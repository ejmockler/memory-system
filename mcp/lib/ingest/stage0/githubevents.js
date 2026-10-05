// Stage-0 hard-drop module for the `github-events` source.
//
// Rules (verbatim from kb/salience-design.md § Layer 1, plus F-T1-GITHUB_EVENTS-F1
// and Wave 2 extensions F3 / F4 / F8):
//   1. raw_content.event_type ∈ {"WatchEvent","ForkEvent"} → DROP (low_signal_event)
//   2. raw_content.actor_login is a known bot actor OR raw_content.ref matches
//      the anchored bot-branch pattern (dependabot/ | renovate/ refs)
//                                                          → DROP (bot_event)
//      F-T2-GITHUB_EVENTS-F3 (Wave 2) extends rule 2: even when the actor is
//      the operator, a branch named refs/heads/dependabot/... is unambiguously
//      bot-triggered work — drop it the same way bot-authored commits drop
//      from git-log. Quarantined (30d retention) per the critic invariant on
//      new DROP rules.
//   3. F-T2-GITHUB_EVENTS-F4 (Wave 2): branch lifecycle.
//      (event_type === "CreateEvent" || event_type === "DeleteEvent") AND
//      ref_type === "branch" AND NOT release/hotfix/harden semantic branch
//                                                          → DROP
//                                                            (branch_lifecycle)
//      Quarantined with 30d retention. The CreateEvent/DeleteEvent surfaces
//      a real signal exactly when a Push lands within ±24h on the same ref —
//      and that Push already carries the operator-attention signal. The
//      bare branch-create/delete is no-value telemetry noise on its own.
//      Risk-mitigation per node F4: `release/`, `hotfix/`, and `harden/`
//      ref prefixes carve out PASS so semantically-named branches survive.
//      F-NEW-W2-GH-BRANCH-LIFECYCLE-WINDOW extends F4: before quarantining
//      a CreateEvent/DeleteEvent on a branch ref, we now consult a ±24h
//      paired-activity window over the github-events ledger keyed by
//      (repoBasename, ref). If any PushEvent/PullRequestEvent on the same
//      repo+ref appears within ±24h of the branch-lifecycle event, we KEEP
//      the row (the Create/Delete is recall-signal corroborating a real
//      work session). Only ORPHAN branch-lifecycle pings — Create/Delete
//      with no paired Push/PR within the window — quarantine through the
//      new reason `gh_branch_lifecycle_orphan_drop`. The original
//      `branch_lifecycle` reason is retained as a fallback for cold-start
//      (when the lifecycle ledger cache is empty / unavailable) so the
//      window check is fail-open: if we can't prove the orphan claim, we
//      still drop only when the carve-out doesn't fire and the cache says
//      no activity. Window cache shares the lazy-build + TTL discipline
//      with the F8 gitlog sha index (5min TTL, bounded by ledger size).
//   4. F-T1-GITHUB_EVENTS-F1 (CRITIC-MODIFIED):
//      raw_content.event_type === "PushEvent" AND
//      raw_content.commits == 0 (or null) AND
//      raw_content.first_message is null/empty
//                                                            → PASS with
//      structural_score=0.10 (reason: empty_pushevent_downgrade).
//
//      Rationale (critic): the original audit proposed DROP for empty
//      PushEvents. The critic REJECTED that because dropping empty
//      PushEvents breaks the github-events ↔ git-log ↔ screentime
//      triangulation R50 needs. Instead we DOWNGRADE the structural score
//      so the row stays in the ledger for cross-source corroboration but
//      is deranked from candidate selection. When R52 backfill lands and
//      populates commits / first_message, the rule auto-becomes a no-op
//      and the score recovers via the substantive_prose path.
//   5. F-T2-GITHUB_EVENTS-F8 (Wave 2): cross-source dedup vs git-log.
//      event_type === "PushEvent" AND raw_content.head matches a known
//      git-log commit SHA for the same repo
//                                                            → DROP
//                                                            (duplicate_of_gitlog_commit)
//      Quarantined with 30d retention so restoration works if git-log gets
//      rotated. Keyed on (repo, sha) to avoid cross-repo cherry-pick
//      false positives per review-question Q3.
//   6. otherwise                                              → PASS
//
// Note: the ledger today carries `raw_content.event_type` (not `type`); we
// also accept `type` defensively. Bot detection looks at
// `raw_content.actor_login` (now populated by the github-events connector
// per F-NEW-R43-CONNECTOR-WIRING — previously this field was never
// written, so the prior CAPS regex always saw an empty string and dropped
// zero rows. The connector-side fix is the load-bearing half of this rule
// landing for the first time).

import { join } from "node:path";

// s10-remaining-stringcap-sites-2: the two source-ledger indices below used to
// be built with readFileSync(path, "utf8") + split("\n"). streamLedgerLines is
// the house primitive for that (stdlib-only — node:fs + node:string_decoder —
// so importing it here introduces no cycle). Two properties matter at these
// sites: it never materializes the file as one V8 string, and it REPORTS an fs
// failure on counts.readError instead of letting a bare catch turn UNREADABLE
// into EMPTY. See _warnLedgerDegradeOnce below for the second half.
import { streamLedgerLines } from "../../synthesis/_ledger-stream.js";

import { CAPS } from "../../validation.js";
import { quarantineRow } from "../quarantine.js";
import { STORAGE_DIR } from "../../config.js";
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — canonical band helper.
// github-events has no length cliff in its terminal PASS (substantive_prose
// only), so the central helper is consulted via resolveBand. The
// empty-PushEvent and paired-branch-lifecycle downgrades remain in-module
// overrides applied before the terminal PASS.
import { resolveBand } from "../structural-score.js";

// F-INFRA-R43-BOT-ACTORS / F-NEW-R43-CONNECTOR-WIRING (github-events slice):
// Canonical bot-actor predicate replaces the prior CAPS.SALIENCE_BOT_AUTHOR_REGEX_GH
// inline match. Keeps github-events and git-log in lockstep with the same
// alternation + anchoring discipline (anchored ^…(@.*)?$ for named bots, a
// generic `[bot]@` suffix marker for un-enumerated future bots, and a
// `<digits>+` privacy-prefix strip for the legacy renovate-bot email shape).
import { isBotActor } from "../../identity/bot-actors.js";

