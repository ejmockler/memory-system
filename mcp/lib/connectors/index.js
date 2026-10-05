// Shared connector infrastructure. The base abstractions the four Phase 2b
// connector impl agents (imessage, screentime, git-log-local, github-events)
// target so each daemon does not re-derive auth, cursor, idempotent append,
// source_policy stamping, edit/delete-as-event, and health.
//
// Authoritative spec: kb/connectors-survey.md § Top-5 connector skeletons +
// kb/ingestion.md § Connector contract. Round-20 close ratified C1
// (authorship trumps audience) and C2 (second_party_dm parity dampener) —
// both encoded in the per-connector classifier the IMPL agents pass to
// `appendLedgerRow`; this module is policy-agnostic and never inspects
// `consent_basis` or `deletion_semantics`.
//
// The six-point contract from kb/ingestion.md § Connector contract:
//
//   1. AUTH — caller owns policy/<source>-{session|token}.json at 0600 (or
//      no creds for read-only Library tails). This module does not touch
//      credentials; that lives in the per-connector daemon.
//   2. CURSOR — persisted at connectors/<source>/state.json with the
//      {cursor, last_appended_ts, last_appended_id, error_count, ...} shape.
//      `readCursor` + `writeCursor` round-trip with atomic tmp+rename+fsync.
//   3. IDEMPOTENT APPEND — `appendLedgerRow` dedupes on
//      `row.source_msg_id` against a bounded tail-read of the source ledger
//      (CAPS.CONNECTOR_DEDUP_TAIL_LINES). Out-of-window duplicates can
//      slip through; that is acceptable — corroboration at the salience
//      layer absorbs the long-tail case and the tail window covers
//      every realistic restart-recovery scenario.
//   4. SOURCE_POLICY STAMPING — caller supplies `sourcePolicyForRow(row)`
//      at construction; this module invokes it per append and stamps the
//      returned `{deletion_semantics, consent_basis}` onto the row before
//      writing. Stamping HERE (not in the caller) guarantees no source-
//      ledger row lands without source_policy.
//   5. EDIT/DELETE-AS-EVENT — out of scope for this base class. Each
//      connector emits a NEW row with `kind: "reconstructed"` and
//      `derived_from: [original_source_msg_id]` via the normal
//      `appendLedgerRow` path. The base class does not mutate prior rows.
//   6. HEALTH — `reportHealth` returns {last_appended_ts,
//      last_cursor_advance_ts, error_rate, status} read from the cursor
//      state file. `listInstalledConnectors` enumerates every connector
//      with a state.json under connectors/.
//
// CRITICAL ROUND-20 C4 KILL-SWITCH MARKER: `applyConnectorRevoke`
// appends a `kind:"policy"` row to ledgers/memory.jsonl with
// `policy_kind:"connector_revoke"` + `target_source: source`. This is
// the AUTHORITATIVE marker the recall layer's transitive-orphan BFS
// reads (kb/connectors-survey.md § imessage kill switch step 3 — "Append
// a single policy event ... This is the AUTHORITATIVE marker the recall
// layer reads"). No other writer emits this marker; this is the single
// chokepoint.
//
// HERMETICITY: every path is sourced via lib/config.js helpers, which honor
// MEMORY_ROOT + per-dir env overrides. Tests redirect by setting env vars
// BEFORE the first dynamic import of this module. The atomic-write helpers
// fsync the parent directory after rename so power-cut at any point
// leaves either the prior state or the new state on disk — never both.

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, basename } from "node:path";

import {
  MEMORY_ROOT,
  memoryLedgerPath,
  connectorStatePath,
  connectorsDir,
} from "../config.js";
import { canonicalJson, CAPS } from "../validation.js";

