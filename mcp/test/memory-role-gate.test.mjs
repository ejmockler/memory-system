// MEMORY_ROLE launch-identity SCOPE_BLOCKED gate tests.
// Verifies the step-0 scope check in lib/dispatch.js (mcp-surface.md §
// Privilege levels → "SCOPE_BLOCKED via launch-identity"): distillation-only
// tools must reject calls when the server's process env does NOT have
// MEMORY_ROLE=distillation, BEFORE any payload parsing or token verification.
//
// IMPORTANT — TEST DISCIPLINE:
//   dispatch.js captures MEMORY_ROLE at MODULE INIT (const MEMORY_ROLE =
//   process.env.MEMORY_ROLE || "agent"). Mutating process.env after the
//   module is cached has no effect on the running dispatch. To exercise all
//   three launch-identity states in one file we mutate process.env BEFORE
//   each dynamic import and use a unique query-string suffix to force Node's
//   ESM loader to instantiate a fresh module graph. Each import() therefore
//   sees a freshly-evaluated MEMORY_ROLE.
//
//   This test MUTATES process.env.MEMORY_ROLE GLOBALLY and uses dynamic
//   imports with cache-busted URLs. It MUST NOT run in parallel with tests
//   that assume the default ("agent") role — e.g., negative-paths.test.mjs
//   and envelope-dispatch.test.mjs call executeTool on shared module state.
//   The npm test chain runs files sequentially with &&, satisfying this.
//   We restore process.env to its prior state at exit as a courtesy to any
//   future in-process test runner, but the dispatch modules instantiated
//   here remain in the import cache.
//
// Run: node test/memory-role-gate.test.mjs
// Exits 0 on pass, non-zero on any failure.

