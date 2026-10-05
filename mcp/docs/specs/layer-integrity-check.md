# Inter-Layer Integrity Check: Stage-0 Ledger -> Cross-Source Dedup

**Node:** F-META-LAYER-INTEGRITY-CHECK
**Status:** SPEC — pending implementation
**Severity:** major
**Owner:** memory-system core (ingest)
**Depends on:** F-INFRA-DEDUP-FULLSCAN, F-CROSS-CROSS-SOURCE-DEDUP
**Blocks:** none (cross-cutting durability invariant)

---

## Problem

Cross-source dedup (R50, `lib/ingest/cross-source-dedup.js`) runs AFTER
per-source Stage-0 but depends on per-source ledger state being durable.
If the Stage-0 in-memory dedup Set glitches (R41
`F-INFRA-DEDUP-FULLSCAN`) and corrupts a ledger — a partial write, a
duplicate emit, a row order swap — the cross-source layer inherits the
corruption silently. There is no integrity check between the two
layers; downstream is the first place the corruption surfaces, by which
time the embed cost has already been paid and the recall index already
poisoned.

This is the classic silent-corruption pattern: every layer trusts its
input is well-formed because the previous layer "definitely succeeded."
The fix is a checkpoint manifest written at Stage-0's end-of-batch and
validated at cross-source-dedup's start-of-batch.

## Goal

Document a checkpoint-manifest invariant that:

1. **Catches row-count corruption** (Stage-0 said it emitted N rows;
   ledger has M != N).
2. **Catches content corruption** (Stage-0's `content_sha` over the
   batch's row stream does not match what cross-source-dedup
   recomputes).
