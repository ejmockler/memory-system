// embed-work-set.js — e2 (embed-population hypergraph): DERIVE the work set
// from the LEDGER instead of reading it from a queue.
//
// WHAT THIS IS
// ------------
// One bounded, resumable, strictly read-only derivation:
//
//   "starting at byte `cursor` of the append-only ledger, give me the next
//    `batch` row ids whose OWN row says they need an embedding and which the
//    live vector index does not already hold as a COMPLETE single vector —
//    and tell me exactly how many bytes and rows that cost."
//
// It exists because the drain's work set has been `policy/re-embed-sweep.jsonl`
// — a queue whose scope is whatever `appendReEmbedSweep` (daemons/watermark.js)
// happened to append. e1 measured the gap: the census's P-NEEDS-EMBED bucket
// holds 1,388,515 distinct ledger row ids (features.embed_state === true and no
// vector by any instrument), while the sweep queue is a tiny fraction of that.
// A row the queue never mentioned is INVISIBLE to the sweep drain forever; it
// is visible here by construction, because the ledger row itself is the
// instrument.
//
// ONE DEFINITION OF THE WORK SET, ENUMERATED BY FOUR SHAPES (2026-08-19)
// ----------------------------------------------------------------------
// The claim is scoped exactly as far as it was checked: ON THE WORK-SET PATH
// (this module, the drain's `workSetMode` block, and
// mcp/scripts/verify-embed-work-set.mjs) there is EXACTLY ONE of each. The
// enumeration was run over daemons/, mcp/lib/ and mcp/scripts/ by four
// independent shapes, because one grep has missed importers twice:
//
//   SHAPE 1, the row predicate — executable reads of `embed_state`:
//     - embed-population-census.js `readRowEmbedInputs` (the ONE definition;
//       imported and CALLED here, never re-spelled);
//     - mcp/lib/recall/multi-feature-score.js `candidateEmbeddingNull`
//       (`candidateFeatures.embed_state === true`) — the RECALL scorer's
//       null-embedding branch. A different question (is this candidate's
//       vector missing at score time), NOT a work-set definition;
//     - distill-promote-fact.js `features.embed_state = true|false` — the
//       WRITER, not a reader.
//     Work-set path: ONE.
//
//   SHAPE 2, the `${id}#${k}` rule — `#`-suffix splitting. THREE spellings
//     exist tree-wide and they are NOT equivalent:
//     - `stripChunkSuffix` (daemons/reembed-drain.mjs) `id.replace(/#\d+$/,"")`
//       — THE rule; the one imported here and by the census;
//     - `_stripChunkSuffix` (mcp/lib/tools/recall.js) — guards a leading `#`
//       and a non-empty remainder, so `"#3"` survives where `stripChunkSuffix`
//       yields `""`;
//     - `baseFactId` (mcp/scripts/run-contextual-eval.mjs) — `indexOf("#")`,
//       so `"a#b#3"` -> `"a"` where `stripChunkSuffix` gives `"a#b"`.
//     Neither of the other two is reachable from the work-set path (recall
//     read-side and an offline eval). Work-set path: ONE. FILED as Fe2-2, not
//     silently blessed.
//
//   SHAPE 3, the ledger walk — `readAppended` / `streamLedgerLines` /
//     `streamLedgerLinesWithOffset` callers. Dozens tree-wide (bm25-rebuild,
//     entity-index, health-reducers, ...), each its own projection. On the
//     work-set path: ONE `readAppended` call site, in `deriveWorkSetBatch`.
//     No `streamLedgerLines*` call is reachable from it.
//
//   SHAPE 4, the atomic cursor writer — tmp + O_EXCL|O_NOFOLLOW + fsync +
//     rename + dir-fsync sequences. Seventeen files pair fsyncSync with
//     renameSync tree-wide. On the work-set path: ONE, `writeCursorFile`
//     (daemons/reembed-drain.mjs), reached only through `writeWorkSetCursor`.
//
// `WORK_SET_SHARED_SYMBOLS` below pins shapes 1, 2 and 4 at FUNCTION-OBJECT
// IDENTITY, and `mcp/test/auto-drain.test.mjs` arm e2 (g) asserts it. That arm
// was MUTATION-TESTED rather than trusted: replacing the import with a local,
// BEHAVIOURALLY IDENTICAL `function stripChunkSuffix(id) { return
// id.replace(/#\d+$/, ""); }` in this file turns it red, verbatim —
//
//   AssertionError [ERR_ASSERTION]: and its chunk rule IS the drain's
//   `${id}#${k}` rule
//   + actual - expected
//   + [Function: stripChunkSuffix]
//   - [Function: stripChunkSuffix]
//
// — the same NAME, a different OBJECT, which is exactly the name-vs-identity
// distinction invariant #5 demands and which no grep for a literal can make.
// The file was restored byte-identically afterwards (sha256 re-checked).
//
// MECHANISM CHOICE, RECORDED RATHER THAN SILENT
// ---------------------------------------------
// The alternative was a positioned-read collector mirroring the drain's
// `collectBatch`. `readAppended` was chosen and it composes, so the fallback
// was NOT written. Making it compose needed exactly one additive primitive:
// `captureCheckpoint(path, { upTo })` (mcp/lib/synthesis/ledger-checkpoint.js),
// because `readAppended` accepts only checkpoints that pass
// `isValidCheckpoint`, i.e. a witness with real block-0 and final-block
// entries ending exactly at `eof`. `upTo` bounds ONLY the newline-safe-eof
// search, so `captureCheckpoint(ledger, { upTo: cursor })` is a genuine
// `[0, cursor)` pin rather than a hand-made object; every pre-existing caller
// is byte-for-byte unchanged.
//   ENFORCING SYMBOL for that last claim: `captureCheckpoint`'s `limit`
//   binding — `Number.isInteger(opts.upTo) && opts.upTo >= 0 ?
//   Math.min(st.size, opts.upTo) : st.size`. Absent, non-integer or negative
//   `upTo` all fall back to `st.size`, which is the pre-existing expression, so
//   a caller that never passes `upTo` cannot observe the parameter. `size` in
//   the returned checkpoint is still `st.size`, so verifyPrefix's "shrunk" test
//   keeps its meaning.
// Early stop is a SENTINEL THROWN FROM `onLine`, so the walk stops at the
// `batch`-th candidate instead
// of reading to eof.
//   ENFORCING SYMBOL: `readAppended`'s own JSDoc closes with, verbatim,
//   "Never throws on fs errors; `onLine` throws DO propagate." — and the
//   `onLine(...)` call sits inside the `try` whose `finally` runs
//   `closeSync(fd)` (mcp/lib/synthesis/ledger-checkpoint.js). There is no
//   `catch` around `onLine`, so BatchFullSentinel reaches this module and the
//   fd is closed on the way out. Both halves re-read 2026-08-19.
// Because the throw discards readAppended's return value,
// the advance is accounted FROM THE LAST ACCEPTED ROW — `off + len + 1`, i.e.
// bytes are consumed only once their terminating "\n" was observed, the same
// rule `collectBatch` states for the sweep file — never from stats we did not
// get.
//
// MEASURED PER-TICK COST (2026-08-18, this repo, node v24, LIVE tree,
// READ-ONLY; true-as-of only — the ledger grows under live writers, and did:
// 3,379,753,900 B at the first reading, 3,379,763,560 B minutes later)
// -----------------------------------------------------------------------
// (A) `node mcp/scripts/verify-embed-work-set.mjs --batch=1000 --sample=5`
//     over ledgers/memory.jsonl from cursor 0 — the WHOLE tick, end to end:
//   readHnswMembership (3.98 MB meta)  60.5 ms  — exclusion set 119,106 bare
//                                                entry ids
//   bounded walk, batch 1000           35.8 ms  — 10,774 rows scanned,
//                                                10,565 candidate rows,
//                                                9,565 already-indexed
//                                                exclusions, 1,000 ids emitted,
//                                                16,667,316 B consumed
//   whole process (incl. node boot)    96.8 ms elapsed, peak RSS 155,959,296 B
//                                      (`/usr/bin/time -l` max RSS 157,696,000)
//   as a fraction of the drain's 900 s StartInterval:  0.0108 % (1.08e-4)
// (B) the two pin primitives, timed alone on the same file:
//   captureCheckpoint (full head pin)  2.40 ms  — 65 witness entries,
//                                                4,256,684 witness bytes
//   verifyPrefix over that pin         1.73 ms  — <= 128 x 64 KiB by
//                                                construction, NOT O(prefix)
//
// (C) DEEP CURSOR — the figure that actually sets steady-state cost, because
//     (A)/(B) above are both at cursor 0 and offset 0 is the ONE place where
//     the ledger is dense in already-indexed ids. Verbatim command:
//       node mcp/scripts/verify-embed-work-set.mjs --batch=1000 --batches=50 --sample=3
//     ledgers/memory.jsonl was 3,395,664,987 B at the start of that run.
//   50 chained batches   694.1 ms elapsed total, 610.6 ms of it derivation,
//                        81.4 ms the one id_map read, peak RSS 228,376,576 B
//                        (`/usr/bin/time -l` max RSS 228,507,648), cursor
//                        0 -> 121,244,157, 88,168 rows scanned.
//   batch 49 ALONE, at cursor 120,111,058 (a NON-ZERO cursor, pin_source
//                        "supplied_pin"):  12.43 ms, 1,001 rows scanned,
//                        1,000 candidate rows, 0 duplicates, 0 exclusions,
//                        1,133,099 B consumed.
//   batch 24 at cursor 83,004,672:  9.44 ms, 1,154 rows, 1,290,351 B.
//   batch  0 at cursor 0:          38.58 ms, 10,774 rows, 16,667,316 B.
//   THE COST FALLS as the cursor advances (0.0014 % of a 900 s tick at batch
//   49): offset 0 is the WORST case, not the typical one, because the
//   exclusion filter discards 9,565 of the first 10,565 candidate rows there
//   and almost none later.
//
// (D) THE `reachedEof` PATH — the one ledger-mode path whose cost is bounded
//     by DISTANCE-TO-EOF rather than by `batch`, which is the r6-2 shape (a
//     full scan on a 900 s timer). It was previously conceded in a comment and
//     never measured. It is measured now. Verbatim command:
//       node mcp/scripts/verify-embed-work-set.mjs --batch=100000000 --batches=1 --sample=3
//     ledgers/memory.jsonl was 3,395,669,422 B at both the start and the end.
//   one derivation, cursor 0 -> 3,395,669,422 (the WHOLE file), reached_eof
//   true:  10,515.1 ms derivation, 10,593.5 ms elapsed, 1,546,130 rows
//   scanned, 1,526,091 candidate rows, 103,702 excluded, 1,422,389 ids,
//   0 duplicate rows, peak RSS 506,593,280 B (`/usr/bin/time -l`).
//   AS A FRACTION OF THE 900 s TICK: 1.177 % (0.0118). That is the WORST CASE
//   for this path — a full 3.4 GB walk from byte 0 — and it is affordable at
//   this cadence, but it is NOT bounded by `batch` and is not claimed to be.
//
//   WHEN IS IT FIRST REACHABLE? Only when fewer than `batch` candidates remain
//   ahead of the cursor. With the installed REEMBED_BATCH=1000 and e1's
//   measured tail density (Fe1-5 / the census payload's
//   `premises.goal_tail_embed_state_true_89_6_pct.measured`: 18,926
//   embed_state-true rows in the last 209,715,200 B, i.e. ~11.08 MB per 1,000
//   candidates), 1,000 candidates occupy roughly the last 11.1 MB. So the path
//   first becomes reachable at a cursor within ~11.1 MB of head.eof — about
//   99.67 % of the way through today's ledger, i.e. only AFTER the derived
//   drain has worked essentially the entire 1.39M backlog. DERIVED FROM e1'S
//   TAIL WINDOW, not directly measured; it is a bound, not a pinned offset.
//
// THE SHAPE IS THE POINT: on EVERY path except (D) the cost is bounded by
// `batch`, NOT by the 3.4 GB ledger. Per tick it is (i) the cursor-pin witness
// re-read, capped at MAX_WITNESS_ENTRIES x BLOCK_BYTES = 128 x 64 KiB by
// ledger-checkpoint.js's own density rules; (ii) one fixed 3.98 MB id_map
// parse; (iii) a delta read of roughly `batch / candidate-density` rows —
// measured 1,000 emitted per 10,774 rows / 16.7 MB at offset 0, and per 1,001
// rows / 1.13 MB at cursor 120,111,058. `mcp/test/auto-drain.test.mjs` arm
// e2 (f) pins that with a fixture whose tail extends far past the cursor.
// PATH (D) IS THE STATED EXCEPTION and carries its own measurement above; it
// is not covered by this sentence.
//
// CARRIED PREMISES FROM e1 (measured there, cited by symbol, not re-derived)
// -------------------------------------------------------------------------
//   P-NEEDS-EMBED                 1,388,515 distinct ids (censusEmbedPopulation)
//   id_map                        127,235 raw entries -> 122,937 bare ids,
//                                 8,129 chunk entries over 3,831 parents,
//                                 tombstones 0 (readHnswMembership)
//   vectors.jsonl                 134,721 distinct bare ids (scanSidecarPopulation)
//   duplicate_id_rows             0 — every id in the pinned prefix appears in
//                                 EXACTLY ONE row today, so latest-write-wins
//                                 is currently a no-op. THIS IS A MEASUREMENT,
//                                 NOT A GUARANTEE: the ledger is append-only
//                                 and a re-append is legal. RESIDUAL: this
//                                 derivation is single-pass and stops at
//                                 `batch`, so it CANNOT apply latest-write-wins
//                                 across the whole file; if an id is re-appended
//                                 with embed_state true AFTER the cursor passed
//                                 its earlier row, that row is seen when the
//                                 cursor reaches it — later, never never. The
//                                 cost of the residual is a WASTED CANDIDATE
//                                 (the child's own done-filter skips it), never
//                                 a wrong advance.
//
// THE DERIVED SET vs e1'S CENSUS: THE DELTA, BOTH DIRECTIONS, WITH PROVENANCE
// ---------------------------------------------------------------------------
// The old heading here read "THE TWO KNOWN LEAKS, STATED". That was an
// ABSOLUTE, and invariant #4 names "a true caveat replaced by a false absolute"
// as the prior program's exact failure mode. It is replaced by the delta as
// resolved on 2026-08-19, in BOTH directions, each with the census key it came
// from. FIVE items survive, not two.
//
// The comparison is exact because the two definitions are stated in code:
//   census bucket, `embed-population-census.js` (the `let bucket;` cascade):
//     inHnsw > inSidecar > inline !== INLINE_VECTOR.NONE > embed_state===true > ...
//   derived set, `deriveWorkSetBatch` below:
//     readRowEmbedInputs(row).embedState === EMBED_STATE.TRUE
//       MINUS readWorkSetExclusions().excludeIds (the id_map's BARE-entry set)
// The cascade is ORDER-DEPENDENT: once an earlier arm matches, `embed_state` is
// never read for that row. So every "how many of bucket X also carry
// embed_state true" question below is answered by a BOUND, not an equality —
// and a bound is what is published, never a zero.
//
// OVER-INCLUSION (in the derived set, not in P-NEEDS-EMBED)
//   L1  P-EMBEDDED-SIDECAR-ONLY — <= 27,072 rows.
//       Provenance: census payload `buckets["P-EMBEDDED-SIDECAR-ONLY"] = 27072`
//       and `reconciliation.vectors_sidecar_ids_absent_from_id_map.count`.
//       These ids have a vector in vectors.jsonl but no id_map entry, so the
//       exclusion set does not hold them and their own row can still say
//       embed_state true. NOT EXCLUDED, deliberately: excluding them means
//       scanning the 12.4 GB vectors.jsonl EVERY TICK — the exact r6-2 trap
//       (presence-vs-completeness over a 12 GB file), a cost this node refuses
//       to put on a 900 s timer. They reach the child, whose own `loadDoneIds`
//       skips them, and a batch of them lands on the drain's existing
//       CHILD_ALREADY_EMBEDDED full-scan route: wasted work, never wrong work.
//       WHY "<=" AND NOT "=": the cascade stops at `inSidecar`, so how many of
//       the 27,072 also carry embed_state true is NOT in e1's payload.
//   L2  P-INLINE-ONLY — <= 287 rows (284 `embedding_4096` + 3
//       `embedding_mrl_768`).
//       Provenance: census payload `buckets["P-INLINE-ONLY"] = 287` and
//       `cross_tabs.bucket_by_inline_vector["P-INLINE-ONLY"]`.
//       A row carrying a non-empty inline vector array and absent from both
//       indices. If its `embed_state` is true it is a derived candidate even
//       though the row itself already holds a vector. UNRESOLVED and BOUNDED at
//       <= 287. It is NOT asserted to be zero: e1's cascade never read
//       embed_state for these rows, and resolving it exactly would need either
//       a cross-tab e1 does not emit or a SECOND full ledger walk — which is
//       the very defect this module exists to not commit. Same disposition as
//       L1 (the child's done-filter absorbs it); same order of magnitude as a
//       rounding error against 1,388,515.
//   L3  EXCLUSION-SET STALENESS — unbounded in principle, one tick in practice.
//       `readWorkSetExclusions` takes the id_map's bare-entry set ONCE per tick
//       (`readHnswMembership(...).bareEntryIds`). An id embedded between that
//       snapshot and the walk is a wasted candidate on this tick and excluded
//       on the next. ACROSS-TICK ONLY — the WITHIN-window case is a different
//       and far worse defect and is CLOSED, see the note below.
//
// UNDER-INCLUSION (needs a vector, INVISIBLE to a flag-keyed predicate)
//   L4  P-EMBED-STATE-FALSE-NO-VECTOR — 57 rows, EXACT.
//       Provenance: census payload
//       `buckets["P-EMBED-STATE-FALSE-NO-VECTOR"] = 57`, defined as
//       "features.embed_state === false yet no vector by any instrument — the
//       flag lies". By kind: 57 fact. By source: chat-claude-code 13,
//       imessage 33, telegram 11. All 57 are at-or-after the wipe threshold.
//       These rows PHYSICALLY need a vector and this module will NEVER emit
//       them, because its predicate is the FLAG and the flag is wrong. Not
//       fixable here without a second instrument (the flag is all the ledger
//       row offers); recorded so the 1,388,515 figure is not mistaken for
//       "everything that needs a vector".
//   L5  P-UNMEASURABLE-NO-EMBED-STATE — 3,130 rows, EXACT, and DELIBERATELY
//       left out.
//       Provenance: census payload
//       `buckets["P-UNMEASURABLE-NO-EMBED-STATE"] = 3130`, with
//       `cross_tabs.bucket_by_kind` = {policy: 1054, reconstructed: 2076}.
//       No `embed_state` KEY at all and no vector: a statement of IGNORANCE,
//       never a claim they are embedded. e1's Fe1-8 measured that NONE of them
//       is a fact row, so they are not silently dropped work — but they are
//       still invisible to this predicate and are counted here rather than
//       omitted.
//
// NET: the derived set is 1,388,515 + (<=27,072) + (<=287) over-inclusions,
// and misses 57 rows that need a vector plus 3,130 it cannot classify. Every
// one of those five numbers comes from the e1 payload quoted in the hypergraph
// FINDINGS.md, not from a second walk performed here.
//
// THE WITHIN-WINDOW DUPLICATE CASE, CLOSED (was mis-stated as L3's cost)
// ---------------------------------------------------------------------
// CORRECTED 2026-08-19. An earlier revision of the staleness note analysed only
// the ACROSS-tick case and called the cost "a wasted candidate". The
// WITHIN-window case was unanalysed and its cost is NOT that: a repeat inside
// one batch used to yield two array entries, which the Set-based proof
// arithmetic downstream can never reconcile, giving work-unmeasurable, a frozen
// cursor and a repair child re-spawned every tick FOREVER. Reproduced by
// review. Closed by keying candidates on the bare id (`seenBare` in
// `deriveWorkSetBatch`), counted as `duplicateRows`, and pinned red-first by
// `mcp/test/auto-drain.test.mjs` arm e2 (j). `duplicateRows` is surfaced to the
// operator in the drain's ledger-mode log record (`duplicate_rows`) and in the
// CLI's per-batch payload, so the counter is readable rather than merely
// returned.
//
// ABSENCE IS NEVER A VERDICT
// --------------------------
// Every unmeasurable derivation throws `WorkSetError` with a stable `code`
// and leaves the cursor FROZEN. No path returns `{ids: []}` to mean "could
// not measure"; an empty `ids` can only ever mean "this window of the ledger
// genuinely contains no candidate", and it is reported alongside
// `rowsScanned` / `reachedEof` so that claim is checkable.
//
// STRICTLY READ-ONLY, EXCEPT THE CURSOR IT IS ASKED TO WRITE
// ----------------------------------------------------------
// `deriveWorkSetBatch` reaches the filesystem through `statSync`,
// `captureCheckpoint`, `verifyPrefix` and `readAppended` — all of which open
// with "r" (ledger-checkpoint.js `openSync(path, "r")`); `readWorkSetExclusions`
// through `readHnswMembership`; `readWorkSetCursor` through `readFileSync`.
// `writeWorkSetCursor` is the ONE mutator. Stated precisely rather than
// flatteringly: through the drain's `writeCursorFile` it creates a SIBLING
// `<cursor>.tmp.<rand>` in the cursor's directory, fsyncs it, renames it over
// the cursor path and fsyncs the directory — so the durable result is one file
// at the path its caller names, and the transient tmp is asserted absent by
// `mcp/test/auto-drain.test.mjs` arms e2 (h) and e2 (i). Nothing here touches
// the ledger, the index, the sidecar, the embed server or any daemon, and
// nothing here starts embedding work: this module computes a list.

