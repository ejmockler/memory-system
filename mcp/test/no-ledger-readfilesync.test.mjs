// no-ledger-readfilesync.test.mjs — s1-stringcap-guard: static class guard for
// the ERR_STRING_TOO_LONG defect class.
//
// THE DEFECT CLASS (7th bite; the tree's own writeup is at
// mcp/lib/synthesis/reconstruction-emitter.js:371-401).
//   `readFileSync(<ledger>, "utf8")` materialises the whole append-only ledger
//   as ONE V8 string. Measured on this machine 2026-08-12:
//       ledgers/memory.jsonl                       = 3,070,728,120 bytes
//       require('buffer').constants.MAX_STRING_LENGTH =   536,870,888 bytes
//   i.e. 5.72x over the cap, so the read throws ERR_STRING_TOO_LONG on EVERY
//   call. Paired with the canonical bare catch:
//       let raw;
//       try { raw = readFileSync(ledgerPath, "utf8"); } catch { return []; }
//   an UNREADABLE ledger becomes indistinguishable from an EMPTY one.
//
// SANCTIONED REPLACEMENT: streamLedgerLines()
//   mcp/lib/synthesis/_ledger-stream.js:128  (the declaration; :26-40 is only
//   its doc-comment — that line pin, inherited from the node inputs, had
//   drifted and is corrected here).
//
// WHAT THIS FILE IS. Every previous fix in this class was per-call-site. This
// is the mechanical guard that makes a NEW copy fail the suite: a static scan
// of mcp/lib, daemons, mcp/daemon, mcp/scripts and repo-root scripts/ for
// whole-file ledger reads, with a two-tier severity model and an explicit,
// anti-rot-checked allowlist.
//
// WHY A CHAR-LEVEL TOKENIZER AND NOT A LINE REGEX. The house line stripper
// `stripComments()` (exported by mcp/lib/forbidden-legacy-identifiers.js) is line-local
// and cannot see a block comment that began on an earlier line — measured: it
// leaves `readFileSync` fully visible on the block-comment continuation line
// reconstruction-emitter.js:374 (pinned executably in T2). And the obvious
// repair — "does this line contain a block-comment opener" — is worse: the
// line comment at mcp/scripts/replay-stage0.mjs:12
//     // storage/sources/*.jsonl. Two outcomes matter:
// contains a `*` `/` glob inside a LINE comment; a naive tracker flips into
// block-comment mode there and stays blind for the rest of the file. Measured:
// that exact bug hid two real violations further down that file. So comment /
// string classification here is done ONLY by the exported char-level
// tokenizer, and both cases are pinned as live controls (T2, T7).
//
// THE MATCH RULE IS KEYED ON THE RESOLVED TARGET, NEVER ON THE ARGUMENT NAME.
//
// WAVE-5 REFUTATION, RECORDED SO IT CANNOT BE RE-LEARNED. The first version of
// this guard required the first argument's SOURCE TEXT to match
// /ledger|jsonl|memory|recall/i. That censuses identifier SPELLINGS, not data.
// A reviewer resolved every one of the 155 call sites the previous rule's scan
// roots then held back to the file it actually opens, stat'd those files, and
// found two live instances of the exact canonical defect that the spelling rule
// could not express (that 155 is a wave-5 figure, superseded by the census
// below; s7/s9 have since streamed several of those sites):
//   * scripts/backfill-from-sources.mjs:29 and :37 (as they stood at HEAD) —
//     `readFileSync(p, "utf8")` where `const p = memoryLedgerPath()`, i.e.
//     ledgers/memory.jsonl, measured 3,070,728,120 B = 5.72x the
//     536,870,888 B cap. arg0 is spelled `p`.
//   * mcp/lib/tools/distill-promote-fact.js:430-439 (as it stood at HEAD) — a
//     HARD-tier whole-file utf8 read of
//     `join(STORAGE_SOURCES_DIR, `${source}.jsonl`)` followed by
//     `raw.split("\n")` at :452. The largest such source ledger is
//     storage/sources/mail.jsonl at 349,643,964 B. arg0 is spelled `path`.
// Both sites are streamed today (sibling node s9). Re-measured 2026-08-12 with
// this file's own countUtf8ReadSites(): both files now have ZERO code-context
// readFileSync(…, utf8) call sites. The token itself has NOT vanished from
// either file — it survives as prose at scripts/backfill-from-sources.mjs:43
// and mcp/lib/tools/distill-promote-fact.js:436, and those two lines are the
// only remaining occurrences. (An earlier draft here said "both files return no
// readFileSync", which a grep refutes; what was verified is the absence of CALL
// SITES, which is the claim that matters.) Both SHAPES survive here as executable
// regression pins — POSITIVE_FIXTURES resolve-config-helper.js,
// resolve-join-root.js and resolve-param-flow.js — because they are now the
// only record of the defect left in the tree.
//
// So the class is defined by WHICH FILE IS OPENED, and only resolution answers
// that. §2 resolves arg0 backwards through scope-aware `const|let|var`
// bindings, module-local helper RETURN expressions (detected structurally by
// their `join(...)` body, never by their name), mcp/lib/config.js's exported
// path helpers and root consts, and bounded intra-file forward parameter flow;
// the resulting path SHAPE is classified against the measured root table in
// §2.1 (ledgers/ and storage/sources/ and indices/ are IN; policy/ and the
// connector state.json / watermark cursor files are OUT, each with the
// measurement that decided it).
//
// EVERY call is placed in a TOTAL three-way partition — LEDGER hit /
// resolved-non-ledger / UNRESOLVED — and T9 proves the partition is total, so
// a call cannot fall out of all three and pass silently (GOAL Invariant 1:
// absence is never a verdict).
//
// WHAT THE RESOLVER STILL CANNOT SEE. These are DECLARED BLIND SPOTS, printed
// in full on every run with path:line and arg0 text, never summarised away and
// never counted as cleared:
//   * cross-MODULE data flow — a path imported from, or passed in by, another
//     file. Flow analysis here is intra-file by construction.
//   * member expressions (`this.cursorPath`, `spec.path`), destructured
//     fields, computed member access and array indexing.
//   * array-element / for-of iteration flow — a path that reaches the call as
//     the loop variable of `for (const p of SOME_ARRAY)`. The array's elements
//     are never resolved, so such a call stays UNRESOLVED even when the array
//     is a module-level const of literal ledger paths. Not hypothetical: see
//     the worked case below.
//   * dynamic paths built from runtime values the source does not fix.
// Measured on 2026-08-12 across the scan roots: 123 code-context
// `readFileSync(…, utf8)` call sites — 2 resolve to a ledger, 41 resolve to a
// provably non-ledger target, 80 are unresolved. Those three counts are a
// MEASUREMENT, not an invariant; the invariant is that they sum to the total,
// proved on every run by T9 against countUtf8ReadSites' independent
// denominator. A reviewer can diff these three numbers by eye against the
// `census:` line the live run prints.
//
// A WORKED BLIND SPOT — scripts/snapshot-test-protected.mjs:271, :311, :338.
// The live run places all three in the UNRESOLVED bucket, printed under
// `scripts/` in the DECLARED BLIND SPOTS section: UNCLASSIFIED, NOT CLEARED.
// Hand-resolved (the resolver cannot, by the array-element blind spot above):
// :271 is `readFileSync(path, "utf8")` inside verifyAppendOnlyMemoryRows(path,
// prePrefixSize), declared at :264 and reached from
// `for (const path of APPEND_ONLY_FILES)` at :423 (calls at :445, :454, :485),
// where APPEND_ONLY_FILES at :77-80 is
// [join(ROOT,"ledgers","memory.jsonl"), join(ROOT,"ledgers","recall.jsonl")].
// So :271 IS a live whole-file utf8 read of a multi-GB ledger — the class,
// hiding inside a declared blind spot. It is REPORTED as a finding, not fixed
// here (single-file remit) and NOT allowlisted: it is not a hit, and an
// allowlist entry for a non-hit would rightly fail T8b's anti-rot check. It at
// least degrades loudly rather than silently — the catch at :272-275 returns
// `read_error <code>` (:274) instead of conflating unreadable with empty.
//
// TWO PATHS INSIDE THE SCAN ROOTS ARE BYPASSED by the reused house exclusion
// isExcludedPath (exported by mcp/lib/forbidden-legacy-identifiers.js), through
// its EXCLUDED_PATH_SEGMENTS and EXCLUDED_PATH_SUFFIXES lists. Cited by SYMBOL,
// never by line number: this header decayed once already against a file whose
// line numbers move whenever the allowlist grows (F52).
//   * scripts/spec-sweep.mjs, via EXCLUDED_PATH_SUFFIXES. 1 file.
//   * mcp/lib/forbidden-legacy-identifiers.js, via EXCLUDED_PATH_SUFFIXES —
//     a HARD-tier file sitting inside an INCLUDED scan root, so it is named
//     explicitly rather than left implicit. Measured 2026-08-12: the file
//     contains ZERO occurrences of the token `readFileSync` in any context,
//     code or prose, so it contributes nothing to any bucket. That one is
//     genuinely CLEARED.
// The count is TWO and was RE-MEASURED (not re-reasoned) after
// EXCLUDED_PATH_SUFFIXES grew to six entries: enumerating every .js/.mjs/.cjs
// file under SCAN_ROOTS and asking isExcludedPath about each, in the same order
// scanCensus does, yields exactly these two. The sixth suffix
// (mcp/test/embed-callers-migrate.test.mjs) does NOT become a third, because
// scanCensus's `relPath.startsWith("mcp/test/")` guard returns BEFORE
// isExcludedPath is ever consulted — that file is already outside this scan.
// The other one, scripts/spec-sweep.mjs, was re-audited on 2026-08-12 by
// running THIS classifier over it with the exclusion bypassed — a measurement,
// not a grep. Result: 10 code-context readFileSync(…, utf8) call sites. Of
// those ten, 0 resolve to a ledger and 3 resolve to a provably non-ledger target:
//   :1096  STATE_FILE       -> policy/distillation-state.json
//   :1138  OWNERSHIP_DOC    -> kb/agent-integration.md
//   :1251  policyEventsPath -> mcp/lib/policy-events.js — a SOURCE FILE, not a
//          ledger and not a policy JSONL; proved at spec-sweep.mjs:1249,
//          `const policyEventsPath = join(ROOT, "mcp", "lib", "policy-events.js")`.
// The remaining 7 (:241, :599, :712, :1028, :1201, :1271, :1349) are
// UNRESOLVED. 7 of 10 UNRESOLVED, therefore the bypassed file is
// UNCLASSIFIED, NOT CLEARED — the same language, for the same reason, as the
// 80 live blind spots above.
//
// THAT CORRECTION IS ITSELF A RECORDED FAILURE (F32). An earlier version of
// this header claimed, as a measurement, that spec-sweep.mjs:1251 opens one of
// the monthly-rotated policy event logs under policy/. It does not; it opens
// the SOURCE file mcp/lib/policy-events.js, as the line above it spells out.
// The false claim was derived from the
// identifier SPELLING `policyEventsPath` — precisely the wave-5 failure mode
// this file exists to have eliminated, reproduced inside the prose documenting
// its elimination. GOAL Invariant 2/3: a spec is a claim about the code, and
// this header is part of the spec. Every factual sentence here was re-derived
// by running the classifier or by opening the file at the line it cites.
//
// HERMETIC. Reads repo SOURCE files and mkdtempSync fixtures only. It never
// opens ledgers/, never touches indices/, never binds or dials a port, and
// depends on no machine state. Safe under the runner's REQUIRE_HERMETIC=1.
//
// Run: node --test test/no-ledger-readfilesync.test.mjs
//      node test/no-ledger-readfilesync.test.mjs        (runner spawn shape)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  EXCLUDED_PATH_SEGMENTS,
  SCANNED_EXTENSIONS,
  isExcludedPath,
  stripComments,
} from "../lib/forbidden-legacy-identifiers.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const MEMORY_SYSTEM_ROOT = resolve(dirname(THIS_FILE), "..", "..");

// The JS-like subset of the house extension list. SCANNED_EXTENSIONS also
// carries .json/.sh/.md for the forbidden-identifier sweep; a readFileSync
// call site can only live in a JS-like file.
const JS_EXTENSIONS = Object.freeze(
  SCANNED_EXTENSIONS.filter((e) => e === ".js" || e === ".mjs" || e === ".cjs"),
);

// Scan roots, repo-relative. mcp/daemon and repo-root scripts/ are beyond the
// three the node spec named; measured cost is 0 extra hits across 8 extra
// files, and they close the gap where reembed-local-4096.mjs and
// backfill-from-sources.mjs live.
const SCAN_ROOTS = Object.freeze([
  "mcp/lib",
  "daemons",
  "mcp/daemon",
  "mcp/scripts",
  "scripts",
]);

// Tier prefixes. A hit under a HARD prefix can never be allowlisted.
const HARD_TIER_PREFIXES = Object.freeze(["mcp/lib/", "daemons/", "mcp/daemon/"]);
const SCRIPTS_TIER_PREFIXES = Object.freeze(["mcp/scripts/", "scripts/"]);

const FIX_HINT =
  "replace the whole-file read with streamLedgerLines() " +
  "(mcp/lib/synthesis/_ledger-stream.js:128)";

