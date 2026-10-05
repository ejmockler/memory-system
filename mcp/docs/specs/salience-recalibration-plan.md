# Salience Recalibration Plan Post-Stage-0 Corpus Shift

**Node:** F-META-SALIENCE-RECALIBRATION-PLAN
**Status:** SPEC — pending implementation
**Severity:** major
**Owner:** memory-system core (recall layer)
**Depends on:** F-INFRA-R40-TELEMETRY, F-META-GROUND-TRUTH-SPEC
**Blocks:** F-T3-SCREENTIME-F7, F-T3-CODEX_CLI-F10

---

## Problem

The audit treats Stage-0 in isolation. Stage-0 drops 96%+ of git-log
rows; downstream salience scoring, HNSW index parameters, cluster
boundaries, and the `MIN_PROMOTE_FLOOR` threshold were all tuned against
the bloated pre-R41 corpus.

After Stage-0 ships, every salience threshold is potentially
miscalibrated:

- A row that previously scored `structural_score=0.40` at the corpus
  median may now be at the 95th percentile of the leaner corpus and
  over-promote into recall.
- HNSW graph structure assumed N=1M nodes; at N=300k the graph's
  ef-construction and ef-search parameters may be misaligned with the
  new neighborhood density.
- Cluster boundaries fit on a corpus dominated by upstream-only
  duplicates collapse to a different topology once those duplicates are
  filtered.

The result is silent over-promotion of marginal rows that previously sat
at the median — visible only when an operator notices recall quality
drift, by which time damage is done.

## Goal

Define a recalibration plan with three mechanisms:

1. **Shadow-pass scorer**: a parallel salience scoring run on the new
   corpus shape that emits `(was_promoted, would_be_promoted_under_new_corpus)`
   pairs WITHOUT activating the new thresholds.
2. **Operator review N=500**: a forced operator review of 500 random
   would-be-drops before `MIN_PROMOTE_FLOOR` is raised in production.
3. **HNSW rebuild trigger**: a corpus-shift threshold that, when
   crossed, schedules an off-peak HNSW index rebuild with re-tuned
   parameters.

## Why this can't be skipped

The corpus shape determines:
- The empirical distribution of `structural_score`.
- The HNSW connectivity assumptions.
- The cluster-boundary fit.
- The downstream MIN_PROMOTE_FLOOR semantic ("the bottom X% is noise"
  is corpus-relative; what's "bottom X%" changes when the corpus
  contracts).

Skipping recalibration after R41 means the system silently changes
behavior in ways the user cannot debug without instrumentation.

## Shadow-pass scorer

### Mechanism

For the duration of the Stage-0 rollout window (typically 7-14 days
aligned with F-META-AB-PARALLEL-RUN), the salience layer runs two passes
per row:

```js
const oldScore = computeSalience(row, OLD_THRESHOLDS, oldCorpusStats);
const newScore = computeSalience(row, NEW_THRESHOLDS, newCorpusStats);
const wasPromoted = oldScore >= OLD_MIN_PROMOTE_FLOOR;
const wouldBePromoted = newScore >= NEW_MIN_PROMOTE_FLOOR;

writeSalienceShadowRow({
  ts, source, source_msg_id: row.source_msg_id,
  old_score: oldScore, new_score: newScore,
  was_promoted: wasPromoted, would_be_promoted: wouldBePromoted,
  flip: wasPromoted !== wouldBePromoted ?
    (wasPromoted ? "promote_to_drop" : "drop_to_promote") : "agree"
});
```

The PRODUCTION path uses `oldScore`. Only the shadow ledger sees both.

### Storage

Path: `storage/salience-shadow/<source>/<UTC-YYYY-MM-DD>.jsonl`

Retention: 14 days (longer than A/B because salience effects are slower
to manifest).

### Corpus stats refresh

`oldCorpusStats` and `newCorpusStats` are precomputed on daemon start
and refreshed daily:

- `oldCorpusStats`: empirical distribution of `structural_score` and
  derived percentiles on the PRE-Stage-0 ledger sample.
- `newCorpusStats`: same on the POST-Stage-0 ledger sample (the
  filtered output of Stage-0 NEW rules during the parallel-run window).

Refresh cadence: daily at 04:00 UTC.

## Operator review (N=500)

Before raising `MIN_PROMOTE_FLOOR` to its new value:

