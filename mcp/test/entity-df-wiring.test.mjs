// W2 — THE WIRING NODE.
//
// Proves the three independently default-off recall READ-path capabilities:
//   1. Bm25Index full canonical ids are projected into entityMatchKey df space,
//      with document dedup and a loud zero-resolved-key canary.
//   2. lookupByEntityMatchKey is the fallback lookup, preserving exact lookup
//      bytes/order when off and using newest-first bucket order when on.
//   3. operator aliases project query and candidate score-time views only.
//
// Hermetic: config roots are redirected before dynamic imports. No live ledger
// or live index is opened, written, truncated, or mutated.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "memory-w2-wiring-"));
for (const dir of ["policy", "storage", "ledgers"]) {
  mkdirSync(join(TEST_ROOT, dir), { recursive: true });
}
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
// Operator identity is resolved once at module load: point it at the synthetic
// identity file before the first (dynamic) import of library code.
const IDENTITY_FILE = fileURLToPath(
  new URL("./fixtures/operator-identity.synthetic.json", import.meta.url),
);
process.env.MEMORY_OPERATOR_IDENTITY_FILE = IDENTITY_FILE;

const FLAGS = [
  "MEMORY_ENTITY_IDF_ENABLED",
  "MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP",
  "MEMORY_ENTITY_ALIAS_OVERLAY",
];
const originalFlags = new Map(FLAGS.map((name) => [name, process.env[name]]));
const flagsOff = () => {
  for (const name of FLAGS) delete process.env[name];
};
flagsOff();