import { readFileSync, statSync } from "node:fs";

import {
  captureCheckpoint,
  deserializeCheckpoint,
  readAppended,
  serializeCheckpoint,
  verifyPrefix,
} from "../synthesis/ledger-checkpoint.js";
// THE row predicate and THE membership reader — the census's own symbols, not
// a second spelling. NOTE ON THE CYCLE: daemons/reembed-drain.mjs ->
// embed-work-set.js -> embed-population-census.js -> daemons/reembed-drain.mjs
// is a genuine ESM cycle (the census imports the drain's chunk rule). It is
// safe, and the reason is NARROWER than the absolute an earlier revision of
// this note claimed ("NOTHING in this file reads an imported binding at
// module-evaluation time" is FALSE — `WORK_SET_SHARED_SYMBOLS` below reads
// three of them at top level). The accurate statement: every imported binding
// read at module-evaluation time here names a FUNCTION DECLARATION in its own
// module (`readRowEmbedInputs`, `stripChunkSuffix`, `writeCursorFile`), and
// function declarations are hoisted and initialised before any cycle partner
// evaluates. Every OTHER use is inside a function body, resolved at call time.
// Do not introduce a top-level read of an imported `const`/`class`/`let` here:
// those are in TDZ across the cycle and would throw at import.
import {
  EMBED_STATE,
  readHnswMembership,
  readRowEmbedInputs,
} from "./embed-population-census.js";
// THE chunk rule and THE atomic cursor writer — the drain's own symbols.
// Importing the drain fires no drain. ENFORCING SYMBOL: `INVOKED_DIRECTLY` in
// daemons/reembed-drain.mjs — `import.meta.url === \`file://${process.argv[1]}\``
// guards the sole `runDrain()` call at module scope, so an import (whose
// argv[1] is some other entry point) evaluates the module and starts nothing.
// Re-read 2026-08-19.
import { stripChunkSuffix, writeCursorFile } from "../../../daemons/reembed-drain.mjs";

