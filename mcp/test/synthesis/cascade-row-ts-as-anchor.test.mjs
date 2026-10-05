// F-CCS-CASCADE-row-ts-as-anchor — integration test.
//
// Verifies that the cascade's PROMOTE chokepoint (appendFactRow inside
// mcp/lib/tools/distill-promote-fact.js) stamps the row's promote-time
// timestamp as a structural absolute anchor at features.time_anchors[0]
// on every promoted fact. Closes the gap where text-extracted anchors are
// empty for technical content and features.episodicity is uniformly stuck
// at the 0.11-0.13 floor.
//
// Invariants under test:
//   I1 — features.time_anchors[0].instant_iso === promotedAt (or event.ts)
//   I2 — features.time_anchors[0].kind === "absolute"
//   I3 — features.time_anchors[0].structural === true
//   I3a — features.time_anchors[0].raw_phrase === null
//   I3b — features.time_anchors[0].stamped_by === "cascade:row-ts"
//   I4 — defensive on missing ts (no crash; row still promotes)
//   I5 — millisecond-precision ts in the git-log.jsonl form propagates
//   I6 — episodicity-scorer reads the stamped anchor (downstream consumer)
//
// Hermetic discipline (matches cascade-stamps-entities/episodicity tests):
//   - env-before-dynamic-import (env vars set BEFORE first import)
//   - all writes under TMP_ROOT
//   - drives promoteSourceRow directly (non-MCP entry, no daemon-token)
//   - ≥12 assertions across separately named tests
//
// Run: node --test test/synthesis/cascade-row-ts-as-anchor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js so the
// ledger / policy paths land under TMP_ROOT.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ccs-row-ts-anchor-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");

for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
  join(process.env.LEDGERS_BASE_DIR),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const promoteFactMod = await import(
  "../../lib/tools/distill-promote-fact.js"
);
const episodicityMod = await import(
  "../../lib/synthesis/episodicity-scorer.js"
);

const LEDGER_PATH = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");

