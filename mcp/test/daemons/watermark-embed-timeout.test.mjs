// watermark-embed-timeout.test.mjs — W1: make the local-embed degrade NAME
// ITSELF.
//
// THE DEFECT. daemons/watermark.js:2209-2218 catches exactly one error class
// (LocalEmbedUnavailableError) and writes one CONSTANT, CAUSELESS sentence:
//
//   watermark: local embed server unavailable for source=<s> — promoting with
//   null embedding + recording to re-embed sweep
//
// That single class spans THIRTEEN construction sites in
// mcp/lib/local-embedder-client.js — transport (:344, the only one carrying a
// `cause`), malformed fetch response (:355), non-2xx (:377, any status),
// missing embeddings[] (:384), embedBatch count mismatch (:447), embedSingle
// count mismatch (:405), and FIVE _renormAndAssert vector-shape throws
// (:269 / :274 / :280 / :288 / :297). Production has logged that sentence
// hundreds of times and it is impossible to tell which one happened. The error
// object was caught and DISCARDED.
//
// WHAT THIS BATTERY PINS. The degrade line must carry a reason code, the item
// count, the elapsed wall-clock of the failed call, and a truncated detail —
// while changing NOTHING about what the tick does.
//
//   R1..R14 — one named case per reason code, each error constructed the way
//             the real client builds it (same message template, same cause
//             shape) and injected by making the cascade's localEmbedBatch
//             throw it. Asserts the exact `reason=<code>` token on stderr.
//             Includes `unknown`: a classifier with no escape hatch lies.
//   S1     — a NON-LocalEmbedUnavailableError throw (plain TypeError) still
//             takes the `localUnavailable === false` branch and still writes
//             the pre-existing `watermark: localEmbedBatch failed for source=`
//             line, unchanged. No degrade line is emitted.
//   S2     — BEHAVIOUR INVARIANCE (the load-bearing assertion). The same
//             seeded fixture run twice — once with a WORKING localEmbedBatch,
//             once with a THROWING one — must produce identical cursor
//             last_offset, results.rows_read and results.rows_promoted. This
//             is what proves only the log changed: no park, no retry, no
//             skipped row, no stalled cursor.
//   S3     — LOG DISCIPLINE: at most ONE degrade line per (source, tick), even
//             when the tick's batch is large (25 rows, one embed round-trip).
//   S4     — DETAIL SANITISATION + TRUNCATION: a server-controlled message
//             containing CR/LF must still produce exactly ONE stderr line (an
//             unsanitised detail would let the embed server forge log lines),
//             and detail is capped at 300 characters.
//   S5     — the operator-grep prefix stays byte-for-byte stable.
//
// HERMETIC: tmp MEMORY_ROOT + per-tier BASE_DIRs exported BEFORE the dynamic
// import reaches mcp/lib/config.js (the watermark-breaker-tick-abort /
// watermark-append-failure idiom). Production ledgers / indices / storage /
// policy and daemons/logs are never read or written, and nothing ever contacts
// 127.0.0.1:8359 — localEmbedBatch is always a stub. NOTE: the sibling
// watermark-multisource.test.mjs drives the daemon via spawnSync in a
// SUBPROCESS, so _setCascadeModsForTest can never reach it; the in-process
// idiom used here is the only one that can inject the embed seam.
//
// prefetchEmbeddings is module-private and stays that way: every case drives
// it through the exported tickSourcesOnce seam.
//
// node:test + node:assert/strict.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-wm-embed-degrade-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");
// Belt and braces: no code path in this battery reaches the real client, but
// if one ever did, this keeps it off the network instead of hitting :8359.
process.env.MEMORY_TEST_STUB_EMBEDDER = "1";

const WATERMARK_STATE_DIR = join(process.env.STORAGE_BASE_DIR, "watermark-state");
const SOURCES_DIR = join(process.env.STORAGE_BASE_DIR, "sources");
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  WATERMARK_STATE_DIR,
  SOURCES_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort tmp cleanup
  }
});

const watermarkMod = await import("../../../daemons/watermark.js");
const salienceMod = await import("../../lib/ingest/salience.js");
const stage0Mod = await import("../../lib/ingest/stage0/index.js");
const promoteMod = await import("../../lib/tools/distill-promote-fact.js");
const { LocalEmbedUnavailableError } = await import(
  "../../lib/local-embedder-client.js"
);

