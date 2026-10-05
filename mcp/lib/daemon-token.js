// Daemon-signed token helpers: signing-key file lifecycle, mint, and verify.
// Phase 1 deliverable. Mirrors the discipline spelled in
// kb/mcp-surface.md § Privilege levels → "Daemon-signed token: signing key
// + minting" and § "Daemon-signed token verification (normative)".
//
// What lives here:
//  - loadSigningKey() — reads <MEMORY_ROOT>/policy/distillation-signing-key.json
//    with the on-disk discipline (mode 0600, O_NOFOLLOW open flag, nlink == 1,
//    version == 1, 64-char lowercase-hex key).
//  - initSigningKey() — first-start generator: O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW
//    write of a freshly randBytes(32) key, then re-load via loadSigningKey().
//  - mintToken(bindingHash, tool, key, opts) — produces the wire token
//    base64url(canonical_json(payload)) + "." + base64url(signature),
//    where signature is the 32 RAW bytes of HMAC-SHA256(key, canonical_json).
//  - verifyToken(token, key, opts) — runs spec steps 0 (wire), 1 (type+freshness),
//    2 (signature). Steps 3 (binding), 4 (nonce single-use), 5 (consent) are
//    the verifier-side concern and live in the dispatch path; verifyBinding()
//    here is the helper for step 3.
//  - verifyBinding(payload, expectedBindingObject) — recompute canonical sha256
//    over the expected binding object and compare to payload.binding_hash.
//
// Determinism for tests: mintToken accepts opts.nonce_hex, opts.issued_at,
// opts.expires_at; verifyToken accepts opts.now. All are ISO-8601 strings
// (or 32-hex for nonce_hex) — callers can pin "2026-05-31T00:00:00Z" and get
// byte-stable tokens. Production calls pass none of these and pick up
// serverTs() / randomBytes(16) defaults.

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, canonicalJsonSha256Hex } from "./validation.js";
import { serverTs } from "./envelope.js";
import { signingKeyPath } from "./config.js";

// DISTILLATION_TOKEN_TTL_SECONDS is not in CAPS (validation.js); inline per
// kb/mcp-surface.md § Caps. Invariant: <= CONSUMED_NONCE_TTL_SECONDS (604800).
const DISTILLATION_TOKEN_TTL_SECONDS = 300;
const CONSUMED_NONCE_TTL_SECONDS = 604800;

// Signing-key path sourced from lib/config.js so env overrides redirect
// the file every test reads/writes. Do NOT inline join(homedir(),
// "memory-system", "policy", ...).
const SIGNING_KEY_PATH = signingKeyPath();

const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// KEY CUSTODY (round-15, C-NEW-3) — read this before changing anything below.
//
// The signing key is a SECRET. The whole privilege model — and the audit
// reach of every policy.token.* event — collapses if it leaks.
//
// Threat model:
//   - The key authorises a process to mint daemon-signed tokens that the
//     MCP server accepts as a distillation supervisor. With the key, anyone
//     can promote arbitrary facts into the long-term memory.
//   - The key is materialised on disk because the supervisor and the MCP
//     server are separate processes and need an out-of-band channel to
//     agree on the HMAC secret. Phase 1's threat model assumes a single-user
//     macOS host with the home dir owned by one trusted user.
//
// On-disk discipline (enforced in readSigningKeyFile + initSigningKey):
//   - mode 0600 (owner rw, no group / world bits)
//   - nlink == 1   (no hardlink defeating the mode bits)
//   - O_NOFOLLOW   (no symlink swap between stat-and-open)
//   - O_EXCL on create (refuse-to-overwrite at init time)
//   - fsync before close on init (no zero-length file on crash mid-write)
//
// Hard rules (operator-side):
//   - The signing key MUST NOT be checked into version control. The
//     project-root .gitignore explicitly excludes
//     it, and policy/.gitignore excludes the entire
//     directory as defence in depth. A startup-time tripwire (see
//     warnOnceIfInsideWorkingTree() below) yells to stderr if the key file is
//     materialised inside any ancestor directory that contains a .git
//     subdirectory.
//   - Production deployments SHOULD set MEMORY_ROOT to a path that is
//     OUTSIDE any git working tree (e.g. /var/lib/memory-system or
//     $HOME/Library/Application Support/memory-system).
//   - If the key is ever exposed (committed, written to a world-readable
//     location, dumped to a log, scraped via a backup), the only safe response
//     is to ROTATE: delete the file and let initSigningKey() generate a new
//     one. There is no "revoke" — every prior token signed with the old key
//     remains structurally valid against the old HMAC, so the only fix is to
//     never accept that HMAC again.
//
// Future work (deferred to Phase 4+):
//   - Multi-user / shared-host deployments need OS-keychain-backed storage
//     (macOS keychain, Linux secret-service, libsecret). The Phase 1 file
//     discipline does NOT generalise: 0600 means nothing if root or any other
//     uid can read the file.
//   - Rotation cadence + dual-signing-key window. Today the key file is the
//     single live secret; a future revision should keep N-2 keys in a ring
//     for verifier-side acceptance, so rotation can roll without invalidating
//     in-flight tokens.
// ---------------------------------------------------------------------------

