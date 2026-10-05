// kb-spec-extract.test.mjs — R34 Foundation B11 self-test.
//
// Verifies the structural KB extractor behaves correctly across:
//   1. Happy path: BEGIN/END pair present, content extracted verbatim.
//   2. Multiple blocks in one file (catalog ordering, sibling extraction).
//   3. Missing block: clean error, helpful message naming the consumer.
//   4. Unclosed BEGIN: structural error at end-of-file.
//   5. Stray END: structural error pointing at the dangling marker.
//   6. Nested BEGIN: structural error (nesting is unsupported).
//   7. Mismatched END name: structural error naming both names.
//   8. File-not-found: clean error before any parse work.
//   9. Inline marker inside a paragraph is IGNORED (markers must be on
//      their own line per the convention).
//  10. listSpecs returns a stable catalog; hasSpec is the boolean variant.
//
// HERMETIC: synthesises every fixture under tmpdir; cleans up at exit.
// No new dependencies. ES modules only.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractSpec,
  listSpecs,
  hasSpec,
} from "../scripts/kb-spec-extract.mjs";

const root = join(
  tmpdir(),
  `kb-spec-extract-test-${process.pid}-${Date.now()}`,
);
mkdirSync(root, { recursive: true });

let failures = 0;
let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    process.stdout.write(`PASS  ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`FAIL  ${label}${detail ? ` -- ${detail}` : ""}\n`);
  }
}

function expectThrow(label, fn, messageSubstring) {
  try {
    fn();
    failures += 1;
    process.stdout.write(`FAIL  ${label} -- expected throw, got success\n`);
  } catch (err) {
    if (typeof messageSubstring === "string" && !err.message.includes(messageSubstring)) {
      failures += 1;
      process.stdout.write(
        `FAIL  ${label} -- threw, but message missing "${messageSubstring}": ${err.message}\n`,
      );
      return;
    }
    passed += 1;
    process.stdout.write(`PASS  ${label}\n`);
  }
}

// -- Fixture 1: happy path with two sibling blocks ---------------------------
const f1 = join(root, "happy.md");
writeFileSync(
  f1,
  [
    "# Doc",
    "",
    "Some prose.",
    "",
    "<!-- BEGIN-SPEC: source_msg_id -->",
    "formula = sha256(canonical_json({conversation_id, content_sha256, prev_source_msg_id}))",
    "<!-- END-SPEC: source_msg_id -->",
    "",
    "More prose between blocks.",
    "",
    "<!-- BEGIN-SPEC: batch_schema.v1 -->",
    "```json",
    "{",
    '  "batch_id": "<ulid>",',
    '  "runtime": "<string>"',
    "}",
    "```",
    "<!-- END-SPEC: batch_schema.v1 -->",
    "",
    "Trailing prose.",
    "",
  ].join("\n"),
);

const formula = extractSpec(f1, "source_msg_id");
check(
  "happy-1: extractSpec returns the exact body of source_msg_id",
  formula ===
    "formula = sha256(canonical_json({conversation_id, content_sha256, prev_source_msg_id}))",
  `got=${JSON.stringify(formula)}`,
);

const batch = extractSpec(f1, "batch_schema.v1");
check(
  "happy-2: extractSpec preserves fenced-code-block content inside a spec",
  batch.includes('"batch_id": "<ulid>"') && batch.startsWith("```json") && batch.endsWith("```"),
  `got=${JSON.stringify(batch)}`,
);

const catalog = listSpecs(f1);
check(
  "happy-3: listSpecs returns both blocks in file order",
  catalog.length === 2 &&
    catalog[0].name === "source_msg_id" &&
    catalog[1].name === "batch_schema.v1",
  `got=${JSON.stringify(catalog)}`,
);

check(
  "happy-4: hasSpec returns true for present block",
  hasSpec(f1, "source_msg_id") === true,
);
check(
  "happy-5: hasSpec returns false for absent block",
  hasSpec(f1, "no_such_block") === false,
);

// -- Fixture 2: missing block ------------------------------------------------
const f2 = join(root, "missing.md");
writeFileSync(
  f2,
  ["# Doc", "", "<!-- BEGIN-SPEC: alpha -->", "alpha body", "<!-- END-SPEC: alpha -->", ""].join(
    "\n",
  ),
);
expectThrow(
  "missing-1: extractSpec for an absent block throws with consumer-update hint",
  () => extractSpec(f2, "beta"),
  "must be updated too",
);
expectThrow(
  "missing-2: error names the present blocks for diagnosis",
  () => extractSpec(f2, "beta"),
  "[alpha]",
);

