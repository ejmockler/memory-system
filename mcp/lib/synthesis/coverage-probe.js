// F-SYN-OPERATIONAL-synthesis-coverage-probe — read-only health probe that
// quantifies how completely the salience cascade is stamping synthesis
// features (entities, time_anchors, valence, episodicity) on newly-promoted
// fact rows AND how completely the recall handler is populating the
// scoringContext block (W4 § 4.7 / W6 § 5) on every memory_recall invocation.
//
// PURPOSE:
//   Before this probe the operator had no concise dashboard signal to
//   distinguish "the synthesis substrate is offline and we're silently
//   degrading every recall to BM25-only" from "everything is fine, the
//   recall miss is upstream". The probe converts the cascade + recall
//   ledgers into a pair of coverage percentages so a regression in any of
//   the four feature stamps OR the populator surfaces within minutes.
//
// DESIGN PRINCIPLES (mirrors mcp/lib/ingest/source-effective-empty-rate.js):
//   - Hermetic: paths are caller-supplied; no STORAGE_DIR / LEDGERS_DIR
//     reach-through. The memory_health caller threads ledgerPath +
//     recallLogPath through, which keeps the env-override discipline
//     intact for hermetic tests.
//   - Pure (modulo disk read): no Date.now() outside the rolling-window
//     anchor (`opts.now` defaults to new Date() for production but tests
//     pin it explicitly).
//   - Defensive: every missing field — missing `features`, missing
//     `features.entities`, malformed JSON line, etc. — is counted as
//     NOT-populated rather than crashed. ONE deliberate exception
//     (WU-health-string-cap-fix): an UNREADABLE ledger (open failure,
//     readSync failure mid-scan) THROWS instead of degrading to zeros.
//     The memory_health caller's existing try/catch converts the throw
//     into a `synthesis_coverage_probe_unreachable` health note plus
//     synthesis_coverage:null — loudly distinguishable from the all-zero
//     snapshot an EMPTY ledger legitimately produces. Pre-fix, both
//     states collapsed to facts_in_window=0 (see BOUNDED note below).
//   - Bounded: streams the file once via _ledger-stream.js's
//     streamLedgerLines and never holds more than the in-window row slice
//     in memory (WU-health-string-cap-fix — the original readFileSync
//     (path, "utf8") implementation materialized the ENTIRE ledger as one
//     JS string; once memory.jsonl crossed Node's ~536,870,888-byte
//     max-string cap it threw ERR_STRING_TOO_LONG, which the old catch
//     swallowed into an empty row set, so the operator dashboard silently
//     reported facts_in_window=0 / all-zero coverage against a 1.8 GB
//     ledger). The ledger is unbounded over time; a tail budget is NOT
//     applied because the operator-visible signal MUST cover the full
//     requested window.

import { existsSync } from "node:fs";
// WU-health-string-cap-fix: the shared WU-B1 streaming primitive. Sync
// fd/readSync chunked scan, StringDecoder across UTF-8 chunk seams, never
// materializes the whole file, and surfaces fs failures on counts.readError
// instead of throwing — see _ledger-stream.js module header. Do NOT replace
// with a bespoke reader; every ledger consumer rebased onto this primitive.
import { streamLedgerLines } from "./_ledger-stream.js";

// Default rolling window for the probe — mirrors the source-effective-empty
// probe's 7-day window so a single operator dashboard cycle compares them
// side-by-side. Exported for tests that want to override.
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * Parse a JSONL file into an array of rows whose `ts` falls inside the
 * rolling window [now - windowDays, now]. Malformed lines + non-ISO `ts`
 * values are silently skipped (counted as "not in window" — the probe's
 * coverage denominators only count parseable rows so the percentages stay
 * meaningful).
 *
 * Returns `{rows, totalLines, parsedLines}`. The two counter fields let the
 * caller surface "the ledger has N lines but only M parsed cleanly" as a
 * health note if needed (Phase 2 extension).
 *
 * WU-health-string-cap-fix: rebased onto streamLedgerLines. The previous
 * readFileSync(absPath, "utf8") whole-file read threw ERR_STRING_TOO_LONG
 * once the ledger crossed Node's ~536,870,888-byte max-string cap, and the
 * old catch swallowed that into {rows: []} — making a 1.8 GB unreadable
 * ledger indistinguishable from an empty one. Constraints preserved:
 *   - RETURN SHAPE unchanged: {rows, totalLines, parsedLines}. totalLines
 *     counts non-empty lines, parsedLines counts JSON-parse successes —
 *     streamLedgerLines counts both identically to the old split-loop.
 *   - FILTERING unchanged: ts/created_at field tolerance, finite-ms check,
 *     [cutoffMs, nowMs] inclusive window. Out-of-window / unparseable rows
 *     never enter the returned array (bounded retention: only the
 *     in-window slice is held).
 *   - MISSING file still returns zeros WITHOUT throwing (pinned by
 *     coverage-probe.test.mjs "missing ledger → 0 facts (no throw)").
 *   - UNREADABLE file (open/readSync failure surfaced on counts.readError)
 *     now THROWS: partial coverage percentages computed off a truncated
 *     scan are biased toward the file head (oldest rows), which is WORSE
 *     than no answer. The memory_health caller catches the throw into a
 *     `synthesis_coverage_probe_unreachable` health note +
 *     synthesis_coverage:null — an unreadable ledger must never be
 *     indistinguishable from an empty one.
 */
