// cascade-verdict-shapes.test.mjs — node s8-cascade-verdict-shapes.
//
// Pins the VERDICT SEMANTICS of mcp/scripts/verify-cascade-correctness.mjs.
//
// Two prior waves keyed the verdict on a present/absent binary and failed in
// opposite directions: one reported a corrupt corpus healthy, the other
// reported a healthy corpus corrupt. This suite pins the third position: the
// scored population is scoped by row `kind`, ABSENCE IS NEVER CORRUPTION, and
// any corrupt fact row forces FAIL no matter what else is in the corpus.
//
// Every fixture shape below was measured on the live ledger by this node's
// own read-only census (2026-08-11T22:06:03Z, memory.jsonl 3,068,082,670 B,
// 1,519,012 lines / 1,519,012 parsed / 0 skipped). Live non-smoke composition
// measured (108,899 non-smoke rows):
//   kinds        fact 106,016 | reconstructed 1,832 | policy 1,051
//   policy_kind  embedding_backfill 701 | salience.recall_feedback 267
//                | feature_backfill 83
//   fact shapes  features.embedding_4096 array[4096] 12,120 (all finite,
//                all unit-norm) | features.embedding_mrl_768 array[768] 3
//                (unit-norm) | null-marker sub-shape A 43,311 (explicit
//                embedding_4096 null) | null-marker sub-shape B 50,582
//                (embedding_4096 key absent, embedding_3072 null) — and
//                `embedding_mrl_768`, `features.embedding`, `embedding`
//                absent on all 106,016. The four buckets partition the
//                population exactly: 12,120 + 3 + 43,311 + 50,582 = 106,016,
//                i.e. ZERO malformed fact rows live.
//
// NOTE on the two absent buckets: BOTH live sub-shapes carry an explicit
// `null` under some probed key, so both are F-NULL-MARKER. F-KEY-MISSING is
// the row that carries no probed embedding key at all (zero live occurrences,
// but it is the shape scripts-stringcap's unembeddedProdRow uses). Both class
// ABSENT, and neither classification depends on WHICH key carries the null.
//   envelopes    policy/embedding_backfill `embedding`
//                {vector_3072 array[3072] unit, vector_mrl_768 null} x700
//                and {..., vector_mrl_768 array[768] unit} x1.
//
// HERMETIC BY CONSTRUCTION: every spawn passes --ledger=<tmp fixture>. This
// suite never reads, stats or names the production ledger, so it is green
// regardless of daemon activity and needs no _hermetic-daemon-skip.mjs.
//
// NOT REGISTERED in run-all-tests.mjs / package.json by design — node g1 owns
// test registration. Run directly:
//   cd mcp && node --test test/cascade-verdict-shapes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  openSync,
  writeSync,
  ftruncateSync,
  closeSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as bufferConstants } from "node:buffer";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-cascade-verdict-"));
const SCRIPT = fileURLToPath(new URL("../scripts/verify-cascade-correctness.mjs", import.meta.url));
const NODE_BIN = process.execPath;

// Apparent size for the over-cap fixture. Technique copied (not imported, not
// edited) from makeOverCapLedger in mcp/test/scripts-stringcap.test.mjs.
const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;
const APPARENT_BYTES = 600_000_000;

// ---------------------------------------------------------------------------
// Vector builders.
// ---------------------------------------------------------------------------

// Unit-norm vector of n dims: every element 1/sqrt(n) => ||v|| == 1.
function unitVec(n) {
  return new Array(n).fill(1 / Math.sqrt(n));
}
// Norm 2.0 — finite, right length, wrong magnitude.
function badNormVec(n) {
  return new Array(n).fill(2 / Math.sqrt(n));
}
// Norm 0.0 — finite, right length, degenerate.
function zeroVec(n) {
  return new Array(n).fill(0);
}
// A vector with a torn element. NOTE: JSON.stringify serializes NaN as `null`,
// so the element this fixture lands on disk with is literal `null` inside the
// array — which is exactly the torn shape a finite-check must reject.
function nonFiniteVec(n) {
  const v = unitVec(n);
  v[5] = NaN;
  return v;
}