/** Payload/cursor schema version. */
export const WORK_SET_VERSION = 1;

/**
 * The shared symbols this module derives with, re-exported BY IDENTITY so a
 * test can assert reuse at the symbol level instead of grepping for a
 * duplicated literal (`mcp/test/auto-drain.test.mjs`, arm e2 (g)). If someone
 * ever re-spells `features.embed_state === true` or the `${id}#${k}` rule
 * here, this object stops being the census's / the drain's function object and
 * that arm fails.
 *
 * All three are FUNCTION DECLARATIONS in their own modules, so this top-level
 * object is safe inside the import cycle described above (declarations are
 * hoisted and initialised; a `const` would not be — do not add one).
 */
export const WORK_SET_SHARED_SYMBOLS = Object.freeze({
  readRowEmbedInputs,
  stripChunkSuffix,
  writeCursorFile,
});

/**
 * Named error for every refusal, on the census's `EmbedPopulationCensusError`
 * pattern: `code` is stable and is what a CLI maps to an exit code, `details`
 * carries the numbers needed to self-diagnose without a debugger.
 */
export class WorkSetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkSetError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Codes this module itself raises. The HNSW refusals are NOT here: they are
 * `EmbedPopulationCensusError`s raised by `readHnswMembership` and are
 * deliberately propagated VERBATIM (`census_hnsw_model_mismatch`,
 * `census_hnsw_meta_unreadable`, ...) rather than re-wrapped — re-labelling a
 * measured instrument refusal would degrade it.
 */
