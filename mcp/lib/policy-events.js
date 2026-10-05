// Policy-events audit log. See kb/mcp-surface.md § Privilege levels
// → Logging + Rotation paragraphs. Monthly-rotated append-only JSONL at
// <MEMORY_ROOT>/policy/policy-events-YYYY-MM.jsonl, keyed on the writer's
// LOCAL-timezone month-of-write.
//
// Three operational guarantees:
//
// 1. Secret-leak guard. Token mint/consume/reject events MUST log only the
//    `nonce_hash` (sha256 of the raw nonce) — never the raw token, the raw
//    nonce, the signing key, or the binding_hash preimage. The validator at
//    appendPolicyEvent rejects any event containing the forbidden field
//    names so accidental drift in caller code surfaces at write time, not
//    in a post-mortem grep of the audit log.
//
// 2. Multi-writer atomicity (review-12 M8 fix + round-15 C-NEW-1 fix).
//    Multiple processes write here concurrently — the MCP handler
//    (token.consumed/rejected), the watermark daemon (daemon.lock_reclaimed,
//    salience.* + corroboration), and the recall layer
//    (recall.transitive_orphan_cap_exceeded). Without a lock, two concurrent
//    appends can
//    interleave bytes mid-line. We acquire the sidecar `policy-events.lock`
//    via the acquireExclusiveLockFile pattern (kb/architecture.md §
//    acquireExclusiveLockFile):
//      a) tryCreateLock uses openSync(LOCK_PATH, O_WRONLY|O_CREAT|O_EXCL|
//         O_NOFOLLOW, 0o600), then fstat(fd) and verifies nlink === 1.
//         nlink===1 closes the swap-during-acquire race where another
//         writer unlinks our fresh lock and recreates it between open and
//         use; if the fd we hold is no longer linked at LOCK_PATH (or has
//         been hard-linked), we drop it and re-acquire.
//      b) reclaimStaleLockIfDead replaces unlink-by-path with a hold-and-
//         verify discipline (round-15 C-NEW-1): open the suspect lock to
//         get fd_a, fstat to record inode_a; re-check pid-dead/mtime-old
//         against the *fstat* sample (not statSync, to avoid path-vs-fd
//         TOCTOU); unlink ONLY if the current path still resolves to
//         inode_a; race losers observe ENOENT/EBUSY semantics via O_EXCL
//         on the next tryCreateLock and never double-unlink someone else's
//         lock. Two writers passing the same staleness check at the same
//         time would each unlink (idempotent against the SAME inode); the
//         first wins by O_EXCL on the new lock; the second observes O_EXCL
//         EEXIST and re-attempts acquisition instead of unlinking the new
//         lock.
//
// 3. Per-line checksum (review-12 M8 fix). Every appended line carries a
//    `checksum` field (last key) — blake2b512 truncated to 16 bytes,
//    lowercase hex (same engine as nonce-store; see kb/mcp-surface.md §
//    Consumed-nonce store for the rationale on truncated-blake2b512 over
//    native blake2b-128) computed over canonical_json of the event WITHOUT
//    its checksum field. Recovery convention: on startup-scan, the first
//    line whose checksum fails is the corrupt-tail boundary; truncate to
//    last_good_line_offset and append a follow-on
//    `{kind:"policy.token.rejected", reason:"policy_events_corrupt_tail_truncated", ...}`
//    event (mirrors the nonce-store discipline). Mid-file corruption halts
//    the writer (mirrors nonce-store's "nonce_store_corrupted" branch);
//    Phase 1 does not auto-recover from mid-file corruption.
//
// Cross-deps:
//   - nonce-store.js calls appendPolicyEvent with kind "policy.token.rejected"
//     and reason "corrupt_tail_truncated" or "nonce_store_corrupted" on
//     startup-scan failures.
//   - Per the AUTHORITATIVE token-event ownership table in
//     kb/agent-integration.md: cascade producers only after R32 / R32.1:
//     watermark.js writes "policy.daemon.lock_reclaimed" and the salience-
//     layer kinds via the cascade; memory_distill_promote_fact handler
//     writes "policy.token.consumed" (after checkAndConsume) and
//     "policy.token.rejected" (on any verifyToken / verifyBinding /
//     checkAndConsume failure). Each kind has exactly one producer
//     (lock_reclaimed has at most one live producer per daemon and disjoint
//     scope). R34 CLOSE-4 removed "policy.daemon.state.rebuilt" — the
//     watermark rebuildStateFromLedgers path was retired in R32.1 with
//     tickOnce; no live producer remained.
//   - R32.1: the policy.distillation.batch.{enqueued,suppressed_by_hook,
//     split,failed,poisoned} event family AND policy.token.minted were
//     retired with the conversational distillation pipeline. The producers
//     (watermark.tickOnce + distillation-supervisor + session-end-hook
//     batch.enqueued path) are gone. Historical context lives in
//     kb/legacy-archive.md.
// All call sites use this same appendPolicyEvent function — single chokepoint
// for the rotation policy, the lock, the per-line checksum, and the
// secret-leak guard.

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { canonicalJson, CAPS } from "./validation.js";
import { POLICY_DIR, policyEventsLockPath } from "./config.js";

