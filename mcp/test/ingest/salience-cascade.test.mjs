// salience-cascade.test.mjs — R25 fixture-battery for the three-layer salience
// cascade (mcp/lib/ingest/salience.js). 12 source-fixture cases spanning all
// five sources (iMessage, ScreenTime, git-log, github-events, chat-claude-code)
// plus five property tests enumerated in the R25+R26 bundle brief.
//
// HERMETIC: synthetic fixtures only; no real chat.db / knowledgeC.db / git
// reads. The HNSW kNN backend is replaced by a stub that returns canned
// neighbours; the index starts empty and is populated only by the fixtures
// declared in this file.
//
// Spec authority: kb/salience-design.md § R25 Implementation Sketch +
// R25+R26 bundle brief § "12 fixtures spanning all 5 sources + property tests".
//
// Stage-0 dispatch: this test wires the REAL Stage-0 modules
// (mcp/lib/ingest/stage0/{imessage,screentime,gitlog,githubevents}.js) into
// salience.js via _setStage0DispatchForTest so each fixture exercises the
// production hard-drop rules. Unknown sources (chat-claude-code) fall back to
// PASS, mirroring the production dispatcher's behaviour for unregistered
// sources.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic root MUST be set BEFORE any dynamic import touches config.js so
// the policy-event writer + ledger paths target the tmp dir.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-salience-cascade-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");
// Operator identity is resolved once at module load
// (lib/identity/operator-identity.js): pin the synthetic identity file here,
// before the first lib import, so no operator value is hardcoded below.
process.env.MEMORY_OPERATOR_IDENTITY_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "operator-identity.synthetic.json",
);
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const salienceMod = await import("../../lib/ingest/salience.js");
const { CAPS, SALIENCE_WEIGHTS_V1_HASH } = await import(
  "../../lib/validation.js"
);

// R25.6: the production loadStage0Dispatch() resolves mod.dispatch directly
// from stage0/index.js — no test-only adapter required. The previous
// _setStage0DispatchForTest((_src, ev) => stage0Dispatch(ev)) wiring was an
// ANTI-TEST that bridged a production export gap (mods.stage0.dispatch was
// undefined at runtime); R25.6 fixed the gap by exporting `dispatch` with a
// signature-tolerant alias. Removing the adapter forces the test to exercise
// the real production call path.

const NOW = new Date("2026-06-02T00:00:00Z");

// -----------------------------------------------------------------------------
// Fixture vector + stub HNSW helpers. All vectors are 768-dim unit-norm with
// a single off-axis perturbation so we can construct deterministic
// near-duplicates / far neighbours for the corroboration fixture (#12).
// -----------------------------------------------------------------------------

function unitVec(perturbation = 0) {
  const v = new Array(768).fill(0);
  v[0] = 1.0;
  if (perturbation !== 0) {
    v[1] = perturbation;
    const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    v[0] /= norm;
    v[1] /= norm;
  }
  return v;
}

function stubHnsw({ neighbours = [], size = null } = {}) {
  return {
    size: () => (size != null ? size : neighbours.length),
    search: () =>
      neighbours.map((n, i) => ({
        memory_id: n.memory_id,
        cosine_distance: n.distance,
        rank: i,
      })),
  };
}

const EMPTY_HNSW = stubHnsw({ neighbours: [], size: 0 });

// -----------------------------------------------------------------------------
// FIXTURE BATTERY — 12 cases, one per row in the brief.
// -----------------------------------------------------------------------------

// Fixture 1: iMessage 1:1 substantive prose → PROMOTE with score >= 0.55
test("F1: iMessage substantive prose → PROMOTE with score >= 0.55", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "imessage",
      source_msg_id: "imsg_f1_substantive",
      content:
        "We landed the salience cascade in R25 today and verified the corroboration thresholds match design doc empirics.",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        text: "We landed the salience cascade in R25 today and verified the corroboration thresholds match design doc empirics.",
        handle_id: "+15555550100",
      },
    },
    { embedding_mrl_768: unitVec(), hnsw: EMPTY_HNSW, now: NOW },
  );
  assert.equal(r.decision, "PROMOTE");
  assert.ok(
    r.score >= 0.55,
    `expected score >= 0.55 but got ${r.score}`,
  );
});

// Fixture 2: iMessage tapback (associated_message_type=2002) → DROP, reason "tapback"
test("F2: iMessage tapback (associated_message_type=2002) → DROP reason=tapback", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "imessage",
      source_msg_id: "imsg_f2_tapback",
      content: "heart",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        associated_message_type: 2002,
        text: "heart",
        handle_id: "+15555550100",
      },
    },
    { embedding_mrl_768: null, hnsw: null, now: NOW },
  );
  assert.equal(r.decision, "DROP");
  assert.equal(r.reason, "tapback");
});

// Fixture 3: iMessage urn:biz: handle → DROP, reason "business_handle"
test("F3: iMessage urn:biz: handle → DROP reason=business_handle", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "imessage",
      source_msg_id: "imsg_f3_biz",
      content: "Your order has shipped.",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        text: "Your order has shipped.",
        handle_id: "urn:biz:acme-shipping",
      },
    },
    { embedding_mrl_768: null, hnsw: null, now: NOW },
  );
  assert.equal(r.decision, "DROP");
  assert.equal(r.reason, "business_handle");
});

// Fixture 4: iMessage OTP ("Your OKX verification code is: 938210")
//   F-T1-IMESSAGE-F1 (critic-modified): the flat "otp_pattern" reason is
//   split into STRICT (REDACT_DROP + 30d quarantine, reason
//   "imessage_otp_strict") and LOOSE (PASS with digit block scrubbed,
//   reason "imessage_otp_redacted_kept"). This fixture is the strict
//   anchor form ("verification code is: NNNNNN") so it routes STRICT.
//   Raw content must never leak in the result regardless of branch.
test("F4: iMessage OTP strict anchor → REDACT_DROP reason=imessage_otp_strict; raw never logged", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "imessage",
      source_msg_id: "imsg_f4_otp",
      content: "Your OKX verification code is: 938210",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        text: "Your OKX verification code is: 938210",
        handle_id: "OKX",
      },
    },
    { embedding_mrl_768: null, hnsw: null, now: NOW },
  );
  assert.equal(r.decision, "REDACT_DROP");
  assert.equal(r.reason, "imessage_otp_strict");
  // Defence-in-depth: the result shape MUST NOT echo the OTP back.
  const serialized = JSON.stringify(r);
  assert.ok(!/938210/.test(serialized), "raw OTP must not appear in result");
});

