// Stage-0 hard-drop module for the `codex-cli` source (R28 Phase 2a).
//
// Layer 1 of the R25 salience cascade for agent-runtime hook captures.
// Input: a fully-formed source-row event from
// storage/sources/codex-cli.jsonl (shape produced by the codex-cli
// connector — paired user/assistant turn with raw_content carrying
// conversation_id, turn_index, user_text, assistant_text, optional
// system_prompt_hash + tool_calls, and (F-T1-CODEX_CLI-F1) an
// auto_injected flag that the connector sets when the user_text starts
// with a scaffold-prefix token).
//
// Rules:
//   1. raw_content.user_text == null && raw_content.assistant_text == null
//                                                        → DROP (empty_turn)
//   2. (F-T1-CODEX_CLI-F1, primary path) raw_content.auto_injected === true
//      AND no assistant_text                             → DROP + quarantine
//                                                          (codex_scaffold_auto_injected,
//                                                           retention=14d)
//   3. (F-T1-CODEX_CLI-F1, fallback) raw_content.user_text matches
//      SCAFFOLD_USER_RE AND no assistant_text            → DROP + quarantine
//                                                          (codex_scaffold_regex_fallback,
//                                                           retention=14d)
//      The fallback exists for historical rows already on disk that the
//      pre-flag connector emitted without auto_injected. New emissions
//      take the primary path because the connector now tags at
//      write-time.
//   4. otherwise                                          → PASS
//
// Rules REMOVED in F-T1-CODEX_CLI-F1:
//   * Old Rule 2 ("developer_only" — system_prompt_hash present, no
//     user_text, no assistant_text). The (isEmpty(userText) AND
//     isEmpty(assistantText)) guard is identical to old Rule 1's, so the
//     branch was provably unreachable (Rule 1 fires first). Removed per
//     R28 audit + F-T1-CODEX_CLI-F1 critic.
//   * Old Rule 4 ("codex_slash_command" — `^/init|/clear|/compact`).
//     Zero matches across 38k codex-cli rows in the audit corpus — the
//     codex CLI's slash commands never surface as user_text in the
//     rollout JSONL (they are intercepted before the response_item
//     write). Removed per F-T1-CODEX_CLI-F1 critic.
//
// Why quarantine (not irreversible DROP):
//   The scaffold-prefix DROP is high-confidence but not infallible. If an
//   operator pastes ONLY a <system_prompt> blob into the CLI to inspect
//   it (no assistant reply), Rule 2 / Rule 3 fires — and the operator
//   might want to recover that row. The quarantine layer holds it for 14
//   days under storage/quarantine/codex-cli/<YYYY-MM-DD>.jsonl with the
//   originating rule_id stamped on the entry. Per F-INFRA-QUARANTINE the
//   row is fully recoverable via restoreFromQuarantine; per the
//   F-T1-CODEX_CLI-F1 critic the 14-day window is shorter than the
//   default 30 days because Codex sessions are operator-controlled and
//   the false-positive case is "operator pasted a scaffold blob to look
//   at it" — a session the operator would notice missing within hours,
//   not weeks.
//
// On PASS we emit a structural_score hint derived from
// CAPS.SALIENCE_STRUCTURAL_RULES["codex-cli"]. Substantive prose wins when
// either side has body text; subject_only falls back when only assistant
// text is present without user text (the rare partial-pair carryover).

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import { CAPS } from "../../validation.js";
import { quarantineRow } from "../quarantine.js";
import { STORAGE_DIR } from "../../config.js";
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — canonical band helper.
// codex-cli bands on (userText.length + assistantText.length) against
// SUBJECT_ONLY_CHAR_THRESHOLD. We synthesise a single joined-content
// pseudofield so the central helper can apply the standard band shape
// without growing a new "totalLen" parameter. The system_prompt_replay
// downgrade remains an in-module override applied after the central
// computation.
import { computeStructuralScore } from "../structural-score.js";

// F-NEW-W1-CODEX-TELEMETRY-SINK sanity beacon. The connector path was
// silently bypassing stage0Dispatch (and therefore the persistent JSONL
// counter sink in lib/ingest/stage0/telemetry.js) until this rewire shipped.
// Emitting a single load-time stderr breadcrumb makes it trivial to confirm
// the module is wired into the dispatcher when an operator tails the daemon
// logs. Cheap, idempotent, fire-once per import. Opt-in (MEMORY_DEBUG=1):
// unconditionally it lands in every MCP client's server log on each start.
if (
  typeof process !== "undefined" &&
  process.env?.MEMORY_DEBUG === "1" &&
  process.stderr &&
  process.stderr.write
) {
  try {
    process.stderr.write(
      "[stage0/codex-cli] module loaded; dispatch wired through stage0Dispatch\n"
    );
  } catch {
    /* never block import on stderr write failure */
  }
}