export const WORK_SET_ERROR_CODES = Object.freeze([
  "work_set_bad_arguments",
  "work_set_ledger_unreadable",
  "work_set_cursor_invalid",
  "work_set_prefix_drifted",
  "work_set_pin_uncapturable",
]);

/** readAppended's error taxonomy -> this module's stable codes. */
const READ_APPENDED_CODE = Object.freeze({
  "invalid-callback": "work_set_ledger_unreadable",
  "invalid-checkpoint": "work_set_cursor_invalid",
  "from-after-to": "work_set_cursor_invalid",
  missing: "work_set_ledger_unreadable",
  truncated: "work_set_ledger_unreadable",
  "torn-boundary": "work_set_prefix_drifted",
  "io-error": "work_set_ledger_unreadable",
});

// The early-stop sentinel. A dedicated class (not a string, not a plain
// Error) so a genuine bug thrown from inside the callback can never be
// mistaken for "we collected enough".
class BatchFullSentinel extends Error {
  constructor() {
    super("work-set batch full (internal early-stop sentinel)");
    this.name = "BatchFullSentinel";
  }
}

function requirePath(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkSetError(
      "work_set_bad_arguments",
      `deriveWorkSetBatch: ${name} must be a non-empty string path (no default exists in this ` +
        `module — defaults belong to the CLI, mirroring the census)`,
      { arg: name },
    );
  }
  return value;
}

