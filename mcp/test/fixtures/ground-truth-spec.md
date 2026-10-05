# Ground-Truth Holdout Set — Specification

This document defines the operator-driven ground-truth labelled holdout set used to measure **precision** and **recall** of corpus-reduction rules (Stage-0 drops, dedup rules, noise filters, etc.).

Without this set, every reduction percentage we report is computed against current corpus self-similarity — i.e. "we dropped N rows", not "of the rows we dropped, how many were actually noise, and of the noise rows present in the corpus, how many did we catch?". Drop volume alone is a vanity metric. This spec establishes the data structure and sampling methodology to replace it.

The companion file `ground-truth-labels.json` is the data container; it ships empty and is populated by the operator in a single labelling session per the protocol below.

---

## 1. Label values

Exactly five labels are permitted. Each row in the holdout set receives exactly one.

| Label        | Definition                                                                                                                                                            |
|--------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `high_value` | The operator would want this row surfaced in retrieval. Losing it would be a real loss. This is signal we are trying to preserve.                                     |
| `low_value`  | The operator would not mind losing this row. It is not noise — it is real — but it carries no retrieval value, and dropping it would not cause regret.                |
| `noise`      | The row should never have been ingested. System chatter, status pings, automated boilerplate, prompts the connector mis-classified as content, etc.                   |
| `redundant`  | The signal in this row exists in another row in the corpus. The information is real and possibly valuable, but this specific row is a duplicate / near-duplicate.     |
| `broken`     | Data quality issue. Malformed row, encoding corruption, truncated payload, schema violation, parser error survivor. Distinct from `noise` — `noise` is correctly parsed but useless; `broken` is incorrectly parsed.  |

Precision and recall are then computed per-rule against these labels. For example: a "drop screentime rows shorter than 12 chars" rule has true-positive = labelled `noise` or `broken` rows it dropped; false-positive = labelled `high_value` or `low_value` rows it dropped; false-negative = labelled `noise`/`broken` rows it did not drop.

---

## 2. Schema (one entry in `labels[]`)

```json
{
  "source_msg_id": "string — the connector-emitted stable id for the row",
  "source":        "string — one of: git-log | imessage | screentime | github-events | codex-cli",
  "text_snippet":  "string — PII-redacted, max 200 chars, see Section 5",
  "label":         "high_value | low_value | noise | redundant | broken",
  "labeled_at":    "string — ISO-8601 timestamp, e.g. 2026-06-07T14:32:00Z",
  "labeler_notes": "string | null — optional free-text rationale, e.g. 'duplicate of source_msg_id=abc123'"
}
```

All six fields are required. `labeler_notes` may be `null` but must be present.

---

## 3. Target size and stratified sampling

**Total: 200 rows. Hard cap.** Larger sets bleed into multi-session labelling, which causes drift (see Section 4).

Stratification is two-level: first by source (5 sources × 40 rows = 200), then within each source by stratum (4 strata × 10 rows = 40 per source).

### Per-source allocation (40 rows each)

| Source          | Count |
|-----------------|-------|
| `git-log`       | 40    |
| `imessage`      | 40    |
| `screentime`    | 40    |
| `github-events` | 40    |
| `codex-cli`     | 40    |

All five sources must be represented. Do not over-sample one source to compensate for under-sampling another — that destroys cross-source comparability of precision/recall.

### Per-stratum allocation (10 rows each, within one source)

| Stratum                   | Count | Sampling rule                                                                                                                    |
|---------------------------|-------|----------------------------------------------------------------------------------------------------------------------------------|
| `random`                  | 10    | Uniform random sample across all rows from this source in the corpus. Establishes a baseline.                                    |
| `high_structural_score`   | 10    | Top-decile rows by the structural-quality score that the ingestion pipeline already computes. Should be enriched for signal.     |
| `dedup_candidates`        | 10    | Rows the dedup machinery flagged as near-duplicates of another row. Tests the redundancy detector.                               |
| `recent`                  | 10    | Most-recent 10 rows (by source timestamp) from this source. Catches regression in recently-changed connectors.                   |

Stratifying this way means a precision/recall measurement at the rule level can be decomposed: a rule that has 95% precision on `random` but 40% precision on `dedup_candidates` is over-fitting to surface noise and missing the duplicate problem.