// ---------------------------------------------------------------------------
// Row builders — one per measured live shape, plus the named-but-unmeasured
// shapes the partition must still refuse to absorb.
// ---------------------------------------------------------------------------
const POST_WIPE = "2026-06-04T00:00:00Z"; // after WIPE_THRESHOLD 2026-06-03T03:57:00Z

function baseFact(id, features) {
  const r = {
    id,
    kind: "fact",
    content: `production fact ${id}`,
    source_refs: [],
    derived_from: [],
    provenance: { agent_id: "test", conversation_id: `conv_${id}` },
    created_at: POST_WIPE,
  };
  if (features !== undefined) r.features = features;
  return r;
}

// MEASURED 50,582: embedding_4096 key entirely absent, embedding_3072 null.
const factNullVia3072 = (id) =>
  baseFact(id, { embed_state: true, embedding_3072: null, embedding_mrl_768: null });
// MEASURED 43,309: explicit embedding_4096 null.
const factNullMarker = (id) =>
  baseFact(id, {
    embed_state: true,
    embedding_4096: null,
    embedding_3072: null,
    embedding_mrl_768: null,
  });
// MEASURED 12,112: valid inline 4096 — the population the old four-key probe
// could not see.
const factValid4096 = (id) => baseFact(id, { embed_state: true, embedding_4096: unitVec(4096) });
// MEASURED 3: valid inline 768 (one of the three also lacks embed_state).
const factValid768 = (id) => baseFact(id, { embedding_mrl_768: unitVec(768) });
// No `features` key at all — the shape scripts-stringcap's unembeddedProdRow uses.
const factNoFeatures = (id) => baseFact(id, undefined);

// Corrupt shapes (zero live occurrences; the partition must name them anyway).
const factNonFinite768 = (id) => baseFact(id, { embedding_mrl_768: nonFiniteVec(768) });
const factNonFinite4096 = (id) => baseFact(id, { embedding_4096: nonFiniteVec(4096) });
const factZeroVec768 = (id) => baseFact(id, { embedding_mrl_768: zeroVec(768) });
const factBadNorm768 = (id) => baseFact(id, { embedding_mrl_768: badNormVec(768) });
const factWrongLen = (id) => baseFact(id, { embedding_4096: unitVec(512) });
const factNotArray = (id) => ({ ...baseFact(id, { embed_state: true }), embedding: 0 });
const factEnvelopeOnFact = (id) =>
  baseFact(id, { embedding: { vector_3072: unitVec(3072), vector_mrl_768: null } });
const factUnknownShape = (id) => baseFact(id, { embedding_4096: { packed: "base64", dims: 4096 } });

// MEASURED policy envelopes. Per mcp/docs/specs/ccs/cascade-embedding-decoupling.md
// §5 the envelope's vector belongs to `target_fact_id` — a DIFFERENT row — so
// these must never be scored as themselves.
const policyEnvelope = (id) => ({
  id,
  kind: "policy",
  policy_kind: "embedding_backfill",
  target_fact_id: `mem_target_${id}`,
  embedding: { vector_3072: unitVec(3072), vector_mrl_768: null },
  created_at: POST_WIPE,
});
const policyEnvelopeWithMrl = (id) => ({
  ...policyEnvelope(id),
  embedding: { vector_3072: unitVec(3072), vector_mrl_768: unitVec(768) },
});
const policySalience = (id) => ({
  id,
  kind: "policy",
  policy_kind: "salience.recall_feedback",
  created_at: POST_WIPE,
});
const policyFeatureBackfill = (id) => ({
  id,
  kind: "policy",
  policy_kind: "feature_backfill",
  created_at: POST_WIPE,
});
const reconstructedRow = (id) => ({
  id,
  kind: "reconstructed",
  content: `reconstructed ${id}`,
  created_at: POST_WIPE,
});
const unknownKindRow = (id, kind) => ({ id, kind, content: `row ${id}`, created_at: POST_WIPE });

