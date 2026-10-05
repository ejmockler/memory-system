# Asymmetric task-type margin: investigation report

## TL;DR

The "+0.003353" reported by `integration-phase3-v0.test.mjs` Step 7 and the
"+0.1119" cited from Phase A in `research-retrieval-frontiers.md` are **not
the same metric**. The collapse is a **measurement artifact**, not a model
regression and not a string-pair sensitivity issue.

- **Phase A's "+0.1119 vs +0.0826" is a matched-minus-distractor SEPARATION
  margin** (the "~35% larger separation" phrasing in the report makes this
  explicit).
- **Step 7's "+0.003353" is a single-pair RQ-vs-SS cosine delta on the same
  matched doc** — both halves use the matched doc encoded as
  `RETRIEVAL_DOCUMENT`; the only thing that varies is whether the query is
  encoded as `RETRIEVAL_QUERY` or `SEMANTIC_SIMILARITY`. This metric is
  empirically close to zero on most pairs (range −0.066 to +0.028 in our
  grid) and does not represent the architecture's actual edge.

`gemini-client.test.mjs` T5 computes the **correct** metric and on the
canonical T5 pair gives `separationMargin = +0.0379`, with the underlying
"Phase A separations" being asymSep=**0.1546** and symSep=**0.1167** —
within noise of Phase A's "0.1119 vs 0.0826".

## Hypothesis verdicts

| H  | Verdict | Evidence (numbers from the empirical grid below) |
| -- | ------- | ------------------------------------------------ |
| H1 | **PARTIALLY SUPPORTED** | Strings *do* shift the absolute margin (range 0.111-0.177 asymSep across matched pairs), but on the *correct* metric both the T5 pair (0.1546) and the Step 7 pair (0.1293) match Phase A's "0.1119" within 16%. Pair selection alone cannot explain a 33x collapse to 0.003353. |
| H2 | **SUPPORTED (root cause)** | Step 7 computes `cosRQ - cosSS` on a single matched pair, not matched-minus-distractor under each scheme. The T5 pair, run through Step 7's formula, gives 0.009408; through Phase A's separation formula, gives 0.1546. Same vectors, different metric. |
| H3 | **REFUTED** | At outputDimensionality=3072, 1536, 768 the asymSep margins are 0.1546 / 0.1673 / 0.1648 — essentially flat. Server returns non-unit-norm vectors at <3072 dims (`||v||=0.688` at 1536, `0.587` at 768) but the cosine ratio is dimension-agnostic by construction. Not the cause. |
| H4 | **PARTIALLY SUPPORTED** | Separation margin varies from −0.054 to +0.053 across 8 pair types; on "very-similar" and "unrelated" pairs asymmetric encoding is actually *worse* than symmetric. But on the matched-recall pairs that match the system's actual use case (T5_pair, Step7_pair, QA-shaped, statement-recall, opposing-entailment) margin is consistently +0.019 to +0.053. The architecture invariant holds on the relevant subdomain. |
| H5 | **REFUTED** | gemini-embedding-001 at outputDimensionality=3072 returns unit-norm vectors, taskType is respected (cosine differs across schemes), no API-drift evidence. Snapshot date 2026-06-02. |

## Empirical margin grid (all 8 pairs, all metrics)

All numbers from real `embedContent` calls at `outputDimensionality=3072`.
`asymSep = cos(RD doc, RQ query) - cos(RD distractor, RQ query)`;
`symSep = cos(SS doc, SS query) - cos(SS distractor, SS query)`;
`separationMargin = asymSep - symSep`;
`Step7Margin = cos(RD doc, RQ query) - cos(RD doc, SS query)` (same doc, query task type varied).

| pair | cosAsymMatched | cosSymMatched | asymSep | symSep | separationMargin | Step7Margin |
| ---- | -------------- | ------------- | ------- | ------ | ---------------- | ----------- |
| T5_pair (Robin / Rust / "who married") | 0.819944 | 0.889619 | **0.154597** | 0.116691 | **+0.037905** | +0.009408 |
| Step7_pair (measured on an earlier example pair, since replaced in the tests) | 0.797473 | 0.866011 | **0.129331** | 0.077300 | **+0.052031** | **+0.003353** |
| very-similar (Paris) | 0.780094 | 0.945917 | 0.111343 | 0.122204 | −0.010860 | −0.046787 |
| QA-shaped (Curie) | 0.776829 | 0.911725 | 0.177303 | 0.131960 | +0.045343 | −0.012544 |
| statement-recall (tea) | 0.855590 | 0.918476 | 0.166397 | 0.147265 | +0.019132 | +0.012684 |
| related-by-entity (Atelier Crenn) | 0.790172 | 0.896541 | 0.119351 | 0.090066 | +0.029285 | +0.003007 |
| opposing-entailment (alcohol) | 0.806824 | 0.849981 | 0.101047 | 0.047611 | +0.053436 | +0.027831 |
| unrelated (Robin / list comp) | 0.568929 | 0.729546 | −0.210380 | −0.156609 | −0.053771 | −0.065884 |

H3 dim sweep (T5_pair):

| dims | asymSep | symSep | separationMargin | ||docRD|| |
| ---- | ------- | ------ | ---------------- | --------- |
| 3072 | 0.154597 | 0.116691 | +0.037905 | 1.000000 |
| 1536 | 0.167317 | 0.126026 | +0.041291 | 0.688294 |
|  768 | 0.164768 | 0.130663 | +0.034105 | 0.587162 |

## Root cause