function streamLedgerRowsInWindow(absPath, cutoffMs, nowMs) {
  if (!existsSync(absPath)) {
    return { rows: [], totalLines: 0, parsedLines: 0 };
  }
  const rows = [];
  // streamLedgerLines never throws; fs failures surface on counts.readError.
  const counts = streamLedgerLines(absPath, (parsed) => {
    if (parsed == null || typeof parsed !== "object") return;
    // W5-CCS field-tolerance: distill-promote-fact.js's appendFactRow writes
    // `created_at`; older / hermetic test fixtures write `ts`. Read whichever
    // exists so the coverage probe matches the substrate honestly across the
    // (W5-promoted, embed-queued) corpus + the pre-W5 historical rows.
    const tsField =
      (typeof parsed.ts === "string" && parsed.ts) ||
      (typeof parsed.created_at === "string" && parsed.created_at) ||
      null;
    const tsMs = tsField ? Date.parse(tsField) : NaN;
    if (!Number.isFinite(tsMs)) return;
    if (tsMs < cutoffMs) return;
    if (tsMs > nowMs) return;
    rows.push(parsed);
  });
  if (counts.readError !== null && counts.readError !== undefined) {
    // LOUD-FAILURE contract (WU-health-string-cap-fix): see doc block above.
    throw new Error(
      `coverage-probe: ledger scan failed (${counts.readError}) at ${absPath}; ` +
        "refusing to report coverage off a truncated scan — " +
        "an unreadable ledger is NOT an empty ledger",
    );
  }
  return { rows, totalLines: counts.totalLines, parsedLines: counts.parsedLines };
}

// Per-axis coverage breakdown shape. Exported so tests can stay typed against
// the same closed object the probe returns.
function emptyCoverage() {
  return { populated: 0, empty: 0, pct: 0 };
}

function pct(populated, total) {
  if (total === 0) return 0;
  // Round to 4 decimal places — fine-grained enough for dashboard
  // percentage labels (0.9925 = "99.25%") but stable across runs.
  return Math.round((populated / total) * 10000) / 10000;
}

/**
 * Test for a populated `features.entities` slot on a memory.jsonl fact row.
 * A row is "populated" when features.entities is a non-empty array.
 * Missing features or non-array entities = not populated.
 */
function isEntitiesPopulated(row) {
  const f = row && row.features;
  if (f == null || typeof f !== "object") return false;
  return Array.isArray(f.entities) && f.entities.length > 0;
}

/**
 * Test for a populated `features.time_anchors` slot. The field is plural
 * on stamped rows (mirrors the time-anchor-resolver output array). Missing
 * or empty = not populated.
 */
function isTimeAnchorPopulated(row) {
  const f = row && row.features;
  if (f == null || typeof f !== "object") return false;
  return Array.isArray(f.time_anchors) && f.time_anchors.length > 0;
}

/**
 * Test for a populated `features.valence` slot.
 *
 * SHAPE: the cascade stamper writes the STRUCTURED OBJECT returned by
 * scoreValence — {sign, magnitude, source, model_version} — or null on
 * degrade. See mcp/lib/tools/distill-promote-fact.js:992 and its comment
 * "the object is the authoritative on-disk shape". The scalar in [-1, +1]
 * is a PROJECTION applied at index time by factValenceScalar, never an
 * on-disk field.
 *
 * This predicate previously tested `typeof f.valence === "number"`, which
 * no object can satisfy, so valence_coverage reported 0% on every window
 * even while valence_model_version was stamped on every fact row. The
 * scalar branch is retained for legacy pre-migration rows.
 *
 * SEMANTICS: presence, not signal — matching the sibling axes on this side
 * of the probe (isEpisodicityPopulated counts a 0 scalar as populated). A
 * neutral sign of 0 is a real stamp and counts. The recall-side
 * isRecallValencePopulated deliberately uses the opposite convention and
 * excludes 0; that asymmetry is intentional and documented there.
 */
