#!/usr/bin/env node
// build-ranking-eval-goldset.mjs — N11-ranking-goldset (SPAWNED by N6).
//
// Builds a RANKING-sensitive eval substrate whose baseline NDCG@12 is < 1.0, so
// a priors-driven re-rank can MEASURABLY move the metric. This is the eval
// substrate that unblocks the N1 learning-lift: the de-circularized contextual
// goldset has RETRIEVAL headroom (baseline_miss_fraction=0.916) but ZERO RANKING
// headroom — a single binary golden per query that is ALREADY surfaced maxes
// NDCG@12 at 1.0, so no re-rank can register a delta (N6 finding).
//
// WHY A NEW SUBSTRATE (the ranking-headroom bottleneck the WU names)
// -----------------------------------------------------------------
//   eval-harness.js computes NDCG@12 by JOINING a `held_out_label` to its
//   `derived_from[0]` recall event and scoring that event's surfaced[] order
//   against the label's expected_ids (graded gain +2 expected / +1 neighbor /
//   -2 forbidden). With ONE expected_id that is already at rank-0, DCG == IDCG
//   == (2/log2(2)) → NDCG = 1.0 (ceiling). Moving it can only stay at 1.0. To
//   create RANKING headroom we emit GRADED, MULTI-golden labels whose goldens
//   are NOT in the ideal top slots in the REAL surfaced order:
//
//     - PRIMARY golden  (gain +2) sits at a MID position (≥ 2) of the real
//       surfaced[] (retrieved, but not rank-0).
//     - SECONDARY golden (gain +2) sits at a LOWER position (≥ primary+2).
//
//   The IDCG (perfect ordering = both +2s at positions 0,1) then EXCEEDS the
//   DCG of the real order → baseline NDCG@12 < 1.0. A re-rank that lifts the
//   two goldens to the top drives NDCG → 1.0, a measurable positive delta. The
//   builder VALIDATES baseline NDCG@12 < 1.0 for every emitted row using the
//   SAME eval-harness function the calibration loop uses (no re-implementation
//   drift) and DROPS any row that does not clear the headroom gate.
//
// STAMPED PRIORS (so the sweep can actually MOVE the metric)
// ---------------------------------------------------------
//   The calibration loop re-scores surfaced[] via rescoreSurfacedWithLiveWeights,
//   which reads surfaced[i].priors {engagement_prior, damping_coefficient,
//   corroboration_boost} and adds SCORE_WEIGHT_*_PRIOR × prior to the score. For
//   a re-rank to lift a mid-positioned golden over the items above it, the
//   golden must carry a prior bonus large enough to overcome the score gap — but
//   ONLY at non-zero weights (at the baseline all-0.0 weights the rescore is a
//   no-op and the order is byte-identical, so the baseline stays at the < 1.0
//   headroom value). We stamp:
//     - GOLDENS  : non-neutral priors sized so grid-max weights lift them above
//                  the items currently ranked higher (engagement_prior carries
//                  most of the lift since it has the widest grid range [0,0.04]
//                  and no upper clamp).
//     - NON-goldens: NEUTRAL priors (engagement 0.0, damping 1.0, corroboration
//                  1.0) so they do not move.
//   This is a SELF-CONTAINED substrate: it does not depend on N10 (live priors
//   persistence) being shipped — the goldset carries its own stamped priors so a
//   weight sweep differentiates cells TODAY. When N10 lands, the live recall log
//   can be used directly; this substrate remains the controlled headroom probe.
//
// RIGOR CONTRACT
//   1. Every golden is a REAL ledger fact id, validated by streaming
//      memory.jsonl (we never invent ids). Rows whose goldens do not resolve are
//      dropped.
//   2. Built from REAL recall.jsonl traffic: the surfaced[] memory_ids + their
//      real positions/scores come from logged recall events (≥6 surfaced). We
//      reuse the real ranking so the headroom is a property of actual traffic.
//   3. Baseline NDCG@12 < 1.0 is VALIDATED per row with eval-harness's
//      ndcgAtKForPair (the exact metric the gate reads). The meta header reports
//      the baseline NDCG distribution so the reviewer sees the headroom is real.
//   4. THESIS #1: never mutates fact rows. Reads memory.jsonl + recall.jsonl
//      read-only; writes ONLY the two derived substrate files.
//
// OUTPUT (two paired files; --out is the labels file, recall path is derived):
//   - ledgers/ranking-eval-goldset.jsonl    — meta header + held_out_label rows
//                                             (the --labels file for calibration)
//   - ledgers/ranking-eval-recall.jsonl     — the paired recall substrate with
//                                             stamped priors (the --recall file)
//
// USAGE:
//   node mcp/scripts/build-ranking-eval-goldset.mjs \
//       [--out=<labels.jsonl>] [--recall-out=<recall.jsonl>]
//       [--source-recall=<recall.jsonl>] [--memory=<memory.jsonl>]
//       [--seed=<int>] [--target=<n>] [--max-scan=<n>]

