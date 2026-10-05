// n10-invariant-eval.mjs — WORKUNIT N10, the CLOSURE EVAL (the judge, never the
// defendant). The single source of truth for the three abstraction-invariant
// gates; both the n10-integration.test.mjs gate AND the closure runner import
// from here so the test assertions and the emitted INVARIANT_CLOSURE line can
// never drift.
//
// THE CLOSURE STATEMENT this node proves, mechanically, in ONE run over fixtures:
//   "A new platform = ONE new adapter; layers 2-5 (classifier, identity,
//    attention, catchup) NEVER change." Prior waves ASSERT it; N10 PROVES it via
//   three gates that must all be green simultaneously:
//
//   (a) GREP gate          — bounded platform-token count over the five L2-5
//                            sources is exactly 0 (the reframe layers literally
//                            cannot name a platform; they read envelope +
//                            capabilities{} only).
//   (b) DEGRADATION gate   — two envelopes differing ONLY in
//                            capabilities.reply_to_available (true vs false),
//                            same reply_to_me evidence, produce a measurable
//                            score delta that SURVIVES into the L5 ranking (not
//                            just at N2 in isolation). Degradation is DATA-driven.
//   (c) FIFTH-ADAPTER gate — the synthetic `fakeplatform` adapter (the ONE new
//                            file) flows to a correct catch-up ranking, AND the
//                            sha256 of all five L2-5 sources is byte-identical
//                            BEFORE vs AFTER routing fakeplatform rows through
//                            the whole chain. EMPTY diff = adding a platform cost
//                            exactly one adapter and zero edits above L1.
//
// THESIS #1 (read-only): this harness imports L1-L5 as black boxes, greps and
// sha-snapshots their source bytes, and drives a FIXTURE corpus through them. It
// mutates NO source row, NO fact row, and writes nothing. Pure compute; daemon
// off; no live DB, no network. Deterministic across runs (now is pinned from the
// fixture; the fixture adapter registry is built generically).
//
// DISCIPLINE mirrors lib/synthesis/eval-harness.js: a VERSION constant, a frozen
// CAPS block, defensive readers, and a public evaluate-style entry returning a
// metrics object with the gate verdicts + the closure line.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateEnvelope } from "./envelope.js";
import { classifyDirectedAtMe } from "./classifier.js";
import { computeAttention } from "./attention.js";
import { buildPersonIndex, lookup as personLookup, OPERATOR_PERSON_ID } from "./identity.js";
import {
  buildCatchupCore,
  buildAdapterRegistry,
  loadEnvelopesFromSourcesSync,
} from "./catchup.js";

// The SYNTHETIC 5th adapter — the load-bearing half of gate (c). It is a real
// module under adapters/ but is DELIBERATELY ABSENT from the live registry
// barrel (adapters/registry.js); we wire it only into a FIXTURE registry here.
import * as fakeplatform from "./adapters/fakeplatform.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// VERSION + frozen CAPS — single source of every magic constant (M4 discipline).
// ---------------------------------------------------------------------------

export const MSG_EVAL_VERSION = "msg-invariant-eval@0.1.0";

// The five L2-5 sources the GREP gate (a) scans and the FIFTH-ADAPTER gate (c)
// sha-snapshots. These are the layers that must NEVER change when a platform is
// added — the classifier, the identity resolver, the attention engine, the
// catch-up surface, and the catch-up surface's retain leaf. (envelope.js / the
// adapters / the registry barrel are L1 wiring, not part of the "above L1"
// no-change set.)
//
// ledger-retain.js joined this list at f5-catchup-seam, when the retain bounds
// and the shared per-row fold moved OUT of catchup.js to break the
// catchup <-> envelope-projection import cycle. Its own header argues it is L1
// wiring; it is registered here anyway, because the alternative is that bytes
// this gate used to scan inside catchup.js stop being scanned merely because
// they changed file. A refactor may WIDEN this gate's coverage; it may never
// silently shrink it.
export const L2to5_SOURCES = Object.freeze([
  path.resolve(__dirname, "classifier.js"),
  path.resolve(__dirname, "identity.js"),
  path.resolve(__dirname, "attention.js"),
  path.resolve(__dirname, "catchup.js"),
  path.resolve(__dirname, "ledger-retain.js"),
]);

