# Entity canonical_id schema + conflation-resistance contract (per-source canonicalization scope)

**Node:** `F-SYN-FOUNDATION-entity-schema`
**Tier:** foundation (design_spec, blocker)
**Status:** synthesis-ready; awaits substrate (`F-SYN-SUBSTRATE-entity-extractor`) and four bound call sites.
**Blocks:** `F-SYN-FOUNDATION-context-populator`, `F-SYN-FOUNDATION-derivation-propagation`, `F-SYN-FOUNDATION-episodicity-feature`.

---

## 1. Mission

Pin the entity schema that flows through the memory system: a closed 7-type taxonomy, a per-source canonicalization scope, a byte-stable `canonical_id` shape, an explicit conflation-resistance gate, and the slug normalization algorithm — at the level of detail required for two independent implementers to produce identical `canonical_id` strings from identical inputs. The schema must hold across (a) cascade Stage-2/3 stamping in `mcp/lib/ingest/salience.js` at promote time, (b) entity-index rebuild from `ledgers/memory.jsonl`, (c) recall-time `surrounding_context` populator, and (d) `memory_exclude` predicate evaluator. The unifying invariant: **a predicate captured under one canonicalization continues to match under the next.** Conflation (two distinct real-world entities collapsing onto one id) is the failure mode the design rejects most aggressively — `kb/salience-design.md` Appendix A.1 documents the empirical FM-1 collapse where a naive NER pass promoted `name:Alex`, `name:Your`, `name:And` to the same semantic candidate level. False-discriminate (the same person held in two ids in two source scopes) is recoverable later via an alias-merge policy event; false-conflate poisons the predicate index permanently.

The schema is shipped at v0 with `source_scope` carried as a structural prefix on the `canonical_id` itself (not a sidecar field), with the cross-source alias graph deferred to v1 behind an operator-confirmed merge policy.

---

## 2. kb anchors

The contract grounds in five passages from the kb. Each is reproduced verbatim; binding language is preserved.

### A1 — `architecture.md` §4 Memory ledger → fact features

> `features: { embedding, embedding_model_version, entities: [], time_anchors: [], valence }` — the slot exists; nothing populates it today.

Binding: the `features.entities[]` slot is the shape this spec finally populates. Any element of that array MUST conform to the `Entity` shape defined in §4 of this spec.

### A2 — `architecture.md` §5 Index → Entity index

> Entity index — people, places, dates extracted at promotion.

Binding: the entity index is a derived projection over `features.entities[]` on every `fact` and `reconstructed` row. The index is a cache, not the truth; this spec's `canonical_id` shape IS the truth, and the index can be rebuilt deterministically from the ledger.

### A3 — `salience-design.md` Appendix A.1 dual-layer-episodic-semantic FM-1 evidence

> FM-1 entity-tagger conflation empirically confirmed in the captured corpus — `name:Alex`, `name:Your`, `name:And` all promote to semantic candidates under a naive NER pass, producing noise amplification on iMessage natural-language entities.

Binding: this passage is load-bearing for the per-source scope decision AND for the stopword/blocklist (§6.3). Any extraction path that bypasses the gate MUST be considered to recreate FM-1.

### A4 — `open-problems.md` #5 Predicate language is a hopeful sketch

> "Anything about my ex" works if "my ex" is an extracted entity. What about "anything that feels like it's from that period of my life"? No entity, only fuzzy embedding.

Binding: predicate semantics rest on the existence of stable `canonical_id`s — this spec is the substrate that makes the "my ex" half work. The fuzzy-embedding half is out of scope and handled by `F-SYN-FOUNDATION-context-populator`'s recall-time surrounding_context channel.

### A5 — `research-retrieval-frontiers.md` Risks #14 Predicate-as-feature drift

> Predicate exclusion is a hard gate outside the learned ranker forever. Engagement on excluded memories triggers a `predicate_review_request` MCP affordance, not a ranker-side learning signal.

Binding: the `canonical_id` flows into the predicate gate (correctness, not score). Predicates compiled in week 1 must continue to match in week 52; alias-graph evolution in v1 MUST NOT mutate already-emitted `canonical_id`s. Aliases are projection-time joins, not re-extractions.

---

## 3. Type taxonomy (closed at v0)

The `EntityKind` enum is a **closed set of seven types**. Adding a new type is a versioned schema change with a coordinated update to `F-SYN-FOUNDATION-episodicity-feature.entity_specificity_prior` table — implementers MUST cross-reference both nodes when changing this enum.

```ts
type EntityKind =
  | 'person'      // human or person-like party (handle, contact, sender)
  | 'place'       // physical location (city, country, named room/venue)
  | 'org'         // company, team, group, institution
  | 'project'     // named work effort (repo, product, codename)
  | 'event'       // bounded happening with a time anchor (meeting, conference, release)
  | 'topic'       // subject matter (low specificity — see §3.1)
  | 'artifact';   // concrete reified object (file path, tool name, document title, URL)
```

### 3.1 entity_specificity_prior table (cross-referenced)

The episodicity feature consumes a per-kind specificity weight. This table is **owned by** `F-SYN-FOUNDATION-episodicity-feature` and **mirrored here** so the taxonomy and the prior never drift. If either node updates the table, the spec change MUST cite both nodes.

| kind     | specificity_prior |
|----------|------------------:|
| event    |              0.95 |
| person   |              0.90 |
| place    |              0.80 |
| project  |              0.70 |
| org      |              0.60 |
| artifact |              0.50 |
| topic    |              0.10 |

Adding a kind that is not in this table is a defect — `lib/ingest/salience.js` MUST fail closed if `specificity_prior[kind]` is undefined at any call site.

