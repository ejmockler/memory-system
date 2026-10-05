// hnsw-capacity-mirror — the JS-side `maxElements` mirror vs the native
// graph's own capacity.
//
// HnswIndex._nativeInsert auto-grows the native graph before inserting so a
// growing corpus never wedges the ingest cascade. The guard's right-hand side
// used to be `this.maxElements`, a JS-side mirror. On the native load path
// (_loadNativeSidecar) that mirror comes from the hnsw.bin.meta.json sidecar
// (via _newFromMeta), while the native object that actually enforces capacity
// is rebuilt from scratch and adopts whatever capacity is recorded in the .bin
// file itself. The two numbers therefore have independent provenance: when the
// sidecar over-reports, `curCount >= this.maxElements` is false while
// hnswlib's own cur_element_count >= max_elements_ is true, the guard stays
// silent, and addPoint throws
//   "Hnswlib Error: The number of elements exceeds the specified limit".
//
// This is a reachable LATENT skew path, not a live outage: the one historical
// occurrence of that error is a closed incident already fixed by commit
// 8bc1fa6. These tests pin the mirror to the native's own report.
//
// Hermetic and tiny by construction: dims 8, maxElements <= 1024 on the happy
// path, <= 64 vectors total, everything under mkdtempSync(tmpdir()) and
// removed in a finally. Nothing under indices/, ledgers/ or storage/ is read.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HnswIndex, HNSW_BACKEND } from "../lib/recall/hnsw-index.js";
// Namespace import ON PURPOSE. The capacity-report tests below probe for a
// symbol (`hnswBytesPerElement`) that did not exist when they were written; a
// NAMED import of an absent export is a module-level SyntaxError that fails the
// whole FILE, which would have made the red-first run un-attributable. Through
// the namespace the absence shows up as a per-test assertion failure instead.
import * as hnswIndexModule from "../lib/recall/hnsw-index.js";

const SKIP =
  HNSW_BACKEND !== "hnswlib-node"
    ? `HNSW_BACKEND is ${JSON.stringify(HNSW_BACKEND)}; the capacity mirror only exists on the hnswlib-node backend`
    : false;

// Unit-norm 8-dim basis vector — HnswIndex.add runs _validateVector, which
// asserts L2 norm and rejects anything else.
function unitVec(i) {
  const v = new Array(8).fill(0);
  v[i % 8] = 1;
  return v;
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hnsw-capacity-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Build a bin/meta pair whose sidecar mirror OVER-reports: 16 points at a real
// native capacity of 16, with the sidecar's `maxElements` field rewritten to
// 1_000_000. That single edited field is the entire fixture.
function buildSkewedPair(dir, { nativeCap = 16, points = 16 } = {}) {
  const path = join(dir, "hnsw.bin");
  const idx = new HnswIndex({
    dims: 8,
    embedding_model_version: "capacity-probe",
    maxElements: nativeCap,
  });
  // The fixture build itself crosses the high-water fraction when nativeCap is
  // small; swallow its breadcrumbs so the runner output stays clean. This
  // cannot mask anything under test — load() returns a NEW instance with fresh
  // one-shot latches, and every assertion below is made against that instance.
  captureConsoleError(() => {
    for (let i = 0; i < points; i++) idx.add(`m${i}`, unitVec(i));
  });
  idx.save(path);

  const metaPath = `${path}.meta.json`;
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.maxElements = 1000000;
  writeFileSync(metaPath, JSON.stringify(meta));
  return path;
}

// Capture console.error for the duration of fn, restoring it in a finally.
function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    fn(lines);
  } finally {
    console.error = orig;
  }
  return lines;
}