// Authoritative event-kind set from kb/mcp-surface.md § Privilege levels
// → Logging and agent-integration.md § Watermark daemon → Policy log entries.
// Drift here = the propagation bug class from rounds 8/9/10; the const is
// the single point of truth, callers MUST use these exact strings.
export const EVENT_KINDS = Object.freeze([
  // R32.1: removed 6 retired entries (policy.token.minted plus the
  // policy.distillation.batch family — enqueued, suppressed_by_hook,
  // split, failed, poisoned). The conversational distillation pipeline
  // that produced them was retired in R32. See kb/legacy-archive.md.
  //
  // R34 CLOSE-4: removed `policy.daemon.state.rebuilt` — the watermark
  // state rebuild path was retired in R32.1 with tickOnce
  // (rebuildStateFromLedgers + stateForPersistence). With no live producer,
  // the kind triggered an EVENT-KIND PRESENCE spec-sweep finding. The
  // ownership-table row and payload-shape entry in kb/agent-integration.md
  // were dropped in the same close-out.
  "policy.token.consumed",
  "policy.token.rejected",
  "policy.daemon.lock_reclaimed",
  // Recall-layer informational event. Producer: mcp/lib/recall/hard-gates.js.
  // Emitted when the transitive-orphan forward BFS hits
  // CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP before exhausting reachable
  // descendants from the active-excise seed set; partial coverage is
  // returned and recall completes. See kb/agent-integration.md § Token-event
  // ownership table and kb/transitive-orphan-design.md § 2.
  "policy.recall.transitive_orphan_cap_exceeded",
  // R25 salience-layer audit events. Producer: mcp/lib/ingest/salience.js
  // (Phase A1). dropped fires when a Stage-0 module returns the DROP
  // decision (structurally-certain noise rules listed in
  // kb/salience-design.md § Stage-0 hard-drops). redacted fires when the
  // OTP regex matches inside a Stage-0 module; raw content is NEVER
  // logged on this path (only source + source_msg_id + reason).
  // policy.corroboration fires when the embedding's nearest neighbour
  // falls inside CAPS.SALIENCE_CORROBORATE_THRESHOLD[source]; no new
  // fact row is appended, the corroboration target is recorded for the
  // recall layer. stale_post_revoke is produced by hard-gates.js (Phase
  // A5) on connector_revoke BFS — declared here so the EVENT_KINDS_SET
  // gate accepts the emit from that file.
  "policy.salience.dropped",
  "policy.salience.redacted",
  "policy.corroboration",
  "policy.salience.stale_post_revoke",
  // R26 watermark multi-source: emitted by daemons/watermark.js when a
  // source-tier ledger (imessage/screentime/git-log/github-events) is
  // skipped because memory.jsonl carries a policy_kind=connector_revoke
  // row with target_source matching. One emit per (source, tick); the
  // cursor remains pinned so a subsequent rescind resumes tailing from
  // the same offset.
  "policy.salience.source_revoked",
  // WAVE-9 (CP-5 Trigger A) salience<->recall feedback. Single producer
  // (enforced by mcp/test/synthesis/single-producer-recall-feedback.test.mjs):
  // mcp/lib/synthesis/recall-feedback-emitter.js (emitRecallFeedback),
  // invoked fire-and-forget from mcp/lib/tools/recall.js at the tail of the
  // recall handler. The batched envelope encodes the full surfaced set
  // (surfaced_memory_ids[], surface_position_by_id{}, propensities_by_id{})
  // alongside the recall_id + scoring_weights snapshot — one audit row per
  // recall, not one row per surfaced memory (the per-row alternative was
  // rejected at architect time for 5-10x ledger inflation without added
  // audit value). See kb/agent-integration.md § Token-event ownership
  // table and mcp/docs/specs/synthesis/token-event-table-update.md.
  "policy.salience.recall_feedback",
  // WORKUNIT N8 — operator-authored direct memory write (memory_put). Single
  // producer: mcp/lib/tools/put.js, emitted on a successful operator put AFTER
  // the fact row is durably fsync'd. The audit row records the minted
  // memory_event_id + promoted_at + tool name; raw content is NOT logged (the
  // fact row itself is the content of record). Zero emits on the gate-blocked
  // path (the gate fires before any ledger write). consent_basis is always
  // "first_party" — the operator asserts their own basis, no source-ledger walk.
  "policy.memory.put",
  // F-WM-AUTOMUTE-SIGNAL (Jul 2026) — watermark per-source circuit-breaker
  // trip. Single producer: daemons/watermark.js (tickSourcesOnce), emitted
  // when a source's cursor error_count is at-or-above
  // CAPS.WATERMARK_SOURCE_ERROR_THRESHOLD and the tail loop auto-mutes the
  // source. Throttled daemon-side to once per mute window (module-level
  // already-signalled set, re-armed when the breaker resets), NOT once per
  // tick — the audit trail records the mute EVENT, not the muted state.
  // Payload: {source, error_count, threshold, muted_at}. The name lives
  // under policy.daemon.* (daemon-lifecycle namespace per
  // kb/agent-integration.md § Name discipline) because the mute is daemon
  // tail-loop state, not a salience decision. Closes the month-long silent
  // git-log mute (June 2026): the bare `continue` left no stderr line, no
  // policy event, and no cursor write when the threshold tripped.
  "policy.daemon.source_auto_muted",
]);

