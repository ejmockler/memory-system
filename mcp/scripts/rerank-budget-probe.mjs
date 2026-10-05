#!/usr/bin/env node
// rerank-budget-probe.mjs — measure what the local Qwen3-Reranker actually
// costs for a PRODUCTION-SHAPED Layer-3 payload, so LOCAL_RERANKER_TIMEOUT_MS
// is set from a number rather than from intuition.
//
// WHY THIS IS A SCRIPT AND NOT A TEST
//   Two reasons, both hard. (1) `test/**/*.test.mjs` on disk is parity-checked
//   against the SUITES registry in scripts/run-all-tests.mjs (suiteParityDrift);
//   a new test file would drift that guard. (2) This probe DELIBERATELY dials
//   the live rerank server on 127.0.0.1:8360 — the one thing every suite is
//   forbidden to do, and the thing rerank-hermeticity-probe.mjs exists to
//   police. A measurement of the real model cannot be hermetic, so it must not
//   live where hermeticity is the contract. Same rationale, same shape as
//   rerank-hermeticity-probe.mjs; that file is the precedent this one follows.
//
// WHY A SCRIPT AND NOT A NUMBER IN A REPORT
//   A latency written into a doc is true on the day it is written and unfalsifiable
//   afterwards. This is re-runnable: whoever doubts the budget re-measures it.
//
// READ-ONLY: POST /rerank is a pure scoring call. Nothing is written to
// ledgers/, indices/, storage/ or policy/; no daemon is started, stopped or
// signalled. If the server is not up the probe reports that and exits 0 —
// absence of a measurement is reported as absence, never as a zero.
//
// THE PAYLOAD IS BUILT THROUGH THE REAL SEAMS
//   buildRerankInstruction() + serializeCandidateForRerank() at cap sizes, with
//   RECALL_RERANK_INPUT_SIZE candidates. A hand-rolled payload would measure a
//   shape production never sends — which is exactly how the "8006 ms is a
//   mystery" reading arose: a short-query probe is not the production shape.
//
// THREE HYPOTHESES IT SEPARATES
//   (a) QUERY LENGTH. local-reranker-client.js sends the FULL instruction as
//       `query` (bounded by CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL), and
//       local-embedder/rerank_server.py's _format inlines that query into EVERY
//       one of the N prompts. So query length is multiplied by N, not added
//       once. The SHORT-QUERY arm is the control that isolates it.
//   (b) CONTENTION. rerank_server.py holds a process-global _LOCK around the
//       whole forward pass, so two concurrent recalls SERIALISE. The
//       2-CONCURRENT arm measures what a second caller actually waits.
//   (c) COLD START. lib/validation.js already records 405-606 ms warm vs 3.9 s
//       cold for a 15-candidate payload. FIRST-CALL is therefore reported
//       separately from the warm distribution, never averaged into it.
//   Payload BYTES are bounded by construction (N x
//   RECALL_BRIEF_MAX_CHARS_PER_ITEM) and are printed to RETIRE that hypothesis
//   as data rather than argue it.
//
// Usage:
//   node scripts/rerank-budget-probe.mjs            # default 7 warm iterations
//   node scripts/rerank-budget-probe.mjs --n 15
//   LOCAL_RERANKER_URL=http://127.0.0.1:8360 node scripts/rerank-budget-probe.mjs

// OUT OF SCOPE, RECORDED NOT FIXED (handed to a follow-up node)
//   rerank_server.py tokenises with truncation=True and MAX_LEN =
//   RERANK_MAX_TOKENS (default 2048), truncating on the RIGHT. The production
//   instruction this probe builds is ~3.9k chars and is inlined AHEAD of each
//   <Document> in _format, so a long-enough query can push the document out of
//   the window entirely and make the scores noise — a CORRECTNESS hazard, not
//   a latency one. This probe surfaces it as data (see the PAYLOAD block's
//   instruction-chars line); it is not fixed here because landing a change in
//   rerank_server.py requires restarting that daemon.
//
//   Separately, rerank.js already documents that the local client ignores the
//   caller's `signal`. That is a cancellation defect, not a taxonomy one.

import { buildRerankInstruction, serializeCandidateForRerank } from "../lib/recall/rerank.js";
import { DEFAULT_TIMEOUT_MS } from "../lib/recall/local-reranker-client.js";
import { CAPS } from "../lib/validation.js";

const BASE = (process.env.LOCAL_RERANKER_URL || "http://127.0.0.1:8360").replace(/\/+$/, "");
const argN = (() => {
  const i = process.argv.indexOf("--n");
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 7;
})();

const N_CANDIDATES = CAPS.RECALL_RERANK_INPUT_SIZE;
const PER_ITEM = CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM;
const MAX_INSTRUCTION = CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL;
// Imported, never re-typed: the probe must not be able to drift from the
// constant it is arguing about.
const CLIENT_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
const OUTER_TIMEOUT_MS = CAPS.RECALL_RERANK_TIMEOUT_MS;

function ms(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}
function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(1) : "n/a";
}

// --- production-shaped payload, through the real seams -----------------------

