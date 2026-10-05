# Thesis

Seven principles. Everything else follows.

## 1. The ledger is permanent; the memory landscape is a projection

The event ledger is append-only and authoritative. "What the system currently believes" is the output of a function over that ledger, parameterized by the recall context. The landscape does not exist between recalls. Storing a current view is the temptation that erodes everything.

## 2. Relevance is determined at recall time

Two parallel conversations see different memory landscapes from the same ledger and neither is more correct. The recall function takes surrounding context — recent turns, entities, time anchors, agent role, mood signals, calendar state — and produces a bounded brief scored against that context.

## 3. Forgetting is a family of operations

Not one verb. Four core ops after collapse:

- `exclude(predicate, scope)` — hide in matching contexts. Covers tombstone and contextual suppression.
- `replace(old_id, new_event, scope)` — new fact wins the projection where both could surface ("I moved").
- `substitute(target, content_transform)` — rewrite content under provenance ("it wasn't a fight, it was a misunderstanding").
- `excise(target, scope)` — destructive ledger mutation. Privileged, rare.

Plus *decay* — the default. No event, no record.

## 4. Decay is not a per-memory activation score

A memory is "stale" only relative to recall contexts. Something unused for two years can be perfectly live when a conversation lands near it. What erodes is the index's *discrimination* — the likelihood that incoming contexts match cleanly to one memory rather than many.

## 5. Reinforcement is engagement-gated proximity

A memory surfaced in turn 5 enters turn 6's surrounding context, raising its match probability. But raw surfacing is *anti-reinforced* — recently surfaced items are down-weighted to prevent positive-feedback dominance. Reinforcement happens only when the user *engages*: responds, agrees, corrects.

## 6. Provenance threaded everywhere

Every event carries source, time, parties, derivation links. Agent-emitted inferences declare what they were derived from. The derivation graph is what makes forgetting propagation possible — without it, a forgotten fact resurfaces through its derivatives.

## 7. Agents cannot write durably (without going through the screened surface)

The agent has no direct `Write` over the ledger. Mutation goes through a narrow MCP surface that validates, screens, attaches provenance, deduplicates, applies policy. This discipline is what lets the system recover from agent mistakes.

**What the screen buys:** argument binding (privileged tokens bind to specific destructive args), single-use enforcement (consumed-nonce store), audit trail (`policy-events-YYYY-MM.jsonl`), schema validation (fail-shut on unknown fields), consent enforcement at write time (`source_policy.consent_basis`).

**What the screen does NOT buy** — and the spec is honest about this rather than implying it does: on a single-user machine where the agent runs in the same uid as any holder of the daemon signing key, a sufficiently capable agent with `Bash` access CAN read the signing key from `<data root>/policy/distillation-signing-key.json` (mode `0600` is readable by every user-process) and forge valid daemon-signed tokens. The token discipline is a **screening and audit layer**, not a privilege boundary against same-uid attackers. Stronger guarantees — separate uid for the key-holder, Keychain-backed key access, hardware-backed signing — are not implemented.

The promote-fact exception (§ `memory_distill_promote_fact`, the only tool that writes ledger entries on behalf of the user without user-issued tokens) inherits this honest framing: daemon-signed tokens authenticate "the process holding the signing key signed this," not "a non-agent process signed this." The exception is real and load-bearing (`memory_distill_promote_fact` remains as the manual promote path, e.g. for promoting auto-memory `pre_distilled` entries through the screened surface); its security guarantee is "screening + audit," not "agent cannot forge." The row-by-row salience cascade (`watermark.tickSourcesOnce`, see `kb/salience-design.md`) is the live promote path and does not call this tool — see `kb/legacy-archive.md` for the retired conversational pipeline that originally drove it. `memory_put` is a second, narrower exception: a first-party write that needs no token, is off by default on a configured install (`MEMORY_PUT_ENABLED`), and is audited by a `policy.memory.put` event (`mcp-surface.md` § `memory_put`).

The principle "agents cannot write durably" therefore reads: *agents cannot accidentally or carelessly write durably without leaving an audit trail and consuming a single-use token bound to specific arguments.* Deliberate exfiltration of the signing key by a sophisticated same-uid attacker is out of scope for the current threat model; the OS-level separation that would mitigate it is not implemented.

---

See `inheritance.md` for the patterns these principles take from an earlier event-ledger design, and the ones they invert. See `operations.md` for how recall and the forgetting family actually work.
