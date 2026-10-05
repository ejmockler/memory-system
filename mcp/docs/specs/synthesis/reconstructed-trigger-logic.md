# Reconstructed-Event Trigger Logic (Runtime Behavior)

> Behavior contract — `F-SYN-BEHAVIOR-reconstructed-trigger-logic`.
> Implements the agent-tier WHEN gate that complements the W7 foundation
> contract (`reconstructed-trigger.md`) and the W8 MCP tool surface
> (`distill-emit-reconstructed.js`).
> Resolves the runtime half of `open-problems.md #6`.

---

## Mission

The W7 foundation contract pinned **HOW** a reconstructed event lands —
the screened validator+appender (`reconstruction-emitter.js`), the two
authorized callers, the per-mode idempotency keys, the consent walk over
parent source_refs. The W8 MCP tool exposes the agent-facing surface.
This spec pins **WHEN** the agent should bother calling the screen at
all.

The operational question is sharp: the agent has just executed a
`memory_recall`, sees N facts in the brief, and is mid-conversation. It
has formulated a sentence that recombines or summarizes those facts.
Should it emit a `kind:"reconstructed"` row, or is the synthesis a
trivial paraphrase that does not earn a durable derivative?

The advisor (`lib/synthesis/reconstructed-trigger-advisor.js`) answers
that question with a closed three-state response:

1. `{emit: true,  reason: "ok_to_emit"}` — the W7 emitter should be called.
2. `{emit: false, reason: <gate code>}`  — the synthesis is not worth a durable row.
3. `{emit: false, reason: "advisor_error"}` — defensive degradation;
   conservative bias toward NOT emitting on uncertainty.

The advisor is **PRE-EMIT** and **OPTIONAL**. It does NOT replace the
screen. The W7 emitter's R3 not-excised gate, R8 idempotency key, and
parent-existence checks are unchanged. The advisor's purpose is to save
the agent a round-trip — and the system a wasted token mint + nonce
burn — when the answer is obviously "no". It is a structural hint, not
an authority.

---

## kb anchors

### A1. `open-problems.md #6 Reconsolidation policy` (verbatim)

> Each recall is a rewrite of the recalled memory in the agent's working
> understanding. The reconstructed kind exists in the ledger to capture
> this, but the trigger is unclear:
>
> - Agent summarizations during a conversation should produce
>   reconstructed events.
> - Pure read-and-cite recalls should not.
> - The boundary is fuzzy and will need tuning.

**Binding.** This spec converts the "boundary is fuzzy" question into a
mechanical algorithm with four gates and four operator-tunable CAPS
thresholds. The "will need tuning" caveat is honored — every gate is
exposed as a `TRIGGER_CAPS.*` knob; the V0 thresholds (0.6, 0.8, 0.92)
are explicitly called out as initial guesses below.

### A2. `docs/specs/synthesis/reconstructed-trigger.md § R4 (confidence floor)`

> If `input.confidence < CAPS.RECONSTRUCT_MIN_CONFIDENCE` (default 0.6)
> → reject with `code: LOW_CONFIDENCE`.

**Binding.** The advisor's `CONFIDENCE_MIN` mirrors the emitter's
floor byte-for-byte (default 0.6). The advisor returning
`below_confidence_min` short-circuits a round-trip that would have
landed at the emitter's `LOW_CONFIDENCE` reject.

### A3. `reconstructed-trigger.md § R5 (PURE_CITATION refusal)`

> Triggered iff `input.parents.length === 1` AND
> `normalized_edit_similarity(content, parent.content) > 0.85`.

**Binding.** The advisor's `pure_paraphrase` gate uses token-set Jaccard
(cheaper than Levenshtein, order-insensitive on word-bag) at threshold
0.8 — intentionally LOWER than the emitter's 0.85 edit-similarity gate
so the advisor never recommends "emit" on a payload the W8 classifier
would reject as `PURE_CITATION`. The advisor is a strict pre-screen.

### A4. `reconstructed-trigger.md § R8 (idempotency)`

> Computed via S4 (agent) or S5 (daemon). On match → return prior
> `memory_id` with `dedupe_action: "rejected_idempotent"`.