// Lorem-ish filler that is deterministic and word-shaped (token counts matter to
// the model far more than byte counts, so random bytes would understate cost).
const WORDS =
  "project status migration ledger embedding recall rerank candidate salience valence consent derivation entity thread message synthesis checkpoint daemon index shard latency budget".split(
    " ",
  );
function filler(chars, seed) {
  let out = "";
  let i = seed;
  while (out.length < chars) {
    out += WORDS[i % WORDS.length] + " ";
    i += 1;
  }
  return out.slice(0, chars);
}

function buildProductionPayload() {
  // Candidates at the per-item cap, entity-heavy (the shape rerank.js:311-316
  // records as the one that used to blow the header budget).
  const rerankInput = [];
  for (let i = 0; i < N_CANDIDATES; i += 1) {
    rerankInput.push({
      candidate: {
        memory_id: `mem_${String(i).padStart(3, "0")}_budgetprobe`,
        kind: "fact",
        ts: "2026-08-19T12:00:00.000Z",
        entities: Array.from({ length: 12 }, (_, k) => `entity_${i}_${k}`),
        consent_basis: "first_party",
        valence: null,
        content: filler(PER_ITEM, i * 7),
        features: { salience: { score: 0.5 } },
      },
      score_components: { final_score: 1 - i / N_CANDIDATES },
    });
  }

  // A surrounding_context big enough that buildRerankInstruction's turn-dropping
  // loop actually binds — i.e. the instruction lands AT the cap, which is the
  // worst case production can send.
  const surrounding_context = {
    current_query: "what is the current status of the migration and who owns it?",
    recent_turns: Array.from({ length: 40 }, (_, k) => ({
      role: k % 2 === 0 ? "user" : "assistant",
      content: filler(200, k * 3),
    })),
    agent_role: "primary_assistant",
    entities: Array.from({ length: 20 }, (_, k) => `entity_ctx_${k}`),
  };

  const instruction = buildRerankInstruction({
    surrounding_context,
    candidates: rerankInput,
    opts: { now: "2026-08-19T12:00:00.000Z" },
  });
  // serializeCandidateForRerank returns {id, content}; local-reranker-client.js
  // sends exactly the .content strings as `documents` (candidates.map(c => c.content)).
  const documents = rerankInput
    .map((s) => serializeCandidateForRerank({ entry: s.candidate, score_components: s.score_components }))
    .map((c) => c.content);
  return { instruction, documents };
}

// --- transport ---------------------------------------------------------------