// Smoke rows — one per isSmoke path.
const smokeMarker = (id) => ({
  id,
  kind: "fact",
  content: `seed ${id}`,
  provenance: { is_seed_row: true, conversation_id: `conv_${id}` },
  created_at: POST_WIPE,
});
const smokeConvId = (id) => ({
  id,
  kind: "fact",
  content: `seed ${id}`,
  provenance: { conversation_id: "conv_smoke" },
  created_at: POST_WIPE,
});
const smokeContent = (id) => ({
  id,
  kind: "fact",
  content: "USER: hi\nASSISTANT: hello",
  provenance: { conversation_id: `conv_${id}` },
  created_at: POST_WIPE,
});
const smokePreWipe = (id) => ({
  id,
  kind: "fact",
  content: `old ${id}`,
  provenance: { conversation_id: `conv_${id}` },
  created_at: "2026-01-01T00:00:00Z",
});
const ALL_SMOKE_PATHS = [
  smokeMarker("mem_smoke_a"),
  smokeConvId("mem_smoke_b"),
  smokeContent("mem_smoke_c"),
  smokePreWipe("mem_smoke_d"),
];

// ---------------------------------------------------------------------------
// Fixture + runner helpers.
// ---------------------------------------------------------------------------
function writeLedger(name, rows) {
  const p = join(TMP_ROOT, name);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return p;
}