// Module discipline (W2-W13): VERSION + frozen CAPS exports.
// VERSION reflects the per-kind validator surface. Bumped when the
// validatePerKindShape contract changes in a backwards-incompatible way.
// v1 ships the recall_feedback per-kind branch + the default-no-op posture
// for pre-existing kinds.
export const VERSION = Object.freeze("v1");

// Frozen caps used by the per-kind shape validator. The min/max bounds
// guard against accidental drift in caller code (e.g. negative position
// indexes, runaway map sizes) without coupling the shape to a downstream
// consumer. Values match the recall-side defaults in CAPS.RECALL_MAX_ITEMS
// (a recall can surface at most 12 memories per kb/mcp-surface.md § Caps),
// but the validator keeps a small slack budget for tests that exercise
// larger fixture sets.
//
// Name discipline: exported as POLICY_EVENT_CAPS rather than CAPS to avoid
// a name collision with the global CAPS imported from validation.js. The
// frozen-CAPS-per-module discipline (W2-W13) is satisfied by the module-
// scoped name; downstream consumers reference these as
// POLICY_EVENT_CAPS.RECALL_FEEDBACK_* exactly.
export const POLICY_EVENT_CAPS = Object.freeze({
  RECALL_FEEDBACK_MAX_SURFACED_IDS: 64,
  RECALL_FEEDBACK_MIN_SURFACED_IDS: 0,
  RECALL_FEEDBACK_MAX_SCORING_WEIGHTS_KEYS: 32,
  RECALL_FEEDBACK_MAX_PROPENSITY_VALUE: 1.0,
  RECALL_FEEDBACK_MIN_PROPENSITY_VALUE: 0.0,
});

const EVENT_KINDS_SET = new Set(EVENT_KINDS);

// Fields that MUST NOT appear in any event payload. The audit log records
// only post-hash artefacts (nonce_hash) and operational metadata; raw
// tokens, raw nonces, key material, and binding_hash preimages stay in
// memory only. Drift in caller code that accidentally includes one of
// these fails fast at write time instead of leaking to disk.
const FORBIDDEN_FIELDS = Object.freeze(["token", "key", "binding_hash", "nonce"]);

