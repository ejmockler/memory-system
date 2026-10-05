// git-log-local.js — Phase 2b dev-context connector for git commit history.
//
// Walks operator-known repo roots, runs `git log` per repo, and emits one
// source-ledger row per commit. Pure subprocess-and-stdout — zero new deps,
// no auth secret, no TCC grant. Uses the shared ConnectorBase from
// lib/connectors/index.js for cursor + idempotent append + source_policy
// stamping + health-reporting + revoke discipline.
//
// Authoritative specs:
//   - kb/connectors-survey.md § Top-5 connector skeletons (matrix row for
//     git-log-local: clean ToS, no perms, first_party / third_party_inferred
//     split by authorship).
//   - kb/ingestion.md § Connector contract (the six obligations the base
//     class satisfies; this module supplies the per-source classifier closure
//     and the source-native polling logic).
//   - Round-20 close C1: authorship trumps audience (operator-authored commit
//     in a third-party repo is first_party; co-authored commit by someone
//     else in an operator-owned repo is third_party_inferred).
//
// Cursor shape (per kb/ingestion.md § Connector contract → CURSOR):
//
//   {
//     last_polled_ts: ISO-8601,
//     per_repo_cursors: { "<abs_repo_path>": "<last_seen_commit_hash>" },
//     per_repo_ref_tips: { "<abs_repo_path>": ["<sha>", ...] },  // D1: sorted
//                        // unique walk start points; lives in state.heavy.json
//                        // (heavyCursorKeys), merged in by readCursor
//     last_appended_ts: ISO-8601,        // ConnectorBase base contract
//     last_appended_id: ulid,            // ConnectorBase base contract
//     last_cursor_advance_ts: ISO-8601,  // ConnectorBase base contract
//     error_count: int,                  // ConnectorBase base contract
//     last_error_kind: string|null,      // ConnectorBase base contract
//   }
//
// The `cursor` field used by other connectors is encoded here as
// `per_repo_cursors` (a map of repo-path -> last-seen-sha) because git is
// per-repo and a flat scalar is structurally insufficient. The base class
// is agnostic to cursor shape; only the canonical {last_appended_ts,
// last_cursor_advance_ts, error_count} keys it inspects matter.
//
// Per-repo walk frontier (D1 gitlog-ref-tip-cursor): on each pollOnce, for
// each discovered surface we run
//   git log --pretty=... --all --reflog --numstat --ignore-missing --stdin
// with one `^<sha>` line on stdin per WALK START POINT persisted from the
// previous poll (`per_repo_ref_tips`, the output of
// `git rev-list --no-walk=unsorted --all --reflog` — by construction the very
// set `git log --all --reflog` starts from). Negating every start point of
// the previous walk means a poll in which no commit landed on ANY branch,
// ANY linked worktree or ANY reflog walks zero commits, while a new commit
// anywhere is reachable from a start point we have not negated and is
// walked exactly as before. The single-sha `<last_seen_sha>..HEAD` range is
// retained ONLY as the one-time migration for a surface that has a legacy
// `per_repo_cursors` sha but no tip entry yet (it excluded one lineage under
// `--all --reflog`, so it re-walked ~36,605 commits per quiet poll —
// measured 2026-09-09). Tips are captured BEFORE the walk and persisted only
// AFTER the surface's walk and appends completed, so a commit landing
// mid-walk is walked now or next poll, never negated unseen. First run for a
// surface (no tips, no cursor) reads the full history bounded by
// LOG_MAX_COMMITS_FIRST_RUN. Tips are persisted ONLY after an unbounded walk
// (D3 gitlog-frontier-completeness): a first run whose listing filled that
// bound persists `[]` — the existing "negate nothing" frontier — so the next
// poll walks every lineage once (`--all --reflog`, absorbed by the dedup Set)
// and only then persists real tips; a first run that returned fewer commits
// than the bound was complete and persists real tips at once. Without the
// deferral, side-lineage commits older than the bound were negated unseen
// (pre-D1's `^cursor` range back-filled them on poll 2). Restart-recovery is
// automatic: the per-repo cursor advances only when the commits are
// successfully appended, and a failed tips walk falls back once to the
// legacy cursor/recovery branches.
// `per_repo_ref_tips` is corpus-sized (~20,500 shas across all surfaces) and
// lives in the change-gated heavy sidecar (state.heavy.json, see
// ConnectorBase.heavyCursorKeys), never in state.json.
//
// Repo discovery: walks each repo-root with a bounded depth (default 3) and
// collects every directory containing a `.git` entry (file OR dir — git
// worktrees have a .git FILE pointing at the parent). NEVER follows symlinks
// — this would balloon the walk and is one of the documented failure modes
// in kb/ingestion.md § Failure modes.
//
// HERMETICITY: every path is sourced via env-overridable repoRoots and the
// ConnectorBase config helpers. Tests build a synthetic mkdtempSync repo
// and override the roots; production <HOME>/{Documents,projects,...}
// is never touched in tests.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { ConnectorBase } from "./index.js";
import { serverTs } from "../envelope.js";
import { canonicalJson } from "../validation.js";
import { CHECKOUT_ROOT, STORAGE_DIR } from "../config.js";

// F-CCS-CONNECTOR-git-log-structural — slugify + canonical-id discipline lives
// in the substrate entity-extractor module. Re-using it here guarantees that
// the connector-stamped canonical_ids are byte-identical to the cascade text-
// extractor's canonical_ids for the same surface (foundation spec §6 merge
// invariant). buildCanonicalId is intentionally NOT used inline — see
// _structuralEntity() below — because it raises on the empty-slug sentinel
// while we want the connector to degrade gracefully (drop the entity, keep
// the row) per the brutalist defensive-degradation discipline.
import {
  slugify as entitySlugify,
  ENTITY_SLUG_REGEX,
  SLUG_EMPTY_SENTINEL,
} from "../synthesis/entity-extractor.js";

// F-INFRA-R42-IDENTITY / F-NEW-R42-CONSUMER-MIGRATION:
// Canonical operator-identity module is the single source of truth for
// "is this email the operator?". The local DEFAULT_OPERATOR_EMAILS const
// has been removed — see commit migrating consumers to R42 identity map.
// ENV override (GIT_LOG_OPERATOR_EMAILS) is still honored at the call site
// as an additive set on top of the canonical map (operator can override
// without source edits per F-T1-GIT_LOG-F1).
import { isOperator, getOperatorIdentities } from "../identity/operator-identity.js";

// F-INFRA-R43-BOT-ACTORS / F-NEW-R43-CONNECTOR-WIRING:
// Canonical bot-actor predicate. Used here to defensively force
// consent_basis=third_party_inferred for known bot author_emails — bots
// are never the operator even if their email accidentally matched the
// operator list. The inlined bot regex previously lived in stage0/gitlog.js;
// connector-side wiring ensures stage-0 + connector classification agree.
import { isBotActor } from "../identity/bot-actors.js";

// F-T2-GIT_LOG-F6 / F-T1-GIT_LOG-F2 — telemetry + quarantine for connector-
// side rules. recordDrop is the dispatcher counter; quarantineRow stores the
// dropped row under storage/quarantine/<source>/ so the operator can restore
// via restoreFromQuarantine() within the 30-day retention window.
//
// NOTE on reason allowlist (D2): every reason this connector emits —
// "git_log_upstream_repo_downgrade", "git_log_initial_commit_variant",
// "git_log_bot_commit_downgrade" (mcp/lib/ingest/stage0/telemetry.js:302-305)
// and "git_log_initial_commit_with_suffix" (telemetry.js:312) — IS in
// REASON_ALLOWLIST. The historical `novel reason ... invalid_reason` stderr
// lines predate that. Rule for adding telemetry here: PASS telemetry is
// recorded ONLY inside the `res.appended` branch of pollOnce (a deduped
// re-walk must not count — it produced ~1.9M phantom rows/day); DROP
// telemetry accompanies a real quarantineRow write. Do not introduce a new
// reason string without adding it to the allowlist in the same change.
import { recordDrop } from "../ingest/stage0/telemetry.js";
import { quarantineRow } from "../ingest/quarantine.js";

// =============================================================================
// Constants
// =============================================================================

// Default repo roots. Operator-overridable via GIT_LOG_REPO_ROOTS env var
// (colon-separated, similar to PATH). The defaults are conservative — we
// intentionally do not walk ~/Library or ~/Downloads because Library hosts
// package caches (homebrew taps with .git dirs the operator does not author
// in) and Downloads is high-churn clutter. Operator can override entirely
// to add custom roots like ~/work or ~/oss.
const DEFAULT_REPO_ROOTS = [
  join(homedir(), "Documents"),
  join(homedir(), "projects"),
  join(homedir(), "code"),
  CHECKOUT_ROOT,
  homedir(),
];

// F-T1-GIT_LOG-F1 / F-NEW-R42-CONSUMER-MIGRATION:
// The local DEFAULT_OPERATOR_EMAILS const has been REMOVED. Canonical
// operator emails now live in lib/identity/operator-identity.js (single
// source of truth: every address listed under `emails` in the operator-identity config,
// including any hostname-derived <user>@<host> form). The classifier consults isOperator() directly.
//
// Operator-overridable via GIT_LOG_OPERATOR_EMAILS env var (colon-separated
// — kept consistent with GIT_LOG_REPO_ROOTS). Entries listed there are
// unioned ADDITIVELY with the canonical R42 map; they cannot subtract from
// the canonical list. Set is built once at constructor time.
//
// HOSTNAME-DERIVED ADDRESS WARNING: the canonical map includes
// "<user>@<host>.local", which is hostname-derived and over-trusted on shared
// machines (lab Macs, FW-3, CI runners). See operator-identity.js review
// note (review-by 2026-12-01) — R42-v2 will pair hostname-derived addresses
// with repo_path_glob scoping.

// Repo discovery walk depth. Each level descends one directory deeper.
// Depth 3 means root/ -> root/a/ -> root/a/b/ -> root/a/b/c/.git is the
// deepest .git we will find. Beyond depth 3 the cost grows fast and the
// probability of finding a useful repo drops sharply (typical layout is
// ~/Documents/<project>/.git or ~/projects/<project>/.git). Tuneable via
// the constructor `walkDepth` opt for tests that want deeper.
const DEFAULT_WALK_DEPTH = 3;

// First-run history cap per repo. Without this a single 10k-commit repo
// would dominate the initial poll. Subsequent polls are incremental via
// the per-repo cursor and are unbounded. Bound matches kb/ingestion.md
// § Connector contract's "first-run backfill bounded" guidance.
const LOG_MAX_COMMITS_FIRST_RUN = 500;

// D5: stdout cap for the per-surface walk in _gitLogForRepo (the only walk
// that can be unbounded — the D3-deferred first run and the legacy/recovery
// fallbacks). Node kills git with ENOBUFS above it and keeps a partial
// stdout that is NOT a usable listing. Ctor option `logMaxBufferBytes`
// (tests inject a KB-scale value); _repoWalkTips and the classifier scan
// keep their own 64 MB literal because they are not the deferred walk.
// Measured 2026-09-15: 24/140 live surfaces list >500 commits; the largest
// (openwrt, 61,964 commits) lists 51.6 MB — under this cap, not by much.
const GIT_LOG_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// git log fields, pipe-delimited. Order matches the parser below.
// Format reference: https://git-scm.com/docs/pretty-formats
//   %H  full commit hash
//   %aI author date strict ISO-8601 (with timezone offset)
//   %an author name
//   %ae author email
//   %s  subject (first line of commit message)
//   %P  parent hashes, space-separated (empty for root commits)
//   %B  full commit message body (multi-line; bounded by BODY_DELIMITER)
//
// F-NEW-W7-GIT-LOG-BODY-CAPTURE: %B (full body) IS now captured. The audit
// found recall facts were subject-only metadata — substantive commit
// messages routinely encode WHY the change was made in the body. The body
// is bounded by a BODY_DELIMITER ("¶¶¶") on each side so the parser can
// extract it deterministically even when bodies contain newlines, pipes,
// or the field-separator. Body is capped at BODY_MAX_BYTES (8 KB) to
// guard against squash-merge mega-bodies; trailing whitespace is stripped.
// PII concern (paste-buffer leaks, debug output) is acknowledged but the
// downstream redaction layer (lib/redaction/predicates.js) operates on
// raw_content so adding body here does not bypass that pipeline.
//
// F-META-GIT-LOG-NUMSTAT: each commit is followed by per-file --numstat
// lines (added\tdeleted\tpath, one per file). We mark the end of the
// commit metadata line with a unique RECORD_TERMINATOR sentinel ("§§§") so
// the parser can split metadata from the trailing numstat block
// unambiguously even when subjects contain newlines or pipes.
//
// Format layout (one commit):
//   <%H>|<%aI>|<%an>|<%ae>|<%s>|<%P>\n¶¶¶\n<%B>\n¶¶¶§§§\n
//   <numstat-line>\n
//   <numstat-line>\n
//   \n            (separator)
//
// The parser splits chunks on RECORD_TERMINATOR ("§§§"), then within each
// chunk finds the metadata line (≥5 pipes), the BODY_DELIMITER markers,
// and the trailing numstat lines.
const BODY_DELIMITER = "¶¶¶";
const GIT_LOG_FORMAT = `%H|%aI|%an|%ae|%s|%P%n${BODY_DELIMITER}%n%B%n${BODY_DELIMITER}§§§`;

// Sentinel emitted at the end of each commit's metadata line so the parser
// can find the boundary between metadata and the trailing numstat block.
// The triple-section-sign is extremely unlikely to appear in commit
// subjects; if it does, we still split greedily on the LAST occurrence
// per commit, so a subject containing the sentinel would only confuse
// parsing if it appeared at the end of the subject (vanishingly rare).
const RECORD_TERMINATOR = "§§§";

// F-NEW-W7-GIT-LOG-BODY-CAPTURE: cap on raw body bytes per commit. 8 KB is
// well above typical commit-body lengths (median ~200 chars) and bounds
// pathological squash-merge bodies that can otherwise reach hundreds of
// KB. When the cap fires, body is truncated to BODY_MAX_BYTES and the
// emitted row carries body_truncated=true so downstream rules can detect
// it. The cap is intentionally lower than MAX_FILE_CHANGES * average-path
// because the body string is unbounded per character whereas numstat
// lines are bounded by path length.
const BODY_MAX_BYTES = 8 * 1024;

// Field separator chosen to be unlikely in commit subjects. We additionally
// validate field count per row and skip malformed rows defensively.
const FIELD_SEP = "|";

// F-META-GIT-LOG-NUMSTAT: cap on file_changes array length per commit. Some
// commits (squash-merges, monorepo refactors) touch thousands of files; we
// retain the first MAX_FILE_CHANGES entries and record a truncated flag so
// downstream rules can see "this was a big change" without paying the row-
// size cost. 256 is well above the typical commit (median ~3 files) and
// below the row-size budget.
const MAX_FILE_CHANGES = 256;

// =============================================================================
// Dedup (F-T1-GIT_LOG-F3): repo-prefixed source_msg_id + full-scan Set
// =============================================================================
//
// The base class's bounded tail-buffer dedup (CONNECTOR_DEDUP_TAIL_LINES=256)
// is structurally insufficient for git-log. Repo discovery emits commits in
// batches that routinely exceed 256 rows, so on every poll a repo with >256
// rows can re-emit duplicates that fall outside the tail window. The audit
// trace identified 645,370 duplicate rows = 96.0% of the ledger as a result.
//
// D5 — interaction with the D3 deferred walk, PINNED not gated. When the
// streaming ledger scan fails (_dedupFallbackMode; stderr + tagError
// "dedup_stream_read_failed" in _buildDedupSet) _isDuplicate degrades to the
// base-class tail window (dedupTailLines, connectors/index.js). A surface
// whose first run filled LOG_MAX_COMMITS_FIRST_RUN persisted `[]` and does
// one unbounded `--all --reflog` walk on the next poll; under the fallback
// only the window absorbs it, so up to (first-run rows − window) rows
// re-append EXACTLY ONCE, after which real tips are persisted and the surface
// goes quiet (T12.n). Neither gate is taken: keeping `[]` would repeat the
// blast on every poll while the read is broken; skipping the deferral would
// silently narrow coverage, the defect D3 fixed. The fallback is already loud.
//
// Fix shape:
//   1. Override _isDuplicate with a full-scan in-memory Set<source_msg_id>.
//   2. Key shape: `git:<repo_identity_hash>:<sha>` so the same commit cherry-
//      picked into two INDEPENDENT repos is NOT collapsed (round-20-style
//      "context matters" for dev provenance).
//
//      e12 — THE HASHED THING IS THE REPO'S IDENTITY, NOT THE PATH IT WAS
//      OBSERVED THROUGH. This distinction is the whole of the e12 fix and it
//      is worth stating plainly, because the append-time dedup above was
//      never broken — it worked perfectly and still let a 5.79x overcount
//      through, precisely because it was asked to dedup on the WRONG KEY.
//
//      A git WORKTREE is a second working surface over ONE object store. The
//      operator's machine carried 15 surfaces (example-app, example-app-g1/g3,
//      ea-g4, ea-wt-*, example-app-fv/pr48/…) all sharing a single
//      `.git` common-dir. Discovery correctly found all 15; each hashed its
//      OWN path, so one commit minted 15 DIFFERENT source_msg_ids, every one
//      of them a legitimate miss in the dedup Set. Measured on the live
//      ledger over the 2026-07-30 window: 9,821 rows for 1,696 distinct
//      commit_hash values = 5.791x, with 1,430 rows apiece under
//      example-app-g1 and example-app-g3 for the same 1,430 commits.
//
//      _canonicalRepoIdentity() collapses that: every surface sharing a
//      git-common-dir resolves to the SAME identity (the main worktree's
//      directory), so all 15 mint one key. Two independent CLONES have two
//      different common-dirs and therefore still hash apart — the round-20
//      rule ("the same commit in two genuinely separate repositories is two
//      events") survives untouched. Only same-object-store surfaces collapse.
//
//      THE KEY SHAPE DOES NOT CHANGE, and that is load-bearing, not
//      incidental. `git:<12-hex>:<sha>` stays. Because the identity of the
//      example-app group resolves to <HOME>/Documents/example-app — the
//      path whose rows are ALREADY on disk under prefix git:0123456789ab: —
//      the first post-fix poll of example-app-g1 computes a key the dedup Set
//      already holds and appends nothing. The fix is migration-free by
//      construction. A NEW key shape would instead miss every historical key
//      and re-append ~1,692 commits per group into an append-only ledger,
//      making the overcount permanently worse. Do not "clean up" the shape.
//
//      IDENTITY COLLAPSES; DISCOVERY DOES NOT. Every discovered surface is
//      still walked with `git log --all --reflog` (:_gitLogForRepo). refs/heads
//      is shared across worktrees so `--all` from the main worktree already
//      covers every branch — but the REFLOG is PER-WORKTREE, so dropping
//      secondary surfaces from discovery would silently lose commits reachable
//      only from a linked worktree's reflog, which is the exact class
//      `--reflog` was added to catch. Collapsing identity is lossless.
//      Collapsing discovery is not.
//   3. Set build is LAZY — triggered on the first append attempt, not at
//      constructor time. Daemon-start latency is bounded; the cost lands on
//      the first poll that actually has commits to emit.
//   4. Tail-checksum sanity: when building the Set, also recompute the
//      checksum of the last TAIL_CHECKSUM_VERIFY_LINES rows. If any row's
//      stored checksum differs from the recomputed value, we treat the
//      ledger as having been truncated/rotated externally and fall back to
//      bounded tail-dedup mode (emit a stderr warning so the operator sees
//      it).
//   5. Telemetry: in-memory counter `_dedupHitCount` increments on every
//      dedup hit; surfaced through `getDedupStats()` for the supervisor /
//      MEASURE harness to read.

