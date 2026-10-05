// index-manifest.js — S3: immutable generation manifest for the BM25 + HNSW
// index pair.
//
// DEFECT CLASS THIS MODULE CLOSES (see mcp/test/recall/index-manifest.test.mjs
// T1): pre-S3 the index members were published as INDEPENDENT renames —
// bm25.json, hnsw.bin, and hnsw.bin.meta.json each swapped into place on its
// own (hnsw-index.js save() renamed bin then meta). A crash between the two
// hnsw renames (or a reader racing a save) paired a NEW graph binary with an
// OLD id map, and an ANN label silently resolved to the WRONG fact id. The
// manifest makes the generation the unit of publication: one JSON file binds
// every member with a sha256 + size, and a SINGLE atomic rename of that file
// (after file + dir fsync) is the only publication event. Readers load ONLY
// what the active manifest names, verify checksums before deserializing, and
// REFUSE a mismatched member fail-closed — falling back to the one retained
// prior generation.
//
// FILES (all inside the caller-passed indices/<modelVersion>/ dir — the
// per-model-version discipline of index-cache.js indexPathsFor):
//   index-manifest.json      — the ACTIVE generation manifest (atomic-rename
//                              target). Shape: see buildManifest below.
//   bm25.gen-<N>.json        — retention snapshot of generation N's bm25
//   hnsw.gen-<N>.bin         —   member files, hardlinked from the fixed
//   hnsw.gen-<N>.bin.meta.json  paths BEFORE the next generation replaces
//                              them. Exactly ONE prior generation is
//                              retained; gcGenerations removes older ones
//                              and NEVER touches a generation the active
//                              manifest (members or previous) still names.
//
// LAYOUT INVARIANT: the ACTIVE generation's members always live at the fixed
// legacy paths (bm25.json / hnsw.bin / hnsw.bin.meta.json) — on-disk member
// FORMATS are byte-identical to pre-S3; only the publication/binding changed.
// This keeps every existing writer (saveIndices, hnsw-index.js save()) and
// any not-yet-restarted pre-S3 process reading the same paths it always did.
// The retention snapshots are hardlinks: every writer replaces members via
// tmp+rename (never in-place), so a linked inode is immutable and the
// recorded checksums keep describing it.
//
// WAL CURSOR BINDING (S2 → S3 seam): the manifest embeds the S2 WAL applied
// cursor {applied_seq, applied_offset} VERBATIM (shape produced by
// index-wal.js readAppliedCursor / captured by index-cache.js
// _flushPendingSaves) — the cursor position whose records are reflected in
// the generation's members. A reader that falls back to a prior generation
// replays the WAL from THAT generation's recorded cursor.
//
// MODULE DISCIPLINE (mirrors index-wal.js): ESM, node stdlib only, no
// module-scope mutable state, pure functions over a caller-passed dir. fs
// errors are RETURN VALUES, not throws — sole exceptions: activateManifest,
// checksumMemberFile and sha256File throw, because they sit on the SAVE path
// whose callers (index-cache.js saveIndices and its flush wrapper) already
// treat a throw as "flush failed, WAL kept". This layer NEVER reads or
// writes ledgers/memory.jsonl.

import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export const MANIFEST_FILE = "index-manifest.json";
export const MANIFEST_FORMAT = 1;

// The fixed (legacy) member paths the ACTIVE generation always occupies.
const FIXED_MEMBER_FILES = {
  bm25: "bm25.json",
  hnsw: "hnsw.bin",
  hnsw_meta: "hnsw.bin.meta.json",
};
const MEMBER_KEYS = ["bm25", "hnsw", "hnsw_meta"];

const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const SHA_CHUNK = 1 << 20; // 1 MiB read window — never the whole file at once