// validatePerKindShape — per-kind structural assertions for the synthesis-
// wave kinds (token-event-table-update.md § JSON schema). Mirrors the
// "throw on first failure with a stable error string" style used by
// validation.js so error messages are greppable + machine-parseable. The
// switch defaults to no-op for kinds that pre-date the synthesis wave
// (back-compat: existing kinds were NEVER structurally validated and we
// do not retrofit them here — drift would surface as a 92/92 regression
// without an alerting net). Synthesis-wave additions ARE validated.
//
// Defensive posture: this helper THROWS on schema mismatch; the caller
// (appendPolicyEvent) is already inside a try/catch via its lock-release
// finally block, so a throw here releases the lock cleanly and the
// caller observes a string error. Per the hot-path-defensive-degradation
// discipline (W2-W13): the recall emitter that produces these rows wraps
// its appendPolicyEvent call in a try/catch and never re-throws to its
// fire-and-forget caller.
function validatePerKindShape(event) {
  switch (event.kind) {
    case "policy.salience.recall_feedback": {
      // Required fields per token-event-table-update.md (workunit schema):
      //   recall_id, surfaced_memory_ids, surface_position_by_id,
      //   scoring_weights, propensities_by_id, emitter_module,
      //   emitter_version.
      // The ts field is optional here because callers that route through
      // appendPolicyEvent already stamp a checksum + the audit log carries
      // its own write-time discipline; but if a ts is present it must be
      // a non-empty string (ISO-8601 by convention; we do not parse).
      if (typeof event.recall_id !== "string" || event.recall_id.length === 0) {
        throw new Error(
          "appendPolicyEvent: policy.salience.recall_feedback payload recall_id must be a non-empty string"
        );
      }
      if (!Array.isArray(event.surfaced_memory_ids)) {
        throw new Error(
          "appendPolicyEvent: policy.salience.recall_feedback payload surfaced_memory_ids must be an array"
        );
      }
      if (
        event.surfaced_memory_ids.length > POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_SURFACED_IDS
      ) {
        throw new Error(
          `appendPolicyEvent: policy.salience.recall_feedback payload surfaced_memory_ids length exceeds POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_SURFACED_IDS (${POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_SURFACED_IDS})`
        );
      }
      for (let i = 0; i < event.surfaced_memory_ids.length; i++) {
        const s = event.surfaced_memory_ids[i];
        if (typeof s !== "string" || s.length === 0) {
          throw new Error(
            `appendPolicyEvent: policy.salience.recall_feedback payload surfaced_memory_ids[${i}] must be a non-empty string`
          );
        }
      }
      if (
        event.surface_position_by_id == null ||
        typeof event.surface_position_by_id !== "object" ||
        Array.isArray(event.surface_position_by_id)
      ) {
        throw new Error(
          "appendPolicyEvent: policy.salience.recall_feedback payload surface_position_by_id must be a plain object"
        );
      }
      for (const [k, v] of Object.entries(event.surface_position_by_id)) {
        if (typeof k !== "string" || k.length === 0) {
          throw new Error(
            "appendPolicyEvent: policy.salience.recall_feedback payload surface_position_by_id keys must be non-empty strings"
          );
        }
        if (!Number.isInteger(v) || v < 0) {
          throw new Error(
            `appendPolicyEvent: policy.salience.recall_feedback payload surface_position_by_id["${k}"] must be a non-negative integer`
          );
        }
      }
      if (
        event.scoring_weights == null ||
        typeof event.scoring_weights !== "object" ||
        Array.isArray(event.scoring_weights)
      ) {
        throw new Error(
          "appendPolicyEvent: policy.salience.recall_feedback payload scoring_weights must be a plain object"
        );
      }
      const scoringWeightKeys = Object.keys(event.scoring_weights);
      if (
        scoringWeightKeys.length > POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_SCORING_WEIGHTS_KEYS
      ) {
        throw new Error(
          `appendPolicyEvent: policy.salience.recall_feedback payload scoring_weights key count exceeds POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_SCORING_WEIGHTS_KEYS (${POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_SCORING_WEIGHTS_KEYS})`
        );
      }
      for (const [k, v] of Object.entries(event.scoring_weights)) {
        if (typeof k !== "string" || k.length === 0) {
          throw new Error(
            "appendPolicyEvent: policy.salience.recall_feedback payload scoring_weights keys must be non-empty strings"
          );
        }
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new Error(
            `appendPolicyEvent: policy.salience.recall_feedback payload scoring_weights["${k}"] must be a finite number`
          );
        }
      }
      if (
        event.propensities_by_id == null ||
        typeof event.propensities_by_id !== "object" ||
        Array.isArray(event.propensities_by_id)
      ) {
        throw new Error(
          "appendPolicyEvent: policy.salience.recall_feedback payload propensities_by_id must be a plain object"
        );
      }
      for (const [k, v] of Object.entries(event.propensities_by_id)) {
        if (typeof k !== "string" || k.length === 0) {
          throw new Error(
            "appendPolicyEvent: policy.salience.recall_feedback payload propensities_by_id keys must be non-empty strings"
          );
        }
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new Error(
            `appendPolicyEvent: policy.salience.recall_feedback payload propensities_by_id["${k}"] must be a finite number`
          );
        }
        if (
          v < POLICY_EVENT_CAPS.RECALL_FEEDBACK_MIN_PROPENSITY_VALUE ||
          v > POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_PROPENSITY_VALUE
        ) {
          throw new Error(
            `appendPolicyEvent: policy.salience.recall_feedback payload propensities_by_id["${k}"] must be in [${POLICY_EVENT_CAPS.RECALL_FEEDBACK_MIN_PROPENSITY_VALUE}, ${POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_PROPENSITY_VALUE}]`
          );
        }
      }
      if (
        typeof event.emitter_module !== "string" ||
        event.emitter_module.length === 0
      ) {
        throw new Error(
          "appendPolicyEvent: policy.salience.recall_feedback payload emitter_module must be a non-empty string"
        );
      }
      if (
        typeof event.emitter_version !== "string" ||
        event.emitter_version.length === 0
      ) {
        throw new Error(
          "appendPolicyEvent: policy.salience.recall_feedback payload emitter_version must be a non-empty string"
        );
      }
      return;
    }
    // Pre-existing kinds (policy.token.consumed, policy.token.rejected,
    // policy.daemon.lock_reclaimed, policy.corroboration,
    // policy.recall.transitive_orphan_cap_exceeded, policy.salience.dropped,
    // policy.salience.redacted, policy.salience.stale_post_revoke,
    // policy.salience.source_revoked) — NO structural validation.
    // Back-compat: introducing validation here would risk breaking the
    // ≥92/92 floor on a change that should be additive only. The synthesis-
    // wave additions ARE validated.
    default:
      return;
  }
}

