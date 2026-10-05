#!/usr/bin/env node
// Census candidate factual claims in full-line comments under mcp/lib.
//
// This is an audit, not a truth oracle. It derives its file set from the tree
// and reports the exact predicates it applies. A reviewer still has to decide
// whether each candidate is a factual claim, a rule, or an explanation, and
// whether a test actually falsifies it. Keeping that boundary explicit avoids
// turning a lexical match into a verdict about meaning or enforcement.

import { readdirSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_LIB_ROOT = resolve(SCRIPT_DIR, "../lib");
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

// Hyphenated compounds such as "read-only" and "test-only" are excluded:
// they name a mode, not an exclusive or universal proposition by themselves.
export const ABSOLUTE_RE = /(?<![\p{L}\p{N}_-])(only|never|always|nowhere|every)(?![\p{L}\p{N}_-])/iu;

// A hard empirical number needs a corpus noun. Percentages and ratios qualify
// directly; bare counts also need a measurement marker. The marker requirement
// is the rule used to distinguish measured counts from configured limits.
const RATE_OR_RATIO_RE = /(?:~?\d[\d,.]*\s*%|(?<!:)\b\d[\d,]*\s*\/\s*\d[\d,]*\b)/u;
const COUNT_RE = /(?<![\p{L}\p{N}_:.-])\d[\d,]*(?:\.\d+)?(?![\p{L}\p{N}_-])/u;
const MEASUREMENT_MARKER_RE = /\b(?:measur(?:e|ed|ement)|snapshot|population|corpus|ledger|real store|on-disk|observed|census|sample)\b/iu;
const CORPUS_NOUN_RE = /\b(?:corpus|population|ledger|rows?|messages?|facts?|threads?|blobs?|files?|directories|commits?|calls?|recalls?|partners?|coverage|rate|resolved|unresolved|miss(?:es)?|duplicates?|errors?|latency|rss|bytes?)\b/iu;
export const HARD_EMPIRICAL_NUMBER_RE = {
  test(text) {
    const numberShape =
      RATE_OR_RATIO_RE.test(text) ||
      (COUNT_RE.test(text) && MEASUREMENT_MARKER_RE.test(text));
    return numberShape && CORPUS_NOUN_RE.test(text);
  },
};

function walkSourceFiles(root) {
  const out = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) out.push(path);
    }
  }
  return out.sort();
}

function cleanCommentLine(line) {
  const match = line.match(/^\s*(?:\/\/|\/\*+|\*\/|\*)\s?(.*)$/u);
  return match ? match[1].replace(/\s*\*\/\s*$/u, "") : null;
}

export function fullLineCommentParagraphs(source, file) {
  const paragraphs = [];
  let lines = [];
  let startLine = null;

  const flush = () => {
    if (lines.length === 0) return;
    const text = lines.join(" ").replace(/\s+/gu, " ").trim();
    if (text) paragraphs.push({ file, line: startLine, text });
    lines = [];
    startLine = null;
  };

  const sourceLines = source.split("\n");
  for (let i = 0; i < sourceLines.length; i += 1) {
    const cleaned = cleanCommentLine(sourceLines[i]);
    if (cleaned === null) {
      flush();
      continue;
    }
    if (cleaned.trim() === "" || /^[-=]{3,}$/u.test(cleaned.trim())) {
      flush();
      continue;
    }
    if (startLine === null) startLine = i + 1;
    lines.push(cleaned.trim());
  }
  flush();
  return paragraphs;
}

export function hardEmpiricalNumberCandidates(source, file = "<source>") {
  return fullLineCommentParagraphs(source, file).filter((paragraph) =>
    HARD_EMPIRICAL_NUMBER_RE.test(paragraph.text)
  );
}

// Convention: a selected empirical source comment is headed RUNTIME-CENSUS,
// names the runnable producer, and contains no captured result. The producer's
// output is the dated evidence; the source comment keeps the interpretation.
const RUNTIME_CENSUS_MARKER_RE = /\bRUNTIME-CENSUS\b/u;
const RUNNABLE_PRODUCER_RE = /\bmcp\/(?:scripts|test)\/[\w./-]+\.mjs\b/u;

export function runtimeCensusConvention(source, file = "<source>") {
  const paragraphs = fullLineCommentParagraphs(source, file).filter((paragraph) =>
    RUNTIME_CENSUS_MARKER_RE.test(paragraph.text)
  );
  const violations = paragraphs
    .map((paragraph) => ({
      ...paragraph,
      has_runnable_producer: RUNNABLE_PRODUCER_RE.test(paragraph.text),
      has_captured_result: HARD_EMPIRICAL_NUMBER_RE.test(paragraph.text),
    }))
    .filter((paragraph) =>
      !paragraph.has_runnable_producer || paragraph.has_captured_result
    );
  return { paragraphs, violations };
}

export function census(libRoot = DEFAULT_LIB_ROOT) {
  const root = resolve(libRoot);
  const files = walkSourceFiles(root);
  const paragraphs = [];
  for (const path of files) {
    const file = relative(root, path).split("\\").join("/");
    paragraphs.push(...fullLineCommentParagraphs(readFileSync(path, "utf8"), file));
  }

  const candidates = paragraphs
    .map((paragraph) => {
      const absolute = ABSOLUTE_RE.test(paragraph.text);
      const hard_number = HARD_EMPIRICAL_NUMBER_RE.test(paragraph.text);
      return { ...paragraph, shapes: { absolute, hard_number } };
    })
    .filter((paragraph) => paragraph.shapes.absolute || paragraph.shapes.hard_number);

  return {
    scope: {
      kind: "CORPUS",
      root,
      extensions: [...SOURCE_EXTENSIONS],
      unit: "maximal contiguous full-line comment paragraph, split by blank comment lines, separators, or code",
      absolute_predicate: ABSOLUTE_RE.source,
      hard_number_predicate: `(${RATE_OR_RATIO_RE.source} OR (${COUNT_RE.source} AND ${MEASUREMENT_MARKER_RE.source})) AND ${CORPUS_NOUN_RE.source}`,
    },
    files_scanned: files.length,
    comment_paragraphs: paragraphs.length,
    candidate_paragraphs: candidates.length,
    absolute_candidates: candidates.filter((p) => p.shapes.absolute).length,
    hard_number_candidates: candidates.filter((p) => p.shapes.hard_number).length,
    overlap_candidates: candidates.filter((p) => p.shapes.absolute && p.shapes.hard_number).length,
    candidates,
  };
}

function parseArgs(argv) {
  let libRoot = DEFAULT_LIB_ROOT;
  let summaryOnly = false;
  for (const arg of argv) {
    if (arg === "--summary") summaryOnly = true;
    else if (arg.startsWith("--lib=")) libRoot = arg.slice("--lib=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { libRoot, summaryOnly };
}

function invokedDirectly() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    const { libRoot, summaryOnly } = parseArgs(process.argv.slice(2));
    const result = census(libRoot);
    if (summaryOnly) delete result.candidates;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