// Sparse over-cap ledger: apparent size above Node's max-string cap, real disk
// cost a few KiB. Technique copied from makeOverCapLedger in
// mcp/test/scripts-stringcap.test.mjs (that file is owned by node s7 and is
// neither imported nor edited here).
function writeOverCapLedger(name, headRows, tailRows) {
  const p = join(TMP_ROOT, name);
  const fd = openSync(p, "w");
  writeSync(fd, headRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  ftruncateSync(fd, APPARENT_BYTES);
  writeSync(fd, "\n" + tailRows.map((r) => JSON.stringify(r)).join("\n") + "\n", APPARENT_BYTES);
  closeSync(fd);
  return p;
}

function runVerify(ledgerPath, extraArgs = []) {
  const res = spawnSync(NODE_BIN, [SCRIPT, `--ledger=${ledgerPath}`, ...extraArgs], {
    encoding: "utf8",
  });
  let summary = null;
  try {
    summary = JSON.parse(res.stdout);
  } catch {
    // leave null; assertions report stdout/stderr
  }
  return { code: res.status, summary, stderr: res.stderr, stdout: res.stdout };
}

// The measured live composition, scaled down. 108 fact rows (15 valid inline,
// 93 absent, 0 corrupt) + 11 non-fact rows = 119 non-smoke rows, which is
// above the default SAMPLE_SIZE of 100 so the reservoir genuinely subsamples
// and the verdict is proven independent of it.
function liveShapeRows() {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(factNullVia3072(`mem_miss_${i}`));
  for (let i = 0; i < 43; i++) rows.push(factNullMarker(`mem_null_${i}`));
  for (let i = 0; i < 12; i++) rows.push(factValid4096(`mem_v4096_${i}`));
  for (let i = 0; i < 3; i++) rows.push(factValid768(`mem_v768_${i}`));
  for (let i = 0; i < 7; i++) rows.push(policyEnvelope(`mem_env_${i}`));
  rows.push(policyEnvelopeWithMrl("mem_env_mrl"));
  for (let i = 0; i < 2; i++) rows.push(policySalience(`mem_sal_${i}`));
  rows.push(policyFeatureBackfill("mem_fb_0"));
  for (let i = 0; i < 2; i++) rows.push(reconstructedRow(`mem_rec_${i}`));
  rows.push(...ALL_SMOKE_PATHS);
  return rows;
}

// ---------------------------------------------------------------------------
// R1 — the live-shape replica is PARTIAL coverage, NOT a failure.
// ---------------------------------------------------------------------------
test("R1 live-shape replica => PARTIAL_INLINE_COVERAGE / exit 0", () => {
  const p = writeLedger("r1-live-shape.jsonl", liveShapeRows());
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stdout was empty. stderr=${stderr}`);
  assert.equal(
    summary.verdict,
    "PARTIAL_INLINE_COVERAGE",
    `absence is not corruption; got ${summary.verdict}`
  );
  assert.equal(code, 0, "partial inline coverage is a healthy sidecar shape, exit 0");

  // Census counts, not sample counts. 108 fact + 11 policy + 2 reconstructed.
  assert.equal(summary.production_rows, 121, "non-smoke rows");
  assert.equal(summary.smoke_rows, 4, "all four isSmoke paths filtered");
  assert.equal(summary.total_rows, 125);
  assert.equal(summary.fact_rows, 108);
  assert.equal(summary.with_embedding, 15, "12 valid 4096 + 3 valid 768");
  assert.equal(summary.without_embedding, 93, "both null-marker sub-shapes, 50 + 43");
  assert.equal(summary.corrupt_fact_rows, 0);
  assert.equal(summary.bad_norm, 0);

  // Both live absent sub-shapes carry an explicit null under a probed key.
  assert.equal(summary.fact_bucket_census["F-NULL-MARKER"], 93);
  assert.equal(summary.fact_bucket_census["F-VALID-4096"], 12);
  assert.equal(summary.fact_bucket_census["F-VALID-768"], 3);

  // Non-fact rows are reported, never scored.
  assert.equal(summary.not_applicable.total, 13);
  assert.equal(summary.not_applicable.reconstructed, 2);
  assert.equal(summary.not_applicable.policy, 11);
  assert.equal(summary.not_applicable.policy_by_kind.embedding_backfill, 8);
  assert.equal(summary.not_applicable.policy_by_kind["salience.recall_feedback"], 2);
  assert.equal(summary.not_applicable.policy_by_kind.feature_backfill, 1);

  // The 15 valid + 93 absent must add up to every fact row: no fall-through.
  const bucketTotal = Object.values(summary.fact_bucket_census).reduce((a, b) => a + b, 0);
  assert.equal(bucketTotal, summary.fact_rows, "bucket partition must be exhaustive");
});

// ---------------------------------------------------------------------------
// R2 — the 12,112-row blindness. All fact rows carry a valid 4096 vector.
// ---------------------------------------------------------------------------
test("R2 all fact rows valid features.embedding_4096 => PASS / exit 0", () => {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(factValid4096(`mem_v_${i}`));
  const p = writeLedger("r2-all-4096.jsonl", rows);
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(summary.verdict, "PASS", "a fully-4096 corpus is healthy");
  assert.equal(code, 0);
  assert.equal(summary.with_embedding, 25, "the probe must SEE features.embedding_4096");
  assert.equal(summary.without_embedding, 0);
  assert.equal(summary.fact_bucket_census["F-VALID-4096"], 25);
});

// ---------------------------------------------------------------------------
// R3 — the 701 policy envelopes alone neither pass nor fail.
// ---------------------------------------------------------------------------
test("R3 policy-envelope-only corpus => NO_FACT_ROWS / exit 0", () => {
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push(policyEnvelope(`mem_env_${i}`));
  rows.push(policyEnvelopeWithMrl("mem_env_mrl"));
  rows.push(...ALL_SMOKE_PATHS);
  const p = writeLedger("r3-envelope-only.jsonl", rows);
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(summary.verdict, "NO_FACT_ROWS", "vacuous, not PASS and not FAIL");
  assert.equal(code, 0);
  assert.equal(summary.fact_rows, 0);
  assert.equal(summary.production_rows, 8);
  assert.equal(summary.not_applicable.policy, 8);
  assert.equal(summary.with_embedding, 0);
  assert.equal(summary.without_embedding, 0);
  assert.ok(typeof summary.note === "string" && summary.note.length > 0, "loud note required");
});

// ---------------------------------------------------------------------------
// R4 — determinism. 405 non-smoke rows so the reservoir really subsamples.
// ---------------------------------------------------------------------------
// The valid rows are deliberately SPLIT across dimensions: the 2 valid-768
// rows are visible to the old four-key probe, so the pre-fix reservoir really
// did return a varying with_embedding here (measured multiset recorded in the
// node's Evidence). Post-fix the census counts all 5, every run.
test("R4 determinism: 20 spawns on one fixture agree exactly", () => {
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push(factNullVia3072(`mem_abs_${i}`));
  for (let i = 0; i < 3; i++) rows.push(factValid4096(`mem_val4096_${i}`));
  for (let i = 0; i < 2; i++) rows.push(factValid768(`mem_val768_${i}`));
  const p = writeLedger("r4-determinism.jsonl", rows);

  const seen = new Set();
  for (let run = 0; run < 20; run++) {
    const { code, summary, stderr } = runVerify(p);
    assert.ok(summary, `run ${run}: parseable JSON; stderr=${stderr}`);
    seen.add(`${summary.verdict}|${code}|${summary.with_embedding}|${summary.without_embedding}`);
  }
  assert.equal(
    seen.size,
    1,
    `verdict/exit/with_embedding must be identical across 20 runs; saw ${[...seen].join(" , ")}`
  );
  assert.deepEqual([...seen], ["PARTIAL_INLINE_COVERAGE|0|5|400"]);
});

// ---------------------------------------------------------------------------
// R5 — a kind outside the censused set is NAMED, never silently absorbed.
// ---------------------------------------------------------------------------
test("R5 unknown kind => UNKNOWN_ROW_KINDS / exit 1, naming the kind", () => {
  const rows = [
    factValid4096("mem_v_0"),
    factNullVia3072("mem_a_0"),
    unknownKindRow("mem_x_0", "episode"),
    unknownKindRow("mem_x_1", "episode"),
    unknownKindRow("mem_y_0", "summary"),
  ];
  const p = writeLedger("r5-unknown-kind.jsonl", rows);
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(summary.verdict, "UNKNOWN_ROW_KINDS");
  assert.equal(code, 1);
  assert.equal(summary.unknown_kinds.episode, 2, "the new kind and its count must be named");
  assert.equal(summary.unknown_kinds.summary, 1);
  assert.ok(
    String(summary.note).includes("episode"),
    "the note must name the uncensused kind, not just count it"
  );
});

// An unknown kind must never MASK corruption. Both verdicts exit 1; the
// corrupt count and the offending kind are both reported either way.
test("unknown kind + corrupt fact row: exit 1, and corruption is still reported", () => {
  const p = writeLedger("unknown-plus-corrupt.jsonl", [
    factValid4096("mem_v_0"),
    factNonFinite768("mem_torn_0"),
    unknownKindRow("mem_x_0", "episode"),
  ]);
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(code, 1, "either way this corpus must not exit 0");
  assert.equal(summary.corrupt_fact_rows, 1, "corruption must remain visible");
  assert.equal(summary.fact_bucket_census["F-NONFINITE-768"], 1);
  assert.equal(summary.unknown_kinds.episode, 1, "the unknown kind must remain visible");
  assert.ok(
    String(summary.note).includes("MALFORMED"),
    `the note must surface the malformed rows too; note=${summary.note}`
  );
});

// ---------------------------------------------------------------------------
// R6 (GUARD, not a red) — corruption is not masked by the policy population.
// ---------------------------------------------------------------------------
test("R6 guard: live replica + ONE non-finite fact row => FAIL / exit 1", () => {
  const rows = liveShapeRows();
  rows.push(factNonFinite768("mem_torn_0"));
  const p = writeLedger("r6-live-plus-corrupt.jsonl", rows);
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(summary.verdict, "FAIL", "one corrupt fact row must sink the whole corpus");
  assert.equal(code, 1);
  assert.equal(summary.corrupt_fact_rows, 1);
  assert.equal(summary.fact_bucket_census["F-NONFINITE-768"], 1);
  // The healthy remainder is still reported honestly.
  assert.equal(summary.with_embedding, 15);
  assert.equal(summary.without_embedding, 93);
});

// ---------------------------------------------------------------------------
// The wave-1 false PASS: an all-corrupt corpus must never be healthy.
// ---------------------------------------------------------------------------
test("all fact rows non-finite => FAIL / exit 1 (kills the wave-1 false PASS)", () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(factNonFinite4096(`mem_torn4096_${i}`));
  for (let i = 0; i < 10; i++) rows.push(factNonFinite768(`mem_torn768_${i}`));
  const p = writeLedger("all-nonfinite.jsonl", rows);
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(summary.verdict, "FAIL");
  assert.equal(code, 1);
  assert.equal(summary.corrupt_fact_rows, 20);
  assert.equal(summary.fact_bucket_census["F-NONFINITE-4096"], 10);
  assert.equal(summary.fact_bucket_census["F-NONFINITE-768"], 10);
  assert.equal(summary.with_embedding, 0);
  assert.ok(summary.failed_ids_first_10.length > 0, "corrupt ids must be surfaced");
});

// ---------------------------------------------------------------------------
// The wave-2 false FAIL: an all-absent corpus is the healthy sidecar shape.
// ---------------------------------------------------------------------------
test("all fact rows absent => NO_INLINE_EMBEDDINGS / exit 0", () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(factNullVia3072(`mem_km_${i}`));
  for (let i = 0; i < 10; i++) rows.push(factNullMarker(`mem_nm_${i}`));
  for (let i = 0; i < 5; i++) rows.push(factNoFeatures(`mem_nf_${i}`));
  const p = writeLedger("all-absent.jsonl", rows);
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(summary.verdict, "NO_INLINE_EMBEDDINGS", "absence is not corruption");
  assert.equal(code, 0);
  assert.equal(summary.without_embedding, 25);
  assert.equal(summary.corrupt_fact_rows, 0);
  assert.equal(summary.fact_bucket_census["F-NULL-MARKER"], 20, "both live null sub-shapes");
  assert.equal(summary.fact_bucket_census["F-KEY-MISSING"], 5, "no probed key at all");
});

// ---------------------------------------------------------------------------
// The null marker is read exactly as recall reads it at dispatch. Neither
// absent bucket may depend on WHICH key carries the null.
// ---------------------------------------------------------------------------
test("both null-marker sub-shapes and the key-missing shape all class ABSENT", () => {
  const cases = [
    ["explicit embedding_4096: null (live 43,309)", factNullMarker("mem_a"), "F-NULL-MARKER"],
    ["embedding_4096 absent + embedding_3072: null (live 50,582)", factNullVia3072("mem_b"), "F-NULL-MARKER"],
    ["no probed embedding key at all", factNoFeatures("mem_c"), "F-KEY-MISSING"],
    // null under a key OTHER than the two the dispatch gate names.
    ["only features.embedding_mrl_768: null", baseFact("mem_d", { embedding_mrl_768: null }), "F-NULL-MARKER"],
    // features present but with no embedding key whatsoever.
    ["features without any embedding key", baseFact("mem_e", { embed_state: true }), "F-KEY-MISSING"],
  ];

  for (const [label, row, expectedBucket] of cases) {
    const p = writeLedger(`absent-${row.id}.jsonl`, [row]);
    const { code, summary, stderr } = runVerify(p);
    assert.ok(summary, `${label}: parseable JSON; stderr=${stderr}`);
    assert.equal(summary.verdict, "NO_INLINE_EMBEDDINGS", `${label} must be ABSENT, not corrupt`);
    assert.equal(code, 0, `${label} must not fail`);
    assert.equal(summary.corrupt_fact_rows, 0, `${label} must not be corrupt`);
    assert.equal(summary.without_embedding, 1, `${label} counts as absent`);
    assert.equal(summary.fact_bucket_census[expectedBucket], 1, `${label} => ${expectedBucket}`);
  }
});

// ---------------------------------------------------------------------------
// Named-but-unmeasured shapes: no default fall-through anywhere.
// ---------------------------------------------------------------------------
test("every corrupt shape lands in its own NAMED bucket, none absorbed by default", () => {
  const rows = [
    factWrongLen("mem_wl_0"),
    factNotArray("mem_na_0"),
    factEnvelopeOnFact("mem_env_on_fact_0"),
    factUnknownShape("mem_unk_0"),
    factBadNorm768("mem_bn_0"),
    factZeroVec768("mem_zero_0"),
  ];
  const p = writeLedger("named-buckets.jsonl", rows);
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(summary.verdict, "FAIL");
  assert.equal(code, 1);
  assert.equal(summary.fact_rows, 6);
  assert.equal(summary.corrupt_fact_rows, 6);

  const b = summary.fact_bucket_census;
  assert.equal(b["F-WRONGLEN:features.embedding_4096:512"], 1, "wrong length names key and length");
  assert.equal(b["F-NOTARRAY:embedding:number"], 1, "non-array names key and type");
  assert.equal(b["F-ENVELOPE-ON-FACT"], 1, "a policy envelope on a fact row is corrupt");
  assert.equal(b["F-BADNORM-768"], 2, "norm 2.0 and norm 0.0 are both bad norms");
  assert.ok(
    Object.keys(b).some((k) => k.startsWith("F-UNKNOWN-SHAPE")),
    `terminal bucket must catch the unnamed shape; buckets=${Object.keys(b).join(",")}`
  );
  const bucketTotal = Object.values(b).reduce((a, x) => a + x, 0);
  assert.equal(bucketTotal, 6, "exhaustive partition, no double count and no drop");
});

// ---------------------------------------------------------------------------
// --lenient flag contract (kb/api-key-pool.md): norm check skipped, length and
// finiteness still enforced.
// ---------------------------------------------------------------------------
test("--lenient: bad-norm fact row is NOT a failure", () => {
  const p = writeLedger("lenient-badnorm.jsonl", [factBadNorm768("mem_bn_0"), factValid768("mem_v_0")]);

  const strict = runVerify(p);
  assert.equal(strict.summary.verdict, "FAIL", "strict is the default and catches the bad norm");
  assert.equal(strict.code, 1);

  const lenient = runVerify(p, ["--lenient"]);
  assert.ok(lenient.summary, `parseable JSON; stderr=${lenient.stderr}`);
  assert.notEqual(lenient.summary.verdict, "FAIL", "lenient skips the norm check");
  assert.equal(lenient.code, 0);
  assert.equal(lenient.summary.corrupt_fact_rows, 0);
  assert.equal(lenient.summary.with_embedding, 2);
  assert.equal(lenient.summary.bad_norm, null, "bad_norm stays null under --lenient");
});

test("--lenient: wrong-length fact row is STILL a failure", () => {
  const p = writeLedger("lenient-wronglen.jsonl", [factWrongLen("mem_wl_0")]);
  const { code, summary, stderr } = runVerify(p, ["--lenient"]);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(summary.verdict, "FAIL", "length is the minimum shape contract in both modes");
  assert.equal(code, 1);
  assert.equal(summary.fact_bucket_census["F-WRONGLEN:features.embedding_4096:512"], 1);
});

test("--lenient: non-finite fact row is STILL a failure", () => {
  const p = writeLedger("lenient-nonfinite.jsonl", [factNonFinite768("mem_torn_0")]);
  const { code, summary } = runVerify(p, ["--lenient"]);

  assert.ok(summary);
  assert.equal(summary.verdict, "FAIL", "finiteness is enforced in both modes");
  assert.equal(code, 1);
  assert.equal(summary.fact_bucket_census["F-NONFINITE-768"], 1);
});

// ---------------------------------------------------------------------------
// T3c collision, pinned in the file this node owns. scripts-stringcap's T3c
// composition (2 fact rows with a valid unit-768 vector + 1 fact row with no
// `features` key) is 2x F-VALID-768 + 1x F-KEY-MISSING, zero corrupt — which
// under this ladder is PARTIAL_INLINE_COVERAGE / exit 0, superseding T3c's
// FAIL / exit 1. That file is owned by node s7 and is NOT edited here.
// ---------------------------------------------------------------------------
test("T3c composition (2 valid-768 + 1 no-features) => PARTIAL_INLINE_COVERAGE / exit 0", () => {
  const p = writeLedger("t3c-composition.jsonl", [
    factValid768("mem_ok_1"),
    factNoFeatures("mem_bad_1"),
    factValid768("mem_ok_2"),
  ]);
  const { code, summary, stderr } = runVerify(p);

  assert.ok(summary, `parseable JSON; stderr=${stderr}`);
  assert.equal(
    summary.verdict,
    "PARTIAL_INLINE_COVERAGE",
    "mixed inline coverage with zero corruption is NOT a failure"
  );
  assert.equal(code, 0);
  assert.equal(summary.with_embedding, 2);
  assert.equal(summary.without_embedding, 1);
  assert.equal(summary.corrupt_fact_rows, 0);
});

// ---------------------------------------------------------------------------
// Preserved behaviours: NO_PRODUCTION_ROWS, exit 2, over-cap streaming.
// ---------------------------------------------------------------------------
test("smoke-only corpus => NO_PRODUCTION_ROWS / exit 0 (unchanged)", () => {
  const p = writeLedger("smoke-only.jsonl", ALL_SMOKE_PATHS);
  const { code, summary } = runVerify(p);

  assert.ok(summary);
  assert.equal(summary.verdict, "NO_PRODUCTION_ROWS");
  assert.equal(code, 0);
  assert.equal(summary.production_rows, 0);
  assert.equal(summary.smoke_rows, 4);
});

test("missing ledger => exit 2 (unchanged)", () => {
  const { code } = runVerify(join(TMP_ROOT, "does-not-exist.jsonl"));
  assert.equal(code, 2);
});

test("over-cap ledger: census still streams and emits parseable JSON", () => {
  const p = writeOverCapLedger(
    "overcap.jsonl",
    [factValid4096("mem_head"), factNullVia3072("mem_head_abs")],
    [factValid768("mem_tail")]
  );

  const st = statSync(p);
  assert.ok(
    st.size > MAX_STRING_LENGTH,
    `fixture apparent size ${st.size} must exceed MAX_STRING_LENGTH ${MAX_STRING_LENGTH}`
  );
  assert.ok(st.blocks <= 128, `fixture must be sparse: got ${st.blocks} 512B-blocks`);

  const { code, summary, stderr } = runVerify(p);
  assert.ok(summary, `over-cap census must still emit JSON; stderr=${stderr}`);
  assert.equal(summary.verdict, "PARTIAL_INLINE_COVERAGE");
  assert.equal(code, 0);
  assert.equal(summary.fact_rows, 3);
  assert.equal(summary.with_embedding, 2);
  assert.equal(summary.without_embedding, 1);
});

// ---------------------------------------------------------------------------
// The verdict must not depend on --sample: it is a full-corpus census.
// ---------------------------------------------------------------------------
test("verdict is invariant under --sample (census, not sample)", () => {
  const p = writeLedger("sample-invariance.jsonl", liveShapeRows());
  const big = runVerify(p);
  const tiny = runVerify(p, ["--sample=1"]);

  assert.equal(tiny.summary.verdict, big.summary.verdict);
  assert.equal(tiny.summary.with_embedding, big.summary.with_embedding);
  assert.equal(tiny.summary.without_embedding, big.summary.without_embedding);
  assert.equal(tiny.summary.sampled, 1, "the reservoir still honours --sample");
  assert.equal(big.summary.sampled, 100, "default SAMPLE_SIZE is 100");
});
