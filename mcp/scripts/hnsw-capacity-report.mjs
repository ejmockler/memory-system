#!/usr/bin/env node
// hnsw-capacity-report.mjs — e4-capacity-wall operator evidence.
//
// READ-ONLY. This script NEVER constructs a HierarchicalNSW on the report path
// and NEVER writes anything anywhere. It answers "how close is this index to
// its memory reservation?" from the sidecar + a stat() alone, because the
// honest answer must not itself cost 16.5 GB: at the production shape simply
// opening the index mallocs maxElements * 16,524 bytes up front.
//
// WHY THIS EXISTS: `maxElements` is NOT a hard ceiling. HnswIndex._nativeInsert
// grows the native graph before inserting, so exceeding it is not an error.
// The wall that remains is BYTES, and until this node nothing in the tree
// watched either number.
//
// USAGE
//   node mcp/scripts/hnsw-capacity-report.mjs <index-dir> [--docs N]
//   node mcp/scripts/hnsw-capacity-report.mjs <index-dir> --measure-resize \
//        [--resize-elements N]
//
//   <index-dir>        REQUIRED. No default: this script is never pointed at a
//                      write path, and refusing to guess is what keeps it that
//                      way. Reads <dir>/hnsw.bin.meta.json and stats
//                      <dir>/hnsw.bin.
//   --docs N           Caller-supplied lexical (BM25) document count, so the
//                      report can print the dense-coverage delta. The script
//                      does NOT go and open the lexical index to find it —
//                      that is the caller's number to supply.
//   --measure-resize   Opt-in COST measurement. Builds a THROWAWAY index under
//                      mkdtemp at production dims/M and a SAFE element count,
//                      then triggers exactly one auto-grow. Never touches the
//                      index dir. See the guard rail at the bottom.
//
// The resize measurement is deliberately NOT in the registered test suite:
// timing and RSS are nondeterministic and the numbers are evidence, not a gate.

import { readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hnswBytesPerElement } from "../lib/recall/hnsw-index.js";

// hnswalg.h saveIndex() header: six size_t POD fields (offsetLevel0_,
// max_elements_, cur_element_count, size_data_per_element_, label_offset_,
// offsetData_) = 48, then maxlevel_ (int) + enterpoint_node_ (tableint) = 8,
// then maxM_, maxM0_, M_ (size_t), mult_ (double), ef_construction_ (size_t) = 40.
const HNSW_FILE_HEADER_BYTES = 96;

