// Consumed-nonce store. See kb/mcp-surface.md § Consumed-nonce store.
//
// Mediates the single-use property of every confirmation token (user-issued
// and daemon-signed). One critical section per privileged call; no agent or
// hook reaches it directly. The verifier resolves `tool` to the actual MCP
// tool name BEFORE calling checkAndConsume — never trust the caller's claim.
//
// Files (canonical, per SYMBOL_CONTRACT):
//   <MEMORY_ROOT>/policy/consumed-nonces.jsonl    append-only log
//   <MEMORY_ROOT>/policy/consumed-nonces.lock     sidecar lock + heartbeat
//
// Line format (one JSON object, "\n"-terminated, no trailing whitespace):
//   {nonce_hash, tool, accepted_at, checksum}
//   checksum = blake2b512-truncated-to-16-bytes lowercase hex of
//     canonical_json({nonce_hash, tool, accepted_at})
//
// Lock discipline ("acquireExclusiveLockFile" pattern; see
// kb/architecture.md § acquireExclusiveLockFile). Node has no built-in
// flock(2); we implement the same invariant via O_CREAT|O_EXCL|O_NOFOLLOW
// atomic create on the .lock sidecar file. File presence IS the lock.
// The lock body is canonical_json({pid, heartbeat_ts}). Open file descriptors
// MUST also pass `fstat(fd).nlink === 1` to defeat a swap-during-acquire race
// where the lock file is unlinked and recreated between open and stat. Stale
// reclaim if (a) the recorded PID is dead (process.kill(pid, 0) -> ESRCH) OR
// (b) the file's mtime is older than STALE_LOCK_RECOVERY_SECONDS.
// Heartbeat refresh during long critical sections is the caller's job; the
// short checkAndConsume path does not need one (the whole section is bounded).
//
// Checksum note. The spec is frozen at "blake2b512 truncated to 16 bytes"
// (kb/mcp-surface.md § Consumed-nonce store: "Why 'blake2b512 truncated to
// 16 bytes' and not 'blake2b-128'"). A native blake2b-128 (BLAKE2b with
// digest_length=16) is NOT the same value as blake2b512 truncated to 16
// bytes — BLAKE2 folds the digest length into its IV, so the two engines
// produce different bytes for the same input. We MUST use blake2b512 +
// .subarray(0, 16). The earlier comment text saying "blake2b-128" was a
// spec-drift artefact; the implementation has always been correct.

import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";

import { canonicalJson, CAPS } from "./validation.js";
import { serverTs } from "./envelope.js";
import { appendPolicyEvent } from "./policy-events.js";
import {
  POLICY_DIR,
  consumedNoncesPath,
  consumedNoncesLockPath,
} from "./config.js";

// ---------------------------------------------------------------------------
// Paths — sourced from lib/config.js so MEMORY_ROOT / POLICY_BASE_DIR env
// overrides redirect every read/write in this module. Do NOT re-derive the
// root inline here.
// ---------------------------------------------------------------------------

const STORE_PATH = consumedNoncesPath();
// Machine-readable marker on the mid-file-corruption throw (err.code).
export const NONCE_STORE_CORRUPTED = "NONCE_STORE_CORRUPTED";
const LOCK_PATH = consumedNoncesLockPath();

// ---------------------------------------------------------------------------
// Open flags
// ---------------------------------------------------------------------------

// O_* flags live on fs.constants, NOT os.constants (os.constants only exposes
// dlopen/errno/signals/priority). Importing from the wrong namespace yields
// `undefined`, which OR-collapses to 0, which silently degrades every
// openSync() in this file to a plain O_RDONLY — defeating O_NOFOLLOW + O_EXCL.
// The Phase 1 nonce-store test surfaced this drift; documented here so any
// future refactor knows why fs is the right source.
const O_RDWR = fsConstants.O_RDWR;
const O_APPEND = fsConstants.O_APPEND;
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;
const O_WRONLY = fsConstants.O_WRONLY;

