# `policy.feature_backfill` event shape + recall consumption semantics

**Node:** `F-CCS-FOUNDATION-feature-backfill-policy`
**Tier:** foundation (design_spec, blocker)
**Status:** spec-locked; awaits `F-CCS-BACKFILL-engine` (substrate) and `F-CCS-BACKFILL-recall-consumer` (integration).
**Blocks (downstream):** `F-CCS-BACKFILL-engine`, `F-CCS-BACKFILL-recall-consumer`, `F-CCS-BACKFILL-trigger`, `F-CCS-OPS-coverage-recheck`.

---

## 1. Mission

Pin the on-ledger event shape and the recall-time consumption semantics for
`policy.feature_backfill` events. This is the only mechanism by which the
projection ("the features the recall scorer sees on a fact") can change for a
fact that has already been promoted — and it changes WITHOUT mutating the
underlying fact row.

The proximate problem: the 83 historical facts in
`storage/ledgers/memory.jsonl` were promoted before the W2–W6 extractor stack
existed, so their `features` payloads contain `{embedding, salience}` only —
no `entities[]`, no `time_anchors[]`, no `valence`, no `episodicity`. New
cascade Stage-3 stamping (`F-CCS-CASCADE-structured-features-merge`) runs at
promote time and CANNOT, by thesis #1, fire retroactively. Absent this spec
the landscape is bifurcated: the new tail of facts scores under the
multi-feature recall scorer using all five channels; the 83-fact head scores
under the legacy embedding-only branch, with no way to heal the gap.

This spec pins (1) the **event schema** on `memory.jsonl`, (2) **recall-time
overlay semantics** (`Map<fact_id, latest_backfill>` rebuilt from the ledger
and applied in memory before scoring), (3) **trigger conditions** (operator
CLI + drift-detector queue), (4) the **idempotence rule** (re-run is a no-op,
not a duplicate), and (5) the **single-producer invariant** (only ONE module
under `mcp/lib/**` may write rows of this `policy_kind`).

The contract holds across three call sites: the engine emitter
(`mcp/lib/synthesis/feature-backfill.js`, owned by `F-CCS-BACKFILL-engine`);
the recall scorer overlay applier (`mcp/lib/recall/`, owned by
`F-CCS-BACKFILL-recall-consumer`); the drift-detector trigger
(`F-CCS-BACKFILL-trigger`). The unifying invariant: **the ledger never lies
about what was emitted when** — a fact promoted in March with no `entities[]`
continues to have no `entities[]` on its on-disk row in June even after
backfill; the June projection sees the entities only because the recall
scorer overlays the backfill event on read. A grep of `memory.jsonl` for the
fact id reveals the unmodified original AND the corrective policy event
side-by-side, in append order.

---

## 2. kb anchors

The contract grounds in two passages from the kb. Each is reproduced verbatim;
binding language is preserved.

### A1 — `thesis.md` Principle #1 (the load-bearing constraint)

> The event ledger is append-only and authoritative. "What the system
> currently believes" is the output of a function over that ledger,
> parameterized by the recall context. The landscape does not exist between
> recalls. Storing a current view is the temptation that erodes everything.

(Section heading verbatim: "The ledger is permanent; the memory landscape is a projection" — `thesis.md` line 5. Body quoted above is `thesis.md` line 7 in full.)

Binding: this passage forbids in-place mutation of the original fact row's
`features` field. The naive "alternative design" — read each bare fact,
mutate `features.entities[]` to the extractor output, re-write the JSONL line
— is ruled out. The corrective mechanism MUST be a new appended event that
the recall projection joins against the original fact, the same way
`policy.corroboration` augments a fact's `source_refs[]` without mutating
the original `fact.source_refs[]` (architecture.md §4 corroboration variant).

### A2 — `architecture.md` §4 Memory ledger → kinds

> Single append-only stream: `ledgers/memory.jsonl`. Mixed kinds:
>
> - `fact` — promoted from a source
> - `policy` — `exclude` / `replace` / `substitute` / `corroboration` /
>   `rescind` operations
> - `recall` — logged retrieval (informs damping and reinforcement; carries
>   the query embedding for predicate snapshotting)
> - `reconstructed` — agent-emitted recall-time summarization (may diverge
>   from source)
>
> ```
> kind: "fact" | "policy" | "recall" | "reconstructed"
> ```