/**
 * readWorkSetExclusions — the ONLY membership set the work-set filter may
 * exclude on.
 *
 * Delegates to the census's `readHnswMembership` and takes its `bareEntryIds`:
 * ids the id_map holds under their EXACT BARE spelling and which are not
 * tombstoned there. A chunked parent (`${id}#k` entries only) is deliberately
 * NOT in this set and therefore stays a CANDIDATE — chunked facts write only
 * `${factId}#k` lines (mcp/scripts/reembed-local-4096.mjs), so a bare entry is
 * evidence of a COMPLETE single-vector embed while a chunk entry is evidence
 * only of PRESENCE. Excluding chunked parents here would be the drain's own
 * presence-vs-completeness defect wearing a new hat.
 *
 * REFUSALS PASS THROUGH UNCHANGED: a model-mismatched or unreadable meta
 * throws the census's own `EmbedPopulationCensusError`.
 *
 * @returns {{ excludeIds: Set<string>, instrument: object }}
 */
export function readWorkSetExclusions({ hnswMetaPath, modelVersion } = {}) {
  const membership = readHnswMembership({ hnswMetaPath, modelVersion });
  return { excludeIds: membership.bareEntryIds, instrument: membership.instrument };
}

/**
 * deriveWorkSetBatch — the derivation. Strictly read-only; every path is
 * injectable and NONE has a default here.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath REQUIRED.
 * @param {number} [opts.cursor=0] byte offset to resume at. MUST be a line
 *   boundary of the current file (it always is when it came from this
 *   module's own advance rule); if it is not, that is
 *   `work_set_cursor_invalid`, never a silent re-alignment.
 * @param {number} [opts.batch=200] stop after this many candidate ids.
 * @param {Set<string>|null} [opts.excludeIds] the BARE-ENTRY membership set
 *   from `readWorkSetExclusions`. Null/absent means exclude nothing, which is
 *   an honest superset (more candidates), never a silent narrowing.
 * @param {object|string|null} [opts.pin] the checkpoint stored alongside the
 *   cursor. When supplied it MUST validate, its `eof` MUST equal `cursor`, and
 *   `verifyPrefix` MUST pass — otherwise the consumed prefix is not the prefix
 *   we consumed and the derivation is UNMEASURABLE (`work_set_prefix_drifted`).
 * @param {number} [opts.maxLineBytes] forwarded to readAppended.
 * @returns {{ids: string[], fromOffset: number, nextOffset: number,
 *   rowsScanned: number, candidateRows: number, bytesScanned: number,
 *   reachedEof: boolean, deriveMs: number, headEof: number, ledgerSize: number,
 *   pinSource: string, nextPin: object|null, excluded: number,
 *   readAppendedStats: object|null}}
 * @throws {WorkSetError}
 */
