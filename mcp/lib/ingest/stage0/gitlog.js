// Stage-0 hard-drop module for the `git-log` source.
//
// Rules (verbatim from kb/salience-design.md § Layer 1, plus Wave 3
// closures from F-NEW-W2-GIT-LOG-STAGE0-CONSUMES-SCORE and
// F-NEW-W2-GIT-LOG-STAGE0-INITIAL-COMMIT):
//
//   0a. raw_content.repo_classification === "upstream_only" AND
//       raw_content.suggested_structural_score === 0.10
//                                                            → PASS at
//       structural_score 0.10, reason "git_log_upstream_repo_downgrade".
//       The connector layer (lib/connectors/git-log-local.js, F-T1-GIT_LOG-F2)
//       tags upstream-only repos at write time; this rule honours the
//       hint instead of dropping it on the floor.
//
//   1.  raw_content.subject matches /^["' ]*initial commit\b/i OR
//       raw_content.parents.length === 0 OR
//       raw_content.is_initial_commit === true                → DROP
//       (reason "git_log_initial_commit_drop", routed through
//       quarantineRow with 30-day restore window per the W2 critic
//       invariant — never permanent DROP).
//
//   2.  raw_content.subject matches /^Merge (branch|pull request|tag)/
//       AND body empty/null                                   → DROP
//       (reason "merge_only").
//
//   3.  raw_content.author_email matches isBotActor() (canonical
//       lib/identity/bot-actors.js predicate — covers dependabot,
//       renovate, renovate-bot, github-actions, copilot, web-flow,
//       pr-bot, claude[bot], gpt-engineer-app[bot], and the generic
//       `[bot]@` suffix; handles GitHub's `<digits>+` noreply prefix).
//                                                              → DROP
//       (reason "bot_commit").
//
//   4.  otherwise                                              → PASS
//       (substantive_prose vs subject_only structural score).

import { CAPS } from "../../validation.js";
import { isBotActor } from "../../identity/bot-actors.js";
import { isOperator } from "../../identity/operator-identity.js";
import { quarantineRow } from "../quarantine.js";
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — canonical band helper.
// git-log's PASS path bands by body-empty (subject_only) vs body-present
// (substantive_prose). We model this via resolveBand directly because the
// signal is structural emptiness, not a char-length cliff — the central
// computeStructuralScore helper expects a length comparison.
import { resolveBand } from "../structural-score.js";
// WU-A3-git-log-content-dedup — generic Stage-1 cross-source dedup
// substrate. Used here for the SAME-source content-hash contract
// (gitlog-content-dedup): the OpenWrt-feed corpus produces 64,851 /
// 80,128 commits whose (repo, sha) tuples differ but whose subject+body
// is byte-identical (e.g. "mt76: update to the latest version" x223
// across vendor mirrors). Detect at Stage-0 BEFORE the row is embedded
// so we burn zero Gemini quota on dups and the kNN index isn't polluted
// with near-anchor neighbours for the same fact.
import { checkCrossSourceDuplicate } from "../cross-source-dedup.js";

const MERGE_SUBJECT_RE = /^Merge (branch|pull request|tag)\b/;

// F-T1-GIT_LOG-F7 — boilerplate-subject DROP. Subjects matching this
// regex are conventionally low-signal (WIP, Checkpoint, Cleanup, typo
// fixes, dead-code removal, README touch-ups, code-style runs, "Run
// black", "chore:" trailers, etc). Per the critic's blocking modification
// the regex alone is NOT sufficient — Stage-0 ALSO requires that the
// commit body provide no countervailing signal. A "WIP: Refactored
// payment pipeline" with a multi-paragraph %B body is substantive and
// must PASS; a bare "WIP" with empty/boilerplate body DROPS.
//
// The body discrimination is implemented in three layers below
// (BOILERPLATE_BODY_MIN_LENGTH + BOILERPLATE_BODY_RE applied inside the
// rule). Both signals must agree before the row is quarantined.
const BOILERPLATE_SUBJECT_RE =
  /^(WIP|wip|Checkpoint|Cleanup|Fix typo|Remove dead code|Update README\.md|Improve code style|Move index\.html|Run black|More cleanup|chore:)/i;