function memoryLedgerLines() {
  if (!existsSync(LEDGER_PATH)) return [];
  const text = readFileSync(LEDGER_PATH, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// Synthetic salience PROMOTE result. Only the fields appendFactRow /
// promoteSourceRow consume are populated. embedding_mrl_768 is null because
// we do not exercise HNSW push for this test — the time-anchor stamp runs
// inside appendFactRow and is independent of embedding state.
function fakePromote(extra = {}) {
  return {
    decision: "PROMOTE",
    score: 0.42,
    components: {
      recency: 0.5,
      authorship: 1.0,
      content_mass: 0.5,
      source_prior: 0.6,
      structural: 0.5,
      novelty: 1.0,
      last_retrieved_ts: 0,
      use_count: 0,
    },
    weights_hash: "test-weights-hash",
    version: "v1",
    embedding_mrl_768: null,
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// T1 — happy path: promoteSourceRow on a synthetic git-log row carrying a
// known ts. The appended fact row's features.time_anchors[0] mirrors that ts
// as a structural absolute anchor.
// -----------------------------------------------------------------------------
test("T1: features.time_anchors[0] mirrors promoted_at as structural absolute anchor", async () => {
  const TS = "2026-06-15T12:00:00.000Z";
  const event = {
    source_msg_id: "git_anchor_1",
    source: "git-log",
    ts: TS,
    raw_content: { subject: "stamp the row-ts anchor on every promoted fact" },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "promoteSourceRow returns ok=true on PROMOTE");
  // promoteSourceRow forwards event.ts into promotedAt for the appended row.
  assert.equal(r.promoted_at, TS, "promoted_at echoes event.ts on promoteSourceRow");

  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "the appended row is locatable by memory_event_id");
  assert.ok(
    Array.isArray(row.features.time_anchors),
    "features.time_anchors is an array",
  );
  assert.ok(
    row.features.time_anchors.length >= 1,
    "features.time_anchors carries at least the structural anchor",
  );
  const head = row.features.time_anchors[0];
  assert.equal(head.kind, "absolute", "head anchor kind is 'absolute'");
  assert.equal(
    head.instant_iso,
    TS,
    "head anchor instant_iso mirrors the row's promoted_at",
  );
  assert.equal(head.structural, true, "head anchor carries structural:true");
  assert.equal(head.raw_phrase, null, "head anchor raw_phrase is null");
  assert.equal(
    head.stamped_by,
    "cascade:row-ts",
    "head anchor stamped_by breadcrumb identifies the cascade row-ts stamper",
  );
});

// -----------------------------------------------------------------------------
// T2 — defensive: when the event lacks `ts`, promoteSourceRow falls back to
// new Date(now).toISOString() inside the cascade, so promotedAt is still a
// string and the stamper still produces an anchor. The row promotes; nothing
// crashes.
//
// Note: there is no real "missing ts" path that yields a non-string promotedAt
// through the public cascade entry points (serverTs() and new Date(...).toISOString()
// both return strings). We exercise the defensive branch by confirming the row
// still promotes and the anchor is well-formed when event.ts is absent.
// -----------------------------------------------------------------------------
test("T2: defensive — missing event.ts still promotes; anchor uses cascade-supplied promotedAt", async () => {
  const event = {
    source_msg_id: "git_anchor_no_ts",
    source: "git-log",
    // ts intentionally omitted
    raw_content: { subject: "missing event.ts must not crash the cascade" },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "row still PROMOTES when event.ts is absent");
  assert.equal(
    typeof r.promoted_at,
    "string",
    "cascade synthesizes a promoted_at ISO string when event.ts is missing",
  );
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row is durably on disk despite missing event.ts");
  const head = row.features.time_anchors && row.features.time_anchors[0];
  assert.ok(head, "structural anchor still stamped when event.ts is absent");
  assert.equal(head.kind, "absolute", "kind is 'absolute' on synthesized-ts anchor");
  assert.equal(head.structural, true, "structural:true holds on synthesized-ts anchor");
  // The synthesized ISO parses as a valid Date.
  assert.ok(
    !Number.isNaN(Date.parse(head.instant_iso)),
    "synthesized instant_iso parses as a valid Date",
  );
});

// -----------------------------------------------------------------------------
// T3 — structural anchor sits at position 0. Confirms unshift semantics:
// the row's features.time_anchors[0] is the structural row-ts anchor and any
// future text-extracted anchors (when the resolver lands on the cascade path)
// would append after it. We assert position-0 invariant directly here using a
// synthetic pre-populated features map at the upstream layer is out of scope
// for the cascade path; what we DO verify is that the head element is the
// structural one and the array has length ≥ 1.
// -----------------------------------------------------------------------------
test("T3: structural anchor occupies position 0 (unshift semantics)", async () => {
  const TS = "2026-06-16T09:30:00.000Z";
  const event = {
    source_msg_id: "git_anchor_pos0",
    source: "git-log",
    ts: TS,
    raw_content: { subject: "head-of-array invariant" },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row exists");
  const anchors = row.features.time_anchors;
  assert.ok(Array.isArray(anchors) && anchors.length >= 1, "anchors array non-empty");
  // Strict: position 0 IS the structural one.
  assert.equal(anchors[0].structural, true, "anchors[0].structural === true");
  assert.equal(
    anchors[0].instant_iso,
    TS,
    "anchors[0].instant_iso === row promoted_at",
  );
  // No other anchor at v0 of this cascade lane (text-extractor not wired on
  // the cascade path yet).
  assert.equal(anchors.length, 1, "exactly one anchor on v0 cascade lane");
});

// -----------------------------------------------------------------------------
// T4 — connector-shaped fixture: use a ts in the exact form the git-log
// connector stores (fractional milliseconds + Z) and confirm the anchor
// mirrors it byte for byte.
// This guards against silent normalization (e.g. truncating fractional
// seconds, dropping the Z) regressing the field.
// -----------------------------------------------------------------------------
test("T4: millisecond-precision git-log ts propagates verbatim into features.time_anchors[0].instant_iso", async () => {
  // Invented ts in the stored git-log.jsonl form (ISO-8601, milliseconds, Z).
  const SOURCE_GIT_TS = "2026-05-20T08:14:27.305Z";
  const event = {
    source_msg_id: "git_anchor_realts",
    source: "git-log",
    ts: SOURCE_GIT_TS,
    raw_content: {
      subject: "Initial commit",
      commit_hash: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
      author_email: "alex.example@example.org",
    },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "source-ts row promotes");
  assert.equal(
    r.promoted_at,
    SOURCE_GIT_TS,
    "promoted_at on the response echoes the source ts verbatim",
  );
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "source-ts row durably on disk");
  assert.equal(
    row.features.time_anchors[0].instant_iso,
    SOURCE_GIT_TS,
    "source ts propagates verbatim into features.time_anchors[0].instant_iso",
  );
  // Also: the row-level created_at carries the same ts (proves cascade
  // wiring is end-to-end).
  assert.equal(
    row.created_at,
    SOURCE_GIT_TS,
    "row.created_at mirrors the source ts (cascade end-to-end)",
  );
});

// -----------------------------------------------------------------------------
// T5 — downstream consumer: episodicity-scorer reads features.time_anchors,
// so the structural stamp must lift the time_specificity input above the
// "no anchors" baseline. We compare two synthetic features blobs (empty vs
// with the structural anchor) and assert the with-anchor episodicity is
// strictly higher. Confirms the gap-closing claim in the node predicate.
// -----------------------------------------------------------------------------
test("T5: structural anchor lifts episodicity above the no-anchors baseline", () => {
  const TS = "2026-06-17T08:00:00.000Z";
  const empty = {
    entities: [],
    time_anchors: [],
    valence: null,
  };
  const withAnchor = {
    entities: [],
    time_anchors: [
      {
        kind: "absolute",
        instant_iso: TS,
        raw_phrase: null,
        structural: true,
        stamped_by: "cascade:row-ts",
      },
    ],
    valence: null,
  };
  const epEmpty = episodicityMod.computeFromFeatures(empty);
  const epAnchored = episodicityMod.computeFromFeatures(withAnchor);
  assert.equal(typeof epEmpty, "number", "no-anchor episodicity is numeric");
  assert.equal(typeof epAnchored, "number", "anchored episodicity is numeric");
  assert.ok(
    epAnchored > epEmpty,
    `structural anchor lifts episodicity (no-anchor=${epEmpty}, anchored=${epAnchored})`,
  );
});

// -----------------------------------------------------------------------------
// T6 — sweep across three consent bases confirms the stamp fires on every
// promoted row regardless of consent_basis (the time-anchor stamp is content-
// and consent-independent: every fact has a promote-time wall-clock).
// -----------------------------------------------------------------------------
test("T6: structural anchor stamps on every promote, across consent bases", async () => {
  const cases = [
    {
      source_msg_id: "anchor_sweep_first",
      ts: "2026-06-17T10:00:00.000Z",
      consent: "first_party",
    },
    {
      source_msg_id: "anchor_sweep_explicit",
      ts: "2026-06-17T11:00:00.000Z",
      consent: "third_party_explicit",
    },
    {
      source_msg_id: "anchor_sweep_inferred",
      ts: "2026-06-17T12:00:00.000Z",
      consent: "third_party_inferred",
    },
  ];
  for (const c of cases) {
    const event = {
      source_msg_id: c.source_msg_id,
      source: "git-log",
      ts: c.ts,
      raw_content: { subject: `sweep ${c.source_msg_id}` },
      source_policy: { consent_basis: c.consent },
    };
    const r = await promoteFactMod.promoteSourceRow({
      event,
      source: "git-log",
      salience: fakePromote(),
    });
    assert.equal(r.ok, true, `promote ok for ${c.source_msg_id}`);
    const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
    assert.ok(row, `row exists for ${c.source_msg_id}`);
    const head = row.features.time_anchors && row.features.time_anchors[0];
    assert.ok(head, `head anchor present for ${c.source_msg_id}`);
    assert.equal(
      head.instant_iso,
      c.ts,
      `instant_iso matches event.ts for ${c.source_msg_id}`,
    );
    assert.equal(head.structural, true, `structural:true for ${c.source_msg_id}`);
  }
});
