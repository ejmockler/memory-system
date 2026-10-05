// entity-noise-blocklist.test.mjs — L8.
//
// Read-side entity-noise filter: conversational role labels
// (`person:<source>:user` / `:assistant`) and codex-cli conversation-id topics
// (`topic:<source>:<uuid>`) inflate the Jaccard denominator on the candidate
// side of `entity_overlap_jaccard` and dilute a 0.7-weighted feature. The
// ledger is append-only, so a producer-side fix cannot repair stored rows; the
// filter lives at read time behind a default-off env flag.
//
// HERMETIC: every input below is a literal in this file. Nothing under
// ledgers/, indices/, storage/ or connectors/ is read or written (the only
// file touched is an empty operator-identity config in a temp dir).
//
// Namespace imports (rather than named) are deliberate: they let this file
// LOAD before the implementation exists, so the RED run fails on real
// assertions with real messages instead of collapsing to one module-link
// SyntaxError.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// STOPWORDS folds in the operator's own tokens from the identity config, which
// is read once at module load. Pin an EMPTY identity before the library is
// imported (dynamic imports, so this assignment is not hoisted past) so the
// exact-membership assertion below does not depend on the host's configuration.
const IDENTITY_DIR = mkdtempSync(join(tmpdir(), "entity-noise-identity-"));
process.on("exit", () => {
  try { rmSync(IDENTITY_DIR, { recursive: true, force: true }); } catch {}
});
process.env.MEMORY_OPERATOR_IDENTITY_FILE = join(IDENTITY_DIR, "operator-identity.json");
writeFileSync(
  process.env.MEMORY_OPERATOR_IDENTITY_FILE,
  JSON.stringify({ schema: "operator-identity-config/v1" }),
);

const extractor = await import("../lib/synthesis/entity-extractor.js");
const scorer = await import("../lib/recall/multi-feature-score.js");

/** The literal env var name. Asserted against the module's frozen constant in
 *  the surface test below, so a rename cannot silently orphan these tests. */
const FLAG = "MEMORY_ENTITY_NOISE_FILTER";

/** Save/restore FLAG around fn so no test leaks flag state into another.
 *  `value === undefined` means "unset". */
function withFlag(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, FLAG);
  const saved = process.env[FLAG];
  try {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
    return fn();
  } finally {
    if (had) process.env[FLAG] = saved;
    else delete process.env[FLAG];
  }
}

const noise = (key) => extractor.isNoiseEntityMatchKey(key);
const jaccard = (a, b) => scorer.entityOverlapJaccard(a, b);
const stripped = (id) => scorer.entityMatchKey(id);

// Genuine (non-noise) entity ids, one per shape the filter must leave alone.
// Synthetic values; these must survive untouched.
const REAL_IDS = [
  "person:telegram:sam_sample",
  "person:telegram:example_team_x",
  "project:codex-cli:example_repo",
  "project:codex-cli:example_tool",
  "person:git-log:alex_example_com",
  "person:telegram:example_bot",
];

// Surfaces that merely CONTAIN or are PREFIXED BY a noise token. The match is
// on the whole slug, so none of these may be filtered.
const NEAR_MISS_IDS = [
  "person:telegram:username",
  "person:telegram:user_group",
  "topic:codex-cli:example_repo",
];

// Noise. The UUID slugs below are synthetic values of the shape the codex-cli
// connector emits: `topic:codex-cli:<8_4_4_4_12 underscore hex>`.
const NOISE_IDS = [
  "person:codex-cli:user",
  "person:codex-cli:assistant",
  "person:chat-claude-code:user",
  "person:chat-claude-code:assistant",
  "person:screentime:user",
  "topic:codex-cli:01900000_0000_7000_8000_000000000001",
];

