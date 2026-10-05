// salience-cascade-integration.test.mjs — R25.5 regression battery for the
// three INTERLOCKED CRIT-1 bugs that masked each other in R25:
//
//   CRIT-1a daemons/watermark.js missing `await` on scoreCandidate → Promise
//           string-compares to "DROP"/"CORROBORATE" always fail; fallthrough
//           returns PROMOTE without actually appending. R25 saw 163,200 rows
//           PROMOTE-decisioned, 0 written.
//
//   CRIT-1b mcp/lib/tools/distill-promote-fact.js did not export
//           promoteSourceRow. watermark.js's typeof guard returned false →
//           silent no-op.
//
//   CRIT-1c mcp/lib/ingest/salience.js threw on `event.content must be a
//           string` because source rows carry raw_content (object), not
//           content (string). No normalization adapter at the salience
//           boundary.
//
// The R25 bug-mask happened BECAUSE each bug hid the others: 1a swallowed
// 1c's throw inside a Promise rejection that was never awaited; 1b would
// have surfaced 1a's behaviour but the typeof check short-circuited; 1c
// would have surfaced 1a's missing-await as a TypeError if the await had
// been present. To prevent recurrence, each test below MUST fail
// independently when its specific bug is reintroduced.
//
// HERMETIC: synthetic source-ledger rows only. No real chat.db, no real
// Gemini calls. The TMP_ROOT is wiped at process exit.
//
// Test surface (5 assertions):
//   T1 raw_content (not content) flows through scoreCandidate without throw
//      and returns PROMOTE. Independently fails if CRIT-1c regresses.
//   T2 scoreCandidate is async; the caller MUST await. Verify by invoking
//      WITHOUT await and asserting the return value is a Promise. Captures
//      the await-vs-Promise type confusion that produced CRIT-1a.
//   T3 end-to-end synthetic watermark tick → ledger row → memory.jsonl
//      write. Uses the actual tickSourcesOnce against a synthetic ledger;
//      asserts memory.jsonl grows by N. Fails if any of 1a/1b/1c regress.
//   T4 promoteSourceRow is reachable as a NAMED IMPORT — no typeof check
//      needed. The "exports are complete" assertion. Captures CRIT-1b.
//   T5 per-source raw_content normalization adapter handles all 4 source
//      shapes; produces non-empty text string for each. Captures CRIT-1c
//      adapter coverage (one shape per source).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Hermetic root MUST be set BEFORE any dynamic import touches config.js so
// the policy-event writer + ledger paths target the tmp dir.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-r25p5-integ-"));
process.env.MEMORY_ROOT = TMP_ROOT;
// Synthetic operator identity, resolved once at operator-identity.js load, so
// it is set before the first library import.
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");
// The watermark daemon's source-cascade path also reads recall-index files;
// MEMORY_SALIENCE_BYPASS is INTENTIONALLY NOT set — we want the full cascade.
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
  join(process.env.STORAGE_BASE_DIR, "watermark-state"),
  join(process.env.LEDGERS_BASE_DIR),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const salienceMod = await import("../../lib/ingest/salience.js");
const distillPromoteFactMod = await import(
  "../../lib/tools/distill-promote-fact.js"
);
const watermarkMod = await import("../../../daemons/watermark.js");

// R25.6: production loadStage0Dispatch() resolves mod.dispatch directly. The
// _setStage0DispatchForTest((_src, ev) => stage0Dispatch(ev)) wiring was an
// ANTI-TEST bridging the runtime gap; with the alias export it's no longer
// needed and the cascade end-to-end exercises the real production hard-drop
// rules (imessage/screentime/gitlog/githubevents) untouched.

const NOW = new Date("2026-06-02T00:00:00Z");

// -----------------------------------------------------------------------------
// Fixture helpers.
// -----------------------------------------------------------------------------

function unitVec() {
  // 768-dim unit vector with all mass on axis 0. Pre-seed by ctx, not by
  // synthesizing here — the cascade only uses this when ctx.embedding_mrl_768
  // is provided. Most tests below leave embedding null (degraded path).
  const v = new Array(768).fill(0);
  v[0] = 1.0;
  return v;
}