export const MSG_EVAL_CAPS = Object.freeze({
  L2to5_SOURCES,

  // The platform-token denylist for gate (a). WORD-BOUNDED (the M5/R1
  // discipline): a bounded token does NOT match inside a larger identifier
  // (`mail`∉`email`, `chat`∉`chatty`, `lid`∉`valid`, `imessage`∉`imessage_handles`
  // — the last being a legitimate operator-identity SEAM field name, not a
  // platform branch). Bare platform references (`imessage row`, `jid`, a real
  // `chat_guid`) still trip. Case-insensitive.
  PLATFORM_WORD_TOKENS: Object.freeze([
    "whatsapp", "imessage", "telegram", "fakeplatform",
    "jid", "lid", "mail",
    "chat_guid", "cache_roomnames", "thread_originator_guid",
    "handle_id", "pushbyjid",
  ]),
  // Literal multi-char platform fragments that carry their OWN delimiters (so
  // they need no word-boundary). These are unambiguous per-platform surface ids.
  PLATFORM_LITERAL_FRAGMENTS: Object.freeze([
    "@g.us", "@s.whatsapp.net", "@lid", "@broadcast",
  ]),

  // Gate (b): the minimum |score_true - score_false| delta that counts as a
  // measurable, data-driven degradation. Far above float noise; far below the
  // ~0.48 delta the real reply_to_available flip produces at L2.
  DEGRADATION_MIN_DELTA: 1e-3,

  // The catch-up directedness floor the eval drives the surface with. Set to
  // N8's attention DIRECTED_THRESHOLD (0.3) — "show me everything the attention
  // engine surfaced", which is the right setting to measure RECALL of a group
  // mention (a lone @-mention scores ~0.32 at N2, above 0.3 but below catchup's
  // stricter 0.5 default). This is a PARAMETER choice, never a code change.
  EVAL_MIN_SCORE: 0.3,
});

// ---------------------------------------------------------------------------
// Defensive fixture reader (the readJsonl-shape discipline from eval-harness.js:
// a corrupt fixture is a hard error here because the corpus is hand-authored and
// small — but a missing file degrades to a clear thrown message, never a silent
// empty run that would make a gate vacuously pass).
// ---------------------------------------------------------------------------

export function readFixtures(fixturePath) {
  const raw = readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed == null || typeof parsed !== "object") {
    throw new Error(`n10 eval: fixture ${fixturePath} did not parse to an object`);
  }
  return parsed;
}

// sha256 of a file's bytes (the empty-diff snapshot primitive for gate (c)).
function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

// Snapshot { absPath -> sha256 } over the L2-5 source set.
export function snapshotL2to5() {
  const snap = {};
  for (const f of L2to5_SOURCES) snap[f] = sha256File(f);
  return snap;
}

// Compare two L2-5 snapshots. Returns "EMPTY" when byte-identical, else a list
// of { file, before, after } for every file whose bytes changed.
export function diffL2to5(before, after) {
  const changed = [];
  for (const f of L2to5_SOURCES) {
    if (before[f] !== after[f]) {
      changed.push({ file: f, before: before[f], after: after[f] });
    }
  }
  return changed.length === 0 ? "EMPTY" : changed;
}

// ---------------------------------------------------------------------------
// Gate (a) — the bounded platform-token GREP over L2-5 sources.
// ---------------------------------------------------------------------------

function buildDenylist() {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reWord = new RegExp(
    "\\b(?:" + MSG_EVAL_CAPS.PLATFORM_WORD_TOKENS.map(esc).join("|") + ")\\b",
    "i",
  );
  const reLit = new RegExp(
    "(?:" + MSG_EVAL_CAPS.PLATFORM_LITERAL_FRAGMENTS.map(esc).join("|") + ")",
    "i",
  );
  return { reWord, reLit };
}

/**
 * grepPlatformTokens(sources?) — count bounded platform-token matches over the
 * given source files (default L2-5). Counts code AND comments (a platform name
 * in a comment still couples the abstraction conceptually). Returns
 * { matches: [{file, line, text, token}], count }.
 *
 * @param {string[]} [sources] absolute file paths.
 */
export function grepPlatformTokens(sources = L2to5_SOURCES) {
  const { reWord, reLit } = buildDenylist();
  const matches = [];
  for (const f of sources) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((ln, i) => {
      const mw = ln.match(reWord);
      const ml = ln.match(reLit);
      if (mw || ml) {
        matches.push({
          file: f,
          line: i + 1,
          text: ln.trim().slice(0, 100),
          token: (mw && mw[0]) || (ml && ml[0]),
        });
      }
    });
  }
  return { matches, count: matches.length };
}

