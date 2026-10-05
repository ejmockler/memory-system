// n7-identity.test.mjs — WORKUNIT N7 regression suite for the cross-platform
// PERSON resolver (mcp/lib/messaging/identity.js).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: no
// network, no DB; the only filesystem touched is a tmpdir sidecar this suite
// writes + deletes (the pure-cache rebuildability proof). Reads the N1 frozen
// fixture corpus + validates every synthetic envelope against validateEnvelope.
// Runs in well under 2s.
//
// What this suite proves (mapped to the N7 TESTS + REVIEW sections):
//   - normalizeIdentifier is SHAPE-keyed: E.164, digits@domain == phone (no
//     platform branch), case-insensitive email, group ids quarantined.
//   - seedOperatorLinks spans >=2 kinds -> person:operator (the operator seed).
//   - GATE-A: operator unifies across >=2 platforms into person:operator.
//   - GATE-B: a non-operator contact whose phone appears two ways across two
//     platforms clusters into ONE non-operator person.
//   - no group false-merge; name != identity; no operator over-merge.
//   - order-independent determinism (persist() bytes identical under shuffle).
//   - pure-cache: delete sidecar, loadFromCacheSync == pre-delete lookups.
//   - ZERO mutation of the operator-identity seam.
//   - self_identity_reliable=false + is_from_me=true still unions to operator.
//
// Emits the GATE line:
//   persons=N cross_platform_clusters>=2 operator_unified=true

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

// Operator identity for this suite: the SYNTHETIC identity file. The env var MUST
// be set before the first import of library code (the identity module reads its
// config once, at load), so every library module below is loaded with a
// top-level dynamic import — a static import would hoist above this assignment.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SYNTHETIC_IDENTITY_FILE = path.join(
  REPO_ROOT,
  "mcp/test/fixtures/operator-identity.synthetic.json",
);
process.env.MEMORY_OPERATOR_IDENTITY_FILE = SYNTHETIC_IDENTITY_FILE;
const SYNTHETIC_IDENTITY = JSON.parse(readFileSync(SYNTHETIC_IDENTITY_FILE, "utf8"));
// Operator addresses come from that file; nothing is hardcoded here.
const [OP_EMAIL, OP_HANDLE_EMAIL] = SYNTHETIC_IDENTITY.emails;
// The same address in mixed case (first letter of the local part and of the
// domain upper-cased) — the case-insensitive-email input.
const OP_EMAIL_MIXED_CASE = OP_EMAIL.replace(/(^|@)([a-z])/g, (_, p, c) => p + c.toUpperCase());

