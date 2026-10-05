// gazetteer.js — closed-set entity recognizer (WORKUNIT A-promote-projection).
//
// PROBLEM the gazetteer closes:
//   The v0 structural entity-extractor (entity-extractor.js) is precision-first
//   over STRUCTURE only: URLs, emails, GitHub repo paths, phone numbers, file
//   paths, hashtags. It cannot recognize a KNOWN NAMED ENTITY mentioned in
//   free prose — e.g. a fact that says "talked to Alex Example about the
//   Fernwick run" extracts ZERO entities even when a host has listed both
//   "Alex Example" (a placeholder contact) and "Fernwick" (a project) as
//   known surfaces. The recall-time entity-overlap soft feature therefore
//   sees no signal for the exact predicate ("conversations with Alex
//   Example") the row was promoted for.
//
// WHAT THIS MODULE DOES:
//   A closed-set ("gazetteer") recognizer. Given a SEED of known
//   {surface, kind} entries (canonical entity surfaces from the existing
//   vocabulary + conversation / contact labels), it scans free text for
//   case-insensitive WHOLE-WORD matches and emits Entity rows shaped exactly
//   like the structural extractor's output, but with evidence='kb_lookup'
//   (the schema's evidence kind for closed-set / dictionary lookups). The
//   canonical_id is formed by the SAME buildCanonicalId substrate helper the
//   structural extractor uses, so a gazetteer hit and a structural hit on the
//   same surface collapse to one canonical_id at the merge step.
//
// DESIGN DISCIPLINE (mirrors entity-extractor.js):
//   - PURE / SYNCHRONOUS MATCHER: the matcher does no I/O and uses no
//     Date.now, Math.random or network, so it is safe to call from inside the
//     durability-critical appendFactRow. The only I/O in the module happens
//     once, at module load: one synchronous, optional read of
//     <MEMORY_ROOT>/config/gazetteer-seed.json (see loadGazetteerSeed).
//   - PRECISION-FIRST: whole-word boundary match only; a seed surface shorter
//     than MIN_ENTITY_LENGTH or that slugifies to the empty sentinel is
//     dropped at seed-compile time so it can never poison the predicate index.
//   - CLOSED SET: a surface must be EXPLICITLY in the seed to match. There is
//     no fuzzy / substring / stemming pass at v0 (false-conflate poisons the
//     predicate index permanently — foundation spec §1).
//   - SOURCE-SCOPE GATED: the seed is compiled against a single source scope
//     (the row's source). Surfaces whose scope is not in ENTITY_SOURCE_SCOPES
//     are dropped at compile time (buildCanonicalId would otherwise throw).
//
// The seed is supplied by the caller. When the caller passes none, the matcher
// falls back to DEFAULT_GAZETTEER_SEED, which is resolved ONCE at module load:
// a per-host config file when one exists, otherwise a small synthetic default
// (see "Default seed" below). That one synchronous config read is the only
// I/O in this module; the matcher itself is seed-agnostic and pure.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_ROOT } from "../config.js";
import {
  buildCanonicalId,
  slugify,
  SLUG_EMPTY_SENTINEL,
  ENTITY_KINDS,
  ENTITY_SOURCE_SCOPES,
  ENTITY_EXTRACTOR_VERSION,
  MIN_ENTITY_LENGTH,
} from "./entity-extractor.js";

/** Gazetteer pass version. Bump on matcher-logic changes; the seed snapshot
 *  is versioned separately via the seed's own provenance. */
export const GAZETTEER_VERSION = "gaz-v0.1.0";

// ---------------------------------------------------------------------------
// Default seed — a SMALL, auditable closed set of surfaces.
//
// This is intentionally minimal: the strong seed is the daemon-supplied one
// built from the entity index + recovered contact labels. The default gives
// the manual MCP path (which has no daemon-built seed in scope) a non-empty
// starting vocabulary. Surfaces are matched WHOLE-WORD + case-insensitive.
//
// WHERE THE DEFAULT COMES FROM:
//   1. <MEMORY_ROOT>/config/gazetteer-seed.json, when that file exists. It
//      must hold a non-empty JSON array of {surface, kind} objects: `surface`
//      a non-empty string, `kind` one of ENTITY_KINDS. A valid file REPLACES
//      the built-in list entirely (no merge), so a host lists exactly the
//      project / org / topic / artifact names it wants recognised. A file
//      that is present but unreadable or malformed is a loud load-time error
//      naming the file — it never degrades silently to the built-in list.
//   2. Otherwise the built-in list below. It ships with the code and carries
//      no host's vocabulary: placeholder names that exist to exercise each kind and each matcher shape —
//      single word, hyphen + digit, two words.
//
// Kinds use the closed ENTITY_KINDS enum. Scope assignment is deferred to
// compile time (the caller passes the row's source scope); a seed entry that
// cannot form a canonical_id under that scope is silently dropped.
// ---------------------------------------------------------------------------
const BUILT_IN_GAZETTEER_SEED = Object.freeze([
  // Projects / systems (topic | project).
  { surface: "Fernwick", kind: "project" },
  { surface: "FW-3", kind: "project" },
  { surface: "Ledger", kind: "project" },
  { surface: "Larkmoor", kind: "project" },
  { surface: "Deck7", kind: "project" },
  { surface: "Harbor Collective", kind: "org" },
  // Topics / artifacts.
  { surface: "tidepooling", kind: "topic" },
  { surface: "NimbusBar", kind: "artifact" },
  { surface: "EchoRouter", kind: "artifact" },
].map((entry) => Object.freeze(entry)));

