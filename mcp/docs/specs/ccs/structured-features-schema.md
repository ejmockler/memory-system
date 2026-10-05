# `row.structured_features` — connector-emitted, cascade-merged shape

**Node:** `F-CCS-FOUNDATION-structured-features-schema`
**Tier:** foundation (W1-CCS, `design_spec`, **BLOCKER**)
**Status:** ready to ship.
**Blocks:** every W-CCS connector node (git-log, github-events, imessage, screentime, chat-claude-code, codex-cli) AND the cascade-merge node (`F-CCS-CASCADE-structured-features-merge`).

---

## 1. Mission

The salience cascade today re-derives entities and time anchors **from raw text** every time it promotes a fact. The connectors already know — at emit time — who the parties are (`author_email` for git-log, `actor.login` for github-events, contact handle for iMessage), what the project is (`repo_path` basename, `repo.full_name`), and when the event happened (`commit_ts`, `event.created_at`, `message.date_apple`). Forcing the cascade's text extractor to reconstruct what the connector authoritatively knows is the FM-1 regression in slow motion: a fuzzy NER pass over `subject = "Initial commit"` cannot recover the author's email, and we lose structural ground truth to entropic re-extraction.

This spec pins `row.structured_features` — a NEW optional top-level field on the source-ledger row schema (alongside `id`, `ts`, `source`, `source_msg_id`, `parties`, `raw_content`, `attachments`, `source_policy`, `checksum` from `architecture.md` § 1) — that every CCS connector emits and that the cascade merges into `fact.features` at promote time. The merge is **union-with-precedence**: structured wins on `canonical_id` collision, text-extracted additions are preserved. Rows without the field cascade unchanged (text-extractor-only path).

The unifying invariant: **`canonical_id` is byte-stable across connector emit AND cascade text-extraction.** A predicate captured against a structured-feature `canonical_id` continues to match against a text-extracted `canonical_id` of the same surface, because both paths route through the same `slugify()` from `mcp/lib/synthesis/canonical-id.js` (per `mcp/docs/specs/synthesis/entity-schema.md` § 5.2). This is what makes the merge a union, not a replacement.

---

## 2. KB anchors (binding quotes)

The contract grounds in four passages. Each is reproduced verbatim; binding language is preserved.

### A1 — `agent-integration.md` § Connectors — the shared base abstraction (the surface this spec extends)

> Phase 2b ships the `imessage`, `screentime-knowledgec`, `git-log-local`, and `github-events` connectors against a single shared module at `mcp/lib/connectors/index.js`. Each impl daemon composes with `ConnectorBase` rather than re-deriving auth handling, cursor persistence, idempotent append, source_policy stamping, or health reporting. The contract from `kb/ingestion.md § Connector contract` is the spec; this section enumerates the concrete surface the daemons target.
>
> **What the impl daemon owns (NOT ConnectorBase):**
>
> - The `sourcePolicyForRow(row) → {deletion_semantics, consent_basis}` classifier closure. Each connector's edges (round-20 C1 authorship-trumps-audience for iMessage outbound; iMessage business-account prefix `BIZ:`; tapback `kind:"reaction"`; etc.) live in the daemon, not the base class. The base never inspects the classifier's logic — it just calls the closure and stamps the result.

**Binding.** The connector-emit boundary is the right place to stamp `structured_features`. The base class never inspects the structured payload — like `sourcePolicyForRow`, it is per-source closure logic. The daemon owns extraction; the base owns dedupe + append + cursor (the impl-daemon-vs-ConnectorBase split is the load-bearing discipline this spec extends).

### A2 — `architecture.md` § 1 Source ledgers (the row schema this extends)

> ```
> {
>   id, ts, source, source_msg_id,
>   parties: [],
>   raw_content,
>   attachments: [],
>   source_policy: { deletion_semantics, consent_basis },
>   checksum
> }
> ```
> Connectors run as background daemons, one process per source. Untransformed at this layer; the raw stream is preserved indefinitely (subject to `source_policy`).

**Binding.** `structured_features` is a NEW optional top-level field on this schema. "Untransformed at this layer" is preserved because the structured features are **additive metadata about the row**, not a transformation of `raw_content` — they extract what the connector already knows from structurally-typed fields it was already reading to populate `parties` and `source_msg_id`. The `checksum` (blake2b512 truncated to 16 bytes, lowercase hex 32-char) covers `structured_features` when present, per the existing "checksum is over all fields except itself" discipline.

### A3 — `architecture.md` § 5 Index

> Derived from the memory ledger, never authoritative. Treat as cache; rebuild from the ledger at any time.

**Binding.** Structured features on `row.structured_features` are AUTHORITATIVE at the source-ledger layer (the connector knows). After promote-time merge they land on `fact.features` (the architecture.md § 4 slot) — at which point the entity / time / derivation indices project off `fact.features` exactly as today. The merge does not introduce a second source of truth; it accelerates the projection by giving the cascade pre-resolved structural inputs that the text extractor would otherwise re-derive (poorly, see FM-1).

### A4 — `salience-design.md` Appendix A.1 (FM-1 evidence — why this exists)

> FM-1 entity-tagger conflation **empirically confirmed** in the captured corpus — `name:Alex`, `name:Your`, `name:And` all promote to semantic candidates under a naive NER pass, producing noise *amplification* on iMessage natural-language entities

**Binding.** Structural emit from the connector is the FM-1 antidote. `author_email = "alex@example.com"` from git-log is unambiguous; `actor.login = "example-org"` from github-events is unambiguous; `handle_id = "urn:biz:..."` from iMessage is unambiguous. Stamping these as `evidence: "structural"` per `entity-schema.md` § 4.2 means the FM-1 STOPWORDS check is **bypassed** for them (per `entity-schema.md` § 6.3 — STOPWORDS gates `handle | kb_lookup | ner_corroborated`, NOT `structural`). The cascade's text extractor remains free to run on `raw_content` text for additional NER-corroborated entities; structural and text contributions union per § 6 below.

