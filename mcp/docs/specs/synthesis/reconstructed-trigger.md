# Reconstructed-Event Trigger Taxonomy

> Foundation contract — `F-SYN-FOUNDATION-reconstructed-trigger`.
> Resolves `open-problems.md #6 (Reconsolidation policy)`.
> Authoritative emission model for the `reconstructed` kind of the memory ledger.

---

## Mission

The memory ledger's four-kind taxonomy (`fact` / `policy` / `recall` / `reconstructed`) is the load-bearing schema of the entire system (`architecture.md §4`). `reconstructed` exists to capture *agent-emitted summarization*: the moment a conversation re-derives or recombines durable memory into a new propositional artifact that ought itself to be subject to forgetting, corroboration, and provenance propagation. `open-problems.md §6` is honest that the *trigger* — when to emit a `reconstructed` event versus when to leave the recall as pure read-and-cite — is unclear and "will need tuning."

This spec pins that boundary down. It defines:

1. **WHO is allowed to emit a `reconstructed` row** — exactly two callers (agent path via screened MCP tool; daemon path via in-process call from the watermark daemon's idle-tick aggregators) — and the auth gate each path uses.
2. **WHAT the classifier looks for** on the agent path — a three-class decision: `PURE_CITATION` (refuse), `SINGLE_PARENT_SUMMARIZATION` (accept with `derived_from: [parent_id]`), `MULTI_PARENT_CORROBORATIVE` (accept with `derived_from: parents`).
3. **The shared validator+appender (`emitReconstruction`)** that both callers converge on so that no `reconstructed` row can ever skip parent-existence, not-excised, source-policy-consent, idempotence, or feature-population enforcement.
4. **Idempotency keys** for both paths, so the same conversational summary or the same daemon aggregator tick cannot double-fire.
5. **The CAPS knobs** that govern thresholds, with explicit acknowledgement that several default values (`RECONSTRUCT_MIN_CONFIDENCE=0.6`, `RECONSTRUCT_CITATION_SIMILARITY_GATE=0.85`, multi-parent overlap gate `0.15`) are *initial guesses* that the user will recalibrate against logged labels.

The spec is on-thesis: `thesis.md §6` requires provenance threaded everywhere; `thesis.md §7` requires that agents cannot write durably without going through the screened MCP surface; `research-retrieval-frontiers.md Risk #10` requires that reflection/promotion write a NEW event with `derived_from[]` populated and parents stay immutable. All three are honored. No new ledger kind is introduced — the architecture.md §4 four-kind taxonomy is preserved.

The W4 critic revision (`revision_step: WU-reconstructed-auth-and-policy-kind`) is authoritative: the agent path REQUIRES a daemon-signed `confirmation_token` (mirroring `memory_distill_promote_fact`); the daemon path bypasses the token by analogy with the cascade's in-process `promoteSourceRow` (`architecture.md §8 line 182`); the agent-path-tokenless variant from the initial design is REJECTED.

---

## kb anchors

Each anchor below is a verbatim quote from the indicated section, plus how this spec binds to it.

### A1. `open-problems.md #6 Reconsolidation policy`

> "Each recall is a rewrite of the recalled memory in the agent's working understanding. The reconstructed kind exists in the ledger to capture this, but the trigger is unclear: Agent summarizations during a conversation should produce reconstructed events. Pure read-and-cite recalls should not. The boundary is fuzzy and will need tuning."

**Binding.** This spec resolves the "trigger is unclear" question by making the boundary mechanical at the MCP screening layer (agent path) and at the aggregator admission layer (daemon path). The "will need tuning" caveat is honored — every threshold is exposed as a `CAPS.*` knob and the open-questions section calls out the calibration debt explicitly.

### A2. `architecture.md §4 Memory ledger → reconstructed kind`

> "reconstructed: content — agent-emitted summarization; derived_from: [ id, ... ]; features: { embedding, embedding_model_version, entities, time_anchors }"

**Binding.** The schema below preserves this shape EXACTLY. The `features` payload does NOT include `valence` (architecture.md §4 lists valence only on `fact` features). The phrase "agent-emitted summarization" is BROADENED in this spec to "synthesis-system-emitted summarization" to admit the daemon path; the call site is distinguished by `provenance.agent_id`. No fifth kind is introduced. No field added that architecture.md does not list.

### A3. `thesis.md Principle 6: Provenance threaded everywhere`

> "Every event carries source, time, parties, derivation links. Agent-emitted inferences declare what they were derived from. The derivation graph is what makes forgetting propagation possible — without it, a forgotten fact resurfaces through its derivatives."

**Binding.** `derived_from: id[]` is required on every emitted `reconstructed` row. The validator REFUSES emission if `parents.length === 0`, if any parent does not exist on the memory ledger, or if any parent has been excised. This is what makes the forgetting-propagation guarantee in `F-SYN-FOUNDATION-derivation-propagation` mechanically enforceable.

### A4. `thesis.md Principle 7: Agents cannot write durably (without going through the screened surface)`

> "Mutation goes through a narrow MCP surface that validates, screens, attaches provenance, deduplicates, applies policy. This discipline is what lets the system recover from agent mistakes."

**Binding.** The AGENT path requires a daemon-signed `confirmation_token` whose binding hash covers `{content_hash, parent_set_hash, conversation_id, scope}` — same screening discipline as `memory_distill_promote_fact`. The DAEMON path bypasses the token but still passes through the SCREEN proper (parent-exists, not-excised, consent walk, idempotence, feature population). Both callers converge on the same `emitReconstruction(input, ctx)` validator+appender; the screen is shared.

### A5. `architecture.md §8 line 182`

> "the cascade's promoteSourceRow is an in-process call" / "The watermark daemon itself does NOT mint or consume these tokens"

**Binding.** This is the binding KB warrant for the daemon path. The cascade promotes facts WITHOUT minting tokens because OS process trust (same uid, same boot-time privilege as the watermark daemon) plus the structural screen IS the screen. The reconstructed-emission daemon path inherits this precedent: thread/project aggregators call `emitReconstruction` directly from the watermark daemon's idle-tick path, no token mint, no token consume.

### A6. `research-retrieval-frontiers.md Risks #10: A-MEM-style memory evolution destroys provenance`

> "Reject in-place rewrites. Reflection/promotion writes a NEW event with derived_from[] populated; parents stay immutable; semantic promotion is corroboration-gated (≥3 distinct source_refs)."

**Binding.** Reconstructed events NEVER mutate their parents. Each emission is a fresh append-only row. The "corroboration-gated (≥3 source_refs)" threshold from this risk-line is the inspiration for the daemon path's `THREAD_AGGREGATION_MIN_FACTS=3` and `PROJECT_AGGREGATION_MIN_COMMITS=5` admission gates (specified in the behavior-tier nodes; this spec is the contract those nodes implement against).

### A7. `agent-integration.md § Token-event ownership table (AUTHORITATIVE)`

> Table row: `policy.token.consumed | memory_distill_promote_fact handler | immediately after checkAndConsume (nonce append) succeeds`

**Binding.** The agent path's screening sequence — `verifyToken → verifyBinding → checkAndConsume` — is the SAME five-step discipline already in production for `memory_distill_promote_fact`. This spec calls it out by name and constrains the agent-path handler to follow it byte-for-byte. The reconstructed-tool handler emits the SAME `policy.token.consumed` / `policy.token.rejected` audit events that the promote-fact handler emits.

---

## Auth Model

This section is the AUTHORITATIVE pin for token discipline on the reconstructed-emission path. It is the cross-tier contract that `F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER` (the 8-step shared validator+appender), `F-SYN-INTEGRATION-RECONSTRUCTED-MCP-TOOL` (the agent-path handler), and `F-SYN-BEHAVIOR-thread-aggregation` / `F-SYN-BEHAVIOR-project-aggregation` (the daemon callers) all bind against. Conformance failures here are structural — the screen integrity of the entire `reconstructed` write surface depends on this.

The model is intentionally a verbatim mirror of `memory_distill_promote_fact`'s discipline (which is itself the load-bearing precedent established in waves W0–W9 for write-screened operator promotion). The reconstructed emitter is the SECOND screened write surface in the system; one identity gate per caller class, one shared structural screen, no exceptions.

### AM1. The two callers (mutually exclusive)

There are exactly TWO authorized callers of `emitReconstruction(input, ctx)`. Any other caller is a conformance failure (see I1 — the grep gate enforces this at CI time).

| Caller | Surface | Identity gate | Trust basis | `provenance.agent_id` pattern |
|---|---|---|---|---|
| **Agent** | MCP tool `memory_distill_emit_reconstructed` | daemon-signed `confirmation_token` (REQUIRED field) | The token proves a token-minting authority (the user's supervisor process, holder of `<data root>/policy/distillation-signing-key.json`) approved THIS agent + THESE args | `claude-code:<conv_id>`, `codex:<conv_id>` (matches `(claude-code\|codex\|operator):.+`) |
| **Daemon** | In-process function call from `daemons/watermark.js` idle-tick path | NONE (no token; not minted, not consumed, not verified) | OS process trust — same uid, same boot-time privilege, same shared-memory address space as `promoteSourceRow` (the cascade's already-sanctioned in-process write path) | `daemon:thread-aggregator`, `daemon:project-aggregator` (matches `daemon:.+`) |

The dispatch on caller class is `input.mode` (`"agent"` vs `"daemon"`). Mode mismatches with `agent_id` prefix (e.g. `mode: "agent"` carrying `agent_id: "daemon:foo"`) are rejected with `INVALID_AGENT_ID` at R1 (caller dispatch). This is defense-in-depth — the prefix-based audit discriminator cannot drift from the dispatch-level discriminator.

### AM2. Token shape (agent path)

The `confirmation_token` field on `EmitReconstructedInput` is a base64-encoded daemon-signed JWT-equivalent. The signing key is `<data root>/policy/distillation-signing-key.json` (the SAME key already used to sign `memory_distill_promote_fact` tokens — single key, multiple bound contexts; precedent: `architecture.md §8 line 182`). The agent never holds this key.

**Token payload — fields that MUST be signed:**

```jsonc
{
  "type": "memory_distill_emit_reconstructed",   // distinct from promote-fact's "memory_distill_promote_fact"
  "iat": <unix-ts>,                              // issued-at; freshness gate is CAPS.RECONSTRUCT_TOKEN_TTL_SECONDS (default 900 = 15 min)
  "nonce_hash": "<sha256-hex>",                  // server-side single-use nonce identifier
  "binding_hash": "<sha256-hex>",                // sha256(canonical_json(binding_object)); see below
  "agent_role": "<string|null>",                 // optional; if set, MUST equal input.agent_role
  "conversation_id": "<string>"                  // MUST equal input.recall_id's logged conversation_id
}
```

**`binding_object` — what binding_hash binds the token to:**

```jsonc
{
  "content_hash":      "sha256(content)",                               // exact bytes of input.content
  "parent_set_hash":   "sha256(canonical_json(input.parents.sort()))",  // order-independent over the parent SET
  "conversation_id":   "<string>",                                      // MUST equal input.recall_id's logged conversation_id
  "scope":             "<conversation_local|agent_role_scoped|cross_session>"  // MUST equal input.scope
}
```

The four bound fields are the MINIMUM that pins the token to the specific args — by binding `content_hash`, the token cannot be replayed for a different summarization; by binding `parent_set_hash`, the token cannot be replayed against a different parent set (even one mutation of the parents array changes the hash); by binding `conversation_id`, the token cannot leak across conversations; by binding `scope`, the token cannot be escalated from `conversation_local` to `cross_session` after mint.

**Note on `recall_id`:** `recall_id` is NOT in the binding object. The token binds to `conversation_id` (the broader scope) and the handler separately enforces that `input.recall_id`'s logged `conversation_id` matches the token's `conversation_id` field. This decouples token minting from recall identity — the supervisor mints one token per emit-attempt; the agent supplies the freshest `recall_id` it has within the TTL window. Re-recalls within the same conversation don't require a token re-mint as long as the parents + content + scope are unchanged.

### AM3. Server-side token verification (agent path) — 5-step ordered sequence

The handler MUST execute these five steps IN ORDER. Reordering is a conformance failure (R9 ordering — the ordering choice is load-bearing for both security and gaming-defense). This mirrors `memory_distill_promote_fact`'s handler byte-for-byte; the audit-join consumer treats both screens as the same audit shape.

1. **`computeBindingObject(input)`** — pure function over `input`; assembles `binding_object` per AM2. Fails closed if any field is missing (the payload-shape assertion at handler step 2 should have caught this, but the binding step double-checks).
2. **`verifyToken(token)`** — cryptographic verify against the daemon-signing public key.
   - Checks: `type === "memory_distill_emit_reconstructed"`, `iat` within `CAPS.RECONSTRUCT_TOKEN_TTL_SECONDS`, signature valid.
   - Fail codes: `TOKEN_EXPIRED`, `BAD_SIGNATURE`, `INVALID_TOKEN_TYPE`.
   - Rejects BEFORE touching the nonce store — invalid signatures cannot burn nonces.
3. **`verifyBinding(token.binding_hash, computeBindingObject(input))`** — recompute `sha256(canonical_json(binding_object))` from `input` and compare byte-for-byte to `token.binding_hash`.
   - Fail code: `BAD_BINDING` with `reason: "binding hash mismatch — token bound to different args"`.
   - Rejects BEFORE touching the nonce store — wrong-binding tokens cannot burn nonces.
4. **`checkAndConsume(token.nonce_hash)`** — atomic single-use check against `<data root>/policy/nonce-store.jsonl` (the existing nonce store used by `memory_distill_promote_fact`).
   - Atomic via the existing single-lock discipline (`mcp-surface.md § Privilege levels → Daemon-signed token`; precedent: promote-fact's `checkAndConsume`).
   - Fail code: `NONCE_REPLAY` if already consumed.
   - This is the IRREVERSIBLE burn. Subsequent failures (classifier reject, parent-not-found, etc.) DO NOT un-burn the nonce (E5 — gaming defense).
5. **`emit policy.token.consumed`** — append audit event to `policy-events-YYYY-MM.jsonl` AFTER the burn succeeds. Shape mirrors promote-fact's `policy.token.consumed` exactly; the audit discriminator is `tool: "memory_distill_emit_reconstructed"`.

Only after step 5 does the handler proceed to the classifier (R5/R6/R7) and then to `emitReconstruction(input, ctx)`. The token has already done its job — the rest is the structural screen.

### AM4. The in-process daemon path — NO token, BUT same structural screen

The DAEMON path (`mode: "daemon"`) carries NO token field. The daemon MUST NOT:

- Mint tokens (it does not hold the signing key; the user's supervisor is the sole minting authority — same posture as the watermark daemon's cascade)
- Consume tokens (no `checkAndConsume` call)
- Emit `policy.token.consumed` or `policy.token.rejected` events (none in the audit stream from the daemon path)

The daemon path is structurally identical to the cascade's in-process `promoteSourceRow` (`architecture.md §8 line 182`: *"the cascade's promoteSourceRow is an in-process call"* / *"The watermark daemon itself does NOT mint or consume these tokens"*). The trust basis is OS process identity: the watermark daemon runs under the user's uid with boot-time privilege; an attacker who has compromised that uid has already won (no token would help). The token gate exists to prevent a hostile or buggy AGENT from writing — it does not exist to prevent the OS-trust-equivalent watermark daemon from writing.

**Critically — the absence of a token does NOT mean the absence of a screen.** The daemon path satisfies the SAME structural validators as the agent path, run by the SAME `emitReconstruction` function:

| Validator | Implemented in | Agent path | Daemon path |
|---|---|---|---|
| `assertShape` (payload schema) — SchemaValidator | `emitReconstruction` step 1 | YES | YES |
| `assertParentsExist` — ParentVerifier R2 | `emitReconstruction` step 2 | YES | YES |
| `assertParentsNotExcised` (incl. transitive-orphan BFS) — ParentVerifier R3 | `emitReconstruction` step 3 | YES | YES |
| `consentWalk(parents)` — source-policy consent inheritance | `emitReconstruction` step 4 | YES | YES |
| `computeIdempotencyKey` + `checkIdempotent` — IdempotenceCheck R8 | `emitReconstruction` steps 5–6 | YES (S4 key) | YES (S5 key) |
| `embedContent` + `extractFeatures` — feature population | `emitReconstruction` steps 7–8 | YES | YES |
| `assembleRow` + `appendLedgerRow` (fsync + dir-fsync) | `emitReconstruction` steps 9–10 | YES | YES |
| `updateIndices` (derivation graph + vector) | `emitReconstruction` step 11 | YES | YES |
| `emit policy.reconstruct.emitted` | `emitReconstruction` step 12 | YES | YES |
| Token verify (AM3) | Handler step 3 (BEFORE emitter) | YES | NO |
| Classifier (R5/R6/R7) | Handler step 4 (BEFORE emitter) | YES | NO (aggregator admission gates apply instead — owned by the behavior tier) |

The token + classifier columns are AGENT-ONLY because they are agent-identity-gates (token) and agent-output-screens (classifier — "is this content actually a reconstruction or just a quotation?"). The daemon does not need either: it has OS process identity, and its content is composed by Gemini Flash against an aggregator-curated group, not by an agent against a surfaced parent set.

**Precedent binding (re-stated for unambiguity):**

- `architecture.md §8 line 182` — the cascade's `promoteSourceRow` is the in-process precedent for token-free same-uid writes that still satisfy the structural screen.
- `agent-integration.md § Token-event ownership table (AUTHORITATIVE)` — confirms that `policy.token.*` events are produced ONLY by the screened MCP tool handlers, not by the watermark daemon. Inheriting this discipline: the daemon path emits `policy.reconstruct.emitted` but NEVER `policy.token.*`.

### AM5. Convergence at the shared validator

Both paths converge at the SAME `emitReconstruction(input, ctx)` function. This is invariant I1 (Single emitter): no code path appends a `kind: "reconstructed"` row except through this function. The CI grep gate enforces this — a search for `"kind":\s*"reconstructed"` in any source file other than `mcp/lib/synthesis/reconstruction-emitter.js` is a conformance failure.

The convergence is what makes the structural screen the load-bearing security boundary, NOT the token. The token is the agent-identity-gate (it answers "is this agent allowed to write?"); the structural screen is the answer to "is this WRITE safe regardless of who emitted it?". Both questions matter, and they are answered at different layers — by separating them, the system can admit the daemon path (which doesn't need the agent-identity-gate but still needs the structural-safety screen) without weakening either.

### AM6. Test fixtures — both paths converge at the same validator

The substrate test suite (`mcp/tests/synthesis/reconstruction-emitter.test.js`, owned by `F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER`) MUST include the following fixtures, each demonstrating that the agent path and the daemon path produce structurally identical screen outcomes:

**Fixture AM-T1 — Both paths reject a non-existent parent:**

```ts
// Setup: parents = ["fact_nonexistent_99"]; no such id in the ledger.
// Agent path:
const agentResult = await emitReconstruction({
  mode: "agent",
  content: "...",
  parents: ["fact_nonexistent_99"],
  conversation_id: "conv_test",
  agent_id: "claude-code:conv_test",
  confidence: 0.8,
  scope: "conversation_local",
  classifier_outcome: "SINGLE_PARENT_SUMMARIZATION",
}, ctx);
// Daemon path:
const daemonResult = await emitReconstruction({
  mode: "daemon",
  content: "...",
  parents: ["fact_nonexistent_99"],
  conversation_id: null,
  agent_id: "daemon:thread-aggregator",
  confidence: 1.0,
  aggregator_name: "thread-aggregator",
  bucket_key: "chat:test:2026-06-18",
}, ctx);

assert.deepEqual(agentResult,  { ok: false, code: "PARENT_NOT_FOUND", reason: /parent fact_nonexistent_99 not in memory ledger/ });
assert.deepEqual(daemonResult, { ok: false, code: "PARENT_NOT_FOUND", reason: /parent fact_nonexistent_99 not in memory ledger/ });
// Same code, same reason shape — proves the screen is shared.
```

**Fixture AM-T2 — Both paths reject an excised parent via the transitive-orphan BFS:**

```ts
// Setup: fact_X exists; excise fact_X with derivation_policy: "drop".
// Both paths attempt to reconstruct citing fact_X.
// Expected: both return { ok: false, code: "PARENT_EXCISED" }.
// Verifies R3 is shared — no path can resurrect excised content through reconstruction.
```

**Fixture AM-T3 — Both paths succeed structurally with no token, no classifier overhead on the daemon side:**

```ts
// Setup: two live facts fact_A, fact_B with first_party consent_basis.
// Agent path: provide content, classifier_outcome: "MULTI_PARENT_CORROBORATIVE" (set by the handler upstream).
// Daemon path: provide content with aggregator_name: "thread-aggregator", bucket_key: "...".
// Expected: both return { ok: true, memory_id: "rec_...", dedupe_action: "appended" }.
// Both produce a policy.reconstruct.emitted event; neither emits policy.token.* from the EMITTER (the agent path's token event came from the handler upstream, not the emitter).
// Inspect the appended rows: both have features.embedding populated, features.entities populated, features.time_anchors populated.
```

**Fixture AM-T4 — Both paths share the idempotence-check code path but use different key domains:**

```ts
// Re-fire the agent fixture from AM-T3 with identical args → S4 key matches → { ok: true, dedupe_action: "rejected_idempotent", memory_id: <prior> }.
// Re-fire the daemon fixture from AM-T3 with identical args → S5 key matches → { ok: true, dedupe_action: "rejected_idempotent", memory_id: <prior> }.
// Cross-fire: agent S4 key and daemon S5 key live in the SAME idempotence index but never collide (different `domain` field in the canonical_json).
// Verifies R8 idempotency monotonicity AND that the two-path key-domain isolation is real.
```

**Fixture AM-T5 — Handler-level: token-verify failure does NOT reach the emitter:**

```ts
// Agent-path-only fixture in mcp/tests/tools/distill-emit-reconstructed.test.js.
// Submit input with bad signature → handler returns BAD_SIGNATURE.
// Assertion: emitReconstruction was NEVER called (spy on the import). The emitter is not the token enforcer; the handler is.
// Verifies AM3's "rejects BEFORE touching the nonce store" + AM5's "convergence is at the emitter, not at the token".
```

**Fixture AM-T6 — Defense-in-depth: daemon path with a stray `confirmation_token` field is silently ignored:**

```ts
// Daemon-path input with an extra confirmation_token field (defense against a misconfigured daemon, per E8).
// Expected: emitReconstruction ignores the field, does NOT call verifyToken, does NOT touch the nonce store.
// A structural-anomaly event is appended to policy-events-YYYY-MM.jsonl for operator inspection.
// Verifies I7 (daemon path token-free) is preserved even under misconfiguration.
```

These six fixtures are the minimum binding test set for the Auth Model. The substrate node MUST implement them in its do_step; CI MUST run them on every PR touching `mcp/lib/synthesis/reconstruction-emitter.js`, `mcp/lib/tools/distill-emit-reconstructed.js`, or `daemons/watermark.js`.

### AM7. CAPS additions for the auth model

```ts
RECONSTRUCT_TOKEN_TTL_SECONDS: 900,            // 15 min freshness window on the agent-path token (matches promote-fact precedent)
RECONSTRUCT_NONCE_STORE_PATH: "<data root>/policy/nonce-store.jsonl",  // SHARED with promote-fact; same single-lock
```

The nonce store is SHARED with `memory_distill_promote_fact`. Token `type` field is the discriminator — `memory_distill_promote_fact` vs `memory_distill_emit_reconstructed` — so a nonce minted for one cannot be replayed against the other. The single-lock discipline (one writer to the nonce store at a time) is preserved.

---

## Schema(s)

### S1. `reconstructed` ledger row (canonical)

This is the shape that lands in `<data root>/ledgers/memory.jsonl` after a successful emission. It conforms to the architecture.md §4 common shape plus the per-kind `reconstructed` extension.

```jsonc
{
  // Common (every ledger entry — see architecture.md §4)
  "id": "rec_<ulid>",                       // ULID; server-generated at append time
  "ts": "<ISO-8601 UTC>",                   // server-stamped at append time
  "kind": "reconstructed",
  "provenance": {
    "agent_id": "<string>",                 // see below
    "conversation_id": "<string> | null",   // null for daemon-driven emissions
    "confidence": <number>                  // [0,1]; gate floor = RECONSTRUCT_MIN_CONFIDENCE
  },

  // Per-kind extension (architecture.md §4 reconstructed)
  "content": "<string>",                    // the distilled summarization, ≤ CONTENT_MAX_CHARS
  "derived_from": [ "<memory_id>", ... ],   // ≥1 entry; all must exist + not be excised
  "features": {
    "embedding": [ <float>, ... ],          // length = embedding model dim; L2-normalized
    "embedding_model_version": "<string>",  // e.g. "gemini-embedding-001"
    "entities": [ "<string>", ... ],        // extracted entity tags; may be empty
    "time_anchors": [ "<ISO-8601>", ... ]   // extracted time anchors; may be empty
  },

  // OPTIONAL — derivation graph admin (parallels fact schema)
  "superseded_by": null,                    // never set on reconstructed at write time
  "reframed_by": null,                      // never set on reconstructed at write time
  "rescinded_at": null                      // not applicable; only policy kinds rescind
}
```

**`provenance.agent_id` is the audit discriminator** (load-bearing — recall-side filters and the policy event stream use this to tell agent emissions from daemon emissions apart):

| value pattern                      | call site                                              |
|------------------------------------|--------------------------------------------------------|
| `claude-code:<conv_id>`            | agent path; Claude Code runtime                        |
| `codex:<conv_id>`                  | agent path; Codex CLI runtime                          |
| `daemon:thread-aggregator`         | daemon path; chat-thread aggregator                    |
| `daemon:project-aggregator`        | daemon path; project/commit aggregator                 |
| `operator:manual`                  | reserved; not used in v0                               |

**No `valence` field on `features`.** Open question O3 below is decided by architecture.md §4: the reconstructed `features` shape lists `entities` + `time_anchors` only (no `valence`). This spec pins that decision. `F-SYN-FOUNDATION-valence-provenance` MUST honor it — reconstructed events carry no valence at v0.

### S2. Agent-path MCP tool input schema

Tool name: `memory_distill_emit_reconstructed`.
Registered alongside `memory_distill_promote_fact` in `mcp/lib/tools/`.
File: `mcp/lib/tools/distill-emit-reconstructed.js` (new).

```ts
type EmitReconstructedInput = {
  recall_id: string;             // server-issued recall_id from a prior memory_recall
                                 // within RECALL_LOG_TTL_SECONDS (default 86400 = 24h)
  parents: string[];             // memory ledger ids; ≥1, ≤ PARENTS_MAX (default 16);
                                 // each must appear in the surfaced[] of the recall_id's
                                 // logged recall event
  content: string;               // the agent's reconstructed summarization; UTF-8,
                                 // length ≤ CONTENT_MAX_CHARS (existing cap)
  scope: "conversation_local"    // recall surfacing weight: only inside this conv
       | "agent_role_scoped"     // recall surfacing weight: across same agent_role
       | "cross_session";        // recall surfacing weight: across all sessions
  confidence: number;            // agent's self-reported confidence ∈ [0, 1];
                                 // gate floor RECONSTRUCT_MIN_CONFIDENCE = 0.6
  agent_role?: string;           // optional; populates provenance.agent_id suffix
                                 // when scope = "agent_role_scoped"
  confirmation_token: string;    // MANDATORY — daemon-signed JWT-equivalent;
                                 // binding {content_hash, parent_set_hash,
                                 //          conversation_id, scope}
};
```

**Reject conditions** (each returns `error: { code, reason }` per the standard envelope; see § Decision rules for exact codes):

- `recall_id` not found in ledger / older than `RECALL_LOG_TTL_SECONDS` → `RECALL_EXPIRED`
- `parents.length === 0` or `> PARENTS_MAX` → `INVALID_PARENTS`
- Any parent NOT present in the recall_id's `surfaced[]` → `PARENT_NOT_SURFACED`
- Any parent excised or transitive-orphan → `PARENT_EXCISED` / `PARENT_ORPHAN`
- `content` exceeds `CONTENT_MAX_CHARS` → `CONTENT_TOO_LONG`
- `scope` not in enum → `INVALID_SCOPE`
- `confidence < RECONSTRUCT_MIN_CONFIDENCE` → `LOW_CONFIDENCE`
- Missing `confirmation_token` → `TOKEN_REQUIRED`
- Token verify / binding / nonce-replay failures → `BAD_SIGNATURE` / `BAD_BINDING` / `NONCE_REPLAY` / `TOKEN_EXPIRED` (mirrors promote-fact)
- Classifier returns `PURE_CITATION` → `PURE_CITATION` (informational reject_reason; not a token-burn condition — see § Decision rules edge case E5)

### S3. Daemon-path in-process input schema

The daemons call `emitReconstruction(input, ctx)` directly. No MCP envelope, no token field.

```ts
type EmitReconstructionInput =
  | {
      // AGENT path (called from the tool handler after token verify + classifier)
      mode: "agent";
      content: string;
      parents: string[];
      conversation_id: string;
      agent_id: string;             // "claude-code:<conv_id>" or "codex:<conv_id>"
      confidence: number;
      scope: "conversation_local" | "agent_role_scoped" | "cross_session";
      classifier_outcome: "SINGLE_PARENT_SUMMARIZATION" | "MULTI_PARENT_CORROBORATIVE";
    }
  | {
      // DAEMON path (called from watermark idle-tick aggregators)
      mode: "daemon";
      content: string;
      parents: string[];
      conversation_id: null;        // daemon emissions are NOT scoped to a conv
      agent_id: `daemon:${string}`; // "daemon:thread-aggregator", etc.
      confidence: number;           // Gemini-Flash self-report; default 1.0 if unset
      aggregator_name: string;      // "thread-aggregator" | "project-aggregator"
      bucket_key: string;           // aggregator's group identity, e.g.
                                    //   "chat:<chat_identifier>:day:<YYYY-MM-DD>"
                                    //   "repo:<repo_root>:author:<email>:week:<isoweek>"
    };
```

**`ctx` (second arg) carries dependency injection** for testability:

```ts
type EmitReconstructionCtx = {
  memoryLedgerPath: string;           // mcp/lib/config.js → memoryLedgerPath()
  indexCache: IndexCache;             // mcp/lib/recall/index-cache.js
  embedFn: (text: string, opts: { task_type: "RETRIEVAL_DOCUMENT" })
            => Promise<{ embedding: number[]; model_version: string }>;
  policyEventsAppender: (event: PolicyEvent) => Promise<void>;
  now: () => string;                  // ISO-8601 server-ts injector
  ulid: () => string;
};
```

### S4. Idempotency key — agent path

```
sha256(canonical_json({
  domain: "agent",
  conversation_id: <string>,
  parent_set_hash: sha256(canonical_json(parents.sort())),
  content_hash: sha256(content)
}))
```

A second emission with the same `{conversation_id, parents (set-equal), content}` hashes to the same key and is dropped with `dedupe_action: "rejected_idempotent"` — the prior emission's row id is returned, no new row is appended.

### S5. Idempotency key — daemon path

```
sha256(canonical_json({
  domain: "daemon",
  aggregator_name: <string>,         // "thread-aggregator" | "project-aggregator"
  bucket_key: <string>,              // aggregator-specific group identity
  content_hash: sha256(content)
}))
```

Different identity domain from the agent path (no conversation_id; bucket_key replaces parent_set_hash because daemon aggregation produces one summary per group, not one summary per parent-set). Same dedupe discipline: re-firing the same aggregator on the same bucket with the same content is a no-op.

### S6. CAPS additions (`mcp/lib/validation.js § CAPS`)

```ts
// AGENT PATH
RECONSTRUCT_MIN_CONFIDENCE: 0.6,                  // confidence floor (§ Decision rules R4)
RECONSTRUCT_CITATION_SIMILARITY_GATE: 0.85,       // pure_citation refusal (§ R5)
RECONSTRUCT_MULTI_PARENT_PER_PARENT_OVERLAP_GATE: 0.15,  // multi-parent admission (§ R6)
RECONSTRUCT_PARENTS_MAX: 16,                      // upper bound on derived_from
RECONSTRUCT_CONTENT_MIN_CHARS: 24,                // refuse near-empty summaries

// DAEMON PATH — admission gates (consumed by behavior-tier aggregators)
THREAD_AGGREGATION_MIN_FACTS: 3,                  // group size floor — chat threads
THREAD_AGGREGATION_MAX_DURATION_HOURS: 24,        // bucket horizon
THREAD_AGGREGATION_DEBOUNCE_MINUTES: 30,          // re-fire interval
PROJECT_AGGREGATION_MIN_COMMITS: 5,               // group size floor — git/github
PROJECT_AGGREGATION_MIN_DIVERSITY: 0.3,           // entity-set Jaccard floor
PROJECT_AGGREGATION_DEBOUNCE_MINUTES: 120,        // re-fire interval

// SHARED — daemon tick interval
PROMOTE_IDLE_TICK_SECONDS: 300                    // 5 minutes
```

All consumers MUST read from `CAPS.<NAME>`; literal constants in handler code are a conformance failure (the validation.js CAPS table is the single source of truth — same discipline as the existing `RECALL_LOG_TTL_SECONDS` and `STALE_LOCK_RECOVERY_SECONDS`).

### S7. Policy event schemas added

The `policy-events-YYYY-MM.jsonl` audit log gains two new kinds (consumed by audit-join tooling and the recall-side filters):

```jsonc
// emitted by the agent-path handler after a successful reconstructed append
{ "kind": "policy.reconstruct.emitted",
  "memory_id": "rec_<ulid>",
  "agent_id": "<string>",
  "classifier_outcome": "SINGLE_PARENT_SUMMARIZATION" | "MULTI_PARENT_CORROBORATIVE",
  "parents": [ "<id>", ... ],
  "scope": "<enum>",
  "confidence": <number>,
  "ts": "<ISO-8601>" }

// emitted by the agent-path handler on classifier reject (NO token burn)
{ "kind": "policy.reconstruct.refused",
  "reason": "pure_citation" | "low_confidence" | "parent_excised" | "parent_not_surfaced",
  "agent_id": "<string>",
  "parents": [ "<id>", ... ],
  "ts": "<ISO-8601>" }
```

The daemon path emits `policy.reconstruct.emitted` with `agent_id` like `"daemon:thread-aggregator"`. Same shape; the `daemon:` prefix is the audit discriminator. The daemon path NEVER emits `policy.token.*` events (no token mint/consume — A5 binding).

---

## Function signatures / Module surface

### M1. `mcp/lib/synthesis/reconstruction-emitter.js` (new — SUBSTRATE tier)

**The shared validator+appender.** Both callers converge here. Owned by `F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER`; this spec specifies the contract.

```ts
/**
 * The single function that writes a reconstructed row to the memory ledger.
 * Both the agent-path MCP tool and the daemon-path aggregators call this.
 *
 * Order-of-operations (the screen proper):
 *   1. assertShape(input)                          // payload schema validation
 *   2. assertParentsExist(input.parents, ctx)      // each id present in ledger
 *   3. assertParentsNotExcised(input.parents, ctx) // each id not excised AND
 *                                                   //   not transitive-orphan
 *   4. consentWalk(input.parents, ctx)             // each parent's source_refs[]
 *                                                   //   .consent_basis check
 *   5. computeIdempotencyKey(input)                // agent vs daemon discriminator
 *   6. checkIdempotent(key, ctx)                   // return prior row if seen
 *   7. embedContent(input.content, ctx.embedFn)    // RETRIEVAL_DOCUMENT path
 *   8. extractFeatures(input.content)              // entities + time_anchors
 *   9. assembleRow(input, embedding, features, ctx.ulid, ctx.now)
 *  10. appendLedgerRow(row, ctx.memoryLedgerPath)  // fsync the file + dir
 *  11. updateIndices(row, ctx.indexCache)          // derivation graph + vector
 *  12. emitPolicyEvent("policy.reconstruct.emitted", ctx.policyEventsAppender)
 *  13. return { ok: true, memory_id: row.id, dedupe_action: "appended" }
 *
 * On any reject before step 9: return { ok: false, code, reason } AND
 * emit policy.reconstruct.refused (no token-burn equivalent — the token
 * has already been consumed by the agent-path handler before this function
 * is called; see § Decision rules E5).
 */
async function emitReconstruction(
  input: EmitReconstructionInput,
  ctx: EmitReconstructionCtx
): Promise<EmitReconstructionResult>;

type EmitReconstructionResult =
  | { ok: true; memory_id: string; dedupe_action: "appended" | "rejected_idempotent" }
  | { ok: false; code: ErrorCode; reason: string };
```

### M2. `mcp/lib/tools/distill-emit-reconstructed.js` (new — INTEGRATION tier)

**The agent-path MCP tool handler.** Mirrors `distill-promote-fact.js` structure byte-for-byte where applicable.

```ts
/**
 * memory_distill_emit_reconstructed — agent-driven reconstructed emission.
 *
 * Handler step order (mirroring promote-fact's 5-step screen + a classifier):
 *   1. scope                       — dispatch.js (MEMORY_ROLE check); NOT redone.
 *   2. payload shape               — assertObjectShape; per-field asserts.
 *   3. TOKEN VERIFY (5 sub-steps):
 *      3a. binding_object {content_hash, parent_set_hash, conversation_id, scope}
 *      3b. verifyToken             — type / freshness / signature
 *      3c. verifyBinding           — sha256(canonical_json(binding_object))
 *      3d. checkAndConsume         — atomic single-use nonce
 *      3e. token-success           — emit policy.token.consumed
 *   4. CLASSIFIER (three-class — see § Decision rules R5/R6/R7):
 *      4a. PURE_CITATION  → emit policy.reconstruct.refused; return error
 *      4b. SINGLE_PARENT  → fall through with classifier_outcome
 *      4c. MULTI_PARENT   → fall through with classifier_outcome
 *   5. emitReconstruction(input, ctx) — the shared validator+appender
 *   6. wrap envelope; return { content: [...], structuredContent: {...} }
 */
async function handle(args: EmitReconstructedInput, requestCtx: RequestCtx): Promise<ToolResult>;
```

### M3. `mcp/lib/synthesis/classifier.js` (new — FOUNDATION/SUBSTRATE seam)

```ts
/**
 * Three-class classifier for the agent path. Pure function; no I/O.
 * Decides whether the agent's content + parents are a citation, a
 * single-parent summarization, or a multi-parent corroborative synthesis.
 *
 * Inputs are the resolved parent fact bodies (content strings + entity
 * tags) — the handler fetches these from the index cache before calling
 * the classifier.
 */
function classifyReconstruction(input: {
  content: string;
  parents: Array<{ id: string; content: string; entities: string[] }>;
  embedFn?: (text: string) => Promise<number[]>;   // optional; used for paraphrase-aware gate
}): Promise<ClassifyResult>;

type ClassifyResult =
  | { outcome: "PURE_CITATION"; reason: string; metrics: { max_edit_similarity: number; max_cosine: number } }
  | { outcome: "SINGLE_PARENT_SUMMARIZATION"; parent_id: string; metrics: { edit_similarity: number; cosine: number } }
  | { outcome: "MULTI_PARENT_CORROBORATIVE"; metrics: { per_parent_overlap: Record<string, number> } };
```

### M4. `mcp/lib/synthesis/idempotency.js` (new — SUBSTRATE)

```ts
function computeIdempotencyKey(input: EmitReconstructionInput): string;       // S4 or S5
async function checkIdempotent(key: string, ctx: EmitReconstructionCtx)
  : Promise<{ seen: false } | { seen: true; prior_memory_id: string }>;
```

The idempotency index is a derived projection over the memory ledger — keyed on the keys defined in S4/S5, value is the prior `memory_id`. Lazy rebuild from the ledger if missing (treat as cache; same discipline as architecture.md §5 indices).

### M5. Daemon-path wiring (BEHAVIOR tier — owned by F-SYN-BEHAVIOR-thread-aggregation / project-aggregation)

This spec does NOT specify the aggregator internals (group selection, diversity gates, Gemini Flash composition prompts — those belong to the behavior nodes). It DOES specify the call site:

```ts
// daemons/watermark.js — idle-tick path
async function tickReconstructionAggregators(ctx: EmitReconstructionCtx): Promise<void> {
  const threadGroups = await aggregatePendingThreads({ now: ctx.now() });
  for (const group of threadGroups) {
    if (!passesAdmissionGates(group)) continue;
    const composed = await composeViaGeminiFlash(group);  // returns {content, confidence}
    await emitReconstruction(
      {
        mode: "daemon",
        content: composed.content,
        parents: group.parent_ids,
        conversation_id: null,
        agent_id: "daemon:thread-aggregator",
        confidence: composed.confidence,
        aggregator_name: "thread-aggregator",
        bucket_key: group.bucket_key,
      },
      ctx
    );
  }
  // ... same shape for project-aggregator
}
```

Tick interval: `CAPS.PROMOTE_IDLE_TICK_SECONDS = 300`. The aggregator runs as part of the existing watermark daemon's main loop; no separate process.

---

## Decision rules

Each rule is mechanical, edge-case-explicit, and references the CAPS or KB anchor it derives from.

### R1. Caller dispatch — agent vs daemon

`emitReconstruction` dispatches on `input.mode`:

- `input.mode === "agent"`: enforce `input.conversation_id` present; enforce `agent_id` matches `(claude-code|codex|operator):.+`; compute idempotency key via S4.
- `input.mode === "daemon"`: enforce `input.conversation_id === null`; enforce `agent_id` matches `daemon:.+`; enforce `aggregator_name` and `bucket_key` present; compute idempotency key via S5.

Mismatch (e.g. `mode: "agent"` with `agent_id: "daemon:foo"`) → reject with `code: INVALID_AGENT_ID`. Mode-not-in-enum → reject with `code: INVALID_MODE`.

### R2. Parent-existence enforcement

For each `parent_id` in `input.parents`:

1. Look up the parent in the index cache (`indexCache.byId(parent_id)`). Cache miss → fall through to a bounded tail-scan of the memory ledger (mirror existing recall hard-gate semantics).
2. If the parent is not found → reject with `code: PARENT_NOT_FOUND`, `reason: "parent <id> not in memory ledger"`.
3. If the parent's `kind` is not `fact` or `reconstructed` → reject with `code: INVALID_PARENT_KIND`. (Policy/recall events can never be `derived_from` targets — they have no propositional content to derive from. This is a defensive check; the agent's surfaced[] should never contain them.)

### R3. Not-excised + transitive-orphan check

This is the load-bearing forgetting-propagation gate. For each parent:

1. Run the existing `mcp/lib/recall/hard-gates.js` transitive-orphan BFS on the parent_id (reverseAdj walk, capped at `CAPS.MAX_DERIVATION_DEPTH = 16`).
2. If the parent is directly excised → reject with `code: PARENT_EXCISED`.
3. If the parent is transitively orphaned (an ancestor was excised with `derivation_policy: "drop"` or `"re_derive_without"`) → reject with `code: PARENT_ORPHAN`.
4. The BFS is the SAME path the recall layer uses; one transitive-orphan check covers all parents. This guarantees that a `reconstructed` event cannot be emitted that resurfaces excised content through its derivatives (the exact failure mode `thesis.md §6` warns about).

### R4. Confidence floor

If `input.confidence < CAPS.RECONSTRUCT_MIN_CONFIDENCE` (default 0.6) → reject with `code: LOW_CONFIDENCE`, `reason: "confidence ${value} below floor ${CAPS.RECONSTRUCT_MIN_CONFIDENCE}"`.

**Empirical-calibration acknowledgement** (open question O1): 0.6 is an initial guess. The behavior-tier dashboards will surface the rejection rate by confidence bin so the user can recalibrate. CAPS knob, not a hardcoded constant.

### R5. PURE_CITATION refusal (agent path only)

Triggered iff BOTH:

- `input.parents.length === 1` (single-parent — the only shape where citation is even possible), AND
- `normalized_edit_similarity(input.content, parent.content) > CAPS.RECONSTRUCT_CITATION_SIMILARITY_GATE` (default 0.85).

**`normalized_edit_similarity`** is Levenshtein over normalized strings (lowercase, NFKC, collapsed whitespace, stripped punctuation), divided by `max(len(a), len(b))`. This catches the "you're just quoting" case where the agent calls the tool with content that is, in any normalized sense, a copy of the parent.

**Paraphrase-aware extension** (acknowledging review issue MAJOR-2): if `edit_similarity` is below the gate BUT a cosine over Gemini embeddings between `content` and `parent.content` exceeds `0.92`, ALSO refuse with `reason: "pure_citation_paraphrase"`. This is a v0 hybrid — edit-similarity catches verbatim quoting cheaply, cosine catches paraphrase. The cosine threshold is also a CAPS knob (`RECONSTRUCT_PARAPHRASE_COSINE_GATE = 0.92`) and is acknowledged as a guess.

On refusal: emit `policy.reconstruct.refused` audit event with `reason: "pure_citation"` or `"pure_citation_paraphrase"`. Return `code: PURE_CITATION` to the agent. **The confirmation_token IS burned** even on this reject path (see § Edge case E5).

### R6. SINGLE_PARENT_SUMMARIZATION acceptance

Triggered iff:

- `input.parents.length === 1`, AND
- `normalized_edit_similarity(content, parent.content) ∈ (0.3, 0.85]`, AND
- Cosine similarity ≤ `RECONSTRUCT_PARAPHRASE_COSINE_GATE` (0.92).

The lower bound (0.3) is asymmetric — content far from the parent in edit-similarity AND parents.length === 1 raises a different question (is the agent actually summarizing the right parent?). Below 0.3 with one parent, the classifier returns `MULTI_PARENT_CORROBORATIVE` if it ALSO satisfies that rule's overlap gate, else falls through to a soft-accept (no refusal) with `classifier_outcome: "SINGLE_PARENT_SUMMARIZATION"` and a `low_overlap` flag in the metrics payload. Operator can tune the floor via `RECONSTRUCT_SINGLE_PARENT_MIN_EDIT_SIMILARITY = 0.3`.

On accept: emit with `derived_from: [parent_id]`, `classifier_outcome: "SINGLE_PARENT_SUMMARIZATION"`.

### R7. MULTI_PARENT_CORROBORATIVE acceptance

Triggered iff:

- `input.parents.length ≥ 2`, AND
- For each parent_id: `tf_idf_overlap(content, parent.content) ≥ CAPS.RECONSTRUCT_MULTI_PARENT_PER_PARENT_OVERLAP_GATE` (default 0.15).

**`tf_idf_overlap`** is the cosine over TF-IDF vectors of the two strings, using the corpus-wide IDF computed from the memory ledger (cached in the index — same projection as the BM25 index that already exists for recall, `mcp/lib/recall/bm25-index.js`).

If ANY parent fails the per-parent overlap gate → reject with `code: PARENT_NOT_CONTRIBUTING`, `reason: "parent <id> overlap ${value} below gate ${CAPS.RECONSTRUCT_MULTI_PARENT_PER_PARENT_OVERLAP_GATE}"`. This is the guard against the agent stuffing parents into `derived_from[]` that didn't actually contribute to the summarization.

**Calibration acknowledgement** (review issue MAJOR-3): 0.15 is an arbitrary v0 default with no held-out justification. Ship as a CAPS knob; instrument the rejection rate by parent count; tighten via O1 labels.

On accept: emit with `derived_from: parents (preserving the order the agent supplied)`, `classifier_outcome: "MULTI_PARENT_CORROBORATIVE"`.

### R8. Idempotency

Computed via S4 (agent) or S5 (daemon). On match → return prior `memory_id` with `dedupe_action: "rejected_idempotent"`. No new row appended; no `policy.reconstruct.emitted` event emitted (the prior emission already wrote it).

**Semantic-hash extension** (acknowledging review issue MINOR-5): in addition to `content_hash` (which lets a one-character edit slip past), the idempotency key MAY include a coarse `sem_bucket` derived from the content embedding's PQ codes. v0 ships the byte-level hash only; the semantic extension is on the wave-N roadmap (open question O2 in this spec is the discussion).

### R9. Token verification ordering (agent path)

The screening sequence in the handler is ORDERED. Reordering changes the security semantics and is a conformance failure:

```
3a. compute binding_object              (pure)
3b. verifyToken (type, freshness, sig)  (cryptographic; rejects bad signatures BEFORE
                                         touching the nonce store)
3c. verifyBinding (hash compare)        (rejects bad bindings BEFORE the nonce store)
3d. checkAndConsume (atomic single-use) (the nonce burn — irreversible)
3e. emit policy.token.consumed          (audit; after the burn)
4.  classifier                          (runs AFTER the nonce burn; see E5)
5.  emitReconstruction                  (the shared validator)
```

The classifier runs AFTER the nonce burn (step 3d). This means a PURE_CITATION refusal STILL burns the agent's token (E5 below). The alternative — run classifier before consume — would let the agent enumerate the classifier without spending tokens, which is exactly the gaming risk open-question O2 calls out. The token is the AGENT IDENTITY GATE; once verified, it's consumed regardless of the classifier outcome.

### R10. Daemon path bypass

If `input.mode === "daemon"`:

- Skip the token verify entirely. Skip the classifier entirely. (The daemon never produces single-parent quotation; aggregator-specific admission gates — group size, diversity, debounce — are the daemon's screening, specified in the behavior tier nodes.)
- Still pass through R2 (parent-existence), R3 (not-excised/orphan), R4 (confidence floor), R8 (idempotency).
- Idempotency key uses S5, NOT S4.
- On accept: emit with `provenance.agent_id` prefixed `daemon:`; `provenance.conversation_id = null`. Append `policy.reconstruct.emitted` with the daemon's agent_id (the audit-join consumer filters by prefix).

### Edge cases (E1–E8)

**E1. Recall_id expired between agent's prior `memory_recall` and the emit call.**
The agent surfaces memories at turn N, the user converses, the agent emits the reconstructed event at turn N+M. If `(now - recall_event.ts) > RECALL_LOG_TTL_SECONDS` (default 24h) → reject with `RECALL_EXPIRED`. The agent should re-recall and re-emit with the fresh recall_id.

**E2. Parent in `surfaced[]` of the recall_id but excised between recall and emit.**
Step R3 catches this: even though the recall_id's snapshot showed the parent as live, by the time the emit call runs the excise has landed. Reject with `PARENT_EXCISED`. No race-window: the recall_id is just a freshness proof for the parent SET, not a guarantee that any individual parent is still live.

**E3. Two agent emissions race on the same conversation_id + parents + content.**
Both compute the same S4 idempotency key. The first wins (appends + emits `policy.reconstruct.emitted`). The second's `checkIdempotent` returns `{ seen: true, prior_memory_id }` and returns `dedupe_action: "rejected_idempotent"`. Both tokens are burned (the token is per-request, not per-row).

**E4. Daemon aggregator runs back-to-back with the same `bucket_key`.**
S5 idempotency catches the duplicate. The second tick returns the prior memory_id without writing. This is the daemon's protection against the watermark daemon over-firing on a slow embedding step.

**E5. PURE_CITATION refusal — token burn semantics.**
The token IS burned (R9 ordering). The audit trail records `policy.token.consumed` AND `policy.reconstruct.refused` with `reason: "pure_citation"`. The agent receives `error: { code: "PURE_CITATION", reason: "..." }`. The hint-event-to-recall question (open question O2 in the node) is RESOLVED as: the recall layer does NOT receive a hint event in v0 (privacy and gaming concerns outweigh the discoverability benefit). The agent can introspect its own error response for the hint.

**E6. Multi-parent with one parent failing the overlap gate.**
The WHOLE emission is rejected (not just the failing parent). The agent has two recovery paths: (a) drop the failing parent and re-emit with a smaller `parents[]`; (b) rewrite `content` to actually use evidence from the failing parent. Both require a fresh recall_id + fresh token. This is the discipline that prevents `derived_from[]` from drifting from "what the content was actually derived from."

**E7. `confirmation_token` field absent on agent path.**
Hard reject at step 2 (payload shape) with `code: TOKEN_REQUIRED`. NO nonce burn (the nonce wasn't presented). The tokenless agent-path schema is explicitly REJECTED by the W4 critic revision (revision_step rationale, binding to thesis.md Principle 7).

**E8. Daemon path emits with `confirmation_token` field present.**
Defensive: the daemon path SHOULD never carry a token (per A5 binding). If a token field is present on a `mode: "daemon"` input → ignore it silently (do not verify, do not consume). Log a structural-anomaly event for operator inspection. This is defense-in-depth against a misconfigured daemon.

---

## Examples

Three worked examples covering the three classifier outcomes plus a daemon-path example, using realistic operator data shapes.

### Example E1 — SINGLE_PARENT_SUMMARIZATION

The user told their agent two days ago: "Send jobs to my SampleBot LX-2 on the wired en5 link, never over Wi-Fi — Wi-Fi is there for firmware updates." That conversation produced a fact:

```jsonc
{
  "id": "fact_01HQ6X3J9Z4M",
  "kind": "fact",
  "content": "SampleBot LX-2 takes jobs over the wired link on interface en5. Wi-Fi is kept for firmware updates and for paired runs with AcmeRaven.",
  "source_refs": [{ "source": "chat-claude-code", "source_msg_id": "...", "consent_basis": "first_party" }],
  "features": { "embedding": [...], "entities": ["SampleBot", "AcmeRaven", "LX-2", "en5", "Wi-Fi"], ... }
}
```

Today's conversation surfaces this fact during a `memory_recall`. The agent then calls:

```jsonc
{
  "tool": "memory_distill_emit_reconstructed",
  "args": {
    "recall_id": "rec_01HRZK9P8M2X",
    "parents": ["fact_01HQ6X3J9Z4M"],
    "content": "Operator's lab setup: LX-2 units receive jobs on the wired link unless told otherwise; Wi-Fi matters only for firmware updates or when both units (SampleBot + AcmeRaven) run as a pair.",
    "scope": "agent_role_scoped",
    "confidence": 0.85,
    "agent_role": "claude-code:lab-debug",
    "confirmation_token": "<base64 daemon-signed JWT>"
  }
}
```

**Trace:**

- Step 3a–3e: token verify passes; binding `{content_hash, parent_set_hash, conversation_id="conv_xyz", scope="agent_role_scoped"}` matches; nonce consumed; `policy.token.consumed` emitted.
- Step 4: classifier runs. `normalized_edit_similarity(content, parent.content) = 0.45` (in (0.3, 0.85]). Cosine = 0.78 (≤ 0.92). Outcome: `SINGLE_PARENT_SUMMARIZATION`.
- Step 5: `emitReconstruction` runs. Parent exists, not excised, consent_basis `first_party` passes the consent walk. Idempotency key = sha256 of {conversation_id, parent_set_hash, content_hash}; no prior match.
- Embedding computed (Gemini RETRIEVAL_DOCUMENT). Entity extraction returns `["SampleBot", "AcmeRaven", "LX-2", "Wi-Fi"]`. No time anchors.
- Row appended:

```jsonc
{
  "id": "rec_01HRZL2A6B1V",
  "ts": "2026-06-18T14:23:01.456Z",
  "kind": "reconstructed",
  "provenance": { "agent_id": "claude-code:conv_xyz", "conversation_id": "conv_xyz", "confidence": 0.85 },
  "content": "Operator's lab setup: LX-2 units receive jobs on the wired link unless told otherwise; Wi-Fi matters only for firmware updates or when both units (SampleBot + AcmeRaven) run as a pair.",
  "derived_from": ["fact_01HQ6X3J9Z4M"],
  "features": { "embedding": [...], "embedding_model_version": "gemini-embedding-001", "entities": ["SampleBot", "AcmeRaven", "LX-2", "Wi-Fi"], "time_anchors": [] }
}
```

- `policy.reconstruct.emitted` audit event written.
- Tool returns `{ ok: true, memory_id: "rec_01HRZL2A6B1V", classifier_outcome: "SINGLE_PARENT_SUMMARIZATION" }`.

### Example E2 — MULTI_PARENT_CORROBORATIVE

The user keeps notes on a side project, a neighbourhood seed library; three durable facts came out of them:

```
fact_A: "A seed-lending program has to follow the county agricultural import rules; registering as a nonprofit exchange is one way through."
fact_B: "Working assumption: branch libraries will lend seeds before they lend tools, since seeds carry near-zero return-handling cost."
fact_C: "The seed-library notes are kept under ~/seed-library/ in four folders: research, design, permits, outreach."
```

In a conversation, the agent surfaces all three (a recall_id with `surfaced: [A, B, C]`), then summarizes:

```jsonc
{
  "tool": "memory_distill_emit_reconstructed",
  "args": {
    "recall_id": "rec_01HRZP4Q5W7Y",
    "parents": ["fact_A", "fact_B", "fact_C"],
    "content": "The seed-library project stands on three legs: rules (county agricultural import rules, with nonprofit exchange registration as a possible route), economics (near-zero return-handling cost is why branch libraries would pick seeds first), and housekeeping (notes under ~/seed-library/ in research / design / permits / outreach folders).",
    "scope": "cross_session",
    "confidence": 0.78,
    "confirmation_token": "<token>"
  }
}
```

**Trace:**

- Token verify passes.
- Classifier: `parents.length === 3` so the multi-parent rule applies.
  - `tf_idf_overlap(content, fact_A.content) = 0.34` (passes 0.15 gate; "county agricultural import rules" and "nonprofit exchange" appear in both).
  - `tf_idf_overlap(content, fact_B.content) = 0.28` (passes; "near-zero return-handling cost", "branch libraries").
  - `tf_idf_overlap(content, fact_C.content) = 0.41` (passes; "seed-library", and the folder names "research", "design", "permits", "outreach").
  - Outcome: `MULTI_PARENT_CORROBORATIVE`.
- `emitReconstruction`: all parents live, consent_basis first_party (the user's own KB), idempotent.
- Embedding + entity extraction.
- Row appended with `derived_from: ["fact_A", "fact_B", "fact_C"]`.
- The derivation graph now has edges from this reconstructed event back to all three; the forgetting-propagation BFS will reach it from any of them.

### Example E3 — PURE_CITATION refusal

The agent surfaces `fact_01HQ6X3J9Z4M` (the SampleBot fact above) and then attempts to emit:

```jsonc
{
  "tool": "memory_distill_emit_reconstructed",
  "args": {
    "recall_id": "rec_01HRZK9P8M2X",
    "parents": ["fact_01HQ6X3J9Z4M"],
    "content": "SampleBot LX-2 takes jobs over the wired link on interface en5; Wi-Fi is kept for firmware updates and paired runs with AcmeRaven.",
    "scope": "conversation_local",
    "confidence": 0.95,
    "confirmation_token": "<token>"
  }
}
```

**Trace:**

- Token verify passes; nonce consumed; `policy.token.consumed` emitted.
- Classifier: `normalized_edit_similarity = 0.97` (the agent's content is the parent with one punctuation mark changed and one word dropped). Exceeds `RECONSTRUCT_CITATION_SIMILARITY_GATE = 0.85`. Outcome: `PURE_CITATION`.
- `policy.reconstruct.refused` emitted with `reason: "pure_citation"`.
- Tool returns `{ ok: false, code: "PURE_CITATION", reason: "edit_similarity 0.97 exceeds gate 0.85; this looks like a quotation, not a reconstruction" }`.
- **Token is burned.** The agent must mint a fresh token to retry. This is the gaming-defense (E5 / R9).

### Example E4 — DAEMON path (thread aggregator)

The watermark daemon's idle-tick path runs `aggregatePendingThreads`. It identifies a chat-thread group:

- `chat_identifier = "iMessage:+15555550101"` (operator + spouse)
- `day_bucket = "2026-06-15"`
- 7 promoted facts in this thread on this day: `[fact_X1, ..., fact_X7]` — all about a weekend trip the user is planning.

Group passes the admission gates (7 ≥ `THREAD_AGGREGATION_MIN_FACTS=3`, all within 24h, no prior emission in the debounce window). Gemini Flash composes a summary:

```
"On 2026-06-15, operator and spouse coordinated a weekend trip to Example Coast: leave Friday after work, stay at Sample Ridge Lodge, hike Placeholder Point Saturday morning, return Sunday evening."
```

Daemon calls:

```ts
emitReconstruction(
  {
    mode: "daemon",
    content: "<summary above>",
    parents: ["fact_X1", "fact_X2", "fact_X3", "fact_X4", "fact_X5", "fact_X6", "fact_X7"],
    conversation_id: null,
    agent_id: "daemon:thread-aggregator",
    confidence: 0.88,                          // Gemini Flash self-report
    aggregator_name: "thread-aggregator",
    bucket_key: "iMessage:+15555550101:2026-06-15"
  },
  ctx
);
```

**Trace:**

- Mode dispatch (R1): daemon. Skip token. Skip classifier.
- R2: all 7 parents exist.
- R3: none excised, none orphaned.
- Consent walk: all source_refs are `consent_basis: "third_party_inferred"` (spouse's messages on the user's device); the consent walk surfaces this — `salience-design.md` allows reconstructed events derived from `third_party_inferred` parents at v0 (the recall-side filters apply the no-verbatim-quoting cap; not the emitter's job).
- Idempotency key (S5) = sha256({domain: "daemon", aggregator_name, bucket_key, content_hash}). No prior match.
- Embedding + entity extraction. Entities: `["Example Coast", "Sample Ridge Lodge", "Placeholder Point"]`. Time anchors: `["2026-06-15"]` plus the weekend dates.
- Row appended with `provenance.agent_id = "daemon:thread-aggregator"`, `provenance.conversation_id = null`.
- `policy.reconstruct.emitted` with `agent_id: "daemon:thread-aggregator"`.

The recall layer can now surface this aggregate when a future conversation lands near "Example Coast" or "weekend trip" — and because `derived_from` carries all 7 parents, excising the trip retroactively (e.g. it was canceled and the user runs `excise`) propagates correctly through the derivation graph.

---

## Invariants

These MUST hold across all implementations. Violations are conformance failures, not opportunities for optimization.

### I1. Single emitter

Both callers — agent-path tool handler and daemon-path aggregators — converge on the SAME `emitReconstruction` function. No code path appends a `kind: "reconstructed"` row except through this function. Direct `fs.appendFile(memoryLedgerPath, ...)` of a reconstructed row from anywhere else in the codebase is a conformance failure. (Grep gate: a test scans the codebase for `"kind":\s*"reconstructed"` and asserts the only appender is `mcp/lib/synthesis/reconstruction-emitter.js`.)

### I2. Parent immutability

A `reconstructed` emission NEVER mutates its parents. No `superseded_by`, no `reframed_by`, no in-place rewrite. The Risk #10 binding (A6) is preserved. Parents stay byte-identical on the ledger after the emission; only the reverseAdj index gains a new descendant edge.

### I3. Four-kind taxonomy preserved

No new ledger `kind` is introduced. The architecture.md §4 enum `{fact, policy, recall, reconstructed}` is closed. Any future "distilled" / "synthesized" / "aggregated" extension MUST be modeled as `reconstructed` with a distinguishing `provenance.agent_id` (e.g. `daemon:project-aggregator`), not a fifth kind. This invariant binds future foundation revisions.

### I4. Provenance auditability

Every `reconstructed` row carries `provenance.agent_id`. Every emission produces a corresponding `policy.reconstruct.emitted` event in `policy-events-YYYY-MM.jsonl`. The audit-join between memory.jsonl and policy-events-YYYY-MM.jsonl is the user's view of "who emitted what." Missing audit events are a conformance failure.

### I5. Forgetting-propagation safety

`reverseAdj` (the index spec'd in `F-SYN-FOUNDATION-derivation-propagation`) MUST include the edges from every `reconstructed` event's `derived_from[]` entries. If a parent is excised, the forward BFS reaches this event and flags it. The emitter's R3 check ensures we never EMIT a row with an already-excised parent; the index update on accept ensures we propagate FUTURE excises correctly. Both halves of the invariant must hold.

### I6. Token discipline preserved on agent path

`memory_distill_emit_reconstructed` MUST require `confirmation_token`. The binding hash MUST include `{content_hash, parent_set_hash, conversation_id, scope}`. The nonce consume MUST be atomic and single-use. The screening sequence ordering (R9) is normative. No tokenless agent-path schema variant is permitted. This invariant is the load-bearing reconciliation of the W4 critic revision.

### I7. Daemon path token-free

The daemon path MUST NOT mint, sign, verify, or consume confirmation tokens. The watermark daemon MUST NOT hold the signing key. If the implementation grows a "daemon mints its own token" path, that is a conformance failure and a regression to the Phase-1 supervisor architecture that R32 retired. The cascade's `promoteSourceRow` is the binding precedent (A5).

### I8. Idempotency monotonicity

Once an emission for a given idempotency key (S4 or S5) succeeds, subsequent emissions with the same key return the prior `memory_id` and DO NOT append a new row. There is no "force re-emit" tool. Manual re-emission requires a different conversation_id (agent path) or different bucket_key (daemon path).

### I9. Classifier purity

`classifyReconstruction` is a pure function over `{content, parents}` plus an optional embedding lookup. It does NOT consult the ledger directly. It does NOT cache between calls (the index cache is the caller's job). This makes the classifier unit-testable with synthetic fixtures and replay-stable when CAPS knobs change.

### I10. No retroactive valence

`reconstructed.features` does NOT carry `valence`. If a future foundation revision wants reconstructed events to participate in valence-weighted recall, that revision MUST extend the architecture.md §4 schema FIRST (and update this spec's S1). The current invariant pins the v0 choice.

---

## Open questions

These are explicit, material questions the spec does NOT resolve. Carried forward as wave-N tasks. Numbering matches the node's `open_questions` field where applicable.

### O1. Calibration path for the CAPS thresholds

`RECONSTRUCT_MIN_CONFIDENCE = 0.6`, `RECONSTRUCT_CITATION_SIMILARITY_GATE = 0.85`, `RECONSTRUCT_PARAPHRASE_COSINE_GATE = 0.92`, `RECONSTRUCT_MULTI_PARENT_PER_PARENT_OVERLAP_GATE = 0.15` are all initial guesses. None has a held-out evaluation behind it. The calibration path:

1. Phase 1 ships with these defaults + structured logging of every classifier decision (`policy.reconstruct.emitted` + `policy.reconstruct.refused` carry the metrics).
2. After ~2 weeks of use, the user labels ~50 emissions and ~50 refusals (`emit_was_correct: bool`, `refuse_was_correct: bool`).
3. The dashboard surfaces per-CAPS sensitivity (move the gate by ±0.05, count flips).
4. Operator updates the CAPS knob.

Resolution wave: O1.

### O2. Should refusals leak a hint event to the recall layer?

The B2 trigger policy (covered by `F-SYN-BEHAVIOR-recall-time-hint`) asks: when a recall looks summarization-shaped, should the recall brief annotate "consider emitting a reconstructed event"? Pro: discoverability — the agent may not know the tool exists. Con: biases the agent toward over-emission AND leaks the classifier logic, letting a sophisticated agent game the gate.

This spec resolves the SUB-question (does a PURE_CITATION refusal leak a hint? E5) as NO. The broader question (does the recall brief annotate?) is deferred to F-SYN-BEHAVIOR-recall-time-hint. Resolution wave: O2.

### O3. Valence on reconstructed events

Already decided by architecture.md §4 (see I10). Listed here for traceability — this is the answer pinned in this spec, not a question left open. The node's open_questions field originally listed this as open; the W4 review correctly answered it. Constrains `F-SYN-FOUNDATION-valence-provenance`.

### O4. Daemon aggregator admission gates

The behavior-tier nodes (`F-SYN-BEHAVIOR-thread-aggregation`, `F-SYN-BEHAVIOR-project-aggregation`) own the group-size + diversity + dedupe admission gates. This foundation spec specifies only the SHARED contract (parent-exists, not-excised, consent walk, idempotence, feature population). The actual aggregator semantics — what counts as a "thread", what counts as "diversity", debounce intervals — are wave-N tasks for the behavior tier.

### O5. Semantic-hash extension to the idempotency key

Acknowledged in R8 and review issue MINOR-5. The v0 key uses byte-level `content_hash`. A one-character edit slips past. The wave-N task is to add a PQ-bucket `sem_hash` to the key and instrument the dedupe rate. Risk: false-positive dedup on semantically-close-but-distinct re-emissions.

### O6. Embedding model upgrade handling

`features.embedding_model_version` is stamped per emission. When the embedding model upgrades (open-problems.md #7), reconstructed events accumulated under the old model coexist with new ones. The recall layer's per-model-version index already handles this for facts; reconstructed events inherit the same discipline. No additional work specified here, but flagging for the cross-tier review.

### O7. Manual emission

Should there be an `operator:manual` agent_id, callable from a privileged CLI, for forensic re-emission (e.g. after a corrupt-tail truncation of a prior reconstructed row)? Not in v0 — current `memory_distill_promote_fact` precedent shows the screened MCP tool can be used by operators. Reserve the agent_id pattern; do not implement the CLI.

---

## Cross-tier impact

This foundation spec constrains the following other nodes. Each constraint is explicit; downstream nodes MUST honor or invoke a revision-step procedure.

### Substrate tier — `F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER`

OWNED HERE. This spec IS that substrate node's contract. The substrate node MUST:

- Implement `emitReconstruction(input, ctx)` exactly as specified in M1.
- Conform to the screen order (R2 → R3 → consent → idempotency → embed → features → assemble → append → indices → audit).
- Use the idempotency keys from S4 and S5; dispatch on `input.mode`.
- Emit `policy.reconstruct.emitted` on accept; `policy.reconstruct.refused` on reject.
- Append the row to `<data root>/ledgers/memory.jsonl` via the existing fsync-then-dir-fsync discipline (mirroring `promote-fact`'s round-15 H3 discipline — line `appendFactRow` + `fsyncSync` + parent dir fsync).

### Integration tier — `F-SYN-INTEGRATION-RECONSTRUCTED-MCP-TOOL`

OWNED THERE. That node MUST:

- Register `memory_distill_emit_reconstructed` in `mcp/lib/tools/distill-emit-reconstructed.js`.
- Implement the 5-step handler exactly per M2 / R9.
- Reject `TOKEN_REQUIRED` at payload-shape step (E7).
- Mirror `distill-promote-fact.js`'s error-envelope handling and policy-event emission.
- Document the token-mint flow (the user's supervisor process mints the token; the agent is given a fresh nonce-bound token per emit attempt; same UX as promote-fact).

### Behavior tier — `F-SYN-BEHAVIOR-thread-aggregation` and `F-SYN-BEHAVIOR-project-aggregation`

OWNED THERE. Those nodes MUST:

- Implement `aggregatePendingThreads({now})` and `aggregatePendingProjects({now})`.
- Call `emitReconstruction({mode: "daemon", ...})` directly — NOT through any MCP tool.
- Build `bucket_key` per the patterns in S5 ("chat:<chat_identifier>:day:<YYYY-MM-DD>", "repo:<repo_root>:author:<email>:week:<isoweek>").
- Enforce their own admission gates (`THREAD_AGGREGATION_MIN_FACTS`, `THREAD_AGGREGATION_MAX_DURATION_HOURS`, `THREAD_AGGREGATION_DEBOUNCE_MINUTES`, `PROJECT_AGGREGATION_MIN_COMMITS`, `PROJECT_AGGREGATION_MIN_DIVERSITY`, `PROJECT_AGGREGATION_DEBOUNCE_MINUTES`) BEFORE calling the emitter.
- NOT mint or consume confirmation tokens (A5, I7).
- Compose `content` via Gemini Flash (the model choice is fixed; the prompt template is owned by the behavior tier).
- Wire the call site into `daemons/watermark.js`'s idle-tick path, gated by `CAPS.PROMOTE_IDLE_TICK_SECONDS`.

### Foundation tier — `F-SYN-FOUNDATION-derivation-propagation` (blocks)

This spec BLOCKS that node. The propagation node needs:

- The trigger taxonomy specified here (otherwise propagation rules have nothing to attach to).
- The invariant I5 (reverseAdj includes reconstructed events' edges).
- The schema S1 (so the propagation BFS knows what to walk).

The propagation node, in turn, will specify:

- The `derivation_policy` choice (`drop` / `re_derive_without` / `retain`) for reconstructed events when an ancestor is excised.
- The depth-cap discipline (already mentioned in `mcp/lib/recall/hard-gates.js`'s `CAPS.MAX_DERIVATION_DEPTH = 16`).

### Foundation tier — `F-SYN-FOUNDATION-valence-provenance`

CONSTRAINED. Per I10, reconstructed events at v0 carry NO valence. The valence-provenance node MUST either:

- Honor the exclusion (reconstructed events are excluded from valence-weighted recall), OR
- Revise architecture.md §4 FIRST, then update this spec's S1, before adding valence to reconstructed.

### Recall tier — recall-side filters (`mcp/lib/recall/hard-gates.js` and ranking)

CONSTRAINED. The recall layer MUST:

- Treat `reconstructed` events as first-class candidates (same as facts) — they participate in the multi-feature scoring.
- Read `provenance.agent_id` to filter daemon-emitted vs agent-emitted (operator may want to weight differently; CAPS knob TBD by recall tier).
- Respect `scope` (`conversation_local` / `agent_role_scoped` / `cross_session`) — multiply the score by a scope-match factor (1.0 if the current `surrounding_context` matches the scope, 0.5 if scope is narrower than current, etc.). Exact factors are recall-tier CAPS (deferred).

### Policy-events audit consumer

CONSTRAINED. The audit-join tool (`memory_health` or a future replay-set builder) MUST recognize:

- `policy.reconstruct.emitted` (new kind; one producer = `emitReconstruction`)
- `policy.reconstruct.refused` (new kind; one producer = `distill-emit-reconstructed.js` handler — only on the agent path)

These additions to the policy-events kind table (agent-integration.md § Token-event ownership) MUST be reflected in the canonical table; this spec is the cross-link warrant for that update.

---

## Appendix: implementation file layout

```
mcp/lib/synthesis/
  reconstruction-emitter.js     # M1 — shared validator+appender
  classifier.js                 # M3 — three-class classifier
  idempotency.js                # M4 — S4/S5 keys + lookup
  thread-aggregator.js          # M5 — owned by F-SYN-BEHAVIOR-thread-aggregation
  project-aggregator.js         # M5 — owned by F-SYN-BEHAVIOR-project-aggregation

mcp/lib/tools/
  distill-emit-reconstructed.js # M2 — agent-path MCP tool handler

daemons/
  watermark.js                  # wire tickReconstructionAggregators into idle tick

mcp/lib/validation.js           # add CAPS knobs from S6

mcp/docs/specs/synthesis/
  reconstructed-trigger.md      # this spec
```

All new files are net-new in v0. The existing `mcp/lib/tools/distill-promote-fact.js` is the reference implementation pattern; the new tool's screening sequence (R9) MUST mirror that file's handler-step ordering byte-for-byte.

