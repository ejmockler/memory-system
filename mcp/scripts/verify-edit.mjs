// verify-edit.mjs
//
// R33 GAP-7 fix. Workflow Phase B agents may claim edits without performing
// them. verify-edit.mjs is the gate that catches this. Run capture at start
// of phase + verify at end. Plans-disguised-as-edits become structurally
// impossible.
//
// R32 watermark agent reported "applied removals to lines 104, 105, 114,
// 141..." but the file mtime was unchanged from pre-R32. The agent generated
// a report ABOUT edits without executing Edit/Write tool calls. Pure
// narrative. This script is the post-hoc artifact-level check that would
// have caught it.
//
// CLI:
//   verify-edit.mjs capture --files=<csv|@listfile> --output=<manifest.json>
//   verify-edit.mjs verify  --manifest=<manifest.json> [--required-changes=<csv>]
//                                                     [--required-unchanged=<csv>]
//
// Manifest format (JSON):
//   {
//     "schema": "verify-edit/v1",
//     "captured_at": "<ISO timestamp>",
//     "entries": [
//       { "path": "<abs path>", "exists": true,  "size": <bytes>,
//         "mtime_ms": <epoch ms>, "sha256": "<hex>" },
//       { "path": "<abs path>", "exists": false }
//     ]
//   }
//
// Verify exit codes:
//   0 = all required-changes actually changed AND all required-unchanged
//       remained byte-identical
//   1 = at least one required-changes file unchanged, or at least one
//       required-unchanged file mutated, or a structural error (bad
//       manifest, etc.)
//
// Verify always prints a per-file report. Files not on either required list
// are reported as informational and never affect exit code.
//
// Discipline:
//   - No new deps. Node stdlib only.
//   - Writes nothing under <MEMORY_ROOT>/storage/. Manifest goes
//     wherever the caller asks (typically /tmp/claude-501/<session>/).
//   - Treats a vanished file (existed at capture, gone at verify) as a
//     CHANGE. Treats a created file (absent at capture, present at verify)
//     as a CHANGE. Both are legitimate edit outcomes.

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) {
      out[a.slice(2)] = true;
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}

function expandFilesArg(filesArg) {
  if (!filesArg) return [];
  if (filesArg.startsWith("@")) {
    const list = readFileSync(filesArg.slice(1), "utf8");
    return list
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("#"));
  }
  return filesArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function fingerprintFile(absPath) {
  if (!existsSync(absPath)) {
    return { path: absPath, exists: false };
  }
  const st = statSync(absPath);
  if (!st.isFile()) {
    return { path: absPath, exists: false, note: "not a regular file" };
  }
  const buf = readFileSync(absPath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return {
    path: absPath,
    exists: true,
    size: st.size,
    mtime_ms: st.mtimeMs,
    sha256,
  };
}

function capture(args) {
  const files = expandFilesArg(args.files).map((p) => resolve(p));
  if (files.length === 0) {
    console.error("verify-edit capture: --files=<csv|@listfile> required");
    process.exit(1);
  }
  const output = args.output;
  if (!output) {
    console.error("verify-edit capture: --output=<manifest.json> required");
    process.exit(1);
  }
  const entries = files.map(fingerprintFile);
  const manifest = {
    schema: "verify-edit/v1",
    captured_at: new Date().toISOString(),
    entries,
  };
  writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `verify-edit capture: ${entries.length} entries -> ${resolve(output)}`,
  );
  process.exit(0);
}

function changed(before, after) {
  if (before.exists !== after.exists) return true;
  if (!before.exists && !after.exists) return false;
  // Both exist: any of size / mtime_ms / sha256 differs counts as changed.
  // sha256 is the authoritative signal; size + mtime are reported alongside
  // for human-readable diff in the printout.
  return before.sha256 !== after.sha256;
}

function verify(args) {
  const manifestPath = args.manifest;
  if (!manifestPath) {
    console.error("verify-edit verify: --manifest=<manifest.json> required");
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`verify-edit verify: cannot read manifest: ${e.message}`);
    process.exit(1);
  }
  if (!manifest || manifest.schema !== "verify-edit/v1") {
    console.error(
      `verify-edit verify: manifest schema mismatch (got ${manifest?.schema})`,
    );
    process.exit(1);
  }
  const requiredChanges = new Set(
    expandFilesArg(args["required-changes"] || "").map((p) => resolve(p)),
  );
  const requiredUnchanged = new Set(
    expandFilesArg(args["required-unchanged"] || "").map((p) => resolve(p)),
  );

  const findings = [];
  let critical = 0;

  for (const before of manifest.entries) {
    const after = fingerprintFile(before.path);
    const didChange = changed(before, after);
    const inRequired = requiredChanges.has(before.path);
    const inUnchanged = requiredUnchanged.has(before.path);

    let verdict;
    if (inRequired && !didChange) {
      verdict = "CRITICAL: agent claimed to edit but mtime+size+sha256 unchanged";
      critical += 1;
    } else if (inUnchanged && didChange) {
      verdict = "CRITICAL: file required to remain unchanged was mutated";
      critical += 1;
    } else if (didChange) {
      verdict = "CHANGED";
    } else {
      verdict = "unchanged";
    }
    findings.push({ path: before.path, before, after, didChange, verdict });
  }

  // Report
  for (const f of findings) {
    const b = f.before;
    const a = f.after;
    const bDesc = b.exists ? `size=${b.size} sha=${b.sha256.slice(0, 12)}` : "ABSENT";
    const aDesc = a.exists ? `size=${a.size} sha=${a.sha256.slice(0, 12)}` : "ABSENT";
    console.log(`${f.verdict}  ${f.path}`);
    console.log(`         before: ${bDesc}`);
    console.log(`         after:  ${aDesc}`);
  }
  console.log(
    `verify-edit verify: ${findings.length} entries, ${critical} CRITICAL`,
  );

  // Required-changes paths not in manifest at all → also a critical finding.
  const manifestPaths = new Set(manifest.entries.map((e) => e.path));
  for (const req of requiredChanges) {
    if (!manifestPaths.has(req)) {
      console.log(
        `CRITICAL: required-changes path not present in manifest: ${req}`,
      );
      critical += 1;
    }
  }
  for (const req of requiredUnchanged) {
    if (!manifestPaths.has(req)) {
      console.log(
        `CRITICAL: required-unchanged path not present in manifest: ${req}`,
      );
      critical += 1;
    }
  }

  process.exit(critical === 0 ? 0 : 1);
}

const mode = process.argv[2];
const args = parseArgs(process.argv.slice(3));

if (mode === "capture") {
  capture(args);
} else if (mode === "verify") {
  verify(args);
} else {
  console.error("Usage:");
  console.error(
    "  verify-edit.mjs capture --files=<csv|@listfile> --output=<manifest.json>",
  );
  console.error(
    "  verify-edit.mjs verify  --manifest=<manifest.json> [--required-changes=<csv>] [--required-unchanged=<csv>]",
  );
  process.exit(1);
}
