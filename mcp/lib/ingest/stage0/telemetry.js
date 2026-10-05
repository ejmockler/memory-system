// Stage-0 per-reason drop telemetry.
//
// Layer-1 observability primitive for the R25 salience cascade. Without
// per-reason drop counters wrapping stage0Dispatch, every subsequent
// Stage-0 rule change ships blind: the operator cannot tell whether a rule
// fired N times, zero times, or N*1000 times, and cannot detect
// regressions when a rule silently stops matching.
//
// Authoritative spec source: F-INFRA-R40-TELEMETRY (hypergraph node) +
// kb/salience-design.md § Layer 1 cascade.
//
// Surfaces:
//   1. recordDrop(source, reason, decision?) — bump the
//      `${source}::${decision}::${reason}` counter in the process-local
//      Map. Caller is the dispatcher wrapper; per-source modules do not
//      call this directly.
//   2. flushCounters({sync?: boolean}) — append the current counter
//      snapshot as a JSONL row to storage/telemetry/stage0_counters_<YYYY-MM-DD>.jsonl
//      and zero out the Map.
//   3. snapshotCounters() — read-only copy of the current Map, surfaced
//      via memory_connectors_list for operator inspection.
//   4. resetForTests() — clear the in-process state. Test-only.
//
// Cardinality discipline (the brutalist critic's non-negotiable mitigation):
//   - Distinct keys capped at TELEMETRY_REASON_CAP = 10_000. Once the Map
//     hits the cap, NEW keys are folded into the synthetic 'other' bucket
//     instead of growing the Map.
//   - Reason strings are validated against REASON_ALLOWLIST. Novel reasons
//     are bucketed into 'invalid_reason' AND emit a one-time stderr
//     warning per novel string so the operator notices schema drift.
//
// Durability discipline:
//   - Auto-flush every TELEMETRY_FLUSH_EVERY_N drops (default 1000) so a
//     long-running daemon never holds more than ~1000 unflushed events.
//   - Flush on SIGTERM, SIGINT, and beforeExit so graceful shutdown
//     persists the trailing counter window. The shutdown flush is
//     synchronous (appendFileSync + fsyncSync) so we never lose data in
//     the exit window.
//   - Daily rotation: the JSONL sink is keyed by UTC date
//     (storage/telemetry/stage0_counters_<YYYY-MM-DD>.jsonl). Each flush
//     re-derives the filename so a long-running process naturally rolls
//     forward at UTC midnight without an explicit rotator.
//
// HERMETICITY: the sink directory is derived from STORAGE_DIR in
// lib/config.js, so MEMORY_ROOT / STORAGE_BASE_DIR env-override
// discipline works for tests + hermetic e2e harnesses.

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STORAGE_DIR } from "../../config.js";
import { serverTs } from "../../envelope.js";

// ---------------------------------------------------------------------------
// Caps (constants are exported so tests can read them; the production
// values are not env-overridable — drift in cardinality or flush cadence
// is a code change, not a config change).
// ---------------------------------------------------------------------------
export const TELEMETRY_REASON_CAP = 10_000;
export const TELEMETRY_FLUSH_EVERY_N = 1000;