export function deriveWorkSetBatch(opts = {}) {
  const t0 = process.hrtime.bigint();
  const o = opts === null || opts === undefined ? {} : opts;
  const ledgerPath = requirePath(o.ledgerPath, "ledgerPath");
  const cursor = o.cursor === undefined || o.cursor === null ? 0 : o.cursor;
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new WorkSetError(
      "work_set_bad_arguments",
      `cursor must be a non-negative integer byte offset, got ${JSON.stringify(o.cursor)}`,
      { cursor: o.cursor },
    );
  }
  const batch = o.batch === undefined || o.batch === null ? 200 : o.batch;
  if (!Number.isInteger(batch) || batch <= 0) {
    throw new WorkSetError(
      "work_set_bad_arguments",
      `batch must be a positive integer, got ${JSON.stringify(o.batch)}`,
      { batch: o.batch },
    );
  }
  const excludeIds =
    o.excludeIds === undefined || o.excludeIds === null ? null : o.excludeIds;
  if (excludeIds !== null && typeof excludeIds.has !== "function") {
    throw new WorkSetError(
      "work_set_bad_arguments",
      "excludeIds must be a Set (or any object with .has); pass null to exclude nothing",
      {},
    );
  }

  let st;
  try {
    st = statSync(ledgerPath);
  } catch (e) {
    throw new WorkSetError(
      "work_set_ledger_unreadable",
      `ledger ${ledgerPath} is not stattable: ${e && e.message ? e.message : String(e)}. ` +
        `NOTHING is derived — this is UNMEASURABLE, never an empty work set.`,
      { ledgerPath, errno: e && e.code ? e.code : null },
    );
  }

  // --- HEAD PIN: the far boundary of this tick's window ---------------------
  const head = captureCheckpoint(ledgerPath);
  if (head === null || !Number.isInteger(head.eof)) {
    throw new WorkSetError(
      "work_set_ledger_unreadable",
      `captureCheckpoint returned no usable checkpoint for ${ledgerPath}; the window has no ` +
        `far boundary, so nothing is derived`,
      { ledgerPath, size: st.size },
    );
  }

  // --- CURSOR PIN: a GENUINE [0, cursor) checkpoint -------------------------
  // Either the caller's stored pin (verified byte-identical) or one captured
  // here with the additive `upTo` bound. Both are real checkpoints; neither is
  // a hand-made object smuggled past isValidCheckpoint.
  let from = null;
  let pinSource = "captured_upto";
  const suppliedPin = o.pin === undefined || o.pin === null ? null : deserializeCheckpoint(o.pin);
  if (o.pin !== undefined && o.pin !== null) {
    if (suppliedPin === null) {
      throw new WorkSetError(
        "work_set_cursor_invalid",
        `the stored cursor pin for ${ledgerPath} is not a valid checkpoint. A cursor without a ` +
          `verifiable pin cannot certify that the bytes it skipped are the bytes it skipped; ` +
          `REFUSING rather than deriving over an unpinned prefix.`,
        { ledgerPath, cursor },
      );
    }
    if (suppliedPin.eof !== cursor) {
      throw new WorkSetError(
        "work_set_cursor_invalid",
        `the stored pin ends at eof ${suppliedPin.eof} but the stored cursor is ${cursor}; a pin ` +
          `that does not end AT the cursor certifies a different prefix than the one consumed`,
        { ledgerPath, cursor, pin_eof: suppliedPin.eof },
      );
    }
    const pv = verifyPrefix(ledgerPath, suppliedPin);
    if (!pv.ok) {
      throw new WorkSetError(
        "work_set_prefix_drifted",
        `the consumed prefix of ${ledgerPath} [0, ${cursor}) is NOT byte-identical to its pin ` +
          `(verifyPrefix reason ${JSON.stringify(pv.reason)}). readAppended's caller contract in ` +
          `mcp/lib/synthesis/ledger-checkpoint.js states it: "a delta over a drifted prefix is ` +
          `meaningless". The cursor is left FROZEN and nothing is derived.`,
        { ledgerPath, cursor, reason: pv.reason },
      );
    }
    from = suppliedPin;
    pinSource = "supplied_pin";
  } else {
    from = captureCheckpoint(ledgerPath, { upTo: cursor });
    if (from === null) {
      throw new WorkSetError(
        "work_set_ledger_unreadable",
        `captureCheckpoint({upTo: ${cursor}}) returned no checkpoint for ${ledgerPath}`,
        { ledgerPath, cursor },
      );
    }
    if (from.eof !== cursor) {
      throw new WorkSetError(
        "work_set_cursor_invalid",
        `cursor ${cursor} is not a line boundary of ${ledgerPath}: the newline-safe eof at or ` +
          `before it is ${from.eof}. This module only ever advances to a byte one past a "\\n", ` +
          `so a mid-line cursor means the file was rewritten or the cursor was hand-edited. ` +
          `REFUSING rather than silently re-aligning (which would replay or skip a row).`,
        { ledgerPath, cursor, newline_safe_eof: from.eof },
      );
    }
  }

  if (from.eof > head.eof) {
    throw new WorkSetError(
      "work_set_cursor_invalid",
      `cursor ${cursor} is past the ledger's newline-safe eof ${head.eof} — the ledger is ` +
        `append-only, so this means it was truncated or replaced. REFUSING (a self-heal to 0 ` +
        `here would silently re-derive 1.39M candidates).`,
      { ledgerPath, cursor, head_eof: head.eof, size: st.size },
    );
  }

  // --- THE ONE WALK --------------------------------------------------------
  // DISTINCTNESS. daemons/reembed-drain.mjs:349 documents collectBatch as
  // "gathering up to `batch` DISTINCT fact_ids" and collects into a Set; the
  // downstream proof arithmetic in measureBatchWork/classifyWorkProof compares
  // this array's LENGTH against a Set-based matched count, so a duplicate can
  // never reconcile: it yields work-unmeasurable, a frozen cursor, and a repair
  // child re-spawned every tick forever. Reproduced with a re-appended id.
  // The derived path therefore keys on the SAME bare spelling the exclusion
  // check uses, so a fact is one candidate however its id is spelled.
  const ids = [];
  const seenBare = new Set();
  let duplicateRows = 0;
  let rowsScanned = 0;
  let candidateRows = 0;
  let excluded = 0;
  let nextOffset = from.eof;
  let reachedEof = false;
  let stats = null;

  try {
    stats = readAppended(
      ledgerPath,
      from,
      head,
      (text, byteOffset, byteLength) => {
        rowsScanned += 1;
        let row;
        try {
          row = JSON.parse(text);
        } catch {
          return; // unparseable rows are not candidates; their bytes still pass
        }
        if (row === null || typeof row !== "object" || Array.isArray(row)) return;
        if (typeof row.id !== "string" || row.id.length === 0) return;
        // THE row predicate — the census's symbol, called, not re-spelled.
        if (readRowEmbedInputs(row).embedState !== EMBED_STATE.TRUE) return;
        candidateRows += 1;
        // THE chunk rule — exclusion is compared in the id_map's own bare key
        // space so a row id that ever carries a `#k` suffix is still checked
        // against the same spelling the index uses.
        const bare = stripChunkSuffix(row.id);
        if (excludeIds !== null && excludeIds.has(bare)) {
          excluded += 1;
          return;
        }
        // A duplicate's BYTES are still consumed (the advance below runs), it
        // simply is not a second candidate — matching collectBatch, where
        // Set.add on a repeat does not grow the batch but the offset moves.
        if (seenBare.has(bare)) {
          duplicateRows += 1;
        } else {
          seenBare.add(bare);
          ids.push(row.id);
        }
        // ADVANCE RULE, verbatim in spirit from collectBatch: a row's bytes
        // are consumed only when its terminating "\n" was observed. readAppended
        // delivers only newline-terminated lines, so `+ 1` is that "\n" and a
        // torn tail is left for the next tick by construction.
        nextOffset = byteOffset + byteLength + 1;
        if (ids.length >= batch) throw new BatchFullSentinel();
      },
      o.maxLineBytes === undefined ? {} : { maxLineBytes: o.maxLineBytes },
    );
  } catch (e) {
    if (!(e instanceof BatchFullSentinel)) throw e;
    stats = null; // discarded by the throw; the advance came from the last row
  }

  if (stats !== null) {
    if (stats.error !== null) {
      const code = READ_APPENDED_CODE[stats.error] || "work_set_ledger_unreadable";
      throw new WorkSetError(
        code,
        `readAppended over ${ledgerPath} [${from.eof}, ${head.eof}) failed: ${stats.error}. ` +
          `Counters reflect progress only; NOTHING is certified from a failed delta and the ` +
          `cursor stays frozen.`,
        { ledgerPath, fromOffset: from.eof, headEof: head.eof, readAppendedError: stats.error },
      );
    }
    // The window was exhausted without filling the batch: every byte up to the
    // head pin has been classified, so the whole window is consumed.
    reachedEof = true;
    nextOffset = head.eof;
  }

  // The pin for the NEXT tick, captured NOW over bytes we just read (rather
  // than at commit time, when the file may have been rewritten under us).
  // `prev: from` makes it the cheap incremental extension, not a fresh sample.
  //
  // Fe2-1 (filed and CLOSED here). `captureCheckpoint` returns null on a
  // missing/unstattable/unreadable file and `serializeCheckpoint` returns null
  // for anything failing `isValidCheckpoint`, so this expression could yield
  // null. A null pin PERSISTS SILENTLY: `readWorkSetCursor` accepts a null pin
  // as legal, the next tick then takes the `captured_upto` branch, never runs
  // `verifyPrefix`, and the drift guarantee this module advertises degrades to
  // an assumption with NO record that it degraded. That is exactly the shape
  // invariant #1 forbids. It is a REFUSAL with the cursor FROZEN, like every
  // other unmeasurable path here — the batch is discarded rather than committed
  // behind an unverifiable prefix.
  const nextPin =
    nextOffset === from.eof
      ? serializeCheckpoint(from)
      : serializeCheckpoint(captureCheckpoint(ledgerPath, { upTo: nextOffset, prev: from }));
  // ENFORCEMENT STATUS, DECLARED (invariant #2). The WRITE-side half of this
  // refusal is pinned by `mcp/test/auto-drain.test.mjs` arm e2 (h). THIS half
  // is UNENFORCED BY TEST: reaching it needs `ledgerPath` to become
  // unstattable/unreadable strictly BETWEEN readAppended returning and this
  // capture, and no hermetic fixture in that suite can schedule that window.
  // It is stated as unenforced rather than implied to be covered.
  if (nextPin === null) {
    throw new WorkSetError(
      "work_set_pin_uncapturable",
      `the derivation over ${ledgerPath} [${from.eof}, ${nextOffset}) completed, but NO valid ` +
        `checkpoint could be captured for the new cursor. Persisting offset ${nextOffset} with a ` +
        `null pin would make the next tick skip verifyPrefix entirely and silently trade a ` +
        `verified prefix for an assumed one. REFUSING: the cursor stays FROZEN at ${from.eof} and ` +
        `nothing from this window is certified.`,
      {
        ledgerPath,
        fromOffset: from.eof,
        nextOffset,
        candidates: ids.length,
        rowsScanned,
        reachedEof,
      },
    );
  }

  return {
    ids,
    fromOffset: from.eof,
    nextOffset,
    rowsScanned,
    candidateRows,
    duplicateRows,
    excluded,
    // Exact: [fromOffset, nextOffset) is what the walk consumed. On the
    // early-stop path readAppended's own byte counters went with the throw, so
    // this is derived from the advance rule rather than from stats we did not get.
    bytesScanned: nextOffset - from.eof,
    reachedEof,
    deriveMs: Number(process.hrtime.bigint() - t0) / 1e6,
    headEof: head.eof,
    ledgerSize: st.size,
    pinSource,
    nextPin,
    readAppendedStats: stats,
  };
}

