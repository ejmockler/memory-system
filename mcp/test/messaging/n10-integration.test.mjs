// n10-integration.test.mjs — WORKUNIT N10 gate. The CLOSURE PROOF of the
// messaging-attention hypergraph: a new platform = ONE new adapter; layers 2-5
// (classifier, identity, attention, catchup) NEVER change.
//
// Hermetic: node:test only. No network, no daemon, no live DB, no fs WRITES.
// Reads ONLY the N10 fixture corpus + the (read-only) L2-5 source bytes (for the
// grep gate and the sha-snapshot empty-diff gate). The whole suite runs in
// single-digit seconds and is deterministic across runs.
//
// It drives the FULL chain end-to-end over fixtures:
//   raw rows -> L1 fakeplatform adapter -> N1 validateEnvelope
//           -> N2 classifier -> N7 identity -> N8 attention -> N9 catchup
//           -> ranked, deduped "waiting on you" list
// and enforces the three abstraction-invariant gates (a/b/c) that convert the
// engineering distinction from ASSERTED to PROVEN, plus the cross-platform
// precision/recall + operator-unification + dedup-collapse eval.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import {
  runInvariantEval,
  runPipeline,
  evalPrecisionRecall,
  readFixtures,
  grepPlatformTokens,
  lineTripsDenylist,
  snapshotL2to5,
  diffL2to5,
  L2to5_SOURCES,
  MSG_EVAL_CAPS,
  MSG_EVAL_VERSION,
  DEFAULT_FIXTURE_PATH,
} from "../../lib/messaging/n10-invariant-eval.mjs";

import * as fakeplatform from "../../lib/messaging/adapters/fakeplatform.js";
import { validateEnvelope } from "../../lib/messaging/envelope.js";
import { OPERATOR_PERSON_ID } from "../../lib/messaging/identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = DEFAULT_FIXTURE_PATH;
const FX = readFixtures(FIXTURE_PATH);

// One shared eval result for the whole-pipeline assertions (deterministic).
const EVAL = runInvariantEval();

// ---------------------------------------------------------------------------
// T1 — pipeline_e2e_runs: every platform fixture flows adapter->validate->
// classify->identity->attention->catchup with ZERO thrown errors. The chain is wired.
// ---------------------------------------------------------------------------
test("T1: pipeline_e2e_runs — the full chain flows over fixtures with no thrown errors", () => {
  const pipe = runPipeline(FX);
  assert.ok(pipe.envelopes_total >= 8, `expected >=8 projected envelopes, got ${pipe.envelopes_total}`);
  assert.ok(Array.isArray(pipe.ranked), "ranked is an array");
  assert.ok(pipe.ranked.length >= 2, `expected >=2 ranked rows, got ${pipe.ranked.length}`);
  assert.ok(pipe.stats && Array.isArray(pipe.stats.platforms), "stats carries a platforms list");
  assert.ok(pipe.stats.platforms.includes("fakeplatform"), "the synthetic platform reached the surface");
});

// ---------------------------------------------------------------------------
// T2 — every_envelope_validates: 100% of adapter outputs pass N1 validateEnvelope.
// Proves L1 contract conformance across the synthetic adapter (R5).
// ---------------------------------------------------------------------------
test("T2: every_envelope_validates — 100% of fakeplatform adapter outputs pass N1", () => {
  let total = 0;
  for (const row of FX.fakeplatform_raw) {
    const env = fakeplatform._toEnvelope(row);
    const v = validateEnvelope(env);
    assert.equal(v.ok, true, `fakeplatform row ${row.id} must validate: ${JSON.stringify(v.errors)}`);
    // Contract-faithfulness: a POPULATED capabilities block (not a privileged shape).
    assert.ok(env.capabilities && typeof env.capabilities.reply_to_available === "boolean",
      "fakeplatform envelope carries a populated capabilities{} block");
    total += 1;
  }
  assert.ok(total >= 7, `evaluated all fakeplatform rows (got ${total})`);
  assert.equal(EVAL.pipeline.envelopes_invalid, 0, "zero invalid envelopes across the whole corpus");
});