const NOW = new Date("2026-08-11T00:00:00Z");
const MEMORY_LEDGER = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");
const RE_EMBED_SWEEP = join(process.env.POLICY_BASE_DIR, "re-embed-sweep.jsonl");

// The endpoint the REAL client interpolates into its messages. Used only to
// build faithful error strings — never contacted.
const ENDPOINT = "http://127.0.0.1:8359/embed";

// The operator-grep prefix. Byte-for-byte stable is a hard requirement:
// existing greps/alerts match on exactly this substring.
const DEGRADE_PREFIX = "watermark: local embed server unavailable for source=";
// The pre-existing UNEXPECTED-throw line (watermark.js:1958-1968), which S1
// pins as unchanged.
const UNEXPECTED_PREFIX = "watermark: localEmbedBatch failed for source=";

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

function sourceLedgerPath(source) {
  return join(SOURCES_DIR, `${source}.jsonl`);
}

function makeRow(source, tag, i) {
  return {
    id: `ulid_${tag}_${String(i).padStart(6, "0")}`,
    ts: new Date(NOW.getTime() + i * 1000).toISOString(),
    source,
    source_msg_id: `${source}-${tag}-${i}`,
    parties: ["user"],
    raw_content: {
      text: `embed degrade probe ${tag} row ${i}: the quarterly budget review moved to Thursday`,
      handle_id: "+15555550199",
    },
    attachments: [],
    source_policy: {
      deletion_semantics: "full_excise",
      consent_basis: "first_party",
    },
    checksum: `cksum-${tag}-${i}`,
  };
}

// Seed `count` rows for `source`, reset that source's cursor to offset 0, and
// truncate the hermetic memory ledger + re-embed sweep so each case asserts
// against a clean slate. Returns the ledger's EOF byte offset.
function seedRows(source, tag, count) {
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify(makeRow(source, tag, i)));
  const path = sourceLedgerPath(source);
  writeFileSync(path, lines.join("\n") + "\n");
  try {
    rmSync(join(WATERMARK_STATE_DIR, `${source}.json`), { force: true });
  } catch {
    /* no cursor yet */
  }
  try {
    writeFileSync(MEMORY_LEDGER, "");
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(RE_EMBED_SWEEP, "");
  } catch {
    /* ignore */
  }
  return statSync(path).size;
}

// Remove every seeded source ledger so a later tick walks only what it seeded.
function clearAllSourceLedgers() {
  if (!existsSync(SOURCES_DIR)) return;
  for (const f of readdirSync(SOURCES_DIR)) {
    if (f.endsWith(".jsonl")) rmSync(join(SOURCES_DIR, f), { force: true });
  }
  if (!existsSync(WATERMARK_STATE_DIR)) return;
  for (const f of readdirSync(WATERMARK_STATE_DIR)) {
    if (f.endsWith(".json")) rmSync(join(WATERMARK_STATE_DIR, f), { force: true });
  }
}

function readCursor(source) {
  return watermarkMod.readSourceCursor(source);
}

// Capture everything written to process.stderr while fn runs. Restored in a
// finally (the telemetry.test.mjs / policy-group-commit.test.mjs idiom).
async function withCapturedStderr(fn) {
  const orig = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === "string" ? chunk : String(chunk);
    void rest;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return captured;
}

const STUB_VEC_4096 = new Array(4096).fill(0).map((_, i) => (i === 0 ? 1 : 0));

// A LIGHTWEIGHT mods bundle: every row hard-DROPs at Stage-0, so no salience /
// promote / index is needed — but normalizeSourceEvent and localEmbedBatch are
// real functions, so prefetchEmbeddings does NOT short-circuit and the embed
// call site is genuinely exercised. prefetchEmbeddings runs BEFORE the row
// loop (watermark.js:2204), so the Stage-0 decision is irrelevant to it.
function dropModsWithEmbed(localEmbedBatch) {
  return {
    stage0: { dispatch: () => ({ decision: "DROP", reason: "test_drop_all" }) },
    salience: null,
    promote: null,
    normalizeSourceEvent: salienceMod.normalizeSourceEvent,
    localEmbedBatch,
    indexCache: null,
  };
}