// HERMETICITY (standing C-NEW-2 pattern): redirect memory-system paths to
// a tmpdir so the new Phase 3 v0 recall handler — exercised in case 4 — does
// NOT touch the production ledger directory. Recall in case 4 fails payload
// validation before writing, but pinning MEMORY_ROOT in advance defends
// against any future ordering change.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memory-role-gate-"));
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(TEST_ROOT, "telemetry");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Snapshot original env so we can restore at the end (defensive — other tests
// in this file's npm chain run in separate node processes, but a future
// in-process runner could care).
const __originalRole = process.env.MEMORY_ROLE;

// Helper: load a FRESH dispatch module with the current process.env.
// The cache-bust query string is unique per call so Node treats it as a
// distinct module specifier and re-evaluates the top-level statements,
// including `const MEMORY_ROLE = process.env.MEMORY_ROLE || "agent"`.
let __importSeq = 0;
async function freshDispatch() {
  __importSeq += 1;
  const url = new URL(
    `../lib/dispatch.js?role-gate=${__importSeq}`,
    import.meta.url,
  ).href;
  return await import(url);
}

const DISTILL_TOOL = "memory_distill_promote_fact";

// ---------------------------------------------------------------------------
// Case 1: MEMORY_ROLE unset → defaults to "agent" → SCOPE_BLOCKED on the
// distillation-only tool, BEFORE args are parsed. We pass {} (which would
// otherwise fail payload validation with INVALID_ARGUMENTS — confirmation_token
// missing). The fact that we get SCOPE_BLOCKED, not INVALID_ARGUMENTS, proves
// the gate fires at step 0 before validatePayload runs.
// ---------------------------------------------------------------------------
{
  delete process.env.MEMORY_ROLE;
  const { executeTool } = await freshDispatch();
  const env = await executeTool(DISTILL_TOOL, {});
  check("case 1 (MEMORY_ROLE unset) returned an envelope", env != null && typeof env === "object");
  check("case 1 ok=false", env.ok === false);
  check(
    "case 1 error.code === SCOPE_BLOCKED",
    env.error?.code === "SCOPE_BLOCKED",
    `got code=${env.error?.code}`,
  );
  // Spec promise: args are NOT parsed on the scope-block path. We did NOT
  // supply confirmation_token; an INVALID_ARGUMENTS here would mean payload
  // validation ran ahead of the scope gate — a step-ordering regression.
  check(
    "case 1 SCOPE_BLOCKED beats INVALID_ARGUMENTS (args not parsed)",
    env.error?.code !== "INVALID_ARGUMENTS",
  );
  check(
    "case 1 envelope meta.tool stamped with called name",
    env.meta?.tool === DISTILL_TOOL,
  );
  check("case 1 envelope data is null on error", env.data === null);
}

// ---------------------------------------------------------------------------
// Case 2: MEMORY_ROLE = "agent" (explicit default) → SCOPE_BLOCKED.
// Same shape as case 1; we verify the explicit value is treated identically
// to "absent" because the gate compares against "distillation" exactly,
// not against a denylist.
// ---------------------------------------------------------------------------
{
  process.env.MEMORY_ROLE = "agent";
  const { executeTool } = await freshDispatch();
  const env = await executeTool(DISTILL_TOOL, {});
  check("case 2 (MEMORY_ROLE='agent') ok=false", env.ok === false);
  check(
    "case 2 error.code === SCOPE_BLOCKED",
    env.error?.code === "SCOPE_BLOCKED",
    `got code=${env.error?.code}`,
  );
  check(
    "case 2 SCOPE_BLOCKED beats INVALID_ARGUMENTS (args not parsed)",
    env.error?.code !== "INVALID_ARGUMENTS",
  );
}

// ---------------------------------------------------------------------------
// Case 3: MEMORY_ROLE = "distillation" → scope gate does NOT fire. The next
// gate (payload validation) fires instead — empty args lack confirmation_token,
// source_refs, content, provenance. assertObjectShape throws
// ToolError(INVALID_ARGUMENTS) which dispatch's catch converts to envelope.
// This proves the gate is correctly conditional on role.
// ---------------------------------------------------------------------------
{
  process.env.MEMORY_ROLE = "distillation";
  const { executeTool } = await freshDispatch();
  const env = await executeTool(DISTILL_TOOL, {});
  check("case 3 (MEMORY_ROLE='distillation') ok=false", env.ok === false);
  check(
    "case 3 error.code === INVALID_ARGUMENTS (scope gate did NOT fire; next gate did)",
    env.error?.code === "INVALID_ARGUMENTS",
    `got code=${env.error?.code}`,
  );
  check(
    "case 3 did NOT short-circuit to SCOPE_BLOCKED",
    env.error?.code !== "SCOPE_BLOCKED",
  );
}

// ---------------------------------------------------------------------------
// Case 4: MEMORY_ROLE = "distillation" + a NON-distillation tool (memory_recall).
// SCOPE_BLOCKED must not fire — distillation-role servers can still call
// agent-surface tools (the gate is one-directional: agent role blocked from
// distillation tools, distillation role unrestricted on agent tools).
// memory_recall with {} fails payload validation → INVALID_ARGUMENTS.
// Either INVALID_ARGUMENTS or ok:true would satisfy "scope did not fire",
// but missing surrounding_context guarantees INVALID_ARGUMENTS in practice.
// ---------------------------------------------------------------------------
{
  process.env.MEMORY_ROLE = "distillation";
  const { executeTool } = await freshDispatch();
  const env = await executeTool("memory_recall", {});
  check("case 4 (recall under distillation role) ok=false", env.ok === false);
  check(
    "case 4 SCOPE_BLOCKED did NOT fire on agent-surface tool",
    env.error?.code !== "SCOPE_BLOCKED",
    `got code=${env.error?.code}`,
  );
  check(
    "case 4 fell through to INVALID_ARGUMENTS (normal validation)",
    env.error?.code === "INVALID_ARGUMENTS",
    `got code=${env.error?.code}`,
  );
}

// ---------------------------------------------------------------------------
// Case 5: MEMORY_ROLE = "distillation" + UNKNOWN tool name. Unknown tools
// resolve to NOT_FOUND regardless of role (the gate's DISTILLATION_ONLY_TOOLS
// set is closed; unknown names are not in it, so scope check passes through,
// then the registry lookup misses → NOT_FOUND). Verifies a probe-for-tool
// existence cannot be deflected to SCOPE_BLOCKED based on naming convention.
// ---------------------------------------------------------------------------
{
  process.env.MEMORY_ROLE = "distillation";
  const { executeTool } = await freshDispatch();
  const env = await executeTool("memory_distill_does_not_exist", {});
  check("case 5 (unknown distill-named tool under distillation role) ok=false", env.ok === false);
  check(
    "case 5 returns NOT_FOUND (unknown tools are NOT_FOUND regardless of role)",
    env.error?.code === "NOT_FOUND",
    `got code=${env.error?.code}`,
  );
  check(
    "case 5 did NOT misroute to SCOPE_BLOCKED for a name not in the registry",
    env.error?.code !== "SCOPE_BLOCKED",
  );
}

// ---------------------------------------------------------------------------
// Case 6 (defensive): MEMORY_ROLE = "" (empty string) → must NOT be treated
// as "distillation". The gate uses `MEMORY_ROLE !== "distillation"`, and the
// init expression `process.env.MEMORY_ROLE || "agent"` coerces empty-string
// to "agent" via the falsy default. Confirms an attacker setting MEMORY_ROLE=""
// in a wrapper can't slip past the gate.
// ---------------------------------------------------------------------------
{
  process.env.MEMORY_ROLE = "";
  const { executeTool } = await freshDispatch();
  const env = await executeTool(DISTILL_TOOL, {});
  check(
    "case 6 (MEMORY_ROLE='') returns SCOPE_BLOCKED (empty string is not 'distillation')",
    env.error?.code === "SCOPE_BLOCKED",
    `got code=${env.error?.code}`,
  );
}

// Restore env to its original state on the way out — courtesy for in-process
// composition, even though the npm test chain runs each file in a fresh node.
if (__originalRole === undefined) {
  delete process.env.MEMORY_ROLE;
} else {
  process.env.MEMORY_ROLE = __originalRole;
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll memory-role-gate assertions passed.`);