// (a) SKEW — the guard reads the native capacity, so an over-reporting sidecar
// no longer hides a full graph. Pre-change this threw
// "Hnswlib Error: The number of elements exceeds the specified limit".
test("skewed sidecar mirror does not defeat the auto-grow guard", { skip: SKIP }, () => {
  withTmpDir((dir) => {
    const path = buildSkewedPair(dir);
    const idx = HnswIndex.load(path, {});
    assert.equal(idx.maxElements, 1000000, "fixture: the JS mirror over-reports after load");
    assert.equal(idx._native.getMaxElements(), 16, "fixture: the native graph is really at 16");

    const lines = captureConsoleError(() => {
      idx.add("m16", unitVec(16));
    });

    // The 17th insert succeeded and grew from the NATIVE base, not the mirror:
    // max(16 * 2, 16 + 1024) === 1040.
    assert.equal(idx.maxElements, idx._native.getMaxElements(), "mirror reconciled to the native");
    assert.equal(idx.maxElements, 1040, "grown from the native base 16, not from the sidecar's 1000000");
    assert.notEqual(idx.maxElements, 1000000, "the inflated sidecar value must never drive capacity");
    assert.equal(idx._native.getCurrentCount(), 17);

    // e4-capacity-wall — DELIBERATE ASSERTION CHANGE, named rather than quietly
    // loosened. This previously asserted `lines.length === 1`. The insert under
    // test now crosses BOTH new capacity breadcrumbs as well: the graph is at
    // 16/16 (occupancy 1.0, past the 0.75 warn fraction) and then grows. The
    // replacement asserts the exact expected SET, in order, which is strictly
    // STRONGER than the old count — it pins every line this insert emits, not
    // just how many. The skew breadcrumb's own once-ness is still asserted
    // independently below.
    assert.equal(
      lines.length,
      3,
      `expected skew + high-water + grow, got ${JSON.stringify(lines)}`
    );
    assert.match(lines[0], /capacity mirror skew/);
    assert.match(lines[1], /capacity high-water/);
    assert.match(lines[2], /capacity grow/);

    // Loud exactly once, naming both numbers and the model version.
    const skewLines = lines.filter((l) => /capacity mirror skew/.test(l));
    assert.equal(skewLines.length, 1, `expected exactly one skew line, got ${JSON.stringify(lines)}`);
    assert.match(skewLines[0], /1000000/);
    assert.match(skewLines[0], /native getMaxElements\(\)=16/);
    assert.match(skewLines[0], /capacity-probe/);
    assert.equal(idx._capacitySkewWarned, true);

    // A second insert on the same instance must not emit another line — the
    // live index holds >100k points and replays route through _nativeInsert.
    const more = captureConsoleError(() => {
      idx.add("m17", unitVec(17));
    });
    assert.deepEqual(more, [], "the breadcrumb is latched: no flood on subsequent inserts");
    assert.equal(idx.maxElements, idx._native.getMaxElements());
  });
});

// (b) HAPPY PATH — no regression on a coherent index. The numbers asserted
// here were measured on the PRE-change code in this session: 4 adds fit at
// capacity 4; the 5th grows to 1028 (= max(4 * 2, 4 + 1024)); a save()->load()
// round-trip reports js 1028 / native 1028 / cur 5.
test("coherent index still auto-grows and round-trips unchanged", { skip: SKIP }, () => {
  withTmpDir((dir) => {
    const idx = new HnswIndex({
      dims: 8,
      embedding_model_version: "capacity-probe",
      maxElements: 4,
    });
    const lines = captureConsoleError(() => {
      for (let i = 0; i < 4; i++) idx.add(`m${i}`, unitVec(i));

      assert.equal(idx.maxElements, 4);
      assert.equal(idx._native.getMaxElements(), 4);
      assert.equal(idx._native.getCurrentCount(), 4);

      idx.add("m4", unitVec(4));
    });
    // e4-capacity-wall — DELIBERATE ASSERTION CHANGE. This was
    // `assert.deepEqual(lines, [])`. The captured window ends with the 5th add,
    // which crosses the warn fraction (3/4) and then grows, so exact emptiness
    // is no longer the correct expectation. The no-skew claim this test was
    // actually making is preserved verbatim below and the rest of the output is
    // pinned exactly — a tightening, not a relaxation.
    assert.equal(
      lines.filter((l) => /capacity mirror skew/.test(l)).length,
      0,
      "a coherent index must never emit a skew line"
    );
    assert.equal(lines.length, 2, `expected high-water + grow, got ${JSON.stringify(lines)}`);
    assert.match(lines[0], /capacity high-water: count=3 maxElements=4 occupancy=0\.7500/);
    assert.match(lines[1], /capacity grow: resizeIndex 4 -> 1028 elements/);

    assert.equal(idx.maxElements, 1028);
    assert.equal(idx._native.getMaxElements(), 1028);
    assert.equal(idx.maxElements, idx._native.getMaxElements());
    assert.equal(idx._native.getCurrentCount(), 5);

    const path = join(dir, "hnsw.bin");
    idx.save(path);
    const rt = HnswIndex.load(path, {});
    assert.equal(rt.maxElements, 1028);
    assert.equal(rt._native.getMaxElements(), 1028);
    assert.equal(rt._native.getCurrentCount(), 5);
    assert.equal(rt.size(), 5);
  });
});