// Allowlist of valid reason strings. Mirrors the union of
// per-stage0-module reasons currently emitted (mcp/lib/ingest/stage0/*.js
// grep "decision:" → reason:). Plus the synthetic buckets the telemetry
// layer itself emits.
//
// New per-source reasons MUST be added here in the same change that adds
// them to the per-source module. The 'invalid_reason' bucket + stderr
// warning is the safety net that catches schema drift, not a permanent
// home for the missing reason.
export const REASON_ALLOWLIST = Object.freeze(
  new Set([
    // Synthetic dispatcher buckets.
    "pass", // decision=PASS, reason=null
    "unknown_source", // dispatcher fallback for missing connector
    "other", // cardinality-cap overflow bucket
    "invalid_reason", // allowlist-violation overflow bucket

    // F-NEW-W7-CURSOR-LAG-ALARM (audit-finding follow-up) — emitted by the
    // watermark daemon, NOT by per-source Stage-0 modules. The daemon
    // calls recordDrop("<source>", "cursor_lag_warn", "WARN") every
    // CURSOR_LAG_CHECK_EVERY_N_TICKS ticks when a cursor is more than
    // CURSOR_LAG_WARN_THRESHOLD_MS behind the source ledger tail AND the
    // ledger has grown in the trailing CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS
    // (i.e. the source is producing but the cursor is parked). Decision
    // is "WARN" so the operator dashboard can filter cursor-lag observ-
    // ability out of real DROP rates.
    "cursor_lag_warn",
    "embed_degenerate_vector", // E1 zero-norm-embedding-root-cause — watermark WARN, one per row-scoped degenerate vector
    // F-NEW-W7-CURSOR-UNSTICK-DIAGNOSIS — emitted when the operator sets
    // WATERMARK_ADVANCE_PAST_DEFERRED=1 to escape the KeyPoolExhausted
    // deadlock. Each EMBED_DEFERRED row counted under this bucket is a
    // forfeit: the cursor advances, the row is dropped from the cascade
    // (no salience block, no recall vector). The counter tracks the data-
    // loss volume so the operator can size the cost of the escape valve.
    "cursor_advanced_past_deferred",

    // identity / cross-source
    // F-NEW-W1-R42-HOSTNAME-OBSERVABILITY — health-check side-channel
    // reason. Emitted by emitHostnameDerivedWarning() with
    // decision='WARN' (NOT 'DROP') when the trailing-7d fraction of
    // commits authored under a hostname-derived address exceeds the
    // THRESHOLD_FRACTION (5%, per critic). The row is NOT quarantined or
    // dropped — the WARN decision is purely observability. Surfaced into
    // memory_connectors_list.health.warnings[] so the operator sees
    // shared-machine drift without tailing stderr.
    "identity_hostname_dominance_warn",

    // F-CROSS-CROSS-SOURCE-DEDUP (R50) — generic Stage-1 cross-source
    // dedup substrate at mcp/lib/ingest/cross-source-dedup.js. The
    // substrate itself does not call recordDrop; per-source Stage-0
    // modules that consult checkCrossSourceDuplicate(row, source) MAY
    // emit these reasons on the DROP they then issue. These complement
    // the per-source reasons already shipped in W2/W3:
    //   - "chat_cc_codex_dedup" (chat-claude-code in-module dedup)
    //   - "duplicate_of_gitlog_commit" (github-events F8 in-module dedup)
    //   - "slack_cross_source_duplicate" (slack F6 probe-stamped dedup)
    // The substrate reasons are the names a per-source Stage-0 emits
    // when it uses the GENERIC substrate path instead of an in-module
    // index. Distinct strings keep telemetry per-contract observable.
    "cross_source_dup_chat_cc_codex",
    "cross_source_dup_screentime_imessage",
    "cross_source_dup_gh_gitlog",

    // imessage
    "tapback",
    "business_handle",
    "otp_pattern",
    "placeholder_residual",
    "bot_message",
    // F-T1-IMESSAGE-F1 / F2 (critic-modified): A2P shortcode + OTP cascade.
    // The strict/full reasons route DROP/REDACT_DROP rows through
    // F-INFRA-QUARANTINE (30d retention). The *_redacted_kept reasons attach
    // to PASS outcomes where the row stayed in the ledger with digit blocks
    // scrubbed (REDACT-and-PASS path the critic mandated for ambiguous
    // matches).
    "imessage_a2p_shortcode_full",
    "imessage_shortcode_redacted_kept",
    "imessage_otp_strict",
    "imessage_otp_redacted_kept",
    // F-T2-IMESSAGE-F3 — regulatory-footer DROP for any handle (not just
    // shortcode senders) when the body carries the canonical CTIA / TCPA
    // compliance footer or marketing-frequency text. Quarantined with 30d
    // retention so false positives (a friend forwarding a spam screenshot)
    // are restorable via the F-INFRA-QUARANTINE restore tool.
    "imessage_a2p_regulatory_footer",
    // F-T2-IMESSAGE-F9 — explicit imessage telemetry visibility bucket.
    // Emitted by stage0/imessage.js as a PASS+reason when the connector
    // (F-T2-IMESSAGE-F7) repaired the outbound parties array via
    // chat_handle_join. Lets the operator monitor the F7 fix-rate as a
    // denominator for the broader audience-metadata health signal.
    "imessage_outbound_parties_repaired",
    // F-NEW-W2-IMESSAGE-PARTIES-REPAIRED-COUNTER — disambiguated empty-case
    // bucket. Emitted as a PASS+reason when the F7 lookup path executed
    // (connector stamped raw_content.parties_source="chat_handle_join")
    // but yielded only ["user"] — true zero-participant legacy chat.db
    // edge (chat_handle_join row was empty or the table was missing, or
    // the chat genuinely has no other handles). Distinct bucket from the
    // success case lets the operator monitor F7 fix-rate vs zero-
    // participant legacy edge separately, and reduces false-positive risk
    // on cross-producer parties-shape inference.
    "imessage_outbound_parties_repaired_empty",
    // F-NEW-W7-IMESSAGE-SERVICE-NOTIFICATION — transactional service
    // shortcode notifications (ExampleEats dispatched/delivered, a laundry
    // pickup ready, a ride on the way, appointment reminders). Emitted as a
    // PASS+reason with structural_score=0.30, so these rows survive for
    // "when did my order arrive" recall but lose head-of-queue
    // priority vs personal messages. The distinct reason key keeps the
    // would-be-default-shortcode count cleanly separated from
    // imessage_shortcode_redacted_kept so the operator can size the
    // transactional traffic volume independently.
    "imessage_service_transactional",
    // F-NEW-W7-IMESSAGE-F3-CONVERSATIONAL-OVERRIDE — friend-forwarded-spam
    // rescue. Emitted as a PASS+reason when the F-T2-IMESSAGE-F3 broad
    // regulatory-footer detector fires BUT the body also carries casual
    // chat-register markers (lol/haha/btw/...) AND is short (< 200 chars).
    // The marketing-footer suffix is stripped in place and the row passes;
    // distinct bucket from imessage_a2p_regulatory_footer so the rescue
    // rate is independently observable.
    "imessage_f3_conversational_rescue",
    // WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — three new spam buckets the
    // audit added to close the iMessage promotional / scam / URL-only
    // gap. Without these on the allowlist the dispatcher buckets the
    // counters into invalid_reason and emits a one-shot stderr warning.
    //   imessage_promotional_sms  — Rule 5c quarantine DROP for
    //                               templated promotional / scheduling
    //                               SMS (vendor-style "Hi {Name}, our
    //                               team visits {day} … reply YES to
    //                               confirm"). 30d quarantine
    //                               retention via quarantineRow so a
    //                               legitimate small-business reminder
    //                               is restorable.
    //   imessage_scam_sms         — Rule 5d quarantine DROP for scam
    //                               transfer (deposit-notice openers)
    //                               / prize-claim ("you have won",
    //                               "claim your prize") SMS. 30d
    //                               quarantine retention.
    //   imessage_url_only         — Rule 5e PASS at structural_score=
    //                               0.35 for messages whose trimmed
    //                               body is a SINGLE URL. The entity-
    //                               extractor downstream stamps the URL
    //                               into features.entities[] as kind=
    //                               "artifact"; the row stays in the
    //                               ledger but loses head-of-queue
    //                               priority vs personal prose.
    "imessage_promotional_sms",
    "imessage_scam_sms",
    "imessage_url_only",

    // screentime
    "discoverability_signals",
    "developer_only",
    "low_signal_event",
    "ephemeral_short_ttl",
    // F-T1-SCREENTIME-F2 — notification-stream quarantine reasons.
    // These rules route DROPs through F-INFRA-QUARANTINE; the dispatcher
    // counter fires on the decision string we return.
    "screentime_iterm2_empty_notif",
    "screentime_apple_chrome_notif",
    // F-T2-SCREENTIME-F3 — /app/usage micro-burst (duration_sec < 5s)
    // quarantine. Cmd-Tab flickers + zero-duration bookkeeping rows route
    // through F-INFRA-QUARANTINE (30d retention) so a recall miss on a
    // brief glance is restorable.
    "app_usage_micro_burst",
    // F-T2-SCREENTIME-F4 — /app/intents empty-payload intent (bundle=null
    // AND intent_class on the known boilerplate allowlist) quarantine.
    // Quarantined with 30d retention so a future URL-extraction subrule
    // can mine restored TBQuickOpenLink rows if needed.
    "empty_payload_intent",
    // F-NEW-W5-SCREENTIME-F4-COUNT-ONLY-TELEMETRY — INIntent base-class +
    // null-verb count-only telemetry rung. Emitted as a PASS+reason when
    // the operator gates the iniIntentNullVerb branch into count-only
    // mode via SCREENTIME_INIINTENT_NULL_VERB_MODE=count_only. The
    // distinct reason key (not "empty_payload_intent") keeps the
    // observation counter cleanly separated from real F4 drops so the
    // operator can size the would-be-drop population before flipping the
    // mode back to "drop". See lib/ingest/stage0/screentime.js for the
    // 7-day observation window discipline. After the count-only window
    // closes the env flag flips off and this counter naturally goes to
    // zero; the bucket stays in the allowlist as the canonical record
    // that the W5 closeout shipped the reversible activation path.
    "iniintent_null_verb_count_only",
    // F-NEW-W7-SCREENTIME-INSENDMESSAGE-BURST-COLLAPSE — intra-source
    // dedup for /app/intents INSendMessageIntent rows. The audit's
    // prospective tail showed 4-6 row clusters within 1-3 seconds all
    // PASSing because CONTRACT_SCREENTIME_IMESSAGE in cross-source-dedup
    // fails open silently when the paired iMessage twin hasn't landed
    // (or never does). The intra-source LRU in stage0/screentime.js
    // probes a process-local cache keyed by canonical handle; same
    // handle re-seen within 5s quarantines (30d retention) under this
    // reason. The FIRST row of any burst still flows through the
    // cross-source contract; this reason fires only on the 2..N tail.
    "screentime_insendmessage_burst_dup",

    // git-log
    "initial_commit",
    "merge_only",
    "bot_commit",
    // F-NEW-W2-GIT-LOG-STAGE0-CONSUMES-SCORE / -INITIAL-COMMIT (Wave 3):
    // Stage-0 and connector-layer reasons that close the F-T1-GIT_LOG-F2
    // and F-T2-GIT_LOG-F6 loops. All four are emitted via recordDrop or
    // through stage0Dispatch counter wrapping; without them on the
    // allowlist the dispatcher buckets them into invalid_reason and
    // emits a one-shot stderr warning per novel string.
    //
    //   git_log_upstream_repo_downgrade   — Stage-0 Rule 0a PASS reason
    //                                       AND connector PASS reason
    //                                       when classification ==
    //                                       "upstream_only"; structural
    //                                       score forced to 0.10.
    //   git_log_initial_commit_drop       — Stage-0 Rule 1 DROP reason
    //                                       (quarantineRow with 30d
    //                                       retention) for any
    //                                       initial-commit variant
    //                                       reaching Stage-0 from a
    //                                       backfill / alternate path
    //                                       that bypassed the connector.
    //   git_log_initial_commit_variant    — Connector-side DROP reason
    //                                       (lib/connectors/git-log-
    //                                       local.js) — quarantineRow
    //                                       before the row even reaches
    //                                       Stage-0. Kept distinct from
    //                                       the Stage-0 reason so the
    //                                       operator can tell which
    //                                       layer fired.
    //   git_log_bot_commit_downgrade      — Connector-side PASS reason
    //                                       for bot-authored commits
    //                                       that survive (no DROP) but
    //                                       carry a structural_score
    //                                       downgrade hint of 0.05.
    "git_log_upstream_repo_downgrade",
    "git_log_initial_commit_drop",
    "git_log_initial_commit_variant",
    "git_log_bot_commit_downgrade",
    // F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT — Stage-0 Rule 0b PASS reason
    // AND connector PASS reason when the subject matches
    // /^["' ]*initial commit:\s+\S/i with a >25-char suffix. The carve-out
    // keeps substantive root commits like "Initial commit: sample
    // curriculum outline and notes" in the ledger at structural_score=0.55
    // rather than quarantining them with the generic initial-commit rule.
    "git_log_initial_commit_with_suffix",
    // F-NEW-W7-GIT-LOG-AUTHOR-SELF — Stage-0 high-priority PASS reason for
    // operator-authored commits. Fires AHEAD of the upstream-only /
    // initial-commit / merge-only / bot rules so an operator commit in an
    // upstream-only repo (e.g. a first-fork landing) is never downgraded
    // to 0.10. Pins structural_score to max(0.7, suggested).
    "git_log_operator_authored_passthrough",
    // F-T1-GIT_LOG-F7 — boilerplate-subject DROP. Fires when the subject
    // matches the boilerplate regex (WIP, Checkpoint, Cleanup, Fix typo,
    // Remove dead code, Update README.md, Improve code style, Move
    // index.html, Run black, More cleanup, "chore:") AND the captured
    // %B body fails to provide countervailing signal (empty, <80 bytes,
    // or itself matches the boilerplate regex). Routed through
    // quarantineRow with 30-day retention so substantive rows that were
    // mis-detected can be restored. Operator-authored rows are exempt
    // (they short-circuit at the Rule -1 operator-authored pass-through).
    "git_log_boilerplate_subject",
    // F-T1-GIT_LOG-F8 — bot-authored version-bump DROP. Fires when the
    // subject matches /^(Bump|chore\(deps\)|update to latest)/i AND the
    // author is classified as a bot (raw_content.is_bot_authored or live
    // isBotActor() probe). Operator-authored bumps PASS — they may carry
    // security/migration signal. Distinct from generic 'bot_commit' so
    // the operator can monitor F8 fire-rate independently. 30-day
    // retention via quarantineRow.
    "git_log_version_bump_bot",
    // WU-A3-git-log-content-dedup — SAME-source content-hash dedup DROP.
    // Fires when the substrate's gitlog-content-dedup contract detects
    // that the row's normalised subject+body sha256 already appears in
    // the git-log ledger (typically: OpenWrt feed commits like
    // "mt76: update to the latest version" repeated across vendor
    // mirrors). The second-and-later identical-content rows are
    // CORROBORATING observations of the first-seen row's fact, not new
    // facts. 30-day quarantine retention so a future
    // corroboration-count projector / restore tool can resolve the
    // paired source_msg_id chain. Distinct reason key so the operator
    // can size content-dedup volume independently of bot_commit /
    // initial-commit / version-bump.
    "git_log_content_dup_corroborate",

    // github-events
    "bot_event",
    // F-T1-GITHUB_EVENTS-F1 (critic-modified): empty-PushEvent downgrade.
    // Emitted by stage0/githubevents.js as a PASS+reason so the operator
    // can count downgraded rows (denominator for the R52 backfill payoff
    // calculation) without conflating them with full-content passes. NOT
    // a DROP — the row stays in the ledger for cross-source corroboration.
    "empty_pushevent_downgrade",
    // F-T2-GITHUB_EVENTS-F4 (Wave 2): branch lifecycle quarantine.
    // CreateEvent / DeleteEvent with ref_type='branch' route through
    // quarantine + DROP — semantically empty branch create/delete pings
    // without a paired Push/PR carry no recall value but stay restorable
    // through F-INFRA-QUARANTINE (30d retention).
    "branch_lifecycle",
    // F-NEW-W2-GH-BRANCH-LIFECYCLE-WINDOW (Wave 3): refines F4 by adding
    // a ±24h paired-activity window. CreateEvent/DeleteEvent for which
    // no PushEvent/PullRequestEvent appears on the same (canonical repo
    // basename, ref) within ±24h are bucketed under this orphan reason;
    // the legacy `branch_lifecycle` is retained as the fail-open fallback
    // (no parseable ts / no repo basename), so the operator can monitor
    // both buckets independently.
    "gh_branch_lifecycle_orphan_drop",
    // F-NEW-W3-GH-BRANCH-LIFECYCLE-PAIRED-SCORE: paired branch-lifecycle
    // PASS+downgrade. CreateEvent/DeleteEvent with a Push/PR in the same
    // (canonical repo basename, ref) ±24h window stay in the ledger but
    // their structural_score is forced to 0.30 (vs the substantive_prose
    // ~0.70 default). The W2 implementation passed through without an
    // explicit score, deviating from the predicate; this rung closes the
    // gap and lets the operator monitor the downgrade fire rate
    // independently of the orphan-drop rate.
    "gh_branch_lifecycle_paired_downgrade",
    // F-T2-GITHUB_EVENTS-F8 (Wave 2): cross-source dedup vs git-log.
    // PushEvent whose head SHA is already present in the git-log ledger
    // (same repo, same commit) DROPs through quarantine — the git-log
    // copy carries fuller author + body context. Set is keyed on
    // (repo, sha) to avoid cross-repo cherry-pick false positives.
    "duplicate_of_gitlog_commit",
    // F-NEW-W7-GITHUB-REPO-OWNERSHIP: empty PushEvents on third-party
    // repos (commits=0 AND first_message=null AND repo owner is NOT in the
    // canonical operator-owned set) DROP through quarantine instead of
    // surviving as the 0.10 downgrade. Rationale: empty third-party push
    // pings cannot be rescued via git-log cross-source corroboration (the
    // operator has no local clone), so the embed budget they consume buys
    // no salience signal. The operator-owned variant retains the 0.10
    // downgrade so the git-log SHA index (F8) can still recover them.
    // Quarantine retention is the standard 30d so a recovery-via-restore
    // path remains available if the operator's repo allowlist drifts.
    "gh_empty_push_third_party",

    // codex-cli (R28 agent-runtime hook)
    "empty_turn",
    // e6-contentfree-promotion: codex-cli Tier-2 drop for assistant turns that
    // are pure process narration ("Still progressing…", "I'll pull the tracker…").
    // Registered here in the same change per this module's own contract above;
    // omitting it turned mcp/test/ingest/stage0-telemetry.test.mjs RED.
    "process_narration",
    "codex_slash_command",
    "environment_context_only",
    // F-T1-CODEX_CLI-F1 — unified scaffold-prefix DROP. Primary path: the
    // connector tags auto-injected user turns with raw_content.auto_injected
    // at write-time, Stage-0 keys off the flag. Fallback path: anchored
    // regex over user_text catches unflagged historical data. Both paths
    // route to quarantine (14-day retention) rather than irreversible DROP.
    "codex_scaffold_auto_injected",
    "codex_scaffold_regex_fallback",
    // F-T2-CODEX_CLI-F3 (Wave 2) — brutalist persona-style assistant-only
    // template outputs (Findings/Verdict/Critical Path/Dependency Map/
    // Attack Surface/Systemic Rot/Bottom Line/Brutal Analysis|Summary|
    // Truth/Counterpart Gaps/Architecture). Short stubs only (< 800 chars);
    // long-form analyses (>= 3000 chars) survive. Routes through
    // quarantine (14d) per CRITIC INVARIANT — never permanent DROP.
    "codex_brutalist_template_output",
    // F-T2-CODEX_CLI-F4 (Wave 2) — bot envelope carrying a red-team
    // automation's done-marker status payload. Routes through quarantine (14d).
    "codex_bot_envelope",
    // F-NEW-W7-CODEX-STATUS-PING-DOWNGRADE — short assistant-only "status
    // ping" narration ("Checks are running.", "I'm reloading and checking
    // browser console.", "The rewrite is in place.", "Let me check the
    // file."). These polite check-in phrases sail past the 64-char
    // subject_only cliff via polite phrasing but carry zero recall value.
    // STATUS_PING_RE is anchored at start-of-string and gated on
    // assistantText.length < 200 chars so longer turns that BEGIN with a
    // status ping and continue into real work survive. Routes through
    // quarantine (14d) per CRITIC INVARIANT — never permanent DROP.
    // F-NEW-W7-CODEX-TURN-ABORTED-SCAFFOLD adds the same Wave-7 audit's
    // sibling rule: <turn_aborted>/<session_aborted>/<tool_use_error>/
    // <command_interrupted> envelopes are now part of SCAFFOLD_USER_RE so
    // they DROP through "codex_scaffold_regex_fallback" instead of
    // PASSing as operator content — no new reason key needed there
    // because the existing scaffold_regex_fallback bucket already counts
    // every envelope-class catch.
    "codex_assistant_status_ping",
    // F-W-CODEX-TOOL-CALL-BLOCK — assistant-only turns that are nothing but
    // bracketed [external_agent_tool_call]/[external_agent_tool_result]
    // envelopes (46% of one measured week's promoted facts). Routes through
    // quarantine (14d) per CRITIC INVARIANT — never permanent DROP.
    "codex_tool_call_block",

    // F-T2-CHAT_CLAUDE-CODE-F6 / F7 (Wave 2) — Claude Code agent-runtime hook.
    // empty_turn reuses the codex-cli reason string (both sources route
    // both-sides-empty turns to permanent DROP; no recoverable signal).
    // content_free is the shared-predicate safety net for shape drift —
    // emitted when isContentFree(row, "chat-claude-code") returns drop=true
    // and Rule 1's inline empty check did not fire (e.g. a future
    // content-fields-manifest revision adds another declared field). The
    // dispatcher's recordDrop wrapper counts it; absence here would route
    // it to invalid_reason and emit a one-shot stderr warning.
    "content_free",
    // F-NEW-W2-CHAT-CC-CROSS-SOURCE-DEDUP (Wave 3 follow-up) — cross-source
    // dedup vs codex-cli. When chat-claude-code emits a turn whose
    // (cwd, content_sha256[:12]) collides with a codex-cli ledger row that
    // landed within +/-10min, the chat-claude-code row routes through
    // quarantine (30d retention) and DROPs with this reason. The codex-cli
    // copy is the canonical keep because it usually carries the fuller
    // system_prompt_hash + tool_calls context for the same operator session.
    // Mitigation: tight +/-10min window + (cwd, sha12) compound key prevents
    // legitimate dual-tool sessions from being dropped.
    "chat_cc_codex_dedup",
    // F-T2-CODEX_CLI-F6 (Wave 2) — system_prompt_hash replay. NOT a drop:
    // emitted as a PASS reason so the operator can see how often the
    // structural_score downgrade fires. The row stays in the ledger; only
    // its structural_score is lowered so Layer-2 selection prefers the
    // canonical first row for the (system_prompt_hash, utc_day) pair.
    // Critic-invariant mandated downgrade-via-low-structural_score over
    // DROP because the row still carries cross-source corroboration value.
    "system_prompt_replay",

    // whatsapp (R39 Phase 3b)
    "media_no_caption",
    "broadcast",
    "sticker_only",
    "empty_message",
    // WU-whatsapp (F-T2-WHATSAPP-F1, F2, F9):
    //   whatsapp_deleted_boilerplate    — F1: localized "this message was
    //                                     deleted" boilerplate text;
    //                                     DROP via quarantineRow (30d).
    //   identifier_body_placeholder     — identifier-body content shape;
    //                                     DROP via quarantineRow.
    //   low_signal_message_type         — compatibility bucket for an
    //                                     already-stamped producer marker;
    //                                     DROP via quarantineRow.
    //   whatsapp_cross_source_duplicate — F9: (peer_jid, content_hash,
    //                                     5min) collision with an
    //                                     iMessage ledger row. The
    //                                     pre-embed probe stamps
    //                                     raw_content.cross_source_dup-
    //                                     licate=true; Stage-0 DROPs via
    //                                     quarantineRow (30d). Gated on
    //                                     >=25 normalised chars to defang
    //                                     short-phrase collisions.
    "whatsapp_deleted_boilerplate",
    "identifier_body_placeholder",
    "low_signal_message_type",
    "whatsapp_cross_source_duplicate",

    // telegram / slack (R38 Phase 2c)
    "channel_lifecycle",
    "bot_forward",
    "reaction",
    "thread_broadcast_empty",
    "file_share_no_text",
    // F-T2-TELEGRAM-F3 — channel broadcast DROP via quarantine. Routes 1:N
    // mass-media channel posts (subscribed Telegram channels) through
    // F-INFRA-QUARANTINE (30d retention) so an operator-engaged channel can
    // be restored if the engagement signal is missed. Carve-outs in
    // stage0/telegram.js exempt is_outgoing rows and any peer_id present in
    // CAPS.TELEGRAM_CHANNEL_ALLOWLIST.
    "channel_broadcast",
    // F-T2-TELEGRAM-F4 — forwarded-from-channel echo DROP via quarantine.
    // A group member forwarding a public-channel post into the group is a
    // double-embed when the operator subscribes to the channel directly.
    // Operator-initiated forwards (is_outgoing) are exempted so save-for-
    // later forwards survive.
    "channel_forward_echo",
    // F-T2-SLACK-F10 (Wave 2): Slackbot-authored system messages
    // (user='USLACKBOT' — reminders, /remind output, Workflow Builder
    // runs). Routes through quarantineRow (30-day retention) per the
    // critic invariant on new DROP paths so a legitimate /remind
    // self-reminder is restorable.
    "slackbot_system",
    // F-T2-SLACK-F4 (Wave 2): message_changed events whose inner
    // text matches the previous text after whitespace normalisation
    // (reaction-only edit, attachment-only reorder). Routes through
    // quarantineRow (30-day retention) so a misclassified edit is
    // restorable; the dispatcher's recordDrop counter shows the fire
    // rate as the F-T2-SLACK-F4 observability denominator.
    "edit_no_change",
    // F-T2-SLACK-F6 (Wave 2): cross-source dedup — a slack row whose
    // normalised text hash matched a recent imessage / github-events /
    // mail entry within a 30-minute window. The upstream pre-embed probe
    // stamps raw_content.cross_source_duplicate=true; Stage-0 then DROPs
    // via quarantine. Gated on >=30 chars of normalised text to defang
    // hash collisions on short replies. Until the cross-source probe
    // substrate ships, the counter remains at zero — the wiring is in
    // place so probe-on/off is a one-flip activation.
    "slack_cross_source_duplicate",

    // mail (R39 Phase 3a)
    "list_id",
    "list_unsubscribe",
    "noreply_sender",
    "auto_submitted",
    "marketing_platform",
    "bulk_precedence",
    "apple_automated",
    "voice_video_metadata_only",
    "group_system_event",
    // F-T2-MAIL-F11 (WU-mail-extend): operator-classified Junk/Spam/
    // Trash/Bulk Mail/Deleted Messages folder placement. Routes through
    // quarantineRow (30-day retention) so the operator can restore a
    // misfile; the dispatcher's recordDrop call increments the per-
    // reason counter so /ops/stage0-fire-counts shows the fire rate
    // (F-T2-MAIL-F10 observability).
    "operator_junk_folder",
    // F-T2-MAIL-F5 (WU-mail-rules / Wave 3): subject-anchored OOO /
    // auto-reply / vacation responder patterns the RFC 3834
    // Auto-Submitted header misses (older Exchange + pre-2022 Gmail).
    // Quarantined (30d) for restorability.
    "subject_autoreply",
    // F-T2-MAIL-F5 (WU-mail-rules / Wave 3): carrier / MTA / spam-filter
    // bracket tags ([SPAM] / [EXTERNAL] / [DELIVERY FAILURE] / etc.) at
    // subject start. Quarantined (30d) for restorability.
    "subject_bracket_noise",
  ])
);