// Paths — POLICY_DIR is sourced from lib/config.js (env-overridable for
// hermetic tests). The active-file basename uses FILE_PREFIX + YYYY-MM +
// FILE_SUFFIX, which config.js's policyEventsActivePath(yyyyMm) helper
// reproduces; this module keeps the two constants because the recovery
// scanner (rotation-aware) globs by prefix/suffix.
const FILE_PREFIX = "policy-events-";
const FILE_SUFFIX = ".jsonl";

// Sidecar lock path — single lock for ALL appends regardless of active-file
// rotation. Rotation at month boundary is safe under this lock: the writer
// re-derives the active path inside the critical section.
const LOCK_PATH = policyEventsLockPath();

// O_* live on fs.constants (NOT os.constants — see nonce-store.js header).
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;
const O_WRONLY = fsConstants.O_WRONLY;
const O_RDONLY = fsConstants.O_RDONLY;
const LOCK_FLAGS = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
// Read-only flags for inspecting a stale lock without disturbing it. O_NOFOLLOW
// rejects a symlink-swap attack the same way LOCK_FLAGS does on create.
const LOCK_INSPECT_FLAGS = O_RDONLY | O_NOFOLLOW;

const LOCK_MODE = 0o600;
const LOCK_ACQUIRE_TIMEOUT_MS = CAPS.STALE_LOCK_RECOVERY_SECONDS * 1000;
const LOCK_BACKOFF_MS = 25;

// blake2b512 truncated to 16 bytes — mirrors nonce-store's discipline. See
// kb/mcp-surface.md § Consumed-nonce store → "Why blake2b512 truncated to 16
// bytes and not blake2b-128" for why this is NOT a native blake2b-128 engine.
function blake2b512TruncTo16Hex(bytes) {
  return createHash("blake2b512").update(bytes).digest().subarray(0, 16).toString("hex");
}

// pidAlive — process.kill(pid, 0) probes existence without delivering a signal.
// ESRCH = no such process (dead). EPERM = process exists but not ours (alive).
// Mirrors nonce-store.js's check; needed by reclaimStaleLockIfDead's
// hold-and-verify path so a young-but-orphaned lock from a crashed writer is
// still reclaimable before the 60s mtime cap.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === "EPERM") return true;
    return false;
  }
}

// tryCreateLock — create the lock via O_CREAT|O_EXCL|O_NOFOLLOW, then verify
// via fstat(fd) that nlink === 1. The nlink check defeats the swap-during-
// acquire race: between our open() and our first use, another writer's
// recovery path could unlink LOCK_PATH and recreate it. If that happens, the
// file we hold a fd on becomes a zombie (nlink === 0 after unlink, or a
// different inode hard-linked over the path); writes to it would not be
// visible to the next process consulting LOCK_PATH. If the verification
// fails, close the fd, ignore the lock body (it never landed at LOCK_PATH
// from any consumer's perspective), and surface failure so acquireLock
// re-attempts via the normal EEXIST loop.
function tryCreateLock(nowIso) {
  let fd;
  try {
    fd = openSync(LOCK_PATH, LOCK_FLAGS, LOCK_MODE);
  } catch (e) {
    if (e && e.code === "EEXIST") return null;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (st.nlink !== 1) {
      // Either nlink === 0 (someone unlinked our fresh lock) or > 1
      // (impossible under O_EXCL + 0o600 but defensive). Drop and retry.
      closeSync(fd);
      return null;
    }
    const body = JSON.stringify({ pid: process.pid, heartbeat_ts: nowIso });
    writeSync(fd, body);
    fsyncSync(fd);
    return fd;
  } catch (e) {
    try { closeSync(fd); } catch { /* ignore */ }
    throw e;
  }
}