---

## 3. The shape

### 3.1 TypeScript-style schema

```ts
/**
 * Optional top-level field on source-ledger rows. Added alongside the existing
 * fields from architecture.md § 1; rows from connectors that have not been
 * upgraded simply omit it (backwards-compat, see § 7).
 *
 * Carried verbatim through ConnectorBase.appendLedgerRow → JSON.stringify.
 * Covered by the row checksum (blake2b512-trunc-16 over canonical_json of all
 * fields except `checksum`).
 */
interface StructuredFeatures {
  /**
   * Required. Schema discriminator. v0 = "v1" (the first shipped version of
   * the structured-features shape). Bump on any structural change to this
   * interface; cascade reads version-gate at merge time.
   */
  schema_version: "v1";

  /**
   * Required. Identifies the connector emitter (module path or daemon name +
   * semver). Lets the drift detector (`F-SYN-OPERATIONAL-drift-detection`)
   * spot upgrades and re-extract retroactively. Matches the regex
   * /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/ from
   * time-anchor-schema.md I8 (same discipline).
   *
   * Examples:
   *   "git-log-local@1.0.0"
   *   "github-events@1.0.0+events-api-v3"
   *   "imessage@1.0.0+biz-prefix"
   */
  emitter_version: string;

  /**
   * Optional. Pre-resolved entities the connector knows from structurally-typed
   * fields it was already reading. Each entity MUST conform to the Entity
   * shape in mcp/docs/specs/synthesis/entity-schema.md § 4 — same kind enum,
   * same canonical_id formation, same evidence taxonomy. The connector path
   * exclusively emits evidence in {handle, structural, kb_lookup}; the
   * cascade's text-extractor path may additionally emit ner_corroborated.
   *
   * The array MUST be sorted ascending by canonical_id (byte-stable hashing).
   * Max length CAPS.ENTITY_MAX_PER_ROW = 32 (same as cascade-stamp path).
   * Empty array is permitted (some sources emit only time anchors).
   */
  entities?: Entity[];

  /**
   * Optional. Pre-resolved time anchors the connector knows from structurally-
   * typed timestamps (commit_ts, event.created_at, message.date_apple). Each
   * MUST conform to the TimeAnchor shape in
   * mcp/docs/specs/synthesis/time-anchor-schema.md § Schema.
   *
   * Connector emits use kind="absolute" almost exclusively (raw_phrase is the
   * ISO string verbatim; extractor_confidence = 1.0 for structurally-typed
   * timestamps). Relative / recurring anchors are NOT emitted by connectors —
   * those remain text-extractor territory.
   *
   * Max length CAPS.TIME_ANCHORS_MAX_PER_FACT = 8. Empty array permitted.
   */
  time_anchors?: TimeAnchor[];

  /**
   * Optional. Normalized parties — typed equivalents of the existing
   * row.parties[] but lifted into entity-schema canonical_ids. The connector
   * already populates row.parties[]; this field is a CONVENIENCE re-export
   * keyed for the merger (see § 6.3). Each string MUST be a valid Entity
   * canonical_id of kind `person` per entity-schema.md § 5.1 — i.e. shape
   *   "person:<source_scope>:<surface_slug>"
   *
   * Why both row.parties[] AND structured_features.parties[]:
   *   row.parties[] is OPAQUE — handle strings, no slugify. Reading it
   *   requires the consumer to know per-source surface rules. This field
   *   is the canonicalized projection so the merger can intersect by
   *   canonical_id directly without re-running slug derivation.
   *
   * Defensive: missing or empty implies the cascade may still derive person
   * entities from row.parties[] via row-parties-as-entities
   * (F-CCS-CASCADE-row-parties-as-entities). The field exists to LET the
   * connector pin the canonicalization; it does not REQUIRE it.
   */
  parties?: string[];

  /**
   * Optional opaque bag. Connector-private structured payloads the
   * cascade does not know how to interpret. Reserved for per-source
   * extensions (e.g. github-events PR labels, iMessage tapback target_guid,
   * git-log commit parent SHAs) that downstream consumers might want to
   * project off the source ledger LATER without re-parsing raw_content.
   *
   * The cascade MUST NOT consume source_specific at promote time in v0 —
   * it is documented as a future-extension surface. CI gates that any
   * key inside source_specific is JSON-serializable; no further structural
   * constraint.
   */
  source_specific?: Record<string, unknown>;
}

/**
 * The Entity shape is OWNED by mcp/docs/specs/synthesis/entity-schema.md § 4.
 * Reproduced inline for cross-reference. ANY drift between this file and
 * entity-schema.md is a CI failure — both must declare the same fields.
 */
interface Entity {
  kind: 'person' | 'place' | 'org' | 'project' | 'event' | 'topic' | 'artifact';
  canonical_id: string;        // `<kind>:<source_scope>:<surface_slug>`
  surface: string;             // verbatim source surface (no case-fold, no NFC)
  source_scope:
    | 'imessage' | 'git-log' | 'github-events'
    | 'screentime' | 'chat-claude-code' | 'codex-cli' | 'manual';
  evidence: 'handle' | 'kb_lookup' | 'structural' | 'ner_corroborated';
  confidence: number;          // [0, 1]
  extractor_version: string;
}

/**
 * The TimeAnchor shape is OWNED by mcp/docs/specs/synthesis/time-anchor-schema.md
 * § Schema. Reproduced minimally; consult that file for parsed-field rules.
 */
interface TimeAnchor {
  kind: 'absolute' | 'relative' | 'recurring';
  raw_phrase: string;
  parsed: {
    iso?: string;
    offset_from?: 'event_ts' | 'now';
    offset_seconds?: number;
    duration_seconds?: number;
    recurrence?: { /* RFC-5545 subset; see time-anchor-schema.md */ };
  };
  extractor_confidence: number;
  extractor_version: string;
  recurrence_resolution_deferred?: boolean;
}
```

### 3.2 CAPS additions (`mcp/lib/validation.js`)