/** Per-host seed override, resolved once at module load. */
export const GAZETTEER_SEED_FILE = join(MEMORY_ROOT, "config", "gazetteer-seed.json");

/**
 * Resolve the default seed: one synchronous read of `file`.
 *
 *   - file absent (ENOENT)            → the built-in list, silently.
 *   - file present and valid          → its entries, frozen; REPLACES the
 *                                       built-in list.
 *   - any other read error, invalid JSON, a non-array, an empty array, or an
 *     entry that is not {surface: non-empty string, kind: ENTITY_KIND}
 *                                     → throws an Error naming `file`.
 *
 * @param {string} [file]
 * @returns {ReadonlyArray<{surface:string, kind:string}>}
 */
export function loadGazetteerSeed(file = GAZETTEER_SEED_FILE) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return BUILT_IN_GAZETTEER_SEED;
    throw new Error(
      `[gazetteer] cannot read gazetteer seed file ${file}: ` +
        `${err && err.message ? err.message : err}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `[gazetteer] gazetteer seed file ${file} is not valid JSON: ` +
        `${err && err.message ? err.message : err}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `[gazetteer] gazetteer seed file ${file} must hold a non-empty JSON array ` +
        `of {surface, kind} entries`,
    );
  }
  const seed = parsed.map((entry, i) => {
    const ok =
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof entry.surface === "string" &&
      entry.surface.trim().length > 0 &&
      ENTITY_KINDS.includes(entry.kind);
    if (!ok) {
      throw new Error(
        `[gazetteer] gazetteer seed file ${file}: entry ${i} must be ` +
          `{surface: non-empty string, kind: one of ${ENTITY_KINDS.join("|")}}`,
      );
    }
    return Object.freeze({ surface: entry.surface, kind: entry.kind });
  });
  return Object.freeze(seed);
}

export const DEFAULT_GAZETTEER_SEED = loadGazetteerSeed();

// ---------------------------------------------------------------------------
// Seed compilation
// ---------------------------------------------------------------------------

/**
 * Compile a raw seed array into a matcher-ready, source-scoped index.
 *
 * Each raw seed entry is {surface: string, kind: ENTITY_KIND}. The compile
 * step:
 *   - validates kind against the closed ENTITY_KINDS enum (drop on miss),
 *   - drops surfaces below MIN_ENTITY_LENGTH (codepoint count on trim),
 *   - drops surfaces that slugify to the empty sentinel,
 *   - forms the canonical_id under `source` (drop if scope is not in
 *     ENTITY_SOURCE_SCOPES — buildCanonicalId would throw),
 *   - dedupes by canonical_id (first kind wins).
 *
 * The returned compiled seed is an array of
 *   { lowerSurface, surface, kind, canonical_id }
 * ready for the whole-word scan. PURE — never throws on a bad entry; it skips.
 *
 * @param {Array<{surface:string, kind:string}>} seed
 * @param {string} source — the row's source scope.
 * @returns {Array<{lowerSurface:string, surface:string, kind:string, canonical_id:string}>}
 */
