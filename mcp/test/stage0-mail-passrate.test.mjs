// stage0-mail-passrate.test.mjs — M3 pass-rate gate that CAN fail.
//
// Context: stage0/mail.js silently dropped 100% of 277,928 emails and no
// assertion could catch it (M1 audit, 2026-07-10: PASS = 0, body_resolved
// false on 100.00% of rows, 6,202 would-pass rows dead at rule 11). This
// suite is the missing gate, built to the honest-gates discipline — every
// assertion here has a demonstrated failure mode:
//
//   1. Labeled HUMAN fixtures with resolved bodies MUST classify PASS.
//      Fails iff the rule cascade wrongly kills 1:1 human mail — the
//      falsifiable core. (Under current rules all four pass; none needed an
//      expected-fail pin. If a future rule change makes one DROP, this gate
//      goes red — that is the point. M4 pins any newly-discovered defect as
//      expected-fail with a handoff comment rather than silencing it.)
//   2. Labeled BULK fixtures MUST drop with their EXACT {decision, reason}
//      attribution — a rule-order regression trap. Each fixture zeroes
//      every other rule's signal (M1 showed rules 1/2/9 shadow everything),
//      so a reason mismatch means the cascade order or a rule regexp moved.
//   3. The production-shaped empty-body human row (M1's 6,202-row rule-11
//      casualty pool) is pinned at its CURRENT behavior —
//      DROP/placeholder_residual — under a `todo` subtest. M4 (2026-07-10)
//      confirmed the rule is correct on genuinely empty text and kept the
//      pin: M2's body-resolution fix lives in the connector working tree,
//      but production-shaped rows stay empty until the operator restarts
//      the live mail-connector LaunchAgent and recaptures historical rows
//      (S1 runbook). Flip expected to PASS only after that recapture.
//   4. Falsifiability proof: the rule-2 fixture is cloned in-test with its
//      triggering marker (list_id_hash) flipped off, and the classification
//      MUST change. A gate that cannot fail is not a gate.
//   5. funnel-alert.js unit tests: an all-drop window >= min alerts; any
//      single PASS or an under-min window defuses it. Had this existed
//      wired to telemetry, the 277k-row silent drop would have tripped it
//      ~2,779 times over. (Live wiring is an operator decision — S1.)
//
// HERMETIC: MEMORY_ROOT / STORAGE_BASE_DIR / QUARANTINE_BASE_DIR are pinned
// to a mkdtemp scratch BEFORE the dynamic import of stage0/mail.js (repo
// pattern, cf. test/ingest/salience-cascade.test.mjs; quarantine.js reads
// QUARANTINE_BASE_DIR at call time). Rules 0/8/9b route through
// quarantineRow — those writes land in the scratch dir, never the live
// store, and the scratch is removed on exit. Classification is done ONLY by
// the real imported stage0(); the cascade is never reimplemented here.
// Fixtures are fully synthetic (invented names/addresses/subjects — no real
// corpus content). ledgers/memory.jsonl is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- Hermetic env MUST be set before any import touches config.js ----------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-stage0-mail-passrate-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.QUARANTINE_BASE_DIR = join(TMP_ROOT, "quarantine");
mkdirSync(process.env.STORAGE_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.QUARANTINE_BASE_DIR, { recursive: true, mode: 0o700 });
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort scratch cleanup */
  }
});

const { stage0 } = await import("../lib/ingest/stage0/mail.js");
const { windowDropRate } = await import(
  "../lib/ingest/stage0/funnel-alert.js"
);

// --- Fixture loading --------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "fixtures", "mail-labeled");

function loadFixtures(bucket) {
  const dir = join(FIXTURE_ROOT, bucket);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      file: `${bucket}/${f}`,
      ...JSON.parse(readFileSync(join(dir, f), "utf8")),
    }));
}

const humanFixtures = loadFixtures("human");
const bulkFixtures = loadFixtures("bulk");

// The exact reason vocabulary stage0/mail.js can emit for drops. Bulk labels
// must come from this set — a typo'd label would otherwise "pass" trivially
// against a typo'd assertion.
const STAGE0_REASON_VOCAB = new Set([
  "operator_junk_folder",
  "list_unsubscribe",
  "list_id",
  "auto_submitted",
  "bulk_precedence",
  "noreply_sender",
  "marketing_platform",
  "apple_automated",
  "subject_autoreply",
  "subject_bracket_noise",
  "otp_pattern",
  "placeholder_residual",
]);

