# Glossary

Terms used in the knowledge base. Stable definitions. `<data root>` is the directory the server keeps its data in (`MEMORY_ROOT`, which defaults to the checkout; see `mcp/lib/config.js`); `<checkout>` is the directory the repository was cloned into.

**backfill** — first-connection historical pull from a source. Years of content, paginated and throttled, runs in background, does not block live ingestion. Backfill events carry a flag so the salience filter can apply a stricter promotion threshold.

**brief** — the bounded output of a `recall` call. Capped in characters and items. Includes provenance, freshness, optional density flag.

**catch-up** — connector mode after restart or transient outage. Pulls from cursor in-order, rate-limited; live tail resumes when caught up.

**confirmation token** — short-lived, single-use, argument-bound token required as input on privileged MCP tools. Issued out-of-band by the user (settings UI, CLI prompt, signed config) for agent-callable privileged tools; minted out-of-band by the user (with `mintToken` in `mcp/lib/daemon-token.js`) from the daemon signing-key file for the manual `memory_distill_promote_fact` surface. The token payload carries a `binding_hash = sha256(canonical_json(binding_object))` where `binding_object` is the complete set of arguments that determine the operation's scope or destructiveness — not a single field. `canonical_json` is **RFC 8785 (JCS)** — pinned normatively in `mcp-surface.md` § Privilege levels with a test vector; minter and verifier must produce bit-identical bytes or every privileged call silently fails. The verifier recomputes `binding_hash` from inbound arguments and rejects on mismatch, so consent is for the verb, not just the noun. "Single-use" is enforced by a server-side consumed-nonce store with atomic check-and-set, checksum-per-line, TTL, and stale-lock recovery. See `mcp-surface.md` § Privilege levels for per-tool binding objects.

**connector** — per-source daemon. Authenticates, maintains a cursor, appends raw events to its source ledger. The highest-privilege component in the system; one process per source for credential isolation.

**consent_basis** — source-policy field declaring whose consent the ingestion relied on: `first_party`, `third_party_inferred`, `third_party_explicit`. About consent to ingestion, not about authorship — see `ingestion.md` § Consent-aware promotion.

**consumed-nonce store** — append-only JSONL at `<data root>/policy/consumed-nonces.jsonl` that mediates the single-use property of every confirmation token (both user-issued and daemon-signed). Each line: `{nonce_hash, tool, accepted_at, checksum}`. The verifier holds an exclusive file lock from scan-start through append-end, so check-and-set is atomic. Corrupt tails are detected and truncated on startup; a background sweeper prunes entries older than `CONSUMED_NONCE_TTL_SECONDS`. Consumption is also logged to `<data root>/policy/policy-events-YYYY-MM.jsonl` for audit. Live. See `mcp-surface.md` § Consumed-nonce store.

**conversational neighborhood** — the surface area of topics, entities, time references, and mood signals in a given conversation. Determines what surfaces from the ledger.

**cursor** — per-source, per-chat/folder marker of last-ingested `source_msg_id` or timestamp. Connector operational state, not memory state. Recoverable by querying the source if lost.

**daemon-signed token** — confirmation-token variant minted out-of-band from `<data root>/policy/distillation-signing-key.json` and consumed by the memory MCP server's verifier when the user manually calls `memory_distill_promote_fact`. Payload `{type: "daemon", binding_hash, nonce, issued_at, expires_at}`; signed via HMAC-SHA256 over the canonical-JSON payload bytes; wire form `base64url(payload).base64url(signature)`. Lifetime bounded by `DISTILLATION_TOKEN_TTL_SECONDS` (300s). Single-use via the consumed-nonce store. The verifier selects the signing key by `payload.type`; daemon-signed and user-issued tokens are not interchangeable (verifier rejects on `type` mismatch). The named §7 exception to "agents cannot write durably" (`thesis.md`). See `mcp-surface.md` § Privilege levels → Daemon-signed token. The original minter (a long-lived supervisor process) is retired; see `kb/legacy-archive.md`.

**damping** — down-weighting of recently-surfaced memories to prevent positive-feedback dominance in extended conversations.

**decay** — the default mode of forgetting. Not an operation. A memory becomes hard to recall because no incoming context matches it well anymore.

**density flag** — recall output signal that many candidates are near the topic and no single one stood out. Prompts a follow-up rather than guessing.

**derivation graph** — edges between memory events declaring which were derived from which. Enables forgetting propagation and provenance tracing.

**design_corpus** — flag on backfilled events drawn from transcripts that participated in designing the system itself. Identified mechanically (Claude Code JSONLs whose tool-use events touched `<checkout>/`); relaxes the stricter backfill promotion threshold because the KB files in the same subtree act as cross-source corroboration. See `agent-integration.md` § Transcript backfill.

**discrimination** — the index's ability to map an incoming context to a small set of relevant memories. Erodes as neighborhood density grows.