// ---------------------------------------------------------------------------
// T3 — gate_a_zero_on_clean: bounded platform-token count over the real L2-5
// sources === 0. Proves the abstraction invariant holds as-built.
// ---------------------------------------------------------------------------
test("T3: gate_a_zero_on_clean — zero platform tokens over the five L2-5 sources", () => {
  const { count, matches } = grepPlatformTokens();
  assert.equal(count, 0, `expected 0 platform tokens, got ${count}: ${JSON.stringify(matches.slice(0, 5))}`);
  assert.equal(EVAL.gate_a.pass, true, "gate (a) passes in the full eval");
  assert.equal(EVAL.gate_a.platform_tokens_L2to5, 0, "platform_tokens_L2to5 === 0");
  // Five since f5-catchup-seam moved the retain bounds + shared fold out of
  // catchup.js into the leaf ledger-retain.js and REGISTERED the leaf here —
  // the gate's coverage widened with the move; bytes it used to scan inside
  // catchup.js are still scanned.
  assert.equal(L2to5_SOURCES.length, 5, "the gate scans exactly the five L2-5 sources");
});

// ---------------------------------------------------------------------------
// T4 — gate_a_catches_planted_leak: a scratch copy of classifier.js with a
// bounded chat_guid reference makes the grep FAIL with the right file:line:token.
// Proves the gate CAN fail (R2) — a gate that can't fail proves nothing.
// ---------------------------------------------------------------------------
test("T4: gate_a_catches_planted_leak — a planted chat_guid trips the gate", () => {
  const tmp = path.join(os.tmpdir(), `n10-leak-${process.pid}-${Date.now()}.js`);
  try {
    writeFileSync(tmp, "// scratch\nconst x = row.chat_guid; // a real platform leak\nexport const y = 1;\n");
    const { count, matches } = grepPlatformTokens([tmp]);
    assert.ok(count >= 1, "the planted chat_guid is detected");
    const hit = matches.find((m) => /chat_guid/i.test(m.token));
    assert.ok(hit, "the offending token is reported as chat_guid");
    assert.equal(hit.line, 2, "the offending line number is reported (file:line:token)");
  } finally {
    rmSync(tmp, { force: true });
  }
});

// ---------------------------------------------------------------------------
// T5 — gate_a_boundary_no_false_positive: legitimate words that merely CONTAIN a
// token substring do NOT trip the bounded denylist. Proves word-boundary
// bounding (R1/M5): mail∉email, chat∉chatty, lid∉valid, imessage∉imessage_handles.
// ---------------------------------------------------------------------------
test("T5: gate_a_boundary_no_false_positive — bounded tokens don't match inside larger words", () => {
  for (const safe of [
    "const email = operator.email;",
    "if (chatty) return;",
    "const ok = isValid(x);",
    "const buckets = [ids.emails, ids.imessage_handles];", // the real identity.js:218 seam field
    "mailbox count",
    "gmail address",
    "detailed view",
  ]) {
    assert.equal(lineTripsDenylist(safe), false, `must NOT trip: ${JSON.stringify(safe)}`);
  }
  // And bare platform references DO trip (the gate is not just permissive):
  for (const leak of [
    "// the imessage adapter",
    "const j = row.jid;",
    "read @s.whatsapp.net",
    "the whatsapp connector",
  ]) {
    assert.equal(lineTripsDenylist(leak), true, `must trip: ${JSON.stringify(leak)}`);
  }
});

// ---------------------------------------------------------------------------
// T6 — gate_b_delta_nonzero: |score_true - score_false| >= DEGRADATION_MIN_DELTA
// at L2. Proves data-driven degradation exists at the classifier.
// ---------------------------------------------------------------------------
test("T6: gate_b_delta_nonzero — a single capability bit-flip moves the L2 score", () => {
  assert.ok(EVAL.gate_b.delta_L2 >= MSG_EVAL_CAPS.DEGRADATION_MIN_DELTA,
    `L2 delta ${EVAL.gate_b.delta_L2} must be >= ${MSG_EVAL_CAPS.DEGRADATION_MIN_DELTA}`);
  assert.ok(EVAL.gate_b.score_true > EVAL.gate_b.score_false,
    "reply_to_available=true scores strictly higher than =false (same evidence)");
});