// --- Inventory + label sanity ------------------------------------------------
test("fixture inventory meets the M3 minimums and labels are well-formed", () => {
  assert.ok(
    humanFixtures.length >= 5,
    `need >=5 human fixtures, found ${humanFixtures.length}`
  );
  assert.ok(
    bulkFixtures.length >= 8,
    `need >=8 bulk fixtures, found ${bulkFixtures.length}`
  );
  for (const fx of [...humanFixtures, ...bulkFixtures]) {
    assert.ok(fx.label && typeof fx.label === "object", `${fx.file}: label`);
    assert.ok(fx.row && typeof fx.row === "object", `${fx.file}: row`);
    assert.strictEqual(fx.row.source, "mail", `${fx.file}: source`);
    assert.ok(fx.row.raw_content, `${fx.file}: raw_content`);
  }
  for (const fx of bulkFixtures) {
    assert.ok(
      STAGE0_REASON_VOCAB.has(fx.label.expected_reason),
      `${fx.file}: expected_reason ${JSON.stringify(fx.label.expected_reason)} ` +
        "is not in stage0's reason vocabulary"
    );
  }
});

// --- Gate 1: human mail with a resolved body MUST pass -----------------------
// This is the assertion that did not exist when mail.js shipped. It fails
// the moment any rule change wrongly kills labeled 1:1 human mail.
test("every human fixture with a resolved body PASSes stage0", async (t) => {
  const withBody = humanFixtures.filter(
    (fx) => fx.row.raw_content.body_resolved === true
  );
  assert.ok(
    withBody.length >= 4,
    `need >=4 human-with-body fixtures, found ${withBody.length}`
  );
  for (const fx of withBody) {
    await t.test(`${fx.file} → PASS`, () => {
      const r = stage0(fx.row);
      assert.strictEqual(
        r.decision,
        "PASS",
        `${fx.file}: human 1:1 mail was dropped (reason=${r.reason}) — ` +
          "stage0 is wrongly killing human mail. If this is a known defect, " +
          "pin it as expected-fail with an M4 handoff comment; do NOT fix " +
          "rules here (M4's remit)."
      );
      assert.strictEqual(r.reason, null, `${fx.file}: PASS carries no reason`);
    });
  }
});

// --- Gate 2: bulk mail MUST drop with exact rule attribution ------------------
// Each fixture zeroes all other rules' signals, so the expected reason is the
// ONLY reason that can legitimately fire. Any change to cascade order or a
// rule regexp shows up as a reason mismatch here.
test("every bulk fixture DROPs with its exact labeled attribution", async (t) => {
  for (const fx of bulkFixtures) {
    await t.test(
      `${fx.file} → ${fx.label.expected_decision}/${fx.label.expected_reason}`,
      () => {
        const r = stage0(fx.row);
        assert.strictEqual(
          r.decision,
          fx.label.expected_decision,
          `${fx.file}: decision`
        );
        assert.strictEqual(
          r.reason,
          fx.label.expected_reason,
          `${fx.file}: rule attribution moved — cascade-order regression?`
        );
      }
    );
  }
});

// The OTP row is the one bulk fixture whose decision is REDACT_DROP (digits
// must be scrubbed, not just dropped). Asserted explicitly so a silent
// downgrade to plain DROP cannot hide inside the loop above.
test("the OTP bulk fixture demands REDACT_DROP, not plain DROP", () => {
  const otp = bulkFixtures.find((fx) => fx.label.expected_reason === "otp_pattern");
  assert.ok(otp, "an otp_pattern bulk fixture must exist");
  assert.strictEqual(otp.label.expected_decision, "REDACT_DROP");
  const r = stage0(otp.row);
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "otp_pattern");
});

// --- Gate 3: the empty-body human row (M1's rule-11 casualty pool) -----------
// Production shape: body_resolved:false, text:"" — the 6,202-row pool where
// M1 found the operator's own 1:1 mail dying purely for lack of a resolved
// body. CURRENT behavior (DROP/placeholder_residual) is pinned here.
// M4 (2026-07-10) reviewed this pin and kept it: rule 11 is CORRECT on
// genuinely empty text (no stage0 rule change was warranted — the deaths
// are upstream body-resolution casualties, fixed by M2 in the connector).
// The pin's precondition is still false in production: the live
// mail-connector LaunchAgent predates M2's fix and historical rows carry
// no bodies. Unlock = operator restarts the LaunchAgent + recaptures per
// the S1 runbook; only then flip expected to PASS.
test("empty-body human row: rule-11 pin held pending operator recapture", async (t) => {
  const empties = humanFixtures.filter(
    (fx) => fx.row.raw_content.body_resolved === false
  );
  assert.strictEqual(
    empties.length,
    1,
    "exactly one production-shaped empty-body human fixture expected"
  );
  const fx = empties[0];
  assert.strictEqual(fx.label.expected_decision, "DROP");
  assert.strictEqual(fx.label.expected_reason, "placeholder_residual");
  // Pin retained by M4: flip expected to PASS only after the operator
  // restarts the live mail-connector LaunchAgent and recaptures (S1).
  await t.test(
    `${fx.file} currently DROPs at rule 11 (pending operator recapture)`,
    {
      todo:
        "Unlock = operator LaunchAgent restart + recapture per S1 runbook " +
        "(M2 connector fix not yet live); then flip expected to PASS",
    },
    () => {
      const r = stage0(fx.row);
      assert.strictEqual(r.decision, "DROP");
      assert.strictEqual(r.reason, "placeholder_residual");
    }
  );
});