// reclaimStaleLockIfDead — hold-and-verify discipline (round-15 C-NEW-1).
//
// Path-vs-fd TOCTOU is the failure mode being closed:
//   T0: writer A statSyncs LOCK_PATH, sees old mtime → decides to unlink
//   T1: writer A unlinks LOCK_PATH
//   T2: writer B creates a fresh LOCK_PATH (O_EXCL succeeds)
//   T3: writer C statSyncs LOCK_PATH, sees fresh-but-stale mtime → unlinks
//   T4: writer D creates ANOTHER fresh LOCK_PATH; both B and D believe they
//       hold the lock; both append to the audit log.
//
// Fix: every unlink is gated on "the path resolves to the same inode I
// inspected". We do this by openSync'ing the suspect lock with
// O_RDONLY|O_NOFOLLOW (gets fd_a + inode_a via fstat), re-checking the
// staleness predicate against the fstat-derived sample (so the dead/old
// decision is bound to inode_a, not whatever currently lives at the path),
// and unlinking only after a final statSync of LOCK_PATH confirms it still
// points to inode_a. If a different inode lives at the path, abort —
// someone else's recovery already replaced the lock and the new one is not
// ours to remove. The race losers' next tryCreateLock will see EEXIST on
// the new lock and back off normally.
//
// Two writers passing the same staleness check simultaneously would each
// open fd's on the SAME inode and each call unlinkSync(LOCK_PATH). That is
// idempotent against the same inode — both succeed (or one sees ENOENT
// after the other completed), and the inode is gone exactly once.
function reclaimStaleLockIfDead() {
  // Open with O_NOFOLLOW so a symlink replacement at LOCK_PATH does not
  // trick us into unlinking the wrong file.
  let fdA;
  try {
    fdA = openSync(LOCK_PATH, LOCK_INSPECT_FLAGS);
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    if (e && e.code === "ELOOP") return false; // symlink — refuse to touch
    throw e;
  }
  try {
    const stA = fstatSync(fdA);
    const inoA = stA.ino;
    const ageMs = Date.now() - stA.mtimeMs;
    // Read the sidecar body bound to fdA (NOT path) so pid-dead is decided
    // against the file we are about to unlink, not whatever the path
    // currently points at.
    let pid = null;
    if (stA.size > 0 && stA.size < 4096) {
      const buf = Buffer.alloc(stA.size);
      try {
        readSync(fdA, buf, 0, stA.size, 0);
        const text = buf.toString("utf8").trim();
        if (text !== "") {
          try {
            const body = JSON.parse(text);
            if (body && Number.isInteger(body.pid)) pid = body.pid;
          } catch { /* malformed sidecar body — treat as dead */ }
        }
      } catch { /* read failed — treat as dead */ }
    }
    const dead = pid == null || !pidAlive(pid);
    const old = ageMs > CAPS.STALE_LOCK_RECOVERY_SECONDS * 1000;
    if (!dead && !old) return false;

    // Verify the path still resolves to inoA before unlinking. If a different
    // inode lives there (someone already reclaimed and recreated), abort
    // without unlinking — that is not our lock to remove.
    let stPath;
    try {
      stPath = statSync(LOCK_PATH);
    } catch (e) {
      // Path already gone — another reclaimer beat us. That is success from
      // our perspective: the stale lock is no longer occupying the path.
      if (e && e.code === "ENOENT") return true;
      throw e;
    }
    if (stPath.ino !== inoA) {
      // Different file at the path now — leave it alone.
      return false;
    }
    try {
      unlinkSync(LOCK_PATH);
    } catch (e) {
      if (!(e && e.code === "ENOENT")) throw e;
    }
    return true;
  } finally {
    try { closeSync(fdA); } catch { /* ignore */ }
  }
}

function acquireLock(nowIso) {
  const start = Date.now();
  let fd = tryCreateLock(nowIso);
  if (fd != null) return fd;
  reclaimStaleLockIfDead();
  while (Date.now() - start < LOCK_ACQUIRE_TIMEOUT_MS) {
    fd = tryCreateLock(nowIso);
    if (fd != null) return fd;
    const deadline = Date.now() + LOCK_BACKOFF_MS;
    while (Date.now() < deadline) { /* tight spin; lock is typically free */ }
    reclaimStaleLockIfDead();
  }
  throw new Error("policy-events: could not acquire lock within budget");
}

function releaseLock(fd) {
  try { closeSync(fd); } catch { /* ignore */ }
  try { unlinkSync(LOCK_PATH); } catch (e) {
    if (!(e && e.code === "ENOENT")) {
      // Best-effort; next acquirer's stale-reclaim recovers.
    }
  }
}

// Active-file path derived from a Date instance. Local-timezone month-of-write
// per spec § Rotation. Exported separately as currentActiveFile(now) so the
// supervisor and verifier can emit `policy_events_active_file` in memory_health
// without re-deriving the rule.
function activeFilePath(now) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 0-indexed -> 1-indexed
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  return join(POLICY_DIR, `${FILE_PREFIX}${yyyy}-${mm}${FILE_SUFFIX}`);
}

function ensurePolicyDir() {
  if (!existsSync(POLICY_DIR)) {
    mkdirSync(POLICY_DIR, { recursive: true, mode: 0o700 });
  }
}

// Touch-create the active file with mode 0600 when absent. Using openSync +
// closeSync rather than writeFileSync("") so we never overwrite an existing
// file's permissions; appendFileSync's default mode 0666 would otherwise be
// trimmed by umask but we want the explicit 0600 — secrets-adjacent log.
function ensureActiveFile(filePath) {
  if (existsSync(filePath)) return;
  const fd = openSync(filePath, "a", 0o600);
  closeSync(fd);
}

