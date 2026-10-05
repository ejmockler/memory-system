# Architecture

Eight layers, bottom up. Each writes to the next; recall reads across.

## 1. Source ledgers

Per-app append-only JSONL files, one per source:

```
storage/sources/telegram.jsonl
storage/sources/whatsapp.jsonl
storage/sources/mail.jsonl
storage/sources/chat-claude-code.jsonl
```

Schema per event:

```
{
  id,
  ts,
  source,
  source_msg_id,
  parties: [],
  raw_content,
  attachments: [],
  source_policy: {
    deletion_semantics: "tombstone_only" | "full_excise" | "follows_upstream",
    consent_basis: "first_party" | "third_party_inferred" | "third_party_explicit"
  },
  checksum: "<blake2b512 truncated to 16 bytes, lowercase hex (32 hex chars), of the canonical_json of all fields ABOVE (excluding `checksum` itself); see mcp-surface.md § Consumed-nonce store for the discipline rationale>"
}
```

Connectors run as background daemons, one process per source. Untransformed at this layer; the raw stream is preserved indefinitely (subject to `source_policy`). The connector contract, per-source mechanisms, liveness timescales, and failure modes are specified in `ingestion.md`.

The `checksum` field enables the corrupt-tail-truncation discipline (`ingestion.md § Failure modes`) — on startup or after a crash, the connector (and the watermark daemon for chat ledgers) scans backwards from EOF, verifies each line's checksum, and truncates at the first mismatch. Without the field, the discipline is unimplementable; with it, the discipline is mechanical. Checksum is computed BEFORE the row is written (so the writer can verify its own write before committing the lock release) and is part of the byte-equality identity of the row (a checksum mismatch on re-verify is a corrupt-row signal, not a "different but valid" row signal).

## 2. Sensitive-material gate

At ingestion, regex + small classifier filter credentials, tokens, identifiers, and content flagged by source_policy. Quarantined material does not promote. The quarantine action itself is logged.

## 3. Salience filter (promotion)

Decides which raw events become memory events. Conservative default — most do not promote. Inputs: event content, source, parties, recency of related memories, explicit "remember this" signals from the user.

Tuned against the replay set (see `build-plan.md`).

**This is the actual product.** Everything else is plumbing.

## 4. Memory ledger

Single append-only stream: `ledgers/memory.jsonl`. Mixed kinds:

- `fact` — promoted from a source
- `policy` — `exclude` / `replace` / `substitute` / `corroboration` / `rescind` operations
- `recall` — logged retrieval (informs damping and reinforcement; carries the query embedding for predicate snapshotting)
- `reconstructed` — agent-emitted recall-time summarization (may diverge from source)

Common shape (every entry):

```
{
  id,                       # unique ledger event id
  ts,                       # server-stamped
  kind: "fact" | "policy" | "recall" | "reconstructed",
  provenance: {
    agent_id,
    conversation_id,
    confidence
  }
}
```

Per-kind extensions:

```
fact:
  content                   # the distilled fact
  source_refs: [ { source, source_msg_id, via, corroboration_event_id, consent_basis } ]
                            # consent_basis forwarded from source_policy.consent_basis
                            # at promotion time (mcp-surface.md § memory_distill_promote_fact
                            # handler step 3e); enables downstream salience-weighting
                            # (recall ranking damping, retention cap, no-verbatim-quoting
                            # for third_party_inferred) without re-walking the source ledger
  derived_from: [ id, ... ]
  features: {
    embedding,              # the fact's own embedding
    embedding_model_version,
    entities: [],
    time_anchors: [],
    valence
  }
  superseded_by: id | null  # set when a replace-policy points here
  reframed_by: id | null    # set when a substitute-policy points here
  rescinded_at: null        # facts are not rescinded; this field is only on policy kinds

policy:
  policy_kind: "exclude" | "replace" | "substitute" | "corroboration" | "rescind"
  applied_at
  scope                     # for exclude/replace
  targets: [ id, ... ]      # which facts/policies this policy acts on
  payload                   # kind-specific (predicate body, new_event_id, content_transform, source_ref for corroboration, target policy_event_id for rescind)
  rescinded_at: ts | null   # filled by a memory_rescind_policy event targeting this

recall:
  query: {
    context_embedding,            # the recall's query vector (NOT a fact embedding)
    embedding_model_version,      # tag from the embedding model used
    surrounding_context_hash      # canonical hash of the surrounding_context for replay
  }
  surfaced: [ { memory_id, score, position } ]   # which memories the brief returned
  density_flag: null | "crowded" | "sparse"
  truncated: boolean

reconstructed:
  content                   # agent-emitted summarization
  derived_from: [ id, ... ]
  features: { embedding, embedding_model_version, entities, time_anchors }
```