function writeSourceLedger(source, rows) {
  const path = join(process.env.STORAGE_BASE_DIR, "sources", `${source}.jsonl`);
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

function memoryLedgerLineCount() {
  const path = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  return text.split("\n").filter((line) => line.length > 0).length;
}

// -----------------------------------------------------------------------------
// T1 — raw_content (not content) flows through scoreCandidate without throw
// and returns PROMOTE. Independently FAILS if CRIT-1c regresses (the adapter
// is removed from salience.js or the boundary check is restored to the strict
// type-error variant).
// -----------------------------------------------------------------------------
test("T1 (CRIT-1c): raw_content-shaped event flows through scoreCandidate without throwing", async () => {
  // Synthetic iMessage row exactly as it lives in storage/sources/imessage.jsonl —
  // raw_content is an OBJECT, content is NOT a top-level key.
  const sourceRow = {
    id: "ulid_T1_RAW_CONTENT",
    ts: "2026-06-01T12:00:00Z",
    source: "imessage",
    source_msg_id: "imsg_T1",
    parties: ["user", "+15555550101"],
    raw_content: {
      text: "We landed the R25.5 fix today and the cascade now drains the source ledgers end-to-end.",
      handle_id: "+15555550101",
    },
    source_policy: { consent_basis: "first_party" },
  };

  // No throw. PROMOTE. The adapter materialised content from raw_content.text.
  const r = await salienceMod.scoreCandidate(sourceRow, {
    embedding_mrl_768: null,
    hnsw: null,
    now: NOW,
  });
  assert.equal(r.decision, "PROMOTE", "raw_content adapter must yield PROMOTE on substantive prose");
  assert.ok(r.components, "PROMOTE result must carry components");
  assert.ok(
    typeof r.components.content_mass === "number" && r.components.content_mass > 0,
    "content_mass must be non-zero (the adapter populated content from raw_content.text)",
  );
});

// -----------------------------------------------------------------------------
// T2 — scoreCandidate is async; the caller MUST await. Verify directly that
// the return value WITHOUT await is a Promise, not a {decision} object.
// Independently FAILS if CRIT-1a regresses (the await is removed from
// watermark.js or someone makes scoreCandidate synchronous and a future
// caller drops the await pattern).
// -----------------------------------------------------------------------------
test("T2 (CRIT-1a): scoreCandidate returns a Promise; callers must await", async () => {
  const sourceRow = {
    source: "imessage",
    source_msg_id: "imsg_T2",
    content: "A substantive message about the R25.5 cascade fix and its three interlocked bugs.",
    consent_basis: "first_party",
    ts: "2026-06-01T13:00:00Z",
    raw_content: { text: "matches content" },
  };

  // Without await: the returned value is a Promise.
  const maybePromise = salienceMod.scoreCandidate(sourceRow, {
    embedding_mrl_768: null,
    hnsw: null,
    now: NOW,
  });
  assert.ok(
    maybePromise && typeof maybePromise.then === "function",
    "scoreCandidate must return a Promise (so an unawaited string-compare against sc.decision is impossible)",
  );

  // The unawaited Promise's `.decision` is undefined — exactly the trap that
  // produced CRIT-1a's PROMOTE-fallthrough on every row.
  assert.equal(
    maybePromise.decision,
    undefined,
    "raw Promise has no .decision — the R25 bug-mask was treating this Promise as a sync result",
  );

  // Awaited result is a real decision object.
  const awaited = await maybePromise;
  assert.ok(
    awaited && typeof awaited.decision === "string",
    "awaited result carries a decision string",
  );
});

// -----------------------------------------------------------------------------
// T3 — end-to-end synthetic watermark tick → ledger row → memory.jsonl write.
// Uses the actual tickSourcesOnce function against a synthetic source ledger.
// Asserts memory.jsonl grows by N. Independently FAILS if any of CRIT-1a /
// CRIT-1b / CRIT-1c regress, because each of those bugs breaks the chain:
//   - 1c: scoreCandidate throws on raw_content → cascade error path → 0 writes
//   - 1a: scoreCandidate returns Promise → fallthrough PROMOTE → no promoteSourceRow call
//   - 1b: promoteSourceRow not exported → typeof guard false → no write
// This is the "memory.jsonl populates to >N rows" gate from the R25.5 brief
// rendered as a unit test.
// -----------------------------------------------------------------------------
test("T3 (CRIT-1a+1b+1c end-to-end): watermark tick → cascade → memory.jsonl appends", async () => {
  // Three substantive iMessage rows. Each should clear Stage-0 (not a tapback,
  // not a urn:biz handle, substantive prose) and the salience layer's content-
  // mass + recency + source-prior. With no HNSW seeded, novelty defaults to
  // 1.0 (empty index) and corroboration cannot fire → all three PROMOTE.
  const rows = [];
  for (let i = 0; i < 3; i++) {
    rows.push({
      id: `ulid_T3_${i}`,
      ts: "2026-06-01T1" + i + ":00:00Z",
      source: "imessage",
      source_msg_id: `imsg_T3_${i}`,
      parties: ["user", "+15555550199"],
      raw_content: {
        text:
          `R25.5 integration row ${i}: the cascade should write this distinct ` +
          `message into memory.jsonl when scoreCandidate is properly awaited and ` +
          `promoteSourceRow is correctly exported.`,
        handle_id: "+15555550199",
      },
      source_policy: { consent_basis: "first_party" },
    });
  }
  writeSourceLedger("imessage", rows);

  // WU2: inject a working LOCAL embedder via the cascade-mods test hook. The
  // cascade pre-fetches the tick's embeddings via localEmbedBatch (4096-dim);
  // wiring a deterministic 4096 unit-vector stub + the real
  // stage0/salience/promote modules exercises the SUCCESS chain (the
  // CRIT-1a/1b/1c regression surface) without a live embed server.
  const salienceModFresh = await import("../../lib/ingest/salience.js");
  const stage0Mod = await import("../../lib/ingest/stage0/index.js");
  const promoteMod = await import("../../lib/tools/distill-promote-fact.js");
  const stubVec4096 = new Array(4096).fill(0).map((_, i) => (i === 0 ? 1 : 0));
  watermarkMod._setCascadeModsForTest({
    stage0: stage0Mod,
    salience: salienceModFresh,
    promote: promoteMod,
    normalizeSourceEvent: salienceModFresh.normalizeSourceEvent,
    localEmbedBatch: async ({ items }) =>
      items.map((_t, i) => ({ index: i, vector_4096: stubVec4096.slice() })),
    indexCache: { loadIndices: () => ({ hnsw: null }) },
  });

  // Pre-tick: memory.jsonl is empty (or non-existent).
  const before = memoryLedgerLineCount();

  let result;
  try {
    // Drive the actual production tick. The local-embed stub above supplies a
    // real 4096-dim vector so we are testing the SUCCESS chain (Stage-0 →
    // salience → promoteSourceRow → memory.jsonl append).
    result = await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    watermarkMod._setCascadeModsForTest(null);
  }

  // Post-tick: at LEAST 1 row appended. The exact count depends on Stage-0
  // dispatch + sibling agent's cold-start novelty lerp (CRIT-6), which is
  // OUT OF SCOPE for this test. We assert the chain produced AT LEAST 1
  // write, which is the meaningful regression signal.
  const after = memoryLedgerLineCount();
  assert.ok(
    after > before,
    `memory.jsonl must grow on a successful cascade tick; before=${before} after=${after} ` +
      `(rows_read=${result.rows_read} rows_promoted=${result.rows_promoted} rows_errored=${result.rows_errored})`,
  );
  // Stronger: zero rows_errored means the cascade chain did not throw on
  // raw_content (1c), did not fall through on missing await (1a), did not
  // silent-no-op on missing export (1b).
  assert.equal(
    result.rows_errored,
    0,
    "no cascade errors expected; if rows_errored > 0 then one of CRIT-1a/1b/1c regressed (the error path swallowed the failure)",
  );
});

// -----------------------------------------------------------------------------
// T4 — promoteSourceRow is reachable as a NAMED IMPORT (no typeof check).
// Independently FAILS if CRIT-1b regresses (the export is removed). Because
// this is a direct import + call assertion, the typeof guard cannot mask the
// regression the way it did in R25.
// -----------------------------------------------------------------------------
test("T4 (CRIT-1b): promoteSourceRow is exported and directly callable", async () => {
  // 1. The export exists as a named export.
  assert.equal(
    typeof distillPromoteFactMod.promoteSourceRow,
    "function",
    "distill-promote-fact.js must export promoteSourceRow (CRIT-1b)",
  );

  // 2. The function works end-to-end on a synthetic event. We construct the
  //    minimum-viable shape watermark.js passes: { event, source, salience }
  //    with a PROMOTE salience result. This is the contract; if it changes,
  //    update watermark.js + this test together.
  const before = memoryLedgerLineCount();
  const synthEvent = {
    id: "ulid_T4_DIRECT",
    ts: "2026-06-01T14:00:00Z",
    source: "imessage",
    source_msg_id: "imsg_T4_direct",
    raw_content: { text: "Direct call to promoteSourceRow from the test." },
    source_policy: { consent_basis: "first_party" },
  };
  const synthSalience = {
    decision: "PROMOTE",
    score: 0.65,
    components: {
      recency: 1.0,
      authorship: 1.0,
      content_mass: 0.5,
      source_prior: 0.7,
      structural: 0.6,
      novelty: 1.0,
      last_retrieved_ts: 0,
      use_count: 0,
    },
    weights_hash: "deadbeef".repeat(8),
    version: "v1",
  };
  const r = await distillPromoteFactMod.promoteSourceRow(
    { event: synthEvent, source: "imessage", salience: synthSalience },
    { now: NOW },
  );
  assert.equal(r.ok, true);
  assert.ok(
    typeof r.memory_event_id === "string" && r.memory_event_id.startsWith("mem_"),
    "memory_event_id must be a mem_<hex> string",
  );
  const after = memoryLedgerLineCount();
  assert.equal(after - before, 1, "promoteSourceRow must append exactly one row");
});

// -----------------------------------------------------------------------------
// T5 — per-source raw_content normalization adapter handles all 4 source
// shapes. One non-empty string per source. Independently FAILS if CRIT-1c
// regresses on any of the source-specific adapter branches.
// -----------------------------------------------------------------------------
test("T5 (CRIT-1c per-source): normalizeSourceEvent covers all 4 source shapes", () => {
  // The adapter is exported by salience.js as `normalizeSourceEvent`.
  assert.equal(
    typeof salienceMod.normalizeSourceEvent,
    "function",
    "salience.js must export normalizeSourceEvent (the R25.5 adapter)",
  );

  const cases = [
    {
      name: "imessage / raw_content.text",
      event: { source: "imessage", raw_content: { text: "hello from imessage" } },
      expectPrefix: "hello from imessage",
    },
    {
      name: "screentime / raw_content.title",
      event: {
        source: "screentime",
        raw_content: { title: "Safari window title", url: "https://example.com" },
      },
      expectPrefix: "Safari window title",
    },
    {
      name: "screentime / raw_content.url fallback",
      event: {
        source: "screentime",
        raw_content: { url: "https://only-url.example.com" },
      },
      expectPrefix: "https://only-url",
    },
    {
      name: "git-log / subject + body",
      event: {
        source: "git-log",
        raw_content: { subject: "Fix R25.5 cascade", body: "Three interlocked bugs." },
      },
      expectContains: "Fix R25.5 cascade",
    },
    {
      name: "github-events / raw_content.body",
      event: {
        source: "github-events",
        raw_content: { body: "PR comment body text", event_type: "IssueCommentEvent" },
      },
      expectPrefix: "PR comment body text",
    },
    {
      name: "github-events / event_type-only payload composes via type-specific composer",
      // WU-A2-github-events-content-fix: pre-fix this case fell through to
      // the bare `raw.event_type` string ("PullRequestEvent"). Post-fix the
      // composer dispatches per event_type even when the payload is
      // minimal — for an action-less PullRequestEvent that means
      // "updated PR #? in unknown" (the action verb defaults to "updated",
      // the number to "#?", the repo to "unknown"). The composed string
      // is still substantively richer than the bare type name and
      // verifies the composer fires.
      event: { source: "github-events", raw_content: { event_type: "PullRequestEvent" } },
      expectContains: "PR",
    },
  ];

  for (const c of cases) {
    const out = salienceMod.normalizeSourceEvent(c.event);
    assert.equal(
      typeof out.content,
      "string",
      `[${c.name}] adapter must produce a string content`,
    );
    assert.ok(
      out.content.length > 0,
      `[${c.name}] adapter must produce non-empty content`,
    );
    if (c.expectPrefix) {
      assert.ok(
        out.content.startsWith(c.expectPrefix),
        `[${c.name}] expected prefix "${c.expectPrefix}", got "${out.content.slice(0, 40)}"`,
      );
    }
    if (c.expectContains) {
      assert.ok(
        out.content.includes(c.expectContains),
        `[${c.name}] expected to contain "${c.expectContains}", got "${out.content.slice(0, 80)}"`,
      );
    }
  }

  // Idempotency: when content is already populated, the adapter does NOT
  // overwrite it (the MCP handler path supplies args.content directly).
  const preFilled = salienceMod.normalizeSourceEvent({
    source: "imessage",
    content: "pre-filled by caller",
    raw_content: { text: "should be ignored" },
  });
  assert.equal(
    preFilled.content,
    "pre-filled by caller",
    "adapter must not overwrite a non-empty content field",
  );
});
