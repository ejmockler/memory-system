// run-all-tests-suite-parity.test.mjs — REGINT (memperf) drift regression.
//
// WHAT THIS PINS: the SUITES registry in scripts/run-all-tests.mjs must cover
// every test/**/*.test.mjs on disk (minus any ANNOTATED_SKIP). SUITES was
// grown to ~247 hand-registered paths with no disk-vs-registry check, so a
// newly added suite can silently go UNREGISTERED and never run under `npm
// test` — the exact drift the mass registration closed. The runner now
// computes suiteParityDrift() in main() and exits 2 on any drift; this suite
// closes the hole from both sides:
//
//   (a) LIVE PARITY — against the real repo, enumerateDiskSuites(REPO_ROOT)
//       vs SUITES has ZERO drift (both this parity suite AND the heal-protected
//       suite it ships with are registered).
//   (b) RED-FIRST DRIFT — pointed at a TEMP fixture tree holding an
//       unregistered *.test.mjs, suiteParityDrift reports it in
//       missingFromSuites; ANNOTATED_SKIP suppresses it; a registered-but-
//       absent entry surfaces in staleInSuites. Proves the guard actually
//       fails on drift (not a vacuous always-green assertion).
//
// Hermetic: mkdtempSync temp tree only for (b). No production memory.jsonl,
// indices, or storage state is read/written/mtime-touched. enumerateDiskSuites
// only stats the fixture dir (and, for (a), the repo's test/ tree — source
// files, never data).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  SUITES,
  ANNOTATED_SKIP,
  enumerateDiskSuites,
  suiteParityDrift,
} from "../scripts/run-all-tests.mjs";

const REPO_ROOT = join(import.meta.dirname, "..");

const TMP_ROOT = mkdtempSync(join(tmpdir(), "suite-parity-"));
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// (a) LIVE PARITY — the real repo has zero drift.
// ---------------------------------------------------------------------------
test("(a) SUITES covers test/**/*.test.mjs on disk with zero drift", () => {
  const disk = enumerateDiskSuites(REPO_ROOT);
  assert.ok(
    disk.length > 0,
    "enumerateDiskSuites must find the repo's test suites (found none — wrong root?)",
  );
  const { missingFromSuites, staleInSuites } = suiteParityDrift(SUITES, disk, {
    skip: ANNOTATED_SKIP,
  });
  assert.deepEqual(
    missingFromSuites,
    [],
    "test files exist on disk that are NOT registered in SUITES (they would " +
      "never run under `npm test`). Register them (or add to ANNOTATED_SKIP):\n  " +
      missingFromSuites.join("\n  "),
  );
  assert.deepEqual(
    staleInSuites,
    [],
    "SUITES entries point at files missing on disk — remove them:\n  " +
      staleInSuites.join("\n  "),
  );
});

test("(a2) both suites shipped with this fix are registered in SUITES", () => {
  // Self-checking: the two new test files must run under the gate.
  for (const rel of [
    "test/run-all-tests-suite-parity.test.mjs",
    "test/recall/heal-index-manifest-protected.test.mjs",
  ]) {
    assert.ok(
      SUITES.includes(rel),
      `${rel} must be registered in SUITES so it runs under the gate`,
    );
  }
});

// ---------------------------------------------------------------------------
// (b) RED-FIRST DRIFT — a fixture tree with an unregistered suite is reported.
// ---------------------------------------------------------------------------
function makeFixtureTree(relFiles) {
  const root = mkdtempSync(join(TMP_ROOT, "fx-"));
  for (const rel of relFiles) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "// fixture suite\n", { mode: 0o600 });
  }
  return root;
}

test("(b1) enumerateDiskSuites walks nested dirs and returns sorted POSIX rel paths", () => {
  const root = makeFixtureTree([
    "test/alpha.test.mjs",
    "test/recall/beta.test.mjs",
    "test/notes.md", // ignored: not *.test.mjs
    "test/helper.mjs", // ignored: not *.test.mjs
  ]);
  const disk = enumerateDiskSuites(root);
  assert.deepEqual(disk, [
    "test/alpha.test.mjs",
    "test/recall/beta.test.mjs",
  ]);
});

test("(b2) an unregistered disk suite surfaces in missingFromSuites (RED)", () => {
  const root = makeFixtureTree([
    "test/registered.test.mjs",
    "test/orphan.test.mjs",
  ]);
  const disk = enumerateDiskSuites(root);
  const { missingFromSuites, staleInSuites } = suiteParityDrift(
    ["test/registered.test.mjs"], // orphan deliberately NOT registered
    disk,
    {},
  );
  assert.deepEqual(
    missingFromSuites,
    ["test/orphan.test.mjs"],
    "the unregistered suite must be reported as drift (this is the red-first proof)",
  );
  assert.deepEqual(staleInSuites, []);
});

test("(b3) ANNOTATED_SKIP suppresses a deliberately-omitted disk suite", () => {
  const root = makeFixtureTree([
    "test/registered.test.mjs",
    "test/soak.test.mjs",
  ]);
  const disk = enumerateDiskSuites(root);
  // string form
  const strDrift = suiteParityDrift(["test/registered.test.mjs"], disk, {
    skip: ["test/soak.test.mjs"],
  });
  assert.deepEqual(strDrift.missingFromSuites, []);
  // { path, reason } form
  const objDrift = suiteParityDrift(["test/registered.test.mjs"], disk, {
    skip: [{ path: "test/soak.test.mjs", reason: "manual-only soak" }],
  });
  assert.deepEqual(objDrift.missingFromSuites, []);
});

test("(b4) a registered-but-absent entry surfaces in staleInSuites", () => {
  const root = makeFixtureTree(["test/present.test.mjs"]);
  const disk = enumerateDiskSuites(root);
  const { missingFromSuites, staleInSuites } = suiteParityDrift(
    ["test/present.test.mjs", "test/ghost.test.mjs"],
    disk,
    {},
  );
  assert.deepEqual(missingFromSuites, []);
  assert.deepEqual(staleInSuites, ["test/ghost.test.mjs"]);
});

test("(b5) enumerateDiskSuites returns [] for a root with no test/ dir", () => {
  const root = mkdtempSync(join(TMP_ROOT, "empty-"));
  assert.deepEqual(enumerateDiskSuites(root), []);
});
