#!/usr/bin/env node
// snapshot-test-protected.mjs — canonical hermeticity-gate snapshot script.
//
// Round-18 brutalist surfaced that external gate-verification (snapshotting
// <MEMORY_ROOT>/policy/ pre+post npm test) produced false-red
// because the running watermark + supervisor daemons legitimately write to
// `policy-events-*.jsonl` and `distillation-state.json` during the test
// window. The C-NEW-2 hermeticity discipline (tests must not touch real
// production paths) IS holding — daemons are the noise source, not tests.
//
// This script defines the canonical hermeticity gate:
//
//   STRICT TEST-PROTECTED files (MUST be byte-identical pre/post npm test):
//     policy/consumed-nonces.jsonl
//     policy/consumed-nonces.lock
//     policy/distillation-signing-key.json
//     indices/<embedding_model_version>/*
//
//   APPEND-ONLY TEST-PROTECTED files (R25+: bytes may GROW pre/post npm test,
//   but the pre-existing prefix MUST be byte-identical and every new row MUST
//   schema-validate. Truncation / out-of-order rewrite / schema-failure on
//   any new row = HARD FAIL.):
//     ledgers/memory.jsonl                  (R25 Phase D backfill ingest)
//     ledgers/recall.jsonl                  (R25 gate-zero: appendRecallEvent
//                                            now writes on every memory_recall)
//
//   DAEMON-WRITABLE files (excluded — daemons write here normally):
//     policy/policy-events-*.jsonl
//     policy/distillation-state.json
//     policy/distillation-state.lock
//
// Why the R25 split:
//   The R25+R26 bundle intentionally turns ledgers/memory.jsonl from a
//   smoke-only ledger (3 rows) into a real-signal ledger (5-15k post-cascade
//   rows). Phase D backfill APPENDS rows during the npm test window. A byte-
//   identical snapshot of memory.jsonl would false-red the gate. But we still
//   need a real invariant — the prefix must be unchanged (no rewrite, no
//   truncation) and every new row must carry a valid schema with
//   features.salience present.
//
// Usage:
//   node <MEMORY_ROOT>/scripts/snapshot-test-protected.mjs > /tmp/before.txt
//   cd <MEMORY_ROOT>/mcp && npm test
//   node <MEMORY_ROOT>/scripts/snapshot-test-protected.mjs > /tmp/after.txt
//   diff /tmp/before.txt /tmp/after.txt   # must be empty
//
//   Or, run as a verifier in one pass against a pre-snapshot file:
//     node scripts/snapshot-test-protected.mjs --verify /tmp/before.txt
//   The verifier exits non-zero on any append-only or strict invariant
//   violation; exit 0 means the gate is green.
//
// Exit 0 always in default (snapshot) mode (this is a snapshot tool, not a
// gate). The --verify mode exits non-zero on violations. CI / verify-agents
// can use either mode.