after(() => {
  for (const [name, value] of originalFlags) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

const recall = await import("../lib/tools/recall.js");
const { Bm25Index } = await import("../lib/recall/bm25-index.js");
const {
  computeScore,
  entityOverlapJaccard,
} = await import("../lib/recall/multi-feature-score.js");
const {
  lookupByEntity,
  lookupByEntityMatchKey,
  __internal: entityIndexInternal,
} = await import("../lib/synthesis/entity-index.js");
const { slugify } = await import("../lib/synthesis/entity-extractor.js");

// Operator ids are derived from the identity file, never re-hardcoded.
const IDENTITY = JSON.parse(readFileSync(IDENTITY_FILE, "utf8"));
const OPERATOR_MAIL_ID = `person:mail:${slugify(IDENTITY.emails[0])}`;
const OPERATOR_GITHUB_ID =
  `person:github-events:${slugify(IDENTITY.github_usernames[0])}`;

const NOW = "2026-08-06T12:00:00.000Z";

function score({ candidateEntities, contextEntities, wiring = null }) {
  const candidateView = wiring == null
    ? candidateEntities
    : recall._resolveRecallEntityAliases(
        candidateEntities,
        wiring.aliasOverlay,
      );
  const contextView = wiring == null
    ? contextEntities
    : recall._resolveRecallEntityAliases(
        contextEntities,
        wiring.aliasOverlay,
      );
  return computeScore({
    s_emb_full3072: 0.25,
    gates: {
      predicate_mask: 1,
      consent_dampener: 1,
      derivation_status: 1,
    },
    candidate: {
      memory_id: "mem_w2",
      kind: "fact",
      ts: NOW,
      entities: candidateView,
      valence: null,
      features: {},
    },
    surrounding_context: {
      entities: contextView,
      time_anchor: null,
      valence: null,
    },
    opts: wiring == null
      ? { now: NOW, env: {} }
      : {
          now: NOW,
          entity_df: wiring.entityDf,
          entity_df_n: wiring.entityDfN,
        },
  });
}

test("all flags OFF: 28,000 score calls are byte-identical and resources stay inert", () => {
  flagsOff();

  // A poisoned object makes this a behavioral proof that the off path does
  // not even inspect the BM25 df source.
  const poisonBm25 = new Proxy({}, {
    get(_target, prop) {
      throw new Error(`flag-off touched bm25.${String(prop)}`);
    },
  });
  const wiring = recall._prepareRecallEntityWiring(poisonBm25);
  assert.deepEqual(wiring, {
    aliasOverlay: null,
    entityDf: null,
    entityDfN: null,
  });

  const pool = [
    "person:mail:alice",
    "person:telegram:bob",
    "project:git-log:memory_system",
    "file:codex-cli:mcp/lib/tools/recall.js",
    "topic:manual:recall",
  ];
  for (let i = 0; i < 28_000; i++) {
    const candidate = [pool[i % pool.length], pool[(i * 3 + 1) % pool.length]];
    const context = [pool[(i * 7 + 2) % pool.length], pool[i % pool.length]];
    const candidateView = recall._resolveRecallEntityAliases(
      candidate,
      wiring.aliasOverlay,
    );
    const contextView = recall._resolveRecallEntityAliases(
      context,
      wiring.aliasOverlay,
    );
    assert.strictEqual(candidateView, candidate, "alias-off copied candidate ids");
    assert.strictEqual(contextView, context, "alias-off copied context ids");

    const legacy = score({ candidateEntities: candidate, contextEntities: context });
    const wired = score({ candidateEntities: candidate, contextEntities: context, wiring });
    assert.equal(
      Buffer.compare(
        Buffer.from(JSON.stringify(wired)),
        Buffer.from(JSON.stringify(legacy)),
      ),
      0,
      `flag-off score bytes diverged at case ${i}`,
    );
  }
  console.log("# flag-off parity: 28,000/28,000 score calls byte-identical");
});

test("IDF flag ON: full ids project to match keys with per-document dedup", () => {
  flagsOff();
  const bm25 = new Bm25Index();
  bm25.add({
    memory_id: "m1",
    content: "one",
    entities: ["person:mail:alice"],
  });
  bm25.add({
    memory_id: "m2",
    content: "two",
    entities: ["person:mail:alice", "person:telegram:alice"],
  });
  bm25.add({
    memory_id: "m3",
    content: "three",
    entities: ["person:telegram:alice"],
  });
  bm25.add({
    memory_id: "m4",
    content: "four",
    entities: ["project:git-log:example_repo"],
  });

  process.env.MEMORY_ENTITY_IDF_ENABLED = "1";
  const wiring = recall._prepareRecallEntityWiring(bm25);
  assert.equal(wiring.entityDfN, 4);
  assert.equal(
    wiring.entityDf.get("person:alice"),
    3,
    "m2 was double-counted across two source buckets",
  );
  assert.equal(wiring.entityDf.get("project:example_repo"), 1);
  assert.equal(wiring.entityDf.has("person:mail:alice"), false);
  assert.equal(wiring.entityDf.has("person:telegram:alice"), false);

  assert.deepEqual(
    recall._assertEntityDfKeyspace(wiring.entityDf, [
      "person:chat-claude-code:alice",
      "project:chat-claude-code:example_repo",
    ]),
    { unionKeys: 2, resolvedKeys: 2 },
  );

  const rare = score({
    candidateEntities: ["project:chat-claude-code:example_repo"],
    contextEntities: [
      "project:chat-claude-code:example_repo",
      "person:chat-claude-code:alice",
    ],
    wiring,
  });
  const legacy = entityOverlapJaccard(
    ["project:chat-claude-code:example_repo"],
    [
      "project:chat-claude-code:example_repo",
      "person:chat-claude-code:alice",
    ],
  );
  assert.notEqual(
    rare.entity_overlap_jaccard,
    legacy,
    "projected IDF remained uniform and silently reproduced Jaccard",
  );
  assert.ok(rare.entity_overlap_jaccard > legacy);
  console.log(
    `# IDF production hand-off: legacy=${legacy.toFixed(6)} weighted=${rare.entity_overlap_jaccard.toFixed(6)}`,
  );
});

test("IDF canary fails loud on the measured full-id key-space trap", () => {
  flagsOff();
  process.env.MEMORY_ENTITY_IDF_ENABLED = "1";
  const misKeyed = new Map([
    ["person:mail:alice", new Set(["m1"])],
    ["project:git-log:example_repo", new Set(["m2"])],
  ]);
  assert.throws(
    () => recall._assertEntityDfKeyspace(misKeyed, [
      "person:chat-claude-code:alice",
      "project:chat-claude-code:example_repo",
    ]),
    (err) =>
      err instanceof recall.EntityDfWiringError &&
      err.code === recall.ENTITY_DF_WIRING_ERROR.ZERO_RESOLVED_KEYS &&
      /resolved 0\/2 union keys/.test(err.message),
  );
  assert.throws(
    () => recall._prepareRecallEntityWiring({ size: () => 2 }),
    (err) =>
      err instanceof recall.EntityDfWiringError &&
      err.code === recall.ENTITY_DF_WIRING_ERROR.SOURCE_UNAVAILABLE,
  );
});

test("match-key lookup flag is independent; OFF bytes match exact lookup, ON reaches cross-source ids", () => {
  flagsOff();
  const queryId = "file:chat-claude-code:mcp/lib/tools/recall.js";
  const index = {
    entitiesByCanonicalId: new Map([
      ["file:git-log:mcp/lib/tools/recall.js", ["oldest", "middle", "newest"]],
    ]),
  };

  const derivesBefore = entityIndexInternal.matchKeyDeriveCount();
  const exact = lookupByEntity(index, queryId);
  const wiredOff = lookupByEntityMatchKey(index, queryId);
  assert.equal(
    Buffer.compare(
      Buffer.from(JSON.stringify(wiredOff)),
      Buffer.from(JSON.stringify(exact)),
    ),
    0,
  );
  assert.equal(entityIndexInternal.matchKeyDeriveCount(), derivesBefore);
  const offBucket = ["oldest", "middle", "newest"];
  assert.strictEqual(recall._orderEntityFallbackBucket(offBucket), offBucket);

  process.env.MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP = "1";
  assert.deepEqual(lookupByEntityMatchKey(index, queryId), [
    "oldest",
    "middle",
    "newest",
  ]);
  assert.deepEqual(recall._orderEntityFallbackBucket(offBucket), [
    "newest",
    "middle",
    "oldest",
  ]);
  // Neither of the other two resources is activated by the lookup flag.
  const independent = recall._prepareRecallEntityWiring(new Proxy({}, {
    get() { throw new Error("match-key-only arm touched BM25"); },
  }));
  assert.deepEqual(independent, {
    aliasOverlay: null,
    entityDf: null,
    entityDfN: null,
  });
});

test("alias flag is independent and changes the real score-time entity views", () => {
  flagsOff();
  const candidate = [OPERATOR_MAIL_ID];
  const context = [OPERATOR_GITHUB_ID];
  const off = score({ candidateEntities: candidate, contextEntities: context });
  assert.equal(off.entity_overlap_jaccard, 0);

  process.env.MEMORY_ENTITY_ALIAS_OVERLAY = "1";
  const wiring = recall._prepareRecallEntityWiring(new Proxy({}, {
    get() { throw new Error("alias-only arm touched BM25"); },
  }));
  assert.ok(wiring.aliasOverlay instanceof Map);
  assert.equal(wiring.entityDf, null);
  assert.equal(wiring.entityDfN, null);

  const candidateView = recall._resolveRecallEntityAliases(
    candidate,
    wiring.aliasOverlay,
  );
  const contextView = recall._resolveRecallEntityAliases(
    context,
    wiring.aliasOverlay,
  );
  assert.deepEqual(candidateView, ["person:operator"]);
  assert.deepEqual(contextView, ["person:operator"]);
  assert.deepEqual(candidate, [OPERATOR_MAIL_ID]);
  assert.deepEqual(context, [OPERATOR_GITHUB_ID]);

  const on = score({ candidateEntities: candidate, contextEntities: context, wiring });
  assert.equal(on.entity_overlap_jaccard, 1);
  assert.ok(on.final_score > off.final_score);
});

test("empty entity unions are no-signal, not a false canary failure", () => {
  flagsOff();
  assert.deepEqual(recall._assertEntityDfKeyspace(new Map(), []), {
    unionKeys: 0,
    resolvedKeys: 0,
  });
});