// (c) ABSENT-METHOD DEGRADE — a runtime whose native object has no
// getMaxElements falls back to this.maxElements, exactly as the pre-existing
// getCurrentCount feature-detect does. No TypeError.
test("missing getMaxElements degrades to the js mirror", { skip: SKIP }, () => {
  withTmpDir(() => {
    const idx = new HnswIndex({
      dims: 8,
      embedding_model_version: "capacity-probe",
      maxElements: 4,
    });
    Object.defineProperty(idx._native, "getMaxElements", {
      value: undefined,
      configurable: true,
    });
    assert.equal(typeof idx._native.getMaxElements, "undefined");

    const lines = captureConsoleError(() => {
      // Fits under the mirror.
      for (let i = 0; i < 4; i++) idx.add(`m${i}`, unitVec(i));
      // Forces the grow branch through the absent-method fallback.
      idx.add("m4", unitVec(4));
    });

    // e4-capacity-wall — DELIBERATE ASSERTION CHANGE, same rationale as (b):
    // this was `assert.deepEqual(lines, [])` and the captured window crosses
    // both new breadcrumbs. The original claim (no skew line) is preserved
    // exactly; the capacity breadcrumbs are pinned rather than tolerated. Note
    // they still fire with getMaxElements absent — they read the SAME
    // feature-detected pair the guard does, via _capacityPair().
    assert.equal(
      lines.filter((l) => /capacity mirror skew/.test(l)).length,
      0,
      "no skew line when the native cannot report a capacity"
    );
    assert.equal(lines.length, 2, `expected high-water + grow, got ${JSON.stringify(lines)}`);
    assert.match(lines[0], /capacity high-water: count=3 maxElements=4/);
    assert.match(lines[1], /capacity grow: resizeIndex 4 -> 1028 elements/);
    // grown = max(4 * 2, 4 + 1024); with getMaxElements absent the mirror takes
    // the computed value.
    assert.equal(idx.maxElements, 1028);
    assert.equal(idx._native.getCurrentCount(), 5);
    assert.equal(idx.size(), 5);
  });
});

// ---------------------------------------------------------------------------
// e4-capacity-wall — the wall that is NOT maxElements.
//
// `maxElements` is a starting capacity, not a hard ceiling: _nativeInsert grows
// the graph before inserting, and test (b) above is the on-disk proof (a
// maxElements-4 index takes a 5th add and round-trips). The surviving wall is
// BYTES. From the bundled hnswlib source
// (mcp/node_modules/hnswlib-node/src/hnswlib/hnswalg.h):
//
//   maxM0_                 = M_ * 2
//   size_links_level0_     = maxM0_ * sizeof(tableint) + sizeof(linklistsizeint)
//   size_data_per_element_ = size_links_level0_ + data_size_ + sizeof(labeltype)
//
// with tableint/linklistsizeint = unsigned int (4) and labeltype = size_t (8),
// i.e. 2*M*4 + 4 + dims*4 + 8. Both the ctor and loadIndex malloc
// max_elements * size_data_per_element_ UP FRONT, and resizeIndex reallocs the
// whole base layer. At the production shape that is 16,524 B/element, so
// maxElements 1,000,000 reserves ~16.5 GB and a grow taken there peaks at old +
// new. Nothing in the tree watched either number. These tests pin the watcher.
// ---------------------------------------------------------------------------

// Byte size of one stored element, restated INDEPENDENTLY of the source under
// test so the assertions below are a real check and not a tautology.
const BYTES_PER_ELEMENT_DIMS8_M16 = 2 * 16 * 4 + 4 + 8 * 4 + 8; // 172