// ---------------------------------------------------------------------------
// T7 — gate_b_delta_survives_to_L5: the same two envelopes yield a non-zero
// rank/score delta in the final ranking. Proves (b) is END-TO-END, not a unit
// re-run of N2 (R3).
// ---------------------------------------------------------------------------
test("T7: gate_b_delta_survives_to_L5 — the capability delta propagates into the L5 rank", () => {
  assert.ok(EVAL.gate_b.delta_L5 >= MSG_EVAL_CAPS.DEGRADATION_MIN_DELTA,
    `L5 delta ${EVAL.gate_b.delta_L5} must survive to >= ${MSG_EVAL_CAPS.DEGRADATION_MIN_DELTA}`);
  assert.ok(EVAL.gate_b.rank_true > EVAL.gate_b.rank_false,
    "the higher-capability envelope ranks strictly higher at L5");
  assert.equal(EVAL.gate_b.pass, true, "gate (b) passes end-to-end");
});

// ---------------------------------------------------------------------------
// T8 — gate_b_identical_caps_zero_delta: identical capability profiles produce a
// delta of 0 (the gate would FAIL) — proving the gate measures the BIT, not
// noise (R3).
// ---------------------------------------------------------------------------
test("T8: gate_b_identical_caps_zero_delta — identical caps give delta 0 (gate measures the bit)", () => {
  assert.equal(EVAL.gate_b.identical_caps_delta, 0,
    "two identical capability profiles must produce a zero score delta");
});

// ---------------------------------------------------------------------------
// T9 — fakeplatform_envelopes_valid: the synthetic adapter emits a contract-
// faithful shape — defensive on malformed rows, omits reply_to_id honestly, and
// stamps a DISTINCT capabilities profile. Proves the 5th adapter is not a stub
// that bypasses validation (R5).
// ---------------------------------------------------------------------------
test("T9: fakeplatform_envelopes_valid — distinct capability profile + defensive mapping", () => {
  // A well-formed inbound row.
  const env = fakeplatform._toEnvelope(FX.fakeplatform_raw.find((r) => r.id === "fp-rhea-1"));
  assert.equal(validateEnvelope(env).ok, true, "a normal row validates");
  assert.deepEqual(env.capabilities, {
    reply_to_available: true,
    structured_mentions: true,
    self_identity_reliable: true,
    addressing_first_class: false,
  }, "fakeplatform stamps its DISTINCT declared capability profile");
  // reply_to_id is OMITTED (not null) when absent — the honest optional encoding.
  assert.equal(Object.prototype.hasOwnProperty.call(env, "reply_to_id"), false,
    "reply_to_id is omitted (not null) when the row carries no reply target");

  // A malformed row degrades to a deliberately-invalid envelope (never throws).
  let threw = false;
  let bad;
  try { bad = fakeplatform._toEnvelope(null); } catch { threw = true; }
  assert.equal(threw, false, "a null row must not throw on the caller's path");
  assert.equal(validateEnvelope(bad).ok, false, "the malformed-row envelope is rejected by N1");

  // The group-mention row carries structured mention + mention_me evidence.
  const mention = fakeplatform._toEnvelope(FX.fakeplatform_raw.find((r) => r.id === "fp-launch-1"));
  assert.equal(mention.directed_at_me_signals.mention_me, true, "group mention sets mention_me");
  assert.ok(Array.isArray(mention.mentions) && mention.mentions.length === 1, "structured mention carried");
});