// Fixture 5: iMessage placeholder residual (1-char text) → DROP, reason "placeholder_residual"
test("F5: iMessage placeholder residual (1-char text) → DROP reason=placeholder_residual", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "imessage",
      source_msg_id: "imsg_f5_placeholder",
      content: "X",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        text: "X",
        handle_id: "+15555550100",
      },
    },
    { embedding_mrl_768: null, hnsw: null, now: NOW },
  );
  assert.equal(r.decision, "DROP");
  assert.equal(r.reason, "placeholder_residual");
});

// Fixture 6: ScreenTime /safari/history substantive URL → PROMOTE
test("F6: ScreenTime /safari/history substantive row → PROMOTE", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "screentime",
      source_msg_id: "st_f6_safari_history",
      content:
        "Visited https://kb.salience-design.example.com/r25 — long read about ECN corroboration.",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        stream: "/safari/history",
        url: "https://kb.salience-design.example.com/r25",
      },
    },
    { embedding_mrl_768: unitVec(), hnsw: EMPTY_HNSW, now: NOW },
  );
  assert.equal(r.decision, "PROMOTE");
});

// Fixture 7: ScreenTime /discoverability/signals → DROP, reason "discoverability_signals"
test("F7: ScreenTime /discoverability/signals → DROP reason=discoverability_signals", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "screentime",
      source_msg_id: "st_f7_disco",
      content: "ranking signal payload",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        stream: "/discoverability/signals",
      },
    },
    { embedding_mrl_768: null, hnsw: null, now: NOW },
  );
  assert.equal(r.decision, "DROP");
  assert.equal(r.reason, "discoverability_signals");
});

// Fixture 8: git-log first-party substantive commit → PROMOTE with score >= 0.7
test("F8: git-log first-party substantive commit → PROMOTE with score >= 0.7", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "git-log",
      source_msg_id: "git_f8_substantive",
      content:
        "R25: wire salience cascade into distill-promote-fact with three-layer admission control",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        subject:
          "R25: wire salience cascade into distill-promote-fact with three-layer admission control",
        body:
          "Implements Layer-1 Stage-0 drops, Layer-2 mark-and-rank scoring, and Layer-3 ECN corroboration per kb/salience-design.md.",
        author_email: "alex@example.com",
      },
    },
    { embedding_mrl_768: unitVec(), hnsw: EMPTY_HNSW, now: NOW },
  );
  assert.equal(r.decision, "PROMOTE");
  assert.ok(
    r.score >= 0.7,
    `expected score >= 0.7 but got ${r.score}`,
  );
});

// Fixture 9: git-log "Initial commit" → DROP, reason
// "git_log_initial_commit_drop" (F-NEW-W2-GIT-LOG-STAGE0-INITIAL-COMMIT,
// Wave 3 — reason renamed from legacy "initial_commit" so the layer
// firing the rule is visible in telemetry, distinct from the connector
// layer's "git_log_initial_commit_variant").
//
// F-NEW-W7-GIT-LOG-RULE1-TIGHTEN: the rule now REQUIRES the subject prefix
// match AND a corroborating signal (parents=[] OR is_initial_commit hint).
// The fixture supplies parents=[] so the tightened predicate fires.
//
// F-NEW-W7-GIT-LOG-AUTHOR-SELF: operator-authored commits (including
// alex@example.com) route through Rule -1 (pass-through) AHEAD of the
// initial-commit rule. The fixture's author_email is therefore a
// non-operator address so the legacy DROP path is the one under test.
test("F9: git-log Initial commit → DROP reason=git_log_initial_commit_drop", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "git-log",
      source_msg_id: "git_f9_initial",
      content: "Initial commit",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        subject: "Initial commit",
        body: "",
        parents: [],
        author_email: "someone-else@example.com",
      },
    },
    { embedding_mrl_768: null, hnsw: null, now: NOW },
  );
  assert.equal(r.decision, "DROP");
  assert.equal(r.reason, "git_log_initial_commit_drop");
});

// Fixture 10: git-log dependabot version-bump → DROP, reason
// "git_log_version_bump_bot" (F-T1-GIT_LOG-F8, W7 Rule 2c).
//
// W7 introduces a dedicated version-bump bucket: when the subject matches
// VERSION_BUMP_SUBJECT_RE (/^(Bump|chore\(deps\)|update to latest)/i) AND
// the author is a bot, Rule 2c fires AHEAD of the generic Rule 3
// (bot_commit) and routes the row to quarantine with reason
// 'git_log_version_bump_bot'. This gives the operator a distinct
// telemetry bucket to monitor F8 fire-rate independently of generic
// bot commits per the F-T1-GIT_LOG-F8 critic spec.
test("F10: git-log dependabot version-bump → DROP reason=git_log_version_bump_bot", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "git-log",
      source_msg_id: "git_f10_bot",
      content: "Bump lodash from 4.17.20 to 4.17.21",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        subject: "Bump lodash from 4.17.20 to 4.17.21",
        body: "Bumps lodash from 4.17.20 to 4.17.21.",
        author_email: "49699333+dependabot[bot]@users.noreply.github.com",
      },
    },
    { embedding_mrl_768: null, hnsw: null, now: NOW },
  );
  assert.equal(r.decision, "DROP");
  assert.equal(r.reason, "git_log_version_bump_bot");
});

// Fixture 11: github-events WatchEvent → DROP, reason "low_signal_event"
test("F11: github-events WatchEvent → DROP reason=low_signal_event", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "github-events",
      source_msg_id: "gh_f11_watch",
      content: "starred memory-system",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        event_type: "WatchEvent",
        actor_login: "alex-example",
        repo: "alex-example/memory-system",
      },
    },
    { embedding_mrl_768: null, hnsw: null, now: NOW },
  );
  assert.equal(r.decision, "DROP");
  assert.equal(r.reason, "low_signal_event");
});