// validateAndSerializePolicyEvent(event) -> { line, checksum }
//
// W3 group-commit extraction: the per-event validation + serialization that
// used to live inline in appendPolicyEvent. Every error string keeps the
// "appendPolicyEvent:" prefix BYTE-IDENTICAL to the pre-W3 messages — they
// are greppable/machine-parseable and existing callers (nonce-store, MCP
// token paths, put.js, recall-feedback-emitter, hard-gates) match on them.
//
// Order of gates (unchanged): plain-object -> kind non-empty -> kind in
// EVENT_KINDS -> FORBIDDEN_FIELDS secret-leak guard -> validatePerKindShape
// -> caller-supplied-checksum guard -> checksum compute.
function validateAndSerializePolicyEvent(event) {
  if (event == null || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("appendPolicyEvent: event must be a plain object");
  }
  if (typeof event.kind !== "string" || event.kind === "") {
    throw new Error("appendPolicyEvent: event.kind must be a non-empty string");
  }
  if (!EVENT_KINDS_SET.has(event.kind)) {
    throw new Error(
      `appendPolicyEvent: unknown event.kind "${event.kind}" (not in EVENT_KINDS)`
    );
  }
  for (const forbidden of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(event, forbidden)) {
      throw new Error(
        `appendPolicyEvent: event contains forbidden field "${forbidden}" (secret-leak guard)`
      );
    }
  }
  // Per-kind shape validation (synthesis-wave additions only; pre-existing
  // kinds default to no-op for back-compat). Throws on schema mismatch
  // with a stable, greppable error string. See validatePerKindShape
  // header for the back-compat posture rationale.
  validatePerKindShape(event);
  if (Object.prototype.hasOwnProperty.call(event, "checksum")) {
    // The caller never supplies the checksum — we compute it. This guard
    // prevents accidentally double-checksumming a re-emitted event or being
    // tricked into recording a wrong checksum.
    throw new Error(
      "appendPolicyEvent: event must not carry a checksum field; it is computed here"
    );
  }

  // Per-line checksum (M8): blake2b512 truncated to 16 bytes over
  // canonical_json(event-without-checksum). Stored as the last key.
  const checksum = blake2b512TruncTo16Hex(
    Buffer.from(canonicalJson(event), "utf8"),
  );
  const stored = { ...event, checksum };
  const line = JSON.stringify(stored) + "\n";
  return { line, checksum };
}

// W3 test seam — data-file fsync counter, following the _set*ForTest idiom.
// Incremented ONLY at the data-file fsyncSync site inside
// appendPolicyEventsBatch; the lock-body fsync in tryCreateLock is NOT
// counted. Lets the group-commit test assert "N events -> exactly 1 fsync"
// without stubbing node:fs.
let __dataFsyncCountForTest = 0;
export function _getDataFsyncCountForTest() {
  return __dataFsyncCountForTest;
}
export function _resetDataFsyncCountForTest() {
  __dataFsyncCountForTest = 0;
}

// Internal chunk bound: one lock acquisition + one fsync per <=500-event
// chunk. A huge cascade burst can therefore never balloon a single
// concatenated write Buffer (or hold the sidecar lock unboundedly long).
const BATCH_CHUNK_SIZE = 500;