// The FULL bundle (real stage0 + salience + promote), used by S2 so
// rows_promoted is a meaningful invariant rather than a constant zero.
function fullMods(localEmbedBatch) {
  return {
    stage0: stage0Mod,
    salience: salienceMod,
    promote: promoteMod,
    normalizeSourceEvent: salienceMod.normalizeSourceEvent,
    localEmbedBatch,
    indexCache: { loadIndices: () => ({ hnsw: null }) },
  };
}

async function tickWithMods(mods) {
  watermarkMod._setCascadeModsForTest(mods);
  try {
    return await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    watermarkMod._setCascadeModsForTest(null);
  }
}

function degradeLines(stderr) {
  return stderr.split("\n").filter((l) => l.includes(DEGRADE_PREFIX));
}

// -----------------------------------------------------------------------------
// Faithful error constructors — each mirrors an actual construction site in
// mcp/lib/local-embedder-client.js, message template and cause shape included.
// LocalEmbedUnavailableError carries only { name, retryable, cause, url }
// (client :121-132): there is NO statusCode field, so HTTP status is only ever
// recoverable from the message substring `returned <status>:` (client :377-380).
// -----------------------------------------------------------------------------

// client :344 — the ONLY site that attaches a `cause`.
function transportError(netErr) {
  return new LocalEmbedUnavailableError(
    `local-embedder-client: cannot reach embed server at ${ENDPOINT}: ${
      netErr && netErr.message ? netErr.message : String(netErr)
    }`,
    { cause: netErr, url: ENDPOINT },
  );
}

// What AbortController.abort() surfaces through node:http (client :326-332).
function abortCause({ withName = true, withCode = true } = {}) {
  const e = new Error("The operation was aborted");
  if (withName) e.name = "AbortError";
  if (withCode) e.code = "ABORT_ERR";
  return e;
}

function syscallCause(code) {
  const e = new Error(`connect ${code} 127.0.0.1:8359`);
  e.code = code;
  e.syscall = "connect";
  return e;
}

// client :377-380
function httpError(status, apiMsg) {
  return new LocalEmbedUnavailableError(
    `local-embedder-client: ${ENDPOINT} returned ${status}: ${apiMsg}`,
    { url: ENDPOINT },
  );
}

// -----------------------------------------------------------------------------
// R1..R14 — reason taxonomy. One named case per code.
//
// Each entry: { name, reason, err, detailIncludes? }.
// -----------------------------------------------------------------------------
const REASON_CASES = [
  {
    name: "R1 timeout (cause.name=AbortError)",
    reason: "timeout",
    err: () => transportError(abortCause({ withName: true, withCode: false })),
  },
  {
    name: "R2 timeout (cause.code=ABORT_ERR, no AbortError name)",
    reason: "timeout",
    err: () => transportError(abortCause({ withName: false, withCode: true })),
  },
  {
    name: "R3 conn_ECONNREFUSED (server down)",
    reason: "conn_ECONNREFUSED",
    err: () => transportError(syscallCause("ECONNREFUSED")),
    detailIncludes: "cannot reach embed server",
  },
  {
    name: "R4 conn_ECONNRESET (socket died mid-request)",
    reason: "conn_ECONNRESET",
    err: () => transportError(syscallCause("ECONNRESET")),
  },
  {
    name: "R5 http_429 (queue_full)",
    reason: "http_429",
    err: () => httpError(429, "queue_full"),
    detailIncludes: "queue_full",
  },
  {
    name: "R6 http_503 (draining / deadline_exceeded)",
    reason: "http_503",
    err: () => httpError(503, "draining"),
    detailIncludes: "draining",
  },
  {
    name: "R7 http_413 (body_too_large)",
    reason: "http_413",
    err: () => httpError(413, "body_too_large"),
    detailIncludes: "body_too_large",
  },
  {
    name: "R8 http_500 (status is DERIVED, not enumerated)",
    reason: "http_500",
    err: () => httpError(500, "internal error"),
  },
  {
    name: "R9 malformed_response (missing embeddings[])",
    reason: "malformed_response",
    err: () =>
      new LocalEmbedUnavailableError(
        `local-embedder-client: ${ENDPOINT} response missing embeddings[]`,
        { url: ENDPOINT },
      ),
    detailIncludes: "missing embeddings[]",
  },
  {
    name: "R10 malformed_response (malformed fetch response)",
    reason: "malformed_response",
    err: () =>
      new LocalEmbedUnavailableError(
        `local-embedder-client: malformed fetch response from ${ENDPOINT}`,
        { url: ENDPOINT },
      ),
  },
  {
    name: "R11 count_mismatch (embedBatch expected N, got M)",
    reason: "count_mismatch",
    err: () =>
      new LocalEmbedUnavailableError(
        "local-embedder-client: embedBatch expected 3 embeddings, got 2",
      ),
    detailIncludes: "expected 3 embeddings, got 2",
  },
  {
    name: "R12 count_mismatch (embedSingle expected 1 embedding, got N)",
    reason: "count_mismatch",
    err: () =>
      new LocalEmbedUnavailableError(
        "local-embedder-client: embedSingle expected 1 embedding, got 0",
      ),
  },
  {
    name: "R13 unknown (no cause, unrecognised message)",
    reason: "unknown",
    err: () =>
      new LocalEmbedUnavailableError(
        "local-embedder-client: a failure mode nobody has written down yet",
      ),
  },
];