// ---------------------------------------------------------------------------
// CURSOR PERSISTENCE — {v, offset, pin}, through the drain's ONE atomic writer.
// ---------------------------------------------------------------------------

/**
 * readWorkSetCursor — `{offset, pin}` from disk.
 *
 * A MISSING file is offset 0 with a null pin: that is the honest start state
 * of a derivation that has never run, not a measurement. A file that exists
 * but does not parse, or carries a non-integer offset, is a REFUSAL
 * (`work_set_cursor_invalid`) — the drain's `readCursorOffset` treats a
 * corrupt sweep cursor as 0 because re-draining the sweep queue is free and
 * idempotent; re-deriving from ledger byte 0 is 1.39M candidates, so silence
 * is not affordable here.
 */
export function readWorkSetCursor(cursorPath) {
  requirePath(cursorPath, "cursorPath");
  let raw;
  try {
    raw = readFileSync(cursorPath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { offset: 0, pin: null, present: false };
    throw new WorkSetError(
      "work_set_cursor_invalid",
      `work-set cursor ${cursorPath} is unreadable: ${e && e.message ? e.message : String(e)}`,
      { cursorPath, errno: e && e.code ? e.code : null },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new WorkSetError(
      "work_set_cursor_invalid",
      `work-set cursor ${cursorPath} does not parse as JSON (${e && e.message ? e.message : String(e)}). ` +
        `Refusing rather than restarting the derivation from byte 0.`,
      { cursorPath },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkSetError(
      "work_set_cursor_invalid",
      `work-set cursor ${cursorPath} is not a JSON object`,
      { cursorPath },
    );
  }
  if (!Number.isInteger(parsed.offset) || parsed.offset < 0) {
    throw new WorkSetError(
      "work_set_cursor_invalid",
      `work-set cursor ${cursorPath} carries offset ${JSON.stringify(parsed.offset)}, which is ` +
        `not a non-negative integer`,
      { cursorPath, offset: parsed.offset === undefined ? null : parsed.offset },
    );
  }
  const pin = parsed.pin === undefined || parsed.pin === null ? null : deserializeCheckpoint(parsed.pin);
  if (parsed.pin !== undefined && parsed.pin !== null && pin === null) {
    throw new WorkSetError(
      "work_set_cursor_invalid",
      `work-set cursor ${cursorPath} carries a pin that fails checkpoint validation`,
      { cursorPath, offset: parsed.offset },
    );
  }
  return { offset: parsed.offset, pin, present: true };
}

/**
 * writeWorkSetCursor — persist `{v, offset, pin}` atomically.
 *
 * The atomic sequence is NOT re-implemented here: it is `writeCursorFile`
 * imported from daemons/reembed-drain.mjs (tmp + O_EXCL|O_NOFOLLOW 0600 +
 * fsync + rename + dir-fsync). One atomic cursor writer, tree-wide.
 */
export function writeWorkSetCursor(cursorPath, { offset, pin = null } = {}) {
  requirePath(cursorPath, "cursorPath");
  if (!Number.isInteger(offset) || offset < 0) {
    throw new WorkSetError(
      "work_set_bad_arguments",
      `writeWorkSetCursor: offset must be a non-negative integer, got ${JSON.stringify(offset)}`,
      { cursorPath, offset },
    );
  }
  const serialized = pin === null || pin === undefined ? null : serializeCheckpoint(deserializeCheckpoint(pin));
  // Fe2-1, WRITE-SIDE HALF. A non-null pin that fails validation used to
  // serialize to null and be persisted as `pin: null` — indistinguishable on
  // disk from "this derivation has never run", which `readWorkSetCursor`
  // accepts, and which makes the NEXT tick skip `verifyPrefix` entirely. That
  // is a silent downgrade from a verified prefix to an assumed one, so it is a
  // REFUSAL. Passing pin: null EXPLICITLY is still legal — that is the honest
  // start state, not a degraded one.
  if (serialized === null && pin !== null && pin !== undefined) {
    throw new WorkSetError(
      "work_set_pin_uncapturable",
      `writeWorkSetCursor: the supplied pin for ${cursorPath} does not validate as a checkpoint, ` +
        `so it would persist as \`pin: null\` — a cursor indistinguishable from one that was never ` +
        `pinned, whose next tick would skip verifyPrefix and silently trade a VERIFIED prefix for ` +
        `an ASSUMED one. REFUSING to write it.`,
      { cursorPath, offset },
    );
  }
  writeCursorFile(cursorPath, { v: WORK_SET_VERSION, offset, pin: serialized });
}