// Data file: read + append + create-if-absent, refuse to follow symlinks.
const STORE_FLAGS = O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW;
// Lock file: create-or-fail (atomic), write-only, refuse to follow symlinks.
const LOCK_FLAGS = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;

const FILE_MODE = 0o600;

// Bounded retry budget for lock acquisition. Cap at STALE_LOCK_RECOVERY_SECONDS
// because if we have not acquired by then the holder is either truly stuck
// (and we will reclaim) or under unusual load (and we should surface upstream).
const LOCK_ACQUIRE_TIMEOUT_MS = CAPS.STALE_LOCK_RECOVERY_SECONDS * 1000;
const LOCK_BACKOFF_MS = 25;

// ---------------------------------------------------------------------------
// Checksum: blake2b512 truncated to 16 bytes (32 hex chars), lowercase hex.
// See header note for why this is NOT a native blake2b-128 engine.
// ---------------------------------------------------------------------------

function blake2b512TruncTo16Hex(bytes) {
  const full = createHash("blake2b512").update(bytes).digest();
  return full.subarray(0, 16).toString("hex");
}

function lineChecksum(nonceHash, tool, acceptedAt) {
  const canonical = canonicalJson({
    nonce_hash: nonceHash,
    tool,
    accepted_at: acceptedAt,
  });
  return blake2b512TruncTo16Hex(Buffer.from(canonical, "utf8"));
}

// ---------------------------------------------------------------------------
// Lock acquisition / release
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH: no such process. EPERM: process exists but not ours -> still alive.
    if (e && e.code === "EPERM") return true;
    return false;
  }
}

function readLockSidecar() {
  try {
    const fd = openSync(LOCK_PATH, O_RDWR | O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (st.nlink !== 1) {
        throw new Error("nonce-store lock has unexpected nlink");
      }
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      const text = buf.toString("utf8").trim();
      const parsed = text === "" ? null : JSON.parse(text);
      return { mtimeMs: st.mtimeMs, body: parsed };
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    if (e instanceof SyntaxError) return { mtimeMs: 0, body: null };
    throw e;
  }
}

function tryCreateLock(now) {
  try {
    const fd = openSync(LOCK_PATH, LOCK_FLAGS, FILE_MODE);
    const body = canonicalJson({
      pid: process.pid,
      heartbeat_ts: now,
    });
    writeSync(fd, body);
    fsyncSync(fd);
    return fd;
  } catch (e) {
    if (e && e.code === "EEXIST") return null;
    throw e;
  }
}

function reclaimStaleLockIfDead(nowEpochMs) {
  const info = readLockSidecar();
  if (info == null) return false;
  const age = nowEpochMs - info.mtimeMs;
  const pid = info.body && Number.isInteger(info.body.pid) ? info.body.pid : null;
  const dead = pid == null || !pidAlive(pid);
  const stale = age > CAPS.STALE_LOCK_RECOVERY_SECONDS * 1000;
  if (dead || stale) {
    try {
      unlinkSync(LOCK_PATH);
    } catch (e) {
      if (!(e && e.code === "ENOENT")) throw e;
    }
    return true;
  }
  return false;
}

function acquireLock(nowIso) {
  const start = Date.now();
  // First attempt without delay.
  let fd = tryCreateLock(nowIso);
  if (fd != null) return fd;
  // Try a stale reclaim, then loop with bounded backoff.
  reclaimStaleLockIfDead(Date.now());
  while (Date.now() - start < LOCK_ACQUIRE_TIMEOUT_MS) {
    fd = tryCreateLock(nowIso);
    if (fd != null) return fd;
    // Busy-wait with a tiny sync delay; not a hot loop in practice because
    // privileged calls are rare and the critical section is short.
    const deadline = Date.now() + LOCK_BACKOFF_MS;
    while (Date.now() < deadline) {
      // intentional: spin briefly to avoid pulling in setTimeout / event-loop
      // hooks from inside what should be a tight sync acquisition path.
    }
    reclaimStaleLockIfDead(Date.now());
  }
  throw new Error("nonce-store: could not acquire lock within budget");
}

function releaseLock(fd) {
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(LOCK_PATH);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) {
      // Surface as a non-fatal hint; the next acquirer's stale-reclaim will
      // recover. Do not throw out of release path.
    }
  }
}