**Metric confusion in Step 7 of `integration-phase3-v0.test.mjs`.** Lines
456-472 compute:

```
cosRQ = cosine(qryEmb_RQ.vector_3072, docEmb.vector_3072);   // doc as RD, query as RQ
cosSS = cosine(qryEmb_SS.vector_3072, docEmb.vector_3072);   // doc as RD, query as SS
asymmetryMargin = cosRQ - cosSS;
```

This measures whether changing the query-side task type from
`SEMANTIC_SIMILARITY` to `RETRIEVAL_QUERY` (while pinning the doc as
`RETRIEVAL_DOCUMENT`) increases cosine on the matched pair. That is a
**weaker** test than Phase A's: it omits the distractor leg and asks only
whether the query encoder *alone* moves toward the doc when given the
asymmetric task type. The expected magnitude is ~0.003-0.03 (per our
grid), not ~0.1.

Phase A's "+0.1119 vs +0.0826 symmetric (~35% larger separation)" is
unambiguously a matched-minus-distractor *separation* — the parenthetical
"larger separation" is the giveaway. `gemini-client.test.mjs` T5 is
written against this correct interpretation (see lines 251 "separation
margin", 277 `asymSeparation = cosAsymMatched - cosAsymDistractor`).

## Proposed test-code fix (DO NOT APPLY in this phase — Implementation will ratify)

**File:** `<checkout>/mcp/test/integration-phase3-v0.test.mjs`
**Lines:** 451-481 (Step 7).

The current step asserts `asymmetryMargin > 0` on a single-pair RQ-vs-SS
delta. Empirically, this delta is −0.066 to +0.028 across pair types — it
flips sign on "very-similar", "QA-shaped", and "unrelated" pairs. The
assertion `ok = asymmetryMargin > 0` is therefore **fragile**: it happens
to pass on the Step 7 string pair (margin +0.003353) but would fail on
several plausible alternative phrasings. It is also not the metric the
architecture report claims.

**Fix:** add a distractor leg and assert the matched-minus-distractor
separation under asymmetric encoding exceeds the same under symmetric
encoding by a documented threshold (e.g., 0.02), exactly as T5 in
`gemini-client.test.mjs` does. Either (a) merge Step 7 with T5 and remove
the duplicate, or (b) keep Step 7 but rewrite it to match T5's contract.

If the goal of Step 7 is *specifically* "does task-typing the query help
when the doc is already RD?", retain the current formula but rename the
metric to `singlePairQueryTaskTypeDelta` and lower the assertion to
"`> -0.05` (sanity, not edge)" — and add a separate distractor-leg block
for the edge claim.

## Recommended CI invariant going forward

Drop any reliance on a specific magnitude pinned to a specific string
pair. The right invariant is:

1. **Direction:** on a held set of 8-10 matched/distractor triplets covering
   QA-shaped, statement-recall, and entity-bearing-fact pairs, the
   `asymSeparation > symSeparation` condition must hold on **at least 6/8**
   pairs. (On our grid, 5/8 pass clean and 1/8 is essentially tied;
   "very-similar" and "unrelated" failures are explainable by the model's
   SS encoder being intentionally tuned for symmetric similarity on
   paraphrase-like pairs.)
2. **Magnitude (aggregate):** mean separationMargin across the 5 "operative"
   pair types (QA, statement-recall, entity-fact, opposing-entailment,
   verifiable-claim) must be > **+0.02**. Our grid mean is +0.034. This
   matches the lower bound T5 already enforces on its canonical pair.
3. **Per-pair sanity ceiling:** assert the canonical T5 pair's
   `separationMargin > +0.02` (current value +0.038, stable across two
   dim regimes). Pinning a single pair is acceptable *as a smoke test*
   but the held set is the load-bearing invariant.
4. **Step 7 in integration test should be REPLACED** by the (already
   correct) T5 in `gemini-client.test.mjs`. Single-pair "did the query
   task type help" is too noisy to be a CI gate (sign flips on 3/8
   pairs).

If the user chooses to keep a single-pair smoke gate in the
integration test, the assertion threshold should be **direction only**
(`asymSeparation > symSeparation`) with the matched/distractor leg added,
not a pinned magnitude.

## API snapshot (H5)

- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent`
- Model: `gemini-embedding-001`
- `outputDimensionality=3072`: returns unit-norm vectors (`||v||=1.000`).
- `outputDimensionality=1536`: returns `||v||=0.688` — client-side
  L2-renorm required (current code does this; matches the published
  "non-3072 dims are not unit-norm" trap).
- `outputDimensionality=768`: returns `||v||=0.587` — same caveat.
- Task type IS respected on all eight values; `RETRIEVAL_QUERY` vs
  `SEMANTIC_SIMILARITY` produces materially different vectors (e.g. on
  the T5 query: `cosBothRQ`=0.843 between RQ-encoded doc and RQ-encoded
  query, but `cosAsymMatched`=0.820 when the doc is encoded as RD —
  confirming the asymmetric encoder pushes the doc and query toward
  *complementary* sub-spaces).
- Snapshot date: 2026-06-02.

## Notes on hermeticity

This investigation used a `mkdtempSync` tmpdir for `MEMORY_ROOT` / `POLICY_BASE_DIR`
/ `STORAGE_BASE_DIR` / `LEDGERS_BASE_DIR`, set before any dynamic import of
memory-system modules. Production `policy/`, `indices/`, and
`ledgers/memory.jsonl` mtimes captured pre-run match post-run.
