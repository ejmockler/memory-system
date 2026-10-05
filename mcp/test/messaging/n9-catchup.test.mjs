// n9-catchup.test.mjs — WORKUNIT N9 gate. The cross-platform CATCH-UP surface
// (mcp/lib/messaging/catchup.js) + its memory_catchup MCP tool.
//
// Hermetic: node:test only, no network, no daemon, no live DB, no fs writes.
// Reads ONLY the N9 fixture corpus (already-projected Envelope rows grouped per
// source ledger). >=12 assertions covering: multi-platform fixture -> ranked
// deduped list; the ordering properties the pipeline actually holds (score
// non-increasing WITHIN a (tier, is_contact) run, tierRank non-decreasing across
// the whole emitted order); person dedup collapses 2 platforms -> 1 row; closer /
// i-spoke-last exclusion; tool registered + dispatchable; bad-input ->
// INVALID_ARGUMENTS; 0 platform tokens over catchup.js; purity (no source
// mutation, no fs write); SOFT N7 fallback.

// MUST stay the FIRST import: static imports hoist, so this shim is the only
// way to pin TELEMETRY_BASE_DIR before the dispatch.js import below pulls in
// config.js — without it, the executeTool calls in this suite write telemetry
// lines into the PRODUCTION sink on every run (L3b defect 4a, caught live
// 2026-07-12 as three 5-line pid groups in telemetry/telemetry.ndjson).
import "./_hermetic-telemetry.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildCatchup,
  buildCatchupCore,
  buildAdapterRegistry,
  loadEnvelopesFromSources,
  ADAPTER_REGISTRY,
  CATCHUP_CAPS,
  DEFAULT_MIN_SCORE,
  NAME,
  TOOL,
  directednessFactor,
  stalenessFactor,
  recencyFactor,
  rankScore,
} from "../../lib/messaging/catchup.js";

// tierRank is the PRIMARY compareDesc key. T4 asserts the emitted order against
// it directly rather than re-deriving a rank from the tier NAME, so the test
// cannot drift from the ordering the pipeline actually uses.
import { tierRank } from "../../lib/messaging/person-enrichment.js";

import { computeAttention } from "../../lib/messaging/attention.js";
import { classifyDirectedAtMe } from "../../lib/messaging/classifier.js";
import { buildPersonIndex, lookup } from "../../lib/messaging/identity.js";

import { listTools, toolCount, executeTool } from "../../lib/dispatch.js";
import { runtimeCensusConvention } from "../../scripts/audit-source-claims.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATCHUP_SRC = path.resolve(__dirname, "../../lib/messaging/catchup.js");
const FIXTURE_PATH = path.join(__dirname, "fixtures", "n9-catchup.fixtures.json");

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const NOW = FIXTURE.meta.pinned_now_ts;

// A FIXTURE adapter registry: the corpus rows are ALREADY N1 Envelopes (the
// raw-row->Envelope projection is N3-N6's job, already gated), so the fixture
// "adapters" are identity mappers keyed by the fixture platform ids. This drives
// the REAL buildCatchup registry path generically (it never branches on a name).
function makeFixtureRegistry() {
  const modules = ["source_a", "source_b"].map((p) => ({
    PLATFORM: p,
    _toEnvelope: (row) => row,
  }));
  return buildAdapterRegistry(modules);
}
const FIXTURE_REGISTRY = makeFixtureRegistry();

// Convenience: the full real resolver over the fixture corpus envelopes.
// loadEnvelopesFromSources is async (it awaits each adapter's optional
// prepareContext); the fixture adapters declare none, so it resolves immediately.
async function fixtureEnvelopes() {
  return loadEnvelopesFromSources(FIXTURE.sources, FIXTURE_REGISTRY);
}
async function fixtureResolvePerson() {
  const index = buildPersonIndex(await fixtureEnvelopes());
  return (platform, senderId) => lookup(index, platform, senderId);
}