export function manifestPathFor(dir) {
  return join(dir, MANIFEST_FILE);
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/**
 * sha256File(path) → lowercase hex digest. Streams the file through a fixed
 * 1 MiB window (a multi-GB hnsw.bin never materializes in memory). THROWS on
 * fs errors (save-path contract; read-path callers go through
 * verifyGenerationMembers which converts to a structured value).
 */
export function sha256File(path) {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(SHA_CHUNK);
  const fd = openSync(path, READ_FLAGS);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, SHA_CHUNK, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * checksumMemberFile(dir, file) → {file, size, sha256}. THROWS on fs errors
 * (save-path contract).
 *
 * FIX CYCLE 2 (perf gate): the publish-time checksum SEEDS the persisted
 * verified-digest cache (best-effort), so the very next cold-load
 * verifyGenerationMembers is stat-level for this member instead of a full
 * re-hash of a multi-GB file. Recording is guarded by a post-hash re-stat:
 * if the member's stat identity changed while we hashed, nothing is cached.
 */
export function checksumMemberFile(dir, file) {
  const p = join(dir, file);
  const st = statSync(p);
  const sha256 = sha256File(p);
  try {
    const st2 = statSync(p);
    if (memberStatIdentity(st2) === memberStatIdentity(st)) {
      recordVerifiedDigest(dir, st2, sha256, file);
    }
  } catch (_e) {
    // advisory cache — never fails the checksum
  }
  return { file, size: st.size, sha256 };
}

// ---------------------------------------------------------------------------
// Verified-digest cache (FIX CYCLE 2 perf gate)
// ---------------------------------------------------------------------------
// Full-sha256 member verification on the cold load costs seconds against the
// production-scale ~1.9 GB hnsw.bin — and the per-session process-spawn
// pattern makes EVERY first recall a cold load. The cache maps a member's
// stat identity (ino:mtimeMs:size) to a digest that was ACTUALLY computed
// over those bytes (by checksumMemberFile at publish time or by a prior
// verifyGenerationMembers full hash). Soundness rests on the layout
// invariant: every sanctioned member replacement is tmp+rename (new inode →
// automatic miss) and in-place writes are forbidden; retention snapshots are
// hardlinks, so they share the verified inode identity and hit for free.
// The sidecar is advisory and trusted (0600, inside the per-version dir):
// read/write failures degrade to the full hash, never to a wrong answer.

export const DIGEST_CACHE_FILE = "index-digest-cache.json";
const DIGEST_CACHE_MAX_ENTRIES = 24;

function digestCachePath(dir) {
  return join(dir, DIGEST_CACHE_FILE);
}

/** memberStatIdentity(st) → "ino:mtimeMs:size" for a Stats object. */
export function memberStatIdentity(st) {
  return `${st.ino}:${st.mtimeMs}:${st.size}`;
}

// → entries object ({identity: {sha256, file, verified_at}}); {} on any
// problem (missing/corrupt cache degrades to full hashing).
function _readDigestCache(dir) {
  try {
    const j = JSON.parse(readFileSync(digestCachePath(dir), "utf8"));
    if (
      j != null &&
      typeof j === "object" &&
      j.v === 1 &&
      j.entries != null &&
      typeof j.entries === "object"
    ) {
      return j.entries;
    }
  } catch (_e) {
    // fall through
  }
  return {};
}

// Atomic (tmp+rename) advisory write; prunes to the newest
// DIGEST_CACHE_MAX_ENTRIES by verified_at. Never throws.
function _writeDigestCache(dir, entries) {
  try {
    const keys = Object.keys(entries);
    if (keys.length > DIGEST_CACHE_MAX_ENTRIES) {
      keys.sort((a, b) =>
        String(entries[a]?.verified_at ?? "").localeCompare(
          String(entries[b]?.verified_at ?? ""),
        ),
      );
      for (const k of keys.slice(0, keys.length - DIGEST_CACHE_MAX_ENTRIES)) {
        delete entries[k];
      }
    }
    const p = digestCachePath(dir);
    const tmp = `${p}.tmp-${process.pid}`;
    const bytes = Buffer.from(JSON.stringify({ v: 1, entries }), "utf8");
    const fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  } catch (_e) {
    // advisory cache — never fails the caller
  }
}

/**
 * recordVerifiedDigest(dir, st, sha256, file) — persist "the bytes with stat
 * identity st hash to sha256". Callers must only pass digests computed over
 * the CURRENT bytes (re-stat guard at the call sites). Best-effort.
 */
export function recordVerifiedDigest(dir, st, sha256, file = null) {
  if (st == null || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    return;
  }
  const entries = _readDigestCache(dir);
  entries[memberStatIdentity(st)] = {
    sha256,
    file,
    verified_at: new Date().toISOString(),
  };
  _writeDigestCache(dir, entries);
}

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

function validCursor(c) {
  return (
    c != null &&
    typeof c === "object" &&
    Number.isSafeInteger(c.applied_seq) &&
    c.applied_seq >= 0 &&
    Number.isSafeInteger(c.applied_offset) &&
    c.applied_offset >= 0
  );
}

function validMemberEntry(m) {
  return (
    m == null ||
    (typeof m === "object" &&
      typeof m.file === "string" &&
      m.file.length > 0 &&
      !m.file.includes("/") && // members live INSIDE the per-version dir
      Number.isSafeInteger(m.size) &&
      m.size >= 0 &&
      typeof m.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(m.sha256))
  );
}

function validMembers(members) {
  if (members == null || typeof members !== "object") return false;
  return MEMBER_KEYS.every((k) => validMemberEntry(members[k] ?? null));
}

/**
 * buildManifest(fields) → plain manifest object.
 *
 * {
 *   format: 1,
 *   generation: <monotonic int>,
 *   created_at: <iso>,
 *   adopted: <bool>,                    // true only for a generation-0 legacy adoption
 *   embedding_model_version, dims, hnsw_backend, hnsw_format,   // model metadata
 *   wal_cursor: {applied_seq, applied_offset},                  // S2 cursor, verbatim
 *   members:  { bm25|hnsw|hnsw_meta: {file, size, sha256} | null },
 *   previous: { generation, wal_cursor, members } | null        // the ONE retained fallback
 * }
 */
export function buildManifest({
  generation,
  embedding_model_version = null,
  dims = null,
  hnsw_backend = null,
  hnsw_format = null,
  wal_cursor,
  members,
  previous = null,
  adopted = false,
} = {}) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError(`buildManifest: invalid generation ${generation}`);
  }
  if (!validCursor(wal_cursor)) {
    throw new TypeError("buildManifest: wal_cursor {applied_seq, applied_offset} required");
  }
  if (!validMembers(members)) {
    throw new TypeError("buildManifest: invalid members");
  }
  return {
    format: MANIFEST_FORMAT,
    generation,
    created_at: new Date().toISOString(),
    adopted: adopted === true,
    embedding_model_version,
    dims,
    hnsw_backend,
    hnsw_format,
    wal_cursor: {
      applied_seq: wal_cursor.applied_seq,
      applied_offset: wal_cursor.applied_offset,
    },
    members: {
      bm25: members.bm25 ?? null,
      hnsw: members.hnsw ?? null,
      hnsw_meta: members.hnsw_meta ?? null,
    },
    previous: previous ?? null,
  };
}