3. **Catches ordering / boundary corruption** (Stage-0 said the batch
   ended at `last_source_msg_id=X`; ledger's tail row has id Y != X).
4. **Halts** on mismatch with an operator-actionable alert; never
   proceeds to dedup on a corrupted ledger.

## Manifest schema

Per source per batch, Stage-0 writes a manifest file to
`mcp/state/manifests/<source>/<batch_id>.json`:

```json
{
  "manifest_version": 1,
  "source": "imessage",
  "batch_id": "2026-06-07T14:23:00Z-imessage-7f3a",
  "batch_started_at": "2026-06-07T14:23:00.123Z",
  "batch_ended_at": "2026-06-07T14:23:17.456Z",
  "row_count": 1842,
  "first_source_msg_id": "1717820000-imessage-aaa",
  "last_source_msg_id": "1717820317-imessage-zzz",
  "content_sha": "sha256:9a8b7c...",
  "decision_counts": {
    "PASS": 421,
    "DROP": 1303,
    "REDACT_DROP": 118
  },
  "structural_score_histogram": {
    "0.0-0.1": 0,
    "0.1-0.2": 0,
    "0.2-0.3": 12,
    "0.3-0.4": 34,
    "0.4-0.5": 88,
    "0.5-0.6": 102,
    "0.6-0.7": 95,
    "0.7-0.8": 60,
    "0.8-0.9": 22,
    "0.9-1.0": 8
  },
  "redaction_categories_triggered": [
    "openai_sk", "github_pat", "e164_phone_hashed", "abperson_uid_hashed"
  ]
}
```

### content_sha derivation

`content_sha` is a streaming SHA256 over the canonical JSON serialization
of each emitted row, concatenated with `\n` between rows, in emission
order. Canonical JSON = sorted keys, no whitespace, UTF-8.

```
content_sha = sha256(
  canonical_json(row_0) + "\n" +
  canonical_json(row_1) + "\n" +
  ...
)
```

This catches both content corruption (a row's content changed) and
ordering corruption (rows emitted in a different order than Stage-0
recorded).

## Stage-0 writer responsibilities

At end-of-batch, Stage-0 MUST:

1. Flush all pending writes to the per-source ledger.
2. fsync the ledger file.
3. Compute the manifest (counting from the actual emitted-rows stream
   that Stage-0 produced; do NOT re-read the ledger — that would
   defeat the integrity check).
4. Write the manifest atomically (write to `.tmp`, fsync, rename).

Stage-0 MUST NOT write the manifest if the batch errored mid-flight;
the absence of a manifest is itself an integrity signal.

## Cross-source dedup validator responsibilities

At start-of-batch, cross-source dedup MUST:

1. Locate the manifest for each source it will consume.
2. **If manifest missing**: HALT with alert
   `LAYER_INTEGRITY_MANIFEST_MISSING:<source>:<batch_id>`. Do not
   consume that source.
3. **Re-stream the ledger** for that source and re-derive
   `row_count`, `last_source_msg_id`, and `content_sha`.
4. **Compare** the derived values against the manifest values.
5. **On mismatch**: HALT with alert
   `LAYER_INTEGRITY_MISMATCH:<source>:<field>:<expected>:<observed>`.
6. **On match**: proceed to dedup; record the manifest validation in
   the dedup run's telemetry.

## Halt semantics

"HALT" means:

- Emit a single operator-visible alert (writes to the user's
  alert channel; channel is whatever the runtime is using — currently
  stderr + a direct message to the user).
- Do not proceed with cross-source dedup for any source until the
  operator acks.
- Do not silently fall back to a partial dedup. Partial is worse than
  none, because downstream layers will trust the partial output.
- Leave the corrupted ledger in place for operator inspection; do not
  auto-repair.

## Alert payload

The alert must be operator-actionable, meaning the user can decide
the next step without reading code:

```
LAYER_INTEGRITY_MISMATCH
Source: imessage
Batch:  2026-06-07T14:23:00Z-imessage-7f3a
Field:  content_sha
Expected (per Stage-0 manifest):  sha256:9a8b7c...
Observed (recomputed from ledger): sha256:1d2e3f...
Row count expected: 1842
Row count observed: 1842
Likely cause: ledger content drift since batch-end (in-memory dedup
              Set leak, double-write, ordering swap).
Suggested next step:
  1. Inspect ledger tail rows for the batch range.
  2. Compare against connector emission log if available.
  3. If corruption confirmed: re-run the affected Stage-0 batch from
     the connector's last checkpoint.
Do NOT proceed with cross-source dedup until resolved.
```

## Why this design

- **Manifest from Stage-0's emit-stream, not from the ledger.** If we
  derived the manifest by re-reading the ledger after writing, the
  check would be circular: a write-time corruption would corrupt both
  the ledger and the manifest identically, and the validator would see
  agreement on a bad value.

- **Re-stream the ledger at validate-time.** The validator must
  recompute the sha from scratch against the ledger bytes. This is the
  expensive but necessary step that turns a trust-the-input contract
  into a verify-the-input contract.

- **Halt, do not auto-repair.** Auto-repair on integrity mismatch
  papers over the upstream bug. The user must see the mismatch and
  fix the root cause.

- **Per-batch granularity.** Smaller batches mean smaller blast radius
  on mismatch and faster validation. Recommended batch size: O(10^4)
  rows.

## Implementation hints

Files to create / modify:

- `mcp/lib/ingest/manifest.js` (NEW) — manifest writer and validator
  primitives. Exports:
  - `writeManifest({ source, batch_id, rows, started_at, ended_at })`
    — called by Stage-0 at end-of-batch.
  - `validateManifest({ source, batch_id, ledger_path })` — called by
    cross-source dedup at start-of-batch. Returns
    `{ ok: true } | { ok: false, mismatch: {...} }`.
  - `canonicalJsonLine(row)` — the canonical serialization helper.
  - `streamingSha256(stream)` — Node-stream-based hasher used by both
    writer and validator.

- `mcp/lib/ingest/stage0/index.js` — call `writeManifest` at the end
  of each batch's dispatch loop.

- `mcp/lib/ingest/cross-source-dedup.js` — call `validateManifest` per
  source before starting dedup; on `ok: false`, emit the alert and
  abort.

- `mcp/state/manifests/<source>/` — manifest storage. Add to
  `.gitignore` (manifests are runtime state, not source).

## Acceptance criteria

- [ ] `writeManifest` is called at end of every Stage-0 batch.
- [ ] `validateManifest` is called at start of every cross-source
      dedup batch, per source.
- [ ] A test that artificially corrupts a ledger row (mutates one
      content field after the manifest is written) triggers the
      `LAYER_INTEGRITY_MISMATCH` halt with the correct alert payload.
- [ ] A test that deletes a manifest before dedup triggers
      `LAYER_INTEGRITY_MANIFEST_MISSING`.
- [ ] A test that runs end-to-end with no corruption proceeds without
      halt and records `manifest_validated: true` in dedup telemetry.
- [ ] Performance: manifest validation re-stream adds <5% to dedup
      batch wall time at the standard batch size (O(10^4) rows). If
      it exceeds 5%, the manifest design must be revisited (e.g.
      sampled validation rather than full re-stream).

## Review questions (from node spec)

- Does the manifest detect both row-count and content corruption?
  YES — `row_count` catches row-count, `content_sha` catches content
  + ordering.
- Is the alert operator-actionable?
  YES — payload includes source, batch, expected/observed, likely
  cause, suggested next steps.
- Does halting prevent downstream corruption propagation?
  YES — cross-source dedup will not consume the source until the
  operator acks; the embedder is downstream of dedup so it is
  transitively protected.

## Open questions

- Do we want a separate manifest per source per batch (proposed) or
  one combined manifest across sources? Per-source is simpler and
  isolates blast radius; combined could detect global ordering issues
  but increases coupling.
- Should the validator's re-stream sha be cached for the dedup
  pass's own use? It traverses the same ledger bytes; reuse would
  remove the 5% overhead. Defer until the simple form is proven.
- Retention policy for old manifests. Proposal: keep 90 days, then
  drop. Manifests are small (O(1KB)) so retention cost is negligible.