The `recall` kind's `query.context_embedding` is the canonical source `memory_exclude` reads when it server-snapshots a predicate's embedding from a `recall_id`. This field is distinct from `fact.features.embedding` and exists only on recall-kind events.

The `policy` kind's `corroboration` variant is the non-mutating dedupe path: when the salience filter detects that a new source event corroborates an already-promoted fact, it emits `{policy_kind: "corroboration", targets: [existing_memory_id], payload: {source_ref: <new>}}` instead of mutating the existing fact's `source_refs[]`. The projection joins the fact with all its corroboration events to compute the effective source set.

The `policy` kind's `rescind` variant deactivates another policy event. `targets: [policy_event_id]`. Emitted by `memory_rescind_policy`. Idempotent: a second rescind of an already-rescinded policy is a no-op (`was_active: false` on the return).

`excise` operations mutate the ledger (tombstone the entry, remove sensitive content where policy demands). Other ops are pure appends.

## 5. Index

Derived from the memory ledger, never authoritative. Treat as cache; rebuild from the ledger at any time.

- **Vector index** — embeddings for semantic match. **Must be ANN-backed** (HNSW or IVF) by the time the ledger crosses ~10⁴ facts; per-turn recall via linear scan does not scale to the backfill volumes (`agent-integration.md`, `ingestion.md`) the system is designed for. The current implementation uses an HNSW index (`hnswlib-node`) alongside multi-feature recall scoring (`build-plan.md`). Vectors are indexed per `embedding_model_version`; a version transition keeps both indices warm until migration completes (see `open-problems.md` § 7).
- **Entity index** — people, places, dates extracted at promotion
- **Time index** — when the event happened, when last referenced
- **Derivation graph** — edge per `derived_from` link; supports forgetting propagation
- **Recall trace** — per-memory log of conversational neighborhoods that have surfaced it
- **Predicate index** — active exclude predicates (`PREDICATE_MAX_ACTIVE` cap); recall consults this to skip predicate-matching memories. Recall scans the active predicates linearly (`mcp/lib/recall/hard-gates.js`); an entity-bucketed structure for the OR-join over entity tags is a possible future replacement.
- **Corroboration projection** — fold of `corroboration`-kind policy events onto their target facts; gives the effective `source_refs[]` set for any memory id. Recomputed lazily.

## 6. Recall service

`recall(surrounding_context) → brief`. Full signature in `operations.md`.

Logs the recall as an event in the memory ledger.

## 7. Policy operations

Narrow MCP surface for the agent:

- `exclude(recall_id, predicate, scope)`
- `replace(old_id, new_event, scope)`
- `substitute(target, content_transform)`
- `rescind_policy(policy_event_id)` — unified inverse for the apply-only verbs above
- `excise(target, scope)` — privileged, mutates the ledger

Of these, only `exclude` (as `memory_exclude`, scoped form) and `rescind_policy` (as `memory_rescind_policy`) are implemented today; the others are design. See `mcp-surface.md` § Current status.

The salience filter additionally emits `corroboration` policy events through `memory_distill_emit_policy` (planned, not implemented; see `mcp-surface.md` § Planned, not implemented) when a new source corroborates a previously promoted fact — this is the non-mutating alternative to in-place `source_refs[]` extension; agents do not emit corroboration directly.

Semantics and predicate language in `operations.md`. MCP surface in `mcp-surface.md`.

## 8. Promotion path (row-by-row salience cascade)

Promotion is performed continuously by the watermark daemon over each per-source ledger, not at conversation end. Per-source cursors advance through `storage/sources/<src>.jsonl` row by row; each row is judged by the cascade defined in `kb/salience-design.md`:

- Stage-0 dispatch (per-source admission)
- Stage-1 score (cheap signals)
- Stage-2 embed + kNN (embedding from the local embedding server, `mcp/lib/local-embedder-client.js`, compared against the existing fact set)
- Outcome: CORROBORATE / PROMOTE / EMBED_DEFERRED / DROP

PROMOTE calls `promoteSourceRow` directly (in-process); CORROBORATE emits a `policy.corroboration` event without mutating the existing fact; EMBED_DEFERRED parks the cursor for the next tick.

### Trigger sources

Source rows enter the cascade through two paths, both writing rows into `storage/sources/<src>.jsonl`:

- **`Stop` hook** (per-turn) — `stop-hook.sh` appends one combined-turn row to `chat-claude-code.jsonl`. Fastest path; runs while the turn is fresh.
- **Connector daemons** — per-source background processes append their own rows. The current list, with what each reads and needs, is in `docs/CONNECTORS.md`.

