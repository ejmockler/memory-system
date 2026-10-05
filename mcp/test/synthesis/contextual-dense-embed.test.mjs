// contextual-dense-embed.test.mjs — N5-contextual-retrieval.
//
// Guards the DENSE leg of contextual retrieval (situate-then-embed) + its
// CAPS kill-switch + the BM25 contextual materialization script, mirroring the
// discipline of contextual-bm25.test.mjs for the lexical leg.
//
// What this suite proves (>=12 assertions):
//   1. CONTEXTUAL_DENSE_ENABLED exists in CAPS, default false, frozen.
//   2. The dense embed-text builder with the cap OFF returns RAW content
//      (byte-identical to today's vectors) — additive, no baseline regression.
//   3. With the cap ON, it returns prefix + "\n\n" + content for a row whose
//      prefix is non-empty (situate-then-embed wiring).
//   4. With the cap ON but conversation-index ABSENT, the prefix degrades to
//      on-row resolution and the path still produces text (defensive degrade).
//   5. A row whose conversation-index hit carries a thread label produces
//      embedded text containing that label (recovered-provenance reaches dense).
//   6. The prefix never pushes chunk #0 over the ceiling for the longest fact
//      (the ceiling-warn callback is NOT invoked); prefix+content chunk #0 fits.
//   7. Determinism: two contextual builds of the same row+index produce
//      byte-identical embedded TEXT.
//   8. The prefix is applied to the WHOLE fact BEFORE chunksFor (chunk #0 of a
//      giant carries the prefix; later chunks do not re-prefix).
//   9. rebuild-bm25-index.mjs --contextual writes a bm25.json into the
//      <model>-contextual tree, reports contextual_prefix:true, leaves the
//      baseline tree untouched, and a prefix-only term matches contextual only.
//
// HERMETIC + OFFLINE: pure helpers + a synthetic conversation-index cache. No
// embed server, no MPS, no live ledger. The production tree is never touched
// (mkdtemp MEMORY_ROOT + env override BEFORE any dynamic import).

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");

// ---------------------------------------------------------------------------
// Hermeticity: stake a tmp MEMORY_ROOT + env BEFORE dynamic import so the lib
// config reads the tmp tree, not the default (production) data root.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-ctxdense-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
mkdirSync(join(MEMORY_ROOT, "storage"), { recursive: true });
mkdirSync(join(MEMORY_ROOT, "ledgers"), { recursive: true });

const reembedMod = await import("../../scripts/reembed-local-4096.mjs");
const { buildEmbedTextForRow, chunksFor, WINDOW, MODEL_CONTEXT_TOKENS, CHARS_PER_TOKEN } =
  reembedMod;
const { CAPS } = await import("../../lib/validation.js");
const { buildContextPrefix } = await import("../../lib/recall/context-prefix.js");
const convMod = await import("../../lib/synthesis/conversation-index.js");
const { persistConversationIndex, loadConversationIndexFromCacheSync, lookupConversation } =
  convMod;

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Fixtures — entity OBJECTS matching the live ledger shape.
// ---------------------------------------------------------------------------
function ent(kind, surface, scope = "git-log") {
  return {
    kind,
    canonical_id: `${kind}:${scope}:${surface.toLowerCase().replace(/\W+/g, "_")}`,
    surface,
    source_scope: scope,
    evidence: "handle",
    confidence: 1,
  };
}

// A git-log style anaphoric fact: content NEVER says "samplestable" nor the
// date, but the project entity carries the surface. The prefix must reintroduce
// it so a query naming the project sits near this fact in embedding space.
const anaphorRow = {
  id: "mem_anaphor01",
  kind: "fact",
  content: "fixed the off by one in the redemption loop",
  source: "git-log",
  provenance: { conversation_id: null },
  features: {
    entities: [ent("project", "samplestable"), ent("person", "alex@example.com", "git-log")],
  },
  created_at: "2026-06-10T08:00:00.000Z",
};