Binding: `feature_backfill` is a NEW value of the `policy_kind` discriminator
on a `kind:"policy"` row. The closed enum listed in §4 is extended by this
spec to include `feature_backfill`, with the same projection-time-join
semantics as `corroboration`: original target row never mutated; join happens
at projection time and is rebuilt-from-ledger on demand. Spec changes adding
new `policy_kind` values MUST cite both this anchor and
`kb/agent-integration.md § Token-event ownership table` to keep the enum
cross-referenced.

---

## 3. Event schema (the canonical row shape)

Every `policy.feature_backfill` row on `ledgers/memory.jsonl` MUST conform
exactly to the following shape. Field order is fixed for canonical JSON
output so two implementers given the same overlay produce byte-identical
rows (modulo random suffix in `id` and wall-clock `ts`).

```ts
interface FeatureBackfillEvent {
  /** `mem_<16-hex>` via crypto.randomBytes(8) — matches the prefix used by
   *  recall-feedback-emitter.js, forgetting-propagation.js, connectors/. */
  id: string;

  /** Server-stamped ISO-8601 via serverTs() from mcp/lib/envelope.js. */
  ts: string;

  /** Always "policy" (architecture.md §4). */
  kind: "policy";

  /** The new policy_kind discriminator. Single-producer CI test asserts
   *  ONLY mcp/lib/synthesis/feature-backfill.js writes this literal under
   *  mcp/lib/. */
  policy_kind: "feature_backfill";

  /** Bumped on backwards-incompatible row-shape change. v1 ships W1-CCS. */
  schema_version: "v1";

  /** memory_id of the fact whose features this event corrects. MUST appear
   *  as the id of a previously-appended kind:"fact" row on the same ledger;
   *  the engine MUST verify before emitting (a dangling pointer is a defect
   *  — fail-shut at the engine, never written to the ledger). */
  target_fact_id: string;

  /** The overlay. A SUBSET of structured features the recall scorer
   *  consumes. Channels present here REPLACE the corresponding channel on
   *  the target fact's in-memory projection (§4 conflict rules). Channels
   *  NOT present are preserved from the original row. */
  features_overlay: {
    entities?: Entity[];           // per F-SYN-FOUNDATION-entity-schema
    time_anchors?: TimeAnchor[];   // per F-SYN-FOUNDATION-time-anchor-schema
    valence?: number;              // [-1.0, 1.0], per valence-provenance
    episodicity?: number;          // [0.0, 1.0], per episodicity-feature
  };

  /** Monotonic integer per target_fact_id. First backfill: 1. Subsequent
   *  backfills (e.g. extractor version bump): next integer. Latest-wins at
   *  recall time (§4). Pair {target_fact_id, backfill_version} is the
   *  idempotence key (§6). */
  backfill_version: number;

  /** Extractor version stack snapshot at emit. Per-channel; omit when the
   *  channel is omitted from the overlay. Source of truth for
   *  drift-detector audits. */
  extractor_versions: {
    entity_extractor?: string;
    time_anchor_extractor?: string;
    valence_scorer?: string;
    episodicity_scorer?: string;
  };

  /** Literal "feature-backfill" (basename of the producer file). */
  emitter_module: "feature-backfill";

  /** Bumped when writer-side semantics change. */
  emitter_version: string;

  /** Same envelope as every kind:"policy" row. agent_id is the synthetic
   *  daemon "feature-backfill-daemon" (no human/conversation in the loop);
   *  conversation_id is null; confidence is the lowest channel-level
   *  confidence in the overlay (so consumers can dampen if needed). */
  provenance: {
    agent_id: "feature-backfill-daemon";
    conversation_id: null;
    confidence: number;
  };
}
```

### 3.1 Canonical JSON + writer discipline

Writers MUST produce the row using canonical JSON (keys in the declared
order, no trailing whitespace, terminated `"\n"` for JSONL discipline). Open
flags: `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW`; mode `0o600`. `fsyncSync`
before close. This matches `recall-feedback-emitter.js` and
`forgetting-propagation.js` exactly.

### 3.2 Closed channel set at v1

`entities`, `time_anchors`, `valence`, `episodicity` is the **closed v1 set**.
Adding a channel is a `schema_version` bump + coordinated update to the
recall scorer's overlay applier (§4.3). Implementers MUST NOT smuggle
non-listed channels through — the consumer ignores unknowns and CI test §9.4
asserts emit-time fail-shut on unknown keys.

Deliberately excluded at v1:

- **`embedding`** — owned by `F-CCS-CASCADE-promote-without-embed` via a
  SEPARATE async-queue / `policy.embedding_added` channel. Mixing the two
  here would couple two independently-failing backfills.
- **`salience`** — managed by the watermark daemon's ranker
  (`kb/salience-design.md`); a feature backfill does not change salience.
- **raw `structured_features` bag** — row-level (per
  `F-CCS-FOUNDATION-structured-features-schema`), not features-level; never
  flows through this overlay.

---

## 4. Recall-time overlay semantics

This is the load-bearing read path.

### 4.1 Build the latest-backfill map at recall init

On each recall call (or once per cache window, §4.5), the consumer MUST:

1. Stream `ledgers/memory.jsonl` from offset 0 (or from the cached `mtime`
   checkpoint).
2. Filter `row.kind === "policy"` AND `row.policy_kind ===
   "feature_backfill"`.
3. Group by `row.target_fact_id`.
4. Within each group select the entry with the **highest**
   `row.backfill_version`. Tie-break: later `ts` wins; final fallback is
   lexicographic `row.id`.
5. Materialize as `Map<fact_id, FeatureBackfillEvent>`.

The map is the projection. Rebuilt from the ledger; never authoritative
(architecture.md §5 indices rule).

### 4.2 Apply the overlay before scoring

For each candidate the recall scorer evaluates, call
`applyBackfillOverlay(candidate, latestBackfillMap)` BEFORE the multi-feature
score function reads `candidate.features.<channel>`. The function returns a
NEW candidate object — the input candidate MUST NOT be mutated. Mutating the
in-memory projection of a fact loaded from the ledger would let the modified
version leak into a subsequent cached read; per architecture.md §5 the
projection is a cache rebuilt from the ledger, and in-place mutation
violates that invariant by aliasing the cache entry.

```ts
function applyBackfillOverlay(
  candidate: FactRow | ReconstructedRow,
  latestBackfillMap: Map<string, FeatureBackfillEvent>,
): FactRow | ReconstructedRow {
  const backfill = latestBackfillMap.get(candidate.id);
  if (!backfill) return candidate; // no backfill — original wins

  const overlaidFeatures = { ...candidate.features };
  for (const channel of ["entities", "time_anchors", "valence", "episodicity"]) {
    if (backfill.features_overlay[channel] !== undefined) {
      overlaidFeatures[channel] = backfill.features_overlay[channel];
    }
  }
  return { ...candidate, features: overlaidFeatures };
}
```

### 4.3 Conflict resolution: per-channel REPLACE (not merge)

- `backfill.features_overlay.entities = [E1, E2]` + original `features.entities
  = [E3]` → projection sees `[E1, E2]` (NOT `[E1, E2, E3]`). This is the only
  rule that matches the "extractor version bump invalidates prior output"
  case — v0.2.0 may decide v0.1.0's E3 was spurious (FM-1 conflation), and
  the overlay MUST be able to remove it.