// ===========================================================================
// 1. TOKENIZER — char-level, single pass, no line heuristics.
// ===========================================================================

export const CH_CODE = 0;
export const CH_STRING = 1;
export const CH_COMMENT = 2;

// tokenizeSource - walks `src` one character at a time through the states
//   code | line-comment | block-comment | '…' | "…" | `…` | /…/ regex
// (template literals push/pop a nested code context for `${ … }`), and returns
//
//   text : same LENGTH as src. Comment characters are replaced by a space,
//          newlines are preserved everywhere, so a byte offset into `text`
//          still maps to the same line number as in `src`. String literals are
//          preserved VERBATIM because they are code — the ledger path in
//          `readFileSync("/x/ledgers/memory.jsonl", "utf8")` and the encoding
//          argument both live inside string literals and are load-bearing for
//          the match rule.
//   mask : Uint8Array of CH_CODE / CH_STRING / CH_COMMENT, one per character.
//          `readFileSync` only counts as a call when its own characters are
//          CH_CODE — which is what keeps the pattern-inside-a-string and
//          pattern-inside-a-comment negative controls out of the hit list,
//          while still letting the argument text be read out of `text`.
//
// Paren balancing and argument splitting consult `mask` so that brackets and
// commas inside strings, comments and regex literals are ignored.
export function tokenizeSource(src) {
  const n = src.length;
  const out = new Array(n);
  const mask = new Uint8Array(n);

  const put = (idx, cls) => {
    const ch = src[idx];
    out[idx] = cls === CH_COMMENT && ch !== "\n" ? " " : ch;
    mask[idx] = cls;
  };

  // Context stack. `code` frames count `{` depth so the `}` that closes a
  // template substitution can be told apart from an ordinary block close.
  const stack = [{ kind: "code", brace: 0 }];
  let i = 0;

  // Shebang: whole first line is not JS. Treat as comment.
  if (src[0] === "#" && src[1] === "!") {
    while (i < n && src[i] !== "\n") put(i++, CH_COMMENT);
  }

  // Characters after which a `/` opens a REGEX literal rather than being a
  // division operator. Conservative on purpose: after an identifier, a number,
  // `)` or `]` a slash is division.
  const REGEX_PRECEDERS = new Set([
    "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "~", "<", ">", "\n",
  ]);
  const prevCodeChar = (from) => {
    for (let k = from - 1; k >= 0; k--) {
      if (mask[k] === CH_COMMENT) continue;
      const c = out[k];
      if (c === " " || c === "\t" || c === "\r") continue;
      return c;
    }
    return "\n"; // start of file behaves like a fresh statement
  };

  while (i < n) {
    const ctx = stack[stack.length - 1];
    const c = src[i];

    if (ctx.kind === "template") {
      if (c === "\\") {
        put(i, CH_STRING);
        if (i + 1 < n) put(i + 1, CH_STRING);
        i += 2;
        continue;
      }
      if (c === "`") {
        put(i, CH_STRING);
        stack.pop();
        i += 1;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        put(i, CH_STRING);
        put(i + 1, CH_STRING);
        stack.push({ kind: "code", brace: 0 });
        i += 2;
        continue;
      }
      put(i, CH_STRING);
      i += 1;
      continue;
    }

    // --- code context ------------------------------------------------------
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") put(i++, CH_COMMENT);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      put(i, CH_COMMENT);
      put(i + 1, CH_COMMENT);
      i += 2;
      while (i < n) {
        if (src[i] === "*" && src[i + 1] === "/") {
          put(i, CH_COMMENT);
          put(i + 1, CH_COMMENT);
          i += 2;
          break;
        }
        put(i, CH_COMMENT);
        i += 1;
      }
      continue;
    }
    if (c === "/" && REGEX_PRECEDERS.has(prevCodeChar(i))) {
      // Regex literal: consume to the unescaped closing `/`, honouring `[…]`
      // character classes (a `/` inside a class is literal). Classified as
      // CH_STRING — not code — so `readFileSync(` inside a regex is inert.
      put(i, CH_STRING);
      i += 1;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        const r = src[i];
        if (r === "\\") {
          put(i, CH_STRING);
          if (i + 1 < n) put(i + 1, CH_STRING);
          i += 2;
          continue;
        }
        put(i, CH_STRING);
        i += 1;
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      put(i, CH_STRING);
      i += 1;
      while (i < n) {
        const s = src[i];
        if (s === "\\") {
          put(i, CH_STRING);
          if (i + 1 < n) put(i + 1, CH_STRING);
          i += 2;
          continue;
        }
        if (s === "\n") break; // unterminated literal — resync at the newline
        put(i, CH_STRING);
        i += 1;
        if (s === quote) break;
      }
      continue;
    }
    if (c === "`") {
      put(i, CH_STRING);
      stack.push({ kind: "template" });
      i += 1;
      continue;
    }
    if (c === "{") {
      ctx.brace += 1;
      put(i, CH_CODE);
      i += 1;
      continue;
    }
    if (c === "}") {
      if (ctx.brace === 0 && stack.length > 1) {
        put(i, CH_STRING); // closes a `${ … }` substitution
        stack.pop();
        i += 1;
        continue;
      }
      if (ctx.brace > 0) ctx.brace -= 1;
      put(i, CH_CODE);
      i += 1;
      continue;
    }
    put(i, CH_CODE);
    i += 1;
  }

  for (let k = 0; k < n; k++) {
    if (out[k] === undefined) {
      out[k] = src[k];
      mask[k] = CH_CODE;
    }
  }
  return { text: out.join(""), mask };
}

// codeOnly - the comment-free projection of a source file: same length, same
// line numbering, comments blanked, code and string literals intact.
export function codeOnly(src) {
  return tokenizeSource(src).text;
}

// ===========================================================================
// 2. RESOLVED-TARGET MODEL
//    The class is defined by WHICH FILE IS OPENED, never by what a variable
//    is named. Everything below resolves arg0 back to a path SHAPE and
//    classifies the shape against a measured root table.
// ===========================================================================

// --- 2.1 The measured root table -------------------------------------------
//
// Every root that holds append-only .jsonl files, sized with `ls -la` on
// 2026-08-12 against MAX_STRING_LENGTH = 536,870,888 B.
//
// INCLUDED — append-only, unbounded, two already over the cap:
//   ledgers/          memory.jsonl              3,070,728,120 B  = 5.72x cap
//                     recall.jsonl                 20,900,441 B  = 0.039x
//   storage/sources/  mail.jsonl                  349,643,964 B  = 0.65x cap
//                     codex-cli.jsonl             267,796,057 B  = 0.50x
//                     git-log.jsonl               124,163,682 B  = 0.23x
//                     chat-claude-code.jsonl       30,797,807 B
//                     screentime.jsonl             26,778,888 B
//                     whatsapp.jsonl               21,354,373 B
//                     imessage.jsonl               11,922,731 B
//                     telegram.jsonl                9,769,071 B
//                     github-events.jsonl           5,229,395 B
//   indices/          <model>/vectors.jsonl    10,760,975,145 B  = 20.04x cap
//                     <model>/embeddings-sidecar.jsonl 129,423,401 B = 0.24x
//                     <model>/index-wal.jsonl       9,941,397 B
//   indices/ is IN, and the decision is load-bearing: vectors.jsonl is the
//   single most over-cap file in the tree, and the sidecar grows one row per
//   memory forever. Same class, same failure, same fix.
//
// EXCLUDED — recorded as decisions, with the measurement that decided them,
// so the boundary is never an omission:
//   policy/           damping-log.jsonl               899,721 B = 0.0017x cap;
//                     the policy event logs ROTATE MONTHLY as
//                     policy-events-YYYY-MM.jsonl — four extant, re-measured
//                     2026-08-12: 2026-05 32,964 B, 2026-06 11,875,244 B,
//                     2026-07 36,504,648 B (the largest, 0.068x cap), 2026-08
//                     2,999,330 B; consumed-nonces.jsonl
//                     is 0 B; predicates.jsonl does not exist on disk. Bounded
//                     by construction — this is what makes hard-gates.js:293 a
//                     resolved non-hit rather than a phantom.
//   storage/salience-sidecars/  the directory does not exist on disk (0 files,
//                     0 bytes). Append-only in principle; pinned independently
//                     by mcp/test/scripts-stringcap.test.mjs T6b/T6b2. Excluded
//                     on measurement, re-check if it ever materialises.
//   storage/ (other)  the large files there are *.cache.json single-document
//                     rewrites (conversation-index.cache.json 247,462,416 B),
//                     not append-only line logs. Different class: the .jsonl
//                     extension test below is what keeps them out.
//   connectors/<s>/state.json and storage/watermark-state/<s>.json are single
//                     JSON cursor objects rewritten atomically. NOT ledgers.
//
// A resolved target counts as a ledger iff its basename ends `.jsonl` AND its
// directory lies under an included root.
const INCLUDED_ROOT_MARKERS = Object.freeze([
  "/ledgers/",
  "/storage/sources/",
  "/indices/",
]);

// ROOT-TABLE REFINEMENT, KEYED ON THE FILE — NOT ON THE CALL SITE.
// ledgers/ also holds hand-curated eval artifacts that are NOT written by the
// production append path. Measured 2026-08-12 (bytes / lines):
//   held-out-labels.jsonl              8,375 /  13   0.0000156x cap
//   held-out-label-candidates.jsonl   12,781 /  13
//   contextual-eval-goldset.jsonl    124,794 / 238
//   ranking-eval-goldset.jsonl        42,195 /  41
//   ranking-eval-recall.jsonl        116,983 /  40
// These grow at human/eval-run cadence, not per-message; reaching the
// 536,870,888-byte cap from 8 KB needs 64,000x growth. Flagging them would be
// the cry-wolf failure that gets a guard deleted (measured: it produced a
// spurious HARD hit at mcp/lib/synthesis/phase-transition-gate.js:118, whose
// resolved target is held-out-labels.jsonl).
//
// This is a statement about which FILE is in the class, so it applies to every
// call site that opens it — it is NOT a per-call-site exemption and cannot be
// used as one. A wildcard basename under an included root (`${source}.jsonl`,
// a new connector ledger) is never matched here and stays IN by default, which
// is what keeps the class closed against new copies.
const BOUNDED_ARTIFACTS = Object.freeze([
  "ledgers/held-out-labels.jsonl",
  "ledgers/held-out-label-candidates.jsonl",
  "ledgers/contextual-eval-goldset.jsonl",
  "ledgers/ranking-eval-goldset.jsonl",
  "ledgers/ranking-eval-recall.jsonl",
]);

// The lock that keeps the refinement above from becoming a weakening lever:
// no production append-path ledger may ever be declared bounded. Asserted in
// T5 alongside the HARD-tier allowlist lock.
export const UNBOUNDABLE_TARGETS = Object.freeze([
  "ledgers/memory.jsonl",
  "ledgers/recall.jsonl",
  "storage/sources/",
  "vectors.jsonl",
  "embeddings-sidecar.jsonl",
  "index-wal.jsonl",
]);

// Opaque-but-KNOWN root tokens. `*` means "not resolved"; these mean
// "resolved, and provably not a live ledger root".
const TOK_HOME = "<HOME>";
const TOK_TMP = "<TMP>";
const TOK_SRCDIR = "<SRCDIR>";

const MAX_RESOLVE_DEPTH = 5;
const MAX_FLOW_ROUNDS = 6;

// classifyShape - the whole verdict, over a resolved path shape.
//   LEDGER      the target is an append-only .jsonl under an included root
//   NON_LEDGER  the target resolved, and is provably something else
//   UNRESOLVED  arg0 could not be resolved — a DECLARED BLIND SPOT, printed
//               on every run, never a silent pass
export function classifyShape(shape) {
  if (shape == null || shape === "") return "UNRESOLVED";
  const segs = shape.split("/").filter((s) => s !== "");
  if (segs.length < 2) return "UNRESOLVED"; // bare filename: root unknown
  const base = segs[segs.length - 1];
  if (base === "*") return "UNRESOLVED"; // filename itself is unknown
  const ext = /\.([A-Za-z0-9]+)$/.exec(base);
  if (!ext) return "UNRESOLVED";
  if (ext[1].toLowerCase() !== "jsonl") return "NON_LEDGER";
  const dir = "/" + segs.slice(0, -1).join("/") + "/";
  // A mkdtemp scratch tree is hermetic and bounded by construction, even when
  // it mirrors the production layout (mcp/scripts/r25-startup-smoke.mjs:53-57
  // builds <tmp>/memory-system/ledgers/memory.jsonl).
  if (dir.includes(TOK_TMP)) return "NON_LEDGER";
  for (const b of BOUNDED_ARTIFACTS) if (shape.endsWith("/" + b)) return "NON_LEDGER";
  for (const marker of INCLUDED_ROOT_MARKERS) if (dir.includes(marker)) return "LEDGER";
  if (!dir.includes("*")) return "NON_LEDGER"; // fully known, and not a root we include
  return "UNRESOLVED";
}

// --- 2.2 Expression-shape resolution ---------------------------------------

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const CALL_HEAD_RE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/;

function normalizeShape(s) {
  return s.replace(/\/{2,}/g, "/");
}

function label(s) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 57) + "..." : t;
}

