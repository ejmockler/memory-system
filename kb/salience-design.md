# Salience Layer — R24 Design Synthesis

## Recommendation (TL;DR)

Ship a three-layer cascade: **(1) source-tiered Stage-0 hard-drops** for structurally certain noise, **(2) mark-and-rank scoring with persisted component sub-scores** on everything else admitted to `memory.jsonl`, and **(3) embedding-clustering corroboration-only** (no canonical-anchor mechanism) to compress templated-duplicate traffic into `policy.corroboration` events instead of new fact rows. This wins because it is the only configuration that all three judge lenses (correctness, ops-cost, user-utility) score in their top hybrid: cheap structural drops where noise has clean signatures, deterministic component scores that the user can re-weight in minutes without re-embed, and corroboration compression where redundancy dominates — while preserving every source row as recovery substrate. **R24.5 graft**: ship two zero-valued retrieval-decay-feedback columns (`last_retrieved_ts`, `use_count`) inside `features.salience.components` at R25 with weight=0.0 in `CAPS.SALIENCE_WEIGHTS_V1`, so CP-5 Trigger A becomes a byte-idempotent weight bump rather than a schema migration once `recall.jsonl` populates.

## The Six Shapes Considered

(Round-1 scoring; R24.5 adds three cognitive-science shapes — see Appendix A.)

- **filter-at-promote** (4/8/5) — One-shot deterministic gate; sub-threshold rows never enter `memory.jsonl`. Promotes 88.6% of iMessage at suggested threshold; miscalls operator's own merged PR.
- **mark-and-rank** (5/7/7) — Runner-up #1. Admit + score + rerank-apply. Byte-idempotent re-weighting, no re-embed. Within-source p10–p90 spread only 0.13–0.17 — cannot filter inside a source alone.
- **multi-stage-cascade** (6/4/6) — Coarse → embedding → optional LLM. Stage-0 strongest piece across all six shapes; Stages 1–2 miscalibrate on ≥4 of 20 knobs and promote OTP codes (privacy bug).
- **source-tiered-policy** (6/5/6) — Runner-up #2. Per-source modules. Best ScreenTime/iMessage noise suppression; git promote rate 92.6% (admits "Initial commit", "wip").
- **embedding-clustering-novelty** (7/7/4) — Promote-time HNSW k-NN; near-duplicates → `policy.corroboration`. 60× compression on templated traffic; novelty ≠ salience for synthesis; FM-3 (mediocre-first-anchor) empirically observable.
- **query-time-only** (3/6/3) — No write-time decision. "which tasks did I finish for the Larkmoor project" returns 20/20 iMessage chitchat; schema signals not in embedding text.

## The Recommendation in Detail

### Promote-time algorithm

```
function scoreCandidate(event, ctx):
  # LAYER 1: Source-tiered Stage-0 hard-drops (structural, ~10µs)
  if event.source has registered stage0_module:
    decision = stage0_module(event)
    if decision == DROP:
      emit policy.salience.dropped {reason, source, raw_ref}
      return {decision: DROP}
    if decision == OTP_SECRET_REDACT:
      emit policy.salience.redacted {reason: "otp_pattern", source}
      return {decision: DROP}

  # LAYER 2: mark-and-rank component scoring (cheap stages, ~1ms)
  components = {
    recency:      recencyScore(event.timestamp, source_tau),
    authorship:   authorshipScore(event, first_party_handles),
    content_mass: contentMassScore(event.raw_content),
    source_prior: SOURCE_PRIORS[event.source],
    structural:   structuralScore(event),
  }

  # LAYER 3: embedding + HNSW for novelty + corroboration check
  emb = embedSingle(event.content)  # reused for index write
  nearest = hnsw.knn(emb, k=8)
  novelty = 1 - nearest[0].cosine_distance
  components.novelty = novelty

  # Corroboration branch (no canonical anchor swap; FM-3 deferred)
  if nearest[0].cosine_distance < CORROBORATE_THRESHOLD[source]:
    emit policy.corroboration {target: nearest[0].id, source_ref: event}
    return {decision: CORROBORATE}

  # Always promote if eligible; salience is rerank info, not gate
  salience = dot(components, WEIGHTS_V1)  # [0,1]
  appendFact(event, features.salience = {
    score: salience,
    components,
    weights_hash: WEIGHTS_V1_HASH,
    version: SALIENCE_VERSION,
  })
  return {decision: PROMOTE, score: salience}
```