// Run buildCatchup over the fixture corpus with the fixture registry. buildCatchup
// is async; callers await it.
function runCatchup(extra = {}) {
  return buildCatchup({
    sources: FIXTURE.sources,
    now: NOW,
    registry: FIXTURE_REGISTRY,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// T1 — multi-platform fixture -> ranked, deduped, non-empty list.
// ---------------------------------------------------------------------------
test("T1: buildCatchup over a multi-platform fixture yields a non-empty ranked list", async () => {
  const res = await runCatchup();
  assert.ok(Array.isArray(res.rows), "rows is an array");
  assert.ok(res.rows.length >= 2, `expected >=2 rows, got ${res.rows.length}`);
  assert.equal(res.generated_at, NOW, "generated_at stamped from injected now");
  for (const r of res.rows) {
    assert.ok(typeof r.score === "number" && Number.isFinite(r.score), "each row carries a finite score");
    assert.ok(Array.isArray(r.reasons) && r.reasons.includes("they_spoke_last"), "row reasons include they_spoke_last");
  }
});

// ---------------------------------------------------------------------------
// T2 — result spans >=2 platforms (cross-platform fusion). GATE platforms_in_result>=2.
// ---------------------------------------------------------------------------
test("T2: the catch-up result spans >=2 distinct platforms", async () => {
  const res = await runCatchup();
  const platforms = new Set();
  for (const r of res.rows) {
    for (const p of r.platforms) platforms.add(p);
    for (const w of r.also_waiting_on) platforms.add(w.platform);
  }
  assert.ok(platforms.size >= 2, `expected >=2 platforms in result, got ${[...platforms].join(",")}`);
  assert.deepEqual(res.stats.platforms, [...platforms].sort(), "stats.platforms matches the surfaced platforms");
});

// ---------------------------------------------------------------------------
// T3 — cross-platform DEDUP collapse: one person on TWO platforms -> ONE row.
// GATE dedup_collapsed.
// ---------------------------------------------------------------------------
test("T3: a person on two platforms collapses to ONE row with both platform refs", async () => {
  const res = await runCatchup();
  // Find the row whose platforms span both sources (the cross-platform person).
  const collapsed = res.rows.find((r) => r.platforms.length >= 2);
  assert.ok(collapsed, "a row spanning >=2 platforms exists (the collapsed cross-platform person)");
  assert.ok(collapsed.platforms.includes("source_a") && collapsed.platforms.includes("source_b"),
    "the collapsed row carries BOTH platform ids");
  assert.ok(collapsed.also_waiting_on.length >= 1, "the second platform's thread is attached as also_waiting_on");
  assert.ok(typeof collapsed.person_id === "string" && collapsed.person_id.length > 0,
    "the collapsed row carries a real N7 person_id");
  // The same person must NOT appear as a second independent row.
  const sameId = res.rows.filter((r) => r.person_id === collapsed.person_id);
  assert.equal(sameId.length, 1, "the cross-platform person appears in exactly ONE row");
});

// ---------------------------------------------------------------------------
// T4 — the ordering properties the pipeline ACTUALLY holds.
// GATE score_nonincreasing_within_band + tierrank_nondecreasing.
//
// WHAT THIS TEST USED TO ASSERT WAS FALSE. "rows are ranked by score,
// non-increasing" is wrong on TWO independent counts, and it passed only because
// the fixture corpus never contains a row that exercises either:
//   1. compareDesc's PRIMARY key is tierRank and its SECOND key is the M5b
//      saved-contact sub-key. A lower-scoring row in a stronger tier — or with
//      the address-book vouch — is emitted ABOVE a higher-scoring one BY DESIGN.
//   2. After the sort, a TIER-BANDED cross-platform diversity interleave
//      re-orders peers within a band, so even inside one tier the emitted
//      sequence is not a score sort.
// Both are intended behaviour, so the TEST was the thing that was wrong.
//
// THE TWO PROPERTIES THAT ARE HELD are asserted separately, because they hold
// under different conditions:
//   (a) with the interleave DISABLED (max_per_platform: 0) the score is
//       non-increasing within each contiguous (tier, is_contact) run. f1 makes
//       this EXACTLY true for the first time: the score key is now the raw score
//       at full double width, so there is no longer a coarse cell inside which a
//       row could sit above another carrying a marginally larger score.
//   (b) with the interleave ON (the shipped default) tierRank is non-decreasing
//       across the WHOLE emitted order — the weave runs within a tier band and
//       can never move a row across a boundary.
// (c) demonstrates that the deleted claim really is false, so the restatement is
// a correction and not a weakening.
// ---------------------------------------------------------------------------
test("T4: score is non-increasing within each (tier, is_contact) run; tierRank never decreases", async () => {
  const bandKey = (r) => `${r.tier}|${!!(r.enrichment && r.enrichment.is_contact)}`;

  // (a) compareDesc's own order, with the interleave switched off.
  const pure = await runCatchup({ max_per_platform: 0 });
  assert.ok(pure.rows.length >= 2, "the corpus yields enough rows for the run property to mean something");
  for (let i = 0; i + 1 < pure.rows.length; i += 1) {
    // A band boundary is where tier / the M5b sub-key decides — not the score.
    if (bandKey(pure.rows[i]) !== bandKey(pure.rows[i + 1])) continue;
    assert.ok(pure.rows[i].score >= pure.rows[i + 1].score,
      `score must be non-increasing inside one (tier, is_contact) run at index ${i}: ${pure.rows[i].score} < ${pure.rows[i + 1].score}`);
  }

  // (b) the shipped path, interleave ON.
  const woven = await runCatchup();
  for (let i = 0; i + 1 < woven.rows.length; i += 1) {
    assert.ok(tierRank(woven.rows[i].tier) <= tierRank(woven.rows[i + 1].tier),
      `tierRank must be non-decreasing at index ${i}: ${woven.rows[i].tier} then ${woven.rows[i + 1].tier}`);
  }

  // (c) THE OLD CLAIM, FALSIFIED on a corpus that inverts the score across both
  // keys above it. (The e11 helpers used here are hoisted function declarations
  // and module consts; both are live by the time this callback runs.)
  const inv = e11InversionSources();
  const res = await e11Run(inv.sources, inv.contacts);
  const saved = res.rows.find((r) => r.thread_id === "dm_saved");
  const deepRow = res.rows.find((r) => r.thread_id === "dm_deep");
  const stranger = res.rows.find((r) => r.thread_id === "dm_stranger");
  assert.ok(saved && deepRow && stranger, "the inversion corpus surfaces all three rows");
  let globalInversions = 0;
  for (let i = 0; i + 1 < res.rows.length; i += 1) {
    if (res.rows[i].score < res.rows[i + 1].score) globalInversions += 1;
  }
  assert.ok(globalInversions > 0,
    "a GLOBALLY non-increasing score is false on this corpus — which is exactly why the old assertion is deleted rather than kept");
  // ...and the two properties this test now asserts still hold on it.
  for (let i = 0; i + 1 < res.rows.length; i += 1) {
    assert.ok(tierRank(res.rows[i].tier) <= tierRank(res.rows[i + 1].tier),
      "tierRank is still non-decreasing on the inverting corpus");
    if (bandKey(res.rows[i]) !== bandKey(res.rows[i + 1])) continue;
    assert.ok(res.rows[i].score >= res.rows[i + 1].score,
      "and the score is still non-increasing inside each (tier, is_contact) run");
  }
});

// ---------------------------------------------------------------------------
// T5 — closer threads ("thanks!") are EXCLUDED (N8 substance reuse honored).
// ---------------------------------------------------------------------------
test("T5: a they-spoke-last CLOSER thread ('thanks!') is absent from the list", async () => {
  const res = await runCatchup();
  const hasCloser = res.rows.some((r) => r.last_msg === "thanks!");
  assert.equal(hasCloser, false, "the closer-only thread must not surface");
  // Casey is the closer person; assert no row resolves to casey's email.
  const casey = res.rows.some((r) =>
    r.last_msg && /thanks/i.test(r.last_msg));
  assert.equal(casey, false, "no row carries the closer content");
});

// ---------------------------------------------------------------------------
// T6 — i-spoke-last EXCLUDED: a directed+substantive thread where I replied last.
// ---------------------------------------------------------------------------
test("T6: a thread where I (user) spoke last is absent (answered)", async () => {
  const res = await runCatchup();
  // Dana's thread ends with my outbound reply; her question must NOT surface.
  const danaSurfaced = res.rows.some((r) =>
    r.last_msg && /confirm the address/i.test(r.last_msg));
  assert.equal(danaSurfaced, false, "an answered (i-spoke-last) thread must not surface");
});

// ---------------------------------------------------------------------------
// T7 — distinct people on the SAME platform are NOT merged (dedup precision).
// ---------------------------------------------------------------------------
test("T7: two distinct senders are not over-collapsed into one row", async () => {
  const res = await runCatchup();
  // Amara (cross-platform) and Blake (source_a only) are distinct people; each
  // must own its own row. Count distinct dedup identities among surfaced rows.
  const ids = new Set(res.rows.map((r) => r.person_id || r.person));
  assert.ok(ids.size >= 2, `expected >=2 distinct people, got ${ids.size}`);
  const blake = res.rows.find((r) => r.last_msg && /review tomorrow/i.test(r.last_msg));
  assert.ok(blake, "Blake's single-platform thread surfaces as its own row");
  assert.equal(blake.platforms.length, 1, "Blake is single-platform (not over-collapsed)");
});

// ---------------------------------------------------------------------------
// T8 — directedness threshold is a LIVE filter input (raising min_score prunes).
// ---------------------------------------------------------------------------
test("T8: raising min_score above the achievable score empties the list", async () => {
  const base = await runCatchup();
  assert.ok(base.rows.length >= 1, "baseline has rows");
  // min_score above 1 can never be met by directednessFactor in [0,1]; with
  // min_score just above every row's directedness the list shrinks to empty.
  const pruned = await runCatchup({ min_score: 1 });
  // All fixture threads are DMs (directedness = DM prior 0.5 < 1), so a
  // min_score of 1 prunes everything.
  assert.equal(pruned.rows.length, 0, "min_score=1 prunes all DM-prior threads");
  // Lowering min_score to 0 keeps at least the baseline rows.
  const wide = await runCatchup({ min_score: 0 });
  assert.ok(wide.rows.length >= base.rows.length, "min_score=0 keeps >= baseline rows");
});

// ---------------------------------------------------------------------------
// T9 — SOFT N7 fallback: resolvePerson=()=>null degrades to per-platform dedup
// and the tool still returns a valid ranked list (no crash, no collapse).
// ---------------------------------------------------------------------------
test("T9: with a null person resolver, dedup degrades to per-platform (no crash, no collapse)", async () => {
  const envelopes = await fixtureEnvelopes();
  const res = buildCatchupCore({
    envelopes,
    classify: classifyDirectedAtMe,
    attention: computeAttention,
    resolvePerson: () => null, // SOFT edge: N7 absent
    now: NOW,
    opts: {},
  });
  assert.ok(res.rows.length >= 2, "still returns a non-empty ranked list under the soft fallback");
  // Without a person index, the cross-platform Amara CANNOT collapse: she appears
  // as TWO per-platform rows (dedup key = `${platform}:${sender_id}`).
  const collapsed = res.rows.filter((r) => r.platforms.length >= 2);
  assert.equal(collapsed.length, 0, "no cross-platform collapse when N7 is absent (documented degradation)");
  for (let i = 0; i + 1 < res.rows.length; i += 1) {
    assert.ok(res.rows[i].score >= res.rows[i + 1].score, "still ranked non-increasing under degradation");
  }
});

// ---------------------------------------------------------------------------
// T10 — tool registered + dispatchable. GATE tool_registered.
// ---------------------------------------------------------------------------
test("T10: memory_catchup is registered, surfaced by listTools, and dispatchable", async () => {
  const tools = listTools();
  const found = tools.find((t) => t.name === NAME);
  assert.ok(found, "memory_catchup present in listTools()");
  assert.equal(found.name, "memory_catchup", "tool name matches");
  assert.ok(typeof found.description === "string" && found.description.length > 0, "non-empty description");
  assert.ok(found.inputSchema && found.inputSchema.type === "object", "valid object inputSchema");
  assert.equal(found.inputSchema.additionalProperties, false, "inputSchema forbids extra props");

  const env = await executeTool("memory_catchup", {});
  assert.equal(env.ok, true, "executeTool returns ok:true (not NOT_FOUND, not SCOPE_BLOCKED)");
  assert.equal(env.meta.tool, "memory_catchup", "envelope meta names the tool");
  assert.ok(env.data && Array.isArray(env.data.rows), "data carries a rows array");
  assert.ok(typeof env.data.generated_at === "string", "generated_at is a server ISO string");
});

// ---------------------------------------------------------------------------
// T11 — toolCount delta is exactly +1 and no other tool name was disturbed.
// ---------------------------------------------------------------------------
test("T11: registration is additive (toolCount includes catchup; names intact)", () => {
  const names = listTools().map((t) => t.name);
  assert.ok(names.includes("memory_catchup"), "memory_catchup in the registry");
  assert.ok(names.includes("memory_recall"), "pre-existing memory_recall untouched");
  assert.ok(names.includes("memory_put"), "pre-existing memory_put untouched");
  assert.equal(new Set(names).size, names.length, "no duplicate tool names");
  assert.equal(toolCount(), names.length, "toolCount equals listTools length");
});

// ---------------------------------------------------------------------------
// T12 — bad input -> INVALID_ARGUMENTS (ToolError converted by dispatch).
// ---------------------------------------------------------------------------
test("T12: bad input returns ok:false with INVALID_ARGUMENTS (not a thrown stack)", async () => {
  const negLimit = await executeTool("memory_catchup", { limit: -1 });
  assert.equal(negLimit.ok, false, "negative limit rejected");
  assert.equal(negLimit.error.code, "INVALID_ARGUMENTS", "negative limit -> INVALID_ARGUMENTS");

  const strPlatforms = await executeTool("memory_catchup", { platforms: "source_a" });
  assert.equal(strPlatforms.ok, false, "string platforms rejected");
  assert.equal(strPlatforms.error.code, "INVALID_ARGUMENTS", "string platforms -> INVALID_ARGUMENTS");

  const badScore = await executeTool("memory_catchup", { min_score: "x" });
  assert.equal(badScore.ok, false, "non-numeric min_score rejected");
  assert.equal(badScore.error.code, "INVALID_ARGUMENTS", "bad min_score -> INVALID_ARGUMENTS");

  const unknownKey = await executeTool("memory_catchup", { nope: 1 });
  assert.equal(unknownKey.ok, false, "unknown key rejected by assertObjectShape");
  assert.equal(unknownKey.error.code, "INVALID_ARGUMENTS", "unknown key -> INVALID_ARGUMENTS");
});

// ---------------------------------------------------------------------------
// T13 — ZERO platform tokens over catchup.js (the abstraction invariant). GATE grep.
// ---------------------------------------------------------------------------
test("T13: catchup.js carries zero platform tokens (M10 grep)", () => {
  const src = readFileSync(CATCHUP_SRC, "utf8");
  const RE = /whatsapp|imessage|telegram|\bmail\b|@g\.us|@s\.whatsapp|chat_guid|cache_roomnames|@lid|jid/i;
  assert.equal(RE.test(src), false, "no platform token may appear in catchup.js");
  // No platform-NAME equality branch: comparing the platform field against a
  // platform-NAME literal is the forbidden control flow. (A `typeof x === "string"`
  // type guard or a `=== null` presence guard is legitimate — those compare
  // against a type/null, never against a platform identity, which the token
  // regex above already proves is absent.)
  const PLATFORM_NAME_BRANCH = /===\s*["'`](?:whatsapp|imessage|telegram|mail|signal|slack)["'`]/i;
  assert.equal(PLATFORM_NAME_BRANCH.test(src), false, "no `=== \"<platform-name>\"` branch in catchup.js");
});

test("T13b: marked catchup census comment names a producer and embeds no result", () => {
  const audit = runtimeCensusConvention(
    readFileSync(CATCHUP_SRC, "utf8"),
    "lib/messaging/catchup.js",
  );
  assert.ok(audit.paragraphs.length > 0, "expected a RUNTIME-CENSUS convention marker");
  assert.deepEqual(audit.violations, [], JSON.stringify(audit.violations, null, 2));
});

// ---------------------------------------------------------------------------
// T14 — PURITY: the fixture corpus is not mutated and no fs write happens.
// ---------------------------------------------------------------------------
test("T14: buildCatchup is a read-only join (no source mutation, no fs write)", async () => {
  const before = readFileSync(FIXTURE_PATH);
  const hashBefore = createHash("sha256").update(before).digest("hex");
  const mtimeBefore = statSync(FIXTURE_PATH).mtimeMs;

  // Deep-snapshot the in-memory sources, run a full build, assert unchanged.
  const snapshot = JSON.parse(JSON.stringify(FIXTURE.sources));
  const res = await runCatchup({ limit: 100 });
  assert.ok(res.rows.length >= 1, "build produced output");
  assert.deepEqual(FIXTURE.sources, snapshot, "in-memory source rows unmutated");

  const after = readFileSync(FIXTURE_PATH);
  const hashAfter = createHash("sha256").update(after).digest("hex");
  const mtimeAfter = statSync(FIXTURE_PATH).mtimeMs;
  assert.equal(hashAfter, hashBefore, "fixture corpus bytes unchanged");
  assert.equal(mtimeAfter, mtimeBefore, "fixture corpus mtime unchanged");
});

// ---------------------------------------------------------------------------
// T15 — the rank normalizers are monotone + bounded (the documented sort key).
// ---------------------------------------------------------------------------
test("T15: rank normalizers are monotone and bounded in [0,1]", () => {
  // directedness: clamp + identity in range.
  assert.equal(directednessFactor(-1), 0, "directedness clamps below 0");
  assert.equal(directednessFactor(2), 1, "directedness clamps above 1");
  assert.equal(directednessFactor(0.5), 0.5, "directedness passes through in range");
  // staleness: older -> higher, in (0,1), 0.5 at the half-life.
  assert.ok(stalenessFactor(0) <= stalenessFactor(CATCHUP_CAPS.STALENESS_HALFLIFE_MS), "staleness non-decreasing");
  assert.ok(Math.abs(stalenessFactor(CATCHUP_CAPS.STALENESS_HALFLIFE_MS) - 0.5) < 1e-9, "staleness=0.5 at half-life");
  // recency: newer -> higher.
  assert.ok(recencyFactor(NOW, NOW) >= recencyFactor(NOW - CATCHUP_CAPS.RECENCY_WINDOW_MS, NOW),
    "recency non-increasing in age");
  // composite product bounded.
  const s = rankScore({ lastInboundTs: NOW - 1000, directed: 0.5, ageMs: 1000, now: NOW });
  assert.ok(s >= 0 && s <= 1, "rankScore product is in [0,1]");
  assert.equal(DEFAULT_MIN_SCORE, CATCHUP_CAPS.DEFAULT_MIN_SCORE, "DEFAULT_MIN_SCORE exported consistently");
});

// ---------------------------------------------------------------------------
// T16 — the default ADAPTER_REGISTRY is generic: keyed by each adapter's own
// PLATFORM, built by looping modules (no platform-name branch in catchup.js).
// ---------------------------------------------------------------------------
test("T16: the default adapter registry is built generically from adapter PLATFORM ids", () => {
  assert.ok(ADAPTER_REGISTRY instanceof Map, "ADAPTER_REGISTRY is a Map");
  assert.ok(ADAPTER_REGISTRY.size >= 2, `registry has >=2 adapters, got ${ADAPTER_REGISTRY.size}`);
  for (const [platform, entry] of ADAPTER_REGISTRY.entries()) {
    assert.ok(typeof platform === "string" && platform.length > 0, "each registry key is a platform id");
    assert.equal(typeof entry.toEnvelope, "function", "each entry exposes a toEnvelope mapper");
    assert.ok(typeof entry.ledgerPath === "string" && entry.ledgerPath.includes(platform),
      "ledgerPath is derived generically from the platform id");
  }
});


// ===========================================================================
// e11 — THE ORDERING OF THE PINNED BAND, AND THE HEAD IT ALSO CHOOSES.
//
// MEASURED FIRST, on one frozen production snapshot (identified in full in
// mcp/test/messaging/e7-catchup-join-eval.mjs's header, `--saturation` mode):
// 158 of 393 deduped threads — 40.2% — sit with recencyFactor pinned at exactly
// CATCHUP_CAPS.RECENCY_FLOOR, every one of them because its last inbound is past
// RECENCY_WINDOW_MS. In the relationship tier it is 6 of 9.
//
// THE DEFECT THAT MEASUREMENT EXPOSED is not the saturation — that is the
// designed shape, and the harness's objective-3 arithmetic declines re-weighting
// it. It is that the pinned set was ordered by TWO CONTRADICTORY RULES at once:
// rows whose scores collided EXACTLY reached compareDesc's explicit ts tiebreak
// and emitted newest-first, while rows separated only by the decaying float tail
// of stalenessFactor never reached it — 1 - 2**(-age/H) approaches 1 FROM BELOW,
// so the OLDER row carried the marginally larger score and emitted oldest-first.
//
// e17 SETTLED THAT BY REMOVING THE SECOND TIME FACTOR, not by an ordering trick.
// Past RECENCY_WINDOW_MS the time term is now a CONSTANT, so the decaying tail
// that produced the contradictory rule does not exist: the pinned pairs collide
// EXACTLY and reach the explicit tiebreak on their own. e11 had meanwhile put a
// coarse comparison in front of the score to force that same outcome; f1 removed
// it, because on the re-measured population it absorbed nothing at all (0 rank
// moves, 0 tier crossings, 0 head changes from 1e-15 through 1e-6) and an
// unexercised mechanism carrying a live justification is a liability. The score
// key is now the RAW SCORE at full double width under a totality clamp, and the
// clamp — not the retired mechanism — is what keeps compareDesc a consistent
// strict weak ordering on degenerate input.
//
// compareDesc is ALSO the dedup HEAD-SELECTION key, which is why T21 exists:
// a property claimed about head identity is a property measured, here and in the
// harness's head_changed bucket.
// ===========================================================================

// The e11 fixtures are their own tiny corpus: DM envelopes on ONE platform, so
// the diversity interleave is a documented no-op (catchup.js: "Single platform
// => interleave is a no-op") and what is asserted is the rank order itself.
let _e11Mid = 0;
function e11Env({ thread_id, is_from_me = false, content = "hi", ts, sender_id, sender_name = null }) {
  _e11Mid += 1;
  return {
    platform: "source_a",
    thread_id,
    thread_type: "dm",
    sender: {
      id: is_from_me ? "user" : sender_id,
      name: is_from_me ? null : sender_name,
      kind: "person",
    },
    recipients: ["user"],
    is_from_me,
    ts,
    content,
    mentions: [],
    directed_at_me_signals: { mention_me: false, reply_to_me: false, addressed_to_me: false },
    capabilities: { reply_to_available: true, structured_mentions: true, self_identity_reliable: true, addressing_first_class: false },
    source_msg_id: `source_a:${thread_id}:${_e11Mid}`,
  };
}

const E11_DAY = 24 * 60 * 60 * 1000;
// One substantive, directed question. Identical across the rows of a pinned pair
// so that directednessFactor cannot be what separates them.
const E11_ASK = "can you confirm the plan for the trip and let me know what time works?";

function e11Run(sources, anchorOpt) {
  return buildCatchup({
    sources,
    now: NOW,
    registry: FIXTURE_REGISTRY,
    min_score: 0.3,
    ...(anchorOpt === undefined ? {} : { anchor: anchorOpt }),
  });
}

// A contactMaps anchor that vouches ONLY the handles named — the injected,
// hermetic form of the M2 address-book join (no DB, no fs, no network).
function e11Contacts(pairs) {
  return {
    contacts: {
      contactMaps: { phoneToName: new Map(pairs), emailToName: new Map() },
      noMemo: true,
    },
  };
}

// THE INVERSION CORPUS. Three rows whose RAW SCORES run in the opposite direction
// to the emitted order, across BOTH keys that sit above the score:
//   dm_saved    — a saved contact, long past the recency window: relationship tier
//                 via the is_contact vouch, and the LOWEST score of the three.
//   dm_deep     — a deep two-way history with someone NOT in the address book:
//                 relationship tier on reciprocity alone, recent, HIGHER score.
//   dm_stranger — a recent stranger: the honest unknown tier, and a high score.
// Shared by T4 (which uses it to falsify the "globally non-increasing score"
// claim it used to assert) and T20 (which uses it to pin that the score key can
// cross neither the tier key nor the M5b sub-key). A `function` declaration so
// both callers reach it regardless of their position in the file.
function e11InversionSources() {
  const deep = [];
  for (let i = 0; i < 8; i += 1) {
    deep.push(e11Env({ thread_id: "dm_deep", sender_id: "+15552220006", sender_name: "Deep History", content: `${E11_ASK} (${i})`, ts: NOW - 3 * E11_DAY - (20 - i) * 60000 }));
    deep.push(e11Env({ thread_id: "dm_deep", sender_id: "user", is_from_me: true, content: "yes, that works for me", ts: NOW - 3 * E11_DAY - (20 - i) * 60000 + 30000 }));
  }
  deep.push(e11Env({ thread_id: "dm_deep", sender_id: "+15552220006", sender_name: "Deep History", content: E11_ASK, ts: NOW - 3 * E11_DAY }));
  return {
    sources: {
      source_a: [
        e11Env({ thread_id: "dm_saved", sender_id: "+15552220005", sender_name: "Saved Contact", content: E11_ASK, ts: NOW - 100 * E11_DAY }),
        ...deep,
        e11Env({ thread_id: "dm_stranger", sender_id: "+15552220007", sender_name: "Stranger", content: E11_ASK, ts: NOW - 3 * E11_DAY }),
      ],
    },
    contacts: e11Contacts([["5552220005", "Saved Contact"]]),
  };
}

// ---------------------------------------------------------------------------
// T18 (e11 property b) — two recency-PINNED rows fall through to the ts-desc
// tiebreak, newest first. This is the case that failed on the pre-e11 comparator.
//
// e17 CHANGED ITS PREMISE, so the case is re-derived rather than re-worded. Before
// e17 the pair was separated by a tiny float residue: recency was pinned at the
// floor for both, but stalenessFactor's 1 - 2**(-age/H) approaches 1 from below,
// so the OLDER row carried a marginally larger score and a full-width comparison
// emitted it first. e17 deleted stalenessFactor from rankScore, so past
// RECENCY_WINDOW_MS the time term is a CONSTANT and this pair now collides
// EXACTLY. The PROPERTY under test is unchanged and is what the operator sees:
// two pinned rows that agree on everything compareDesc consults before the
// tiebreak are emitted NEWEST FIRST. Only the mechanism reaching it changed, and
// the case pins both the exact tie AND the resulting order.
// ---------------------------------------------------------------------------
test("T18 (e11/e17): two recency-PINNED rows collide EXACTLY and order NEWEST-FIRST on the explicit tiebreak", async () => {
  const NEWER_AGE = 35 * E11_DAY;
  const OLDER_AGE = 142 * E11_DAY;
  const sources = {
    source_a: [
      e11Env({ thread_id: "dm_older", sender_id: "+15552220001", sender_name: "Older Row", content: E11_ASK, ts: NOW - OLDER_AGE }),
      e11Env({ thread_id: "dm_newer", sender_id: "+15552220002", sender_name: "Newer Row", content: E11_ASK, ts: NOW - NEWER_AGE }),
    ],
  };
  const res = await e11Run(sources);
  const newer = res.rows.find((r) => r.thread_id === "dm_newer");
  const older = res.rows.find((r) => r.thread_id === "dm_older");
  assert.ok(newer && older, "both rows surface — an ordering change never drops a row");

  // (1) THE PREMISE: both are pinned at the floor, so recency carries no ordering
  // information between them.
  assert.equal(recencyFactor(NOW - NEWER_AGE, NOW), CATCHUP_CAPS.RECENCY_FLOOR, "the newer row is past RECENCY_WINDOW_MS => pinned");
  assert.equal(recencyFactor(NOW - OLDER_AGE, NOW), CATCHUP_CAPS.RECENCY_FLOOR, "the older row is pinned at the same floor");

  // (2) EVERYTHING compareDesc CONSULTS BEFORE SCORE IS EQUAL.
  assert.equal(newer.tier, older.tier, "same tier — tierRank cannot separate them");
  assert.equal(
    !!(newer.enrichment && newer.enrichment.is_contact),
    !!(older.enrichment && older.enrichment.is_contact),
    "same saved-contact vouch — the M5b sub-key cannot separate them",
  );
  assert.equal(newer.reciprocity_strength, older.reciprocity_strength, "same reciprocity term");
  assert.equal(newer.anchor_factor, older.anchor_factor, "same anchor term");

  // (3) THE COLLISION (e17). With one time term, and everything else equal, the
  // two scores are EXACTLY equal — the staleness tail that used to separate them
  // is gone. The tie is stated explicitly rather than left to be inferred from
  // the order.
  const delta = Math.abs(older.score - newer.score);
  assert.equal(delta, 0, `the two pinned rows now collide exactly (delta ${delta})`);
  assert.equal(
    older.score,
    newer.score,
    "both scores are the same number — past the window the time term is the constant RECENCY_FLOOR",
  );

  // (4) THE ORDER. On an exact tie the EXPLICIT ts-desc tiebreak decides, and it
  // is the honest rule for the whole pinned band — reached by the arithmetic
  // itself rather than manufactured by a coarse comparison in front of it.
  assert.ok(
    res.rows.indexOf(newer) < res.rows.indexOf(older),
    "the NEWER pinned row is emitted first, decided by the explicit ts-desc tiebreak",
  );
});

// ---------------------------------------------------------------------------
// T19 (e11 property c) — a pair separated by REAL SIGNAL still orders by SCORE,
// even when the ts tiebreak would say the opposite. Nothing in front of the score
// key may swallow a separation this size.
// ---------------------------------------------------------------------------
test("T19: a pair separated by real signal orders by score, over the ts tiebreak", async () => {
  const OLD_AGE = 40 * E11_DAY; // pinned, and OLDER
  const NEW_AGE = 30 * E11_DAY; // pinned, and NEWER
  const broadcast = [];
  for (let i = 0; i < 6; i += 1) {
    broadcast.push(
      e11Env({
        thread_id: "dm_broadcast",
        sender_id: "+15552220004",
        sender_name: "Broadcast Row",
        content: `${E11_ASK} (${i})`,
        ts: NOW - NEW_AGE + i * 1000,
      }),
    );
  }
  const sources = {
    source_a: [
      // A genuine first contact: turns 0, one inbound => the new-contact neutral.
      e11Env({ thread_id: "dm_first", sender_id: "+15552220003", sender_name: "First Contact", content: E11_ASK, ts: NOW - OLD_AGE }),
      // A one-directional high-volume channel: turns 0, outbound 0, inbound 6 =>
      // the broadcast floor. Same tier, same (absent) vouch, but a much lower
      // reciprocity term.
      ...broadcast,
    ],
  };
  const res = await e11Run(sources);
  const first = res.rows.find((r) => r.thread_id === "dm_first");
  const bcast = res.rows.find((r) => r.thread_id === "dm_broadcast");
  assert.ok(first && bcast, "both rows surface — the broadcast is down-ranked, never dropped");

  assert.equal(first.tier, bcast.tier, "same tier");
  assert.equal(
    !!(first.enrichment && first.enrichment.is_contact),
    !!(bcast.enrichment && bcast.enrichment.is_contact),
    "same (absent) saved-contact vouch",
  );
  assert.ok(first.reciprocity_strength > bcast.reciprocity_strength, "the reciprocity term is what separates them");
  assert.ok(first.ts < bcast.ts, "and the ts tiebreak, if it were reached, would say the OPPOSITE");

  const delta = first.score - bcast.score;
  assert.ok(delta > 0, `the reciprocity term really does separate them (${delta})`);
  // ANCHORED ON THE MEASURED SEPARATION, not on a symbolic bound: the reciprocity
  // term puts these two 1.0e-2 apart, which is real signal and eight orders of
  // magnitude clear of any float residue in a product of four factors.
  assert.ok(delta > 1e-3, `the separation (${delta}) is signal, not residue`);
  assert.notEqual(first.score, bcast.score, "so the score key can tell them apart");
  assert.ok(
    res.rows.indexOf(first) < res.rows.indexOf(bcast),
    "the higher-scoring OLDER row is emitted first: with a real separation, score still decides",
  );
});

// ---------------------------------------------------------------------------
// T20 (e11 property d) — the SCORE key sits strictly BELOW the tier key and BELOW
// the M5b saved-contact sub-key, so it can NEVER reorder across either. Asserted
// on a corpus where the raw scores say the opposite of the emitted order.
// ---------------------------------------------------------------------------
test("T20: the score key never reorders across the TIER key or the is_contact sub-key", async () => {
  const inv = e11InversionSources();
  const res = await e11Run(inv.sources, inv.contacts);
  const saved = res.rows.find((r) => r.thread_id === "dm_saved");
  const deepRow = res.rows.find((r) => r.thread_id === "dm_deep");
  const stranger = res.rows.find((r) => r.thread_id === "dm_stranger");
  assert.ok(saved && deepRow && stranger, "all three rows surface");

  // THE TIER KEY. The saved contact scores far BELOW the stranger and still
  // outranks it, because tierRank is consulted first.
  assert.equal(saved.tier, "relationship", "the saved contact is in the relationship tier");
  assert.equal(stranger.tier, "unknown", "the stranger is in the honest unknown tier");
  assert.ok(saved.score < stranger.score, "and the stranger out-SCORES the saved contact");
  assert.ok(res.rows.indexOf(saved) < res.rows.indexOf(stranger), "the tier key wins: no row crosses a tier boundary");

  // THE M5b SUB-KEY, WITHIN one tier. Both rows are relationship; only one is a
  // saved contact; the saved one scores strictly lower; it still wins.
  assert.equal(deepRow.tier, "relationship", "the deep two-way history reaches the relationship tier on reciprocity alone");
  assert.equal(saved.enrichment.is_contact, true, "the saved contact carries the address-book vouch");
  assert.equal(deepRow.enrichment.is_contact, false, "the deep-history peer does not");
  assert.ok(saved.score < deepRow.score, "and the deep-history peer out-SCORES the saved contact");
  assert.ok(res.rows.indexOf(saved) < res.rows.indexOf(deepRow), "the saved-contact sub-key wins: the score key sits strictly below it");
});

// ---------------------------------------------------------------------------
// T21 (e11 property e) — HEAD SELECTION. compareDesc is ALSO the dedup key, so a
// change to it decides WHICH THREAD of a person the operator is shown. This is
// the property the e7 harness's head_changed_count measures on production; here
// it is pinned exactly, on a group whose members collide EXACTLY.
// ---------------------------------------------------------------------------
test("T21: a dedup group that collides EXACTLY heads on the NEWEST thread", async () => {
  const HANDLE = "+15552220008";
  const NEWER_AGE = 40 * E11_DAY;
  const OLDER_AGE = 150 * E11_DAY;
  const sources = {
    source_a: [
      e11Env({ thread_id: "dm_group_old", sender_id: HANDLE, sender_name: "One Person", content: E11_ASK, ts: NOW - OLDER_AGE }),
      e11Env({ thread_id: "dm_group_new", sender_id: HANDLE, sender_name: "One Person", content: E11_ASK, ts: NOW - NEWER_AGE }),
    ],
  };
  const res = await e11Run(sources);

  // ONE person, ONE emitted row: the two threads collapsed.
  assert.equal(res.rows.length, 1, "the two threads of one person collapse to a single row");
  const head = res.rows[0];
  assert.equal(head.also_waiting_on.length, 1, "the non-head thread is attached, never dropped");

  // The premise, again: both pinned, so the time term carries no ordering
  // information between them and the two scores are EXACTLY equal.
  assert.equal(recencyFactor(NOW - NEWER_AGE, NOW), CATCHUP_CAPS.RECENCY_FLOOR, "the newer thread is pinned");
  assert.equal(recencyFactor(NOW - OLDER_AGE, NOW), CATCHUP_CAPS.RECENCY_FLOOR, "the older thread is pinned");
  const other = head.also_waiting_on[0];
  const delta = Math.abs(head.score - other.score);
  assert.equal(delta, 0, `the two threads collide exactly (delta ${delta}), so the score key cannot choose the head`);

  // THE HEAD IS THE NEWEST MEMBER — not the highest-scoring one. On an exact tie
  // the explicit ts-desc tiebreak is what selects it.
  assert.equal(head.thread_id, "dm_group_new", "the NEWER thread heads the group");
  assert.equal(head.ts, NOW - NEWER_AGE, "and the head carries that thread's timestamp");
  assert.equal(other.score, head.score, "the non-head member carries the SAME score — nothing but ts separates them");

  // AND THE OTHER MEMBER KEEPS ITS OWN IDENTITY on the collapsed row.
  assert.equal(other.thread_id, "dm_group_old", "the older thread is the also_waiting_on member");
  assert.equal(other.ts, NOW - OLDER_AGE, "carrying its own timestamp");
  assert.equal(other.platform, "source_a", "its own platform");
  assert.ok(typeof other.last_msg === "string" && other.last_msg.length > 0, "and its own last_msg");
});