// (d) HIGH-WATER — the breadcrumb fires once, strictly BEFORE the wall, and is
// latched for the life of the instance.
test("capacity high-water breadcrumb fires exactly once, before the wall", { skip: SKIP }, () => {
  withTmpDir(() => {
    const idx = new HnswIndex({
      dims: 8,
      embedding_model_version: "capacity-probe",
      maxElements: 4,
    });

    // curCount is read BEFORE the insert, so these three adds see 0/4, 1/4 and
    // 2/4 — all under the 0.75 default warn fraction.
    const quiet = captureConsoleError(() => {
      for (let i = 0; i < 3; i++) idx.add(`m${i}`, unitVec(i));
    });
    assert.deepEqual(quiet, [], "below the warn fraction the insert path is silent");

    // The 4th add sees 3/4 === 0.75: the warning lands while the graph still
    // has a free slot. That "before the wall" ordering is the whole point.
    const atHighWater = captureConsoleError(() => {
      idx.add("m3", unitVec(3));
    });
    assert.equal(
      atHighWater.length,
      1,
      `expected exactly one high-water line, got ${JSON.stringify(atHighWater)}`
    );
    assert.match(atHighWater[0], /capacity high-water/);
    assert.match(atHighWater[0], /count=3/);
    assert.match(atHighWater[0], /maxElements=4/);
    assert.match(atHighWater[0], /occupancy=0\.75/);
    assert.match(atHighWater[0], new RegExp(`bytesPerElement=${BYTES_PER_ELEMENT_DIMS8_M16}`));
    assert.match(atHighWater[0], new RegExp(`reservedBytes=${4 * BYTES_PER_ELEMENT_DIMS8_M16}`));
    assert.equal(idx._capacityHighWaterWarned, true);

    // Proof the warning preceded the wall: capacity was still 4 and the graph
    // had not grown when the line was emitted.
    assert.equal(idx._native.getMaxElements(), 4, "no grow happened at high-water");
    assert.equal(idx._native.getCurrentCount(), 4);

    // Latched: the growing insert and the one after it never re-emit it. The
    // live index replays >100k points through _nativeInsert.
    const after = captureConsoleError(() => {
      idx.add("m4", unitVec(4));
      idx.add("m5", unitVec(5));
    });
    assert.equal(
      after.filter((l) => /capacity high-water/.test(l)).length,
      0,
      `the high-water breadcrumb is latched; got ${JSON.stringify(after)}`
    );
  });
});

// (e) GROW — the realloc that can kill the process announces its BYTE size
// before it is attempted.
test("capacity grow breadcrumb names the byte size of the realloc", { skip: SKIP }, () => {
  withTmpDir(() => {
    const idx = new HnswIndex({
      dims: 8,
      embedding_model_version: "capacity-probe",
      maxElements: 4,
    });
    for (let i = 0; i < 4; i++) {
      captureConsoleError(() => idx.add(`m${i}`, unitVec(i)));
    }
    assert.equal(idx._native.getCurrentCount(), 4);

    const lines = captureConsoleError(() => {
      idx.add("m4", unitVec(4));
    });
    const growLines = lines.filter((l) => /capacity grow/.test(l));
    assert.equal(
      growLines.length,
      1,
      `expected exactly one grow line, got ${JSON.stringify(lines)}`
    );
    // grown = max(4 * 2, 4 + 1024) = 1028 elements -> 1028 * 172 bytes.
    const grownBytes = 1028 * BYTES_PER_ELEMENT_DIMS8_M16;
    assert.match(growLines[0], /1028/);
    assert.match(growLines[0], new RegExp(String(grownBytes)));
    assert.match(growLines[0], /byte/i);
    assert.equal(idx._capacityGrowWarned, true);
    assert.equal(idx._native.getMaxElements(), 1028, "the grow itself still happened");

    // Latched for the life of the instance.
    const after = captureConsoleError(() => idx.add("m5", unitVec(5)));
    assert.equal(
      after.filter((l) => /capacity grow/.test(l)).length,
      0,
      `the grow breadcrumb is latched; got ${JSON.stringify(after)}`
    );
  });
});

// (f) capacityReport() arithmetic is exact — including the PRODUCTION shape,
// asserted as pure arithmetic. No 4096-dim index is constructed anywhere in
// this suite; doing so would malloc maxElements * 16,524 bytes.
test("capacityReport arithmetic is exact at both the tiny and production shapes", { skip: SKIP }, () => {
  withTmpDir(() => {
    const idx = new HnswIndex({
      dims: 8,
      embedding_model_version: "capacity-probe",
      maxElements: 16,
    });
    captureConsoleError(() => {
      for (let i = 0; i < 4; i++) idx.add(`m${i}`, unitVec(i));
    });

    const r = idx.capacityReport();
    assert.equal(r.dims, 8);
    assert.equal(r.M, 16);
    assert.equal(r.count, 4);
    assert.equal(r.maxElements, 16);
    assert.equal(r.bytesPerElement, BYTES_PER_ELEMENT_DIMS8_M16);
    assert.equal(r.reservedBytes, 16 * BYTES_PER_ELEMENT_DIMS8_M16);
    assert.equal(r.usedBytes, 4 * BYTES_PER_ELEMENT_DIMS8_M16);
    assert.equal(r.occupancy, 0.25);
    // Same arithmetic _nativeInsert uses: max(cap * 2, count + 1024).
    assert.equal(r.nextGrowElements, Math.max(16 * 2, 4 + 1024));
    assert.equal(r.nextGrowReservedBytes, 1028 * BYTES_PER_ELEMENT_DIMS8_M16);

    // capacityReport must be a pure read: it changes nothing.
    assert.equal(idx._native.getCurrentCount(), 4);
    assert.equal(idx._native.getMaxElements(), 16);
    assert.deepEqual(idx.capacityReport(), r);

    // PRODUCTION shape as pure numbers. 2*16*4 + 4 + 4096*4 + 8 = 16524.
    const bytesPerElement = hnswIndexModule.hnswBytesPerElement;
    assert.equal(
      typeof bytesPerElement,
      "function",
      "hnsw-index.js must export the hnswalg byte formula so operators can size an index without building one"
    );
    assert.equal(bytesPerElement(4096, 16), 2 * 16 * 4 + 4 + 4096 * 4 + 8);
    assert.equal(bytesPerElement(4096, 16), 16524);
    // maxElements 1_000_000 at the production shape reserves ~16.5 GB.
    assert.equal(bytesPerElement(4096, 16) * 1_000_000, 16_524_000_000);
  });
});