The watermark daemon (`<checkout>/daemons/watermark.js`) is specified in `agent-integration.md § Watermark daemon` and runs the cascade tick (`tickSourcesOnce`) over all source ledgers. An earlier conversational-distillation pipeline — a separate idle-watermark trigger that built per-conversation batches handed to a supervisor process — is retired; see `kb/legacy-archive.md`.

`memory_distill_promote_fact` survives as a manual promote surface — useful for promoting auto-memory `pre_distilled` entries or for a manual recovery — and carries a daemon-signed confirmation token minted from `<data root>/policy/distillation-signing-key.json` (minting flow and verification path in `mcp-surface.md § Privilege levels → Daemon-signed token`). The watermark daemon itself does NOT mint or consume these tokens; the cascade's `promoteSourceRow` is an in-process call.

The watermark daemon's operational state persists as one cursor file per source at `<data root>/storage/watermark-state/<source>.json` (last-processed offset and related fields; `watermarkSourceCursorPath` in `mcp/lib/config.js`); cascade events and recall/audit events stream to `<data root>/policy/policy-events-YYYY-MM.jsonl` (separate from the memory ledger — the policy log is operational audit, not memory state).

**Schema cross-links.** Cascade event payloads and the per-source watermark state shape are specified in:

- Per-source watermark state shape: `agent-integration.md § Watermark daemon`.
- Cascade outcomes and event ownership: `kb/salience-design.md` and `agent-integration.md § Token-event ownership table (AUTHORITATIVE)`.

This document references those sections; implementers MUST read the authoritative section, not this summary.

## Interface boundaries

How each boundary in the system is mediated. The protocol choice per boundary is a design commitment, not a default.

