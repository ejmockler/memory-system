// THE C1-LESSON TEST — source_msg_id preimage byte-equality across the spec
// and the stop-hook implementation.
//
// History: the canonical preimage shape for source_msg_id silently drifted in
// three prior rounds (8/9/10). The field name "prev_source_msg_id" was
// renamed, dropped, or reordered with no test to catch the drift; downstream
// dedupe collapsed distinct turns. This test makes a fourth drift impossible
// to ship silently by:
//
//   1. Extracting the formula text from BOTH kb/agent-integration.md and
//      kb/build-plan.md; asserting they are STRING-EQUAL after whitespace
//      normalization. Spec ↔ spec drift fails here.
//   2. Computing source_msg_id for two fixed canonical chat-events; pinning
//      the hex. Implementation drift in canonicalJson or sha256 fails here.
//   3. Asserting the literal token "prev_source_msg_id" appears in the
//      canonical_json preimage string (catches a renamed field).
//   4. End-to-end: run hooks/stop-hook.sh against a fixed hook JSON via
//      stdin, parse the appended ledger line, and assert its source_msg_id
//      byte-equals the pinned hex. This is the spec ↔ impl preimage assertion.
//
// Run: node test/source-msg-id-preimage.test.mjs
// Exits 0 on pass, non-zero on any failure.
//
// HOME is reset to a fresh temp dir for the end-to-end run so the real
// chat-ledger and hook-errors log are not touched.

import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "../lib/validation.js";
import { extractCanonical } from "../scripts/canonical-block-scan.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");
const KB_DIR = join(REPO_ROOT, "kb");
const HOOKS_DIR = join(REPO_ROOT, "hooks");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
  assertions += 1;
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Spec ↔ spec drift: extract the source_msg_id formula from BOTH kb files
//    and assert they match after whitespace normalization.
// ---------------------------------------------------------------------------