function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} kB`;
  return `${n} B`;
}

function parseArgs(argv) {
  const out = { dir: null, docs: null, measureResize: false, resizeElements: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--measure-resize") out.measureResize = true;
    else if (a === "--docs") out.docs = Number(argv[++i]);
    else if (a === "--resize-elements") out.resizeElements = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (out.dir === null) out.dir = a;
    else throw new Error(`unexpected extra argument ${a}`);
  }
  if (!out.dir) {
    throw new Error(
      "an index directory is REQUIRED (no default write path is ever assumed).\n" +
        "  usage: node mcp/scripts/hnsw-capacity-report.mjs <index-dir> [--docs N] [--measure-resize]"
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report path — sidecar + stat only. Nothing native is constructed.
// ---------------------------------------------------------------------------

function report({ dir, docs }) {
  const metaPath = join(dir, "hnsw.bin.meta.json");
  const binPath = join(dir, "hnsw.bin");

  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const count = Array.isArray(meta.id_map) ? meta.id_map.length : 0;
  const tombstones = Array.isArray(meta.tombstones) ? meta.tombstones.length : 0;
  const { dims, M, maxElements } = meta;
  const bytesPerElement = hnswBytesPerElement(dims, M);

  // capacityReport()-shaped, computed from the sidecar rather than from a live
  // index. nextGrowElements mirrors _nativeInsert's max(cap * 2, count + 1024).
  const nextGrowElements = Math.max(maxElements * 2, count + 1024);
  const rep = {
    count,
    maxElements,
    dims,
    M,
    bytesPerElement,
    reservedBytes: maxElements * bytesPerElement,
    usedBytes: count * bytesPerElement,
    occupancy: maxElements > 0 ? count / maxElements : 0,
    nextGrowElements,
    nextGrowReservedBytes: nextGrowElements * bytesPerElement,
  };

  console.log(`index dir:            ${dir}`);
  console.log(`model:                ${meta.embedding_model_version}`);
  console.log(`backend (sidecar):    ${meta.backend}`);
  console.log("");
  console.log("CAPACITY");
  console.log(`  count               ${rep.count}`);
  console.log(`  maxElements         ${rep.maxElements}`);
  console.log(`  occupancy           ${rep.occupancy.toFixed(6)}`);
  console.log(`  tombstones          ${tombstones}`);
  console.log("");
  console.log("MEMORY (hnswalg.h: 2*M*4 + 4 + dims*4 + 8 per element)");
  console.log(`  dims / M            ${rep.dims} / ${rep.M}`);
  console.log(`  bytesPerElement     ${rep.bytesPerElement}`);
  console.log(`  usedBytes           ${rep.usedBytes} (${fmtBytes(rep.usedBytes)})`);
  console.log(
    `  reservedBytes       ${rep.reservedBytes} (${fmtBytes(rep.reservedBytes)})` +
      "  <- malloc'd UP FRONT by the ctor and by loadIndex"
  );
  console.log(`  nextGrowElements    ${rep.nextGrowElements}`);
  console.log(
    `  nextGrowReserved    ${rep.nextGrowReservedBytes} (${fmtBytes(rep.nextGrowReservedBytes)})`
  );
  console.log(
    `  peak during grow    ~${fmtBytes(rep.reservedBytes + rep.nextGrowReservedBytes)}` +
      "  (realloc holds old + new)"
  );

  // Reconcile the pure formula against the bytes actually on disk.
  let binBytes = null;
  try {
    binBytes = statSync(binPath).size;
  } catch {
    binBytes = null;
  }
  if (binBytes != null && count > 0) {
    const measuredPerVector = binBytes / count;
    const linkListSizeFields = 4 * count; // one unsigned int per element
    const upperLevelBytes =
      binBytes - HNSW_FILE_HEADER_BYTES - count * bytesPerElement - linkListSizeFields;
    const sizeLinksPerElement = M * 4 + 4;
    console.log("");
    console.log("ON-DISK RECONCILIATION (hnsw.bin)");
    console.log(`  file bytes          ${binBytes} (${fmtBytes(binBytes)})`);
    console.log(`  measured B/vector   ${measuredPerVector.toFixed(3)}`);
    console.log(`  formula B/element   ${bytesPerElement}`);
    console.log(
      `  gap                 ${(measuredPerVector - bytesPerElement).toFixed(3)} B/vector, accounted as:`
    );
    console.log(`    file header       ${HNSW_FILE_HEADER_BYTES} B once`);
    console.log(`    linkListSize      4 B x ${count} = ${linkListSizeFields} B`);
    console.log(
      `    upper-level links ${upperLevelBytes} B = ${(upperLevelBytes / sizeLinksPerElement).toFixed(1)}` +
        ` x ${sizeLinksPerElement} B (size_links_per_element_ = M*4 + 4)`
    );
    console.log(
      "    NOTE: the .bin stores cur_element_count elements, NOT maxElements —" +
        " the file is small while the RESERVATION is not."
    );
  }

  if (docs != null && Number.isFinite(docs) && docs > 0) {
    const delta = docs - count;
    console.log("");
    console.log("CORPUS COVERAGE (against the caller-supplied lexical doc count)");
    console.log(`  lexical docs        ${docs}`);
    console.log(`  dense vectors       ${count}`);
    console.log(`  uncovered           ${delta} (${((delta / docs) * 100).toFixed(2)}% of the corpus)`);
    console.log(`  coverage            ${((count / docs) * 100).toFixed(2)}%`);
    const fullReserved = docs * bytesPerElement;
    console.log(
      `  full-coverage cost  ${fullReserved} (${fmtBytes(fullReserved)}) of base layer at this shape`
    );
    console.log(
      "  NOTE: closing this delta is an UNDECIDED decision awaiting recall evidence." +
        " This script measures it; it does not recommend it."
    );
  }

  return rep;
}

// ---------------------------------------------------------------------------
// --measure-resize — opt-in, throwaway, mkdtemp-scoped.
// ---------------------------------------------------------------------------

async function measureResize(elements) {
  const PROD_DIMS = 4096;
  const PROD_M = 16;
  const bytesPerElement = hnswBytesPerElement(PROD_DIMS, PROD_M);
  const baseBytes = elements * bytesPerElement;

  // Hard safety rail. A real 1M x 4096 grow needs ~50 GB and would take the
  // machine down; this path exists to EXTRAPOLATE from a safe size, never to
  // reproduce the wall.
  const MAX_SAFE_BYTES = 2e9;
  if (!Number.isFinite(elements) || elements <= 0) {
    throw new Error("--resize-elements must be a positive integer");
  }
  if (baseBytes * 3 > MAX_SAFE_BYTES) {
    throw new Error(
      `refusing --resize-elements ${elements}: base layer ${fmtBytes(baseBytes)}, ` +
        `peak during grow ~${fmtBytes(baseBytes * 3)} exceeds the ${fmtBytes(MAX_SAFE_BYTES)} safety rail`
    );
  }

  // The index is never persisted, but scope it to a mkdtemp root anyway so no
  // future edit to this function can leak an artifact next to indices/.
  const root = mkdtempSync(join(tmpdir(), "hnsw-resize-probe-"));
  try {
    const { HnswIndex, HNSW_BACKEND } = await import("../lib/recall/hnsw-index.js");
    if (HNSW_BACKEND !== "hnswlib-node") {
      console.log(`\n--measure-resize SKIPPED: backend is ${HNSW_BACKEND}, not hnswlib-node`);
      return;
    }

    console.log("");
    console.log(`RESIZE COST (throwaway index under ${root}; nothing is persisted)`);
    console.log(`  shape               dims ${PROD_DIMS}, M ${PROD_M} (production)`);
    console.log(`  elements            ${elements} -> base layer ${fmtBytes(baseBytes)}`);

    // efConstruction is deliberately LOW here. It drives build time only; the
    // base-layer geometry under measurement (size_data_per_element_) depends on
    // dims and M alone, so lowering it changes nothing about the realloc being
    // timed and takes the build from ~14 ms/add to ~1 ms/add.
    const idx = new HnswIndex({
      dims: PROD_DIMS,
      embedding_model_version: "resize-probe",
      M: PROD_M,
      efConstruction: PROD_M,
      maxElements: elements,
    });

    // Vector CONTENT is irrelevant here: the base layer's size depends only on
    // dims, M and count. Sparse unit-norm vectors keep the build cheap.
    const mkVec = (k) => {
      const v = new Array(PROD_DIMS).fill(0);
      const a = k % PROD_DIMS;
      const b = (k * 7 + 13) % PROD_DIMS;
      if (a === b) v[a] = 1;
      else {
        v[a] = Math.SQRT1_2;
        v[b] = Math.SQRT1_2;
      }
      return v;
    };

    const buildStart = process.hrtime.bigint();
    for (let i = 0; i < elements; i++) idx.add(`p${i}`, mkVec(i));
    const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
    console.log(
      `  build (setup, not the measurement) ${buildMs.toFixed(0)} ms for ${elements} adds`
    );

    // MEASURE THE REALLOC DIRECTLY.
    //
    // The first version of this probe inferred the cost by timing the add that
    // crosses the boundary and subtracting a baseline add. That does not work:
    // at 4096 dims an addPoint costs ~20 ms while the realloc costs ~1 ms, so
    // the measurement came out NEGATIVE. The signal has to be isolated.
    //
    // This resizeIndex call is on a THROWAWAY index built by this function and
    // discarded on return. It is not a library code path: hnsw-index.js gained
    // no new resizeIndex call site in this change, and the breadcrumbs added
    // there are observe-only.
    const before = idx.capacityReport();
    const grownTo = Math.max(before.maxElements * 2, before.count + 1024);
    if (globalThis.gc) globalThis.gc();
    const rssBefore = process.memoryUsage().rss;
    const t0 = process.hrtime.bigint();
    idx._native.resizeIndex(grownTo);
    const reallocMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const rssAfter = process.memoryUsage().rss;

    console.log(`  grew                ${before.maxElements} -> ${grownTo} elements`);
    console.log(
      `  realloc requested   ${fmtBytes(grownTo * bytesPerElement)}` +
        ` (old ${fmtBytes(before.maxElements * bytesPerElement)} still held)`
    );
    console.log(`  realloc time        ${reallocMs.toFixed(3)} ms  <- the measurement`);
    console.log(
      `  RSS delta           ${fmtBytes(rssAfter - rssBefore)} (${rssBefore} -> ${rssAfter})`
    );
    console.log(
      "  READ THIS: an RSS delta far below the requested bytes means the" +
        " allocator remapped rather than copied, so the risk here is NOT latency." +
        "\n             The danger is the allocation SUCCEEDING AT ALL: hnswalg.h" +
        " throws std::runtime_error(\"Not enough memory: resizeIndex failed to" +
        "\n             allocate base layer\") on failure, and every" +
        " updateIndicesForFact call site catches and continues — so the fact is" +
        "\n             indexed nowhere and only a stderr breadcrumb records it."
    );

    // EXTRAPOLATION — clearly labelled. Never measured, and never will be here.
    const prodReserved = 1_000_000 * bytesPerElement;
    const prodGrown = 2_000_000 * bytesPerElement;
    const scale = prodGrown / (grownTo * bytesPerElement);
    console.log("");
    console.log("  1,000,000-ELEMENT EXTRAPOLATION (EXTRAPOLATED, NOT MEASURED)");
    console.log(`    reserved at 1M    ${fmtBytes(prodReserved)}`);
    console.log(`    grow 1M -> 2M     ${fmtBytes(prodGrown)} requested`);
    console.log(`    peak during grow  ~${fmtBytes(prodReserved + prodGrown)} (old + new held together)`);
    console.log(
      `    realloc time      ~${(reallocMs * scale).toFixed(0)} ms if cost is LINEAR in bytes` +
        ` (x${scale.toFixed(0)} the measured size)`
    );
    console.log(
      "    This grow is NEVER attempted here: ~50 GB would take the machine down." +
        " The linear assumption is unverified above the measured size."
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  report(args);
  if (args.measureResize) await measureResize(args.resizeElements);
}

main().catch((e) => {
  console.error(`hnsw-capacity-report: ${e.message}`);
  process.exit(1);
});