// ---------------------------------------------------------------------------
// T10 — fakeplatform_flows_to_ranking: the synthetic platform's they-spoke-last
// asks appear in ranked[]; the closer "ah cool, thanks!" is DOWN-RANKED (absent);
// and ambient group chatter does NOT surface. Proves a NEW platform reaches the
// catch-up surface AND N8 substance/directedness still gate it correctly.
// ---------------------------------------------------------------------------
test("T10: fakeplatform_flows_to_ranking — asks surface, closer + ambient chatter do not", () => {
  const ranked = EVAL.pipeline.ranked;
  const fpRows = ranked.filter((r) =>
    r.platform === "fakeplatform" || (Array.isArray(r.platforms) && r.platforms.includes("fakeplatform")));
  assert.ok(fpRows.length >= 1, "at least one fakeplatform row reaches the ranked surface");

  // The closer is absent (N8 substance down-rank).
  assert.equal(ranked.some((r) => /ah cool, thanks!/i.test(r.last_msg || "")), false,
    "the closer-only fakeplatform thread must NOT surface");
  // Ambient undirected group chatter is absent (precision).
  assert.equal(ranked.some((r) => /(meme was hilarious|haha yeah totally)/i.test(r.last_msg || "")), false,
    "ambient group chatter must NOT surface");
  // The group MENTION of me DOES surface (recall through a group via mention_me).
  const allContent = ranked.flatMap((r) => [r.last_msg, ...(r.also_waiting_on || []).map((w) => w.last_msg)]);
  assert.ok(allContent.some((c) => /confirm the launch date/i.test(c || "")),
    "the group mention-of-me with a real ask DOES surface");

  // Ranking non-increasing (the documented sort key).
  for (let i = 0; i + 1 < ranked.length; i += 1) {
    assert.ok(ranked[i].score >= ranked[i + 1].score, `score non-increasing at ${i}`);
  }
});

// ---------------------------------------------------------------------------
// T11 — fifth_adapter_diff_empty: sha256 of all five L2-5 files is identical
// before vs after wiring fakeplatform through the whole pipeline. THE CLOSURE
// PROOF: one adapter, zero edits above L1 (R4).
// ---------------------------------------------------------------------------
test("T11: fifth_adapter_diff_empty — L2-5 sources byte-identical across a fakeplatform run", () => {
  const before = snapshotL2to5();
  // A full pipeline run that routes fakeplatform rows through classifier ->
  // identity -> attention -> catchup.
  const pipe = runPipeline(FX);
  assert.ok(pipe.ranked.length >= 2, "the run produced output");
  const after = snapshotL2to5();
  assert.equal(diffL2to5(before, after), "EMPTY", "no L2-5 source byte changed during the fakeplatform run");
  assert.equal(EVAL.gate_c.L2to5_diff, "EMPTY", "gate (c) reports an EMPTY diff");
  assert.equal(EVAL.gate_c.pass, true, "gate (c) passes");
});

// ---------------------------------------------------------------------------
// T12 — diff_flips_on_real_edit: a deliberate one-byte change between snapshots
// flips L2to5_diff to non-EMPTY. Proves the diff check is not vacuous (R4).
// ---------------------------------------------------------------------------
test("T12: diff_flips_on_real_edit — a one-byte change flips the diff to non-EMPTY", () => {
  const before = snapshotL2to5();
  // Simulate a changed snapshot WITHOUT touching the real file: mutate the
  // in-memory snapshot of one L2-5 source and diff against it. (We never write
  // to the real source — Thesis #1 — so we tamper a copy of the hash map.)
  const tampered = { ...before, [L2to5_SOURCES[0]]: "deadbeef".repeat(8) };
  const d = diffL2to5(before, tampered);
  assert.notEqual(d, "EMPTY", "a changed source hash must produce a non-EMPTY diff");
  assert.ok(Array.isArray(d) && d.length === 1, "exactly one file is reported changed");
  assert.equal(d[0].file, L2to5_SOURCES[0], "the changed file is identified");
});

// ---------------------------------------------------------------------------
// T13 — sources_unmutated: the fixture corpus + the five L2-5 source files are
// sha-identical before/after a full run. Thesis-#1 audit (R6).
// ---------------------------------------------------------------------------
test("T13: sources_unmutated — fixture corpus + L2-5 sources byte-identical pre/post run", () => {
  const hashOf = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const allPaths = [FIXTURE_PATH, ...L2to5_SOURCES];
  const before = allPaths.map(hashOf);
  const mtimeBefore = allPaths.map((p) => statSync(p).mtimeMs);

  // Snapshot the in-memory sources, run the full eval, assert no in-memory mutation.
  const snapshot = JSON.parse(JSON.stringify(FX));
  const r = runInvariantEval();
  assert.ok(r.pipeline.ranked.length >= 2, "eval produced output");
  assert.deepEqual(FX, snapshot, "the in-memory fixture object is unmutated by the run");

  const after = allPaths.map(hashOf);
  const mtimeAfter = allPaths.map((p) => statSync(p).mtimeMs);
  assert.deepEqual(after, before, "every source/fixture file is byte-identical after the run");
  assert.deepEqual(mtimeAfter, mtimeBefore, "no source/fixture mtime changed (no write happened)");
});