// Fixture 12: github-events PullRequestEvent (merged) PROMOTEs;
//             its IssueCommentEvent twin from the same PR CORROBORATEs
//             (provided as the nearest neighbour at cosine_distance < 0.30).
test("F12: github-events PR merged → PROMOTE; same-PR IssueCommentEvent twin → CORROBORATE", async () => {
  // First: the PR-merge event into an empty HNSW. PROMOTEs.
  const prResult = await salienceMod.scoreCandidate(
    {
      source: "github-events",
      source_msg_id: "gh_f12_pr_merged",
      content:
        "Merged pull request #1234: R25 salience cascade — three-layer admission control.",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        event_type: "PullRequestEvent",
        actor_login: "alex-example",
        repo: "alex-example/memory-system",
        pr_number: 1234,
        merged: true,
      },
    },
    { embedding_mrl_768: unitVec(), hnsw: EMPTY_HNSW, now: NOW },
  );
  assert.equal(prResult.decision, "PROMOTE");

  // Second: the IssueCommentEvent twin. We seed the HNSW with the PR-merge
  // memory at cosine_distance = 0.10, well under the github-events threshold
  // (0.30). Expect CORROBORATE.
  const commentResult = await salienceMod.scoreCandidate(
    {
      source: "github-events",
      source_msg_id: "gh_f12_issue_comment",
      content: "Comment on PR #1234: ship it — the cascade looks great.",
      consent_basis: "first_party",
      ts: "2026-06-01T00:05:00Z",
      raw_content: {
        event_type: "IssueCommentEvent",
        actor_login: "alex-example",
        repo: "alex-example/memory-system",
        pr_number: 1234,
      },
    },
    {
      embedding_mrl_768: unitVec(0.05),
      // R25.5 CRIT-6 (b): corroboration is disabled while hnsw.size() <
      // CAPS.SALIENCE_CORROBORATE_MIN_INDEX_SIZE (default 50). To exercise
      // the CORROBORATE branch we declare a size at the threshold; the
      // single neighbour returned from search() is still the load-bearing
      // signal under test.
      hnsw: stubHnsw({
        size: 50,
        neighbours: [{ memory_id: "mem_f12_pr_anchor", distance: 0.10 }],
      }),
      now: NOW,
    },
  );
  assert.equal(commentResult.decision, "CORROBORATE");
  assert.equal(commentResult.target_id, "mem_f12_pr_anchor");
  assert.equal(commentResult.source_ref.source, "github-events");
  assert.equal(
    commentResult.source_ref.source_msg_id,
    "gh_f12_issue_comment",
  );
});

// -----------------------------------------------------------------------------
// PROPERTY TESTS — five invariants from the brief.
// -----------------------------------------------------------------------------

// Property 1: BYTE-IDEMPOTENT — rescoring the same fixtures with the same
// weights produces identical scores per fixture (byte-equal numeric value).
test("P1: BYTE-IDEMPOTENT rescoring — same fixture twice → identical features.salience.score", async () => {
  const baseEvent = {
    source: "git-log",
    source_msg_id: "git_p1_idemp",
    content: "R25 salience cascade — three-layer admission control",
    consent_basis: "first_party",
    ts: "2026-06-01T00:00:00Z",
    raw_content: {
      subject: "R25 salience cascade",
      body: "three-layer admission control",
      author_email: "alex@example.com",
    },
  };
  const ctx = {
    embedding_mrl_768: unitVec(),
    hnsw: EMPTY_HNSW,
    now: NOW,
  };
  const r1 = await salienceMod.scoreCandidate(baseEvent, ctx);
  const r2 = await salienceMod.scoreCandidate(baseEvent, ctx);
  assert.equal(r1.decision, "PROMOTE");
  assert.equal(r2.decision, "PROMOTE");
  // Strict-equal on the numeric score and on each component value. We also
  // compare the canonical JSON byte-strings of the components dicts as a
  // belt-and-braces idempotency check (no key-ordering surprises).
  assert.equal(r1.score, r2.score);
  for (const k of Object.keys(r1.components)) {
    assert.equal(
      r1.components[k],
      r2.components[k],
      `component ${k} drifted between runs`,
    );
  }
  const c1 = JSON.stringify(r1.components, Object.keys(r1.components).sort());
  const c2 = JSON.stringify(r2.components, Object.keys(r2.components).sort());
  assert.equal(c1, c2);
  assert.equal(r1.weights_hash, r2.weights_hash);
});

// Property 2: MONOTONICITY — if fixture A's components strictly dominate
// fixture B's (every component >=), then score(A) >= score(B). We test by
// running two PROMOTE rows where A differs from B only via increasing the
// structural hint (Stage-0 module returns a higher structural_score for the
// long-form variant), so all OTHER components are equal-by-construction.
test("P2: MONOTONICITY — component-wise dominance implies score dominance", async () => {
  const longContent =
    "Substantive multi-sentence commit subject containing more than twenty-five characters and rich vocabulary.";
  const shortContent = "fixup! minor tweak";
  const longEvent = {
    source: "git-log",
    source_msg_id: "git_p2_long",
    content: longContent,
    consent_basis: "first_party",
    ts: "2026-06-01T00:00:00Z",
    raw_content: {
      subject: longContent,
      body: "Detailed body text explaining the change in production-grade prose with multiple sentences.",
      author_email: "alex@example.com",
    },
  };
  const shortEvent = {
    source: "git-log",
    source_msg_id: "git_p2_short",
    content: shortContent,
    consent_basis: "first_party",
    ts: "2026-06-01T00:00:00Z",
    raw_content: {
      subject: shortContent,
      body: "",
      author_email: "alex@example.com",
    },
  };
  const ctx = {
    embedding_mrl_768: unitVec(),
    hnsw: EMPTY_HNSW,
    now: NOW,
  };
  const lo = await salienceMod.scoreCandidate(shortEvent, ctx);
  const hi = await salienceMod.scoreCandidate(longEvent, ctx);
  assert.equal(lo.decision, "PROMOTE");
  assert.equal(hi.decision, "PROMOTE");
  // Verify component-wise dominance: every component in `hi` is >= the
  // same component in `lo`.
  for (const k of Object.keys(hi.components)) {
    assert.ok(
      hi.components[k] >= lo.components[k],
      `expected hi.${k} (${hi.components[k]}) >= lo.${k} (${lo.components[k]})`,
    );
  }
  assert.ok(
    hi.score >= lo.score,
    `expected hi.score (${hi.score}) >= lo.score (${lo.score})`,
  );
});