// One-shot guard for the working-tree tripwire so we don't spam stderr on
// every loadSigningKey() call (the supervisor calls it once per startup,
// but tests / inline self-tests can call it many times per process).
let __workingTreeWarned = false;

// Walk parent dirs from POLICY_DIR up to the filesystem root; if any has a
// .git subdir (file or directory — submodule pointers are .git files), the
// signing key is materialised INSIDE a git working tree, which is the
// materialization-in-working-tree class of bug we hit in round-14 (C-NEW-3).
// Warning goes to stderr because (a) MCP servers reserve stdout for the
// JSON-RPC framing and (b) operators read stderr for startup health.
function warnOnceIfInsideWorkingTree(keyPath) {
  if (__workingTreeWarned) return;
  __workingTreeWarned = true;
  try {
    let dir = dirname(keyPath);
    // Cap the walk at the filesystem root to avoid an infinite loop if
    // someone passes a relative path that dirname-loops on ".".
    let lastDir = "";
    while (dir && dir !== lastDir) {
      const gitMarker = `${dir}/.git`;
      if (existsSync(gitMarker)) {
        // Use process.stderr.write rather than console.error so the message
        // shows up even when the caller has remapped console.* (the MCP
        // child does this to keep stdout JSON-RPC-clean).
        const msg =
          `CRITICAL: signing key at ${keyPath} is inside a git working tree ` +
          `(.git found at ${gitMarker}). Do NOT commit this file. ` +
          `Add policy/distillation-signing-key.json to .gitignore and move ` +
          `MEMORY_ROOT to a directory outside any working tree.\n`;
        try {
          process.stderr.write(msg);
        } catch {
          // stderr write should never throw, but if it does (closed fd in
          // some test harness), we silently swallow rather than crash the
          // process — the tripwire is advisory, not load-bearing.
        }
        return;
      }
      lastDir = dir;
      dir = dirname(dir);
    }
  } catch {
    // Any unexpected error (permission denied on dirname walk, etc.) is
    // non-fatal — the tripwire is advisory; production discipline is the
    // gitignore + the operator setting MEMORY_ROOT correctly.
  }
}

// Test-only reset hook for the one-time warning flag. NOT exported as part
// of the public surface; tests that need it import via _resetWorkingTreeWarning.
export function _resetWorkingTreeWarning() {
  __workingTreeWarned = false;
}

