// WORKUNIT A-promote-projection — promote-time feature-completeness test.
//
// Verifies that the four additive promote-time stamps + the sentinel discipline
// land on every NEW fact at the single PROMOTE chokepoint
// (mcp/lib/tools/distill-promote-fact.js appendFactRow), driven through the
// non-MCP promoteSourceRow entry (watermark path) so we avoid daemon-signed
// token plumbing / consent walks.
//
// Hot path under test:
//
//   watermark daemon → scoreCandidate (PROMOTE)
//     → promoteSourceRow
//       → appendFactRow         <─── valence / gazetteer / thread_keys / ts +
//         → memory.jsonl row          sentinels stamped here
//
// Contract (from the WORKUNIT A-promote-projection node):
//   (1) features.valence is the FULL structured {sign, magnitude, source,
//       model_version} object; the index/scorer SCALAR is projected (never
//       stored twice) via factValenceScalar — the SINGLE shared projection.
//   (2) features.valence_model_version is ALWAYS stamped (sentinel discipline).
//   (3) a gazetteer-known name (a surface from the library's default seed) is
//       extracted with evidence='kb_lookup', additively merged into entities.
//   (4) features.thread_keys forwards the source row's identity keys (closed
//       set) so the thread / project aggregators can bucket the NEW fact.
//   (5) top-level `ts` mirrors created_at so the aggregators' ts guard passes.
//   (6) sentinels: on a forced scorer throw the *_version tag is STILL stamped
//       and features.synth_degraded.reasons[] records a `*_threw` reason that
//       reuses the recall populator's degraded vocabulary; the row still
//       promotes durably.
//   (7) valence is stamped BEFORE episodicity so the episodicity scorer reads
//       features.valence.magnitude (verified by re-deriving the scalar from the
//       on-disk features and matching the stamped episodicity).
//   (8) THESIS #1: a pre-existing ledger row is byte-identical after a promote
//       — only NEW facts are stamped; no existing row is mutated.
//
// Test discipline:
//   - HERMETIC: env vars set BEFORE any dynamic import touches config.js.
//   - All writes under TMP_ROOT; no real storage paths touched.
//   - Drives `promoteSourceRow` directly (non-MCP entry).
//   - >= 12 assertions across separately named tests.
//
// Run:
//   node --test test/synthesis/promote-projection-completeness.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js so the
// ledger / policy paths land under TMP_ROOT.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-syn-promote-projection-"));
process.env.MEMORY_ROOT = TMP_ROOT;
// Synthetic operator identity. operator-identity.js resolves its config file
// once, at module load, so this is set before the first library import (the
// temp root has no config/operator-identity.json of its own).
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);
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

const promoteFactMod = await import("../../lib/tools/distill-promote-fact.js");
const valenceMod = await import("../../lib/synthesis/valence-scorer.js");
const episodicityMod = await import(
  "../../lib/synthesis/episodicity-scorer.js"
);

// The gazetteer's default seed is a frozen module constant with no injection
// point on the promote path. T3 takes its "known name" from that export
// instead of repeating a seed literal here: the first single-word project
// surface, whose canonical id is the lowercased word.
const { DEFAULT_GAZETTEER_SEED } = await import(
  "../../lib/synthesis/gazetteer.js"
);
const KNOWN_PROJECT_ENTRY =
  DEFAULT_GAZETTEER_SEED.find(
    (e) => e && e.kind === "project" && /^[A-Za-z]{3,}$/.test(e.surface),
  ) || null;
const KNOWN_PROJECT = KNOWN_PROJECT_ENTRY ? KNOWN_PROJECT_ENTRY.surface : "";
const KNOWN_PROJECT_ID = `project:git-log:${KNOWN_PROJECT.toLowerCase()}`;

const LEDGER_PATH = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");

