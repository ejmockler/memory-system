#!/usr/bin/env node
// _envelope_gate.js — Wave-0 N1 closure gate (no test framework, no DB).
//
// Loads every *.fixture.json + bad-shapes.json under fixtures/, runs
// validateEnvelope() over each, and asserts the closed contract:
//   - every fixture's expected_envelope ACCEPTS (ok === true),
//   - bad-shapes.json has EXACTLY 3 entries, each REJECTS (ok === false),
//     and its cited error fields include the expected reason substring,
//   - the validator never throws on adversarial input.
//
// On success prints `PASS accept=N reject=3/3` and exits 0. On ANY deviation
// prints `FAIL ...` with the offending {field, reason} and exits 1. Asserts a
// wall-clock budget (< 2s). Pure Node stdlib; opens zero DB handles.
//
// The `reject == 3/3` count is LOAD-BEARING: the bad set is closed at exactly 3,
// so a regression that makes a GOOD fixture reject would push the count to 4 and
// the gate MUST fail (not silently pass).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateEnvelope } from "./envelope.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const EXPECTED_BAD_COUNT = 3;
const TIME_BUDGET_MS = 2000;

function fail(msg) {
  process.stdout.write(`FAIL ${msg}\n`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main() {
  const start = Date.now();

  // 1. Platform fixtures — every expected_envelope must ACCEPT.
  const fixtureFiles = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".fixture.json"))
    .sort();

  let accept = 0;
  for (const f of fixtureFiles) {
    const fx = readJson(path.join(FIXTURES_DIR, f));
    if (!fx || typeof fx !== "object" || !fx.expected_envelope) {
      fail(`fixture ${f} missing expected_envelope`);
    }
    let res;
    try {
      res = validateEnvelope(fx.expected_envelope);
    } catch (e) {
      fail(`validateEnvelope THREW on ${f}: ${e && e.message}`);
    }
    if (!res.ok) {
      fail(`fixture ${f} expected ACCEPT but got errors ${JSON.stringify(res.errors)}`);
    }
    accept += 1;
  }

  // 2. Bad shapes — closed set of exactly 3, each must REJECT with the right field.
  const bad = readJson(path.join(FIXTURES_DIR, "bad-shapes.json"));
  if (!Array.isArray(bad)) {
    fail("bad-shapes.json is not an array");
  }
  if (bad.length !== EXPECTED_BAD_COUNT) {
    fail(`bad-shapes.json must have exactly ${EXPECTED_BAD_COUNT} entries, found ${bad.length}`);
  }

  let reject = 0;
  for (const b of bad) {
    let res;
    try {
      res = validateEnvelope(b.envelope);
    } catch (e) {
      fail(`validateEnvelope THREW on bad shape ${b.label}: ${e && e.message}`);
    }
    if (res.ok) {
      fail(`bad shape ${b.label} expected REJECT but it ACCEPTED`);
    }
    const want = b.expect_reason_includes;
    const cited = res.errors.some((er) => er.field && er.field.includes(want));
    if (!cited) {
      fail(
        `bad shape ${b.label} rejected but no error field includes "${want}"; ` +
          `errors=${JSON.stringify(res.errors)}`,
      );
    }
    reject += 1;
  }

  if (reject !== EXPECTED_BAD_COUNT) {
    fail(`reject count ${reject} != ${EXPECTED_BAD_COUNT} (load-bearing)`);
  }

  // 3. No-throw fail-closed guarantee on adversarial whole-envelope inputs.
  for (const bogus of [null, undefined, 42, [], "x"]) {
    let res;
    try {
      res = validateEnvelope(bogus);
    } catch (e) {
      fail(`validateEnvelope THREW on adversarial input ${String(bogus)}: ${e && e.message}`);
    }
    if (res.ok !== false) {
      fail(`adversarial input ${String(bogus)} unexpectedly ACCEPTED`);
    }
  }

  const ms = Date.now() - start;
  if (ms >= TIME_BUDGET_MS) {
    fail(`wall-clock ${ms}ms exceeded budget ${TIME_BUDGET_MS}ms`);
  }

  process.stdout.write(`PASS accept=${accept} reject=${reject}/${EXPECTED_BAD_COUNT}\n`);
  process.exit(0);
}

main();