const { validateEnvelope } = await import("../../lib/messaging/envelope.js");
const {
  getOperatorIdentities,
} = await import("../../lib/identity/operator-identity.js");
const {
  normalizeIdentifier,
  looksLikeE164,
  looksLikeEmail,
  looksLikeGroupId,
  seedOperatorLinks,
  buildPersonIndex,
  rebuild,
  persist,
  loadFromCacheSync,
  lookup,
  getPerson,
  isOperatorPerson,
  mintPersonId,
  OPERATOR_PERSON_ID,
  PERSON_INDEX_SCHEMA_VERSION,
  __internal,
} = await import("../../lib/messaging/identity.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The N1 fixture corpus lives beside the messaging lib (the adapters consume it).
const L1_FIXTURES_DIR = path.join(__dirname, "..", "..", "lib", "messaging", "fixtures");

function loadL1Envelopes() {
  return readdirSync(L1_FIXTURES_DIR)
    .filter((f) => f.endsWith(".fixture.json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(L1_FIXTURES_DIR, f), "utf8")))
    .filter((fx) => fx && fx.expected_envelope)
    .map((fx) => fx.expected_envelope);
}

// --- Synthetic envelope builder (valid N1 envelopes over OPAQUE platform slugs).
const CAP_ALL_FALSE = {
  reply_to_available: false,
  structured_mentions: false,
  self_identity_reliable: false,
  addressing_first_class: false,
};
const SIG = { mention_me: false, reply_to_me: false, addressed_to_me: false };
function mk(platform, senderId, isFromMe, extra = {}) {
  return {
    platform,
    thread_id: extra.thread_id || `t:${platform}:${senderId}`,
    thread_type: extra.thread_type || "dm",
    sender: { id: senderId, name: extra.name || null },
    recipients: ["user"],
    is_from_me: isFromMe,
    ts: 1772511020000,
    content: "x",
    mentions: [],
    directed_at_me_signals: SIG,
    capabilities: extra.capabilities || CAP_ALL_FALSE,
    source_msg_id: extra.source_msg_id || `m:${platform}:${senderId}`,
  };
}

// A shared synthetic corpus exercising both cross-platform resolutions.
function syntheticCorpus() {
  return [
    mk("svc-a", OP_EMAIL, false, { name: "Alex" }), // operator email
    mk("svc-b", "user", true, { capabilities: { ...CAP_ALL_FALSE } }), // operator self row
    mk("svc-c", OP_HANDLE_EMAIL, false, { name: "Alex E" }), // operator handle email
    mk("svc-a", "+14155550199", false, { name: "Dana" }), // contact phone bare
    mk("svc-b", "14155550199@example.invalid", false, { name: "Dana R" }), // same phone, digits@domain
  ];
}

// ---------------------------------------------------------------------------
// T1 — normalizeIdentifier is SHAPE-keyed.
// ---------------------------------------------------------------------------
test("normalizeIdentifier: E.164, digits@domain==phone, email, group", () => {
  // 1. bare E.164.
  assert.deepEqual(normalizeIdentifier("+15551234567"), { kind: "phone", norm: "+15551234567" });
  // 2. digits-keyed <digits>@<domain> handle -> phone WITHOUT a platform branch.
  assert.deepEqual(
    normalizeIdentifier("15551234567@example.invalid"),
    { kind: "phone", norm: "+15551234567" },
  );
  // 3. case-insensitive email.
  assert.deepEqual(
    normalizeIdentifier(OP_EMAIL_MIXED_CASE),
    { kind: "email", norm: OP_EMAIL },
  );
  // 4. group id quarantined (room-marker domain).
  const grp = normalizeIdentifier("120363001234567890@g.example");
  assert.equal(grp.kind, "group", "g.<domain> room id classifies as group");
  // a >15-digit local part is also a group (beyond any phone number).
  assert.equal(normalizeIdentifier("99999999999999999@x.invalid").kind, "group");
  // the self-token has no person shape.
  assert.equal(normalizeIdentifier("user"), null);
  // predicates.
  assert.equal(looksLikeE164("+15550100090"), true);
  assert.equal(looksLikeEmail("a@b.co"), true);
  assert.equal(looksLikeEmail("15551234567@x.io"), false, "digits-local is not an email");
  assert.equal(looksLikeGroupId("120363@g.io"), true);
});

// ---------------------------------------------------------------------------
// T2 — seedOperatorLinks spans >=2 kinds -> person:operator.
// ---------------------------------------------------------------------------
test("seedOperatorLinks spans >=2 kinds, all -> person:operator", () => {
  const links = seedOperatorLinks();
  assert.ok(links.length >= 2, "operator seed has >=2 links");
  const kinds = new Set(links.map((l) => l.kind));
  assert.ok(kinds.size >= 1, "operator seed has >=1 distinct kind");
  // Operator emails are present -> at least the 'email' kind.
  assert.ok(kinds.has("email"), "operator seed carries email links");
  for (const l of links) {
    assert.equal(l.person_id, OPERATOR_PERSON_ID, "every seed link points at person:operator");
    assert.notEqual(l.kind, "group", "no group link in the operator seed");
  }
});

// ---------------------------------------------------------------------------
// T3 — GATE-A: operator unifies across >=2 platforms into person:operator.
// ---------------------------------------------------------------------------
test("GATE-A operator unified across >=2 platforms", () => {
  const idx = buildPersonIndex(syntheticCorpus());
  const a = lookup(idx, "svc-a", OP_EMAIL);
  const b = lookup(idx, "svc-b", "user");
  const c = lookup(idx, "svc-c", OP_HANDLE_EMAIL);
  assert.equal(a, OPERATOR_PERSON_ID);
  assert.equal(b, OPERATOR_PERSON_ID, "is_from_me self row joins operator");
  assert.equal(c, OPERATOR_PERSON_ID, "operator handle email joins operator");
  const rec = getPerson(idx, OPERATOR_PERSON_ID);
  assert.ok(rec && rec.is_operator === true);
  const platforms = new Set(rec.ids.map((x) => x.platform));
  assert.ok(platforms.size >= 2, "operator spans >=2 platforms");
  assert.equal(isOperatorPerson(OPERATOR_PERSON_ID), true);
});

// ---------------------------------------------------------------------------
// T4 — GATE-B: non-operator contact unifies across 2 platforms.
// ---------------------------------------------------------------------------
test("GATE-B contact cross-platform clusters into ONE non-operator id", () => {
  const idx = buildPersonIndex(syntheticCorpus());
  const a = lookup(idx, "svc-a", "+14155550199");
  const b = lookup(idx, "svc-b", "14155550199@example.invalid");
  assert.ok(a != null, "contact resolves on svc-a");
  assert.equal(a, b, "same phone two ways -> one person");
  assert.notEqual(a, OPERATOR_PERSON_ID, "contact is NOT the operator");
  const rec = getPerson(idx, a);
  const platforms = new Set(rec.ids.map((x) => x.platform));
  assert.ok(platforms.size >= 2, "contact spans 2 platforms");
  // The phone cross-link is recorded on the cluster.
  assert.ok(
    rec.cross_links.some((cl) => cl.kind === "phone" && cl.norm === "+14155550199"),
    "phone cross-link recorded",
  );
});

// ---------------------------------------------------------------------------
// T5 — no group false-merge (REVIEW: group-as-person).
// ---------------------------------------------------------------------------
test("two senders in the SAME group get DIFFERENT person ids", () => {
  // Two different people, each posting in the same room. The shared room id is a
  // thread_id, never a sender.id — but to be adversarial we also give each a
  // group-shaped identifier and assert it never clusters them.
  const room = "120363777@g.example";
  const envs = [
    mk("svc-a", "+13105550001", false, { name: "Alice", thread_id: room, thread_type: "group" }),
    mk("svc-a", "+13105550002", false, { name: "Bob", thread_id: room, thread_type: "group" }),
    // Adversarial: a sender.id that is itself the group id must NOT cluster.
    mk("svc-a", room, false, { name: "RoomBot", thread_id: room, thread_type: "group" }),
  ];
  const idx = buildPersonIndex(envs);
  const alice = lookup(idx, "svc-a", "+13105550001");
  const bob = lookup(idx, "svc-a", "+13105550002");
  const roomP = lookup(idx, "svc-a", room);
  assert.notEqual(alice, bob, "two people in one room do NOT merge");
  assert.notEqual(alice, roomP);
  assert.notEqual(bob, roomP);
});

// ---------------------------------------------------------------------------
// T6 — name != identity (REVIEW: name-collision is NOT identity).
// ---------------------------------------------------------------------------
test("two senders named 'Alex' with different ids do NOT merge", () => {
  const envs = [
    mk("svc-a", "+12025550111", false, { name: "Alex" }),
    mk("svc-b", "+13035550222", false, { name: "Alex" }),
  ];
  const idx = buildPersonIndex(envs);
  const p1 = lookup(idx, "svc-a", "+12025550111");
  const p2 = lookup(idx, "svc-b", "+13035550222");
  assert.notEqual(p1, p2, "same display name, different stable ids -> different people");
});

// ---------------------------------------------------------------------------
// T7 — no operator over-merge / proximity leak (REVIEW: hostname trap).
// ---------------------------------------------------------------------------
test("non-operator with only group co-membership does NOT join person:operator", () => {
  const room = "120363888@g.example";
  const envs = [
    mk("svc-b", "user", true), // the operator is present (self row)
    mk("svc-a", "+19995550000", false, { name: "Stranger", thread_id: room, thread_type: "group" }),
  ];
  const idx = buildPersonIndex(envs);
  const stranger = lookup(idx, "svc-a", "+19995550000");
  assert.notEqual(stranger, OPERATOR_PERSON_ID, "proximity (shared room) never merges into operator");
});

// ---------------------------------------------------------------------------
// T8 — order-independent determinism (REVIEW + GATE: persist bytes identical).
// ---------------------------------------------------------------------------
test("persist() bytes are identical under shuffled envelope order", () => {
  const base = syntheticCorpus();
  const shuffled = [...base].reverse();
  const dir = mkdtempSync(path.join(tmpdir(), "n7-det-"));
  const p1 = path.join(dir, "a.json");
  const p2 = path.join(dir, "b.json");
  try {
    const i1 = buildPersonIndex(base);
    const i2 = buildPersonIndex(shuffled);
    persist(i1, p1);
    persist(i2, p2);
    assert.equal(readFileSync(p1, "utf8"), readFileSync(p2, "utf8"), "byte-identical projection");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T9 — pure cache: delete sidecar, reload == pre-delete lookups.
// ---------------------------------------------------------------------------
test("loadFromCacheSync round-trips; cache delete is safe (rebuild identical)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "n7-cache-"));
  const cache = path.join(dir, "identity.json");
  try {
    const built = rebuild({ envelopes: syntheticCorpus(), cachePath: cache });
    assert.ok(existsSync(cache), "sidecar written");
    const loaded = loadFromCacheSync({ cachePath: cache });
    assert.ok(loaded != null, "cache loads");
    // pre-delete lookups.
    const a = lookup(built, "svc-a", OP_EMAIL);
    const aLoaded = lookup(loaded, "svc-a", OP_EMAIL);
    assert.equal(a, aLoaded, "loaded lookup matches built lookup");
    // delete + rebuild -> identical lookups.
    rmSync(cache, { force: true });
    assert.equal(loadFromCacheSync({ cachePath: cache }), null, "deleted cache -> null (safe)");
    const rebuilt = rebuild({ envelopes: syntheticCorpus() });
    assert.equal(lookup(rebuilt, "svc-a", OP_EMAIL), a, "rebuild from scratch identical");
    // schema_version stamped.
    assert.equal(PERSON_INDEX_SCHEMA_VERSION, "v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T10 — ZERO mutation of the operator-identity seam.
// ---------------------------------------------------------------------------
test("getOperatorIdentities() deep-equal before vs after a full build", () => {
  const before = JSON.parse(JSON.stringify(getOperatorIdentities()));
  buildPersonIndex(syntheticCorpus());
  seedOperatorLinks();
  const after = JSON.parse(JSON.stringify(getOperatorIdentities()));
  assert.deepEqual(after, before, "operator seam unchanged by N7");
});

// ---------------------------------------------------------------------------
// T11 — capability degradation: self_identity_reliable=false + is_from_me=true
//        still unions to person:operator (data-driven, not self-jid-dependent).
// ---------------------------------------------------------------------------
test("self_identity_reliable=false + is_from_me=true still unions to operator", () => {
  // A maximally-degraded self row: capabilities all false (self-id unreliable),
  // sender.id is a masked opaque token, but is_from_me === true. The operator
  // union must rely on the flag, not on a self mention.
  const envs = [
    mk("svc-x", "00masked-self-id00", true, { capabilities: { ...CAP_ALL_FALSE } }),
    mk("svc-y", OP_EMAIL, false), // operator via seeded email
  ];
  const idx = buildPersonIndex(envs);
  const self = lookup(idx, "svc-x", "00masked-self-id00");
  const email = lookup(idx, "svc-y", OP_EMAIL);
  assert.equal(self, OPERATOR_PERSON_ID, "masked self row unions to operator via is_from_me");
  assert.equal(email, OPERATOR_PERSON_ID, "seeded operator email also operator");
  assert.equal(self, email, "both are the same operator person");
});

// ---------------------------------------------------------------------------
// T12 — closure metric: cross_platform_clusters >= 2 and lookup consistency.
// ---------------------------------------------------------------------------
test("cross_platform_clusters >= 2 and lookup/persons consistent", () => {
  const idx = buildPersonIndex(syntheticCorpus());
  assert.ok(idx.stats.cross_platform_clusters >= 2, "the closure metric (>=2)");
  // Every lookup target is a real person record.
  for (const [, personId] of idx.lookup) {
    assert.ok(idx.persons.has(personId), "every lookup target resolves to a person record");
  }
  // persons count is consistent with distinct lookup targets.
  const distinct = new Set([...idx.lookup.values()]);
  assert.equal(distinct.size, idx.persons.size, "persons == distinct lookup targets");
});

// ---------------------------------------------------------------------------
// T13 — mintPersonId is deterministic + operator constant; node-key namespacing.
// ---------------------------------------------------------------------------
test("mintPersonId deterministic, operator constant; union-find namespacing", () => {
  assert.equal(mintPersonId(["svc-a x", "svc-b y"], true), OPERATOR_PERSON_ID);
  const id1 = mintPersonId(["svc-b y", "svc-a x"], false);
  const id2 = mintPersonId(["svc-a x", "svc-b y"], false); // different order
  assert.equal(id1, id2, "minted id is order-independent (lexMin of sorted members)");
  assert.ok(id1.startsWith("person:"), "minted id carries the person: prefix");
  assert.notEqual(id1, OPERATOR_PERSON_ID);
  // platform vs identifier node keys never collide.
  assert.notEqual(
    __internal.platformNodeKey("svc-a", "x"),
    __internal.identifierNodeKey("phone", "x"),
  );
});

// ---------------------------------------------------------------------------
// T14 — N1 fixture corpus is consumable: every expected_envelope clusters
//        without throwing, and the operator self-id token never becomes a person.
// ---------------------------------------------------------------------------
test("N1 fixture corpus clusters cleanly; defensive on malformed input", () => {
  const l1 = loadL1Envelopes();
  assert.ok(l1.length >= 4, "loaded the 4 platform fixtures");
  for (const e of l1) assert.ok(validateEnvelope(e).ok, "fixture envelope is N1-valid");
  const idx = buildPersonIndex(l1);
  assert.ok(idx.persons.size >= 1, "fixtures produce >=1 person");
  // Defensive: malformed inputs are skipped, never throw.
  const safe = buildPersonIndex([null, 42, {}, { sender: {} }, { platform: "p", sender: { id: "" } }]);
  assert.equal(safe.stats.envelopes_seen, 0, "all malformed inputs skipped");
});