// Property 3: ZERO-WEIGHTED COLUMNS — every PROMOTE fact's persisted
// features.salience.components has last_retrieved_ts === null AND use_count === 0.
test("P3: ZERO-WEIGHTED COLUMNS — every PROMOTE row has last_retrieved_ts=null AND use_count=0", async () => {
  const evt = {
    source: "imessage",
    source_msg_id: "imsg_p3_zw",
    content: "Substantive iMessage prose worthy of promotion and persistence.",
    consent_basis: "first_party",
    ts: "2026-06-01T00:00:00Z",
    raw_content: {
      text: "Substantive iMessage prose worthy of promotion and persistence.",
      handle_id: "+15555550100",
    },
  };
  const r = await salienceMod.scoreCandidate(evt, {
    embedding_mrl_768: unitVec(),
    hnsw: EMPTY_HNSW,
    now: NOW,
  });
  assert.equal(r.decision, "PROMOTE");
  const block = salienceMod.buildSalienceFeaturesBlock(r);
  assert.equal(block.components.last_retrieved_ts, null);
  assert.equal(block.components.use_count, 0);
});

// Property 4: CORROBORATION PRESERVES SOURCE_REF — the CORROBORATE result's
// source_ref points to the dropped (incoming) fact's source-ledger row, not
// to the anchor.
test("P4: CORROBORATION preserves source_ref to the dropped (incoming) row", async () => {
  const incomingSourceMsgId = "imsg_p4_near_dup";
  const incomingSource = "imessage";
  const r = await salienceMod.scoreCandidate(
    {
      source: incomingSource,
      source_msg_id: incomingSourceMsgId,
      content: "Near-duplicate substantive prose for corroboration coverage.",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        text: "Near-duplicate substantive prose for corroboration coverage.",
        handle_id: "+15555550100",
      },
    },
    {
      embedding_mrl_768: unitVec(),
      // R25.5 CRIT-6 (b): declare a size at the corroboration-enable
      // threshold so the gate doesn't short-circuit this property test.
      hnsw: stubHnsw({
        size: 50,
        neighbours: [{ memory_id: "mem_p4_anchor", distance: 0.05 }],
      }),
      now: NOW,
    },
  );
  assert.equal(r.decision, "CORROBORATE");
  // The source_ref MUST identify the INCOMING dropped row, not the anchor.
  assert.equal(r.source_ref.source, incomingSource);
  assert.equal(r.source_ref.source_msg_id, incomingSourceMsgId);
  // The anchor's memory_id is reported separately as target_id.
  assert.equal(r.target_id, "mem_p4_anchor");
  // Cross-check: the corroboration target's id is NOT in the source_ref shape.
  assert.notEqual(r.source_ref.source_msg_id, "mem_p4_anchor");
});

// Property 5: HARD-ZERO ON BOILERPLATE — a fact whose text matches
// CAPS.SALIENCE_BOILERPLATE_REGEX has features.salience.components.content_mass === 0.
test("P5: HARD-ZERO content_mass when text matches CAPS.SALIENCE_BOILERPLATE_REGEX", async () => {
  // "thanks" matches the boilerplate regex. It passes Stage-0 (>= 2 chars,
  // no OTP, no business handle, no tapback) and proceeds to Layer 2 where
  // content_mass should hard-zero.
  const r = await salienceMod.scoreCandidate(
    {
      source: "imessage",
      source_msg_id: "imsg_p5_boilerplate",
      content: "thanks",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        text: "thanks",
        handle_id: "+15555550100",
      },
    },
    { embedding_mrl_768: unitVec(), hnsw: EMPTY_HNSW, now: NOW },
  );
  assert.equal(r.decision, "PROMOTE");
  assert.equal(r.components.content_mass, 0);
  // Belt-and-braces: confirm the canonical regex itself matches the input,
  // i.e. the test is exercising the documented invariant rather than a
  // contingent fluke.
  const re = new RegExp(CAPS.SALIENCE_BOILERPLATE_REGEX, "i");
  assert.ok(re.test("thanks"), "regex sanity-check failed");
});

// -----------------------------------------------------------------------------
// META — confirm the weights-hash invariant + version exposed by the module
// match the CAPS-derived constants so the fixture battery cross-pins the
// salience-version provenance that the rest of the system reads via CAPS.
// -----------------------------------------------------------------------------
test("META: weights_hash + version round-trip through buildSalienceFeaturesBlock", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "git-log",
      source_msg_id: "git_meta_provenance",
      content: "Meta probe row for provenance round-trip.",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        subject: "Meta probe row for provenance round-trip",
        body: "Body content.",
        author_email: "alex@example.com",
      },
    },
    { embedding_mrl_768: unitVec(), hnsw: EMPTY_HNSW, now: NOW },
  );
  assert.equal(r.decision, "PROMOTE");
  const block = salienceMod.buildSalienceFeaturesBlock(r);
  assert.equal(block.weights_hash, SALIENCE_WEIGHTS_V1_HASH);
  assert.equal(block.version, CAPS.SALIENCE_VERSION);
});

// -----------------------------------------------------------------------------
// A3 — codex-authorship-axis (memory-roots node A3). authorship scores the
// SPEAKER for the two agent-transcript sources (codex-cli, chat-claude-code)
// and the HOISTED consent basis (event.consent_basis ?? source_policy.
// consent_basis) for every other source. kb/ingestion.md:140: consent is not
// authorship. Cases (a)-(h) from the node spec. Fixtures reuse unitVec /
// EMPTY_HNSW / NOW; codex-cli assistant_text is long, prose-shaped and
// bracket-free so no Stage-0 rule (tool-call block, status ping, narration,
// brutalist stub) DROPs or downgrades it, and no system_prompt_hash is set so
// the dedup persistence stays inert.
// -----------------------------------------------------------------------------