export function compileSeed(seed, source) {
  const out = [];
  if (!Array.isArray(seed)) return out;
  if (!ENTITY_SOURCE_SCOPES.includes(source)) return out;
  const seen = new Set();
  for (const entry of seed) {
    if (!entry || typeof entry !== "object") continue;
    const surface = typeof entry.surface === "string" ? entry.surface.trim() : "";
    const kind = entry.kind;
    if (surface.length === 0) continue;
    if (!ENTITY_KINDS.includes(kind)) continue;
    // Min-length gate on codepoints (mirrors admitEntity step (a)).
    if ([...surface].length < MIN_ENTITY_LENGTH) continue;
    // Slug must be non-empty.
    let slug;
    try {
      slug = slugify(surface);
    } catch {
      continue;
    }
    if (slug === SLUG_EMPTY_SENTINEL) continue;
    let canonical_id;
    try {
      canonical_id = buildCanonicalId({ source, kind, text: surface });
    } catch {
      // Unknown scope / kind / drained slug — skip silently (precision-first).
      continue;
    }
    if (seen.has(canonical_id)) continue;
    seen.add(canonical_id);
    out.push({
      lowerSurface: surface.toLowerCase(),
      surface,
      kind,
      canonical_id,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-word matcher
// ---------------------------------------------------------------------------

// A word boundary for our purposes: the char on either side of the match is
// not a letter / digit / underscore. We avoid the JS \b regex because seed
// surfaces can contain punctuation/spaces ("QD-4", "Harbor Collective") and a
// per-surface compiled regex per call would be a hot-path allocation. Instead
// we lowercase both haystack and needle once and do indexOf-with-boundary.
function isWordChar(ch) {
  if (ch === undefined) return false;
  return /[a-z0-9_]/.test(ch);
}

/**
 * Find every whole-word, case-insensitive occurrence of `lowerNeedle` in
 * `lowerHay`. Returns the [start, end) spans (in the original-string index
 * space, which is identical because we only lowercased, never reshaped).
 *
 * Boundary rule: a match at [i, j) qualifies when the char BEFORE i and the
 * char AT j are NOT word-chars (letter/digit/underscore). This lets multi-word
 * and hyphenated surfaces match ("FW-3" inside "the FW-3 deck") while refusing
 * a substring match ("cat" inside "category").
 *
 * For surfaces whose own edges are non-word chars (rare — none in the default
 * seed), the boundary check still holds because we test the haystack chars
 * just outside the span, not the needle's own edges.
 *
 * @param {string} lowerHay
 * @param {string} lowerNeedle
 * @returns {Array<[number, number]>}
 */
function findWholeWord(lowerHay, lowerNeedle) {
  const spans = [];
  if (lowerNeedle.length === 0) return spans;
  let from = 0;
  for (;;) {
    const idx = lowerHay.indexOf(lowerNeedle, from);
    if (idx === -1) break;
    const end = idx + lowerNeedle.length;
    const before = idx > 0 ? lowerHay[idx - 1] : undefined;
    const after = end < lowerHay.length ? lowerHay[end] : undefined;
    // The needle's own first/last char determine which side needs a boundary:
    // if the needle starts with a word-char, the preceding haystack char must
    // NOT be a word-char (else we're inside a larger token). Symmetric on the
    // tail. If the needle's edge is itself a non-word char, no boundary is
    // required on that side.
    const needleStartsWord = isWordChar(lowerNeedle[0]);
    const needleEndsWord = isWordChar(lowerNeedle[lowerNeedle.length - 1]);
    const leftOk = !needleStartsWord || !isWordChar(before);
    const rightOk = !needleEndsWord || !isWordChar(after);
    if (leftOk && rightOk) {
      spans.push([idx, end]);
    }
    from = idx + 1; // advance by one to allow overlapping matches
  }
  return spans;
}

/**
 * Run the gazetteer over `text` against a compiled seed for one source scope.
 *
 * @param {string} text — the fact content.
 * @param {object} opts
 * @param {string} opts.source — the row's source scope.
 * @param {Array<{surface:string, kind:string}>} [opts.seed] — raw seed; the
 *   DEFAULT_GAZETTEER_SEED is used when omitted.
 * @returns {{ entities: Array<object>, model_version: string }}
 *   entities mirror the entity-extractor Entity shape with
 *   evidence='kb_lookup', stamped_by='cascade:gazetteer'. Returns an EMPTY
 *   list (never throws) on bad input, unknown scope, or no matches.
 */
export function extractGazetteerEntities(text, opts = {}) {
  const empty = { entities: [], model_version: GAZETTEER_VERSION };
  if (typeof text !== "string" || text.length === 0) return empty;
  const source = opts.source;
  if (!ENTITY_SOURCE_SCOPES.includes(source)) return empty;
  const seed = Array.isArray(opts.seed) ? opts.seed : DEFAULT_GAZETTEER_SEED;
  const compiled = compileSeed(seed, source);
  if (compiled.length === 0) return empty;

  const lowerHay = text.toLowerCase();
  const byId = new Map();
  for (const c of compiled) {
    const spans = findWholeWord(lowerHay, c.lowerSurface);
    if (spans.length === 0) continue;
    // First span wins as the entity's representative span; the entity is
    // emitted once per canonical_id regardless of occurrence count.
    if (byId.has(c.canonical_id)) continue;
    byId.set(c.canonical_id, {
      kind: c.kind,
      canonical_id: c.canonical_id,
      surface: c.surface,
      source_scope: source,
      evidence: "kb_lookup",
      confidence: 1.0,
      extractor_version: ENTITY_EXTRACTOR_VERSION,
      span: spans[0],
      stamped_by: "cascade:gazetteer",
    });
  }

  // Sort ascending by canonical_id for determinism (mirrors the structural
  // extractor's invariant I3).
  const entities = [...byId.values()].sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0,
  );
  return { entities, model_version: GAZETTEER_VERSION };
}