// F-NEW-W7-GITHUB-REPO-OWNERSHIP: canonical operator-identity map. Used to
// gate the empty-PushEvent rule: empty pushes on operator-owned repos keep
// the 0.10 downgrade (the git-log SHA index may still rescue them via
// cross-source corroboration); empty pushes on THIRD-PARTY repos cannot be
// rescued that way (the operator has no local clone), so they quarantine
// under reason='gh_empty_push_third_party' rather than consuming embed
// budget for zero salience signal. We pull github_usernames + github_orgs
// from getOperatorIdentities() at module load so the gate is keyed on the
// R42 single-source-of-truth identity map rather than per-call drift.
import { getOperatorIdentities } from "../../identity/operator-identity.js";

// ---------------------------------------------------------------------------
// s10-remaining-stringcap-sites-2 — LOUD DEGRADE FOR LEDGER READ FAILURES.
//
// Both source-ledger indices in this module previously wrapped their whole-file
// read in a bare `catch { return <empty index>; }`. That catch is half the
// defect and is size-independent: an EACCES parent dir, an EIO, a torn file or
// (eventually) an over-cap read all become "the ledger has no rows", which is
// indistinguishable from the truth. Stage-0 must never crash the dispatcher, so
// the failure cannot be thrown — stderr is the channel that remains, and it is
// the channel the two in-tree precedents already use (cross-source-dedup.js
// `_warnOnce`, stage0/telemetry.js `NOVEL_REASON_WARNED`).
//
// One-shot per distinct cause: the index caches rebuild every 5 minutes, so an
// unconditional warn would emit ~288 identical lines/day per index.
// ---------------------------------------------------------------------------
const _ledgerDegradeWarned = new Set();

function _warnLedgerDegradeOnce(key, msg) {
  if (_ledgerDegradeWarned.has(key)) return;
  _ledgerDegradeWarned.add(key);
  try {
    // eslint-disable-next-line no-console
    console.warn(`[stage0/githubevents] ${msg}`);
  } catch {
    /* never let logging fail the hot path */
  }
}

const LOW_SIGNAL_EVENT_TYPES = new Set(["WatchEvent", "ForkEvent"]);

// F-T1-GITHUB_EVENTS-F1 (critic-modified): downgraded structural score for
// empty PushEvents. The 0.10 value matches the audit's recommended floor for
// "metadata-only" rows — enough to be retrievable for corroboration, low
// enough to lose every reasonable candidate-selection tie-breaker.
const EMPTY_PUSHEVENT_DOWNGRADE_SCORE = 0.10;

// F-NEW-W7-GITHUB-REPO-OWNERSHIP reason string. Empty PushEvents on
// third-party repos (owner NOT in operator's gh_usernames / gh_orgs set)
// quarantine under this reason instead of surviving as the F1 downgrade.
// MUST be present in REASON_ALLOWLIST so the dispatcher counts it distinctly.
const REASON_EMPTY_PUSH_THIRD_PARTY = "gh_empty_push_third_party";

// Operator-owned gh repo namespaces. Built once at module load from the R42
// identity map (github_usernames + github_orgs) and from nothing else: this
// module compiles in no login. An empty or unconfigured identity therefore
// yields an EMPTY set, every repo owner is third-party, and every empty
// PushEvent quarantines (restorable). Lowercased for the case-insensitive
// owner compare (GitHub logins are case-preserving but case-insensitive for
// routing).
function _buildOperatorOwnedSet() {
  const set = new Set();
  try {
    const ids = getOperatorIdentities();
    if (Array.isArray(ids?.github_usernames)) {
      for (const u of ids.github_usernames) {
        if (typeof u === "string" && u.length > 0) set.add(u.toLowerCase());
      }
    }
    if (Array.isArray(ids?.github_orgs)) {
      for (const o of ids.github_orgs) {
        if (typeof o === "string" && o.length > 0) set.add(o.toLowerCase());
      }
    }
  } catch {
    /* fail-open: empty set => every owner is "third-party" => every empty
     * PushEvent quarantines. That is the safe default: better to over-drop
     * (quarantine is restorable) than to leak embed-budget on rows the
     * identity map cannot vouch for. */
  }
  return set;
}

const OPERATOR_OWNED_GH_NAMESPACES = _buildOperatorOwnedSet();

// Test surface — let test harnesses inspect the resolved owner set without
// reaching into module internals. Returns a fresh Array snapshot.
export function _operatorOwnedGhNamespacesForTest() {
  return Array.from(OPERATOR_OWNED_GH_NAMESPACES);
}

// Extract the gh repo owner (lowercased) from a row's raw_content. The
// connector writes raw_content.repo as `owner/repo` (e.g.
// "alex-example/example-repo"); defensive parse for legacy / malformed rows.
function _extractRepoOwner(rc) {
  const slug = typeof rc?.repo === "string" ? rc.repo : "";
  if (slug.length === 0 || !slug.includes("/")) return "";
  return slug.slice(0, slug.indexOf("/")).toLowerCase();
}

// F-T2-GITHUB_EVENTS-F3 (Wave 2): anchored bot-branch pattern. The audit
// predicate proposed the bare CAPS regex `dependabot|renovate` which would
// false-positive on user branches like `renovate-feature` or
// `dependabot-bug-fix`. We anchor to the `refs/heads/<bot>/` and
// `refs/heads/<bot>-` boundaries instead — a hard match for the canonical
// bot-branch shapes (`refs/heads/dependabot/npm_and_yarn/...`,
// `refs/heads/renovate/lock-file-maintenance`, etc.) without snagging
// user-named branches that merely contain the substring.
const BOT_BRANCH_REGEX =
  /^(?:refs\/heads\/)?(?:dependabot|renovate)(?:\/|$|-)/i;

// F-T2-GITHUB_EVENTS-F4 (Wave 2): semantic-branch carve-out. CreateEvents
// on release/hotfix/harden branches carry weak but real "work-starting"
// signal — operators name these branches intentionally. The risk-mitigation
// from node F4 names exactly these three prefixes; everything else falls
// through to the branch_lifecycle DROP.
const SEMANTIC_BRANCH_REGEX = /^(?:release|hotfix|harden)\//i;

