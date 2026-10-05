// recall-caps-snapshot.test.mjs — R25.5 CRIT-7 regression.
//
// Pins the threading of CAPS snapshot into recall.jsonl rows so the week-1
// threshold-freeze verifier can match SALIENCE_WEIGHTS_V1_HASH and detect
// cap drift across re-weight events. Pre-fix: every persisted recall row
// had caps_snapshot=undefined because recall.js never called
// rerank.js _capsSnapshot. The fix exported `capsSnapshot` from
// mcp/lib/recall/rerank.js and threaded it into the recallEvent body just
// before appendRecallEvent.
//
// HERMETIC: tmp MEMORY_ROOT + force-unset GEMINI_API_KEY so the recall
// handler takes the degraded path (no network); we still expect
// caps_snapshot to be populated even on degraded recalls.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("recall-caps-snapshot");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-r25p5-recall-caps-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");
const INDICES_DIR = join(HERMETIC_ROOT, "indices");
for (const d of [HERMETIC_ROOT, POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, INDICES_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;

// Force-degrade Gemini so the test has zero network dependence.
delete process.env.GEMINI_API_KEY;

// Production snapshot guard.
// The production tree is lib/config.js's DEFAULT data root: the checkout that
// contains mcp/ (three levels above this file). Derived, never spelled.
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROD_MEMORY = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
const PROD_RECALL = join(CHECKOUT_ROOT, "ledgers", "recall.jsonl");
const PROD_INDICES = join(CHECKOUT_ROOT, "indices");
const PROD_SIGNING_KEY = join(CHECKOUT_ROOT, "policy", "distillation-signing-key.json");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = {
  memory: snap(PROD_MEMORY),
  recall: snap(PROD_RECALL),
  indices: snap(PROD_INDICES),
  signing_key: snap(PROD_SIGNING_KEY),
};

// ---------------------------------------------------------------------------
// 1. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const recallMod = await import("../../lib/tools/recall.js");
const { CAPS, SALIENCE_WEIGHTS_V1_HASH } = await import("../../lib/validation.js");

const RECALL_JSONL = join(LEDGERS_DIR, "recall.jsonl");

let failures = 0;
function record(label, ok, diag) {
  if (ok) {
    console.log(`PASS  ${label}` + (diag ? `  -- ${diag}` : ""));
  } else {
    failures += 1;
    console.log(`FAIL  ${label}  -- ${diag || "(no diagnostic)"}`);
  }
}

function readRecallJsonl() {
  if (!existsSync(RECALL_JSONL)) return [];
  return readFileSync(RECALL_JSONL, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

function buildArgs(currentQuery) {
  return {
    surrounding_context: {
      recent_turns: [{ role: "user", content: currentQuery }],
      agent_role: "test-agent",
      current_query: currentQuery,
      time: "2026-06-02T00:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_r25p5_recall_caps_snapshot_test",
    max_items: 12,
    max_chars: 4000,
  };
}

// ---------------------------------------------------------------------------
// T5: synthetic memory_recall call -> persisted row's caps_snapshot is
// populated, is an object (not a string), and carries the live
// SALIENCE_WEIGHTS_V1_HASH so the verifier can pin freeze-window drift.
// ---------------------------------------------------------------------------
{
  const linesBefore = readRecallJsonl().length;
  const QUERY = "what did the user say about caps snapshot threading?";
  const args = buildArgs(QUERY);

  let result = null;
  let exception = null;
  try {
    result = await recallMod.TOOL.handler(args);
  } catch (e) {
    exception = e.message;
  }

  const linesAfter = readRecallJsonl();
  const grewBy = linesAfter.length - linesBefore;
  const ev = linesAfter[linesAfter.length - 1] || null;

  const handlerOk = result != null && result.ok === true;
  const grewOk = grewBy === 1;
  const fieldPresent = ev != null && Object.prototype.hasOwnProperty.call(ev, "caps_snapshot");
  const fieldNotUndefined = ev != null && ev.caps_snapshot !== undefined;
  const fieldIsObject =
    ev != null &&
    ev.caps_snapshot != null &&
    typeof ev.caps_snapshot === "object" &&
    !Array.isArray(ev.caps_snapshot);
  const hashMatch =
    fieldIsObject &&
    ev.caps_snapshot.SALIENCE_WEIGHTS_V1_HASH === SALIENCE_WEIGHTS_V1_HASH;
  const versionMatch =
    fieldIsObject && ev.caps_snapshot.SALIENCE_VERSION === CAPS.SALIENCE_VERSION;
  const alphaMatch =
    fieldIsObject && ev.caps_snapshot.SALIENCE_ALPHA === CAPS.SALIENCE_ALPHA;

  const ok =
    exception == null &&
    handlerOk &&
    grewOk &&
    fieldPresent &&
    fieldNotUndefined &&
    fieldIsObject &&
    hashMatch &&
    versionMatch &&
    alphaMatch;

  record(
    "T5 memory_recall persists caps_snapshot matching live CAPS",
    ok,
    `grew_by=${grewBy} handler_ok=${handlerOk} present=${fieldPresent} ` +
      `not_undef=${fieldNotUndefined} is_obj=${fieldIsObject} ` +
      `hash_match=${hashMatch} version_match=${versionMatch} alpha_match=${alphaMatch} ` +
      `caps_hash_field=${fieldIsObject ? ev.caps_snapshot.SALIENCE_WEIGHTS_V1_HASH : "n/a"} ` +
      `expected_hash=${SALIENCE_WEIGHTS_V1_HASH} exception=${exception}`,
  );
}

// ---------------------------------------------------------------------------
// Production hermeticity guard.
// ---------------------------------------------------------------------------
{
  const after = {
    memory: snap(PROD_MEMORY),
    recall: snap(PROD_RECALL),
    indices: snap(PROD_INDICES),
    signing_key: snap(PROD_SIGNING_KEY),
  };
  const sameMem = after.memory === PROD_BEFORE.memory;
  const sameRecall = after.recall === PROD_BEFORE.recall;
  const sameIdx = after.indices === PROD_BEFORE.indices;
  const sameKey = after.signing_key === PROD_BEFORE.signing_key;
  record(
    "Production tree byte-stable",
    sameMem && sameRecall && sameIdx && sameKey,
    `mem=${sameMem} recall=${sameRecall} idx=${sameIdx} key=${sameKey}`,
  );
}

if (failures > 0) {
  console.log(`\nFAIL: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nALL PASS");