function isValencePopulated(row) {
  const f = row && row.features;
  if (f == null || typeof f !== "object") return false;
  if (typeof f.valence === "number") return Number.isFinite(f.valence);
  const v = f.valence;
  if (v == null || typeof v !== "object") return false;
  return typeof v.sign === "number" && Number.isFinite(v.sign);
}

/**
 * Test for a populated `features.episodicity` slot. The cascade stamper
 * writes a numeric scalar in [0, 1] OR null on degrade. Anything that is
 * null / undefined / non-numeric counts as not populated.
 */
function isEpisodicityPopulated(row) {
  const f = row && row.features;
  if (f == null || typeof f !== "object") return false;
  return typeof f.episodicity === "number" && Number.isFinite(f.episodicity);
}

/**
 * Increment a version histogram safely. Missing or non-string version =
 * counted under the sentinel "_missing_". The histogram lets the operator
 * spot a stuck extractor version mid-rollout (e.g. half the rows on v0.1.0,
 * half on v0.2.0 — indicates the daemon was restarted mid-window).
 */
function tickVersion(hist, version) {
  const key = typeof version === "string" && version.length > 0 ? version : "_missing_";
  hist[key] = (hist[key] || 0) + 1;
}

/**
 * Per-recall scoringContext population predicates. These mirror the
 * `populator` block recall.js writes onto every recall event (see
 * mcp/lib/tools/recall.js ~L964). The probe treats a recall as "populated"
 * on a given axis when the corresponding count or boolean is non-empty.
 *
 * The populator block is the authoritative on-disk signal: it captures the
 * SAME counts the recall handler used to build scoringContext, so the probe
 * cannot disagree with reality.
 */
function isRecallEntitiesPopulated(event) {
  const p = event && event.populator;
  if (p == null || typeof p !== "object") return false;
  return typeof p.entities_count === "number" && p.entities_count > 0;
}

function isRecallTimeAnchorPopulated(event) {
  const p = event && event.populator;
  if (p == null || typeof p !== "object") return false;
  if (p.has_time_anchor === true) return true;
  return typeof p.time_anchors_count === "number" && p.time_anchors_count > 0;
}

function isRecallValencePopulated(event) {
  const p = event && event.populator;
  if (p == null || typeof p !== "object") return false;
  // inferred_mood_sign is a scalar in [-1, +1]; 0 is the "neutral" stamp
  // the populator writes when valence-scorer returns no sign. We count 0
  // as NOT populated because the operator wants to see real valence
  // signal, not the neutral fallback.
  return typeof p.inferred_mood_sign === "number" && p.inferred_mood_sign !== 0;
}

export function isRecallDegraded(event) {
  if (event == null || typeof event !== "object") return false;
  if (event.degraded_recall === true) return true;
  const p = event.populator;
  return p != null && typeof p === "object" && p.degraded === true;
}

/**
 * Compute a synthesis-coverage snapshot for the operator dashboard.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath     - absolute path to memory.jsonl
 * @param {string} opts.recallLogPath  - absolute path to recall.jsonl
 * @param {number} [opts.windowDays=7] - rolling-window length in days
 * @param {Date|number} [opts.now]     - clock anchor (Date or epoch ms);
 *                                       production omits, tests pin
 *
 * @returns {Promise<object>} snapshot shape (frozen at:
 *   kb/mcp-surface.md health_envelope_schema_v1):
 *
 *   {
 *     window_days: number,
 *     built_at: string (ISO-8601),
 *     facts_in_window: number,
 *     entity_coverage:        {populated, empty, pct},
 *     time_anchor_coverage:   {populated, empty, pct},
 *     valence_coverage:       {populated, empty, pct},
 *     episodicity_coverage:   {populated, empty, pct},
 *     extractor_versions: {
 *       entity_extractor_version:       {[v: string]: count},
 *       episodicity_version:            {[v: string]: count},
 *       time_anchor_resolver_version:   {[v: string]: count},
 *       valence_model_version:          {[v: string]: count},
 *     },
 *     recall_population: {
 *       recalls_in_window: number,
 *       non_empty_entities_pct: number,
 *       non_empty_time_anchor_pct: number,
 *       non_empty_valence_pct: number,
 *       degraded_recall_pct: number
 *     }
 *   }
 *
 * The function is async to match the buildHealthData contract; the body is
 * synchronous so the caller can await it without extra event-loop ticks.
 */
