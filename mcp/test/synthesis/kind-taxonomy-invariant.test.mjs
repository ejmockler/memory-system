// kind-taxonomy-invariant.test.mjs — CI invariant for the closed 4-kind
// taxonomy established by architecture.md §4 ("Memory ledger").
//
// PROBLEM (root cause):
//   The first draft of the power-law decay contract (F-SYN-FOUNDATION-
//   power-law-decay-contract) smuggled three non-canonical labels
//   (`episodic`, `semantic`, `ambient`) into a per-kind f-value table as
//   though they were row-level memory-ledger kinds. They are not.
//   architecture.md §4 enumerates a closed set:
//     kind: "fact" | "policy" | "recall" | "reconstructed"
//   The smuggled labels are derivative axes (episodicity is a feature;
//   ambient is a surrounding-context bundle), not row kinds. Letting
//   them harden into per-kind tables creates a dispatch hole at the
//   integration boundary where `candidate.kind` is drawn from the
//   authoritative taxonomy and the smuggled keys are never hit.
//
// MECHANICAL ENFORCEMENT:
//   Grep the synthesis spec corpus (`mcp/docs/specs/synthesis/*.md`) and
//   the synthesis library (`mcp/lib/synthesis/**/*.js`) for tell-tale
//   row-level smuggle patterns:
//     kind: "ambient" | "semantic" | "episodic"
//     kind === "ambient" | "semantic" | "episodic"
//     kind == "ambient" | "semantic" | "episodic"
//   Assert the count is zero.
//
//   Two narrow whitelisted exceptions, enforced by allowlist file paths:
//   (1) The power-law-decay-contract.md spec itself is allowed to
//       MENTION the smuggled labels in its rebase narrative (§0 mapping
//       table, §5.2 dispatcher SMUGGLED_LABEL branch, telemetry schema).
//       To still catch accidental row-level smuggle inside the spec, we
//       additionally assert that the spec does NOT contain a literal
//       `kind: "ambient"` / `kind: "semantic"` / `kind: "episodic"`
//       assignment OUTSIDE of:
//         - the §0.1 mapping table (which explicitly demotes them),
//         - the §5.2 dispatcher pseudocode (which catches them as
//           SMUGGLED_LABEL),
//         - the §3.4 telemetry SMUGGLED_LABEL enum entry.
//       The simplest enforcement: ban the literal SOURCE-CODE pattern
//       `kind: "ambient"` (with a JS-style colon) anywhere in the spec,
//       since that pattern only appears in code blocks that propose a
//       row-level kind label.
//   (2) Worked examples and other synthesis specs may reference
//       `Entity.kind` values like person/place/topic — these are NOT
//       memory-ledger row kinds and are out of scope.
//
// Run: node test/synthesis/kind-taxonomy-invariant.test.mjs
// Exits 0 on pass, non-zero on any failure.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const SPEC_DIR = path.join(REPO_ROOT, "docs", "specs", "synthesis");
const LIB_DIR = path.join(REPO_ROOT, "lib", "synthesis");

// Forbidden row-level kind labels. These collapse into the §4.3
// fact-row stratification rule (episodic/semantic) or live on
// surrounding_context (ambient). They are NEVER row-level kinds.
const FORBIDDEN_LABELS = ["ambient", "semantic", "episodic"];

// JS/TS source-code smuggle patterns (these appear inside code blocks /
// type annotations / dispatcher tables). The grep matches literal
// `kind: "X"`, `kind === "X"`, `kind == "X"`, `kind:"X"` etc.
function buildSmuggleRegex(label) {
  // Examples matched:
  //   kind: "episodic"
  //   kind:"episodic"
  //   kind === "episodic"
  //   kind=="episodic"
  //   kind === 'episodic'
  // The regex is intentionally permissive on whitespace and quote style.
  return new RegExp(
    `\\bkind\\b\\s*(?::|===|==)\\s*["']${label}["']`,
    "g",
  );
}

// Whitelist: lines in power-law-decay-contract.md that intentionally
// describe the SMUGGLED LABEL legacy-fallback branch in the dispatcher
// (§5.2). These appear inside an `if kind in {...}` listing.
// Pattern: `if kind in {"episodic", "semantic", "ambient"}` (and minor
// variants). We allow ANY line in the spec that contains the canonical
// listing of all three labels together inside a `{...}` or `[...]`
// expression, on the assumption that any such grouping is a rebase
// narrative, not a per-row smuggle.
function isAllowedSmuggleNarrativeLine(line) {
  // Allow lines that reference the trio as a SET (rebase narrative).
  const allCanonicalTrioInSet = /\{[^}]*"episodic"[^}]*"semantic"[^}]*"ambient"[^}]*\}/;
  if (allCanonicalTrioInSet.test(line)) return true;
  return false;
}