// appendPolicyEventsBatch(events, { now } = {}) -> [{written_to, checksum}]
// in input order.
//
// W3 group-commit: N events cost ceil(N/500) lock+fsync cycles instead of N.
// The July 2026 measurement that motivated this: ~1.06M per-event fsyncs from
// mail drop events alone, each programming a NAND page for a ~200-byte line.
//
// Guarantees (same recovery-scanner-compatible row format as ever):
//   - EVERY event is validated + serialized (kind gate, FORBIDDEN_FIELDS,
//     validatePerKindShape, caller-checksum guard, checksum compute) BEFORE
//     any lock is taken or any byte is written — an invalid event anywhere
//     in the batch means nothing lands on disk (all-or-nothing per chunk,
//     and since validation is up-front, all-or-nothing for the whole call).
//   - writeTime is derived ONCE per call and the active path is re-derived
//     from it inside each chunk's critical section, so a single batch never
//     spans two month files (monthly local-timezone rotation preserved).
//   - Per chunk: acquire the sidecar lock, ensureActiveFile (0600 openSync
//     "a" idiom — appendFileSync is never used), open ONE fd, write all
//     lines as one concatenated Buffer via a writeSync loop, fsyncSync ONCE,
//     close, release the lock in finally. Lock semantics against concurrent
//     writers are untouched.
export function appendPolicyEventsBatch(events, { now } = {}) {
  if (!Array.isArray(events)) {
    throw new Error("appendPolicyEventsBatch: events must be an array");
  }
  if (events.length === 0) return [];

  // Validate + serialize ALL events before taking the lock. A throw here
  // leaves the audit log byte-untouched.
  const serialized = events.map((event) => validateAndSerializePolicyEvent(event));

  const writeTime = now instanceof Date ? now : new Date();
  const nowIso = writeTime.toISOString();
  ensurePolicyDir();

  const results = new Array(serialized.length);
  for (let start = 0; start < serialized.length; start += BATCH_CHUNK_SIZE) {
    const chunk = serialized.slice(start, start + BATCH_CHUNK_SIZE);
    // Acquire the lock BEFORE computing the active-file path so a
    // month-boundary rotation during write is observed atomically by the
    // writer (the path is re-derived inside the critical section).
    const lockFd = acquireLock(nowIso);
    let dataFd = -1;
    try {
      const filePath = activeFilePath(writeTime);
      ensureActiveFile(filePath);

      // Open + append + fsync explicitly. appendFileSync(filePath, ...)
      // opens, writes, closes — but does not fsync. We need the fsync inside
      // the lock so the durability boundary aligns with the lock release.
      dataFd = openSync(filePath, "a", 0o600);
      const buf = Buffer.from(chunk.map((s) => s.line).join(""), "utf8");
      let written = 0;
      while (written < buf.length) {
        written += writeSync(dataFd, buf, written, buf.length - written);
      }
      fsyncSync(dataFd);
      __dataFsyncCountForTest += 1;
      for (let i = 0; i < chunk.length; i++) {
        results[start + i] = { written_to: filePath, checksum: chunk[i].checksum };
      }
    } finally {
      if (dataFd !== -1) {
        try { closeSync(dataFd); } catch { /* ignore */ }
      }
      releaseLock(lockFd);
    }
  }
  return results;
}

// appendPolicyEvent(event, { now } = {}) -> {written_to, checksum}
//
// `event` must be a plain object with a string `kind` from EVENT_KINDS and
// must not contain any forbidden field (see FORBIDDEN_FIELDS). `now` is an
// optional Date override for tests — production callers omit it and the
// helper takes new Date() (the same path validation.js's serverTs uses).
//
// W3: reimplemented as a batch of one so every existing caller (nonce-store,
// MCP token consume/reject, put.js, recall-feedback-emitter, hard-gates)
// keeps its exact return shape, its error strings, and synchronous per-call
// durability (the single-event path still locks + fsyncs before returning).
//
// JSON.stringify (not canonical_json) for the written line: this is an audit
// log, not a signed payload — readability and append-speed win over
// bit-identity. The CHECKSUM is computed over canonical_json (RFC 8785 JCS)
// of the same logical object so the recovery scanner can re-compute it
// deterministically regardless of key order in the stored line.
export function appendPolicyEvent(event, { now } = {}) {
  return appendPolicyEventsBatch([event], { now })[0];
}

// listRotatedFiles() -> string[] of absolute paths, chronological order
// (oldest first). Filenames sort lexicographically by YYYY-MM, which is
// also chronological; readdir does not guarantee order so we sort.
export function listRotatedFiles() {
  if (!existsSync(POLICY_DIR)) return [];
  const entries = readdirSync(POLICY_DIR);
  const matches = [];
  for (const name of entries) {
    if (!name.startsWith(FILE_PREFIX)) continue;
    if (!name.endsWith(FILE_SUFFIX)) continue;
    // Confirm the YYYY-MM segment is well-formed; reject names like
    // "policy-events-corrupt.jsonl" so the operator's archival sandbox
    // never bleeds into the daemon's view of history.
    const mid = name.slice(FILE_PREFIX.length, name.length - FILE_SUFFIX.length);
    if (!/^\d{4}-\d{2}$/.test(mid)) continue;
    matches.push(join(POLICY_DIR, name));
  }
  matches.sort(); // lexicographic == chronological for YYYY-MM
  return matches;
}

// currentActiveFile({ now } = {}) -> absolute path for the current
// local-time month. Mirrors `memory_health`'s `policy_events_active_file`
// field. Test code may pass a fixed Date via `now` for determinism.
export function currentActiveFile({ now } = {}) {
  const writeTime = now instanceof Date ? now : new Date();
  return activeFilePath(writeTime);
}

// policyEventsDiskBytes() -> number, summed across every rotated file in
// the policy directory. Mirrors `memory_health`'s
// `policy_events_disk_bytes`. Missing files contribute 0 (don't throw —
// the metric is best-effort observability, not a hard invariant).
export function policyEventsDiskBytes() {
  let total = 0;
  for (const filePath of listRotatedFiles()) {
    try {
      total += statSync(filePath).size;
    } catch {
      // File may have been archived/removed between readdir and stat;
      // skip silently — the operator-driven offline archival path is
      // expected per spec § Rotation.
    }
  }
  return total;
}