| Boundary | Protocol | Why |
|---|---|---|
| Agent ↔ memory system | MCP | Request/response inside a conversation lifetime; agent-initiated; bounded surface. Matches MCP's home territory. |
| Pipeline stage ↔ pipeline stage | Filesystem + local process | No agent in the loop. Files on disk; processes tailing them. |
| Connector ↔ external source | Native protocol or local store (MTProto, SQLite databases, Apple Mail's local message store, etc.) | Source-initiated push; long-running stateful sessions; 24/7 lifecycle. MCP's shape inverts these. |

### MCP-mediated surfaces (agent boundary)

- `recall(surrounding_context) → brief`
- `exclude(predicate, scope)`, `replace(old_id, new_event, scope)`, `substitute(target, content_transform)`, `excise(target, scope)`
- Distillation: reads transcripts, emits promotion and policy events
- Control plane: list connectors, pause ingestion, inspect quarantine, approve entries

### Not MCP-mediated

- Source ledger writes (connectors, directly)
- Sensitive-material gate (filesystem reader, writes to quarantine ledger)
- Salience filter (filesystem reader, writes to memory ledger)
- Index rebuilds (background process)
- Consumed-nonce store (`<data root>/policy/consumed-nonces.jsonl`) — verifier-internal single-use enforcement; no agent or hook reaches it directly
- Policy-events audit log (`<data root>/policy/policy-events-YYYY-MM.jsonl`) — operational timeline for token mint/consume/reject and watermark-daemon cascade events

### Hosted-MCP privacy regression

Hosted MCP servers — for example Anthropic-hosted Gmail / Calendar / Drive integrations — route raw content through a third-party service. Using one of these as an ingestion path would invert the local-first commitment in `thesis.md`. The whole point of local source ledgers is that raw content stays on your machine until you decide what to do with it. **Hosted MCPs are out of scope as connectors for this system.**

### Hybrid pattern (local MCP under connector)

Where a locally-running MCP server cleanly implements a protocol you would otherwise hand-roll, it can sit *underneath* a connector daemon as a protocol library. The connector remains the architectural unit — it still maintains the cursor, writes to the source ledger, attaches `source_policy`, decides `consent_basis`, handles backfill throttling. The local MCP just provides the wire protocol.

Acceptable when: MCP runs locally, supports streaming or acceptable polling latency, stable enough to honor the connector contract.

Not acceptable when: MCP is remote, polling-only with seconds-of-latency requirements, or unstable enough to put the contract at risk.

See `agent-integration.md` for the per-runtime mechanics of the agent boundary — hook patterns, watermark fallback, per-runtime chat ledgers, and the bridge to Claude Code's existing auto-memory.

### acquireExclusiveLockFile (canonical lock discipline)

Three modules in this codebase guard a shared on-disk resource with an exclusive file lock: the consumed-nonce store (`mcp/lib/nonce-store.js` against `consumed-nonces.lock`), the policy-events audit log (`mcp/lib/policy-events.js` against `policy-events.lock`), and the watermark daemon's single-writer lock (`daemons/watermark.js` against `<data root>/policy/distillation-state.lock`, a legacy name kept for compatibility). Without a single normative pattern, each module reinvents a slightly different recipe and the differences become race-condition gradients. The pattern is named **acquireExclusiveLockFile** and every implementation MUST follow it byte-for-byte:

1. **Sidecar file as the lock.** `<resource>.lock` lives in the same directory as the resource. File presence IS the lock. Body is `JSON.stringify({pid: process.pid, heartbeat_ts: <ISO-8601>})` for diagnostics. Mode `0600`.
2. **Atomic create.** Open with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`. The atomic create + refuse-symlink combination is what makes acquisition single-winner across processes. `O_EXCL` returning `EEXIST` is the "someone else holds the lock" signal; `EEXIST` is the ONLY error that triggers retry-with-backoff. Any other errno propagates.
3. **Post-open `nlink === 1` check.** Immediately `fstat(fd)` and assert `st.nlink === 1`. This defeats a swap-during-acquire pathology where another process unlinks-and-recreates the lock file between our open and our write — our fd would still write to a now-orphaned inode while a competing winner held the new one.
4. **Heartbeat for long holds.** If the critical section is bounded sub-millisecond (typical: nonce-store check-and-append, policy-events single-line append) the heartbeat is optional. For longer holds (watermark daemon's full state-rewrite) the holder MUST `utimesSync` the lock every `STALE_LOCK_RECOVERY_SECONDS / 2` while holding it.
5. **Stale reclaim.** On acquisition failure, check the lock file's mtime. If `(now_ms - mtimeMs) > STALE_LOCK_RECOVERY_SECONDS * 1000` AND (best-effort) the recorded PID is non-live (`process.kill(pid, 0)` → `ESRCH`), `unlinkSync` the sidecar and retry. The PID check is best-effort because cross-host scenarios (NFS, container restart) can have live PIDs in a different process namespace; mtime is the load-bearing predicate.
6. **Bounded retry.** Cap retries at `STALE_LOCK_RECOVERY_SECONDS` wall-clock. Beyond that, throw — the caller surfaces via `memory_health.health_notes` rather than hanging the request.
7. **Release on close.** Release MUST `closeSync` then `unlinkSync` the sidecar. Closing without unlinking would leave a stale lock; unlinking without closing leaks the fd (harmless but noisy under load). Wrap the body in `try { ... } finally { releaseLock(fd); }` and tolerate `ENOENT` on the unlink (another process's stale-reclaim may have already removed it).

Caps are shared: `STALE_LOCK_RECOVERY_SECONDS = 60` (the timeout AND the stale threshold) and the 25ms backoff between retry attempts. Both live in `mcp/lib/validation.js § CAPS`.

Reference implementation: `mcp/lib/nonce-store.js → acquireLock / reclaimStaleLockIfDead / releaseLock`. `policy-events.js` and the watermark daemon implement the same three functions with identical semantics. New modules MUST link to this section in their header comment and MUST NOT invent variant rules (e.g. retry-forever, `O_TRUNC` lock body, omitted `O_NOFOLLOW`).

**Sanctioned deviations (index-WAL flush lease, `mcp/lib/recall/index-wal.js`).** Two documented deviations, both scoped to the `index-wal.lock` flush lease only (the append micro-lock stays fully canonical):

1. *Non-blocking acquire.* `acquireFlushLease` is a try-acquire: contention returns `null` and the caller skips the flush instead of retry-with-backoff (step 6). Safe because the WAL retains every record — a skipped flush defers persistence, never loses data.
2. *Single heartbeat before a long save.* Step 4 mandates a heartbeat every `STALE_LOCK_RECOVERY_SECONDS / 2` during long holds; `_flushPendingSaves` (`index-cache.js`) heartbeats exactly once immediately before `saveIndices`. A periodic timer cannot close the gap: `saveIndices` is fully synchronous, so nothing fires on the blocked event loop while it runs, and its internals are contractually unchanged. Example measurement (2026-07-14, one development machine): saving an `hnsw.bin` of about 1.9 GB took ~0.83 s wall for the dominant write+fsync+rename, ~70x inside the 60 s ttl; at that install's index growth (~30 MB/day) the margin is decades. Your index size and timings will differ. The gap is additionally only *latent* single-host: stale reclaim requires mtime age > ttl AND a dead pid (step 5), and the flushing process is alive mid-save, so its lease cannot be reclaimed under it. Cross-host the pid check is best-effort and mtime is the load-bearing predicate — if the per-version index trees ever move to shared storage, this deviation MUST be closed by threading heartbeats into the save itself.