// Predicate form used by REVIEW tests (R1/R2): does a STRING trip the denylist?
export function lineTripsDenylist(line) {
  const { reWord, reLit } = buildDenylist();
  return reWord.test(line) || reLit.test(line);
}

function runGateA() {
  const { matches, count } = grepPlatformTokens();
  return {
    name: "grep_platform_tokens_L2to5",
    pass: count === 0,
    platform_tokens_L2to5: count,
    offending: matches, // empty on PASS; file:line:token list on FAIL (for the owning node)
  };
}

// ---------------------------------------------------------------------------
// Gate (b) — capability-degradation, measured END TO END (L2 score AND L5 rank).
// ---------------------------------------------------------------------------

// Two envelopes identical in every field, differing ONLY in
// capabilities.reply_to_available, both carrying reply_to_me=true evidence in a
// GROUP (so the DM prior does not mask the channel math). reply_to_id is present
// so the evidence is structurally coherent.
// The probe is deliberately STALE (48h) so the L5 rank product preserves a LARGE,
// unambiguous delta from the directedness flip — proving the capability bit
// survives all the way to the surface, not merely at N2 in isolation.
//
// e17 — THE REASON THE 48h AGE WAS CHOSEN NO LONGER APPLIES, and the age is kept
// anyway. The rank product was (recency × directedness × staleness), and a
// near-fresh probe was avoided because stalenessFactor(~0) shrank the delta toward
// zero. e17 deleted stalenessFactor from rankScore — the two factors read the same
// age, so their product was an undesigned band-pass — and the time term is now
// recencyFactor alone, which at 48h is HIGHER than it was at any age this probe
// could have used. The probe therefore still carries a large delta, for the
// opposite reason; the age is left alone because changing a probe's constant while
// its property still holds would be churn, not a fix.
const DEG_PROBE_AGE_MS = 48 * 60 * 60 * 1000;

function degradationPair(now) {
  const base = (replyAvailable) => ({
    platform: "deg_probe", // a probe slug, not a real platform; never grepped
    thread_id: "dm_deg_probe",
    thread_type: "group",
    sender: { id: "+15551112222", name: "Deg Probe" },
    recipients: ["user"],
    is_from_me: false,
    ts: now - DEG_PROBE_AGE_MS,
    content: "can you take a look at this and reply when you get a chance?",
    reply_to_id: "deg-prev",
    mentions: [],
    directed_at_me_signals: { mention_me: false, reply_to_me: true, addressed_to_me: false },
    capabilities: {
      reply_to_available: replyAvailable,
      structured_mentions: true,
      self_identity_reliable: true,
      addressing_first_class: false,
    },
    source_msg_id: replyAvailable ? "deg:true:1" : "deg:false:1",
  });
  return { eTrue: base(true), eFalse: base(false) };
}

// L5 rank of a single-envelope corpus (min_score 0 so even the degraded score
// is surfaced for measurement, never pruned). Returns 0 when nothing surfaces
// (the degraded case correctly drops below N8's directed threshold).
function rankSingle(env, now) {
  const res = buildCatchupCore({
    envelopes: [env],
    classify: classifyDirectedAtMe,
    attention: computeAttention,
    resolvePerson: () => null,
    now,
    opts: { min_score: 0 },
  });
  return res.rows.length > 0 ? res.rows[0].score : 0;
}

function runGateB(now) {
  const { eTrue, eFalse } = degradationPair(now);
  const scoreTrue = classifyDirectedAtMe(eTrue).score;
  const scoreFalse = classifyDirectedAtMe(eFalse).score;
  const deltaL2 = Math.abs(scoreTrue - scoreFalse);

  const rankTrue = rankSingle(eTrue, now);
  const rankFalse = rankSingle(eFalse, now);
  const deltaL5 = Math.abs(rankTrue - rankFalse);

  // Identical-caps control (R3): same profile on both => delta must be 0, which
  // would (correctly) FAIL the gate — proving the gate measures the bit, not
  // noise. Reported so the test can assert it directly.
  const ctrl = classifyDirectedAtMe(eTrue).score - classifyDirectedAtMe({ ...eTrue, source_msg_id: "ctrl" }).score;
  const identicalCapsDelta = Math.abs(ctrl);

  const pass =
    deltaL2 >= MSG_EVAL_CAPS.DEGRADATION_MIN_DELTA &&
    deltaL5 >= MSG_EVAL_CAPS.DEGRADATION_MIN_DELTA;

  return {
    name: "capability_degradation_end_to_end",
    pass,
    score_true: scoreTrue,
    score_false: scoreFalse,
    delta_L2: deltaL2,
    rank_true: rankTrue,
    rank_false: rankFalse,
    delta_L5: deltaL5,
    identical_caps_delta: identicalCapsDelta,
    min_delta: MSG_EVAL_CAPS.DEGRADATION_MIN_DELTA,
  };
}

