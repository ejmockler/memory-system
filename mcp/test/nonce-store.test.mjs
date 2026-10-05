// Atomicity + recovery tests for lib/nonce-store.js.
//
// Validates the single-use property the verifier (step 4 of FIVE-STEP
// VERIFICATION ORDER) relies on. The nonce store is the chokepoint that turns
// every token into a one-shot — if checkAndConsume can be raced or if the
// startup recovery path mis-classifies tail vs mid-file corruption, the
// privilege system silently regresses.
//
// Run: node test/nonce-store.test.mjs
// Exits 0 on pass, non-zero on any failure.

import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

// HERMETICITY (round-14 C-NEW-2 hot-fix): set env vars BEFORE importing
// nonce-store.js / policy-events.js so config.js binds paths inside a tmpdir,
// NOT the live <checkout>. Static ESM imports are hoisted; dynamic
// import() after env mutation is the only way to override paths cleanly.
// Without this, _resetForTest() truncates the production consumed-nonces.jsonl
// and writes test pollution into the real policy-events log on every npm test.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-nonce-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

const {
  _PATHS,
  _resetForTest,
  checkAndConsume,
  ensureStoreReady,
  pruneExpired,
} = await import("../lib/nonce-store.js");
const { canonicalJson, CAPS } = await import("../lib/validation.js");
const { listRotatedFiles, currentActiveFile } = await import("../lib/policy-events.js");

// Absolute file URL to nonce-store.js — the eval'd worker source uses this
// for a dynamic import. Workers have their own module graph; reusing the
// same on-disk module means both workers hit the same .jsonl + .lock file,
// which is precisely what the lock under test must serialize.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NONCE_STORE_URL = new URL("../lib/nonce-store.js", import.meta.url).href;

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers — mirror the production line-format helpers so tests can fabricate
// both well-formed and corrupted lines without reaching into private exports.
// ---------------------------------------------------------------------------

const STORE_PATH = _PATHS.STORE_PATH;
const LOCK_PATH = _PATHS.LOCK_PATH;

// blake2b512 truncated to 16 bytes — mirrors the production helper in
// mcp/lib/nonce-store.js (the spec is frozen at that exact derivation; a
// native blake2b-128 engine would produce different bytes for the same input
// because BLAKE2 folds the digest length into its IV).
function blake2b512TruncTo16Hex(bytes) {
  return createHash("blake2b512").update(bytes).digest().subarray(0, 16).toString("hex");
}
function makeValidLine(nonceHash, tool, acceptedAt) {
  const checksum = blake2b512TruncTo16Hex(
    Buffer.from(canonicalJson({ nonce_hash: nonceHash, tool, accepted_at: acceptedAt }), "utf8"),
  );
  return (
    canonicalJson({ nonce_hash: nonceHash, tool, accepted_at: acceptedAt, checksum }) + "\n"
  );
}
function makeBadChecksumLine(nonceHash, tool, acceptedAt) {
  // Same shape but with a wrong checksum: passes JSON.parse, fails checksum.
  return (
    canonicalJson({
      nonce_hash: nonceHash,
      tool,
      accepted_at: acceptedAt,
      checksum: "00".repeat(16),
    }) + "\n"
  );
}

function hash(name) {
  // 64-hex sha256 of a label — checkAndConsume rejects anything that is not
  // /^[0-9a-f]{64}$/, so we synthesise stable test nonces this way.
  return createHash("sha256").update(name).digest("hex");
}

// Capture policy-events file before/after a test step so we can assert what
// reason (if any) ensureStoreReady wrote.
function readActiveEvents() {
  const path = currentActiveFile();
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text === "") return [];
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e != null);
}
function eventsSince(prevCount) {
  return readActiveEvents().slice(prevCount);
}

// Deterministic time pin for nonce-store accept_at / pruneExpired sweeps.
const PINNED_NOW = "2026-05-31T00:00:00Z";