**Binding.** The advisor's `near_duplicate_exists` gate scans the SAME
{conversation_id, parent_set_hash} domain the W7 emitter's S4 key
collapses to. If any prior reconstructed row's content has token-set
Jaccard > 0.92 with the candidate, the advisor short-circuits — the W7
emitter would have hit either the S4 key match (exact dup) or, with a
single-byte edit slipping past `content_hash`, would still write a row
that the recall layer would surface alongside the near-duplicate
original, polluting the brief.

### A5. `thesis.md Principle 7` (binding restated)

> Mutation goes through a narrow MCP surface that validates, screens,
> attaches provenance, deduplicates, applies policy.

**Binding.** The advisor is NOT mutation. It is a read-only hint. It
does not append to the ledger, the policy stream, or any other surface.
The screen integrity invariant of W7 (single-emitter; CI grep gate) is
unaffected.

---

## Trigger gates (4-of-4)

The advisor runs four gates in order. The first gate that fails returns
its reason code; later gates are not consulted. The ordering minimizes
work: cheapest check first (confidence is a single number compare),
most expensive check last (ledger scan).

| # | Gate                  | CAPS key                       | V0 default | Cost            | Reason on fail               |
|---|-----------------------|--------------------------------|------------|------------------|------------------------------|
| 1 | Confidence floor      | `CONFIDENCE_MIN`               | 0.6        | O(1)             | `below_confidence_min`       |
| 2 | Pure paraphrase       | `PARAPHRASE_OVERLAP_THRESHOLD` | 0.8        | O(|tokens|)      | `pure_paraphrase`            |
| 3 | Near-duplicate scan   | `NEAR_DUP_THRESHOLD`           | 0.92       | O(ledger × tokens) | `near_duplicate_exists`    |
| 4 | All-clear             | —                              | —          | O(1)             | `ok_to_emit` (emit: true)    |

### Gate 1 — Confidence floor

The agent self-reports `confidence ∈ [0, 1]` at the call site. If
`confidence < TRIGGER_CAPS.CONFIDENCE_MIN`, the advisor short-circuits
with `below_confidence_min`. The W7 emitter would have rejected the
same payload at R4 with `LOW_CONFIDENCE`; the advisor saves the
round-trip + token mint.

**Edge case** — `confidence` is exactly equal to the floor: ACCEPT.
The W7 emitter uses `< floor` (strict less-than) at R4; the advisor
mirrors. A floor of 0.6 admits 0.6 exactly.

### Gate 2 — Pure paraphrase (single-parent only)

Triggered ONLY when `parents.length === 1`. The advisor computes
token-set Jaccard between `content` and `parents[0].content`. If the
Jaccard exceeds `PARAPHRASE_OVERLAP_THRESHOLD` (default 0.8), the
advisor rejects with `pure_paraphrase`.

**Why token-set Jaccard, not Levenshtein.** The W7 emitter spec § R5
uses `normalized_edit_similarity` (Levenshtein over normalized
strings). The advisor is on the hot path of EVERY agent emit
consideration — Levenshtein is O(|a|×|b|) and prohibitively expensive
for the advisor's intended call rate. Token-set Jaccard is
O(|a|+|b|), word-order-insensitive, and a reasonable proxy for "the
agent is just restating the parent with different words". The
permissiveness margin (advisor at 0.8 vs emitter at 0.85) ensures the
advisor never recommends "emit" on a payload the emitter would reject.

**v1 roadmap.** Swap token-set Jaccard for Gemini-embedding cosine when
the embedding hot path is cheap enough to call inline. Operator
recalibration: tune `PARAPHRASE_OVERLAP_THRESHOLD` against logged
labels from the held-out set (`held-out-labeled-set.md`).

**Edge case** — parent content is null/missing: SKIP the gate (proceed
to Gate 3). The advisor cannot diagnose paraphrase without the parent
body. The W8 MCP tool handler has the bodies in hand from the prior
recall; if it called the advisor without them, the advisor degrades
gracefully.

### Gate 3 — Near-duplicate of existing reconstructed row

The advisor scans the memory ledger for prior `kind:"reconstructed"`
rows inside the `{conversation_id, parent_set_hash}` idempotency
domain — the same domain the W7 emitter's S4 key collapses to. For
each candidate, computes token-set Jaccard against the new content.
If the maximum Jaccard exceeds `NEAR_DUP_THRESHOLD` (default 0.92),
the advisor rejects with `near_duplicate_exists`.