// ---------------------------------------------------------------------------
// Read + verify
// ---------------------------------------------------------------------------

/**
 * readActiveManifest(dir) → {manifest: object|null, error: object|null}
 *
 * PARSE + SHAPE CHECK ONLY — never reads member bytes (the warm path budgets
 * one small-file read at most; checksum verification is the cold-load-only
 * verifyGenerationMembers below). Missing manifest → {null, null} (the
 * legacy / pre-adoption state). Malformed manifest → structured error; the
 * caller must fail closed (a manifest that EXISTS but cannot be trusted must
 * never be bypassed in favor of raw member files — that would reopen the
 * mixed-generation window).
 */
export function readActiveManifest(dir) {
  const p = manifestPathFor(dir);
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { manifest: null, error: null };
    return {
      manifest: null,
      error: { code: "index_manifest_unreadable", message: e.message },
    };
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return {
      manifest: null,
      error: { code: "index_manifest_unreadable", message: `malformed JSON: ${e.message}` },
    };
  }
  if (
    j == null ||
    typeof j !== "object" ||
    j.format !== MANIFEST_FORMAT ||
    !Number.isSafeInteger(j.generation) ||
    j.generation < 0 ||
    !validCursor(j.wal_cursor) ||
    !validMembers(j.members) ||
    (j.previous != null &&
      !(
        typeof j.previous === "object" &&
        Number.isSafeInteger(j.previous.generation) &&
        j.previous.generation >= 0 &&
        validMembers(j.previous.members)
      ))
  ) {
    return {
      manifest: null,
      error: { code: "index_manifest_unreadable", message: "bad manifest shape" },
    };
  }
  return { manifest: j, error: null };
}