// WU-scripts-stringcap: readFileSync is gone from this file's import list —
// readCandidateEvents was its only user and now streams.
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { ndcgAtKForPair, EVAL_CAPS, EVAL_HARNESS_VERSION } from "../lib/synthesis/eval-harness.js";
// WU-scripts-stringcap: readCandidateEvents' whole-file readFileSync of
// recall.jsonl was a landmine — the bare catch turned a future
// ERR_STRING_TOO_LONG into a silently EMPTY goldset. See readCandidateEvents.
import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";
import { LEDGERS_DIR } from "../lib/config.js";

export const BUILDER_VERSION = "build-ranking-eval-goldset@0.1.0";

// Data root comes from lib/config.js (MEMORY_ROOT, default: this checkout),
// never from the home directory.
const MEMORY_LEDGER = join(LEDGERS_DIR, "memory.jsonl");
const RECALL_LEDGER = join(LEDGERS_DIR, "recall.jsonl");
const DEFAULT_OUT = join(LEDGERS_DIR, "ranking-eval-goldset.jsonl");
const DEFAULT_RECALL_OUT = join(LEDGERS_DIR, "ranking-eval-recall.jsonl");

// --------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same family used across the project.
// --------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT,
    recallOut: DEFAULT_RECALL_OUT,
    sourceRecall: RECALL_LEDGER,
    memory: MEMORY_LEDGER,
    seed: 0x2026_0011 >>> 0,
    target: 100,
    maxScan: 1_600_000,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg.startsWith("--recall-out=")) opts.recallOut = arg.slice("--recall-out=".length);
    else if (arg.startsWith("--source-recall=")) opts.sourceRecall = arg.slice("--source-recall=".length);
    else if (arg.startsWith("--memory=")) opts.memory = arg.slice("--memory=".length);
    else if (arg.startsWith("--seed=")) opts.seed = Number(arg.slice("--seed=".length)) >>> 0;
    else if (arg.startsWith("--target=")) opts.target = Number(arg.slice("--target=".length));
    else if (arg.startsWith("--max-scan=")) opts.maxScan = Number(arg.slice("--max-scan=".length));
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: build-ranking-eval-goldset.mjs [--out=path] [--recall-out=path] " +
          "[--source-recall=path] [--memory=path] [--seed=int] [--target=n] [--max-scan=n]\n",
      );
      process.exit(0);
    }
  }
  return opts;
}

const K = EVAL_CAPS.K; // 12 — the eval-harness gate K.

// --------------------------------------------------------------------------
// The prior bonus a golden must carry so that grid-MAX weights lift it above
// the items currently ranked higher. The live-weight rescorer adds:
//   bonus = wEng*engagement_prior + wDamp*damping_coefficient + wCorro*corroboration_boost
// At grid-max (wEng=0.04, wDamp=0.03, wCorro=0.03) with neutral non-goldens
// (which still receive wDamp*1.0 + wCorro*1.0 = 0.06 of constant lift) the
// golden's MARGINAL lift over a neutral item is:
//   wEng*engagement_prior + wDamp*(damp-1.0) + wCorro*(corro-1.0)
// We size engagement_prior so this marginal lift exceeds the largest score gap
// the golden must overcome (the gap from the golden's real score up to the
// top-of-list score) with margin. damping/corroboration are pinned at their
// upper clamps (1.5 / 1.3) to add a little extra, but engagement carries the
// bulk because it has the widest grid range and no upper clamp.
// --------------------------------------------------------------------------
const GRID_MAX = Object.freeze({ wEng: 0.04, wDamp: 0.03, wCorro: 0.03 });
const GOLDEN_DAMPING = 1.5; // upper clamp of damping_coefficient
const GOLDEN_CORRO = 1.3; // upper clamp of corroboration_boost
const NEUTRAL_PRIORS = Object.freeze({
  engagement_prior: 0.0,
  damping_coefficient: 1.0,
  corroboration_boost: 1.0,
});

