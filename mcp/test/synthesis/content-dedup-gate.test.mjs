// content-dedup-gate.test.mjs — WU1 promote-time content-dedup gate.
//
// The embedding-free corroboration gate: when normalized content has already
// been promoted (per the persistent content-index), the cascade returns
// CORROBORATE instead of promoting a duplicate fact. This is the fix for the
// ~95%-duplicate ledger that accumulated while Gemini was down (the
// embed-novelty gate defaults to neutral/admit with null embeddings, so
// without this gate the cascade promotes every duplicate).
//
// Recovered after the WU1 DO agent died mid-response (API Error). The gate
// + content-index module + watermark wiring shipped; this test suite did not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic root BEFORE any dynamic import.
const TMP = mkdtempSync(join(tmpdir(), "content-dedup-gate-"));
const LEDGERS = join(TMP, "ledgers");
const STORAGE = join(TMP, "storage");
const POLICY = join(TMP, "policy");
for (const d of [LEDGERS, STORAGE, POLICY]) mkdirSync(d, { recursive: true });
process.env.MEMORY_ROOT = TMP;
process.env.LEDGERS_BASE_DIR = LEDGERS;
process.env.STORAGE_BASE_DIR = STORAGE;
process.env.POLICY_BASE_DIR = POLICY;
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const LEDGER = join(LEDGERS, "memory.jsonl");
const CACHE = join(STORAGE, "content-index.cache.json");

const ci = await import("../../lib/synthesis/content-index.js");

function writeLedger(rows) {
  writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}
function fact(id, content, created_at) {
  return { id, kind: "fact", content, source: "git-log", created_at, features: {} };
}

// ---------------------------------------------------------------------------
// content-index module
// ---------------------------------------------------------------------------

test("VERSION + frozen CAPS exported", () => {
  assert.equal(ci.CONTENT_INDEX_VERSION, "v1");
  assert.ok(Object.isFrozen(ci.CONTENT_INDEX_CAPS));
});

test("normalizeContent: trim + collapse whitespace + lowercase", () => {
  assert.equal(ci.normalizeContent("  Update  TO   HEAD  "), "update to head");
  assert.equal(ci.normalizeContent("Update\nto\tHEAD"), "update to head");
});

test("contentHash: identical normalized content -> identical hash; empty -> null", () => {
  assert.equal(ci.contentHash("Update  to  HEAD"), ci.contentHash("update to head"));
  assert.notEqual(ci.contentHash("a"), ci.contentHash("b"));
  assert.equal(ci.contentHash(""), null);
  assert.equal(ci.contentHash("   "), null);
});

test("rebuild: 5 identical-content facts -> hash maps to EARLIEST id", async () => {
  writeLedger([
    fact("mem_e", "mt76: update to the latest version", "2026-06-01T00:00:05Z"),
    fact("mem_a", "mt76: update to the latest version", "2026-06-01T00:00:01Z"),
    fact("mem_c", "mt76: update to the latest version", "2026-06-01T00:00:03Z"),
    fact("mem_distinct", "a genuinely different commit message", "2026-06-01T00:00:02Z"),
    fact("mem_b", "mt76: update to the latest version", "2026-06-01T00:00:02Z"),
  ]);
  const index = await ci.loadOrRebuildContentIndex({ ledgerPath: LEDGER, cachePath: CACHE });
  // Earliest in LEDGER ORDER is canonical (first-seen wins). mem_e appears first.
  const canonical = ci.lookupCanonical(index, "mt76: update to the latest version");
  assert.equal(canonical, "mem_e");
  // distinct content resolves to its own id.
  assert.equal(ci.lookupCanonical(index, "a genuinely different commit message"), "mem_distinct");
  // unseen content -> null (would PROMOTE).
  assert.equal(ci.lookupCanonical(index, "never seen before"), null);
  // empty content -> null (never dedups).
  assert.equal(ci.lookupCanonical(index, ""), null);
});

test("addToContentIndex: in-tick fold; earliest-wins no-op on repeat", () => {
  const index = { byContentHash: new Map() };
  ci.addToContentIndex(index, "mem_first", "shared content");
  ci.addToContentIndex(index, "mem_second", "shared content"); // no-op, earliest wins
  assert.equal(ci.lookupCanonical(index, "shared content"), "mem_first");
  ci.addToContentIndex(index, "mem_x", ""); // empty -> ignored
  assert.equal(index.byContentHash.size, 1);
});