// A row with NO entities, NO conversation_id — only a source. The prefix is
// short ("Source: ...") but non-empty; still degrades cleanly.
const sparseRow = {
  id: "mem_sparse01",
  kind: "fact",
  content: "sounds good",
  source: "imessage",
  provenance: { conversation_id: null },
  features: {},
  created_at: "2026-06-12T10:00:00.000Z",
};

// =====================================================================
// 1. CAP existence + default + frozen.
// =====================================================================

test("CONTEXTUAL_DENSE_ENABLED exists, is false by default, and CAPS is frozen", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(CAPS, "CONTEXTUAL_DENSE_ENABLED"),
    true,
    "CAP key must exist",
  );
  assert.equal(CAPS.CONTEXTUAL_DENSE_ENABLED, false, "default OFF (eval-first)");
  assert.equal(Object.isFrozen(CAPS), true, "CAPS is Object.freeze'd");
  // Mutation is a silent no-op under freeze; assert it did not take.
  try { CAPS.CONTEXTUAL_DENSE_ENABLED = true; } catch { /* strict-mode throw is also fine */ }
  assert.equal(CAPS.CONTEXTUAL_DENSE_ENABLED, false, "frozen — cannot be flipped at runtime");
});

// =====================================================================
// 2. Cap OFF — embedded text is byte-identical to raw content.
// =====================================================================

test("cap OFF: buildEmbedTextForRow returns RAW content (byte-identical baseline)", () => {
  const text = buildEmbedTextForRow(anaphorRow, anaphorRow.content, { contextual: false });
  assert.equal(text, anaphorRow.content, "OFF => no prefix, byte-identical to today");
  // The default (no opts) is also the baseline path.
  assert.equal(buildEmbedTextForRow(anaphorRow, anaphorRow.content), anaphorRow.content);
});

// =====================================================================
// 3. Cap ON — prefix + "\n\n" + content for a non-empty prefix.
// =====================================================================

test("cap ON: embedded text is prefix + \\n\\n + content (situate-then-embed)", () => {
  const prefix = buildContextPrefix(anaphorRow);
  assert.ok(prefix.length > 0, "fixture row yields a non-empty prefix");
  const text = buildEmbedTextForRow(anaphorRow, anaphorRow.content, { contextual: true });
  assert.equal(text, prefix + "\n\n" + anaphorRow.content, "exact concat shape");
  // The prefix reintroduces a term the bare content omits (the load-bearing case).
  assert.ok(text.includes("samplestable"), "anaphor term recovered into the embed text");
  assert.ok(!anaphorRow.content.includes("samplestable"), "bare content never had it");
});

// =====================================================================
// 4. Cap ON, index ABSENT — degrades to on-row resolution, still produces text.
// =====================================================================

test("cap ON, conversation-index absent: degrades to on-row prefix, still produces text", () => {
  // No conversationIndex passed -> buildContextPrefix(row) single-arg path.
  const text = buildEmbedTextForRow(sparseRow, sparseRow.content, { contextual: true });
  assert.ok(typeof text === "string" && text.length >= sparseRow.content.length, "non-empty text");
  assert.ok(text.endsWith(sparseRow.content), "content survives at the tail");
  // The on-row prefix for a source-only row is "Source: imessage. ..." etc.
  assert.ok(text.includes("Source: imessage"), "on-row degrade still situates by source");
});

// =====================================================================
// 5. Recovered-provenance: a conversation-index hit's thread label reaches the
//    embedded text (the whole point — recovered provenance feeds the dense leg).
// =====================================================================