### 3.2 Out-of-scope at v0

Explicitly NOT entity kinds at v0: dates, times, time anchors (these are `features.time_anchors[]`, owned by `F-SYN-FOUNDATION-time-anchor-schema`); emotions (these are `features.valence`); URLs that are merely citation targets (these are `artifact` only when they reify a named resource the user might predicate on). Implementers MUST NOT smuggle these into `features.entities[]`.

---

## 4. The `Entity` shape

Every element of `features.entities[]` on a `fact` or `reconstructed` ledger row MUST conform exactly to:

```ts
interface Entity {
  /** One of seven kinds. Closed set. */
  kind: EntityKind;

  /** Source-scoped canonical id. Shape: `<kind>:<source_scope>:<surface_slug>`.
   *  Deterministic over (kind, source_scope, raw surface). See §5. */
  canonical_id: string;

  /** The surface form actually seen in the source row.
   *  Preserved verbatim (no case-fold, no NFC).
   *  Length 1..256 chars (UTF-8 codepoints, not bytes). */
  surface: string;

  /** Identifies the canonicalization scope. Mirrors the source name
   *  from `storage/sources/<source>.jsonl`. v0 alphabet:
   *  imessage | git-log | github-events | screentime | chat-claude-code | manual */
  source_scope: SourceScope;

  /** What promoted this entity past the conflation gate. See §6. */
  evidence: EvidenceKind;

  /** [0,1]. Extractor-emitted confidence; not a probability, an ordering. */
  confidence: number;

  /** Extractor version that emitted this entity (e.g. "v0.1.0").
   *  Lets the projection re-run under a tightened blocklist
   *  without re-stamping the ledger in place. */
  extractor_version: string;
}
```

### 4.1 `SourceScope` enum

```ts
type SourceScope =
  | 'imessage'
  | 'git-log'
  | 'github-events'
  | 'screentime'
  | 'chat-claude-code'
  | 'manual';
```

Adding a new source ledger requires adding its scope here AND specifying its evidence rules in §6.2. Unknown source values MUST raise `ENTITY_SCHEMA_UNKNOWN_SOURCE` at extractor invocation.

### 4.2 `EvidenceKind` enum

```ts
type EvidenceKind =
  | 'handle'             // sender/recipient handle or addressed identifier
  | 'kb_lookup'          // matched against an operator-curated KB list
  | 'structural'         // structurally-typed field (repo path, file path, tool name)
  | 'ner_corroborated';  // NER tag PLUS at least one corroborating signal (§6.4)
```

`ner_corroborated` REPLACES the earlier draft's `ner_with_evidence` (review §6.2). The corroborating signal MUST be specified by `Entity.confidence` source breakdown in the extractor's emit record; bare `ner` (no corroboration) is **forbidden** as an evidence kind — entities emitted on raw NER alone must be dropped at the gate.

### 4.3 Cardinality and ordering rules

- `features.entities[]` MAY be empty.
- Maximum entities per row: `CAPS.ENTITY_MAX_PER_ROW = 32`. Extractors MUST emit the top-32 by `(confidence, surface length)` desc and emit `policy.entity_extraction.truncated` if a row exceeded the cap.
- The array MUST be **sorted ascending by `canonical_id`** for byte-stable hashing of `fact` rows. Implementers MUST sort even when there is one element (so adding an element later does not produce a different content hash on a stable corpus).
- Duplicate `canonical_id`s in the same row MUST be coalesced (keep highest `confidence`).

---

## 5. canonical_id shape and the slug normalization algorithm

### 5.1 The shape

```
canonical_id := "<kind>" ":" "<source_scope>" ":" "<surface_slug>"
```

Examples:

- `person:imessage:alex_lastname`
- `person:git-log:alex_example_com`
- `project:git-log:memory_system`
- `artifact:chat-claude-code:mcp_lib_validation_js`
- `event:imessage:lx2_rollout_tuesday`

The structural prefix is **load-bearing**. It encodes the per-source scope mechanically into the id, which makes predicate scoping ("exclude anything `person:imessage:alex_*`") a substring match rather than a sidecar join. It also encodes the kind, so predicate language can scope by `kind`-prefix without a schema lookup.

### 5.2 Per-source slug normalization (deterministic)

Given a raw surface string `s` and a target slug, run the following pipeline **in order**. Two implementations diverging by a single step is a defect.

```
function slugify(surface: string): string {
  let x = surface;
  // Step 1 — Unicode normalization form C (NFC). Pin form explicitly;
  //           NFC vs NFD divergence on 'café' would produce different slugs.
  x = x.normalize('NFC');
  // Step 2 — ASCII-fold. Decompose to NFD, strip combining marks,
  //           then drop any remaining non-ASCII codepoint.
  x = x.normalize('NFD').replace(/\p{M}/gu, '');
  x = x.replace(/[^\x00-\x7F]/g, '');
  // Step 3 — Lowercase (Unicode-aware, but after ASCII-fold this is ASCII).
  x = x.toLowerCase();
  // Step 4 — Collapse runs of non-alphanumeric to underscore.
  x = x.replace(/[^a-z0-9]+/g, '_');
  // Step 5 — Strip leading and trailing underscores.
  x = x.replace(/^_+|_+$/g, '');
  // Step 6 — Truncate to 64 chars on byte length (== char length, all ASCII).
  if (x.length > 64) x = x.slice(0, 64);
  // Step 7 — If empty after the pipeline, return the sentinel '_empty_'.
  //           Empty slugs MUST NOT produce a malformed canonical_id; the
  //           gate (§6) is responsible for dropping entities with empty slugs.
  if (x.length === 0) return '_empty_';
  return x;
}
```