import {
  statSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Default data root is the checkout this script lives in (same default as
// mcp/lib/config.js, re-derived here because this tool takes no project
// imports); MEMORY_ROOT redirects it.
const ROOT = process.env.MEMORY_ROOT || resolve(fileURLToPath(new URL("..", import.meta.url)));

// Strict files — every byte must be identical pre/post test window.
const STRICT_FILES = [
  join(ROOT, "policy", "consumed-nonces.jsonl"),
  join(ROOT, "policy", "consumed-nonces.lock"),
  join(ROOT, "policy", "distillation-signing-key.json"),
];

// Append-only files — pre-existing prefix must be identical; new rows must
// schema-validate.
const APPEND_ONLY_FILES = [
  join(ROOT, "ledgers", "memory.jsonl"),
  join(ROOT, "ledgers", "recall.jsonl"),
];

const STRICT_DIRS = [
  join(ROOT, "indices"),
];

// ---------- per-row schema validators -------------------------------------
//
// Lightweight structural validators. We deliberately do NOT import
// mcp/lib/validation.js — this script must be runnable as a pure node:*
// stdlib tool with zero project imports (so it can run pre-`npm install`
// or against a corrupt mcp/ tree). The shapes pinned below match the
// authoritative writers:
//   memory.jsonl row -> mcp/lib/tools/distill-promote-fact.js appendFactRow
//   recall.jsonl row -> mcp/lib/recall-log.js appendRecallEvent
//
// On schema drift in the writers, update the validators here.

function validateMemoryRow(row, opts = {}) {
  if (row == null || typeof row !== "object" || Array.isArray(row)) {
    return { ok: false, reason: "not_object" };
  }
  if (typeof row.id !== "string" || !row.id.startsWith("mem_")) {
    return { ok: false, reason: "bad_id" };
  }
  if (typeof row.kind !== "string") {
    return { ok: false, reason: "missing_kind" };
  }
  // memory.jsonl carries both kind:"fact" (the salience-promoted rows) AND
  // kind:"policy" (connector events, revoke entries, salience policy events).
  // Only fact rows require features.salience.
  if (row.kind === "fact") {
    if (typeof row.content !== "string") {
      return { ok: false, reason: "fact_missing_content" };
    }
    if (!Array.isArray(row.source_refs)) {
      return { ok: false, reason: "fact_missing_source_refs" };
    }
    if (row.provenance == null || typeof row.provenance !== "object") {
      return { ok: false, reason: "fact_missing_provenance" };
    }
    if (typeof row.created_at !== "string") {
      return { ok: false, reason: "fact_missing_created_at" };
    }
    // R25 invariant: every NEW fact row carries features.salience.
    // The 3 legacy smoke rows from May 31 (pre-R25) do NOT carry it; the
    // caller passes opts.requireSalience=false for those.
    if (opts.requireSalience !== false) {
      const features = row.features;
      if (features == null || typeof features !== "object") {
        return { ok: false, reason: "fact_missing_features" };
      }
      if (features.salience == null || typeof features.salience !== "object") {
        return { ok: false, reason: "fact_missing_features_salience" };
      }
      const sal = features.salience;
      if (typeof sal.score !== "number" || sal.score < 0 || sal.score > 1) {
        return { ok: false, reason: "salience_bad_score" };
      }
      if (sal.components == null || typeof sal.components !== "object") {
        return { ok: false, reason: "salience_missing_components" };
      }
      if (typeof sal.weights_hash !== "string" || sal.weights_hash.length < 16) {
        return { ok: false, reason: "salience_bad_weights_hash" };
      }
      if (typeof sal.version !== "string") {
        return { ok: false, reason: "salience_missing_version" };
      }
    }
    return { ok: true };
  }
  if (row.kind === "policy") {
    // Policy rows have a minimal structural shape; do not over-constrain.
    if (typeof row.created_at !== "string") {
      return { ok: false, reason: "policy_missing_created_at" };
    }
    return { ok: true };
  }
  // Unknown kind — accept but flag for visibility.
  return { ok: true };
}

function validateRecallRow(row) {
  if (row == null || typeof row !== "object" || Array.isArray(row)) {
    return { ok: false, reason: "not_object" };
  }
  if (typeof row.id !== "string") {
    return { ok: false, reason: "missing_id" };
  }
  if (row.kind !== "recall") {
    return { ok: false, reason: "wrong_kind" };
  }
  if (typeof row.ts !== "string") {
    return { ok: false, reason: "missing_ts" };
  }
  if (row.query == null || typeof row.query !== "object") {
    return { ok: false, reason: "missing_query" };
  }
  if (!Array.isArray(row.surfaced)) {
    return { ok: false, reason: "missing_surfaced" };
  }
  return { ok: true };
}

// ---------- snapshot helpers ----------------------------------------------

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function snapshotStrictFile(path) {
  try {
    const s = statSync(path);
    const body = readFileSync(path);
    return `STRICT ${path} size=${s.size} sha256=${sha256Hex(body)}`;
  } catch (err) {
    if (err.code === "ENOENT") return `STRICT ${path} ABSENT`;
    return `STRICT ${path} ERROR:${err.code}`;
  }
}

function snapshotAppendOnlyFile(path) {
  try {
    const s = statSync(path);
    const body = readFileSync(path);
    // The append-only invariant requires the PREFIX hash; pre/post comparison
    // takes the smaller (pre) size and hashes the prefix of (post).
    return [
      `APPEND_ONLY ${path} size=${s.size} sha256_full=${sha256Hex(body)}`,
      `APPEND_ONLY_PREFIX ${path} prefix_size=${s.size} prefix_sha256=${sha256Hex(body)}`,
    ].join("\n");
  } catch (err) {
    if (err.code === "ENOENT") return `APPEND_ONLY ${path} ABSENT`;
    return `APPEND_ONLY ${path} ERROR:${err.code}`;
  }
}

function walkDir(root, lines) {
  if (!existsSync(root)) {
    lines.push(`STRICT ${root} ABSENT`);
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, lines);
    } else if (entry.isFile()) {
      lines.push(snapshotStrictFile(full));
    }
  }
}

// ---------- --verify mode --------------------------------------------------
//
// In verify mode, we re-snapshot the current state, compare each strict file
// for byte-identity, and for each append-only file:
//   1. Confirm the PRE prefix (from /tmp/before.txt) is a byte-identical
//      prefix of the POST content (no rewrite, no truncation).
//   2. Parse every NEW row (rows after the PRE size) and run schema validators.
//   3. Confirm row-count grew monotonically (size_post >= size_pre).
//
// Returns { ok: bool, violations: string[] }.