// All FIVE _renormAndAssert shape throws collapse to one code: bad_vector.
const BAD_VECTOR_MESSAGES = [
  "local-embedder-client: embedBatch[0].vector_4096 is not a non-empty number[]",
  "local-embedder-client: embedBatch[0].vector_4096 has 1024 dims; expected 4096",
  "local-embedder-client: embedBatch[0].vector_4096 has degenerate norm=0; cannot renormalize",
  "local-embedder-client: embedBatch[0].vector_4096[7] is not a finite number",
  "local-embedder-client: embedBatch[0].vector_4096 unit-norm invariant violated post-renorm; ||v||=1.5",
];
for (let i = 0; i < BAD_VECTOR_MESSAGES.length; i++) {
  REASON_CASES.push({
    name: `R14.${i + 1} bad_vector (_renormAndAssert variant ${i + 1})`,
    reason: "bad_vector",
    err: () => new LocalEmbedUnavailableError(BAD_VECTOR_MESSAGES[i]),
  });
}

for (const kase of REASON_CASES) {
  test(`${kase.name} → reason=${kase.reason}`, async () => {
    const source = "imessage";
    const tag = kase.reason + "-" + kase.name.split(" ")[0];
    seedRows(source, tag, 2);

    let embedCalls = 0;
    const stderr = await withCapturedStderr(async () => {
      await tickWithMods(
        dropModsWithEmbed(async () => {
          embedCalls += 1;
          throw kase.err();
        }),
      );
    });

    assert.equal(embedCalls, 1, "the embed seam must have been exercised exactly once");

    const lines = degradeLines(stderr);
    assert.equal(
      lines.length,
      1,
      `expected exactly ONE degrade line, got ${lines.length}:\n${stderr}`,
    );
    const line = lines[0];

    // S5 (per-case): the operator-grep prefix is byte-for-byte stable.
    assert.ok(
      line.includes(DEGRADE_PREFIX + source),
      `degrade line must keep the byte-for-byte grep prefix; got:\n${line}`,
    );

    // The whole point: the failure NAMES ITSELF.
    assert.match(
      line,
      new RegExp(` reason=${kase.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`),
      `degrade line must carry reason=${kase.reason}; got:\n${line}`,
    );

    // items= is the embedded-item count for this tick (2 seeded rows).
    const items = line.match(/ items=(\d+)/);
    assert.ok(items != null, `degrade line must carry items=<n>; got:\n${line}`);
    assert.equal(Number(items[1]), 2, "items must equal the tick's embedded item count");

    // elapsed_ms is an INTEGER wall-clock of the failed call.
    const elapsed = line.match(/ elapsed_ms=(\d+)(\s|$)/);
    assert.ok(elapsed != null, `degrade line must carry elapsed_ms=<n>; got:\n${line}`);
    assert.ok(
      Number.isInteger(Number(elapsed[1])) && Number(elapsed[1]) >= 0,
      "elapsed_ms must be a non-negative integer",
    );

    if (kase.detailIncludes) {
      assert.ok(
        line.includes(kase.detailIncludes),
        `degrade line must carry the verbatim detail ${JSON.stringify(
          kase.detailIncludes,
        )}; got:\n${line}`,
      );
    }
  });
}