// _isDuplicate tail-read sizing (bytes). dedupTailLines is a LINE budget,
// but the read itself must be BYTE-bounded: readFileSync of the whole ledger
// throws once the file crosses Node's ~512 MiB max string length
// (storage/sources/codex-cli.jsonl passed 191 MB in June 2026 and is still
// growing), and the old catch-all turned that permanent throw into
// "return false" — dedup silently OFF on every append with no error signal.
// That exact silent-disable already destroyed the git-log ledger via a
// sibling code path (94% duplicate rows). So we positional-read only the
// last
//   max(dedupTailLines * DEDUP_TAIL_AVG_LINE_BYTES, DEDUP_TAIL_MIN_READ_BYTES)
// bytes. 8 KiB/line is deliberately generous (typical connector rows are
// well under 1 KiB; codex-cli transcript rows run several KiB) so the byte
// window is a superset of the line window in every realistic ledger. A
// ledger whose average line exceeds 8 KiB just shrinks the effective
// window, which the contract already tolerates (out-of-window duplicates
// slip through — header § 3). Exported for the connector-base unit test.
export const DEDUP_TAIL_AVG_LINE_BYTES = 8192;
export const DEDUP_TAIL_MIN_READ_BYTES = 512 * 1024;

// O_* live on fs.constants (NOT os.constants — see policy-events.js header).
const LEDGER_O_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;
const LEDGER_FILE_MODE = 0o600;

// blake2b512 truncated to 16 bytes — mirrors nonce-store + memory.jsonl
// row-checksum discipline. See kb/mcp-surface.md § Consumed-nonce store for
// the rationale on truncated-blake2b512 over native blake2b-128.
function blake2b512TruncTo16Hex(bytes) {
  return createHash("blake2b512").update(bytes).digest().subarray(0, 16).toString("hex");
}

// fsyncDir — flush the parent directory entry after a rename or first-write
// so a power-cut between the data sync and the inode-link sync cannot lose
// the new file's existence. macOS APFS quirk + Linux ext4 default both need
// the explicit dir-fsync for full durability. Copied from
// distill-promote-fact.js for shape parity.
function fsyncDir(dirPath) {
  let dirFd = -1;
  try {
    dirFd = openSync(dirPath, fsConstants.O_RDONLY);
    fsyncSync(dirFd);
  } catch (err) {
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL") {
      throw err;
    }
  } finally {
    if (dirFd !== -1) {
      try { closeSync(dirFd); } catch { /* ignore */ }
    }
  }
}

// serverTs — local mirror of envelope.js's serverTs to avoid importing
// envelope.js (which pulls error-codes + the dispatch surface). Connectors
// only need the ISO string.
function serverTs() {
  return new Date().toISOString();
}

// ULID-shape monotonic id for ledger rows. The chat-claude-code.jsonl rows
// use "ulid_" + 24-char crockford-32 — we mirror the prefix and length so
// downstream readers (distill-promote-fact's source-ledger walk) do not see
// shape drift between connectors. The 24-char body is randomBytes-derived,
// not a real ULID time component; phase-2b connectors do not need the
// time-prefix monotonicity property because the row carries its own `ts`.
function generateLedgerRowId() {
  return "ulid_" + randomBytes(15).toString("base64url").replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 20);
}

// Resolve the per-source storage ledger path. Mirrors
// chatLedgerPath('claude-code') -> storage/sources/chat-claude-code.jsonl
// for non-chat sources we use storage/sources/<source>.jsonl directly.
// Callers supply absolute paths if they need to override (the imessage and
// screentime daemons will likely use the default).
function defaultSourceLedgerPath(source) {
  return join(MEMORY_ROOT, "storage", "sources", `${source}.jsonl`);
}

// =============================================================================
// ConnectorBase — the abstraction the four Phase 2b daemons compose with.
// =============================================================================