// Depth-aware scans over an expression fragment. The fragment is re-run
// through the same blessed tokenizer so brackets, commas and operators inside
// strings, template literals and regexes are ignored exactly as they are in
// the main pass.
function fragment(expr) {
  const { text, mask } = tokenizeSource(expr);
  return { text, mask };
}

function unwrapParens(expr) {
  let e = expr.trim();
  for (let guard = 0; guard < 8; guard++) {
    if (e.length < 2 || e[0] !== "(" || e[e.length - 1] !== ")") return e;
    const { text, mask } = fragment(e);
    if (matchingParen(text, mask, 0) !== e.length - 1) return e;
    e = e.slice(1, -1).trim();
  }
  return e;
}

// `a || b` and `a ?? b`: the LAST operand is the default, and the default is
// the constant. Measured need: `opts.policy_dir || POLICY_DIR`
// (hard-gates.js:288) and `opts.retroactivePath || retroactiveDropPath(runId)`
// (replay-stage0.mjs:316).
function lastOrOperand(expr) {
  const { text, mask } = fragment(expr);
  let depth = 0;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    if (mask[i] !== CH_CODE) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && (c === "|" || c === "?") && text[i + 1] === c) {
      last = i + 2;
      i += 1;
    }
  }
  return last < 0 ? null : expr.slice(last);
}

// `cond ? a : b` — the ELSE branch is the default. Measured need:
// backfill-seed-row-marker.mjs:102-104, whose else-branch is the literal
// "<root>/ledgers/memory.jsonl".
function ternaryElse(expr) {
  const { text, mask } = fragment(expr);
  let depth = 0;
  let q = -1;
  for (let i = 0; i < text.length; i++) {
    if (mask[i] !== CH_CODE) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && c === "?" && text[i + 1] !== "." && text[i + 1] !== "?") {
      q = i;
      break;
    }
  }
  if (q < 0) return null;
  let d = 0;
  let nested = 0;
  for (let i = q + 1; i < text.length; i++) {
    if (mask[i] !== CH_CODE) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") d += 1;
    else if (c === ")" || c === "]" || c === "}") d -= 1;
    else if (d === 0 && c === "?" && text[i + 1] !== "." && text[i + 1] !== "?") nested += 1;
    else if (d === 0 && c === ":") {
      if (nested === 0) return expr.slice(i + 1);
      nested -= 1;
    }
  }
  return null;
}

// `savePath + ".meta.json"` (mcp/lib/ingest/_hnsw.js:196) — the appended
// literal is what decides the extension even when the prefix is unknown.
function splitTopLevelPlus(expr) {
  const { text, mask } = fragment(expr);
  let depth = 0;
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (mask[i] !== CH_CODE) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && c === "+" && text[i + 1] !== "+" && text[i - 1] !== "+") {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(expr.slice(start));
  return parts;
}

function isWholeStringLiteral(expr) {
  const e = expr.trim();
  if (e.length < 2) return false;
  const q = e[0];
  if (q !== '"' && q !== "'") return false;
  const { mask } = fragment(e);
  for (let i = 0; i < e.length; i++) if (mask[i] !== CH_STRING) return false;
  return e[e.length - 1] === q;
}

function isWholeTemplate(expr) {
  const e = expr.trim();
  if (e.length < 2 || e[0] !== "`" || e[e.length - 1] !== "`") return false;
  const { mask } = fragment(e);
  return mask[0] === CH_STRING && mask[e.length - 1] === CH_STRING;
}

// A template's substitutions are exactly the parts we cannot know statically,
// so each becomes a `*` wildcard segment: `${source}.jsonl` -> `*.jsonl`.
function templateShape(expr) {
  const body = expr.trim().slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "$" && body[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      for (; j < body.length && depth > 0; j++) {
        if (body[j] === "{") depth += 1;
        else if (body[j] === "}") depth -= 1;
      }
      out += "*";
      i = j - 1;
      continue;
    }
    out += body[i];
  }
  return normalizeShape(out);
}

function parseCall(expr) {
  const e = expr.trim();
  const head = CALL_HEAD_RE.exec(e);
  if (!head) return null;
  const openIdx = head[0].length - 1;
  const { text, mask } = fragment(e);
  const closeIdx = matchingParen(text, mask, openIdx);
  if (closeIdx !== e.length - 1) return null; // not a bare call expression
  return { name: head[1], args: splitArgs(text, mask, openIdx, closeIdx) };
}

// resolveShape - expression text -> path shape (or null = unresolved).
//
// DEPTH ACCOUNTING. `depth` counts SEMANTIC hops only — identifier -> binding,
// call -> function return, name -> config.js export. Structural rewrites
// (parens, `||`, `?:`, `+`, join arguments, template substitutions) do not
// consume budget, because each of them strictly shrinks the expression and so
// cannot diverge. Measured need: scripts/backfill-embeddings.mjs:297 resolves
// through sidecarPath -> sidecarPathFor() -> indicesDirFor() -> MEMORY_ROOT,
// which is 4 semantic hops but 9 rewrites; charging for rewrites truncated it
// to UNRESOLVED and hid a live hit. (That chain is unchanged; only the READ's
// line moved — it was :181 when this was measured, and sibling s10 streaming
// the ledger read above it shortened the file. Re-pinned 2026-08-12 against the
// live run, which still prints this exact resolution.)
//
// `chain` accumulates the human-readable resolution steps that get printed
// beside every hit, so no verdict is ever unexplained.
function resolveShape(expr, facts, useIdx, depth, chain) {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const e = unwrapParens(String(expr || ""));
  if (e === "") return null;

  const orTail = lastOrOperand(e);
  if (orTail != null) return resolveShape(orTail, facts, useIdx, depth, chain);

  const elseBranch = ternaryElse(e);
  if (elseBranch != null) return resolveShape(elseBranch, facts, useIdx, depth, chain);

  if (isWholeStringLiteral(e)) return normalizeShape(e.trim().slice(1, -1));
  if (isWholeTemplate(e)) return templateShape(e);

  const plus = splitTopLevelPlus(e);
  if (plus) {
    let acc = "";
    for (const p of plus) {
      const s = resolveShape(p, facts, useIdx, depth, chain);
      acc += s == null ? "*" : s;
    }
    return normalizeShape(acc);
  }

  const call = parseCall(e);
  if (call) return resolveCallShape(call, facts, useIdx, depth, chain);

  if (IDENT_RE.test(e)) return resolveIdentShape(e, facts, useIdx, depth, chain);

  return null; // member expression, index, await, spread, …
}

const JOINERS = new Set(["join", "resolve", "path.join", "path.resolve", "posix.join"]);

function resolveCallShape(call, facts, useIdx, depth, chain) {
  const name = call.name;
  const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;

  if (JOINERS.has(name) || (name.includes(".") && JOINERS.has(bare))) {
    // join()/resolve() arguments are a STRUCTURAL rewrite: each argument is a
    // strict sub-expression, so the recursion cannot diverge and must not be
    // charged. Measured: charging it truncated
    // scripts/backfill-embeddings.mjs:297 (sidecarPath -> sidecarPathFor() ->
    // indicesDirFor() -> MEMORY_ROOT) to UNRESOLVED and hid a live hit on
    // indices/<model>/embeddings-sidecar.jsonl. (:181 when first measured; the
    // read moved up when s10 streamed the ledger read above it.)
    const segs = call.args.map((a) => {
      const s = resolveShape(a, facts, useIdx, depth, chain);
      return s == null ? "*" : s;
    });
    return normalizeShape(segs.join("/"));
  }
  if (bare === "mkdtempSync" || bare === "mkdtemp" || bare === "tmpdir") return TOK_TMP;
  if (bare === "homedir") return TOK_HOME;
  if (bare === "fileURLToPath" || bare === "dirname") return TOK_SRCDIR;

  // Module-local helper: resolve through its RETURN expression. This is the
  // structural detection the change plan calls for — _gitlogLedgerPath()
  // (githubevents.js:313) is recognised by its `join(STORAGE_DIR, "sources",
  // "git-log.jsonl")` body, never by its name.
  const local = facts.functions.get(name);
  if (local) {
    const s = functionReturnShape(local, facts, depth + 1, chain);
    if (s != null) chain.push(`${name}()`);
    return s;
  }

  // Cross-module, but to ONE known module: mcp/lib/config.js is this tree's
  // declared single source of truth for every production path (see its own
  // header). Its exported helpers are resolved structurally by the same code
  // path, once, and only consulted when nothing local shadows the name.
  const cfg = configShapes().functions.get(name);
  if (cfg != null) {
    chain.push(`${name}() [config.js]`);
    return cfg;
  }
  return null;
}

function resolveIdentShape(name, facts, useIdx, depth, chain) {
  // 1. Nearest ENCLOSING binding. A file-global first-wins map over-taints:
  //    measured, it turns mcp/scripts/r25-startup-smoke.mjs's locally shadowed
  //    `const LEDGERS_DIR = join(SCRATCH_ROOT, "ledgers")` into the production
  //    root and flags a hermetic mkdtemp fixture.
  const b = nearestBinding(facts, name, useIdx);
  if (b) {
    const s = resolveShape(b.init, facts, b.declIdx, depth + 1, chain);
    if (s != null) chain.push(`${name} = ${label(b.init)}`);
    return s;
  }
  // 2. A parameter that in-file call-site flow proved ledger-bound.
  const p = boundParamShape(facts, name, useIdx);
  if (p != null) {
    chain.push(`${name} (param, ledger-bound at call site)`);
    return p;
  }
  // 3. A root constant imported from config.js (LEDGERS_DIR, STORAGE_DIR, …).
  const cfg = configShapes().consts.get(name);
  if (cfg != null) {
    chain.push(`${name} [config.js]`);
    return cfg;
  }
  if (name === "__dirname") return TOK_SRCDIR;
  return null;
}

// --- 2.3 Per-file facts: scope-aware bindings, functions, parameter flow ----

function buildFacts(relPath, text, mask) {
  const n = text.length;
  const enclosing = new Int32Array(n).fill(-1);
  const braceMatch = new Map();
  const openStack = [];
  for (let i = 0; i < n; i++) {
    if (mask[i] !== CH_CODE) {
      enclosing[i] = openStack.length ? openStack[openStack.length - 1] : -1;
      continue;
    }
    const c = text[i];
    if (c === "{") {
      enclosing[i] = openStack.length ? openStack[openStack.length - 1] : -1;
      openStack.push(i);
      continue;
    }
    if (c === "}") {
      const o = openStack.pop();
      if (o !== undefined) braceMatch.set(o, i);
      enclosing[i] = openStack.length ? openStack[openStack.length - 1] : -1;
      continue;
    }
    enclosing[i] = openStack.length ? openStack[openStack.length - 1] : -1;
  }
  const scopeEndOf = (open) => (open < 0 ? n : (braceMatch.get(open) ?? n));

  // Bindings: `const|let|var NAME = <init>`, keyed by their enclosing scope.
  const bindings = new Map(); // name -> [{declIdx, scopeOpen, scopeEnd, init}]
  const DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  let d;
  while ((d = DECL_RE.exec(text)) !== null) {
    if (mask[d.index] !== CH_CODE) continue;
    const init = readInitializer(text, mask, d.index + d[0].length);
    if (init == null) continue;
    const scopeOpen = enclosing[d.index];
    const list = bindings.get(d[1]) || [];
    list.push({
      declIdx: d.index,
      scopeOpen,
      scopeEnd: scopeEndOf(scopeOpen),
      init,
    });
    bindings.set(d[1], list);
  }

  // Function declarations, their simple parameter names, and their body range.
  const functions = new Map();
  const FUNC_RE = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let f;
  while ((f = FUNC_RE.exec(text)) !== null) {
    if (mask[f.index] !== CH_CODE) continue;
    const openIdx = f.index + f[0].length - 1;
    const closeIdx = matchingParen(text, mask, openIdx);
    if (closeIdx < 0) continue;
    const rawParams = splitArgs(text, mask, openIdx, closeIdx).map((s) => s.trim());
    const params = rawParams.map((s) => (IDENT_RE.test(s) ? s : null));
    let bodyOpen = -1;
    for (let i = closeIdx + 1; i < n; i++) {
      if (mask[i] !== CH_CODE) continue;
      if (text[i] === " " || text[i] === "\n" || text[i] === "\t" || text[i] === "\r") continue;
      if (text[i] === "{") bodyOpen = i;
      break;
    }
    if (bodyOpen < 0) continue;
    functions.set(f[1], {
      name: f[1],
      declIdx: f.index,
      params,
      bodyStart: bodyOpen,
      bodyEnd: braceMatch.get(bodyOpen) ?? n,
    });
  }

  const facts = {
    relPath,
    text,
    mask,
    bindings,
    functions,
    paramShape: new Map(), // "fn#i" -> shape
  };

  runParameterFlow(facts);
  return facts;
}

// readInitializer - the initializer text of a declaration, ending at the first
// TOP-LEVEL `;` or `,`. Bounded so a malformed file cannot make this quadratic.
function readInitializer(text, mask, from) {
  let depth = 0;
  const cap = Math.min(text.length, from + 4000);
  for (let i = from; i < cap; i++) {
    if (mask[i] !== CH_CODE) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return text.slice(from, i).trim();
      depth -= 1;
    } else if (depth === 0 && (c === ";" || c === ",")) {
      return text.slice(from, i).trim();
    }
  }
  return null;
}

