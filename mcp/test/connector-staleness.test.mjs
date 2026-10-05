// connector-staleness.test.mjs — c2-capture-staleness-alarm.
//
// POSITIVE CONTROL for the capture-liveness signal memory_health did not have.
// The pre-existing cursor-lag alarm (daemons/watermark.js
// computeCursorLagSnapshot, surfaced at lib/tools/health.js) measures CASCADE
// BACKLOG — the gap between a source ledger's tail row and the watermark
// cursor. When a source stops capturing entirely the cursor catches up and the
// lag COLLAPSES TO ZERO, so a dead source and a healthy source read identically
// (measured live 2026-08-11: github-events silent 88.6h reported lag_h=0.0,
// byte-identical to chat-claude-code which had appended 4 minutes earlier).
// These tests pin the replacement signal: capture-side liveness keyed on
// connectors/<source>/state.json.last_appended_ts + statSync(mtime) of
// storage/sources/<source>.jsonl.
//
// Hermetic discipline:
//
//   - MEMORY_ROOT / POLICY_BASE_DIR / STORAGE_BASE_DIR / LEDGERS_BASE_DIR /
//     CONNECTORS_BASE_DIR are bound to a mkdtempSync path BEFORE the first
//     dynamic import (lib/config.js binds CONNECTORS_DIR at module load —
//     without CONNECTORS_BASE_DIR the detector would read the PRODUCTION
//     connectors/ tree). Every fixture lives under TMP_ROOT; nothing under
//     the live install's {storage,connectors,ledgers,indices} is read
//     or written by this file.
//   - `now` is injected everywhere. No assertion path calls bare Date.now().
//
// MECHANICAL LEDGER-READ GUARD (T6): node:fs is monkey-patched through a
// createRequire handle BEFORE any ESM import of node:fs in this process, so
// the patch is visible to `import { readFileSync } from "node:fs"` inside the
// detector (Node evaluates a builtin's ESM facade once, on first ESM import —
// the canary import below happens after the patch and proves the binding is
// live). Consequently this file must NOT statically `import ... from
// "node:fs"`; all fixture I/O goes through the `fs` handle below.
//
// Run: cd mcp && node --test test/connector-staleness.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const fs = require("node:fs");

// ---------------------------------------------------------------------------
// Hermetic roots — bound BEFORE the first dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = fs.mkdtempSync(join(tmpdir(), "connector-staleness-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
const CONNECTORS_DIR = join(MEMORY_ROOT, "connectors");
const SOURCES_DIR = join(STORAGE_DIR, "sources");

for (const d of [POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, CONNECTORS_DIR, SOURCES_DIR]) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
process.env.CONNECTORS_BASE_DIR = CONNECTORS_DIR;