export class ConnectorBase {
  // Construct a connector bound to a specific source + on-disk paths +
  // source_policy classifier closure.
  //
  // Params:
  //   source              — short string used in storage/sources/<source>.jsonl
  //                         + connectors/<source>/state.json + every row's
  //                         `source` field. Required.
  //   sourceLedgerPath    — override the default storage/sources/<source>.jsonl.
  //                         Optional; defaults to MEMORY_ROOT-derived path.
  //   cursorPath          — override the default connectors/<source>/state.json.
  //                         Optional; defaults to MEMORY_ROOT-derived path.
  //   sourcePolicyForRow  — function(row) -> {deletion_semantics, consent_basis}.
  //                         Required. The base class never inspects the
  //                         classifier's logic; round-20 C1/C2 + the per-source
  //                         classifier rules from kb/connectors-survey.md live
  //                         in the impl agent's closure, not here.
  //   errorThreshold      — degraded threshold (default CAPS.CONNECTOR_ERROR_THRESHOLD).
  //   dedupTailLines      — how many trailing lines to scan for source_msg_id
  //                         dedup (default CAPS.CONNECTOR_DEDUP_TAIL_LINES).
  constructor({
    source,
    sourceLedgerPath,
    cursorPath,
    sourcePolicyForRow,
    errorThreshold,
    dedupTailLines,
  }) {
    if (typeof source !== "string" || source === "") {
      throw new Error("ConnectorBase: source must be a non-empty string");
    }
    if (typeof sourcePolicyForRow !== "function") {
      throw new Error(
        "ConnectorBase: sourcePolicyForRow must be a function (row) -> {deletion_semantics, consent_basis}",
      );
    }
    this.source = source;
    this.sourceLedgerPath = sourceLedgerPath || defaultSourceLedgerPath(source);
    this.cursorPath = cursorPath || connectorStatePath(source);
    this.sourcePolicyForRow = sourcePolicyForRow;
    this.errorThreshold = errorThreshold != null ? errorThreshold : CAPS.CONNECTOR_ERROR_THRESHOLD;
    this.dedupTailLines = dedupTailLines != null ? dedupTailLines : CAPS.CONNECTOR_DEDUP_TAIL_LINES;
  }

  // ---------------------------------------------------------------------------
  // Cursor — connectors/<source>/state.json
  // ---------------------------------------------------------------------------

  // readCursor: returns the parsed state object, or null if absent.
  // The shape is per-connector-extensible (each daemon stores its own native
  // cursor field — message.ROWID for iMessage, last-commit-sha for git, etc.)
  // but the base-mandated keys are:
  //   {cursor, last_appended_ts, last_appended_id, last_cursor_advance_ts, error_count}
  // Missing keys are returned as-is; callers handle defaults.
  // heavyCursorKeys — cursor fields whose size grows with corpus rather than
  // being O(1) hot state. Subclasses override. Listed keys are persisted to a
  // SIDECAR (state.heavy.json) that is rewritten only when its content
  // actually changes, instead of being re-serialized into state.json on every
  // poll alongside the O(1) fields.
  //
  // Why: state.json is rewritten every poll because last_polled_ts /
  // last_cursor_advance_ts are stamped with now(), so the bytes always differ.
  // Any corpus-sized map living in that object is therefore rewritten at poll
  // frequency regardless of whether it changed. Measured on codex-cli: a
  // 2.165 MB cursor rewritten every ~58 s to persist a 26-byte timestamp —
  // 3.2 GB/day, ~83,000x amplification on the marginal update, while the
  // source ledger it tracks had not grown in 16 hours.
  //
  // This is deliberately NOT a cap. The per-session maps stay unbounded and
  // complete; only the WRITE becomes proportional to real change. Capping or
  // evicting sessions would trade correctness (one full re-walk per evicted
  // file) for bytes we can simply stop rewriting.
  get heavyCursorKeys() {
    return [];
  }

  // Sidecar path for heavyCursorKeys: <cursor dir>/state.heavy.json
  get heavyCursorPath() {
    return this.cursorPath.replace(/\.json$/, "") + ".heavy.json";
  }

