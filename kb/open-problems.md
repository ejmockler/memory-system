# Open problems

What we have not solved. Each is a genuine product risk, not a TODO.

## 1. Salience filter evaluation at N=1

One user. Cannot A/B. The replay set is the proposed answer — labeled data accumulated through use. Sub-questions:

- How much data before the filter is stable? Probably weeks to months.
- Bootstrapping strategy with no data? Conservative heuristics + per-event LLM judge call for the first ~1000 events.
- Detecting filter drift from current preferences? Probably requires periodic explicit "is this still right" check-ins.

This is the genuine product risk. The replay set is hopeful, not proven.

## 2. Which-operation classifier

When the user says "forget that," is it `exclude`, `replace`, `substitute`, or `excise`? This is the actual UX surface.

Proposed pattern: **propose-back** — the agent surfaces its interpretation and asks for confirmation. Sub-questions:

- Where does the proposal live (in-conversation? side-channel? settings UI?)
- How quickly does the system learn defaults so propose-back becomes propose-once for common patterns?
- What about high-confidence vs. ambiguous cases — skip propose-back when confidence is high?

## 3. Third-party consent at ingestion

Slurping the user's Telegram contacts' messages and emails from others — those parties never consented to your remembering. `source_policy.consent_basis` is the declared field. Open:

- What does `third_party_inferred` actually mean operationally? Cap on retention? Cap on what surfaces in recall?
- If a third party later objects, can the user excise that party's content cleanly? Yes via excise + derivation graph propagation, but it needs testing under load.
- Does the salience filter need consent-aware caps on third-party content even when the user wants it kept?

## 4. Silent excise vs recall-as-event paradox (resolved)

"Recall is logged" + "some excisions must leave no trace" contradict if the excised memory was ever recalled. The recall log itself encodes the memory's existence.

**Resolved via the two-recall-logs option.** The observable recall log is keyed by `{recall_id, memory_id}` and supports surgical row deletion under `silent: true`. A separate private damping log, keyed by `{memory_id, turn_window}` and never inspected by any tool other than the recall scorer, retains the surfacing and engagement signal so co-bucketed memories' reinforcement is unaffected by an excise.

The earlier "drop the bucket" default was rejected during an adversarial design review — it discarded damping state for up to `RECALL_MAX_ITEMS - 1` unrelated co-surfaced memories per affected brief, silently mis-ranking them. Adopting the two-logs split costs one extra append-only file and removes the collateral data loss.

See `mcp-surface.md` § memory_excise for the spec.

## 5. Predicate language is a hopeful sketch

Feature-vector + entity-tag predicates for `exclude` are cheap and inspectable. But:

- "Anything about my ex" works if "my ex" is an extracted entity. What about "anything that feels like it's from that period of my life"? No entity, only fuzzy embedding.
- Predicates accumulate. After 100 `exclude` operations, recall does 100 vector compares per candidate. Mostly fine, but eventually needs a predicate index.
- User editability: captured features need to be human-inspectable so the user can refine "no, exclude that broader pattern."

## 6. Reconsolidation policy

Each recall is a rewrite of the recalled memory in the agent's working understanding. The `reconstructed` kind exists in the ledger to capture this, but the trigger is unclear:

- Agent summarizations during a conversation should produce `reconstructed` events.
- Pure read-and-cite recalls should not.
- The boundary is fuzzy and will need tuning.

## 7. Index discrimination decay model

The principle says "the index erodes." The operationalization (top-K gap threshold for density flag) is one observable behavior. But actual erosion depends on:

- How many memories share a neighborhood (organic — happens over time)
- Whether the embedding model itself is stable across upgrades

Embedding model upgrades are an underestimated risk. Re-embedding the ledger is mechanically fine, but the prior recall trace and prior `exclude` predicate captures may stop making sense under a different embedding geometry. Tag every embedding with model+version; store old and new during transition; allow gradual cutover.

## 8. Damping calibration

Engagement-gated reinforcement is the right *shape*, but the constants are unknown:

- How many turns is "recent" for the anti-reinforcement penalty?
- What counts as engagement? Direct response, paraphrase, contradiction, all of the above?
- How much should engagement boost vs. how much should raw surfacing penalize?

These will need to be tuned through use; the framework supports it but the numbers are not pre-determined.

## 9. Distillation hook latency vs. freshness

The distillation hook runs *outside* the conversation thread. This is correct (avoids inline cost) but creates a window where the just-ended conversation's facts are not yet in the memory ledger. If the user immediately starts a new conversation, recall won't see the prior conversation's content.

Options:
- Eager partial distillation per turn for "remember this" explicit signals
- Lazy full distillation per conversation end
- Mid-conversation tagged events that promote immediately

Probably all three, layered. Not yet specified.