1. The shadow scorer accumulates `flip: drop_to_promote` rows (rows that
   would now promote but previously didn't).
2. The supervisor samples N=500 random rows from each flip class.
3. A review CLI (`mcp/scripts/salience-review.mjs`) presents the sample
   one row at a time:
   ```
   Row 12/500. Source: git-log. Subject: "WIP: fix payment retry logic"
   Old score: 0.38 (DROP). New score: 0.71 (PROMOTE).
   Why flipped: lighter corpus shifted median; upstream-only commits
   filtered out so this row is now in the top quartile.
   Decision? (k)eep promote / (d)rop / (s)kip / (q)uit:
   ```
4. The user labels each row. The labels are persisted to
   `storage/salience-review-labels.jsonl`.
5. Accept criteria: ≥80% of `drop_to_promote` flips must be
   operator-labeled "keep promote" for the threshold change to ship.
   Below that, the new threshold is NOT activated.

The N=500 figure is a default and operator-tunable via
`SALIENCE_REVIEW_SAMPLE_SIZE` (minimum 100).

## HNSW rebuild trigger

The HNSW index parameters (M, ef_construction, ef_search) are tuned on
corpus size at build time. A corpus that shrinks 96% wants different
parameters.

### Trigger

When the post-Stage-0 corpus size differs from the at-build-time corpus
size by more than `HNSW_REBUILD_SHIFT_RATIO` (default 0.5 — i.e.
shrinkage or growth by >50%), schedule a rebuild.

### Rebuild

1. Off-peak (03:00 local), the supervisor rebuilds the HNSW index from
   the current post-Stage-0 ledger with re-tuned parameters:
   - `M`: scales with `log(N)`.
   - `ef_construction`: scales with `N^0.5`.
   - `ef_search`: operator-configurable; default re-tuned against the
     new corpus's recall@10 vs latency curve.
2. The new index is written to a side-by-side file:
   `storage/hnsw/index-<UTC>.bin`.
3. After integrity check, the supervisor atomically swaps the symlink
   `storage/hnsw/current.bin -> index-<UTC>.bin`.
4. Old index files older than 30 days are pruned.

### Cluster-boundary stability check

Run k-means / leiden on a 5k row sample monthly. Compare to last
month's cluster assignments via adjusted Rand index. Drop in stability
below 0.7 triggers a manual review.

## Timeline aligned with Stage-0 rollout

| Day | Event |
|-----|-------|
| -7  | Stage-0 A/B starts (per F-META-AB-PARALLEL-RUN). Salience shadow scorer starts simultaneously. |
| -7..0 | Shadow ledger accumulates. No production threshold changes. |
| 0   | A/B operator review (per F-META-AB-PARALLEL-RUN). |
| 0..+3 | Salience review CLI sampling phase. N=500 review by operator. |
| +3  | If ≥80% accept rate, raise `MIN_PROMOTE_FLOOR`. Otherwise stay. |
| +3..+14 | Post-promotion monitoring. Shadow scorer continues to surface drift. |
| +14 | HNSW rebuild evaluation. If corpus shift > threshold, schedule rebuild. |
| +30 | Cluster-stability check. |

## Telemetry

Daily rollup at `storage/telemetry/salience_shadow_<date>.jsonl`:

```json
{ "ts": "ISO", "source": "git-log",
  "rows_scored": 12345,
  "flip_drop_to_promote": 234,
  "flip_promote_to_drop": 12,
  "flip_agree_promote": 5432,
  "flip_agree_drop": 6667,
  "new_score_p50": 0.42, "new_score_p95": 0.81,
  "old_score_p50": 0.31, "old_score_p95": 0.72 }
```

`memory_connectors_list` surfaces a salience-recalibration health
summary block.

## Open questions / future work

- Per-source MIN_PROMOTE_FLOOR vs single global value. Currently global;
  per-source override is a v2 enhancement when distinct corpus shapes
  warrant it.
- Cluster boundaries as a hard invariant vs advisory. Currently
  advisory; promoting to invariant requires more empirical data.

## Review questions (from node)

1. Is there a shadow-run mechanism before salience thresholds activate?
   YES — shadow scorer runs both old + new, production uses old.
2. Is there a diff CLI for `(was_promoted, would_be_promoted)`
   comparison?
   YES — `mcp/scripts/salience-review.mjs`.
3. Is the HNSW index rebuild cadence specified?
   YES — corpus-shift threshold + off-peak rebuild + atomic symlink
   swap + 30-day retention.
4. Are recalibration milestones aligned with Stage-0 rollout?
   YES — timeline table above.

## Files to touch (implementation, future PR)

- `mcp/lib/ingest/salience.js` — shadow-pass scorer
- `mcp/lib/recall/_hnsw.js` — rebuild trigger + parameter scaling
- `mcp/scripts/salience-review.mjs` — review CLI
- `mcp/scripts/hnsw-rebuild.mjs` — rebuild driver
- `storage/salience-shadow/` — new directory
- `storage/salience-review-labels.jsonl` — new label log
- `storage/hnsw/` — index versioning + symlink

## Risk

- Operator review of N=500 rows is high-effort; the CLI must be fast
  (keyboard-driven, <5s per row average).
- HNSW rebuild is expensive (minutes to hours on large corpora). Must
  run off-peak.
- The 80% acceptance criterion is heuristic and operator-tunable. If
  operators consistently accept >95%, the bar is too low; if <60%, the
  new thresholds are wrong.