```js
// Structured features (F-CCS-FOUNDATION-structured-features-schema)
STRUCTURED_FEATURES_SCHEMA_VERSION: "v1",                 // frozen for v0 ship
STRUCTURED_FEATURES_EMITTER_VERSION_REGEX:
  /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/,
STRUCTURED_FEATURES_MAX_BYTES: 16384,                     // 16KB per row guard
STRUCTURED_FEATURES_VALID_EVIDENCE_AT_CONNECTOR:
  Object.freeze(["handle", "structural", "kb_lookup"]),   // NO ner_corroborated
```

The `STRUCTURED_FEATURES_VALID_EVIDENCE_AT_CONNECTOR` cap is a hard gate at the connector layer: a connector emitting `evidence: "ner_corroborated"` indicates a code path bug (NER is the cascade's job, not the connector's) and the schema validator MUST refuse such a row. The cascade text-extractor path is the ONLY caller permitted to stamp `ner_corroborated`.

---

## 4. Source-row carrier (where on the row this lives)

`structured_features` is a NEW **optional top-level field** on every source-ledger row. The carrier shape for a row from `storage/sources/<src>.jsonl` after this spec lands:

```jsonc
{
  "id": "ulid_...",
  "ts": "2026-01-15T10:00:00.000Z",
  "source": "git-log",
  "source_msg_id": "git:0123456789abcdef0123456789abcdef01234567",
  "parties": ["alex@example.com"],
  "raw_content": { /* per-source raw payload (unchanged) */ },
  "attachments": [],
  "source_policy": { "deletion_semantics": "full_excise", "consent_basis": "first_party" },

  // NEW: optional structured-features payload from the connector.
  "structured_features": {
    "schema_version": "v1",
    "emitter_version": "git-log-local@1.0.0",
    "entities": [ /* see worked examples § 5 */ ],
    "time_anchors": [ /* see worked examples § 5 */ ],
    "parties": [ /* see worked examples § 5 */ ]
    // source_specific omitted in this row
  },

  "checksum": "<blake2b512-trunc-16-hex over canonical_json of every field above except `checksum`>"
}
```

**Checksum coverage.** The existing rule from `architecture.md` § 1 stands: `checksum` is computed over the canonical JSON of EVERY field except `checksum` itself. When `structured_features` is present, it is included in the preimage; when it is absent, the preimage is identical to today's. This means:

- An upgraded connector's row has a checksum that DIFFERS from a hypothetical pre-upgrade row carrying identical other fields — the structured payload IS part of the row's byte-identity.
- The corrupt-tail-truncation discipline from `ingestion.md` § Failure modes works unchanged. A connector upgrade does not invalidate prior rows (their checksums covered the pre-upgrade preimage and remain valid).
- The cascade's promote-time consumer reads `row.structured_features` AFTER the row has been verified by the connector's append-time checksum gate — no re-verification needed at consumer side.

**ConnectorBase contract impact.** `ConnectorBase.appendLedgerRow(row)` does NOT need to be modified — it stringifies whatever shape the daemon hands it. The daemon-owned `sourcePolicyForRow` closure today returns `{deletion_semantics, consent_basis}`; this spec introduces a sibling per-row helper, `buildStructuredFeatures(row) → StructuredFeatures | undefined`, owned by the daemon and invoked by the daemon **before** calling `appendLedgerRow`. The base class never inspects the helper's output; it just passes the assembled row through to the dedupe + append + cursor discipline.

**Order of operations inside the daemon (per emit):**

1. Compute `source_msg_id` from raw source fields (existing).
2. Compute `structured_features` from raw source fields (NEW; per-source helper).
3. Assemble the row: `{id, ts, source, source_msg_id, parties, raw_content, attachments, source_policy, structured_features, checksum}`.
4. Compute checksum over (3) sans `checksum` (existing discipline, with new field in preimage).
5. Hand to `ConnectorBase.appendLedgerRow(row)` (existing dedup + lock + fsync + advance cursor).

---

## 5. Worked examples — three sources, synthetic rows

Each example pairs an invented row, shaped like the rows connectors write under `<MEMORY_ROOT>/storage/sources/` (synthetic fixtures), with the `structured_features` that an upgraded connector emits for it. Slug derivation follows `entity-schema.md` § 5.2 verbatim.

### 5.1 git-log commit by Alex Example on Sample-Tool

**Source row (current, pre-upgrade — no `structured_features`):**

```json
{
  "id": "ulid_0EXAMPLE0GITLOG00001",
  "ts": "2026-01-15T10:00:00.000Z",
  "source": "git-log",
  "source_msg_id": "git:0123456789abcdef0123456789abcdef01234567",
  "parties": ["alex@example.com"],
  "raw_content": {
    "repo_path": "~/Documents/example-org/Sample-Tool",
    "commit_hash": "0123456789abcdef0123456789abcdef01234567",
    "author_name": "Alex Example",
    "author_email": "alex@example.com",
    "author_ts": "2025-04-02T09:15:30-07:00",
    "subject": "Initial commit",
    "parents": []
  },
  "attachments": [],
  "source_policy": {"deletion_semantics": "full_excise", "consent_basis": "first_party"},
  "checksum": "00112233445566778899aabbccddeeff"
}
```

**Post-upgrade `structured_features` stamped by `git-log-local@1.0.0`:**

```jsonc
{
  "structured_features": {
    "schema_version": "v1",
    "emitter_version": "git-log-local@1.0.0",
    "entities": [
      {
        "kind": "person",
        "canonical_id": "person:git-log:alex_example_com",
        "surface": "alex@example.com",
        "source_scope": "git-log",
        "evidence": "structural",
        "confidence": 1.0,
        "extractor_version": "git-log-local@1.0.0"
      },
      {
        "kind": "project",
        "canonical_id": "project:git-log:sample_tool",
        "surface": "Sample-Tool",
        "source_scope": "git-log",
        "evidence": "structural",
        "confidence": 1.0,
        "extractor_version": "git-log-local@1.0.0"
      }
    ],
    "time_anchors": [
      {
        "kind": "absolute",
        "raw_phrase": "2025-04-02T09:15:30-07:00",
        "parsed": { "iso": "2025-04-02T16:15:30Z" },
        "extractor_confidence": 1.0,
        "extractor_version": "git-log-local@1.0.0"
      }
    ],
    "parties": ["person:git-log:alex_example_com"]
  }
}
```