// Bodies shorter than this byte count add NO substantive countervailing
// signal — even if non-empty, a 30-char body on a "WIP" subject is
// effectively a continuation of the boilerplate (e.g. "wip", "tmp",
// "checkpoint before lunch"). Matches the critic's "<80" floor verbatim.
const BOILERPLATE_BODY_MIN_LENGTH = 80;

// Bodies whose content also matches the boilerplate pattern (e.g.
// subject="WIP", body="WIP\nstill cleaning up") are themselves
// boilerplate — DROP. This catches the operator habit of pasting the
// subject into the body on quick checkpoint commits.
const BOILERPLATE_BODY_RE = BOILERPLATE_SUBJECT_RE;

// F-T1-GIT_LOG-F8 — version-bump DROP. Bot-authored version bumps
// (dependabot, renovate, github-actions auto-PR-merge) are pure noise
// in the ledger; the connector layer already downgrades them but a
// distinct quarantine reason lets the operator monitor F8 fire-rate
// independently of the generic bot_commit bucket. Per the critic's
// modification F8 catches ONLY bot-authored bumps — an operator-authored
// "Bump openssl to 3.0.13" is a security/migration signal and must
// remain in the ledger (it already PASSes via Rule -1 above).
const VERSION_BUMP_SUBJECT_RE =
  /^(Bump|chore\(deps\)|update to latest)/i;

