// held-out-bootstrap.test.mjs — F-SYN-OPERATIONAL-held-out-labeled-set-v2 closure
// Tests the W14-closeout sampler + synthetic-bootstrap engineering surface.
// The sampler stratifies recall events; the bootstrap synthesizes v0 baseline
// labels marked is_synthetic:true / supersede_with_v1:true.

import { test } from "node:test";
import assert from "node:assert/strict";

const sampler = await import("../../scripts/sample-held-out-events.mjs");
const bootstrap = await import("../../scripts/bootstrap-synthetic-held-out-labels.mjs");

test("sampler VERSION + CAPS exported + frozen", () => {
  assert.equal(sampler.SAMPLER_VERSION, "v0.1.0");
  assert.ok(Object.isFrozen(sampler.SAMPLER_CAPS));
  assert.equal(sampler.SAMPLER_CAPS.DEFAULT_TARGET_SIZE, 150);
  assert.equal(sampler.SAMPLER_CAPS.TIME_OF_DAY_BUCKETS.length, 4);
  assert.equal(sampler.SAMPLER_CAPS.DENSITY_BUCKETS.length, 3);
});

test("bootstrap VERSION + CAPS exported + frozen", () => {
  assert.equal(bootstrap.BOOTSTRAP_VERSION, "v0.1.0");
  assert.ok(Object.isFrozen(bootstrap.BOOTSTRAP_CAPS));
  assert.equal(bootstrap.BOOTSTRAP_CAPS.TOP_K_EXPECTED, 3);
  assert.equal(bootstrap.BOOTSTRAP_CAPS.LABELER_NAME, "synthetic-v0-bootstrap");
});

test("stratifySample: empty input → empty output", () => {
  assert.deepEqual(sampler.stratifySample({ events: [], targetSize: 10 }), []);
  assert.deepEqual(sampler.stratifySample({ events: null, targetSize: 10 }), []);
});

test("stratifySample: stratifies by time-of-day across recall events", () => {
  const events = [
    { id: "r1", ts: "2026-06-20T03:00:00Z", candidates_pre_truncation: 5, query: { agent_role: "default" } },
    { id: "r2", ts: "2026-06-20T09:00:00Z", candidates_pre_truncation: 5, query: { agent_role: "default" } },
    { id: "r3", ts: "2026-06-20T15:00:00Z", candidates_pre_truncation: 5, query: { agent_role: "default" } },
    { id: "r4", ts: "2026-06-20T21:00:00Z", candidates_pre_truncation: 5, query: { agent_role: "default" } },
  ];
  const sample = sampler.stratifySample({ events, targetSize: 4 });
  const todBuckets = new Set(sample.map((s) => s.stratum.time_of_day));
  assert.ok(todBuckets.size >= 3, `expected 3+ distinct time-of-day buckets, got ${[...todBuckets]}`);
});

test("stratifySample: respects target_size cap", () => {
  const events = Array.from({ length: 200 }, (_, i) => ({
    id: `r${i}`,
    ts: "2026-06-20T12:00:00Z",
    candidates_pre_truncation: 5,
    query: { agent_role: "default" },
  }));
  const sample = sampler.stratifySample({ events, targetSize: 50 });
  assert.equal(sample.length, 50);
});

test("stratifySample: density bucketing uses quantiles", () => {
  const events = [
    { id: "r1", ts: "2026-06-20T12:00:00Z", candidates_pre_truncation: 1, query: {} },
    { id: "r2", ts: "2026-06-20T12:00:00Z", candidates_pre_truncation: 10, query: {} },
    { id: "r3", ts: "2026-06-20T12:00:00Z", candidates_pre_truncation: 50, query: {} },
  ];
  const sample = sampler.stratifySample({ events, targetSize: 3 });
  const denBuckets = new Set(sample.map((s) => s.stratum.density_bucket));
  assert.ok(denBuckets.size >= 2, `expected 2+ density buckets, got ${[...denBuckets]}`);
});

test("toLabelCandidate: produces operator-fillable shape", () => {
  const item = {
    event: {
      id: "r1",
      ts: "2026-06-20T12:00:00Z",
      query: { surrounding_context_hash: "abc123" },
      surfaced: [{ memory_id: "m1" }, { memory_id: "m2" }],
      candidates_pre_truncation: 5,
      density_flag: null,
    },
    stratum: { agent_role: "default", time_of_day: "afternoon", density_bucket: "medium" },
  };
  const cand = sampler.toLabelCandidate(item);
  assert.equal(cand.recall_id, "r1");
  assert.equal(cand.query_hash, "abc123");
  assert.equal(cand.surfaced.length, 2);
  assert.deepEqual(cand.expected_ids, []);
  assert.deepEqual(cand.forbidden_ids, []);
  assert.equal(cand.abstain, null);
  assert.equal(cand.sampler_version, "v0.1.0");
});