**Derivation notes (mechanical, no LLM judgment):**

- `author_email = "alex@example.com"` → `slugify("alex@example.com")` → `alex_example_com` → `person:git-log:alex_example_com`. STOPWORDS bypass (evidence is `structural`).
- `repo_path = "~/Documents/example-org/Sample-Tool"` → basename `Sample-Tool` → `slugify` → `sample_tool` → `project:git-log:sample_tool`.
- `author_ts = "2025-04-02T09:15:30-07:00"` → normalized to UTC → `2025-04-02T16:15:30Z` on `time_anchors[0].parsed.iso`. `raw_phrase` carries the original-TZ form for audit.
- `author_name = "Alex Example"` is INTENTIONALLY NOT EMITTED as a separate person entity — the email is the canonical structural surface; the name would either collide (alias path, v1 territory) or generate a stopword-conflict `alex` slug. Per `entity-schema.md` § 5.3 git-log row, author-email IS the surface.
- `commit_hash` is NOT an entity. It is the row's `source_msg_id` namespace already; no consumer joins on it as a `canonical_id`.

### 5.2 github-events PullRequestEvent on `example-org/example-repo`

**Source row (current):**

```json
{
  "id": "ulid_0EXAMPLE0GHEVENT0002",
  "ts": "2026-01-15T10:05:00.000Z",
  "source": "github-events",
  "source_msg_id": "gh-event:1000000001",
  "parties": ["user", "gh:example-org"],
  "raw_content": {
    "event_type": "PullRequestEvent",
    "action": "merged",
    "pr_number": 12,
    "pr_title": null,
    "pr_author": null,
    "repo": "example-org/example-repo",
    "public": true,
    "created_at": "2026-01-15T09:42:17Z"
  },
  "attachments": [],
  "source_policy": {"deletion_semantics": "full_excise", "consent_basis": "third_party_inferred"},
  "_classifier_repo_owner": "example-org",
  "kind": "github_event",
  "checksum": "ffeeddccbbaa99887766554433221100"
}
```

**Post-upgrade `structured_features` stamped by `github-events@1.0.0`:**

```jsonc
{
  "structured_features": {
    "schema_version": "v1",
    "emitter_version": "github-events@1.0.0",
    "entities": [
      {
        "kind": "org",
        "canonical_id": "org:github-events:example_org",
        "surface": "example-org",
        "source_scope": "github-events",
        "evidence": "structural",
        "confidence": 1.0,
        "extractor_version": "github-events@1.0.0"
      },
      {
        "kind": "person",
        "canonical_id": "person:github-events:example_org",
        "surface": "example-org",
        "source_scope": "github-events",
        "evidence": "structural",
        "confidence": 1.0,
        "extractor_version": "github-events@1.0.0"
      },
      {
        "kind": "project",
        "canonical_id": "project:github-events:example_repo",
        "surface": "example-repo",
        "source_scope": "github-events",
        "evidence": "structural",
        "confidence": 1.0,
        "extractor_version": "github-events@1.0.0"
      }
    ],
    "time_anchors": [
      {
        "kind": "absolute",
        "raw_phrase": "2026-01-15T09:42:17Z",
        "parsed": { "iso": "2026-01-15T09:42:17Z" },
        "extractor_confidence": 1.0,
        "extractor_version": "github-events@1.0.0"
      }
    ],
    "parties": ["person:github-events:example_org"],
    "source_specific": {
      "event_type": "PullRequestEvent",
      "action": "merged",
      "pr_number": 12
    }
  }
}
```

**Derivation notes:**

- `repo = "example-org/example-repo"` splits on `/` → `owner = "example-org"`, `name = "example-repo"`. Owner becomes `org:github-events:example_org` AND `person:github-events:example_org` — GitHub login namespace conflates user-account and org-account; structural emit covers both. Conflation-resistance discipline: identical canonical surface with different `kind` produces different `canonical_id` strings (the kind prefix is structural), so the predicate evaluator's set-membership stays clean.
- `time_anchors[0]` uses `created_at` (the event clock) NOT `row.ts` (the connector-ingestion clock). `row.ts` becomes a structural anchor later via `F-CCS-CASCADE-row-ts-as-anchor` for ALL promoted facts; the connector's `structured_features.time_anchors[]` captures the EVENT clock specifically.
- `_classifier_repo_owner: "example-org"` is a pre-existing connector breadcrumb — it stays where it is; the canonical surface is duplicated in `structured_features.entities[].canonical_id` so consumers do not have to special-case the legacy field.
- `source_specific` carries the PR action + number that the cascade does not consume in v0 but downstream salience-recalibration or operator dashboards may want.

### 5.3 iMessage business-account message (`urn:biz:` handle)

**Source row (current):**

```json
{
  "id": "ulid_0EXAMPLE0IMESSAGE003",
  "ts": "2025-02-11T18:20:05.250Z",
  "source": "imessage",
  "source_msg_id": "A1B2C3D4-0000-4000-8000-000000000003",
  "parties": ["user", "urn:biz:00000000-aaaa-4bbb-8ccc-000000000001"],
  "raw_content": {
    "text": "Sounds good! ",
    "handle_id": "urn:biz:00000000-aaaa-4bbb-8ccc-000000000001",
    "chat_guid": "any;-;urn:biz:00000000-aaaa-4bbb-8ccc-000000000001",
    "cache_roomnames": null,
    "is_from_me": 1,
    "associated_message_type": 0,
    "thread_originator_guid": null,
    "service": "iMessage",
    "date_apple": "760990805250000000",
    "participant_count": 2,
    "text_source": "attributedBody"
  },
  "attachments": [],
  "source_policy": {"deletion_semantics": "full_excise", "consent_basis": "first_party"},
  "checksum": "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
}
```

