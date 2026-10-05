// index-publish-ordering.test.mjs — the PUBLISH-WINDOW false-positive refusal.
//
// THE DEFECT. `_publishGenerationLocked` (lib/recall/index-cache.js) writes the
// members at their FIXED paths (bm25.json first, then the 2.0 GB hnsw.bin) and
// only afterwards renames index-manifest.json into place. That rename is the
// ONLY publication event (lib/recall/index-manifest.js:10-12), and the window
// between the member writes and the rename is DELIBERATE and documented at
// lib/recall/index-cache.js:1473-1479 ("Until it lands, readers keep verifying
// against the OLD manifest"). In production that window is tens of seconds.
//
// The reader mishandled it. loadIndices' warm-hit gate ANDed the manifest
// fingerprint with `_entryMemberFpsMatch(cached)` (a mtimeMs:size compare of
// the member files). Mid-publish, bm25.json already holds generation N+1's
// bytes while the manifest still describes generation N, so the member compare
// failed, the warm hit was skipped, and a full COLD manifest-gated load ran —
// which then verified the still-gen-N manifest against the already-gen-N+1
// bm25.json and REFUSED the active generation on the size check. queryd's watch
// tick (mcp/daemon/queryd.js:565-592, every watchIntervalMs = 2000) walked
// straight into it: one spurious full re-deserialize of hnsw.bin per
// generation, inside the event loop, plus a `degraded_reason:
// "index_generation_refused"` stamped onto memory_recall for a perfectly
// healthy corpus.
//
// Live evidence (read-only, 2026-08-11):
//   grep -c "REFUSING index generation" daemons/logs/queryd.stderr -> 78
//   100% member=bm25, 100% code=index_manifest_member_mismatch, and in every
//   case the logged actual_size equals the NEXT generation's expected_size.
//
// ===========================================================================
// RED-FIRST EVIDENCE — verbatim failing run against the UNMODIFIED
// lib/recall/index-cache.js (2026-08-11, branch memperf-fixes;
// `cd mcp && node --test test/recall/index-publish-ordering.test.mjs`):
//
//   ✖ T1 warm manifest-managed entry survives the mid-publish member rewrite (no re-deserialize, no refusal) (76.4145ms)
//   ✖ T2 cold load inside a live publish window: retained generation served, classified in-flight, NOT refused (37.868833ms)
//   ✔ T3 anti-masking: NO lock and a STALE lock both keep the loud REFUSING path byte-for-byte (74.506709ms)
//   ✔ T4 legacy/unmanaged entry keeps member-fingerprint invalidation (785.556375ms)
//   ✔ ledgers/memory.jsonl was never created by this suite (0.128958ms)
//   ℹ tests 5
//   ℹ suites 0
//   ℹ pass 3
//   ℹ fail 2
//   ℹ cancelled 0
//   ℹ skipped 0
//   ℹ todo 0
//   ℹ duration_ms 1049.615083
//
//   ✖ failing tests:
//
//   test at test/recall/index-publish-ordering.test.mjs:277:7
//   ✖ T1 warm manifest-managed entry survives the mid-publish member rewrite (no re-deserialize, no refusal) (76.4145ms)
//     AssertionError [ERR_ASSERTION]: RED: the warm entry was DROPPED and the generation re-deserialized (bm25 identity)
//
//     false !== true
//
//         at TestContext.<anonymous> (file:///<checkout>/mcp/test/recall/index-publish-ordering.test.mjs:298:10)
//         at Test.runInAsyncScope (node:async_hooks:227:14)
//         at Test.run (node:internal/test_runner/test:1201:25)
//         at Test.start (node:internal/test_runner/test:1096:17)
//         at startSubtestAfterBootstrap (node:internal/test_runner/harness:385:17)
//         at async file:///<checkout>/mcp/test/recall/index-publish-ordering.test.mjs:277:1 {
//       generatedMessage: false,
//       code: 'ERR_ASSERTION',
//       actual: false,
//       expected: true,
//       operator: 'strictEqual',
//       diff: 'simple'
//     }
//
//   test at test/recall/index-publish-ordering.test.mjs:330:7
//   ✖ T2 cold load inside a live publish window: retained generation served, classified in-flight, NOT refused (37.868833ms)
//     AssertionError [ERR_ASSERTION]: RED: an in-flight publication must not degrade recall ({"code":"index_manifest_member_mismatch","member":"bm25","served":"fallback"})
//     + actual - expected
//
//     + {
//     +   code: 'index_manifest_member_mismatch',
//     +   member: 'bm25',
//     +   served: 'fallback'
//     + }
//     - null
//
//         at TestContext.<anonymous> (file:///<checkout>/mcp/test/recall/index-publish-ordering.test.mjs:358:12)
//         at Test.runInAsyncScope (node:async_hooks:227:14)
//         at Test.run (node:internal/test_runner/test:1201:25)
//         at Test.start (node:internal/test_runner/test:1096:17)
//         at startSubtestAfterBootstrap (node:internal/test_runner/harness:385:17)
//         at run (node:internal/test_runner/harness:396:12)
//         at test (node:internal/test_runner/harness:405:12)
//         at file:///<checkout>/mcp/test/recall/index-publish-ordering.test.mjs:330:7 {
//       generatedMessage: false,
//       code: 'ERR_ASSERTION',
//       actual: { code: 'index_manifest_member_mismatch', member: 'bm25', served: 'fallback' },
//       expected: null,
//       operator: 'strictEqual',
//       diff: 'simple'
//     }
//
// (The line numbers above are the RED run's; this header block shifted them.
// T3 and T4 are guard rails, not the reproduction: they pass pre-fix by
// construction and must STILL pass post-fix — T3 pins that a genuine member
// mismatch stays loud, T4 pins that legacy/unmanaged entries keep
// member-fingerprint invalidation as their only change signal.)
// ===========================================================================
//
// ===========================================================================
// WAVE 2 RED — the first fix was too wide in one direction and too quiet in
// another. Two defects, two new cases, run VERBATIM against the wave-1
// lib/recall/index-cache.js (2026-08-11, branch memperf-fixes;
// `cd mcp && node --test test/recall/index-publish-ordering.test.mjs`):
//
//   R1  the warm-gate suppression was UNCONDITIONAL. Every manifest-managed
//       warm entry skipped member-fingerprint invalidation with NO lease
//       consulted on that path, so an absent or STALE lease still suppressed —
//       a genuine out-of-band member corruption on a warm process would have
//       been served silently forever. T3c is the case that sees it: T3 calls
//       _resetCaches() immediately before its load and therefore only ever
//       covered the COLD gate.
//   R2  SILENT EMPTY was reachable. The cold-path `continue` skipped
//       noteActiveRefusal, so an exhausted walk returned a bare null and
//       loadIndices had nothing to stamp: with a fresh lease, a member skew,
//       no retention snapshot and no `previous`, recall served EMPTY with
//       generation_refused === null. T5 is that measurement.
//
// T1 was ALSO made production-faithful in this wave (it now stages the window
// with the publisher's lease held, as production does). It PASSES pre-fix —
// precisely because the wave-1 suppression was unconditional and did not need
// the lease. It is T3c, not T1, that turns the lease into a load-bearing
// conjunct; T1 is what proves the lease-gated form still suppresses.
//
//   ✔ T1 warm manifest-managed entry survives the mid-publish member rewrite (no re-deserialize, no refusal) (77.255166ms)
//   ✔ T2 cold load inside a live publish window: retained generation served, classified in-flight, NOT refused (38.05825ms)
//   ✔ T3 anti-masking: NO lock and a STALE lock both keep the loud REFUSING path byte-for-byte (74.242792ms)
//   ✖ T3c anti-masking on the WARM gate: NO lock and a STALE lock both drop the warm entry and refuse loudly (66.645792ms)
//   ✔ T4 legacy/unmanaged entry keeps member-fingerprint invalidation (787.143875ms)
//   ✖ T5 in-flight + nothing survives: the empty serve is MARKED, never silent (43.613042ms)
//   ✔ ledgers/memory.jsonl was never created by this suite (0.097416ms)
//   ℹ tests 7
//   ℹ suites 0
//   ℹ pass 5
//   ℹ fail 2
//   ℹ cancelled 0
//   ℹ skipped 0
//   ℹ todo 0
//   ℹ duration_ms 1166.512375
//
//   ✖ failing tests:
//
//   test at test/recall/index-publish-ordering.test.mjs:573:7
//   ✖ T3c anti-masking on the WARM gate: NO lock and a STALE lock both drop the warm entry and refuse loudly (66.645792ms)
//     AssertionError [ERR_ASSERTION]: warm-no-lock: a genuine member mismatch must still REFUSE loudly (got [])
//
//     0 !== 1
//
//         at assertLoud (file:///<checkout>/mcp/test/recall/index-publish-ordering.test.mjs:499:10)
//         at TestContext.<anonymous> (file:///<checkout>/mcp/test/recall/index-publish-ordering.test.mjs:574:3)
//         at Test.runInAsyncScope (node:async_hooks:227:14)
//         at Test.run (node:internal/test_runner/test:1201:25)
//         at Test.start (node:internal/test_runner/test:1096:17)
//         at startSubtestAfterBootstrap (node:internal/test_runner/harness:385:17)
//         at run (node:internal/test_runner/harness:396:12)
//         at test (node:internal/test_runner/harness:405:12)
//         at file:///<checkout>/mcp/test/recall/index-publish-ordering.test.mjs:573:7 {
//       generatedMessage: false,
//       code: 'ERR_ASSERTION',
//       actual: 0,
//       expected: 1,
//       operator: 'strictEqual',
//       diff: 'simple'
//     }
//
//   test at test/recall/index-publish-ordering.test.mjs:663:7
//   ✖ T5 in-flight + nothing survives: the empty serve is MARKED, never silent (43.613042ms)
//     AssertionError [ERR_ASSERTION]: RED: an EMPTY serve with a null marker is a silent degradation
//         at TestContext.<anonymous> (file:///<checkout>/mcp/test/recall/index-publish-ordering.test.mjs:707:12)
//         at Test.runInAsyncScope (node:async_hooks:227:14)
//         at Test.run (node:internal/test_runner/test:1201:25)
//         at Test.start (node:internal/test_runner/test:1096:17)
//         at startSubtestAfterBootstrap (node:internal/test_runner/harness:385:17)
//         at run (node:internal/test_runner/harness:396:12)
//         at test (node:internal/test_runner/harness:405:12)
//         at file:///<checkout>/mcp/test/recall/index-publish-ordering.test.mjs:663:7 {
//       generatedMessage: false,
//       code: 'ERR_ASSERTION',
//       actual: null,
//       expected: null,
//       operator: 'notStrictEqual',
//       diff: 'simple'
//     }
//
// (Line numbers are that run's; this block shifted them. `actual: null,
// expected: null` on the T5 line is node:assert printing a notStrictEqual
// failure — the observed generation_refused WAS null, which is the defect.)
// ===========================================================================
//
// Discipline (matches test/recall/index-manifest.test.mjs — RED-RUN ISOLATION):
//   - mkdtempSync rooted in tmpdir; MEMORY_ROOT + POLICY_BASE_DIR +
//     STORAGE_BASE_DIR + LEDGERS_BASE_DIR + TELEMETRY_BASE_DIR overwritten
//     BEFORE any dynamic import. The live indices/ and ledgers/ trees are
//     NEVER touched or even named.
//   - small synthetic dims=8 unit vectors; per-test model versions.
//   - node:test + node:assert/strict; _resetCaches() between tests.
//   - every index-wal.lock a test creates is removed before that test returns.
//   - a final assertion pins that ledgers/memory.jsonl was never created.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-publish-window-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(MEMORY_ROOT, "telemetry");
// High thresholds: nothing auto-flushes; every publication here is explicit.
process.env.INDEX_SAVE_BATCH = "1000";
process.env.INDEX_SAVE_MAX_AGE_S = "3600";