test("conversation-index hit injects the thread label into the embedded text", async () => {
  // Build a real cache: anaphorRow joins to a daemon:thread:* descriptor.
  const ledgerPath = join(MEMORY_ROOT, "ledgers", "memory.jsonl");
  writeFileSync(ledgerPath, JSON.stringify(anaphorRow) + "\n");
  const fp = statSync(ledgerPath);
  const byFactId = new Map([
    [
      anaphorRow.id,
      {
        conversation_id: "daemon:thread:repo:sample-orchard:author:alex@x:day:2026-06-10",
        thread_label: "sample-orchard 2026-06-10",
      },
    ],
  ]);
  const cachePath = join(MEMORY_ROOT, "storage", "conversation-index.cache.json");
  await persistConversationIndex(
    { byFactId, ledgerMtime: fp.mtimeMs, ledgerSize: fp.size, built_at: new Date().toISOString(), stats: {} },
    cachePath,
  );
  const idx = loadConversationIndexFromCacheSync({ ledgerPath, cachePath });
  assert.ok(idx != null, "fresh cache loads (mtime+size fingerprint matches)");
  assert.equal(lookupConversation(idx, anaphorRow.id).thread_label, "sample-orchard 2026-06-10");

  const text = buildEmbedTextForRow(anaphorRow, anaphorRow.content, {
    contextual: true,
    conversationIndex: idx,
  });
  // The thread label's descriptive token (the repo) is in the prefix.
  assert.ok(text.startsWith("Conversation: sample-orchard"), `got: ${text.slice(0, 80)}`);
  assert.ok(text.includes(anaphorRow.content), "content still present");
});

// =====================================================================
// 6. Ceiling guard — the prefix never pushes chunk #0 over the embed window.
// =====================================================================

test("prefix never pushes chunk #0 over the ceiling for the longest fact", () => {
  // A fact whose content is exactly WINDOW chars: prefix + content overflows
  // WINDOW (so it chunks) but chunk #0 must STILL be <= WINDOW and never warn.
  const bigRow = {
    id: "mem_big01",
    kind: "fact",
    content: "x".repeat(WINDOW),
    source: "git-log",
    provenance: { conversation_id: null },
    features: { entities: [ent("project", "samplestable")] },
    created_at: "2026-06-10T08:00:00.000Z",
  };
  const text = buildEmbedTextForRow(bigRow, bigRow.content, { contextual: true });
  assert.ok(text.length > WINDOW, "prefix+WINDOW content exceeds the window (will chunk)");
  let warns = 0;
  const cs = chunksFor(bigRow.id, text, { onWarn: () => warns++ });
  assert.equal(warns, 0, "ceiling-warn was NOT triggered (prefix fits under the cap)");
  assert.ok(cs.length >= 1, "produced at least one chunk");
  assert.ok(cs[0].text.length <= WINDOW, "chunk #0 stays within the embed window");
  // Sanity: WINDOW + the ~40-token prefix is still well under the model ceiling.
  const ceilingChars = MODEL_CONTEXT_TOKENS * CHARS_PER_TOKEN;
  assert.ok(cs[0].text.length < ceilingChars, "chunk #0 under the model ceiling");
});

// =====================================================================
// 7. Determinism — two builds of the same row+index produce identical text.
// =====================================================================

test("determinism: two contextual builds produce byte-identical embedded TEXT", () => {
  const a = buildEmbedTextForRow(anaphorRow, anaphorRow.content, { contextual: true });
  const b = buildEmbedTextForRow({ ...anaphorRow }, anaphorRow.content, { contextual: true });
  assert.equal(a, b, "embedding-INPUT is deterministic across calls");
});

// =====================================================================
// 8. Whole-fact prefixing — chunk #0 of a giant carries the prefix; later
//    chunks do NOT re-prefix (the cookbook situates the whole doc once).
// =====================================================================