const A3_CTX = () => ({ embedding_mrl_768: unitVec(), hnsw: EMPTY_HNSW, now: NOW });
const A3_ASSISTANT_PROSE =
  "The watermark cursor was advancing past the torn tail because readAppended rounded the offset up to the next 64 KiB chunk boundary before checking for a trailing newline; the regression test now pins a row split exactly on that boundary and the cursor stays put until the row completes.";

function a3CodexRow(id, userText) {
  return {
    id,
    ts: "2026-06-01T00:00:00Z",
    source: "codex-cli",
    source_msg_id: id,
    parties: ["user", "assistant"],
    raw_content: {
      user_text: userText,
      assistant_text: A3_ASSISTANT_PROSE,
      cwd: "/tmp/a3-fixture",
    },
    source_policy: { consent_basis: "first_party" },
  };
}

// (a) codex-cli turn carrying operator words → operator-authored 1.0.
test("A3(a): codex-cli user turn + source_policy first_party → authorship 1.0, PROMOTE", async () => {
  const r = await salienceMod.scoreCandidate(
    a3CodexRow("codex_a3_user_turn", "fix the cursor so it never skips a torn row"),
    A3_CTX(),
  );
  assert.equal(r.decision, "PROMOTE");
  assert.equal(r.components.authorship, 1.0);
});

// (b) codex-cli assistant-only turn → agent-authored CAPS rung.
test("A3(b): codex-cli assistant-only → authorship CAPS.SALIENCE_AUTHORSHIP_AGENT, PROMOTE", async () => {
  assert.equal(typeof CAPS.SALIENCE_AUTHORSHIP_AGENT, "number");
  assert.ok(CAPS.SALIENCE_AUTHORSHIP_AGENT < 0.6, "agent rung sits below the R21 third-party value");
  const r = await salienceMod.scoreCandidate(
    a3CodexRow("codex_a3_assistant_only", ""),
    A3_CTX(),
  );
  assert.equal(r.decision, "PROMOTE");
  assert.equal(r.components.authorship, CAPS.SALIENCE_AUTHORSHIP_AGENT);
  // Whitespace-only user_text is empty by Stage-0's own isEmpty semantics.
  const r2 = await salienceMod.scoreCandidate(
    a3CodexRow("codex_a3_assistant_only_ws", "   \n\t"),
    A3_CTX(),
  );
  assert.equal(r2.decision, "PROMOTE");
  assert.equal(r2.components.authorship, CAPS.SALIENCE_AUTHORSHIP_AGENT);
});

// (c) chat-claude-code assistant-only → same agent rung.
test("A3(c): chat-claude-code assistant-only → authorship CAPS.SALIENCE_AUTHORSHIP_AGENT, PROMOTE", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      id: "chatcc_a3_assistant_only",
      ts: "2026-06-01T00:00:00Z",
      source: "chat-claude-code",
      source_msg_id: "chatcc_a3_assistant_only",
      raw_content: {
        user_text: "",
        assistant_text: A3_ASSISTANT_PROSE,
        cwd: "/tmp/a3-fixture",
      },
      source_policy: { consent_basis: "first_party" },
    },
    A3_CTX(),
  );
  assert.equal(r.decision, "PROMOTE");
  assert.equal(r.components.authorship, CAPS.SALIENCE_AUTHORSHIP_AGENT);
});

// (d) telegram with ONLY source_policy.consent_basis third_party_inferred → 0.6.
test("A3(d): telegram source_policy third_party_inferred (no top-level field) → authorship 0.6, PROMOTE", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      id: "tg_a3_third_party",
      ts: "2026-06-01T00:00:00Z",
      source: "telegram",
      source_msg_id: "tg_a3_third_party",
      raw_content: {
        peer_type: "user",
        sender_name: "Ada",
        text: "The venue confirmed Thursday for the reading group; bring the annotated draft.",
      },
      source_policy: { consent_basis: "third_party_inferred" },
    },
    A3_CTX(),
  );
  assert.equal(r.decision, "PROMOTE");
  assert.equal(r.components.authorship, 0.6);
});

// (e) imessage with ONLY source_policy.consent_basis first_party → 1.0 (the hoist).
test("A3(e): imessage source_policy first_party (no top-level field) → authorship 1.0 via hoist, PROMOTE", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      id: "imsg_a3_hoist",
      ts: "2026-06-01T00:00:00Z",
      source: "imessage",
      source_msg_id: "imsg_a3_hoist",
      raw_content: {
        text: "Sent the revised abstract to the committee this morning; deadline moved to Friday.",
        handle_id: "+15555550100",
      },
      source_policy: { consent_basis: "first_party" },
    },
    A3_CTX(),
  );
  assert.equal(r.decision, "PROMOTE");
  assert.equal(r.components.authorship, 1.0);
});

// (f) the existing top-level consent_basis fixture shape still scores 1.0.
test("A3(f): top-level consent_basis first_party fixture shape still → authorship 1.0, PROMOTE", async () => {
  const r = await salienceMod.scoreCandidate(
    {
      source: "imessage",
      source_msg_id: "imsg_a3_top_level",
      content:
        "We landed the salience cascade in R25 today and verified the corroboration thresholds match design doc empirics.",
      consent_basis: "first_party",
      ts: "2026-06-01T00:00:00Z",
      raw_content: {
        text: "We landed the salience cascade in R25 today and verified the corroboration thresholds match design doc empirics.",
        handle_id: "+15555550100",
      },
    },
    A3_CTX(),
  );
  assert.equal(r.decision, "PROMOTE");
  assert.equal(r.components.authorship, 1.0);
  // Top-level wins over a conflicting source_policy (?? semantics).
  assert.equal(
    salienceMod._internals.authorshipScore({
      source: "imessage",
      consent_basis: "first_party",
      source_policy: { consent_basis: "third_party_inferred" },
    }),
    1.0,
  );
});

