// codex-cli-connector.test.mjs — R28 Phase 2a Codex CLI connector tests.
//
// Exercises lib/connectors/codex-cli.js against the synthetic JSONL fixture
// at test/fixtures/codex-cli-fixture.jsonl. NEVER reads ~/.codex/sessions.
//
// Edge cases covered (5 task-spec'd assertions + supporting ones):
//   T1: connector reads + appends 4 turns from a 14-row fixture (2 turns
//       are Stage-0-dropped: <environment_context>-only ping and the
//       all-empty turn); state.json carries per-session cursor + offset.
//   T2: re-running with state.json cursor advances correctly; second poll
//       appends 0 turns; ledger unchanged.
//   T3: empty-turn rows get dropped at Stage-0 (verified by absence of any
//       row with both user_text == "" and assistant_text == "").
//   T4: source_msg_id is deterministic across re-runs (same session_uuid +
//       turn_index produce identical source_msg_id; matches
//       "codex:<sessionId>:<turn_index>" shape).
//   T5: content extraction matches expected concatenation ("user: <...>
//       \n\nassistant: <...>"); raw_content carries user_text, assistant_text,
//       turn_index, conversation_id; system_prompt_hash present on the
//       first turn whose preceding developer-role row was hashed.
//
// HERMETICITY: env vars set BEFORE the dynamic import; the fixture is
// copied into a TEST_ROOT subtree and the sessionsGlobs is overridden to
// point at the copy. The live install's ledgers/memory.jsonl
// is snapshot-checked pre/post and the test fails if it drifts.
//
// KEY_LEAKAGE_ZERO: fixture content references only the placeholder strings
// ALPHA and BETA; no real API keys, no operator dialog, no UUIDs that map
// to real sessions.
//
// Run: node test/codex-cli-connector.test.mjs

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("codex-cli-connector");

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "codex-cli-conn-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
// Pin consent_basis so the test does not depend on operator env.
process.env.CODEX_CLI_CONSENT_BASIS = "first_party";
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety snapshot.
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try {
  const st = statSync(PROD_LEDGER);
  prodBefore = { mtimeMs: st.mtimeMs, size: st.size };
} catch {}

// ---------------------------------------------------------------------------
// Dynamic imports.
// ---------------------------------------------------------------------------
const { CodexCliConnector, _internals, _resetDirMemo } = await import("../lib/connectors/codex-cli.js");
const { STORAGE_DIR } = await import("../lib/config.js");

// ---------------------------------------------------------------------------
// Fixture staging: copy the fixture into a synthetic codex sessions tree.
// We place it at <TEST_ROOT>/codex-sessions/2026/06/02/rollout-<...>.jsonl
// to mirror the production layout. The connector's sessionsGlobs override
// resolves the same shape.
// ---------------------------------------------------------------------------
const FIXTURE_SRC = join(import.meta.dirname, "fixtures", "codex-cli-fixture.jsonl");
const SESSIONS_ROOT = join(TEST_ROOT, "codex-sessions");
const SESSION_DIR = join(SESSIONS_ROOT, "2026", "06", "02");
mkdirSync(SESSION_DIR, { recursive: true });
// Filename mirrors the canonical pattern; the trailing UUID is the
// session id we expect filenameToSessionId to extract. We use the same
// session UUID the fixture's session_meta carries so the per_session
// cursor key is stable across both code paths.
const SESSION_FILE_BASENAME =
  "rollout-2026-06-02T00-00-00-00000000-0000-7000-8000-000000000001.jsonl";
const SESSION_FILE = join(SESSION_DIR, SESSION_FILE_BASENAME);
copyFileSync(FIXTURE_SRC, SESSION_FILE);