test("prefix rides chunk #0 only — later chunks carry no re-prefix", () => {
  const TURN = "\n---\n";
  const turns = [];
  for (let i = 0; i < 30; i++) turns.push(`TURN${i}:` + "a".repeat(1800));
  const giant = turns.join(TURN);
  const row = {
    id: "mem_giant01",
    kind: "fact",
    content: giant,
    source: "imessage",
    provenance: { conversation_id: null },
    features: { entities: [ent("project", "samplestable")] },
    created_at: "2026-06-10T08:00:00.000Z",
  };
  const text = buildEmbedTextForRow(row, giant, { contextual: true });
  const cs = chunksFor(row.id, text, { onWarn: () => {} });
  assert.ok(cs.length > 1, "giant chunks into multiple vectors");
  assert.ok(cs[0].text.includes("Conversation:") || cs[0].text.includes("samplestable"),
    "chunk #0 carries the situating prefix");
  // The prefix appears exactly once across the whole text (no per-chunk re-prefix
  // by the builder; chunking does not duplicate it except via the normal overlap
  // tail, which prepends a slice of chunk N-1, not a fresh prefix build).
  const prefixHits = (text.match(/Conversation: /g) || []).length;
  assert.equal(prefixHits, 1, "the builder prefixes the WHOLE fact exactly once");
});

// =====================================================================
// 9. BM25 contextual materialization script — writes into the -contextual tree,
//    reports contextual_prefix:true, baseline tree untouched, prefix-only match.
// =====================================================================

