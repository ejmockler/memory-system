#!/usr/bin/env node
// identity.gate.mjs — WORKUNIT N7 closure gate (no test framework, no DB).
//
// Builds the cross-platform person index over the N1 fixture corpus PLUS a
// minimal synthetic overlay that exercises the two required cross-platform
// resolutions, then asserts the measurable closure:
//
//   - operator_unified: the operator's ids on >=2 distinct platforms all resolve
//     to the SAME person:operator id (seeded from operator links + an
//     is_from_me self row). The gate is SELF-CONTAINED: it injects the overlay's
//     synthetic operator addresses through buildPersonIndex's `operatorLinks`
//     option — the same link shape seedOperatorLinks() derives from the
//     operator-identity config — so it passes on a host with no identity
//     configured and never depends on whose identity is configured;
//   - cross_platform_clusters >= 2: at least two clusters whose ids[] span >=2
//     distinct platform values (the operator + >=1 non-operator contact whose
//     phone appears as a digits-keyed handle on one platform AND a bare E.164
//     handle on another).
//
// On success prints, and exits 0:
//   persons=<N> cross_platform_clusters>=2 operator_unified=true
// On ANY deviation prints `FAIL ...` and exits 1. Runs <2s, fixtures only.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateEnvelope } from "./envelope.js";
import {
  buildPersonIndex,
  normalizeIdentifier,
  lookup,
  getPerson,
  OPERATOR_PERSON_ID,
} from "./identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const TIME_BUDGET_MS = 2000;

// The overlay's SYNTHETIC operator addresses (no value belongs to a real person).
const OPERATOR_EMAIL = "alex@example.com";
const OPERATOR_HANDLE_EMAIL = "alex.example@example.org";

function fail(msg) {
  process.stdout.write(`FAIL ${msg}\n`);
  process.exit(1);
}

function main() {
  const start = Date.now();

  // 1. Load every platform fixture's expected_envelope (the L1 corpus).
  const envelopes = [];
  for (const f of readdirSync(FIXTURES_DIR).filter((x) => x.endsWith(".fixture.json")).sort()) {
    const fx = JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf8"));
    if (!fx || !fx.expected_envelope) continue;
    const res = validateEnvelope(fx.expected_envelope);
    if (!res.ok) fail(`fixture ${f} envelope INVALID: ${JSON.stringify(res.errors)}`);
    envelopes.push(fx.expected_envelope);
  }

  // 2. Synthetic overlay — minimal envelopes that prove the cross-platform
  //    resolutions the gate measures. Each is a valid N1 envelope. The platform
  //    slugs are OPAQUE source labels ("svc-a" .. "svc-d"): the resolver is
  //    platform-agnostic, so the gate does not depend on real connector names.
  const CAP_ALL_FALSE = {
    reply_to_available: false,
    structured_mentions: false,
    self_identity_reliable: false,
    addressing_first_class: false,
  };
  const SIG = { mention_me: false, reply_to_me: false, addressed_to_me: false };
  const mk = (platform, senderId, isFromMe, extra = {}) => ({
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
    capabilities: CAP_ALL_FALSE,
    source_msg_id: `m:${platform}:${senderId}`,
  });

  const overlay = [
    // OPERATOR on platform "svc-a": their canonical email (seeded link).
    mk("svc-a", OPERATOR_EMAIL, false, { name: "Alex" }),
    // OPERATOR on platform "svc-b": a self-authored row (is_from_me=true) under a
    // masked/self token — operator membership is data-driven (no seeded link
    // needed for this row; the is_from_me flag unions it).
    mk("svc-b", "user", true),
    // OPERATOR on platform "svc-c": their seeded handle email — unions to the
    // same cluster via the shared normalized email.
    mk("svc-c", OPERATOR_HANDLE_EMAIL, false, { name: "Alex E" }),

    // NON-OPERATOR contact "Dana": phone as a BARE E.164 on platform svc-a ...
    mk("svc-a", "+14155550199", false, { name: "Dana" }),
    // ... and the SAME phone as a digits-keyed <digits>@<domain> handle on svc-b.
    mk("svc-b", "14155550199@example.invalid", false, { name: "Dana R" }),
  ];

  for (const e of overlay) {
    const res = validateEnvelope(e);
    if (!res.ok) fail(`overlay envelope INVALID: ${JSON.stringify(res.errors)}`);
    envelopes.push(e);
  }

  // 3. Build the index, seeding the operator cluster from the overlay's
  //    synthetic operator addresses (same {kind, norm, person_id} link shape as
  //    seedOperatorLinks()).
  const operatorLinks = [OPERATOR_EMAIL, OPERATOR_HANDLE_EMAIL].map((raw) => {
    const n = normalizeIdentifier(raw);
    if (n == null) fail(`operator seed address did not normalize: ${raw}`);
    return { kind: n.kind, norm: n.norm, person_id: OPERATOR_PERSON_ID };
  });
  const index = buildPersonIndex(envelopes, { operatorLinks });

  // 4. operator_unified: the operator's svc-a email, svc-b self row, and svc-c
  //    handle all resolve to person:operator (>=2 distinct platforms).
  const opA = lookup(index, "svc-a", OPERATOR_EMAIL);
  const opB = lookup(index, "svc-b", "user");
  const opC = lookup(index, "svc-c", OPERATOR_HANDLE_EMAIL);
  const operatorUnified =
    opA === OPERATOR_PERSON_ID && opB === OPERATOR_PERSON_ID && opC === OPERATOR_PERSON_ID;
  if (!operatorUnified) {
    fail(`operator NOT unified: svc-a=${opA} svc-b=${opB} svc-c=${opC}`);
  }
  const opRec = getPerson(index, OPERATOR_PERSON_ID);
  if (opRec == null) fail("person:operator record missing");
  const opPlatforms = new Set(opRec.ids.map((x) => x.platform));
  if (opPlatforms.size < 2) {
    fail(`operator spans <2 platforms: ${[...opPlatforms].join(",")}`);
  }

  // 5. contact cross-platform: Dana's two platform ids resolve to ONE
  //    non-operator person spanning svc-a + svc-b.
  const danaA = lookup(index, "svc-a", "+14155550199");
  const danaB = lookup(index, "svc-b", "14155550199@example.invalid");
  if (danaA == null || danaA !== danaB) {
    fail(`contact NOT unified across platforms: svc-a=${danaA} svc-b=${danaB}`);
  }
  if (danaA === OPERATOR_PERSON_ID) fail("contact wrongly merged into person:operator");

  // 6. cross_platform_clusters >= 2.
  const cpc = index.stats.cross_platform_clusters;
  if (!(cpc >= 2)) fail(`cross_platform_clusters=${cpc} (<2)`);

  const ms = Date.now() - start;
  if (ms >= TIME_BUDGET_MS) fail(`wall-clock ${ms}ms exceeded budget ${TIME_BUDGET_MS}ms`);

  process.stdout.write(
    `persons=${index.persons.size} cross_platform_clusters>=2 operator_unified=true\n`,
  );
  process.exit(0);
}

main();