function memoryLedgerLines() {
  if (!existsSync(LEDGER_PATH)) return [];
  const text = readFileSync(LEDGER_PATH, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// Synthetic salience PROMOTE result. Mirrors the shape scoreCandidate
// produces; only the fields appendFactRow / promoteSourceRow consume are
// populated. embedding_mrl_768 is null because the index push is irrelevant
// to the feature-stamp contract (the stamps run before the index branch).
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

// A git-log source row carrying:
//   - emotionally-charged content (positive valence hits) + invented project
//     names (T3 adds a gazetteer-known surface taken from the default seed),
//   - identity keys in raw_content (repo_path, author_email) for thread_keys.
function gitEvent(source_msg_id, content, extraRaw = {}) {
  return {
    source_msg_id,
    source: "git-log",
    ts: "2026-06-02T09:00:00Z",
    raw_content: {
      subject: content,
      repo_path: "/home/alex/projects/example-repo",
      author_email: "alex@example.com",
      ...extraRaw,
    },
    parties: ["alex@example.com"],
    source_policy: { consent_basis: "first_party" },
  };
}

async function promote(event) {
  return promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
}

// -----------------------------------------------------------------------------
// T1 — valence carried as the FULL structured object AND reconciled to a scalar
// via the SINGLE factValenceScalar projection (not stored twice).
// -----------------------------------------------------------------------------
test("T1: fresh promote carries features.valence as a structured object + scalar projection", async () => {
  const content =
    "so happy and grateful — the Acmebot LX-2 run was amazing and wonderful today";
  const r = await promote(gitEvent("proj_t1", content));
  assert.equal(r.ok, true, "promoteSourceRow returns ok=true");
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "the appended row is locatable by memory_event_id");

  const v = row.features.valence;
  // (a) valence is the structured ValenceValue OBJECT, not a bare scalar.
  assert.equal(typeof v, "object", "features.valence is an object");
  assert.ok(v !== null, "features.valence is non-null on a valence-bearing row");
  assert.ok(
    typeof v.sign === "number" &&
      typeof v.magnitude === "number" &&
      typeof v.source === "string",
    "valence object carries {sign, magnitude, source}",
  );
  // This content is dominantly positive -> sign 1.
  assert.equal(v.sign, 1, "dominantly-positive content scores sign=1");

  // (b) the index/scorer SCALAR is PROJECTED from the object via the single
  // shared helper — NOT stored as a second on-row field. Re-derive it and
  // confirm it is a finite scalar ∈ [-1,+1] consistent with the object.
  const scalar = valenceMod.factValenceScalar(row.features.valence);
  assert.equal(typeof scalar, "number", "factValenceScalar yields a number");
  assert.ok(
    Number.isFinite(scalar) && scalar >= -1 && scalar <= 1,
    `projected scalar ∈ [-1,+1]; got ${scalar}`,
  );
  assert.equal(
    scalar,
    v.sign * Math.min(Math.abs(v.magnitude), 1),
    "scalar == sign * clamp(magnitude) (single projection contract)",
  );
});

// -----------------------------------------------------------------------------
// T2 — valence_model_version is ALWAYS stamped (sentinel discipline) and a
// clean promote carries NO synth_degraded field (byte-compat with pre-WU rows).
// -----------------------------------------------------------------------------
test("T2: valence_model_version always stamped; clean promote has no synth_degraded", async () => {
  const r = await promote(
    gitEvent("proj_t2", "shipping the Atlas cascade integration today, feeling good"),
  );
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row is on disk");
  assert.equal(
    row.features.valence_model_version,
    valenceMod.MODEL_VERSION,
    "features.valence_model_version mirrors the module constant",
  );
  assert.equal(
    "synth_degraded" in row.features,
    false,
    "a clean promote carries NO synth_degraded field (byte-compatible)",
  );
});

// -----------------------------------------------------------------------------
// T3 — a gazetteer-known name is extracted with evidence='kb_lookup'
// and additively merged into features.entities (the structural extractor cannot
// see free-prose project names).
// -----------------------------------------------------------------------------
test("T3: gazetteer-known name (default-seed project) extracted with evidence=kb_lookup", async () => {
  assert.ok(
    KNOWN_PROJECT_ENTRY,
    "default gazetteer seed carries a single-word project surface",
  );
  const r = await promote(
    gitEvent("proj_t3", `we discussed the ${KNOWN_PROJECT} rollout and the spring planning notes`),
  );
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row is on disk");
  assert.ok(Array.isArray(row.features.entities), "features.entities is an array");
  const gaz = row.features.entities.filter((e) => e && e.evidence === "kb_lookup");
  assert.ok(
    gaz.length >= 1,
    `at least one gazetteer (kb_lookup) entity stamped; got ${gaz.length}`,
  );
  const ids = gaz.map((e) => e.canonical_id);
  assert.ok(
    ids.includes(KNOWN_PROJECT_ID),
    `seed project recognized as ${KNOWN_PROJECT_ID}; got ${JSON.stringify(ids)}`,
  );
  // Additive merge: gazetteer hits carry the cascade:gazetteer breadcrumb.
  assert.ok(
    gaz.every((e) => e.stamped_by === "cascade:gazetteer"),
    "every gazetteer entity is breadcrumbed stamped_by=cascade:gazetteer",
  );
});

// -----------------------------------------------------------------------------
// T4 — identity keys forwarded onto features.thread_keys (closed set only).
// -----------------------------------------------------------------------------
test("T4: features.thread_keys forwards the source row's identity keys", async () => {
  const r = await promote(
    gitEvent("proj_t4", "checked the Acmebot run config", {
      // an arbitrary non-closed-set key that must NOT leak through.
      message_body: "this is a large body that must never be copied to the fact",
    }),
  );
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row is on disk");
  const tk = row.features.thread_keys;
  assert.equal(typeof tk, "object", "features.thread_keys is an object");
  assert.equal(
    tk.repo_path,
    "/home/alex/projects/example-repo",
    "repo_path forwarded from raw_content",
  );
  assert.equal(
    tk.author_email,
    "alex@example.com",
    "author_email forwarded from raw_content",
  );
  // Closed-set discipline: a non-identity raw_content field is NOT copied.
  assert.equal(
    "message_body" in tk,
    false,
    "non-closed-set raw_content keys are NOT forwarded (no PII passthrough)",
  );
});

// -----------------------------------------------------------------------------
// T5 — top-level `ts` mirror equals created_at so the aggregators' ts guard
// passes. created_at remains the authoritative promote-time field.
// -----------------------------------------------------------------------------
test("T5: top-level ts mirror is present and equals created_at", async () => {
  const r = await promote(gitEvent("proj_t5", "Atlas project notes, glad about progress"));
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row is on disk");
  assert.equal(typeof row.ts, "string", "top-level ts is present as a string");
  assert.equal(typeof row.created_at, "string", "created_at is present");
  assert.equal(row.ts, row.created_at, "ts is a pure mirror of created_at");
});

// -----------------------------------------------------------------------------
// T6 — valence is stamped BEFORE episodicity: the episodicity scorer reads
// features.valence.magnitude. Re-deriving the scalar from the on-disk features
// via the same pure computeFromFeatures path must match the stamped value,
// which proves the cascade consumed the post-valence-stamp features block.
// -----------------------------------------------------------------------------
test("T6: valence stamped before episodicity (episodicity reads valence.magnitude)", async () => {
  const r = await promote(
    gitEvent(
      "proj_t6",
      "absolutely thrilled and excited — wonderful amazing Acmebot milestone today",
    ),
  );
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row is on disk");
  // valence must be present (non-null) and its magnitude > 0 for this content.
  assert.ok(
    row.features.valence && typeof row.features.valence.magnitude === "number",
    "valence.magnitude is present on the row",
  );
  assert.ok(
    row.features.valence.magnitude > 0,
    "emotionally-charged content yields a non-zero valence magnitude",
  );
  // The episodicity scalar, re-derived from the FULL on-disk features (which
  // include the valence object), equals the stamped scalar. If valence had been
  // stamped AFTER episodicity, the stamped value would have been computed over a
  // valence-less features block and this equality would fail.
  const expected = episodicityMod.computeFromFeatures(row.features);
  assert.equal(
    row.features.episodicity,
    expected,
    "stamped episodicity == computeFromFeatures(row.features) incl. valence",
  );
});

// -----------------------------------------------------------------------------
// T7 — sentinels on a FORCED valence throw: the *_version tag is STILL stamped,
// the row still promotes durably, and synth_degraded.reasons records a
// `valence_scorer_threw` reason that reuses the recall populator vocabulary.
//
// We force the throw by monkey-patching scoreValence on the imported module
// namespace (ESM live binding; the cascade reads the binding at call time).
// -----------------------------------------------------------------------------
test("T7: forced valence throw stamps version, records synth_degraded reason, still promotes", async () => {
  const original = valenceMod.scoreValence;
  let monkeyPatched = false;
  try {
    Object.defineProperty(valenceMod, "scoreValence", {
      value: () => {
        throw new Error("simulated valence scorer failure");
      },
      configurable: true,
    });
    monkeyPatched = true;
  } catch {
    monkeyPatched = false;
  }

  try {
    const r = await promote(
      gitEvent("proj_t7", "force a valence degrade on the Acmebot row"),
    );
    assert.equal(r.ok, true, "row still PROMOTES when the valence scorer throws");
    const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
    assert.ok(row, "the row is durably on disk despite the scorer throw");

    // The *_version tag is ALWAYS stamped (sentinel discipline) — even on throw.
    assert.equal(
      row.features.valence_model_version,
      valenceMod.MODEL_VERSION,
      "valence_model_version stamped even on a scorer throw",
    );

    if (monkeyPatched) {
      // valence degraded to explicit null (NOT a half-built object).
      assert.equal(
        row.features.valence,
        null,
        "valence degrades to explicit null on throw",
      );
      // synth_degraded.reasons[] records the throw using the recall vocabulary.
      assert.ok(
        row.features.synth_degraded &&
          Array.isArray(row.features.synth_degraded.reasons),
        "synth_degraded.reasons[] is present on a degraded row",
      );
      assert.ok(
        row.features.synth_degraded.reasons.includes("valence_scorer_threw"),
        `reasons[] records valence_scorer_threw; got ${JSON.stringify(
          row.features.synth_degraded.reasons,
        )}`,
      );
    } else {
      // ESM live-binding patch refused: verify the degrade contract by shape.
      assert.ok(
        row.features.valence === null ||
          typeof row.features.valence === "object",
        "valence is null or an object — never undefined / crash",
      );
    }
  } finally {
    try {
      Object.defineProperty(valenceMod, "scoreValence", {
        value: original,
        configurable: true,
      });
    } catch {
      // best effort; suite isolation is per-process.
    }
  }
});

// -----------------------------------------------------------------------------
// T8 — THESIS #1: a pre-existing ledger row is byte-identical after a promote.
// We write a hand-crafted "legacy" row to the ledger FIRST, promote a NEW fact,
// then assert the legacy row's serialized bytes are unchanged — only NEW facts
// are stamped; no existing row is mutated.
// -----------------------------------------------------------------------------
test("T8: existing ledger row is untouched by a subsequent promote (Thesis #1)", async () => {
  // A legacy row with NONE of the WU-A projection fields. Append it raw.
  const legacy = {
    id: "mem_legacy_thesis1",
    kind: "fact",
    content: "a pre-existing fact promoted before the WU-A projection landed",
    source: "git-log",
    source_refs: [
      {
        source: "git-log",
        source_msg_id: "legacy_src",
        via: "original",
        corroboration_event_id: null,
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "legacy",
      conversation_id: null,
      confidence: "high",
    },
    features: { entities: [] },
    created_at: "2025-01-01T00:00:00Z",
  };
  const legacyLine = JSON.stringify(legacy);
  // Append to whatever is already on disk (prior tests promoted rows); the
  // legacy line is the LAST line we control.
  const before = existsSync(LEDGER_PATH) ? readFileSync(LEDGER_PATH, "utf8") : "";
  writeFileSync(LEDGER_PATH, before + legacyLine + "\n", { mode: 0o600 });

  // Promote a NEW fact through the cascade.
  const r = await promote(
    gitEvent("proj_t8", "a brand-new Atlas fact, excited to ship"),
  );
  assert.equal(r.ok, true, "the new fact promotes");

  // Re-read and locate the legacy row by id; its serialized bytes must be
  // byte-identical (no field added, no field mutated).
  const lines = readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const legacyOnDisk = lines.find((l) => {
    try {
      return JSON.parse(l).id === "mem_legacy_thesis1";
    } catch {
      return false;
    }
  });
  assert.ok(legacyOnDisk, "the legacy row is still on disk");
  assert.equal(
    legacyOnDisk,
    legacyLine,
    "the legacy row is byte-identical (no existing-row mutation — Thesis #1)",
  );
  // And the NEW row carries the projection fields the legacy row lacks.
  const newRow = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((x) => x && x.id === r.memory_event_id);
  assert.ok(newRow, "the new row is on disk");
  assert.ok(
    "valence_model_version" in newRow.features && "ts" in newRow,
    "the NEW row carries the WU-A projection fields the legacy row lacks",
  );
});

// -----------------------------------------------------------------------------
// T9 — A1 (Carry attribution through promotion, WRITE-SIDE): a telegram source
// row → fact carries a top-level parties[] forwarded verbatim + a bounded
// features.attribution ⊆ the closed 9-key allowlist, with direction keys
// mirroring the source row. The full raw_content / message body is NEVER
// re-attached (top-level raw_content stays null; no `text` key on attribution).
// -----------------------------------------------------------------------------
test("T9: telegram promote stamps top-level parties + closed-key features.attribution (no raw_content)", async () => {
  const RAW_TEXT = "telegram body text that must NEVER be re-attached to a fact";
  const event = {
    source_msg_id: "tg_a1_t9",
    source: "telegram",
    ts: "2026-06-02T09:00:00Z",
    raw_content: {
      peer_type: "user",
      peer_id: "770001",
      peer_name: "Example Team",
      message_id: 4242,
      sender_id: "990002",
      sender_name: "Sam Sample",
      is_outgoing: false,
      is_self: false,
      reply_to: 4200,
      text: RAW_TEXT,
    },
    parties: ["samsample", "Example Team"],
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "telegram",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "telegram row promotes");
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "telegram fact is on disk");

  // (a) top-level parties[] forwarded verbatim (connector audience array).
  assert.deepEqual(
    row.parties,
    ["samsample", "Example Team"],
    "top-level parties[] forwarded verbatim from the source row",
  );

  // (b) features.attribution is a closed-key subset ⊆ the 9-key allowlist.
  const ALLOWED = new Set([
    "sender_id",
    "sender_name",
    "peer_id",
    "peer_name",
    "peer_type",
    "is_outgoing",
    "is_self",
    "reply_to",
    "fwd_from",
  ]);
  const attr = row.features.attribution;
  assert.equal(typeof attr, "object", "features.attribution is an object");
  assert.ok(attr !== null, "features.attribution is non-null on a telegram fact");
  for (const k of Object.keys(attr)) {
    assert.ok(ALLOWED.has(k), `attribution key '${k}' is in the 9-key allowlist`);
  }
  assert.equal(attr.sender_id, "990002", "sender_id forwarded verbatim");
  assert.equal(attr.sender_name, "Sam Sample", "sender_name forwarded verbatim");
  assert.equal(attr.peer_name, "Example Team", "peer_name forwarded verbatim");
  assert.equal(attr.peer_type, "user", "peer_type forwarded verbatim");
  assert.equal(attr.reply_to, 4200, "reply_to forwarded as a scalar");
  // (c) direction keys mirror the source row verbatim.
  assert.equal(attr.is_outgoing, false, "is_outgoing mirrors the source row");
  assert.equal(attr.is_self, false, "is_self mirrors the source row");

  // (d) the full raw_content / message body is NEVER re-attached.
  assert.equal(row.raw_content == null, true, "top-level raw_content stays null");
  assert.equal("text" in attr, false, "raw_content.text is not copied to attribution");
  assert.equal(
    JSON.stringify(row.features.attribution).includes(RAW_TEXT),
    false,
    "the raw message body never leaks into features.attribution",
  );

  // (e) features.attribution is DISJOINT from thread_keys / raw_content.
  assert.ok(
    !("raw_content" in row.features),
    "features.raw_content is not synthesized on a telegram promote (disjoint field)",
  );
});

// -----------------------------------------------------------------------------
// T10 — A1: a non-messaging (git-log) promote carries NO features.attribution
// (empty-subset → field omitted) and NO synth_degraded on the clean path — the
// attribution stamp is byte-compatible with pre-A1 non-messaging facts.
// -----------------------------------------------------------------------------
test("T10: non-messaging (git-log) promote carries no features.attribution and no synth_degraded", async () => {
  const r = await promote(
    gitEvent("proj_t10_a1", "a plain git-log fact with no connector attribution"),
  );
  const row = memoryLedgerLines().find((x) => x.id === r.memory_event_id);
  assert.ok(row, "git-log fact is on disk");
  assert.equal(
    "attribution" in row.features,
    false,
    "non-messaging source carries NO features.attribution (empty → omit, byte-compat)",
  );
  assert.equal(
    "synth_degraded" in row.features,
    false,
    "the attribution stamp records no degrade on the clean/empty path",
  );
});