### Scoring function

`score ∈ [0,1]` = weighted sum of six **scored** components, weights pinned in `CAPS.SALIENCE_WEIGHTS_V1` summing to 1.0:

- `recency 0.15` — `exp(-Δt / τ_source)`; τ per source (iMessage 90d, ScreenTime 30d, git 365d)
- `authorship 0.20` — first-party = 1.0, third-party = 0.6 (R21 dampener)
- `content_mass 0.15` — `min(1, log2(uniq_tokens+1)/6)`, hard-zero on boilerplate regex
- `source_prior 0.10` — per-source baseline (git-fp 0.85, imsg 0.60, gh 0.55, screentime 0.20)
- `structural 0.15` — per-source rule table (tapback 0.05, merge 0.15, substantive prose 0.85)
- `novelty 0.25` — `1 - max(cosine, k=8 nearest neighbors)`

**R24.5 zero-weighted columns** (in `features.salience.components`, weight=0.0 in `CAPS.SALIENCE_WEIGHTS_V1`, no contribution to `score` at R25; populated by `appendRecallEvent` once `recall.jsonl` exists): `last_retrieved_ts 0.00` (null at admit), `use_count 0.00` (0 at admit). Shipping dark at R25 makes CP-5 Trigger A a byte-idempotent weight bump + replay, not a schema migration. Closes brutalist MEDIUM defect.

### Storage + recall integration