let failures = 0;
let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${label}: ${e.message}`);
  }
}

function listFiles(dir, ext) {
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = readdirSync(d);
    } catch (e) {
      return;
    }
    for (const name of entries) {
      const full = path.join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && full.endsWith(ext)) out.push(full);
    }
  }
  walk(dir);
  return out;
}

function scanFile(filePath, label) {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const offenders = [];
  const re = buildSmuggleRegex(label);
  lines.forEach((line, i) => {
    re.lastIndex = 0;
    if (!re.test(line)) return;
    if (isAllowedSmuggleNarrativeLine(line)) return;
    offenders.push({ line_no: i + 1, line: line.trim() });
  });
  return offenders;
}

// --- Tests --------------------------------------------------------------

check("F-SYN-* synthesis specs do not smuggle row-level kind=ambient", () => {
  const files = listFiles(SPEC_DIR, ".md");
  const all = [];
  for (const f of files) {
    const offs = scanFile(f, "ambient");
    for (const o of offs) {
      all.push(`${path.relative(REPO_ROOT, f)}:${o.line_no}: ${o.line}`);
    }
  }
  if (all.length > 0) {
    throw new Error(
      `Found ${all.length} row-level kind="ambient" smuggle(s):\n  ` +
        all.join("\n  "),
    );
  }
});

check("F-SYN-* synthesis specs do not smuggle row-level kind=semantic", () => {
  const files = listFiles(SPEC_DIR, ".md");
  const all = [];
  for (const f of files) {
    const offs = scanFile(f, "semantic");
    for (const o of offs) {
      all.push(`${path.relative(REPO_ROOT, f)}:${o.line_no}: ${o.line}`);
    }
  }
  if (all.length > 0) {
    throw new Error(
      `Found ${all.length} row-level kind="semantic" smuggle(s):\n  ` +
        all.join("\n  "),
    );
  }
});

check("F-SYN-* synthesis specs do not smuggle row-level kind=episodic", () => {
  const files = listFiles(SPEC_DIR, ".md");
  const all = [];
  for (const f of files) {
    const offs = scanFile(f, "episodic");
    for (const o of offs) {
      all.push(`${path.relative(REPO_ROOT, f)}:${o.line_no}: ${o.line}`);
    }
  }
  if (all.length > 0) {
    throw new Error(
      `Found ${all.length} row-level kind="episodic" smuggle(s):\n  ` +
        all.join("\n  "),
    );
  }
});

check("synthesis lib source does not smuggle row-level kind=ambient", () => {
  const files = listFiles(LIB_DIR, ".js");
  const all = [];
  for (const f of files) {
    const offs = scanFile(f, "ambient");
    for (const o of offs) {
      all.push(`${path.relative(REPO_ROOT, f)}:${o.line_no}: ${o.line}`);
    }
  }
  if (all.length > 0) {
    throw new Error(
      `Found ${all.length} row-level kind="ambient" smuggle(s) in lib:\n  ` +
        all.join("\n  "),
    );
  }
});

check("synthesis lib source does not smuggle row-level kind=semantic", () => {
  const files = listFiles(LIB_DIR, ".js");
  const all = [];
  for (const f of files) {
    const offs = scanFile(f, "semantic");
    for (const o of offs) {
      all.push(`${path.relative(REPO_ROOT, f)}:${o.line_no}: ${o.line}`);
    }
  }
  if (all.length > 0) {
    throw new Error(
      `Found ${all.length} row-level kind="semantic" smuggle(s) in lib:\n  ` +
        all.join("\n  "),
    );
  }
});

check("synthesis lib source does not smuggle row-level kind=episodic", () => {
  const files = listFiles(LIB_DIR, ".js");
  const all = [];
  for (const f of files) {
    const offs = scanFile(f, "episodic");
    for (const o of offs) {
      all.push(`${path.relative(REPO_ROOT, f)}:${o.line_no}: ${o.line}`);
    }
  }
  if (all.length > 0) {
    throw new Error(
      `Found ${all.length} row-level kind="episodic" smuggle(s) in lib:\n  ` +
        all.join("\n  "),
    );
  }
});

// Sanity check: assert that the regex actually catches a real smuggle.
// If this test fails, the regex is too lax and the real tests above are
// vacuously passing.
check("regex catches a synthetic smuggle line (sanity check)", () => {
  const positives = [
    `kind: "ambient"`,
    `kind:"ambient"`,
    `kind === "semantic"`,
    `kind=="episodic"`,
    `  kind: 'episodic',`,
  ];
  for (const p of positives) {
    let hit = false;
    for (const label of FORBIDDEN_LABELS) {
      const re = buildSmuggleRegex(label);
      if (re.test(p)) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      throw new Error(`Regex did not catch synthetic smuggle: ${p}`);
    }
  }
});

// Sanity check: the regex must NOT catch unrelated kind references
// (e.g. entity kinds, policy_kinds, etc.) that legitimately appear in
// the synthesis corpus.
check("regex ignores unrelated kind references (false-positive check)", () => {
  const negatives = [
    `Entity.kind = "person"`,
    `policy_kind: "exclude"`,
    `kind: "fact"`,
    `kind: "policy"`,
    `kind: "recall"`,
    `kind: "reconstructed"`,
    `embedding_model_version: "v1"`,
    `// the smuggled labels are episodic/semantic/ambient`,
  ];
  for (const n of negatives) {
    for (const label of FORBIDDEN_LABELS) {
      const re = buildSmuggleRegex(label);
      if (re.test(n)) {
        throw new Error(
          `Regex falsely flagged legitimate line for label=${label}: ${n}`,
        );
      }
    }
  }
});

// --- Summary -------------------------------------------------------------

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