**Why this matters even though the W7 emitter has R8 idempotency.**
R8 uses an exact `content_hash` match. A single-byte edit on the
content slips past R8 — the agent re-emits "Operator keeps SampleBot
LX-2 unit." vs the prior "Operator keeps the SampleBot LX-2 unit."
and both rows land on the ledger. The recall layer then surfaces
both, polluting the brief. The advisor's near-dup gate catches this
class at advisory time.

**Defensive degradation.** Any ledger read failure (missing file,
torn JSON, I/O error) collapses to "no near-dup observed" — the
advisor proceeds to Gate 4. This is the W7-aligned discipline: a
runtime hot-path advisor MUST NOT fail-shut on transient I/O. The
W7 emitter still runs its own R8 check on the actual write path.

**`conversation_id` scoping.** When `conversation_id !== null`, the
advisor scopes the scan to rows from the same conversation
(matching the agent-path S4 key domain). When `conversation_id`
is null (daemon-style call), the advisor scopes only by
`parent_set_hash`, matching the daemon-path S5 domain.

### Gate 4 — All-clear

`emit: true`, `reason: "ok_to_emit"`, `advisory_score: confidence`.
The integration tier plumbs `advisory_score` into telemetry.

---

## Algorithm pseudo-code

```
function shouldEmitReconstruction(input):
  try:
    # ---- shape pre-checks ----
    if input is not object or missing required fields:
      return {emit: false, reason: "advisor_error", advisory_score: 0}

    # ---- Gate 1: confidence ----
    if input.confidence < CONFIDENCE_MIN:
      return {emit: false, reason: "below_confidence_min",
              advisory_score: clamp(input.confidence, 0, 1)}

    # ---- Gate 2: pure paraphrase (single-parent only) ----
    if input.parents.length == 1:
      parent_content = input.parents[0].content
      if parent_content is not null:
        overlap = tokenSetJaccard(input.content, parent_content)
        if overlap > PARAPHRASE_OVERLAP_THRESHOLD:
          return {emit: false, reason: "pure_paraphrase",
                  advisory_score: overlap}

    # ---- Gate 3: near-duplicate scan ----
    parent_ids  = input.parents.map(p -> p.id)
    parent_set_h = sha256(JSON.stringify(parent_ids.sorted()))
    ledger_rows = scanLedger(input.ledgerPath)   # defensive; degrades to []
    candidates  = rows where row.kind == "reconstructed"
                          AND row.conversation_id matches input.conversation_id
                          AND parentSetHash(row.derived_from) == parent_set_h
    best_overlap = max(tokenSetJaccard(input.content, c.content) for c in candidates)
    if best_overlap > NEAR_DUP_THRESHOLD:
      return {emit: false, reason: "near_duplicate_exists",
              advisory_score: best_overlap}

    # ---- Gate 4: all-clear ----
    return {emit: true, reason: "ok_to_emit",
            advisory_score: input.confidence}

  catch any error:
    return {emit: false, reason: "advisor_error", advisory_score: 0}
```

---

## Worked examples

### Example E1 — Multi-parent synthesis worth emitting

The user's recall surfaced four facts at turn N:

- `fact_A` — "SampleBot is the LX-2 nicknamed amber-harbor."
- `fact_B` — "AcmeRaven is the LX-2 nicknamed quiet-meadow."
- `fact_C` — "The two LX-2 units share one bench in the lab."
- `fact_D` — "Jobs go over the wired en5 link; Wi-Fi is for firmware updates."

At turn N+2 the agent synthesizes:

> *"The user keeps two LX-2 units on one lab bench — SampleBot
> (amber-harbor) and AcmeRaven (quiet-meadow) — and sends jobs over the
> wired en5 link, leaving Wi-Fi for firmware updates."*

**Gate 1.** `confidence = 0.87` ≥ 0.6 → PASS.
**Gate 2.** `parents.length === 4` → gate not applicable (single-parent only).
**Gate 3.** No prior reconstructed row in the {conv_id, parent_set_hash}
domain → PASS.
**Gate 4.** Returns `{emit: true, reason: "ok_to_emit", advisory_score: 0.87}`.