/**
 * verifyGenerationMembers(dir, members) → {ok, error: object|null}
 *
 * Fail-closed member verification: every non-null member must exist, match
 * its recorded size (cheap stat first), and match its recorded sha256. The
 * full sha256 read (cold-load cost only; callers must never run this on the
 * warm path) is SKIPPED when the member's stat identity (ino:mtimeMs:size)
 * carries a previously verified digest equal to the recorded one — the FIX
 * CYCLE 2 perf gate: publish-time checksums seed the persisted cache, so a
 * fresh process's first recall stays stat-level instead of re-hashing the
 * ~1.9 GB hnsw.bin. A fingerprint miss (every tmp+rename replacement is a
 * new inode) or a digest disagreement falls through to the full hash.
 * The FIRST failing member produces the structured error:
 *   {code: "index_manifest_member_missing"|"index_manifest_member_mismatch",
 *    member, file, expected_size?, actual_size?, expected_sha256?,
 *    actual_sha256?}
 * Never throws.
 */
export function verifyGenerationMembers(dir, members) {
  if (!validMembers(members)) {
    return {
      ok: false,
      error: { code: "index_manifest_member_mismatch", member: null, file: null, message: "invalid members shape" },
    };
  }
  const digestEntries = _readDigestCache(dir);
  let digestDirty = false;
  for (const key of MEMBER_KEYS) {
    const m = members[key] ?? null;
    if (m == null) continue;
    const p = join(dir, m.file);
    let st;
    try {
      st = statSync(p);
    } catch (_e) {
      return {
        ok: false,
        error: { code: "index_manifest_member_missing", member: key, file: m.file },
      };
    }
    if (st.size !== m.size) {
      return {
        ok: false,
        error: {
          code: "index_manifest_member_mismatch",
          member: key,
          file: m.file,
          expected_size: m.size,
          actual_size: st.size,
          expected_sha256: m.sha256,
        },
      };
    }
    // Verified-digest fast path: these exact bytes (by stat identity) were
    // already hashed to the recorded digest — skip the full read.
    const ident = memberStatIdentity(st);
    const hit = digestEntries[ident];
    if (hit != null && hit.sha256 === m.sha256) continue;
    let got;
    try {
      got = sha256File(p);
    } catch (e) {
      return {
        ok: false,
        error: { code: "index_manifest_member_missing", member: key, file: m.file, message: e.message },
      };
    }
    if (got !== m.sha256) {
      return {
        ok: false,
        error: {
          code: "index_manifest_member_mismatch",
          member: key,
          file: m.file,
          expected_size: m.size,
          actual_size: st.size,
          expected_sha256: m.sha256,
          actual_sha256: got,
        },
      };
    }
    // Remember the verified digest — but only if the bytes we hashed are
    // still the bytes at the path (re-stat guard; a swap mid-hash would
    // otherwise poison the cache).
    try {
      const st2 = statSync(p);
      if (memberStatIdentity(st2) === ident) {
        digestEntries[ident] = {
          sha256: got,
          file: m.file,
          verified_at: new Date().toISOString(),
        };
        digestDirty = true;
      }
    } catch (_e) {
      // advisory only
    }
  }
  if (digestDirty) _writeDigestCache(dir, digestEntries);
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * activateManifest(dir, manifest) — THE publication event.
 *
 * Write the manifest JSON to a tmp sibling, fsyncSync the file, then ONE
 * atomic renameSync onto index-manifest.json, then best-effort fsync of the
 * containing dir (the exact discipline of hnsw-index.js save()'s linear
 * branch). A crash at any point leaves either the old manifest or the new
 * one fully active — never a mix. THROWS on failure (save-path contract);
 * the tmp file is cleaned up best-effort first.
 */
export function activateManifest(dir, manifest) {
  if (manifest == null || typeof manifest !== "object") {
    throw new TypeError("activateManifest: manifest object required");
  }
  const p = manifestPathFor(dir);
  const tmp = `${p}.tmp-${process.pid}`;
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  try {
    const fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort tmp cleanup
    }
    throw e;
  }
  // Durable rename: best-effort dir fsync (some filesystems reject it; the
  // per-file fsync above already guarantees the manifest bytes themselves).
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (_e) {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Generation 0 adoption (migration)
// ---------------------------------------------------------------------------

// Bounded first-line peek (NDJSON header probe) — never slurps a multi-GB
// linear-scan hnsw.bin. Mirrors HnswIndex._readFirstLine's cap discipline.
function readFirstLineBounded(path) {
  const CAP = 1 << 16; // 64 KiB — far larger than any header line
  const buf = Buffer.allocUnsafe(CAP);
  let fd = null;
  try {
    fd = openSync(path, READ_FLAGS);
    const n = readSync(fd, buf, 0, CAP, 0);
    if (n <= 0) return null;
    const s = buf.subarray(0, n).toString("utf8");
    const nl = s.indexOf("\n");
    return nl >= 0 ? s.slice(0, nl) : null;
  } catch (_e) {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// Best-effort model-metadata probe for adoption: the native sidecar (small
// JSON) or the v2 NDJSON header line both carry
// {format, backend, dims, embedding_model_version}. Absence → nulls (the
// metadata is informational; the checksums are the load-bearing binding).
function probeHnswMetadata(dir) {
  const out = { embedding_model_version: null, dims: null, hnsw_backend: null, hnsw_format: null };
  const metaPath = join(dir, FIXED_MEMBER_FILES.hnsw_meta);
  let header = null;
  if (existsSync(metaPath)) {
    try {
      header = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch (_e) {
      header = null;
    }
  }
  if (header == null) {
    const line = readFirstLineBounded(join(dir, FIXED_MEMBER_FILES.hnsw));
    if (line != null) {
      try {
        header = JSON.parse(line);
      } catch (_e) {
        header = null;
      }
    }
  }
  if (header != null && typeof header === "object") {
    if (typeof header.embedding_model_version === "string") {
      out.embedding_model_version = header.embedding_model_version;
    }
    if (Number.isSafeInteger(header.dims)) out.dims = header.dims;
    if (typeof header.backend === "string") out.hnsw_backend = header.backend;
    if (Number.isSafeInteger(header.format)) out.hnsw_format = header.format;
  }
  return out;
}

/**
 * adoptGeneration0(dir, {wal_cursor}) → {manifest|null, adopted, error|null}
 *
 * MIGRATION: first run against a pre-S3 tree (members on disk, no manifest).
 * Checksums the CURRENT fixed-path files as generation 0 and activates the
 * manifest — the member files themselves are never rewritten. Nothing on
 * disk → {manifest: null, adopted: false} (bootstrap: nothing to adopt; the
 * first save creates generation 0). Never throws.
 */
export function adoptGeneration0(dir, { wal_cursor } = {}) {
  const cursor = validCursor(wal_cursor)
    ? wal_cursor
    : { applied_seq: 0, applied_offset: 0 };
  const members = { bm25: null, hnsw: null, hnsw_meta: null };
  let any = false;
  try {
    for (const key of MEMBER_KEYS) {
      const file = FIXED_MEMBER_FILES[key];
      if (!existsSync(join(dir, file))) continue;
      members[key] = checksumMemberFile(dir, file);
      any = true;
    }
  } catch (e) {
    return {
      manifest: null,
      adopted: false,
      error: { code: "index_manifest_adoption_failed", message: e.message },
    };
  }
  if (!any) return { manifest: null, adopted: false, error: null };
  const meta = probeHnswMetadata(dir);
  let manifest;
  try {
    manifest = buildManifest({
      generation: 0,
      ...meta,
      wal_cursor: cursor,
      members,
      previous: null,
      adopted: true,
    });
    activateManifest(dir, manifest);
  } catch (e) {
    return {
      manifest: null,
      adopted: false,
      error: { code: "index_manifest_adoption_failed", message: e.message },
    };
  }
  return { manifest, adopted: true, error: null };
}

// ---------------------------------------------------------------------------
// Retention + GC
// ---------------------------------------------------------------------------

/**
 * retentionMemberNames(generation) → generation-addressed retention names.
 * NOTE the hnsw_meta name is hnsw.gen-N.bin + ".meta.json" — exactly the
 * sidecar suffix HnswIndex.load probes, so a retained generation loads with
 * zero special-casing.
 */
export function retentionMemberNames(generation) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError(`retentionMemberNames: invalid generation ${generation}`);
  }
  return {
    bm25: `bm25.gen-${generation}.json`,
    hnsw: `hnsw.gen-${generation}.bin`,
    hnsw_meta: `hnsw.gen-${generation}.bin.meta.json`,
  };
}

// Hardlink src → dst, replacing dst atomically (link to a tmp sibling, then
// rename). Hardlinks are safe snapshots here because every member writer
// replaces files via tmp+rename — an inode, once published, is immutable.
// Filesystems without hardlink support fall back to a plain copy.
function linkOrCopyReplace(src, dst) {
  const tmp = `${dst}.tmp-${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    // ENOENT expected
  }
  try {
    linkSync(src, tmp);
  } catch (_e) {
    copyFileSync(src, tmp);
  }
  renameSync(tmp, dst);
}

// FIX CYCLE 2 (retention guard) — cheap content-identity check between two
// paths: same dev+ino (hardlinked → identical by construction), else same
// size AND byte-identical first + last 64 KiB blocks. Deliberately
// conservative in the cheap direction only: a `true` may be a false positive
// on middle-of-file differences, but callers use it purely to SKIP work on
// the identical-bytes fast path — any replacement decision still requires
// the full recorded-sha256 proof below. Never throws.
const IDENTITY_BLOCK = 1 << 16; // 64 KiB

function _readAt(fd, buf, len, position) {
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, position + got);
    if (n <= 0) break;
    got += n;
  }
  return got;
}

export function sameFileContentCheap(a, b) {
  let sa;
  let sb;
  try {
    sa = statSync(a);
    sb = statSync(b);
  } catch (_e) {
    return false;
  }
  if (sa.dev === sb.dev && sa.ino === sb.ino) return true;
  if (sa.size !== sb.size) return false;
  let fda = null;
  let fdb = null;
  try {
    fda = openSync(a, READ_FLAGS);
    fdb = openSync(b, READ_FLAGS);
    const n = Math.min(IDENTITY_BLOCK, sa.size);
    if (n > 0) {
      const ba = Buffer.allocUnsafe(n);
      const bb = Buffer.allocUnsafe(n);
      if (_readAt(fda, ba, n, 0) !== n || _readAt(fdb, bb, n, 0) !== n) return false;
      if (!ba.equals(bb)) return false;
      if (sa.size > n) {
        const off = sa.size - n;
        if (_readAt(fda, ba, n, off) !== n || _readAt(fdb, bb, n, off) !== n) return false;
        if (!ba.equals(bb)) return false;
      }
    }
    return true;
  } catch (_e) {
    return false;
  } finally {
    for (const fd of [fda, fdb]) {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }
}

/**
 * retainActiveGeneration(dir, manifest) → {members|null, error|null}
 *
 * Snapshot the ACTIVE generation's members to their generation-addressed
 * retention names (hardlink; copy fallback) so the NEXT generation's renames
 * over the fixed paths cannot destroy the fallback. Returns retention-named
 * member entries carrying the SAME recorded size/sha256 (content identity —
 * the link shares the inode). Any failure → {members: null, error} and the
 * caller degrades (carries the older fallback). Never throws.
 */
export function retainActiveGeneration(dir, manifest) {
  if (manifest == null || typeof manifest !== "object" || !validMembers(manifest.members)) {
    return {
      members: null,
      error: { code: "index_generation_retention_failed", message: "invalid manifest" },
    };
  }
  let names;
  try {
    names = retentionMemberNames(manifest.generation);
  } catch (e) {
    return {
      members: null,
      error: { code: "index_generation_retention_failed", message: e.message },
    };
  }
  const out = { bm25: null, hnsw: null, hnsw_meta: null };
  for (const key of MEMBER_KEYS) {
    const m = manifest.members[key] ?? null;
    if (m == null) continue;
    const src = join(dir, m.file);
    const dst = join(dir, names[key]);
    let srcSize = -1;
    try {
      srcSize = statSync(src).size;
    } catch (_e) {
      srcSize = -1;
    }
    if (srcSize !== m.size) {
      // The fixed path no longer holds the bytes this manifest recorded
      // (a successor save crashed after replacing the members but before
      // activating its manifest). NEVER overwrite an existing retention
      // snapshot with those foreign bytes — the snapshot (linked from the
      // then-matching fixed file) is the best candidate for the recorded
      // content; the checksum verify at fallback time stays the judge.
      if (existsSync(dst)) {
        out[key] = { file: names[key], size: m.size, sha256: m.sha256 };
        continue;
      }
      return {
        members: null,
        error: {
          code: "index_generation_retention_failed",
          member: key,
          file: m.file,
          message: `fixed member size ${srcSize} != recorded ${m.size} and no prior snapshot exists`,
        },
      };
    }
    // FIX CYCLE 2 (retention guard) — the size check above is spoofable: a
    // successor save that crashed AFTER replacing the fixed path with
    // same-size foreign bytes but BEFORE activating its manifest left src
    // passing size-only. Pre-fix, linkOrCopyReplace then OVERWROTE the good
    // existing snapshot (taken by that successor's own retention step) with
    // the foreign bytes — destroying the only fallback. Content-address the
    // conflict: an existing snapshot is only ever replaced when src PROVABLY
    // holds the recorded bytes (full sha256 — paid only on the rare
    // conflicting-snapshot path; the cheap first/last-block identity check
    // skips it when src and dst are the same bytes, e.g. a retried save).
    if (existsSync(dst)) {
      if (!sameFileContentCheap(src, dst)) {
        let srcSha = null;
        try {
          srcSha = sha256File(src);
        } catch (_e) {
          srcSha = null;
        }
        if (srcSha === m.sha256) {
          // src holds the recorded bytes; dst is a stale snapshot from an
          // older lineage (e.g. post-re-adoption generation-number reuse) —
          // replacing it is a repair.
          try {
            linkOrCopyReplace(src, dst);
          } catch (e) {
            return {
              members: null,
              error: {
                code: "index_generation_retention_failed",
                member: key,
                file: m.file,
                message: e.message,
              },
            };
          }
        }
        // else: same-size FOREIGN bytes at the fixed path — NEVER clobber
        // the existing snapshot; it is the best candidate for the recorded
        // content and the checksum verify at fallback time stays the judge.
      }
      out[key] = { file: names[key], size: m.size, sha256: m.sha256 };
      continue;
    }
    try {
      linkOrCopyReplace(src, dst);
    } catch (e) {
      return {
        members: null,
        error: {
          code: "index_generation_retention_failed",
          member: key,
          file: m.file,
          message: e.message,
        },
      };
    }
    out[key] = { file: names[key], size: m.size, sha256: m.sha256 };
  }
  return { members: out, error: null };
}

const RETENTION_FILE_RE = /^(?:bm25|hnsw)\.gen-(\d+)\./;

/**
 * gcGenerations(dir, manifest) → {removed: string[], error: object|null}
 *
 * Remove retention files of generations OLDER than the one retained
 * fallback. A generation is kept iff the active manifest still names it
 * (its own generation or previous.generation) — and, defensively, anything
 * at/after the active generation number is never touched. The fallback
 * generation is therefore never unlinked. Best-effort; never throws.
 */
export function gcGenerations(dir, manifest) {
  if (manifest == null || typeof manifest !== "object" || !Number.isSafeInteger(manifest.generation)) {
    return { removed: [], error: { code: "index_manifest_gc_failed", message: "invalid manifest" } };
  }
  const keep = new Set([manifest.generation]);
  if (manifest.previous != null && Number.isSafeInteger(manifest.previous.generation)) {
    keep.add(manifest.previous.generation);
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    return { removed: [], error: { code: "index_manifest_gc_failed", message: e.message } };
  }
  const removed = [];
  for (const f of entries) {
    const m = RETENTION_FILE_RE.exec(f);
    if (m == null) continue;
    const gen = Number(m[1]);
    if (!Number.isSafeInteger(gen)) continue;
    if (keep.has(gen) || gen >= manifest.generation) continue;
    try {
      unlinkSync(join(dir, f));
      removed.push(f);
    } catch (e) {
      console.error(`index-manifest: GC failed to remove ${f}: ${e.message}`);
    }
  }
  return { removed, error: null };
}