// Internal: open the signing-key file with the on-disk discipline required by
// the spec (mode 0600, O_NOFOLLOW, nlink == 1). Returns the raw JSON string.
// Throws on any discipline violation — fail-shut, no silent fallback.
function readSigningKeyFile(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    // mode 0600: owner read+write, no group/other bits.
    const modeBits = st.mode & 0o777;
    if (modeBits !== 0o600) {
      throw new Error(
        `signing-key file ${path} has mode ${modeBits.toString(8)}, expected 600`,
      );
    }
    if (st.nlink !== 1) {
      throw new Error(
        `signing-key file ${path} has nlink ${st.nlink}, expected 1 (hardlink defense)`,
      );
    }
    // Buffer the bytes via fs.readFileSync(fd) so we stay on the same fd we
    // just stat-ed; closes are explicit in the finally.
    const buf = readFileSync(fd);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// Public: read and validate the signing key. Returns {version, key} where
// key is a 32-byte Buffer. Throws on missing file or any conformance failure.
export function loadSigningKey({ path = SIGNING_KEY_PATH } = {}) {
  // Tripwire (round-15, C-NEW-3): yell to stderr ONCE per process if the key
  // file is materialised inside a git working tree. Runs before the file
  // read so even a permission-denied read still triggers the warning.
  warnOnceIfInsideWorkingTree(path);
  const raw = readSigningKeyFile(path);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`signing-key file ${path} is not valid JSON: ${err.message}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`signing-key file ${path} must be a JSON object`);
  }
  if (parsed.version !== 1) {
    throw new Error(
      `signing-key file ${path} has version ${parsed.version}, expected 1`,
    );
  }
  if (typeof parsed.key_hex !== "string" || !HEX64_RE.test(parsed.key_hex)) {
    throw new Error(
      `signing-key file ${path} key_hex must be 64 lowercase hex chars`,
    );
  }
  const key = Buffer.from(parsed.key_hex, "hex");
  if (key.length !== 32) {
    // Defense in depth: regex already enforces 64 chars, but the decoded
    // length is the actual invariant the HMAC depends on.
    throw new Error(`signing-key decoded length ${key.length}, expected 32`);
  }
  return { version: parsed.version, key };
}

// Public: first-start key generation. Atomic O_CREAT|O_EXCL write at mode 0600;
// loser of a startup race reads the winner's file. Errors if the file already
// exists — explicit refusal-to-overwrite per spec.
export function initSigningKey({ path = SIGNING_KEY_PATH } = {}) {
  const keyBytes = randomBytes(32);
  const keyHex = keyBytes.toString("hex");
  const payload = JSON.stringify({ version: 1, key_hex: keyHex });
  // O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, mode 0600. The O_NOFOLLOW prevents
  // racing a symlink in between check and create. EEXIST surfaces verbatim so
  // callers can distinguish "already present" from corruption.
  const fd = openSync(
    path,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    // node:fs writeSync may short-write; loop until the buffer is exhausted.
    // fsync the fd before close so a crash mid-init does not leave a
    // zero-length file that the next start tries to read.
    const buf = Buffer.from(payload, "utf8");
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return loadSigningKey({ path });
}

// canonical_json(payload) sorted-key order is enforced by the canonicalize
// library; we just hand it the literal object. The frozen-key order documented
// in the spec (binding_hash, expires_at, issued_at, nonce, type) is what JCS
// produces given lexicographic UTF-16 sort — no need to pre-sort.
function buildPayload(bindingHash, nonceHex, issuedAt, expiresAt) {
  return {
    binding_hash: bindingHash,
    expires_at: expiresAt,
    issued_at: issuedAt,
    nonce: nonceHex,
    type: "daemon",
  };
}

function base64urlEncode(buf) {
  return Buffer.isBuffer(buf)
    ? buf.toString("base64url")
    : Buffer.from(buf, "utf8").toString("base64url");
}

function base64urlDecode(str) {
  // Buffer.from accepts base64url since Node 16; if the input is malformed
  // we return a zero-length buffer rather than throw, and the caller maps
  // that to the spec's "malformed" reject.
  if (typeof str !== "string") return Buffer.alloc(0);
  return Buffer.from(str, "base64url");
}

function isoPlusSeconds(isoBaseline, seconds) {
  // Add N seconds to an ISO-8601 string and re-serialize via toISOString().
  const baseMs = Date.parse(isoBaseline);
  if (!Number.isFinite(baseMs)) {
    throw new Error(`isoPlusSeconds: invalid baseline ${isoBaseline}`);
  }
  return new Date(baseMs + seconds * 1000).toISOString();
}

// Public: mint a daemon-signed token. Returns the wire token plus the raw
// nonce (caller may want to log nonce_hash) and the issued_at / expires_at
// timestamps it bound. opts are the test-determinism knobs.
export function mintToken(bindingHash, tool, key, opts = {}) {
  if (typeof bindingHash !== "string" || !/^[0-9a-f]{64}$/.test(bindingHash)) {
    throw new Error("mintToken: bindingHash must be 64 lowercase hex chars");
  }
  if (typeof tool !== "string" || tool === "") {
    throw new Error("mintToken: tool must be a non-empty string");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("mintToken: key must be a 32-byte Buffer");
  }
  const nonceHex =
    opts.nonce_hex != null ? opts.nonce_hex : randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(nonceHex)) {
    throw new Error("mintToken: nonce_hex must be 32 lowercase hex chars");
  }
  const issuedAt = opts.issued_at != null ? opts.issued_at : serverTs();
  const expiresAt =
    opts.expires_at != null
      ? opts.expires_at
      : isoPlusSeconds(issuedAt, DISTILLATION_TOKEN_TTL_SECONDS);

  const payload = buildPayload(bindingHash, nonceHex, issuedAt, expiresAt);
  const payloadCanonical = canonicalJson(payload);
  const payloadBytes = Buffer.from(payloadCanonical, "utf8");
  const signature = createHmac("sha256", key).update(payloadBytes).digest();
  if (signature.length !== 32) {
    // crypto.createHmac('sha256') always produces 32 bytes; the assert is a
    // belt-and-suspenders guard against a future Node API change.
    throw new Error("mintToken: HMAC-SHA256 output is not 32 bytes");
  }
  const token = `${base64urlEncode(payloadBytes)}.${base64urlEncode(signature)}`;
  return { token, nonce_hex: nonceHex, issued_at: issuedAt, expires_at: expiresAt };
}

// Public: verify a daemon-signed token. Runs the spec's steps 0-2 (wire
// split, type+freshness, signature). Steps 3-5 (binding, nonce single-use,
// consent) live in the dispatch / nonce-store callers; verifyBinding() here
// is the helper for step 3.
//
// Returns either {ok: true, payload, nonce_hash} or {ok: false, reason}
// where reason is one of: "malformed", "wrong_type", "expired",
// "stale_issue", "ttl_overrun", "bad_signature".
export function verifyToken(token, key, opts = {}) {
  // Step 0: wire shape. Must split on "." into exactly two parts.
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const dot = token.indexOf(".");
  if (dot < 0 || token.indexOf(".", dot + 1) >= 0) {
    return { ok: false, reason: "malformed" };
  }
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (payloadB64 === "" || sigB64 === "") {
    return { ok: false, reason: "malformed" };
  }

  const payloadBytes = base64urlDecode(payloadB64);
  if (payloadBytes.length === 0) return { ok: false, reason: "malformed" };
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    payload == null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.type !== "string" ||
    typeof payload.binding_hash !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.issued_at !== "string" ||
    typeof payload.expires_at !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }

  // Step 1: type and freshness. Type FIRST so type-routed tokens get
  // wrong_type rather than bad_signature (no HMAC oracle on type-routed
  // payloads).
  if (payload.type !== "daemon") return { ok: false, reason: "wrong_type" };

  const nowIso = opts.now != null ? opts.now : serverTs();
  const nowMs = Date.parse(nowIso);
  const expiresMs = Date.parse(payload.expires_at);
  const issuedMs = Date.parse(payload.issued_at);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(expiresMs) ||
    !Number.isFinite(issuedMs)
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (expiresMs <= nowMs) return { ok: false, reason: "expired" };
  const ageSeconds = (nowMs - issuedMs) / 1000;
  if (ageSeconds > DISTILLATION_TOKEN_TTL_SECONDS) {
    return { ok: false, reason: "stale_issue" };
  }
  // ttl_overrun: expires_at must fit inside the nonce-store retention window.
  if (expiresMs > nowMs + CONSUMED_NONCE_TTL_SECONDS * 1000) {
    return { ok: false, reason: "ttl_overrun" };
  }

  // Step 2: signature. Recompute canonical_json(payload) from the parsed
  // object (NOT from the wire bytes — the wire bytes might encode the same
  // payload non-canonically, and verifying against those would let a forger
  // smuggle alternate encodings past the HMAC). Compare via timingSafeEqual
  // after a length-equality non-secret guard.
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    // Caller bug, not a token defect; surface clearly rather than as
    // bad_signature.
    throw new Error("verifyToken: key must be a 32-byte Buffer");
  }
  const recomputed = createHmac("sha256", key)
    .update(Buffer.from(canonicalJson(payload), "utf8"))
    .digest();
  const presented = base64urlDecode(sigB64);
  if (presented.length !== recomputed.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(presented, recomputed)) {
    return { ok: false, reason: "bad_signature" };
  }

  const nonceHash = createHash("sha256").update(payload.nonce).digest("hex");
  return { ok: true, payload, nonce_hash: nonceHash };
}

// Public: step 3 helper. Recompute binding_hash from the expected binding
// object and compare to payload.binding_hash. Caller (dispatch) decides what
// to do on mismatch (reason "binding_mismatch" + reject without consuming
// nonce — preserves the nonce slot for the legitimate caller).
export function verifyBinding(payload, expectedBindingObject) {
  if (payload == null || typeof payload.binding_hash !== "string") return false;
  const expected = canonicalJsonSha256Hex(expectedBindingObject);
  return expected === payload.binding_hash;
}

// ---------------------------------------------------------------------------
// Inline 6-line self-test (only runs when invoked directly: `node daemon-token.js`).
// ---------------------------------------------------------------------------
const __isMain = (() => {
  try {
    return import.meta.url === `file://${fileURLToPath(import.meta.url)}`
      ? process.argv[1] === fileURLToPath(import.meta.url)
      : false;
  } catch {
    return false;
  }
})();

if (__isMain) {
  const k = randomBytes(32);
  const bh = canonicalJsonSha256Hex({ a: 1 });
  const { token } = mintToken(bh, "memory_distill_promote_fact", k);
  const v = verifyToken(token, k);
  if (!v.ok) throw new Error(`self-test failed: ${v.reason}`);
  console.error("daemon-token self-test ok");
}