function extractFormula(filePath, marker) {
  const text = readFileSync(filePath, "utf8");
  // Find the first occurrence of the marker, then read to the closing `)))`
  // of the outer sha256(...). Grep-like extraction keeps the test honest:
  // we read the spec text the way a human does, not via a structured parser.
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  // Take up to the next backtick OR closing angle bracket OR newline-after-`)))`.
  // The spec uses two encodings: build-plan.md wraps in backticks; agent-
  // integration.md wraps in <...> inside a code block. Normalize to the inner
  // formula by trimming surrounding markup.
  const slice = text.slice(idx, idx + 400);
  // Pull out up to the end of the outermost sha256(...) by counting parens.
  let depth = 0;
  let end = -1;
  for (let i = marker.length; i < slice.length; i++) {
    const ch = slice[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  return slice.slice(0, end);
}

function normalize(s) {
  // Collapse all whitespace runs (incl. backticks, surrounding markup) into
  // a single space; trim. Drop backticks entirely — they are markdown noise.
  return s.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

const FORMULA_MARKER = "source_msg_id = sha256";

const agentSpecPath = join(KB_DIR, "agent-integration.md");
const buildPlanPath = join(KB_DIR, "build-plan.md");

// agent-integration.md does NOT carry the literal "source_msg_id = sha256(...)"
// form — it uses an inline JSON template instead. We instead match the
// preimage-fields paragraph below it, which is the authoritative prose form.
// build-plan.md DOES carry the literal form. So we extract the prose form
// from agent-integration.md and the literal form from build-plan.md, then
// normalize each to its canonical "source_msg_id = sha256(canonical_json(
// {conversation_id, content_sha256, prev_source_msg_id}))" shape and compare.

const buildPlanText = readFileSync(buildPlanPath, "utf8");
const agentText = readFileSync(agentSpecPath, "utf8");

// R34 B12: structural extraction. The formula lives inside a CANONICAL
// block in build-plan.md and is locked to mcp/policy/canonical-allowlist.json.
// This replaces the prior anchor-text regex (extractFormula) which was
// silently broken by the R32.1 Phase-1 stub that deleted the formula
// surrounding prose.
let buildPlanFormula = null;
let buildPlanFormulaErr = null;
try {
  buildPlanFormula = extractCanonical(
    buildPlanPath,
    "source_msg_id_formula",
  ).trim();
} catch (e) {
  buildPlanFormulaErr = e.message;
}
check(
  "formula extracted from build-plan.md (canonical block)",
  buildPlanFormula != null,
  buildPlanFormulaErr,
);

// agent-integration.md carries two sources of the same formula:
//   (1) the inline-JSON template at "source_msg_id": "<sha256(...)>", which
//       documents the stop-hook payload shape; and
//   (2) the R35 M2 CANONICAL block 'source_msg_id_inline_formula' which is the
//       structurally-bound, sha256-locked form a consumer SHOULD extract.
// Both must agree with build-plan.md. We assert via extractCanonical (primary,
// drift-proof) AND via the inline-JSON includes() (legacy compat) so a future
// migrator that deletes either path fails this gate.
let agentFormulaExtracted = null;
let agentFormulaExtractedErr = null;
try {
  agentFormulaExtracted = extractCanonical(
    agentSpecPath,
    "source_msg_id_inline_formula",
  ).trim();
} catch (e) {
  agentFormulaExtractedErr = e.message;
}
check(
  "agent-integration.md carries canonical source_msg_id_inline_formula block (R35 M2)",
  agentFormulaExtracted != null,
  agentFormulaExtractedErr,
);
const agentMarker =
  '"source_msg_id": "<sha256(canonical_json({conversation_id, content_sha256, prev_source_msg_id}))>"';
const agentHasInlineForm = agentText.includes(agentMarker);
check(
  "agent-integration.md still carries inline source_msg_id formula (legacy compat)",
  agentHasInlineForm,
);
// Re-form the agent formula in the same shape as build-plan.md for comparison.
const agentFormula =
  agentFormulaExtracted ||
  "source_msg_id = sha256(canonical_json({conversation_id, content_sha256, prev_source_msg_id}))";

const buildPlanNorm = buildPlanFormula
  ? normalize(buildPlanFormula)
  : "<missing>";
const agentNorm = normalize(agentFormula);
check(
  "spec formulas STRING-EQUAL after whitespace normalization",
  buildPlanNorm === agentNorm,
  `build-plan: ${buildPlanNorm}\n      agent:      ${agentNorm}`,
);

// Independent assertion: the literal token "prev_source_msg_id" appears in
// BOTH kb files, in BOTH the formula context AND the field-definition context.
// This catches "prev_source_msg_id_for_conversation" or similar drift.
check(
  "build-plan.md uses literal 'prev_source_msg_id'",
  buildPlanText.includes("prev_source_msg_id"),
);
check(
  "agent-integration.md uses literal 'prev_source_msg_id'",
  agentText.includes("prev_source_msg_id"),
);

// ---------------------------------------------------------------------------
// 2. Pinned hex: compute source_msg_id for a fixed canonical chat-event and
//    assert the hex equals the pinned value. Drift in canonicalJson, sha256,
//    or the preimage shape fails this assertion.
// ---------------------------------------------------------------------------

function sha256Hex(s) {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

// Turn 1: prev_source_msg_id = null (first turn of conversation).
const CONVERSATION_ID = "conv_test";

const turn1ContentPreimage = canonicalJson({
  user_text: "hi",
  assistant_text: "hello",
});
const turn1ContentSha256 = sha256Hex(turn1ContentPreimage);
const turn1SourceMsgIdPreimage = canonicalJson({
  conversation_id: CONVERSATION_ID,
  content_sha256: turn1ContentSha256,
  prev_source_msg_id: null,
});
const turn1SourceMsgId = sha256Hex(turn1SourceMsgIdPreimage);

// PINNED (first-run captures; subsequent runs must match exactly).
const PINNED_TURN1 =
  "d7359a876398fa6bdd437d243e318746930fd17f1d4b9182b0117ae3bf91a400";
const PINNED_TURN1_CONTENT_SHA256 =
  "ee3cdd8a804e593a8f2e740f59c543270f12ebf05a3794fe633f3d1c7bc428f4";

check(
  "turn1 content_sha256 matches pinned hex",
  turn1ContentSha256 === PINNED_TURN1_CONTENT_SHA256,
  `got=${turn1ContentSha256}`,
);
check(
  "turn1 source_msg_id matches pinned hex",
  turn1SourceMsgId === PINNED_TURN1,
  `got=${turn1SourceMsgId}`,
);

// Field-name discipline: the canonical_json preimage MUST contain the literal
// substring "prev_source_msg_id" (no "prev_source_msg_id_for_conversation",
// no "prev_id", no rename of any kind).
check(
  "turn1 preimage carries literal 'prev_source_msg_id'",
  turn1SourceMsgIdPreimage.includes("prev_source_msg_id"),
);
check(
  "turn1 preimage does NOT carry 'prev_source_msg_id_for_conversation'",
  !turn1SourceMsgIdPreimage.includes("prev_source_msg_id_for_conversation"),
);

// Turn 2: prev_source_msg_id = turn1's hash; different user/assistant text.
const turn2ContentPreimage = canonicalJson({
  user_text: "ok",
  assistant_text: "ack",
});
const turn2ContentSha256 = sha256Hex(turn2ContentPreimage);
const turn2SourceMsgIdPreimage = canonicalJson({
  conversation_id: CONVERSATION_ID,
  content_sha256: turn2ContentSha256,
  prev_source_msg_id: turn1SourceMsgId,
});
const turn2SourceMsgId = sha256Hex(turn2SourceMsgIdPreimage);

const PINNED_TURN2 =
  "4915c5e6831c5e75d09b2b613241c9b1f72f5bc3db4f0cab76e790998cb1a4c8";

check(
  "turn2 source_msg_id matches pinned hex",
  turn2SourceMsgId === PINNED_TURN2,
  `got=${turn2SourceMsgId}`,
);
check(
  "turn2 source_msg_id differs from turn1 (prev-chain works)",
  turn2SourceMsgId !== turn1SourceMsgId,
);
check(
  "turn2 preimage carries the turn1 hex inside the prev_source_msg_id slot",
  turn2SourceMsgIdPreimage.includes(turn1SourceMsgId),
);

// ---------------------------------------------------------------------------
// 3. End-to-end: drive stop-hook.sh with a fixed hook JSON and assert the
//    appended ledger line has source_msg_id == PINNED_TURN1.
//
// The hook resolves all data paths via MEMORY_ROOT, which the spawn env
// points at <tmpdir>/memory-system (HOME is redirected to the same fresh
// tmpdir only as a belt) — so we mirror the on-disk layout
// the script expects inside the tmpdir, including a symlink back to the
// real mcp/ tree (so the inline node block can import validation.js +
// envelope.js without us duplicating them).
// ---------------------------------------------------------------------------

const TMP_HOME = mkdtempSync(join(tmpdir(), "stop-hook-test-"));
try {
  const TMP_MEMORY = join(TMP_HOME, "memory-system");
  mkdirSync(join(TMP_MEMORY, "storage", "sources"), { recursive: true });
  mkdirSync(join(TMP_MEMORY, "hooks", ".tmp"), { recursive: true });
  // Symlink mcp/ to the real tree so the inline node block can resolve
  // validation.js + envelope.js. (The hook reads `${MEMORY_ROOT}/mcp/lib`.)
  // Use a copy if symlink unavailable.
  const realMcp = join(REPO_ROOT, "mcp");
  const tmpMcp = join(TMP_MEMORY, "mcp");
  const { symlinkSync } = await import("node:fs");
  try {
    symlinkSync(realMcp, tmpMcp);
  } catch (_e) {
    // Best-effort fallback: cpSync from node:fs.
    const { cpSync } = await import("node:fs");
    cpSync(realMcp, tmpMcp, { recursive: true });
  }

  // Compose the hook payload the way Claude Code's Stop hook emits it.
  const hookPayload = {
    session_id: CONVERSATION_ID,
    user_message: "hi",
    assistant_message: "hello",
  };

  const stopHookPath = join(HOOKS_DIR, "stop-hook.sh");
  check("stop-hook.sh exists", existsSync(stopHookPath));

  const proc = spawnSync("bash", [stopHookPath], {
    input: JSON.stringify(hookPayload),
    env: { ...process.env, HOME: TMP_HOME, MEMORY_ROOT: TMP_MEMORY },
    encoding: "utf8",
  });
  check(
    "stop-hook.sh exited 0",
    proc.status === 0,
    `status=${proc.status} stderr=${proc.stderr}`,
  );

  const ledgerPath = join(
    TMP_MEMORY,
    "storage",
    "sources",
    "chat-claude-code.jsonl",
  );
  check("ledger file written", existsSync(ledgerPath));

  const ledgerRaw = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8")
    : "";
  const ledgerLines = ledgerRaw.split("\n").filter((l) => l.length > 0);
  check(
    "exactly one ledger line appended",
    ledgerLines.length === 1,
    `got=${ledgerLines.length}`,
  );

  let ledgerEvent = null;
  if (ledgerLines.length === 1) {
    try {
      ledgerEvent = JSON.parse(ledgerLines[0]);
    } catch (e) {
      check("ledger line parses as JSON", false, String(e));
    }
  }

  if (ledgerEvent) {
    check(
      "ledger source matches",
      ledgerEvent.source === "chat-claude-code",
      `got=${ledgerEvent.source}`,
    );
    check(
      "ledger raw_content.conversation_id matches",
      ledgerEvent.raw_content?.conversation_id === CONVERSATION_ID,
      `got=${ledgerEvent.raw_content?.conversation_id}`,
    );
    // THE byte-equality assertion: the hook computed the same source_msg_id
    // as the pinned hex above. This proves the spec ↔ impl preimage is
    // identical down to the byte.
    check(
      "ledger source_msg_id BYTE-EQUALS PINNED_TURN1 (END-TO-END)",
      ledgerEvent.source_msg_id === PINNED_TURN1,
      `got=${ledgerEvent.source_msg_id} expected=${PINNED_TURN1}`,
    );
  }
} finally {
  // Best-effort cleanup of the tmpdir (symlink is safe to remove without
  // touching the real tree).
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 4. R28.1 parity tests — chat-claude-code stop-hook parity with codex-cli.
//
// Two defect classes were patched in stop-hook.sh's inline node block:
//   (a) array-form Anthropic Messages API content was silently dropped — only
//       typeof === "string" was previously accepted. Fix: extractText handles
//       string + array-of-content-blocks + nested tool_result.content.
//   (b) provider key shapes (AIza..., AQ...., sk-ant-...) were passed verbatim
//       into the ledger. Fix: redactKeyShapes runs on extracted text BEFORE
//       content_sha256, replacing matches with "<REDACTED:KEY_SHAPE>".
//
// We drive stop-hook.sh end-to-end and assert the appended ledger row's
// raw_content reflects both fixes.
// ---------------------------------------------------------------------------

function runStopHookOnce(payload) {
  const HOME2 = mkdtempSync(join(tmpdir(), "stop-hook-parity-"));
  const MEM2 = join(HOME2, "memory-system");
  mkdirSync(join(MEM2, "storage", "sources"), { recursive: true });
  mkdirSync(join(MEM2, "hooks", ".tmp"), { recursive: true });
  const realMcp2 = join(REPO_ROOT, "mcp");
  const tmpMcp2 = join(MEM2, "mcp");
  try {
    const { symlinkSync } = require("node:fs");
    symlinkSync(realMcp2, tmpMcp2);
  } catch (_) {
    const { cpSync } = require("node:fs");
    try { cpSync(realMcp2, tmpMcp2, { recursive: true }); } catch (__) {}
  }
  const stopHookPath2 = join(HOOKS_DIR, "stop-hook.sh");
  const proc2 = spawnSync("bash", [stopHookPath2], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: HOME2, MEMORY_ROOT: MEM2 },
    encoding: "utf8",
  });
  const ledgerPath2 = join(MEM2, "storage", "sources", "chat-claude-code.jsonl");
  const raw = existsSync(ledgerPath2) ? readFileSync(ledgerPath2, "utf8") : "";
  let row = null;
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 1) {
    try { row = JSON.parse(lines[0]); } catch (_) {}
  }
  try { rmSync(HOME2, { recursive: true, force: true }); } catch (_) {}
  return { row, status: proc2.status, stderr: proc2.stderr };
}

// Need a require() for the helper above (the test file is ESM).
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

// ---- T-array-form-user: Anthropic Messages API array-form user content ----
const arrayPayload = {
  session_id: "conv_parity_array",
  user_message: [
    { type: "text", text: "first chunk" },
    { type: "tool_result", content: [{ type: "text", text: "tool out" }] },
  ],
  assistant_message: [
    { type: "text", text: "agent reply" },
    { type: "tool_use", id: "tu_1", name: "X", input: {} },
  ],
};
const arrRes = runStopHookOnce(arrayPayload);
check(
  "[parity] array-form: stop-hook exited 0",
  arrRes.status === 0,
  `status=${arrRes.status} stderr=${arrRes.stderr}`,
);
check(
  "[parity] array-form: user_text concatenates text + nested tool_result",
  arrRes.row?.raw_content?.user_text === "first chunk\ntool out",
  `got=${JSON.stringify(arrRes.row?.raw_content?.user_text)}`,
);
check(
  "[parity] array-form: assistant_text extracts only the text block (tool_use skipped)",
  arrRes.row?.raw_content?.assistant_text === "agent reply",
  `got=${JSON.stringify(arrRes.row?.raw_content?.assistant_text)}`,
);

// ---- T-key-redaction: provider key shapes are scrubbed BEFORE write ----
// Synthetic-shape strings (not real keys; length-only assertion via the
// regex's {35,} / {40,} quantifiers).
const FAKE_AIZA = "AIza" + "A".repeat(36);
const FAKE_AQ = "AQ." + "B".repeat(50);
const FAKE_SK = "sk-ant-" + "C".repeat(45);
const keyPayload = {
  session_id: "conv_parity_redact",
  user_message: `please verify ${FAKE_AIZA} and ${FAKE_AQ}`,
  assistant_message: `ok also ${FAKE_SK} end`,
};
const keyRes = runStopHookOnce(keyPayload);
check(
  "[parity] key-redact: stop-hook exited 0",
  keyRes.status === 0,
  `status=${keyRes.status} stderr=${keyRes.stderr}`,
);
const keyRowJson = keyRes.row ? JSON.stringify(keyRes.row) : "";
check(
  "[parity] key-redact: AIza shape never appears in stored row",
  keyRowJson.length > 0 && !keyRowJson.includes(FAKE_AIZA),
);
check(
  "[parity] key-redact: AQ. shape never appears in stored row",
  keyRowJson.length > 0 && !keyRowJson.includes(FAKE_AQ),
);
check(
  "[parity] key-redact: sk-ant- shape never appears in stored row",
  keyRowJson.length > 0 && !keyRowJson.includes(FAKE_SK),
);
check(
  "[parity] key-redact: <REDACTED:KEY_SHAPE> marker present in user_text",
  (keyRes.row?.raw_content?.user_text || "").includes("<REDACTED:KEY_SHAPE>"),
);
check(
  "[parity] key-redact: <REDACTED:KEY_SHAPE> marker present in assistant_text",
  (keyRes.row?.raw_content?.assistant_text || "").includes("<REDACTED:KEY_SHAPE>"),
);

if (failures > 0) {
  console.error(`\n${failures} failure(s) out of ${assertions} assertions.`);
  process.exit(1);
}
console.log(`\nAll ${assertions} source_msg_id preimage assertions passed.`);
process.exit(0);