// F-T2-GITHUB_EVENTS-F4 reason string. MUST be present in telemetry.js
// REASON_ALLOWLIST or the dispatcher buckets it into "invalid_reason".
const REASON_BRANCH_LIFECYCLE = "branch_lifecycle";

// F-NEW-W2-GH-BRANCH-LIFECYCLE-WINDOW reason string. Paired window
// disambiguates the F4 DROP into two outcomes: a Create/Delete with no
// paired Push/PR in ±24h on the same (repoBasename, ref) is the original
// "no-value telemetry noise" case and drops under this new reason. The
// legacy REASON_BRANCH_LIFECYCLE is preserved as the fail-open fallback
// (cache cold / unavailable) so the dispatcher still has a bucket for
// rows that we couldn't prove orphan.
const REASON_BRANCH_LIFECYCLE_ORPHAN = "gh_branch_lifecycle_orphan_drop";

// F-NEW-W3-GH-BRANCH-LIFECYCLE-PAIRED-SCORE. The Wave-2 W3 follow-up
// closes a verbatim-deviation gap: the original predicate said "if a
// paired event exists, downgrade structural_score to 0.30". The W2 DO
// implemented paired => PASS-fall-through to the substantive_prose
// default (~0.70). This rung makes the downgrade explicit: paired
// branch-lifecycle events PASS, but at 0.30 — kept in the ledger for
// corroboration, deranked in Layer-2 selection. The reason string is
// distinct from the orphan-drop bucket so the operator can monitor the
// paired downgrade rate independently. Must be present in REASON_ALLOWLIST.
const REASON_BRANCH_LIFECYCLE_PAIRED_DOWNGRADE =
  "gh_branch_lifecycle_paired_downgrade";
const BRANCH_LIFECYCLE_PAIRED_SCORE = 0.30;

// Window half-width for paired-activity lookup. ±24h around the lifecycle
// event ts. Matches the F4 docstring's existing "±24h" framing and the
// node-file predicate verbatim.
const BRANCH_LIFECYCLE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Event types that carry the "real work" signal we use to corroborate a
// branch-lifecycle event. PullRequestEvent covers PR opens/closes on the
// same head ref; PushEvent covers the commit landing on the ref. Both
// are the canonical "did this branch see action?" markers.
const BRANCH_PAIR_EVENT_TYPES = Object.freeze(
  new Set(["PushEvent", "PullRequestEvent"])
);

// F-T2-GITHUB_EVENTS-F8 reason string. Same allowlist discipline.
const REASON_DUPLICATE_OF_GITLOG = "duplicate_of_gitlog_commit";

// Quarantine retention is global (30d default via QUARANTINE_RETENTION_DAYS).
// Documented here so future audits know F3/F4/F8 DROPs are recoverable.
const QUARANTINE_RETENTION_DAYS = 30;

// Helper: is the row an empty PushEvent? Defensive against missing fields
// (a malformed/legacy row missing `commits` is treated as empty; the same
// for first_message). The rule fires ONLY for PushEvent — other event_types
// fall through to the normal PASS path even when their payload is sparse.
function isEmptyPushEvent(evtType, rc) {
  if (evtType !== "PushEvent") return false;
  const commitsRaw = rc.commits;
  const commitsEmpty =
    commitsRaw == null ||
    commitsRaw === 0 ||
    (Array.isArray(commitsRaw) && commitsRaw.length === 0);
  if (!commitsEmpty) return false;
  const firstMessage = rc.first_message;
  const firstMessageEmpty =
    firstMessage == null ||
    (typeof firstMessage === "string" && firstMessage.trim() === "");
  return firstMessageEmpty;
}

// ---------------------------------------------------------------------------
// F-T2-GITHUB_EVENTS-F8 — cross-source dedup index against git-log.
// ---------------------------------------------------------------------------
//
// On first stage0 invocation, we lazy-build a Set<string> from the git-log
// source ledger keyed by `${repo_path}\x00${commit_hash}`. Each PushEvent we
// see whose (repo, head SHA) tuple is in the Set drops as a duplicate.
//
// Lazy-build keeps daemon-start latency at zero when github-events stage0 is
// never invoked (the salience cascade may skip Stage-0 in some configurations);
// it also bounds memory pressure — if the operator does not run github-events
// the Set is never allocated.
//
// repo-key normalisation: git-log writes `raw_content.repo_path` as an
// absolute filesystem path (e.g. `<HOME>/example-repo-server`), while
// github-events writes `raw_content.repo` as a `owner/repo` slug (e.g.
// `alex-example/example-repo`). We can't reliably match those at this layer
// without a cross-source manifest. The pragmatic compromise: key the index
// on `<basename>\x00<sha>` (the leaf directory of the git-log repo_path,
// e.g. "example-repo-server") AND on `<repo_slug_basename>\x00<sha>` (the
// basename of the github-events repo field, e.g. "example-repo"). When the
// PushEvent's repo basename ≠ the git-log path basename we fall back to a
// sha-only secondary index — false-positive risk per review-question Q3 is
// real (cross-repo cherry-picks would collide), but tightly bounded because
// SHA-1 collision across operator's repos is overwhelmingly unlikely in
// the 30-day quarantine window. The quarantine path makes false-positives
// recoverable via restoreFromQuarantine().
//
// F-NEW-W2-GH-GITLOG-BASENAME-NORMALIZE (Wave 3): the raw basename
// comparison still misses the common case where a github-events repo is
// `alex-example/example-repo` and the on-disk clone is
// `<HOME>/example-repo-server` (operator habit: append "-server",
// "-client", "-cli" to the clone dir name; also the `.git` suffix on
// bare-clone dirs). We now run a `canonicalizeRepoBasename()` over BOTH
// sides of the comparison that strips trailing `.git`, `-server`,
// `-client`, `-cli`, and `-mcp` suffixes. Trade-off: this introduces a
// real false-positive risk where two unrelated org-level repos share a
// canonicalised basename (e.g. `alice/foo` and `bob/foo`, or
// `carol/foo-server` and `dave/foo`). The risk is bounded by:
//   (a) the (canonical-basename, sha) tuple — SHA-1 collision across
//       unrelated repos is overwhelmingly unlikely in the 30d window;
//   (b) the quarantine path keeps every drop recoverable via
//       restoreFromQuarantine() if a false positive ever surfaces;
//   (c) the canonicalisation is suffix-stripping only — it never
//       up-casts unrelated basenames (`foo` and `bar` still collide
//       only if both already shared the same SHA, which is the same
//       risk the pre-fix index already accepted on the basename path).
// Net: the recovery for the operator's example-repo ↔ example-repo-server
// case (a real, observed dedup miss) outweighs the increased collision
// surface, which remains quarantine-recoverable.
//
// Cache invalidation: the Set is rebuilt every GITLOG_SHA_CACHE_TTL_MS so
// fresh git-log appends become visible. Rebuild is bounded by the git-log
// ledger size; on a saturated daemon the ledger grows ~1k rows/day so a
// 5-minute TTL costs O(k) Set construction every 5min.