**distillation hook** — historical term for the process that ran at conversation end to emit promotion and policy events. Retired; promotion is now performed by the row-by-row salience cascade (`watermark.tickSourcesOnce`, see `kb/salience-design.md`). See `kb/legacy-archive.md` for the retired pipeline.

**cascade tick** — one iteration of the watermark daemon's main loop. On each tick the daemon scans `storage/sources/<src>.jsonl` rows past each per-source cursor and runs Stage-0 dispatch -> Stage-1 score -> Stage-2 embed+kNN -> CORROBORATE / PROMOTE / EMBED_DEFERRED / DROP per row, with a direct call to `promoteSourceRow` on PROMOTE. Replaces the retired `distillation tick` term; see `kb/salience-design.md`.

**engagement-gated reinforcement** — reinforcement that requires user response, correction, or agreement — not raw surfacing.

**event ledger** — append-only stream. Sacred. Source of truth.

**excise** — privileged forgetting operation that mutates the ledger. Used for consent revocation, legal removal, real shame. Designed, not implemented (`mcp-surface.md` § Planned, not implemented).

**exclude** — forgetting operation. Hides a memory in contexts matching a predicate. Covers tombstone and contextual suppression.

**fact** — memory event kind, promoted from a source.

**feature-vector predicate** — exclude predicate stored as `{context_embedding, embedding_model_version, context_entities, similarity_threshold, scope}`. The agent passes only `recall_id` + `context_entities` + `similarity_threshold` + `scope`; the server snapshots `context_embedding` and `embedding_model_version` from the `recall`-kind ledger event referenced by `recall_id` (specifically its `query.context_embedding` and `query.embedding_model_version` fields — see `architecture.md` § Memory ledger per-kind extensions). Hand-crafted vectors cannot reach the predicate store because there is no field to put them in. Inspectable, cheap, editable.

**hook bridge** — pair of thin shell scripts (`<checkout>/hooks/stop-hook.sh`, `<checkout>/hooks/session-end-hook.sh`) that translate Claude Code's `Stop` / `SessionEnd` hook JSON into `chat-claude-code.jsonl` source-ledger appends. Holds no secrets, makes no MCP calls, never blocks the runtime. The hook bridge writes rows; the watermark daemon's cascade tick then reads those rows through Stage-0/1/2 and promotes via `promoteSourceRow`. See `agent-integration.md § Hook bridge` and `kb/salience-design.md`.

**watermark** — the per-source resume cursor maintained by `daemons/watermark.js` over `storage/sources/<src>.jsonl`, stored at `<data root>/storage/watermark-state/<src>.json`. The cascade tick reads from the cursor's `last_offset` forward each iteration. The older "idle watermark" — a per-conversation idle threshold that fired the retired conversational pipeline — is retired; see `kb/legacy-archive.md`.

**memory landscape** — the projection of the ledger under a given recall context. Does not exist between recalls.

**memory ledger** — `ledgers/memory.jsonl`. Mixed-kind append-only stream: facts, policies, recalls, reconstructions.

**policy** — memory event kind. An `exclude`, `replace`, `substitute`, or `excise` operation.

**projection** — the result of applying recall + policy + index to the ledger for a given context. Disposable, recomputable, not authoritative.

**promotion** — the salience filter's decision to elevate a raw source event into the memory ledger.

**propose-back** — UX pattern where the agent surfaces its interpretation of a forgetting intent for user confirmation before executing.

**provenance** — origin metadata: source, time, parties, derivation, confidence. Required on every event.

**recall** — function from `surrounding_context` to `brief`. Also a memory event kind logging the function call.

**recall trace** — per-memory log of which conversational neighborhoods have surfaced it. Input to damping.

**reconstructed** — memory event kind capturing an agent-emitted summarization during recall. May legitimately diverge from source.

**reinforcement** — boost to a memory's future recall likelihood. Triggered by user engagement, not raw surfacing.

**replace** — forgetting operation. New fact wins the projection where both could surface; old fact stays in ledger and may surface in different scopes.

**replay set** — held-out labeled conversations used to evaluate the salience filter and recall function. Built incrementally through use.

**salience filter** — the classifier that decides promotion. Conservative default. The actual product.

**sensitive-material gate** — ingestion-time filter for credentials, tokens, third-party content flagged by source policy. Quarantines, never promotes.

**silent excise** — excise that does not log the excision itself. Used when the act of excising is itself sensitive.

**source ledger** — per-app append-only JSONL of raw events. One per source.

**source policy** — declared at ingest per source: `deletion_semantics`, `consent_basis`.

**substitute** — forgetting operation. Rewrites content under provenance ("reframed at time T from original"). Original stays auditable.

**supersession** — the relationship `replace` creates between old and new facts.

**surrounding context** — the input to `recall`. Recent turns, entities, time, mood, calendar, agent role, recent recall trace.
