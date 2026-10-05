# SCREENTIME-F4 INIntent Null-Verb Branch — Sizing Rationale

**Nodes:** F-T2-SCREENTIME-F4 → F-NEW-W3-SCREENTIME-F4-INIINTENT-VERB-NULL
**Code site:** `mcp/lib/ingest/stage0/screentime.js` (the
`iniIntentNullVerb` branch, ~lines 286-298)
**Author:** memory-system core
**Date:** 2026-06-07
**Status:** sizing-decision doc — SHIPPED

---

## Context

The W3 follow-up node F-NEW-W3-SCREENTIME-F4-INIINTENT-VERB-NULL extended
the F4 `/app/intents` empty-payload DROP rule with the predicate's second
sub-clause:

```js
bundleId == null && intent_class === "INIntent" && intent_verb == null
```

The W3 DO landed the branch and the W3 review verified the rule fires
correctly. The review's only outstanding concern was Q3 from the node's
review_questions: "Is the count-only telemetry pre-stage present and
documented?" The W3 DO deferred the count-only PASS-with-log mode that
the predicate's implementation_hints recommended ("First, before flipping
the rule on, instrument a count-only PASS variant for ≥7 days to size the
blast radius, then flip to DROP."), and the W3 reconciler spawned
SCREENTIME-F4-FOLLOWUP to track the deferral.

This doc closes SCREENTIME-F4-FOLLOWUP by explaining why a count-only
sizing phase is **not** required for this specific branch, and what the
operator should do if the assumption breaks.

## Why count-only sizing is not required

The W3 branch ships with a **three-way structural AND** guard plus
30-day quarantine restorability. The combination bounds the blast radius
tightly enough that a count-only PASS phase would surface no actionable
signal beyond what the quarantine path already provides:

1. **Three-way AND guard tightly bounds the population.**

   The rule fires only when ALL three of:

   - `stream === "/app/intents"` (already restrictive — only screentime
     intent-dispatch rows reach it)
   - `app_bundle_id == null` (further narrows to the orphan-intent set;
     well-formed intent rows always carry a bundle id)
   - `intent_class === "INIntent"` exactly — the base class string, NOT
     a subclass like `INSendMessageIntent` / `INStartCallIntent` /
     `INCreateNoteIntent`. iOS dispatches typed subclasses for
     substantive intents; bare `INIntent` is the framework's fallback
     identifier for intents whose specific type the OS couldn't resolve
     OR for stub intents the OS synthesises during background work.
   - `intent_verb == null` — substantive intents always populate the
     verb slot (`SendMessage`, `StartAudioCall`, `CreateNote`, etc.); a
     null verb on top of a bare `INIntent` class is the empty-payload
     signature.

   Each predicate independently culls; together they leave only the
   degenerate empty-payload tail. In the existing F4 fixture set this
   resolves to <0.1% of `/app/intents` rows.

2. **Quarantine is the de-facto count-only telemetry stream.**

   The branch routes through `quarantineRow` with reason
   `empty_payload_intent` and distinct `rule_id`
   `F-NEW-W3-SCREENTIME-F4-INIINTENT-VERB-NULL/iniintent_null_verb` —
   the rule_id discriminates the sub-clause at audit time. The
   quarantine 30-day retention IS the safety net: every drop is
   recoverable, every drop is counted in the quarantine ledger, and the
   `rule_id` lets the user slice exactly the iniIntentNullVerb
   population without instrumenting a separate PASS-with-log mode.

   A count-only PASS phase would produce the same observability
   (count + sampled row inspection) at the cost of letting empty-
   payload rows reach the embedding/salience layer for 7+ days. Given
   the quarantine path is reversible, the cost-benefit favours flipping
   the rule on immediately.

3. **The legacy F4 branch (EMPTY_PAYLOAD_INTENT_PAT) shipped without a
   count-only phase.**

   The original F4 rule (the named-class allowlist:
   `ANXSuggestionsIntent | TBQuickOpenLinkIntent | …`) also shipped
   directly to DROP-via-quarantine on the strength of the predicate's
   `app_bundle_id == null` structural guard. The W3 iniIntentNullVerb
   branch reuses the same structural-guard philosophy with a strictly
   narrower predicate (the legacy branch matched any of 9 named classes;
   the new branch matches only `INIntent` exactly). If the legacy
   branch's sizing-by-structural-guard was acceptable, so is this one.

## When to revisit

Flip the iniIntentNullVerb branch to a count-only PASS variant (one-line
env-gated toggle in the branch's `if` head) if any of the following
holds:

- Quarantine-restore tooling surfaces a non-trivial restore rate
  (>2% of iniIntentNullVerb-tagged rows over a 30-day window) — that
  signals real false positives where a substantive event landed with
  the empty-payload signature.
- iOS ships a build that begins dispatching substantive intents under
  bare `INIntent` with null verbs (low likelihood — the framework's
  documented behaviour for >5 years has been typed-subclass dispatch).
- The user observes a downstream recall failure traceable to a row
  the iniIntentNullVerb branch dropped.

In any of those cases the recommended remediation is:

1. Gate the branch behind `process.env.SCREENTIME_F4_NULLVERB_MODE`
   (values: `drop` (default), `count_only` — PASS with telemetry tag).
2. Run for ≥7 days in `count_only` to sample real production volume.
3. Decide: revert to `drop`, leave at `count_only`, or remove the branch.

## Files

- `mcp/lib/ingest/stage0/screentime.js` — the iniIntentNullVerb branch
  (DROP via quarantineRow, REASON_EMPTY_PAYLOAD_INTENT).
- `mcp/lib/ingest/quarantine.js` — 30-day retention + restore tool.
- `mcp/lib/ingest/stage0/telemetry.js` — REASON_ALLOWLIST entry
  `empty_payload_intent`.