Validation: the regex `^[a-z0-9]+(_[a-z0-9]+)*$` MUST match every non-sentinel slug. The sentinel `_empty_` MUST never appear in a stamped `Entity.canonical_id` — emitters MUST refuse to stamp when the slug is `_empty_`.

### 5.3 Per-source surface-to-slug rules

Each source has a small surface-derivation rule that picks the raw string fed into `slugify()`. These rules are AUTHORITATIVE; substrate extractors implement them verbatim.

| source_scope     | kind     | surface derivation                                                                 |
|------------------|----------|------------------------------------------------------------------------------------|
| imessage         | person   | Use the contact's verified display name from the handle directory; fall back to the literal handle (`+1...` or `user@example.com`) if no display name. NEVER use NER-only names without `kb_lookup` corroboration. |
| imessage         | place    | KB-lookup only at v0. NER place mentions without KB confirmation are dropped.       |
| imessage         | org      | KB-lookup only at v0.                                                              |
| imessage         | project  | Operator-tagged or KB-lookup only.                                                 |
| imessage         | event    | KB-lookup only at v0.                                                              |
| imessage         | topic    | NOT EMITTED at v0 (FM-1 risk highest here).                                        |
| imessage         | artifact | URLs and attachment names; canonical surface is the URL's `host + first path segment` for URLs, the filename for attachments. |
| git-log          | person   | `git author email`, then `git author name` as fallback. The author-email IS the surface. |
| git-log          | place    | NOT EMITTED.                                                                       |
| git-log          | org      | Domain part of author-email when it matches an operator-confirmed org domain; else NOT EMITTED. |
| git-log          | project  | Repo path's basename (`memory-system`, `seed-library`).                      |
| git-log          | event    | NOT EMITTED at v0.                                                                 |
| git-log          | topic    | NOT EMITTED at v0.                                                                 |
| git-log          | artifact | File paths that appear in the diff hunk header (`mcp/lib/validation.js`).          |
| github-events    | person   | `actor.login` (always present on event payloads).                                  |
| github-events    | org      | Owner of `repo.full_name` (the `<owner>` part of `<owner>/<name>`).                |
| github-events    | project  | `repo.full_name` basename.                                                         |
| github-events    | event    | NOT EMITTED.                                                                       |
| github-events    | place    | NOT EMITTED.                                                                       |
| github-events    | topic    | NOT EMITTED at v0.                                                                 |
| github-events    | artifact | Issue / PR title (when entity is reified by URL).                                  |
| screentime       | artifact | Bundle id (`com.apple.MobileSMS`) when present; app name as fallback.              |
| screentime       | (others) | NOT EMITTED at v0 (ScreenTime carries no NER substrate).                           |
| chat-claude-code | person   | Operator's handle ONLY (from `~/.claude/projects` path token); other "people" surfaced inside chat are dropped at v0 (deferred to v1 with project-name normalizer; open question §10). |
| chat-claude-code | project  | The first path segment under `~/.claude/projects/` (`-Users-<username>-memory-system` slug). |
| chat-claude-code | artifact | File paths and tool names (`Bash`, `Read`, `Edit`); structural evidence required. |
| chat-claude-code | (others) | NOT EMITTED at v0.                                                                 |
| manual           | any      | Operator-supplied surface, slugified through §5.2.                                 |

`NOT EMITTED` means the extractor MUST NOT emit an entity of that `(source_scope, kind)` pair at v0. The substrate extractor's emit table is the only place these rules live; downstream consumers do not need to know what is NOT EMITTED — they will simply never see those entities.

### 5.4 canonical_id stability invariant

For any `(kind, source_scope, surface)` triple, `canonical_id` MUST be byte-stable across:

- Two invocations of the extractor on the same machine.
- Two invocations of the extractor on different machines.
- Re-extraction over the same source row at a later `extractor_version`.
- The cascade-stamp at promote time AND the recall-time `surrounding_context` populator.

This is the entire point of the contract. Any change to §5.2 or §5.3 is a versioned schema change that requires a coordinated re-extraction (see §8 migration story).

---

## 6. Conflation-resistance gate

Before any `Entity` is appended to `features.entities[]`, it MUST pass the gate. The gate is a sequence of allow checks; failing any drops the entity silently (without emitting a `policy` event — the volume is too high) but increments a metric `entity_extraction.gate_drops.<reason>`.

### 6.1 Universal gate (applies to every emit)

```
function admitEntity(entity, context):
  // (a) Minimum surface length.
  if codepointLength(entity.surface.trim()) < 3:
    drop('surface_too_short')

  // (b) Blocklist check (case-insensitive, post-trim).
  if STOPWORDS.has(normalizeForBlocklist(entity.surface)):
    drop('stopword')

  // (c) Empty slug.
  if slugify(entity.surface) === '_empty_':
    drop('empty_slug_after_normalize')

  // (d) Forbidden source/kind combination per §5.3.
  if entity.kind in NOT_EMITTED[entity.source_scope]:
    drop('source_kind_forbidden')

  // (e) Per-source evidence rule.
  if not perSourceEvidenceCheck(entity, context):
    drop('evidence_rule_failed')

  return true
```

### 6.2 Per-source evidence rules

| source_scope     | required evidence                                                                                          |
|------------------|------------------------------------------------------------------------------------------------------------|
| imessage         | `handle` for person; `kb_lookup` for place/org/project/event; `structural` (URL or attachment) for artifact |
| git-log          | `structural` (author-email, repo-path, file-path)                                                          |
| github-events    | `structural` (actor.login, repo.full_name, payload title)                                                  |
| screentime       | `structural` (bundle id or app name)                                                                       |
| chat-claude-code | `structural` (path segment under `~/.claude/projects`, tool name from harness, file path)                  |
| manual           | `handle` (operator typed it intentionally)                                                                 |