Rare-but-important categories (e.g. a connector that only emits 5 rows total) are under-represented by this scheme. That is a known limitation; document any source where the stratum quota cannot be met and pad the random stratum to compensate.

---

## 4. Labelling session protocol

The operator labels the holdout set in **a single uninterrupted session**. This is the most important constraint in this spec.

Rationale: the definitions of `high_value` vs `low_value` drift over the course of a long session. The operator at hour 1 has a sharper internal model of "what would I want surfaced" than the operator at hour 6, and across multiple sessions the model resets entirely. Multi-session labelling produces ground-truth noise that pollutes downstream precision/recall numbers — at which point the holdout set is worse than nothing because it gives false confidence.

Practical rules:

1. **One session, ≤ 200 rows.** If the operator cannot finish 200 rows in one sitting, ship 150 or 100 — do not split across sessions.
2. **No more than 200 rows total.** Even split across sessions, larger sets drift more than they sharpen.
3. **Pre-shuffle rows.** Labels are assigned to rows in random order, not source-by-source or stratum-by-stratum. This prevents the operator from acclimating to "screentime mode" and applying a screentime-specific bar.
4. **No re-labelling.** Once a row is labelled, do not revisit. Re-labelling is itself drift.
5. **Record `labeled_at` per row, not per session.** This lets us audit drift retroactively — if `high_value` rate drops monotonically across `labeled_at` we know the operator fatigued.
6. **Capture `labeler_notes` whenever the call is non-obvious.** This is the single highest-leverage place to add free-text, because the rationale is needed when a rule disagrees with the label later.

---

## 5. PII redaction (mandatory, before labelling)

`text_snippet` is **redacted before the operator sees it.** This is non-negotiable.

Reasons:

- **Bias.** If the operator recognises the contact ("oh, that's a message from $person"), the label gets contaminated by relationship valence rather than signal value. The same text from an unknown sender would receive a different label.
- **Provenance leakage.** The holdout set lives in `test/fixtures/` and may be reviewed, snapshotted, or shared. Raw PII in fixtures is a leak.
- **Operator trust.** The operator should not need to think about whether labelling will surface private content to a code reviewer or a downstream LLM.

Minimum redaction rules:

| PII type          | Redaction                                                                 |
|-------------------|---------------------------------------------------------------------------|
| Personal names    | `<PERSON>` (per-row consistent within a row, fresh per row)               |
| Phone numbers     | `<PHONE>`                                                                 |
| Email addresses   | `<EMAIL>`                                                                 |
| URLs              | `<URL>` (preserve domain only if structural to the row's semantics)       |
| Street addresses  | `<ADDRESS>`                                                               |
| Auth tokens / keys| `<SECRET>` — and verify the original row is also scrubbed from the corpus |
| Filesystem paths  | Truncate to last 2 path segments, prefix with `…/`                        |

`text_snippet` is also capped at **200 characters** post-redaction. Longer snippets do not help the labeller and increase fixture size for no benefit. Truncate with an ellipsis.

---

## 6. What this spec deliberately does not do

This node is **spec only**. Population of the 200 rows is operator work and is out of scope.

Specifically, this node does **not**:

- Run the stratified sampler. Sampling against the live corpus is a downstream task once the corpus is stable.
- Provide a labelling UI. The operator labels by editing `ground-truth-labels.json` directly (or via a tool added later).
- Compute precision/recall. That is a measurement-tier task that consumes this fixture.
- Lock the schema as immutable. `schema_version` exists in the JSON so the schema can evolve; bump it and migrate if a field changes.

---

## 7. Acceptance checklist for this spec node

- [x] JSON file `ground-truth-labels.json` exists with `schema_version`, an empty `labels: []`, and a schema description embedded.
- [x] All six required fields documented: `source_msg_id`, `source`, `text_snippet`, `label`, `labeled_at`, `labeler_notes`.
- [x] All five label values defined: `high_value`, `low_value`, `noise`, `redundant`, `broken`.
- [x] Stratified sampling plan covers all 5 sources (`git-log`, `imessage`, `screentime`, `github-events`, `codex-cli`).
- [x] Per-source stratification covers all 4 strata (`random`, `high_structural_score`, `dedup_candidates`, `recent`) at 10 rows each.
- [x] Single-session labelling protocol specified to limit drift.
- [x] PII-redaction of `text_snippet` mandated before the operator labels.