export async function computeSynthesisCoverage(opts) {
  const o = opts || {};
  const ledgerPath = typeof o.ledgerPath === "string" ? o.ledgerPath : null;
  const recallLogPath = typeof o.recallLogPath === "string" ? o.recallLogPath : null;
  const windowDays =
    Number.isFinite(o.windowDays) && o.windowDays > 0
      ? o.windowDays
      : DEFAULT_WINDOW_DAYS;
  const nowMs =
    o.now instanceof Date
      ? o.now.getTime()
      : typeof o.now === "number" && Number.isFinite(o.now)
        ? o.now
        : Date.now();
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  // ---------------------------------------------------------------------
  // Fact-side coverage: memory.jsonl rows in window.
  // ---------------------------------------------------------------------
  const entity_coverage = emptyCoverage();
  const time_anchor_coverage = emptyCoverage();
  const valence_coverage = emptyCoverage();
  const episodicity_coverage = emptyCoverage();

  const extractor_versions = {
    entity_extractor_version: {},
    episodicity_version: {},
    time_anchor_resolver_version: {},
    valence_model_version: {},
  };

  let factsInWindow = 0;
  if (ledgerPath) {
    const { rows } = streamLedgerRowsInWindow(ledgerPath, cutoffMs, nowMs);
    // Only fact rows count toward synthesis coverage — distillation may
    // append other kinds (reconstructed shadows, recall events leaked
    // here in legacy layouts). We narrow to kind:"fact" or rows whose
    // `features` slot exists (covers reconstructed-fact subtypes).
    for (const row of rows) {
      const looksLikeFact =
        row && (row.kind === "fact" || row.kind === "reconstructed_fact" || row.features != null);
      if (!looksLikeFact) continue;
      factsInWindow += 1;

      if (isEntitiesPopulated(row)) entity_coverage.populated += 1;
      else entity_coverage.empty += 1;

      if (isTimeAnchorPopulated(row)) time_anchor_coverage.populated += 1;
      else time_anchor_coverage.empty += 1;

      if (isValencePopulated(row)) valence_coverage.populated += 1;
      else valence_coverage.empty += 1;

      if (isEpisodicityPopulated(row)) episodicity_coverage.populated += 1;
      else episodicity_coverage.empty += 1;

      const f = row.features || {};
      tickVersion(extractor_versions.entity_extractor_version, f.entity_extractor_version);
      tickVersion(extractor_versions.episodicity_version, f.episodicity_version);
      tickVersion(
        extractor_versions.time_anchor_resolver_version,
        f.time_anchor_resolver_version,
      );
      tickVersion(extractor_versions.valence_model_version, f.valence_model_version);
    }
  }

  entity_coverage.pct = pct(entity_coverage.populated, factsInWindow);
  time_anchor_coverage.pct = pct(time_anchor_coverage.populated, factsInWindow);
  valence_coverage.pct = pct(valence_coverage.populated, factsInWindow);
  episodicity_coverage.pct = pct(episodicity_coverage.populated, factsInWindow);

  // ---------------------------------------------------------------------
  // Recall-side coverage: recall.jsonl events in window. Only the
  // `populator` block matters — it mirrors what the recall handler used
  // to build scoringContext (the spec invariant: populator counts ===
  // scoringContext non-empty axes).
  // ---------------------------------------------------------------------
  let recallsInWindow = 0;
  let recallEntities = 0;
  let recallTimeAnchor = 0;
  let recallValence = 0;
  let recallDegraded = 0;
  if (recallLogPath) {
    const { rows } = streamLedgerRowsInWindow(recallLogPath, cutoffMs, nowMs);
    for (const ev of rows) {
      if (!ev || ev.kind !== "recall") continue;
      recallsInWindow += 1;
      if (isRecallEntitiesPopulated(ev)) recallEntities += 1;
      if (isRecallTimeAnchorPopulated(ev)) recallTimeAnchor += 1;
      if (isRecallValencePopulated(ev)) recallValence += 1;
      if (isRecallDegraded(ev)) recallDegraded += 1;
    }
  }

  const recall_population = {
    recalls_in_window: recallsInWindow,
    non_empty_entities_pct: pct(recallEntities, recallsInWindow),
    non_empty_time_anchor_pct: pct(recallTimeAnchor, recallsInWindow),
    non_empty_valence_pct: pct(recallValence, recallsInWindow),
    degraded_recall_pct: pct(recallDegraded, recallsInWindow),
  };

  return {
    window_days: windowDays,
    built_at: new Date(nowMs).toISOString(),
    facts_in_window: factsInWindow,
    entity_coverage,
    time_anchor_coverage,
    valence_coverage,
    episodicity_coverage,
    extractor_versions,
    recall_population,
  };
}