function parsePreSnapshot(text) {
  const strict = new Map(); // path -> {size, sha256}
  const appendOnly = new Map(); // path -> {prefix_size, prefix_sha256}
  for (const line of text.split("\n")) {
    if (line.startsWith("STRICT ")) {
      const m = line.match(/^STRICT (\S+) size=(\d+) sha256=([0-9a-f]+)$/);
      if (m) strict.set(m[1], { size: parseInt(m[2], 10), sha256: m[3] });
      // Handle ABSENT
      const absentMatch = line.match(/^STRICT (\S+) ABSENT$/);
      if (absentMatch) strict.set(absentMatch[1], { absent: true });
    } else if (line.startsWith("APPEND_ONLY_PREFIX ")) {
      const m = line.match(/^APPEND_ONLY_PREFIX (\S+) prefix_size=(\d+) prefix_sha256=([0-9a-f]+)$/);
      if (m) appendOnly.set(m[1], { size: parseInt(m[2], 10), sha256: m[3] });
    } else if (line.startsWith("APPEND_ONLY ") && line.endsWith(" ABSENT")) {
      const m = line.match(/^APPEND_ONLY (\S+) ABSENT$/);
      if (m) appendOnly.set(m[1], { absent: true });
    }
  }
  return { strict, appendOnly };
}

function verifyAppendOnlyMemoryRows(path, prePrefixSize) {
  // Parse rows; classify pre-existing rows (offset < prePrefixSize) vs new.
  // For new rows: require salience. For pre-existing legacy rows: do not
  // require salience (allows the 3 May-31 smoke rows + any pre-R25 rows).
  const violations = [];
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, violations: [] };
    return { ok: false, violations: [`${path}: read_error ${err.code}`] };
  }
  // Cursor tracks byte offset within the file so we can compare against
  // prePrefixSize.
  let cursor = 0;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (line.length === 0) {
      // Tail empty after final newline — skip.
      if (isLast) break;
      cursor += 1; // bare \n
      continue;
    }
    const lineStart = cursor;
    cursor += Buffer.byteLength(line, "utf8") + 1; // +1 for \n
    const isNewRow = lineStart >= prePrefixSize;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      violations.push(`${path}:line${i + 1}: json_parse_error ${err.message}`);
      continue;
    }
    const result = validateMemoryRow(row, { requireSalience: isNewRow });
    if (!result.ok) {
      violations.push(`${path}:line${i + 1}: schema_invalid (${result.reason}) [new=${isNewRow}]`);
    }
  }
  return { ok: violations.length === 0, violations };
}

function verifyAppendOnlyRecallRows(path, _prePrefixSize) {
  const violations = [];
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, violations: [] };
    return { ok: false, violations: [`${path}: read_error ${err.code}`] };
  }
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      violations.push(`${path}:line${i + 1}: json_parse_error ${err.message}`);
      continue;
    }
    const result = validateRecallRow(row);
    if (!result.ok) {
      violations.push(`${path}:line${i + 1}: schema_invalid (${result.reason})`);
    }
  }
  return { ok: violations.length === 0, violations };
}