const SESSIONS_GLOB = join(SESSIONS_ROOT, "*", "*", "*", "rollout-*.jsonl");

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function readLedger() {
  const path = join(STORAGE_DIR, "sources", "codex-cli.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

// The LOGICAL cursor: state.json merged with its heavy sidecar, mirroring
// ConnectorBase.readCursor — which is how every production consumer reads it.
//
// The corpus-sized per_session_* maps now live in state.heavy.json, rewritten
// only when their content changes, so they are no longer re-serialized into
// state.json on every poll. This helper previously read state.json raw and so
// asserted a physical layout rather than the cursor contract; the assertions
// below are about cursor SEMANTICS, which the merged view preserves exactly.
// readCursorSplit() covers the physical split separately.
function readCursorFile() {
  const path = join(TEST_ROOT, "connectors", "codex-cli", "state.json");
  if (!existsSync(path)) return null;
  const light = JSON.parse(readFileSync(path, "utf8"));
  const heavyPath = join(TEST_ROOT, "connectors", "codex-cli", "state.heavy.json");
  if (!existsSync(heavyPath)) return light;
  const raw = readFileSync(heavyPath, "utf8");
  if (raw === "") return light;
  return { ...light, ...JSON.parse(raw) };
}

// The physical view, for asserting the split actually happened.
function readCursorSplit() {
  const dir = join(TEST_ROOT, "connectors", "codex-cli");
  const lightPath = join(dir, "state.json");
  const heavyPath = join(dir, "state.heavy.json");
  return {
    light: existsSync(lightPath) ? JSON.parse(readFileSync(lightPath, "utf8")) : null,
    heavy: existsSync(heavyPath) ? JSON.parse(readFileSync(heavyPath, "utf8")) : null,
    lightBytes: existsSync(lightPath) ? readFileSync(lightPath, "utf8").length : 0,
    heavyBytes: existsSync(heavyPath) ? readFileSync(heavyPath, "utf8").length : 0,
    heavyMtimeMs: existsSync(heavyPath) ? statSync(heavyPath).mtimeMs : null,
  };
}

function clearLedger() {
  const path = join(STORAGE_DIR, "sources", "codex-cli.jsonl");
  try { rmSync(path); } catch {}
}

function clearConnectorDir() {
  rmSync(join(TEST_ROOT, "connectors"), { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
}

// ===========================================================================
// T0 — _internals helpers smoke (precondition for the higher-level checks)
// ===========================================================================
console.log("\n--- T0: internals smoke ---");
{
  check(
    "T0.a expandGlob resolves a wildcarded path under TEST_ROOT",
    _internals.expandGlob(SESSIONS_GLOB).length === 1,
    JSON.stringify(_internals.expandGlob(SESSIONS_GLOB)),
  );
  check(
    "T0.b filenameToSessionId extracts the trailing UUID",
    _internals.filenameToSessionId(SESSION_FILE_BASENAME) ===
      "00000000-0000-7000-8000-000000000001",
    _internals.filenameToSessionId(SESSION_FILE_BASENAME),
  );
  check(
    "T0.c extractText concatenates input/output_text parts",
    _internals.extractText([
      { type: "input_text", text: "hello" },
      { type: "output_text", text: "world" },
    ]) === "hello\n\nworld",
  );
  check(
    "T0.d buildContent prefixes user: / assistant:",
    _internals.buildContent("hi", "hey") === "user: hi\n\nassistant: hey",
  );
  check(
    "T0.e buildContent omits empty halves",
    _internals.buildContent("only user", "") === "user: only user",
  );
  // F-A6-CODEX-RECOMMENDED-PLUGINS — the harness plugin list envelope is
  // stamped auto_injected=true at write time when anchored, never when an
  // operator merely mentions the token mid-sentence.
  check(
    "T0.f looksAutoInjectedUserText tags an anchored <recommended_plugins> envelope",
    _internals.looksAutoInjectedUserText(
      "<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n\n- Airtable (airtable@openai-curated-remote)\n</recommended_plugins>",
    ) === true,
  );
  check(
    "T0.g looksAutoInjectedUserText ignores a mid-sentence <recommended_plugins> mention",
    _internals.looksAutoInjectedUserText(
      "the <recommended_plugins> block listed Airtable",
    ) === false,
  );
  // A9 — prove the stamp on the ACTUAL emitted row, not just the helper.
  // buildRow (codex-cli.js) sets raw_content.auto_injected ONLY when
  // autoInjected === true and otherwise leaves the key ABSENT, so the
  // negative case asserts absence — never `=== false`.
  {
    const turnH = {
      turn_index: 7,
      user_text: "<recommended_plugins>\nHere is a list of plugins...\n</recommended_plugins>",
      assistant_text: "Installed nothing; noted.",
      ts: "2026-06-02T22:45:10.000Z",
    };
    const rowH = _internals.buildRow({
      sessionId: "00000000-0000-7000-8000-000000000001",
      sessionFileBasename: SESSION_FILE_BASENAME,
      turn: turnH,
      autoInjected: _internals.looksAutoInjectedUserText(turnH.user_text),
      sessionCwd: "/tmp/a9-cwd",
    });
    check(
      "T0.h buildRow stamps raw_content.auto_injected === true for an anchored <recommended_plugins> turn",
      rowH.raw_content.auto_injected === true,
      JSON.stringify(rowH.raw_content),
    );
    check(
      "T0.h source_msg_id is codex:<session>:<turn_index> on the stamped row",
      rowH.source_msg_id === "codex:00000000-0000-7000-8000-000000000001:7",
      rowH.source_msg_id,
    );
    const turnI = {
      ...turnH,
      user_text: "the <recommended_plugins> block listed Airtable",
      assistant_text: "Right — that was the harness list, not something you asked for.",
    };
    const rowI = _internals.buildRow({
      sessionId: "00000000-0000-7000-8000-000000000001",
      sessionFileBasename: SESSION_FILE_BASENAME,
      turn: turnI,
      autoInjected: _internals.looksAutoInjectedUserText(turnI.user_text),
      sessionCwd: "/tmp/a9-cwd",
    });
    check(
      "T0.i buildRow leaves auto_injected ABSENT for a mid-sentence <recommended_plugins> mention",
      !("auto_injected" in rowI.raw_content),
      JSON.stringify(rowI.raw_content),
    );
  }
}

// ===========================================================================
// T1 — connector reads + appends 4 turns from the 14-row fixture
// ===========================================================================
console.log("\n--- T1: 14-row fixture → 4 emitted turns ---");
{
  clearLedger();
  clearConnectorDir();

  const c = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  const res = await c.pollOnce();

  // Fixture yields 6 paired turns (turn_index 0..5); Stage-0 drops:
  //   turn 0 — <environment_context>-only user with no assistant
  //   turn 3 — empty user + empty assistant
  // Net appended: 4.
  check("T1.a appended=4", res.appended === 4, JSON.stringify(res));
  check("T1.b errors=0", res.errors === 0, JSON.stringify(res));
  check("T1.c sessions=1", res.sessions === 1, JSON.stringify(res));

  const rows = readLedger();
  check("T1.d 4 rows on disk", rows.length === 4, `got ${rows.length}`);
  check("T1.e all rows source=codex-cli", rows.every((r) => r.source === "codex-cli"));
  check(
    "T1.f all rows consent_basis=first_party",
    rows.every((r) => r.source_policy?.consent_basis === "first_party"),
  );
  check(
    "T1.g all rows deletion_semantics=full_excise",
    rows.every((r) => r.source_policy?.deletion_semantics === "full_excise"),
  );
  check(
    "T1.h source_msg_id starts with codex:",
    rows.every((r) => typeof r.source_msg_id === "string" && r.source_msg_id.startsWith("codex:")),
  );
  check(
    "T1.i parties = [user, assistant]",
    rows.every(
      (r) => Array.isArray(r.parties) && r.parties.length === 2 &&
        r.parties[0] === "user" && r.parties[1] === "assistant",
    ),
  );
  check(
    "T1.j raw_content.conversation_id is the session UUID",
    rows.every((r) => r.raw_content?.conversation_id === "00000000-0000-7000-8000-000000000001"),
  );
  check(
    "T1.k turn_index values are 1, 2, 4, 5 (after Stage-0 drops at 0 + 3)",
    JSON.stringify(rows.map((r) => r.raw_content?.turn_index)) === "[1,2,4,5]",
  );
  check("T1.l checksum stamped", rows.every((r) => /^[0-9a-f]{32}$/.test(r.checksum || "")));
  check("T1.m id starts with ulid_", rows.every((r) => typeof r.id === "string" && r.id.startsWith("ulid_")));

  // Cursor state assertions.
  const state = readCursorFile();
  check("T1.n cursor file exists", state != null);
  check(
    "T1.o per_session_cursors carries last advanced turn_index (5)",
    state?.per_session_cursors?.["00000000-0000-7000-8000-000000000001"] === 5,
    JSON.stringify(state?.per_session_cursors),
  );
  check(
    "T1.p per_session_offsets reflects full-file byte length",
    Number.isInteger(state?.per_session_offsets?.[SESSION_FILE_BASENAME]) &&
      state.per_session_offsets[SESSION_FILE_BASENAME] === statSync(SESSION_FILE).size,
    JSON.stringify(state?.per_session_offsets),
  );
  check(
    "T1.q last_appended_ts populated (non-null)",
    typeof state?.last_appended_ts === "string" && state.last_appended_ts !== "",
  );
}

// ===========================================================================
// T2 — re-running with cursor: zero new appends, ledger unchanged
// ===========================================================================
console.log("\n--- T2: rerun with cursor → 0 new appends ---");
{
  const beforeRows = readLedger();
  // Snapshot the ledger bytes so we can detect any mutation.
  const ledgerPath = join(STORAGE_DIR, "sources", "codex-cli.jsonl");
  const beforeBytes = readFileSync(ledgerPath);

  const c = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  const res = await c.pollOnce();

  check("T2.a appended=0 (cursor advance dedup)", res.appended === 0, JSON.stringify(res));
  check("T2.b errors=0", res.errors === 0, JSON.stringify(res));

  const afterRows = readLedger();
  check("T2.c row count unchanged (4)", afterRows.length === beforeRows.length);
  const afterBytes = readFileSync(ledgerPath);
  check("T2.d ledger bytes unchanged", Buffer.compare(beforeBytes, afterBytes) === 0);
}

// ===========================================================================
// T3 — empty-turn rows get dropped at Stage-0
// ===========================================================================
console.log("\n--- T3: empty-turn rows dropped at Stage-0 ---");
{
  const rows = readLedger();
  const anyDoubleEmpty = rows.some(
    (r) => r.raw_content?.user_text === "" && r.raw_content?.assistant_text === "",
  );
  check("T3.a no row carries both user_text == '' AND assistant_text == ''", !anyDoubleEmpty);
  // Also confirm no row carries the <environment_context> prefix as user_text
  // — that row was Stage-0 dropped as environment_context_only.
  const anyEnvContext = rows.some(
    (r) =>
      typeof r.raw_content?.user_text === "string" &&
      /^\s*<environment_context>/i.test(r.raw_content.user_text) &&
      (r.raw_content?.assistant_text == null || r.raw_content.assistant_text === ""),
  );
  check("T3.b no <environment_context>-only ping survives", !anyEnvContext);
}

// ===========================================================================
// T4 — source_msg_id is deterministic across re-runs
// ===========================================================================
console.log("\n--- T4: deterministic source_msg_id across fresh-instance reruns ---");
{
  // Capture current source_msg_ids.
  const baselineIds = readLedger().map((r) => r.source_msg_id);

  // Fresh instance + fresh cursor dir; ledger left in place so dedup engages.
  clearConnectorDir();
  const c = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  const res = await c.pollOnce();

  // Even with no cursor, the base-class source_msg_id tail-read deduplicates
  // every row already on disk; net appended = 0.
  check("T4.a fresh-cursor poll appends 0 (dedup via base class)", res.appended === 0, JSON.stringify(res));

  const afterIds = readLedger().map((r) => r.source_msg_id);
  check(
    "T4.b source_msg_id list is identical after restart",
    JSON.stringify(afterIds) === JSON.stringify(baselineIds),
    `before=${JSON.stringify(baselineIds)} after=${JSON.stringify(afterIds)}`,
  );
  // Determinism: id shape is "codex:<session_uuid>:<turn_index>".
  const expectedFirst = "codex:00000000-0000-7000-8000-000000000001:1";
  check(
    "T4.c first source_msg_id matches deterministic shape",
    baselineIds[0] === expectedFirst,
    `got=${baselineIds[0]} expected=${expectedFirst}`,
  );
}

// ===========================================================================
// T5 — content extraction matches expected concatenation
// ===========================================================================
console.log("\n--- T5: content extraction shape + raw_content fidelity ---");
{
  const rows = readLedger();
  // Pull the second emitted turn (turn_index=2, user="now compute 2 + 2",
  // assistant="The answer is 4.").
  const turn2 = rows.find((r) => r.raw_content?.turn_index === 2);
  check("T5.a turn_index=2 row exists", turn2 != null);
  check(
    "T5.b raw_content.user_text matches fixture user text",
    turn2?.raw_content?.user_text === "now compute 2 + 2",
    JSON.stringify(turn2?.raw_content?.user_text),
  );
  check(
    "T5.c raw_content.assistant_text matches fixture assistant text",
    turn2?.raw_content?.assistant_text === "The answer is 4.",
    JSON.stringify(turn2?.raw_content?.assistant_text),
  );
  check(
    "T5.d content concatenates user:/assistant: with double newline",
    turn2?.content === "user: now compute 2 + 2\n\nassistant: The answer is 4.",
    JSON.stringify(turn2?.content),
  );
  // Confirm the first emitted turn carries the developer-row hash, since the
  // fixture's developer-role permissions row precedes turn_index=1.
  const turn1 = rows.find((r) => r.raw_content?.turn_index === 1);
  check("T5.e turn_index=1 row exists", turn1 != null);
  check(
    "T5.f turn_index=1 carries system_prompt_hash (16 hex chars)",
    typeof turn1?.raw_content?.system_prompt_hash === "string" &&
      /^[0-9a-f]{32}$/.test(turn1.raw_content.system_prompt_hash),
    JSON.stringify(turn1?.raw_content?.system_prompt_hash),
  );
  // Sanity: turn_index=2 (the math turn) should NOT carry a stale system
  // prompt hash — the developer-row pool was drained at turn_index=1.
  check(
    "T5.g turn_index=2 does NOT carry system_prompt_hash",
    turn2?.raw_content?.system_prompt_hash === undefined,
    JSON.stringify(turn2?.raw_content?.system_prompt_hash),
  );

  // Sanity check on a longer turn (turn_index=4, the community garden budget
  // placeholder turn).
  const turn4 = rows.find((r) => r.raw_content?.turn_index === 4);
  check("T5.h turn_index=4 row exists", turn4 != null);
  check(
    "T5.i turn_index=4 content carries both halves",
    typeof turn4?.content === "string" &&
      turn4.content.includes("user: ") &&
      turn4.content.includes("assistant: ALPHA") &&
      turn4.content.includes("BETA"),
  );
}

// ===========================================================================
// T6 — health surface returns ok after a successful poll
// ===========================================================================
console.log("\n--- T6: reportHealth() returns ok ---");
{
  // T4 cleared the cursor dir then re-polled with the ledger already full;
  // the re-poll deduped everything and so wrote a cursor with
  // last_appended_ts==null. Run one more pollOnce on a fresh ledger to
  // confirm reportHealth picks up the populated state. We clear both the
  // ledger and cursor dir so the poll genuinely appends and the cursor
  // last_appended_ts is non-null.
  clearLedger();
  clearConnectorDir();
  const c0 = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  await c0.pollOnce();

  const c = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  const h = c.reportHealth();
  check("T6.a status=ok", h.status === "ok", `status=${h.status}`);
  check("T6.b error_rate=0", h.error_rate === 0);
  check("T6.c source=codex-cli", h.source === "codex-cli");
  check("T6.d last_appended_ts populated", typeof h.last_appended_ts === "string", JSON.stringify(h));
}

// ===========================================================================
// T7 — no session files: graceful skip, errors=0
// ===========================================================================
console.log("\n--- T7: empty sessions glob → graceful skip ---");
{
  clearLedger();
  clearConnectorDir();
  const nonMatchingGlob = join(TEST_ROOT, "no-such-dir", "*", "*", "*", "rollout-*.jsonl");
  const c = new CodexCliConnector({ sessionsGlobs: [nonMatchingGlob] });
  const res = await c.pollOnce();
  check("T7.a appended=0", res.appended === 0, JSON.stringify(res));
  check("T7.b errors=0", res.errors === 0, JSON.stringify(res));
  check("T7.c sessions=0", res.sessions === 0, JSON.stringify(res));
  check("T7.d ledger empty", readLedger().length === 0);
}

// ===========================================================================
// T8 — F-NEW-R40-CODEX-ERR-STRING-TOO-LONG regression: chunked
// _readSessionRows on a session file larger than one read chunk.
//
// The old whole-file readFileSync path threw ERR_STRING_TOO_LONG on any
// rollout file past V8's max string length (536,870,888 bytes). Building a
// >536 MB fixture per test run is not viable, so instead we pin the
// MECHANISM that makes big files safe: the fd-based chunked reader. The
// synthetic file below is ~1.5 chunks long with (a) a JSONL line that
// straddles the chunk boundary mid-line and (b) multi-byte UTF-8 padding so
// the boundary almost certainly splits a character — the two failure modes
// a naive per-chunk toString would corrupt. We call _readSessionRows
// directly (no pollOnce) so the test stays cheap: no Stage-0, no ledger.
// ===========================================================================
console.log("\n--- T8: chunked _readSessionRows (mid-chunk line split) ---");
{
  const { writeFileSync } = await import("node:fs");
  const CHUNK = _internals.READ_CHUNK_BYTES;
  const CHUNK_DIR = join(TEST_ROOT, "chunked-sessions");
  mkdirSync(CHUNK_DIR, { recursive: true });
  const CHUNK_FILE = join(
    CHUNK_DIR,
    "rollout-2026-06-02T00-00-00-00000000-0000-7000-8000-000000000002.jsonl",
  );

  const metaLine = JSON.stringify({
    timestamp: "2026-06-03T00:00:00.000Z",
    type: "session_meta",
    payload: { id: "00000000-0000-7000-8000-000000000002", cwd: "/tmp/chunked-cwd" },
  });
  const itemLine = (i, text) =>
    JSON.stringify({
      timestamp: "2026-06-03T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "input_text", text }],
      },
    });

  // 2-byte UTF-8 padding ("χ") so any byte-level chunk boundary has a ~50%
  // chance of landing INSIDE a character — the carried-Buffer path must
  // reassemble it losslessly.
  const pad = "χ".repeat(200000); // 400,000 bytes per padded row
  const lines = [metaLine];
  let bytes = Buffer.byteLength(metaLine, "utf8") + 1;
  let i = 0;
  // Fill valid padded rows up to just short of the first chunk boundary...
  for (;;) {
    const line = itemLine(i, `row-${i} ${pad}`);
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes >= CHUNK) break;
    lines.push(line);
    bytes += lineBytes;
    i += 1;
  }
  // ...then a marker row GUARANTEED to straddle the boundary (it starts
  // before byte CHUNK and, being ~800 KB, ends after it). Record its text
  // so we can assert byte-exact round-tripping through the carry path.
  const markerText = `BOUNDARY-MARKER ${"χ".repeat(400000)} END-MARKER`;
  const markerLine = itemLine(i, markerText);
  lines.push(markerLine);
  bytes += Buffer.byteLength(markerLine, "utf8") + 1;
  const markerIndex = lines.length - 1; // index into `lines` == index into rows
  // A blank line (skipped, no parse_error) plus a tail past the boundary so
  // the walk spans a second chunk.
  lines.push("");
  bytes += 1;
  const tailOffsetBytes = bytes; // byte offset where the first tail row starts
  const TAIL_ROWS = 5;
  for (let t = 0; t < TAIL_ROWS; t++) {
    lines.push(itemLine(i + 1 + t, `tail-${t}`));
  }
  writeFileSync(CHUNK_FILE, lines.join("\n") + "\n");
  const fileSize = statSync(CHUNK_FILE).size;
  check("T8.pre synthetic file spans >1 chunk", fileSize > CHUNK, `size=${fileSize} chunk=${CHUNK}`);

  const c = new CodexCliConnector({ sessionsGlobs: [join(CHUNK_DIR, "rollout-*.jsonl")] });

  // (a) Full walk from byte 0 — every JSON line comes back, no error.
  const full = c._readSessionRows(CHUNK_FILE, 0);
  const expectedRows = lines.filter((l) => l !== "").length; // meta + items
  check("T8.a error=null on full walk", full.error === null, JSON.stringify(full.error));
  check("T8.b sessionId from session_meta", full.sessionId === "00000000-0000-7000-8000-000000000002", full.sessionId);
  check("T8.c sessionCwd from session_meta", full.sessionCwd === "/tmp/chunked-cwd", full.sessionCwd);
  check("T8.d all rows parsed", full.rows.length === expectedRows, `got ${full.rows.length} want ${expectedRows}`);
  check("T8.e newOffset = byte size", full.newOffset === fileSize, `got ${full.newOffset} want ${fileSize}`);
  const marker = full.rows[markerIndex];
  check(
    "T8.f boundary-straddling row round-trips byte-exact (split multi-byte char)",
    marker?.payload?.content?.[0]?.text === markerText,
    `len got=${marker?.payload?.content?.[0]?.text?.length} want=${markerText.length}`,
  );

  // (b) Unchanged file: fromOffset == size must RE-WALK from byte 0 (strict
  // `<` clamp). This is load-bearing for turn-index numbering — _pairTurns
  // numbers from the start of the rows it gets, so only a full walk yields
  // session-relative indexes that can pass the per_session_cursors gate.
  const rescan = c._readSessionRows(CHUNK_FILE, fileSize);
  check("T8.g fromOffset==size re-walks from 0", rescan.rows.length === expectedRows, `got ${rescan.rows.length}`);

  // (c) Mid-file byte offset at a line boundary: only the tail rows come
  // back, and session_meta is still recovered via the first-line read.
  const tail = c._readSessionRows(CHUNK_FILE, tailOffsetBytes);
  check("T8.h tail offset yields only tail rows", tail.rows.length === TAIL_ROWS, `got ${tail.rows.length} want ${TAIL_ROWS}`);
  check("T8.i sessionId recovered at non-zero offset", tail.sessionId === "00000000-0000-7000-8000-000000000002", tail.sessionId);
  check("T8.j sessionCwd recovered at non-zero offset", tail.sessionCwd === "/tmp/chunked-cwd", tail.sessionCwd);
  check("T8.k tail rows carry expected text", tail.rows[0]?.payload?.content?.[0]?.text === "tail-0",
    JSON.stringify(tail.rows[0]?.payload?.content?.[0]?.text));
  check("T8.l tail error=null (blank line is not a parse_error)", tail.error === null, JSON.stringify(tail.error));

  // (d) Error-shape parity with the old readFileSync version.
  const missing = c._readSessionRows(join(CHUNK_DIR, "no-such-file.jsonl"), 42);
  check("T8.m unreadable file tags err.code", missing.error === "ENOENT", JSON.stringify(missing.error));
  check("T8.n unreadable file keeps fromOffset", missing.newOffset === 42 && missing.rows.length === 0, JSON.stringify(missing));

  // (e) Malformed line mid-file still yields parse_error + the good rows.
  const BAD_FILE = join(CHUNK_DIR, "rollout-2026-06-02T00-00-00-00000000-0000-7000-8000-000000000003.jsonl");
  writeFileSync(BAD_FILE, metaLine + "\n" + "not-json{{{" + "\n" + itemLine(0, "ok-after-bad") + "\n");
  const bad = c._readSessionRows(BAD_FILE, 0);
  check("T8.o malformed line → parse_error", bad.error === "parse_error", JSON.stringify(bad.error));
  check("T8.p good rows survive the malformed line", bad.rows.length === 2, `got ${bad.rows.length}`);
  check("T8.q parse_error is NOT flagged as a read failure", bad.readFailed === false, JSON.stringify(bad.readFailed));
  const missingAgain = c._readSessionRows(join(CHUNK_DIR, "no-such-file.jsonl"), 42);
  check("T8.r genuine fs error IS flagged as a read failure", missingAgain.readFailed === true, JSON.stringify(missingAgain.readFailed));
}

// ===========================================================================
// T9 — F-NEW-R41-CODEX-PARSE-LOOP regression: a permanently-unparseable line
// must not pin the per-session offset or inflate error_count forever.
//
// The pre-R41 offset-advance gate (`errorCount === 0 || appendedInFile > 0`)
// treated line-level parse failures like transient read errors: the offset
// never advanced past a file whose content contains a bad line, so every
// poll re-read (and re-failed on) the same bytes and tagged parse_error
// again — an eternal loop observed live at ~1.3k error_count/min against a
// dead 912 MB session file. This block pins the fixed contract:
//   - valid rows AFTER a bad line still ingest (parse failures are
//     line-scoped, never file-fatal);
//   - the offset advances to EOF despite the parse error;
//   - parse_error is tagged at most ONCE per content version
//     (fileBase + size + mtimeMs, persisted in per_session_file_meta);
//   - a second pollOnce over the unchanged file performs ZERO reads
//     (asserted via a _readSessionRows call-count spy, plus offset and
//     error_count stability);
//   - a file that GROWS with valid rows after the bad line ingests them
//     losslessly with correct session-relative turn numbering (the
//     two-poll defer/re-walk dance), re-tagging at most once for the new
//     content version.
// ===========================================================================
console.log("\n--- T9: parse-error offset advance + once-per-version tag + unchanged-file skip ---");
{
  const { writeFileSync, appendFileSync } = await import("node:fs");
  clearLedger();
  clearConnectorDir();

  const T9_DIR = join(TEST_ROOT, "parse-loop-sessions");
  mkdirSync(T9_DIR, { recursive: true });
  const T9_SESSION_ID = "00000000-0000-7000-8000-000000000004";
  const T9_BASENAME = `rollout-2026-07-03T00-00-00-${T9_SESSION_ID}.jsonl`;
  const T9_FILE = join(T9_DIR, T9_BASENAME);
  const T9_GLOB = join(T9_DIR, "rollout-*.jsonl");

  const t9Meta = JSON.stringify({
    timestamp: "2026-07-03T00:00:00.000Z",
    type: "session_meta",
    payload: { id: T9_SESSION_ID, cwd: "/tmp/parse-loop-cwd" },
  });
  const t9Row = (role, text) =>
    JSON.stringify({
      timestamp: "2026-07-03T00:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    });

  // Permanently-unparseable line FOLLOWED by valid rows.
  writeFileSync(
    T9_FILE,
    [
      t9Meta,
      t9Row("user", "first question about the parser"),
      t9Row("assistant", "A thorough first answer about the parser internals."),
      "this-is-not-json{{{",
      t9Row("user", "second question after the corrupt line"),
      t9Row("assistant", "A thorough second answer that follows the corrupt line."),
    ].join("\n") + "\n",
  );
  const sizeV1 = statSync(T9_FILE).size;

  // --- Poll 1: valid rows ingest; offset reaches EOF; error tagged once. ---
  const c1 = new CodexCliConnector({ sessionsGlobs: [T9_GLOB] });
  const res1 = await c1.pollOnce();
  check("T9.a poll1 appends both valid turns despite the bad line", res1.appended === 2, JSON.stringify(res1));
  check("T9.b poll1 reports the parse error once", res1.errors === 1, JSON.stringify(res1));
  const state1 = readCursorFile();
  check(
    "T9.c offset advanced to EOF despite the parse error",
    state1?.per_session_offsets?.[T9_BASENAME] === sizeV1,
    JSON.stringify(state1?.per_session_offsets),
  );
  check("T9.d error_count === 1 (tagged once)", state1?.error_count === 1, JSON.stringify(state1?.error_count));
  check("T9.e last_error_kind === parse_error", state1?.last_error_kind === "parse_error", state1?.last_error_kind);
  const fileMeta1 = state1?.per_session_file_meta?.[T9_BASENAME];
  check(
    "T9.f per_session_file_meta pins the content version",
    fileMeta1?.size === sizeV1 && fileMeta1?.ingest_complete === true && fileMeta1?.parse_error_tagged === true,
    JSON.stringify(fileMeta1),
  );

  // --- Poll 2 (fresh instance — version record must survive on disk):
  // unchanged file ⇒ ZERO reads, no new error tag, stable offset. ---
  const c2 = new CodexCliConnector({ sessionsGlobs: [T9_GLOB] });
  let readCalls2 = 0;
  const origRead2 = c2._readSessionRows.bind(c2);
  c2._readSessionRows = (...args) => { readCalls2 += 1; return origRead2(...args); };
  const res2 = await c2.pollOnce();
  check("T9.g poll2 over unchanged file performs ZERO reads", readCalls2 === 0, `readCalls=${readCalls2}`);
  check("T9.h poll2 appends 0 / errors 0", res2.appended === 0 && res2.errors === 0, JSON.stringify(res2));
  check("T9.i poll2 still counts the session", res2.sessions === 1, JSON.stringify(res2));
  const state2 = readCursorFile();
  check("T9.j error_count unchanged after poll2 (no re-tag)", state2?.error_count === 1, JSON.stringify(state2?.error_count));
  check(
    "T9.k offset stable after poll2",
    state2?.per_session_offsets?.[T9_BASENAME] === sizeV1,
    JSON.stringify(state2?.per_session_offsets),
  );

  // --- Grow the file: a NEW valid turn lands after the bad line. The
  // version change forces a re-read; ingestion is the pre-existing
  // two-poll dance (tail walk defers mis-numbered turns, then the
  // from-zero re-walk ingests them with session-relative numbering). ---
  appendFileSync(
    T9_FILE,
    t9Row("user", "third question appended later") + "\n" +
      t9Row("assistant", "A thorough third answer appended after the first version.") + "\n",
  );
  const sizeV2 = statSync(T9_FILE).size;

  const c3 = new CodexCliConnector({ sessionsGlobs: [T9_GLOB] });
  const res3 = await c3.pollOnce();
  const state3 = readCursorFile();
  check(
    "T9.l content change bypasses the skip (offset → new EOF)",
    state3?.per_session_offsets?.[T9_BASENAME] === sizeV2,
    JSON.stringify(state3?.per_session_offsets),
  );
  const res4 = await c3.pollOnce();
  const rowsAfterGrowth = readLedger();
  const turn2Row = rowsAfterGrowth.find((r) => r.raw_content?.turn_index === 2);
  check(
    "T9.m appended-after-bad-line turn ingests losslessly with correct turn_index",
    res3.appended + res4.appended === 1 &&
      turn2Row != null &&
      turn2Row.raw_content?.user_text === "third question appended later",
    `res3=${JSON.stringify(res3)} res4=${JSON.stringify(res4)} turn2=${JSON.stringify(turn2Row?.raw_content)}`,
  );
  const state4 = readCursorFile();
  check(
    "T9.n parse error re-tagged at most once for the NEW content version",
    state4?.error_count === 2,
    JSON.stringify({ error_count: state4?.error_count }),
  );

  // --- Poll 5: file settled again ⇒ back to zero reads, no error growth. ---
  const c5 = new CodexCliConnector({ sessionsGlobs: [T9_GLOB] });
  let readCalls5 = 0;
  const origRead5 = c5._readSessionRows.bind(c5);
  c5._readSessionRows = (...args) => { readCalls5 += 1; return origRead5(...args); };
  const res5 = await c5.pollOnce();
  check("T9.o poll5 zero reads once the grown file is fully ingested", readCalls5 === 0, `readCalls=${readCalls5}`);
  check(
    "T9.p poll5 errors 0 and error_count stable",
    res5.errors === 0 && readCursorFile()?.error_count === 2,
    JSON.stringify({ res5, error_count: readCursorFile()?.error_count }),
  );
}

// ---------------------------------------------------------------------------
// T10 — heavy cursor state is split out and NOT rewritten on an idle poll.
//
// Regression: state.json is rewritten every poll because last_polled_ts /
// last_cursor_advance_ts are stamped with now(), so its bytes always differ.
// The three per-session maps used to live in that object, so a corpus-sized
// structure was re-serialized at poll frequency regardless of whether it
// changed. Measured in production: a 2.165 MB cursor rewritten every ~58 s to
// persist a 26-byte timestamp — 3.2 GB/day, ~83,000x amplification on the
// marginal update, while the source ledger had not grown in 16 hours.
//
// The fix routes them to a change-gated sidecar. This is NOT a cap: every
// session stays tracked and complete. What changes is that the WRITE becomes
// proportional to real change. The load-bearing assertion is T10.d — an idle
// poll must leave the sidecar's mtime untouched.
// ---------------------------------------------------------------------------
{
  clearLedger();
  clearConnectorDir();

  const c1 = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  await c1.pollOnce();

  const split1 = readCursorSplit();
  const HEAVY = ["per_session_file_meta", "per_session_offsets", "per_session_cursors"];

  check(
    "T10.a heavy sidecar written",
    split1.heavy != null && HEAVY.some((k) => split1.heavy[k] != null),
    JSON.stringify(Object.keys(split1.heavy || {})),
  );
  check(
    "T10.b heavy keys are ABSENT from state.json",
    HEAVY.every((k) => split1.light == null || split1.light[k] === undefined),
    JSON.stringify(Object.keys(split1.light || {})),
  );
  check(
    "T10.c merged cursor still exposes per_session_cursors (contract preserved)",
    readCursorFile()?.per_session_cursors?.["00000000-0000-7000-8000-000000000001"] === 5,
    JSON.stringify(readCursorFile()?.per_session_cursors),
  );

  // Idle poll: no session content changed, so only the timestamps move.
  // A fresh connector instance is used deliberately — the digest cache starts
  // cold, so this also proves the on-disk seed path elides the write rather
  // than relying on in-process memory.
  const c2 = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  const res2 = await c2.pollOnce();
  const split2 = readCursorSplit();

  check("T10.d0 idle poll appended nothing", res2.appended === 0, JSON.stringify(res2));
  check(
    "T10.d heavy sidecar NOT rewritten on an idle poll (mtime unchanged)",
    split1.heavyMtimeMs != null && split1.heavyMtimeMs === split2.heavyMtimeMs,
    `before=${split1.heavyMtimeMs} after=${split2.heavyMtimeMs}`,
  );
  check(
    "T10.e state.json stays the small hot-field file",
    split2.lightBytes < split2.heavyBytes || split2.heavyBytes === 0,
    `light=${split2.lightBytes}B heavy=${split2.heavyBytes}B`,
  );
  check(
    "T10.f cursor semantics survive the idle poll",
    readCursorFile()?.per_session_cursors?.["00000000-0000-7000-8000-000000000001"] === 5,
    JSON.stringify(readCursorFile()?.per_session_cursors),
  );
}

// ---------------------------------------------------------------------------
// T11 — glob expansion is memoized per directory, and DISCOVERY still works.
//
// expandGlob now reuses a directory's previous listing while that directory's
// (mtimeMs, ino) is unchanged, instead of readdir-ing every directory on every
// poll. In production the glob spans 6,297 files across 5,623 directories and
// was re-expanded every ~58 s — ~12,000 syscalls per poll, ~15M/day, to
// rediscover a date-partitioned tree whose past days never change.
//
// The risk the memo introduces is NOT stale file contents (every returned path
// is still stat'd downstream — T9 covers that). It is stale DISCOVERY: if the
// memo failed to invalidate, a newly created session would become permanently
// invisible. These cases pin exactly that, since adding a file changes the
// parent directory's mtime and MUST bust the memo.
// ---------------------------------------------------------------------------
{
  clearLedger();
  clearConnectorDir();

  // Start from a cold memo so this block is order-independent: earlier blocks
  // in this file have already walked the same tree.
  _resetDirMemo();

  // NOTE: these cases assert on `sessions` (how many session files the walk
  // FOUND), not `appended`. The new files below are copies of the same
  // fixture, so their rows carry source_msg_ids already ingested by the
  // baseline poll and are correctly deduped to appended=0. `sessions` is the
  // discovery signal and is exactly what the memo could break.
  const c1 = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  const base = await c1.pollOnce();
  check(
    "T11.a baseline poll found exactly 1 session",
    base.sessions === 1 && base.appended > 0,
    JSON.stringify(base),
  );

  // (1) NEW FILE in an EXISTING day directory — parent mtime moves.
  const newInSameDir = join(
    SESSION_DIR,
    "rollout-2026-06-02T00-00-00-00000000-0000-7000-8000-000000000005.jsonl",
  );
  copyFileSync(FIXTURE_SRC, newInSameDir);

  const c2 = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  const afterSameDir = await c2.pollOnce();
  check(
    "T11.b new file in an EXISTING directory is discovered (memo invalidated)",
    afterSameDir.sessions === 2,
    `expected 2 sessions found, got ${JSON.stringify(afterSameDir)}`,
  );

  // (2) NEW day DIRECTORY — a level the walk had already cached.
  const newDayDir = join(SESSIONS_ROOT, "2026", "06", "03");
  mkdirSync(newDayDir, { recursive: true });
  const newInNewDir = join(
    newDayDir,
    "rollout-2026-06-02T00-00-00-00000000-0000-7000-8000-000000000006.jsonl",
  );
  copyFileSync(FIXTURE_SRC, newInNewDir);

  const c3 = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  const afterNewDir = await c3.pollOnce();
  check(
    "T11.c new DIRECTORY is discovered (intermediate level memo invalidated)",
    afterNewDir.sessions === 3,
    `expected 3 sessions found, got ${JSON.stringify(afterNewDir)}`,
  );

  // (3) A poll with nothing changed must still be a clean no-op — the memo
  // serving cached listings must not resurrect already-consumed rows.
  const c4 = new CodexCliConnector({ sessionsGlobs: [SESSIONS_GLOB] });
  const idle = await c4.pollOnce();
  check(
    "T11.d unchanged tree -> idle poll appends nothing",
    idle.appended === 0 && idle.errors === 0,
    JSON.stringify(idle),
  );
}

// ---------------------------------------------------------------------------
// T12 — F-A6-CODEX-RECOMMENDED-PLUGINS end-to-end (A9): pollOnce() over a
// synthetic rollout stamps raw_content.auto_injected on the row READ BACK
// from the source ledger, and only on the anchored envelope.
//
// T0.f-T0.i prove the helper and buildRow in isolation; this block proves
// the same contract through the real capture path (parse -> cursor gate ->
// looksAutoInjectedUserText -> buildRow -> Stage-0 -> append).
//
// Why BOTH fixture turns carry an assistant reply: Stage-0 rule 2
// (stage0/codex-cli.js, reason `codex_scaffold_auto_injected`) DROPs a
// flagged row ONLY when assistant_text is empty — a flagged envelope WITH a
// reply PASSes so the dialogue half of the turn survives. Without replies
// turn 0 would be quarantined and never reach the ledger, leaving nothing
// to assert the stamp on. Same pattern as T9's synthetic rollout.
// ---------------------------------------------------------------------------
console.log("\n--- T12: pollOnce stamps auto_injected on the emitted <recommended_plugins> row ---");
{
  const { writeFileSync } = await import("node:fs");
  clearLedger();
  clearConnectorDir();

  const T12_DIR = join(TEST_ROOT, "a9-scaffold-sessions");
  mkdirSync(T12_DIR, { recursive: true });
  const T12_SESSION_ID = "00000000-0000-7000-8000-000000000007";
  const T12_BASENAME = `rollout-2026-08-01T00-00-00-${T12_SESSION_ID}.jsonl`;
  const T12_FILE = join(T12_DIR, T12_BASENAME);
  const T12_GLOB = join(T12_DIR, "rollout-*.jsonl");

  const t12Meta = JSON.stringify({
    timestamp: "2026-08-01T00:00:00.000Z",
    type: "session_meta",
    payload: { id: T12_SESSION_ID, cwd: "/tmp/a9-cwd" },
  });
  const t12Row = (role, text) =>
    JSON.stringify({
      timestamp: "2026-08-01T00:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    });

  writeFileSync(
    T12_FILE,
    [
      t12Meta,
      // turn 0 — anchored harness envelope, WITH a reply (see header).
      t12Row(
        "user",
        "<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n\n- Airtable (airtable@openai-curated-remote)\n</recommended_plugins>",
      ),
      t12Row("assistant", "Installed nothing; noted the available plugin list."),
      // turn 1 — operator merely MENTIONS the token mid-sentence.
      t12Row("user", "the <recommended_plugins> block listed Airtable"),
      t12Row("assistant", "Right — that was the harness list, not something you asked for."),
    ].join("\n") + "\n",
  );

  const c = new CodexCliConnector({ sessionsGlobs: [T12_GLOB] });
  const res = await c.pollOnce();
  check(
    "T12.a pollOnce appends both turns with zero errors (envelope-with-reply PASSes Stage-0 rule 2)",
    res.appended === 2 && res.errors === 0,
    JSON.stringify(res),
  );

  const rows = readLedger();
  const row0 = rows.find((r) => r?.raw_content?.turn_index === 0);
  const row1 = rows.find((r) => r?.raw_content?.turn_index === 1);
  check(
    "T12.b ledger row turn_index 0 (anchored envelope) carries raw_content.auto_injected === true",
    row0?.raw_content?.auto_injected === true,
    JSON.stringify(row0?.raw_content),
  );
  check(
    "T12.c ledger row turn_index 1 (mid-sentence mention) lacks the auto_injected key entirely",
    row1 != null && !("auto_injected" in row1.raw_content),
    JSON.stringify(row1?.raw_content),
  );
  check(
    "T12.d both rows carry source_msg_id codex:<session>:<turn_index>",
    row0?.source_msg_id === `codex:${T12_SESSION_ID}:0` &&
      row1?.source_msg_id === `codex:${T12_SESSION_ID}:1`,
    JSON.stringify(rows.map((r) => r.source_msg_id)),
  );
}

// ---------------------------------------------------------------------------
// Production-safety: confirm we never wrote to the real memory.jsonl.
// ---------------------------------------------------------------------------
let prodAfter = null;
try {
  const st = statSync(PROD_LEDGER);
  prodAfter = { mtimeMs: st.mtimeMs, size: st.size };
} catch {}
if (prodBefore != null && prodAfter != null) {
  const intact = prodBefore.mtimeMs === prodAfter.mtimeMs && prodBefore.size === prodAfter.size;
  check(
    "PROD-SAFETY production memory.jsonl mtime+size unchanged",
    intact,
    `before=${JSON.stringify(prodBefore)} after=${JSON.stringify(prodAfter)}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll codex-cli-connector assertions passed.`);