**Post-upgrade `structured_features` stamped by `imessage@1.0.0+biz-prefix`:**

```jsonc
{
  "structured_features": {
    "schema_version": "v1",
    "emitter_version": "imessage@1.0.0+biz-prefix",
    "entities": [
      {
        "kind": "org",
        "canonical_id": "org:imessage:biz_00000000_aaaa_4bbb_8ccc_000000000001",
        "surface": "urn:biz:00000000-aaaa-4bbb-8ccc-000000000001",
        "source_scope": "imessage",
        "evidence": "handle",
        "confidence": 0.95,
        "extractor_version": "imessage@1.0.0+biz-prefix"
      }
    ],
    "time_anchors": [
      {
        "kind": "absolute",
        "raw_phrase": "760990805250000000",
        "parsed": { "iso": "2025-02-11T18:20:05.250Z" },
        "extractor_confidence": 1.0,
        "extractor_version": "imessage@1.0.0+biz-prefix"
      }
    ],
    "parties": [],
    "source_specific": {
      "handle_kind": "business_account",
      "is_from_me": 1,
      "thread_originator_guid": null
    }
  }
}
```

**Derivation notes (this is where the user-edge work earns its keep):**

- `handle_id = "urn:biz:00000000-..."` is a BUSINESS account, NOT a person handle. Per `agent-integration.md` § Connectors edge ("iMessage business-account prefix `BIZ:`"), this is `kind: "org"` not `kind: "person"`. Evidence is `handle` (Apple-verified directory handle), not `structural` — the handle IS the connector's structural surface for the entity-schema gate.
- `parties[]` in `structured_features` is INTENTIONALLY EMPTY here: the only non-`user` party is the business account, which is an `org`, not a `person`. `structured_features.parties[]` is reserved for person-kind canonical_ids per § 3.1 contract. The cascade's `row.parties[]` consumer (`F-CCS-CASCADE-row-parties-as-entities`) sees `"user"` and `"urn:biz:..."` and is also defensive — `"user"` becomes a role-entity if and only if the connector indicates `is_from_me: 1` (per that node's predicate).
- `date_apple = "760990805250000000"` is Apple-epoch nanoseconds (Apple-epoch start: 2001-01-01T00:00:00Z). The connector converts to ISO-8601 UTC at emit time; `raw_phrase` keeps the Apple-epoch form for audit. The ISO matches `row.ts` to within rounding — they are the SAME event clock — but `time_anchors[0]` uses the message-date specifically so a downstream consumer joining on the conversation does not have to know about the row-vs-event ts distinction.
- The body `"Sounds good!"` is NOT emitted as a topic or NER entity. Per `entity-schema.md` § 5.3, iMessage `topic` is `NOT EMITTED at v0` and `place / org / project / event` are KB-lookup only (the user's KB has none of these for this row). FM-1 risk on a two-word ack message is exactly what STOPWORDS exists to suppress.

---

## 6. Cascade merge semantics (consumer side)

Owned in detail by `F-CCS-CASCADE-structured-features-merge`. This section pins the contract that node implements.

### 6.1 Entry point

At promote time, `mcp/lib/tools/distill-promote-fact.js → appendFactRow(row, ...)` already runs the text-extractor cascade and stamps `fact.features.entities[]` / `fact.features.time_anchors[]`. After this spec lands, the function ALSO reads `row.structured_features` and merges. Reduced pseudocode:

```js
async function appendFactRow(row, ctx) {
  // ... existing setup, validation, embed ...

  // Existing text-extractor cascade path (unchanged).
  const textEntities    = extractEntities({ row, source: row.source, context: ctx }).entities;
  const textTimeAnchors = parseAnchors(extractText(row), row.ts);

  // NEW: read connector-emitted structured features, defensive on absence.
  const sf = row.structured_features ?? null;

  const mergedEntities    = mergeEntities(textEntities, sf?.entities ?? []);
  const mergedTimeAnchors = mergeTimeAnchors(textTimeAnchors, sf?.time_anchors ?? []);

  fact.features.entities     = mergedEntities;
  fact.features.time_anchors = mergedTimeAnchors;

  // ... rest of existing appendFactRow ...
}
```

### 6.2 Entity merge — union with structured-wins-on-collision

```js
function mergeEntities(textEntities, structuredEntities) {
  // Index structured by canonical_id (O(structured)).
  const byId = new Map();
  for (const e of structuredEntities) byId.set(e.canonical_id, e);

  // Walk text; if the canonical_id already exists in byId, KEEP the structured
  // one (structured wins). If it does not, ADD the text entity (text-only
  // additions preserved).
  for (const t of textEntities) {
    if (!byId.has(t.canonical_id)) byId.set(t.canonical_id, t);
  }

  // Emit as sorted array (entity-schema.md § 4.3 — sort ascending by canonical_id).
  const merged = [...byId.values()].sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 :
    a.canonical_id > b.canonical_id ? 1 : 0
  );

  // Cap at CAPS.ENTITY_MAX_PER_ROW = 32 (already enforced by extractor;
  // defense-in-depth on merge).
  return merged.slice(0, CAPS.ENTITY_MAX_PER_ROW);
}
```

**Why structured wins on conflict:**

- The connector's `evidence: "structural"` is empirically more reliable than the cascade's `evidence: "ner_corroborated"` for the same `canonical_id` (FM-1 evidence in `salience-design.md` Appendix A.1).
- The connector's `confidence` is calibrated against the source's structural ground truth (typically 1.0); the text extractor's confidence is calibrated against NER corroboration heuristics (typically 0.7-0.95).
- Keeping the structured entity's `surface` preserves the original-form Apple/Git/GitHub display string instead of the NER-tokenized variant.
- Crucially: `canonical_id` IS byte-equal across both paths by design (both routes through the same `slugify()` from `mcp/lib/synthesis/canonical-id.js`), so the merge is over a well-defined key, not a fuzzy match.

**Text-only additions preserved:**

- A row like the git-log Initial-commit example carries `subject: "Initial commit"` in `raw_content`. The text extractor may emit NER-corroborated entities (e.g., `topic:git-log:...` if v1 enables it). Those entities have `canonical_id` strings that DO NOT appear in `structured_features.entities[]`, so the merge keeps them. The cascade does not lose the text path's discoveries.

### 6.3 Time-anchor merge — same union, separate dedupe key

Time anchors do not have a `canonical_id`; dedupe is by `(kind, parsed.iso ?? raw_phrase)` tuple. Pseudocode:

```js
function mergeTimeAnchors(textAnchors, structuredAnchors) {
  const dedupeKey = (a) => `${a.kind}|${a.parsed?.iso ?? a.raw_phrase}`;
  const byKey = new Map();
  for (const a of structuredAnchors) byKey.set(dedupeKey(a), a);  // structured first
  for (const t of textAnchors) {
    if (!byKey.has(dedupeKey(t))) byKey.set(dedupeKey(t), t);
  }
  return [...byKey.values()].slice(0, CAPS.TIME_ANCHORS_MAX_PER_FACT);
}
```

The cascade's `F-CCS-CASCADE-row-ts-as-anchor` (which stamps `row.ts` as a structural absolute anchor at promote time) runs BEFORE this merge or AFTER it; either order is correct because the dedupe key collapses identical `(kind, iso)` pairs. If the connector already emitted an absolute anchor for `row.ts` (e.g. github-events where `created_at === row.ts`), the cascade's row-ts stamp deduplicates against it cleanly.

### 6.4 Parties merge

`structured_features.parties[]` (canonical_id strings) merges with the entities derived from `row.parties[]` by `F-CCS-CASCADE-row-parties-as-entities`. Both routes produce `person:<scope>:<slug>` strings via the same slugify; collisions dedupe trivially in the entity-merge map above. No separate `parties` field lives on `fact.features`; the parties surface as `entities` of `kind: "person"`.

### 6.5 `source_specific` is NOT merged

v0 ships `source_specific` as a read-by-future-consumers field. The promote-time cascade does NOT consume it. Implementers MUST NOT promote `source_specific` keys to `fact.features` or `fact.content` — that would couple cascade behavior to per-source private payloads and violate the entity-schema's closed-enum discipline.

---

## 7. Backwards-compatibility (the load-bearing claim)

The schema is **strictly additive** at the source-ledger layer. Three concrete invariants enforce this.

### 7.1 Rows without `structured_features` cascade unchanged

The merge functions in § 6 read `row.structured_features ?? null` and short-circuit through `sf?.entities ?? []`. When `structured_features` is absent:

- `mergeEntities(textEntities, [])` returns `textEntities.sort()` — byte-identical to today's cascade output.
- `mergeTimeAnchors(textAnchors, [])` returns `textAnchors` — byte-identical.
- No additional projection runs; no policy events emitted.

This is the "old connector / pre-upgrade row" path. Every row in `storage/sources/<src>.jsonl` written before the connector upgrades carries this shape; the cascade re-processes them on a future watermark tick exactly as it does today.

### 7.2 Schema validation rejects malformed `structured_features` defensively

The cascade-side validator (a new helper `validateStructuredFeatures(sf)` at `mcp/lib/synthesis/structured-features-schema.js`) is **fail-open**: on any structural violation it logs `policy.structured_features.invalid` with `{source_msg_id, reason}` and **returns `null`**, which routes the cascade through the same text-extractor-only path as an absent payload. The row is NOT dropped; the fact is NOT poisoned. Validation failures observed at the user over a Phase-N week are the upgrade signal — bump `emitter_version`, fix, re-extract via the drift detector.

The validator MUST reject:

- `schema_version !== "v1"` → reason `unsupported_schema_version` (forward-compat: an unknown future version is treated as absent until the cascade learns to consume it).
- `emitter_version` missing or not matching `STRUCTURED_FEATURES_EMITTER_VERSION_REGEX` → reason `invalid_emitter_version`.
- Any `entity.evidence` outside `STRUCTURED_FEATURES_VALID_EVIDENCE_AT_CONNECTOR` → reason `forbidden_evidence_at_connector`.
- `entities[]` length > `CAPS.ENTITY_MAX_PER_ROW` → reason `entity_cap_exceeded`.
- `time_anchors[]` length > `CAPS.TIME_ANCHORS_MAX_PER_FACT` → reason `time_anchor_cap_exceeded`.
- Any entity `canonical_id` not matching `<kind>:<source_scope>:<slug>` where `slug` matches `CAPS.ENTITY_SLUG_REGEX` from entity-schema.md § 8 → reason `invalid_canonical_id`.
- Total serialized byte size > `STRUCTURED_FEATURES_MAX_BYTES` → reason `oversized_payload` (defends the recall hot path).

### 7.3 The merge is a strict superset of the text-only path

For any source-ledger row R, define `cascade_old(R)` as the entities/time_anchors the cascade would have stamped on the resulting fact under today's text-only path, and `cascade_new(R)` as the stamped output after this spec lands. The invariant:

> **For every R, `cascade_old(R)` ⊆ `cascade_new(R)` (as a multiset on `canonical_id` and on time-anchor dedupe-key).**

I.e. every entity the text extractor would have emitted survives the merge; the merge can only ADD structured entities or REPLACE the text-extractor's entry with a higher-fidelity structured one. No entity is silently lost.

CI gates this with a property test that runs the cascade on synthetic fixtures shaped like `<MEMORY_ROOT>/storage/sources/*.jsonl` rows with and without `structured_features` synthesized in the test fixture, and asserts subset semantics on the resulting `fact.features.entities[]`.

---

## 8. Invariants (CI-enforceable)

- **I1. `schema_version` constant required.** `structured_features.schema_version` MUST equal `CAPS.STRUCTURED_FEATURES_SCHEMA_VERSION = "v1"`. A row carrying a different value is treated as absent (fail-open). CI: grep `mcp/lib/connectors/**.js` for `schema_version:` and assert all occurrences equal the cap.
- **I2. `emitter_version` required, matches regex.** Every `structured_features` block MUST carry `emitter_version` matching `STRUCTURED_FEATURES_EMITTER_VERSION_REGEX`. The drift detector reads `emitter_version` to know which rows to re-extract on connector upgrade.
- **I3. `canonical_id` byte-stability across emit AND text-extract.** Both the connector emit path AND the cascade's text-extractor path produce `canonical_id` strings via the SAME `mcp/lib/synthesis/canonical-id.js → formCanonicalId()`. CI: a property test feeds the same `(kind, source_scope, surface)` triple through both call sites and asserts byte-equal output. Drift here breaks predicate scoping silently.
- **I4. Connector-emit evidence is `{handle | structural | kb_lookup}`.** Per `STRUCTURED_FEATURES_VALID_EVIDENCE_AT_CONNECTOR`. `ner_corroborated` is the cascade text-extractor's evidence-kind exclusively; a connector emitting it is a code defect, validator returns `null` (rejects the structured payload, text-only path used).
- **I5. Schema-version gate at consumer.** The cascade-side merger MUST switch on `sf.schema_version` (currently a single arm `"v1"`); an unknown version causes `validateStructuredFeatures` to return `null`. This is the forward-compat gate.
- **I6. Backwards-compat: missing field → text-only path unchanged.** `row.structured_features === undefined` produces byte-identical `fact.features` to today's cascade. CI: replay-driven test asserts byte-equality on a corpus snapshot from before the spec lands.
- **I7. Sorted entities.** `structured_features.entities[]` MUST be sorted ascending by `canonical_id` (same byte-stability invariant as `entity-schema.md` § 4.3). The merger ALSO sorts the merged output; this invariant guards the emit-side input.
- **I8. Cap enforcement at emit AND merge.** `entities[].length ≤ 32`; `time_anchors[].length ≤ 8`. Both connector emit and cascade merge enforce; either layer alone is sufficient, defense-in-depth.
- **I9. Single-producer per `structured_features` shape per source.** Each source has exactly ONE module that emits `structured_features` (the connector daemon). CI grep: `mcp/lib/connectors/<source>-*.js` is the only file matching `structured_features:`. Two emitters per source would silently diverge slug-derivation.
- **I10. `source_specific` JSON-serializable, never consumed at v0.** The cascade's promote path MUST NOT read `source_specific`; a grep CI gate (`mcp/lib/tools/distill-promote-fact.js` MUST NOT match `source_specific`) enforces.
- **I11. Checksum covers `structured_features`.** The row's `checksum` preimage includes `structured_features` when present (per `architecture.md` § 1 "all fields except `checksum`"). Round-trip test: parse a row, recompute the checksum, assert equality.
- **I12. Fail-open on validator reject.** When `validateStructuredFeatures` returns `null`, the cascade MUST proceed via the text-only path AND emit `policy.structured_features.invalid` exactly once per affected row (dedupe-keyed on `source_msg_id`). The fact lands normally; the operational signal lands on the policy ledger.
- **I13. Frozen CAPS.** `STRUCTURED_FEATURES_VALID_EVIDENCE_AT_CONNECTOR` is `Object.freeze`d; mutation at runtime raises.

---

## 9. Open questions

- **OQ1. emitter_version drift across re-extractions.** When a connector ships `git-log-local@1.1.0` with a new slug rule, what happens to rows stamped under `1.0.0`? Two options: (a) leave the row's `structured_features` intact and rely on the projection-time alias graph (v1 of `entity-schema.md` § 8.2); (b) drift detector emits a `kind: "reconstructed"` fact with new `derived_from` (the `time-anchor-schema.md` § Examples § 4 pattern). Recommendation: (b), because the source ledger row itself is append-only — the structured features on the row stay, the cascade re-projects via the reconstructed fact. Carry-forward to `F-SYN-OPERATIONAL-drift-detection`.
- **OQ2. `source_specific` schema validation.** v0 ships it as opaque `Record<string, unknown>`. v1 may want per-source typed schemas (e.g. `source_specific.github_events.PullRequestEvent.{pr_number, action}`). Deferred until a v1 consumer emerges; no pre-emptive complexity.
- **OQ3. Connector emit for `chat-claude-code` / `codex-cli`.** These two sources emit ONE row per turn with `parties: ["user", "assistant"]` — neither is a person handle. The W-CCS chat connector nodes (`F-CCS-CONNECTOR-chat-claude-code-structural`, `F-CCS-CONNECTOR-codex-cli-structural`) emit `structured_features.entities[]` of `kind: "project"` (the cwd's basename, per `entity-schema.md` § 5.3 chat-claude-code rule) AND tool-name `kind: "artifact"` entities. Person entities for the user are pinned to `person:<scope>:user` (the role-entity convention from `F-CCS-CASCADE-row-parties-as-entities`); v1 may bind to the user's real handle once `F-SYN-FOUNDATION-context-populator` lands the user-identity binding. Out of scope here; lives in the connector specs.
- **OQ4. iMessage business-account `org` vs `service` kind.** `entity-schema.md` § 3 has a closed 7-type taxonomy with no `service` kind. Business accounts are `org` per § 5.1 today. If a deployment's corpus produces non-org `urn:biz:` handles (e.g. service-bots that are neither people nor orgs), a kind extension would be a versioned change. v0: ship `org`; reconsider when evidence appears.
- **OQ5. Time-anchor merge ordering with `F-CCS-CASCADE-row-ts-as-anchor`.** Both nodes stamp absolute anchors; the merge dedupes. Open question: which `extractor_version` wins on the dedupe collision (the connector's or the cascade's `row-ts-as-anchor` stamp)? Recommendation: connector wins (more specific provenance — it stamped the EVENT clock, not the INGESTION clock). Carry-forward as a tie-break rule in `F-CCS-CASCADE-row-ts-as-anchor`'s do_step.
- **OQ6. Latency budget for `buildStructuredFeatures` at connector emit.** Per-row connector emit today is sub-millisecond (just JSON serialization + dedupe tail-read). Adding structured-feature derivation should stay sub-millisecond per row (no embeddings, no LLM calls, just slugify + a few field lookups). If a future per-source helper crosses 5ms, that is a defect. No CAP at v0; budget enforced by review.

---

## 10. Cross-tier impact

This spec is the W1-CCS BLOCKER. The following nodes consume it directly.

| Node | Tier | Consumes |
|---|---|---|
| `F-CCS-CASCADE-structured-features-merge` | cascade | Reads `row.structured_features`; runs `mergeEntities` / `mergeTimeAnchors`; emits `policy.structured_features.invalid` on validator reject. |
| `F-CCS-CASCADE-row-ts-as-anchor` | cascade | Stamps `row.ts` as structural anchor; coexists with connector-emitted time anchors via the § 6.3 dedupe. |
| `F-CCS-CASCADE-row-parties-as-entities` | cascade | Promotes `row.parties[]` to entities; coexists with `structured_features.parties[]` via § 6.4 dedupe (same canonical_id space). |
| `F-CCS-CONNECTOR-git-log-structural` | connector | Implements `buildStructuredFeatures` for `mcp/lib/connectors/git-log-local.js` per § 5.1. |
| `F-CCS-CONNECTOR-github-events-structural` | connector | Implements `buildStructuredFeatures` for `mcp/lib/connectors/github-events.js` per § 5.2. |
| `F-CCS-CONNECTOR-imessage-structural` | connector | Implements `buildStructuredFeatures` for `mcp/lib/connectors/imessage.js` per § 5.3. |
| `F-CCS-CONNECTOR-screentime-structural` | connector | Implements per ScreenTime structural rules in `entity-schema.md` § 5.3 (bundle id as `artifact`). |
| `F-CCS-CONNECTOR-chat-claude-code-structural` | connector | Implements project + tool extraction per `entity-schema.md` § 5.3 chat-claude-code rule. |
| `F-CCS-CONNECTOR-codex-cli-structural` | connector | Parallel to chat-claude-code; same shape, different source_scope. |
| `F-CCS-BACKFILL-engine` | backfill | Re-stamps `structured_features` on historical rows via the drift detector path (OQ1); reads `emitter_version` to scope the re-extraction. |
| `F-CCS-OPS-coverage-recheck` | ops | Counts rows with vs without `structured_features` per source; reports coverage as upgrade progresses. |

The spec does NOT constrain:

- `mcp/lib/synthesis/canonical-id.js` (already pinned by `entity-schema.md`).
- `mcp/lib/synthesis/time-anchor-resolver.js` (already pinned by `time-anchor-schema.md`).
- The salience cascade's Stage-0 dispatch or Stage-1 score (those run BEFORE entity / time-anchor stamping and do not read `structured_features`).
- The recall service (it reads `fact.features` directly; the spec mediates between row and fact, not between fact and recall).

---

## 11. Implementation checklist (for the integration-tier task)

A future implementer wiring `F-CCS-CASCADE-structured-features-merge` should:

- [ ] Add CAPS constants from § 3.2 to `mcp/lib/validation.js`; `Object.freeze` the evidence set.
- [ ] Create `mcp/lib/synthesis/structured-features-schema.js` exporting:
  - `VERSION = "v1"` (module-level constant, per workunit discipline)
  - `CAPS` (frozen re-export of the structured-features CAPS subset)
  - `validateStructuredFeatures(sf): StructuredFeatures | null` (fail-open)
  - `mergeEntities(textEntities, structuredEntities): Entity[]`
  - `mergeTimeAnchors(textAnchors, structuredAnchors): TimeAnchor[]`
- [ ] Edit `mcp/lib/tools/distill-promote-fact.js → appendFactRow` to invoke the merge (per § 6.1 pseudocode).
- [ ] Tests at `mcp/test/synthesis/structured-features-schema.test.mjs`:
  - Hermetic setup: env-before-dynamic-import per W2-W12 style.
  - Synthetic fixtures shaped like rows of `<MEMORY_ROOT>/storage/sources/git-log.jsonl`, `github-events.jsonl`, `imessage.jsonl` (the three § 5 examples).
  - 12+ assertions covering: schema-version gate (I1), emitter-version regex (I2), canonical_id byte-stability across both paths (I3), connector-evidence allowlist (I4), forward-compat reject of unknown schema_version (I5), backwards-compat byte-equality on rows without `structured_features` (I6), sort discipline on emit AND merge (I7), cap enforcement (I8), source_specific NEVER consumed at promote (I10), checksum round-trip (I11), fail-open behavior on validator reject (I12), frozen CAPS (I13).
- [ ] CI grep: exactly one emitter per source (I9).
- [ ] CI grep: `distill-promote-fact.js` does not reference `source_specific` (I10).
- [ ] CI grep: no `schema_version` literal in `mcp/lib/connectors/**` other than `"v1"` (I1).

When this checklist completes, the connector-tier nodes (`F-CCS-CONNECTOR-*-structural`) are unblocked to land their per-source `buildStructuredFeatures` helpers against the merge contract.

---

## 12. Footnote on naming

The earlier hypergraph predicate uses `parties` both at the row's top level (existing `row.parties[]`) AND inside `structured_features.parties[]` (this spec). The conflict is intentional and the disambiguation is structural: `row.parties` is the existing opaque-string array (handles, role names); `structured_features.parties` is the canonicalized projection (`person:<scope>:<slug>` strings). Reviewers should not collapse the two. The merger reads BOTH (via `F-CCS-CASCADE-row-parties-as-entities` for the opaque path, via `mergeEntities` for the structured path) and the dedupe key (`canonical_id`) unifies them.