- `backfill.features_overlay.entities` undefined → projection preserves
  original `features.entities`. (Subset overlay; absent channels mean "leave
  alone.")
- Both undefined → projection's `features.entities` remains undefined. The
  scorer's `entity_overlap` branch already short-circuits to 0 when no
  entities are present (research-retrieval-frontiers.md Phase 3 v0).

Per-channel REPLACE is the **conservative** choice. Union-merge was
considered and rejected: it forces the engine to know which extractor
produced each pre-existing element (not recorded on the original row) and
would let v0.1.0 noise persist in the v0.2.0 projection indefinitely.

### 4.4 Latest-wins for multiple backfills of the same fact

```
ts=2026-06-21  id=mem_aaa  target=mem_F1  backfill_version=1  (v0.1.0 entities)
ts=2026-09-15  id=mem_bbb  target=mem_F1  backfill_version=2  (v0.2.0 entities)
```

The projection sees ONLY `backfill_version=2`'s overlay. The version=1 row
stays on disk for audit. The `backfill_version` field is what makes this
deterministic — duplicate version on the same fact is a defect in the engine
(the engine MUST allocate `next_version = max(existing_versions) + 1`); the
§4.1.4 tie-break (ts then id) is the defensive fallback.

### 4.5 Caching discipline

The map is expensive to rebuild on every recall once the ledger crosses ~10⁴
facts. The consumer MAY cache keyed by `(ledgerPath, mtimeMs, sizeBytes)` —
a change to either invalidates the cache and triggers a rebuild from offset
0 (or, optimization: from last-cached mtime offset, streaming only the new
tail and merging in). Cache is in-process; cross-process recall (multiple
MCP server instances) rebuilds independently.

MAX cache age is bounded — `LATEST_BACKFILL_CACHE_MAX_AGE_MS = 60_000` is
exported from the consumer so a stuck mtime (filesystem clock skew, NFS)
cannot let a stale projection persist indefinitely.

### 4.6 Score-time fallback

The scorer's multiplicative branch `s_emb * predicate_mask *
consent_dampener * derivation_status * episodicity_match` reads
`features.episodicity`; the additive branch's `entity_overlap`, `time_match`,
`valence` terms read their respective channels. With §4.2 in place the
scorer reads projected (post-overlay) features and is unaware that any
backfill happened. No scorer code path requires modification beyond
inserting the overlay call.

Bare-fact baseline (no overlay because no backfill exists yet) is
**identical** to the legacy embedding-only branch — `entity_overlap = 0`,
`time_match = 0`, `valence_term = 0` collapse the additive branch to zero,
multiplicative branch carries the score. After backfill, the additive
branch contributes; before, it doesn't. This is the design intention —
backfilled facts get multi-feature scoring; un-backfilled facts score under
embedding alone with no degradation.

---

## 5. Trigger conditions

Two paths emit backfill tasks. Both are SPECIFIED here for the foundation
handoff; implementation lives in `F-CCS-BACKFILL-trigger` (drift-detector)
and `F-CCS-BACKFILL-engine` (CLI).

### 5.1 Manual operator trigger

`mcp/scripts/run-feature-backfill.mjs` is the CLI:

```bash
node mcp/scripts/run-feature-backfill.mjs                       # backfill all bare facts
node mcp/scripts/run-feature-backfill.mjs --since-version 1 --channel entities
node mcp/scripts/run-feature-backfill.mjs --fact-ids mem_F1,mem_F2
```

Walks `kind:"fact"` rows, decides per-fact whether a backfill is needed (§6),
invokes the engine's `runBackfill({fact_ids, channel?, sinceVersion?})` with
the filtered set. Non-zero exit only on fatal config errors; individual fact
failures are logged and skipped (defensive degradation).

### 5.2 Drift-detector queued task

When `mcp/lib/synthesis/drift-detector.js` (extended per
`F-CCS-BACKFILL-trigger`) observes `entity_extractor.VERSION` has
incremented relative to the max `extractor_versions.entity_extractor`
observed in the latest-backfill map, it enqueues a task into
`<data root>/policy/backfill-queue.jsonl` (mirrors engagement-queue
pattern). The watermark daemon's idle tick drains at most
`BACKFILL_TASKS_PER_TICK = 5` per cycle (cap prevents runaway).

The drift-detector ALSO emits a `policy.backfill_scheduled` event onto the
memory ledger — a SEPARATE `policy_kind`, owned by a SEPARATE single-producer
file (drift-detector.js per `F-CCS-BACKFILL-trigger`). Payload:
`{target_fact_count, reason: "extractor_version_bump", old_version,
new_version, channel}`. This is the audit trail that drift was detected;
actual backfill events follow when the engine drains the queue.

`backfill-queue.jsonl` is OPERATIONAL state (architecture.md §8's distinction
between policy-events-YYYY-MM.jsonl ops audit and memory.jsonl memory state).
Rebuildable from the memory ledger via outstanding `policy.backfill_scheduled`
events; does not require its own corrupt-tail discipline beyond best-effort
recovery.

---

## 6. Idempotence

The pair `{target_fact_id, backfill_version}` is the dedupe key.

### 6.1 Engine-side rules

Before emitting an event for a fact, the engine MUST:

1. Scan the latest-backfill map for `target_fact_id`.
2. If no entry exists → new event carries `backfill_version: 1`.
3. If an entry exists with `backfill_version: N`:
   a. Compute the proposed overlay (run extractors over `fact.content +
      fact.structured_features`).
   b. Compare byte-for-byte against the existing entry's `features_overlay`.
      Byte-equal → **no-op**, skip emission, log via console.error.
   c. Different → allocate `backfill_version: N + 1`, emit.

Byte-equality uses canonical JSON of the `features_overlay` sub-object
(deterministic key order from the v1 closed set). This is what makes
"re-running the CLI on an already-backfilled corpus" a no-op rather than
a duplicate-row amplifier.

### 6.2 Why version + byte-equality

Pure version-allocation without byte-equality would let accidental re-runs
double the backfill count for every fact (each invocation observes N=1,
emits N=2 with same overlay). Pure byte-equality without version would
prevent the consumer from disambiguating two legitimate backfills for the
same fact when the overlay legitimately changed (v0.1.0 → `[E1, E2]`;
v0.2.0 → `[E1, E3]`; both are "latest" by ts; version is the unambiguous
discriminator).

The pair gives both: dedupe on byte-equal, monotonic on byte-different.

### 6.3 Collision handling

If two engine processes race on the same fact (operator CLI + drift-detector
queue drain hit simultaneously), both may observe N=1 and allocate N=2 →
two `backfill_version: 2` rows for the same `target_fact_id`. The §4.1.4
tie-break resolves the projection deterministically. Audit tooling
(`mcp/scripts/audit-backfill-collisions.mjs`, owned by
`F-CCS-OPS-coverage-recheck`) flags the collision for operator
investigation.

The engine SHOULD acquire a per-fact advisory lock via the
`acquireExclusiveLockFile` discipline (architecture.md §
acquireExclusiveLockFile) — sidecar at
`<data root>/policy/backfill-<fact_id>.lock`, mode `0o600`, retry with
backoff up to `STALE_LOCK_RECOVERY_SECONDS`. This is an OPTIMIZATION
(prevents collision) not a CORRECTNESS requirement (the tie-break keeps the
projection deterministic regardless).

---

## 7. Single-producer invariant

ONLY `mcp/lib/synthesis/feature-backfill.js` may write rows whose
`policy_kind` field equals the string literal `"feature_backfill"`.

### 7.1 CI enforcement (mirror of W9 + W11 pattern)

A test at `mcp/test/synthesis/single-producer-feature-backfill.test.mjs`
mirrors `single-producer-forgetting-cascade.test.mjs` byte-for-byte
(reference: `mcp/test/synthesis/single-producer-forgetting-cascade.test.mjs`
lines 28–195):

- Walks every `.js`/`.mjs` file under `mcp/lib/**`.
- Strips comments via `stripJsComments(src)` (helper copied verbatim from the
  forgetting-cascade test to avoid drift).
- Greps the stripped source for `"feature_backfill"` / `'feature_backfill'`
  / `` `feature_backfill` ``.
- Asserts the only matching file is `mcp/lib/synthesis/feature-backfill.js`.

The test ALSO asserts: `ALLOWED_WRITERS` non-empty + file exists; sole
producer actually contains the literal (guard against renamed-constant
drift); exported `FEATURE_BACKFILL_KIND` and `FEATURE_BACKFILL_VERSION` match
the literal/module-version values; test directory excluded from the scan.
≥12 assertions.

### 7.2 Allowed callers (read-side)

The recall consumer (`mcp/lib/recall/multi-feature-score.js` or wherever
`applyBackfillOverlay` lands) reads the literal as a FILTER VALUE when
grepping `memory.jsonl` for these rows (§4.1.2). This is a READ. The
single-producer test SHOULD list this file in `ALLOWED_CALLERS` (mirror of
`forgetting-cascade.test.mjs` lines 43–48) and additionally assert the
allowed caller does NOT match the literal as a quoted value in stripped
source — the consumer reads from the exported constant, never an inline
string.

### 7.3 The CLI is NOT a writer

`mcp/scripts/run-feature-backfill.mjs` invokes `runBackfill()` exported from
the engine; the engine is the writer. The CLI MUST NOT contain the literal
`"feature_backfill"` anywhere — it imports `FEATURE_BACKFILL_KIND` if it
needs the value. This keeps the single-producer chokepoint at one file.

---

## 8. Worked examples

### 8.1 Example A — bare fact backfilled to v0.1.0 entities (the 83-fact case)

**Ledger before** (truncated):

```json
{"id":"mem_F1","ts":"2026-03-15T10:00:00Z","kind":"fact",
 "content":"Alex showed the Acmebot LX-2 during the workshop",
 "features":{"embedding":[...384...],"salience":0.6}}
```

`features.entities` undefined — one of the 83.

**Engine action**: `runBackfill({fact_ids: ["mem_F1"]})`. Engine reads row,
sees `features.entities` missing, runs the W2 entity extractor (v0.1.0) over
`content`, produces:

```json
[
  {"kind":"person","canonical_id":"person:chat:alex"},
  {"kind":"artifact","canonical_id":"artifact:chat:acmebot-lx-2"},
  {"kind":"event","canonical_id":"event:chat:workshop"}
]
```

No map entry for `mem_F1` → `backfill_version: 1`.

**Ledger after** (two lines):

```json
{"id":"mem_F1", ...unchanged...}
{"id":"mem_b1a2","ts":"2026-06-21T14:00:00Z","kind":"policy",
 "policy_kind":"feature_backfill","schema_version":"v1",
 "target_fact_id":"mem_F1","features_overlay":{
   "entities":[
     {"kind":"person","canonical_id":"person:chat:alex"},
     {"kind":"artifact","canonical_id":"artifact:chat:acmebot-lx-2"},
     {"kind":"event","canonical_id":"event:chat:workshop"}]},
 "backfill_version":1,
 "extractor_versions":{"entity_extractor":"v0.1.0"},
 "emitter_module":"feature-backfill","emitter_version":"v1",
 "provenance":{"agent_id":"feature-backfill-daemon",
   "conversation_id":null,"confidence":0.75}}
```

**Recall projection** for `mem_F1` post-backfill: in-memory candidate's
`features.entities[]` reads as three entities; `embedding` and `salience`
preserved from original; `time_anchors`, `valence`, `episodicity` remain
undefined (overlay did not carry them). Additive `entity_overlap` term now
fires when a recall context mentions Alex / the workshop, where it would
have been 0 pre-backfill.

### 8.2 Example B — same fact backfilled to v0.2.0 (extractor version bump)

**Trigger**: drift-detector observes `entity_extractor.VERSION === "v0.2.0"`
and the latest-backfill map shows `mem_F1` was backfilled at v0.1.0. Enqueues
`mem_F1` into `backfill-queue.jsonl`. Watermark idle tick drains.

**Engine action**: reads `mem_F1`, finds existing `backfill_version: 1`,
runs v0.2.0 extractor, produces:

```json
[
  {"kind":"person","canonical_id":"person:chat:alex"},
  {"kind":"artifact","canonical_id":"artifact:chat:acmebot-lx-2"}
]
```

(v0.2.0 dropped `event:chat:workshop` — v0.1.0 over-fired on generic event
nouns; v0.2.0 fixed that, hypothetical FM-1-style review.)

Byte-equality fails → allocate `backfill_version: 2`.

**Ledger after** (three lines):

```json
{"id":"mem_F1", ...unchanged...}
{"id":"mem_b1a2", target_fact_id="mem_F1", backfill_version=1, ...v0.1.0 overlay...}
{"id":"mem_c3d4","ts":"2026-09-15T09:00:00Z","kind":"policy",
 "policy_kind":"feature_backfill","schema_version":"v1",
 "target_fact_id":"mem_F1","features_overlay":{
   "entities":[
     {"kind":"person","canonical_id":"person:chat:alex"},
     {"kind":"artifact","canonical_id":"artifact:chat:acmebot-lx-2"}]},
 "backfill_version":2,
 "extractor_versions":{"entity_extractor":"v0.2.0"},
 "emitter_module":"feature-backfill","emitter_version":"v1", ...}
```

**Recall projection**: in-memory candidate's `features.entities[]` reads as
the two-entity v0.2.0 set. The v0.1.0 row stays on disk for audit; the
projection ignores it because §4.1.4 selects `max(backfill_version)`.

### 8.3 Example C — re-running the CLI is a no-op

`node mcp/scripts/run-feature-backfill.mjs --fact-ids mem_F1` after Example B
has settled.

**Engine action**: reads `mem_F1`, finds existing `backfill_version: 2` at
v0.2.0 entities. Re-runs v0.2.0 extractor (still current), produces the same
two-entity output. Byte-equality passes. **No event emitted.** Logged:

```
backfill skipped — no-op for fact_id mem_F1 at version 2
```

Ledger unchanged. Projection unchanged. This is the discipline that makes
the CLI safe to invoke from cron or a post-deploy hook: re-runs are no-ops,
NOT duplicates.

---

## 9. Invariants (CI-enforceable)

### 9.1 INV-MUT-FORBIDDEN — never mutate a `kind:"fact"` row

No code path under `mcp/lib/` may rewrite a `kind:"fact"` row on
`ledgers/memory.jsonl`. Test: synthesize a ledger with one bare fact, run
the backfill engine, assert the fact row's byte offset + content are
unchanged (compare a `crypto.createHash('blake2b512').update(line).digest()`
before and after).

### 9.2 INV-LATEST-WINS — projection reflects the highest `backfill_version`

Synthesize a ledger with one fact and three `policy.feature_backfill` events
(versions 1, 2, 3) for that fact with different overlay entity sets. Build
the map; assert map entry has `backfill_version === 3` and
`features_overlay.entities` matches the v3 set.

### 9.3 INV-IDEMPOTENT — re-emit-byte-equal is a no-op

Run `runBackfill()` twice in succession over the same fact with the same
extractor versions; assert the second run emits 0 events and the ledger line
count is unchanged.

### 9.4 INV-OVERLAY-CLOSED — only v1 channels are honored

Build a backfill row with an extra channel (e.g.
`features_overlay.color = "red"`); apply overlay to a candidate; assert
`candidate.features.color` is undefined (consumer ignores unknowns) AND
the engine REFUSES to write a row containing an unknown channel (fail-shut
at emit time on keys not in the v1 closed set).

### 9.5 INV-SINGLE-PRODUCER — only the engine writes the literal

See §7.1. Test mirrors `single-producer-forgetting-cascade.test.mjs`
byte-for-byte (replace `"derivation.cascade_orphan"` with
`"feature_backfill"`; replace `ALLOWED_WRITERS` target).

### 9.6 INV-BACKCOMPAT — bare facts cascade unchanged

A `kind:"fact"` row with no `policy.feature_backfill` partner MUST flow
through the recall scorer with the same per-channel contributions it did
before this spec landed: `entity_overlap = 0`, `time_match = 0`,
`valence_term = 0`, embedding multiplicative branch unchanged. Test:
synthesize a ledger with a bare fact and no backfill rows; score under the
multi-feature scorer; assert score equals pre-spec baseline.

### 9.7 INV-DETERMINISTIC-PROJECTION — same ledger, same map

Synthesize a ledger with multiple backfill events in shuffled append order;
build the map twice (separate processes); assert deep-equal. The §4.1.4
tie-break (version, ts, id) is what makes this deterministic regardless of
stream order.

---

## 10. Open questions

Deferred to downstream nodes or to a v2 schema bump. NOT load-bearing for v1.

### 10.1 Per-channel backfill versioning

Current schema: one `backfill_version` covering all overlay channels.
Alternative: per-channel versions (`backfill_version: {entities: 2,
time_anchors: 1, ...}`) letting the entity extractor bump independently of
the valence scorer. Deferred because (a) projection logic gets substantially
more complex, (b) the bigger event count makes audit-grep harder. v1 cost:
bumping ONE channel requires re-emitting an event with the FULL overlay.
Operationally fine — the engine re-runs current extractors and emits one
consolidated row. Revisit at v2 if extractor-version churn becomes a
problem.

### 10.2 Backfill of `kind:"reconstructed"` rows

v1 scopes `target_fact_id` to `kind:"fact"` only. Reconstructed rows
(W11 reconstructed-trigger pipeline) also have features-stamping needs but
raise lifecycle questions (a reconstructed row may be derived from facts
that get backfilled later — does the reconstructed row's features change?
Does the W4 derivation-graph propagation re-derive content from now-stamped
parents?). Deferred. Engine MUST fail-shut if `target_fact_id` resolves to
a non-fact row.

### 10.3 Cross-extractor-version overlay rescue

If v0.2.0 output is a strict superset of v0.1.0 (new entities added, none
removed), per-channel REPLACE is wasteful. Alternative ("smart merge")
skips re-emit if new overlay is a superset. Deferred. v1 discipline ("the
projection sees the latest extractor's view, period") is conceptually
clean; optimization can land in v2 with an explicit merge-mode flag.

### 10.4 Backfill row corroboration

If two operators run backfill concurrently on the same fact and produce
DIFFERENT overlays (testing extractor branches), §4.1.4 picks one
arbitrarily. The system has no semantics for "corroborate these two
overlays into one." Deferred to a Phase-4 multi-operator scenario.

### 10.5 Excise / rescind of backfill events

A `memory_rescind_policy` event targeting a `policy.feature_backfill` event
SHOULD logically deactivate the backfill, exposing the underlying fact's
original features to the projection (or the next-most-recent backfill if
one exists). Clean extension of the existing rescind contract: step 4.1.2
also excludes rows whose `id` appears in any `policy.rescind` event's
`targets[]`. Specified here; lands in `F-CCS-BACKFILL-recall-consumer` as
an implementation detail.

---

## 11. Cross-tier impact

### 11.1 `F-CCS-FOUNDATION-structured-features-schema` (sibling foundation)

The structured-features-schema spec pins the row-level `structured_features`
bag. This spec's overlay `Entity` and `TimeAnchor` types MUST match the
shapes pinned there (which re-use `F-SYN-FOUNDATION-entity-schema` and
`F-SYN-FOUNDATION-time-anchor-schema`). Drift requires a coordinated update
to §3 of this spec.

### 11.2 `F-CCS-CASCADE-structured-features-merge` (cascade tier)

The cascade merges `row.structured_features` into a new fact's `features` at
promote time — the steady-state shape this spec backfills toward. If the
cascade adds a new channel, this spec MUST bump `schema_version` to v2 and
add it to the v1 closed set in §3.2.

### 11.3 `F-CCS-BACKFILL-engine` (substrate)

The engine implements the writer. MUST:

- Export `FEATURE_BACKFILL_KIND = "feature_backfill"`, frozen
  `FEATURE_BACKFILL_VERSION`, frozen `CAPS`.
- Implement `runBackfill({fact_ids, channel?, sinceVersion?})` honoring §6.
- Provide `mcp/scripts/run-feature-backfill.mjs` as CLI entrypoint.
- Pass §9.1 / §9.3 / §9.5 invariant tests.

### 11.4 `F-CCS-BACKFILL-recall-consumer` (integration)

The consumer implements the reader. MUST:

- Export `applyBackfillOverlay(candidate, latestBackfillMap)` honoring §4.3
  per-channel REPLACE.
- Implement latest-backfill map build (§4.1) and cache discipline (§4.5).
- Pass §9.2 / §9.4 / §9.6 / §9.7 invariant tests.

### 11.5 `F-CCS-BACKFILL-trigger` (integration)

Drift-detector extension implements §5.2 queued trigger + the
`policy.backfill_scheduled` audit event through its OWN single-producer file
(drift-detector.js). This spec's single-producer rule (§7) covers
`policy.feature_backfill` only.

### 11.6 `F-CCS-OPS-coverage-recheck` (ops)

Audit tooling reads the latest-backfill map READ-ONLY and reports per-channel
coverage percentages, drift alerts (stale extractor versions), and
collision reports (per §6.3). Does NOT emit `policy.feature_backfill`
events of its own.

---

## 12. Implementation checklist (foundation → substrate handoff)

For `F-CCS-BACKFILL-engine`:

- [ ] Exported `FEATURE_BACKFILL_KIND = "feature_backfill"`,
      `FEATURE_BACKFILL_SCHEMA_VERSION = "v1"`,
      `FEATURE_BACKFILL_VERSION = "v0.1.0"`, frozen `CAPS`.
- [ ] Writer discipline — `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW`,
      mode `0o600`, `fsyncSync` before close.
- [ ] Canonical key order per §3.
- [ ] Idempotence — byte-equality check before allocating
      `backfill_version + 1`.
- [ ] CLI at `mcp/scripts/run-feature-backfill.mjs`, defensive per-fact
      handling, non-zero exit only on fatal config errors.
- [ ] Single-producer test mirroring
      `single-producer-forgetting-cascade.test.mjs`.
- [ ] 15+ assertions in the engine's primary test file.
- [ ] Defensive degradation — extractor failure → skip + log, never throw.
- [ ] Hermetic test setup — env-before-dynamic-import for ledger paths.

For `F-CCS-BACKFILL-recall-consumer`:

- [ ] `applyBackfillOverlay` exported; immutable input + output.
- [ ] Latest-backfill map cached at module scope, keyed by
      `(ledgerPath, mtimeMs, sizeBytes)`.
- [ ] `LATEST_BACKFILL_CACHE_MAX_AGE_MS = 60_000` exported.
- [ ] Tie-break per §4.1.4 (version, then ts, then id).
- [ ] Rescind handling per §10.5.
- [ ] 12+ assertions in the consumer's primary test file.

---

*End of spec. Implementer questions → comment on
`F-CCS-FOUNDATION-feature-backfill-policy` in the hypergraph or surface
through the W1-CCS review channel.*