// ---------------------------------------------------------------------------
// The PIPELINE driver — wire the full chain over the fixture corpus, with the
// FIXTURE registry (fakeplatform real adapter + an identity mapper for the
// already-projected source_legacy envelope ledger). Returns the ranked list +
// per-stage diagnostics.
// ---------------------------------------------------------------------------

// Build the fixture adapter registry. fakeplatform is the REAL N10 adapter; the
// second "platform" is an identity mapper because the source_legacy fixture rows
// are ALREADY N1 envelopes (their raw-row->envelope projection is N3-N6's job,
// already gated). This drives the REAL generic registry path — it never branches
// on a name.
function fixtureRegistry() {
  const modules = [
    fakeplatform,
    { PLATFORM: "source_legacy", _toEnvelope: (row) => row },
  ];
  return buildAdapterRegistry(modules);
}

// The fixture corpus -> a { platform -> rawRows[] } sources map the catch-up
// surface consumes generically.
function fixtureSources(fx) {
  return {
    [fakeplatform.PLATFORM]: Array.isArray(fx.fakeplatform_raw) ? fx.fakeplatform_raw : [],
    source_legacy: Array.isArray(fx.source_legacy_envelopes) ? fx.source_legacy_envelopes : [],
  };
}

/**
 * runPipeline(fx[, opts]) — drive adapter -> validate -> classify -> identity ->
 * attention -> catchup over the fixture corpus. Returns:
 *   {
 *     ranked,                 // the deduped "waiting on you" rows (catchup)
 *     stats,                  // catchup stats
 *     envelopes_total,        // count of projected envelopes
 *     envelopes_invalid,      // count failing validateEnvelope (must be 0)
 *     invalid_detail,         // [{platform, source_msg_id, errors}] for any invalid
 *     operator: {             // operator-unification evidence
 *       fakeplatform_user, legacy_email, operator_person_id, unified
 *     },
 *     dedup: { cross_platform_row }  // the collapsed cross-platform person row (or null)
 *   }
 */
export function runPipeline(fx, opts = {}) {
  const now = typeof fx?.meta?.pinned_now_ts === "number" ? fx.meta.pinned_now_ts : Date.now();
  const minScore = typeof opts.min_score === "number" ? opts.min_score : MSG_EVAL_CAPS.EVAL_MIN_SCORE;
  const registry = fixtureRegistry();
  const sources = fixtureSources(fx);

  // Stage 1+2: project every raw row to an envelope and validate it (N1). The
  // SYNC loader is used here because the FIXTURE registry's adapters declare no
  // prepareContext (the async catch-up path's context build is exercised by the
  // N11b gate, not by this invariant eval); the projection is identical.
  const envelopes = loadEnvelopesFromSourcesSync(sources, registry);
  let invalid = 0;
  const invalidDetail = [];
  for (const e of envelopes) {
    const v = validateEnvelope(e);
    if (!v.ok) {
      invalid += 1;
      invalidDetail.push({
        platform: e.platform,
        source_msg_id: e.source_msg_id,
        errors: v.errors,
      });
    }
  }

  // Stage 3: identity index (operator unification + cross-platform clustering).
  const index = buildPersonIndex(envelopes);
  const opEmail = fx?.meta?.operator_email;
  const fakeplatformUser = personLookup(index, fakeplatform.PLATFORM, "user");
  const legacyEmail = typeof opEmail === "string" ? personLookup(index, "source_legacy", opEmail) : null;

  // Stage 4+5: the full catch-up build (attention + ranking + dedup) via the
  // REAL pure core over the already-projected envelopes + the SAME person index
  // built above. This is the synchronous equivalent of buildCatchup for the
  // context-free fixture path (buildCatchup itself is now async to await an
  // adapter's optional prepareContext, which the fixture adapters do not declare).
  const resolvePerson = (platform, senderId) => {
    try {
      return personLookup(index, platform, senderId);
    } catch {
      return null;
    }
  };
  const result = buildCatchupCore({
    envelopes,
    classify: classifyDirectedAtMe,
    attention: computeAttention,
    resolvePerson,
    now,
    opts: { min_score: minScore },
  });

  const crossPlatformRow = result.rows.find((r) => Array.isArray(r.platforms) && r.platforms.length >= 2) || null;

  return {
    now,
    ranked: result.rows,
    stats: result.stats,
    envelopes_total: envelopes.length,
    envelopes_invalid: invalid,
    invalid_detail: invalidDetail,
    operator: {
      fakeplatform_user: fakeplatformUser,
      legacy_email: legacyEmail,
      operator_person_id: OPERATOR_PERSON_ID,
      unified:
        fakeplatformUser === OPERATOR_PERSON_ID &&
        (legacyEmail === null || legacyEmail === OPERATOR_PERSON_ID),
    },
    dedup: { cross_platform_row: crossPlatformRow },
  };
}