// --- Gate 4: falsifiability proof --------------------------------------------
// Clone the rule-2 fixture, flip its ONLY triggering marker off, and the
// classification MUST change. This demonstrates the bulk gate above is not
// vacuous: the assertions really do hinge on the labeled marker.
test("falsifiability: flipping the rule-2 marker off changes the classification", () => {
  const fx = bulkFixtures.find((f) => f.label.expected_reason === "list_id");
  assert.ok(fx, "a list_id bulk fixture must exist");

  const baseline = stage0(fx.row);
  assert.strictEqual(baseline.decision, "DROP");
  assert.strictEqual(baseline.reason, "list_id");

  const mutated = structuredClone(fx.row);
  mutated.raw_content.list_id_hash = null; // marker OFF
  const flipped = stage0(mutated);
  assert.notStrictEqual(
    flipped.reason,
    "list_id",
    "marker off but attribution unchanged — the gate cannot fail; broken"
  );
  // The fixture zeroes every other drop signal, so with the marker off the
  // row must sail through the whole cascade.
  assert.strictEqual(flipped.decision, "PASS");
});

// --- Gate 5: funnel-alert unit tests ------------------------------------------
// windowDropRate is the pure tripwire for the exact failure M1 confirmed:
// a window where NOTHING passes. Not wired to any daemon (operator/S1 call).
const drop = () => ({ decision: "DROP", reason: "list_id" });
const redactDrop = () => ({ decision: "REDACT_DROP", reason: "otp_pattern" });
const pass = () => ({ decision: "PASS", reason: null });

test("funnel-alert: 100 all-drop events trip the alarm", () => {
  const events = Array.from({ length: 100 }, drop);
  assert.deepStrictEqual(windowDropRate(events), {
    n: 100,
    dropRate: 1,
    alert: true,
  });
});

test("funnel-alert: 99 all-drop events stay under the min floor", () => {
  const events = Array.from({ length: 99 }, drop);
  const r = windowDropRate(events);
  assert.strictEqual(r.n, 99);
  assert.strictEqual(r.dropRate, 1);
  assert.strictEqual(r.alert, false);
});

test("funnel-alert: a single PASS in 100 events defuses the alarm", () => {
  const events = Array.from({ length: 99 }, drop);
  events.push(pass());
  const r = windowDropRate(events);
  assert.strictEqual(r.n, 100);
  assert.strictEqual(r.dropRate, 0.99);
  assert.strictEqual(r.alert, false);
});

test("funnel-alert: REDACT_DROP counts as a drop, not a pass", () => {
  const events = Array.from({ length: 100 }, redactDrop);
  assert.strictEqual(windowDropRate(events).alert, true);
});

test("funnel-alert: empty window → n 0, dropRate 0, no alert", () => {
  assert.deepStrictEqual(windowDropRate([]), {
    n: 0,
    dropRate: 0,
    alert: false,
  });
});

test("funnel-alert: custom min is honored on both sides of the floor", () => {
  const ten = Array.from({ length: 10 }, drop);
  assert.strictEqual(windowDropRate(ten, { min: 10 }).alert, true);
  assert.strictEqual(
    windowDropRate(ten.slice(0, 9), { min: 10 }).alert,
    false
  );
});

test("funnel-alert: the real fixture battery would NOT alert (humans pass)", () => {
  // End-to-end sanity tying the two halves of M3 together: classify every
  // fixture with the real stage0 and feed the results to the tripwire with
  // min=1. Human PASSes defuse it — proof the alarm only fires on the
  // pathological all-drop shape, not on a normal bulk-heavy mix.
  const results = [...humanFixtures, ...bulkFixtures].map((fx) =>
    stage0(structuredClone(fx.row))
  );
  const r = windowDropRate(results, { min: 1 });
  assert.strictEqual(r.n, humanFixtures.length + bulkFixtures.length);
  assert.strictEqual(r.alert, false);
  assert.ok(r.dropRate < 1, "at least one human fixture must PASS");
});