`ner_corroborated` is **only valid** for iMessage natural-language entities that BOTH matched a NER tag AND appear in a handle or KB-lookup pass. The combined signal is what justifies the kind — neither alone is sufficient on iMessage prose. v0 is intentionally conservative: when in doubt, drop.

### 6.3 STOPWORDS — the FM-1 blocklist

Lives in `mcp/lib/synthesis/entity-extractor.js` as the exported, frozen `STOPWORDS` (`Set<string>`; members lowercase, ASCII-folded). Members at v0:

```
Pronouns / determiners / prepositions / conjunctions / common copula:
'i', 'me', 'my', 'mine', 'myself',
'you', 'your', 'yours', 'yourself',
'he', 'him', 'his', 'himself',
'she', 'her', 'hers', 'herself',
'it', 'its', 'itself',
'we', 'us', 'our', 'ours', 'ourselves',
'they', 'them', 'their', 'theirs', 'themselves',
'this', 'that', 'these', 'those',
'a', 'an', 'the',
'and', 'or', 'but', 'so', 'because', 'if',
'is', 'are', 'was', 'were', 'be', 'been', 'being',
'do', 'does', 'did', 'done',
'has', 'have', 'had', 'having',

// FM-1 specific (review §6.3):
...operatorSelfTokens(),  // the user's own tokens: NOT literals, derived at module load (see below)
'claude',        // ambient mention; require structural evidence

// Common iMessage chitchat that NER promotes:
'thanks', 'thank', 'cool', 'yeah', 'okay', 'ok',
'hey', 'hi', 'hello', 'bye',
'today', 'tomorrow', 'yesterday', 'now', 'later',  // time anchors, not entities
'thing', 'stuff', 'things',
'someone', 'something', 'somewhere', 'anyone', 'anything',
'maybe', 'perhaps', 'probably', 'definitely',
```

The user's own tokens are **derived, not listed**: `operatorSelfTokens()` reads the identity config through `mcp/lib/identity/operator-identity.js` once, at module load, and contributes the local-part of every configured e-mail address plus every configured GitHub username, each folded through `normalizeForBlocklist` (trim, NFC, strip diacritics and non-ASCII, lowercase). With `config/operator-identity.example.json` that yields `alex`, `alex.example` and `alex-example`; with no identity configured it yields nothing, and only the fixed members above apply. On iMessage NL such a bare token shows up as a third-person mention and must never become a person entity without corroborating handle evidence. Changing the identity config changes the set only after the process restarts. The list MUST be reviewable by the user and surfacing in `memory_health.diagnostics.entity_stopwords_version`.

### 6.4 What "corroborated" means

For `evidence: 'ner_corroborated'`, the extractor MUST record in its emit log which signals corroborated the NER tag. The two valid corroborations on iMessage are:

1. **Handle match**: the surface appears in the conversation's `parties[]` handle directory (e.g. NER tagged "Robin" AND `parties` includes a contact `Robin Lastname`).
2. **KB lookup**: the surface matches an entry in the user's curated KB list at `<data root>/policy/entity-kb/<kind>.jsonl`.

The extractor MUST emit `entity_extraction.ner_corroborated` metrics tagged with which corroboration fired. NER + neither corroboration is a `gate_drops.evidence_rule_failed` drop.

---

## 7. Module surface

### 7.1 Extractor (substrate; landed in a later wave)

```ts
import type { SourceRow } from '../sources/types';

interface ExtractInput {
  /** Raw source row as it appears in storage/sources/<source>.jsonl. */
  row: SourceRow;
  /** The source name; MUST match SourceScope enum. */
  source: SourceScope;
  /** Optional shared context (party directory, KB lists) reused across rows. */
  context?: ExtractorContext;
}

interface ExtractOutput {
  /** Sorted ascending by canonical_id; max length CAPS.ENTITY_MAX_PER_ROW. */
  entities: Entity[];
  /** Per-row gate-drop metric increments. */
  drops: Record<string, number>;
  /** Set when the row exceeded ENTITY_MAX_PER_ROW. */
  truncated: boolean;
  /** Extractor version that ran. Stamped onto each entity.extractor_version. */
  extractor_version: string;
  /** Walltime ms for diagnostics. */
  latency_ms: number;
}

function extractEntities(input: ExtractInput): ExtractOutput;
```

The extractor is **pure-functional given `ExtractorContext`**. Two invocations with the same `(row, source, context)` MUST produce byte-identical `ExtractOutput.entities`. No clock reads, no random sampling, no network calls inside the extractor.

### 7.2 Canonical-id formation (pure helper)

```ts
function formCanonicalId(kind: EntityKind, source: SourceScope, surface: string): string;
```

Returns `<kind>:<source>:<slugify(surface)>` after running the validation regex; throws `ENTITY_SCHEMA_INVALID_SLUG` if the surface slugifies to `_empty_`.

### 7.3 Gate (pure helper)

```ts
function admitEntity(
  entity: Omit<Entity, 'canonical_id'>,
  context: ExtractorContext,
): { admit: true; canonical_id: string } | { admit: false; reason: string };
```

### 7.4 Cascade-stamp call site

`mcp/lib/ingest/salience.js` invokes `extractEntities()` between Stage-0 admission and the embed step (so the embed reuses the row content as-is, not the entity surface). The stamper MUST:

1. Call `extractEntities(row, source, ctx)`.
2. Set `fact.features.entities = output.entities`.
3. If `output.truncated`, emit `policy.entity_extraction.truncated {fact_id, source_msg_id, raw_count, kept: CAPS.ENTITY_MAX_PER_ROW}`.
4. NEVER mutate `output.entities` post-stamp.