// ---------------------------------------------------------------------------
// In-process counter state. Process-local; cleared on flush. Caller
// (dispatcher wrapper) holds the only reference.
// ---------------------------------------------------------------------------
const COUNTERS = new Map(); // key=`${source}::${decision}::${reason}` → count
let INCREMENT_SINCE_LAST_FLUSH = 0;
const NOVEL_REASON_WARNED = new Set(); // dedupe stderr spam
let SHUTDOWN_HOOKS_INSTALLED = false;

// ---------------------------------------------------------------------------
// recordDrop — bump the counter for a single dispatch outcome.
//
// Caller passes the source, reason, and decision (the three dispatch
// observables). Reason=null is canonicalised to "pass" so PASS outcomes
// also get a bucket — the operator needs the PASS volume as the
// denominator for any drop-rate calculation.
//
// Returns the (canonicalised, post-cap, post-allowlist) reason string
// that was actually counted so tests can assert behaviour.
// ---------------------------------------------------------------------------
export function recordDrop(source, reason, decision) {
  const safeSource =
    typeof source === "string" && source.length > 0 ? source : "unknown_source";
  const safeDecision =
    typeof decision === "string" && decision.length > 0 ? decision : "PASS";

  let canonicalReason;
  if (reason == null || reason === "") {
    canonicalReason = "pass";
  } else if (typeof reason !== "string") {
    canonicalReason = "invalid_reason";
  } else if (REASON_ALLOWLIST.has(reason)) {
    canonicalReason = reason;
  } else {
    canonicalReason = "invalid_reason";
    if (!NOVEL_REASON_WARNED.has(reason)) {
      NOVEL_REASON_WARNED.add(reason);
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[stage0-telemetry] novel reason "${reason}" (source=${safeSource}) bucketed into invalid_reason; add it to REASON_ALLOWLIST in lib/ingest/stage0/telemetry.js`
        );
      } catch {
        /* never let logging fail the hot path */
      }
    }
  }

  const key = `${safeSource}::${safeDecision}::${canonicalReason}`;
  const existing = COUNTERS.get(key);
  if (existing !== undefined) {
    COUNTERS.set(key, existing + 1);
  } else if (COUNTERS.size >= TELEMETRY_REASON_CAP) {
    // Cardinality cap: do NOT add a new key. Fold into the synthetic
    // 'other' bucket for this source+decision instead.
    const overflowKey = `${safeSource}::${safeDecision}::other`;
    COUNTERS.set(overflowKey, (COUNTERS.get(overflowKey) || 0) + 1);
  } else {
    COUNTERS.set(key, 1);
  }

  INCREMENT_SINCE_LAST_FLUSH += 1;
  installShutdownHooksOnce();
  if (INCREMENT_SINCE_LAST_FLUSH >= TELEMETRY_FLUSH_EVERY_N) {
    try {
      flushCounters({ sync: false });
    } catch {
      // Flush failures must NOT crash the ingest hot path. We keep the
      // in-memory counters and try again on the next increment.
    }
  }
  return canonicalReason;
}

// ---------------------------------------------------------------------------
// recordPass — bump a PASS-decision counter with a custom reason.
//
// F-NEW-W5-SCREENTIME-F4-COUNT-ONLY-TELEMETRY (Wave-5 closeout): the
// screentime INIntent null-verb branch (F-NEW-W3-SCREENTIME-F4-INIINTENT-
// VERB-NULL) was shipped as a hard DROP. The W5 review re-opened the
// deferred predicate Q3 ("count-only telemetry pre-stage present and
// documented") and asked for a reversible activation path:
//   1. Operator flips SCREENTIME_INIINTENT_NULL_VERB_MODE=count_only.
//   2. The branch returns PASS with reason=iniintent_null_verb_count_only
//      instead of DROP.
//   3. recordPass increments the per-source PASS counter under that
//      distinct reason so the telemetry sink and snapshotCounters
//      surface the would-be-drop volume.
//   4. After the 7-day observation window the operator either flips back
//      to "drop" (default) or, if the count-only data shows a non-trivial
//      false-positive rate, leaves it in count_only mode while the
//      structural guard is widened.
//
// recordPass is a thin convenience wrapper over recordDrop with
// decision="PASS" hardcoded — every PASS counter is structurally
// identical to a DROP counter, just routed through a different decision
// bucket so the operator's drop-rate dashboard does not double-count
// count-only observations as drops.
//
// Returns the canonicalised reason that was counted (mirrors recordDrop).
// ---------------------------------------------------------------------------
export function recordPass(source, reason) {
  return recordDrop(source, reason, "PASS");
}

// ---------------------------------------------------------------------------
// snapshotCounters — read-only copy for the memory_connectors_list health
// surface. Returns an array of {source, decision, reason, count} entries,
// sorted for deterministic envelope output.
// ---------------------------------------------------------------------------
export function snapshotCounters() {
  const entries = [];
  for (const [key, count] of COUNTERS.entries()) {
    const idx1 = key.indexOf("::");
    const idx2 = idx1 >= 0 ? key.indexOf("::", idx1 + 2) : -1;
    if (idx1 < 0 || idx2 < 0) continue;
    const source = key.slice(0, idx1);
    const decision = key.slice(idx1 + 2, idx2);
    const reason = key.slice(idx2 + 2);
    entries.push({ source, decision, reason, count });
  }
  entries.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    if (a.decision !== b.decision) return a.decision.localeCompare(b.decision);
    return a.reason.localeCompare(b.reason);
  });
  return entries;
}

// ---------------------------------------------------------------------------
// flushCounters — append the current Map as a single JSONL row and zero
// the Map. The row shape is:
//   {
//     ts: <ISO8601>,
//     flush_kind: "tick" | "shutdown" | "manual",
//     total_counted: <sum of all counts>,
//     distinct_keys: <COUNTERS.size at flush time>,
//     counters: [ {source, decision, reason, count}, ... ]
//   }
//
// One JSONL row per flush keeps downstream stream readers simple: each
// line is a complete window. The daily rotation keeps any single sink
// file bounded (~one row per 1000 events, with worst-case ~86 flushes/sec
// at saturated dispatch = still well under a million rows/day).
//
// opts.sync (default true on shutdown, false on tick) controls whether
// we issue the fsync. The tick-path skips fsync for throughput; the
// shutdown-path forces fsync because the process is about to exit.
// ---------------------------------------------------------------------------
export function flushCounters(opts = {}) {
  const flushKind =
    typeof opts.flush_kind === "string" ? opts.flush_kind : "tick";
  const wantSync = opts.sync === true;

  if (COUNTERS.size === 0) {
    // Nothing to write. Reset the increment counter so we don't
    // re-trigger immediately.
    INCREMENT_SINCE_LAST_FLUSH = 0;
    return { wrote: false, rows: 0 };
  }

  const counters = snapshotCounters();
  let total = 0;
  for (const c of counters) total += c.count;

  const row = {
    ts: serverTs(),
    flush_kind: flushKind,
    total_counted: total,
    distinct_keys: COUNTERS.size,
    counters,
  };

  const path = currentSinkPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // If we cannot create the sink dir, we still must not retain
      // the in-memory counters forever — clear them so memory doesn't
      // grow unbounded.
      COUNTERS.clear();
      INCREMENT_SINCE_LAST_FLUSH = 0;
      return { wrote: false, rows: 0 };
    }
  }

  const bytes = Buffer.from(JSON.stringify(row) + "\n", "utf8");
  if (wantSync) {
    // Shutdown path: open + write + fsync + close.
    const fd = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_NOFOLLOW,
      0o600
    );
    try {
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      try {
        fsyncSync(fd);
      } catch {
        /* fsync failure on shutdown is best-effort */
      }
    } finally {
      closeSync(fd);
    }
  } else {
    // Tick path: appendFileSync is the simplest path that flushes the
    // line through the kernel's page cache. We skip fsync for throughput.
    appendFileSync(path, bytes, { mode: 0o600 });
  }

  COUNTERS.clear();
  INCREMENT_SINCE_LAST_FLUSH = 0;
  return { wrote: true, rows: counters.length, path };
}

// ---------------------------------------------------------------------------
// currentSinkPath — daily-rotated JSONL sink. Derives the date suffix
// from the current UTC date so the rollover is deterministic across
// machines and timezones.
//
// Path: <STORAGE_DIR>/telemetry/stage0_counters_<YYYY-MM-DD>.jsonl
// ---------------------------------------------------------------------------
export function currentSinkPath(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return join(
    STORAGE_DIR,
    "telemetry",
    `stage0_counters_${yyyy}-${mm}-${dd}.jsonl`
  );
}

// ---------------------------------------------------------------------------
// Shutdown hook registration. Idempotent; safe to call from every
// recordDrop. The handlers themselves are wrapped so a flush failure
// never blocks process exit.
//
// We install handlers for:
//   - SIGTERM: graceful daemon stop (systemd / launchd / `kill <pid>`)
//   - SIGINT:  Ctrl-C in foreground runs
//   - beforeExit: natural event-loop drain (tests + short-lived CLIs)
//
// `process.once` is used for SIGTERM / SIGINT because we want the
// first signal to flush + re-emit the default behaviour (process exit).
// beforeExit may fire multiple times if userland schedules more work;
// we re-flush each time but the work is cheap when COUNTERS is empty.
// ---------------------------------------------------------------------------
function installShutdownHooksOnce() {
  if (SHUTDOWN_HOOKS_INSTALLED) return;
  SHUTDOWN_HOOKS_INSTALLED = true;
  if (typeof process === "undefined" || typeof process.on !== "function") {
    return;
  }
  const flushOnSignal = (signal) => {
    try {
      flushCounters({ sync: true, flush_kind: "shutdown" });
    } catch {
      /* never block exit */
    }
    // Re-raise default behaviour: detach our listener and re-send the
    // signal so the process exits with the conventional 128 + signo
    // status. If no other listener is attached this terminates.
    try {
      process.kill(process.pid, signal);
    } catch {
      /* if we cannot re-raise, fall through and let userland exit */
    }
  };
  try {
    process.once("SIGTERM", () => flushOnSignal("SIGTERM"));
    process.once("SIGINT", () => flushOnSignal("SIGINT"));
    process.on("beforeExit", () => {
      try {
        flushCounters({ sync: true, flush_kind: "shutdown" });
      } catch {
        /* never block exit */
      }
    });
  } catch {
    // Some embedded contexts (web workers, vm modules) reject signal
    // registration. We have already set the SHUTDOWN_HOOKS_INSTALLED
    // flag, so we will not retry; the dispatcher still records to
    // memory and the operator can call flushCounters manually.
  }
}

// ---------------------------------------------------------------------------
// resetForTests — test-only escape hatch. Clears the Map, the warning
// dedupe set, and the increment counter. Does NOT uninstall shutdown
// hooks (Node's process is shared across tests).
// ---------------------------------------------------------------------------
export function resetForTests() {
  COUNTERS.clear();
  NOVEL_REASON_WARNED.clear();
  INCREMENT_SINCE_LAST_FLUSH = 0;
}

// ---------------------------------------------------------------------------
// reconcileReasonAllowlist — static analyzer that walks every per-source
// Stage-0 module under mcp/lib/ingest/stage0/*.js (skipping telemetry.js
// and index.js itself) and extracts every reason string that appears in
// a `reason: "<literal>"` field of an object literal — the canonical
// stage0 return shape ({ decision, reason }).
//
// Returns the symmetric difference vs REASON_ALLOWLIST:
//   {
//     scanned_files: [...],
//     reasons_in_code: Set<string>,
//     missing_from_allowlist: [...],   // novel reasons emitted by code
//     unused_allowlist_entries: [...], // allowlist entries no module emits
//   }
//
// CI guarantee: assert symmetric-difference is empty (modulo the
// SYNTHETIC_BUCKETS that the telemetry layer itself emits and which no
// per-source module ever returns).
//
// Implementation is regex-based (no AST) per implementation_hints — v1
// only needs to catch the canonical `reason: "literal"` form used by
// every Stage-0 module today. The regex tolerates both single and double
// quotes and any whitespace around the colon.
//
// Parameters:
//   stage0Dir — override the directory to scan (test injection). Defaults
//     to the per-source modules' own dir (the dir this file lives in).
// ---------------------------------------------------------------------------

// Reasons the telemetry layer ITSELF emits (synthetic buckets that no
// per-source stage0 module will ever return). They live in
// REASON_ALLOWLIST but should NOT be flagged as `unused_allowlist_entries`
// when no module references them.
//
// `identity_hostname_dominance_warn` is in the same category: it is
// emitted from lib/identity/operator-identity.js (NOT from a stage0
// per-source module) via emitHostnameDerivedWarning(). Including it
// here keeps reconcileReasonAllowlist's unused-entry report clean when
// CI runs the static scan.
const SYNTHETIC_BUCKETS = Object.freeze(
  new Set([
    "pass",
    "unknown_source",
    "other",
    "invalid_reason",
    "identity_hostname_dominance_warn",
  ])
);

// Files in the stage0 dir that are not per-source modules and should not
// be scanned for reason literals (they don't return stage0 decisions).
const NON_SOURCE_FILES = Object.freeze(
  new Set(["telemetry.js", "index.js"])
);

// Matches `reason: "literal"` or `reason: 'literal'` in an object
// literal. Multi-line tolerant via optional whitespace. We deliberately
// do NOT match template literals or computed values — those would be
// programming errors in a Stage-0 module (reasons must be string
// literals so the allowlist check is meaningful).
const REASON_LITERAL_REGEX = /\breason\s*:\s*(["'])([^"'\n\r\\]+)\1/g;

// F-NEW-W1-R40-CONST-BOUND-REASONS — second-pass support for const-bound
// reason identifiers. Per-source modules increasingly bind reason strings
// to UPPER_SNAKE consts at the top of the file (e.g.
// `const REASON_BRANCH_LIFECYCLE = "branch_lifecycle";` in githubevents.js,
// `const REASON_ITERM2_EMPTY = "screentime_iterm2_empty_notif";` in
// screentime.js) and emit them via `reason: REASON_X` OR via an
// intermediate binding like `const dropReason = cond ? REASON_X :
// REASON_Y; ...; reason: dropReason`. The original REASON_LITERAL_REGEX
// only catches inline literals — without this pass, const-bound reasons
// drop out of the reconciler's reasons_in_code set and surface as
// false-positive `unused_allowlist_entries`.
//
// Two narrowly-scoped regexes — no AST. Both accept single and double
// quotes, and the IDENT regex requires the canonical REASON_<UPPER_SNAKE>
// shape so we do NOT accidentally resolve unrelated consts (e.g. a
// `const FOO = "bar"` would never be picked up because FOO is not
// REASON_<UPPER_SNAKE>). REASON_CONST_REF_REGEX matches ANY non-decl
// reference to the identifier in the file (`REASON_X` appearing outside
// of `const REASON_X = ...`) — covers both `reason: REASON_X` direct use
// and indirect use through a temporary binding (ternary, switch, helper
// arg). This is intentionally broad: we treat the bare presence of a
// reference as evidence the const flows to a dispatch outcome somewhere,
// because every REASON_<UPPER_SNAKE> in the Stage-0 modules exists for
// that purpose by convention.
const REASON_CONST_DECL_REGEX =
  /\bconst\s+(REASON_[A-Z0-9_]+)\s*=\s*(["'])([^"'\n\r\\]+)\2\s*;?/g;
const REASON_CONST_REF_REGEX = /\b(REASON_[A-Z0-9_]+)\b/g;

export function reconcileReasonAllowlist(stage0Dir) {
  const dir =
    typeof stage0Dir === "string" && stage0Dir.length > 0
      ? stage0Dir
      : dirname(fileURLToPath(import.meta.url));

  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(
      `reconcileReasonAllowlist: cannot read stage0 dir ${dir}: ${err.message}`
    );
  }

  const scannedFiles = [];
  const reasonsInCode = new Set();
  for (const name of entries) {
    if (!name.endsWith(".js")) continue;
    if (NON_SOURCE_FILES.has(name)) continue;
    const full = join(dir, name);
    let src;
    try {
      src = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    scannedFiles.push(full);
    REASON_LITERAL_REGEX.lastIndex = 0;
    let m;
    while ((m = REASON_LITERAL_REGEX.exec(src)) !== null) {
      reasonsInCode.add(m[2]);
    }
    // F-NEW-W1-R40-CONST-BOUND-REASONS — second pass. Build a local
    // identifier→literal map from `const REASON_X = "<value>";` decls,
    // then resolve every `reason: REASON_X` usage in the same file. We
    // intentionally scope the identifier map per-file (no cross-module
    // resolution) because the const-binding convention is local-only
    // and a cross-file pass would invite name-collision false positives.
    const identMap = new Map();
    REASON_CONST_DECL_REGEX.lastIndex = 0;
    let d;
    while ((d = REASON_CONST_DECL_REGEX.exec(src)) !== null) {
      identMap.set(d[1], d[3]);
    }
    if (identMap.size > 0) {
      // The declaration itself counts as one reference of each
      // identifier; we want to surface the const literal only when at
      // least one OTHER reference exists. Track per-identifier
      // reference counts and require >= 2 (decl + at least one usage)
      // before resolving the literal into reasons_in_code. Bare
      // reference (not just `reason: REASON_X`) is sufficient because
      // some modules route the const through an intermediate binding
      // (ternary, switch, helper arg) that a usage-site regex cannot
      // follow without an AST.
      const refCount = new Map();
      REASON_CONST_REF_REGEX.lastIndex = 0;
      let r;
      while ((r = REASON_CONST_REF_REGEX.exec(src)) !== null) {
        const ident = r[1];
        if (!identMap.has(ident)) continue;
        refCount.set(ident, (refCount.get(ident) || 0) + 1);
      }
      for (const [ident, count] of refCount) {
        if (count < 2) continue;
        const literal = identMap.get(ident);
        if (typeof literal === "string" && literal.length > 0) {
          reasonsInCode.add(literal);
        }
      }
    }
  }

  const missingFromAllowlist = [];
  for (const r of reasonsInCode) {
    if (!REASON_ALLOWLIST.has(r)) missingFromAllowlist.push(r);
  }

  const unusedAllowlistEntries = [];
  for (const r of REASON_ALLOWLIST) {
    if (SYNTHETIC_BUCKETS.has(r)) continue;
    if (!reasonsInCode.has(r)) unusedAllowlistEntries.push(r);
  }

  // Deterministic ordering so a snapshot/CI diff is stable.
  missingFromAllowlist.sort();
  unusedAllowlistEntries.sort();
  scannedFiles.sort();

  return {
    scanned_files: scannedFiles,
    reasons_in_code: reasonsInCode,
    missing_from_allowlist: missingFromAllowlist,
    unused_allowlist_entries: unusedAllowlistEntries,
  };
}
