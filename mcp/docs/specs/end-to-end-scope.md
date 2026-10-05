# End-to-End Pipeline Scope: Pre-Stage-0 Connector Filters + Post-Stage-0 Salience

**Node:** F-META-END-TO-END-SCOPE
**Status:** SPEC — pending implementation
**Severity:** major
**Owner:** memory-system core (pipeline architecture)
**Depends on:** F-META-SALIENCE-RECALIBRATION-PLAN
**Blocks:** none (cross-cutting documentation)

---

## Problem

The Stage-0 audit treats Stage-0 in isolation. But Stage-0 changes only
matter end-to-end: an operator may save a week of Stage-0 work that gets
quietly undone by emission-filter behavior at the connector boundary
upstream, or by salience-scorer behavior on the new corpus shape
downstream.

Specifically:

1. **Pre-Stage-0 (connector emission filters)** — each connector decides
   whether a row enters the ledger at all (e.g. `imessage` discards
   tapback receipts; `screentime` discards background-only events).
   Tightening Stage-0 PASS bands is wasted work if the connector is
   already over-emitting; loosening them is dangerous if the connector
   is already under-emitting.

2. **Post-Stage-0 (cross-source dedup + salience + embedder)** —
   structural_score bands are normalized at Stage-0, then re-interpreted
   by the salience scorer against a corpus-shape baseline. If the
   corpus shape shifts (which is the explicit goal of R41 and the cross
   source/structural-bands work), the salience scorer's empirical
   `MIN_PROMOTE_FLOOR` quantile no longer maps to the same operator
   intent — silent over- or under-promotion follows.

There are no documented hand-off contracts between layers; no acceptance
criteria close the loop on whether a Stage-0 change actually produced
the intended end-to-end behavior change.

## Goal

Document the full pipeline as one connected system and define hand-off
contracts between adjacent layers. Each Stage-0 fix must declare its
expected downstream behavior change and ship with an end-to-end
acceptance test exercising the full cascade against a golden-path
fixture set.

## End-to-end pipeline diagram

```
[ Source ]
    |
    v
[ Connector emission filter ]            <- pre-Stage-0 scope
    |  (lib/connectors/<source>.js)
    |  Contract: row schema, presence of required content fields,
    |            connector-side `suggested_structural_score` hints.
    v
[ Stage-0 per-source classifier ]        <- in-scope of audit (Waves 0-4)
    |  (lib/ingest/stage0/<source>.js)
    |  Decision: DROP | REDACT_DROP | PASS
    |  Output: { decision, structural_score?, reason, triggered_redactions? }
    v
[ Stage-0 telemetry + quarantine ]       <- W1 (lib/ingest/stage0/telemetry.js,
    |  source-effective-empty-rate.js,       lib/ingest/quarantine.js)
    |  cross-source-dedup pre-aggregation)
    |  Contract: every PASS row has structural_score in [0,1] and at
    |            least one populated content field; every DROP row has
    |            a reason from the per-source enumeration.
    v
[ Per-source ledger ]                    <- ledger checkpoint manifest
    |  Contract: row_count, last_source_msg_id, content_sha
    |            (F-META-LAYER-INTEGRITY-CHECK manifest).
    v
[ Cross-source dedup ]                   <- W3 (lib/ingest/cross-source-dedup.js)
    |  Contract: validates manifest before consuming. On mismatch, halt.
    |  Output: deduped row set, dedup_reason on each dropped row.
    v
[ Salience scorer ]                      <- (lib/ingest/salience.js)
    |  Contract: reads `structural_score` hint when present;
    |            applies `MIN_PROMOTE_FLOOR` against the empirical
    |            corpus-relative distribution. Shadow-pass first
    |            per F-META-SALIENCE-RECALIBRATION-PLAN.
    v
[ Embedder ]                             <- W4 (observability/embed-cost.js,
    |  W5: gemini-client integration)
    |  Contract: embed cost is observable per source per band; cost
    |            spikes after a Stage-0 change are caught here.
    v
[ HNSW index + recall ]
```

## Per-Stage-0 fix: downstream expectation table

For each Stage-0 change shipped in Waves 0-4, document the expected
behavior at every downstream layer. The table below is the canonical
template; new Stage-0 fixes MUST add a row before merge.

| Stage-0 change                       | Connector layer expectation         | Cross-source dedup expectation               | Salience expectation                              | Embedder expectation                                  |
|--------------------------------------|--------------------------------------|----------------------------------------------|---------------------------------------------------|--------------------------------------------------------|
| R41 cross-source dedup               | unchanged                            | drop ~70% of git-log upstream-only rows      | corpus quantile shifts; `MIN_PROMOTE_FLOOR` re-tune required (per F-META-SALIENCE-RECALIBRATION-PLAN) | embed-cost drops ~60% for git-log; alert if not       |
| R49 unified redaction                | unchanged                            | unchanged (redaction is pre-ledger)          | unchanged structural scores; triggered_redactions appears in telemetry | unchanged embed cost                                  |
| R51 structural-score bands           | requires connector-side `suggested_structural_score` hints for downgrade cases | unchanged dedup; manifest content_sha changes because some rows now carry downgraded scores | empirical structural_score distribution shifts; `MIN_PROMOTE_STRUCTURAL_SCORE` floor activates per F-CROSS-STRUCTURAL-SCORE-BANDS | embed cost drops further; alert threshold tightened by 10% |
| Per-source effective-empty-rate gate | connector emission rate change       | dedup load reduced proportionally            | unchanged scoring; lower volume                   | embed cost drops in proportion to gate                |