test("rebuild-bm25-index.mjs --contextual materializes the -contextual tree only", () => {
  const ledgerPath = join(MEMORY_ROOT, "ledgers", "memory.jsonl");
  writeFileSync(
    ledgerPath,
    [anaphorRow, { ...sparseRow }].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const script = join(HERE, "..", "..", "scripts", "rebuild-bm25-index.mjs");

  // 1. Build the BASELINE arm first (explicit model-version, no contextual).
  const baselineModel = "test-bm25-base";
  execFileSync(process.execPath, [script, `--model-version=${baselineModel}`], {
    env: { ...process.env },
  });
  const baselinePath = join(MEMORY_ROOT, "indices", baselineModel, "bm25.json");
  assert.ok(existsSync(baselinePath), "baseline bm25.json materialized");
  const baselineMtimeBefore = statSync(baselinePath).mtimeMs;

  // 2. Build the CONTEXTUAL arm: --contextual + an explicit base model so the
  //    output tree is test-bm25-ctx-contextual (suffix appended).
  const ctxModel = "test-bm25-ctx";
  const out = execFileSync(
    process.execPath,
    [script, `--model-version=${ctxModel}`, "--contextual"],
    { env: { ...process.env }, encoding: "utf8" },
  );
  const envelope = JSON.parse(out.trim().split("\n").pop());
  assert.equal(envelope.contextual_prefix, true, "envelope reports contextual_prefix:true");
  assert.equal(
    envelope.model_version,
    `${ctxModel}-contextual`,
    "output tree is suffixed with -contextual (baseline never clobbered)",
  );
  const ctxPath = join(MEMORY_ROOT, "indices", `${ctxModel}-contextual`, "bm25.json");
  assert.ok(existsSync(ctxPath), "contextual bm25.json materialized in the -contextual tree");

  // 3. Baseline tree was NOT rewritten by the contextual build (thesis #1).
  assert.equal(
    statSync(baselinePath).mtimeMs,
    baselineMtimeBefore,
    "baseline bm25.json mtime unchanged by the contextual build",
  );

  // 4. A prefix-only term ("samplestable") matches the contextual index but NOT
  //    the baseline (the load-bearing recall assertion, now at the script level).
  const loadV2 = (p) => {
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
    const postings = new Map();
    for (let i = 1; i < lines.length; i++) {
      const v = JSON.parse(lines[i]);
      if (v[0] === "P") postings.set(v[1], v[2]);
    }
    return postings;
  };
  const ctxPostings = loadV2(ctxPath);
  const basePostings = loadV2(baselinePath);
  assert.ok(ctxPostings.has("samplestable"), "contextual index has the prefix-only token");
  assert.ok(!basePostings.has("samplestable"), "baseline index lacks the prefix-only token");
});

// =====================================================================
// 10. computeFailureRate registers the lift — a synthetic goldset where the
//     contextual leg surfaces the golden and the baseline misses must report
//     contextual top_k_failure_rate < baseline (the metric sees the lift).
//     Pure, no I/O.
// =====================================================================

test("computeFailureRate registers a contextual lift over a synthetic goldset", async () => {
  const { computeFailureRate } = await import("../../lib/recall/eval-failure-rate.js");
  // 4 queries; the golden is findable in contextual, missed in baseline.
  const goldset = [
    { query: "q1", golden_fact_id: "g1", stratum: "whole_fact_entity" },
    { query: "q2", golden_fact_id: "g2", stratum: "whole_fact_entity" },
    { query: "q3", golden_fact_id: "g3", stratum: "whole_fact_general" },
    { query: "q4", golden_fact_id: "g4", stratum: "whole_fact_general" },
  ];
  const baselineRecall = () => ["x", "y", "z"]; // golden never present
  const contextualRecall = (q) => {
    const goldenById = { q1: "g1", q2: "g2", q3: "g3", q4: "g4" };
    return [goldenById[q], "x", "y"]; // golden at rank 0
  };
  const base = await computeFailureRate({ goldset, recallFn: baselineRecall, k: 20 });
  const ctx = await computeFailureRate({ goldset, recallFn: contextualRecall, k: 20 });
  assert.equal(base.top_k_failure_rate, 1, "baseline misses every golden (failure=1.0)");
  assert.equal(ctx.top_k_failure_rate, 0, "contextual surfaces every golden (failure=0.0)");
  assert.ok(ctx.top_k_failure_rate < base.top_k_failure_rate, "metric registers the lift");
});

// =====================================================================
// 11. A/B driver emits all cells with a per-leg delta, and degrades (not
//     crashes) when the embed server is down. We run ONLY the bm25 leg (no
//     embed server needed) against a built contextual + baseline tree so the
//     delta is real; dense/fused cells would degrade in this hermetic env.
// =====================================================================

test("run-contextual-eval-ab emits per-leg cells + delta and degrades gracefully", () => {
  // The A/B runner resolves indices under its own default data root, NOT the
  // env-overridden tmp root — so a full live run is out of scope for a hermetic
  // test. We assert the runner PARSES, validates legs, and emits the config +
  // summary envelope shape (the contract the gate reads), degrading on a missing
  // goldset rather than crashing.
  const script = join(HERE, "..", "..", "scripts", "run-contextual-eval-ab.mjs");
  // A goldset that exists but is empty-of-rows (meta only) -> children run and
  // emit a result with n_total=0; the driver still emits all cells + summary.
  const goldset = join(MEMORY_ROOT, "ledgers", "ab-goldset.jsonl");
  writeFileSync(
    goldset,
    JSON.stringify({ kind: "contextual_eval_goldset_meta", baseline_miss_fraction_headroom: 0.5 }) +
      "\n",
  );
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [script, `--goldset=${goldset}`, "--legs=bm25", "--limit=1"],
      { env: { ...process.env }, encoding: "utf8" },
    );
  } catch (e) {
    // Child may exit non-zero only on a HARD failure; surface its stdout.
    out = (e.stdout || "").toString();
  }
  const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const config = lines.find((l) => l.kind === "contextual_eval_ab_config");
  const summary = lines.find((l) => l.kind === "contextual_eval_ab_summary");
  const cells = lines.filter((l) => l.kind === "contextual_eval_ab_cell");
  assert.ok(config, "emits a config envelope");
  assert.deepEqual(config.arms, ["baseline", "contextual"], "both arms in the matrix");
  assert.equal(cells.length, 2, "bm25 leg -> 2 cells (baseline + contextual)");
  assert.ok(summary, "emits a summary envelope");
  assert.ok(summary.per_leg && "bm25" in summary.per_leg, "per-leg summary present");
  assert.ok("delta" in summary.per_leg.bm25, "per-leg carries a delta field (null when incomparable)");
});