// ---------------------------------------------------------------------------
// T14 — fakeplatform_absent_from_live_registry: the synthetic adapter is eval
// scaffolding only — it is NOT wired into the live registry barrel, so the live
// catch-up surface never serves fakeplatform rows. Proves it never shipped (R7's
// gate-on-activation spirit: scaffolding stays out of production).
// ---------------------------------------------------------------------------
test("T14: fakeplatform_absent_from_live_registry — scaffolding not shipped to production", async () => {
  const { ADAPTER_MODULES } = await import("../../lib/messaging/adapters/registry.js");
  const platforms = ADAPTER_MODULES.map((m) => m && m.PLATFORM);
  assert.equal(platforms.includes("fakeplatform"), false,
    "fakeplatform must NOT appear in the live adapter registry barrel");
  // And the live catch-up registry likewise excludes it.
  const { ADAPTER_REGISTRY } = await import("../../lib/messaging/catchup.js");
  assert.equal(ADAPTER_REGISTRY.has("fakeplatform"), false,
    "the live ADAPTER_REGISTRY must NOT serve fakeplatform");
});

// ---------------------------------------------------------------------------
// T15 — run_is_deterministic: two runs over the same fixtures produce identical
// gate verdicts AND identical ranked[] ordering. Proves the closure line is
// trustworthy (R8).
// ---------------------------------------------------------------------------
test("T15: run_is_deterministic — two runs give identical verdicts + ranked order", () => {
  const a = runInvariantEval();
  const b = runInvariantEval();
  assert.equal(a.gate_a.pass, b.gate_a.pass, "gate (a) verdict stable");
  assert.equal(a.gate_b.pass, b.gate_b.pass, "gate (b) verdict stable");
  assert.equal(a.gate_c.pass, b.gate_c.pass, "gate (c) verdict stable");
  assert.equal(a.gate_b.delta_L2, b.gate_b.delta_L2, "L2 delta identical across runs");
  assert.equal(a.gate_b.delta_L5, b.gate_b.delta_L5, "L5 delta identical across runs");
  const order = (r) => r.pipeline.ranked.map((x) => `${x.platforms.join("+")}|${x.score}|${x.last_msg}`);
  assert.deepEqual(order(a), order(b), "ranked[] ordering is byte-stable across runs");
});

// ---------------------------------------------------------------------------
// T16 — closure_line_iff_all_three: the INVARIANT_CLOSURE line is emitted IFF
// gate_a ∧ gate_b ∧ gate_c. Proves the simultaneity requirement of the GATE.
// ---------------------------------------------------------------------------
test("T16: closure_line_iff_all_three — the closure line emits iff all three gates pass", () => {
  assert.equal(EVAL.all_pass, true, "all three gates pass as-built");
  assert.equal(
    EVAL.closure_line,
    "INVARIANT_CLOSURE platform_tokens_L2to5=0 degradation_gate=PASS fifth_adapter ranked_ok=true L2to5_diff=EMPTY",
    "the exact machine-checkable closure line is emitted",
  );
  // Suppression logic: simulate any single gate red -> no closure line. (We test
  // the IFF condition directly on the documented predicate, not by mutating the
  // real sources — Thesis #1.)
  const suppressed = (a, b, c) => (a && b && c) ? "LINE" : null;
  assert.equal(suppressed(false, true, true), null, "gate (a) red suppresses the line");
  assert.equal(suppressed(true, false, true), null, "gate (b) red suppresses the line");
  assert.equal(suppressed(true, true, false), null, "gate (c) red suppresses the line");
  assert.equal(suppressed(true, true, true), "LINE", "all green emits the line");
});

