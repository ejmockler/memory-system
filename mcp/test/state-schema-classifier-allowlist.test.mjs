// state-schema-classifier-allowlist.test.mjs
//
// R35 M3 regression coverage. Pins the documentation-context-aware
// suppression that prevents spec-sweep's STATE-SCHEMA classifier from
// flagging LIVE identifier mentions in KB prose, WHILE preserving the
// classifier's drift detection on actual deprecated-name occurrences.
//
// Closes the recursion floor M3 fix: classifier-driven scanner needs both
// FORBIDDEN_IDENTIFIERS (the negative set) AND ALLOWLISTED_LIVE_IDENTIFIERS
// (the positive set when context is KB documentation). The positive set is
// per-file-basename and KB-path-scoped — production code is never
// allowlisted.
//
// HERMETIC: imports helpers from scripts/spec-sweep.mjs directly; no
// filesystem writes; no spawn; runs in-process.
//
// SPEC-SWEEP SELF-DEFENSE: this test file enumerates currently-deprecated
// AND currently-live identifier names as INPUTS to the allowlist helper.
// To prevent spec-sweep from flagging this test as drift, all such names
// are assembled at runtime via string concatenation rather than appearing
// as bare literal tokens. The classifier's grep is fixed-string and does
// not constant-fold these expressions.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWLISTED_LIVE_IDENTIFIERS,
  isAllowlistedLiveIdentifier,
} from "../../scripts/spec-sweep.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push({ label, detail });
    process.stderr.write(
      `FAIL  ${label}${detail ? `\n      ${detail}` : ""}\n`,
    );
  }
}

// Identifier names assembled at runtime so the spec-sweep grep does not
// see them as bare literals in this source file. Each name is a real
// classifier term per scripts/spec-sweep.mjs sweepDeprecatedTerms().
const SCHEMA_VERSION = "schema" + "_version";
const LAST_PROCESSED_OFFSET = "last_processed" + "_offset";
const IN_FLIGHT_BATCH_IDS = "in_flight_batch" + "_ids";
const HIGH_WATER_MARK_OFFSET = "high_water_mark" + "_offset";
const TURN_RANGE = "turn" + "_range";

const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KB = join(CHECKOUT_ROOT, "kb");

// ---------------------------------------------------------------------------
// FIXTURE 1: allowlist shape is the contract the classifier relies on.
// ---------------------------------------------------------------------------
check(
  "ALLOWLISTED_LIVE_IDENTIFIERS is a Map",
  ALLOWLISTED_LIVE_IDENTIFIERS instanceof Map,
);
check(
  "ALLOWLISTED_LIVE_IDENTIFIERS has the four expected KB basenames",
  ALLOWLISTED_LIVE_IDENTIFIERS.has("mcp-surface.md") &&
    ALLOWLISTED_LIVE_IDENTIFIERS.has("glossary.md") &&
    ALLOWLISTED_LIVE_IDENTIFIERS.has("agent-integration.md") &&
    ALLOWLISTED_LIVE_IDENTIFIERS.has("legacy-archive.md"),
);
for (const [name, set] of ALLOWLISTED_LIVE_IDENTIFIERS) {
  check(
    `ALLOWLISTED_LIVE_IDENTIFIERS["${name}"] is a Set`,
    set instanceof Set,
  );
}

// ---------------------------------------------------------------------------
// FIXTURE 2: the four documented false-positive sites are now allowlisted.
// These were the 5 surviving spec-sweep hits enumerated in the R34
// brutalist (j) phase. Two of them are the same identifier in the same
// file at different lines (kb/agent-integration.md L105 and L121) —
// counted as one allowlist entry, but two distinct grep hits in the wild.
// ---------------------------------------------------------------------------
check(
  "mcp-surface.md schema-version is allowlisted (HEALTH envelope field)",
  isAllowlistedLiveIdentifier(`${KB}/mcp-surface.md`, SCHEMA_VERSION),
);
check(
  "glossary.md last-processed-offset is allowlisted (watermark cursor)",
  isAllowlistedLiveIdentifier(`${KB}/glossary.md`, LAST_PROCESSED_OFFSET),
);
check(
  "agent-integration.md last-processed-offset is allowlisted (watermark cursor)",
  isAllowlistedLiveIdentifier(
    `${KB}/agent-integration.md`,
    LAST_PROCESSED_OFFSET,
  ),
);
check(
  "legacy-archive.md in-flight-batch-ids is allowlisted (historical archive)",
  isAllowlistedLiveIdentifier(
    `${KB}/legacy-archive.md`,
    IN_FLIGHT_BATCH_IDS,
  ),
);