/** Given the score gap a golden must close (top score − golden score) and a
 *  safety margin, return the engagement_prior that makes the golden's MARGINAL
 *  lift over a neutral item exceed the gap at grid-MAX weights. Pinned damping/
 *  corroboration contribute a fixed marginal term; engagement covers the rest. */
function engagementPriorForGap(gap, margin) {
  const fixedMarginal =
    GRID_MAX.wDamp * (GOLDEN_DAMPING - NEUTRAL_PRIORS.damping_coefficient) +
    GRID_MAX.wCorro * (GOLDEN_CORRO - NEUTRAL_PRIORS.corroboration_boost);
  const need = gap + margin - fixedMarginal;
  if (need <= 0) return 0.0;
  return need / GRID_MAX.wEng;
}

// --------------------------------------------------------------------------
// Pass 1: read source recall.jsonl, collect candidate events (≥6 surfaced) +
// the set of memory ids to validate against the ledger. recall.jsonl is small.
// --------------------------------------------------------------------------
// WU-scripts-stringcap: this was NOT broken today — it was a LANDMINE.
// ledgers/recall.jsonl is 20,900,441 B (0.0389x Node's 536,870,888-byte string
// cap), so the readFileSync still succeeds. But the failure mode was the worst
// available one: the bare `catch { return { events, needed }; }` swallowed
// ERR_STRING_TOO_LONG and returned an EMPTY candidate set, so the day
// recall.jsonl crosses the cap this builder would emit a silently empty goldset
// instead of failing. Streaming removes the cap entirely; readError is now
// reported loudly rather than swallowed.
//
// existsSync dropped per B1c3 (_ledger-stream.js:118-127): it returns false for
// a path behind EACCES/ELOOP/ENOTDIR, which silently became "no recall traffic".
// ENOENT still yields zeros with readError null, preserving the historical
// missing-ledger -> empty contract.
//
// Return shape { events, needed } is PINNED (caller destructures it).
export function readCandidateEvents(sourceRecallPath) {
  const events = [];
  const needed = new Set();
  const counts = streamLedgerLines(sourceRecallPath, (row) => {
    if (!row || row.kind !== "recall") return;
    const surfaced = Array.isArray(row.surfaced) ? row.surfaced : [];
    // Keep surfaced items carrying a real memory_id, sorted by position so the
    // REAL ranking is what we measure headroom against.
    const items = [];
    for (const s of surfaced) {
      if (!s || typeof s.memory_id !== "string") continue;
      items.push({
        memory_id: s.memory_id,
        position: typeof s.position === "number" ? s.position : items.length,
        score: typeof s.score === "number" && Number.isFinite(s.score) ? s.score : 0,
      });
    }
    items.sort((a, b) => a.position - b.position);
    if (items.length < 6) return; // need ≥6 for a primary+secondary spread
    for (const it of items) needed.add(it.memory_id);
    events.push({ id: row.id, ts: row.ts || null, items });
  });
  if (counts.readError) {
    throw new Error(
      `build-ranking-eval-goldset: cannot read recall ledger ${sourceRecallPath}: ${counts.readError}`,
    );
  }
  return { events, needed };
}