function nearestBinding(facts, name, useIdx) {
  const list = facts.bindings.get(name);
  if (!list) return null;
  let best = null;
  for (const b of list) {
    if (useIdx < b.scopeOpen || useIdx > b.scopeEnd) continue;
    if (b.declIdx > useIdx) continue; // not yet initialised at the use site
    if (best === null || b.scopeOpen > best.scopeOpen || (b.scopeOpen === best.scopeOpen && b.declIdx > best.declIdx)) {
      best = b;
    }
  }
  return best;
}

function enclosingFunctions(facts, useIdx) {
  const out = [];
  for (const fn of facts.functions.values()) {
    if (useIdx > fn.bodyStart && useIdx < fn.bodyEnd) out.push(fn);
  }
  out.sort((a, b) => b.bodyStart - a.bodyStart); // innermost first
  return out;
}

function boundParamShape(facts, name, useIdx) {
  for (const fn of enclosingFunctions(facts, useIdx)) {
    const i = fn.params.indexOf(name);
    if (i < 0) continue;
    const s = facts.paramShape.get(`${fn.name}#${i}`);
    return s == null ? null : s;
  }
  return null;
}

function functionReturnShape(fn, facts, depth, chain) {
  const { text, mask } = facts;
  const RET_RE = /\breturn\b/g;
  RET_RE.lastIndex = fn.bodyStart;
  let r;
  let fallback = null;
  while ((r = RET_RE.exec(text)) !== null) {
    if (r.index >= fn.bodyEnd) break;
    if (mask[r.index] !== CH_CODE) continue;
    const expr = readInitializer(text, mask, r.index + r[0].length);
    if (expr == null || expr === "") continue;
    // `depth` was already charged by the caller for the call -> return hop;
    // reading the return expression is not a second semantic hop.
    const s = resolveShape(expr, facts, r.index, depth, chain);
    if (s == null) continue;
    if (classifyShape(s) === "LEDGER") return s; // a helper that CAN return a ledger does
    if (fallback === null) fallback = s;
  }
  return fallback;
}