// ---------------------------------------------------------------------------
// Exported surface + I5 containment.
// ---------------------------------------------------------------------------
test("new noise vocabulary is exported frozen and STOPWORDS is untouched", () => {
  assert.equal(
    typeof extractor.isNoiseEntityMatchKey,
    "function",
    "entity-extractor.js must export isNoiseEntityMatchKey",
  );
  assert.ok(
    extractor.ENTITY_NOISE_ROLE_SURFACES instanceof Set,
    "ENTITY_NOISE_ROLE_SURFACES must be a Set",
  );
  assert.equal(
    extractor.ENTITY_NOISE_ROLE_SURFACES.size,
    2,
    "ENTITY_NOISE_ROLE_SURFACES holds exactly 'user' and 'assistant'",
  );
  assert.ok(extractor.ENTITY_NOISE_ROLE_SURFACES.has("user"));
  assert.ok(extractor.ENTITY_NOISE_ROLE_SURFACES.has("assistant"));
  assert.ok(
    Object.isFrozen(extractor.ENTITY_NOISE_ROLE_SURFACES),
    "ENTITY_NOISE_ROLE_SURFACES must be frozen",
  );

  assert.ok(
    extractor.ENTITY_NOISE_UUID_SLUG_RE instanceof RegExp,
    "ENTITY_NOISE_UUID_SLUG_RE must be a RegExp",
  );
  assert.equal(
    extractor.ENTITY_NOISE_UUID_SLUG_RE.global,
    false,
    "regex must be non-global: a `g` flag carries lastIndex across .test() calls",
  );
  // Direct proof of the lastIndex hazard the non-global flag prevents.
  const sample = "01900000_0000_7000_8000_000000000002";
  assert.equal(extractor.ENTITY_NOISE_UUID_SLUG_RE.test(sample), true);
  assert.equal(
    extractor.ENTITY_NOISE_UUID_SLUG_RE.test(sample),
    true,
    "repeated .test() on identical input must not alternate",
  );
  // The sampled slug shape is also a legal entity slug under the existing regex.
  assert.equal(extractor.ENTITY_SLUG_REGEX.test(sample), true);
  // Hyphen-separated UUIDs are not a slug shape this system emits.
  assert.equal(
    extractor.ENTITY_NOISE_UUID_SLUG_RE.test("01900000-0000-7000-8000-000000000002"),
    false,
  );

  // ENTITY-SCHEMA I5 containment: STOPWORDS keeps its exact membership and the
  // new vocabulary is NOT smuggled into it.
  // 86 static members; the operator-derived tokens are empty under the pinned
  // empty identity above.
  assert.equal(extractor.STOPWORDS.size, 86, "STOPWORDS membership must not change");
  assert.equal(extractor.STOPWORDS.has("user"), false);
  assert.equal(extractor.STOPWORDS.has("assistant"), false);

  // The env-flag name the scorer reads.
  assert.equal(
    scorer.ENTITY_NOISE_FILTER_ENV?.ENABLED,
    FLAG,
    "multi-feature-score.js must export ENTITY_NOISE_FILTER_ENV.ENABLED === " + FLAG,
  );
});

// ---------------------------------------------------------------------------
// POSITIVE CONTROL — the most important test. Real signal survives.
// ---------------------------------------------------------------------------
test("POSITIVE CONTROL: real entities survive the filter and still score", () => {
  withFlag("1", () => {
    for (const id of REAL_IDS) {
      const key = stripped(id);
      assert.notEqual(key, null, `${id} must produce a match key`);
      assert.equal(
        noise(key),
        false,
        `${id} -> ${key} must NOT be classified as noise`,
      );
      assert.equal(
        jaccard([id], [id]),
        1,
        `${id} must still self-match with the filter ON`,
      );
    }
    // As a set, on both sides, with the filter ON.
    assert.equal(jaccard(REAL_IDS, REAL_IDS), 1);
    // And a single shared real entity out of the whole set is still non-zero.
    const one = jaccard(REAL_IDS, ["project:codex-cli:example_repo"]);
    assert.ok(one > 0, "a shared real entity must still yield non-zero overlap");
    assert.equal(one, 1 / REAL_IDS.length);
  });
});