process.on("exit", () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// fs instrumentation — installed ONCE, switched by mutable flags (the ESM
// facade snapshots the function identities at first ESM import, so the
// wrappers themselves must never be re-assigned after that point).
// ---------------------------------------------------------------------------
let LEDGER_READ_GUARD = false; // when true, any content-read of a .jsonl throws
let FS_CALLS = null; // when an array, every wrapped call records "fn:path"

function noteCall(fn, path) {
  if (FS_CALLS) FS_CALLS.push(`${fn}:${String(path)}`);
}
function guardLedger(fn, path) {
  const p = String(path);
  if (LEDGER_READ_GUARD && p.endsWith(".jsonl")) {
    throw new Error(`FORBIDDEN_LEDGER_CONTENT_READ via ${fn}: ${p}`);
  }
}

for (const fnName of ["readFileSync", "openSync", "readSync", "createReadStream"]) {
  const orig = fs[fnName];
  fs[fnName] = function wrapped(...args) {
    // readSync's first arg is an fd, not a path; recording it is still useful
    // as evidence that no content read happened at all during a probe.
    noteCall(fnName, args[0]);
    if (fnName !== "readSync") guardLedger(fnName, args[0]);
    return orig.apply(this, args);
  };
}
for (const fnName of ["statSync", "existsSync", "readdirSync", "lstatSync"]) {
  const orig = fs[fnName];
  fs[fnName] = function wrapped(...args) {
    noteCall(fnName, args[0]);
    return orig.apply(this, args);
  };
}
{
  const origPromiseRead = fs.promises.readFile;
  fs.promises.readFile = function wrapped(...args) {
    noteCall("promises.readFile", args[0]);
    guardLedger("promises.readFile", args[0]);
    return origPromiseRead.apply(this, args);
  };
}

// Canary: an ESM module that imports node:fs the same way the detector does.
// Importing it here (post-patch) both evaluates the node:fs ESM facade against
// the patched functions and PROVES the guard reaches ESM importers. If this
// self-check ever stops throwing, T6 would be vacuous — so it throws loudly.
const CANARY_PATH = join(TMP_ROOT, "fs-canary.mjs");
fs.writeFileSync(
  CANARY_PATH,
  'import { readFileSync } from "node:fs";\nexport const read = (p) => readFileSync(p, "utf8");\n',
  "utf8",
);
const canary = await import(pathToFileURL(CANARY_PATH).href);
{
  const probe = join(TMP_ROOT, "canary-probe.jsonl");
  fs.writeFileSync(probe, "{}\n", "utf8");
  LEDGER_READ_GUARD = true;
  let threw = false;
  try { canary.read(probe); } catch (e) { threw = /FORBIDDEN_LEDGER_CONTENT_READ/.test(String(e && e.message)); }
  LEDGER_READ_GUARD = false;
  if (!threw) {
    throw new Error(
      "fs guard self-check FAILED: the node:fs patch is not visible to ESM importers, " +
        "so T6's no-ledger-read guard would be vacuous. Refusing to run a fake test.",
    );
  }
  fs.rmSync(probe, { force: true });
}

// ---------------------------------------------------------------------------
// Subject under test (post-env-binding, post-fs-patch).
// ---------------------------------------------------------------------------
const mod = await import("../lib/synthesis/connector-staleness.js");
const { computeSourceCaptureStaleness, buildCaptureStalenessHealthNotes } = mod;

for (const [name, value] of Object.entries({
  computeSourceCaptureStaleness,
  buildCaptureStalenessHealthNotes,
})) {
  assert.equal(typeof value, "function", `lib/synthesis/connector-staleness.js must export ${name}`);
}

// ---------------------------------------------------------------------------
// Fixture helpers. NOW is frozen: no assertion depends on the wall clock.
// ---------------------------------------------------------------------------
const NOW = new Date("2026-08-11T18:00:00.000Z");
const H = 3600 * 1000;
const M = 60 * 1000;

let caseSeq = 0;
function newCase(label) {
  caseSeq += 1;
  const root = join(TMP_ROOT, "cases", `${caseSeq}-${label}`);
  const connectorsDir = join(root, "connectors");
  const sourcesDir = join(root, "storage", "sources");
  fs.mkdirSync(connectorsDir, { recursive: true });
  fs.mkdirSync(sourcesDir, { recursive: true });
  return { root, connectorsDir, sourcesDir };
}

function writeState(c, source, stateOrRaw) {
  const dir = join(c.connectorsDir, source);
  fs.mkdirSync(dir, { recursive: true });
  const raw = typeof stateOrRaw === "string" ? stateOrRaw : JSON.stringify(stateOrRaw, null, 2);
  fs.writeFileSync(join(dir, "state.json"), raw, "utf8");
}

// Writes a source ledger and stamps its mtime. `bytes` may be a Buffer whose
// content would throw if parsed — the detector must never look at it.
function writeLedger(c, source, bytes, mtimeMs) {
  const p = join(c.sourcesDir, `${source}.jsonl`);
  fs.writeFileSync(p, bytes);
  const secs = mtimeMs / 1000;
  fs.utimesSync(p, secs, secs);
  return p;
}

function bySource(snapshot) {
  const out = {};
  for (const e of snapshot) out[e.source] = e;
  return out;
}

// Only the synthetic sources a case created — the roster also carries the
// CAPS.WATERMARK_SOURCES names, which are `not_installed` under a hermetic root.
function only(snapshot, sources) {
  return snapshot.filter((e) => sources.includes(e.source));
}

const THRESHOLDS_6H = { default_ms: 6 * H, overrides_ms: {} };

// ---------------------------------------------------------------------------
// T1 — stale fires.
// ---------------------------------------------------------------------------
test("T1 a source silent for 9h under a 6h threshold is stale", () => {
  const c = newCase("t1-stale");
  const at = NOW.getTime() - 9 * H;
  writeState(c, "t1src", { last_appended_ts: new Date(at).toISOString(), last_polled_ts: new Date(NOW.getTime() - M).toISOString() });
  writeLedger(c, "t1src", "{}\n", at);

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["t1src"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const e = bySource(snapshot).t1src;
  assert.ok(e, "t1src must appear in the snapshot");
  assert.equal(e.reason, "stale");
  assert.equal(e.stale, true);
  assert.equal(e.installed, true);
  assert.equal(e.threshold_ms, 6 * H);
  assert.equal(e.append_age_ms, 9 * H);
  assert.equal(e.last_appended_ts, new Date(at).toISOString());
  assert.equal(typeof e.ledger_mtime_ms, "number");
  assert.equal(typeof e.ledger_size, "number");
});

// ---------------------------------------------------------------------------
// T2 — fresh does not fire.
// ---------------------------------------------------------------------------
test("T2 a source that appended 5m ago is fresh and silent", () => {
  const c = newCase("t2-fresh");
  const at = NOW.getTime() - 5 * M;
  writeState(c, "t2src", { last_appended_ts: new Date(at).toISOString() });
  writeLedger(c, "t2src", "{}\n", at);

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["t2src"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const e = bySource(snapshot).t2src;
  assert.equal(e.reason, "fresh");
  assert.equal(e.stale, false);
  assert.equal(e.append_age_ms, 5 * M);
});

// ---------------------------------------------------------------------------
// T3 — per-source thresholds. No single global number can satisfy BOTH
// assertions: 30h must be fresh under the 48h override and stale under the 6h
// default, in the SAME call.
// ---------------------------------------------------------------------------
test("T3 per-source thresholds are honored (30h fresh under 48h, stale under 6h)", () => {
  const c = newCase("t3-thresholds");
  const at = NOW.getTime() - 30 * H;
  for (const s of ["slowsrc", "fastsrc"]) {
    writeState(c, s, { last_appended_ts: new Date(at).toISOString() });
    writeLedger(c, s, "{}\n", at);
  }

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["slowsrc", "fastsrc"],
    thresholds: { default_ms: 6 * H, overrides_ms: { slowsrc: 48 * H } },
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const m = bySource(snapshot);
  assert.equal(m.slowsrc.reason, "fresh");
  assert.equal(m.slowsrc.stale, false);
  assert.equal(m.slowsrc.threshold_ms, 48 * H);
  assert.equal(m.fastsrc.reason, "stale");
  assert.equal(m.fastsrc.stale, true);
  assert.equal(m.fastsrc.threshold_ms, 6 * H);
});

// ---------------------------------------------------------------------------
// T4 — never_appended is its own verdict (the live `slack` shape: a state.json
// with no last_appended_ts key at all and NO storage/sources/slack.jsonl,
// while last_cursor_advance_ts is minutes old).
// ---------------------------------------------------------------------------
test("T4 never-appended is typed distinctly and is never reported fresh", () => {
  const c = newCase("t4-never");
  writeState(c, "neversrc", {
    last_polled_ts: new Date(NOW.getTime() - M).toISOString(),
    last_cursor_advance_ts: new Date(NOW.getTime() - 6 * M).toISOString(),
    error_count: 6148,
  });

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["neversrc"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const e = bySource(snapshot).neversrc;
  assert.equal(e.reason, "never_appended");
  assert.notEqual(e.reason, "fresh");
  assert.equal(e.stale, false, "never_appended must not fold into stale");
  assert.equal(e.installed, true);
  assert.equal(e.last_appended_ts, null);
  assert.equal(e.append_age_ms, null);

  const notes = buildCaptureStalenessHealthNotes(only(snapshot, ["neversrc"]));
  assert.deepEqual(notes, ["source_never_appended: neversrc"]);
});

// ---------------------------------------------------------------------------
// T5 — a read failure must never be indistinguishable from a healthy read
// (dep: s5-typed-read-failures).
// ---------------------------------------------------------------------------
test("T5 unparseable state.json is typed state_unreadable, never fresh", () => {
  const c = newCase("t5-unreadable");
  writeState(c, "badsrc", "{not json");

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["badsrc"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const e = bySource(snapshot).badsrc;
  assert.equal(e.reason, "state_unreadable");
  assert.notEqual(e.reason, "fresh");
  assert.equal(e.stale, false, "state_unreadable must not fold into stale");

  const notes = buildCaptureStalenessHealthNotes(only(snapshot, ["badsrc"]));
  assert.deepEqual(notes, ["source_state_unreadable: badsrc"]);
});

// ---------------------------------------------------------------------------
// T6 — mechanical guard for telegram-drain-liveness.js:18-22's hard rule. The
// fixture ledger holds bytes that would throw on any parse; any content read of
// a *.jsonl path throws FORBIDDEN_LEDGER_CONTENT_READ, which the detector's own
// try/catch could swallow — so we ALSO assert the recorded fs call log contains
// no content-read of a .jsonl at all.
// ---------------------------------------------------------------------------
test("T6 the detector never reads a source ledger's content", () => {
  const c = newCase("t6-noread");
  const at = NOW.getTime() - 2 * H;
  writeState(c, "bigsrc", { last_appended_ts: new Date(at).toISOString() });
  writeLedger(c, "bigsrc", Buffer.from([0xff, 0xfe, 0x7b, 0x22, 0x61, 0x00, 0x0a]), at);

  FS_CALLS = [];
  LEDGER_READ_GUARD = true;
  let snapshot;
  try {
    snapshot = computeSourceCaptureStaleness({
      now: NOW,
      sources: ["bigsrc"],
      thresholds: THRESHOLDS_6H,
      connectorsDir: c.connectorsDir,
      sourcesDir: c.sourcesDir,
    });
  } finally {
    LEDGER_READ_GUARD = false;
  }
  const calls = FS_CALLS;
  FS_CALLS = null;

  const e = bySource(snapshot).bigsrc;
  assert.equal(e.reason, "fresh", "a verdict is still returned over an unparseable ledger");
  assert.equal(e.ledger_size, 7);

  const contentReads = calls.filter(
    (c2) => /^(readFileSync|openSync|createReadStream|promises\.readFile):/.test(c2) && c2.endsWith(".jsonl"),
  );
  assert.deepEqual(contentReads, [], `detector performed a ledger content read: ${JSON.stringify(contentReads)}`);
  assert.ok(
    calls.some((c2) => c2.startsWith("statSync:") && c2.endsWith("bigsrc.jsonl")),
    `expected a statSync of the source ledger; got ${JSON.stringify(calls)}`,
  );
});

// ---------------------------------------------------------------------------
// T7 — the note formatter.
// ---------------------------------------------------------------------------
test("T7 the formatter emits exactly one note for stale and nothing for fresh", () => {
  const c = newCase("t7-notes");
  const staleAt = NOW.getTime() - 9 * H;
  writeState(c, "t7stale", { last_appended_ts: new Date(staleAt).toISOString() });
  writeLedger(c, "t7stale", "{}\n", staleAt);
  const freshAt = NOW.getTime() - 5 * M;
  writeState(c, "t7fresh", { last_appended_ts: new Date(freshAt).toISOString() });
  writeLedger(c, "t7fresh", "{}\n", freshAt);

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["t7stale", "t7fresh"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });

  const staleNotes = buildCaptureStalenessHealthNotes(only(snapshot, ["t7stale"]));
  assert.equal(staleNotes.length, 1);
  assert.ok(
    staleNotes[0].startsWith("source_capture_stale:"),
    `expected a source_capture_stale: note; got ${JSON.stringify(staleNotes)}`,
  );
  assert.equal(staleNotes[0], "source_capture_stale: t7stale last_append_h=9 threshold_h=6");

  const freshNotes = buildCaptureStalenessHealthNotes(only(snapshot, ["t7fresh"]));
  assert.deepEqual(freshNotes, []);

  // Malformed input never throws.
  assert.deepEqual(buildCaptureStalenessHealthNotes(null), []);
  assert.deepEqual(buildCaptureStalenessHealthNotes([null, undefined, {}]), []);
});

// ---------------------------------------------------------------------------
// T8 — purity: deterministic, and zero writes under TMP_ROOT.
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      const p = join(cur, d.name);
      if (d.isDirectory()) { stack.push(p); out.push(`D ${p}`); continue; }
      let st;
      try { st = fs.statSync(p); } catch { out.push(`E ${p}`); continue; }
      out.push(`F ${p} ${st.size} ${st.mtimeMs}`);
    }
  }
  out.sort();
  return out;
}

test("T8 the detector is pure: identical results, zero filesystem mutation", () => {
  const c = newCase("t8-purity");
  const at = NOW.getTime() - 9 * H;
  writeState(c, "p1", { last_appended_ts: new Date(at).toISOString() });
  writeLedger(c, "p1", "{}\n", at);
  writeState(c, "p2", "{not json");
  writeState(c, "p3", { last_polled_ts: new Date(NOW.getTime() - M).toISOString() });

  const args = {
    now: NOW,
    sources: ["p1", "p2", "p3"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  };
  const before = walk(TMP_ROOT);
  const a = computeSourceCaptureStaleness(args);
  const b = computeSourceCaptureStaleness(args);
  const after = walk(TMP_ROOT);

  assert.deepEqual(a, b, "two identical calls must be deep-equal");
  assert.deepEqual(after, before, "the detector must not create or modify any file");
});

// ---------------------------------------------------------------------------
// T9 — the screentime shape. screentime is in
// CAPS.WATERMARK_CAPTURED_ONLY_SOURCES (lib/validation.js:556-564) by a
// deliberate Wave-9 decision: its cascade cursor has been frozen at 2026-06-01
// ON PURPOSE while the connector captures normally. An alarm keyed on
// storage/watermark-state/<source>.json fires on it forever. This test pins
// both halves: the verdict is `fresh`, and no fs call touches watermark-state.
// ---------------------------------------------------------------------------
test("T9 a frozen watermark cursor is irrelevant: screentime-shaped source is fresh", () => {
  const c = newCase("t9-screentime");
  const at = NOW.getTime() - 2 * M;
  writeState(c, "screentime", {
    last_appended_ts: new Date(at).toISOString(),
    last_cursor_advance_ts: new Date(at).toISOString(),
    error_count: 1,
  });
  writeLedger(c, "screentime", "{}\n", at);
  // The deliberately-frozen cascade cursor, in the canonical location.
  const wmDir = join(c.root, "storage", "watermark-state");
  fs.mkdirSync(wmDir, { recursive: true });
  fs.writeFileSync(
    join(wmDir, "screentime.json"),
    JSON.stringify({ last_appended_ts: "2026-06-01T00:00:00.000Z", last_offset: 12345, version: 1 }),
    "utf8",
  );

  FS_CALLS = [];
  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["screentime"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const calls = FS_CALLS;
  FS_CALLS = null;

  const e = bySource(snapshot).screentime;
  assert.equal(e.reason, "fresh");
  assert.equal(e.stale, false);
  assert.deepEqual(buildCaptureStalenessHealthNotes(only(snapshot, ["screentime"])), []);

  const cursorTouches = calls.filter((c2) => c2.includes("watermark-state"));
  assert.deepEqual(
    cursorTouches,
    [],
    `the detector must never key on the cascade cursor; touched ${JSON.stringify(cursorTouches)}`,
  );
});

// ---------------------------------------------------------------------------
// T10 — the live chat-claude-code shape: a ledger with NO connectors/<s>/
// directory at all. Judged on ledger mtime; never not_installed, never
// never_appended.
// ---------------------------------------------------------------------------
test("T10 a ledger-only source is judged on ledger mtime", () => {
  const c = newCase("t10-ledger-only");
  writeLedger(c, "ledgeronly", "{}\n", NOW.getTime() - 4 * M);
  writeLedger(c, "ledgeronlystale", "{}\n", NOW.getTime() - 30 * H);

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["ledgeronly", "ledgeronlystale"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const m = bySource(snapshot);
  assert.equal(m.ledgeronly.reason, "fresh");
  assert.equal(m.ledgeronly.installed, true, "a ledger on disk is a capture footprint");
  assert.equal(m.ledgeronly.last_appended_ts, null);
  assert.equal(m.ledgeronly.ledger_age_ms, 4 * M);
  assert.notEqual(m.ledgeronly.reason, "not_installed");
  assert.notEqual(m.ledgeronly.reason, "never_appended");

  assert.equal(m.ledgeronlystale.reason, "stale");
  assert.equal(m.ledgeronlystale.stale, true);
});

// ---------------------------------------------------------------------------
// T11 — roster + robustness. The roster is CAPS.WATERMARK_SOURCES minus
// wildcard entries, UNIONed with connector dirs that carry a state.json, so a
// connector installed but not yet registered is still covered. A source with
// neither footprint is not_installed and emits no note. Nothing throws.
// ---------------------------------------------------------------------------
test("T11 roster unions unregistered connector dirs; absent sources are silent", async () => {
  const c = newCase("t11-roster");
  writeState(c, "unregistered-connector", { last_appended_ts: new Date(NOW.getTime() - 9 * H).toISOString() });

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const m = bySource(snapshot);

  const { CAPS } = await import("../lib/validation.js");
  for (const entry of CAPS.WATERMARK_SOURCES) {
    if (entry.includes("*")) {
      assert.equal(m[entry], undefined, `wildcard roster entry ${entry} must be skipped`);
      continue;
    }
    assert.ok(m[entry], `roster must cover CAPS.WATERMARK_SOURCES entry ${entry}`);
    assert.equal(m[entry].reason, "not_installed", `${entry} has no footprint under the hermetic root`);
    assert.equal(m[entry].stale, false);
    assert.equal(m[entry].installed, false);
  }
  assert.ok(m["unregistered-connector"], "a connector dir with state.json joins the roster");
  assert.equal(m["unregistered-connector"].reason, "stale");

  // not_installed is silent.
  const notes = buildCaptureStalenessHealthNotes(snapshot);
  assert.deepEqual(
    notes,
    ["source_capture_stale: unregistered-connector last_append_h=9 threshold_h=6"],
  );

  // Never throws on hostile input.
  assert.doesNotThrow(() => computeSourceCaptureStaleness());
  assert.doesNotThrow(() =>
    computeSourceCaptureStaleness({
      now: NOW,
      sources: [null, "", 42, "ok-src"],
      thresholds: { default_ms: "nonsense", overrides_ms: null },
      connectorsDir: join(c.root, "does-not-exist"),
      sourcesDir: join(c.root, "also-missing"),
    }),
  );
});

// ===========================================================================
// e13 (capture-holes) — THE POLL AXIS AND THE ERROR CAUSE.
//
// T1-T11 above pin the CAPTURE axis: "did anything get appended?". That
// question has one answer and two meanings. A source can be silent because the
// connector RAN and found nothing upstream, or because the connector STOPPED
// RUNNING. Those demand opposite operator actions, and last_appended_ts cannot
// tell them apart. T14/T15 force the discrimination in a single call; T16 pins
// that a connector which writes no heartbeat is typed `unmeasurable` and never
// gets a positive reading. T12/T13 pin the error-CAUSE escalation on the live
// slack shape, without letting error_count near the verdict.
//
// Live shapes these encode, read off disk 2026-08-20T15:00:56Z:
//   connectors/slack/state.json      — last_appended_ts null, last_polled_ts
//                                      14:57:24.547Z, last_error_kind
//                                      "slack_auth_invalid_auth", last_error_ts
//                                      14:57:24.536Z, error_count 7358 (T12)
//   connectors/codex-cli/state.json  — error_count 100,675 but last_error_ts
//                                      2026-07-03, capturing normally (T13's
//                                      stale-tombstone case)
//   connectors/screentime|mail|imessage|whatsapp|github-events/state.json
//                                    — no last_polled_ts key at all (T16)
// ===========================================================================

// ---------------------------------------------------------------------------
// T12 — the escalation. Never appended AND failing right now: the verdict is
// its own reason, and the note names a cause an operator can act on.
// ---------------------------------------------------------------------------
test("T12 never-appended while erroring now is typed never_appended_erroring with its cause", () => {
  const c = newCase("t12-erroring");
  writeState(c, "t12slack", {
    last_polled_ts: new Date(NOW.getTime() - M).toISOString(),
    last_cursor_advance_ts: new Date(NOW.getTime() - 6 * M).toISOString(),
    error_count: 7358,
    last_error_kind: "slack_auth_invalid_auth",
    last_error_ts: new Date(NOW.getTime() - M).toISOString(),
  });
  // No storage/sources/t12slack.jsonl at all — the live slack shape.

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["t12slack"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const e = bySource(snapshot).t12slack;
  assert.equal(e.reason, "never_appended_erroring");
  assert.notEqual(e.reason, "fresh");
  assert.equal(e.stale, false, "never_appended_erroring must not fold into stale");
  assert.equal(e.installed, true);
  assert.equal(e.last_appended_ts, null);
  assert.equal(e.erroring_now, true);
  assert.equal(e.last_error_kind, "slack_auth_invalid_auth");
  assert.equal(e.error_count, 7358);
  assert.equal(e.error_age_ms, M);
  // The poll axis is orthogonal: slack DOES stamp last_polled_ts, so we know
  // the connector ran. It ran and failed — that is the whole finding.
  assert.equal(e.poll_liveness, "live");

  const notes = buildCaptureStalenessHealthNotes(only(snapshot, ["t12slack"]));
  assert.equal(notes.length, 1);
  assert.ok(
    notes[0].startsWith("source_never_appended_erroring: t12slack "),
    `expected the escalated note; got ${JSON.stringify(notes)}`,
  );
  assert.ok(
    notes[0].includes("last_error_kind=slack_auth_invalid_auth"),
    `the note must name the cause; got ${JSON.stringify(notes)}`,
  );
  assert.equal(
    notes[0],
    "source_never_appended_erroring: t12slack last_error_kind=slack_auth_invalid_auth error_count=7358 error_age_h=0",
  );
});

// ---------------------------------------------------------------------------
// T13 — the tombstone case. An OLD error must not escalate a silent source,
// and error_count must not either: codex-cli carries error_count 100,675 with
// a 48-day-old last_error_ts while capturing normally (REJECTED (c)). The note
// stays byte-identical to T4's plain form.
// ---------------------------------------------------------------------------
test("T13 a stale error never escalates never_appended; error_count is not a verdict input", () => {
  const c = newCase("t13-stale-error");
  writeState(c, "t13src", {
    last_polled_ts: new Date(NOW.getTime() - M).toISOString(),
    error_count: 100675,
    last_error_kind: "parse_error",
    last_error_ts: new Date(NOW.getTime() - 30 * 24 * H).toISOString(),
  });

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["t13src"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const e = bySource(snapshot).t13src;
  assert.equal(e.reason, "never_appended", "a 30d-old error is a tombstone, not a live failure");
  assert.equal(e.erroring_now, false);
  assert.equal(e.stale, false);
  // The cause fields are still CARRIED — they are annotation, and annotation of
  // an already-decided verdict is exactly what they are for.
  assert.equal(e.last_error_kind, "parse_error");
  assert.equal(e.error_count, 100675);
  assert.equal(e.error_age_ms, 30 * 24 * H);

  const notes = buildCaptureStalenessHealthNotes(only(snapshot, ["t13src"]));
  assert.deepEqual(notes, ["source_never_appended: t13src"]);
});

// ---------------------------------------------------------------------------
// T14 + T15 — THE DISCRIMINATION, forced in ONE call. Both sources have the
// identical 9h append age under the identical 6h threshold, so the capture axis
// alone cannot separate them. Only the poll heartbeat can:
//   t14ran     — polled 1m ago: the connector RAN and found nothing.
//   t15stopped — polled 9h ago: the connector STOPPED RUNNING.
// No single-axis detector can pass both halves of this test.
// ---------------------------------------------------------------------------
test("T14/T15 stale-with-a-live-poll and stale-with-a-dead-poll are separable in one call", () => {
  const c = newCase("t14-t15-poll-axis");
  const appendedAt = NOW.getTime() - 9 * H;
  writeState(c, "t14ran", {
    last_appended_ts: new Date(appendedAt).toISOString(),
    last_polled_ts: new Date(NOW.getTime() - M).toISOString(),
  });
  writeLedger(c, "t14ran", "{}\n", appendedAt);
  writeState(c, "t15stopped", {
    last_appended_ts: new Date(appendedAt).toISOString(),
    last_polled_ts: new Date(NOW.getTime() - 9 * H).toISOString(),
  });
  writeLedger(c, "t15stopped", "{}\n", appendedAt);

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["t14ran", "t15stopped"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const m = bySource(snapshot);

  // Identical on the capture axis...
  assert.equal(m.t14ran.reason, "stale");
  assert.equal(m.t15stopped.reason, "stale");
  assert.equal(m.t14ran.append_age_ms, 9 * H);
  assert.equal(m.t15stopped.append_age_ms, 9 * H);

  // ...and separated on the poll axis.
  assert.equal(m.t14ran.poll_liveness, "live", "polled 1m ago: the connector ran");
  assert.equal(m.t14ran.poll_age_ms, M);
  assert.equal(m.t14ran.last_polled_ts, new Date(NOW.getTime() - M).toISOString());
  assert.equal(m.t15stopped.poll_liveness, "stale", "polled 9h ago: the connector stopped");
  assert.equal(m.t15stopped.poll_age_ms, 9 * H);
  assert.notEqual(
    m.t14ran.poll_liveness,
    m.t15stopped.poll_liveness,
    "the two shapes must not collapse to one verdict",
  );

  // The discrimination is READABLE, not merely computed.
  assert.deepEqual(buildCaptureStalenessHealthNotes(only(snapshot, ["t14ran"])), [
    "source_capture_stale: t14ran last_append_h=9 threshold_h=6 poll_liveness=live polled_h=0",
  ]);
  assert.deepEqual(buildCaptureStalenessHealthNotes(only(snapshot, ["t15stopped"])), [
    "source_capture_stale: t15stopped last_append_h=9 threshold_h=6 poll_liveness=stale polled_h=9",
  ]);
});

// ---------------------------------------------------------------------------
// T16 — ABSENCE IS NEVER A VERDICT (GOAL invariant 1). Five of the nine
// installed connectors write no last_polled_ts key at all (screentime, mail,
// imessage, whatsapp, github-events, read 2026-08-20T15:00:56Z). Those must be
// typed `unmeasurable` — never "live", and never quietly folded into health.
//
// On the NOTE: `unmeasurable` deliberately appends no suffix (F13-5 in the
// module header). T7:408 and T11:579 pin the unannotated source_capture_stale
// line byte-for-byte for exactly this no-heartbeat shape, so a suffix here
// would mean editing their bodies. Silence is the honest rendering —
// health_notes is an exception channel, and saying nothing about the poll axis
// is not a claim about it. What this test enforces is the thing that actually
// matters: no note and no field may ever ASSERT poll health for a source that
// publishes no heartbeat.
// ---------------------------------------------------------------------------
test("T16 a connector with no poll heartbeat is unmeasurable, never live, never asserted healthy", () => {
  const c = newCase("t16-unmeasurable");
  const freshAt = NOW.getTime() - 5 * M;
  const staleAt = NOW.getTime() - 9 * H;
  // The live screentime/mail/imessage/whatsapp/github-events key set: appends
  // are recorded, polls are not.
  writeState(c, "t16fresh", {
    last_appended_ts: new Date(freshAt).toISOString(),
    last_cursor_advance_ts: new Date(freshAt).toISOString(),
    error_count: 1,
  });
  writeLedger(c, "t16fresh", "{}\n", freshAt);
  writeState(c, "t16stale", {
    last_appended_ts: new Date(staleAt).toISOString(),
    last_cursor_advance_ts: new Date(staleAt).toISOString(),
  });
  writeLedger(c, "t16stale", "{}\n", staleAt);

  const snapshot = computeSourceCaptureStaleness({
    now: NOW,
    sources: ["t16fresh", "t16stale"],
    thresholds: THRESHOLDS_6H,
    connectorsDir: c.connectorsDir,
    sourcesDir: c.sourcesDir,
  });
  const m = bySource(snapshot);

  for (const s of ["t16fresh", "t16stale"]) {
    assert.equal(m[s].poll_liveness, "unmeasurable", `${s} publishes no heartbeat`);
    assert.notEqual(m[s].poll_liveness, "live", `${s} must never read as live`);
    assert.notEqual(m[s].poll_liveness, "stale", `${s} must never read as a measured stale poll`);
    assert.equal(m[s].last_polled_ts, null);
    assert.equal(m[s].poll_age_ms, null);
  }
  // The capture axis is untouched by the missing heartbeat.
  assert.equal(m.t16fresh.reason, "fresh");
  assert.equal(m.t16stale.reason, "stale");

  // Every entry in the snapshot carries a poll_liveness value — the field is
  // total, so no source can silently escape the axis.
  for (const e of snapshot) {
    assert.ok(
      ["live", "stale", "unmeasurable"].includes(e.poll_liveness),
      `${e.source} carries no poll_liveness: ${JSON.stringify(e.poll_liveness)}`,
    );
  }

  // fresh stays silent (health_notes is an exception channel), and the stale
  // line is byte-identical to the form T7/T11 pin — no invented poll claim.
  assert.deepEqual(buildCaptureStalenessHealthNotes(only(snapshot, ["t16fresh"])), []);
  const staleNotes = buildCaptureStalenessHealthNotes(only(snapshot, ["t16stale"]));
  assert.deepEqual(staleNotes, [
    "source_capture_stale: t16stale last_append_h=9 threshold_h=6",
  ]);
  for (const n of buildCaptureStalenessHealthNotes(snapshot)) {
    assert.ok(
      !/poll_liveness=(live|stale)/.test(n),
      `a heartbeat-less source must never be given a poll verdict in a note: ${n}`,
    );
  }
});