  async readCursor() {
    if (!existsSync(this.cursorPath)) return null;
    let raw;
    try {
      raw = readFileSync(this.cursorPath, "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return null;
      throw e;
    }
    if (raw === "") return null;
    let light;
    try {
      light = JSON.parse(raw);
    } catch {
      // Corrupt state file — treat as absent. The next writeCursor will
      // re-create it. The connector daemon SHOULD log this and rebuild
      // from the source-of-truth (kb/ingestion.md § Failure modes →
      // "Cursor drift").
      return null;
    }
    if (light == null || typeof light !== "object") return light;

    // Merge the heavy sidecar back over the light state. Sidecar wins for the
    // keys it carries; anything else (including heavy keys still inline from a
    // pre-split state.json) passes through untouched, so the format migrates
    // forward on the first write with no migration step.
    //
    // A missing or corrupt sidecar degrades to "heavy keys absent", which the
    // connectors already treat as a cold start — per the codex-cli contract
    // that deleting per_session_offsets "costs one re-walk per file". Losing
    // bytes here costs work, never correctness.
    try {
      if (existsSync(this.heavyCursorPath)) {
        const heavyRaw = readFileSync(this.heavyCursorPath, "utf8");
        if (heavyRaw !== "") {
          const heavy = JSON.parse(heavyRaw);
          if (heavy != null && typeof heavy === "object" && !Array.isArray(heavy)) {
            return { ...light, ...heavy };
          }
        }
      }
    } catch {
      // Fall through to the light state alone.
    }
    return light;
  }

  // writeCursor: atomic write-tmp + rename + fsync. mode 0600.
  //
  // Atomicity discipline (matches policy-events lock + distill-promote-fact
  // ledger discipline):
  //   1. ensure parent dir exists at 0700
  //   2. write tmp file at cursorPath + ".tmp.<random>" with 0600
  //   3. fsync the tmp file
  //   4. rename tmp -> cursorPath (POSIX atomic on same fs)
  //   5. fsync the parent directory (so the rename is durable)
  //
  // Power-cut at any point leaves either the prior state.json or the new
  // state.json on disk — never a half-written file. The unit test T2
  // simulates "write tmp but do not rename" by hand and confirms readCursor
  // returns the last successful state.
  // _writeAtomic — the tmp + fsync + rename + dir-fsync discipline described
  // above, factored out so the cursor and its heavy sidecar share one
  // implementation.
  _writeAtomic(targetPath, body) {
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = targetPath + ".tmp." + randomBytes(6).toString("hex");
    const fd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(body, "utf8");
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      fsyncSync(fd);
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    renameSync(tmpPath, targetPath);
    fsyncDir(dir);
  }

  async writeCursor(state) {
    if (state == null || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("ConnectorBase.writeCursor: state must be a plain object");
    }

    // Split corpus-sized fields out of the per-poll write. See heavyCursorKeys.
    const heavyKeys = this.heavyCursorKeys.filter(
      (k) => Object.prototype.hasOwnProperty.call(state, k),
    );

    let light = state;
    if (heavyKeys.length > 0) {
      const heavy = {};
      for (const k of heavyKeys) heavy[k] = state[k];
      light = { ...state };
      for (const k of heavyKeys) delete light[k];

      // Compact (not pretty-printed): this file is machine-only, and the
      // indentation on a corpus-sized map is pure overhead.
      const heavyBody = JSON.stringify(heavy) + "\n";
      const digest = createHash("blake2b512").update(heavyBody).digest("hex");

      // Skip the write when nothing changed. On the first write of a process
      // the cached digest is unset, so seed it from whatever is on disk —
      // one read (reads cost no NAND wear) to avoid one 2 MB write.
      if (this._heavyDigest == null) {
        try {
          if (existsSync(this.heavyCursorPath)) {
            const onDisk = readFileSync(this.heavyCursorPath, "utf8");
            this._heavyDigest = createHash("blake2b512").update(onDisk).digest("hex");
          }
        } catch {
          // Unreadable sidecar — fall through and rewrite it.
        }
      }

      if (this._heavyDigest !== digest) {
        this._writeAtomic(this.heavyCursorPath, heavyBody);
        this._heavyDigest = digest;
      }
    }

    this._writeAtomic(this.cursorPath, JSON.stringify(light, null, 2) + "\n");
  }

  // ---------------------------------------------------------------------------
  // Append — storage/sources/<source>.jsonl
  // ---------------------------------------------------------------------------

  // appendLedgerRow: stamp + dedupe + append + checksum.
  //
  // The input `row` is the source-specific payload assembled by the daemon;
  // it MUST carry at least `source_msg_id` (the source-native stable id for
  // dedup) and SHOULD carry `parties`, `raw_content`, and `attachments`.
  //
  // What this method does:
  //   1. Assert row.source_msg_id is a non-empty string.
  //   2. Tail-read the source ledger (bounded to dedupTailLines) and check
  //      whether any prior row carries the same source_msg_id. If yes,
  //      return {appended: false, source_msg_id} — the caller's cursor
  //      advance is the operative response.
  //   3. Stamp:
  //        ts             <- serverTs() if absent
  //        source         <- this.source (overwrite even if caller set it)
  //        id             <- generated ULID-shape id (always)
  //        source_policy  <- this.sourcePolicyForRow(row)
  //   4. Compute blake2b512-trunc-16-hex checksum over canonical_json of
  //      the row WITHOUT its checksum field. Append as last key.
  //   5. Append + fsync + dir-fsync to storage/sources/<source>.jsonl.
  //
  // Returns {appended: true, source_msg_id, id} on first-time append; the
  // generated row-id is returned so the caller can cross-reference for its
  // own logging.
  async appendLedgerRow(row) {
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("ConnectorBase.appendLedgerRow: row must be a plain object");
    }
    if (typeof row.source_msg_id !== "string" || row.source_msg_id === "") {
      throw new Error("ConnectorBase.appendLedgerRow: row.source_msg_id must be a non-empty string");
    }
    if (this._isDuplicate(row.source_msg_id)) {
      return { appended: false, source_msg_id: row.source_msg_id };
    }
    const policy = this.sourcePolicyForRow(row);
    if (policy == null || typeof policy !== "object" || Array.isArray(policy)) {
      throw new Error(
        "ConnectorBase.appendLedgerRow: sourcePolicyForRow must return {deletion_semantics, consent_basis}",
      );
    }
    if (typeof policy.deletion_semantics !== "string" || policy.deletion_semantics === "") {
      throw new Error(
        "ConnectorBase.appendLedgerRow: source_policy.deletion_semantics must be a non-empty string",
      );
    }
    if (typeof policy.consent_basis !== "string" || policy.consent_basis === "") {
      throw new Error(
        "ConnectorBase.appendLedgerRow: source_policy.consent_basis must be a non-empty string",
      );
    }
    const rowId = generateLedgerRowId();
    const ts = typeof row.ts === "string" && row.ts !== "" ? row.ts : serverTs();

    // Build the stamped row in a STABLE field order. The checksum is the
    // final key per chat-claude-code.jsonl convention. Use the same
    // canonical_json over the row-without-checksum so the recovery scanner
    // re-computes deterministically regardless of stored key order.
    const rowWithoutChecksum = {
      id: rowId,
      ts,
      source: this.source,
      source_msg_id: row.source_msg_id,
      parties: Array.isArray(row.parties) ? row.parties : [],
      raw_content: row.raw_content != null ? row.raw_content : {},
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      source_policy: {
        deletion_semantics: policy.deletion_semantics,
        consent_basis: policy.consent_basis,
      },
    };
    // kind, derived_from, room_id, thread_originator_guid — any extra
    // top-level fields the per-source daemon adds (e.g. "kind":"reaction"
    // for iMessage tapbacks, "derived_from":[...] for edit-as-event) are
    // copied through verbatim. We trust the daemon to honor the schema
    // contract documented in kb/connectors-survey.md.
    for (const key of Object.keys(row)) {
      if (["id", "ts", "source", "source_msg_id", "parties", "raw_content", "attachments", "source_policy", "checksum"].includes(key)) {
        continue;
      }
      rowWithoutChecksum[key] = row[key];
    }
    const checksum = blake2b512TruncTo16Hex(Buffer.from(canonicalJson(rowWithoutChecksum), "utf8"));
    const stored = { ...rowWithoutChecksum, checksum };

    const dir = dirname(this.sourceLedgerPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const bytes = Buffer.from(JSON.stringify(stored) + "\n", "utf8");
    const fd = openSync(this.sourceLedgerPath, LEDGER_O_FLAGS, LEDGER_FILE_MODE);
    try {
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      fsyncSync(fd);
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    fsyncDir(dir);
    return { appended: true, source_msg_id: row.source_msg_id, id: rowId };
  }

  // _isDuplicate — bounded tail-read for source_msg_id dedup.
  // CAPS.CONNECTOR_DEDUP_TAIL_LINES is the spec'd window. The cost of
  // O(window) per append is acceptable because the daemon append-rate is
  // human-scale (iMessage ~1/s peak; ScreenTime ~1/min; git/github ~rare).
  // Out-of-window duplicates slip through; the salience-layer corroboration
  // pattern in kb/ingestion.md § Cross-source dedupe absorbs that long tail.
  //
  // BOUNDED means bytes, not just lines: openSync + fstatSync + positional
  // readSync of only the last max(dedupTailLines * DEDUP_TAIL_AVG_LINE_BYTES,
  // DEDUP_TAIL_MIN_READ_BYTES) bytes, drop the first (almost certainly
  // partial) line, THEN apply the last-N-lines scan. Reading the whole file
  // (the pre-R39 readFileSync) was a time bomb — see the constants' header
  // comment for the codex-cli / git-log post-mortem.
  //
  // Failure modes are distinguished, matching readCursor's idiom:
  //   ENOENT             -> false (no ledger yet — first append ever).
  //   any other IO error -> rethrow. appendLedgerRow rejects loudly and the
  //                         daemon's catch path tagError()s; dedup must
  //                         never fail open silently again.
  _isDuplicate(sourceMsgId) {
    let fd = -1;
    try {
      // O_NOFOLLOW for parity with the write-side LEDGER_O_FLAGS: a
      // symlinked ledger is a misconfiguration we refuse (ELOOP), not follow.
      fd = openSync(this.sourceLedgerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      if (err && err.code === "ENOENT") return false;
      throw err;
    }
    let tail;
    let windowStart;
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return false;
      const windowBytes = Math.max(
        this.dedupTailLines * DEDUP_TAIL_AVG_LINE_BYTES,
        DEDUP_TAIL_MIN_READ_BYTES,
      );
      windowStart = Math.max(0, size - windowBytes);
      const length = size - windowStart;
      const buf = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        // Positional read: an explicit position does not advance the fd
        // offset, so each retry supplies windowStart + read.
        const n = readSync(fd, buf, read, length - read, windowStart + read);
        if (n === 0) break; // ledger shrank mid-read (rotation); scan what we got
        read += n;
      }
      tail = buf.subarray(0, read).toString("utf8");
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    if (windowStart > 0) {
      // The window almost certainly starts mid-line (it may even split a
      // multi-byte UTF-8 sequence); drop through the first newline so only
      // complete lines are scanned. A single line longer than the whole
      // window leaves nothing complete to scan — treat as out-of-window.
      const firstNewline = tail.indexOf("\n");
      if (firstNewline === -1) return false;
      tail = tail.slice(firstNewline + 1);
    }
    if (tail === "") return false;
    const allLines = tail.split("\n");
    // Drop trailing empty line from final "\n".
    while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }
    const start = Math.max(0, allLines.length - this.dedupTailLines);
    for (let i = start; i < allLines.length; i++) {
      const line = allLines[i];
      if (line === "") continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed && parsed.source_msg_id === sourceMsgId) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Health — read-only view of cursor state
  // ---------------------------------------------------------------------------

  // reportHealth: synchronous read of cursor state -> {last_appended_ts,
  // last_cursor_advance_ts, error_rate, status}.
  //
  // Status taxonomy (round-20 close):
  //   ok       — error_count < threshold AND cursor advanced within CAPS.CONNECTOR_HEALTH_STALE_SECONDS
  //   degraded — error_count >= threshold (failure-rate trip)
  //   stale    — last_cursor_advance_ts older than CONNECTOR_HEALTH_STALE_SECONDS but no errors logged
  //   failed   — caller sets state.status = "failed" explicitly (e.g. unrecoverable auth)
  reportHealth() {
    let state;
    try {
      if (!existsSync(this.cursorPath)) return this._healthFromState(null);
      const raw = readFileSync(this.cursorPath, "utf8");
      state = raw === "" ? null : JSON.parse(raw);
    } catch {
      state = null;
    }
    return this._healthFromState(state);
  }

  _healthFromState(state) {
    if (state == null) {
      return {
        source: this.source,
        last_appended_ts: null,
        last_cursor_advance_ts: null,
        error_rate: 0,
        status: "ok",
      };
    }
    const errorCount = Number.isInteger(state.error_count) ? state.error_count : 0;
    const lastAppendedTs = typeof state.last_appended_ts === "string" ? state.last_appended_ts : null;
    const lastAdvanceTs = typeof state.last_cursor_advance_ts === "string" ? state.last_cursor_advance_ts : null;
    let status = "ok";
    if (state.status === "failed") {
      status = "failed";
    } else if (errorCount >= this.errorThreshold) {
      status = "degraded";
    } else if (lastAdvanceTs != null) {
      const ageSec = (Date.now() - Date.parse(lastAdvanceTs)) / 1000;
      if (Number.isFinite(ageSec) && ageSec > CAPS.CONNECTOR_HEALTH_STALE_SECONDS) {
        status = "stale";
      }
    }
    // error_rate is a 0..1 normalized fraction: errorCount / threshold capped at 1.
    // The threshold is the "degraded" trip line, so the ratio at-trip == 1.0.
    const errorRate = this.errorThreshold > 0
      ? Math.min(1, errorCount / this.errorThreshold)
      : 0;
    return {
      source: this.source,
      last_appended_ts: lastAppendedTs,
      last_cursor_advance_ts: lastAdvanceTs,
      error_rate: errorRate,
      status,
    };
  }

  // tagError: increment error_count for a named kind. Persists immediately
  // via writeCursor so a daemon crash mid-batch does not lose the error
  // signal. Crosses the threshold => next reportHealth() returns "degraded".
  //
  // The `kind` parameter is recorded as `last_error_kind` (the latest one
  // wins); per-kind counters are out of scope for the base class — each
  // daemon adds them if it wants more granularity.
  async tagError(kind) {
    const state = (await this.readCursor()) || {};
    const next = {
      ...state,
      error_count: (Number.isInteger(state.error_count) ? state.error_count : 0) + 1,
      last_error_kind: typeof kind === "string" ? kind : "unknown",
      last_error_ts: serverTs(),
    };
    await this.writeCursor(next);
  }
}

// =============================================================================
// listInstalledConnectors — surface for memory_connectors_list MCP tool.
// =============================================================================

// Enumerate connectors/ subdirectories. Each dir with a state.json counts
// as installed. Directories without state.json are ignored (e.g. an empty
// connectors/imessage/ created by the operator before first run).
//
// Each entry's metadata:
//   {source, status, last_appended_ts, last_cursor_advance_ts}
//
// Status is computed by the same logic ConnectorBase.reportHealth uses,
// but without needing the per-connector classifier closure (we're read-only
// here). The threshold is the global CAPS.CONNECTOR_ERROR_THRESHOLD.
export function listInstalledConnectors() {
  const dir = connectorsDir();
  if (!existsSync(dir)) return [];
  const entries = [];
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const source = ent.name;
    const statePath = join(dir, source, "state.json");
    if (!existsSync(statePath)) continue;
    let state;
    try {
      const raw = readFileSync(statePath, "utf8");
      state = raw === "" ? null : JSON.parse(raw);
    } catch {
      state = null;
    }
    entries.push(metadataFromState(source, state));
  }
  // Stable sort by source name so the MCP envelope is deterministic for
  // operator inspection and test snapshotting.
  entries.sort((a, b) => a.source.localeCompare(b.source));
  return entries;
}

function metadataFromState(source, state) {
  if (state == null) {
    return {
      source,
      status: "ok",
      last_appended_ts: null,
      last_cursor_advance_ts: null,
    };
  }
  const errorCount = Number.isInteger(state.error_count) ? state.error_count : 0;
  const lastAppendedTs = typeof state.last_appended_ts === "string" ? state.last_appended_ts : null;
  const lastAdvanceTs = typeof state.last_cursor_advance_ts === "string" ? state.last_cursor_advance_ts : null;
  let status = "ok";
  if (state.status === "failed") {
    status = "failed";
  } else if (errorCount >= CAPS.CONNECTOR_ERROR_THRESHOLD) {
    status = "degraded";
  } else if (lastAdvanceTs != null) {
    const ageSec = (Date.now() - Date.parse(lastAdvanceTs)) / 1000;
    if (Number.isFinite(ageSec) && ageSec > CAPS.CONNECTOR_HEALTH_STALE_SECONDS) {
      status = "stale";
    }
  }
  return {
    source,
    status,
    last_appended_ts: lastAppendedTs,
    last_cursor_advance_ts: lastAdvanceTs,
  };
}

// =============================================================================
// applyConnectorRevoke — round-20 C4 kill-switch marker.
// =============================================================================

// Append a `kind:"policy"` row to ledgers/memory.jsonl with
//   policy_kind: "connector_revoke"
//   target_source: <source>
//   ts: <serverTs>
//
// This is the AUTHORITATIVE marker the recall layer's transitive-orphan BFS
// reads (kb/recall/hard-gates.js walks every kind:"policy" row in
// memory.jsonl). The recall layer treats every memory whose
// source_refs[].source == target_source as a seed for the transitive-orphan
// BFS — at most one BFS per recall, cached at process scope and busted on
// memory.jsonl mtime change.
//
// NOT a policy-events-YYYY-MM.jsonl event. The audit log in policy/ is for
// daemon-token + distillation lifecycle; the connector_revoke marker lives
// on the memory ledger because the recall layer reads memory.jsonl already
// (no extra IO at recall time).
//
// Returns the parsed row that was appended. The row carries:
//   id          — generated "mem_" + 8 random bytes (matches Phase 1 fact-row
//                 discipline; the recall layer keys on this id when emitting
//                 transitive-orphan policy.recall.* events).
//   kind        — "policy"
//   policy_kind — "connector_revoke"
//   target_source — source
//   ts          — serverTs()
//   checksum    — blake2b512-trunc-16-hex of canonical_json of the row
//                 without its checksum field
//
// Optional `opts.reason` is preserved as `reason` on the row for operator
// audit trail (e.g. "operator_requested_via_mcp", "auth_revoked_upstream").
export async function applyConnectorRevoke({ source, opts } = {}) {
  if (typeof source !== "string" || source === "") {
    throw new Error("applyConnectorRevoke: source must be a non-empty string");
  }
  const ts = serverTs();
  const id = "mem_" + randomBytes(8).toString("hex");
  const rowWithoutChecksum = {
    id,
    kind: "policy",
    policy_kind: "connector_revoke",
    target_source: source,
    ts,
  };
  if (opts && typeof opts.reason === "string" && opts.reason !== "") {
    rowWithoutChecksum.reason = opts.reason;
  }
  const checksum = blake2b512TruncTo16Hex(
    Buffer.from(canonicalJson(rowWithoutChecksum), "utf8"),
  );
  const stored = { ...rowWithoutChecksum, checksum };

  const ledgerPath = memoryLedgerPath();
  const dir = dirname(ledgerPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const bytes = Buffer.from(JSON.stringify(stored) + "\n", "utf8");
  const fd = openSync(ledgerPath, LEDGER_O_FLAGS, LEDGER_FILE_MODE);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  fsyncDir(dir);
  return stored;
}