test("POSITIVE CONTROL: whole-slug match only — near misses are not filtered", () => {
  withFlag("1", () => {
    for (const id of NEAR_MISS_IDS) {
      const key = stripped(id);
      assert.equal(
        noise(key),
        false,
        `${id} -> ${key} must survive: the match is on the whole slug, never a prefix or substring`,
      );
      assert.equal(jaccard([id], [id]), 1, `${id} must still self-match`);
    }
    // The role surfaces are noise only under kind `person`; the UUID shape is
    // noise only under kind `topic`. Cross-kind pairings survive.
    assert.equal(noise("topic:user"), false);
    assert.equal(noise("project:assistant"), false);
    assert.equal(
      noise("person:01900000_0000_7000_8000_000000000001"),
      false,
      "a UUID slug under kind person is not in scope for this filter",
    );
    // Case: slugs are lowercase by construction; an uppercase role label is
    // not a slug this pipeline emits and is not matched.
    assert.equal(noise("person:User"), false);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL — the measured noise is dropped from BOTH key sets.
// ---------------------------------------------------------------------------
test("NEGATIVE CONTROL: role labels and uuid topics are filtered when the flag is ON", () => {
  withFlag("1", () => {
    for (const id of NOISE_IDS) {
      const key = stripped(id);
      assert.equal(noise(key), true, `${id} -> ${key} must be classified as noise`);
      // Dropped from the candidate set...
      assert.equal(
        jaccard([id, "project:codex-cli:example_repo"], ["project:codex-cli:example_repo"]),
        1,
        `${id} must be dropped from the candidate key set`,
      );
      // ...and from the context set: the filter is symmetric.
      assert.equal(
        jaccard(["project:codex-cli:example_repo"], [id, "project:codex-cli:example_repo"]),
        1,
        `${id} must be dropped from the context key set too`,
      );
    }
    // A whole noise set on one side leaves nothing to intersect.
    assert.equal(jaccard(NOISE_IDS, ["project:codex-cli:example_repo"]), 0);
  });
});

// ---------------------------------------------------------------------------
// FLAG-OFF BIT-IDENTITY.
// ---------------------------------------------------------------------------
//
// Mixed noise+signal worked case:
//   A keys = {person:user, person:assistant, topic:01900000_..., project:example_repo,
//             person:sam_sample}                              -> |A| = 5
//   B keys = {project:example_repo, person:sam_sample, person:user} -> |B| = 3
//   |A n B| = 3, union = 5 + 3 - 3 = 5  ->  3/5
const MIXED_CANDIDATE = [
  "person:codex-cli:user",
  "person:codex-cli:assistant",
  "topic:codex-cli:01900000_0000_7000_8000_000000000001",
  "project:codex-cli:example_repo",
  "person:telegram:sam_sample",
];
const MIXED_CONTEXT = [
  "project:codex-cli:example_repo",
  "person:telegram:sam_sample",
  "person:codex-cli:user",
];
const MIXED_OFF_EXPECTED = 3 / 5;

test("FLAG-OFF is bit-identical: only the exact string '1' enables the filter", () => {
  for (const value of [undefined, "0", "", "true", "yes", "TRUE", "01", " 1"]) {
    withFlag(value, () => {
      assert.equal(
        jaccard(MIXED_CANDIDATE, MIXED_CONTEXT),
        MIXED_OFF_EXPECTED,
        `flag=${JSON.stringify(value)} must leave the score bit-identical (noise still counted)`,
      );
    });
  }
  withFlag("1", () => {
    // Same input, filter ON: both noise keys leave both sides.
    assert.equal(jaccard(MIXED_CANDIDATE, MIXED_CONTEXT), 1);
  });
});

test("the flag is read at CALL time, never cached at module load", () => {
  withFlag(undefined, () => {
    assert.equal(jaccard(MIXED_CANDIDATE, MIXED_CONTEXT), MIXED_OFF_EXPECTED);
    process.env[FLAG] = "1";
    assert.equal(jaccard(MIXED_CANDIDATE, MIXED_CONTEXT), 1);
    process.env[FLAG] = "0";
    assert.equal(jaccard(MIXED_CANDIDATE, MIXED_CONTEXT), MIXED_OFF_EXPECTED);
  });
});

// ---------------------------------------------------------------------------
// MONOTONICITY — the worked case from the node spec.
// ---------------------------------------------------------------------------
test("MONOTONICITY: filtering noise strictly raises overlap on the worked case", () => {
  const candidate = [
    "person:codex-cli:user",
    "person:codex-cli:assistant",
    "project:codex-cli:example_repo",
  ];
  const context = ["project:codex-cli:example_repo"];

  const off = withFlag(undefined, () => jaccard(candidate, context));
  const on = withFlag("1", () => jaccard(candidate, context));

  assert.equal(off, 1 / 3, "OFF: |A|=3, |B|=1, inter=1, union=3 -> 1/3");
  assert.equal(on, 1, "ON: |A|=1, |B|=1, inter=1, union=1 -> 1");
  assert.ok(on > off, "the filter must strictly raise this score");
  for (const v of [off, on]) {
    assert.ok(v >= 0 && v <= 1, "Jaccard must stay in [0,1]");
  }
});

// ---------------------------------------------------------------------------
// QUERY-SIDE REACHABILITY — measured, not argued.
// ---------------------------------------------------------------------------
//
// An earlier revision of this file asserted in a comment that noise on the
// QUERY side was unreachable. That was a claim, not a measurement, and it is
// false. `harvestHashtags` (lib/synthesis/entity-extractor.js, the regex
// `/(?<![A-Za-z0-9_])#([A-Za-z][A-Za-z0-9_]{2,63})\b/g`) admits a full
// underscore-hex conversation-id slug as a `topic` whenever its first nibble is
// a letter. The three cases below are the outputs measured in this session by
// calling extractEntities directly; they are asserted here so the reachability
// claim is a test rather than prose.
test("QUERY-SIDE REACHABILITY: a hashtag can emit a bare uuid topic", () => {
  const opts = { source: "chat-claude-code" };
  const ids = (text) =>
    extractor.extractEntities(text, opts).entities.map((e) => e.canonical_id);

  // (1) a-f-leading uuid: REACHABLE. Measured this session.
  assert.deepEqual(
    ids("recap of #cafebabe_0000_4000_8000_000000000001"),
    ["topic:chat-claude-code:cafebabe_0000_4000_8000_000000000001"],
    "a hashtag whose slug is an a-f-leading uuid reaches the query side as a topic",
  );
  // ...and that emitted key is exactly what this filter classifies as noise.
  assert.equal(noise(stripped("topic:chat-claude-code:cafebabe_0000_4000_8000_000000000001")), true);

  // (2) digit-leading uuid: NOT reachable — the hashtag charset requires a
  // LEADING LETTER (`[A-Za-z]` then `[A-Za-z0-9_]{2,63}`). Measured this session.
  assert.deepEqual(ids("recap of #01900000_0000_7000_8000_000000000002"), []);

  // (3) an email keeps the FULL address as its surface, so `user@example.com`
  // yields `person:...:user_example_com`, never a bare `person:user`. Measured
  // this session.
  assert.deepEqual(
    ids("mail from user@example.com"),
    ["person:chat-claude-code:user_example_com"],
  );
  assert.equal(noise("person:user_example_com"), false);
});

// ---------------------------------------------------------------------------
// INVARIANT 5 — the filter must never turn a non-zero into a zero, nor a zero
// into a non-zero.
// ---------------------------------------------------------------------------
//
// The rule that makes this structural: a noise key is dropped ONLY when it
// appears in exactly one of the two key sets. The intersection is therefore
// bit-identical between flag states, and only union-only members are removed.
//
// df/N below are literals chosen for this test; they are not measured ledger
// statistics and are not claimed to be.
const INV5_DF = new Map([
  ["person:user", 900],
  ["project:example_repo", 40],
  ["project:x", 30],
  ["project:otherproj", 25],
]);
const INV5_N = 1000;
const idf = (a, b) => scorer.entityOverlapIdf(a, b, INV5_DF, INV5_N);

test("INVARIANT 5: shared noise in the intersection is retained, not collapsed to 0", () => {
  // The reviewer's refutation case. BOTH sides carry a real non-noise entity,
  // and their only shared key is a noise key. Dropping it destroyed the score.
  const candidate = ["person:codex-cli:user", "project:codex-cli:example_repo"];
  const context = ["person:chat-claude-code:user", "project:codex-cli:otherproj"];

  const offJ = withFlag(undefined, () => jaccard(candidate, context));
  const onJ = withFlag("1", () => jaccard(candidate, context));
  assert.equal(offJ, 1 / 3, "OFF: |A|=2, |B|=2, inter={person:user}=1, union=3");
  assert.equal(
    onJ,
    1 / 3,
    "ON must equal OFF: person:user is in the INTERSECTION, so it is not dropped",
  );

  const offI = withFlag(undefined, () => idf(candidate, context));
  const onI = withFlag("1", () => idf(candidate, context));
  assert.ok(offI > 0, "OFF: the weighted path scores non-zero");
  assert.equal(onI, offI, "the idf path carries the identical rule, not a delegation");
  assert.ok(onI > 0, "a non-zero must never collapse to zero");
});

test("INVARIANT 5: general monotonicity — ON is never below OFF", () => {
  // The second break, unnamed in wave 1: OFF 2/3 -> ON 1/2 under the old rule.
  const candidate = [
    "person:codex-cli:user",
    "project:codex-cli:example_repo",
    "project:codex-cli:x",
  ];
  const context = ["person:chat-claude-code:user", "project:codex-cli:example_repo"];

  const offJ = withFlag(undefined, () => jaccard(candidate, context));
  const onJ = withFlag("1", () => jaccard(candidate, context));
  assert.equal(offJ, 2 / 3);
  assert.ok(onJ >= offJ, `ON (${onJ}) must not be below OFF (${offJ})`);
  assert.equal(onJ, 2 / 3, "person:user is shared, so nothing is dropped");

  const offI = withFlag(undefined, () => idf(candidate, context));
  const onI = withFlag("1", () => idf(candidate, context));
  assert.ok(onI >= offI, `idf ON (${onI}) must not be below OFF (${offI})`);
});

const CAFEBABE = "cafebabe_0000_4000_8000_000000000001";

test("INVARIANT 5: a uuid topic shared across sources still matches", () => {
  // Reachable in practice: the query side emits this exact key from a hashtag
  // (see QUERY-SIDE REACHABILITY above), and a codex-cli row carries it from
  // its conversation id. Source-stripping makes them the same key.
  const candidate = [`topic:codex-cli:${CAFEBABE}`, "project:codex-cli:example_repo"];
  const context = [`topic:chat-claude-code:${CAFEBABE}`];

  const off = withFlag(undefined, () => jaccard(candidate, context));
  const on = withFlag("1", () => jaccard(candidate, context));
  assert.equal(off, 1 / 2);
  assert.ok(on >= off, `ON (${on}) must not be below OFF (${off})`);
  assert.ok(on > 0, "the shared uuid is the whole signal here; it must not vanish");

  const dfU = new Map([[`topic:${CAFEBABE}`, 120], ["project:example_repo", 40]]);
  const offI = withFlag(undefined, () => scorer.entityOverlapIdf(candidate, context, dfU, 1000));
  const onI = withFlag("1", () => scorer.entityOverlapIdf(candidate, context, dfU, 1000));
  assert.ok(offI > 0);
  assert.ok(onI >= offI, `idf ON (${onI}) must not be below OFF (${offI})`);
  assert.ok(onI > 0);
});

// ---------------------------------------------------------------------------
// EXHAUSTIVE PROPERTY — the invariant as a closed proof, not a spot check.
// ---------------------------------------------------------------------------
//
// 2^4 x 2^4 = 256 candidate/context subset pairs over an alphabet containing
// both noise kinds and two real entities. Every pair is checked against BOTH
// overlap functions. This is what would have caught wave 1.
test("EXHAUSTIVE: over all 256 subset pairs, ON >= OFF and zero-ness is preserved", () => {
  const ALPHABET = [
    "person:codex-cli:user",
    `topic:codex-cli:${CAFEBABE}`,
    "project:codex-cli:example_repo",
    "project:codex-cli:x",
  ];
  const df = new Map([
    ["person:user", 900],
    [`topic:${CAFEBABE}`, 120],
    ["project:example_repo", 40],
    ["project:x", 30],
  ]);
  const N = 1000;

  const subsets = [];
  for (let mask = 0; mask < 1 << ALPHABET.length; mask++) {
    const s = [];
    for (let i = 0; i < ALPHABET.length; i++) {
      if (mask & (1 << i)) s.push(ALPHABET[i]);
    }
    subsets.push(s);
  }
  assert.equal(subsets.length, 16);

  const fns = [
    ["entityOverlapJaccard", (a, b) => scorer.entityOverlapJaccard(a, b)],
    ["entityOverlapIdf", (a, b) => scorer.entityOverlapIdf(a, b, df, N)],
  ];

  let pairs = 0;
  for (const cand of subsets) {
    for (const ctx of subsets) {
      pairs++;
      for (const [name, fn] of fns) {
        const off = withFlag(undefined, () => fn(cand, ctx));
        const on = withFlag("1", () => fn(cand, ctx));
        const where = `${name} cand=${JSON.stringify(cand)} ctx=${JSON.stringify(ctx)}`;
        assert.ok(off >= 0 && off <= 1, `OFF out of [0,1]: ${where}`);
        assert.ok(on >= 0 && on <= 1, `ON out of [0,1]: ${where}`);
        assert.ok(on >= off, `ON ${on} < OFF ${off}: ${where}`);
        assert.equal(
          on === 0,
          off === 0,
          `zero-ness must be preserved (ON ${on}, OFF ${off}): ${where}`,
        );
      }
    }
  }
  assert.equal(pairs, 256, "the enumeration must be exhaustive");
});

// ---------------------------------------------------------------------------
// SYMMETRY AND RANGE.
// ---------------------------------------------------------------------------
test("SYMMETRY: the filter applies to both sides and can never exceed 1", () => {
  const bothSides = ["person:codex-cli:user", "project:codex-cli:example_repo"];
  const off = withFlag(undefined, () => jaccard(bothSides, bothSides));
  const on = withFlag("1", () => jaccard(bothSides, bothSides));
  for (const v of [off, on]) {
    assert.ok(v >= 0 && v <= 1, "Jaccard must stay in [0,1] in both flag states");
  }
  assert.equal(off, 1);
  assert.equal(on, 1, "the surviving real key still matches on both sides");

  // Noise present on BOTH sides is RETAINED: the key is in the intersection,
  // so dropping it would shrink the intersection and lower the score, which is
  // exactly the invariant breach the asymmetry rule exists to prevent.
  const pureNoiseOff = withFlag(undefined, () =>
    jaccard(["person:codex-cli:user"], ["person:chat-claude-code:user"]),
  );
  const pureNoiseOn = withFlag("1", () =>
    jaccard(["person:codex-cli:user"], ["person:chat-claude-code:user"]),
  );
  assert.equal(pureNoiseOff, 1, "OFF: both sides normalize to person:user");
  assert.equal(pureNoiseOn, 1, "ON: the shared key is in the intersection, so it is kept");
  assert.ok(pureNoiseOn >= 0 && pureNoiseOn <= 1);
});

// ---------------------------------------------------------------------------
// NO-REGRESSION FLOOR.
// ---------------------------------------------------------------------------
test("NO-REGRESSION FLOOR: an all-noise candidate scores 0 in both flag states", () => {
  const context = ["project:codex-cli:example_repo", "person:telegram:sam_sample"];
  const off = withFlag(undefined, () => jaccard(NOISE_IDS, context));
  const on = withFlag("1", () => jaccard(NOISE_IDS, context));
  assert.equal(off, 0, "OFF: no key intersects -> 0");
  assert.equal(on, 0, "ON: the candidate key set empties -> 0");

  // The filter can only REMOVE keys, so an intersection that was empty stays
  // empty: no candidate that scored 0 can score above 0 after.
  const zeroBefore = [
    "person:codex-cli:user",
    "project:codex-cli:example_tool",
  ];
  const disjoint = ["person:git-log:alex_example_com"];
  assert.equal(withFlag(undefined, () => jaccard(zeroBefore, disjoint)), 0);
  assert.equal(withFlag("1", () => jaccard(zeroBefore, disjoint)), 0);
});

// ---------------------------------------------------------------------------
// PATH AGREEMENT — entityOverlapIdf must not disagree with entityOverlapJaccard
// about the flag, including via its early delegation when df is unusable.
// ---------------------------------------------------------------------------
test("PATH AGREEMENT: entityOverlapIdf honours the flag on both of its paths", () => {
  const candidate = [
    "person:codex-cli:user",
    "person:codex-cli:assistant",
    "project:codex-cli:example_repo",
  ];
  const context = ["project:codex-cli:example_repo"];

  // (a) Invalid entity_df_n -> delegates to entityOverlapJaccard.
  withFlag(undefined, () => {
    assert.equal(scorer.entityOverlapIdf(candidate, context, null, 0), 1 / 3);
  });
  withFlag("1", () => {
    assert.equal(
      scorer.entityOverlapIdf(candidate, context, null, 0),
      1,
      "the delegating path must forward the flag, not silently lose it",
    );
  });

  // (b) Valid df -> weighted path. With every noise key filtered, the only
  // surviving key is present on both sides, so the weighted ratio is exactly 1.
  const df = new Map([
    ["person:user", 900],
    ["person:assistant", 900],
    ["project:example_repo", 3],
  ]);
  withFlag("1", () => {
    const v = scorer.entityOverlapIdf(candidate, context, df, 1000);
    assert.equal(v, 1);
  });
  withFlag(undefined, () => {
    const v = scorer.entityOverlapIdf(candidate, context, df, 1000);
    assert.ok(v > 0 && v < 1, "OFF: the common role keys still dilute the union");
  });
});

// ---------------------------------------------------------------------------
// PURITY.
// ---------------------------------------------------------------------------
test("PURITY: isNoiseEntityMatchKey is deterministic and total", () => {
  for (const key of [
    "person:user",
    "person:assistant",
    "topic:01900000_0000_7000_8000_000000000001",
    "person:sam_sample",
    "project:example_repo",
  ]) {
    assert.equal(noise(key), noise(key), `${key} must be deterministic`);
  }

  for (const bad of [null, undefined, "", 123, "noleadingcolon", {}, [], NaN, true]) {
    assert.equal(
      noise(bad),
      false,
      `${String(bad)} must return false, not throw`,
    );
  }

  // Split on the FIRST ':' only, so a slug containing ':' survives intact.
  assert.equal(noise("person:user:extra"), false);
  assert.equal(noise("person:"), false);
  assert.equal(noise(":user"), false);
});

// ---------------------------------------------------------------------------
// BOUNDED RETENTION — the filter introduces no growing collection.
// ---------------------------------------------------------------------------
test("BOUNDED RETENTION: 50k ids with the filter ON stay under a 64 MB heap delta", () => {
  const LIMIT_BYTES = 64 * 1024 * 1024;
  const N = 50_000;
  const candidate = new Array(N);
  for (let i = 0; i < N; i++) {
    const m = i % 4;
    if (m === 0) candidate[i] = "person:codex-cli:user";
    else if (m === 1) candidate[i] = "person:codex-cli:assistant";
    else if (m === 2) {
      const hex = i.toString(16).padStart(8, "0");
      candidate[i] = `topic:codex-cli:${hex}_0000_7000_8000_000000000002`;
    } else candidate[i] = `project:codex-cli:repo_${i}`;
  }
  const context = ["project:codex-cli:repo_3", "person:telegram:sam_sample"];

  withFlag("1", () => {
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const value = scorer.entityOverlapJaccard(candidate, context);
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    const delta = after - before;

    assert.ok(Number.isFinite(value), "the computation must complete");
    assert.ok(value >= 0 && value <= 1, "and stay in [0,1]");
    console.log(
      `# BOUNDED RETENTION: n=${N} heapUsed delta = ${delta} bytes ` +
        `(${(delta / (1024 * 1024)).toFixed(2)} MiB), limit ` +
        `${LIMIT_BYTES} bytes; jaccard=${value}`,
    );
    assert.ok(
      delta < LIMIT_BYTES,
      `heapUsed grew ${delta} bytes across the call, over the ${LIMIT_BYTES} byte bound`,
    );
  });
});