test("synthesizeLabel: builds held_out_label kind from candidate", () => {
  const cand = {
    recall_id: "r1",
    ts: "2026-06-20T12:00:00Z",
    surfaced: [
      { memory_id: "m1", position: 0 },
      { memory_id: "m2", position: 1 },
      { memory_id: "m3", position: 2 },
      { memory_id: "m4", position: 3 },
    ],
    density_flag: null,
    stratum: { agent_role: "default", time_of_day: "afternoon", density_bucket: "medium" },
  };
  const label = bootstrap.synthesizeLabel(cand);
  assert.equal(label.kind, "held_out_label");
  assert.deepEqual(label.derived_from, ["r1"]);
  assert.deepEqual(label.payload.expected_ids, ["m1", "m2", "m3"]);
  assert.deepEqual(label.payload.forbidden_ids, []);
  assert.equal(label.payload.abstain, false);
  assert.equal(label.metadata.is_synthetic, true);
  assert.equal(label.metadata.supersede_with_v1, true);
  assert.equal(label.metadata.labeler, "synthetic-v0-bootstrap");
});

test("synthesizeLabel: empty surfaced → abstain", () => {
  const label = bootstrap.synthesizeLabel({
    recall_id: "r2",
    surfaced: [],
    density_flag: null,
  });
  assert.equal(label.payload.abstain, true);
  assert.deepEqual(label.payload.expected_ids, []);
});

test("synthesizeLabel: density_flag abstain_emit → abstain", () => {
  const label = bootstrap.synthesizeLabel({
    recall_id: "r3",
    surfaced: [{ memory_id: "m1", position: 0 }],
    density_flag: "abstain_emit",
  });
  assert.equal(label.payload.abstain, true);
});

test("synthesizeLabel: deterministic id from recall_id (idempotent re-runs)", () => {
  const cand = { recall_id: "r-stable", surfaced: [], density_flag: null };
  const l1 = bootstrap.synthesizeLabel(cand);
  const l2 = bootstrap.synthesizeLabel(cand);
  assert.equal(l1.id, l2.id);
  assert.ok(l1.id.startsWith("holb_"));
});

test("synthesizeLabel: defensive on null/non-object input", () => {
  assert.equal(bootstrap.synthesizeLabel(null), null);
  assert.equal(bootstrap.synthesizeLabel(undefined), null);
  assert.equal(bootstrap.synthesizeLabel("not-an-object"), null);
});

test("synthesizeLabel: respects TOP_K_EXPECTED cap of 3", () => {
  const surfaced = Array.from({ length: 10 }, (_, i) => ({ memory_id: `m${i}`, position: i }));
  const label = bootstrap.synthesizeLabel({ recall_id: "r-many", surfaced, density_flag: null });
  assert.equal(label.payload.expected_ids.length, 3);
  assert.deepEqual(label.payload.expected_ids, ["m0", "m1", "m2"]);
});

test("end-to-end: stratify → toLabelCandidate → synthesizeLabel pipeline", () => {
  const events = [
    {
      id: "r-e2e",
      ts: "2026-06-20T15:00:00Z",
      query: { surrounding_context_hash: "h1", agent_role: "default" },
      surfaced: [{ memory_id: "m-Acmebot-SampleBot" }, { memory_id: "m-sam-sample-sample-tool" }],
      candidates_pre_truncation: 8,
      density_flag: null,
    },
  ];
  const sample = sampler.stratifySample({ events, targetSize: 1 });
  assert.equal(sample.length, 1);
  const cand = sampler.toLabelCandidate(sample[0]);
  const label = bootstrap.synthesizeLabel(cand);
  assert.equal(label.kind, "held_out_label");
  assert.deepEqual(label.derived_from, ["r-e2e"]);
  assert.ok(label.payload.expected_ids.includes("m-Acmebot-SampleBot"));
  assert.ok(label.payload.expected_ids.includes("m-sam-sample-sample-tool"));
  assert.equal(label.metadata.is_synthetic, true);
  assert.deepEqual(label.metadata.stratum, sample[0].stratum);
});