// =============================================================================
// e12 — OPERATOR MIGRATION PROCEDURE FOR THE SURPLUS ROWS ALREADY ON DISK.
// WRITTEN, NOT RUN. Nothing in this file executes it.
// =============================================================================
//
// The fix above changes the FUTURE only. storage/sources/git-log.jsonl is
// append-only: it is never rewritten, truncated, reordered or de-duplicated in
// place by this connector or by any test, so the ~8,100 surplus rows in the
// 2026-07-30 window (9,821 rows for 1,696 distinct commits) stay exactly where
// they are until an operator decides otherwise. Correcting history is an
// OPERATOR ACTION, deliberately outside this connector's authority.
//
// What the operator would run, if they choose to:
//
//   1. MEASURE FIRST, and keep the measurement. Stream the ledger (readline or
//      the fd+readSync pattern in _buildDedupSet — NEVER readFileSync; the file
//      is 149 MB today and this connector has already been burned once by
//      ERR_STRING_TOO_LONG, at a cost of ~30k duplicate rows per poll). Group
//      by (canonical_identity, commit_hash) where canonical_identity is
//      _canonicalRepoIdentity(raw_content.repo_path). Record the row count, the
//      distinct-group count, and the ratio. That ratio is the acceptance
//      criterion for step 4.
//
//   2. KEEP THE EARLIEST ROW PER GROUP. Order within a group by ledger position
//      (the append order), not by ts: ts is the commit's author time, which is
//      IDENTICAL across the duplicate rows and therefore cannot break the tie.
//      The earliest row is the one whose id/checksum any existing downstream
//      reference is most likely to name.
//
//   3. WRITE A NEW FILE, THEN SWAP. Never edit in place. Emit the kept rows to
//      git-log.jsonl.migrated in original order, verify the line count equals
//      the distinct-group count from step 1, verify every distinct commit_hash
//      present in the original is still present (NO COMMIT LOSS is the
//      invariant that matters most here), then move the original aside — do not
//      delete it — and rename the new file into place.
//
//   4. RECONCILE THE DERIVED STATE. Rows removed from the source ledger have
//      already propagated: quarantine dailies, the fact ledger, embeddings and
//      any index built from them still carry the surplus. The migration is not
//      complete until those are rebuilt or reconciled. Deciding that scope is
//      the operator's call, which is precisely why this is not a code path.
//
//   5. DO NOT TOUCH connectors/git-log.json. The per-repo cursors are a walk
//      frontier over the repos, not over the ledger; rewriting them to match a
//      migrated ledger risks a full re-walk. Leave them alone.
//
// A NOTE ON WHY NO RE-APPEND IS NEEDED AT ALL: because the identity resolves to
// a path whose rows are already on disk (example-app -> git:0123456789ab:), the
// first post-fix poll finds its keys already in the dedup Set and appends
// nothing. The surplus is stale, not growing. That is what makes the migration
// optional rather than urgent.

// Number of trailing rows whose stored checksum we recompute on Set build
// to detect external truncation/rotation. The base class's checksum shape
// is blake2b512-truncated-to-16-hex over canonical_json of the row minus
// its checksum field — same hash used downstream by recovery scanners.
const TAIL_CHECKSUM_VERIFY_LINES = 16;

// F-GIT_LOG-DEDUP-STREAM: chunk size for the fd-based streaming ledger scan
// in _buildDedupSet(). The previous implementation did a whole-file
// readFileSync(..., "utf8"); once the ledger crossed Node's ~512 MB max
// string length (observed at 1.4 GB / 1.1M rows) that read threw
// ERR_STRING_TOO_LONG on EVERY build, the catch dropped us into the
// 256-line tail-dedup fallback, and the connector re-appended ~30k
// duplicate rows per poll — the exact runaway the full-scan Set was built
// to prevent. The scan is now a sync fd + readSync loop (callers
// _isDuplicate / _repoHasPriorHistory are sync, so async streams are not
// an option) that splits on newline bytes; only one chunk plus the current
// carry (partial line) is ever held as a Buffer, and only one line at a
// time exists as a string. 8 MiB balances syscall count (~180 reads for a
// 1.4 GB ledger) against resident memory. Tests inject a tiny value via
// opts.dedupStreamChunkBytes to force lines to straddle chunk boundaries.
const DEDUP_STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

// Short hash of a repo IDENTITY (an absolute path). Callers must pass the
// value from _canonicalRepoIdentity(), never a raw discovered surface path —
// see the e12 note above. The function itself is unchanged: it is a pure
// path->hash, and keeping it that way is what makes the identity decision
// reviewable at one call site instead of hidden inside the hash.
// We use the first 12 hex chars of
// blake2b512 — 48 bits is well past the birthday-paradox safety line for
// the dozens-to-hundreds of repos a single operator's machine carries, and
// keeps the source_msg_id short enough to not bloat row size.
function repoPathHash(absRepoPath) {
  return createHash("blake2b512").update(absRepoPath).digest().subarray(0, 6).toString("hex");
}

// Match the base class's checksum shape exactly. If lib/connectors/index.js
// changes its checksum algorithm, this MUST move in lockstep — the tail
// sanity check is only correct when it recomputes byte-identically.
function blake2b512TruncTo16Hex(bytes) {
  return createHash("blake2b512").update(bytes).digest().subarray(0, 16).toString("hex");
}

// =============================================================================
// F-T1-GIT_LOG-F2: Repo classification (operator_owned / mixed / upstream_only)
// =============================================================================
//
// The audit identified that 63.7% of git-log ledger rows came from upstream
// clones with ZERO operator commits (openwrt: 252k rows, iTerm2: 176k rows).
// The original audit predicate proposed DROP for such repos; the brutalist
// critic modification (Round-3) replaced that with a structural_score=0.10
// DOWNGRADE so cross-source corroboration recall is preserved at near-zero
// embed cost. This module implements the downgrade-flagging path: classify
// each repo once, cache the verdict, and tag emitted rows with both the
// classification and a suggested structural_score that the Stage-0 dispatch
// layer (or any downstream salience consumer) can apply.
//
// Classification is computed by walking FULL repo history (NOT bounded to
// last-500 like the emit path) — bounded windows misclassified fork-in-
// progress repos, study repos, and co-founder repos where operator commits
// trickled in slowly. Full history is the only reliable basis.
//
// Cache shape:
//   {
//     <abs_repo_path>: {
//       operator_count: int,
//       total_count: int,
//       classification: "operator_owned" | "mixed" | "upstream_only",
//       classified_at: ISO-8601,
//     },
//     ...
//   }
// Cache TTL: 7 days. Entries older than the TTL are re-evaluated so
// newly-forked repos transition from "upstream_only" -> "mixed" once the
// operator starts committing. "upstream_only" entries are recomputed on EVERY
// poll (not just on TTL expiry) so a single operator commit flips the
// classification immediately — matches the original audit's mitigation note.

// Path to the on-disk classification cache. STORAGE_DIR is env-overridable
// via STORAGE_BASE_DIR so tests can redirect to a tmp dir.
const REPO_CLASSIFICATION_CACHE_FILENAME = "git-log-repo-classification.json";
function repoClassificationCachePath() {
  return join(STORAGE_DIR, REPO_CLASSIFICATION_CACHE_FILENAME);
}

// Re-classify cached entries older than this. Seven days matches a typical
// repo-activity cadence — repos churn weekly, not hourly.
const REPO_CLASSIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Downgrade score for upstream-only repos. 0.10 is well below the typical
// substantive_prose=0.85 / subject_only=0.5 but non-zero so cross-source
// corroboration logic can still find these rows.
const UPSTREAM_REPO_DOWNGRADE_SCORE = 0.10;

// Downgrade score for bot-authored commits. Same rationale as upstream
// downgrade: preserve cross-source corroboration value (CI-bot integrations
// occasionally reference operator PRs) at near-zero embed cost.
const BOT_COMMIT_DOWNGRADE_SCORE = 0.05;

// Maximum commits to read when computing the classification. 0 means
// "no cap" (the connector default is unbounded — we want a full history
// scan per the critic mitigation). Tests inject a small value to keep
// fixtures fast.
const CLASSIFY_HISTORY_DEPTH_DEFAULT = 0; // 0 = unbounded

// F-GIT_LOG-GITDIR-VALIDATE: resolveGitDir — cheap validity probe for a
// discovered repo. _walk() treats ANY directory containing a `.git` entry
// as a repo, but a `.git` entry is not proof of a working repo:
//   - an empty `.git` directory carcass (init interrupted / manually
//     gutted) fails every git command with "not a git repository",
//   - a dangling submodule pointer FILE ("gitdir: ../../.git/modules/...")
//     whose superproject checkout no longer has a `.git` can NEVER
//     resolve.
// Both were observed in production (4 repos, error_count inflated by 4 on
// every poll, 1,701 accumulated errors) and neither can heal on its own —
// re-running `git log` per poll just re-fails forever. `git rev-parse
// --git-dir` is the canonical resolution probe: it succeeds iff git can
// locate a usable gitdir, without walking any history. Returns
// {ok: true} or {ok: false, error: <trimmed stderr, capped>}.
function resolveGitDir(repoPath) {
  const res = spawnSync("git", ["-C", repoPath, "rev-parse", "--git-dir"], {
    encoding: "utf8",
  });
  if (res.error) {
    return { ok: false, error: `spawn_failed:${res.error.code || res.error.message}`.slice(0, 200) };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || "").toString().trim();
    return { ok: false, error: (stderr || `git_rev_parse_exit_${res.status}`).slice(0, 200) };
  }
  return { ok: true };
}

// classifyRepo: shell out to `git log` and count operator-authored vs total
// commits. Returns {operator_count, total_count, classification,
// classified_at}. Pure function — does not read/write the cache; callers
// (the connector) own cache I/O.
//
// classification rules:
//   - total === 0                → "mixed" (no signal; empty repo)
//   - operator_count === 0       → "upstream_only"
//   - operator_count === total   → "operator_owned"
//   - otherwise                  → "mixed"
//
// operatorEmails: Set<string> | string[] of operator emails to count as
//   operator-authored. Caller supplies the union of the R42 canonical EMAILS
//   and any ENV/constructor overrides. We additionally call isOperator() as
//   a safety net so canonical-list updates picked up without a code change.
//
// opts.maxCommits: cap on number of commits to read. 0 (default) = full
//   history. Tests inject a small value.
export function classifyRepo(repoPath, operatorEmails, opts = {}) {
  const maxCommits = Number.isInteger(opts.maxCommits) && opts.maxCommits >= 0
    ? opts.maxCommits
    : CLASSIFY_HISTORY_DEPTH_DEFAULT;
  const nowFn = typeof opts.now === "function" ? opts.now : serverTs;
  const opSet = operatorEmails instanceof Set
    ? operatorEmails
    : new Set(
        (Array.isArray(operatorEmails) ? operatorEmails : [])
          .map((e) => String(e || "").toLowerCase())
          .filter(Boolean),
      );

  const args = [
    "-C", repoPath,
    "log",
    "--pretty=format:%ae",
    "--all",
  ];
  if (maxCommits > 0) {
    args.push("-n", String(maxCommits));
  }
  const res = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.status !== 0) {
    // Unreadable repo (corrupt .git, permissions). Treat as "mixed" so we
    // neither over-trust nor over-drop. The classification will be retried
    // on the next poll because cached classified_at carries the failure ts
    // and "mixed" is not the immediate-recompute case — we re-check on TTL.
    return {
      operator_count: 0,
      total_count: 0,
      classification: "mixed",
      classified_at: nowFn(),
      error: ((res.stderr || "").toString().trim() || "git_log_failed").slice(0, 200),
    };
  }

  const raw = (res.stdout || "").toString();
  let total = 0;
  let operator = 0;
  if (raw !== "") {
    const lines = raw.split("\n");
    for (const line of lines) {
      if (line === "") continue;
      total += 1;
      const lc = line.toLowerCase();
      if (opSet.has(lc)) operator += 1;
      else if (isOperator(line, "git-log")) operator += 1;
    }
  }

  let classification;
  if (total === 0) {
    classification = "mixed";
  } else if (operator === 0) {
    classification = "upstream_only";
  } else if (operator === total) {
    classification = "operator_owned";
  } else {
    classification = "mixed";
  }

  return {
    operator_count: operator,
    total_count: total,
    classification,
    classified_at: nowFn(),
  };
}