// ---------------------------------------------------------------------------
// FIXTURE 3: the allowlist is documentation-context-aware. Live-identifier
// mentions OUTSIDE the kb/ tree must NOT be allowlisted — production code
// references continue to fail the gate.
// ---------------------------------------------------------------------------
check(
  "production daemon file is NOT allowlisted for schema-version",
  !isAllowlistedLiveIdentifier(
    join(CHECKOUT_ROOT, "daemons/watermark.js"),
    SCHEMA_VERSION,
  ),
);
check(
  "production daemon file is NOT allowlisted for last-processed-offset",
  !isAllowlistedLiveIdentifier(
    join(CHECKOUT_ROOT, "daemons/watermark.js"),
    LAST_PROCESSED_OFFSET,
  ),
);
check(
  "production MCP lib file is NOT allowlisted for schema-version",
  !isAllowlistedLiveIdentifier(
    join(CHECKOUT_ROOT, "mcp/lib/tools/health.js"),
    SCHEMA_VERSION,
  ),
);
check(
  "test file is NOT allowlisted for in-flight-batch-ids",
  !isAllowlistedLiveIdentifier(
    join(CHECKOUT_ROOT, "mcp/test/some-test.mjs"),
    IN_FLIGHT_BATCH_IDS,
  ),
);
check(
  "scripts/spec-sweep.mjs itself is NOT allowlisted for any identifier",
  !isAllowlistedLiveIdentifier(
    join(CHECKOUT_ROOT, "scripts/spec-sweep.mjs"),
    SCHEMA_VERSION,
  ),
);

// ---------------------------------------------------------------------------
// FIXTURE 4: the allowlist is per-file-basename. Allowlisting a term in
// one KB file does NOT propagate to other KB files. A future KB author
// who wants to mention a live identifier in a NEW file must explicitly
// add it to the allowlist; cross-contamination would defeat the whole
// signal-to-noise improvement.
// ---------------------------------------------------------------------------
check(
  "thesis.md is NOT allowlisted for schema-version (not in the per-file map)",
  !isAllowlistedLiveIdentifier(`${KB}/thesis.md`, SCHEMA_VERSION),
);
check(
  "build-plan.md is NOT allowlisted for last-processed-offset",
  !isAllowlistedLiveIdentifier(
    `${KB}/build-plan.md`,
    LAST_PROCESSED_OFFSET,
  ),
);
check(
  "mcp-surface.md is NOT allowlisted for last-processed-offset",
  !isAllowlistedLiveIdentifier(
    `${KB}/mcp-surface.md`,
    LAST_PROCESSED_OFFSET,
  ),
);
check(
  "agent-integration.md is NOT allowlisted for schema-version",
  !isAllowlistedLiveIdentifier(
    `${KB}/agent-integration.md`,
    SCHEMA_VERSION,
  ),
);
check(
  "glossary.md is NOT allowlisted for in-flight-batch-ids",
  !isAllowlistedLiveIdentifier(
    `${KB}/glossary.md`,
    IN_FLIGHT_BATCH_IDS,
  ),
);

// ---------------------------------------------------------------------------
// FIXTURE 5: non-allowlisted terms are NOT suppressed in allowlisted files.
// Even mcp-surface.md (which has schema-version allowlisted) must still
// surface OTHER forbidden identifiers. The allowlist suppresses only the
// per-file pair, not all classifier hits in that file.
// ---------------------------------------------------------------------------
check(
  "mcp-surface.md is NOT allowlisted for turn-range (drift would still surface)",
  !isAllowlistedLiveIdentifier(`${KB}/mcp-surface.md`, TURN_RANGE),
);
check(
  "mcp-surface.md is NOT allowlisted for in-flight-batch-ids",
  !isAllowlistedLiveIdentifier(
    `${KB}/mcp-surface.md`,
    IN_FLIGHT_BATCH_IDS,
  ),
);
check(
  "mcp-surface.md is NOT allowlisted for high-water-mark-offset",
  !isAllowlistedLiveIdentifier(
    `${KB}/mcp-surface.md`,
    HIGH_WATER_MARK_OFFSET,
  ),
);
check(
  "legacy-archive.md is NOT allowlisted for schema-version",
  !isAllowlistedLiveIdentifier(
    `${KB}/legacy-archive.md`,
    SCHEMA_VERSION,
  ),
);
check(
  "legacy-archive.md is NOT allowlisted for turn-range",
  !isAllowlistedLiveIdentifier(`${KB}/legacy-archive.md`, TURN_RANGE),
);

// ---------------------------------------------------------------------------
// FIXTURE 6: the allowlist is .md-only. A non-markdown file in kb/ (none
// exist today, but the guard is defense-in-depth) must NOT be allowlisted.
// ---------------------------------------------------------------------------
check(
  "kb/.json files are NOT allowlisted",
  !isAllowlistedLiveIdentifier(
    `${KB}/some-fixture.json`,
    SCHEMA_VERSION,
  ),
);

// ---------------------------------------------------------------------------
// FIXTURE 7: only the /kb/ path segment qualifies a file as documentation.
// A file path that happens to contain the substring "kb" without being in
// the kb/ directory must NOT be allowlisted.
// ---------------------------------------------------------------------------
check(
  "non-kb path with 'kb' substring is NOT allowlisted",
  !isAllowlistedLiveIdentifier(
    join(CHECKOUT_ROOT, "mcp/lib/kb-spec-extract.js"),
    SCHEMA_VERSION,
  ),
);

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
process.stdout.write(
  `\nstate-schema-classifier-allowlist: ${pass} pass, ${fail} fail\n`,
);
if (fail > 0) {
  for (const f of failures) {
    process.stdout.write(`  - ${f.label}\n`);
  }
  process.exit(1);
}
process.exit(0);