// (g) flag forced off: CAPS is Object.freeze'd (validation.js) and no
// override hook exists, so the `speakerEnabled` parameter on
// _internals.authorshipScore is the only hermetic route. Off must reproduce
// the pre-A3 rule byte-for-byte, INCLUDING the missing source_policy hoist.
test("A3(g): flag off → assistant-only codex and telegram both 0.6; hoist absent; top-level still honoured", () => {
  const a = salienceMod._internals.authorshipScore;
  const off = { speakerEnabled: false };
  assert.equal(a(a3CodexRow("codex_a3_off", ""), off), 0.6);
  assert.equal(a(a3CodexRow("codex_a3_off_user", "fix it"), off), 0.6);
  assert.equal(
    a({ source: "telegram", source_policy: { consent_basis: "third_party_inferred" } }, off),
    0.6,
  );
  // Pre-A3 had no hoist: first_party under source_policy alone was invisible.
  assert.equal(
    a({ source: "imessage", source_policy: { consent_basis: "first_party" } }, off),
    0.6,
  );
  // ...and the top-level field was the only thing it read.
  assert.equal(a({ source: "imessage", consent_basis: "first_party" }, off), 1.0);
  // Flag on, same rows: the speaker rule and the hoist both engage.
  assert.equal(a(a3CodexRow("codex_a3_on", ""), {}), CAPS.SALIENCE_AUTHORSHIP_AGENT);
  assert.equal(a(a3CodexRow("codex_a3_on_user", "fix it")), 1.0);
  assert.equal(
    a({ source: "imessage", source_policy: { consent_basis: "first_party" } }),
    1.0,
  );
});

// (h) route is PROMOTE for every fixture above under BOTH regimes. Salience
// is rerank information, not a gate (kb/salience-design.md:54): authorship
// feeds only weightedScore, which no decision branch reads, so the flag-off
// route is identical by construction. Pin that construction: substituting
// the flag-off authorship into the PROMOTE components moves the score by
// exactly WEIGHTS.authorship * delta and nothing else.
test("A3(h): PROMOTE under on and off; authorship moves score only through its weight", async () => {
  const { authorshipScore, weightedScore, WEIGHTS } = salienceMod._internals;
  const rows = [
    a3CodexRow("codex_a3_h_user", "fix the cursor so it never skips a torn row"),
    a3CodexRow("codex_a3_h_assistant", ""),
    {
      id: "chatcc_a3_h",
      ts: "2026-06-01T00:00:00Z",
      source: "chat-claude-code",
      source_msg_id: "chatcc_a3_h",
      raw_content: { user_text: "", assistant_text: A3_ASSISTANT_PROSE, cwd: "/tmp/a3-fixture" },
      source_policy: { consent_basis: "first_party" },
    },
    {
      id: "tg_a3_h",
      ts: "2026-06-01T00:00:00Z",
      source: "telegram",
      source_msg_id: "tg_a3_h",
      raw_content: { peer_type: "user", sender_name: "Ada", text: "The venue confirmed Thursday for the reading group; bring the annotated draft." },
      source_policy: { consent_basis: "third_party_inferred" },
    },
    {
      id: "imsg_a3_h",
      ts: "2026-06-01T00:00:00Z",
      source: "imessage",
      source_msg_id: "imsg_a3_h",
      raw_content: { text: "Sent the revised abstract to the committee this morning; deadline moved to Friday.", handle_id: "+15555550100" },
      source_policy: { consent_basis: "first_party" },
    },
  ];
  for (const row of rows) {
    const on = await salienceMod.scoreCandidate(row, A3_CTX());
    assert.equal(on.decision, "PROMOTE", `${row.id} must PROMOTE under flag on`);
    assert.equal(on.components.authorship, authorshipScore(row));
    const offAuthorship = authorshipScore(row, { speakerEnabled: false });
    assert.equal(offAuthorship, 0.6, `${row.id} scores 0.6 under the pre-A3 rule`);
    const offScore = weightedScore({ ...on.components, authorship: offAuthorship });
    const expectedDelta = WEIGHTS.authorship * (on.components.authorship - offAuthorship);
    assert.ok(
      Math.abs((on.score - offScore) - expectedDelta) < 1e-12,
      `${row.id}: score delta ${on.score - offScore} != weight*delta ${expectedDelta}`,
    );
  }
});

// -----------------------------------------------------------------------------
// A5 — codex-speaker-guard (memory-roots node A5). The Layer-3 kNN
// CORROBORATE branch no longer folds a row that is the operator speaking
// (isOperatorWordsTurn) into a nearest-neighbour fact by distance alone;
// it PROMOTEs with novelty = the raw kNN distance. Behind
// CAPS.SALIENCE_CORROBORATE_SPEAKER_GUARD_ENABLED; CAPS is frozen, so the
// flag-off (pre-A5) routing is reached through _setSpeakerGuardForTest,
// always wrapped in try/finally(null).
//
// Fixture notes: every kNN stub declares size 200 — at/above
// SALIENCE_CORROBORATE_MIN_INDEX_SIZE (50) so the branch is live, AND
// at/above SALIENCE_NOVELTY_LERP_FLOOR (200) so R25.5 CRIT-6(a) does not
// blend the persisted novelty toward 0.5 (at size 50 the 0.10 fold distance
// would surface as 0.4). The single neighbour at 0.10 is under the codex-cli /
// chat-claude-code threshold (0.25). policyEventSink is an ARRAY so the emit
// helpers push instead of appending durably (salience.js emitPolicyEvent).
// -----------------------------------------------------------------------------

const { addToContentIndex } = await import("../../lib/synthesis/content-index.js");
const stage0CodexMod = await import("../../lib/ingest/stage0/codex-cli.js");

const A5_NEIGHBOUR = "mem_a5_anchor";
function a5Ctx({ contentIndex = null } = {}) {
  const ctx = {
    embedding_mrl_768: unitVec(),
    hnsw: stubHnsw({ size: 200, neighbours: [{ memory_id: A5_NEIGHBOUR, distance: 0.10 }] }),
    policyEventSink: [],
    now: NOW,
  };
  if (contentIndex != null) ctx.contentIndex = contentIndex;
  return ctx;
}

function a5ChatCcRow(id, userText, extra = {}) {
  return {
    id,
    ts: "2026-06-01T00:00:00Z",
    source: "chat-claude-code",
    source_msg_id: id,
    parties: ["user", "assistant"],
    raw_content: {
      user_text: userText,
      assistant_text: A3_ASSISTANT_PROSE,
      cwd: "/tmp/a5-fixture",
      ...extra,
    },
    source_policy: { consent_basis: "first_party" },
  };
}