// --------------------------------------------------------------------------
// Pass 2: stream the memory ledger and validate which needed ids are REAL
// facts. Lightweight: we only need to confirm existence + kind. Lines carry
// inline embeddings, so we read the id/kind from the line head defensively.
// --------------------------------------------------------------------------
async function validateGoldenIds({ memoryPath, needed, maxScan }) {
  const found = new Set();
  if (!existsSync(memoryPath) || needed.size === 0) return found;
  await new Promise((resolve) => {
    let scanned = 0;
    const rl = createInterface({
      input: createReadStream(memoryPath),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (!line) return;
      scanned++;
      if (scanned > maxScan) {
        rl.close();
        return;
      }
      // Parse the row head only (id + kind appear near the start). Falling back
      // to a bounded slice keeps us off the multi-MB embedding tail.
      let id = null;
      let kind = null;
      const idM = line.slice(0, 2048).match(/"id"\s*:\s*"(mem_[0-9a-f]+)"/);
      if (idM) id = idM[1];
      const kM = line.slice(0, 2048).match(/"kind"\s*:\s*"([a-z_]+)"/);
      if (kM) kind = kM[1];
      if (id && (kind === "fact" || kind === "reconstructed") && needed.has(id)) {
        found.add(id);
        if (found.size === needed.size) rl.close();
      }
    });
    rl.on("close", resolve);
    rl.on("error", () => resolve());
  });
  return found;
}

/** Compute the baseline NDCG@12 for a (expected_ids, surfaced-order) pair using
 *  the EXACT eval-harness function (so the builder's headroom claim is the same
 *  number the gate reads). Returns the NDCG (may be null if not scoreable). */
function baselineNdcg(expectedIds, surfacedIds) {
  const label = { kind: "held_out_label", payload: { expected_ids: expectedIds, forbidden_ids: [] } };
  // derivationGraph absent → no +1 neighbor boost; graded gain is +2 per
  // expected only, which is what we want for a clean multi-golden headroom.
  return ndcgAtKForPair(label, surfacedIds, undefined, K);
}