// -- Fixture 3: unclosed BEGIN ----------------------------------------------
const f3 = join(root, "unclosed.md");
writeFileSync(
  f3,
  ["# Doc", "<!-- BEGIN-SPEC: alpha -->", "alpha body without close", ""].join("\n"),
);
expectThrow(
  "unclosed-1: extractSpec on unclosed BEGIN throws naming the spec",
  () => extractSpec(f3, "alpha"),
  "unclosed BEGIN-SPEC",
);

// -- Fixture 4: stray END ----------------------------------------------------
const f4 = join(root, "stray-end.md");
writeFileSync(f4, ["# Doc", "<!-- END-SPEC: orphan -->", ""].join("\n"));
expectThrow(
  "stray-end-1: extractSpec on stray END throws naming the line",
  () => extractSpec(f4, "anything"),
  "has no matching BEGIN-SPEC",
);

// -- Fixture 5: nested BEGIN -------------------------------------------------
const f5 = join(root, "nested.md");
writeFileSync(
  f5,
  [
    "<!-- BEGIN-SPEC: outer -->",
    "outer prose",
    "<!-- BEGIN-SPEC: inner -->",
    "inner prose",
    "<!-- END-SPEC: inner -->",
    "<!-- END-SPEC: outer -->",
    "",
  ].join("\n"),
);
expectThrow(
  "nested-1: nested BEGIN-SPEC is rejected with sibling-split hint",
  () => extractSpec(f5, "outer"),
  "nested BEGIN-SPEC",
);

// -- Fixture 6: mismatched END name -----------------------------------------
const f6 = join(root, "mismatch.md");
writeFileSync(
  f6,
  [
    "<!-- BEGIN-SPEC: alpha -->",
    "body",
    "<!-- END-SPEC: beta -->",
    "",
  ].join("\n"),
);
expectThrow(
  "mismatch-1: mismatched END-SPEC name is rejected naming both",
  () => extractSpec(f6, "alpha"),
  "mismatched END-SPEC",
);

// -- Fixture 7: file-not-found -----------------------------------------------
const ghost = join(root, "does-not-exist.md");
expectThrow(
  "fnf-1: extractSpec on missing file throws clean diagnostic",
  () => extractSpec(ghost, "anything"),
  "file not found",
);
check(
  "fnf-2: hasSpec on missing file returns false (does NOT throw)",
  hasSpec(ghost, "anything") === false,
);

// -- Fixture 8: inline marker inside a paragraph is IGNORED -----------------
const f8 = join(root, "inline-paragraph.md");
writeFileSync(
  f8,
  [
    "This paragraph mentions <!-- BEGIN-SPEC: pseudo --> inline, which",
    "should be ignored because markers must be on their own line.",
    "",
    "<!-- BEGIN-SPEC: real -->",
    "real body",
    "<!-- END-SPEC: real -->",
    "",
  ].join("\n"),
);
const realBody = extractSpec(f8, "real");
check(
  "inline-1: real block extracts cleanly when prose mentions marker syntax",
  realBody === "real body",
  `got=${JSON.stringify(realBody)}`,
);
expectThrow(
  "inline-2: pseudo marker inside prose does NOT register as a spec block",
  () => extractSpec(f8, "pseudo"),
  "not found",
);

// -- Fixture 9: spec name with dots + dashes is supported -------------------
const f9 = join(root, "dotted-name.md");
writeFileSync(
  f9,
  [
    "<!-- BEGIN-SPEC: kb.schema.batch-v1 -->",
    "dotted body",
    "<!-- END-SPEC: kb.schema.batch-v1 -->",
    "",
  ].join("\n"),
);
check(
  "dotted-1: dotted+dashed spec names round-trip",
  extractSpec(f9, "kb.schema.batch-v1") === "dotted body",
);

// -- Fixture 10: multi-line body is preserved including blank lines ---------
const f10 = join(root, "multiline.md");
writeFileSync(
  f10,
  [
    "<!-- BEGIN-SPEC: multi -->",
    "line 1",
    "",
    "line 3 after blank",
    "line 4",
    "<!-- END-SPEC: multi -->",
    "",
  ].join("\n"),
);
check(
  "multiline-1: blank lines inside the spec body are preserved",
  extractSpec(f10, "multi") === "line 1\n\nline 3 after blank\nline 4",
);

// -- Cleanup -----------------------------------------------------------------
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  /* ignore */
}

process.stdout.write(
  `\nkb-spec-extract.test.mjs: ${passed} passed, ${failures} failed\n`,
);
if (failures > 0) {
  process.exit(1);
}