// runParameterFlow - intra-file, bounded, scope-aware forward flow. For each
// declared function, find its IN-FILE call sites and, when argument i resolves
// to a ledger, mark parameter i ledger-bound for that body only. No
// cross-file propagation; iterate to a fixed point with a hard round cap.
// LIVE INSTANCE, re-derived 2026-08-12: this is what reaches
// scripts/backfill-embeddings.mjs:297 (`readFileSync(path, "utf8")` inside
// readSidecar(path), declared :293) from its call sites readSidecar(sidecarPath)
// at :424 and :556, where `const sidecarPath = sidecarPathFor(MODEL_VERSION)`
// at :406. The live run prints the verdict as
// `path (param, ledger-bound at call site)`. The instance this comment used to
// cite — readLedger(path) fed by `const ledgerPath = memoryLedgerPath()` in the
// same file — no longer exists: sibling node s10 replaced it with
// streamLedgerLines (now readLedgerFacts at scripts/backfill-embeddings.mjs
// :272-289), so that shape survives only as the synthetic fixture
// resolve-param-flow.js below.
function runParameterFlow(facts) {
  const { text, mask } = facts;
  const callSites = new Map(); // fn name -> [{openIdx, closeIdx}]
  for (const fn of facts.functions.values()) {
    const re = new RegExp(`\\b${fn.name.replace(/[$]/g, "\\$")}\\s*\\(`, "g");
    const sites = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      if (mask[m.index] !== CH_CODE) continue;
      // Skip the declaration itself: `function NAME(`.
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/\bfunction\s*\*?\s*$/.test(before)) continue;
      // Skip member calls `obj.NAME(`.
      if (text[m.index - 1] === ".") continue;
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = matchingParen(text, mask, openIdx);
      if (closeIdx < 0) continue;
      sites.push({ openIdx, closeIdx });
    }
    if (sites.length) callSites.set(fn.name, sites);
  }

  for (let round = 0; round < MAX_FLOW_ROUNDS; round++) {
    let changed = false;
    for (const fn of facts.functions.values()) {
      const sites = callSites.get(fn.name);
      if (!sites) continue;
      for (const site of sites) {
        const args = splitArgs(text, mask, site.openIdx, site.closeIdx);
        for (let i = 0; i < args.length && i < fn.params.length; i++) {
          if (fn.params[i] == null) continue;
          const key = `${fn.name}#${i}`;
          if (facts.paramShape.has(key)) continue;
          const shape = resolveShape(args[i], facts, site.openIdx, 0, []);
          if (shape != null && classifyShape(shape) === "LEDGER") {
            facts.paramShape.set(key, shape);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
}

// --- 2.4 mcp/lib/config.js, resolved once ----------------------------------

let _configShapes = null;
export function configShapes() {
  if (_configShapes) return _configShapes;
  const consts = new Map();
  const functions = new Map();
  try {
    const src = readFileSync(join(MEMORY_SYSTEM_ROOT, "mcp/lib/config.js"), "utf8");
    const { text, mask } = tokenizeSource(src);
    const facts = buildFacts("mcp/lib/config.js", text, mask);
    const EXPORT_CONST_RE = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g;
    let m;
    while ((m = EXPORT_CONST_RE.exec(text)) !== null) {
      if (mask[m.index] !== CH_CODE) continue;
      const init = readInitializer(text, mask, m.index + m[0].length);
      if (init == null) continue;
      const s = resolveShape(init, facts, m.index, 0, []);
      if (s != null) consts.set(m[1], s);
    }
    for (const fn of facts.functions.values()) {
      const s = functionReturnShape(fn, facts, 0, []);
      if (s != null) functions.set(fn.name, s);
    }
  } catch {
    // Leave both maps empty; T0 asserts they are NOT empty, so a silent
    // failure here cannot quietly hollow out the resolver.
  }
  _configShapes = { consts, functions };
  return _configShapes;
}

// ===========================================================================
// 3. MATCH RULE — structural, over the tokenized projection.
// ===========================================================================

const CALL_RE = /\breadFileSync\s*\(/g;
// Explicit utf8 encoding, positional or as an options-object property.
const UTF8_POSITIONAL_RE = /["']utf-?8["']/i;
const UTF8_OPTION_RE = /encoding\s*:\s*["']utf-?8["']/i;
// Corroborating detail only. 720 bare `catch {` blocks live under mcp/lib
// alone (measured: grep -rcE "catch[[:space:]]*\{" mcp/lib), so a catch is
// never a standalone rule — it only raises the severity of an existing hit.
const SWALLOWING_CATCH_RE = /catch\s*(\([^)]*\))?\s*\{[\s\S]{0,240}?\breturn\b/;

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function matchingParen(text, mask, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (mask[i] !== CH_CODE) continue;
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitArgs(text, mask, openIdx, closeIdx) {
  const args = [];
  let depth = 0;
  let start = openIdx + 1;
  for (let i = openIdx + 1; i < closeIdx; i++) {
    if (mask[i] !== CH_CODE) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  args.push(text.slice(start, closeIdx));
  return args;
}

function normalizeCall(s) {
  return s
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+,/g, ",")
    .trim();
}

export function tierFor(relPath) {
  for (const p of HARD_TIER_PREFIXES) if (relPath.startsWith(p)) return "HARD";
  for (const p of SCRIPTS_TIER_PREFIXES) if (relPath.startsWith(p)) return "SCRIPTS";
  return "OTHER";
}

// scanText - the whole classifier, pure. Returns a TOTAL three-way partition
// of every code-context `readFileSync(…, utf8)` call site in the file:
//   { hits, nonLedger, unresolved }
// each element being
//   { relPath, line, call, firstArg, shape, chain, excerpt, tier,
//     swallowingCatch, verdict }
//
// The decision is on the RESOLVED TARGET, never on the arg0 source text.
// arg0 is resolved backwards through scope-aware bindings, module-local
// helpers, config.js path helpers and intra-file parameter flow; the
// resulting path shape is classified against the measured root table in 2.1.
// Paren-balancing (not a line regex) is what handles the multi-line
// readFileSync calls in this tree.
export function scanText(relPath, src) {
  const { text, mask } = tokenizeSource(src);
  const starts = lineStarts(text);
  const srcLines = src.split("\n");
  const textLines = text.split("\n");
  const facts = buildFacts(relPath, text, mask);
  const hits = [];
  const nonLedger = [];
  const unresolved = [];

  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(text)) !== null) {
    const at = m.index;
    if (mask[at] !== CH_CODE) continue; // inside a string / comment / regex
    const openIdx = at + m[0].length - 1;
    const closeIdx = matchingParen(text, mask, openIdx);
    if (closeIdx < 0) continue; // unbalanced — nothing defensible to say

    const args = splitArgs(text, mask, openIdx, closeIdx);
    const firstArg = (args[0] || "").trim();
    const restArgs = args.slice(1).join(",");
    // Buffer reads (no encoding) are a DIFFERENT class — unbounded RSS, not
    // MAX_STRING_LENGTH — and are deliberately out of scope, so they are not
    // part of this partition at all.
    if (!UTF8_POSITIONAL_RE.test(restArgs) && !UTF8_OPTION_RE.test(restArgs)) continue;

    const chain = [];
    const shape = resolveShape(firstArg, facts, at, 0, chain);
    const verdict = classifyShape(shape);

    const line = lineOf(starts, at);
    const window = textLines.slice(line - 1, line + 4).join("\n");
    const rec = {
      relPath,
      line,
      call: normalizeCall(text.slice(at, closeIdx + 1)),
      firstArg: label(firstArg),
      shape,
      chain: [label(firstArg), ...chain, shape == null ? "?" : shape].join(" -> "),
      excerpt: (srcLines[line - 1] || "").trim(),
      tier: tierFor(relPath),
      swallowingCatch: SWALLOWING_CATCH_RE.test(window),
      verdict,
    };
    if (verdict === "LEDGER") hits.push(rec);
    else if (verdict === "NON_LEDGER") nonLedger.push(rec);
    else unresolved.push(rec);
  }
  return { hits, nonLedger, unresolved };
}

// ===========================================================================
// 3. DRIVER
// ===========================================================================

function* walkSources(absRoot) {
  let entries;
  try {
    entries = readdirSync(absRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = join(absRoot, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDED_PATH_SEGMENTS.includes(`/${ent.name}/`)) continue;
      yield* walkSources(abs);
    } else if (ent.isFile()) {
      if (JS_EXTENSIONS.some((e) => ent.name.endsWith(e))) yield abs;
    }
  }
}

const byPathLine = (a, b) =>
  a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1;

// scanCensus - drives scanText over the scan roots and returns the TOTAL
// partition of every code-context `readFileSync(…, utf8)` call site found:
//   { hits, nonLedger, unresolved, total }
// `total` is counted independently of the three buckets so the partition can
// be proved total rather than asserted to be (T9). A call that fell out of
// every bucket would be a silent pass; the assertion makes that mechanical.
//   opts.root  base directory relative paths are reported against
//   opts.roots root-relative subtrees to walk (defaults to SCAN_ROOTS)
export function scanCensus(opts = {}) {
  const root = opts.root || MEMORY_SYSTEM_ROOT;
  const roots = opts.roots || SCAN_ROOTS.map((r) => join(MEMORY_SYSTEM_ROOT, r));
  const hits = [];
  const nonLedger = [];
  const unresolved = [];
  let total = 0;
  for (const absRoot of roots) {
    if (!existsSync(absRoot)) continue;
    for (const abs of walkSources(absRoot)) {
      if (abs === THIS_FILE) continue;
      const relPath = relative(root, abs).split("\\").join("/");
      // mcp/test/** legitimately quotes source patterns in fixtures.
      if (relPath.startsWith("mcp/test/") || relPath.startsWith("test/")) continue;
      if (isExcludedPath(relPath)) continue;
      let src;
      try {
        src = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const part = scanText(relPath, src);
      hits.push(...part.hits);
      nonLedger.push(...part.nonLedger);
      unresolved.push(...part.unresolved);
      total += countUtf8ReadSites(src);
    }
  }
  hits.sort(byPathLine);
  nonLedger.sort(byPathLine);
  unresolved.sort(byPathLine);
  return { hits, nonLedger, unresolved, total };
}

// countUtf8ReadSites - the independent denominator for the totality proof.
// Deliberately does NOT reuse scanText's bookkeeping: it counts code-context
// readFileSync(…, utf8) call sites straight off the tokenizer, so a bug that
// drops a record from all three buckets shows up as an arithmetic mismatch.
export function countUtf8ReadSites(src) {
  const { text, mask } = tokenizeSource(src);
  let n = 0;
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(text)) !== null) {
    if (mask[m.index] !== CH_CODE) continue;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchingParen(text, mask, openIdx);
    if (closeIdx < 0) continue;
    const rest = splitArgs(text, mask, openIdx, closeIdx).slice(1).join(",");
    if (UTF8_POSITIONAL_RE.test(rest) || UTF8_OPTION_RE.test(rest)) n += 1;
  }
  return n;
}

// The gate's view: LEDGER-verdict hits only.
export function scanForLedgerWholeFileReads(opts = {}) {
  return scanCensus(opts).hits;
}

// ===========================================================================
// 4. ALLOWLIST — explicit, one written reason per entry, no silent skips.
// ===========================================================================
//
// SEEDED FROM MEASUREMENT, NOT FROM THE SPEC. The node inputs named eight
// exemptions (replay-stage0 x2, replay-salience, verify-cascade-correctness,
// backfill-seed-row-marker, build-contextual-eval-goldset,
// build-ranking-eval-goldset, r25-startup-smoke). Six of those had already been
// streamed onto streamLedgerLines by sibling node s7 and no longer exist; each
// was re-grepped on 2026-08-12 before being dropped. Copying the stale eight in
// would have manufactured six permanent blanket exemptions for call sites that
// are not there — which is exactly how an allowlist rots into an absolution.
//
// DUAL-KEYED. Every entry is keyed on relPath + the exact normalized call text
// (NOT a bare line number — a one-line edit by a sibling node must not falsely
// RED this gate) AND must be corroborated by a structural fact still present in
// the source. The tree's `// spec-sweep:allow` marker discipline
// (scripts/spec-sweep.mjs, used at mcp/test/hermeticity/r25-no-real-reads.test.mjs:65-68)
// is the model; a literal marker comment could not be used for the
// r25-startup-smoke entry because this node's remit is a single file and it may
// not edit that script. Its corroboration is structural instead, and adding the
// marker is left to that file's owner.
//
// ONE ENTRY RETIRED BY THE RESOLVER, NOT BY A DECISION. The previous version
// carried a PERMANENT entry for mcp/scripts/r25-startup-smoke.mjs:179
// (`readFileSync(SCRATCH_MEMORY, "utf8")`) whose written reason was "descends
// from mkdtempSync at :53-57, a hermetic scratch fixture". The resolved-target
// rule now derives exactly that, structurally: SCRATCH_MEMORY resolves through
// the file's own locally-shadowed LEDGERS_DIR back to mkdtempSync -> <TMP>, and
// classifyShape() clears any target under a mkdtemp root. It is no longer a hit,
// so the entry was DELETED rather than left to rot into a blanket exemption —
// T8b would have failed on it. The exemption is now mechanical and travels with
// the code: point SCRATCH at a real directory and the guard flags it again. The
// shape is pinned two ways so deleting the entry lost nothing — synthetic
// (NEGATIVE_FIXTURES mkdtemp-scratch-ledger.js) and live (T7b).
//
// ONE ENTRY ADDED ON A SIBLING'S ARGUMENT, NOT TO MAKE THE GATE GREEN. The
// second entry (scripts/backfill-embeddings.mjs) was RED and unowned for two
// waves. It is exempted here only because sibling node s10 examined the site
// and argued it kill-not-this-class (FINDINGS F35), and further established
// (F37) that making the script WORK would resurrect a dead Gemini-era index
// publisher. The matcher was NOT narrowed, the root table was NOT touched, and
// indices/ is still an INCLUDED root — the site is still a HIT, still printed
// on every run, still anti-rot checked, and its reason is falsifiable by two
// structural facts in the source (see `corroboration` below). That is the only
// honest shape an exemption may take here.
//
// AN ALLOWLIST IS A RECORD, NOT AN ABSOLUTION.
const ALLOWLIST = Object.freeze([
  Object.freeze({
    relPath: "mcp/scripts/backfill-seed-row-marker.mjs",
    call: 'readFileSync(ledgerPath, "utf8")',
    permanent: false,
    reason:
      "DELIBERATE AND INTERLOCKED. Operator script owned by no node in the current " +
      "work. The read is guarded by a preceding statSync/MAX_STRING_LENGTH refusal " +
      "that process.exit(4)s unless --i-understand-this-rewrites-the-live-ledger is " +
      "passed, and the call site carries its own DELIBERATE/GUARDED/ALLOWLISTED " +
      "comment saying not to convert it. The interlock is cross-pinned by " +
      "mcp/test/scripts-stringcap.test.mjs T6c (guard must precede the read) and " +
      "T6b (ALLOWED_LEDGER_READS) — the two guards must not drift apart. Expected to " +
      "be resolved by streaming onto streamLedgerLines once the seed-row backfill " +
      "is retired; until then this is a RECORD of a known landmine, not an absolution.",
    corroboration: /DELIBERATE, GUARDED, ALLOWLISTED readFileSync/,
    corroborationWhy:
      "cross-checks mcp/test/scripts-stringcap.test.mjs T6c, which asserts the same " +
      "inline comment exists before the call",
  }),
  Object.freeze({
    relPath: "scripts/backfill-embeddings.mjs",
    call: 'readFileSync(path, "utf8")',
    permanent: false,
    reason:
      "UNREACHABLE TODAY, BY MEASUREMENT. Operator script owned by no node in the current " +
      "work. The hit is at :297, inside readSidecar(path) declared at :293; arg0 resolves " +
      "(readSidecar(sidecarPath) at :424 and :556 <- const sidecarPath = " +
      "sidecarPathFor(MODEL_VERSION) at :406 <- sidecarPathFor at :148-150 <- indicesDirFor " +
      "at :145-147) to indices/${MODEL_VERSION}/embeddings-sidecar.jsonl, and MODEL_VERSION " +
      "is pinned at :138 to CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT = \"gemini-embedding-001\" " +
      "(mcp/lib/validation.js:56). indices/ is an INCLUDED root and the sidecar grows one " +
      "row per memory forever, so the CLASSIFICATION is correct and this is a real hit, not " +
      "a phantom. What exempts it is reachability, measured 2026-08-12: the read is guarded " +
      "by `if (!existsSync(path)) return out;` at :296, and " +
      "indices/gemini-embedding-001/embeddings-sidecar.jsonl DOES NOT EXIST. (The DIRECTORY " +
      "does exist — it holds bm25.json, bm25.gen-2.json, hnsw.bin, hnsw.gen-2.bin, " +
      "index-digest-cache.json, index-manifest.json — so the sloppier claim 'the directory " +
      "is absent' would have been false; it is the FILE that is absent.) readSidecar " +
      "therefore returns the empty Map at :296 and :297 never executes. The 129,423,401 B " +
      "embeddings-sidecar.jsonl that DOES exist lives under the live generation " +
      "indices/qwen3-embedding-8b-fp16 (its index-manifest.json: generation 87, " +
      "embedding_model_version qwen3-embedding-8b-fp16, dims 4096, created " +
      "2026-08-12T00:43:35.800Z) and is NOT addressable from this call site, because the " +
      "pin at :138 names the Gemini generation and nothing in this script reads the live " +
      "one. Sibling node s10 examined this site and argued it kill-not-this-class " +
      "(FINDINGS F35), and established (F37) that making the script work would resurrect a " +
      "dead Gemini-era publisher — the script's own header at :176-195 records that step 5 " +
      "calls publishGeneration(MODEL_VERSION, ...) into indices/gemini-embedding-001 and " +
      "that nothing schedules the script. THIS IS A RECORD, NOT AN ABSOLUTION: repoint " +
      "MODEL_VERSION at the live generation, or revive the Gemini publisher so the sidecar " +
      "is written again, and this read becomes live on a file that already stands at 0.24x " +
      "the cap and only grows — it must then move onto streamLedgerLines " +
      "(mcp/lib/synthesis/_ledger-stream.js:128).",
    // Both structural facts the exemption rests on, in source order (:138 then
    // :296), so neither can be removed without voiding the entry.
    corroboration:
      /const MODEL_VERSION = CAPS\.GEMINI_EMBEDDING_MODEL_DEFAULT;[\s\S]*?function readSidecar\(path\) \{[\s\S]*?if \(!existsSync\(path\)\) return out;/,
    corroborationWhy:
      "cross-checks the two facts the exemption is made of: the Gemini model pin at :138, " +
      "which is WHY the resolved target is the absent gemini-embedding-001 sidecar rather " +
      "than the live 129 MB qwen one, and the existsSync early-return at :296, which is WHY " +
      "the read is a no-op. Repoint the pin or drop the guard and the exemption is void",
  }),
]);

function allowlistEntryFor(hit) {
  return ALLOWLIST.find((e) => e.relPath === hit.relPath && e.call === hit.call) || null;
}

// ===========================================================================
// 5. FIXTURES
// ===========================================================================

// Every positive fixture pins ONE dimension of the matcher (encoding spelling,
// options-object form, multi-line call, the tokenizer trap, cross-module
// resolution, parameter flow) — and each one's arg0 RESOLVES to a file under an
// included root, because that resolution IS the rule now. Naming a variable
// `ledgerPath` is not what makes these hits; opening ledgers/memory.jsonl is.
const POSITIVE_FIXTURES = Object.freeze({
  // The canonical shape: whole-file read + a catch that returns a default,
  // which is what makes UNREADABLE indistinguishable from EMPTY.
  "canonical.js": [
    'import { readFileSync } from "node:fs";',
    'const ledgerPath = "/Users/x/memory-system/ledgers/memory.jsonl";',
    "export function loadRows() {",
    "  let raw;",
    "  try {",
    '    raw = readFileSync(ledgerPath, "utf8");',
    "  } catch {",
    "    return [];",
    "  }",
    '  return raw.split("\\n");',
    "}",
  ].join("\n"),

  // Single-quoted, hyphenated encoding spelling.
  "single-quoted.js": [
    'import { readFileSync } from "node:fs";',
    'const LEDGER_PATH = "/Users/x/memory-system/ledgers/recall.jsonl";',
    "export function load() {",
    "  return readFileSync(LEDGER_PATH, 'utf-8');",
    "}",
  ].join("\n"),

  // Options-object encoding form.
  "options-object.js": [
    'import { readFileSync } from "node:fs";',
    'const ledgerPath = "/Users/x/memory-system/ledgers/memory.jsonl";',
    "export function load() {",
    '  return readFileSync(ledgerPath, { encoding: "utf8" });',
    "}",
  ].join("\n"),

  // First argument is a string literal, not an identifier.
  "string-literal.js": [
    'import { readFileSync } from "node:fs";',
    "export function load() {",
    '  return readFileSync("/Users/x/memory-system/ledgers/memory.jsonl", "utf8");',
    "}",
  ].join("\n"),

  // Call split across three lines — only paren-balancing catches this.
  "multiline.js": [
    'import { readFileSync } from "node:fs";',
    'const ledgerPath = "/Users/x/memory-system/ledgers/memory.jsonl";',
    "export function load() {",
    "  return readFileSync(",
    "    ledgerPath,",
    '    "utf8",',
    "  );",
    "}",
  ].join("\n"),

  // THE MEASURED VACUITY TRAP. Line 1 is a LINE comment containing a `*` `/`
  // glob (the real shape at mcp/scripts/replay-stage0.mjs:12). A tracker that
  // asks "does this line contain a block-comment opener" goes blind here and
  // never sees the violation below. Under the resolved-target rule the trap
  // bites TWICE: going blind at line 1 also hides the `const` binding on line
  // 5, so arg0 would degrade to UNRESOLVED even if the call were still seen.
  "trap.js": [
    "// storage/sources/*.jsonl. Two outcomes matter:",
    "//   (1) newly drops",
    "//   (2) newly passes",
    'import { readFileSync } from "node:fs";',
    'const ledgerPath = "/Users/x/memory-system/storage/sources/mail.jsonl";',
    "export function load() {",
    '  return readFileSync(ledgerPath, "utf8");',
    "}",
  ].join("\n"),

  // ---------------------------------------------------------------------
  // THE WAVE-5 REFUTATION, PINNED. These three shapes are the ones that
  // defeated the previous identifier-spelling rule. All three name their
  // argument `p` / `path` — nothing in the arg0 SOURCE TEXT says "ledger" —
  // yet every one of them opens a multi-hundred-MB append-only .jsonl.
  // They are regression pins: both real sites are streamed today (grep
  // readFileSync over scripts/backfill-from-sources.mjs and
  // mcp/lib/tools/distill-promote-fact.js returns nothing), so these
  // fixtures are the ONLY surviving executable record of the defect.
  // ---------------------------------------------------------------------

  // (a) scripts/backfill-from-sources.mjs:29 / :37 as they stood at HEAD.
  //     Opened ledgers/memory.jsonl (3,070,005,046 B = 5.72x the cap).
  //     arg0 is `p`.
  "resolve-config-helper.js": [
    'import { existsSync, readFileSync } from "node:fs";',
    'import { memoryLedgerPath } from "../mcp/lib/config.js";',
    "function memLineCount() {",
    "  const p = memoryLedgerPath();",
    "  if (!existsSync(p)) return 0;",
    '  const buf = readFileSync(p, "utf8");',
    '  return buf.split("\\n").filter((l) => l.length > 0).length;',
    "}",
    "export { memLineCount };",
  ].join("\n"),

  // (b) mcp/lib/tools/distill-promote-fact.js loadSourceRow as it stood at
  //     HEAD. Opened storage/sources/<source>.jsonl — largest is
  //     mail.jsonl at 349,643,964 B. arg0 is `path`; the root is reached
  //     through a module-local const alias of a config.js root export.
  "resolve-join-root.js": [
    'import { existsSync, readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { STORAGE_DIR } from "../mcp/lib/config.js";',
    'const STORAGE_SOURCES_DIR = join(STORAGE_DIR, "sources");',
    "export function loadSourceRow(source, sourceMsgId) {",
    "  const path = join(STORAGE_SOURCES_DIR, `${source}.jsonl`);",
    "  if (!existsSync(path)) return null;",
    '  const raw = readFileSync(path, "utf8");',
    '  return raw.split("\\n").find((l) => l.includes(sourceMsgId));',
    "}",
  ].join("\n"),

  // (c) The general form of both misses. The read is inside a helper whose
  //     parameter is only ledger-bound at the CALL SITE — no amount of staring
  //     at `path` can tell you that. This shape WAS live at
  //     scripts/backfill-embeddings.mjs as readLedger(path) fed by
  //     `const ledgerPath = memoryLedgerPath()`; s10 streamed it on 2026-08-12
  //     (now readLedgerFacts, :272-289), so this fixture is the only remaining
  //     record of it. The parameter-flow path is still exercised live by
  //     readSidecar(path) at :293-297 in that same file.
  "resolve-param-flow.js": [
    'import { existsSync, readFileSync } from "node:fs";',
    'import { memoryLedgerPath } from "../mcp/lib/config.js";',
    "function readLedger(path) {",
    "  if (!existsSync(path)) return [];",
    '  return readFileSync(path, "utf8").split("\\n");',
    "}",
    "export function main() {",
    "  const ledgerPath = memoryLedgerPath();",
    "  return readLedger(ledgerPath);",
    "}",
  ].join("\n"),
});

// Shapes the resolver provably CANNOT decide. They are not hits and they are
// not clearances — they are the declared blind spot, and T9b asserts they land
// in the UNRESOLVED bucket rather than quietly falling out of the partition.
const UNRESOLVED_FIXTURES = Object.freeze({
  // Dotted member-expression first argument. `cfg.recallLedgerPath` may well
  // BE the recall ledger, but nothing in this file proves it: member access is
  // not resolved. Live equivalents: mcp/lib/connectors/index.js:253
  // (`this.cursorPath`), mcp/scripts/verify-gate.mjs:270 (`spec.path`).
  "member-expression.js": [
    'import { readFileSync } from "node:fs";',
    "export function load(cfg) {",
    '  return readFileSync(cfg.recallLedgerPath, "utf8");',
    "}",
  ].join("\n"),

  // Cross-module parameter: the caller lives in another file, so intra-file
  // flow cannot reach it. Live equivalent: mcp/lib/recall/hnsw-index.js:868.
  "cross-module-param.js": [
    'import { readFileSync } from "node:fs";',
    "export function loadFrom(path) {",
    '  return readFileSync(path, "utf8");',
    "}",
  ].join("\n"),
});

const NEGATIVE_FIXTURES = Object.freeze({
  // Non-ledger identifier: a config read is a different, bounded thing.
  "config-read.js": [
    'import { readFileSync } from "node:fs";',
    "export function load(configPath) {",
    '  return JSON.parse(readFileSync(configPath, "utf8"));',
    "}",
  ].join("\n"),

  // No encoding argument returns a Buffer, not a string. Buffers are not
  // subject to MAX_STRING_LENGTH, so this is a DIFFERENT defect class
  // (unbounded RSS) and deliberately out of scope for this guard.
  "buffer-read.js": [
    'import { readFileSync } from "node:fs";',
    "export function load(ledgerPath) {",
    "  return readFileSync(ledgerPath);",
    "}",
  ].join("\n"),

  // JSDoc block-comment continuation line — the shape at
  // reconstruction-emitter.js:374 that defeats stripComments() alone.
  "jsdoc.js": [
    "/** scanLedgerLines — WU-emitter-string-cap-fix.",
    " *",
    " *  INCIDENT HISTORY:",
    ' *    The original body did readFileSync(ledgerPath, "utf8") on the ENTIRE',
    " *    memory.jsonl. It is streamed now.",
    " */",
    "export function scanLedgerLines() {",
    "  return [];",
    "}",
  ].join("\n"),

  // Line comment carrying the pattern.
  "line-comment.js": [
    "export function load() {",
    '  // the old body did readFileSync(ledgerPath, "utf8") — now streamed',
    "  return [];",
    "}",
  ].join("\n"),

  // The pattern inside a string literal and inside a template literal.
  "in-strings.js": [
    "export const DOC =",
    '  "the old body did readFileSync(ledgerPath, \\"utf8\\") on the whole ledger";',
    "export function render(name) {",
    "  return `${name}: readFileSync(ledgerPath, \"utf8\") is banned`;",
    "}",
  ].join("\n"),

  // -----------------------------------------------------------------------
  // THE FOUR MEASURED PHANTOMS. Widening the rule from "what is it named" to
  // "what does it open" is only an improvement if it does not flood: these are
  // the shapes a naive taint pass gets WRONG, each reduced from the live site
  // it was measured at. Their live counterparts are pinned in T7b; these
  // synthetic twins keep the shapes covered even if the live code moves.
  // -----------------------------------------------------------------------

  // connectors/<source>/state.json — a single JSON cursor object rewritten
  // atomically, not a line log. Live: mcp/lib/connectors/index.js:677. A
  // name-blind taint pass taints it because `dir` came from config.js.
  "connector-state.js": [
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { connectorsDir } from "../mcp/lib/config.js";',
    "export function load(source) {",
    "  const dir = connectorsDir();",
    '  const statePath = join(dir, source, "state.json");',
    '  return JSON.parse(readFileSync(statePath, "utf8"));',
    "}",
  ].join("\n"),

  // storage/watermark-state/<source>.json — per-source cursor, atomic
  // write-tmp-and-rename. Live: daemons/watermark.js:785. Sits directly under
  // storage/, which is exactly where a root-prefix rule would over-match.
  "watermark-cursor.js": [
    'import { readFileSync } from "node:fs";',
    'import { watermarkSourceCursorPath } from "../mcp/lib/config.js";',
    "export function readSourceCursor(source) {",
    "  const path = watermarkSourceCursorPath(source);",
    '  return JSON.parse(readFileSync(path, "utf8"));',
    "}",
  ].join("\n"),

  // policy/predicates.jsonl — a .jsonl, so an extension rule flags it; but
  // policy/ is an EXCLUDED root on measurement (largest file 899,721 B =
  // 0.0017x cap, policy-events rotates monthly). Live: hard-gates.js:293.
  // Also pins the `opts.x || CONST` default-operand rewrite.
  "policy-predicates.js": [
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { POLICY_DIR } from "../mcp/lib/config.js";',
    "export function loadActivePredicates(opts = {}) {",
    "  const policyDir = opts.policy_dir || POLICY_DIR;",
    '  const path = join(policyDir, "predicates.jsonl");',
    '  return readFileSync(path, "utf8").split("\\n");',
    "}",
  ].join("\n"),

  // A hermetic mkdtemp scratch tree that MIRRORS the production layout, right
  // down to a locally shadowed `LEDGERS_DIR`. Live: mcp/scripts/r25-startup-
  // smoke.mjs:53-57 + :179. Scope-awareness is what clears it — a file-global
  // first-wins binding map reads the shadowed name as the production root and
  // flags a few-KB fixture as a multi-GB ledger.
  "mkdtemp-scratch-ledger.js": [
    'import { mkdtempSync, readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { tmpdir } from "node:os";',
    'const SCRATCH = mkdtempSync(join(tmpdir(), "r25-smoke-"));',
    'const SCRATCH_ROOT = join(SCRATCH, "memory-system");',
    'const LEDGERS_DIR = join(SCRATCH_ROOT, "ledgers");',
    'const SCRATCH_MEMORY = join(LEDGERS_DIR, "memory.jsonl");',
    "export function body() {",
    '  return readFileSync(SCRATCH_MEMORY, "utf8");',
    "}",
  ].join("\n"),
});

function withFixtures(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "no-ledger-readfilesync-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body + "\n");
    }
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// Counting assert wrapper so the printed `self-test: PASS (N assertions)` line
// is the REAL executed count, not a hand-maintained number that can drift.
let SELF_TEST_ASSERTIONS = 0;
const A = {
  ok(v, m) {
    SELF_TEST_ASSERTIONS += 1;
    assert.ok(v, m);
  },
  equal(a, b, m) {
    SELF_TEST_ASSERTIONS += 1;
    assert.equal(a, b, m);
  },
  deepEqual(a, b, m) {
    SELF_TEST_ASSERTIONS += 1;
    assert.deepEqual(a, b, m);
  },
  match(s, re, m) {
    SELF_TEST_ASSERTIONS += 1;
    assert.match(s, re, m);
  },
};

function readRepoFile(relPath) {
  return readFileSync(join(MEMORY_SYSTEM_ROOT, relPath), "utf8");
}

// ===========================================================================
// T0 — the resolver's foundation is LIVE, not silently hollow.
//
// configShapes() swallows its own errors so a moved/renamed config.js cannot
// crash the suite. That is exactly the failure mode that would make every
// later verdict vacuous: with empty maps, memoryLedgerPath() stops resolving
// and every hit that depends on it silently becomes UNRESOLVED. Measured: with
// config.js unreadable the live hit count drops from 5 to 3 and BOTH HARD-tier
// githubevents.js hits vanish. So the maps are asserted non-empty and the four
// production ledger helpers are asserted to resolve INTO the included roots.
// ===========================================================================
test("T0 config.js path helpers resolve — the resolver is not hollow", () => {
  const { consts, functions } = configShapes();
  A.ok(
    consts.size > 0,
    "configShapes().consts is empty — mcp/lib/config.js did not parse, and every " +
      "resolution that depends on a root const is silently UNRESOLVED",
  );
  A.ok(
    functions.size > 0,
    "configShapes().functions is empty — the path helpers did not parse; the guard " +
      "would go quietly vacuous rather than fail",
  );

  for (const [name, marker] of [
    ["memoryLedgerPath", "/ledgers/memory.jsonl"],
    ["recallLedgerPath", "/ledgers/recall.jsonl"],
    ["sourceLedgerPath", "/storage/sources/"],
    ["chatLedgerPath", "/storage/sources/"],
  ]) {
    const shape = functions.get(name);
    A.ok(
      typeof shape === "string" && shape.includes(marker),
      `config.js ${name}() must resolve to a path containing ${marker}; got ${shape}`,
    );
    A.equal(
      classifyShape(shape),
      "LEDGER",
      `config.js ${name}() resolves to ${shape}, which must classify as a ledger`,
    );
  }
  for (const name of ["LEDGERS_DIR", "STORAGE_DIR"]) {
    A.ok(
      typeof consts.get(name) === "string",
      `config.js must export the root const ${name} for identifier resolution to work`,
    );
  }
});

// ===========================================================================
// T1 — tokenizer unit assertions (the exported classifier, directly).
// ===========================================================================
test("T1 codeOnly: comments blanked, strings preserved, line numbering intact", () => {
  const src = [
    "const a = 1; // readFileSync(ledgerPath, \"utf8\")",
    "/* readFileSync(ledgerPath, \"utf8\")",
    "   still inside the block */",
    'const p = "/x/ledgers/memory.jsonl";',
    "",
  ].join("\n");
  const out = codeOnly(src);

  A.equal(out.length, src.length, "codeOnly must preserve length so offsets map to lines");
  A.equal(
    out.split("\n").length,
    src.split("\n").length,
    "codeOnly must preserve newlines so offsets map to lines",
  );
  A.equal(
    /readFileSync/.test(out),
    false,
    "line and block comments (including the continuation line) must be blanked",
  );
  A.ok(
    out.includes('"/x/ledgers/memory.jsonl"'),
    "string literals are CODE and must survive — the ledger path lives in one",
  );

  // A `/` glob inside a LINE comment must not open block-comment mode.
  const trap = [
    "// storage/sources/*.jsonl. Two outcomes matter:",
    'const x = readFileSync(ledgerPath, "utf8");',
  ].join("\n");
  A.ok(
    codeOnly(trap).includes('readFileSync(ledgerPath, "utf8")'),
    "the `*` `/` glob in a line comment must not blind the tokenizer for the rest of the file",
  );
});

// ===========================================================================
// T2 — why stripComments() alone is insufficient, in executable form.
// ===========================================================================
test("T2 stripComments() alone still exposes readFileSync on a block-comment continuation line", () => {
  const line = readRepoFile("mcp/lib/synthesis/reconstruction-emitter.js").split("\n")[373];
  A.match(
    line,
    /The original body did readFileSync/,
    "reconstruction-emitter.js:374 is still the block-comment continuation line this pins",
  );
  A.ok(
    /readFileSync/.test(stripComments(line, ".js")),
    "the house line stripper is line-local and cannot see a block comment opened earlier — " +
      "this is the measured reason a char-level tokenizer supersedes it here",
  );
  A.equal(
    codeOnly(readRepoFile("mcp/lib/synthesis/reconstruction-emitter.js")).split("\n")[373].trim(),
    "",
    "the tokenizer, unlike stripComments, blanks that line completely",
  );
});

// ===========================================================================
// T3 — POSITIVE CONTROLS. Every synthetic violation shape must be flagged.
// ===========================================================================
test("T3 positive controls: every synthetic violation shape is flagged", () => {
  withFixtures(POSITIVE_FIXTURES, (dir) => {
    const hits = scanForLedgerWholeFileReads({ roots: [dir], root: dir });
    const byFile = new Map(hits.map((h) => [h.relPath, h]));
    for (const rel of Object.keys(POSITIVE_FIXTURES)) {
      A.ok(
        byFile.has(rel),
        `positive control ${rel} was NOT flagged — the scanner is vacuous. Flagged: ` +
          JSON.stringify(hits.map((h) => h.relPath)),
      );
    }
    A.equal(
      byFile.get("canonical.js").swallowingCatch,
      true,
      "the canonical shape must carry the '+ swallowing catch' severity annotation",
    );
    A.equal(
      byFile.get("multiline.js").line,
      4,
      "the multi-line call must be reported at the readFileSync line",
    );
    A.equal(
      byFile.get("trap.js").line,
      7,
      "the trap fixture's violation must be found DESPITE the glob in the line comment at line 1",
    );
    A.equal(
      byFile.get("options-object.js").call,
      'readFileSync(ledgerPath, { encoding: "utf8" })',
      "the options-object form must be captured verbatim",
    );

    // THE VERDICT IS THE RESOLVED FILE. Every positive control must carry a
    // resolution chain ending in a concrete path under an included root — if a
    // hit cannot say WHICH FILE it opens, it is the spelling rule again.
    for (const rel of Object.keys(POSITIVE_FIXTURES)) {
      const h = byFile.get(rel);
      A.equal(
        classifyShape(h.shape),
        "LEDGER",
        `${rel} was flagged but its resolved shape ${h.shape} does not classify as a ledger`,
      );
      A.ok(
        /\.jsonl$/.test(h.shape),
        `${rel} must resolve to a concrete .jsonl target; chain was ${h.chain}`,
      );
    }

    // The three wave-5 refutation shapes specifically: arg0 is spelled `p` /
    // `path` / `path`, so ONLY resolution can reach them.
    A.match(
      byFile.get("resolve-config-helper.js").chain,
      /memoryLedgerPath\(\)/,
      "the backfill-from-sources shape must resolve through config.js memoryLedgerPath()",
    );
    A.match(
      byFile.get("resolve-join-root.js").shape,
      /\/storage\/sources\/\*\.jsonl$/,
      "the distill-promote-fact shape must resolve to storage/sources/<source>.jsonl",
    );
    A.match(
      byFile.get("resolve-param-flow.js").chain,
      /param, ledger-bound at call site/,
      "the param-flow shape must be reached by intra-file forward flow, not by naming",
    );
    for (const rel of ["resolve-config-helper.js", "resolve-join-root.js", "resolve-param-flow.js"]) {
      A.equal(
        /ledger|jsonl|memory|recall/i.test(byFile.get(rel).firstArg),
        false,
        `${rel}'s arg0 (${byFile.get(rel).firstArg}) must NOT be ledger-ish by spelling — ` +
          "that is the whole point of the pin; if it is, the fixture stopped testing the refutation",
      );
    }
  });
});

// ===========================================================================
// T4 — NEGATIVE CONTROLS. None of these may be flagged.
// ===========================================================================
// Which BUCKET each negative control must land in. "not flagged" is not one
// fact but two very different ones, and collapsing them is how a blind spot
// gets mistaken for a clearance:
//   NON_LEDGER  the resolver reached a concrete target and PROVED it is not a
//               ledger — a positive clearance.
//   UNRESOLVED  the resolver could not decide — a DECLARED BLIND SPOT that is
//               printed on every run.
const NEGATIVE_BUCKET = Object.freeze({
  "config-read.js": "UNRESOLVED", // free param, cross-module caller
  "connector-state.js": "NON_LEDGER", // -> connectors/*/state.json
  "watermark-cursor.js": "NON_LEDGER", // -> storage/watermark-state/*.json
  "policy-predicates.js": "NON_LEDGER", // -> policy/predicates.jsonl, excluded root
  "mkdtemp-scratch-ledger.js": "NON_LEDGER", // -> <TMP>/…/ledgers/memory.jsonl
});

test("T4 negative controls: none of the synthetic non-violations is flagged", () => {
  withFixtures(NEGATIVE_FIXTURES, (dir) => {
    const census = scanCensus({ roots: [dir], root: dir });
    A.deepEqual(
      census.hits.map((h) => `${h.relPath}:${h.line}`),
      [],
      "negative controls must produce zero hits",
    );

    // buffer-read.js / jsdoc.js / line-comment.js / in-strings.js contribute NO
    // call site at all (no encoding argument, or not in code context), so they
    // are absent from the partition by construction rather than cleared by it.
    const verdictOf = new Map(
      [...census.hits, ...census.nonLedger, ...census.unresolved].map((r) => [r.relPath, r.verdict]),
    );
    for (const [rel, expected] of Object.entries(NEGATIVE_BUCKET)) {
      A.equal(
        verdictOf.get(rel),
        expected,
        `${rel} must land in the ${expected} bucket — a phantom-shaped read that is ` +
          "merely UNRESOLVED when it could be positively cleared (or vice versa) means the " +
          "resolver is not saying what it actually knows",
      );
    }
  });

  // The declared blind spot, as a control of its own: these MUST be reported
  // as unresolved rather than either flagged or silently cleared.
  withFixtures(UNRESOLVED_FIXTURES, (dir) => {
    const census = scanCensus({ roots: [dir], root: dir });
    A.deepEqual(census.hits, [], "unresolvable shapes must never be flagged as hits");
    A.deepEqual(
      census.unresolved.map((r) => r.relPath).sort(),
      Object.keys(UNRESOLVED_FIXTURES).sort(),
      "every unresolvable shape must be reported in the UNRESOLVED blind-spot bucket, " +
        "not dropped on the floor",
    );
    A.deepEqual(census.nonLedger, [], "an unresolvable shape must never be counted as cleared");
  });

  // Bare catches are corroborating detail ONLY — never a standalone rule.
  withFixtures(
    {
      "just-a-catch.js": [
        "export function load(ledgerPath) {",
        "  try {",
        "    return doSomething(ledgerPath);",
        "  } catch {",
        "    return [];",
        "  }",
        "}",
      ].join("\n"),
    },
    (dir) => {
      A.deepEqual(
        scanForLedgerWholeFileReads({ roots: [dir], root: dir }),
        [],
        "a swallowing catch with no whole-file read must not be a hit on its own",
      );
    },
  );
});

// ===========================================================================
// T5 — tier classification and the anti-weakening lock.
// ===========================================================================
test("T5 tiers: lib/daemon hits are HARD, scripts hits are allowlist-checked", () => {
  const violation = [
    'import { readFileSync } from "node:fs";',
    'const ledgerPath = "/Users/x/memory-system/ledgers/memory.jsonl";',
    'export const rows = readFileSync(ledgerPath, "utf8").split("\\n");',
  ].join("\n");
  withFixtures(
    {
      "mcp/lib/fake.js": violation,
      "daemons/fake.js": violation,
      "mcp/daemon/fake.js": violation,
      "mcp/scripts/fake.mjs": violation,
      "scripts/fake.mjs": violation,
    },
    (dir) => {
      const hits = scanForLedgerWholeFileReads({
        roots: [join(dir, "mcp"), join(dir, "daemons"), join(dir, "scripts")],
        root: dir,
      });
      const tiers = Object.fromEntries(hits.map((h) => [h.relPath, h.tier]));
      A.deepEqual(
        tiers,
        {
          "mcp/lib/fake.js": "HARD",
          "daemons/fake.js": "HARD",
          "mcp/daemon/fake.js": "HARD",
          "mcp/scripts/fake.mjs": "SCRIPTS",
          "scripts/fake.mjs": "SCRIPTS",
        },
        "tier assignment must follow the path prefix, not the file name",
      );
      // END-TO-END non-vacuity of the gate itself: a planted mcp/lib violation
      // is BOTH tiered HARD and un-allowlistable, which is exactly the pair of
      // facts T8 turns into a hard failure. Asserted on fixtures because this
      // node may not plant a file in the repo.
      const planted = hits.filter((h) => h.tier === "HARD");
      A.equal(planted.length, 3, "all three HARD-tier fixtures must be flagged");
      for (const h of planted) {
        A.equal(
          allowlistEntryFor(h),
          null,
          `${h.relPath} is HARD tier and must be un-allowlistable — T8 fails the build on it`,
        );
      }
    },
  );

  // ANTI-WEAKENING LOCK: the allowlist may never reach into the HARD tier.
  for (const e of ALLOWLIST) {
    A.equal(
      tierFor(e.relPath),
      "SCRIPTS",
      `ALLOWLIST entry ${e.relPath} is not in the scripts tier — mcp/lib, daemons and ` +
        "mcp/daemon hits can NEVER be allowlisted, they must be fixed",
    );
  }
  for (const e of ALLOWLIST) {
    A.ok(
      typeof e.reason === "string" && e.reason.length > 40,
      `ALLOWLIST entry ${e.relPath} must carry a written reason`,
    );
  }

  // THE SECOND WEAKENING LEVER, LOCKED. Widening the matcher is only honest if
  // it cannot be paid for by quietly declaring a production ledger "bounded".
  // BOUNDED_ARTIFACTS is a statement about specific FILES, and no production
  // append-path target may ever appear in it.
  for (const b of BOUNDED_ARTIFACTS) {
    for (const u of UNBOUNDABLE_TARGETS) {
      A.equal(
        b.includes(u),
        false,
        `BOUNDED_ARTIFACTS entry "${b}" names the production append-path target "${u}". ` +
          "Declaring a live ledger bounded is the same weakening as allowlisting a HARD-tier " +
          "hit, one indirection further out. Fix the read; do not re-label the file.",
      );
    }
  }
  // …and the classifier must still call each of those a ledger.
  for (const [shape, why] of [
    ["/Users/x/memory-system/ledgers/memory.jsonl", "the multi-GB append-only ledger"],
    ["/Users/x/memory-system/ledgers/recall.jsonl", "the append-only recall audit ledger"],
    ["/Users/x/memory-system/storage/sources/mail.jsonl", "a connector source ledger"],
    ["/Users/x/memory-system/storage/sources/*.jsonl", "a wildcard source ledger"],
    ["/Users/x/memory-system/indices/m/vectors.jsonl", "the multi-GB vectors file"],
    ["/Users/x/memory-system/indices/m/embeddings-sidecar.jsonl", "the embeddings sidecar"],
  ]) {
    A.equal(classifyShape(shape), "LEDGER", `${shape} (${why}) must classify as a ledger`);
  }
  // The excluded roots and the non-ledger shapes, from the same table.
  for (const [shape, why] of [
    ["/Users/x/memory-system/policy/predicates.jsonl", "policy/ is bounded by measurement"],
    ["/Users/x/memory-system/policy/damping-log.jsonl", "policy/ is bounded by measurement"],
    ["/Users/x/memory-system/connectors/mail/state.json", "a single JSON cursor object"],
    ["/Users/x/memory-system/ledgers/held-out-labels.jsonl", "a hand-curated eval artifact"],
    ["<TMP>/memory-system/ledgers/memory.jsonl", "a hermetic mkdtemp scratch tree"],
  ]) {
    A.equal(classifyShape(shape), "NON_LEDGER", `${shape} (${why}) must be positively cleared`);
  }

  process.stdout.write(`self-test: PASS (${SELF_TEST_ASSERTIONS} assertions)\n`);
});

// ===========================================================================
// T6 — LIVE ANTI-VACUITY CONTROL. The measured trap, on the real file.
// ===========================================================================
test("T6 live anti-vacuity: the `*/` glob at replay-stage0.mjs:12 does not blind the tokenizer", () => {
  const src = readRepoFile("mcp/scripts/replay-stage0.mjs");
  assert.match(
    src.split("\n")[11],
    /storage\/sources\/\*\.jsonl/,
    "replay-stage0.mjs:12 is still the line-comment glob this control depends on",
  );
  assert.ok(
    codeOnly(src).includes('readFileSync(path, "utf8")'),
    "codeOnly() over the REAL replay-stage0.mjs must still expose the atomicAppendJsonl " +
      "call at :207 — if it does not, the tokenizer went blind at the line-12 glob and " +
      "every scan of this file below that point is vacuous",
  );
});

// ===========================================================================
// T7 — LIVE NEGATIVE CONTROLS. Eight prose files, anchored by FILE + CONTENT.
// Line pins are deliberately NOT used: the node inputs' pins had already
// drifted (index-cache.js:94 -> :99, tools/recall.js:2398 -> :2407).
// ===========================================================================
const PROSE_FILES = Object.freeze([
  "mcp/lib/synthesis/reconstruction-emitter.js",
  "mcp/lib/synthesis/project-aggregator.js",
  "mcp/lib/synthesis/thread-aggregator.js",
  "mcp/lib/recall/index-cache.js",
  "mcp/lib/synthesis/derivation-graph.js",
  "mcp/lib/synthesis/entity-index.js",
  "mcp/lib/tools/recall.js",
  "mcp/lib/synthesis/_ledger-stream.js",
]);

test("T7 live negative controls: prose about already-fixed reads is never a hit", () => {
  const all = scanForLedgerWholeFileReads();
  for (const rel of PROSE_FILES) {
    const src = readRepoFile(rel);
    // Non-vacuity: each of these must genuinely still contain the pattern, or
    // it is not a control at all.
    assert.ok(
      /readFileSync/.test(src),
      `${rel} no longer mentions readFileSync — this control has gone vacuous, re-pick it`,
    );
    assert.deepEqual(
      all.filter((h) => h.relPath === rel).map((h) => `${h.relPath}:${h.line}  ${h.excerpt}`),
      [],
      `${rel} is prose describing an already-streamed read and must not be flagged`,
    );
  }
});

// ===========================================================================
// T7b — THE FOUR MEASURED PHANTOMS, LIVE.
//
// Widening the rule from "what is arg0 NAMED" to "what file does it OPEN" is
// only an improvement if it does not cry wolf. These four live sites are the
// ones a name-blind taint pass gets wrong — each was measured being falsely
// flagged by an intermediate version of this resolver — plus the mkdtemp
// scratch read whose ALLOWLIST entry the resolver retired. Each is anchored by
// FILE + exact call text (never a line number: those drift), and each must
// resolve to the bucket named, so a regression that turns a positive clearance
// into a mere blind spot fails here too.
// ===========================================================================
const LIVE_PHANTOMS = Object.freeze([
  Object.freeze({
    relPath: "mcp/lib/connectors/index.js",
    call: 'readFileSync(statePath, "utf8")',
    verdict: "NON_LEDGER",
    why: "connectors/<source>/state.json — a single JSON cursor object rewritten atomically",
  }),
  Object.freeze({
    relPath: "daemons/watermark.js",
    call: 'readFileSync(path, "utf8")',
    verdict: "NON_LEDGER",
    why: "storage/watermark-state/<source>.json — per-source cursor, write-tmp-and-rename",
  }),
  Object.freeze({
    relPath: "mcp/lib/recall/hard-gates.js",
    call: 'readFileSync(path, "utf8")',
    verdict: "NON_LEDGER",
    why:
      "policy/predicates.jsonl — a .jsonl, but policy/ is an EXCLUDED root on measurement " +
      "(largest file 899,721 B = 0.0017x cap; predicates.jsonl is not even on disk)",
  }),
  Object.freeze({
    relPath: "mcp/lib/recall/hnsw-index.js",
    call: 'readFileSync(path, "utf8")',
    verdict: "UNRESOLVED",
    why:
      "the legacy monolithic hnsw.bin meta read. `path` is a cross-module parameter, so this " +
      "is an honest BLIND SPOT, not a clearance — and it is NOT flagged. The file guards " +
      "itself with LEGACY_PARSE_MAX_BYTES at :859 rather than relying on this scanner",
  }),
  Object.freeze({
    relPath: "mcp/scripts/r25-startup-smoke.mjs",
    call: 'readFileSync(SCRATCH_MEMORY, "utf8")',
    verdict: "NON_LEDGER",
    why:
      "the mkdtemp scratch ledger that used to need a PERMANENT allowlist entry. The " +
      "resolver now derives the exemption: SCRATCH_MEMORY -> shadowed LEDGERS_DIR -> " +
      "SCRATCH_ROOT -> mkdtempSync -> <TMP>. If this ever stops being NON_LEDGER the " +
      "deleted allowlist entry must come back",
  }),
]);

test("T7b live phantoms: the shapes a name-blind rule over-taints stay unflagged", () => {
  const census = scanCensus();
  const all = [...census.hits, ...census.nonLedger, ...census.unresolved];
  for (const p of LIVE_PHANTOMS) {
    const matches = all.filter((r) => r.relPath === p.relPath && r.call === p.call);
    // Non-vacuity: a pin that no longer matches anything proves nothing.
    assert.equal(
      matches.length,
      1,
      `live phantom control ${p.relPath} ${p.call} matched ${matches.length} call sites ` +
        "(expected exactly 1) — the pin has drifted; re-anchor it, do not delete it",
    );
    assert.equal(
      matches[0].verdict,
      p.verdict,
      `${p.relPath} ${p.call} is ${matches[0].verdict}, expected ${p.verdict} — ${p.why}. ` +
        `Resolution chain: ${matches[0].chain}`,
    );
  }
  // Restated as the property that actually matters, independently of bucket.
  assert.deepEqual(
    census.hits
      .filter((h) => LIVE_PHANTOMS.some((p) => p.relPath === h.relPath && p.call === h.call))
      .map((h) => `${h.relPath}:${h.line}`),
    [],
    "a measured phantom was flagged — the widened rule is now crying wolf, and a guard that " +
      "cries wolf gets deleted",
  );
});

// ===========================================================================
// T8 — THE GATE. Live scan, report, allowlist coverage, anti-rot.
// ===========================================================================
test("T8 live scan: no unlisted whole-file ledger read survives", () => {
  const census = scanCensus();
  const hits = census.hits;

  process.stdout.write(
    `\nno-ledger-readfilesync: live scan of ${SCAN_ROOTS.join(", ")}\n` +
      `  census: ${census.total} code-context readFileSync(…, utf8) call site(s) = ` +
      `${hits.length} ledger hit(s) + ${census.nonLedger.length} resolved non-ledger + ` +
      `${census.unresolved.length} unresolved\n`,
  );
  for (const h of hits) {
    const entry = allowlistEntryFor(h);
    const status = entry ? (entry.permanent ? "ALLOWLISTED (permanent)" : "ALLOWLISTED") : "UNLISTED";
    process.stdout.write(
      `  [${h.tier}] ${h.relPath}:${h.line}  ${h.excerpt}` +
        (h.swallowingCatch ? "  + swallowing catch" : "") +
        `  -> ${status}\n` +
        `        resolved: ${h.chain}\n`,
    );
  }

  // THE DECLARED BLIND SPOT, PRINTED IN FULL ON EVERY RUN — not a count, not a
  // summary, and not omitted when empty. GOAL Invariant 1: absence is never a
  // verdict, so a call this resolver cannot decide must leave the run visible
  // as an open question rather than as a pass.
  process.stdout.write(
    `\n  DECLARED BLIND SPOTS — ${census.unresolved.length} call site(s) whose first argument\n` +
      "  could not be resolved to a concrete file. Cross-MODULE data flow is NOT tracked, and\n" +
      "  neither are member expressions, destructured fields, dynamically built paths, nor\n" +
      "  array-element / for-of iteration flow (a path arriving as the loop variable of\n" +
      "  `for (const p of SOME_ARRAY)` — the array's elements are never resolved, even when it\n" +
      "  is a module-level const of literal ledger paths). These are UNCLASSIFIED, NOT CLEARED:\n" +
      "  any one of them may be opening a ledger. Worked instance in this file's header:\n" +
      "  scripts/snapshot-test-protected.mjs:271 reaches ledgers/memory.jsonl this way.\n",
  );
  for (const root of SCAN_ROOTS) {
    const inRoot = census.unresolved.filter(
      (r) => r.relPath === root || r.relPath.startsWith(root + "/"),
    );
    if (inRoot.length === 0) continue;
    process.stdout.write(`    ${root}/ — ${inRoot.length}\n`);
    for (const r of inRoot) {
      process.stdout.write(`      ${r.relPath}:${r.line}  arg0=${r.firstArg}\n`);
    }
  }
  process.stdout.write("\n");

  // NON-VACUITY of the live scan: if the matcher silently matched nothing, the
  // whole gate would go green for free.
  assert.ok(
    hits.length >= ALLOWLIST.length && hits.length > 0,
    `expected at least ${Math.max(1, ALLOWLIST.length)} live hits (the allowlisted sites); found ` +
      `${hits.length} — the matcher is broken and this gate would pass vacuously`,
  );

  // THE GATE. A hit blocks unless it is a SCRIPTS-tier hit with a dual-keyed
  // ALLOWLIST entry. HARD-tier hits are un-allowlistable by construction, so
  // they always block. Both kinds are reported in ONE failure, each carrying
  // the file it actually opens — the failure text has to be enough to act on
  // without re-running anything.
  const describe = (h) =>
    `[${h.tier}${h.tier === "HARD" ? ", un-allowlistable" : ""}] ${h.relPath}:${h.line}  ` +
    `${h.call}  -> opens ${h.shape}` +
    (h.swallowingCatch ? "  + swallowing catch (unreadable becomes indistinguishable from empty)" : "");

  const blocking = hits.filter((h) => h.tier === "HARD" || !allowlistEntryFor(h));
  assert.deepEqual(
    blocking.map(describe),
    [],
    "whole-file ledger read(s) survive. " +
      FIX_HINT +
      ". HARD-tier hits (mcp/lib, daemons, mcp/daemon) can NEVER be allowlisted — fix them. " +
      "A SCRIPTS-tier hit may instead take a dual-keyed ALLOWLIST entry carrying a written " +
      "reason and a structural corroboration.",
  );

  // Stated separately so the un-allowlistability of the HARD tier is asserted
  // as its own fact and cannot be lost if the combined check above is edited.
  const hard = hits.filter((h) => h.tier === "HARD");
  assert.deepEqual(
    hard.map(describe),
    [],
    "whole-file ledger read(s) under mcp/lib / daemons / mcp/daemon — " + FIX_HINT,
  );
});

test("T8b anti-rot: every ALLOWLIST entry corresponds to EXACTLY ONE live hit", () => {
  const hits = scanForLedgerWholeFileReads();
  for (const e of ALLOWLIST) {
    // EXACTLY one, not `some`. The dual key is relPath + normalized call text,
    // and that text can be generic — `readFileSync(path, "utf8")` is two of the
    // commonest tokens in this tree. Under `some`, a SECOND identical call
    // added to the same file later would inherit this entry's exemption
    // silently, with a written reason that was never about it. Requiring
    // exactly one makes that event a build failure instead of a hole.
    const matches = hits.filter((h) => h.relPath === e.relPath && h.call === e.call);
    assert.equal(
      matches.length,
      1,
      `ALLOWLIST entry ${e.relPath} ${e.call} matches ${matches.length} live hits, expected ` +
        `exactly 1${matches.length > 1 ? ` (lines ${matches.map((h) => h.line).join(", ")})` : ""}. ` +
        "0 = the site was fixed or moved; DELETE the entry or re-verify its reason, because a " +
        "stale allowlist degrades into a blanket exemption. >1 = this entry's dual key is now " +
        "BLANKET-EXEMPTING a call site nobody wrote a reason for: a second identical call added " +
        "to the same file inherits the exemption silently. Give each site its own entry with its " +
        "own reason, or make the key discriminating.",
    );
    assert.match(
      readRepoFile(e.relPath),
      e.corroboration,
      `ALLOWLIST entry ${e.relPath} lost its corroboration (${e.corroborationWhy}) — ` +
        "the exemption is void until it is re-established",
    );
  }
});

// ===========================================================================
// T9 — THE PARTITION IS TOTAL. This is the mechanical form of GOAL Invariant 1.
//
// A three-way partition is only a guarantee if nothing can fall out of all
// three buckets. `census.total` is counted by countUtf8ReadSites(), which walks
// the tokenizer independently of scanText's bookkeeping, so this is a real
// cross-check and not a tautology: any call site the classifier drops on the
// floor — an early `continue`, a thrown-and-swallowed resolution, a bucket that
// stops being appended to — shows up here as arithmetic that does not close.
// Without this, "we found no hits" and "we looked at nothing" print the same.
// ===========================================================================
test("T9 partition totality: every call site lands in exactly one bucket", () => {
  const c = scanCensus();
  const sum = c.hits.length + c.nonLedger.length + c.unresolved.length;

  assert.equal(
    sum,
    c.total,
    `partition is NOT total: ${c.total} code-context readFileSync(…, utf8) call sites were ` +
      `found by the tokenizer but only ${sum} were classified ` +
      `(${c.hits.length} ledger + ${c.nonLedger.length} non-ledger + ${c.unresolved.length} ` +
      "unresolved). The missing call sites are SILENT PASSES — the exact failure this guard " +
      "exists to prevent. Find where they are being dropped; do not adjust the count.",
  );

  // Non-vacuity of the equation itself: with any bucket empty the sum could
  // close by accident. All three are populated, and removing ANY of their
  // contributions must break the equality.
  for (const [name, bucket] of [
    ["hits", c.hits],
    ["nonLedger", c.nonLedger],
    ["unresolved", c.unresolved],
  ]) {
    assert.ok(
      bucket.length > 0,
      `the ${name} bucket is empty, so T9's equation would close even if that bucket were ` +
        "never populated — this assertion has gone vacuous, investigate before relaxing it",
    );
    assert.notEqual(
      sum - bucket.length,
      c.total,
      `dropping the ${name} bucket still satisfies the totality equation — it is not ` +
        "load-bearing and T9 proves nothing",
    );
  }

  // And the same proof on a fixture set with a KNOWN population, so the live
  // numbers are not the only thing standing behind it.
  withFixtures({ ...POSITIVE_FIXTURES, ...NEGATIVE_FIXTURES, ...UNRESOLVED_FIXTURES }, (dir) => {
    const f = scanCensus({ roots: [dir], root: dir });
    assert.equal(
      f.hits.length + f.nonLedger.length + f.unresolved.length,
      f.total,
      "the partition must be total over the fixture corpus too",
    );
    assert.equal(
      f.hits.length,
      Object.keys(POSITIVE_FIXTURES).length,
      "every positive fixture and only the positive fixtures may be a hit",
    );
  });
});
