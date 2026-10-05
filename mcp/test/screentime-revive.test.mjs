// screentime-revive.test.mjs — c1-captured-only-guard.
//
// FILENAME IS A PRESERVED MISNOMER. Do not "improve" it. This node started
// life as "revive the screentime connector" and that framing was KILLED on
// inspection: the screentime connector is alive and healthy (it keeps tailing
// macOS knowledgeC.db into storage/sources/screentime.jsonl), and its
// exclusion from cascade is deliberate, measured, and correct. The node was
// rescoped to "pin the captured_only carve-out", but the path
// `mcp/test/screentime-revive.test.mjs` is load-bearing downstream (topology
// data-files / data-verify, and the SUITES registration in
// mcp/scripts/run-all-tests.mjs), so the name stays.
//
// What is pinned, and why:
//
//   - mcp/lib/validation.js:545-550 — screentime is captured_only because the
//     Wave 9 audit + live production observation measured 0% promoted facts
//     across the live corpus. Its per-app duration bands are attention-shape
//     telemetry, not a fact stream. Re-enabling cascade would push a ~23.8 MB
//     backlog of 0%-promotion telemetry into a 3+ GB ledger; that needs an
//     operator gate, never a silent code change.
//
//   - mcp/lib/validation.js:556-565 — CAPS.WATERMARK_CAPTURED_ONLY_SOURCES is
//     the single source of truth for that decision, with the documented
//     test-only lever MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE at :551-555 (an
//     EMPTY string disables captured_only entirely; a comma-separated list
//     replaces the default). CAPS is Object.freeze()d at module load, so the
//     two regimes CANNOT coexist in one process — the guard-off arm below
//     therefore runs in a child process.
//
//   - daemons/watermark.js:2523-2527 — the carve-out actually being pinned:
//     computeCursorLagSnapshot `continue`s past any source listed in
//     CAPS.WATERMARK_CAPTURED_ONLY_SOURCES, so the cursor-lag alarm never
//     pages on a source that is parked on purpose. Before this file, deleting
//     those five lines left the whole suite green (cursor-lag-alarm.test.mjs
//     T1-T5 never seed a screentime fixture and never touch the override).
//
// The guard is BIDIRECTIONAL by construction:
//
//   - GREEN ARM (default env, in-process): with a 25h-stale cursor on a
//     ledger that grew a minute ago — the exact shape that forces
//     warned===true in cursor-lag-alarm.test.mjs T2 — screentime must be
//     ABSENT from the snapshot while the identically-seeded controls
//     `imessage` and `git-log` both come back warned===true. Deleting
//     watermark.js:2523-2527 breaks this arm.
//
//   - GUARD-OFF ARM (child process, MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE=""):
//     with captured_only disabled, the SAME on-disk fixture must produce a
//     screentime entry with warned===true, an empty caps array, and controls
//     still warned===true. Hard-coding `if (source === "screentime") continue`
//     past CAPS breaks this arm.
//
// Hermetic discipline (copied in shape from cursor-lag-alarm.test.mjs:49-67):
// MEMORY_ROOT / POLICY_BASE_DIR / STORAGE_BASE_DIR / LEDGERS_BASE_DIR are
// bound to a mkdtempSync root BEFORE the first dynamic import of
// daemons/watermark.js. Nothing under the live <checkout>
// storage, ledgers or indices trees is read or written; knowledgeC.db is
// never opened; the watermark daemon is never spawned (computeCursorLagSnapshot
// is exported at daemons/watermark.js:2511 and called in-process); and the
// clock is injected (fixed NOW) so the result is day/hour independent.
//
// Run: node --test mcp/test/screentime-revive.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Repo root, derived from this file's own location (mcp/test/<this>) so the
// child helper — which lives in tmpdir and therefore cannot resolve relative
// specifiers against the repo — can import by absolute file URL.
// ---------------------------------------------------------------------------
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WATERMARK_PATH = join(REPO_ROOT, "daemons", "watermark.js");
const VALIDATION_PATH = join(REPO_ROOT, "mcp", "lib", "validation.js");

// ---------------------------------------------------------------------------
// Hermetic MEMORY_ROOT — bind BEFORE the first dynamic import of watermark.js.
// An import that lands before this binding silently repoints the test at live
// production storage.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "screentime-captured-only-guard-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
const WATERMARK_STATE_DIR = join(STORAGE_DIR, "watermark-state");

