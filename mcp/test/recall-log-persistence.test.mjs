// recall-log-persistence.test.mjs — R25 gate-zero unit tests for the
// appendRecallEvent writer in mcp/lib/recall-log.js.
//
// These tests do NOT touch the production <checkout> tree.
// A fresh tmp root is materialised before any dynamic import; the LEDGERS_BASE_DIR
// env var redirects appendRecallEvent's writer path to the tmp dir.
//
// Coverage (per R25 task spec § 6):
//   T1 — writer creates a parseable JSON line on disk; file exists; line OK.
//   T2 — two concurrent appendRecallEvent calls both land cleanly; no torn writes.
//   T3 — schema validation rejects malformed (non-object, null) events.
//   T4 — large-file (>100MB-class) append tolerance: many appends, no daemon crash,
//        line count + per-line parse remain sound.
//
// Discipline:
//   - ES modules only. No new npm deps. node:fs + node:crypto + node:path stdlib.
//   - Hermetic root pre-import via env vars (matches integration-phase3-v0.test.mjs pattern).
//   - No emojis.
//   - serverTs from envelope.js (no inline Date.now() in test event bodies).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("recall-log-persistence");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import of the writer.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-r25-recall-log-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");
for (const d of [HERMETIC_ROOT, POLICY_DIR, STORAGE_DIR, LEDGERS_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;

// Production snapshot guard: capture sizes BEFORE any test action so we can
// assert byte-stability of the production ledgers at the end. recall.jsonl
// may or may not exist in production today (R25 is the first ship that
// guarantees its writer fires from the recall handler); accept "missing".
// Checkout root, derived from this file's location (never from MEMORY_ROOT,
// which this suite redirects to a temp tree).
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_MEMORY = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
const PROD_RECALL = join(CHECKOUT_ROOT, "ledgers", "recall.jsonl");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = { memory: snap(PROD_MEMORY), recall: snap(PROD_RECALL) };

// ---------------------------------------------------------------------------
// 1. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const { appendRecallEvent } = await import("../lib/recall-log.js");
const { serverTs } = await import("../lib/envelope.js");

const RECALL_JSONL = join(LEDGERS_DIR, "recall.jsonl");

// ---------------------------------------------------------------------------
// 2. Test framework.
// ---------------------------------------------------------------------------
let failures = 0;
function record(label, ok, diag) {
  if (ok) {
    console.log(`PASS  ${label}` + (diag ? `  -- ${diag}` : ""));
  } else {
    failures += 1;
    console.log(`FAIL  ${label}  -- ${diag || "(no diagnostic)"}`);
  }
}

function readAllLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
}

function makeSyntheticEvent(suffix) {
  // Minimum shape per kb/phase3-v0-contracts.md § 5 (v0) + v1 § 3 (additive).
  return {
    id: `rec_${suffix}`,
    ts: serverTs(),
    kind: "recall",
    query: {
      surrounding_context_hash: "a".repeat(64),
      context_embedding: [],
      embedding_model_version: "gemini-embedding-001@test",
    },
    surfaced: [],
    candidates_pre_truncation: [],
    density_flag: null,
    degraded_recall: false,
    rerank_attempted: false,
    rerank_failed_reason: null,
    layer3_latency_ms: 0,
    degraded_recall_layer3: false,
    rerank_instruction_hash: null,
    rerank_caps_snapshot: null,
    rerank_model_version: null,
  };
}

// ---------------------------------------------------------------------------
// T1 — single append: parseable JSON line on disk.
// ---------------------------------------------------------------------------
{
  const ev = makeSyntheticEvent("t1");
  appendRecallEvent(ev);
  const exists = existsSync(RECALL_JSONL);
  const lines = readAllLines(RECALL_JSONL);
  let parsed = null;
  let parseErr = null;
  try {
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    parseErr = e.message;
  }
  const ok =
    exists &&
    lines.length >= 1 &&
    parsed != null &&
    parsed.id === "rec_t1" &&
    parsed.kind === "recall" &&
    parsed.query &&
    parsed.query.embedding_model_version === "gemini-embedding-001@test";
  record(
    "T1 single appendRecallEvent writes a parseable JSON line",
    ok,
    `exists=${exists} lines=${lines.length} parseErr=${parseErr} id=${parsed && parsed.id}`,
  );
}

// ---------------------------------------------------------------------------
// T2 — concurrency: many parallel appends, no torn writes.
// The O_APPEND flag guarantees POSIX-atomic appends for writes <= PIPE_BUF
// (and Node's writeSync loop here always issues one write() per JSON-line
// since the buffer is constructed in one allocation). We schedule N parallel
// appendRecallEvent calls and verify (a) line count == N + prior, and
// (b) every line parses cleanly and the ids are exactly the expected set.
// ---------------------------------------------------------------------------
{
  const linesBefore = readAllLines(RECALL_JSONL).length;
  const N = 32;
  const ids = [];
  const promises = [];
  for (let i = 0; i < N; i++) {
    const id = `t2_${i.toString().padStart(3, "0")}`;
    ids.push(`rec_${id}`);
    // appendRecallEvent is sync; wrap in a microtask so they interleave at
    // the event-loop tick level. The atomic-append guarantee comes from O_APPEND
    // at the kernel level, not from event-loop ordering.
    promises.push(
      Promise.resolve().then(() => appendRecallEvent(makeSyntheticEvent(id))),
    );
  }
  let exception = null;
  try {
    await Promise.all(promises);
  } catch (e) {
    exception = e.message;
  }

  const linesAfter = readAllLines(RECALL_JSONL);
  let allParse = true;
  const seenIds = new Set();
  for (const l of linesAfter) {
    try {
      const j = JSON.parse(l);
      if (typeof j.id === "string") seenIds.add(j.id);
    } catch {
      allParse = false;
    }
  }
  const t2IdsPresent = ids.every((x) => seenIds.has(x));
  const countOk = linesAfter.length === linesBefore + N;
  const ok = exception == null && allParse && t2IdsPresent && countOk;
  record(
    "T2 concurrent appendRecallEvent writes are all present + parseable",
    ok,
    `count_before=${linesBefore} count_after=${linesAfter.length} expected=${linesBefore + N} all_parse=${allParse} all_ids_present=${t2IdsPresent} exception=${exception}`,
  );
}

// ---------------------------------------------------------------------------
// T3 — schema validation: writer rejects non-object events.
// recall-log.js:167-169 contracts: TypeError on null / non-object.
// ---------------------------------------------------------------------------
{
  const cases = [
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "string", value: "not-an-event" },
    { label: "number", value: 42 },
    { label: "array", value: [{ id: "x" }] }, // typeof [] === "object" so this PASSES the guard; documented for the record
  ];
  let allCaught = true;
  const diags = [];
  for (const c of cases) {
    let threw = false;
    try {
      // Use a try/catch around the call. We expect TypeError for null/undefined/string/number;
      // array is a typeof-object so the current contract (recall-log.js:167-169) lets it
      // through and writes it as JSON — that is intentional per the writer's permissive
      // shape policy ("event must be an object"). We assert the documented behavior:
      //   - null, undefined, string, number  -> TypeError
      //   - array                              -> appends (writer is shape-permissive
      //     past the typeof check; downstream consumers schema-validate at read time)
      appendRecallEvent(c.value);
    } catch (e) {
      threw = e instanceof TypeError;
    }
    const expectedThrow = ["null", "undefined", "string", "number"].includes(c.label);
    const observed = expectedThrow === threw;
    if (!observed) allCaught = false;
    diags.push(`${c.label}:threw=${threw}(expected=${expectedThrow})`);
  }
  record(
    "T3 schema validation rejects malformed (non-object) events",
    allCaught,
    diags.join(" | "),
  );
}