// -----------------------------------------------------------------------------
// S1 — a NON-LocalEmbedUnavailableError throw is UNCHANGED.
//
// It must still take the `localUnavailable === false` branch, still write the
// pre-existing watermark.js:1958-1968 line, and must NOT be reported as a
// server-unavailable degrade. This is the discriminator that the classifier
// did not widen the catch.
// -----------------------------------------------------------------------------
test("S1: a plain TypeError still takes the localUnavailable=false branch, log unchanged", async () => {
  const source = "imessage";
  seedRows(source, "s1-typeerror", 2);

  const stderr = await withCapturedStderr(async () => {
    await tickWithMods(
      dropModsWithEmbed(async () => {
        throw new TypeError("synthetic non-typed embed failure (test)");
      }),
    );
  });

  assert.ok(
    stderr.includes(
      UNEXPECTED_PREFIX +
        source +
        " (promoting with null embedding + sweep): synthetic non-typed embed failure (test)",
    ),
    `the pre-existing unexpected-throw line must be byte-for-byte unchanged; got:\n${stderr}`,
  );
  assert.equal(
    degradeLines(stderr).length,
    0,
    "an untyped throw is NOT a server-unavailable degrade and must not emit that line",
  );
});

// -----------------------------------------------------------------------------
// S2 — BEHAVIOUR INVARIANCE. The most important assertion in the file.
//
// Same seeded fixture, run twice with the FULL cascade (real stage0 + salience
// + promote): once with a working localEmbedBatch, once with a throwing one.
// The cursor must reach the SAME last_offset and the tick must report the same
// rows_read / rows_promoted. If this ever goes red, the change stopped being a
// logging change: something started parking, retrying, or skipping rows.
// -----------------------------------------------------------------------------
test("S2: an embed failure changes the LOG and nothing else (cursor + counts identical)", async () => {
  const source = "telegram";
  clearAllSourceLedgers();

  async function runOnce(localEmbedBatch) {
    const eof = seedRows(source, "s2-invariance", 3);
    let res;
    await withCapturedStderr(async () => {
      res = await tickWithMods(fullMods(localEmbedBatch));
    });
    const cursor = readCursor(source);
    return {
      eof,
      last_offset: cursor == null ? null : String(cursor.last_offset),
      error_count: cursor == null ? null : cursor.error_count,
      rows_read: res.rows_read,
      rows_promoted: res.rows_promoted,
      rows_errored: res.rows_errored,
      rows_dropped: res.rows_dropped,
      rows_corroborated: res.rows_corroborated,
    };
  }

  const ok = await runOnce(async (args) =>
    args.items.map((_t, i) => ({ index: i, vector_4096: STUB_VEC_4096.slice() })),
  );
  const bad = await runOnce(async () => {
    throw transportError(abortCause());
  });

  assert.equal(ok.eof, bad.eof, "both runs must be seeded from a byte-identical fixture");
  assert.equal(
    ok.last_offset,
    bad.last_offset,
    "the cursor must advance to the SAME offset with a failed embed as with a good one",
  );
  assert.equal(
    String(ok.last_offset),
    String(ok.eof),
    "and that offset must be EOF — no head-of-line block on either path",
  );
  assert.equal(ok.rows_read, bad.rows_read, "rows_read must be identical");
  assert.equal(ok.rows_promoted, bad.rows_promoted, "rows_promoted must be identical");
  assert.equal(ok.rows_errored, bad.rows_errored, "rows_errored must be identical");
  assert.equal(ok.rows_dropped, bad.rows_dropped, "rows_dropped must be identical");
  assert.equal(
    ok.rows_corroborated,
    bad.rows_corroborated,
    "rows_corroborated must be identical",
  );
  assert.equal(
    bad.error_count,
    ok.error_count,
    "an embed outage must not be charged toward the auto-mute breaker",
  );
  assert.ok(
    ok.rows_promoted >= 1,
    `the invariance fixture must actually PROMOTE, else it proves nothing (got ${ok.rows_promoted})`,
  );
});