const GITLOG_SHA_CACHE_TTL_MS = 5 * 60 * 1000;

let _gitlogShaCache = null; // { repoSha: Set<string>, shaOnly: Set<string>, builtAt: number }

function _gitlogLedgerPath() {
  return join(STORAGE_DIR, "sources", "git-log.jsonl");
}

function _basenameSafe(p) {
  if (typeof p !== "string" || p.length === 0) return "";
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// F-NEW-W2-GH-GITLOG-BASENAME-NORMALIZE: strip the operator's known
// clone-suffix conventions so basename equality on both sides of the
// dedup key actually matches in the example-repo ↔ example-repo-server
// case. Order matters: `.git` first (bare clones), then the operator's
// post-fix conventions. Lower-case the result so cross-case operator
// habits (`MyRepo-Server` vs `myrepo-server`) collapse too.
const REPO_BASENAME_SUFFIX_REGEX = /(?:\.git|-server|-client|-cli|-mcp)$/i;

function canonicalizeRepoBasename(name) {
  if (typeof name !== "string" || name.length === 0) return "";
  let s = name.toLowerCase();
  // Strip iteratively in case multiple suffixes stack (e.g. `foo-mcp-server`,
  // which after stripping `-server` becomes `foo-mcp` which should then
  // also lose `-mcp`). Bounded loop — REPO_BASENAME_SUFFIX_REGEX matches
  // a non-empty suffix every iteration, so the loop terminates in O(suffixes).
  for (let i = 0; i < 4; i++) {
    const next = s.replace(REPO_BASENAME_SUFFIX_REGEX, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

// Test surface — let test harnesses exercise the canonicaliser directly
// without round-tripping through the lazy index build.
export { canonicalizeRepoBasename };

// s10-remaining-stringcap-sites-2: STREAMED, NOT WHOLE-FILE READ.
//
// The previous body was readFileSync(path, "utf8") + split("\n") over
// storage/sources/git-log.jsonl, measured at 124,163,682 B on 2026-08-12
// (`stat -f %z`) against this build's 536,870,888-byte MAX_STRING_LENGTH
// (vendor/node v24.15.0) — 0.231x, i.e. under the cap and NOT throwing today.
// It is a landmine, not a live outage — but the fuse is measured, not assumed.
// Per-day byte totals from the ledger's own `ts` fields (this session): day 0 is
// a 18,261,807-byte connector backfill, so the whole-span mean is skewed; the
// trailing windows give 446,966 B/day (7d), 1,899,066 B/day (14d) and
// 1,037,139 B/day (30d), i.e. a linear horizon to 536,870,888 B on the order of
// ONE TO THREE YEARS. Extrapolation, not prophecy — commit rate is operator
// behaviour — but the right order of magnitude is years, not decades.
//
// The other reason to close it is that this file is HARD tier for the class
// guard (un-allowlistable), and the transient cost of the whole-file shape is
// real right now — the string plus its split array, rebuilt every 5 minutes of
// PushEvent traffic. Measured end-to-end through stage0() on a 39,840,000-byte
// hermetic fixture (test T8, --expose-gc child, maxRSS delta), three runs each
// side: PEAK 4.398-4.411 -> 0.674-0.682 bytes per file byte. Retention is
// unchanged at 0.149 B/B — both shapes keep exactly the two Sets below, and no
// claim is made here that the old one leaked.
//
// RETENTION: the two Sets, and nothing else. Each parsed row is dropped the
// instant this callback returns; at most a 40-char sha and a
// `<canonical-basename>\x00<sha>` key survive per row. maxLineBytes is left at
// the primitive's 8 MiB default — the largest line in the live git-log ledger
// measured 40,147 B this session (streamLedgerLinesWithOffset scan), 209x under
// that default, so no live row is at risk of being skipped by it.
//
// READ FAILURES ARE REPORTED, NOT SWALLOWED. `readError` rides on the returned
// index; ENOENT keeps the historical missing-ledger => empty-index contract
// (the primitive classifies it as readError:null), while EACCES/ELOOP/ENOTDIR
// and mid-stream I/O failures set it. A partial index is still returned and
// still used: a sha that WAS read is a true positive regardless of what came
// after it, so partial data can only cost dedups (PASS), never invent one.
function _buildGitlogShaIndex() {
  const path = _gitlogLedgerPath();
  const repoSha = new Set();
  const shaOnly = new Set();
  const counts = streamLedgerLines(path, (parsed) => {
    const rc = parsed && parsed.raw_content;
    if (!rc || typeof rc !== "object") return;
    const sha =
      typeof rc.commit_hash === "string" && rc.commit_hash.length > 0
        ? rc.commit_hash
        : null;
    if (!sha) return;
    shaOnly.add(sha);
    // F-NEW-W2-GH-GITLOG-BASENAME-NORMALIZE: index under the canonical
    // (suffix-stripped, lowercased) basename so the lookup-side check
    // below matches `alex-example/example-repo` against an on-disk clone
    // at `<HOME>/example-repo-server`.
    const repoBasename = canonicalizeRepoBasename(_basenameSafe(rc.repo_path));
    if (repoBasename) {
      repoSha.add(`${repoBasename}\x00${sha}`);
    }
  });
  const readError = counts.readError != null ? counts.readError : null;
  if (readError !== null) {
    _warnLedgerDegradeOnce(
      `gitlog::${readError}`,
      `git-log ledger read FAILED (${path}): ${readError} — the cross-source ` +
        "SHA dedup index is DEGRADED (partial or empty), so PushEvents that " +
        "duplicate a git-log commit will NOT be deduped. This is a read " +
        "failure, not an empty ledger. Warned once per distinct cause.",
    );
  }
  return { repoSha, shaOnly, builtAt: Date.now(), readError };
}

function _getGitlogShaIndex() {
  const now = Date.now();
  if (
    _gitlogShaCache != null &&
    now - _gitlogShaCache.builtAt < GITLOG_SHA_CACHE_TTL_MS
  ) {
    return _gitlogShaCache;
  }
  try {
    _gitlogShaCache = _buildGitlogShaIndex();
  } catch (e) {
    // Stage-0 must never crash the dispatcher. On any error, return an
    // empty index so the dedup rule no-ops for this poll.
    //
    // s10: streamLedgerLines never throws, so reaching here now means a genuine
    // programming fault (or an OOM) rather than a swallowed fs error — and that
    // must not be silent either. The empty-index return is preserved exactly.
    const msg = e && e.message ? e.message : String(e);
    _warnLedgerDegradeOnce(
      `gitlog-build::${msg}`,
      `git-log SHA index BUILD FAILED: ${msg} — dedup disabled for this cycle.`,
    );
    _gitlogShaCache = {
      repoSha: new Set(),
      shaOnly: new Set(),
      builtAt: now,
      readError: msg,
    };
  }
  return _gitlogShaCache;
}

// Test surface — let test harnesses reset the cache between runs without
// reaching into module internals. s10: also clears the one-shot degrade-warn
// memo so a test that expects a warning is not silenced by an earlier test that
// already tripped the same cause.
export function _resetGitlogShaCacheForTest() {
  _gitlogShaCache = null;
  _ledgerDegradeWarned.clear();
}

// Test surface — let test harnesses pre-seed the cache with a synthetic
// index (avoids needing a real git-log ledger on disk).
export function _seedGitlogShaCacheForTest(repoShaSet, shaOnlySet) {
  _gitlogShaCache = {
    repoSha: repoShaSet instanceof Set ? repoShaSet : new Set(repoShaSet || []),
    shaOnly:
      shaOnlySet instanceof Set ? shaOnlySet : new Set(shaOnlySet || []),
    builtAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// F-NEW-W2-GH-BRANCH-LIFECYCLE-WINDOW — github-events activity ledger.
// ---------------------------------------------------------------------------
//
// Lazy-build a Map<`${canonicalBasename}\x00${ref}`, number[]> from the
// github-events ledger where each value is the list of `ts` (epoch-ms) at
// which a PushEvent or PullRequestEvent landed on that (repo, ref) tuple.
// We scan the same JSONL file the connector appends to; rows older than
// 2 * BRANCH_LIFECYCLE_WINDOW_MS at build time are dropped from the
// index (the window only ever looks back ±24h from "now", so events older
// than 48h cannot pair with any incoming live event).
//
// Cache lifetime mirrors the gitlog index: 5min TTL, lazy-build on first
// hit, rebuilt on next access after expiry. Memory pressure is bounded by
// the github-events ledger size (~hundreds of rows / day for a typical
// operator, single-digit MB even at the 30d retention horizon).

const GHEVENTS_ACTIVITY_CACHE_TTL_MS = 5 * 60 * 1000;

let _gheventsActivityCache = null; // { refTs: Map<string, number[]>, builtAt: number }

function _gheventsLedgerPath() {
  return join(STORAGE_DIR, "sources", "github-events.jsonl");
}

function _normRef(ref) {
  if (typeof ref !== "string") return "";
  return ref.replace(/^refs\/heads\//, "");
}

// s10-remaining-stringcap-sites-2: STREAMED, NOT WHOLE-FILE READ.
//
// HONEST SCOPE. storage/sources/github-events.jsonl measured 5,241,383 B on
// 2026-08-12 (statSync) — 0.0098x this build's 536,870,888-byte
// MAX_STRING_LENGTH. Per-day byte totals from its own rows, this session:
// 74,444 B/day over the trailing 7 days, 146,368 B/day over 14, 109,874 B/day
// over 30 — a linear horizon to the cap of roughly 10-20 YEARS. (The brief's
// "~12 KB/day, ~121-year horizon" was a single poll's growth mistaken for a
// daily rate; the corrected figure is still a decade-plus, so the conclusion
// holds even though the number did not.) The string-cap risk at THIS site is
// remote and no comment here claims otherwise.
// What this change actually buys is the bare catch below: an
// UNREADABLE ledger used to be indistinguishable from an empty one, and this
// index's fail-open direction is a quarantine DROP (see
// hasPairedActivityInWindow's caller), so silence here costs rows. The file is
// also HARD tier for the class guard, which is un-allowlistable.
//
// RETENTION: one Map keyed by (canonical repo basename, normalized ref) holding
// arrays of epoch-ms numbers, already bounded by the 48h `cutoffMs` filter
// below. Each parsed row is dropped the instant this callback returns.
// maxLineBytes stays at the primitive's 8 MiB default; the largest line in the
// live github-events ledger measured 30,488 B this session.
function _buildGheventsActivityIndex() {
  const path = _gheventsLedgerPath();
  const refTs = new Map();
  const cutoffMs = Date.now() - 2 * BRANCH_LIFECYCLE_WINDOW_MS;
  const counts = streamLedgerLines(path, (parsed) => {
    const rc = parsed && parsed.raw_content;
    if (!rc || typeof rc !== "object") return;
    const evtType =
      (typeof rc.event_type === "string" && rc.event_type) ||
      (typeof rc.type === "string" && rc.type) ||
      "";
    if (!BRANCH_PAIR_EVENT_TYPES.has(evtType)) return;

    // Extract the ref. PushEvent carries `ref` directly; PullRequestEvent
    // does not surface a head ref in the current summarizer shape. For PR
    // events we fall back to the PR number scoped per-repo so a CreateEvent
    // whose ref is unrelated does not collide. The collision risk is small
    // because branch-lifecycle Create/Delete events almost always carry a
    // ref name and PR events with no ref simply don't participate in the
    // window — fail-open under-pair rather than false-pair.
    let ref = _normRef(rc.ref);
    if (!ref) return;

    const repoSlug = typeof rc.repo === "string" ? rc.repo : "";
    const repoSlugBasename = repoSlug.includes("/")
      ? repoSlug.slice(repoSlug.indexOf("/") + 1)
      : repoSlug;
    const repoBasename = canonicalizeRepoBasename(repoSlugBasename);
    if (!repoBasename) return;

    // Prefer the gh event's authoritative `created_at`; fall back to the
    // ledger row's `ts`. Convert to epoch-ms; skip rows we can't parse.
    const tsRaw =
      (typeof rc.created_at === "string" && rc.created_at) ||
      (typeof parsed.ts === "string" && parsed.ts) ||
      "";
    if (!tsRaw) return;
    const tsMs = Date.parse(tsRaw);
    if (!Number.isFinite(tsMs)) return;
    if (tsMs < cutoffMs) return;

    const key = `${repoBasename}\x00${ref}`;
    const arr = refTs.get(key);
    if (arr) {
      arr.push(tsMs);
    } else {
      refTs.set(key, [tsMs]);
    }
  });
  const readError = counts.readError != null ? counts.readError : null;
  if (readError !== null) {
    _warnLedgerDegradeOnce(
      `ghevents::${readError}`,
      `github-events ledger read FAILED (${path}): ${readError} — the branch ` +
        "lifecycle pairing window is DEGRADED (partial or empty), so a " +
        "Create/Delete event whose paired Push/PR sits in the unread portion " +
        "cannot be proven paired. Such rows now quarantine under the legacy " +
        "`branch_lifecycle` reason instead of claiming a proven orphan. This " +
        "is a read failure, not an empty ledger. Warned once per distinct cause.",
    );
  }
  return { refTs, builtAt: Date.now(), readError };
}

function _getGheventsActivityIndex() {
  const now = Date.now();
  if (
    _gheventsActivityCache != null &&
    now - _gheventsActivityCache.builtAt < GHEVENTS_ACTIVITY_CACHE_TTL_MS
  ) {
    return _gheventsActivityCache;
  }
  try {
    _gheventsActivityCache = _buildGheventsActivityIndex();
  } catch (e) {
    // Stage-0 must never crash. On any error, return an empty index so the
    // window rule becomes fail-open: no paired activity ⇒ orphan-drop.
    //
    // s10: streamLedgerLines never throws, so reaching here now means a genuine
    // programming fault (or an OOM), not a swallowed fs error. The empty-index
    // return is preserved exactly; only the silence is removed. readError is
    // stamped so the caller downgrades the orphan claim (see
    // _gheventsWindowIsUsable).
    const msg = e && e.message ? e.message : String(e);
    _warnLedgerDegradeOnce(
      `ghevents-build::${msg}`,
      `github-events activity index BUILD FAILED: ${msg} — the branch-lifecycle ` +
        "pairing window is unavailable for this cycle.",
    );
    _gheventsActivityCache = { refTs: new Map(), builtAt: now, readError: msg };
  }
  return _gheventsActivityCache;
}

// _gheventsWindowIsUsable — s10-remaining-stringcap-sites-2.
//
// TRUE iff the activity index was built from a ledger that was read to EOF
// cleanly (readError null — which the streaming primitive also reports for a
// genuinely MISSING ledger, preserving the cold-start contract at
// _ledger-stream.js:146). FALSE when the ledger exists but could not be read.
//
// The distinction is load-bearing for the DROP REASON, not for the DROP: the
// module already carries two reasons, one asserting "we ran the window check
// and found no pairing" (REASON_BRANCH_LIFECYCLE_ORPHAN) and one meaning "we
// could not run the check" (REASON_BRANCH_LIFECYCLE, F4's original). An
// unreadable ledger is the second case; reporting it as the first asserts a
// proof the code does not have.
function _gheventsWindowIsUsable() {
  const idx = _getGheventsActivityIndex();
  return !idx || idx.readError == null;
}

// hasPairedActivityInWindow — returns true iff the github-events ledger
// contains a PushEvent or PullRequestEvent on the same (canonical repo
// basename, normalized ref) within ±BRANCH_LIFECYCLE_WINDOW_MS of the
// supplied tsMs. Linear scan over the per-key timestamp array, which is
// bounded by the github-events ledger volume for that single ref —
// typically a handful of entries even in a hot 48h window.
function hasPairedActivityInWindow(repoBasename, ref, tsMs) {
  if (!repoBasename || !ref || !Number.isFinite(tsMs)) return false;
  const idx = _getGheventsActivityIndex();
  const arr = idx.refTs.get(`${repoBasename}\x00${ref}`);
  if (!arr || arr.length === 0) return false;
  const lo = tsMs - BRANCH_LIFECYCLE_WINDOW_MS;
  const hi = tsMs + BRANCH_LIFECYCLE_WINDOW_MS;
  for (const t of arr) {
    if (t >= lo && t <= hi) return true;
  }
  return false;
}

// Test surface — let test harnesses reset / pre-seed the github-events
// activity cache without touching the on-disk ledger.
export function _resetGheventsActivityCacheForTest() {
  _gheventsActivityCache = null;
  // s10: clear the one-shot degrade-warn memo too, so a test asserting the
  // warning is not silenced by an earlier test that tripped the same cause.
  _ledgerDegradeWarned.clear();
}
export function _seedGheventsActivityCacheForTest(refTsMap) {
  const m = new Map();
  if (refTsMap && typeof refTsMap === "object") {
    for (const [k, v] of Object.entries(refTsMap)) {
      m.set(k, Array.isArray(v) ? v.slice() : []);
    }
  }
  _gheventsActivityCache = { refTs: m, builtAt: Date.now() };
}

// _shapeForQuarantine — quarantineRow requires row.source. Stage-0 receives
// event objects that already carry source="github-events" from the
// dispatcher; the defensive stamp covers callers that bypass the dispatcher
// (tests that invoke stage0() directly with a synthetic event).
function _shapeForQuarantine(event) {
  if (event && typeof event === "object") {
    if (typeof event.source === "string" && event.source.length > 0) return event;
    return { ...event, source: "github-events" };
  }
  return { source: "github-events", raw_content: {} };
}

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};
  const evtType = (typeof rc.event_type === "string" && rc.event_type)
    || (typeof rc.type === "string" && rc.type)
    || "";
  if (LOW_SIGNAL_EVENT_TYPES.has(evtType)) {
    return { decision: "DROP", reason: "low_signal_event" };
  }

  // F-NEW-R43-CONNECTOR-WIRING: prefer raw_content.actor_login (populated by
  // the github-events connector). Legacy rows pre-dating the connector fix
  // may instead carry `pr_author` / `author_login` so we fall back to those
  // for backward compatibility with the existing on-disk ledger.
  const actor = (typeof rc.actor_login === "string" && rc.actor_login)
    || (typeof rc.pr_author === "string" && rc.pr_author)
    || (typeof rc.author_login === "string" && rc.author_login)
    || "";
  // F-T2-GITHUB_EVENTS-F3 (Wave 2): bot detection now ALSO inspects the
  // branch ref. Anchored regex (BOT_BRANCH_REGEX) avoids false-positives on
  // user branches that merely contain the substring "dependabot" /
  // "renovate" (e.g. "renovate-feature"). The actor-login check still wins
  // when both fire (same DROP outcome, but isBotActor() is the canonical
  // predicate). DROPs route to quarantine for restorability.
  const ref = typeof rc.ref === "string" && rc.ref ? rc.ref : "";
  const actorIsBot = actor.length > 0 && isBotActor(actor);
  const refIsBot = ref.length > 0 && BOT_BRANCH_REGEX.test(ref);
  if (actorIsBot || refIsBot) {
    try {
      quarantineRow(_shapeForQuarantine(event), "bot_event", {
        rule_id: actorIsBot
          ? "F-NEW-R43-CONNECTOR-WIRING/bot_actor"
          : "F-T2-GITHUB_EVENTS-F3/bot_ref",
        source: "github-events",
      });
    } catch {
      /* hot path must not crash on quarantine failure */
    }
    return { decision: "DROP", reason: "bot_event" };
  }

  // F-T2-GITHUB_EVENTS-F4 (Wave 2): branch lifecycle DROP via quarantine.
  // CreateEvent / DeleteEvent with ref_type="branch" are pure noise on their
  // own — a Push or PR within ±24h carries the real signal. We carve out
  // release/, hotfix/, harden/ refs which name intentional work-start.
  //
  // F-NEW-W2-GH-BRANCH-LIFECYCLE-WINDOW (Wave 3): before dropping, consult
  // the github-events activity ledger for a paired Push/PR on the same
  // (canonical repoBasename, ref) within ±24h. Paired ⇒ KEEP (the
  // Create/Delete corroborates an operator work session). Orphan ⇒
  // quarantine under REASON_BRANCH_LIFECYCLE_ORPHAN. The legacy
  // REASON_BRANCH_LIFECYCLE survives as the fail-open fallback when the
  // event lacks a parseable ts (we can't anchor a window without one) —
  // operator-debuggable via the per-reason counters.
  const refType = typeof rc.ref_type === "string" ? rc.ref_type : "";
  if (
    (evtType === "CreateEvent" || evtType === "DeleteEvent") &&
    refType === "branch"
  ) {
    // Strip a leading "refs/heads/" if a caller normalised it; the
    // CreateEvent payload typically carries the bare branch name (e.g.
    // "feature/foo") not the full ref-path.
    const refForCarveOut = _normRef(ref);
    if (!SEMANTIC_BRANCH_REGEX.test(refForCarveOut)) {
      // Pull the lifecycle event's own timestamp. Prefer the gh-event
      // created_at; fall back to the row-level ts the connector stamped.
      const lifecycleTsRaw =
        (typeof rc.created_at === "string" && rc.created_at) ||
        (typeof event.ts === "string" && event.ts) ||
        "";
      const lifecycleTsMs = lifecycleTsRaw ? Date.parse(lifecycleTsRaw) : NaN;

      // Resolve the same canonical basename used by the gitlog index so
      // (repo, ref) lookups agree across both indexes.
      const lifecycleRepoSlug = typeof rc.repo === "string" ? rc.repo : "";
      const lifecycleRepoSlugBasename = lifecycleRepoSlug.includes("/")
        ? lifecycleRepoSlug.slice(lifecycleRepoSlug.indexOf("/") + 1)
        : lifecycleRepoSlug;
      const lifecycleRepoBasename = canonicalizeRepoBasename(
        lifecycleRepoSlugBasename
      );

      const canCheckWindow =
        Number.isFinite(lifecycleTsMs) &&
        lifecycleRepoBasename.length > 0 &&
        refForCarveOut.length > 0;

      const paired =
        canCheckWindow &&
        hasPairedActivityInWindow(
          lifecycleRepoBasename,
          refForCarveOut,
          lifecycleTsMs
        );

      if (paired) {
        // F-NEW-W3-GH-BRANCH-LIFECYCLE-PAIRED-SCORE: Paired activity inside
        // the ±24h window ⇒ KEEP but explicitly downgrade to 0.30 (verbatim
        // predicate). The pre-W3 code fell through to PASS with the
        // substantive_prose default (~0.70), which masked the design intent:
        // a paired CreateEvent/DeleteEvent corroborates work but is the
        // weaker of the two signals (the paired Push/PR carries the real
        // payload). Returning explicitly here also stops further DROP-rule
        // evaluation (e.g. the PushEvent F8 dedup below) which is correct
        // for CreateEvent/DeleteEvent — those event types never carry the
        // head SHA the F8 index keys on.
        return {
          decision: "PASS",
          reason: REASON_BRANCH_LIFECYCLE_PAIRED_DOWNGRADE,
          structural_score: BRANCH_LIFECYCLE_PAIRED_SCORE,
        };
      } else {
        // Choose between the new orphan reason (when we actually proved
        // no paired activity) and the legacy reason (cold-start /
        // unparseable ts / missing repo basename — we couldn't run the
        // window check and fall back to F4's original semantics).
        //
        // s10-remaining-stringcap-sites-2 adds the fourth "couldn't run it"
        // case: the activity ledger EXISTS but could not be read (EACCES /
        // EIO / a mid-stream failure). Before, that read failure was swallowed
        // into an empty index and the row was quarantined as a PROVEN orphan.
        // The DROP is unchanged; the claim attached to it is not.
        const windowRan = canCheckWindow && _gheventsWindowIsUsable();
        const dropReason = windowRan
          ? REASON_BRANCH_LIFECYCLE_ORPHAN
          : REASON_BRANCH_LIFECYCLE;
        const ruleId = windowRan
          ? "F-NEW-W2-GH-BRANCH-LIFECYCLE-WINDOW/orphan_drop"
          : "F-T2-GITHUB_EVENTS-F4/branch_lifecycle";
        try {
          quarantineRow(_shapeForQuarantine(event), dropReason, {
            rule_id: ruleId,
            source: "github-events",
          });
        } catch {
          /* hot path */
        }
        return { decision: "DROP", reason: dropReason };
      }
    }
  }

  // F-T2-GITHUB_EVENTS-F8 (Wave 2): cross-source dedup vs git-log.
  // A PushEvent whose head SHA appears in the git-log ledger for the
  // matching repo is redundant — git-log carries fuller commit context
  // (author email, body) than the github-events summary. Drop via
  // quarantine so the row is restorable if the git-log copy is rotated.
  if (evtType === "PushEvent") {
    const headSha = typeof rc.head === "string" ? rc.head : "";
    if (headSha.length > 0) {
      const repoSlug = typeof rc.repo === "string" ? rc.repo : "";
      const repoSlugBasename = repoSlug.includes("/")
        ? repoSlug.slice(repoSlug.indexOf("/") + 1)
        : repoSlug;
      // F-NEW-W2-GH-GITLOG-BASENAME-NORMALIZE: canonicalise both sides of
      // the dedup key so the example-repo ↔ example-repo-server case
      // dedups. The index is built with the same canonicaliser above.
      const repoBasename = canonicalizeRepoBasename(repoSlugBasename);
      const idx = _getGitlogShaIndex();
      // Primary index: (repoBasename, sha). Secondary index: sha-only —
      // only consult it when the repo basename is empty (defensive — we
      // do NOT want a sha-only collision across unrelated repos to drop a
      // real github-events row when we KNOW the repo names mismatch).
      const repoShaKey = repoBasename
        ? `${repoBasename}\x00${headSha}`
        : "";
      const hit =
        (repoShaKey && idx.repoSha.has(repoShaKey)) ||
        (!repoBasename && idx.shaOnly.has(headSha));
      if (hit) {
        try {
          quarantineRow(_shapeForQuarantine(event), REASON_DUPLICATE_OF_GITLOG, {
            rule_id: "F-T2-GITHUB_EVENTS-F8/duplicate_of_gitlog_commit",
            source: "github-events",
          });
        } catch {
          /* hot path */
        }
        return { decision: "DROP", reason: REASON_DUPLICATE_OF_GITLOG };
      }
    }
  }

  const rules = CAPS.SALIENCE_STRUCTURAL_RULES?.["github-events"] || {};

  // F-T1-GITHUB_EVENTS-F1 (critic-modified) + F-NEW-W7-GITHUB-REPO-OWNERSHIP:
  // empty-PushEvent path now branches on repo ownership:
  //   * operator-owned repo (owner ∈ OPERATOR_OWNED_GH_NAMESPACES) → PASS at
  //     structural_score=0.10. Cross-source corroboration via the git-log SHA
  //     index (F8) may still rescue these rows when the operator has a local
  //     clone; the downgrade keeps them retrievable while deranking them in
  //     candidate selection. When R52 backfill (now also implemented on the
  //     connector side) populates commits / first_message later, the
  //     predicate auto-stops firing and the row recovers via substantive_prose.
  //   * third-party repo (owner NOT in the operator-owned set) → quarantine
  //     under REASON_EMPTY_PUSH_THIRD_PARTY. Rationale (W7 audit): empty
  //     pushes on third-party repos cannot be rescued via git-log
  //     corroboration (operator has no clone), so the embed budget they
  //     consume buys zero salience signal. Quarantine (30d retention) keeps
  //     the row restorable if the operator's repo allowlist evolves; a
  //     missing identity-map entry never causes permanent data loss.
  if (isEmptyPushEvent(evtType, rc)) {
    const repoOwner = _extractRepoOwner(rc);
    const ownerIsOperator =
      repoOwner.length > 0 &&
      OPERATOR_OWNED_GH_NAMESPACES.has(repoOwner);
    if (ownerIsOperator) {
      return {
        decision: "PASS",
        reason: "empty_pushevent_downgrade",
        structural_score: EMPTY_PUSHEVENT_DOWNGRADE_SCORE,
      };
    }
    // Third-party (or unknown-owner) empty push → quarantine + DROP.
    try {
      quarantineRow(_shapeForQuarantine(event), REASON_EMPTY_PUSH_THIRD_PARTY, {
        rule_id: "F-NEW-W7-GITHUB-REPO-OWNERSHIP/empty_push_third_party",
        source: "github-events",
      });
    } catch {
      /* hot path must not crash on quarantine failure */
    }
    return { decision: "DROP", reason: REASON_EMPTY_PUSH_THIRD_PARTY };
  }

  // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION: terminal PASS reads
  // substantive_prose via the central helper. github-events has no
  // length-cliff band so computeStructuralScore would always return the
  // upper band; we go directly through resolveBand for clarity.
  const subProse = resolveBand("github-events", "substantive_prose");
  return {
    decision: "PASS",
    reason: null,
    structural_score: typeof subProse === "number" ? subProse : 0.7,
  };
}

export function structuralRules() {
  return { ...(CAPS.SALIENCE_STRUCTURAL_RULES?.["github-events"] || {}) };
}