// (g) l3's STANDING RULING — the mirror-skew reconciliation path performs ZERO
// resizes. We never resizeIndex merely to make two numbers agree; the new
// breadcrumbs are observe-only and must not have changed that.
test("mirror-skew reconciliation performs zero resizeIndex calls", { skip: SKIP }, () => {
  withTmpDir((dir) => {
    // Headroom on purpose: 8 points in a real capacity of 64, sidecar rewritten
    // to 1_000_000. The skew is present; the graph is nowhere near full.
    const path = buildSkewedPair(dir, { nativeCap: 64, points: 8 });
    const idx = HnswIndex.load(path, {});
    assert.equal(idx.maxElements, 1000000, "fixture: the JS mirror over-reports");
    assert.equal(idx._native.getMaxElements(), 64, "fixture: the native graph is really at 64");

    // HierarchicalNSW's methods live on a non-writable prototype slot, so a
    // plain assignment throws under ESM strict mode. defineProperty installs an
    // own property that shadows it — the same technique test (c) uses.
    const resizeCalls = [];
    const realResize = idx._native.resizeIndex.bind(idx._native);
    Object.defineProperty(idx._native, "resizeIndex", {
      value: (n) => {
        resizeCalls.push(n);
        return realResize(n);
      },
      configurable: true,
    });

    const lines = captureConsoleError(() => {
      idx.add("m8", unitVec(8));
    });

    assert.deepEqual(
      resizeCalls,
      [],
      `reconciling a skewed mirror must never resize; got ${JSON.stringify(resizeCalls)}`
    );
    assert.equal(idx.maxElements, 64, "reconciliation is a plain assignment DOWN to the native");
    assert.equal(idx._native.getMaxElements(), 64, "the native capacity is untouched");
    assert.equal(idx._native.getCurrentCount(), 9);

    // Exactly the skew line: 8/64 is far below the warn fraction, and nothing grew.
    assert.equal(lines.length, 1, `expected only the skew line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0], /capacity mirror skew/);
    assert.equal(lines.filter((l) => /capacity high-water|capacity grow/.test(l)).length, 0);
  });
});

// (h) SILENCE BELOW THE FRACTION — the steady state of a healthy index emits
// nothing at all. This is the regression guard on the new breadcrumbs: they
// must not become a per-insert flood on the live 127k-point index.
test("no capacity breadcrumbs below the warn fraction on a coherent index", { skip: SKIP }, () => {
  withTmpDir(() => {
    const idx = new HnswIndex({
      dims: 8,
      embedding_model_version: "capacity-probe",
      maxElements: 1024,
    });
    const lines = captureConsoleError(() => {
      for (let i = 0; i < 100; i++) idx.add(`m${i}`, unitVec(i));
    });
    assert.deepEqual(lines, [], `100/1024 is 0.098 occupancy: silence expected, got ${JSON.stringify(lines)}`);
    assert.equal(idx._capacityHighWaterWarned, false);
    assert.equal(idx._capacityGrowWarned, false);
    assert.equal(idx._capacitySkewWarned, false);
    const r = idx.capacityReport();
    assert.equal(r.count, 100);
    assert.equal(r.maxElements, 1024);
    assert.ok(r.occupancy < 0.75, "fixture: below the warn fraction");
  });
});