// -----------------------------------------------------------------------------
// S3 — LOG DISCIPLINE: one degrade line per (source, tick), regardless of how
// many rows the tick embedded. A per-row or per-chunk line would drown the
// operator log exactly when the system is already degraded.
// -----------------------------------------------------------------------------
test("S3: exactly ONE degrade line per (source, tick) even for a large batch", async () => {
  const source = "imessage";
  clearAllSourceLedgers();
  const ROWS = 25;
  seedRows(source, "s3-batch", ROWS);

  let res;
  const stderr = await withCapturedStderr(async () => {
    res = await tickWithMods(
      dropModsWithEmbed(async () => {
        throw httpError(429, "queue_full");
      }),
    );
  });

  assert.ok(res.rows_read >= ROWS, `all ${ROWS} rows must be read (got ${res.rows_read})`);
  const lines = degradeLines(stderr);
  assert.equal(
    lines.length,
    1,
    `a ${ROWS}-row tick must still log ONCE, got ${lines.length}:\n${stderr}`,
  );
  assert.match(
    lines[0],
    new RegExp(` items=${ROWS}(\\s|$)`),
    `the single line must report the full batch size items=${ROWS}; got:\n${lines[0]}`,
  );
});

// -----------------------------------------------------------------------------
// S4 — DETAIL SANITISATION + TRUNCATION.
//
// The detail is SERVER-CONTROLLED text (the client interpolates the response
// body into `returned <status>: <apiMsg>`). An embed server that echoes a
// newline could otherwise forge an entire additional log line, and an
// unbounded body could blow up a line to megabytes. One line, <= 300 chars.
// -----------------------------------------------------------------------------
test("S4: a CR/LF-bearing, oversized detail stays ONE line and is truncated to 300 chars", async () => {
  const source = "imessage";
  clearAllSourceLedgers();
  seedRows(source, "s4-sanitise", 1);

  const forged =
    "FIRSTLINE\nwatermark: FORGED-SECOND-LINE\r\nTHIRDLINE" + "x".repeat(2000);

  const stderr = await withCapturedStderr(async () => {
    await tickWithMods(
      dropModsWithEmbed(async () => {
        throw httpError(400, forged);
      }),
    );
  });

  const lines = degradeLines(stderr);
  assert.equal(
    lines.length,
    1,
    `a newline-bearing detail must still produce ONE degrade line, got ${lines.length}`,
  );
  assert.match(lines[0], / reason=http_400(\s|$)/, "status still classified from the message");

  // The forged continuation was FOLDED onto the same line, not emitted as its
  // own record.
  const detail = lines[0].split("re-embed sweep: ")[1];
  assert.ok(detail != null, `degrade line must carry a detail suffix; got:\n${lines[0]}`);
  assert.ok(
    detail.length <= 300,
    `detail must be truncated to <= 300 chars, got ${detail.length}`,
  );
  assert.doesNotMatch(detail, /[\r\n]/, "detail must contain no CR or LF");
  assert.ok(
    detail.includes("FIRSTLINE"),
    "the head of the server message must survive into the detail",
  );
  // No stderr line may consist of the forged continuation on its own.
  assert.equal(
    stderr.split("\n").filter((l) => l.startsWith("watermark: FORGED-SECOND-LINE")).length,
    0,
    "server-controlled text must never be able to forge a standalone log line",
  );
});

// -----------------------------------------------------------------------------
// S5 — the sweep is still recorded. The degrade line promises "recording to
// re-embed sweep"; pin that the promise is kept on the classified path, so the
// new wording never drifts away from the behaviour it describes.
// -----------------------------------------------------------------------------
test("S5: the classified degrade still promotes with a null embedding and records the sweep", async () => {
  const source = "imessage";
  clearAllSourceLedgers();
  seedRows(source, "s5-sweep", 1);

  let res;
  const stderr = await withCapturedStderr(async () => {
    res = await tickWithMods(
      fullMods(async () => {
        throw transportError(syscallCause("ECONNREFUSED"));
      }),
    );
  });

  assert.ok(res.rows_promoted >= 1, "the row must still PROMOTE with a null embedding");
  const lines = degradeLines(stderr);
  assert.equal(lines.length, 1, "one degrade line");
  assert.match(lines[0], / reason=conn_ECONNREFUSED(\s|$)/);

  const sweep = existsSync(RE_EMBED_SWEEP)
    ? readFileSync(RE_EMBED_SWEEP, "utf8").split("\n").filter((l) => l.length > 0)
    : [];
  assert.ok(
    sweep.length >= 1,
    "the promoted-without-embed fact id must be recorded to the re-embed sweep file",
  );
});