for (const d of [POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, SOURCES_DIR, WATERMARK_STATE_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;

process.on("exit", () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// The green arm is only meaningful under DEFAULT caps. If an ambient override
// is present the in-process regime is not the production one — fail loudly
// rather than assert a contract about a world nobody ships.
if (typeof process.env.MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE === "string") {
  throw new Error(
    "MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE is set in the ambient env " +
      `(${JSON.stringify(process.env.MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE)}); ` +
      "the default-caps arm of this guard cannot run. Unset it and re-run.",
  );
}

// ---------------------------------------------------------------------------
// Fixture — the byte-identical "25h stale cursor + ledger grown a minute ago"
// shape cursor-lag-alarm.test.mjs T2 (lines 241-263) uses to force
// warned===true, applied to all three sources. NOW is a fixed constant and is
// passed straight back into computeCursorLagSnapshot({ now: NOW }), so the
// test never consults the wall clock.
//
// All three names are bare-name entries in CAPS.WATERMARK_SOURCES
// (validation.js:494-496), which is what listSourceLedgers (watermark.js:
// 749-760) walks; a source absent from that list would never appear in the
// snapshot for reasons that have nothing to do with captured_only.
// ---------------------------------------------------------------------------
const NOW = 1770000000000;
const TAIL_TS_ISO = new Date(NOW - 60_000).toISOString();
const CURSOR_TS_ISO = new Date(NOW - 25 * 3600 * 1000).toISOString();
const LEDGER_MTIME_MS = NOW - 60_000;
const EXPECTED_LAG_MS = 25 * 3600 * 1000 - 60_000; // 89_940_000

// Copied in shape from cursor-lag-alarm.test.mjs:159-193. Writes one ledger
// row at storage/sources/<source>.jsonl (so listSourceLedgers picks the source
// up and readLedgerTailTs reads its ts + mtime) plus one cursor at
// storage/watermark-state/<source>.json.
function writeSourceFixture({ source, tailTsIso, cursorTsIso, ledgerMtimeMs }) {
  const row = {
    id: "ulid_FIXTURE_" + source,
    ts: tailTsIso,
    source,
    source_msg_id: "msg_" + source,
    parties: [],
    raw_content: { text: "fixture row" },
    attachments: [],
    source_policy: {
      deletion_semantics: "soft_delete_retain_audit",
      consent_basis: "operator_consent",
    },
  };
  const ledgerPath = join(SOURCES_DIR, `${source}.jsonl`);
  writeFileSync(ledgerPath, JSON.stringify(row) + "\n", { mode: 0o600 });
  if (Number.isFinite(ledgerMtimeMs)) {
    const sec = ledgerMtimeMs / 1000;
    utimesSync(ledgerPath, sec, sec);
  }
  const cursor = {
    version: 1,
    source,
    last_offset: "0",
    last_appended_ts: cursorTsIso,
    last_event_id: null,
    error_count: 0,
    muted_until: null,
    updated_at: new Date(NOW).toISOString(),
  };
  const cursorPath = join(WATERMARK_STATE_DIR, `${source}.json`);
  writeFileSync(cursorPath, JSON.stringify(cursor), { mode: 0o600 });
}

// screentime is the captured_only subject; imessage and git-log are the
// controls that prove the fixture is capable of warning at all.
for (const source of ["screentime", "imessage", "git-log"]) {
  writeSourceFixture({
    source,
    tailTsIso: TAIL_TS_ISO,
    cursorTsIso: CURSOR_TS_ISO,
    ledgerMtimeMs: LEDGER_MTIME_MS,
  });
}

// ---------------------------------------------------------------------------
// Child helper for the guard-off regime. It lives inside TMP_ROOT on purpose:
// a second file under mcp/test/ would be picked up as an unregistered suite by
// mcp/test/run-all-tests-suite-parity.test.mjs and would violate this node's
// one-file remit. The helper re-binds the hermetic env from argv BEFORE any
// import, reads the fixture the parent already seeded, and never deletes
// TMP_ROOT — the parent owns cleanup.
// ---------------------------------------------------------------------------
const CHILD_SENTINEL = "__CAPTURED_ONLY_GUARD_JSON__";
const HELPER_PATH = join(TMP_ROOT, "captured-only-guard-child.mjs");
writeFileSync(
  HELPER_PATH,
  `import { join } from "node:path";
import { pathToFileURL } from "node:url";

const memoryRoot = process.argv[2];
const watermarkPath = process.argv[3];
const validationPath = process.argv[4];
const now = Number(process.argv[5]);

process.env.MEMORY_ROOT = memoryRoot;
process.env.POLICY_BASE_DIR = join(memoryRoot, "policy");
process.env.STORAGE_BASE_DIR = join(memoryRoot, "storage");
process.env.LEDGERS_BASE_DIR = join(memoryRoot, "ledgers");

const wm = await import(pathToFileURL(watermarkPath).href);
const { CAPS } = await import(pathToFileURL(validationPath).href);

const payload = {
  override: process.env.MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE,
  caps: CAPS.WATERMARK_CAPTURED_ONLY_SOURCES,
  entries: wm.computeCursorLagSnapshot({ now }),
};
process.stdout.write("\\n" + ${JSON.stringify(CHILD_SENTINEL)} + JSON.stringify(payload) + "\\n");
`,
  { mode: 0o600 },
);

function runGuardOffChild() {
  const res = spawnSync(
    process.execPath,
    [HELPER_PATH, MEMORY_ROOT, WATERMARK_PATH, VALIDATION_PATH, String(NOW)],
    {
      env: { ...process.env, MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE: "" },
      encoding: "utf8",
    },
  );
  // A crashed helper must never be readable as a passing guard: surface the
  // child's verbatim stderr and fail.
  assert.equal(
    res.status,
    0,
    `guard-off child exited ${res.status} (signal ${res.signal}).\n` +
      `--- child stdout ---\n${res.stdout}\n--- child stderr ---\n${res.stderr}`,
  );
  const line = String(res.stdout)
    .split("\n")
    .find((l) => l.startsWith(CHILD_SENTINEL));
  assert.ok(
    line,
    `guard-off child printed no ${CHILD_SENTINEL} payload.\n` +
      `--- child stdout ---\n${res.stdout}\n--- child stderr ---\n${res.stderr}`,
  );
  return JSON.parse(line.slice(CHILD_SENTINEL.length));
}

// ---------------------------------------------------------------------------
// Dynamic imports — strictly after the env binding above.
// ---------------------------------------------------------------------------
const { computeCursorLagSnapshot } = await import("../../daemons/watermark.js");
const { CAPS } = await import("../lib/validation.js");

// ---------------------------------------------------------------------------
// GREEN ARM — default CAPS, in-process.
// ---------------------------------------------------------------------------
test("captured_only: screentime is carved out of the cursor-lag snapshot while identically-seeded controls warn", () => {
  const snapshot = computeCursorLagSnapshot({ now: NOW });

  // (d) the decision itself, at its source of truth.
  assert.ok(
    Array.isArray(CAPS.WATERMARK_CAPTURED_ONLY_SOURCES) &&
      CAPS.WATERMARK_CAPTURED_ONLY_SOURCES.includes("screentime"),
    "CAPS.WATERMARK_CAPTURED_ONLY_SOURCES must include 'screentime' " +
      "(mcp/lib/validation.js:556-565) — 0% promoted facts, parked on purpose.",
  );

  // (a) the carve-out at daemons/watermark.js:2523-2527.
  assert.equal(
    snapshot.some((e) => e.source === "screentime"),
    false,
    "screentime must be ABSENT from computeCursorLagSnapshot under default " +
      `CAPS; got ${JSON.stringify(snapshot.filter((e) => e.source === "screentime"))}`,
  );

  // (b) + (c) the controls — identical fixture, so their warning proves the
  // absence above is the carve-out and not a dud fixture.
  for (const source of ["imessage", "git-log"]) {
    const entry = snapshot.find((e) => e.source === source);
    assert.ok(entry, `${source} control entry must be present in the snapshot`);
    assert.equal(entry.warned, true, `${source} control must be warned===true`);
    assert.equal(entry.lag_ms, EXPECTED_LAG_MS, `${source} lag_ms is clock-independent`);
    assert.equal(entry.ledger_growing, true, `${source} ledger_growing===true`);
  }
});

// ---------------------------------------------------------------------------
// GUARD-OFF ARM — MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE="" in a child
// process (CAPS is frozen at validation.js module load, so this regime cannot
// live in the parent).
//
// This is the "somebody deleted the guard" world. The carve-out must be
// CAPS-driven, not name-driven: with captured_only emptied, the SAME on-disk
// fixture must make screentime behave like any other stale source. If a future
// change hard-codes `if (source === "screentime") continue` past CAPS, this arm
// goes red while the green arm above stays green — which is the whole point.
// ---------------------------------------------------------------------------
test("captured_only guard-off: with the override empty, screentime warns like any other stale source", () => {
  const { override, caps, entries } = runGuardOffChild();

  assert.equal(override, "", "child must have run with the documented empty-string override");
  assert.deepEqual(caps, [], "override='' must empty CAPS.WATERMARK_CAPTURED_ONLY_SOURCES");

  const screentime = entries.find((e) => e.source === "screentime");
  assert.ok(
    screentime,
    "screentime must be PRESENT in the snapshot once captured_only no longer lists it — " +
      "the skip at daemons/watermark.js:2523-2527 must read CAPS, not a hard-coded name. " +
      `Got sources: ${JSON.stringify(entries.map((e) => e.source))}`,
  );
  assert.equal(screentime.warned, true, "screentime warned===true with captured_only disabled");
  assert.equal(screentime.lag_ms, EXPECTED_LAG_MS, "screentime lag_ms is clock-independent");
  assert.equal(screentime.ledger_growing, true, "screentime ledger_growing===true");

  // Controls under the SAME fixture: only captured_only membership changed, so
  // imessage / git-log must be unchanged from the green arm.
  for (const source of ["imessage", "git-log"]) {
    const entry = entries.find((e) => e.source === source);
    assert.ok(entry, `${source} control entry must still be present with captured_only disabled`);
    assert.equal(entry.warned, true, `${source} control must still be warned===true`);
    assert.equal(entry.lag_ms, EXPECTED_LAG_MS, `${source} lag_ms unchanged across regimes`);
  }
});