// loadRepoClassificationCache: read the on-disk cache. Returns an empty
// object if the file does not exist or is malformed. Safe to call at
// daemon-start — never throws.
function loadRepoClassificationCache() {
  const path = repoClassificationCachePath();
  if (!existsSync(path)) return {};
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

// saveRepoClassificationCache: best-effort write. Failures are logged via
// console.warn but do NOT throw — cache is an optimisation, not a hard
// dependency. Writes through STORAGE_DIR so the env-override discipline
// applies (tests redirect via STORAGE_BASE_DIR).
function saveRepoClassificationCache(cache) {
  const path = repoClassificationCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort */
  }
  try {
    writeFileSync(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[git-log classify] cache write failed: ${err && err.message ? err.message : String(err)}`,
      );
    } catch { /* never let logging fail */ }
  }
}

// shouldReclassify: decision for whether a cached entry needs a refresh.
// Re-classify when:
//   - no cache entry exists,
//   - the entry is older than REPO_CLASSIFICATION_TTL_MS,
//   - the entry is currently "upstream_only" (cheap re-check so a first
//     operator commit flips the classification immediately),
//   - the entry carries an `error` field (transient git failure should
//     not stick for 7 days; retry every poll so a corrupt .git or a
//     temporarily-locked index does not lock the row into "mixed"),
//   - F-NEW-W7-GIT-LOG-UPSTREAM-CLASSIFIER-FIX: the entry has total_count===0.
//     A zero-total verdict only happens when classifyRepo's git log
//     returned empty stdout — that is either an empty repo (rare) or a
//     git invocation that was raced against a shallow clone / fetch in
//     progress. Either way, sticking with "mixed" for 7 days suppresses
//     the upstream downgrade on legitimate openwrt-style upstream repos
//     that simply weren't ready on the classifier's first attempt.
function shouldReclassify(cached, nowMs) {
  if (!cached || typeof cached !== "object") return true;
  if (cached.classification === "upstream_only") return true;
  if (typeof cached.error === "string" && cached.error.length > 0) return true;
  if (cached.total_count === 0) return true;
  if (typeof cached.classified_at !== "string") return true;
  const ageMs = nowMs - Date.parse(cached.classified_at);
  if (!Number.isFinite(ageMs)) return true;
  return ageMs >= REPO_CLASSIFICATION_TTL_MS;
}

// =============================================================================
// F-T2-GIT_LOG-F6: Initial-commit variant detection (case-insensitive,
// "Initial commit: <suffix>" allowed, parents.length===0 also fires)
// =============================================================================
//
// The original Stage-0 rule fired only on the strict-equality subject
// "Initial commit". The audit found ~270 underbroad variants ("initial
// commit", "Initial commit:", "Initial commit: scaffold", etc.) and an
// unknown number of root commits with non-canonical subjects ("repo
// inception", "scaffold start"). Per the brutalist invariants, DROP rules
// must call quarantineRow() so the dropped row is recoverable for 30 days
// rather than permanently lost. The connector intercepts the row BEFORE
// emit, calls quarantineRow with the full source-shape (source +
// source_msg_id + raw_content), and skips appendLedgerRow.

const INITIAL_COMMIT_SUBJECT_RE = /^["' ]*initial commit\b/i;

// F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT — carve-out regex: matches
// "Initial commit: <substantive suffix>" where the suffix encodes project
// intent ("sample curriculum outline and notes", "scaffold + tests", ...).
// Together with a suffix-length floor (>25 chars), these commits PASS at a
// modest structural_score (0.55) rather than being quarantined. The
// case-insensitive marker is required so "INITIAL COMMIT:" / "initial
// commit:" / quoted variants all participate.
const INITIAL_COMMIT_WITH_SUFFIX_RE = /^["' ]*initial commit:\s+(\S.*)$/i;
const INITIAL_COMMIT_SUFFIX_MIN_LENGTH = 25;

// F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT — helper for connector + Stage-0
// to share. Returns the trimmed suffix when the subject matches the
// "Initial commit: <suffix>" carve-out AND the suffix exceeds the min
// length floor; returns null otherwise. The minimum-length floor is what
// keeps "Initial commit: foo" (3-char suffix = noise) out of the
// carve-out while letting
// "Initial commit: sample curriculum outline and notes" (substantive
// intent) through.
export function initialCommitSuffix(subject) {
  if (typeof subject !== "string") return null;
  const m = INITIAL_COMMIT_WITH_SUFFIX_RE.exec(subject);
  if (!m) return null;
  const suffix = (m[1] || "").trim();
  if (suffix.length <= INITIAL_COMMIT_SUFFIX_MIN_LENGTH) return null;
  return suffix;
}

// F-NEW-W7-GIT-LOG-RULE1-TIGHTEN: previously this returned true on EITHER
// the subject prefix OR parents.length===0. The audit found the parents=[]
// branch was over-reaching: stash-snapshot synthetic commits, freshly
// rewritten branches, and substantive scaffolds (e.g. "sync workspace sources"
// at 6500 LOC) all carry parents=[] but are NOT semantically empty.
// Tightened predicate: REQUIRE the subject match AND at least one
// corroborating signal (parents=[] or the connector-stamped
// is_initial_commit hint). When the subject does not match — even with
// parents=[] — we no longer quarantine, allowing legitimate root commits
// with substantive subjects to flow through. Carve-out for the colon-
// suffix variant ("Initial commit: <substantive>") is layered above:
// callers must check initialCommitSuffix() first.
export function isInitialCommitVariant(subject, parents, opts = {}) {
  const subjectMatches =
    typeof subject === "string" && INITIAL_COMMIT_SUBJECT_RE.test(subject);
  if (!subjectMatches) return false;
  // Subject matches; require corroborating signal so a substantive commit
  // whose subject HAPPENS to start with "initial commit" but has real
  // parents (e.g. a refactor named that way) does not get caught.
  const noParents = Array.isArray(parents) && parents.length === 0;
  const isInitialHint = opts && opts.is_initial_commit === true;
  return noParents || isInitialHint;
}

// =============================================================================
// F-CCS-CONNECTOR-git-log-structural — buildStructuredFeatures (per-row)
// =============================================================================
//
// The salience cascade currently re-derives entities and time anchors from
// raw subject text every time it promotes a fact. That is the FM-1 regression
// in slow motion: a fuzzy NER pass over `subject = "Initial commit"` cannot
// recover the author email, and we lose structural ground truth to entropic
// re-extraction. This connector ALREADY KNOWS — at emit time — who the
// person is (raw_content.author_email), what the project is
// (basename(raw_content.repo_path)), and when the event happened
// (raw_content.author_ts). The structured-features payload pins all three so
// downstream cascades can stop forcing the text extractor to re-discover them.
//
// Shape pinned by mcp/docs/specs/ccs/structured-features-schema.md §3.1 +
// worked example §5.1. The Entity + TimeAnchor sub-shapes are
// referenced (not redefined) from mcp/docs/specs/synthesis/entity-schema.md §4
// and time-anchor-schema.md respectively. evidence:'structural' bypasses the
// FM-1 STOPWORDS check per entity-schema §6.3 — exactly the antidote.
//
// CAPS (foundation spec §3.2). Inlined here as frozen module-local constants
// because the connector ships before the central mcp/lib/validation.js CAPS
// edits land. Module exports VERSION + frozen CAPS per the WU engineering
// discipline.

/** Frozen schema discriminator for the v0 ship of structured_features. */
export const STRUCTURED_FEATURES_SCHEMA_VERSION = "v1";

/**
 * Frozen emitter version stamped on every structured_features payload
 * produced by this module. Matches the worked example
 * (structured-features-schema.md §5.1) verbatim AND the regex in
 * time-anchor-schema.md §8 I8.
 */
export const STRUCTURED_FEATURES_EMITTER_VERSION = "git-log-local@1.0.0";

/**
 * The entity-schema source_scope this connector stamps. Matches
 * ENTITY_SOURCE_SCOPES from lib/synthesis/entity-extractor.js (the closed
 * 7-source enum). Stamping a non-enum source_scope would make the
 * canonical_id drift from the cascade text-extractor path and break the
 * union-by-canonical-id merge invariant.
 */
export const STRUCTURED_FEATURES_SOURCE_SCOPE = "git-log";

/**
 * Per-row evidence kind. Connector-emit allowlist is {handle, structural,
 * kb_lookup} per foundation spec §3.2; git-log knows author_email + repo
 * basename structurally, so 'structural' is the only honest value.
 */
const STRUCTURED_EVIDENCE = "structural";

// Module-VERSION export for the WU engineering discipline ("Module exports
// VERSION + frozen CAPS"). Bumped when the structured-features emission
// logic changes (NOT when the parser changes — the parser does not affect
// the pinned canonical_id discipline).
export const VERSION = STRUCTURED_FEATURES_EMITTER_VERSION;

// Frozen CAPS bag for the WU discipline + test introspection. Tests can read
// CAPS.SCHEMA_VERSION etc. directly without poking at named exports.
export const CAPS = Object.freeze({
  SCHEMA_VERSION: STRUCTURED_FEATURES_SCHEMA_VERSION,
  EMITTER_VERSION: STRUCTURED_FEATURES_EMITTER_VERSION,
  SOURCE_SCOPE: STRUCTURED_FEATURES_SOURCE_SCOPE,
});

/**
 * _structuralEntity: build one Entity (entity-schema §4 shape) from a raw
 * surface. Returns null if the surface slugifies to the empty sentinel
 * (defensive degradation — the cascade still has the text-extractor path
 * for that surface).
 *
 * Pure function. No I/O, no Date.now(), no Math.random().
 */
function _structuralEntity(kind, surface) {
  if (typeof surface !== "string" || surface === "") return null;
  let slug;
  try {
    slug = entitySlugify(surface);
  } catch {
    return null;
  }
  if (slug === SLUG_EMPTY_SENTINEL) return null;
  if (!ENTITY_SLUG_REGEX.test(slug)) return null;
  return {
    kind,
    canonical_id: `${kind}:${STRUCTURED_FEATURES_SOURCE_SCOPE}:${slug}`,
    surface,
    source_scope: STRUCTURED_FEATURES_SOURCE_SCOPE,
    evidence: STRUCTURED_EVIDENCE,
    confidence: 1.0,
    extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
  };
}

/**
 * buildStructuredFeatures: derive the structured_features payload for a
 * single git-log row from its raw_content. Returns the payload object on
 * success OR null/undefined when the raw_content is missing the
 * structurally-typed fields we need (defensive degradation per the
 * brutalist hot-path discipline — the connector emits the row without
 * structured_features and the cascade falls back to the text-extractor
 * path, which is the explicit backwards-compat invariant from foundation
 * spec §7).
 *
 * Inputs we read from raw_content (the connector ALREADY KNOWS these):
 *   - author_email : the operator-or-bot email; becomes person entity +
 *                    parties[].
 *   - repo_path    : absolute repo dir; basename becomes project entity.
 *   - author_ts    : strict ISO-8601 timestamp; becomes the absolute
 *                    time anchor with parsed.iso = UTC-normalized.
 *
 * Failure modes that route to null (NOT throw — never block emit):
 *   - rawContent is not a plain object
 *   - all three structural fields are missing/empty/non-string
 *   - author_email AND repo_path both fail to slugify (no entities at
 *     all is structurally indistinguishable from text-extractor path)
 *
 * Otherwise: returns a partial payload (some structural fields may be
 * empty arrays if their input was malformed). The cascade merger is
 * union-with-precedence so partial structural emission is strictly
 * additive (foundation spec §6).
 */
export function buildStructuredFeatures(rawContent) {
  if (rawContent == null || typeof rawContent !== "object" || Array.isArray(rawContent)) {
    return null;
  }

  const entities = [];

  // Person entity from author_email. The email is the canonical surface
  // per entity-schema §5.3 — NOT author_name (name conflates and would
  // generate stopword-conflict slugs like "nadia").
  const authorEmail = rawContent.author_email;
  const personEntity = _structuralEntity("person", authorEmail);
  if (personEntity) entities.push(personEntity);

  // Project entity from basename(repo_path). basename gives us the repo
  // dir name regardless of where the operator clones it; same repo
  // cloned to two locations stamps the same project canonical_id (this
  // is intentional — the project IS the repo, the path is just where
  // it lives).
  let projectEntity = null;
  if (typeof rawContent.repo_path === "string" && rawContent.repo_path !== "") {
    const repoBase = basename(rawContent.repo_path);
    projectEntity = _structuralEntity("project", repoBase);
    if (projectEntity) entities.push(projectEntity);
  }

  // Absolute time anchor from author_ts. raw_phrase preserves the
  // original-TZ form for audit; parsed.iso is UTC-normalized so the
  // cascade dedupe key (kind, parsed.iso) is stable across TZ-offset
  // variants of the same instant. Date(...).toISOString() normalizes
  // to UTC by construction.
  const timeAnchors = [];
  const authorTs = rawContent.author_ts;
  if (typeof authorTs === "string" && authorTs !== "") {
    const parsedMs = Date.parse(authorTs);
    if (Number.isFinite(parsedMs)) {
      let iso;
      try {
        iso = new Date(parsedMs).toISOString();
      } catch {
        iso = null;
      }
      if (typeof iso === "string" && iso !== "") {
        timeAnchors.push({
          kind: "absolute",
          raw_phrase: authorTs,
          parsed: { iso },
          extractor_confidence: 1.0,
          extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
          // structural=true is the connector's pinning that this anchor
          // comes from a structurally-typed field — the merger uses this
          // to win tie-breaks over text-extracted anchors of the same
          // (kind, iso) per foundation spec §6 OQ5.
          structural: true,
        });
      }
    }
  }

  // parties[] is the canonicalized projection of row.parties[] — keyed by
  // person canonical_id so the merger can intersect by id directly per
  // foundation spec §3.1 / §6.3. Empty when author_email did not slugify
  // (the cascade still derives a person via row-parties-as-entities on
  // the opaque handle).
  const parties = [];
  if (personEntity) parties.push(personEntity.canonical_id);

  // If we found NOTHING structural at all, return null so the row emits
  // without structured_features (backwards-compat path; cascade text
  // extractor runs as today).
  if (entities.length === 0 && timeAnchors.length === 0 && parties.length === 0) {
    return null;
  }

  // Sort entities by canonical_id (foundation spec §3.1 — array MUST be
  // sorted ascending for byte-stable merge / dedupe).
  entities.sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0,
  );

  return {
    schema_version: STRUCTURED_FEATURES_SCHEMA_VERSION,
    emitter_version: STRUCTURED_FEATURES_EMITTER_VERSION,
    entities,
    time_anchors: timeAnchors,
    parties,
  };
}

// =============================================================================
// GitLogConnector
// =============================================================================

export class GitLogConnector extends ConnectorBase {
  // D1: the per-surface tip frontier is corpus-sized (~20,500 shas across the
  // discovered surfaces, ~850 KB) and changes only when a ref or reflog entry
  // moves, while state.json is rewritten every poll for a timestamp. Routing
  // it to the change-gated sidecar keeps the per-poll write O(1). Same shape
  // as codex-cli.js; see ConnectorBase.heavyCursorKeys.
  get heavyCursorKeys() {
    return ["per_repo_ref_tips"];
  }

  constructor(opts = {}) {
    const {
      repoRoots,
      operatorEmails,
      walkDepth,
      logMaxCommitsFirstRun,
      logMaxBufferBytes,
      now,
      // F-T1-GIT_LOG-F2: classify-related options.
      // classifyBypass: when true, skip the upstream-repo downgrade check
      //   entirely. Useful for first-fork commit detection where the
      //   operator wants ALL commits to flow through (including
      //   upstream-only ones) — e.g. the operator just forked openwrt and
      //   wants to see the inherited history once before downgrading
      //   future polls.
      // classifyMaxCommits: cap on history depth for the classifier scan.
      //   Default 0 (unbounded full history). Tests inject a small value.
      classifyBypass,
      classifyMaxCommits,
      // F-GIT_LOG-DEDUP-STREAM: chunk size for the streaming dedup-set
      // ledger scan. Default DEDUP_STREAM_CHUNK_BYTES (8 MiB); tests
      // inject a tiny value to force lines to straddle chunk boundaries.
      dedupStreamChunkBytes,
      // ConnectorBase pass-throughs:
      sourceLedgerPath,
      cursorPath,
    } = opts;

    // F-T1-GIT_LOG-F1 / F-NEW-R42-CONSUMER-MIGRATION:
    // Operator-email override set. Constructor opts.operatorEmails wins for
    // tests; otherwise GIT_LOG_OPERATOR_EMAILS env var (colon-separated) is
    // unioned ADDITIVELY on top of the canonical R42 identity map. Caller
    // entries CANNOT subtract from the canonical list (isOperator() always
    // runs first); they only ADD per-deployment overrides without source
    // edits. Lowercased once at constructor time for case-insensitive match.
    const overrideEmailSet = new Set(
      (Array.isArray(operatorEmails) && operatorEmails.length > 0
        ? operatorEmails
        : (process.env.GIT_LOG_OPERATOR_EMAILS
            ? process.env.GIT_LOG_OPERATOR_EMAILS.split(":").filter(Boolean)
            : [])
      ).map((e) => String(e).toLowerCase()),
    );

    function sourcePolicyForRow(row) {
      // Round-20 close C1: authorship trumps audience.
      // - operator authored (author_email matches) → first_party
      // - non-operator author (co-author / merge / contribution) →
      //   third_party_inferred
      // deletion_semantics is `full_excise` for both — the operator can
      // request the row to be excised; the upstream `.git` history is the
      // source-of-truth and is untouched.
      const emailRaw =
        row && row.raw_content && typeof row.raw_content.author_email === "string"
          ? row.raw_content.author_email
          : "";
      const emailLc = emailRaw.toLowerCase();

      // F-NEW-R43-CONNECTOR-WIRING: defensive guard. Bot author_emails are
      // never the operator even if they accidentally collide with an
      // override entry. Classify as third_party_inferred regardless.
      if (emailRaw !== "" && isBotActor(emailRaw)) {
        return {
          deletion_semantics: "full_excise",
          consent_basis: "third_party_inferred",
        };
      }

      // F-NEW-R42-CONSUMER-MIGRATION: canonical identity check first; ENV
      // override is an additive union for per-deployment customisation.
      const operatorMatch =
        (emailRaw !== "" && isOperator(emailRaw, "git-log")) ||
        (emailLc !== "" && overrideEmailSet.has(emailLc));
      return {
        deletion_semantics: "full_excise",
        consent_basis: operatorMatch ? "first_party" : "third_party_inferred",
      };
    }

    super({
      source: "git-log",
      sourceLedgerPath,
      cursorPath,
      sourcePolicyForRow,
    });

    // Exposed for tests / introspection. This is the ADDITIVE override set
    // only — it does NOT contain the canonical R42 operator emails. Callers
    // wanting the effective lookup should call isOperator() from the
    // identity module + check this set, exactly as sourcePolicyForRow does.
    this.operatorEmailOverrides = overrideEmailSet;
    // Back-compat alias; deprecated. Remove once Phase-3 of R42 consumer
    // migration completes (see F-NEW-R42-CONSUMER-MIGRATION critic_mods).
    this.operatorEmails = overrideEmailSet;
    this.repoRoots =
      Array.isArray(repoRoots) && repoRoots.length > 0
        ? repoRoots.map((r) => resolve(r))
        : (process.env.GIT_LOG_REPO_ROOTS
            ? process.env.GIT_LOG_REPO_ROOTS.split(":").filter(Boolean).map((r) => resolve(r))
            : DEFAULT_REPO_ROOTS.map((r) => resolve(r)));
    this.walkDepth = Number.isInteger(walkDepth) && walkDepth >= 0 ? walkDepth : DEFAULT_WALK_DEPTH;
    this.logMaxCommitsFirstRun = Number.isInteger(logMaxCommitsFirstRun) && logMaxCommitsFirstRun > 0
      ? logMaxCommitsFirstRun
      : LOG_MAX_COMMITS_FIRST_RUN;
    // D5: used ONLY at _gitLogForRepo's spawnSync (see GIT_LOG_MAX_BUFFER_BYTES).
    this.logMaxBufferBytes = Number.isInteger(logMaxBufferBytes) && logMaxBufferBytes > 0
      ? logMaxBufferBytes
      : GIT_LOG_MAX_BUFFER_BYTES;
    // Override-for-test: opts.now is a () => ISO-8601 string; production
    // uses the shared envelope.serverTs.
    this._now = typeof now === "function" ? now : serverTs;

    // F-T1-GIT_LOG-F3: lazy full-scan dedup Set.
    //   _dedupSet           — Set<source_msg_id> populated on first emit.
    //   _dedupSetBuilt      — true once the Set has been built; the build is
    //                         attempted once per connector instance.
    //   _dedupFallbackMode  — true if the tail-checksum sanity check failed
    //                         and we are falling back to the base-class
    //                         tail-window dedup.
    //   _dedupHitCount      — telemetry counter; increments on every dedup
    //                         hit. Read by getDedupStats() for the supervisor
    //                         / MEASURE harness.
    //   _dedupBuildScanned  — number of ledger rows scanned during build.
    //   _dedupBuildSkipped  — rows skipped during build (malformed JSON,
    //                         missing source_msg_id).
    //   _dedupStreamError   — F-GIT_LOG-DEDUP-STREAM: null when the
    //                         streaming ledger scan succeeded; otherwise
    //                         the failure detail string. Surfaced via
    //                         getDedupStats().stream_error so the
    //                         supervisor sees WHY the connector is in
    //                         fallback tail-dedup mode (the silent
    //                         ERR_STRING_TOO_LONG fallback is the exact
    //                         runaway this replaces).
    this._dedupSet = new Set();
    this._dedupSetBuilt = false;
    this._dedupFallbackMode = false;
    this._dedupHitCount = 0;
    this._dedupBuildScanned = 0;
    this._dedupBuildSkipped = 0;
    this._dedupStreamError = null;
    this._dedupStreamChunkBytes =
      Number.isInteger(dedupStreamChunkBytes) && dedupStreamChunkBytes > 0
        ? dedupStreamChunkBytes
        : DEDUP_STREAM_CHUNK_BYTES;

    // e12: per-poll memo for `git rev-parse --git-common-dir`, Map<surface,
    // commonDir|null>. Cleared at the top of every pollOnce so the cost is
    // bounded at ONE rev-parse per discovered surface per poll (never one per
    // commit — a 1,430-commit worktree group would otherwise pay 1,430 forks),
    // while a worktree created or deleted between polls is still re-resolved.
    // Lazily re-created by _gitCommonDir so callers that reach identity
    // resolution outside pollOnce (tests, _repoHasPriorHistory) still work.
    this._commonDirMemo = new Map();

    // F-T1-GIT_LOG-F2: repo classification state.
    //   _classifyBypass        — opt-in flag to skip the upstream-repo
    //                            downgrade entirely (first-fork detection).
    //   _classifyMaxCommits    — history depth for the classifier scan; 0
    //                            (default) is unbounded full history per
    //                            the brutalist critic modification.
    //   _classificationCache   — lazy-loaded {repo_path -> entry} map; load
    //                            on first pollOnce, persist after refresh.
    //   _classificationCacheLoaded — guard for the lazy load.
    //   _classificationDirty   — set when an in-process refresh changed
    //                            entries; flushed back to disk at end of
    //                            pollOnce so a daemon crash does not lose
    //                            the work.
    //   _classifyDowngradeCount — telemetry: rows emitted with
    //                             repo_classification=upstream_only this
    //                             pollOnce. Read via getDedupStats().
    //   _classifyBotDowngradeCount — telemetry: bot-author rows tagged
    //                                for downgrade (F-T2-GIT_LOG-F5).
    //   _classifyInitialQuarantineCount — telemetry: Initial-commit
    //                                     variants routed to quarantine
    //                                     this pollOnce (F-T2-GIT_LOG-F6).
    this._classifyBypass = classifyBypass === true;
    this._classifyMaxCommits =
      Number.isInteger(classifyMaxCommits) && classifyMaxCommits >= 0
        ? classifyMaxCommits
        : CLASSIFY_HISTORY_DEPTH_DEFAULT;
    this._classificationCache = {};
    this._classificationCacheLoaded = false;
    this._classificationDirty = false;
    this._classifyDowngradeCount = 0;
    this._classifyBotDowngradeCount = 0;
    this._classifyInitialQuarantineCount = 0;
  }

  // ---------------------------------------------------------------------------
  // F-T1-GIT_LOG-F2: classification helpers (instance methods so subclass /
  // test fakes can override). Each method is small and pure-ish; the
  // mutation lives in `_ensureRepoClassification` which is called from
  // `pollOnce` per repo.
  // ---------------------------------------------------------------------------

  // _effectiveOperatorEmails: union of the R42 canonical EMAILS map and the
  // additive override set. Returned as a lower-cased Set for the
  // classifier. Built fresh on each call so a hot-reload of the identity
  // module (rare; module reload requires daemon restart in practice) does
  // not stick to a stale snapshot.
  //
  // F-NEW-W7-GIT-LOG-UPSTREAM-CLASSIFIER-FIX: previously this seeded the
  // Set with ONLY the additive overrides and relied on isOperator() inside
  // classifyRepo's per-line loop to cover the canonical R42 emails. That
  // works correctly for correctness, but it (a) makes the fast-path Set
  // empty in practice (no env override is set on the laptop) and (b) makes
  // it impossible to assert "this address counted as operator" via a test
  // that inspects _effectiveOperatorEmails. Pulling the canonical list in
  // via getOperatorIdentities() at call time avoids both problems and
  // matches the audit's "operator email list mismatch" repro path — the
  // classifier now sees a configured send-as alias (e.g. `ops@example.org`) as a Set hit without
  // depending on isOperator's per-source disambiguation. The fallback
  // isOperator() call inside classifyRepo() is retained so a hot-reload
  // of the identity module is still picked up.
  _effectiveOperatorEmails() {
    const out = new Set();
    for (const e of this.operatorEmailOverrides) {
      out.add(String(e || "").toLowerCase());
    }
    try {
      const ids = getOperatorIdentities();
      const emails = Array.isArray(ids && ids.emails) ? ids.emails : [];
      for (const e of emails) {
        if (typeof e === "string" && e.length > 0) out.add(e.toLowerCase());
      }
    } catch {
      // getOperatorIdentities throws should never happen; fail open and
      // rely on the per-line isOperator() fallback inside classifyRepo.
    }
    return out;
  }

  // _ensureRepoClassification: returns the cached entry for repoPath,
  // recomputing if shouldReclassify() says so. Side effect: marks the
  // cache as dirty so pollOnce flushes to disk at end-of-tick.
  _ensureRepoClassification(repoPath) {
    if (this._classifyBypass) {
      // Bypass mode: synthesize a "mixed" entry so emitted rows do not
      // carry a downgrade flag. Operator is asking for the upstream
      // history once (first-fork detection).
      return {
        operator_count: -1,
        total_count: -1,
        classification: "mixed",
        classified_at: this._now(),
        bypassed: true,
      };
    }
    if (!this._classificationCacheLoaded) {
      this._classificationCache = loadRepoClassificationCache();
      this._classificationCacheLoaded = true;
    }
    const cached = this._classificationCache[repoPath];
    const nowMs = Date.now();
    if (!shouldReclassify(cached, nowMs)) {
      return cached;
    }
    // F-GIT_LOG-GITDIR-VALIDATE: before spending a full-history classify
    // scan (and before pollOnce spends a `git log`), confirm git can
    // actually resolve the repo's gitdir. Broken checkouts (empty .git
    // carcass, dangling submodule pointer file) fail EVERY git command,
    // can never heal by retrying, and previously inflated error_count by
    // one per repo per poll via _gitLogForRepo's GIT_LOG_FAILED path.
    // Verdict is stamped on the classification entry as
    // gitdir_unresolvable=true; pollOnce skips such repos entirely.
    const gitDirCheck = resolveGitDir(repoPath);
    if (!gitDirCheck.ok) {
      if (cached && cached.gitdir_unresolvable === true) {
        // Still broken. Return the ORIGINAL entry untouched — no re-log,
        // no cache rewrite — so the skip is once-per-classification, not
        // noise-per-poll. (shouldReclassify keeps returning true because
        // `error` is set, so we re-probe with the cheap rev-parse each
        // poll and heal immediately once the operator repairs the repo.)
        return cached;
      }
      const entry = {
        operator_count: 0,
        total_count: 0,
        classification: "mixed",
        classified_at: this._now(),
        gitdir_unresolvable: true,
        error: gitDirCheck.error,
      };
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[git-log discovery] gitdir unresolvable at ${repoPath} — ` +
          `repo SKIPPED until it heals (${gitDirCheck.error})`
        );
      } catch { /* never let logging fail */ }
      this._classificationCache[repoPath] = entry;
      this._classificationDirty = true;
      return entry;
    }
    const opEmails = this._effectiveOperatorEmails();
    const entry = classifyRepo(repoPath, opEmails, {
      maxCommits: this._classifyMaxCommits,
      now: this._now,
    });
    this._classificationCache[repoPath] = entry;
    this._classificationDirty = true;
    return entry;
  }

  // _persistClassificationCache: flush the in-memory cache to disk if any
  // entry changed. Safe to call when nothing changed (no-op). Errors are
  // swallowed inside saveRepoClassificationCache.
  _persistClassificationCache() {
    if (!this._classificationDirty) return;
    saveRepoClassificationCache(this._classificationCache);
    this._classificationDirty = false;
  }

  // F-T2-GIT_LOG-F4: _repoHasPriorHistory — returns true iff the dedup
  // Set already contains at least one source_msg_id matching the repo's
  // `git:<repoPathHash>:*` prefix. The dedup Set is built lazily on first
  // _isDuplicate call; this helper forces the build so the answer is
  // accurate. Used by pollOnce to decide whether a missing cursor entry
  // should trigger the restart-recovery path (walk full history, dedup
  // absorbs) or the true-first-run path (bounded N commits).
  _repoHasPriorHistory(repoPath) {
    if (!this._dedupSetBuilt) {
      this._buildDedupSet();
    }
    // Fast empty check before doing the prefix scan.
    if (this._dedupSet.size === 0) return false;
    // e12: the prefix must be built from the same IDENTITY the emit path keys
    // on (:~1885), or the question "does the ledger already hold rows for this
    // repo?" is asked about a key that was never written. A linked worktree
    // whose cursor is missing would otherwise answer "no prior history" and
    // take the bounded true-first-run walk even though its parent's full
    // history is on disk. Nothing over-appends either way (the dedup Set
    // absorbs), but the two sites must agree on what a repo IS.
    const prefix = `git:${repoPathHash(this._canonicalRepoIdentity(repoPath))}:`;
    for (const id of this._dedupSet) {
      if (typeof id === "string" && id.startsWith(prefix)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Repo IDENTITY (e12-ingestion-overcount)
  // ---------------------------------------------------------------------------

  // _gitCommonDir — resolve the OBJECT STORE a discovered surface belongs to.
  //
  // `git rev-parse --git-common-dir` is the canonical answer to "which repo is
  // this really": for a main worktree it is that repo's `.git`; for a LINKED
  // worktree it is the PARENT repo's `.git`, not the worktree's own
  // `.git/worktrees/<name>` gitdir. That asymmetry is exactly the signal we
  // need — it is what tells example-app-g1 and example-app apart from two
  // independent clones that merely share a name.
  //
  // Shape is deliberately the SAME spawnSync shape resolveGitDir() already
  // uses (:~430) rather than a new subprocess helper — same binary, same
  // encoding, same -C form, so there is one subprocess idiom in this file.
  //
  // Returns an absolute path, or null. Null on: non-zero exit (not a repo,
  // permission failure, a git too old for --path-format), empty stdout, or a
  // common-dir whose basename is not ".git" (bare repos, `--separate-git-dir`
  // layouts, anything we have not reasoned about). Null means "cannot tell",
  // and the caller degrades to today's per-path behaviour — see
  // _canonicalRepoIdentity. NEVER throws.
  //
  // Memoized per poll: a 15-surface worktree group costs 15 cheap rev-parses
  // per poll, not one per commit. pollOnce resets the memo so a worktree
  // added or removed between polls is re-resolved rather than cached forever.
  _gitCommonDir(repoPath) {
    if (!this._commonDirMemo) this._commonDirMemo = new Map();
    if (this._commonDirMemo.has(repoPath)) return this._commonDirMemo.get(repoPath);

    let result = null;
    try {
      const res = spawnSync(
        "git",
        ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { encoding: "utf8" },
      );
      if (!res.error && res.status === 0) {
        const out = (res.stdout || "").toString().trim();
        // basename check: we only understand the ordinary "<repo>/.git" layout.
        // A bare repo answers "<repo>.git" and a --separate-git-dir answers
        // somewhere else entirely; for both, dirname() would name a directory
        // that is NOT the repo, so we decline to guess.
        // MULTI-LINE STDOUT IS A REFUSAL, and this guard is load-bearing rather
        // than defensive. `git rev-parse` on a version that does not know
        // --path-format (pre-2.31) ECHOES the unrecognized option to stdout and
        // still EXITS 0, so a linked worktree answers with two lines:
        //
        //     --path-format=absolute
        //     <HOME>/Documents/example-app/.git
        //
        // basename() splits on "/", so the last segment of that whole string is
        // ".git" and the check below PASSES — after which dirname() yields the
        // newline-bearing garbage "--path-format=absolute\n/.../example-app",
        // which would be written as repo_path into an APPEND-ONLY ledger and
        // could not be taken back. The main worktree degrades correctly on such
        // a git (its relative ".git" is rejected) while its linked worktrees
        // would silently adopt the garbage, so the fix would do nothing AND
        // corrupt the record. Verified by construction on node's own path
        // module; latent on this machine at git 2.45.2.
        if (out !== "" && !out.includes("\n") && basename(out) === ".git") result = out;
      }
    } catch {
      result = null; // DEGRADE, NEVER CRASH.
    }
    this._commonDirMemo.set(repoPath, result);
    return result;
  }

  // _canonicalRepoIdentity — the string that IS the repo, for keying purposes.
  //
  //   resolvable  -> dirname(<common-dir>)  i.e. the MAIN worktree directory.
  //                  Every linked worktree of one repo returns the same value.
  //   unresolvable-> repoPath itself, i.e. EXACTLY today's behaviour.
  //
  // The fallback is the point, not padding. An old git, a bare repo, a
  // permission failure or a vanished directory must degrade to per-path
  // identity — which over-counts, the failure mode we already survive — rather
  // than throw, drop the repo, or (worst) collapse two unrelated repos onto
  // one key and LOSE commits. Verified on the live machine (git 2.45.2):
  // example-app-g1 and example-app both resolve to <HOME>/Documents/example-app,
  // memory-system resolves to itself, and the three deleted ea-wt-* paths
  // resolve to themselves without raising.
  //
  // Note the resolution is independent of whether the main worktree happens to
  // be under repoRoots at all: the answer comes from git's own metadata, so a
  // group of worktrees whose parent lives outside the walked roots still
  // collapses to one identity.
  _canonicalRepoIdentity(repoPath) {
    const commonDir = this._gitCommonDir(repoPath);
    if (typeof commonDir !== "string" || commonDir === "") return repoPath;
    const identity = dirname(commonDir);
    // Re-check the newline here as well as in _gitCommonDir. Not redundancy for
    // its own sake: THIS is the value that becomes repo_path in an append-only
    // ledger, so the seat that writes refuses the malformed value regardless of
    // which caller or memo supplied it. See the pre-2.31 echo case above.
    if (typeof identity !== "string" || identity === "" || identity.includes("\n")) {
      return repoPath;
    }
    return identity;
  }

  // ---------------------------------------------------------------------------
  // Repo discovery
  // ---------------------------------------------------------------------------

  // discoverRepos: returns absolute paths of every directory containing a
  // `.git` entry under each repoRoot, walked to walkDepth. NEVER follows
  // symlinks (lstatSync guard) — prevents cycles + ballooning walks.
  //
  // A `.git` entry may be:
  //   - a directory (normal repo)
  //   - a file (git worktree linked back to a parent — also a valid repo
  //     surface for `git log` since the linked worktree exposes the parent
  //     repo's history)
  //
  // Both are accepted because `git log` succeeds in either layout.
  //
  // e12: discovery is UNCHANGED by the identity collapse and must stay that
  // way — every surface is still returned and still walked. See the note on
  // `--reflog` in _gitLogForRepo for why removing worktrees here would lose
  // commits. What changed is only what we HASH (_canonicalRepoIdentity).
  discoverRepos() {
    const found = new Set();
    for (const root of this.repoRoots) {
      this._walk(root, 0, found);
    }
    return [...found].sort();
  }

  _walk(dir, depth, found) {
    if (depth > this.walkDepth) return;
    if (!existsSync(dir)) return;
    // Skip symlinks to avoid cycles + walk-ballooning.
    let st;
    try { st = lstatSync(dir); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (!st.isDirectory()) return;

    // Cheap probe: a directory with .git either as dir or file is a repo.
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      found.add(dir);
      // Once we've identified a repo, do not descend into it. Nested
      // repos (e.g. submodules) are common and we explicitly do NOT walk
      // into them — `git log` on the outer repo does not see submodule
      // commits, and walking submodules would emit duplicate work in
      // recursive layouts. Submodule support is out of scope for v0.
      return;
    }

    if (depth === this.walkDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      // Skip dot-dirs (node_modules, .npm, .cache, etc.) — they don't host
      // operator repos and they're costly to traverse.
      if (ent.name.startsWith(".") && ent.name !== ".") continue;
      // Skip common high-cost / repo-irrelevant subtrees by name.
      if (ent.name === "node_modules" || ent.name === "Library") continue;
      this._walk(join(dir, ent.name), depth + 1, found);
    }
  }

  // ---------------------------------------------------------------------------
  // git log per-repo
  // ---------------------------------------------------------------------------

  // _gitLogForRepo: returns array of parsed commits in chronological order
  // (oldest first — git log's default is reverse-chrono, we reverse so
  // appendLedgerRow processes from oldest to newest, which matches the
  // ledger's append-only semantics and lets the per-repo cursor advance
  // monotonically).
  //
  // For first run (no cursor entry) AND no prior dedup history, bounded to
  // logMaxCommitsFirstRun commits.
  //
  // F-T2-GIT_LOG-F4 (restart-recovery): when lastSeenSha is unknown but the
  // dedup Set is non-empty (i.e. the on-disk ledger has prior rows for
  // some repo, which strongly suggests "this is NOT a true first run, the
  // cursor was lost"), DO NOT do a bounded first-run reset. Instead, walk
  // FULL history and rely on the source_msg_id dedup Set built by
  // _buildDedupSet() to discard already-seen commits in O(1) per check.
  // This avoids the dup-reemission failure mode where a lost cursor + a
  // bounded first-run reset re-emitted every commit within the bound.
  //
  // The repoHasPriorHistory hint lets the caller (pollOnce) pass an
  // explicit signal — when the dedup Set contains ANY entry whose key
  // matches `git:<repoPathHash>:*`, we know the ledger has prior rows for
  // this repo and we can safely walk the full history because the dedup
  // Set will reject duplicates.
  //
  // D1 gitlog-ref-tip-cursor — TIP FRONTIER (the steady-state mode). When
  // `Array.isArray(opts.excludeTips)` (an EMPTY array counts: it is the valid
  // persisted state of a zero-commit repo), the walk negates every persisted
  // start point instead of a single range: `--ignore-missing --stdin` is
  // appended to argv and one `^<sha>` line per tip goes through spawnSync
  // `input`, NEVER argv (a repo has up to 2,730 refs). `--ignore-missing`
  // absorbs tips that reflog expiry pruned between polls; it MUST precede
  // `--stdin` (probed on git 2.55.0: that order exits 0, the reverse dies
  // with `fatal: bad object`). No `-n` and no `<sha>..HEAD` in this mode. A
  // non-zero exit with tips falls back exactly once to the legacy
  // lastSeenSha / restart-recovery branches below, whose dedup Set absorbs
  // the re-walk — so the F-T2-GIT_LOG-F4 semantics survive on the failure
  // path only and the quiet path never touches the Set.
  //
  // LEGACY (callers passing no excludeTips — the one-time migration of a
  // surface that has a per_repo_cursors sha but no tip entry, and the
  // instance seams the cursor-stamp tests inject): with lastSeenSha set the
  // walk queries `<last_sha>..HEAD`, which under `--all --reflog` excludes
  // one lineage only and is why the tip frontier exists.
  _gitLogForRepo(repoPath, lastSeenSha, opts = {}) {
    const repoHasPriorHistory = opts.repoHasPriorHistory === true;
    const tips = Array.isArray(opts.excludeTips) ? opts.excludeTips : null;
    // D3: optional out-param. `opts.walkInfo` (a plain object owned by the
    // caller) receives `mode` = "tips" | "range" | "full" |
    // "bounded_first_run". The SAME object is threaded through both recursive
    // fallbacks below, so the mode reported is the branch that TERMINATED
    // the walk, not the one first attempted — pollOnce keys the tip-
    // persistence deferral on it, and only "bounded_first_run" is bounded.
    const walkInfo = opts.walkInfo && typeof opts.walkInfo === "object" ? opts.walkInfo : null;
    const args = [
      "-C", repoPath,
      "log",
      `--pretty=format:${GIT_LOG_FORMAT}`,
      "--all",
      // e12 — DO NOT "OPTIMISE" THIS BY WALKING ONLY THE MAIN WORKTREE.
      // Now that every worktree of a repo shares ONE source_msg_id identity,
      // walking all 15 surfaces of a group looks redundant. It is not.
      // refs/heads IS shared across worktrees, so `--all` from the main
      // worktree already covers every branch — but the REFLOG is PER-WORKTREE
      // (.git/worktrees/<name>/logs/HEAD), so a commit that exists only in a
      // linked worktree's reflog (amended away, reset past, detached-HEAD
      // experiment) is reachable from that surface and NOWHERE ELSE. That is
      // the precise class `--reflog` was added to catch. Dropping secondary
      // surfaces from discovery would silently shrink the set of distinct
      // commit_hash values we emit. Collapsing IDENTITY is lossless;
      // collapsing DISCOVERY is not. The redundant walks are absorbed for
      // free by the dedup Set — an O(1) miss per already-seen commit.
      "--reflog",
      // F-META-GIT-LOG-NUMSTAT: emit per-file (added\tdeleted\tpath) lines
      // after each commit's metadata line. Marginal extra cost per commit
      // (git already has the diffstat in its object graph). The data is
      // load-bearing for GIT_LOG-F7 (boilerplate-subject discrimination)
      // and GIT_LOG-F8 (version-bump rule) — both deferred precisely
      // because the connector lacked file-change context.
      "--numstat",
    ];
    let input;
    if (tips !== null) {
      // Tip frontier: negate every persisted start point via stdin. Empty
      // tips → empty stdin, which exits 0 and walks the whole (zero-commit)
      // repo — probed. Order is load-bearing: --ignore-missing BEFORE --stdin.
      args.push("--ignore-missing", "--stdin");
      input = tips.map((t) => "^" + t).join("\n") + (tips.length ? "\n" : "");
      if (walkInfo) walkInfo.mode = "tips";
    } else if (lastSeenSha) {
      // Bounded incremental tail. Note: if lastSeenSha is no longer in the
      // repo (rebased away, branch-pruned, etc.), git will error; we catch
      // and treat as restart-recovery fallback below.
      args.push(`${lastSeenSha}..HEAD`);
      if (walkInfo) walkInfo.mode = "range";
    } else if (repoHasPriorHistory) {
      // F-T2-GIT_LOG-F4: restart-recovery path. The cursor is missing but
      // the dedup Set has prior rows for this repo, so this is NOT a true
      // first run. Walk FULL history; the dedup Set will absorb the
      // already-seen commits in O(1) each.
      // No -n cap.
      if (walkInfo) walkInfo.mode = "full";
    } else {
      // True first run: bound the history walk so a giant repo does not
      // dominate the initial poll. The ONLY bounded branch: pollOnce defers
      // tip persistence when this listing fills the bound (D3).
      args.push("-n", String(this.logMaxCommitsFirstRun));
      if (walkInfo) walkInfo.mode = "bounded_first_run";
    }

    const res = spawnSync("git", args, {
      encoding: "utf8",
      // D5: ctor seam, default GIT_LOG_MAX_BUFFER_BYTES (64 MB) — guards
      // against a single mega-repo; ENOBUFS above it is handled below.
      maxBuffer: this.logMaxBufferBytes,
      ...(input !== undefined ? { input } : {}),
    });

    if (res.status !== 0) {
      // D5: the listing exceeded maxBuffer. Node kills git (SIGTERM, status
      // null, error.code ENOBUFS) and keeps the partial stdout, which is NOT
      // a usable walk. Say so on stderr and mark walkInfo so pollOnce counts
      // it. The pre-D5 shape was silent: tips [] + no cursor threw the
      // uninformative `exit null` on every poll forever (errors=1, tips []);
      // tips [] + a legacy cursor fell through to the one-lineage range walk
      // with errors=0, no stderr, and persisted real tips — the exact silent
      // narrowing D3 fixed, reintroduced by a buffer limit.
      //
      // Decision: when the overflowing walk negated NOTHING (the D3-deferred
      // first-run walk: tips === [] and no legacy cursor) return [] at once
      // with the marker. The `full` fallback is the identical listing minus
      // `--stdin`, so recursing would only ENOBUFS again at the same cost.
      // With non-empty tips or a legacy cursor the existing fallbacks below
      // run unchanged: the range/full retry is a DIFFERENT listing and may
      // fit, and if it does not, the no-fallback throw below names ENOBUFS.
      // pollOnce persists the PRE-WALK frontier for a marked surface — never
      // `[]` — see the D3 tip-persistence comment there for why.
      if (res.error && res.error.code === "ENOBUFS") {
        const mode = walkInfo && walkInfo.mode ? walkInfo.mode : "unknown";
        const partial = (res.stdout || "").toString().length;
        const negatedNothing = tips !== null && tips.length === 0 && !lastSeenSha;
        try {
          // eslint-disable-next-line no-console
          console.error(
            `[git-log] ENOBUFS in ${repoPath} (mode=${mode}, maxBuffer=${this.logMaxBufferBytes}, ` +
            `partial_stdout=${partial}) — listing exceeded the buffer; ` +
            (negatedNothing
              ? "returning [] and persisting the pre-walk frontier (errors+1); " +
                "page the deferred walk or raise logMaxBufferBytes for this surface"
              : "falling back to the legacy cursor/recovery walk (errors+1)"),
          );
        } catch { /* never let logging fail */ }
        if (walkInfo) walkInfo.enobufs = { mode, bytes: this.logMaxBufferBytes };
        if (negatedNothing) return [];
      }
      // D1: the tip-frontier walk failed. Fall back EXACTLY ONCE to the
      // legacy cursor / restart-recovery branches with excludeTips removed.
      // The dedup Set is consulted (built lazily) only here, on the failure
      // path — the caller skipped _repoHasPriorHistory for the quiet path.
      if (tips !== null) {
        return this._gitLogForRepo(repoPath, lastSeenSha, {
          repoHasPriorHistory:
            opts.repoHasPriorHistory === true || this._repoHasPriorHistory(repoPath),
          ...(walkInfo ? { walkInfo } : {}),
        });
      }
      // F-T2-GIT_LOG-F4: incremental query failed (lastSeenSha pruned or
      // ref-not-found). Retry WITHOUT the lastSeenSha but pass through the
      // repoHasPriorHistory hint so we walk full history if the dedup Set
      // already covers this repo. This prevents the previous "full first-
      // run reset" failure mode that would re-emit logMaxCommitsFirstRun
      // commits on every restart.
      // D3: the hint is DERIVED here, exactly as the tips fallback above
      // does, because pollOnce passes `false` for any surface that has a
      // cursor (the quiet path must never build the dedup Set). This is a
      // FAILURE path only — the legacy one-time migration of a surface whose
      // cursor sha was pruned — so the Set is consulted lazily here and never
      // on a walk that succeeded. `...opts` keeps `walkInfo` threaded.
      if (lastSeenSha) {
        return this._gitLogForRepo(repoPath, null, {
          ...opts,
          repoHasPriorHistory:
            opts.repoHasPriorHistory === true || this._repoHasPriorHistory(repoPath),
        });
      }
      // Genuine git failure — propagate via tagError so health surfaces it.
      const stderr = (res.stderr || "").toString().trim();
      // D5: an ENOBUFS that had no different fallback to try (first run, or
      // the full recovery walk) is named as such — `exit null` said nothing.
      const enobufs = Boolean(res.error && res.error.code === "ENOBUFS");
      const err = new Error(
        enobufs
          ? `git log failed in ${repoPath}: ENOBUFS — listing exceeded maxBuffer=${this.logMaxBufferBytes} ` +
            `bytes (partial_stdout=${(res.stdout || "").toString().length})`
          : `git log failed in ${repoPath}: ${stderr || "exit " + res.status}`,
      );
      err.code = enobufs ? "GIT_LOG_ENOBUFS" : "GIT_LOG_FAILED";
      throw err;
    }

    const raw = (res.stdout || "").toString();
    // D5: the RAW record count of the terminating walk, for pollOnce's
    // first-run bound test. GIT_LOG_FORMAT emits exactly one RECORD_TERMINATOR
    // (`§§§`) per commit, so this counts what git LISTED, not what the parser
    // kept: _parseMetadataLine drops a record whose metadata line splits into
    // < 6 fields, and the metaIdx backward search can misfile a >=5-pipe body
    // line, so the parsed length can read "below the cap" for a listing that
    // filled it. A body containing the terminator over-counts, which only
    // biases toward deferral (one extra unbounded walk), never toward
    // persisting a narrowed frontier. Same walkInfo object through both
    // recursive fallbacks, so it describes the walk that terminated.
    if (walkInfo) walkInfo.rawCount = raw === "" ? 0 : raw.split(RECORD_TERMINATOR).length - 1;
    if (raw === "") return [];
    return this._parseGitLogOutput(raw);
  }

  // _repoWalkTips — D1: every WALK START POINT of `git log --all --reflog`
  // for one discovered surface: all refs plus every reflog entry, as
  // `git rev-list --no-walk=unsorted --all --reflog` reports them. Returned
  // sorted and unique so two captures of an unchanged repo are byte-identical
  // under JSON.stringify (noteRepoTips compares stable JSON). Never throws:
  // a non-zero exit (broken checkout, git missing) yields [] — persisting []
  // for such a surface would negate nothing, so the next walk is a full one
  // and the dedup Set absorbs it; losing bytes here costs work, never rows.
  // Both git object formats are walk start points: SHA-1 (40 hex) and
  // SHA-256 (64 hex, `git init --object-format=sha256`). D3: the original
  // 40-only filter dropped every line of a SHA-256 repo, so it persisted `[]`
  // and was walked unbounded on EVERY poll (probed 3/3 on a 3-commit fixture).
  _repoWalkTips(repoPath) {
    const res = spawnSync(
      "git",
      ["-C", repoPath, "rev-list", "--no-walk=unsorted", "--all", "--reflog"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (res.status !== 0) return [];
    const out = new Set();
    for (const line of (res.stdout || "").toString().split("\n")) {
      if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line)) out.add(line);
    }
    return [...out].sort();
  }

  // _parseGitLogOutput: parse `git log --pretty=format:GIT_LOG_FORMAT
  // --numstat` output. Each commit produces:
  //   <H>|<aI>|<an>|<ae>|<s>|<P>§§§
  //   <added>\t<deleted>\t<path>
  //   <added>\t<deleted>\t<path>
  //   ...
  //   (blank line separator before next commit)
  //
  // F-META-GIT-LOG-NUMSTAT: file_changes is a structured array of
  // {path, additions, deletions, binary} entries. Binary files surface
  // as "-\t-\t<path>" in git's output; we record additions/deletions as
  // null and binary=true. Renames surface as "<a>\t<d>\t<old> => <new>"
  // (with braces in some cases like "{a => b}/c"); we keep the raw path
  // string for simplicity — downstream rules use it for boilerplate /
  // lockfile path matching, not for graph-rewriting.
  _parseGitLogOutput(raw) {
    const commits = [];
    if (typeof raw !== "string" || raw === "") return commits;

    // Split on the RECORD_TERMINATOR so each chunk holds one commit's
    // metadata + its trailing numstat block. The first chunk's metadata
    // starts at offset 0; subsequent chunks start after a newline that
    // separated them from the previous commit's numstat block.
    const chunks = raw.split(RECORD_TERMINATOR);
    // Drop the trailing empty chunk if git's output ended with a sentinel
    // followed by nothing (or just a final newline + numstat which our
    // split correctly handles).
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk === "" || chunk == null) continue;

      // The chunk starts with the metadata line. For chunks beyond the
      // first, the leading content may be the PRECEDING commit's numstat
      // block followed by a blank line, then the next metadata. The first
      // chunk is just the first metadata line. Logic: trim leading
      // whitespace/newlines, then take the first line as metadata; the
      // remainder is the numstat block.
      //
      // To handle the chunk-boundary case correctly: a chunk like
      //   "<metadata>\n<numstat-line>\n<numstat-line>\n\n"
      // means "this commit's metadata is the first line; the numstat
      // lines below belong to this commit; the trailing blank separates
      // it from the next chunk (which starts the next metadata)".
      //
      // After the first chunk, however, the split on the sentinel placed
      // the BEGINNING of each chunk in the numstat region. Reconstruct:
      // for chunks[1..], the first metadata line is at the START of the
      // chunk only if the preceding chunk had its sentinel at the END of
      // the metadata line. That IS the case because GIT_LOG_FORMAT ends
      // with the sentinel. So:
      //   chunks[0] = "<meta-1>"
      //   chunks[1] = "\n<numstat-1>\n<numstat-1>\n\n<meta-2>"
      //   chunks[2] = "\n<numstat-2>\n...\n\n<meta-3>"
      //   ...
      //
      // Strategy: for chunks > 0, split on "\n" and identify the LAST
      // non-empty trailing line that LOOKS LIKE a metadata line (contains
      // pipes at the expected positions). Everything before is numstat
      // for the PREVIOUS commit; the trailing metadata-like line is the
      // current commit's metadata. For chunk 0, the entire chunk IS the
      // first commit's metadata (no preceding numstat).
      //
      // Simpler: collect (numstatBlock, metadata) pairs by walking
      // chunks in order. chunks[0] yields just metadata-0 (no preceding
      // numstat). chunks[i>0] yields numstat-(i-1) + metadata-i.
      //
      // Build commits array as we go: when we see metadata for commit N,
      // create the commit entry but defer setting file_changes until we
      // see numstat-N (in the next chunk).
      const isFirstChunk = i === 0;
      const lines = chunk.split("\n");

      // F-NEW-W7-GIT-LOG-BODY-CAPTURE: each chunk now contains a metadata
      // line followed by a body block delimited by BODY_DELIMITER ("¶¶¶")
      // on either side, e.g.:
      //   <meta>
      //   ¶¶¶
      //   <body-line-1>
      //   <body-line-2>
      //   ¶¶¶
      // For chunks > 0, this body block is preceded by the previous
      // commit's numstat lines and a blank-line separator. The find-metadata
      // helper locates the metadata line index AND the body bounded by the
      // surrounding BODY_DELIMITER pair within the same chunk.
      if (isFirstChunk) {
        // Chunk 0 layout: <meta>\n¶¶¶\n<body>\n¶¶¶
        const meta = this._parseMetadataLine(lines[0]);
        if (meta) {
          const extracted = this._extractBodyFromLines(lines, 1);
          meta.body = extracted.body;
          meta.body_truncated = extracted.body_truncated;
          commits.push(meta);
        }
        continue;
      }

      // Chunks > 0: walk from the end of the chunk backwards. The LAST
      // non-empty line is `¶¶¶` (body close). Search backwards for the
      // metadata line (≥5 pipes); body is between the metadata line and
      // the closing `¶¶¶`. Everything BEFORE the metadata line is the
      // previous commit's numstat block + blank separator.
      let metaIdx = -1;
      for (let j = lines.length - 1; j >= 0; j--) {
        const ln = lines[j];
        if (ln === "") continue;
        const sepCount = (ln.match(/\|/g) || []).length;
        if (sepCount >= 5) {
          metaIdx = j;
          break;
        }
      }

      const numstatEnd = metaIdx >= 0 ? metaIdx : lines.length;
      const prevFileChanges = [];
      let prevTruncated = false;
      for (let j = 0; j < numstatEnd; j++) {
        const ln = lines[j];
        if (ln === "") continue;
        if (prevFileChanges.length >= MAX_FILE_CHANGES) {
          prevTruncated = true;
          break;
        }
        const fc = this._parseNumstatLine(ln);
        if (fc) prevFileChanges.push(fc);
      }
      if (commits.length > 0) {
        const prev = commits[commits.length - 1];
        prev.file_changes = prevFileChanges;
        prev.file_changes_truncated = prevTruncated;
      }

      if (metaIdx >= 0) {
        const meta = this._parseMetadataLine(lines[metaIdx]);
        if (meta) {
          const extracted = this._extractBodyFromLines(lines, metaIdx + 1);
          meta.body = extracted.body;
          meta.body_truncated = extracted.body_truncated;
          commits.push(meta);
        }
      }
    }

    // Final commit may not have had file_changes assigned (no successor
    // chunk to carry its numstat). Default to an empty array. In practice
    // git's output always ends with a numstat block followed by a sentinel
    // and we did NOT attach that block because there's no chunk[i+1] to
    // process it. We make a second pass: if the LAST chunk had numstat
    // after the last sentinel, assign it to the last commit here.
    //
    // The simpler correct behavior: the split on RECORD_TERMINATOR
    // produces chunks where chunks[i] for i>0 hold numstat-(i-1) before
    // the next metadata. chunks[lastIndex] holds numstat for the LAST
    // commit AFTER its trailing metadata IF the input ended with a final
    // sentinel and trailing numstat. With our git invocation,
    // `--pretty=format:...§§§ --numstat` produces:
    //   "<meta-1>§§§\n<numstat-1>\n\n<meta-2>§§§\n<numstat-2>\n\n..."
    // so split on "§§§" yields:
    //   chunks[0] = "<meta-1>"
    //   chunks[1] = "\n<numstat-1>\n\n<meta-2>"
    //   chunks[2] = "\n<numstat-2>\n\n<meta-3>"
    //   ...
    //   chunks[N] = "\n<numstat-N>\n" (trailing)
    // We already handled chunks[N] in the loop above (metaIdx === -1),
    // so the last commit's file_changes were assigned in that pass.
    // Ensure each commit has file_changes default-set.
    for (const c of commits) {
      if (!Array.isArray(c.file_changes)) {
        c.file_changes = [];
        c.file_changes_truncated = false;
      }
      if (typeof c.body !== "string") {
        c.body = "";
        c.body_truncated = false;
      }
    }

    // Reverse so we process oldest-first (git log is reverse-chrono by
    // default).
    commits.reverse();
    return commits;
  }

  // _parseMetadataLine: parse a single "<H>|<aI>|<an>|<ae>|<s>|<P>" line.
  // Returns the commit object (without file_changes — that is filled by
  // the numstat block) or null on malformed input.
  _parseMetadataLine(line) {
    if (typeof line !== "string" || line === "") return null;
    const parts = line.split(FIELD_SEP);
    if (parts.length < 6) return null;
    const hash = parts[0];
    const authorIsoTs = parts[1];
    const authorName = parts[2];
    const authorEmail = parts[3];
    const parents = parts[parts.length - 1];
    const subject = parts.slice(4, parts.length - 1).join(FIELD_SEP);
    return {
      hash,
      author_ts: authorIsoTs,
      author_name: authorName,
      author_email: authorEmail,
      subject,
      parents: parents === "" ? [] : parents.split(" ").filter(Boolean),
      // file_changes filled in by the caller as the numstat block is
      // parsed for the following chunk.
      file_changes: undefined,
      file_changes_truncated: undefined,
      // F-NEW-W7-GIT-LOG-BODY-CAPTURE: body filled in by the caller via
      // _extractBodyFromLines() once the chunk's body block is located.
      body: undefined,
      body_truncated: undefined,
    };
  }

  // F-NEW-W7-GIT-LOG-BODY-CAPTURE: extract the %B body block from a chunk
  // starting at `startIdx`. The body is bounded by BODY_DELIMITER ("¶¶¶")
  // on both sides; the opening delimiter is at lines[startIdx] (or the
  // first non-empty line at/after startIdx), and the closing delimiter
  // is the LAST line containing BODY_DELIMITER. Returns the trimmed body
  // string (capped at BODY_MAX_BYTES). The metadata object's body and
  // body_truncated fields are set by the caller from the return value.
  //
  // The capped length is measured in BYTES (Buffer.byteLength) because the
  // 8 KB budget is a row-size guard and JS string .length undercounts
  // multibyte UTF-8 sequences.
  _extractBodyFromLines(lines, startIdx) {
    // Find opening delimiter: scan forward from startIdx for the first
    // line that equals BODY_DELIMITER.
    let openIdx = -1;
    for (let i = startIdx; i < lines.length; i++) {
      if (lines[i] === BODY_DELIMITER) {
        openIdx = i;
        break;
      }
    }
    if (openIdx === -1) {
      return { body: "", body_truncated: false };
    }
    // Find closing delimiter: scan forward from openIdx+1 for next line
    // equal to BODY_DELIMITER. (Body lines should never themselves be a
    // bare "¶¶¶" — extremely improbable in real commit messages.)
    let closeIdx = -1;
    for (let i = openIdx + 1; i < lines.length; i++) {
      if (lines[i] === BODY_DELIMITER) {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx === -1) {
      // No close — chunk truncated. Take everything from openIdx+1 to end.
      closeIdx = lines.length;
    }
    const rawBody = lines.slice(openIdx + 1, closeIdx).join("\n");
    // Strip trailing whitespace (git frequently emits a trailing newline
    // from %B). Leading whitespace is preserved — operators sometimes use
    // indented bullet lists in commit bodies and those carry meaning.
    const trimmed = rawBody.replace(/\s+$/g, "");
    // Cap at BODY_MAX_BYTES. We measure in UTF-8 bytes; if the cap fires
    // we slice on a character boundary by repeatedly trimming the last
    // character until under cap (cheap because the overshoot is bounded
    // by the largest single codepoint, 4 bytes).
    if (Buffer.byteLength(trimmed, "utf8") <= BODY_MAX_BYTES) {
      return { body: trimmed, body_truncated: false };
    }
    let truncated = trimmed.slice(0, BODY_MAX_BYTES);
    while (Buffer.byteLength(truncated, "utf8") > BODY_MAX_BYTES) {
      truncated = truncated.slice(0, -1);
    }
    return { body: truncated, body_truncated: true };
  }

  // _parseNumstatLine: parse "<added>\t<deleted>\t<path>" (or "-\t-\t<path>"
  // for binary). Returns {path, additions, deletions, binary} or null on
  // malformed input. Renames ("old => new" / "{a => b}/c") flow through
  // as raw path strings — downstream rules use them for boilerplate /
  // lockfile path matching, not for graph rewriting.
  _parseNumstatLine(line) {
    if (typeof line !== "string" || line === "") return null;
    // git separates fields with literal tabs. Defensive split on \t.
    const parts = line.split("\t");
    if (parts.length < 3) return null;
    const addStr = parts[0];
    const delStr = parts[1];
    // Path may contain tabs in pathological cases; rejoin defensively.
    const path = parts.slice(2).join("\t");
    if (path === "") return null;
    const binary = addStr === "-" && delStr === "-";
    if (binary) {
      return { path, additions: null, deletions: null, binary: true };
    }
    const additions = parseInt(addStr, 10);
    const deletions = parseInt(delStr, 10);
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) return null;
    return { path, additions, deletions, binary: false };
  }

  // ---------------------------------------------------------------------------
  // pollOnce — the main per-tick entry point
  // ---------------------------------------------------------------------------

  // pollOnce: discover repos, fetch new commits per repo, append ledger rows,
  // advance per-repo cursor. Returns {appended, errors, repos}.
  //
  // Idempotent: re-running with no new commits returns {appended: 0, errors: 0}.
  // The base class's source_msg_id dedup is the secondary defense — even if
  // the per-repo cursor is wrong (e.g. operator manually deleted it), the
  // commit SHA dedup at appendLedgerRow ensures we don't double-append.
  //
  // Returns:
  //   {appended: int, errors: int, repos: int}
  async pollOnce() {
    // e12: fresh identity memo per poll — see the field's note in the
    // constructor. Reset FIRST, before discovery, so a worktree removed since
    // the last poll cannot be answered from a stale cache.
    this._commonDirMemo = new Map();
    const repos = this.discoverRepos();
    const state = (await this.readCursor()) || {};
    const perRepoCursors = (state.per_repo_cursors && typeof state.per_repo_cursors === "object")
      ? { ...state.per_repo_cursors }
      : {};
    // D1: the tip frontier, merged in from state.heavy.json by readCursor.
    // Keyed by DISCOVERED SURFACE exactly like per_repo_cursors (see the e12
    // note at noteRepoCursor). Absent key = never walked under the tip
    // frontier (legacy migration or true first run); present key, even [],
    // = negate exactly that set.
    const perRepoTips = (state.per_repo_ref_tips
      && typeof state.per_repo_ref_tips === "object"
      && !Array.isArray(state.per_repo_ref_tips))
      ? { ...state.per_repo_ref_tips }
      : {};

    let appendedCount = 0;
    let errorCount = 0;
    // D1: every commit _gitLogForRepo returned this poll, appended or not.
    // A quiet poll must report 0 here — that is the whole point of the fix.
    let walkedCount = 0;
    // c3-cursor-stamp-class: did any per-repo cursor actually MOVE this poll?
    //
    // perRepoCursors is mutated at THREE sites, every one of them DURABLE —
    // each is persisted as `per_repo_cursors` at :2072 — so every one of
    // them is real cursor progress:
    //   :1800  tick-dedup skip-past (F-NEW-W7-GIT-LOG-COMMIT-HASH-DEDUP):
    //           the "already quarantined this exact hash this tick" branch;
    //   :1848  quarantine advance: the initial-commit-variant branch, which
    //           is the ONLY thing that moves the cursor for a repo that never
    //           appends a row;
    //   :2026  append / dedup: the normal path.
    // All three route through noteRepoCursor (declared at :1669); its single
    // raw assignment at :1674 is the only place the map is written. An
    // earlier pass of this fix gated the append/dedup site ALONE, leaving the
    // other two to move the durable cursor under a stale stamp — routing every
    // site through one helper is what makes the flag impossible to forget.
    //
    // The flag gates ONLY the last_cursor_advance_ts stamp at :2076. The
    // cursor WRITE stays unconditional: writeCursor still persists
    // per_repo_cursors and last_polled_ts on every poll, so
    // listInstalledConnectors (index.js:673-674) keeps enumerating this source.
    let cursorAdvanced = false;
    // noteRepoCursor — the ONE place perRepoCursors is mutated. Every durable
    // cursor write routes through this helper so the change-detection can never
    // be forgotten at a newly added site (that omission is exactly what shipped
    // in the first pass of this fix: two of three sites mutated the map without
    // touching the flag).
    //
    // A cursor advance is a VALUE CHANGE, not an assignment. Re-assigning the
    // hash already stored — a re-walk that replays a commit we have seen — is
    // not progress and must not refresh the staleness sensor.
    //
    // The prior value is read with a proto-safe own-property check: a bare
    // `perRepoCursors[rp]` returns Function.prototype.toString for a repo
    // literally named "toString" and would score a spurious advance. Commit
    // b97565c closed two prototype-key defects in this tree for the same reason.
    // e12 — `rp` IS THE DISCOVERED SURFACE, NOT THE CANONICAL IDENTITY, and
    // that asymmetry against source_msg_id is deliberate. per_repo_cursors is
    // a WALK FRONTIER, not an identity: each linked worktree has its own HEAD
    // and its own reflog, so two surfaces of one repo are at genuinely
    // different points in the history. Collapsing them onto one key would let
    // whichever surface polled last stall or rewind the others' walk. The
    // existing "advance whether appended or DEDUPED" rule at the append site
    // is what makes this safe post-fix: a worktree whose commits now all hit
    // the dedup Set still advances its own cursor every poll.
    //
    // Stale entries for VANISHED worktrees (ea-wt-dip, ea-wt-N2 — already gone
    // from disk) are deliberately NOT pruned. They cost a few bytes of JSON;
    // pruning them risks a full re-walk if the path ever returns.
    const noteRepoCursor = (rp, hash) => {
      const prior = Object.prototype.hasOwnProperty.call(perRepoCursors, rp)
        ? perRepoCursors[rp]
        : undefined;
      if (prior !== hash) cursorAdvanced = true;
      perRepoCursors[rp] = hash;
    };
    // noteRepoTips — D1: the ONE place perRepoTips is mutated, for the same
    // reason noteRepoCursor is the one place perRepoCursors is. A tip-set
    // change is a VALUE change under stable JSON: re-storing the identical
    // sorted list (a quiet poll) is not progress; a first `[]` for a surface
    // with no prior entry IS (the frontier moved from "unknown" to "known
    // empty"). Proto-safe read for the same reason as noteRepoCursor.
    // D3 deferral rule: tips are persisted only after an UNBOUNDED walk. The
    // call site passes the pre-walk snapshot after a tips/range/full walk and
    // `[]` after a bounded first run that filled the bound, so poll 2 walks
    // every lineage once (dedup absorbs) and only then stores real tips.
    const noteRepoTips = (rp, tips) => {
      const prior = Object.prototype.hasOwnProperty.call(perRepoTips, rp)
        ? perRepoTips[rp]
        : undefined;
      if (JSON.stringify(prior) !== JSON.stringify(tips)) cursorAdvanced = true;
      perRepoTips[rp] = tips;
    };
    let lastAppendedTs = state.last_appended_ts || null;
    let lastAppendedId = state.last_appended_id || null;

    // F-NEW-W7-GIT-LOG-COMMIT-HASH-DEDUP: tick-scoped quarantine dedup. The
    // audit found that initial-commit / quarantine events for the SAME
    // commit (same source_msg_id, hashed `git:<repo>:<sha>`) were being
    // appended to the quarantine daily file 4–7 times per commit across
    // 2 days because quarantineRow has no dedup, and the connector can
    // re-walk the same commit when classify cache invalidates or when
    // the dedup Set falls back to tail mode. Without per-tick dedup the
    // quarantine inventory inflates 4–7×, slowing restoreFromQuarantine
    // scans and confusing operator audits.
    //
    // Strategy: maintain a tick-local Set keyed by source_msg_id. Before
    // quarantineRow is called for git-log, check the Set; if present,
    // skip the call (and skip the per-reason recordDrop counter —
    // counting the same event once per tick matches the semantic intent
    // of the dispatcher counter). The Set is fresh per pollOnce, so a
    // commit that genuinely reappears in a future tick is quarantined
    // exactly once that tick. Cross-tick dedup is the responsibility of
    // the existing source_msg_id ledger dedup + the in-memory
    // _dedupSet — quarantine never causes a write to the ledger, so
    // ledger dedup does not help here.
    const tickQuarantinedHashes = new Set();

    for (const repoPath of repos) {
      const cursorForRepo = perRepoCursors[repoPath] || null;

      // F-T1-GIT_LOG-F2: classify the repo before we read commits so the
      // emitted rows can carry the classification + suggested
      // structural_score. Classification is cached on disk and
      // re-evaluated weekly (and on every poll for "upstream_only"
      // entries, so a single operator commit flips the verdict
      // immediately). Runs BEFORE the _repoHasPriorHistory prefix scan
      // (below) so broken checkouts skip out without paying an O(set)
      // scan per poll.
      let classification;
      try {
        classification = this._ensureRepoClassification(repoPath);
      } catch (err) {
        // Classification is best-effort. If it fails (e.g. git missing),
        // synthesize a "mixed" entry so emission continues without a
        // downgrade flag.
        classification = {
          operator_count: 0,
          total_count: 0,
          classification: "mixed",
          classified_at: this._now(),
          error: err && err.message ? err.message : "classify_failed",
        };
      }

      // F-GIT_LOG-GITDIR-VALIDATE: a discovered directory whose gitdir
      // cannot resolve (empty .git carcass, dangling submodule pointer)
      // fails EVERY git command and cannot heal by retrying. Skip it —
      // no _gitLogForRepo, no tagError — so it does not inflate
      // error_count by one per poll forever. The one-time visibility is
      // the console.warn emitted by _ensureRepoClassification when the
      // repo first classifies as unresolvable; healing is automatic (the
      // cheap rev-parse probe re-runs each poll).
      if (classification && classification.gitdir_unresolvable === true) {
        continue;
      }

      // D1: does this surface already carry a tip frontier? hasOwnProperty,
      // not truthiness or length — `[]` is the valid persisted state of a
      // zero-commit repo and must take the tips branch, or that surface
      // takes the cursor-missing branch below on every poll and forces the
      // full 156 MB dedup-Set build for nothing (8 such repos measured).
      const hasTips = Object.prototype.hasOwnProperty.call(perRepoTips, repoPath);
      // Snapshot the start points BEFORE the walk (TOCTOU guard). Only what
      // is in THIS snapshot gets negated next poll, so a commit that lands
      // after it is walked now (it is not negated by the current tips) or
      // next poll (it is not in the persisted set) — never negated unseen.
      // Snapshotting AFTER the walk could persist a tip whose commit was
      // never walked and silently stop ingestion with a green errors:0.
      const tipsBeforeWalk = this._repoWalkTips(repoPath);

      // F-T2-GIT_LOG-F4: when cursor is missing, check whether the dedup
      // Set already has prior rows for this repo. If yes, treat as
      // restart-recovery (walk full history; dedup absorbs duplicates).
      // If no, treat as true first run (bounded N commits).
      // D1: a surface WITH a tips entry skips the scan — the quiet path must
      // never trigger _buildDedupSet; the failure fallback inside
      // _gitLogForRepo builds it lazily if the tips walk fails.
      const repoHasPriorHistory = (cursorForRepo || hasTips)
        ? false
        : this._repoHasPriorHistory(repoPath);

      let commits;
      // D3: out-param naming the branch that terminated the walk (see
      // _gitLogForRepo); one object per surface, threaded through fallbacks.
      const walkInfo = {};
      try {
        // No tips entry + legacy cursor sha = the one-time `sha..HEAD`
        // migration walk; no tips + no cursor = first run / recovery.
        commits = this._gitLogForRepo(repoPath, cursorForRepo, {
          repoHasPriorHistory,
          walkInfo,
          ...(hasTips ? { excludeTips: perRepoTips[repoPath] } : {}),
        });
      } catch (err) {
        errorCount += 1;
        await this.tagError(err.code || "git_log_error");
        continue;
      }
      // D3: a bounded first run (`-n logMaxCommitsFirstRun`) that FILLED the
      // bound may have left commits older than the bound on other lineages
      // unwalked. The `>= cap` half is load-bearing: a first run that
      // returned fewer records than the cap was complete and must persist
      // real tips, or every small repo re-walks on poll 2 (T12.b1, T12.j7).
      // D5: the bound is tested on the RAW record count (walkInfo.rawCount,
      // one RECORD_TERMINATOR per listed commit), NOT on commits.length:
      // _parseMetadataLine drops a record whose line splits into < 6 fields
      // (`parts.length < 6`) and the metaIdx backward search can misfile a
      // >=5-pipe body line, so a listing that filled the cap could parse to
      // cap-1, persist real tips, and negate the dropped record's lineage
      // unseen forever (reproduced on the T12.j shape: 2 of 5 user commits
      // appended, every later poll walked 0). A dropped record must still
      // defer. The parsed length is the fallback for a walkInfo without
      // rawCount (a seam that bypasses _gitLogForRepo's success path).
      // `walkedCount` stays the PARSED count — D2 telemetry semantics.
      const rawCount = Number.isInteger(walkInfo.rawCount) ? walkInfo.rawCount : commits.length;
      const firstRunHitBound = walkInfo.mode === "bounded_first_run"
        && rawCount >= this.logMaxCommitsFirstRun;
      // D5: an ENOBUFS on this surface's walk (marker set in _gitLogForRepo,
      // stderr line already emitted) is an error, not a quiet poll: count it
      // and tag it so health shows it, then let the normal path run — append
      // whatever the walk returned and persist the PRE-WALK frontier below.
      if (walkInfo.enobufs) {
        errorCount += 1;
        await this.tagError("git_log_enobufs");
      }
      walkedCount += commits.length;
      // Set by the append-failure `break` below; a surface whose appends
      // broke keeps its OLD frontier so the next poll re-walks the
      // un-appended commits.
      let appendFailed = false;

      // F-T1-GIT_LOG-F3 / e12: precompute the repo-IDENTITY hash once per repo
      // so the per-commit source_msg_id is `git:<identity_hash>:<sha>`.
      // Cross-repo cherry-picks remain distinct rows (round-20-style provenance
      // discipline: the same commit landing in two independent repos is two
      // events) because two clones have two different git-common-dirs.
      //
      // e12 — THE GENERAL RULE THIS LINE ENFORCES: a connector's source_msg_id
      // must key the EVENT, not the SURFACE the event was observed through.
      // Getting that wrong is invisible to every downstream boundary: the
      // append-time dedup below was already correct and still passed a 5.79x
      // overcount, because a wrong key is not a duplicate. Identity is the
      // connector's obligation; ENFORCEMENT of it belongs at the ledger append
      // and nowhere else (one site, already built). Per-consumer dedup is how
      // this contamination reached the e7 catch-up join in the first place, and
      // it does not scale past the first consumer.
      //
      // repoPath below is the DISCOVERED SURFACE and stays the surface: it is
      // what we hand to `git log` and what keys per_repo_cursors. Only the
      // hashed identity collapses.
      const canonicalRepoPath = this._canonicalRepoIdentity(repoPath);
      const rpHash = repoPathHash(canonicalRepoPath);

      for (const commit of commits) {
        const sourceMsgId = `git:${rpHash}:${commit.hash}`;

        // F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT: check the
        // "Initial commit: <substantive suffix>" carve-out BEFORE the
        // generic initial-commit detection. When the suffix is long
        // enough (>25 chars) the commit encodes real project intent
        // (e.g. "Initial commit: sample curriculum outline and notes")
        // and should PASS at structural_score=0.55 with reason
        // 'git_log_initial_commit_with_suffix' rather than be
        // quarantined. The carve-out flag is stamped on raw_content so
        // Stage-0 can honour the suggested score without re-evaluating.
        const colonSuffix = initialCommitSuffix(commit.subject);

        // F-NEW-W7-GIT-LOG-RULE1-TIGHTEN: the initial-commit detection
        // now REQUIRES the subject prefix match AND a corroborating
        // signal (parents=[] or is_initial_commit hint). The colon-
        // suffix carve-out short-circuits ahead of this; if colonSuffix
        // is truthy we fall through to the PASS path with the carve-out
        // hint set.
        if (
          colonSuffix == null &&
          isInitialCommitVariant(commit.subject, commit.parents, {
            is_initial_commit: commit.is_initial_commit === true,
          })
        ) {
          // F-NEW-W7-GIT-LOG-COMMIT-HASH-DEDUP: skip the quarantine call
          // if we already quarantined this exact commit hash this tick.
          // Otherwise the same `git:<repo>:<sha>` lands in the daily
          // quarantine file once per re-walk, inflating the inventory
          // 4–7× without changing observability.
          if (tickQuarantinedHashes.has(sourceMsgId)) {
            // Already handled this tick; advance cursor and continue. This
            // write is DURABLE (it lands in per_repo_cursors), so it goes
            // through noteRepoCursor like every other cursor mutation.
            noteRepoCursor(repoPath, commit.hash);
            continue;
          }
          // F-META-GIT-LOG-NUMSTAT: include file_changes in the quarantine
          // payload so a future restoreFromQuarantine() preserves the
          // numstat signal. Initial-commit variants often have large
          // numstat blocks (scaffolding); the file_changes_truncated
          // flag is carried so callers can detect cap firings.
          const initialFileChanges = Array.isArray(commit.file_changes) ? commit.file_changes : [];
          try {
            quarantineRow(
              {
                source: "git-log",
                source_msg_id: sourceMsgId,
                raw_content: {
                  // e12: canonical identity, mirroring the emit path at :2106
                  // so a restoreFromQuarantine() reconstructs the same
                  // repo_path the append path would have written.
                  repo_path: canonicalRepoPath,
                  observed_repo_path: repoPath,
                  commit_hash: commit.hash,
                  author_name: commit.author_name,
                  author_email: commit.author_email,
                  author_ts: commit.author_ts,
                  subject: commit.subject,
                  // F-NEW-W7-GIT-LOG-BODY-CAPTURE: preserve body on
                  // quarantine so restoreFromQuarantine reconstructs
                  // the full commit message, not just the subject.
                  body: typeof commit.body === "string" ? commit.body : "",
                  body_truncated: commit.body_truncated === true,
                  parents: commit.parents,
                  file_changes: initialFileChanges,
                  file_changes_truncated: commit.file_changes_truncated === true,
                  file_count: initialFileChanges.length,
                },
              },
              "git_log_initial_commit_variant",
              { rule_id: "F-T2-GIT_LOG-F6", source: "git-log" },
            );
            recordDrop("git-log", "git_log_initial_commit_variant", "DROP");
            this._classifyInitialQuarantineCount += 1;
            tickQuarantinedHashes.add(sourceMsgId);
          } catch {
            // Quarantine is best-effort. If it fails (disk full, perms)
            // we still advance the cursor — losing a single quarantine
            // entry is preferable to re-processing the same commit on
            // every poll forever.
          }
          // Advance cursor even on quarantine — the row is "handled". Also a
          // DURABLE write, so it routes through noteRepoCursor: a repo whose
          // only commit is an initial-commit variant never reaches the append
          // path, and this is the sole thing that moves its cursor.
          noteRepoCursor(repoPath, commit.hash);
          continue;
        }

        // F-T2-GIT_LOG-F5: broaden bot detection at the connector layer.
        // isBotActor covers dependabot/renovate/github-actions/copilot/
        // web-flow/[bot]@/<digits>+legacy-prefix per R43. When a bot is
        // detected, attach a suggested_structural_score downgrade so the
        // downstream salience layer can de-weight without losing cross-
        // source corroboration value. (Critic invariant: prefer downgrade
        // over DROP when the row carries corroboration value — bot CI
        // commits occasionally reference operator PRs.)
        const isBotAuthor =
          typeof commit.author_email === "string" &&
          commit.author_email !== "" &&
          isBotActor(commit.author_email);

        // F-T1-GIT_LOG-F2: upstream-only repo downgrade. Tag the row so
        // Stage-0 / downstream salience can apply structural_score=0.10
        // without re-running the classifier. Telemetry: recordDrop with
        // decision="PASS" so the per-reason counter reflects downgrade
        // volume (matches the "register downgrades for visibility"
        // invariant).
        const isUpstreamOnly =
          classification && classification.classification === "upstream_only";

        // Compute the connector-side suggested structural_score. The
        // Stage-0 module owns the final value; this is a SUGGESTION the
        // connector publishes via raw_content so downstream can act on
        // it without re-classifying. Lowest wins (bot beats upstream
        // beats default).
        let suggestedStructuralScore = null;
        // D2: connector-side PASS reasons are CAPTURED here (classify time)
        // and only RECORDED once appendLedgerRow reports the row landed —
        // see the res.appended branch below. Bot/upstream and the suffix
        // carve-out can both apply to one commit; the array keeps the
        // per-reason semantics unchanged and moves only WHEN they count.
        const passReasons = [];
        if (isBotAuthor) {
          suggestedStructuralScore = BOT_COMMIT_DOWNGRADE_SCORE;
          this._classifyBotDowngradeCount += 1;
          passReasons.push("git_log_bot_commit_downgrade");
        } else if (isUpstreamOnly) {
          suggestedStructuralScore = UPSTREAM_REPO_DOWNGRADE_SCORE;
          this._classifyDowngradeCount += 1;
          passReasons.push("git_log_upstream_repo_downgrade");
        }

        // F-META-GIT-LOG-NUMSTAT: roll up file_changes into summary
        // aggregates (file_count, total_additions, total_deletions,
        // binary_count) so downstream Stage-0 rules can match without
        // re-walking the array. The raw file_changes[] array is also
        // emitted so rules that need path-level signal (e.g. lockfile-
        // only commits, version-bump commits where only package.json /
        // Cargo.toml / pyproject.toml changed) have access.
        const fileChanges = Array.isArray(commit.file_changes) ? commit.file_changes : [];
        const fileChangesTruncated = commit.file_changes_truncated === true;
        let totalAdditions = 0;
        let totalDeletions = 0;
        let binaryCount = 0;
        for (const fc of fileChanges) {
          if (fc.binary) {
            binaryCount += 1;
          } else {
            if (Number.isFinite(fc.additions)) totalAdditions += fc.additions;
            if (Number.isFinite(fc.deletions)) totalDeletions += fc.deletions;
          }
        }

        // F-NEW-W7-GIT-LOG-AUTHOR-SELF: detect operator-authored commits
        // for the Stage-0 author-self pass-through rule. We stamp a
        // boolean on raw_content so Stage-0 can pin a floor of
        // max(0.7, current_score) without re-running isOperator. Bot-
        // authored commits NEVER pass this gate (bot defense already
        // ran above). Note: `parties` is [author_email]; isOperator's
        // git-log-scoped match honours canonical R42 EMAILS + ENV
        // override set.
        const isOperatorAuthored =
          !isBotAuthor &&
          typeof commit.author_email === "string" &&
          commit.author_email !== "" &&
          isOperator(commit.author_email, "git-log");

        // F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT: colon-suffix variants
        // carry their own suggested score (0.55). The carve-out wins
        // over the bot/upstream downgrades because the operator is
        // explicitly encoding project intent on the root commit; the
        // suffix > 25 chars is the substantive-content gate.
        let initialCommitSuffixValue = colonSuffix; // captured above
        if (
          initialCommitSuffixValue != null &&
          (suggestedStructuralScore == null || suggestedStructuralScore < 0.55)
        ) {
          suggestedStructuralScore = 0.55;
          passReasons.push("git_log_initial_commit_with_suffix");
        }

        // F-CCS-CONNECTOR-git-log-structural: assemble the raw_content
        // payload up-front so we can hand it to buildStructuredFeatures
        // BEFORE constructing the row. The structured payload is what
        // lets the cascade stop forcing the text extractor to re-derive
        // author + project + commit_ts. Defensive: any throw from the
        // builder is swallowed so a malformed row still emits (and the
        // cascade falls back to the text-extractor path — strict
        // backwards-compat per foundation spec §7).
        // e12: the CANONICAL identity is what feeds the project entity.
        // buildStructuredFeatures mints the project canonical_id from
        // basename(repo_path) (:~830), so feeding it the discovered surface
        // minted example-app-g1 / ea-g4 / ea-wt-dip as SEPARATE project
        // entities for one project — a second, independent correctness defect
        // that the same identity collapse fixes. One project, one entity.
        const rawContentForStructural = {
          repo_path: canonicalRepoPath,
          author_email: commit.author_email,
          author_ts: commit.author_ts,
        };
        let structuredFeatures = null;
        try {
          structuredFeatures = buildStructuredFeatures(rawContentForStructural);
        } catch {
          structuredFeatures = null;
        }

        const row = {
          source_msg_id: sourceMsgId,
          parties: [commit.author_email],
          ...(structuredFeatures != null ? { structured_features: structuredFeatures } : {}),
          raw_content: {
            // e12: repo_path is the repo's IDENTITY (the main worktree), so
            // every downstream reader that treats it as "which project is
            // this" — basename() project entities, per-repo roll-ups, the
            // operator eyeballing a row — sees one project rather than one
            // per worktree. observed_repo_path carries the surface the commit
            // was actually walked from, so provenance is not destroyed by the
            // collapse: it is demoted from key to attribute, which is exactly
            // what it always was.
            repo_path: canonicalRepoPath,
            observed_repo_path: repoPath,
            commit_hash: commit.hash,
            author_name: commit.author_name,
            author_email: commit.author_email,
            author_ts: commit.author_ts,
            subject: commit.subject,
            // F-NEW-W7-GIT-LOG-BODY-CAPTURE: full %B body, bounded by
            // BODY_MAX_BYTES (8 KB). body_truncated indicates the cap
            // fired. Empty bodies surface as "" and body_truncated=false.
            body: typeof commit.body === "string" ? commit.body : "",
            body_truncated: commit.body_truncated === true,
            parents: commit.parents,
            // F-T1-GIT_LOG-F2: classification + suggested score for the
            // downstream salience layer to read.
            repo_classification: classification.classification,
            // F-T2-GIT_LOG-F5: explicit bot flag so downstream can
            // distinguish bot-downgrade from upstream-downgrade.
            is_bot_authored: isBotAuthor,
            // F-NEW-W7-GIT-LOG-AUTHOR-SELF: operator-authored flag for
            // the Stage-0 author-self pass-through rule. Stage-0 reads
            // this AND parties/author_email to decide the high-priority
            // PASS path.
            is_operator_authored: isOperatorAuthored,
            // F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT: when the "Initial
            // commit: <suffix>" carve-out fires, surface the suffix so
            // Stage-0 + downstream can audit-log which substantive
            // intent the root commit was carrying. Null when the
            // carve-out did not fire.
            ...(initialCommitSuffixValue != null
              ? { initial_commit_suffix: initialCommitSuffixValue }
              : {}),
            // F-META-GIT-LOG-NUMSTAT: per-file diff stats + roll-up
            // aggregates. file_changes is the structured array (capped
            // at MAX_FILE_CHANGES; file_changes_truncated reflects
            // whether the cap fired). The aggregate fields exist for
            // cheap Stage-0 matching without re-walking the array.
            // GIT_LOG-F7 (boilerplate-subject rule) gates on
            // file_count <= 2 + lockfile-only paths; GIT_LOG-F8
            // (version-bump rule) gates on file_count <= 2 + version-
            // bump path patterns.
            file_changes: fileChanges,
            file_changes_truncated: fileChangesTruncated,
            file_count: fileChanges.length,
            total_additions: totalAdditions,
            total_deletions: totalDeletions,
            binary_count: binaryCount,
            ...(suggestedStructuralScore != null
              ? { suggested_structural_score: suggestedStructuralScore }
              : {}),
          },
        };
        try {
          const res = await this.appendLedgerRow(row);
          if (res.appended) {
            appendedCount += 1;
            lastAppendedTs = this._now();
            lastAppendedId = res.id;
            // D2: connector-side PASS telemetry counts APPENDED rows only. A deduped re-walk (restart recovery, --all --reflog) must not inflate the sink —
            // measured 1.9M phantom git-log rows/day (99.8% of Stage-0 telemetry) against 0-1 appended rows per poll.
            for (const reason of passReasons) recordDrop("git-log", reason, "PASS");
          }
          // Whether appended or deduped, advance the per-repo cursor past
          // this commit. Dedup is fine: we know the row is already on disk.
          // c3-cursor-stamp-class: only a real change counts as an advance —
          // the proto-safe compare lives in noteRepoCursor.
          noteRepoCursor(repoPath, commit.hash);
        } catch (err) {
          errorCount += 1;
          await this.tagError(err.code || "append_error");
          // Do NOT advance the cursor on append failure — next poll retries.
          appendFailed = true;
          break;
        }
      }
      // D1: persist the pre-walk frontier ONLY after the surface's walk
      // returned and every append either landed or deduped. Never on a
      // thrown walk (we `continue`d above) and never after an append break.
      // D3: after a bounded first run that filled the bound, persist `[]`
      // instead — the existing "negate nothing" frontier (the zero-commit
      // path T12.h persists it; probed: `[]` tips → full `--all --reflog`
      // walk) — so the NEXT poll performs one unbounded walk absorbed by the
      // dedup Set and only THEN persists real tips. No sibling marker key:
      // `[]` already carries the semantics and DURABLE_CURSOR_FIELDS stays.
      // D5 — ENOBUFS on the deferred walk (walkInfo.enobufs): persist the
      // PRE-WALK frontier (tipsBeforeWalk), never keep `[]`. Keeping `[]`
      // re-spawns a >maxBuffer `git log` every 15-minute poll forever with no
      // path to success (reproduced: tips [] + no cursor → `exit null`,
      // errors=1, tips [] again on the next poll); persisting tipsBeforeWalk
      // freezes that surface at pre-D1 coverage EXACTLY ONCE, and the stderr
      // line + the git_log_enobufs error count make it visible in health
      // instead of a green errors:0. It is the pre-walk snapshot (TOCTOU
      // guard intact) and it is NOT the D3 deferral: firstRunHitBound is
      // false for a tips-mode walk, and this stays the single noteRepoTips
      // call (cursor-stamp T13c). Named follow-up (not D5): page the deferred
      // walk with `-n`/`--skip`, or a per-surface logMaxBufferBytes, so a
      // frozen surface can complete its one unbounded walk.
      // D5 — dedup-fallback interaction, PINNED not gated: when
      // _dedupFallbackMode is true (_isDuplicate → super._isDuplicate, the
      // tail-window read of dedupTailLines rows) the deferred unbounded walk
      // is absorbed only by that window, so up to (first-run rows − window)
      // rows re-append EXACTLY ONCE; real tips are then persisted and the
      // surface goes quiet (T12.n). Gating by keeping `[]` would repeat that
      // blast every poll while the ledger read is broken; gating by skipping
      // the deferral would silently narrow coverage — the defect D3 fixed.
      // The fallback is already loud (stderr + dedup_stream_read_failed).
      if (!appendFailed) noteRepoTips(repoPath, firstRunHitBound ? [] : tipsBeforeWalk);
    }

    // F-T1-GIT_LOG-F2: persist classification cache changes at end of
    // pollOnce so a daemon crash mid-tick does not lose freshly-computed
    // verdicts. Safe to call when nothing changed (no-op).
    this._persistClassificationCache();

    // Persist the cursor unconditionally (even with 0 appended): the write is
    // what durably carries per_repo_cursors and last_polled_ts. Only the
    // ADVANCE STAMP is conditional — see below.
    //
    // c3-cursor-stamp-class — CORRECTING THE COMMENT THAT USED TO STAND HERE.
    // It read: "last_polled_ts is the health-staleness anchor; without it
    // `status:"stale"` would trip spuriously after the first hour of no
    // activity." That is false. The staleness anchor is
    // last_cursor_advance_ts: it is the field read by _healthFromState
    // (index.js:601, compared at :607-611) and by metadataFromState
    // (index.js:701, compared at :707-711). NO classifier reads
    // last_polled_ts — the single mention of that field anywhere in
    // index.js is the heavy-sidecar rationale comment at index.js:228.
    //
    // c3-cursor-stamp-class fix (ports telegram.js:255-264): stamp an advance
    // ONLY when a per-repo cursor genuinely moved. The prior unconditional
    // `nowTs` refreshed the sensor on every poll and made `stale` unreachable
    // for this source.
    //
    // The old comment's underlying WORRY is real and is NOT addressed here: at
    // CAPS.CONNECTOR_HEALTH_STALE_SECONDS = 3600 (mcp/lib/validation.js:370) a
    // correctly-stamped git-log will read `stale` during any quiet hour once
    // error_count is ever reset (today error_count 1701 pins it `degraded`,
    // which is checked first at index.js:705). The per-source override the tree
    // promises at mcp/lib/validation.js:367-369 has never been written; that is
    // filed as residual Fc3-3 and belongs to a different node.
    const nowTs = this._now();
    const carriedAdvanceTs =
      typeof state.last_cursor_advance_ts === "string" ? state.last_cursor_advance_ts : null;
    const nextState = {
      ...state,
      per_repo_cursors: perRepoCursors,
      // D1: routed to state.heavy.json by heavyCursorKeys (change-gated).
      // The key is materialised once a surface has noted tips (or once it is
      // already on disk); a poll over zero repos against a legacy state that
      // never carried the key leaves it absent, so `undefined -> {}` never
      // reads as durable cursor progress under a carried-forward stamp
      // (cursor-stamp-class T7).
      ...((Object.prototype.hasOwnProperty.call(state, "per_repo_ref_tips")
        || Object.keys(perRepoTips).length > 0)
        ? { per_repo_ref_tips: perRepoTips }
        : {}),
      last_polled_ts: nowTs,
      last_appended_ts: lastAppendedTs,
      last_appended_id: lastAppendedId,
      last_cursor_advance_ts: cursorAdvanced ? nowTs : carriedAdvanceTs,
      // Preserve error_count — tagError already incremented it for the
      // current poll's failures; do not overwrite here.
      error_count: Number.isInteger(state.error_count) ? state.error_count : 0,
    };
    // Reload state to pick up tagError's increments. tagError persists
    // immediately so the on-disk error_count reflects current-poll errors;
    // we re-read so we don't clobber it with the snapshot we took at
    // pollOnce start.
    const reloaded = (await this.readCursor()) || {};
    if (Number.isInteger(reloaded.error_count) && reloaded.error_count >= nextState.error_count) {
      nextState.error_count = reloaded.error_count;
      nextState.last_error_kind = reloaded.last_error_kind;
      nextState.last_error_ts = reloaded.last_error_ts;
    }
    await this.writeCursor(nextState);

    return { appended: appendedCount, errors: errorCount, repos: repos.length, walked: walkedCount };
  }

  // ---------------------------------------------------------------------------
  // F-T1-GIT_LOG-F3: dedup override
  // ---------------------------------------------------------------------------

  // _isDuplicate (OVERRIDE of ConnectorBase._isDuplicate). The base class
  // does a bounded tail-read (CONNECTOR_DEDUP_TAIL_LINES=256). For git-log
  // that window is structurally insufficient — repo discovery can emit
  // batches >256, and the audit trace identified 645,370 duplicate rows
  // (96.0% of the ledger) traceable to that exact failure mode.
  //
  // This override builds a full-scan in-memory Set<source_msg_id> from the
  // existing ledger on the first call (lazy — daemon-start latency is
  // bounded), then consults it in O(1) per append. Tail-checksum sanity
  // check verifies the last TAIL_CHECKSUM_VERIFY_LINES rows; if any
  // recomputed checksum mismatches stored, we treat the ledger as having
  // been truncated/rotated externally and fall back to the base-class
  // bounded tail-dedup with a stderr warning.
  _isDuplicate(sourceMsgId) {
    if (!this._dedupSetBuilt) {
      this._buildDedupSet();
    }
    if (this._dedupFallbackMode) {
      const isDup = super._isDuplicate(sourceMsgId);
      if (isDup) this._dedupHitCount += 1;
      return isDup;
    }
    if (this._dedupSet.has(sourceMsgId)) {
      this._dedupHitCount += 1;
      return true;
    }
    // Not a duplicate — record it so future appends within this daemon
    // process see the just-appended row even before it hits disk-flush.
    // Note: the row is the next-to-be-appended; recording it here is safe
    // because the caller (appendLedgerRow) has already verified absence
    // and will now persist. If the persist fails the in-memory marker
    // would be a false positive, but appendLedgerRow throws in that case
    // and the daemon's next poll attempt will not advance the cursor —
    // the row is genuinely lost from on-disk state but the in-memory Set
    // entry merely blocks an immediate retry (acceptable: retry happens
    // on next daemon tick, by which time a fresh instance has rebuilt
    // the Set from disk).
    this._dedupSet.add(sourceMsgId);
    return false;
  }

  // _buildDedupSet: one-shot full-scan of the on-disk ledger. Builds the
  // Set, runs the tail-checksum sanity check, logs the unique-count, sets
  // the fallback flag if needed. Safe to call when ledger does not exist
  // (yields an empty Set).
  //
  // F-GIT_LOG-DEDUP-STREAM: the scan is a SYNC fd + readSync loop, NOT a
  // whole-file readFileSync. The ledger grew past Node's ~512 MB max
  // string length (1.4 GB / 1.1M rows observed), so the whole-file read
  // threw ERR_STRING_TOO_LONG on every build; the catch silently fell
  // back to the 256-line tail-dedup and the connector re-appended ~30k
  // duplicate rows per poll — the exact runaway this Set exists to
  // prevent. Sync is REQUIRED: both callers (_isDuplicate, invoked from
  // appendLedgerRow's sync dedup check, and _repoHasPriorHistory) are
  // sync, so createReadStream/readline cannot be awaited here. Memory
  // stays bounded: one chunk Buffer + the current carry (partial line)
  // + one line string at a time; the ~1.1M-id Set itself is fine in
  // memory. On any stream failure we still fall back to tail-dedup, but
  // LOUDLY: stderr + getDedupStats().stream_error + a fire-and-forget
  // tagError so reportHealth surfaces it — never silently again.
  _buildDedupSet() {
    this._dedupSetBuilt = true;
    if (!existsSync(this.sourceLedgerPath)) {
      this._logDedupBuild(0, 0, 0, "ledger-absent");
      return;
    }

    let scanned = 0;
    let skipped = 0;
    // Running raw-line index (newline-delimited, empties included) so the
    // tail-mismatch report keeps the same line_index semantics as the old
    // whole-file split.
    let lineIndex = 0;
    // Bounded window of the last TAIL_CHECKSUM_VERIFY_LINES non-empty
    // lines, retained for the post-scan checksum sanity check. O(16)
    // regardless of ledger size.
    const tailWindow = [];

    const processLine = (line) => {
      const idx = lineIndex;
      lineIndex += 1;
      if (line === "") return;
      tailWindow.push({ index: idx, line });
      if (tailWindow.length > TAIL_CHECKSUM_VERIFY_LINES) tailWindow.shift();
      scanned += 1;
      let parsed;
      try { parsed = JSON.parse(line); } catch { skipped += 1; return; }
      if (parsed && typeof parsed.source_msg_id === "string" && parsed.source_msg_id !== "") {
        this._dedupSet.add(parsed.source_msg_id);
      } else {
        skipped += 1;
      }
    };

    let fd = null;
    try {
      fd = openSync(this.sourceLedgerPath, "r");
      const chunk = Buffer.allocUnsafe(this._dedupStreamChunkBytes);
      // carry = bytes of the trailing partial line from the previous
      // chunk. Kept as a Buffer (NOT a string) so a multi-byte UTF-8
      // sequence split across a chunk boundary reassembles correctly —
      // 0x0A never appears inside a UTF-8 continuation, so splitting on
      // newline BYTES before decoding is safe.
      let carry = Buffer.alloc(0);
      for (;;) {
        const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        const buf = carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        let start = 0;
        let nl;
        while ((nl = buf.indexOf(0x0a, start)) !== -1) {
          processLine(buf.subarray(start, nl).toString("utf8"));
          start = nl + 1;
        }
        // Buffer.from COPIES — mandatory, because when carry was empty
        // `buf` is a subarray VIEW over `chunk`, which the next readSync
        // overwrites in place.
        carry = Buffer.from(buf.subarray(start));
      }
      // Final line without a trailing newline (partial append) still
      // counts — the old split-based scan saw it too.
      if (carry.length > 0) processLine(carry.toString("utf8"));
    } catch (err) {
      // Stream failure — fall back to tail-dedup so we don't emit every
      // row as "novel", but make the failure LOUD (see header comment):
      // the silent version of this fallback is what let the duplicate
      // runaway go unnoticed for 1.1M rows.
      this._dedupFallbackMode = true;
      const detail = `read-error:${err && err.code ? err.code : (err && err.message ? err.message : "unknown")}`;
      this._dedupStreamError = detail;
      this._dedupBuildScanned = scanned;
      this._dedupBuildSkipped = skipped;
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[git-log dedup] STREAMING LEDGER SCAN FAILED (${detail}) at line ~${lineIndex} — ` +
          `falling back to bounded tail-dedup (CONNECTOR_DEDUP_TAIL_LINES window); ` +
          `duplicate re-appends are possible until the ledger read is fixed.`
        );
      } catch { /* never let logging fail */ }
      // Fire-and-forget: tagError is async and this method must stay
      // sync. The write races nothing fatal — pollOnce already reconciles
      // concurrent tagError increments via its end-of-tick cursor reload.
      try { this.tagError("dedup_stream_read_failed").catch(() => {}); } catch { /* best-effort */ }
      this._logDedupBuild(this._dedupSet.size, scanned, 0, detail);
      return;
    } finally {
      if (fd != null) {
        try { closeSync(fd); } catch { /* best-effort */ }
      }
    }

    if (lineIndex === 0) {
      this._logDedupBuild(0, 0, 0, "ledger-empty");
      return;
    }

    // Tail-checksum sanity: recompute checksums for the trailing window
    // and compare to stored. Any mismatch -> external truncation/rotation
    // suspected -> fall back to bounded tail-dedup mode.
    let tailVerified = 0;
    let tailMismatch = null;
    for (const { index, line } of tailWindow) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!parsed || typeof parsed.checksum !== "string" || parsed.checksum === "") continue;
      const stored = parsed.checksum;
      const { checksum: _ignored, ...rest } = parsed;
      let recomputed;
      try {
        recomputed = blake2b512TruncTo16Hex(Buffer.from(canonicalJson(rest), "utf8"));
      } catch {
        continue;
      }
      tailVerified += 1;
      if (recomputed !== stored) {
        tailMismatch = { line_index: index, stored, recomputed };
        break;
      }
    }
    if (tailMismatch != null) {
      this._dedupFallbackMode = true;
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[git-log dedup] tail-checksum sanity check FAILED at line ${tailMismatch.line_index} ` +
          `(stored=${tailMismatch.stored} recomputed=${tailMismatch.recomputed}); ` +
          `ledger appears to have been truncated/rotated externally — ` +
          `falling back to bounded tail-dedup (CONNECTOR_DEDUP_TAIL_LINES window).`
        );
      } catch { /* never let logging fail */ }
    }

    this._dedupBuildScanned = scanned;
    this._dedupBuildSkipped = skipped;
    this._logDedupBuild(
      this._dedupSet.size,
      scanned,
      tailVerified,
      this._dedupFallbackMode ? "fallback-tail-dedup" : "ok",
    );
  }

  _logDedupBuild(uniqueCount, scanned, tailVerified, status) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[git-log dedup] built source_msg_id Set: ` +
        `unique=${uniqueCount} scanned=${scanned} skipped=${this._dedupBuildSkipped} ` +
        `tail_verified=${tailVerified} status=${status}`
      );
    } catch { /* never let logging fail */ }
  }

  // getDedupStats: read-only telemetry view for the supervisor / MEASURE
  // harness. Returns the dedup counters as a plain object so callers can
  // assert measurement outcomes without poking at internal fields.
  getDedupStats() {
    return {
      built: this._dedupSetBuilt,
      fallback_mode: this._dedupFallbackMode,
      unique_set_size: this._dedupSet.size,
      hits: this._dedupHitCount,
      scanned: this._dedupBuildScanned,
      skipped: this._dedupBuildSkipped,
      // F-GIT_LOG-DEDUP-STREAM: null when the streaming ledger scan
      // succeeded; failure detail string when the build fell back to
      // tail-dedup because the scan errored mid-stream.
      stream_error: this._dedupStreamError,
      // F-T1-GIT_LOG-F2 / F-T2-GIT_LOG-F5 / F-T2-GIT_LOG-F6 counters.
      // Reset on each new connector instance; persist via per-tick
      // telemetry sink (lib/ingest/stage0/telemetry.js) for cross-tick
      // aggregation.
      classify_upstream_downgrade: this._classifyDowngradeCount,
      classify_bot_downgrade: this._classifyBotDowngradeCount,
      classify_initial_quarantine: this._classifyInitialQuarantineCount,
    };
  }

  // F-T1-GIT_LOG-F2: read-only classification cache view for tests +
  // operator inspection. Returns a shallow clone so callers cannot mutate
  // the in-memory map. Lazy-loads the cache if not yet read.
  getClassificationCache() {
    if (!this._classificationCacheLoaded) {
      this._classificationCache = loadRepoClassificationCache();
      this._classificationCacheLoaded = true;
    }
    return { ...this._classificationCache };
  }
}

// =============================================================================
// CLI / daemon entry points
// =============================================================================

// runOnce: invoke pollOnce once and exit. Used by --once and by the launchd
// plist's foreground execution (the plist re-launches the binary on a
// throttled interval so we don't need an in-process scheduler).
export async function runOnce(opts = {}) {
  const c = new GitLogConnector(opts);
  return c.pollOnce();
}

// runForever: poll loop with a fixed sleep between ticks. NOT used by the
// launchd plist (which uses StartInterval / KeepAlive throttle); exposed
// for manual use during operator debug sessions.
export async function runForever(opts = {}) {
  const intervalSec = Number.isInteger(opts.intervalSec) && opts.intervalSec > 0
    ? opts.intervalSec
    : 300; // 5 min default
  const c = new GitLogConnector(opts);
  for (;;) {
    try { await c.pollOnce(); }
    catch { /* tagError already invoked; loop continues */ }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

// CLI surface: --check (report health), --once (single poll, exit), default
// is runForever.
export async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--check")) {
    const c = new GitLogConnector();
    const h = c.reportHealth();
    process.stdout.write(JSON.stringify(h) + "\n");
    return 0;
  }
  if (args.includes("--once")) {
    const res = await runOnce();
    process.stdout.write(JSON.stringify(res) + "\n");
    return 0;
  }
  await runForever();
  return 0; // unreachable in normal operation
}

// Run when invoked directly (node lib/connectors/git-log-local.js ...).
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`git-log-local fatal: ${err && err.stack ? err.stack : String(err)}\n`);
      process.exit(1);
    },
  );
}