- `features.salience = {score, components, weights_hash, version}` lives **on the fact row** in `memory.jsonl`. No sidecar (preserves append-only invariant + R19 audit story).
- Per-row overhead ~225 bytes (~18% on 1.2KB rows), including the two zero-valued decay-feedback columns. Acceptable.
- Recall-touch updates write to `ledgers/recall.jsonl` (R19's `appendRecallEvent`); a periodic projection (post-R25, gated on CP-5 Trigger A) folds `last_retrieved_ts` / `use_count` into `features.salience.components` via the same byte-idempotent replay path — fact rows in `memory.jsonl` are never mutated in-place.
- `rerank.js.serializeCandidateForRerank` appends `salience=<f3>` to per-candidate header.
- Layer-2 multi-feature score multiplies `final *= salience^α` with `α=0.5` (square-rooted to preserve long tail).
- `buildRerankInstruction` adds a 6th Flash rule: "PREFER salience ≥ 0.6 when other features tie."
- `_capsSnapshot()` records `SALIENCE_WEIGHTS_V1_HASH` + `SALIENCE_ALPHA` + `SALIENCE_VERSION` on every recall (R19 audit).

### Recoverability

- **Wrong weights** (common): bump `SALIENCE_WEIGHTS_V1` → `replay-salience.mjs` → byte-idempotent arithmetic over `features.salience.components` → no re-embed → ~3 min.
- **Wrong Stage-0 rule** (medium): tighten regex → version bump → `replay-stage0.mjs` → embed cost bounded by drop-set size (~$0.05).
- **Wrong corroboration threshold** (rare): `salience:rebuild-corroborations --since=<date>` emits `policy.salience.upgrade` events. Source ledger never mutated.

### Grafted strengths

- **Stage-0 hard-drops** (from source-tiered): tapbacks (`associated_message_type ∈ [2000, 3007]`), `urn:biz:`, `/discoverability/signals`, WatchEvent/ForkEvent, dependabot, "Initial commit"/merge subjects. ~200 LOC, zero ops cost.
- **OTP/secret regex at Stage-0** (from multi-stage): closes the cascade-Stage-2 privacy bug (promotes OTPs at 0.76).
- **Corroboration branch only** (from ECN): 60× compression on templated traffic. Skip canonical-anchor — FM-3 (mediocre-first-anchor) is empirically real and fights synthesis queries.

## Empirical Justification

R24 sample-extrapolation table (kept verbatim for historical comparison; superseded by the R25.7 operator-corpus table below):

| Source | n | Stage-0 | Corroborate | Promote |
|---|---:|---:|---:|---:|
| imessage | 500 | ~14 (tapback/urn:biz) | 1.0% | ~85% |
| screentime | 929 | 805 (87%) | 22.1% | ~0% |
| git-log (fp) | 500 | ~15 (Initial/merge) | 8.0% | ~85% |
| github-events | 243 | 25 (Create/Delete/Watch) | 65.8% | ~5.8% |
| chat-claude-code | 297 | n/a (R26 blocker) | — | — |

### R25.7 reconciliation against full operator corpus (2026-06-02)

The R24 table above was extrapolated from a 500-row sample per source plus
projected 90-day population growth that assumed ScreenTime would dominate
the ledger at ~80k rows/source. The user's actual on-disk
`storage/sources/*.jsonl` after R25.6's clean rebuild measures:

| Source | n (rows) | Stage-0 fires | Stage-0 % | Reasons (R25.7 counts) |
|---|---:|---:|---:|---|
| imessage | 15,157 | 1,572 | 10.37% | tapback 381 / business_handle 157 / placeholder_residual 640 / otp_pattern 394 |
| screentime | 17,302 | 5,361 | 30.98% | discoverability_signals 5,361 |
| git-log (fp) | 221,217 | 2,620 | 1.18% | initial_commit 154 / merge_only 1,776 / bot_commit 690 |
| github-events | 243 | 1 | 0.41% | WatchEvent 1 |

Combined source-ledger total: 253,919 rows; combined Stage-0 fires: 9,554
(3.76%); rows reaching Layer-2/3: 244,365.

**Why the bands differ from R24:**

- **ScreenTime**: the rule `raw_content.stream == "/discoverability/signals"`
  is correct and fires exactly. The R24 ~87% drop rate was a sample artefact
  of one heavily-discoverability-weighted 929-row window; the user's
  full 17.3k-row corpus distributes across six streams (`/discoverability/signals`
  30.98%, `/app/intents` 27.02%, `/notification/usage` 20.89%, `/app/usage`
  20.36%, `/app/mediaUsage` 0.71%, `/app/webUsage` 0.04%). The 90-day
  projection's "70k ± 10k drops" assumed a steady-state ScreenTime ingest
  rate that the user's actual usage does not produce.
- **iMessage**: 10.37% vs design ~3% is **higher**, driven primarily by
  640 `placeholder_residual` drops (object-replacement char `￼` from
  iMessage attachments-only rows) and 394 OTP redactions — the user's
  corpus contains 7 years of carrier, bank and exchange verification
  codes the R24 500-row sample under-counted. All sampled drops verified
  defensible: tapbacks are emoji reactions; biz handles are Apple's
  automated assistant; OTPs are exactly the security shape the rule was
  built for; placeholders are 1-char attachment stubs.
- **git-log**: 1.18% vs design ~3% is **lower** because the user's
  ~221k commits span 600+ first-party repos with substantive subjects;
  the design's 3% extrapolation assumed a higher fraction of fork/clone
  bootstrapping. All 2,620 drops verified defensible.
- **github-events**: 1 drop vs design ~25% is a **corpus composition**
  artefact — the user's 243-event window is 80% PushEvent + 7%
  CreateEvent + 6% PullRequestEvent, with only one WatchEvent in the
  whole window. The design's 25% assumed a WatchEvent/ForkEvent-heavy
  mix typical of repo-star traffic the user does not generate.

**R25.7 memory.jsonl post-rebuild band**: the design's prior "30–50k" band
was anchored to the 500-row extrapolation. With sync-embed corroboration
firing correctly (Layer-3) plus the corrected Stage-0 magnitudes, expect
~244k rows reaching Layer-2/3, of which the design's CP-1 Aggressive
corroboration thresholds (imsg 0.18 / git 0.28 / gh 0.30 / screentime 0.35)
collapse near-duplicate ScreenTime ticks, templated commits, and chitchat.
**Updated band: 60k–110k rows** on `memory.jsonl` post-sync-embed rebuild.
The exact figure depends on per-source duplicate density and will be pinned
by R25.7's clean rebuild artefact; this band brackets the realistic floor
(aggressive corroboration on git-log + ScreenTime) and ceiling (corroboration
fires only on the densest 20% of templated traffic). Re-tightening to a
narrower band must wait for the rebuild's actual ratios.

R25.7 footnote: the R24 empirical band was extrapolated from a 500–929-row
sample per source; the user's actual corpus shows the per-source
counts in the table above. The Stage-0 rules themselves are unchanged —
each fires correctly on the streams/types/regexes the design specified;
only the prior magnitude *bands* required reconciliation against the
real corpus shape.

**90-day projection (kept as design intent; revisit post-R25.7 rebuild)**:
memory.jsonl ~42 MB raw + ~17 MB salience overhead = **~59 MB**; HNSW
~250 MB disk / ~1 GB RAM; source ledger untouched ~1.3 GB. Per-ingest <1 ms;
per-query Δ ~100µs; zero new embed at recall time (Layer-3 sync-embed
amortised at admit). Weights-change: byte-idempotent rewrite, ~3 min.

**5 illustrative spot-checks** (constructed strings, one per cascade outcome; none is a real message): (1) iMessage `"yeah for the meeting tuesday i was thinking 2-4"` → PROMOTE @ 0.612; (2) SMS `"Example Service: 000000 is your one-time sign-in code"` → STAGE-0 REDACT; (3) git `"R23: harden HNSW backfill"` → PROMOTE @ 0.741; (4) git `"Initial commit"` → STAGE-0 DROP; (5) gh `IssueCommentEvent` on `example-org/example-repo` → PROMOTE @ 0.88, sibling null-title `PullRequestEvent merged` → CORROBORATE @ d=0.118.

### GAP-1 Status (R24.5)

`ledgers/recall.jsonl` does not exist on disk (R19's `appendRecallEvent` is wired but never invoked end-to-end; `ledgers/memory.jsonl` has 3 smoke rows from May 31). The "single most important number" is uncomputable against ground truth. R24.5 ran a lexical-overlap proxy (n=1 per archetype) and found the hybrid ties dual-layer-episodic-semantic at proxy-0.8 intersection; the hybrid's only structural MISS is the long-tail/surprise archetype, addressed by the R24.5 graft (two zero-valued decay-feedback columns + CP-5 Trigger A). Three specific miss scenarios — *"podcast someone recommended 3 months ago"*, *"Acme legal contact from the conference"*, *"LX-2 multi-host decision last month"* — map to CP-5 Triggers A, B, C respectively. **Disposition: GRAFT, not flip.** Full table + per-shape evaluation in Appendix A.

## R24.5 — Discovery Shapes Evaluated + GAP-1 Closure

R24.5 steel-manned and empirically scored the three cognitive-science-shaped shapes silently dropped from the original six (`retrieval-decay-feedback`, `summarize-then-discard`, `dual-layer-episodic-semantic`), and re-ran GAP-1 using a lexical-overlap proxy after confirming `ledgers/recall.jsonl` is empty on disk. All three shapes were rejected as standalone: decay-feedback's signal is zero today and creates an OTP/`urn:biz:` privacy gap during the decay window; summarize-then-discard puts an LLM in the write path and empirically loses point-fact recall; dual-layer's FM-1 entity-tagger conflation is empirically confirmed (`name:Alex`, `name:Your`, `name:And` all promote to semantic candidates on iMessage NL). Full per-shape evaluation in Appendix A.

**GAP-1 proxy headline**: R24 hybrid scores 0.8 intersection (lexical-overlap proxy, n=1 per cell across 5 archetypes), tied with mark-and-rank and dual-layer-episodic-semantic. Decay-feedback's 1.0 is a proxy artifact of admit-all-at-1.0, not signal preservation. The brutalist's REFUTE on proxy methodology is acknowledged: n=1 cells with lexical-overlap target are too weak to flip a recommendation. Only architectural facts (FM-1 conflation, LLM determinism cost, decay-window privacy gap, recall.jsonl absence) carry weight here. Full proxy table + judge re-ranking in Appendix A.

**Judge re-ranking under GAP-1**: R24 hybrid wins all three lenses (correctness 8, ops-cost 7, user-utility 8). All three judges converge on the same graft: bolt the decay-feedback columns onto the hybrid at zero weight to close the long-tail MISS without sacrificing Stage-0 privacy, byte-idempotent re-weighting, or write-path determinism. **Decision: GRAFT, not flip.** The single change is the two zero-valued columns described in §"Scoring function" and surfaced in the TL;DR.

**Deferred-without-steelman carve-out** (closes brutalist GAP-2 hit-zone-c): Five additional R24 hit-zone (a) shapes — `learned-classifier-bootstrap`, `reservoir/importance-sampling`, `sketch-based-summarization`, `two-tower-retrieval`, `operator-pin-as-canonical` — were noted but not steel-manned in R24.5. They are deferred without prejudice: each is either a different layer of the stack (two-tower is recall-side), dependent on a substrate that does not exist yet (learned-classifier needs `recall.jsonl`), or an operator-loop variant interacting with the workflow file layer above salience (operator-pin-as-canonical is a CP question). Acknowledged; not promoted.

## Operator Call-Points

### CP-1: Stage-0 + corroboration threshold sensitivity
- **Aggressive** (default): full Stage-0 set (ScreenTime allowlist, `urn:biz:`, tapback, `Initial commit`, merge-only, WatchEvent/ForkEvent, dependabot). Corroborate threshold imsg 0.18 / git 0.28 / gh 0.30 / screentime 0.35.
- **Balanced**: same Stage-0; tightened to imsg 0.12 / git 0.22 / gh 0.24.
- **Permissive**: Stage-0 only tapback + `Initial commit` + dependabot.
- **Default: Aggressive.** Empirical Stage-0 calls clean; corroboration is the load-bearing storage saver.

### CP-2: Component weights
- **Equal-ish baseline** (default): `recency 0.15, authorship 0.20, content_mass 0.15, source_prior 0.10, structural 0.15, novelty 0.25` + zero-weighted `last_retrieved_ts 0.00, use_count 0.00`.
- **Operator-priority**: `authorship → 0.30, content_mass → 0.20, novelty → 0.15`. Matches stated query patterns.
- **Default: baseline.** Re-weighting is byte-idempotent; tune from week-1 `recall.jsonl`.

### CP-3: Corroboration retroactivity on `connector_revoke`
- **Inherit R21 BFS** (default): revoke folds corroborations via transitive-orphan walk; salience components on facts NOT recomputed. `policy.salience.stale_post_revoke` audit event surfaces drift.
- **Recompute novelty on revoke**: ~10× revoke cost.
- **Default: inherit R21 BFS.**

### CP-4: Golden-query harness
- **With harness** (default): 50-query golden set; CI asserts top-K stability. R24.5 caveat: set is **synthetic at R25 ship** (seeded from operator-asserted archetypes), *replaced* with curated-from-real-traffic queries at week 1 once `recall.jsonl` populates.
- **Without harness**: ship cleaner; accept "recall feels off" as the 6-month failure mode.
- **Default: with harness.**

### CP-5: Discovery-shape bolt-on triggers (R24.5)
- **Trigger A (decay-feedback scoring activation)**: columns ship at R25 with weight=0.0 (see §Scoring function). Trigger fires when operator self-reports "I keep failing to find old stuff" within R25 first month, OR when week-4 `recall.jsonl` shows >10% of returned facts have `last_retrieved_ts` older than 90 days yet score in the top-5. Trigger-fire is a `CAPS.SALIENCE_WEIGHTS_V1` bump (e.g., `last_retrieved_ts → 0.10, use_count → 0.05`) + `replay-salience.mjs` — byte-idempotent, no re-embed, no schema migration. Closes brutalist MEDIUM defect on column-add vs. scoring-use conflation.
- **Trigger B (dual-layer bolt-on)**: if week-4 `recall.jsonl` archetype mix shows "who is `<person>`" >25%, build background distiller emitting `kind:"semantic_fact"` rows. Scope must narrow to github-events + chat-claude-code (FM-1 conflation confirmed on iMessage NL). ~3 weeks; own workflow.
- **Trigger C (summarize-then-discard bolt-on)**: if `memory.jsonl` >1 GB before month 6, OR "what was decided" archetype consistently misses, schedule LLM-summarization over `policy.corroboration` clusters. Defer to R29+.
- **Default: no bolt-on at R25 ship.** Triggers fire from data, not preference.

## Failure Modes

1. **Embedding-model drift** — Gemini swap → non-comparable `novelty`. Signal: `salience_calibration_mismatch` counter. Fix: `salience_layer_quiesce` + rebuild.
2. **Stage-0 regex false-positive** on legitimate `urn:biz:`. Signal: `policy.salience.dropped` stream + drop-rate alert. Fix: tighten + module version bump + replay.
3. **Mediocre-first-fact locks corroboration cluster.** Signal: corroboration count high + canonical shorter than corroborating mean. Fix: manual `policy.salience.canonicalize` (no auto-swap by design).
4. **Silent under-ranking with no ground truth.** Signal: golden-query harness regression. Fix: CP-4 mandatory.
5. **ScreenTime drowned** — Stage-0 walls all `/discoverability/signals` → "what was I doing Tuesday" returns nothing. Fix: corroboration carries trace; if not, lower screentime corroborate threshold to 0.20 + admit `/app/usage` + `/app/webUsage`.

## What This Does NOT Solve

- **R26 (watermark daemon coverage extension)** must land before this is effective end-to-end. The salience layer can't filter rows it never sees, and `chat-claude-code` is 99.7% empty smoke rows in the current ledger — salience is empirically untestable on the primary target source until R26 backfills real conversation data.
- **Background discovery.** The current recommendation is engineered-focus, not background-discovery. R24.5 steel-manned and empirically scored all three cognitive-science shapes (retrieval-decay-feedback, summarize-then-discard, dual-layer-episodic-semantic), confirmed the hybrid ties the best of them on the GAP-1 proxy (0.8) and dominates on shippability + write-path determinism, and grafted the two zero-valued retrieval-decay-feedback columns (`last_retrieved_ts`, `use_count`) at R25 ship to make CP-5 Trigger A a weight-bump rather than a schema migration. Summarize-then-discard and dual-layer remain CP-5 deferred-flip candidates with quantitative trigger conditions; no LLM-in-write-path or second store at R25.
- **Connector-revoke retroactive salience semantics** are unaddressed by the recommendation beyond CP-3's default (inherit R21 BFS, accept stale `s_novelty` on revoked-source neighbors). Stored component sub-scores are exposed; the audit event `policy.salience.stale_post_revoke` is the surfaced mitigation.
- **Recall-trace ground truth** — `ledgers/recall.jsonl` is empty on disk; R19's writer is wired but never invoked. The lexical-overlap proxy (n=1 per cell, intersection rate 0.8 for the hybrid) substitutes only weakly. R25 must persist `appendRecallEvent` to disk as part of the gate-zero; thresholds freeze at week 1 against real recall events. The brutalist's "single most important number" remains uncomputable until then; nothing about the recommendation is contingent on its eventual value above the 70% gate, because the hybrid's only structural MISS is the long-tail/surprise archetype (closable additively via CP-5 Trigger A's weight bump).
- **R25/R26 sequencing** — calibrating salience on today's narrow daemon scope produces stale numbers the moment R26 lands. Surfaced as known; defer thresholds-freeze until after R26.

## Schema reference

### Retroactive-drop sidecar (R25.5 CRIT-3)

Stage-0 rule tightenings are re-played against `storage/sources/*.jsonl` via `mcp/scripts/replay-stage0.mjs`. Rows that PREVIOUSLY promoted into `memory.jsonl` but would FAIL the current Stage-0 rules are written to a sidecar that the recall layer (`mcp/lib/recall/hard-gates.js`) reads at every recall.

- **Path glob**: `storage/salience-sidecars/retroactive-drop-<run_id>.jsonl`. One file per `replay-stage0` invocation; the consumer reads every matching file under the directory. The directory's `(name, mtime, size)` fingerprint is folded into the orphan-map cache key so a new sidecar busts the cache deterministically.
- **Row schema** (`RETROACTIVE_DROP_SIDECAR_VERSION = 1`):
  - `dropped_at_ts` — ISO-8601 string.
  - `target_memory_id` — string. The `memory.jsonl` row id to excise. Resolved by `replay-stage0` via `source_msg_id → memory_id` join over `source_refs[]`.
  - `reason` — string. The Stage-0 rule name that fired (e.g. `stage0_imessage_tapback_tightened`). Surfaces in the recall ledger's `candidates_pre_truncation.dropped_reason` prefix as `retroactive_drop:<reason>`.
  - `replay_run_id` — string. Same value as the filename suffix; operators can rescind an entire run by deleting one file.
  - `version` — number. `1` for the R25.5 wire format. The consumer version-gates: unknown versions contribute no excises.
- **Why a sidecar, not a `policy.salience.retroactive_drop` audit event**: per-run volume can dwarf the rest of the audit log; the sidecar lives next to source-replay artefacts and is read once per recall (cached).

### Stale-post-revoke audit event (R25.5 CRIT-2 emission)

`policy.salience.stale_post_revoke` declared in `mcp/lib/policy-events.js` and emitted by `mcp/lib/recall/hard-gates.js` `loadTransitiveOrphanMap` at BFS discovery time. Schema:

- `kind` — `"policy.salience.stale_post_revoke"`.
- `fact_id` — string. The `memory.jsonl` row id that derives transitively from a now-revoked source AND carries `features.salience`.
- `target_source` — string. The source named in the `connector_revoke` policy event (`imessage`, `screentime`, `git-log`, `github-events`).
- `revoke_event_id` — string. The `id` of the `connector_revoke` policy event, or `"unknown"` if the producer omitted an id.
- `novelty_component_was` — number | null. The `features.salience.components.novelty` value at promote-time; surfaces the stale-drift quantity per CP-3 ("facts NOT recomputed; audit event surfaces drift").
- `discovered_at` — ISO-8601 string. The moment of BFS discovery.

Idempotency: process-scope dedup on `(fact_id, revoke_event_id)`. Process restart re-emits once per cached pair — accepted; the monthly-rotated audit log absorbs the bounded re-emission.

## R25 Implementation Sketch

- **New module**: `mcp/lib/ingest/salience.js` (~450 LOC, +~50 over R24 for two zero-valued decay-feedback columns). Exports `scoreCandidate(event, ctx)`. Owned by `memory_distill_promote_fact` between step 3e (consent walk) and step 4 (embed-then-append); embedding reused for index write. Component vector includes `last_retrieved_ts: null`, `use_count: 0` at admit.
- **New caps**: `CAPS.SALIENCE_WEIGHTS_V1` (8 entries: 6 scored + 2 zero-weighted decay), `..._HASH`, `..._ALPHA`, `..._VERSION`, per-source `CORROBORATE_THRESHOLD[*]`, `SOURCE_PRIORS[*]`. All snapshot in `_capsSnapshot()`.
- **Touched files**: `mcp/lib/hard-gates.js`, `mcp/lib/rerank.js` (+`salience=` line, `final *= salience^α`, 6th Flash rule), `mcp/lib/distill-promote-fact.js`, `mcp/lib/recall-log.js` (ensure `appendRecallEvent` actually persists to disk — wired but never invoked; **R25 gate-zero**).
- **Tests**: `mcp/test/ingest/salience-cascade.test.js` — 12 fixtures (5 spot-check + tapback/urn:biz/OTP/merge/null-PR/revoked/mixed-version-replay). Asserts `last_retrieved_ts === null` and `use_count === 0` at admit. Property: weight-bump byte-idempotent (incl. synthetic Trigger-A activation); monotonicity.
- **Replay scripts**: `replay-salience.mjs`, `replay-stage0.mjs`, `salience-rebuild-corroborations.mjs`.
- **Golden harness** (CP-4): `mcp/test/recall/golden-queries.test.js` — 50 queries; synthetic at R25 ship, replaced from real `recall.jsonl` at week 1.

**Sizing**: one workflow, ~450 LOC. R25 gate-zero (revised in R24.5): ship the cascade AND wire `appendRecallEvent` to disk in the same workflow; freeze `CAPS.SALIENCE_WEIGHTS_V1` thresholds at week 1 against real events. If week-1 measured intersection <70%, flip CP-1 toward Permissive and fire CP-5 Trigger A early.

---

## Appendix A — R24.5 Per-Shape Evaluation + GAP-1 Tables

### A.1 Per-shape rejection notes

**retrieval-decay-feedback** (steel-man: salience as observed-from-recall-traces; sidecar projection over `ledgers/salience-projection.jsonl`; per-source τ; surprise-brief on Δs > 0.30 after 21d quiet). Architecturally the only shape that uniquely closes the long-tail/surprise archetype. Empirically rejected as standalone: (a) `ledgers/recall.jsonl` does not exist, so the ground-truth signal is zero today; (b) Stage-0 OTP + `urn:biz:` defenses arrive 30–90 days before any decay-floor, creating an unrecoverable privacy gap during the decay window; (c) FM-1 cold-start dominates the first ~180d. The two zero-valued columns (`last_retrieved_ts`, `use_count`) are grafted into the hybrid at R25 ship; scoring contribution is gated on CP-5 Trigger A.

**summarize-then-discard** (steel-man: per-source window buffers; LLM distiller emits `kind:semantic.summary` rows with `source_refs[]`; raw archived to cold tier; `expand_summary` recall branch). Empirically real ~15-25× compression on iMessage thread-days and fat-tail git repo-days (≤3% of windows, ~40% of commit volume). Rejected: (a) LLM-in-write-path destroys R24's byte-idempotent re-weighting and propagates R21's untrusted-output constraint into the ledger itself — Jaccard 0.15 is a thin defense against confabulation; (b) point-fact recall regression empirically confirmed ("which commit added Apple Pay" lottery against a 410-commit exemplar); (c) flagship target source (`chat-claude-code`) is R26-blocked; (d) 55% imsg / 18% git / 28% chat windows degrade to single-row passthrough, where the shape reduces to mark-and-rank without scoring. Deferred under CP-5 Trigger C.

**dual-layer-episodic-semantic** (steel-man: episodic ledger preserves mark-and-rank; deterministic 6h daemon materializes `kind:semantic_entity` rows in a second ledger keyed on `(entity_id, entity_kind)`; recall hits `hnsw_semantic` first). Architecturally cleanest answer for "who is X" queries. Rejected for R25: (a) FM-1 entity-tagger conflation **empirically confirmed** in the captured corpus — `name:Alex`, `name:Your`, `name:And` all promote to semantic candidates under a naive NER pass, producing noise *amplification* on iMessage natural-language entities; (b) flagship "14 Robin mentions" hero scenario is not present in the captured corpus at any salience; (c) two-store architecture + consolidation daemon + revoke-BFS extension + operator-adjudicated `semantic_split` is multi-workflow scope, not a single R25 lift. Deferred under CP-5 Trigger B; if it lands, scope must be narrowed to structurally-clean sources (github-events + chat-claude-code) where conflation is bounded.

### A.2 GAP-1 proxy cross-check (n=1 per cell, lexical-overlap)

`ledgers/recall.jsonl` does not exist on disk (`ledgers/` contains only `.gitkeep` + a 3-row smoke `memory.jsonl` from May 31); R19's `appendRecallEvent` is wired into `tools/recall.js` but has not been invoked in production. The "single most important number" is uncomputable against ground truth. Lexical-overlap proxy across five operator archetypes (entity-identity, decision-rationale, recent-substantive, long-tail/surprise, synthesis):

| Shape | Proxy intersection rate |
|---|---:|
| **R24 hybrid (recommended)** | **0.8** |
| mark-and-rank | 0.8 |
| dual-layer-episodic-semantic | 0.8 |
| source-tiered-policy | 0.6 |
| multi-stage-cascade | 0.6 |
| summarize-then-discard | 0.6 |
| embedding-clustering-novelty | 0.4 |
| filter-at-promote | 0.2 |
| retrieval-decay-feedback | 1.0 (proxy artifact of admit-all-at-1.0) |
| query-time-only | 0.0 |

(The full cross-check report was a working document and is not part of this repository.)

### A.3 Judge re-ranking under GAP-1

| Lens | Winner | Hybrid score | Next best |
|---|---|---:|---|
| Correctness | R24 hybrid | 8/10 | mark-and-rank 7 |
| Ops-cost | R24 hybrid | 7/10 | mark-and-rank 7 (filter-at-promote 9 but rejected on correctness) |
| User-utility | R24 hybrid | 8/10 | mark-and-rank 7, dual-layer 7 |

All three judges converge on the same graft: bolt the decay-feedback columns onto the hybrid at zero weight to close the long-tail MISS without sacrificing Stage-0 privacy, byte-idempotent re-weighting, or write-path determinism. Brutalist verdict: SYNTHESIS_READY; GRAFT_DECAY_FEEDBACK_COLUMNS_ONTO_HYBRID; one MEDIUM defect (CP-5 Trigger A conflated column-add with scoring-use) — closed in this revision by hoisting column-add to R25 ship.
