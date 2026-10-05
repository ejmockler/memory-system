// kb-spec-extract.mjs — R34 Foundation B11.
//
// Structural extractor for KB content consumed by tests + production code.
// Replaces anchor-text matching (brittle: a renamed heading silently breaks
// the reader) with explicit, machine-readable spec-block markers.
//
// CONVENTION
// ----------
// Any content in a KB markdown file that is read by a script or a test must
// be wrapped in a paired marker:
//
//     <!-- BEGIN-SPEC: <spec_name> -->
//     ...content (arbitrary markdown / code fences / prose)...
//     <!-- END-SPEC: <spec_name> -->
//
// Marker rules:
//   - <spec_name> is a snake_case or kebab-case identifier; the regex below
//     enforces [a-z0-9_.-]+ to keep namespacing flexible.
//   - Markers MUST appear on their own line (leading whitespace tolerated)
//     so the AST walk is line-based and unambiguous. A marker embedded in
//     a paragraph is ignored.
//   - BEGIN/END pairs MUST balance per spec_name. Unmatched markers cause
//     extractSpec to throw with a precise diagnostic.
//   - Nested spec blocks are NOT supported. A BEGIN-SPEC inside another
//     BEGIN-SPEC is rejected. (This keeps the extractor a single linear
//     scan rather than a recursive parser; KB authors should split content
//     into sibling blocks instead.)
//
// API
// ---
//   extractSpec(filepath, spec_name) -> string
//     Returns the content BETWEEN the BEGIN-SPEC and END-SPEC markers
//     (exclusive of the marker lines themselves; trailing newline of the
//     last content line preserved). Throws cleanly if:
//       - file does not exist
//       - BEGIN-SPEC marker for spec_name is missing
//       - END-SPEC marker for spec_name is missing
//       - markers are crossed / nested
//
//   listSpecs(filepath) -> Array<{ name, startLine, endLine }>
//     Returns every spec block in the file (1-indexed line numbers, both
//     inclusive of the marker lines themselves). Useful for catalog tools
//     and for the canonical-block-scan gate (B12).
//
//   hasSpec(filepath, spec_name) -> boolean
//     Cheap presence check that does not throw on absence.
//
// DESIGN NOTES
// ------------
// - No dependencies. Single-file scanner using node:fs + node:path.
// - The "AST" is intentionally trivial: a line-based pass over the markdown
//   source recognising marker lines. A full CommonMark parser is unnecessary
//   for this contract and would add a brittle dependency surface.
// - extractSpec returns the literal text between markers. Consumers that
//   want the body of a fenced code block can post-process by stripping the
//   surrounding ``` fence — a 2-line slice operation. This keeps the
//   extractor's contract narrow and predictable.
// - Error messages include a HELPFUL hint: "if intentionally removed, the
//   consumer (test or script) that calls extractSpec must be updated too".
//   This matches the B12 canonical-block deletion-protection story.
//
// USAGE (consumer example)
// ------------------------
//   import { extractSpec } from "./mcp/scripts/kb-spec-extract.mjs";
//   const formula = extractSpec(
//     "kb/build-plan.md",
//     "source_msg_id"
//   );
//   // formula now contains the canonical formula text; the test asserts
//   // against this string directly rather than against a regex over the
//   // entire build-plan.md.