mkdirSync(process.env.POLICY_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.STORAGE_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.LEDGERS_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(join(MEMORY_ROOT, "indices"), { recursive: true, mode: 0o700 });

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Dynamic import AFTER the env override.
const { loadIndices, saveIndices, _resetCaches } = await import(
  "../../lib/recall/index-cache.js"
);
const { readActiveManifest, retainActiveGeneration, retentionMemberNames } =
  await import("../../lib/recall/index-manifest.js");
const { writeBm25IndexV2Atomic } = await import(
  "../../lib/recall/bm25-rebuild.js"
);
const { WAL_LEASE_FILE } = await import("../../lib/recall/index-wal.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { CAPS } = await import("../../lib/validation.js");

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const DIMS = 8;

function dirFor(modelVersion) {
  return join(MEMORY_ROOT, "indices", modelVersion);
}

function unitVec(seed) {
  const v = [];
  let x = (seed + 1) * 2654435761;
  for (let i = 0; i < DIMS; i++) {
    x = (x * 1103515245 + 12345) % 2147483647;
    v.push((x % 1000) / 1000 + 0.01);
  }
  const norm = Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  return v.map((a) => a / norm);
}

function bm25EntryFor(id, token) {
  return {
    memory_id: id,
    kind: "fact",
    content: `synthetic fact ${id} ${token}`,
    ts: "2026-08-11T00:00:00Z",
    entities: [],
    valence: null,
    consent_basis: "first_party",
  };
}

function freshIndices(modelVersion) {
  return {
    bm25: new Bm25Index(),
    hnsw: new HnswIndex({
      dims: DIMS,
      embedding_model_version: modelVersion,
      maxElements: 1024,
    }),
  };
}

function addFact(pair, id, token, seed) {
  pair.bm25.add(bm25EntryFor(id, token));
  pair.hnsw.add(id, unitVec(seed));
}

// Capture console.error for ONE synchronous section. Deliberately does NOT
// forward: the expected REFUSING / in-flight breadcrumbs are the very thing
// under test and forwarding them buries the node:test report.
function captureStderr(fn) {
  const lines = [];
  const realErr = console.error;
  console.error = (...args) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  let value;
  try {
    value = fn();
  } finally {
    console.error = realErr;
  }
  return { value, lines };
}

const refusingLines = (lines) =>
  lines.filter((l) => /REFUSING index generation/.test(l));
const inFlightLines = (lines) =>
  lines.filter((l) => /index_publish_in_flight/.test(l));

// ---------------------------------------------------------------------------
// stagePublishWindow(MV, pair) — reproduces the production mid-publish state
// byte-for-byte, in the publisher's own order:
//
//   _publishGenerationLocked:1444  retainActiveGeneration(dir, active)
//   _publishGenerationLocked:1465  member write (bm25.json, tmp+rename)
//   _publishGenerationLocked:1617  activateManifest(...)   <-- NOT reached
//
// i.e. generation N is retained under its gen-addressed snapshot names, the
// FIXED bm25.json path already holds generation N+1's bytes, and
// index-manifest.json still describes generation N. Every step uses the exact
// symbols the publisher uses (retainActiveGeneration from index-manifest.js;
// writeBm25IndexV2Atomic from bm25-rebuild.js — the same tmp+rename writer,
// used this way at test/recall/index-manifest.test.mjs:541).
//
// The caller supplies the live pair so saveIndices' cache reseed keeps the
// caller's object identities (T1 needs that to prove no re-deserialize).
// ---------------------------------------------------------------------------
function stagePublishWindow(MV, pair) {
  const dir = dirFor(MV);

  // The generation that IS active for the whole window.
  saveIndices(MV, pair);

  const { manifest, error } = readActiveManifest(dir);
  assert.equal(error, null, "staged tree must have a readable active manifest");
  assert.notEqual(manifest, null, "staged tree must have an active manifest");

  // Publisher step 1 — hardlink the active members to their retention names.
  const kept = retainActiveGeneration(dir, manifest);
  assert.equal(
    kept.error,
    null,
    `retention must succeed to stage the window (${JSON.stringify(kept.error)})`,
  );

  // Publisher step 2 — the NEXT generation's bm25 bytes land at the FIXED
  // path (tmp+rename). Deliberately different content AND different size so
  // verifyGenerationMembers' size check trips exactly like production's
  // expected_size/actual_size pairs.
  const next = new Bm25Index();
  next.add(bm25EntryFor("mem_next0", "successorglyph"));
  next.add(bm25EntryFor("mem_next1", "successorglyph"));
  next.add(bm25EntryFor("mem_next2", "successorglyph"));
  writeBm25IndexV2Atomic(join(dir, "bm25.json"), next);

  // Publisher step 4 (activateManifest) is deliberately NOT performed: that
  // rename is the publication event, and the window is everything before it.
  return { dir, generation: manifest.generation };
}

function writeFreshLease(dir) {
  const p = join(dir, WAL_LEASE_FILE);
  writeFileSync(p, "", { mode: 0o600 });
  return p;
}

function removeLease(dir) {
  try {
    unlinkSync(join(dir, WAL_LEASE_FILE));
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// (T1) RED CORE — a WARM, manifest-managed entry must survive the publish
// window untouched. The manifest has not moved, therefore the generation this
// entry holds has not been superseded, therefore the cached objects are still
// exactly what the active manifest names. Pre-fix the member-fingerprint
// conjunct at index-cache.js:274-279 dropped the warm hit, forcing a full cold
// re-deserialize of the whole generation AND stamping a bogus refusal.
//
// WAVE 2 — the window is staged WITH the publisher's flush lease held, which
// is what production actually looks like (publishGeneration takes the lease at
// index-cache.js:1370 and holds it across the member writes). The suppression
// is licensed by that lease and by nothing else; T3/T3c pin the unleased and
// stale-leased cases to the loud path on BOTH the cold and the warm gate.
// ---------------------------------------------------------------------------
await test("T1 warm manifest-managed entry survives the mid-publish member rewrite (no re-deserialize, no refusal)", () => {
  _resetCaches();
  const MV = "pw-t1-warm-window";

  const pair = freshIndices(MV);
  addFact(pair, "mem_w0", "windowglyph", 3);
  addFact(pair, "mem_w1", "sillglyph", 4);
  saveIndices(MV, pair);

  const warm0 = loadIndices(MV);
  assert.equal(warm0.generation_refused, null, "baseline load is healthy");
  assert.equal(
    warm0.bm25.search("windowglyph", 5)[0].memory_id,
    "mem_w0",
    "baseline load serves the published generation",
  );

  const { dir } = stagePublishWindow(MV, pair);
  writeFreshLease(dir); // the publisher holds the lease across its member writes

  try {
    const { value: warm1, lines } = captureStderr(() => loadIndices(MV));

    assert.equal(
      warm1.bm25 === warm0.bm25,
      true,
      "RED: the warm entry was DROPPED and the generation re-deserialized (bm25 identity)",
    );
    assert.equal(
      warm1.hnsw === warm0.hnsw,
      true,
      "RED: the warm entry was DROPPED and the generation re-deserialized (hnsw identity)",
    );
    assert.equal(
      warm1.generation_refused,
      null,
      `RED: healthy corpus falsely marked refused mid-publish (${JSON.stringify(warm1.generation_refused)})`,
    );
    assert.deepEqual(
      refusingLines(lines),
      [],
      "RED: the intended publish window must not produce a REFUSING breadcrumb",
    );
  } finally {
    removeLease(dir);
  }

  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T2) COLD start inside a LIVE publish window. A process that has no warm
// entry at all (fresh MCP spawn, queryd restart) still walks the cold path
// mid-publish. It must serve the retained generation — that part already
// worked — but it must NOT report the active generation as refused, because a
// publication demonstrably holds the flush lease. The distinguishing evidence
// is exactly the lease: index-wal.lock present and fresh.
// ---------------------------------------------------------------------------
await test("T2 cold load inside a live publish window: retained generation served, classified in-flight, NOT refused", () => {
  _resetCaches();
  const MV = "pw-t2-cold-window";

  const pair = freshIndices(MV);
  addFact(pair, "mem_c0", "coldglyph", 7);
  addFact(pair, "mem_c1", "hearthglyph", 8);
  const { dir } = stagePublishWindow(MV, pair);

  _resetCaches(); // fresh process: no warm entry
  writeFreshLease(dir); // the publisher's held flush lease

  try {
    const { value: served, lines } = captureStderr(() => loadIndices(MV));

    // The retention snapshot still serves generation N's real content.
    assert.equal(
      served.bm25.search("coldglyph", 5)[0]?.memory_id,
      "mem_c0",
      "generation N's content still serves from the retention snapshot",
    );
    assert.equal(
      served.bm25.search("successorglyph", 5).length,
      0,
      "the half-published successor's bytes are NEVER served",
    );
    assert.equal(served.hnsw.has("mem_c0"), true, "hnsw member served whole");

    assert.equal(
      served.generation_refused,
      null,
      `RED: an in-flight publication must not degrade recall (${JSON.stringify(served.generation_refused)})`,
    );
    assert.equal(
      refusingLines(lines).length,
      0,
      `RED: a publish in flight must not emit REFUSING (got ${JSON.stringify(refusingLines(lines))})`,
    );
    assert.equal(
      inFlightLines(lines).length,
      1,
      `RED: exactly one index_publish_in_flight breadcrumb expected (got ${JSON.stringify(inFlightLines(lines))})`,
    );
  } finally {
    removeLease(dir);
  }

  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T3) ANTI-MASKING GUARD. The in-flight suppression is licensed ONLY by a
// fresh lease. With no lease, or a lease older than
// CAPS.STALE_LOCK_RECOVERY_SECONDS, a member mismatch is a genuine corruption
// signal and the ORIGINAL loud path must run verbatim: the REFUSING stderr
// line AND the in-band generation_refused marker that memory_health and the
// memory_recall envelope depend on (FU2, index-cache.js:689-699).
//
// Fail-OPEN by construction: uncertainty resolves to today's behaviour.
// ---------------------------------------------------------------------------
// assertLoud(label, MV, prepare, {warm}) — one staged publish window, one
// load, and the FULL pre-fix behaviour asserted verbatim.
//
//   warm: false (default) — _resetCaches() before the load: the COLD gate.
//   warm: true            — a manifest-managed WARM entry is established
//                           BEFORE the window opens and NO _resetCaches()
//                           runs afterwards, so the load under test enters
//                           through the warm-hit gate itself. Suppression on
//                           that gate is equally lease-bounded, so an absent
//                           or stale lease must drop the warm entry, cold-load,
//                           and refuse loudly — new object identities included.
const noLockPrepare = (dir) => {
  removeLease(dir);
  assert.equal(
    existsSync(join(dir, WAL_LEASE_FILE)),
    false,
    "no-lock case must genuinely have no lease file",
  );
};

const staleLockPrepare = (dir) => {
  const p = writeFreshLease(dir);
  const staleS =
    (Date.now() - CAPS.STALE_LOCK_RECOVERY_SECONDS * 1000 - 5000) / 1000;
  utimesSync(p, staleS, staleS);
};

function assertLoud(label, MV, prepare, { warm = false } = {}) {
  _resetCaches();
  const pair = freshIndices(MV);
  addFact(pair, "mem_a0", "alarmglyph", 21);

  // WARM variant: publish + load once so a manifest-managed entry is resident
  // and healthy before the window opens.
  let warm0 = null;
  if (warm) {
    saveIndices(MV, pair);
    warm0 = loadIndices(MV);
    assert.equal(
      warm0.generation_refused,
      null,
      `${label}: the warm baseline must be healthy`,
    );
  }

  const { dir, generation } = stagePublishWindow(MV, pair);

  // COLD only: simulate a fresh process. The warm variant deliberately keeps
  // the resident entry — that IS the path under test.
  if (!warm) _resetCaches();
  prepare(dir);

  let served;
  let lines;
  try {
    ({ value: served, lines } = captureStderr(() => loadIndices(MV)));
  } finally {
    removeLease(dir);
  }

  const loud = refusingLines(lines);
  assert.equal(
    loud.length,
    1,
    `${label}: a genuine member mismatch must still REFUSE loudly (got ${JSON.stringify(lines)})`,
  );
  assert.match(
    loud[0],
    /REFUSING index generation \d+ \(active\)/,
    `${label}: the REFUSING line shape is unchanged`,
  );
  assert.equal(
    inFlightLines(lines).length,
    0,
    `${label}: nothing may be classified in-flight without a fresh lease`,
  );
  assert.notEqual(
    served.generation_refused,
    null,
    `${label}: the in-band refusal marker must survive`,
  );
  assert.equal(
    served.generation_refused.code,
    "index_manifest_member_mismatch",
    `${label}: refusal code unchanged`,
  );
  assert.equal(
    served.generation_refused.member,
    "bm25",
    `${label}: refused member unchanged`,
  );
  assert.equal(
    served.generation_refused.served,
    "fallback",
    `${label}: the retained generation still serves under the refusal`,
  );
  // The refusal is about the ACTIVE candidate only — content still serves.
  assert.equal(
    served.bm25.search("alarmglyph", 5)[0]?.memory_id,
    "mem_a0",
    `${label}: generation ${generation} still served from retention`,
  );
  if (warm) {
    // Unleased/stale-leased ⇒ the warm entry carries no license to survive:
    // it must be dropped and the fallback generation freshly deserialized.
    assert.equal(
      served.bm25 === warm0.bm25,
      false,
      `${label}: the warm entry must be DROPPED without a fresh lease (bm25 identity)`,
    );
    assert.equal(
      served.hnsw === warm0.hnsw,
      false,
      `${label}: the warm entry must be DROPPED without a fresh lease (hnsw identity)`,
    );
  }
  _resetCaches();
}

await test("T3 anti-masking: NO lock and a STALE lock both keep the loud REFUSING path byte-for-byte", () => {
  // Case A — no index-wal.lock at all.
  assertLoud("no-lock", "pw-t3-no-lock", noLockPrepare);

  // Case B — an index-wal.lock older than CAPS.STALE_LOCK_RECOVERY_SECONDS.
  assertLoud("stale-lock", "pw-t3-stale-lock", staleLockPrepare);
});

// ---------------------------------------------------------------------------
// (T3c) ANTI-MASKING ON THE **WARM** PATH — the gap wave 1 left open. T3 above
// calls _resetCaches() immediately before the load, so it only ever exercises
// the COLD gate; the warm gate (index-cache.js:352-357), which is where the
// suppression actually lives and which queryd hits every 2s, had zero
// anti-masking coverage. A guard that cannot see the path it guards is
// vacuous. Same two negative cases, same assertions, entered warm.
// ---------------------------------------------------------------------------
await test("T3c anti-masking on the WARM gate: NO lock and a STALE lock both drop the warm entry and refuse loudly", () => {
  assertLoud("warm-no-lock", "pw-t3c-warm-no-lock", noLockPrepare, {
    warm: true,
  });
  assertLoud("warm-stale-lock", "pw-t3c-warm-stale-lock", staleLockPrepare, {
    warm: true,
  });
});

// ---------------------------------------------------------------------------
// (T4) LEGACY / UNMANAGED entries keep member-fingerprint invalidation. They
// have no manifest to key the cache identity on, so _entryMemberFpsMatch stays
// their ONLY change signal.
//
// Reaching a truly unmanaged entry is possible without faking anything: the
// gen-0 adoption path at index-cache.js:223-272 only adopts while holding the
// flush lease, and explicitly refuses to adopt unleased. Holding a FRESH
// index-wal.lock therefore makes _acquirePublishLease(dir) return null,
// adoption is skipped, and manifestFp stays "missing" via the else-branch at
// index-cache.js:265-270 — the legacy serve. (Cost: each loadIndices in this
// test pays the PUBLISH_LEASE_WAIT_MS_DEFAULT = 250ms bounded spin.)
// ---------------------------------------------------------------------------
await test("T4 legacy/unmanaged entry keeps member-fingerprint invalidation", () => {
  _resetCaches();
  const MV = "pw-t4-unmanaged";
  const dir = dirFor(MV);

  // Build real members, then strip the manifest so the tree looks pre-S3.
  const pair = freshIndices(MV);
  addFact(pair, "mem_l0", "legacyglyph", 31);
  saveIndices(MV, pair);
  rmSync(join(dir, "index-manifest.json"), { force: true });

  _resetCaches();
  writeFreshLease(dir); // blocks gen-0 adoption -> genuinely unmanaged entry

  try {
    const warm0 = loadIndices(MV);
    assert.equal(
      warm0.bm25.search("legacyglyph", 5)[0]?.memory_id,
      "mem_l0",
      "legacy fixed-path load serves the members",
    );

    // Sanity: the unmanaged entry IS warm-cacheable, so the invalidation
    // assertion below is not vacuous.
    const warmAgain = loadIndices(MV);
    assert.equal(
      warmAgain.bm25 === warm0.bm25,
      true,
      "unmanaged entry warm-hits when nothing changed",
    );

    // Out-of-band member replacement — the ONLY signal an unmanaged entry has.
    const replaced = new Bm25Index();
    replaced.add(bm25EntryFor("mem_l1", "replacementglyph"));
    writeBm25IndexV2Atomic(join(dir, "bm25.json"), replaced);

    const fresh = loadIndices(MV);
    assert.equal(
      fresh.bm25 === warm0.bm25,
      false,
      "unmanaged entry MUST fresh-load after a member replacement",
    );
    assert.equal(
      fresh.bm25.search("replacementglyph", 5)[0]?.memory_id,
      "mem_l1",
      "the replaced member's content is what serves",
    );
  } finally {
    removeLease(dir);
  }

  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T5) NO SILENT EMPTY. Suppressing the refusal must never buy silence. If the
// in-flight classification skips the ACTIVE candidate and then NOTHING else
// survives the walk — no retention snapshot, no `previous` generation —
// loadIndices degrades to the empty indices, and that degrade MUST still carry
// a marker out to queryd's status frame and the memory_recall envelope. Wave 1
// returned a bare null from _pickLoadableGeneration on that path: recall served
// EMPTY with degraded_reason absent, which is exactly the silent-degradation
// shape this whole change exists to eliminate.
//
// Staged by deleting the three retention snapshots retainActiveGeneration just
// made (names straight from retentionMemberNames), so _generationCandidates
// (index-cache.js:614-655) yields the active candidate ALONE.
// ---------------------------------------------------------------------------
await test("T5 in-flight + nothing survives: the empty serve is MARKED, never silent", () => {
  _resetCaches();
  const MV = "pw-t5-no-silent-empty";

  const pair = freshIndices(MV);
  addFact(pair, "mem_e0", "voidglyph", 41);
  const { dir, generation } = stagePublishWindow(MV, pair);

  // Remove every survivor: the retention snapshots of the active generation.
  // (stagePublishWindow publishes exactly once, so the manifest has no
  // `previous` either — the active candidate is the only candidate.)
  const names = retentionMemberNames(generation);
  for (const key of ["bm25", "hnsw", "hnsw_meta"]) {
    try {
      unlinkSync(join(dir, names[key]));
    } catch {
      // some members may legitimately not have been retained
    }
  }
  assert.equal(
    existsSync(join(dir, names.bm25)),
    false,
    "the retention snapshot must genuinely be gone",
  );

  _resetCaches(); // fresh process: no warm entry to fall back on
  writeFreshLease(dir); // and a publication IS in flight

  try {
    const { value: served, lines } = captureStderr(() => loadIndices(MV));

    // Nothing could be served — that part is unavoidable and correct.
    assert.equal(
      served.bm25.search("voidglyph", 5).length,
      0,
      "no candidate survived, so the empty index serves",
    );
    assert.equal(
      served.bm25.search("successorglyph", 5).length,
      0,
      "the half-published successor's bytes are NEVER served",
    );

    // …but it must NOT be silent.
    assert.notEqual(
      served.generation_refused,
      null,
      "RED: an EMPTY serve with a null marker is a silent degradation",
    );
    assert.equal(
      served.generation_refused.served,
      "empty",
      `RED: the empty serve must be stamped served:"empty" (${JSON.stringify(served.generation_refused)})`,
    );
    assert.equal(
      served.generation_refused.code,
      "index_publish_in_flight",
      `RED: the marker must name the in-flight classification that skipped the candidate (${JSON.stringify(served.generation_refused)})`,
    );
    assert.equal(
      refusingLines(lines).length,
      0,
      `a publish in flight still must not emit REFUSING (got ${JSON.stringify(refusingLines(lines))})`,
    );
    assert.equal(
      inFlightLines(lines).length,
      1,
      `exactly one index_publish_in_flight breadcrumb expected (got ${JSON.stringify(inFlightLines(lines))})`,
    );
  } finally {
    removeLease(dir);
  }

  _resetCaches();
});

// ---------------------------------------------------------------------------
// Hermeticity pin: this suite must never create (or read) the memory ledger.
// ---------------------------------------------------------------------------
await test("ledgers/memory.jsonl was never created by this suite", () => {
  assert.equal(
    existsSync(join(MEMORY_ROOT, "ledgers", "memory.jsonl")),
    false,
    "no ledger file was ever created or read",
  );
});