function a5CodexRow(id, userText, extra = {}) {
  const row = a3CodexRow(id, userText);
  Object.assign(row.raw_content, extra);
  return row;
}

async function a5Run(row, opts) {
  const ctx = a5Ctx(opts);
  const r = await salienceMod.scoreCandidate(row, ctx);
  return { r, sink: ctx.policyEventSink };
}

// T-A5-1: an operator-word row at distance 0.10 PROMOTEs with the raw fold
// distance as novelty and NO policy.corroboration in the sink.
test("T-A5-1: operator-word codex-cli / chat-claude-code rows at distance 0.10 → PROMOTE, novelty 0.10, empty sink", async () => {
  assert.equal(CAPS.SALIENCE_CORROBORATE_SPEAKER_GUARD_ENABLED, true);
  for (const row of [
    a5CodexRow("codex_a5_1", "fix the cursor so it never skips a torn row"),
    a5ChatCcRow("chatcc_a5_1", "port the guard to the chat-cc stage0 too"),
  ]) {
    const { r, sink } = await a5Run(row);
    assert.equal(r.decision, "PROMOTE", `${row.id} must PROMOTE under the guard`);
    assert.equal(r.components.novelty, 0.10, `${row.id}: novelty is the raw kNN distance`);
    assert.equal(sink.length, 0, `${row.id}: nothing emitted on a rescued PROMOTE`);
    assert.ok(!sink.some((e) => e.kind === "policy.corroboration"));
  }
});

// T-A5-2: flag off is byte-for-byte the pre-A5 routing — the same rows
// CORROBORATE against the neighbour and emit exactly one policy.corroboration
// with the F12 / P4 shape (no reason key on the kNN producer).
test("T-A5-2: guard off → CORROBORATE target_id = neighbour, one policy.corroboration in the sink", async () => {
  salienceMod._setSpeakerGuardForTest(false);
  try {
    for (const row of [
      a5CodexRow("codex_a5_2", "fix the cursor so it never skips a torn row"),
      a5ChatCcRow("chatcc_a5_2", "port the guard to the chat-cc stage0 too"),
    ]) {
      const { r, sink } = await a5Run(row);
      assert.equal(r.decision, "CORROBORATE", `${row.id} must CORROBORATE with the guard off`);
      assert.equal(r.target_id, A5_NEIGHBOUR);
      assert.equal(r.cosine_distance, 0.10);
      assert.equal(r.source_ref.source, row.source);
      assert.equal(r.source_ref.source_msg_id, row.id);
      const corr = sink.filter((e) => e.kind === "policy.corroboration");
      assert.equal(corr.length, 1, `${row.id}: exactly one corroboration event`);
      assert.equal(sink.length, 1);
      const ev = corr[0];
      assert.equal(ev.target_memory_id, A5_NEIGHBOUR);
      assert.deepEqual(ev.source_ref, { source: row.source, source_msg_id: row.id });
      assert.equal(ev.cosine_distance, 0.10);
      assert.ok(!("reason" in ev), "kNN producer carries no reason key");
      assert.equal(ev.weights_hash, SALIENCE_WEIGHTS_V1_HASH);
      assert.equal(ev.salience_version, CAPS.SALIENCE_VERSION);
      assert.equal(ev.ts, NOW.toISOString());
    }
  } finally {
    salienceMod._setSpeakerGuardForTest(null);
  }
  // The finally restored CAPS: the guard is live again.
  const { r } = await a5Run(a5CodexRow("codex_a5_2_restored", "fix the cursor so it never skips a torn row"));
  assert.equal(r.decision, "PROMOTE");
});

// T-A5-3: an assistant-only turn is not the operator speaking; it still folds.
test("T-A5-3: assistant-only codex-cli / chat-claude-code rows (user_text \"\") still CORROBORATE with the guard on", async () => {
  for (const row of [a5CodexRow("codex_a5_3", ""), a5ChatCcRow("chatcc_a5_3", ""), a5CodexRow("codex_a5_3_ws", "  \n\t")]) {
    const { r, sink } = await a5Run(row);
    assert.equal(r.decision, "CORROBORATE", `${row.id} is assistant-only and must still fold`);
    assert.equal(r.target_id, A5_NEIGHBOUR);
    assert.equal(sink.filter((e) => e.kind === "policy.corroboration").length, 1);
    assert.equal(salienceMod._internals.isOperatorWordsTurn(row), false);
  }
});

// T-A5-4: scaffold pseudo-user turns are not the operator speaking. Each
// fixture carries an assistant reply so Stage-0 rules 2-3 (which DROP only
// when assistant_text is empty) PASS it — the row must reach the kNN branch
// to prove that the GUARD, not Stage-0, is what declines to protect it.
test("T-A5-4: with-reply <recommended_plugins> / auto_injected / <environment_context> rows still CORROBORATE", async () => {
  const rows = [
    a5CodexRow(
      "codex_a5_4a",
      "<recommended_plugins>\nAirtable, Linear, Notion are available but not installed.\n</recommended_plugins>",
    ),
    a5CodexRow("codex_a5_4b", "Continue with the plan from the last turn.", { auto_injected: true }),
    a5CodexRow(
      "codex_a5_4c",
      "<environment_context>\n  <cwd>/tmp/a5-fixture</cwd>\n  <shell>zsh</shell>\n</environment_context>",
    ),
    a5ChatCcRow("chatcc_a5_4d", "<recommended_plugins>\nnone\n</recommended_plugins>"),
  ];
  for (const row of rows) {
    assert.equal(salienceMod._internals.isOperatorWordsTurn(row), false, `${row.id} is scaffold, not operator words`);
    const { r, sink } = await a5Run(row);
    assert.equal(r.decision, "CORROBORATE", `${row.id} must reach kNN and fold`);
    assert.equal(r.target_id, A5_NEIGHBOUR);
    assert.equal(sink.filter((e) => e.kind === "policy.corroboration").length, 1);
  }
});