// Case-insensitive prefix match for any "Initial commit" variant.
// Mirrors INITIAL_COMMIT_SUBJECT_RE in lib/connectors/git-log-local.js so
// the connector and Stage-0 layers share one predicate. Covers:
//   "Initial commit"          (canonical)
//   "initial commit"          (lowercase)
//   "Initial commit: scaffold" (subject prefix with suffix)
//   "Initial commit"          (with leading quotes/spaces from CSV exports)
//   "'Initial commit'"        (single-quoted dumps)
// The `\b` word boundary prevents matches against subjects like
// "Initial commitment to refactor" (a real prose commit).
const INITIAL_COMMIT_SUBJECT_RE = /^["' ]*initial commit\b/i;

// F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT — local mirror of the connector
// helper (lib/connectors/git-log-local.js initialCommitSuffix). Stage-0
// modules are designed to be runnable without the connector layer (the
// test fixtures synthesise raw_content directly), so we duplicate the
// regex + min-length floor here. Kept in lockstep with the connector
// copy: every change must edit both files.
const INITIAL_COMMIT_WITH_SUFFIX_RE = /^["' ]*initial commit:\s+(\S.*)$/i;
const INITIAL_COMMIT_SUFFIX_MIN_LENGTH = 25;
function initialCommitSuffix(subject) {
  if (typeof subject !== "string") return null;
  const m = INITIAL_COMMIT_WITH_SUFFIX_RE.exec(subject);
  if (!m) return null;
  const suffix = (m[1] || "").trim();
  if (suffix.length <= INITIAL_COMMIT_SUFFIX_MIN_LENGTH) return null;
  return suffix;
}

// F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT — PASS score for the carve-out.
// 0.55 sits between subject_only (0.5) and substantive_prose (0.85) — the
// suffix signals project intent but the rest of the row's content is
// still root-commit scaffolding so the score is intentionally modest.
const INITIAL_COMMIT_WITH_SUFFIX_SCORE = 0.55;

// F-NEW-W7-GIT-LOG-AUTHOR-SELF — floor score for the operator-authored
// pass-through. The rule pins structural_score to max(0.7, current_score)
// so author-self commits never get accidentally downgraded by downstream
// heuristics that don't yet know to honour the operator-author signal.
const OPERATOR_AUTHORED_FLOOR_SCORE = 0.7;

// Connector-side classifier sentinel: the upstream-only repo downgrade
// publishes raw_content.suggested_structural_score = 0.10 alongside
// raw_content.repo_classification = "upstream_only". Rule 0a gates on
// BOTH so a future hint with a different score (e.g. bot 0.05) routes
// through its own dedicated rule rather than collapsing into this one.
const UPSTREAM_REPO_DOWNGRADE_SCORE = 0.10;

function emptyBody(body) {
  if (body === null || body === undefined) return true;
  if (typeof body !== "string") return false;
  return body.trim().length === 0;
}

// F-NEW-W7-GIT-LOG-RULE1-TIGHTEN — tightened predicate. Previously this
// fired on EITHER the subject prefix OR parents.length===0 OR the
// is_initial_commit hint. The audit found the parents=[] branch was
// over-reaching: stash-snapshot synthetic-node commits, freshly rewritten
// branches, and substantive scaffolds (e.g. "sync workspace sources" at 6500
// LOC ML work) all carry parents=[] but are NOT semantically empty
// initial commits. The retuned rule REQUIRES the subject prefix match
// AND a corroborating signal (parents=[] OR the connector-stamped
// is_initial_commit hint). When the subject does not match — even with
// parents=[] — we no longer quarantine, allowing legitimate root commits
// with substantive subjects to flow through to the PASS path where
// numstat-based scoring takes over.
//
// Parents=[] alone is now a CORROBORATING signal (not a sole trigger).
// Callers wanting the legacy "any parents=[] is initial" behaviour should
// pass {strict_no_parents: true} but no caller does — the legacy
// behaviour was a bug.
function isInitialCommitVariant(rc) {
  const subject = typeof rc.subject === "string" ? rc.subject : "";
  const subjectMatches = INITIAL_COMMIT_SUBJECT_RE.test(subject);
  if (!subjectMatches) return false;
  // Subject matches; require corroboration.
  const noParents = Array.isArray(rc.parents) && rc.parents.length === 0;
  const isInitialHint = rc && rc.is_initial_commit === true;
  return noParents || isInitialHint;
}

// _shapeForQuarantine — quarantineRow requires row.source. Stage-0
// receives event objects that already carry source="git-log" from the
// dispatcher; the defensive stamp covers callers that bypass the
// dispatcher (tests that invoke stage0() directly with a synthetic
// event).
function _shapeForQuarantine(event) {
  if (event && typeof event === "object") {
    if (typeof event.source === "string" && event.source.length > 0) return event;
    return { ...event, source: "git-log" };
  }
  return { source: "git-log", raw_content: {} };
}

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};

  // -------------------------------------------------------------------
  // Rule -1 — F-NEW-W7-GIT-LOG-AUTHOR-SELF. Operator-authored pass-through.
  //
  // Highest priority among PASS-class rules. When the author email
  // matches the operator (canonical R42 identity map, source-hint
  // "git-log") AND the row is NOT bot-authored, return PASS with
  // structural_score = max(OPERATOR_AUTHORED_FLOOR_SCORE,
  //                        rc.suggested_structural_score).
  // The audit traced repeated cases where operator-self commits were
  // mishandled by downstream heuristics that didn't know the author
  // signal — they applied subject_only (0.5) or even noise (0.10) when
  // the operator was the one writing the commit. Pinning a floor of
  // 0.7 here prevents that. The bot guard is critical: a bot that
  // happens to share an operator-aliased email (rare but seen with
  // CI-bot integrations that impersonate the human owner) must NOT
  // ride this rule into the ledger at high score.
  //
  // The rule fires AHEAD of the upstream-only / initial-commit /
  // merge-only / bot rules because the author signal trumps repo or
  // subject heuristics: an operator commit in an upstream-only repo is
  // a first-fork or contribution event and should NOT be downgraded
  // to 0.10.
  //
  // Reason: "git_log_operator_authored_passthrough" — registered in
  // REASON_ALLOWLIST as a PASS bucket (the dispatcher records the
  // counter regardless of decision).
  // -------------------------------------------------------------------
  const authorEmailForSelfCheck =
    typeof rc.author_email === "string" ? rc.author_email : "";
  const isBotAuthorForSelfCheck =
    authorEmailForSelfCheck !== "" && isBotActor(authorEmailForSelfCheck);
  // Honor the connector-stamped flag first if present (avoids re-running
  // isOperator()); fall back to the live identity check so Stage-0 is
  // usable even when invoked against a synthetic event that did not pass
  // through the connector.
  const isOperatorAuthored =
    rc.is_operator_authored === true
      ? !isBotAuthorForSelfCheck
      : !isBotAuthorForSelfCheck &&
        authorEmailForSelfCheck !== "" &&
        isOperator(authorEmailForSelfCheck, "git-log");
  if (isOperatorAuthored) {
    const suggested = Number(rc.suggested_structural_score);
    const floor = OPERATOR_AUTHORED_FLOOR_SCORE;
    const structural_score = Number.isFinite(suggested)
      ? Math.max(floor, suggested)
      : floor;
    return {
      decision: "PASS",
      reason: "git_log_operator_authored_passthrough",
      structural_score,
    };
  }

  // -------------------------------------------------------------------
  // Rule 0a — F-NEW-W2-GIT-LOG-STAGE0-CONSUMES-SCORE.
  // Honor the connector-side upstream-only downgrade. The connector
  // (F-T1-GIT_LOG-F2) classifies repos and stamps raw_content with
  //   { repo_classification: "upstream_only",
  //     suggested_structural_score: 0.10 }
  // Without this rule the hint never affects scoring — the entire
  // 50-64% corpus-reduction lever was orphaned in Wave 2.
  //
  // Gating on BOTH fields (not just the score) ensures a future hint
  // with the same 0.10 value but a different classification is not
  // accidentally swept into this bucket.
  // -------------------------------------------------------------------
  if (
    rc.repo_classification === "upstream_only" &&
    rc.suggested_structural_score === UPSTREAM_REPO_DOWNGRADE_SCORE
  ) {
    return {
      decision: "PASS",
      reason: "git_log_upstream_repo_downgrade",
      structural_score: UPSTREAM_REPO_DOWNGRADE_SCORE,
    };
  }

  // -------------------------------------------------------------------
  // Rule 0b — F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT. Substantive
  // "Initial commit: <suffix>" carve-out. The audit recovered several
  // root commits where the operator encoded project intent on the
  // subject line ("Initial commit: sample curriculum outline and notes",
  // 12 conceptual files). The legacy Rule 1 quarantined these as
  // initial-commit variants, losing the intent signal entirely. The
  // carve-out detects subjects matching /^["' ]*initial commit:\s+\S/i
  // AND a suffix > 25 chars, then PASSes at structural_score=0.55 with
  // reason 'git_log_initial_commit_with_suffix'. The score sits between
  // subject_only (0.5) and substantive_prose (0.85) because the row is
  // still a root commit but the suffix encodes substantive content.
  //
  // Honour any pre-stamped suggested score from the connector ONLY if
  // it is higher than 0.55 (defensive — the connector-side carve-out
  // already stamps 0.55 when it fires; respecting a higher value
  // preserves the "lowest wins" precedence above).
  // -------------------------------------------------------------------
  const subjectForCarveout =
    typeof rc.subject === "string" ? rc.subject : "";
  const colonSuffix = initialCommitSuffix(subjectForCarveout);
  if (colonSuffix != null) {
    const suggested = Number(rc.suggested_structural_score);
    const score = Number.isFinite(suggested)
      ? Math.max(INITIAL_COMMIT_WITH_SUFFIX_SCORE, suggested)
      : INITIAL_COMMIT_WITH_SUFFIX_SCORE;
    return {
      decision: "PASS",
      reason: "git_log_initial_commit_with_suffix",
      structural_score: score,
    };
  }

  // -------------------------------------------------------------------
  // Rule 1 — F-NEW-W2-GIT-LOG-STAGE0-INITIAL-COMMIT, tightened by
  // F-NEW-W7-GIT-LOG-RULE1-TIGHTEN.
  //
  // The predicate now requires the subject prefix /^["' ]*initial commit\b/i
  // AND a corroborating signal (parents.length===0 OR the connector-
  // stamped is_initial_commit hint). The parents=[]-only branch is
  // dropped from the sole-trigger position because the audit found it
  // over-reached on stash-snapshot synthetic-parents=[] commits and
  // substantive scaffolds whose subjects were NOT "initial commit".
  // Routed through quarantineRow so the row remains restorable for 30
  // days (W2 critic invariant: prefer quarantine over permanent DROP).
  // -------------------------------------------------------------------
  if (isInitialCommitVariant(rc)) {
    try {
      quarantineRow(_shapeForQuarantine(event), "git_log_initial_commit_drop", {
        rule_id: "F-NEW-W2-GIT-LOG-STAGE0-INITIAL-COMMIT",
        source: "git-log",
      });
    } catch {
      // Quarantine is best-effort. If it fails (disk full, perms) we
      // still return DROP — losing a single quarantine entry is
      // preferable to re-emitting an initial-commit row downstream.
    }
    return { decision: "DROP", reason: "git_log_initial_commit_drop" };
  }

  const subject = typeof rc.subject === "string" ? rc.subject : "";
  if (MERGE_SUBJECT_RE.test(subject) && emptyBody(rc.body)) {
    return { decision: "DROP", reason: "merge_only" };
  }

  // -------------------------------------------------------------------
  // Rule 2b — F-T1-GIT_LOG-F7. Boilerplate-subject quarantine.
  //
  // Phase A (F-NEW-W7-GIT-LOG-BODY-CAPTURE) shipped %B body capture, so
  // the rule can now apply the critic's mandatory discrimination: the
  // subject regex alone is insufficient — the body must also fail to
  // provide countervailing signal. Three branches DROP:
  //   (i)   body is empty/whitespace-only,
  //   (ii)  body is non-empty but shorter than BOILERPLATE_BODY_MIN_LENGTH
  //         (80 bytes — the critic's threshold),
  //   (iii) body itself matches BOILERPLATE_BODY_RE (the operator pasted
  //         the boilerplate subject into the body).
  // A substantive body (>=80 bytes that doesn't itself match the
  // boilerplate pattern) PASSES through to Rule 3 / final-score path.
  // Routed via quarantineRow with 30-day retention per the W2 critic
  // invariant — never permanent DROP.
  //
  // Operator-authored boilerplate commits are handled at Rule -1 above
  // (operator-authored pass-through), so this rule only sees bot or
  // unrecognised-author rows.
  // -------------------------------------------------------------------
  if (BOILERPLATE_SUBJECT_RE.test(subject)) {
    const body = typeof rc.body === "string" ? rc.body : "";
    const bodyTrimmed = body.trim();
    const bodyIsBoilerplate =
      bodyTrimmed.length === 0 ||
      bodyTrimmed.length < BOILERPLATE_BODY_MIN_LENGTH ||
      BOILERPLATE_BODY_RE.test(bodyTrimmed);
    if (bodyIsBoilerplate) {
      try {
        quarantineRow(
          _shapeForQuarantine(event),
          "git_log_boilerplate_subject",
          {
            rule_id: "F-T1-GIT_LOG-F7",
            source: "git-log",
          }
        );
      } catch {
        // Quarantine is best-effort. Mirror Rule 1's failure mode.
      }
      return { decision: "DROP", reason: "git_log_boilerplate_subject" };
    }
    // Otherwise fall through — the body is substantive and the row
    // earns the standard PASS path below.
  }

  // -------------------------------------------------------------------
  // Rule 2c — F-T1-GIT_LOG-F8. Bot-authored version-bump quarantine.
  //
  // Per the critic's modification: ONLY bot-authored bumps DROP under
  // this rule. Operator-authored bumps are conserved as PASS rows
  // (security/migration signals). The bot check uses the canonical
  // isBotActor() predicate from lib/identity/bot-actors.js so this rule
  // shares its bot-actor universe with Rule 3 (single source of truth).
  //
  // Honours the connector-stamped raw_content.is_bot_authored flag
  // first (avoids re-running the regex when the connector already
  // classified the author); falls back to a live isBotActor() probe so
  // Stage-0 is usable against synthetic events. Quarantine reason
  // 'git_log_version_bump_bot' is distinct from generic 'bot_commit'
  // so the operator can monitor F8 fire-rate independently. 30-day
  // retention per W2 critic invariant.
  // -------------------------------------------------------------------
  if (VERSION_BUMP_SUBJECT_RE.test(subject)) {
    const authorEmailForBumpCheck =
      typeof rc.author_email === "string" ? rc.author_email : "";
    const isBotAuthored =
      rc.is_bot_authored === true ||
      (authorEmailForBumpCheck !== "" && isBotActor(authorEmailForBumpCheck));
    if (isBotAuthored) {
      try {
        quarantineRow(_shapeForQuarantine(event), "git_log_version_bump_bot", {
          rule_id: "F-T1-GIT_LOG-F8",
          source: "git-log",
        });
      } catch {
        // Quarantine is best-effort. Mirror Rule 1's failure mode.
      }
      return { decision: "DROP", reason: "git_log_version_bump_bot" };
    }
    // Non-bot version-bump: fall through to PASS so operator-authored
    // security/migration bumps stay in the ledger.
  }

  // -------------------------------------------------------------------
  // Rule 3 — F-NEW-W2-VALIDATION-BOT-AUTHOR-REGEX-GIT.
  // Use the canonical isBotActor() predicate from lib/identity/
  // bot-actors.js. Replaces the legacy
  // CAPS.SALIENCE_BOT_AUTHOR_REGEX_GIT ("dependabot|renovate-bot|
  // github-actions") which was a strict subset of the bot universe the
  // connector layer already recognises (copilot, web-flow, [bot]@,
  // <digits>+legacy-prefix, etc.). One predicate, every layer.
  // -------------------------------------------------------------------
  const authorEmail = typeof rc.author_email === "string" ? rc.author_email : "";
  if (authorEmail && isBotActor(authorEmail)) {
    return { decision: "DROP", reason: "bot_commit" };
  }

  // -------------------------------------------------------------------
  // Rule 4 — WU-A3-git-log-content-dedup. Same-source content-hash dedup.
  //
  // Consults the generic Layer-1.5 cross-source-dedup substrate with the
  // gitlog-content-dedup contract (source_a === source_b === "git-log";
  // key = sha256(normalised subject + body); no time window). The
  // substrate scans the git-log ledger for any previously-emitted row
  // whose normalised content matches.
  //
  // Semantics: the SECOND-AND-LATER row with the same content hash is a
  // CORROBORATING observation of the FIRST-seen row's fact, not a new
  // fact. We DROP at Stage-0 with reason "git_log_content_dup_corroborate"
  // and route through quarantineRow (30d retention per the W2 critic
  // invariant on new DROP rules). The reason name is registered in
  // REASON_ALLOWLIST so the dispatcher records the fire-rate counter
  // without bucketing into invalid_reason.
  //
  // Why DROP rather than emit a separate CORROBORATE decision: Stage-0
  // does NOT have access to the target's memory_id (the downstream
  // policy.corroboration emitter in salience.js needs a memory_id, and
  // Stage-0 only sees source ledger rows). The 30-day quarantine entry
  // carries the paired source_msg_id so a future restoration tool or
  // corroboration-count projector can resolve the chain.
  //
  // Fail-open: the substrate is documented as fail-open on any error
  // (file missing, parse failure, key extractor throws). A swallow-and-
  // pass here is intentional — losing a dedup signal degrades to the
  // legacy duplicate-row behaviour, which is acceptable while the
  // substrate self-heals.
  //
  // Defence in depth: the substrate's self_match_filter (set on the
  // gitlog-content-dedup contract) skips a candidate whose source_msg_id
  // equals the candidate-row's source_msg_id. Stage-0 fires BEFORE the
  // watermark daemon advances, so under normal operation the row being
  // checked has not yet been written to the ledger; the filter covers
  // replay / re-presentation paths (crash recovery, manual backfill).
  // -------------------------------------------------------------------
  let xsrcContentDup;
  try {
    xsrcContentDup = checkCrossSourceDuplicate(event, "git-log");
  } catch {
    // Substrate is fail-open by contract; this catch is defence in depth
    // so any thrown error here never crashes Stage-0.
    xsrcContentDup = { is_dup: false };
  }
  if (
    xsrcContentDup &&
    xsrcContentDup.is_dup === true &&
    xsrcContentDup.contract === "gitlog-content-dedup"
  ) {
    try {
      quarantineRow(
        _shapeForQuarantine(event),
        "git_log_content_dup_corroborate",
        {
          rule_id: "WU-A3-git-log-content-dedup/substrate",
          source: "git-log",
          paired_source: xsrcContentDup.paired_source,
          paired_id: xsrcContentDup.paired_id,
          contract: xsrcContentDup.contract,
        }
      );
    } catch {
      /* hot path — never crash Stage-0 on quarantine write */
    }
    return {
      decision: "DROP",
      reason: "git_log_content_dup_corroborate",
    };
  }

  // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION: band resolved via the
  // central helper. git-log's cliff is body-empty vs body-present rather
  // than char-length, so we read each band directly via resolveBand and
  // dispatch on emptyBody().
  // Default a substantive commit subject to substantive_prose; rare
  // single-line "fixup!"/"wip" subjects collapse via novelty later.
  const subjectOnly = resolveBand("git-log", "subject_only");
  const subProse = resolveBand("git-log", "substantive_prose");
  const structural_score = emptyBody(rc.body)
    ? (typeof subjectOnly === "number" ? subjectOnly : 0.5)
    : (typeof subProse === "number" ? subProse : 0.85);
  return {
    decision: "PASS",
    reason: null,
    structural_score,
  };
}

export function structuralRules() {
  return { ...(CAPS.SALIENCE_STRUCTURAL_RULES?.["git-log"] || {}) };
}