// ---------------------------------------------------------------------------
// salience.js Layer-2.5 gate via scoreCandidate
// ---------------------------------------------------------------------------

const salience = await import("../../lib/ingest/salience.js");

function ctxWith(index, extra = {}) {
  // No embedder wired -> scoreCandidate skips Layer-3 (novelty=0.5) per its
  // contract; the content-dedup gate runs before that.
  return { contentIndex: index, ...extra };
}
function evt(content, source_msg_id, id) {
  return {
    source: "git-log",
    source_msg_id: source_msg_id || "git:repoX:" + (id || "sha1"),
    content,
    ts: "2026-06-21T00:00:00Z",
  };
}

test("gate: content already in index -> CORROBORATE (no new fact)", async () => {
  const index = { byContentHash: new Map() };
  ci.addToContentIndex(index, "mem_canonical", "update to latest Git HEAD");
  const out = await salience.scoreCandidate(
    evt("update to latest Git HEAD", "git:repoB:sha9"),
    ctxWith(index),
    {},
  );
  assert.equal(out.decision, "CORROBORATE");
  assert.equal(out.target_id, "mem_canonical");
  assert.equal(out.reason, "content_duplicate_no_embed");
});

test("gate: normalization parity -> whitespace/case variant still corroborates", async () => {
  const index = { byContentHash: new Map() };
  ci.addToContentIndex(index, "mem_canonical", "Update To Latest Git HEAD");
  const out = await salience.scoreCandidate(
    evt("update   to   latest   git   head", "git:repoB:sha9"),
    ctxWith(index),
    {},
  );
  assert.equal(out.decision, "CORROBORATE");
  assert.equal(out.target_id, "mem_canonical");
});

test("gate: novel content -> NOT corroborated (proceeds to promote path)", async () => {
  const index = { byContentHash: new Map() };
  ci.addToContentIndex(index, "mem_canonical", "some other content");
  const out = await salience.scoreCandidate(
    evt("a brand new unique commit message nobody has seen", "git:repoB:sha9"),
    ctxWith(index),
    {},
  );
  assert.notEqual(out.decision, "CORROBORATE");
});

test("gate: never collapses a row onto ITSELF (self-collision guard)", async () => {
  const index = { byContentHash: new Map() };
  ci.addToContentIndex(index, "git:repoA:sha1", "self content");
  // event whose own source_msg_id equals the canonical id
  const out = await salience.scoreCandidate(
    { source: "git-log", source_msg_id: "git:repoA:sha1", content: "self content", ts: "2026-06-21T00:00:00Z" },
    ctxWith(index),
    {},
  );
  assert.notEqual(out.decision, "CORROBORATE");
});

test("gate: empty content never corroborates", async () => {
  const index = { byContentHash: new Map() };
  // index has a real entry, but the candidate content is empty.
  ci.addToContentIndex(index, "mem_x", "non-empty");
  const out = await salience.scoreCandidate(evt("", "git:repoB:sha9"), ctxWith(index), {});
  assert.notEqual(out.decision, "CORROBORATE");
});

test("gate: absent contentIndex (legacy/hermetic) -> behaves as today, no crash", async () => {
  const out = await salience.scoreCandidate(
    evt("update to latest Git HEAD", "git:repoB:sha9"),
    {}, // no contentIndex
    {},
  );
  assert.notEqual(out.decision, "CORROBORATE");
  assert.ok(typeof out.decision === "string");
});

test("gate: malformed index -> lookup throws -> DEGRADES to promote (never blocks)", async () => {
  // contentIndex present but byContentHash is not a Map -> lookupCanonical throws.
  const out = await salience.scoreCandidate(
    evt("update to latest Git HEAD", "git:repoB:sha9"),
    { contentIndex: { byContentHash: "not-a-map" } },
    {},
  );
  // Gate swallows the throw and continues; decision is NOT CORROBORATE, no exception.
  assert.notEqual(out.decision, "CORROBORATE");
});