async function callRerank(query, documents, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(`${BASE}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, documents }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, why: `http_${res.status}`, ms: ms(t0) };
    const body = await res.json();
    const n = Array.isArray(body && body.scores) ? body.scores.length : -1;
    return { ok: n === documents.length, why: n === documents.length ? null : `scores=${n}`, ms: ms(t0), server_ms: body && body.elapsed_ms };
  } catch (err) {
    const aborted = (err && err.name === "AbortError") || controller.signal.aborted;
    return { ok: false, why: aborted ? "timeout" : `network: ${err && err.message}`, ms: ms(t0) };
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  try {
    const res = await fetch(`${BASE}/health`, { method: "GET" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- arms --------------------------------------------------------------------

function report(label, samples) {
  const okMs = samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const failed = samples.filter((s) => !s.ok);
  const line =
    `${label.padEnd(34)} n=${String(samples.length).padStart(2)}  ` +
    `p50=${fmt(pct(okMs, 50)).padStart(8)}ms  p95=${fmt(pct(okMs, 95)).padStart(8)}ms  ` +
    `min=${fmt(okMs[0]).padStart(8)}ms  max=${fmt(okMs[okMs.length - 1]).padStart(8)}ms`;
  const failNote = failed.length ? `  FAILED=${failed.length} (${failed.map((f) => f.why).join(", ")})` : "";
  process.stdout.write(line + failNote + "\n");
  return { p50: pct(okMs, 50), p95: pct(okMs, 95), max: okMs[okMs.length - 1], failed: failed.length };
}

async function main() {
  const h = await health();
  process.stdout.write(
    `rerank-budget-probe — ${BASE}\n` +
      `Layer-3 payload shape is read from CAPS, not hard-coded here.\n\n`,
  );
  if (!h || h.ok !== true) {
    process.stdout.write(
      `NO MEASUREMENT: ${BASE}/health did not answer ok.\n` +
        `The server is not up, so there is nothing to measure. This is reported as an\n` +
        `ABSENCE of evidence — do not read it as a fast or a slow result, and do not\n` +
        `change any timeout constant on the strength of it.\n`,
    );
    return 0;
  }
  process.stdout.write(`server: model=${h.model} device=${h.device}\n\n`);

  const { instruction, documents } = buildProductionPayload();
  const shortQuery = "what is the current status of the migration and who owns it?";
  const bodyBytes = Buffer.byteLength(JSON.stringify({ query: instruction, documents }), "utf8");
  const docBytes = documents.reduce((a, d) => a + Buffer.byteLength(d, "utf8"), 0);

  process.stdout.write(
    `PAYLOAD (built via buildRerankInstruction + serializeCandidateForRerank)\n` +
      `  candidates           ${documents.length}  (CAPS.RECALL_RERANK_INPUT_SIZE)\n` +
      `  instruction chars    ${instruction.length}  (cap CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL=${MAX_INSTRUCTION})\n` +
      `  short-query chars    ${shortQuery.length}  (the control)\n` +
      `  document chars       min=${Math.min(...documents.map((d) => d.length))} max=${Math.max(...documents.map((d) => d.length))}  (per-item cap ${PER_ITEM} + header)\n` +
      `  documents bytes      ${docBytes}\n` +
      `  whole request bytes  ${bodyBytes}\n` +
      `  -> BYTES are bounded by construction and are kilobytes, not megabytes.\n` +
      `     Transport size is retired as an explanation; what follows is compute.\n` +
      `  -> TRUNCATION HAZARD (out of scope, recorded): rerank_server.py tokenises\n` +
      `     at RERANK_MAX_TOKENS (default 2048) with RIGHT truncation, and _format\n` +
      `     puts this ${instruction.length}-char query AHEAD of each <Document>. A query this\n` +
      `     long can evict the document from the window and make the scores noise.\n\n`,
  );

  // Generous ceiling so an arm MEASURES a slow call instead of reporting a
  // timeout we then have to guess about.
  const CEILING = 120000;

  process.stdout.write(`ARMS (each call POST /rerank, ceiling ${CEILING}ms so nothing is truncated)\n`);

  // (c) COLD START — the first call of this process, reported alone.
  const first = await callRerank(instruction, documents, CEILING);
  process.stdout.write(
    `${"first-call (production query)".padEnd(34)} ${fmt(first.ms).padStart(8)}ms` +
      (first.ok ? "" : `  FAILED (${first.why})`) +
      `   <- reported ALONE; never averaged into warm\n`,
  );

  // (a) QUERY LENGTH — production query vs short-query control, warm, serial.
  const warmProd = [];
  for (let i = 0; i < argN; i += 1) warmProd.push(await callRerank(instruction, documents, CEILING));
  const prod = report("warm serial (production query)", warmProd);

  const warmShort = [];
  for (let i = 0; i < argN; i += 1) warmShort.push(await callRerank(shortQuery, documents, CEILING));
  const short = report("warm serial (SHORT query ctrl)", warmShort);

  // (b) CONTENTION — two concurrent callers against a process-global lock.
  const conc = [];
  for (let i = 0; i < Math.max(2, Math.ceil(argN / 2)); i += 1) {
    const pair = await Promise.all([
      callRerank(instruction, documents, CEILING),
      callRerank(instruction, documents, CEILING),
    ]);
    conc.push(...pair);
  }
  const concurrent = report("2-concurrent (production query)", conc);

  // --- reading ---------------------------------------------------------------

  const ratio = Number.isFinite(short.p50) && short.p50 > 0 ? prod.p50 / short.p50 : NaN;
  const contentionRatio = Number.isFinite(prod.p50) && prod.p50 > 0 ? concurrent.p95 / prod.p50 : NaN;
  const worst = Math.max(
    ...[first.ms, prod.p95, concurrent.p95].filter((x) => Number.isFinite(x)),
  );

  process.stdout.write(
    `\nREADING\n` +
      `  (a) query length      production p50 / short-query p50 = ${fmt(ratio)}x\n` +
      `      The query is inlined into EVERY one of the ${documents.length} prompts by\n` +
      `      rerank_server.py's _format, so a long query is multiplied, not added.\n` +
      `  (b) contention        2-concurrent p95 / serial p50 = ${fmt(contentionRatio)}x\n` +
      `      rerank_server.py's process-global _LOCK serialises the forward pass;\n` +
      `      a ratio near 2x IS the lock, not noise.\n` +
      `  (c) cold start        first-call ${fmt(first.ms)}ms vs warm p50 ${fmt(prod.p50)}ms\n\n` +
      `BUDGET\n` +
      `  worst observed (max of first-call, serial p95, concurrent p95) = ${fmt(worst)}ms\n` +
      `  client default LOCAL_RERANKER_TIMEOUT_MS = ${CLIENT_DEFAULT_TIMEOUT_MS}ms\n` +
      `  CAPS.RECALL_RERANK_TIMEOUT_MS (rerank.js outer race) = ${OUTER_TIMEOUT_MS}ms\n` +
      `  STRUCTURAL FACT, independent of the numbers above: ${CLIENT_DEFAULT_TIMEOUT_MS} < ${OUTER_TIMEOUT_MS},\n` +
      `  so on the LOCAL path the client's timer ALWAYS fires first and rerank.js's\n` +
      `  outer race is dead code. Any Layer-3 timeout observed near 8s is the\n` +
      `  CLIENT's budget expiring — attributing it to the CAP is a misreading.\n` +
      `  headroom at the client default = ${fmt(CLIENT_DEFAULT_TIMEOUT_MS - worst)}ms\n` +
      `  Change LOCAL_RERANKER_TIMEOUT_MS only against numbers from a run of THIS\n` +
      `  script, recorded beside the constant.\n`,
  );
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`rerank-budget-probe: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