// T-A5-5: precedence — the Layer-2.5 content-hash branch runs BEFORE the kNN
// branch and is not guarded, so a byte-identical re-paste of an operator turn
// still folds with reason "content_duplicate_no_embed".
test("T-A5-5: byte-identical operator content in ctx.contentIndex → CORROBORATE content_duplicate_no_embed with the guard on", async () => {
  const row = a5CodexRow("codex_a5_5", "fix the cursor so it never skips a torn row");
  assert.equal(salienceMod._internals.isOperatorWordsTurn(row), true);
  const content = salienceMod.normalizeSourceEvent(row).content;
  assert.ok(content.startsWith("user: fix the cursor"));
  const contentIndex = { byContentHash: new Map() };
  addToContentIndex(contentIndex, "mem_a5_canonical", content);
  const { r, sink } = await a5Run(row, { contentIndex });
  assert.equal(r.decision, "CORROBORATE");
  assert.equal(r.reason, "content_duplicate_no_embed");
  assert.equal(r.target_id, "mem_a5_canonical");
  const corr = sink.filter((e) => e.kind === "policy.corroboration");
  assert.equal(corr.length, 1);
  assert.equal(corr[0].reason, "content_duplicate_no_embed");
  assert.equal(corr[0].cosine_distance, null);
  assert.equal(corr[0].target_memory_id, "mem_a5_canonical");
  // Same row, index miss → the kNN branch is reached and the guard rescues it.
  const miss = await a5Run(row, { contentIndex: { byContentHash: new Map() } });
  assert.equal(miss.r.decision, "PROMOTE");
  assert.equal(miss.sink.length, 0);
});

// T-A5-6: parity + predicate probes. The CAPS regex string IS Stage-0's
// SCAFFOLD_USER_RE source (strongest drift pin: any token added to one and
// not the other fails here), plus the per-token / per-shape probes.
test("T-A5-6: CAPS scaffold regex === stage0 SCAFFOLD_USER_RE.source; predicate probes", () => {
  const { isOperatorWordsTurn } = salienceMod._internals;
  const SCAFFOLD_USER_RE = stage0CodexMod._internals.SCAFFOLD_USER_RE;
  assert.equal(typeof CAPS.SALIENCE_CORROBORATE_SPEAKER_GUARD_ENABLED, "boolean");
  assert.equal(CAPS.SALIENCE_CORROBORATE_SPEAKER_GUARD_ENABLED, true);
  assert.equal(typeof CAPS.SALIENCE_SPEAKER_GUARD_SCAFFOLD_REGEX, "string");
  assert.equal(CAPS.SALIENCE_SPEAKER_GUARD_SCAFFOLD_REGEX, SCAFFOLD_USER_RE.source);
  assert.ok(SCAFFOLD_USER_RE.flags.includes("i"));
  const guardRe = new RegExp(CAPS.SALIENCE_SPEAKER_GUARD_SCAFFOLD_REGEX, "i");
  // Per-token probes: every Stage-0 token, including A6's recommended_plugins.
  for (const tok of [
    "environment_context", "system_prompt", "goal_context", "subagent_notification",
    "INSTRUCTIONS", "thesis_statement", "counterpart_gaps", "turn_aborted",
    "session_aborted", "tool_use_error", "command_interrupted", "recommended_plugins",
  ]) {
    const text = `<${tok}>\nbody\n</${tok}>`;
    assert.equal(guardRe.test(text), true, `<${tok}> must match the guard regex`);
    assert.equal(SCAFFOLD_USER_RE.test(text), true, `<${tok}> must match Stage-0`);
    assert.equal(isOperatorWordsTurn({ source: "codex-cli", raw_content: { user_text: text } }), false);
  }
  assert.equal(guardRe.test("  <recommended_plugins>"), true);
  assert.equal(guardRe.test("# AGENTS.md instructions for /tmp/x"), true);
  assert.equal(guardRe.test("CONTEXT AND INSTRUCTIONS: do the thing"), true);
  // Anchored: an operator DISCUSSING a tag is still the operator speaking.
  assert.equal(guardRe.test("the <system_prompt> tag worked"), false);
  assert.equal(isOperatorWordsTurn({ source: "codex-cli", raw_content: { user_text: "the <system_prompt> tag worked" } }), true);
  assert.equal(isOperatorWordsTurn({ source: "codex-cli", raw_content: { user_text: "the <recommended_plugins> block listed Airtable" } }), true);
  // Not operator words: an imessage row (payload under raw_content.text).
  assert.equal(
    isOperatorWordsTurn({ source: "imessage", raw_content: { text: "Sent the revised abstract.", handle_id: "+15555550100" } }),
    false,
  );
  // Not operator words: no raw_content, non-object raw_content, non-string /
  // blank user_text, auto_injected.
  assert.equal(isOperatorWordsTurn({ source: "codex-cli" }), false);
  assert.equal(isOperatorWordsTurn({ source: "codex-cli", raw_content: "user_text" }), false);
  assert.equal(isOperatorWordsTurn({ source: "codex-cli", raw_content: { user_text: 42 } }), false);
  assert.equal(isOperatorWordsTurn({ source: "codex-cli", raw_content: { user_text: " \n " } }), false);
  assert.equal(isOperatorWordsTurn({ source: "codex-cli", raw_content: { user_text: "real words", auto_injected: true } }), false);
  assert.equal(isOperatorWordsTurn(null), false);
  // MCP promote path: the source row is forwarded under `raw`.
  assert.equal(isOperatorWordsTurn({ source: "codex-cli", raw: { raw_content: { user_text: "real words" } } }), true);
  assert.equal(isOperatorWordsTurn({ source: "codex-cli", raw: { raw_content: { user_text: "" } } }), false);
  // event.raw_content wins over event.raw.raw_content when both exist.
  assert.equal(
    isOperatorWordsTurn({ source: "codex-cli", raw_content: { user_text: "" }, raw: { raw_content: { user_text: "x" } } }),
    false,
  );
  // The override hook is exported on both surfaces and null-restores.
  assert.equal(typeof salienceMod._setSpeakerGuardForTest, "function");
  assert.equal(salienceMod._internals._setSpeakerGuardForTest, salienceMod._setSpeakerGuardForTest);
});