The agent calls the W7 emitter via the W8 MCP tool. A new
`kind:"reconstructed"` row with `derived_from: [fact_A, fact_B, fact_C,
fact_D]` lands on the ledger.

### Example E2 — Paraphrase that should NOT emit

The user's recall surfaced one fact at turn N:

- `fact_X` — "The AcmeRaven unit keeps a quiet-meadow nickname."

At turn N+1 the agent synthesizes:

> *"AcmeRaven keeps a quiet-meadow nickname."*

**Gate 1.** `confidence = 0.95` ≥ 0.6 → PASS.
**Gate 2.** `parents.length === 1`. Token-set Jaccard between content
and `fact_X.content`:
- candidate tokens: `{acmeraven, keeps, a, quiet-meadow, nickname}`
- parent tokens:    `{the, acmeraven, unit, keeps, a, quiet-meadow, nickname}`
- intersection: 5; union: 7; Jaccard = 0.714.
- 0.714 ≤ 0.8 → PASS (the advisor is permissive here; the W8
  classifier's tighter 0.85 edit-similarity gate would still likely
  refuse). The advisor's bias is "don't reject what the screen would
  accept". The W8 classifier is the authoritative paraphrase gate.

For an even tighter paraphrase:

> *"AcmeRaven unit keeps a quiet-meadow nickname."*

- candidate tokens: `{acmeraven, unit, keeps, a, quiet-meadow, nickname}`
- parent tokens:    `{the, acmeraven, unit, keeps, a, quiet-meadow, nickname}`
- intersection: 6; union: 7; Jaccard = 0.857.
- 0.857 > 0.8 → REJECT with `pure_paraphrase`. The agent skips the
  emit; no token mint, no nonce burn.

### Example E3 — Near-duplicate of an existing reconstructed row

The user has, from a prior conversation in the same `conv_id`,
already emitted a reconstructed row over `{fact_A, fact_B}`:

- `rec_prior.content` — "The user runs two LX-2 units from
  Acmebot in the lab, with the wired link as the default route."

The agent now considers re-emitting over the same parent set with
slightly different phrasing:

> *"Operator runs two LX-2 units from Acmebot in the lab; the wired
> link is the default route."*

**Gate 1.** `confidence = 0.9` ≥ 0.6 → PASS.
**Gate 2.** `parents.length === 2` → gate not applicable.
**Gate 3.** The ledger scan finds `rec_prior` in the same
{conv_id, parent_set_hash} domain. Token-set Jaccard:
- candidate tokens: `{operator, runs, two, lx-2, units, from,
  acmebot, in, the, lab, wired, link, is, default, route}`
- prior tokens:     `{the, operator, runs, two, lx-2, units, from,
  acmebot, in, lab, with, wired, link, as, default, route}`
- intersection: 14; union: 17; Jaccard = 0.824.
- 0.824 < 0.92 → PASS (not near-dup at the advisor tier).

For a true near-dup with only a single word dropped:

> *"The user runs LX-2 units from Acmebot in the lab, with the
> wired link as the default route."*

- intersection: 15; union: 16; Jaccard = 0.9375.
- 0.9375 > 0.92 → REJECT with `near_duplicate_exists`. The W7 emitter
  would have appended a near-identical second row that R8 would not
  have caught (different `content_hash`). The advisor saves the
  pollution.

### Example E4 — Below-confidence reject

The agent's self-report:

> *"I think the user's lab is in Pittsburgh, but I'm not sure."*

`confidence = 0.45`.

**Gate 1.** 0.45 < 0.6 → REJECT with `below_confidence_min`,
`advisory_score: 0.45`. No further gates consulted.

The W7 emitter would have rejected at R4 with `LOW_CONFIDENCE`; the
advisor saves the round-trip + token mint.

---

## Cross-tier impact

The advisor is OPTIONAL at the system level:

| Tier               | Calls advisor?                                                                 | Consequence of skipping advisor                                                                                   |
|--------------------|--------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| Agent (Claude/Codex) | **SHOULD** call before invoking the W8 MCP tool                              | Without the advisor, the agent emits on every synthesis attempt; wasted token mints + nonce burns on guaranteed rejects |
| W8 MCP tool        | **MAY** call inside the handler as a pre-screen                              | The W8 classifier (`SINGLE_PARENT_SUMMARIZATION` vs `MULTI_PARENT_CORROBORATIVE` vs `PURE_CITATION`) still runs    |
| W7 emitter         | **MUST NOT** call — the emitter is the screen, not the advisor               | N/A; the emitter never calls the advisor                                                                          |
| Daemon path        | **MAY** call from aggregator admission gates                                 | The daemon's group-size + diversity + debounce gates are the daemon's screening; the advisor is a content-level    |

**Invariant.** The advisor's `emit:false` is ADVISORY. A caller that
ignores it and calls the W7 emitter anyway will hit the emitter's
own gates (R3 not-excised, R4 confidence, R8 idempotency, consent
walk). The advisor does NOT replace any of those. The screen integrity
invariant — single emitter, single MCP tool surface — is preserved.

**Telemetry.** Each advisor call is a candidate dashboard signal: the
integration tier MAY log `{advisor_version, reason, advisory_score,
caller_id}` to a future `policy.advisor.consulted` event stream. The
v0 ship does NOT introduce a new policy_kind (single-producer CI test
unaffected). The dashboard wiring is a v1 extension.

---

## CAPS table

```ts
TRIGGER_CAPS = Object.freeze({
  CONFIDENCE_MIN: 0.6,                  // mirrors W7 § R4 emitter floor
  PARAPHRASE_OVERLAP_THRESHOLD: 0.8,    // strictly LOOSER than W7 § R5 (0.85
                                        // edit-sim) so advisor never says
                                        // "emit" on what emitter would reject
  NEAR_DUP_THRESHOLD: 0.92,             // tightest gate; only fires when two
                                        // syntheses are near-identical
});
```

**Calibration debt.** All three thresholds are v0 initial guesses. The
operator recalibrates against the held-out labeled set
(`held-out-labeled-set.md`). The advisor MUST be invoked through the
`TRIGGER_CAPS.*` lookup — literal numbers in caller code are a
conformance failure (same discipline as the W7 emitter's
`RECONSTRUCT_MIN_CONFIDENCE` lookup through `CAPS`).

---

## Open questions

**O1.** Should the advisor's `pure_paraphrase` gate use the same
`normalized_edit_similarity` as the W8 classifier instead of token-set
Jaccard? Trade-off: Levenshtein is exact but O(|a|×|b|); Jaccard is
O(|a|+|b|) but word-order-insensitive. v0 ships Jaccard; v1 may add a
parallel edit-sim path when the user has labels to calibrate the
two thresholds against each other.

**O2.** Should `near_duplicate_exists` rejects ever be surfaced to the
agent as a hint with the prior `memory_event_id`, so the agent can
cite the existing row instead of re-emitting? The W7 emitter already
returns `prior_memory_id` on R8 dedupe; the advisor returning the same
shape would let the agent skip the emit AND immediately cite. v0 does
NOT include this — keeps the advisor's return shape minimal. v1
roadmap.

**O3.** Aggregator caller class. The daemon path's content is composed
by Gemini Flash against an aggregator-curated group; the advisor's
near-dup gate is still useful there (a Flash composition could
overlap an existing aggregator row). The daemon path SHOULD call the
advisor with `conversation_id: null` (matching the S5 domain). v0
documents this binding; the daemon wiring node (separate WU) is
responsible for the call site.

---

## Conformance

- `lib/synthesis/reconstructed-trigger-advisor.js` exports
  `TRIGGER_ADVISOR_VERSION`, frozen `TRIGGER_CAPS`, and the single async
  `shouldEmitReconstruction` function.
- All thresholds read from `TRIGGER_CAPS.*`, never hardcoded in callers.
- Every cross-module call (`scanLedgerLines`, `tokenSetJaccard`) is
  wrapped in try/catch; defensive degradation > fail-shut on the
  runtime hot path.
- The advisor does NOT write to the memory ledger, the policy event
  stream, the recall log, or any other persistence surface.
- The advisor does NOT introduce a new `policy_kind` value.
- Test suite: `test/synthesis/reconstructed-trigger-advisor.test.mjs`
  exercises all four reason codes plus the defensive degradation path,
  with ≥ 12 assertions.