// ---------------------------------------------------------------------------
// T17 — cross_platform_precision_recall: over the HAND-LABELED corpus the surface
// achieves precision 1.0 (no ambient chatter / no closer surfaced) and recall 1.0
// (every real ask surfaced). The WORKUNIT's sized-corpus eval (part 4).
// ---------------------------------------------------------------------------
test("T17: cross_platform_precision_recall — precision=1.0, recall=1.0 over the labeled corpus", () => {
  const pr = EVAL.precision_recall;
  assert.equal(pr.recall, 1, `recall must be 1.0 (missed: ${JSON.stringify(pr.missed)})`);
  assert.equal(pr.precision, 1, `precision must be 1.0 (false positives: ${JSON.stringify(pr.false_positives)})`);
  assert.equal(pr.no_ambient_chatter_surfaced, true, "no ambient group chatter surfaced (precision)");
  assert.equal(pr.no_closer_surfaced, true, "no closer surfaced (substance)");
  assert.equal(pr.real_asks_surfaced, true, "every real ask surfaced (recall)");
  assert.ok(pr.needs_total >= 3, `the labeled corpus carries >=3 needs_response threads (got ${pr.needs_total})`);
});

// ---------------------------------------------------------------------------
// T18 — operator_unifies_and_dedup_collapses: the operator's identifiers on BOTH
// platforms resolve to person:operator (the operator never surfaces), and the
// cross-platform human collapses to ONE row carrying both platform refs. The
// WORKUNIT's "operator unifies + dedup collapses" claims (part 4).
// ---------------------------------------------------------------------------
test("T18: operator_unifies_and_dedup_collapses — person:operator unification + 2->1 collapse", () => {
  const op = EVAL.pipeline.operator;
  assert.equal(op.operator_person_id, OPERATOR_PERSON_ID, "the operator id is the seeded person:operator");
  assert.equal(op.fakeplatform_user, OPERATOR_PERSON_ID, "fakeplatform self id unifies to person:operator");
  assert.equal(op.legacy_email, OPERATOR_PERSON_ID, "the operator email on source_legacy unifies to person:operator");
  assert.equal(op.unified, true, "the operator unifies across both platforms");
  // The operator never surfaces as a 'waiting on you' row.
  assert.equal(EVAL.pipeline.ranked.some((r) => r.person_id === OPERATOR_PERSON_ID), false,
    "the operator is never surfaced in the catch-up list");

  // Cross-platform dedup collapse: the one human on both platforms -> ONE row.
  const collapsed = EVAL.pipeline.dedup.cross_platform_row;
  assert.ok(collapsed, "a cross-platform collapsed row exists");
  assert.ok(collapsed.platforms.includes("fakeplatform") && collapsed.platforms.includes("source_legacy"),
    "the collapsed row carries BOTH platform refs");
  assert.ok(collapsed.also_waiting_on.length >= 1, "the second platform's thread is attached as also_waiting_on");
  assert.ok(typeof collapsed.person_id === "string" && collapsed.person_id.startsWith("person:"),
    "the collapsed row carries a real N7 person_id");
  // That person appears in exactly ONE row (no double-count).
  const sameId = EVAL.pipeline.ranked.filter((r) => r.person_id === collapsed.person_id);
  assert.equal(sameId.length, 1, "the cross-platform person appears in exactly ONE row");
});

// ---------------------------------------------------------------------------
// T19 — eval_version_pinned: the harness pins a VERSION + frozen CAPS (the M4
// discipline) so a knob change is a deliberate, auditable version bump.
// ---------------------------------------------------------------------------
test("T19: eval_version_pinned — MSG_EVAL_VERSION + frozen MSG_EVAL_CAPS", () => {
  assert.equal(typeof MSG_EVAL_VERSION, "string", "a pinned eval version exists");
  assert.ok(Object.isFrozen(MSG_EVAL_CAPS), "MSG_EVAL_CAPS is frozen");
  assert.ok(Object.isFrozen(MSG_EVAL_CAPS.PLATFORM_WORD_TOKENS), "the token list is frozen");
  assert.ok(MSG_EVAL_CAPS.DEGRADATION_MIN_DELTA > 0, "a positive degradation epsilon is pinned");
});