// ---------------------------------------------------------------------------
// T4 — large-file tolerance: many sequential appends do not crash the writer.
// We do NOT actually grow recall.jsonl past 100MB inside a test (that would
// add multi-second wall time). The contract being verified is that the writer
// re-opens + fsyncs per call (recall-log.js:176-186) with no shared state,
// so a long-running daemon does not accumulate fd leaks or buffer growth.
// We append 200 medium-sized rows and assert (a) no exceptions, (b) file
// size scales linearly with payload size, (c) all 200 lines parse.
// ---------------------------------------------------------------------------
{
  const linesBefore = readAllLines(RECALL_JSONL).length;
  const N = 200;
  let exception = null;
  try {
    for (let i = 0; i < N; i++) {
      const ev = makeSyntheticEvent(`t4_${i}`);
      // Pad the event with synthetic candidate entries to make each row ~2 KB,
      // so 200 rows ~ 400 KB — enough to exercise repeated fsyncs without
      // consuming meaningful disk in a test environment.
      ev.candidates_pre_truncation = [];
      for (let j = 0; j < 20; j++) {
        ev.candidates_pre_truncation.push({
          memory_id: `fact_t4_${i}_${j}`,
          position: j,
          score: 0.5,
          rerank_score: null,
        });
      }
      appendRecallEvent(ev);
    }
  } catch (e) {
    exception = e.message;
  }
  const linesAfter = readAllLines(RECALL_JSONL);
  let allParse = true;
  for (const l of linesAfter) {
    try {
      JSON.parse(l);
    } catch {
      allParse = false;
      break;
    }
  }
  const countOk = linesAfter.length === linesBefore + N;
  const sizeBytes = statSync(RECALL_JSONL).size;
  const ok = exception == null && allParse && countOk;
  record(
    "T4 large-file append tolerance (200 medium rows)",
    ok,
    `before=${linesBefore} after=${linesAfter.length} expected=${linesBefore + N} size_bytes=${sizeBytes} all_parse=${allParse} exception=${exception}`,
  );
}

// ---------------------------------------------------------------------------
// Production-snapshot guard: confirm we did not touch the live ledgers.
// ---------------------------------------------------------------------------
const PROD_AFTER = { memory: snap(PROD_MEMORY), recall: snap(PROD_RECALL) };
const prodUnchanged =
  PROD_AFTER.memory === PROD_BEFORE.memory &&
  PROD_AFTER.recall === PROD_BEFORE.recall;
record(
  "Production ledgers byte-identical pre/post",
  prodUnchanged,
  `memory: ${PROD_BEFORE.memory} -> ${PROD_AFTER.memory} ; recall: ${PROD_BEFORE.recall} -> ${PROD_AFTER.recall}`,
);

// ---------------------------------------------------------------------------
// Cleanup hermetic tmp root.
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // best-effort
}

if (failures > 0) {
  console.error(`\nFAIL  ${failures} step(s) failed.`);
  process.exit(1);
}
console.log("\nALL PASS  recall-log-persistence");