### 7.5 Entity-index rebuild call site

`mcp/lib/recall/entity-index.js` (built later) builds the inverted index by streaming `ledgers/memory.jsonl` and bucketing by `canonical_id`. The index MUST be regenerated from scratch on any of:

- `extractor_version` bump (re-runs extraction over the entire ledger; emits a new feature_version, see §8).
- `STOPWORDS` change (treated as `extractor_version` bump in v0).
- Schema enum change (`EntityKind`, `SourceScope`, `EvidenceKind`).

The index MUST NOT modify any ledger row — it is a derived cache (`architecture.md` §5).

### 7.6 Recall-consume populator call site

`F-SYN-FOUNDATION-context-populator` calls a recall-time entity recognizer over `surrounding_context`. That recognizer MUST use the SAME `slugify()` and the SAME `STOPWORDS` set as the cascade-stamp path, OR predicates compiled in week 1 will silently stop matching. The recall-time recognizer's contract is owned by the context-populator node; this node defines only the contract that they share.

### 7.7 Predicate-evaluator call site

`mcp/lib/predicates/evaluator.js` (later) compares the predicate's captured entity set against a candidate row's `features.entities[]` set by `canonical_id` equality. Substring scoping (e.g. `person:imessage:*`) is the predicate language's job, not the evaluator's; the evaluator only does set membership over `canonical_id` strings.

---

## 8. Caps and versioning

Caps live in `mcp/lib/validation.js § CAPS`. New entries this spec introduces:

```js
// Entity schema (F-SYN-FOUNDATION-entity-schema)
ENTITY_SCHEMA_VERSION: 1,                  // bump on any structural change to Entity
ENTITY_EXTRACTOR_VERSION: 'v0.1.0',        // bump on extractor algorithm change
ENTITY_MAX_PER_ROW: 32,
ENTITY_SURFACE_MAX_LEN: 256,
ENTITY_SLUG_MAX_LEN: 64,
ENTITY_SLUG_REGEX: /^[a-z0-9]+(_[a-z0-9]+)*$/,
ENTITY_STOPWORDS: new Set([...]),          // see §6.3
ENTITY_KINDS: ['person','place','org','project','event','topic','artifact'],
ENTITY_SOURCE_SCOPES: ['imessage','git-log','github-events','screentime','chat-claude-code','manual'],
ENTITY_EVIDENCE_KINDS: ['handle','kb_lookup','structural','ner_corroborated'],
```

### 8.1 Migration story

When STOPWORDS tightens or per-source rules change (open question 10.4):

1. Bump `ENTITY_EXTRACTOR_VERSION` (e.g. `v0.2.0`).
2. Run `mcp/scripts/replay-entity-extraction.mjs` over the ledger. The script:
   - Reads each `fact` / `reconstructed` row.
   - Re-runs `extractEntities()` against the original `source_refs[0].source_msg_id` (resolving via the source ledger).
   - Computes the diff `(old_entities, new_entities)`.
   - If non-empty, emits a `policy.entity_re_extraction` event carrying `(fact_id, removed: [...], added: [...], extractor_version_from, extractor_version_to)`.
   - The projection joins the policy event when building the entity index; the ledger fact row is NEVER mutated in place (architecture.md §4 append-only invariant).
3. Bump `ENTITY_SCHEMA_VERSION` only if the structural shape changed (e.g. new field, removed field). Adding STOPWORDS members is an extractor change, not a schema change.

This makes "tighten the FM-1 blocklist" a 3-minute replay (byte-idempotent arithmetic over already-stored content) rather than a destructive ledger surgery.

### 8.2 Cross-source alias graph (v1 deferred)

v0 ships per-source-scoped ids. v1 adds an alias graph at `<data root>/policy/entity-aliases.jsonl` as policy events of the form:

```ts
interface EntityAliasPolicy {
  kind: 'policy.entity_alias';
  applied_at: ISO8601;
  members: string[];          // 2+ canonical_ids that name the same real entity
  basis: 'operator_confirmed' | 'auto_handle_email_match';
  confidence: number;
}
```

Recall and predicate evaluator MUST treat any member of an alias group as equivalent at query time, via a projection-time join over the alias log. **Crucially, alias is NOT re-extraction**: the `canonical_id`s already stamped on ledger rows are never rewritten. This makes the v1 graph a forgiving join, not a schema migration.

Operator-confirmed merges are the default at v1; the auto-handle+email merge path is gated behind an explicit cap (`CAPS.ENTITY_ALIAS_AUTO_MERGE_ENABLED = false` at ship).

---

## 9. Worked examples

### 9.1 iMessage prose — the FM-1 collapse averted