## Hand-off contracts (explicit)

Each layer publishes a contract on its outputs that downstream layers
test against. Contracts live next to each module as `CONTRACT.md` or
as a top-of-file block comment; the integration tests enforce them.

### 1. Connector -> Stage-0

- Required fields: `source`, `source_msg_id`, `ts`, `content_fields` (per
  `predicates/content-fields-manifest.js`).
- Optional: `suggested_structural_score` for downgrade hints.
- Forbidden: pre-redacted ledger writes (redaction is Stage-0's job,
  via `lib/redaction/predicates.js`).

### 2. Stage-0 -> ledger

- Every emitted row has `decision ∈ {DROP, REDACT_DROP, PASS}`.
- PASS rows have `structural_score ∈ [0,1]` (number) and at least one
  populated content field.
- DROP/REDACT_DROP rows have `reason` from the per-source DROP-reason
  enumeration.
- A checkpoint manifest is written at the end of each Stage-0 batch
  per F-META-LAYER-INTEGRITY-CHECK.

### 3. Ledger -> cross-source dedup

- Manifest must validate (row_count, last_source_msg_id, content_sha).
- On mismatch, dedup HALTS with operator alert.

### 4. Cross-source dedup -> salience

- Each row carries `dedup_reason` if dropped, else passes through.
- The deduped corpus shape MUST be measured before the salience scorer
  runs (F-META-SALIENCE-RECALIBRATION-PLAN shadow-pass).

### 5. Salience -> embedder

- Only rows above `MIN_PROMOTE_FLOOR` are embedded.
- Embed cost is logged per source per band via
  `observability/embed-cost.js`.

## Acceptance criteria (close-the-loop)

A Stage-0 change is "done end-to-end" only when all of the following
hold against the golden-path fixture set:

- [ ] Stage-0 unit tests pass.
- [ ] Cross-source dedup integration test passes against the new
      manifest content_sha.
- [ ] Salience shadow-pass diff is reviewed and the
      `(was_promoted, would_be_dropped)` count is within the predicted
      band from the downstream-expectation table.
- [ ] Embed cost per source per band moves in the direction predicted
      by the table; if it does not, the change is reverted and the
      table updated.
- [ ] Operator review of N=500 random would-be-drops is filed (per
      F-META-SALIENCE-RECALIBRATION-PLAN) before any
      `MIN_PROMOTE_FLOOR` raise.

## Golden-path fixture set

A small, hand-curated multi-source fixture corpus used by the end-to-end
test. Lives at `mcp/test/fixtures/golden-path/` (to be created
alongside the end-to-end test harness). Composition:

- 50 rows per source (10 sources currently: chat-claude-code,
  codex-cli, git-log, githubevents, imessage, mail, screentime, slack,
  telegram, whatsapp).
- 10 known-good rows per source (operator-curated as "definitely
  recall-worthy").
- 10 known-noise rows per source (operator-curated as "definitely
  drop-worthy").
- 30 ambiguous rows per source spanning the structural_score band
  midpoints (0.3, 0.5, 0.7).
- For each source, at least one row that triggers each redaction
  category in `KEY_SHAPE_RX_FULL` (8 categories), one E.164 phone,
  one ABPerson UID, one URL with a redacted query param.
- For cross-source dedup: at least 5 cross-source duplicate clusters
  (same content visible in two or more sources).

The fixture set is versioned in-tree; changes require operator review
in PR.

## End-to-end test cascade

A single test (`mcp/test/e2e/full-cascade.test.js`, to be created):

1. Load golden-path fixture set.
2. Run each connector against its fixture slice -> ledger.
3. Run Stage-0 per source -> ledger + manifest.
4. Validate manifest.
5. Run cross-source dedup.
6. Run salience scorer in shadow-pass mode.
7. Compare promoted rows against the user-curated "known-good"
   set; assert precision >= 0.8 and recall >= 0.7 (initial floors;
   tune via golden-path operator review).
8. Compare dropped rows against the user-curated "known-noise"
   set; assert >= 0.9 of known-noise rows were dropped.
9. Assert embed cost (if embedder were run) is within the
   predicted-table band per source.

## Out of scope

- Re-tuning HNSW parameters end-to-end is covered by
  F-META-SALIENCE-RECALIBRATION-PLAN.
- Operator-identity / bot-actors split is covered by Wave-0
  `identity/operator-identity.js`.
- The pre-pre-Stage-0 layer (raw source acquisition: which APIs we
  call, polling cadence) is out of scope here; the audit assumes the
  connector already has the raw rows.

## Open questions

- Should connectors emit per-row `suggested_structural_score` hints
  uniformly, or only on downgrade cases? Currently only git-log does
  the downgrade-hint pattern (R41 critic modification). If we
  standardize, the contract changes uniformly across all connectors.
- Per-source `MIN_PROMOTE_FLOOR` vs. global. Currently global; if the
  empirical distributions diverge sharply post-R41, per-source may be
  required.
- Golden-path fixture refresh cadence. Operator-curated fixtures
  drift; propose quarterly review.