// Bootstrap POLICY_DIR — nonce-store assumes the parent dir exists (it does
// in production because policy-events.js's ensurePolicyDir runs at module
// load on first append). Tests must create it explicitly so _resetForTest's
// writeFileSync does not silently swallow the ENOENT and leave us with no
// store at all.
mkdirSync(dirname(STORE_PATH), { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------------------
// 1. Fresh nonce accepted; replay rejected.
// ---------------------------------------------------------------------------
_resetForTest();
{
  const n = hash("fresh-1");
  const first = checkAndConsume(n, "memory_excise", { now: PINNED_NOW });
  check("fresh nonce ok=true", first.ok === true, JSON.stringify(first));
  check(
    "fresh nonce accepted_at echoes pinned now",
    first.accepted_at === PINNED_NOW,
    `got ${first.accepted_at}`,
  );

  const second = checkAndConsume(n, "memory_excise", { now: PINNED_NOW });
  check("replay nonce ok=false", second.ok === false);
  check(
    "replay nonce reason=nonce_replayed",
    second.reason === "nonce_replayed",
    `got ${second.reason}`,
  );
}

// ---------------------------------------------------------------------------
// 2. REAL concurrent race on the SAME nonce — two worker threads.
//     The previous Promise.all-of-sync version did NOT race anything: both
//     resolved promises wake on the same microtask queue inside a single
//     event-loop turn, and because checkAndConsume is synchronous, the
//     second callback simply runs after the first returns. No lock pressure.
//
//     review-12 M4 demands real concurrency. Two worker_threads Workers
//     each invoke checkAndConsume(n, ...) on the same nonce. They block on
//     a SharedArrayBuffer + Atomics.wait barrier so the main thread can
//     release both simultaneously via Atomics.notify(buf, 0, 2). That puts
//     both workers in the open() call near-simultaneously and exercises the
//     O_CREAT|O_EXCL .lock acquire under genuine OS-level contention.
//
//     Invariants under test (same as before, but actually proven now):
//       (i)   exactly one Worker wins (ok:true)
//       (ii)  exactly one Worker loses with reason:"nonce_replayed"
//       (iii) the store file contains EXACTLY one line afterwards
//
//     Repeat the race N=8 times so a fluke serialization (loser sleeping
//     on the barrier hand-off long enough that the winner finishes before
//     the loser even tries the lock) does not silently let a real bug
//     through. 8 rounds gives ~16 worker spawns; each round picks a fresh
//     nonce so a prior round's success doesn't shadow a later one.
// ---------------------------------------------------------------------------

// Inline worker source. Pure ESM; receives workerData with the nonce-store
// module URL, the nonce hash, the tool, the pinned now, and a SharedArrayBuffer
// view for the start barrier. Atomics.wait blocks until the main thread does
// Atomics.notify(view, 0, 2). Result is posted back as {ok, reason} so the
// main thread can tally winners / losers.
const RACE_WORKER_SRC = `
import { workerData, parentPort } from "node:worker_threads";
const view = new Int32Array(workerData.barrierSab);
// Block until the main thread releases both workers at once.
Atomics.wait(view, 0, 0);
const mod = await import(workerData.nonceStoreUrl);
const res = mod.checkAndConsume(workerData.nonce, workerData.tool, {
  now: workerData.now,
});
// Only forward the two fields the test inspects — avoids accidentally
// shipping non-cloneable values back across the structured-clone boundary.
parentPort.postMessage({ ok: res.ok === true, reason: res.reason ?? null });
`;

async function raceOnce(nonceLabel) {
  const n = hash(nonceLabel);
  // 4-byte SAB; index 0 starts at 0 so Atomics.wait blocks; we flip it and
  // notify both workers in one Atomics.notify call to wake them concurrently.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  const mkWorker = () =>
    new Worker(RACE_WORKER_SRC, {
      eval: true,
      workerData: {
        barrierSab: sab,
        nonceStoreUrl: NONCE_STORE_URL,
        nonce: n,
        tool: "memory_substitute",
        now: PINNED_NOW,
      },
    });
  const w1 = mkWorker();
  const w2 = mkWorker();
  const collect = (w) =>
    new Promise((resolveP, rejectP) => {
      w.once("message", (m) => resolveP(m));
      w.once("error", rejectP);
      w.once("exit", (code) => {
        if (code !== 0) rejectP(new Error(`worker exited ${code}`));
      });
    });
  const p1 = collect(w1);
  const p2 = collect(w2);
  // Give both workers a beat to reach Atomics.wait before we notify; without
  // this the notify can race the wait and one worker will spin past the
  // barrier with no effect. A single setImmediate is sufficient — workers
  // hit the wait inside their first JS turn after spawn.
  await new Promise((r) => setImmediate(r));
  // Flip the barrier value (Atomics.wait wakes only when value differs from
  // the expected, but here we also call notify which wakes regardless of
  // value mismatch — belt and braces).
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0, 2);
  const [r1, r2] = await Promise.all([p1, p2]);
  // Terminate the workers; they have already posted and are about to exit.
  await Promise.all([w1.terminate(), w2.terminate()]);
  return [r1, r2];
}

_resetForTest();
{
  const ROUNDS = 8;
  let allWinsExactlyOne = true;
  let allLosersReplayed = true;
  let allStoreLineCounts = []; // record cumulative line count after each round
  for (let i = 0; i < ROUNDS; i += 1) {
    const results = await raceOnce(`race-real-${i}`);
    const wins = results.filter((r) => r.ok === true);
    const losses = results.filter((r) => r.ok === false);
    if (wins.length !== 1) allWinsExactlyOne = false;
    if (losses.length !== 1) allLosersReplayed = false;
    if (losses[0]?.reason !== "nonce_replayed") allLosersReplayed = false;
    const lineCount = readFileSync(STORE_PATH, "utf8")
      .split("\n")
      .filter((l) => l !== "").length;
    allStoreLineCounts.push(lineCount);
  }
  check(
    `worker-thread race (${ROUNDS} rounds): EVERY round produced exactly one winner`,
    allWinsExactlyOne === true,
  );
  check(
    `worker-thread race (${ROUNDS} rounds): EVERY round produced exactly one loser with reason="nonce_replayed"`,
    allLosersReplayed === true,
  );
  // After N rounds with N distinct nonces, the store must contain exactly N
  // accepted lines — never N*2 (double-write) and never <N (lock starvation).
  check(
    `worker-thread race (${ROUNDS} rounds): cumulative store line count grows by exactly 1 per round`,
    allStoreLineCounts.length === ROUNDS &&
      allStoreLineCounts.every((cnt, idx) => cnt === idx + 1),
    `lineCounts=[${allStoreLineCounts.join(",")}]`,
  );
}

// ---------------------------------------------------------------------------
// 3. pruneExpired with a future `now` removes entries past TTL.
// ---------------------------------------------------------------------------
_resetForTest();
{
  const old = hash("old-entry");
  const fresh = hash("fresh-entry");
  // Insert "old" at PINNED_NOW.
  const r1 = checkAndConsume(old, "memory_replace", { now: PINNED_NOW });
  check("prune setup: old inserted", r1.ok === true);
  // Insert "fresh" 6 days later — still well within TTL at prune time.
  const sixDaysLaterMs = Date.parse(PINNED_NOW) + 6 * 24 * 60 * 60 * 1000;
  const sixDaysLaterIso = new Date(sixDaysLaterMs).toISOString();
  const r2 = checkAndConsume(fresh, "memory_replace", { now: sixDaysLaterIso });
  check("prune setup: fresh inserted", r2.ok === true);

  // Advance the clock past CONSUMED_NONCE_TTL for "old" but not for "fresh".
  // CONSUMED_NONCE_TTL_SECONDS = 604800 (7 days). Pick now = old + 7d + 1h:
  //   old age = 7d + 1h  → > TTL → pruned
  //   fresh age = 1d + 1h → < TTL → retained
  const futureMs = Date.parse(PINNED_NOW) + 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;
  const futureIso = new Date(futureMs).toISOString();
  const pruneRes = pruneExpired({ now: futureIso });
  check(
    "prune removes exactly the expired entry",
    pruneRes.pruned_count === 1,
    `pruned_count=${pruneRes.pruned_count}`,
  );

  // "old" must now be insertable again; "fresh" must still be a replay.
  const reuseOld = checkAndConsume(old, "memory_replace", { now: futureIso });
  check("prune: expired nonce slot reclaimed", reuseOld.ok === true);
  const reuseFresh = checkAndConsume(fresh, "memory_replace", { now: futureIso });
  check(
    "prune: kept nonce still rejects replay",
    reuseFresh.ok === false && reuseFresh.reason === "nonce_replayed",
    `got ${JSON.stringify(reuseFresh)}`,
  );
}

// ---------------------------------------------------------------------------
// 4. ensureStoreReady on a fabricated corrupt-TAIL file — truncates +
//    emits policy.token.rejected reason "corrupt_tail_truncated".
// ---------------------------------------------------------------------------
_resetForTest();
{
  const goodLine = makeValidLine(hash("tail-good"), "memory_excise", PINNED_NOW);
  const badTail = makeBadChecksumLine(hash("tail-bad"), "memory_excise", PINNED_NOW);
  writeFileSync(STORE_PATH, goodLine + badTail, { mode: 0o600 });

  const before = readActiveEvents().length;
  const res = ensureStoreReady({ now: PINNED_NOW });
  check(
    "tail-corruption: ensureStoreReady reports truncated_corrupt_tail",
    res.truncated_corrupt_tail === true,
    JSON.stringify(res),
  );
  const after = readFileSync(STORE_PATH, "utf8");
  check(
    "tail-corruption: store truncated to last good offset",
    after === goodLine,
    `len=${after.length}`,
  );
  const events = eventsSince(before);
  const tailEvt = events.find(
    (e) => e.kind === "policy.token.rejected" && e.reason === "corrupt_tail_truncated",
  );
  check(
    "tail-corruption: emitted policy.token.rejected reason=corrupt_tail_truncated",
    tailEvt != null,
    `events=${JSON.stringify(events)}`,
  );

  // After truncation the good line's nonce still rejects on replay — the
  // recovery did not silently drop accepted state.
  const replay = checkAndConsume(hash("tail-good"), "memory_excise", { now: PINNED_NOW });
  check(
    "tail-corruption: surviving good entry still rejects replay",
    replay.ok === false && replay.reason === "nonce_replayed",
  );
}

// ---------------------------------------------------------------------------
// 5. ensureStoreReady on MID-FILE corruption (good, bad, good) — throws +
//    emits policy.token.rejected reason "nonce_store_corrupted".
// ---------------------------------------------------------------------------
_resetForTest();
{
  const g1 = makeValidLine(hash("mid-g1"), "memory_excise", PINNED_NOW);
  const bad = makeBadChecksumLine(hash("mid-bad"), "memory_excise", PINNED_NOW);
  const g2 = makeValidLine(hash("mid-g2"), "memory_excise", PINNED_NOW);
  writeFileSync(STORE_PATH, g1 + bad + g2, { mode: 0o600 });

  const before = readActiveEvents().length;
  let threw = false;
  try {
    ensureStoreReady({ now: PINNED_NOW });
  } catch {
    threw = true;
  }
  check("mid-corruption: ensureStoreReady throws", threw === true);
  const events = eventsSince(before);
  const midEvt = events.find(
    (e) => e.kind === "policy.token.rejected" && e.reason === "nonce_store_corrupted",
  );
  check(
    "mid-corruption: emitted policy.token.rejected reason=nonce_store_corrupted",
    midEvt != null,
    `events=${JSON.stringify(events)}`,
  );
}

// ---------------------------------------------------------------------------
// 6. Stale-lock reclaim — a .lock file written by a dead PID with ancient
//    mtime must NOT block checkAndConsume; the holder reclaims and proceeds.
// ---------------------------------------------------------------------------
_resetForTest();
{
  // Use a PID that is overwhelmingly unlikely to be alive: 0x3B9AC9FF
  // (~999999999). pidAlive() returns false for ESRCH.
  const deadPid = 999999999;
  // Write the lock body, then back-date its mtime by 10 minutes (well past
  // STALE_LOCK_RECOVERY_SECONDS = 60).
  const body = canonicalJson({ pid: deadPid, heartbeat_ts: PINNED_NOW });
  const fd = openSync(LOCK_PATH, "w", 0o600);
  writeSync(fd, body);
  closeSync(fd);
  const ancientMs = Date.now() - 10 * 60 * 1000;
  const { utimesSync } = await import("node:fs");
  utimesSync(LOCK_PATH, new Date(ancientMs), new Date(ancientMs));
  check("stale-lock setup: .lock present", existsSync(LOCK_PATH));

  const n = hash("reclaim-1");
  const res = checkAndConsume(n, "memory_excise", { now: PINNED_NOW });
  check(
    "stale-lock: checkAndConsume reclaims and succeeds",
    res.ok === true,
    JSON.stringify(res),
  );
  // Lock should be released (and thus absent) after the critical section.
  check("stale-lock: .lock cleaned up after release", !existsSync(LOCK_PATH));
}

// ---------------------------------------------------------------------------
// 7. _resetForTest produces a clean slate — covered implicitly by every
//    previous test, but assert directly for documentation value.
// ---------------------------------------------------------------------------
{
  const n = hash("reset-1");
  checkAndConsume(n, "memory_excise", { now: PINNED_NOW });
  _resetForTest();
  const after = checkAndConsume(n, "memory_excise", { now: PINNED_NOW });
  check("_resetForTest: same nonce re-accepted after reset", after.ok === true);
  // And the lock path is gone.
  check("_resetForTest: lock file absent", !existsSync(LOCK_PATH));
}

// Final cleanup so we do not leave state for sibling tests.
_resetForTest();

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll nonce-store assertions passed.`);