// ---------------------------------------------------------------------------
// Store reads
// ---------------------------------------------------------------------------

function openStore() {
  const fd = openSync(STORE_PATH, STORE_FLAGS, FILE_MODE);
  const st = fstatSync(fd);
  if (st.nlink !== 1) {
    closeSync(fd);
    throw new Error("nonce-store: file has unexpected nlink");
  }
  return { fd, size: st.size };
}

function readAllBytes(fd, size) {
  if (size === 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (n === 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

// Scan parsed lines until either nonce match or end-of-file. Returns
//   { matched: true, lineNo } if nonce already consumed,
//   { matched: false, lines: [...parsed...] } otherwise.
// On any per-line checksum failure or parse error, the line is treated as
// invalid; if it is the final line (tail) the caller's startup-recovery path
// (ensureStoreReady) will truncate. Mid-file failure throws — this function
// is only called from inside the critical section, so the throw exits cleanly.
function scanForMatch(text, nonceHash) {
  if (text === "") return { matched: false };
  const lines = text.split("\n");
  // Trailing newline implies an empty final element; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Tail-corruption case is handled by ensureStoreReady on startup; from
      // inside the hot path we cannot tell tail from mid-file safely, so we
      // refuse to proceed rather than silently accept a nonce that may be a
      // duplicate hiding behind a torn line. The caller surfaces this.
      throw new Error("nonce-store: malformed line during scan");
    }
    if (
      !parsed ||
      typeof parsed.nonce_hash !== "string" ||
      typeof parsed.tool !== "string" ||
      typeof parsed.accepted_at !== "string" ||
      typeof parsed.checksum !== "string"
    ) {
      throw new Error("nonce-store: line missing required fields");
    }
    const expected = lineChecksum(parsed.nonce_hash, parsed.tool, parsed.accepted_at);
    if (expected !== parsed.checksum) {
      throw new Error("nonce-store: line checksum mismatch");
    }
    if (parsed.nonce_hash === nonceHash) {
      return { matched: true, lineNo: i };
    }
  }
  return { matched: false };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// checkAndConsume — atomic single-use enforcement.
// Returns:
//   {ok: true,  accepted_at: <ISO-8601>}                        nonce newly recorded
//   {ok: false, reason: "nonce_replayed"}                       nonce already present
// opts.now (ISO-8601) is an override-for-test seam; production callers pass
// nothing and let serverTs() stamp.
export function checkAndConsume(nonceHash, tool, opts = {}) {
  if (typeof nonceHash !== "string" || !/^[0-9a-f]{64}$/.test(nonceHash)) {
    throw new Error("nonce-store: nonceHash must be lowercase 64-hex sha256");
  }
  if (typeof tool !== "string" || tool === "") {
    throw new Error("nonce-store: tool must be a non-empty string");
  }
  const now = typeof opts.now === "string" ? opts.now : serverTs();

  const lockFd = acquireLock(now);
  let storeFd = -1;
  try {
    const opened = openStore();
    storeFd = opened.fd;
    const bytes = readAllBytes(storeFd, opened.size);
    const scan = scanForMatch(bytes.toString("utf8"), nonceHash);
    if (scan.matched) {
      return { ok: false, reason: "nonce_replayed" };
    }
    const acceptedAt = now;
    const checksum = lineChecksum(nonceHash, tool, acceptedAt);
    const line =
      canonicalJson({
        nonce_hash: nonceHash,
        tool,
        accepted_at: acceptedAt,
        checksum,
      }) + "\n";
    writeSync(storeFd, line);
    fsyncSync(storeFd);
    return { ok: true, accepted_at: acceptedAt };
  } finally {
    if (storeFd !== -1) {
      try {
        closeSync(storeFd);
      } catch {
        // ignore
      }
    }
    releaseLock(lockFd);
  }
}

// ensureStoreReady — supervisor startup helper.
//   0. Create the policy directory (0700) if absent, so a first boot on an
//      empty root is not misreported as corruption. Any failure here
//      surfaces as the real fs error (ENOENT/EACCES/ENOTDIR ...).
//   1. Reclaim stale lock if present.
//   2. If the file is missing, create it empty (atomic, 0600).
//   3. Scan tail-to-head: detect the first checksum mismatch.
//        - If at tail (no valid lines after): truncate to last-good-offset,
//          emit policy.token.rejected reason: "corrupt_tail_truncated".
//        - If mid-file (valid checksums follow): emit reason:
//          "nonce_store_corrupted" and throw — refuse to proceed. The
//          thrown error carries code NONCE_STORE_CORRUPTED so callers can
//          tell real corruption from any other startup failure.
// Returns {reclaimed_stale_lock, truncated_corrupt_tail}.
export function ensureStoreReady(opts = {}) {
  const now = typeof opts.now === "string" ? opts.now : serverTs();
  // First boot on an empty root: the policy dir does not exist yet. Create it
  // before any lock work (same pattern as policy-events.js ensurePolicyDir);
  // recursive mkdir is a no-op on an existing dir and never re-modes it.
  mkdirSync(POLICY_DIR, { recursive: true, mode: 0o700 });
  const reclaimedStaleLock = reclaimStaleLockIfDead(Date.now());

  // Acquire the lock for the recovery sweep so a concurrent
  // checkAndConsume cannot observe a half-recovered file.
  const lockFd = acquireLock(now);
  let truncatedCorruptTail = false;
  let storeFd = -1;
  try {
    const opened = openStore();
    storeFd = opened.fd;
    const bytes = readAllBytes(storeFd, opened.size);
    const text = bytes.toString("utf8");
    if (text === "") {
      return {
        reclaimed_stale_lock: reclaimedStaleLock,
        truncated_corrupt_tail: false,
      };
    }
    // Walk line-by-line, tracking the byte offset of the last fully-valid line.
    // Any line that fails parse or checksum becomes a candidate "first bad".
    // If anything valid follows: mid-file corruption -> halt. Otherwise: torn
    // tail -> truncate to the byte offset of the start of the first bad line.
    let offset = 0;
    let lastGoodOffset = 0;
    let firstBadOffset = -1;
    let validAfterBad = false;
    const rawLines = text.split("\n");
    // If text ends with "\n" the last element is "" — we should not treat it
    // as a bad line; skip the trailing empty.
    const last = rawLines.length - 1;
    for (let i = 0; i <= last; i++) {
      const line = rawLines[i];
      const lineLen = Buffer.byteLength(line, "utf8");
      // Final empty element after trailing "\n": offset moves over the "\n"
      // already consumed by the previous iteration's lineLen+1; do nothing.
      if (i === last && line === "") break;
      const ok = isLineValid(line);
      if (ok && firstBadOffset === -1) {
        // Advance lastGoodOffset to end of this line + its terminating "\n".
        offset += lineLen + 1;
        lastGoodOffset = offset;
      } else if (!ok && firstBadOffset === -1) {
        firstBadOffset = offset;
        offset += lineLen + 1;
      } else if (ok && firstBadOffset !== -1) {
        validAfterBad = true;
        break;
      } else {
        offset += lineLen + 1;
      }
    }
    if (firstBadOffset !== -1) {
      if (validAfterBad) {
        // Mid-file corruption — refuse to proceed.
        appendPolicyEvent({
          kind: "policy.token.rejected",
          nonce_hash_or_null: null,
          reason: "nonce_store_corrupted",
          attempted_at: now,
        });
        const corrupt = new Error("nonce-store: mid-file corruption; refusing to proceed");
        corrupt.code = NONCE_STORE_CORRUPTED;
        throw corrupt;
      }
      // Tail corruption — truncate to last good offset via tmp+rename.
      const goodSlice = bytes.subarray(0, lastGoodOffset);
      writeFileAtomic(STORE_PATH, goodSlice);
      truncatedCorruptTail = true;
      appendPolicyEvent({
        kind: "policy.token.rejected",
        nonce_hash_or_null: null,
        reason: "corrupt_tail_truncated",
        attempted_at: now,
      });
    }
    return {
      reclaimed_stale_lock: reclaimedStaleLock,
      truncated_corrupt_tail: truncatedCorruptTail,
    };
  } finally {
    if (storeFd !== -1) {
      try {
        closeSync(storeFd);
      } catch {
        // ignore
      }
    }
    releaseLock(lockFd);
  }
}

function isLineValid(line) {
  if (line === "") return false;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (
    !parsed ||
    typeof parsed.nonce_hash !== "string" ||
    typeof parsed.tool !== "string" ||
    typeof parsed.accepted_at !== "string" ||
    typeof parsed.checksum !== "string"
  ) {
    return false;
  }
  const expected = lineChecksum(parsed.nonce_hash, parsed.tool, parsed.accepted_at);
  return expected === parsed.checksum;
}

// pruneExpired — compact by rewriting the file dropping entries older than
// CONSUMED_NONCE_TTL_SECONDS. Atomic: write tmp then rename. opts.now lets
// tests pin the clock.
export function pruneExpired(opts = {}) {
  const nowIso = typeof opts.now === "string" ? opts.now : serverTs();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error("nonce-store: opts.now must be a valid ISO-8601 string");
  }
  const cutoffMs = nowMs - CAPS.CONSUMED_NONCE_TTL_SECONDS * 1000;

  const lockFd = acquireLock(nowIso);
  let storeFd = -1;
  let prunedCount = 0;
  try {
    const opened = openStore();
    storeFd = opened.fd;
    const bytes = readAllBytes(storeFd, opened.size);
    const text = bytes.toString("utf8");
    if (text === "") {
      return { pruned_count: 0 };
    }
    const kept = [];
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (!isLineValid(line)) {
        // Defensive: pruneExpired should run after ensureStoreReady, but if
        // it encounters an invalid line we drop it (it was already going to
        // be unreadable by checkAndConsume).
        prunedCount += 1;
        continue;
      }
      const parsed = JSON.parse(line);
      const acceptedMs = Date.parse(parsed.accepted_at);
      if (!Number.isFinite(acceptedMs) || acceptedMs < cutoffMs) {
        prunedCount += 1;
        continue;
      }
      kept.push(line);
    }
    const out = kept.length === 0 ? "" : kept.join("\n") + "\n";
    writeFileAtomic(STORE_PATH, Buffer.from(out, "utf8"));
    return { pruned_count: prunedCount };
  } finally {
    if (storeFd !== -1) {
      try {
        closeSync(storeFd);
      } catch {
        // ignore
      }
    }
    releaseLock(lockFd);
  }
}

// _resetForTest — truncate file (and remove lock if present). DOCUMENTED
// TEST-ONLY: production code MUST NOT call this; doing so opens a replay
// window for every unexpired token. Marker `_` prefix mirrors the
// recall-log.js _resetRecallLog convention.
export function _resetForTest() {
  try {
    writeFileSync(STORE_PATH, "", { mode: FILE_MODE, flag: "w" });
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
  try {
    unlinkSync(LOCK_PATH);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// writeFileAtomic — write to tmp + fsync + rename over target. Both writes
// honor 0600 mode. Used by pruneExpired and ensureStoreReady's tail-truncate.
function writeFileAtomic(targetPath, bytes) {
  const tmpPath = targetPath + ".tmp";
  const fd = openSync(tmpPath, O_RDWR | O_CREAT | O_NOFOLLOW, FILE_MODE);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
}

// Exported paths for tests / observability. Not part of the runtime contract.
export const _PATHS = Object.freeze({
  STORE_PATH,
  LOCK_PATH,
  POLICY_DIR,
});