function runVerify(preSnapshotPath) {
  let text;
  try {
    text = readFileSync(preSnapshotPath, "utf8");
  } catch (err) {
    process.stderr.write(`--verify: cannot read pre-snapshot ${preSnapshotPath}: ${err.message}\n`);
    process.exit(2);
  }
  const pre = parsePreSnapshot(text);
  const violations = [];

  // Strict files: every byte identical OR both ABSENT.
  for (const path of STRICT_FILES) {
    const preEntry = pre.strict.get(path);
    if (preEntry == null) {
      // Not in pre-snapshot — accept (new file post-R25 is allowed if
      // pre-snapshot was taken before the file existed).
      continue;
    }
    let curSize = -1;
    let curHash = null;
    let absent = false;
    try {
      const s = statSync(path);
      curSize = s.size;
      curHash = sha256Hex(readFileSync(path));
    } catch (err) {
      if (err.code === "ENOENT") absent = true;
      else violations.push(`STRICT ${path}: read_error ${err.code}`);
    }
    if (preEntry.absent && absent) continue;
    if (preEntry.absent && !absent) {
      violations.push(`STRICT ${path}: appeared after npm test (was ABSENT, now exists)`);
      continue;
    }
    if (!preEntry.absent && absent) {
      violations.push(`STRICT ${path}: vanished after npm test (was present, now ABSENT)`);
      continue;
    }
    if (preEntry.size !== curSize) {
      violations.push(`STRICT ${path}: size changed ${preEntry.size} -> ${curSize}`);
    }
    if (preEntry.sha256 !== curHash) {
      violations.push(`STRICT ${path}: sha256 changed (byte-identical invariant violated)`);
    }
  }

  // Strict dirs: each file inside must be byte-identical.
  for (const dir of STRICT_DIRS) {
    if (!existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const cur = stack.pop();
      let entries;
      try {
        entries = readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(cur, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          const preEntry = pre.strict.get(full);
          if (preEntry == null) continue;
          if (preEntry.absent) {
            violations.push(`STRICT ${full}: appeared after npm test`);
            continue;
          }
          try {
            const s = statSync(full);
            const curHash = sha256Hex(readFileSync(full));
            if (preEntry.size !== s.size) {
              violations.push(`STRICT ${full}: size changed ${preEntry.size} -> ${s.size}`);
            }
            if (preEntry.sha256 !== curHash) {
              violations.push(`STRICT ${full}: sha256 changed`);
            }
          } catch (err) {
            violations.push(`STRICT ${full}: ${err.code || err.message}`);
          }
        }
      }
    }
  }

  // Append-only files: prefix-identical + every row schema-validates.
  for (const path of APPEND_ONLY_FILES) {
    const preEntry = pre.appendOnly.get(path);
    let curSize = -1;
    let absent = false;
    try {
      const s = statSync(path);
      curSize = s.size;
    } catch (err) {
      if (err.code === "ENOENT") absent = true;
      else {
        violations.push(`APPEND_ONLY ${path}: stat_error ${err.code}`);
        continue;
      }
    }

    // ABSENT-handling cases.
    if (preEntry == null && absent) continue;
    if (preEntry == null && !absent) {
      // File appeared after npm test — acceptable for recall.jsonl (R25
      // gate-zero: empty pre, populated post is the WHOLE point). Validate
      // every row.
      const rowResult = path.endsWith("memory.jsonl")
        ? verifyAppendOnlyMemoryRows(path, 0)
        : verifyAppendOnlyRecallRows(path, 0);
      for (const v of rowResult.violations) violations.push(v);
      continue;
    }
    if (preEntry.absent && absent) continue;
    if (preEntry.absent && !absent) {
      // Newly created during npm test — verify every row.
      const rowResult = path.endsWith("memory.jsonl")
        ? verifyAppendOnlyMemoryRows(path, 0)
        : verifyAppendOnlyRecallRows(path, 0);
      for (const v of rowResult.violations) violations.push(v);
      continue;
    }
    if (!preEntry.absent && absent) {
      violations.push(`APPEND_ONLY ${path}: vanished after npm test (was present, now ABSENT)`);
      continue;
    }

    // Both present. Verify prefix-identity.
    if (curSize < preEntry.size) {
      violations.push(`APPEND_ONLY ${path}: truncated (was ${preEntry.size}, now ${curSize})`);
      continue;
    }
    let body;
    try {
      body = readFileSync(path);
    } catch (err) {
      violations.push(`APPEND_ONLY ${path}: read_error ${err.code}`);
      continue;
    }
    const prefix = body.subarray(0, preEntry.size);
    const prefixHash = sha256Hex(prefix);
    if (prefixHash !== preEntry.sha256) {
      violations.push(`APPEND_ONLY ${path}: prefix sha256 changed (rewrite/out-of-order insert detected)`);
      continue;
    }
    // Prefix OK. Validate rows (pre-existing rows allow missing salience;
    // newly appended rows in [preEntry.size, curSize) require salience).
    const rowResult = path.endsWith("memory.jsonl")
      ? verifyAppendOnlyMemoryRows(path, preEntry.size)
      : verifyAppendOnlyRecallRows(path, preEntry.size);
    for (const v of rowResult.violations) violations.push(v);
  }

  if (violations.length > 0) {
    process.stdout.write(`snapshot-test-protected: VIOLATIONS (${violations.length}):\n`);
    for (const v of violations) process.stdout.write(`  ${v}\n`);
    process.exit(1);
  }
  process.stdout.write("snapshot-test-protected: --verify PASS (0 violations)\n");
  process.exit(0);
}

// ---------- main -----------------------------------------------------------

const verifyIdx = process.argv.indexOf("--verify");
if (verifyIdx > 0 && process.argv[verifyIdx + 1]) {
  runVerify(process.argv[verifyIdx + 1]);
} else {
  const lines = [];
  lines.push("# hermeticity-gate snapshot — STRICT (byte-identical) + APPEND_ONLY (prefix-identical) files");
  lines.push("# Daemon-writable files (policy-events-*.jsonl, distillation-state.json) excluded");
  lines.push("# R25+: ledgers/memory.jsonl + ledgers/recall.jsonl are APPEND_ONLY; the pre-existing");
  lines.push("# prefix bytes are unchanged + every row schema-validates. Use --verify <pre> to gate.");
  lines.push("");
  for (const f of STRICT_FILES) lines.push(snapshotStrictFile(f));
  for (const f of APPEND_ONLY_FILES) lines.push(snapshotAppendOnlyFile(f));
  for (const d of STRICT_DIRS) walkDir(d, lines);
  process.stdout.write(lines.join("\n") + "\n");
}