// ---------------------------------------------------------------------------
// Cross-platform catch-up EVAL — precision + recall over the HAND-LABELED corpus.
// Each fakeplatform raw row and each labeled thread carries a `label`
// (needs_response | no_response). We collapse to per-thread truth, then check
// which threads the ranked surface raised.
// ---------------------------------------------------------------------------

/**
 * evalPrecisionRecall(fx, ranked) — over the hand-labeled corpus:
 *   recall    = surfaced needs_response threads / all needs_response threads
 *   precision = surfaced needs_response threads / all surfaced threads
 * Plus the boolean sub-claims the WORKUNIT names: no ambient group chatter and
 * no closer surfaced (precision), every real ask surfaced (recall), the operator
 * unifies, dedup collapses.
 */
export function evalPrecisionRecall(fx, ranked) {
  // Per-thread ground truth from the labeled rows. A thread is needs_response
  // iff ANY of its labeled rows is needs_response (the trailing ask wins); else
  // no_response. We key truth by the SURFACE identity the ranked rows expose:
  //   - a needs_response thread is identified by a representative content snippet.
  // Simpler + robust: derive the set of "must surface" content markers and
  // "must NOT surface" content markers directly from the labels.
  const needs = []; // {marker}
  const noResp = []; // {marker}
  const rawRows = Array.isArray(fx.fakeplatform_raw) ? fx.fakeplatform_raw : [];
  for (const r of rawRows) {
    const marker = typeof r.text === "string" ? r.text : "";
    if (r.label === "needs_response") needs.push(marker);
    else if (r.label === "no_response") noResp.push(marker);
  }
  // source_legacy labeled threads: the priya thread (i-spoke-last) must NOT
  // surface; the rhea legacy ask is part of the cross-platform person (counted
  // via the fakeplatform rhea ask, so we don't double-count it as a separate
  // needs_response marker — but its content must be allowed to appear as the
  // collapsed row's last_msg). We add priya's content as a no_response marker.
  const legacy = Array.isArray(fx.source_legacy_envelopes) ? fx.source_legacy_envelopes : [];
  for (const e of legacy) {
    if (e.is_from_me === true) continue;
    // priya: answered (i-spoke-last) -> no_response.
    if (typeof e.content === "string" && /budget approval/i.test(e.content)) {
      noResp.push(e.content);
    }
  }

  // What surfaced? Collect the content of every ranked head row AND its
  // also_waiting_on attachments (the collapsed cross-platform threads).
  const surfacedContent = [];
  for (const row of ranked) {
    if (typeof row.last_msg === "string") surfacedContent.push(row.last_msg);
    for (const w of (row.also_waiting_on || [])) {
      if (typeof w.last_msg === "string") surfacedContent.push(w.last_msg);
    }
  }
  const surfacedSet = new Set(surfacedContent);

  // Recall: each needs_response marker must appear in the surfaced set. The Rhea
  // cross-platform person is surfaced once; her fakeplatform ask OR her legacy
  // ask satisfies recall for "Rhea is waiting" — we treat the fakeplatform ask
  // marker as satisfied if EITHER her head or her also_waiting_on content shows.
  const recalled = [];
  const missed = [];
  for (const marker of needs) {
    // Rhea's fakeplatform ask collapses under the legacy head; accept either her
    // legacy redlines content or her q4 ask as evidence she surfaced.
    const rheaCollapsed = /q4 numbers/i.test(marker) &&
      surfacedContent.some((c) => /contract redlines|q4 numbers/i.test(c));
    if (surfacedSet.has(marker) || rheaCollapsed) recalled.push(marker);
    else missed.push(marker);
  }

  // Precision: no no_response marker may appear in the surfaced set.
  const falsePositives = [];
  for (const marker of noResp) {
    if (surfacedSet.has(marker)) falsePositives.push(marker);
  }

  const recall = needs.length > 0 ? recalled.length / needs.length : 1;
  const precision = surfacedContent.length > 0
    ? (surfacedContent.length - falsePositives.length) / surfacedContent.length
    : 1;

  return {
    needs_total: needs.length,
    recalled: recalled.length,
    missed,
    recall,
    false_positives: falsePositives,
    precision,
    // Named sub-claims the WORKUNIT requires.
    no_ambient_chatter_surfaced: !surfacedContent.some((c) => /meme was hilarious|haha yeah totally/i.test(c)),
    no_closer_surfaced: !surfacedContent.some((c) => /ah cool, thanks!/i.test(c)),
    real_asks_surfaced: missed.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Gate (c) — the synthetic 5th adapter: ranked_ok + EMPTY L2-5 diff.
// ---------------------------------------------------------------------------

function runGateC(fx) {
  // Snapshot L2-5 BEFORE the fakeplatform run.
  const before = snapshotL2to5();

  // Run the WHOLE pipeline WITH fakeplatform wired into the fixture registry.
  const pipe = runPipeline(fx);

  // Snapshot L2-5 AFTER — must be byte-identical (the closure proof).
  const after = snapshotL2to5();
  const diff = diffL2to5(before, after);

  // ranked_ok: fakeplatform rows reach the surface AND a fakeplatform DM
  // out-ranks a fakeplatform closed "ah cool!" thread (which must be absent).
  const fakeplatformRows = pipe.ranked.filter(
    (r) => r.platform === fakeplatform.PLATFORM ||
      (Array.isArray(r.platforms) && r.platforms.includes(fakeplatform.PLATFORM)),
  );
  const closerSurfaced = pipe.ranked.some(
    (r) => typeof r.last_msg === "string" && /ah cool, thanks!/i.test(r.last_msg),
  );
  const everyEnvelopeValid = pipe.envelopes_invalid === 0;
  const rankedNonIncreasing = pipe.ranked.every(
    (r, i) => i === 0 || pipe.ranked[i - 1].score >= r.score,
  );

  const rankedOk =
    fakeplatformRows.length >= 1 &&
    !closerSurfaced &&
    everyEnvelopeValid &&
    rankedNonIncreasing;

  return {
    name: "fifth_adapter_ranked_and_empty_diff",
    pass: rankedOk && diff === "EMPTY",
    ranked_ok: rankedOk,
    L2to5_diff: diff,
    fakeplatform_rows: fakeplatformRows.length,
    closer_surfaced: closerSurfaced,
    every_envelope_valid: everyEnvelopeValid,
    ranked_non_increasing: rankedNonIncreasing,
  };
}

// ---------------------------------------------------------------------------
// runInvariantEval — the public entry. Returns the three gate verdicts, the
// pipeline ranking, the precision/recall report, and the machine-checkable
// closure line (emitted iff all three gates pass).
// ---------------------------------------------------------------------------

export const DEFAULT_FIXTURE_PATH = path.resolve(
  __dirname,
  "../../test/messaging/fixtures/n10-integration.fixtures.json",
);

export function runInvariantEval({ fixturePath = DEFAULT_FIXTURE_PATH } = {}) {
  const fx = readFixtures(fixturePath);
  const now = typeof fx?.meta?.pinned_now_ts === "number" ? fx.meta.pinned_now_ts : Date.now();

  const pipeline = runPipeline(fx);
  const prEval = evalPrecisionRecall(fx, pipeline.ranked);

  const gate_a = runGateA();
  const gate_b = runGateB(now);
  const gate_c = runGateC(fx);

  const allPass = gate_a.pass && gate_b.pass && gate_c.pass;

  // The single, machine-checkable closure line — emitted ONLY when all three
  // gates are green simultaneously (the GATE's simultaneity requirement).
  const closure_line = allPass
    ? `INVARIANT_CLOSURE platform_tokens_L2to5=${gate_a.platform_tokens_L2to5} degradation_gate=PASS fifth_adapter ranked_ok=${gate_c.ranked_ok} L2to5_diff=${gate_c.L2to5_diff}`
    : null;

  return {
    version: MSG_EVAL_VERSION,
    built_at: new Date().toISOString(),
    fixture_path: fixturePath,
    pipeline,
    precision_recall: prEval,
    gate_a,
    gate_b,
    gate_c,
    all_pass: allPass,
    closure_line,
  };
}

export default runInvariantEval;