import { readFileSync, existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Marker grammar. The regex matches:
//   - optional leading whitespace
//   - the literal "<!-- BEGIN-SPEC: " or "<!-- END-SPEC: "
//   - the spec name (snake_case / kebab-case / dotted)
//   - optional trailing whitespace
//   - the literal " -->"
//   - optional trailing whitespace + newline
//
// Anchoring at ^...$ ensures the marker must be on its own line; an inline
// "<!-- BEGIN-SPEC: x -->" inside a paragraph is silently ignored, which is
// the desired behaviour (paragraph prose mentioning the marker syntax in
// docs should not accidentally open a block).
const SPEC_NAME_RE = /[a-z0-9][a-z0-9_.\-]*/i;
const BEGIN_RE = new RegExp(
  `^\\s*<!--\\s*BEGIN-SPEC:\\s*(${SPEC_NAME_RE.source})\\s*-->\\s*$`,
);
const END_RE = new RegExp(
  `^\\s*<!--\\s*END-SPEC:\\s*(${SPEC_NAME_RE.source})\\s*-->\\s*$`,
);

function readKbFile(filepath) {
  if (!existsSync(filepath)) {
    throw new Error(
      `kb-spec-extract: file not found: ${filepath} — the consumer (test or script) calls extractSpec/listSpecs against a path that does not exist on disk`,
    );
  }
  return readFileSync(filepath, "utf8");
}

// Single linear scan over the lines. Builds the catalog AND validates the
// open/close pairing. Throws on:
//   - END without matching open BEGIN
//   - BEGIN while another spec is already open (nested)
//   - file ends with an unclosed BEGIN
function scanSpecs(text, filepath) {
  const lines = text.split("\n");
  const catalog = [];
  let open = null; // { name, startLine }
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const lineNum = i + 1;
    const beginMatch = ln.match(BEGIN_RE);
    if (beginMatch) {
      if (open !== null) {
        throw new Error(
          `kb-spec-extract: nested BEGIN-SPEC at ${filepath}:${lineNum} (spec="${beginMatch[1]}") — outer spec "${open.name}" opened at line ${open.startLine} is still open; nested spec blocks are not supported. Split the content into sibling blocks.`,
        );
      }
      open = { name: beginMatch[1], startLine: lineNum };
      continue;
    }
    const endMatch = ln.match(END_RE);
    if (endMatch) {
      const closingName = endMatch[1];
      if (open === null) {
        throw new Error(
          `kb-spec-extract: END-SPEC at ${filepath}:${lineNum} (spec="${closingName}") has no matching BEGIN-SPEC. Either the BEGIN was deleted or the END marker is a stray. If intentionally removed, the consumer (test or script) that read this block must be updated too.`,
        );
      }
      if (closingName !== open.name) {
        throw new Error(
          `kb-spec-extract: mismatched END-SPEC at ${filepath}:${lineNum}: expected END-SPEC: ${open.name} (opened line ${open.startLine}), got END-SPEC: ${closingName}.`,
        );
      }
      catalog.push({
        name: open.name,
        startLine: open.startLine,
        endLine: lineNum,
      });
      open = null;
      continue;
    }
  }
  if (open !== null) {
    throw new Error(
      `kb-spec-extract: unclosed BEGIN-SPEC at ${filepath}:${open.startLine} (spec="${open.name}") — end-of-file reached without matching END-SPEC: ${open.name}. The block is structurally broken.`,
    );
  }
  return { lines, catalog };
}

export function extractSpec(filepath, specName) {
  if (typeof specName !== "string" || specName.length === 0) {
    throw new Error(
      `kb-spec-extract: extractSpec requires a non-empty spec name (got ${JSON.stringify(specName)})`,
    );
  }
  const text = readKbFile(filepath);
  const { lines, catalog } = scanSpecs(text, filepath);
  const hit = catalog.find((c) => c.name === specName);
  if (!hit) {
    const present = catalog.map((c) => c.name);
    throw new Error(
      `kb-spec-extract: spec block "${specName}" not found in ${filepath}. ` +
        `Present spec blocks: [${present.join(", ") || "<none>"}]. ` +
        `If intentionally removed, the consumer (test or script) that calls extractSpec("${filepath}", "${specName}") must be updated too. ` +
        `If renamed, update the consumer to use the new name. ` +
        `If never introduced, wrap the canonical content in:\n` +
        `    <!-- BEGIN-SPEC: ${specName} -->\n` +
        `    ...content...\n` +
        `    <!-- END-SPEC: ${specName} -->`,
    );
  }
  // Body lines are strictly between the marker lines (exclusive). The
  // marker lines themselves are not part of the spec content.
  const bodyLines = lines.slice(hit.startLine, hit.endLine - 1);
  return bodyLines.join("\n");
}

export function listSpecs(filepath) {
  const text = readKbFile(filepath);
  const { catalog } = scanSpecs(text, filepath);
  return catalog;
}

export function hasSpec(filepath, specName) {
  if (!existsSync(filepath)) return false;
  try {
    const text = readFileSync(filepath, "utf8");
    const { catalog } = scanSpecs(text, filepath);
    return catalog.some((c) => c.name === specName);
  } catch {
    return false;
  }
}

// CLI surface (helpful for ad-hoc inspection during migrations).
//
//   node mcp/scripts/kb-spec-extract.mjs <filepath>                 # list
//   node mcp/scripts/kb-spec-extract.mjs <filepath> <spec_name>     # extract
// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  const [, , filepath, specName] = process.argv;
  if (!filepath) {
    process.stderr.write(
      "Usage:\n" +
        "  kb-spec-extract.mjs <filepath>              # list spec blocks\n" +
        "  kb-spec-extract.mjs <filepath> <spec_name>  # extract one block\n",
    );
    process.exit(1);
  }
  try {
    if (specName) {
      process.stdout.write(extractSpec(filepath, specName));
      if (!process.stdout.write("\n")) {
        // ignore
      }
      process.exit(0);
    } else {
      const catalog = listSpecs(filepath);
      if (catalog.length === 0) {
        process.stdout.write(`(no spec blocks found in ${filepath})\n`);
        process.exit(0);
      }
      for (const c of catalog) {
        process.stdout.write(`${c.name}\t${c.startLine}-${c.endLine}\n`);
      }
      process.exit(0);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