Source row (synthesized but representative of the user's iMessage corpus):

```json
{
  "id": "imsg-7f81",
  "ts": "2026-06-10T14:32:00Z",
  "source": "imessage",
  "source_msg_id": "Q-2026-06-10T14:32:00-handle:+15550100001",
  "parties": [
    {"handle": "+15550100001", "display_name": "Alex Lastname"},
    {"handle": "operator", "display_name": "Operator"}
  ],
  "raw_content": "And your sync with Alex moved to tuesday at 2, so let us hand the LX-2 rollout call back to him then."
}
```

A naive NER over `raw_content` would emit `name:And`, `name:Your`, `name:Alex`, `time:tuesday at 2`, `name:LX-2`. Under this spec's gate:

- `And` → drops at `stopword` (in STOPWORDS).
- `Your` → drops at `stopword`.
- `Alex` (bare) → drops at `stopword`: under the example identity config `alex` is one of the user-derived tokens (§6.3). To admit the person the gate requires handle corroboration: NER tag PLUS a `parties[].display_name` that contains `Alex Lastname`. The surface then becomes `Alex Lastname`, evidence `handle`, kind `person`; the full surface normalizes to `alex lastname`, which is not a STOPWORDS member. `slugify("Alex Lastname")` → `alex_lastname`. `canonical_id` → `person:imessage:alex_lastname`.
- `tuesday at 2` → drops; this is a time anchor, owned by `F-SYN-FOUNDATION-time-anchor-schema`.
- `LX-2` → admitted only if KB-lookup hits `<data root>/policy/entity-kb/project.jsonl`. Suppose the KB lists `LX-2` and `Acmebot LX-2`; the surface used is the KB's canonical surface `Acmebot LX-2`. Evidence `kb_lookup`, kind `project`. `canonical_id` → `project:imessage:acmebot_lx_2`.

Emit:

```json
{
  "entities": [
    {
      "kind": "person",
      "canonical_id": "person:imessage:alex_lastname",
      "surface": "Alex Lastname",
      "source_scope": "imessage",
      "evidence": "handle",
      "confidence": 0.95,
      "extractor_version": "v0.1.0"
    },
    {
      "kind": "project",
      "canonical_id": "project:imessage:acmebot_lx_2",
      "surface": "Acmebot LX-2",
      "source_scope": "imessage",
      "evidence": "kb_lookup",
      "confidence": 0.85,
      "extractor_version": "v0.1.0"
    }
  ],
  "drops": {"stopword": 3, "evidence_rule_failed": 0},
  "truncated": false,
  "extractor_version": "v0.1.0",
  "latency_ms": 4
}
```

Note the sort order: `person:...` precedes `project:...` lexicographically — this is the byte-stable order required by §4.3.

### 9.2 git-log commit — structural evidence path

Source row:

```json
{
  "id": "git-9af2",
  "ts": "2026-06-15T09:14:12Z",
  "source": "git-log",
  "source_msg_id": "memory-system:b3a912f8",
  "parties": [{"handle": "operator", "email": "alex@example.com", "name": "Alex"}],
  "raw_content": {
    "repo": "memory-system",
    "commit": "b3a912f8",
    "author_email": "alex@example.com",
    "author_name": "Alex",
    "subject": "R34: pin entity schema (foundation-tier spec)",
    "files": ["mcp/docs/specs/synthesis/entity-schema.md", "mcp/lib/validation.js"]
  }
}
```

Extraction:

- `author_email = "alex@example.com"` → kind `person`, evidence `structural`, surface `alex@example.com`. `slugify` → `alex_example_com`. `canonical_id` → `person:git-log:alex_example_com`.
- `repo = "memory-system"` → kind `project`, evidence `structural`. `canonical_id` → `project:git-log:memory_system`.
- `files[0]` → kind `artifact`, evidence `structural`. `slugify("mcp/docs/specs/synthesis/entity-schema.md")` → `mcp_docs_specs_synthesis_entity_schema_md`. `canonical_id` → `artifact:git-log:mcp_docs_specs_synthesis_entity_schema_md`.
- `files[1]` → kind `artifact`. `canonical_id` → `artifact:git-log:mcp_lib_validation_js`.
- Author `name = "Alex"` → drops at `stopword` (bare 'alex'). The `author_email` is the canonical surface; the `name` is decoration.

Emit (sorted by `canonical_id`):

```json
{
  "entities": [
    {"kind":"artifact","canonical_id":"artifact:git-log:mcp_docs_specs_synthesis_entity_schema_md","surface":"mcp/docs/specs/synthesis/entity-schema.md","source_scope":"git-log","evidence":"structural","confidence":1.0,"extractor_version":"v0.1.0"},
    {"kind":"artifact","canonical_id":"artifact:git-log:mcp_lib_validation_js","surface":"mcp/lib/validation.js","source_scope":"git-log","evidence":"structural","confidence":1.0,"extractor_version":"v0.1.0"},
    {"kind":"person","canonical_id":"person:git-log:alex_example_com","surface":"alex@example.com","source_scope":"git-log","evidence":"structural","confidence":1.0,"extractor_version":"v0.1.0"},
    {"kind":"project","canonical_id":"project:git-log:memory_system","surface":"memory-system","source_scope":"git-log","evidence":"structural","confidence":1.0,"extractor_version":"v0.1.0"}
  ],
  "drops": {"stopword": 1},
  "truncated": false,
  "extractor_version": "v0.1.0",
  "latency_ms": 1
}
```

Note: `person:git-log:alex_example_com` is a **different** canonical_id than the iMessage `person:imessage:alex_lastname` even if both refer to the same human at some other scope. At v0 this is acceptable; v1's alias graph will optionally join them with operator confirmation.

### 9.3 github-events PullRequestEvent — structural-only path

Source row:

```json
{
  "id": "gh-1b04",
  "ts": "2026-06-12T17:01:00Z",
  "source": "github-events",
  "source_msg_id": "gh:8123456789",
  "raw_content": {
    "type": "PullRequestEvent",
    "actor": {"login": "alex"},
    "repo": {"full_name": "example-org/example-repo"},
    "payload": {"action": "closed", "pull_request": {"merged": true, "title": "feat: add seed-catalog import"}}
  }
}
```

Extraction:

- `actor.login = "alex"` → kind `person`, evidence `structural`. `canonical_id` → `person:github-events:alex`. Note: the stopword `alex` does NOT apply here because `structural` evidence bypasses the FM-1 risk (this is a GitHub username, not NL prose).
- `repo.full_name = "example-org/example-repo"` splits: org `example-org` → `org:github-events:example_org`; project `example-repo` → `project:github-events:example_repo`.
- `payload.pull_request.title` → kind `artifact`. `canonical_id` → `artifact:github-events:feat_add_seed_catalog_import`.

Important nuance: STOPWORDS is applied to NL prose at iMessage. For structural fields (handles, logins, repo paths), the stopword check is **bypassed** because the FM-1 conflation does not occur on structurally-typed surfaces. The gate logic at §6.1 (b) takes the source's evidence kind into account:

```js
function admitEntity(entity, context) {
  // ... checks (a), (c), (d) ...
  if (entity.evidence !== 'structural' && STOPWORDS.has(normalizeForBlocklist(entity.surface))) {
    return drop('stopword');
  }
  // ... continue with checks (e) ...
}
```

This is a key invariant: **STOPWORDS is a NER guardrail, not a structural one**. (See review §6.2 — `ner_corroborated` evidence STILL applies stopwords; only pure `structural` bypasses them.)

### 9.4 Predicate captured at week 1, matched at week 52

Operator at week 1 says "exclude anything about Alex Lastname in iMessage":

```
exclude(scope: 'imessage', predicate: {entity_canonical_ids: ['person:imessage:alex_lastname']})
```

The predicate is captured by `memory_exclude` as a snapshot referencing `person:imessage:alex_lastname`.

At week 52:

- The cascade has continued to stamp `person:imessage:alex_lastname` on every relevant `fact` (the slug is byte-stable).
- STOPWORDS tightened at week 4 to add `'maybe'` and `'perhaps'`; `extractor_version` bumped to `v0.2.0`. The replay re-ran extraction; no `alex_lastname` entity was affected (the replay diff shows only removals on rows where the new stopwords would have prevented bad emits — it was a clean handle-corroborated emit on day one).
- v1 landed at week 30; the user confirmed `person:imessage:alex_lastname` and `person:git-log:alex_example_com` are the same human. An alias-policy event was emitted.
- At week 52 the predicate evaluator at recall time joins the alias log: a row whose entities include `person:git-log:alex_example_com` ALSO matches the week-1 predicate, because the alias graph says it's the same entity.

The predicate captured in week 1 continues to match in week 52, AND its scope EXPANDED (without re-capture) because the user confirmed an alias. No ledger row was rewritten; no extraction was re-run; the projection did the work at recall time. This is the invariant the spec exists to honor.

---

## 10. Open questions (carry forward as wave-N tasks)

1. **Alias-graph confirmation policy (v1).** Does the user confirm every cross-source merge, or do high-confidence handle+email pairs auto-merge under `CAPS.ENTITY_ALIAS_AUTO_MERGE_ENABLED`? Recommendation: ship v1 with auto-merge OFF; let operator add a small confirmation UI in the MCP surface. Concrete decision deferred to a v1 task.
2. **Prefix-vs-sidecar source_scope encoding.** This spec picks prefix. Prefix is structurally load-bearing for predicate scoping and string-search ergonomics; sidecar would have made alias migration slightly less surgical. The choice is irreversible without a ledger replay; if a future wave reverses it, the cost is a one-time `replay-entity-extraction.mjs` with a schema bump.
3. **chat-claude-code structural evidence for non-tool entities.** Tool names (`Bash`, `Read`) and project paths are clean structural emits. File paths emitted inside chat are clean. But conversation prose mentioning "Robin" or "the contractor" is exactly the FM-1 risk on iMessage NL — at v0 we drop them. v1 needs a project-name normalizer OR a confirmation surface; deferred.
4. **STOPWORDS tightening migration.** Already addressed at §8.1: bump `extractor_version`, run `replay-entity-extraction.mjs`, emit `policy.entity_re_extraction` events. The replay script itself is unbuilt; spec for it is `F-SYN-FOUNDATION-derivation-propagation` adjacent and lives in a substrate-tier node.
5. **NFC vs NFD pin under font-engine evolution.** This spec pins NFC pre-ASCII-fold. If the user's input pipeline starts emitting NFD (some macOS file APIs do — `HFS+`-era paths are NFD), the slugifier still normalizes correctly at step 1. But a future bug where step 1 is skipped would be silent. Add a test fixture `'café' === slugify('café')` to the CI gate.
6. **Operator tokens in STOPWORDS are per-host.** Implemented for the user's own tokens: they come from the identity config at module load (§6.3), so no personal name is hardcoded. What stays open is the fixed remainder (`'claude'` and the chitchat members): it is still a literal in `mcp/lib/synthesis/entity-extractor.js`. Moving it to a config file loaded at startup (for example `<data root>/policy/entity-stopwords.json`) is deferred to a substrate-tier task.

---

## 11. Invariants (must hold across implementations)

These are the contract's load-bearing claims. CI MUST gate every one.

- **(I1) canonical_id byte-stability.** For fixed `(kind, source_scope, surface, ENTITY_EXTRACTOR_VERSION, ENTITY_STOPWORDS_HASH)`, `canonical_id` is byte-identical across machines and invocations.
- **(I2) Slug regex.** Every emitted slug matches `^[a-z0-9]+(_[a-z0-9]+)*$`. The sentinel `_empty_` never appears in stamped entities.
- **(I3) Entity-set sort order.** `features.entities[]` is sorted ascending by `canonical_id`. The sort comparator is byte-wise (lexicographic on the canonical id string).
- **(I4) Closed enums.** `kind ∈ ENTITY_KINDS`, `source_scope ∈ ENTITY_SOURCE_SCOPES`, `evidence ∈ ENTITY_EVIDENCE_KINDS`. Any other value is a failure-closed error.
- **(I5) STOPWORDS scope.** Stopwords block `evidence ∈ {handle, kb_lookup, ner_corroborated}` emits; stopwords do NOT block `structural` emits. The structural-bypass is the gate logic at §6.3 example 9.3.
- **(I6) Append-only ledger.** Re-extraction NEVER mutates an existing `fact` row's `features.entities[]`. Re-extraction emits `policy.entity_re_extraction` events; the projection applies them at index-build time.
- **(I7) Aliases do not re-extract.** `policy.entity_alias` events join at projection time; `canonical_id` on a stamped row stays.
- **(I8) Closed evidence semantics.** A `fact` with `entities[i].evidence === 'ner_corroborated'` MUST have at least one corroboration recorded in the extractor's emit log. The extractor MUST refuse to emit `ner_corroborated` without recorded corroboration.
- **(I9) Type-prior coherence.** `F-SYN-FOUNDATION-episodicity-feature.entity_specificity_prior` MUST be defined for every `EntityKind` in `ENTITY_KINDS`. CI cross-checks both nodes.
- **(I10) Per-source NOT-EMITTED enforcement.** A `(source_scope, kind)` pair listed as NOT EMITTED in §5.3 MUST never appear in any stamped row.
- **(I11) Predicate evaluator equality.** Predicate matching is `canonical_id` set-membership; substring matching for kind/scope prefix is a predicate-language feature, not an evaluator feature. The evaluator MUST NOT do fuzzy matching.

---

## 12. Cross-tier impact

This spec is the lowest-level entity contract; many other nodes constrain to it.

| Node | Constraint introduced |
|---|---|
| `F-SYN-FOUNDATION-context-populator` | Recall-time surrounding_context entity recognizer MUST use the SAME `slugify()` and `STOPWORDS` set as the extractor, OR predicates compiled at week 1 will silently stop matching. |
| `F-SYN-FOUNDATION-derivation-propagation` | When a row is excised, derivation propagation MUST consult `features.entities[]` to compute orphan flags only on the affected `canonical_id`s; the propagation walks edges by `canonical_id` set intersection, not surface-string. |
| `F-SYN-FOUNDATION-episodicity-feature` | Owns the `entity_specificity_prior` table mirrored at §3.1 here. CI MUST cross-check that both nodes carry the same kinds and priors. |
| `F-SYN-SUBSTRATE-entity-extractor` | Implements `extractEntities()` per §7.1; module path `mcp/lib/synthesis/entity-extractor.js` (TBD by substrate-tier node). |
| `F-SYN-INTEGRATION-CASCADE-STAMPS-ENTITIES` | Wires §7.4 into `mcp/lib/ingest/salience.js`. |
| `F-SYN-INTEGRATION-RECALL-CONSUMES-ENTITIES` | Wires the recall-time entity reader to `features.entities[]`. |
| `F-SYN-INTEGRATION-CASCADE-STAMPS-EPISODICITY` | Reads `Entity.kind` to compute episodicity; constrained by §3.1 table coherence. |
| `mcp/lib/validation.js § CAPS` | Adds the constants in §8. |
| `mcp/lib/predicates/evaluator.js` (existing) | MUST treat `Entity.canonical_id` as opaque strings; MUST consult `policy.entity_alias` events at v1 via the projection. |

The spec does NOT constrain:

- The embedding model (entities are NOT embedded; the entity-overlap feature is Jaccard over `canonical_id` sets, per `research-retrieval-frontiers.md` Layer 2).
- The valence / time-anchor schemas (separately owned).
- The salience cascade Stage-0 rules (which fire BEFORE this spec runs).

---

## 13. Implementation checklist (for the future substrate-tier task)

A future implementer building `mcp/lib/synthesis/entity-extractor.js` should:

- [ ] Add the CAPS constants from §8 to `mcp/lib/validation.js`.
- [ ] Write `mcp/lib/synthesis/canonical-id.js` exporting `slugify()`, `formCanonicalId()`. Pure-functional; ESM; no I/O.
- [ ] Write `mcp/lib/synthesis/entity-stopwords.js` exporting the user-tuned `STOPWORDS` set. Read from `<data root>/policy/entity-stopwords.json` if present; fall back to the §6.3 default list.
- [ ] Write `mcp/lib/synthesis/entity-extractor.js` exporting `extractEntities()` per §7.1. Per-source extraction strategies dispatched on `source_scope`.
- [ ] Write `mcp/lib/synthesis/entity-kb-lookup.js` reading `<data root>/policy/entity-kb/{person,place,org,project,event,topic,artifact}.jsonl`. Cache in-process; reload on file `mtime` bump.
- [ ] Tests at `mcp/test/synthesis/entity-extractor.test.js`:
  - The §9.1 / §9.2 / §9.3 fixtures pass.
  - All §11 invariants are property-tested.
  - NFC vs NFD divergence fixture `slugify('café') === slugify('caf́e')` passes.
  - STOPWORDS membership case-fold fixture: `slugify('And')` admitted as surface but blocked at the gate.
  - `policy.entity_extraction.truncated` emitted when a synthetic row carries >32 entities.
- [ ] CI cross-check: `ENTITY_KINDS` equals the keys of `entity_specificity_prior` (§3.1).
- [ ] CI cross-check: every entry in §5.3 has corresponding evidence-rule logic in `extractEntities()`.

When this checklist is complete, the four call sites (§7.4, §7.5, §7.6, §7.7) can be wired by the integration-tier nodes.

---

## 14. Footnote on naming

The earlier draft's evidence kind `ner_with_evidence` was renamed `ner_corroborated` per review (§6.2). Implementers SHOULD prefer `ner_corroborated` in code; the migration is mechanical (string rename). Any pre-spec usage of `ner_with_evidence` MUST be treated as `ner_corroborated` until the corpus is empty of the legacy value.