// F-T1-CODEX_CLI-F1 — anchored fallback regex over user_text. MUST match
// the connector-side SCAFFOLD_USER_RE in lib/connectors/codex-cli.js so
// the flag-based and regex-based paths classify identically. Anchored at
// `^\s*` so a real operator message that DISCUSSES one of these tokens
// ("the <system_prompt> tag worked great") does NOT match.
//
// F-NEW-W7-CODEX-TURN-ABORTED-SCAFFOLD — the alternation group now
// includes the interrupt-class envelopes the harness injects as
// pseudo-user turns when a tool call is aborted mid-stream:
//   <turn_aborted>      — operator/runtime cancelled the in-flight turn
//   <session_aborted>   — full session terminated by the harness
//   <tool_use_error>    — tool invocation errored and the harness threaded
//                         a synthetic user turn announcing it
//   <command_interrupted> — ^C / SIGINT interrupted a long-running command
// These envelopes are not operator content; the connector was emitting
// them as user_text and Stage-0 was PASSing them as if they were operator
// dialogue. Adding them here routes them through the existing scaffold
// quarantine path (14d) so a false positive (operator pasting an
// envelope token to discuss it) remains recoverable.
//
// F-A6-CODEX-RECOMMENDED-PLUGINS — `<recommended_plugins>` is the Codex CLI
// harness-injected "plugins available but not installed" list, threaded in
// as a pseudo-user turn. Measured 221 rows/week (118 reply-less) on
// 2026-09-02..09-08; routed through the same scaffold quarantine path.
const SCAFFOLD_USER_RE =
  /^\s*(?:<(?:environment_context|system_prompt|goal_context|subagent_notification|INSTRUCTIONS|thesis_statement|counterpart_gaps|turn_aborted|session_aborted|tool_use_error|command_interrupted|recommended_plugins)\b|# AGENTS\.md instructions for|CONTEXT AND INSTRUCTIONS:)/i;

// F-NEW-W7-CODEX-STATUS-PING-DOWNGRADE — assistant-only "status ping"
// narration regex. These short, polite check-in phrases from the
// assistant ("Checks are running.", "I'm reloading and checking browser
// console.", "The rewrite is in place.", "Let me check the file.") sail
// past the 64-char SUBJECT_ONLY_CHAR_THRESHOLD via polite phrasing — they
// look like substantive prose but carry zero recall value. Anchored at
// start-of-string so an assistant turn that BEGINS with a status ping and
// then goes on to do real work (>= 200 chars total) is preserved; the
// 200-char guard is the same defensive heuristic shape the brutalist
// short-stub rule uses.
//
// Per CRITIC INVARIANT we route the row through quarantine (14d
// retention) rather than permanent DROP — the operator may genuinely want
// recall of "what was Claude doing at 3am" so a false positive remains
// restorable for the standard codex scaffold window.
const STATUS_PING_RE =
  /^(checks?\s+(?:are\s+|is\s+)?(?:running|complete)|i'?m\s+(?:reloading|checking|investigating|looking|searching|reading|inspecting|verifying|building|running)|the\s+(?:rewrite|build|test|change|fix)\s+(?:is|are)\s+(?:in\s+place|complete|running|done)|let\s+me\s+(?:check|verify|look|investigate)|now\s+(?:reloading|checking|running)|standing\s+by|continuing|moving\s+on)/i;
const STATUS_PING_MAX_CHARS = 200;

// F-E6-CODEX-PROCESS-NARRATION (Tier 1) — the pure-narration families the
// original STATUS_PING_RE alternation never named. Same rule, same reason
// key, same quarantine path: this is a widening of rule 6, not a new rule.
//
// Families, all anchored at `^` exactly as STATUS_PING_RE is, so an
// assistant turn that merely DISCUSSES the phrase mid-sentence is untouched:
//   still <active|running|green|passing|clean|waiting|progressing|quiet|
//         going|alive|no ...>      — "Still going; queue half drained."
//   holding for ...                — "Holding for the suite to exit."
//   another <test|pass|check|one>  — "Another pass; the run stays healthy."
//   no <final|new|output|diagnostics|result|change|traceback>
//   nothing <new|yet>
//   waiting <for|on> ...
//   <N> more <passed|test(s)|case(s)>   — "Six more cases, all fine."
const NARRATION_PING_RE =
  /^(?:still\s+(?:active|running|green|passing|clean|waiting|progressing|quiet|going|alive|no\b)|holding\s+for\b|another\s+(?:test|pass|check|one)\b|no\s+(?:final|new|output|diagnostics|result|change|traceback)\b|nothing\s+(?:new|yet)\b|waiting\s+(?:for|on)\b|(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+more\s+(?:passed|tests?|cases?)\b)/i;

// F-E6-CODEX-PROCESS-NARRATION — a SECOND, TIGHTER cap that applies to
// NARRATION_PING_RE only. STATUS_PING_RE keeps STATUS_PING_MAX_CHARS (200).
//
// The cliff is measured, not stylistic. Census over the full
// storage/sources/codex-cli.jsonl (85,020 rows; 72,748 assistant-only, i.e.
// user_text blank and assistant_text non-blank), evaluating the predicate
// directly without invoking stage0():
//   * at cap < 200 the new families take 1,689 rows. A hand audit of 40
//     random DISTINCT strings drawn from the 80..200 band (466 rows, 466
//     distinct) found 6 carrying a real fact in a trailing clause — the
//     shape (illustrative, invented) is "Still clean: the linter reports
//     nothing. Unit jobs have finished; the docs build is still executing."
//   * at cap < 80 the set is 1,223 rows / 620 distinct strings, and a hand
//     audit of 30 random distinct strings found ZERO fact-bearing rows.
// 80 is therefore the largest cap at which the measured false-positive
// count is 0. The quarantine path (14d) still makes any miss recoverable.
const NARRATION_STRICT_MAX_CHARS = 80;

// F-E6-CODEX-PROCESS-NARRATION (Tier 2) — first-person NEXT-ACTION shape.
// DOWNGRADE, NOT DROP, and the refusal is deliberate: a blocklist here
// would delete exactly the "what commitments are open" content a recall
// asks for. Measured on the same corpus: short (< 80) assistant-only turns
// opening with I'll/I'm number 122 rows / 120 distinct (0.17% of
// assistant-only), and a hand pass over all 120 found 93 naming a concrete
// artifact, file, symbol or decision (illustrative, invented: "I'm adding
// the empty-input case to the parser tests.", "I'm updating the guide so it
// names the same limit as the code."). Dropping that family buys 0.17% and
// loses the commitments.
//
// So instead we take the anchored, verb-bounded shape below and return
// PASS at the `boilerplate` rung, mirroring the system_prompt_replay rung
// further down this same function. Anchored at `^` and restricted to a
// closed set of PROCESS verbs so a result clause ("The packaging check is
// green after the manifest path fix. I'm rerunning the whole suite.")
// keeps its full score — only turns that OPEN as narration are downgraded.
// The unanchored variant was measured first and rejected: it took 3,031
// rows (4.17% of assistant-only) and swept up result clauses. The anchored
// shape below takes 273 rows / 269 distinct (0.38%), and a hand audit of 30
// random distinct matches found ZERO completed-fact assertions — every one
// was an intention about the next step.
const NEXT_ACTION_NARRATION_RE =
  /^(?:i['\u2019]?(?:ll|m)\s+(?:let|keep|continu\w*|pull\w*|sanity-check\w*|re-?check\w*|check\w*|wait\w*|poll\w*|hold\w*|re-?run\w*|verif\w*|inspect\w*|summari[sz]\w*|monitor\w*)\b|the\s+[a-z][\w'\u2019-]*\s+is\s+(?:working|running|progressing)\s+now\b)/i;

// F-T1-CODEX_CLI-F1 — quarantine retention for codex scaffold DROPs. The
// retention_days value is captured on each quarantine entry's rule_id so
// the purge tool can surface "kept 14d" vs the default 30d window.
const CODEX_SCAFFOLD_RETENTION_DAYS = 14;

const SUBJECT_ONLY_CHAR_THRESHOLD = 64;

function isEmpty(v) {
  if (v == null) return true;
  if (typeof v !== "string") return false;
  return v.trim().length === 0;
}

// quarantineScaffoldRow: best-effort quarantine write. The dispatcher
// already records the DROP counter via recordDrop; quarantineRow ALSO
// increments its own in-process counter for the quarantine audit surface.
// We swallow errors so a quarantine-sink failure (disk full, permissions)
// never blocks the Stage-0 hot path — the DROP decision still stands and
// downstream salience treats the row as filtered.
//
// F-NEW-W1-CODEX-QUARANTINE-METADATA invariant: the `event` we hand to
// quarantineRow() MUST already carry the recoverable minimum:
//   - source_msg_id   (restoreFromQuarantine keys on this)
//   - raw_content     (the full original payload, NOT a stripped form)
//   - parties, ts     (so cross-source dedup + chronology survive restore)
//   - source          (stamped via opts.source below as a safety net)
// The connector now stamps source_msg_id + ts + parties on the probe
// BEFORE Stage-0 sees it; this helper does NOT re-strip the event.
function quarantineScaffoldRow(event, reason) {
  try {
    quarantineRow(event, reason, {
      source: "codex-cli",
      rule_id: `${reason}:retention=${CODEX_SCAFFOLD_RETENTION_DAYS}d`,
    });
  } catch {
    // Quarantine failure is non-fatal. The Stage-0 DROP decision still
    // stands; we lose the recovery window but never block the cascade.
  }
}

// F-T2-CODEX_CLI-F3 — brutalist persona-style output template detector.
// The codex-cli ledger holds ~1,361 rows of assistant-only outputs that
// open with one of the "brutalist critic" section headings (Findings,
// Verdict, Critical Path, Dependency Map, Attack Surface, Systemic Rot,
// Bottom Line, Brutal Analysis/Summary/Truth, Counterpart Gaps,
// Architecture). These are deterministic boilerplate from a known critique
// tool — not operator-authored. Anchored at start-of-string so a user
// message that merely DISCUSSES the heading ("see the Findings section")
// does not match.
//
// CRITIC NOTE (per node review_question): keep long-form (>= LONG_FORM_KEEP_CHARS)
// brutalist analyses for cross-source corroboration value; only drop the
// short summary stubs. The threshold is a defensive heuristic, not a
// hard cliff — the quarantine layer makes any false positive recoverable
// for 14 days.
const BRUTALIST_OUTPUT_RE =
  /^\*\*(?:Findings|Verdict|Critical Path|Dependency Map|Attack Surface|Systemic Rot|Bottom Line|Brutal (?:Analysis|Summary|Truth)|Counterpart Gaps|Architecture)\*\*(?:\n|\s*$)/;
const BRUTALIST_LONG_FORM_KEEP_CHARS = 3000;
const BRUTALIST_SHORT_STUB_MAX_CHARS = 800;

// F-T2-CODEX_CLI-F4 — bot-envelope detector. Assistant turns that begin
// with a configured done-marker prefix are status payloads from an
// automation driving codex (JSON envelopes). Zero operator dialogue value;
// the embedder would otherwise hash these into a tight noise cluster.
// Set CODEX_AUTOMATION_DONE_PREFIX to that marker to enable the rule; unset,
// it never fires.
const AUTOMATION_DONE_PREFIX = process.env.CODEX_AUTOMATION_DONE_PREFIX || null;

// F-W-CODEX-TOOL-CALL-BLOCK — assistant-only turns whose ENTIRE text is one
// or more bracketed tool envelopes the codex-cli connector renders for a
// tool invocation or its result:
//
//   [external_agent_tool_call: Bash]
//   description: ...
//   command: ...
//   [/external_agent_tool_call]
//
//   [external_agent_tool_result]
//   ...
//   [/external_agent_tool_result]
//
// Measured on the trailing 60 MB of storage/sources/codex-cli.jsonl
// (2026-09-09): 7,422 assistant rows contain such a block; 7,420 are
// NOTHING BUT blocks, and 7,342 of those have a blank user_text. In the
// memory ledger they were 5,108 of the 11,093 facts promoted in the week
// of 2026-09-02..08 (46%), and they took eight of twelve slots in every
// facet of a "what happened this week" recall. They are runtime plumbing
// (the command that ran, the bytes it printed), not operator dialogue,
// and the operator's own words on that turn live in the SAME row's
// user_text — which this rule preserves by keeping the isEmpty(userText)
// guard every other codex rule uses.
//
// Anchored at both ends: a row that OPENS with a block and continues into
// prose, or prose that quotes a block, is untouched — only the pure-block
// row matches. Route through quarantine (14d) per CRITIC INVARIANT — never
// permanent DROP — so "what did Claude run at 3am" stays recoverable inside
// the standard codex scaffold window.
const TOOL_BLOCK_RE =
  /^\s*(?:\[external_agent_tool_(?:call|result)(?::[^\]]*)?\][\s\S]*?\[\/external_agent_tool_(?:call|result)\]\s*)+$/;

// F-T2-CODEX_CLI-F6 — system_prompt_hash dedup state. Per the predicate
// and critic-invariant ("prefer downgrade-via-low-structural_score over
// DROP when the row carries cross-source corroboration value"), we do
// NOT drop replay rows. Instead, on every PASS we downgrade the
// structural_score for any (system_prompt_hash, utc_day) pair we have
// already seen within the same day. The first occurrence per day passes
// through with the normal substantive_prose score; the 2nd .. Nth get
// the much lower `system_prompt_replay` rung so Layer-2 selection prefers
// the canonical row.
//
// The in-process Set is keyed by `${hash}::${YYYY-MM-DD}`. F-NEW-W2-CODEX-
// SYSPROMPT-RESTART-IDEMPOTENCE — the Set is ALSO persisted to disk as a
// per-UTC-day JSONL append-only file at:
//
//     storage/dedup/codex_system_prompt_<YYYY-MM-DD>.jsonl
//
// Re-hydration on module load reads TODAY's file + YESTERDAY's file (the
// latter absorbs near-midnight clock skew: a replay that landed at 23:59 UTC
// yesterday with a key dated yesterday could still re-occur in the first
// few minutes after a restart if we only hydrated today). Daily rotation
// is implicit in the filename suffix; the per-day rotation also bounds the
// hydration cost — we never scan more than the trailing 48h of replay
// keys regardless of how long the daemon has been running.
//
// Cardinality cap (SYSTEM_PROMPT_REPLAY_CARDINALITY_CAP=100k) is enforced
// IN-MEMORY only; once the in-memory Set hits the cap, new keys are not
// tracked AND not appended to disk. This matches the pre-persistence
// semantic exactly: a long-running daemon that exceeds the cap forgets new
// keys until restart, and a restarted daemon hydrates only up to the cap
// from disk. The cap is the same on both sides so a daemon flap cannot
// inflate the on-disk file beyond the in-memory budget.
//
// DESIGN RATIFICATION (per node review_question Q3): the PASS+downgrade
// design (NOT a literal DROP) is ratified explicitly. The critic invariant
// "prefer downgrade-via-low-structural_score over DROP when the row carries
// cross-source corroboration value" applies: a replayed system_prompt_hash
// still indicates a real operator session and may carry unique user_text /
// assistant_text content (the duplication is in the developer-role prompt
// boilerplate, not the dialogue). Dropping would lose the dialogue half;
// downgrading instead biases Layer-2 selection toward the canonical first
// occurrence while preserving the full row for cross-source corroboration.
const SEEN_SYSTEM_PROMPT_HASHES = new Set();
const SYSTEM_PROMPT_REPLAY_CARDINALITY_CAP = 100_000;
const SYSTEM_PROMPT_REPLAY_SCORE = 0.15;

// F-NEW-W2-CODEX-SYSPROMPT-RESTART-IDEMPOTENCE — durable persistence root.
function _codexSystemPromptDedupDir() {
  return join(STORAGE_DIR, "dedup");
}
function _codexSystemPromptDedupPath(utcDay) {
  return join(_codexSystemPromptDedupDir(), `codex_system_prompt_${utcDay}.jsonl`);
}

function utcDayTag(ts) {
  // ts is the row timestamp string from the connector (ISO-8601). Fall
  // back to current UTC day if missing — the dedup correctness only
  // depends on stable keys across a single daemon poll, not absolute
  // wall-clock precision.
  const d =
    typeof ts === "string" && ts.length > 0
      ? new Date(ts)
      : new Date();
  if (Number.isNaN(d.getTime())) return "1970-01-01";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// F-NEW-W2-CODEX-SYSPROMPT-RESTART-IDEMPOTENCE — append the (hash, day) key
// to today's persisted JSONL. Errors are swallowed: persistence is a
// hardening pass for the restart-idempotence gap, not load-bearing.
function _persistSystemPromptKey(hash, utcDay) {
  try {
    const dir = _codexSystemPromptDedupDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const path = _codexSystemPromptDedupPath(utcDay);
    const line = JSON.stringify({ hash, utc_day: utcDay }) + "\n";
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // Persistence failure is non-fatal. The in-memory Set still tracks
    // the key for the lifetime of this daemon; only restart-idempotence
    // is degraded.
  }
}

// F-NEW-W2-CODEX-SYSPROMPT-RESTART-IDEMPOTENCE — re-hydrate the in-memory
// Set from disk. Reads TODAY + YESTERDAY (UTC) to absorb near-midnight
// clock skew. Older files age out naturally — they describe replays from
// >24h ago that no live codex-cli row will re-emit (sessions are
// session-scoped). Respects the cardinality cap on both sides: we stop
// loading once the in-memory Set hits the cap.
//
// Called at module load. Idempotent for tests via _resetSystemPromptSeenForTest
// + _hydrateSystemPromptSeenForTest helpers.
function _hydrateSystemPromptSeenFromDisk(opts = {}) {
  const dir = _codexSystemPromptDedupDir();
  if (!existsSync(dir)) return;
  // Determine which days to hydrate. Default: TODAY + YESTERDAY UTC.
  // Test surface accepts an explicit list to make hermetic snapshot tests
  // deterministic without mocking the system clock.
  let daysToLoad;
  if (Array.isArray(opts.utcDays) && opts.utcDays.length > 0) {
    daysToLoad = opts.utcDays;
  } else {
    const nowMs =
      opts.now instanceof Date
        ? opts.now.getTime()
        : typeof opts.now === "number"
          ? opts.now
          : Date.now();
    const today = utcDayTag(new Date(nowMs).toISOString());
    const yesterday = utcDayTag(new Date(nowMs - 24 * 60 * 60 * 1000).toISOString());
    daysToLoad = [today, yesterday];
  }
  for (const day of daysToLoad) {
    if (SEEN_SYSTEM_PROMPT_HASHES.size >= SYSTEM_PROMPT_REPLAY_CARDINALITY_CAP) break;
    const path = _codexSystemPromptDedupPath(day);
    if (!existsSync(path)) continue;
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (raw === "") continue;
    const lines = raw.split("\n");
    for (const line of lines) {
      if (line === "") continue;
      if (SEEN_SYSTEM_PROMPT_HASHES.size >= SYSTEM_PROMPT_REPLAY_CARDINALITY_CAP) break;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const hash = typeof parsed.hash === "string" ? parsed.hash : null;
      const utcDay = typeof parsed.utc_day === "string" ? parsed.utc_day : null;
      if (!hash || !utcDay) continue;
      SEEN_SYSTEM_PROMPT_HASHES.add(`${hash}::${utcDay}`);
    }
  }
}

// Hydrate on module load. The eager call is intentional: stage0/codex-cli.js
// imports run once per daemon process, and the dispatcher hot path is sized
// to assume the dedup Set is ready at first dispatch. Tests reset + re-
// hydrate via the exported _internals._hydrateForTest helper.
try {
  _hydrateSystemPromptSeenFromDisk();
} catch {
  // Never let module load fail because of a hydration error; the in-memory
  // Set starts empty in that case (same as the pre-persistence behaviour).
}

function markSystemPromptSeen(hash, ts) {
  const utcDay = utcDayTag(ts);
  const key = `${hash}::${utcDay}`;
  if (SEEN_SYSTEM_PROMPT_HASHES.has(key)) return true;
  if (SEEN_SYSTEM_PROMPT_HASHES.size >= SYSTEM_PROMPT_REPLAY_CARDINALITY_CAP) {
    // Hit the cap. Don't keep growing; new keys are not tracked, so we
    // miss the dedup signal for them but never leak memory. A daemon
    // restart drains the in-memory set; the cap is the same on both
    // sides so a daemon flap cannot inflate the on-disk file beyond
    // the in-memory budget.
    return false;
  }
  SEEN_SYSTEM_PROMPT_HASHES.add(key);
  // F-NEW-W2-CODEX-SYSPROMPT-RESTART-IDEMPOTENCE — persist the new key so
  // a daemon restart re-hydrates it from disk and the next emission of
  // the same (hash, day) lands the system_prompt_replay downgrade.
  _persistSystemPromptKey(hash, utcDay);
  return false;
}

function _resetSystemPromptSeenForTest() {
  SEEN_SYSTEM_PROMPT_HASHES.clear();
}

// F-NEW-W2-CODEX-SYSPROMPT-RESTART-IDEMPOTENCE — test surface for the
// re-hydrate path. Production callers don't need it; tests do, because
// the load-time hydration fires before tests get a chance to write a
// fixture file under STORAGE_DIR. Exported via _internals below.
function _hydrateSystemPromptSeenForTest(opts) {
  _hydrateSystemPromptSeenFromDisk(opts);
}

// readdirSync is imported for the (currently-unused) operator-facing
// directory listing surface. Keep the import; quiet the lint without
// pulling it from the named import list.
void readdirSync;

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};
  const userText = typeof rc.user_text === "string" ? rc.user_text : "";
  const assistantText = typeof rc.assistant_text === "string" ? rc.assistant_text : "";
  const autoInjected = rc.auto_injected === true;

  // 1. Empty turn — both sides empty/null. We do NOT quarantine empty
  // turns; they carry no operator intent and are not recoverable signal.
  if (isEmpty(userText) && isEmpty(assistantText)) {
    return { decision: "DROP", reason: "empty_turn" };
  }

  // 2. F-T1-CODEX_CLI-F1 PRIMARY — connector-tagged auto-injected user
  // turn with no assistant reply. The connector already tagged this row
  // at write-time so Stage-0 trusts the flag rather than re-running the
  // regex. Routes to quarantine (14d) so an operator-pasted scaffold blob
  // remains recoverable. Note: when assistant_text IS present the
  // assistant response is signal — we PASS the row through so the
  // dialogue half of the turn survives.
  if (autoInjected && isEmpty(assistantText)) {
    quarantineScaffoldRow(event, "codex_scaffold_auto_injected");
    return { decision: "DROP", reason: "codex_scaffold_auto_injected" };
  }

  // 3. F-T1-CODEX_CLI-F1 FALLBACK — anchored regex over user_text catches
  // unflagged historical rows already on disk that the pre-flag connector
  // emitted before auto_injected tagging shipped. Same quarantine
  // discipline (14d) and same empty-assistant guard. After the historical
  // corpus has aged out of the 14-day window this branch becomes a no-op
  // and can be deleted in a follow-up cleanup.
  if (!autoInjected && SCAFFOLD_USER_RE.test(userText) && isEmpty(assistantText)) {
    quarantineScaffoldRow(event, "codex_scaffold_regex_fallback");
    return { decision: "DROP", reason: "codex_scaffold_regex_fallback" };
  }

  // 4. F-T2-CODEX_CLI-F4 — bot envelope. Assistant-only turns whose
  // assistant_text begins with the automation's done-marker prefix are
  // automation status payloads (JSON envelope). Zero operator-dialogue value; data
  // is recoverable from the bot's own log if ever needed. Route through
  // quarantine (14d) per CRITIC INVARIANT — never permanent DROP.
  if (isEmpty(userText) && AUTOMATION_DONE_PREFIX && assistantText.startsWith(AUTOMATION_DONE_PREFIX)) {
    quarantineScaffoldRow(event, "codex_bot_envelope");
    return { decision: "DROP", reason: "codex_bot_envelope" };
  }

  // 5. F-T2-CODEX_CLI-F3 — brutalist persona-style output template. Drop
  // SHORT assistant-only outputs that open with a known brutalist
  // section heading (Findings / Verdict / Critical Path / Dependency
  // Map / Attack Surface / Systemic Rot / Bottom Line / Brutal
  // Analysis|Summary|Truth / Counterpart Gaps / Architecture). Long-form
  // analyses (>= BRUTALIST_LONG_FORM_KEEP_CHARS) survive because they
  // carry cross-source corroboration value; mid-length rows
  // (BRUTALIST_SHORT_STUB_MAX_CHARS .. BRUTALIST_LONG_FORM_KEEP_CHARS)
  // PASS with no downgrade — the critic recommendation is to drop only
  // the short summary stubs. Route through quarantine (14d) per CRITIC
  // INVARIANT — never permanent DROP.
  if (
    isEmpty(userText) &&
    assistantText.length < BRUTALIST_SHORT_STUB_MAX_CHARS &&
    BRUTALIST_OUTPUT_RE.test(assistantText)
  ) {
    quarantineScaffoldRow(event, "codex_brutalist_template_output");
    return { decision: "DROP", reason: "codex_brutalist_template_output" };
  }

  // 6. F-NEW-W7-CODEX-STATUS-PING-DOWNGRADE — short assistant-only "status
  // ping" narration. These polite check-in phrases ("Checks are running.",
  // "I'm reloading and checking browser console.", "The rewrite is in
  // place.", "Let me check the file.") look like substantive prose to the
  // 64-char SUBJECT_ONLY_CHAR_THRESHOLD but carry zero recall value — they
  // are runtime narration the operator never asked for. The guard
  // assistantText.length < STATUS_PING_MAX_CHARS (200) preserves longer
  // turns that BEGIN with a status ping and then go on to do real work.
  // Route through quarantine (14d) per CRITIC INVARIANT — never permanent
  // DROP, so an operator who genuinely wants recall of "what was Claude
  // doing at 3am" can restore the row inside the standard scaffold window.
  //
  // F-E6-CODEX-PROCESS-NARRATION widens this SAME rule with the
  // pure-narration families STATUS_PING_RE never named, under a tighter
  // cap (NARRATION_STRICT_MAX_CHARS = 80 vs 200). No new drop reason, no
  // new telemetry key, no new module: the widened arm reuses
  // `codex_assistant_status_ping` and the same quarantineScaffoldRow path
  // so a false positive stays recoverable and countable.
  if (
    isEmpty(userText) &&
    ((assistantText.length < STATUS_PING_MAX_CHARS &&
      STATUS_PING_RE.test(assistantText)) ||
      (assistantText.length < NARRATION_STRICT_MAX_CHARS &&
        NARRATION_PING_RE.test(assistantText)))
  ) {
    quarantineScaffoldRow(event, "codex_assistant_status_ping");
    return { decision: "DROP", reason: "codex_assistant_status_ping" };
  }

  // 7. F-W-CODEX-TOOL-CALL-BLOCK — assistant-only turn that is NOTHING BUT
  // bracketed tool-call / tool-result envelopes (see TOOL_BLOCK_RE). No
  // length cap: the envelope is plumbing at any size (p95 4 KB, max 34 KB
  // on the measured corpus), and the anchored regex already spares any row
  // that carries prose outside the brackets. Same isEmpty(userText) guard
  // as every other codex rule so the operator's words on the turn survive.
  if (isEmpty(userText) && TOOL_BLOCK_RE.test(assistantText)) {
    quarantineScaffoldRow(event, "codex_tool_call_block");
    return { decision: "DROP", reason: "codex_tool_call_block" };
  }

  // PASS + structural-score hint.
  // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION: codex-cli's cliff is on
  // the joined user+assistant length. Build a synthetic _joined field of
  // the same length so the central helper's longest-field measurement
  // returns totalLen. Functionally identical to the pre-W5 inline
  // `totalLen >= SUBJECT_ONLY_CHAR_THRESHOLD` lookup.
  const totalLen = userText.length + assistantText.length;
  const defaultStructuralScore = computeStructuralScore(
    { _joined: userText + assistantText },
    "codex-cli",
    {
      contentFields: ["_joined"],
      shortReplyThreshold: SUBJECT_ONLY_CHAR_THRESHOLD,
      lowerBand: "subject_only",
    }
  );

  // F-T2-CODEX_CLI-F6 — system_prompt_hash dedup AS DOWNGRADE, not DROP.
  // The top hash repeats 839+ times across the codex-cli corpus. Per the
  // CRITIC INVARIANT ("prefer downgrade-via-low-structural_score over DROP
  // when the row carries cross-source corroboration value") we keep the
  // row in the ledger but ask Layer-2 selection to deprioritise replays.
  // The first row per (hash, utc_day) PASSes with the normal score; every
  // subsequent replay gets the system_prompt_replay rung. This implements
  // the predicate-suggested seenSystemPromptHashes(hash + ':' + day) check
  // without the irreversible Stage-0 DROP the predicate originally hinted at.
  const hash = typeof rc.system_prompt_hash === "string" ? rc.system_prompt_hash : null;
  if (hash) {
    const alreadySeen = markSystemPromptSeen(hash, event.ts);
    if (alreadySeen) {
      return {
        decision: "PASS",
        reason: "system_prompt_replay",
        structural_score: Math.min(defaultStructuralScore, SYSTEM_PROMPT_REPLAY_SCORE),
      };
    }
  }

  // F-E6-CODEX-PROCESS-NARRATION (Tier 2) — first-person next-action
  // narration DOWNGRADE. Deliberately NOT a DROP: this family carries the
  // open-commitment content ("I'm adding the empty-input case to the parser
  // tests.") that a "what am I working on" recall is asking for.
  // We keep the row and ask Layer-2 to deprioritise it instead.
  //
  // The score source is CAPS.SALIENCE_STRUCTURAL_RULES["codex-cli"]
  // .boilerplate (0.30) — an existing, already-frozen rung that no rule
  // referenced until now. No new table key. structuralScore() in
  // lib/ingest/salience.js honours a numeric stage0 hint ahead of the table
  // lookup, and that value is the `structural` component of the Layer-2
  // admit vector: this is ingest-side only and never touches the reranker
  // or the recall path.
  const boilerplateScore =
    CAPS.SALIENCE_STRUCTURAL_RULES?.["codex-cli"]?.boilerplate;
  if (
    isEmpty(userText) &&
    assistantText.length < STATUS_PING_MAX_CHARS &&
    typeof boilerplateScore === "number" &&
    NEXT_ACTION_NARRATION_RE.test(assistantText)
  ) {
    return {
      decision: "PASS",
      reason: "process_narration",
      structural_score: Math.min(defaultStructuralScore, boilerplateScore),
    };
  }

  return {
    decision: "PASS",
    reason: null,
    structural_score: defaultStructuralScore,
  };
}

export function structuralRules() {
  return { ...(CAPS.SALIENCE_STRUCTURAL_RULES?.["codex-cli"] || {}) };
}

// Test-only exports. Surfaces the scaffold regex + retention constant so
// unit tests can assert the same prefix set the connector tags at
// write-time, and verify the quarantine window. Wave-2 additions surface
// the brutalist regex + thresholds, the automation-completion prefix, the
// system_prompt_replay rung, and the test-only state reset so the new
// rules are unit-testable.
export const _internals = {
  SCAFFOLD_USER_RE,
  CODEX_SCAFFOLD_RETENTION_DAYS,
  BRUTALIST_OUTPUT_RE,
  BRUTALIST_LONG_FORM_KEEP_CHARS,
  BRUTALIST_SHORT_STUB_MAX_CHARS,
  AUTOMATION_DONE_PREFIX,
  // F-W-CODEX-TOOL-CALL-BLOCK — surface the anchored envelope regex so the
  // suite can pin both anchors (pure block DROPs; block+prose PASSes).
  TOOL_BLOCK_RE,
  SYSTEM_PROMPT_REPLAY_SCORE,
  SYSTEM_PROMPT_REPLAY_CARDINALITY_CAP,
  // F-NEW-W7-CODEX-STATUS-PING-DOWNGRADE — surface the regex + length
  // cliff so unit tests can assert: (a) canonical status-ping prefixes
  // match; (b) a 250-char turn that BEGINS with "Checks are running."
  // but continues into real work survives; (c) operator discussion of
  // the phrase ("the 'checks are running' message confused me") does
  // not match because it is not anchored at start-of-string.
  STATUS_PING_RE,
  STATUS_PING_MAX_CHARS,
  // F-E6-CODEX-PROCESS-NARRATION — surface the widened Tier-1 alternation,
  // its tighter cap, and the Tier-2 next-action shape so the registered
  // suite can pin the length cliff and the anchor without re-deriving them.
  NARRATION_PING_RE,
  NARRATION_STRICT_MAX_CHARS,
  NEXT_ACTION_NARRATION_RE,
  _resetSystemPromptSeenForTest,
  // F-NEW-W2-CODEX-SYSPROMPT-RESTART-IDEMPOTENCE — test-only re-hydrate
  // helper + the per-day path helper so unit tests can drop a fixture
  // file under STORAGE_DIR and assert it loads. utcDayTag is exported so
  // tests can compute the canonical key shape without re-deriving it.
  _hydrateSystemPromptSeenForTest,
  _codexSystemPromptDedupPath,
  utcDayTag,
};