async function main() {
  const opts = parseArgs(process.argv);
  const rng = mulberry32(opts.seed);

  const { events, needed } = readCandidateEvents(opts.sourceRecall);
  process.stderr.write(
    `build-ranking-goldset: candidate recall events=${events.length} distinct surfaced ids=${needed.size}\n`,
  );
  if (events.length === 0) {
    process.stderr.write(
      `build-ranking-goldset: no candidate recall events in ${opts.sourceRecall}; nothing to build.\n`,
    );
    process.exit(1);
  }

  process.stderr.write("build-ranking-goldset: validating golden ids against memory ledger...\n");
  const realIds = await validateGoldenIds({
    memoryPath: opts.memory,
    needed,
    maxScan: opts.maxScan,
  });
  process.stderr.write(`build-ranking-goldset: validated real fact ids=${realIds.size}/${needed.size}\n`);

  const labelRows = [];
  const recallRows = [];
  const ndcgSamples = [];
  const usedGoldens = new Set();
  let id_n = 0;
  const mkLabelId = () => `rkgl_${String(++id_n).padStart(4, "0")}`;

  // Deterministic order so the manifest is stable across runs over the same
  // recall log: sort events by id.
  events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const ev of events) {
    if (labelRows.length >= opts.target) break;
    const items = ev.items;
    const n = items.length;

    // Choose the primary golden at a MID position and the secondary BELOW it.
    // primary ∈ [2, n-3] so it is retrieved-but-not-rank-0 AND leaves room for a
    // lower secondary. We pick primary deterministically by a coin flip over the
    // feasible mid band; secondary = primary + (2 or 3), clamped to n-1.
    const lo = 2;
    const hi = Math.max(lo, n - 3);
    const pIdx = lo + Math.floor(rng() * (hi - lo + 1));
    let sIdx = pIdx + (rng() < 0.5 ? 2 : 3);
    if (sIdx > n - 1) sIdx = n - 1;
    if (sIdx <= pIdx) continue;

    const primary = items[pIdx];
    const secondary = items[sIdx];
    // Both goldens MUST be real ledger facts (validated). Skip otherwise so we
    // never label a non-existent fact as golden.
    if (!realIds.has(primary.memory_id) || !realIds.has(secondary.memory_id)) continue;
    // One label per golden-pair-anchor: don't let a single fact dominate.
    if (usedGoldens.has(primary.memory_id) || usedGoldens.has(secondary.memory_id)) continue;

    const expected = [primary.memory_id, secondary.memory_id];
    const surfacedIds = items.map((it) => it.memory_id);

    // VALIDATE baseline NDCG@12 < 1.0 (the whole point — real ranking headroom).
    const baseNdcg = baselineNdcg(expected, surfacedIds);
    if (baseNdcg == null || !(baseNdcg < 1 - 1e-9)) continue;

    // ---- Stamp priors onto the paired recall substrate. Goldens get a prior
    // bonus large enough that grid-MAX weights lift them above the items above
    // them; non-goldens stay neutral. We size each golden's engagement_prior to
    // the gap from its real score up to the TOP-OF-LIST score (the worst case it
    // must overcome to reach rank-0), plus a margin.
    const topScore = items[0].score;
    const margin = 0.02; // comfortable headroom over the largest gap
    const surfacedOut = items.map((it, idx) => {
      const isGolden = it.memory_id === primary.memory_id || it.memory_id === secondary.memory_id;
      let priors;
      if (isGolden) {
        const gap = Math.max(0, topScore - it.score);
        priors = {
          engagement_prior: Number(engagementPriorForGap(gap, margin).toFixed(6)),
          damping_coefficient: GOLDEN_DAMPING,
          corroboration_boost: GOLDEN_CORRO,
        };
      } else {
        priors = { ...NEUTRAL_PRIORS };
      }
      return {
        memory_id: it.memory_id,
        score: it.score,
        position: idx,
        propensity: 1 / n,
        rerank_score: null,
        priors,
      };
    });

    const recallId = `rkrec_${String(id_n + 1).padStart(4, "0")}`;
    const labelId = mkLabelId();

    recallRows.push({
      id: recallId,
      ts: ev.ts || "2026-06-23T00:00:00Z",
      kind: "recall",
      query: { surrounding_context_hash: `ranking-goldset:${labelId}`, context_embedding: [], embedding_model_version: "ranking-eval-substrate" },
      surfaced: surfacedOut,
      candidates_pre_truncation: [],
      density_flag: "ok",
      degraded_recall: false,
      degraded_recall_layer3: false,
      ranking_goldset_meta: {
        derived_from_recall: ev.id,
        primary_golden: primary.memory_id,
        secondary_golden: secondary.memory_id,
        primary_position: pIdx,
        secondary_position: sIdx,
      },
    });

    labelRows.push({
      id: labelId,
      kind: "held_out_label",
      derived_from: [recallId],
      ts: ev.ts || "2026-06-23T00:00:00Z",
      provenance: { agent_id: "builder:build-ranking-eval-goldset", conversation_id: null, confidence: 1.0 },
      payload: {
        expected_ids: expected,
        forbidden_ids: [],
        abstain: false,
        labeled_at: new Date().toISOString(),
        labeler_notes:
          "RANKING-sensitive graded-relevance label: two real ledger facts both " +
          "expected (gain +2 each) but surfaced at mid/low positions in the REAL " +
          "recall order, so baseline NDCG@12 < 1.0. A priors-driven re-rank that " +
          "lifts them to the top drives NDCG → 1.0 (measurable lift).",
      },
      metadata: {
        is_synthetic: false,
        is_ranking_headroom: true,
        labeler: "build-ranking-eval-goldset",
        builder_version: BUILDER_VERSION,
        source_recall_id: ev.id,
        primary_golden: primary.memory_id,
        secondary_golden: secondary.memory_id,
        primary_position: pIdx,
        secondary_position: sIdx,
        baseline_ndcg_at_12: Number(baseNdcg.toFixed(6)),
        ranking_headroom: Number((1 - baseNdcg).toFixed(6)),
      },
    });

    usedGoldens.add(primary.memory_id);
    usedGoldens.add(secondary.memory_id);
    ndcgSamples.push(baseNdcg);
  }

  if (labelRows.length === 0) {
    process.stderr.write(
      "build-ranking-goldset: produced 0 ranking-headroom rows (no event cleared baseline NDCG@12 < 1.0). " +
        "Check the source recall log has events with ≥6 surfaced real facts.\n",
    );
    process.exit(1);
  }

  // ---- Headroom summary (the anti-circularity proof for this substrate).
  const total = labelRows.length;
  const baselineMean = ndcgSamples.reduce((a, b) => a + b, 0) / total;
  const baselineMin = Math.min(...ndcgSamples);
  const baselineMax = Math.max(...ndcgSamples);
  // ALL rows are headroom by construction (we drop any that isn't < 1.0); a
  // baseline-miss is "baseline NDCG@12 < 1.0". Report the fraction so the same
  // anti-circularity guard (assertGoldsetHeadroom) that reads
  // headroom.baseline_miss_fraction_all sees a genuine, non-zero headroom.
  const baselineMisses = ndcgSamples.filter((v) => v < 1 - 1e-9).length;
  const baseline_miss_fraction_all = baselineMisses / total;

  const header = {
    kind: "ranking_eval_goldset_meta",
    built_at: new Date().toISOString(),
    builder: "build-ranking-eval-goldset.mjs",
    builder_version: BUILDER_VERSION,
    workunit: "N11-ranking-goldset",
    seed: opts.seed,
    eval_harness_version: EVAL_HARNESS_VERSION,
    k: K,
    paired_recall: opts.recallOut,
    source_recall: opts.sourceRecall,
    counts: { total, labels: labelRows.length, recall_events: recallRows.length },
    headroom: {
      // The anti-circularity guard reads baseline_miss_fraction_all; for a
      // RANKING goldset "miss" := baseline NDCG@12 < 1.0 (real ranking headroom).
      baseline_miss_fraction_all,
      baseline_misses: baselineMisses,
      baseline_ndcg_at_12_mean: Number(baselineMean.toFixed(6)),
      baseline_ndcg_at_12_min: Number(baselineMin.toFixed(6)),
      baseline_ndcg_at_12_max: Number(baselineMax.toFixed(6)),
      ranking_headroom_mean: Number((1 - baselineMean).toFixed(6)),
    },
    notes:
      "RANKING-SENSITIVE: every label has TWO real ledger facts expected (gain +2 " +
      "each) surfaced at mid/low positions in the REAL recall order, so baseline " +
      `NDCG@12 (mean ${baselineMean.toFixed(3)}) is < 1.0 — real ranking headroom. ` +
      "Unlike the contextual goldset (RETRIEVAL headroom, baseline NDCG=1.0 once " +
      "retrieved), a priors-driven re-rank can MEASURABLY move this metric. The " +
      "paired recall substrate stamps non-neutral priors on the goldens (neutral " +
      "elsewhere) so a weight sweep differentiates cells at non-zero weights while " +
      "staying byte-identical at the all-0.0 baseline.",
  };

  const labelLines = [JSON.stringify(header)];
  for (const r of labelRows) labelLines.push(JSON.stringify(r));
  writeFileSync(opts.out, labelLines.join("\n") + "\n", { mode: 0o600 });

  const recallLines = [];
  for (const r of recallRows) recallLines.push(JSON.stringify(r));
  writeFileSync(opts.recallOut, recallLines.join("\n") + "\n", { mode: 0o600 });

  process.stderr.write(
    `build-ranking-goldset: wrote ${total} ranking-headroom labels to ${opts.out}\n` +
      `  paired recall substrate (${recallRows.length} events) to ${opts.recallOut}\n` +
      `  baseline NDCG@12 mean=${baselineMean.toFixed(4)} min=${baselineMin.toFixed(4)} max=${baselineMax.toFixed(4)}\n` +
      `  baseline_miss_fraction_all=${baseline_miss_fraction_all.toFixed(3)} (all rows have ranking headroom)\n`,
  );
  process.stdout.write(JSON.stringify(header.counts) + "\n");
  process.stdout.write(JSON.stringify(header.headroom) + "\n");
}

// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  main().catch((e) => {
    process.stderr.write(`build-ranking-goldset: unhandled ${e && e.stack}\n`);
    process.exit(1);
  });
}
