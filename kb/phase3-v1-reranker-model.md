# Phase 3 v1 — Layer-3 Listwise Reranker Model Resolution

**Status:** RESOLVED 2026-06-02 (Phase A · flash-model-audit).
**Authoritative for:** Layer-3 reranker model tag in `mcp/lib/recall/*` v1 code paths.
**Spec link:** `kb/research-retrieval-frontiers.md` § "Phase 3 v1 — Instruction-following reranker"
and § "Recommended Phase 3 architecture > Layer 3 — Reranker".
**Cross-link:** `mcp/lib/validation.js` CAPS constants `GEMINI_FLASH_MODEL_DEFAULT`,
`GEMINI_FLASH_PINNED_SNAPSHOT`.

## Decision

**Model:** `gemini-2.5-flash` (the stable alias).

**Pinning approach:** Use the stable alias `gemini-2.5-flash` as the runtime
default in `CAPS.GEMINI_FLASH_MODEL_DEFAULT`. **Do NOT** swap in `gemini-flash-latest`
or any `-preview-` snapshot for production. The stable alias is itself the pinned
identifier in Google's current discipline — its `version: "001"` field is exposed
on the live `models/{name}` endpoint and remains constant for that alias. New
generations (3.x, 3.5) get their own tags; they do not silently replace 2.5-flash.

**Snapshot field:** `CAPS.GEMINI_FLASH_PINNED_SNAPSHOT = "gemini-2.5-flash"`
(no separate dated tag exists on v1beta as of 2026-06-02 — the empirical probes
of `gemini-2.5-flash-09-2025`, `gemini-2.5-flash-preview-09-2025`,
`gemini-2.5-flash-001` all returned HTTP 404). The constant exists as a forward
seam: when Google publishes a dated snapshot for 2.5-flash (analogous to how
`gemini-embedding-001` carries its version inline), this CAPS field gets the
dated tag and the embedding event records both at promote / rerank time.

**Why not flash-lite:** flash-lite is ~40% faster (median 769ms vs 1205ms in
the empirical measurement below) but the reranker is a *correctness* layer
sitting after hard gates — it encodes the policy string declaratively
(`agent_role`, time, prefer-entity-overlap, dampen `third_party_inferred`,
demote `derivation_orphan`, avoid paraphrases of `recent_turns[]`). The
spec (§ Risks #8) names instruction-following as the bottleneck; flash-lite
has a smaller reasoning budget and weaker instruction adherence. We accept
the 436ms p50 delta at v1 launch and re-A/B against flash-lite in v2 against
the logged recall corpus per the spec's "A/B on logged events, not benchmarks"
discipline (§ Layer 3, Risks #8 DOWNGRADE).

**Why not flash-latest:** `gemini-flash-latest` rolls forward with a 2-week
deprecation notice — `kb/research-retrieval-frontiers.md` § Risks #3 makes
silent model-change a CI-tripping invariant (the 001 task-type asymmetry margin
is the canary). Auto-rollover to a model that breaks the listwise-output
contract surfaces only when CI fails at 03:00 with a red alarm. The stable
alias avoids that class of surprise; new generations require an explicit
config change + A/B gate.

## Rationale (sources)

1. **`https://ai.google.dev/gemini-api/docs/models`** — canonical model card.
   Lists `gemini-2.5-flash` and `gemini-2.5-flash-lite` as stable. The 2.5-flash
   card text: *"Our best price-performance model for low-latency, high-volume
   tasks that require reasoning."* — the "requires reasoning" framing is the
   instruction-following hint that pushed us off flash-lite at v1.
2. **Live `models/gemini-2.5-flash`** — `version: "001"`, methods include
   `generateContent`, input 1,048,576 / output 65,536 tokens. The version field
   IS the snapshot pinning surface today.
3. **`https://developers.googleblog.com/en/continuing-to-bring-you-our-latest-models-with-an-improved-gemini-2-5-flash-and-flash-lite-release/`**
   — Google's own framing: "for users prioritizing stability over early access
   to features, continue to use the existing stable versions: `gemini-2.5-flash`
   and `gemini-2.5-flash-lite`." Direct alignment with our pinning discipline.
4. **`https://ai.google.dev/gemini-api/docs/structured-output`** — confirms
   `responseMimeType: "application/json"` + `responseSchema` is GA on 2.5-flash;
   empirically verified below.
5. **`https://blog.google/technology/developers/gemini-api-structured-outputs/`**
   — JSON Schema support GA'd for "all actively supported Gemini models"; the
   reranker's strict `{ranking: string[]}` contract is enforceable, not
   text-out + parse.

## Cost + latency table

Latencies are median-of-3 (warmup discarded) over a representative listwise
rerank call: 94 input tokens (system instruction + 3 candidate snippets), JSON
output. Measured 2026-06-02 against `v1beta` from this machine.
`thinkingConfig.thinkingBudget = 0` set in the request — without it, 2.5-flash
spends ~95 reasoning tokens and ~1.9s extra; with `thinkingBudget=0` the model
returns the same answer in ~1.2s on the smoke prompt.

| Model | Stable? | p50 latency (ms) | Input $/1M | Output $/1M | Structured output | Free RPM/TPM/RPD | Tier-1 RPM/TPM |
|---|---|---|---|---|---|---|---|
| `gemini-2.5-flash`        | YES | **1205** | $0.30 | $2.50 | yes (responseSchema) | 10 / 250k / 250 | 300 / 1,000k |
| `gemini-2.5-flash-lite`   | YES | **769**  | $0.10 | $0.40 | yes (responseSchema) | 15 / 250k / 1,000 | 300 / 1,000k |
| `gemini-flash-latest`     | rolling | 1508 | $0.30 | $2.50 | yes | (alias — inherits) | (alias — inherits) |
| `gemini-flash-lite-latest`| rolling | 769  | $0.10 | $0.40 | yes | (alias — inherits) | (alias — inherits) |
| `gemini-3-flash-preview`  | preview | n/m | $0.50 | $3.00 | (not measured) | (preview gating) | (preview gating) |
| `gemini-3.5-flash`        | stable (3.x line) | n/m | $1.50 | $9.00 | (not measured) | n/m | n/m |

At expected steady-state load (~10^3 recalls/day · ~120 input + ~20 output
tokens per rerank — assuming the brief feeds 50 candidates each ≤80 tokens
distilled, plus instruction string), 2.5-flash costs ~`$0.30 · (10^3 ·
6000)/10^6 = $0.0018/day input` + `$2.50 · (10^3 · 20)/10^6 = $0.05/day output`
≈ **$0.05/day**. Below the noise floor for this project. Flash-lite would cut
that to ~$0.008/day at the cost of instruction-following quality. Cost is
**not** the deciding axis at v1; latency and instruction adherence are.

## API URL + request body template

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$GEMINI_API_KEY
Content-Type: application/json
```

Body (the load-bearing shape — copy verbatim into v1 client code):

```json
{
  "contents": [{
    "role": "user",
    "parts": [{
      "text": "<POLICY_INSTRUCTION_STRING>\n\nSURROUNDING_CONTEXT:\n<distilled query + recent_turns + agent_role + time anchor>\n\nCANDIDATES:\n[{\"id\":\"<memory_id>\",\"content\":\"<≤600 char snippet>\"}, ...]"
    }]
  }],
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": {
      "type": "object",
      "properties": {
        "ranking": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["ranking"]
    },
    "temperature": 0.0,
    "maxOutputTokens": 1024,
    "thinkingConfig": { "thinkingBudget": 0 }
  }
}
```

**Notes for the v1 implementation:**
- `responseSchema` with `responseMimeType: application/json` guarantees the
  output parses as `{"ranking": ["mem_id1", "mem_id2", ...]}`. The reranker
  client MAY assert: `JSON.parse(text).ranking` is an array of strings whose
  every element exists in the input candidate id set. Fail closed on mismatch.
- `thinkingBudget: 0` is REQUIRED for p50 < 1.5s. Without it, 2.5-flash
  internally allocates ~95 reasoning tokens that triple end-to-end latency
  with no measured ranking-quality gain on the smoke set.
- `temperature: 0.0` — listwise rerank is deterministic by spec; the
  Plackett-Luce propensity layer (Layer-2 v0) handles exploration, not the
  reranker.
- `maxOutputTokens: 1024` accommodates ~50 candidate ids in the output array
  (worst case: ULID-style ids @ ~28 chars + JSON overhead ≈ 1500 chars ≈ 400
  tokens). Bumping to 1024 leaves headroom for ULID-prefixed memory ids.
- Set `Authorization` via the `?key=` query parameter (matches the existing
  `mcp/lib/gemini-client.js` discipline). Do NOT use OAuth for this surface.

## Integration test (CI canary)

A single canonical-pair test added to `mcp/test/gemini-flash-rerank.test.mjs`
asserts the model is reachable AND that `responseSchema` returns a parseable
`{ranking: [...]}` object. Skip when `GEMINI_API_KEY` is absent (Phase A
asymmetric-margin test follows the same pattern). The test MUST:

1. Read `CAPS.GEMINI_FLASH_MODEL_DEFAULT` from `mcp/lib/validation.js`.
2. POST the canonical body above with a 3-candidate fixed corpus.
3. Assert HTTP 200, `JSON.parse(text).ranking` is an array of strings, the
   array length equals the candidate-set size, and every returned id is a
   member of the input set.
4. Log the median-of-3 latency to stdout for trend-watching but do NOT fail
   on absolute latency (network-flaky CI surfaces would create false alarms).

**This test plays the same role as `test/gemini-client.test.mjs` for embeddings
(L14 invariant: the asymmetric task-type margin is a CI-tripping invariant).**
If a future model swap silently breaks the JSON-ranking contract, this test
fails at PR time, not at recall-time in prod.

## Invariants (do not relax)

1. The stable alias `gemini-2.5-flash` IS the pinned identifier. Do not swap
   to `gemini-flash-latest`, `gemini-flash-latest:001`, or any
   `-preview-XX-2025` tag for production code paths.
2. `responseSchema` is REQUIRED. Text-out + parse violates the v0 contract
   discipline (kb/phase3-v0-contracts.md treats parser fallback as drift).
3. `thinkingBudget: 0` is REQUIRED for the listwise-rerank surface. Reasoning
   tokens triple latency with no measured ranking-quality benefit on the
   spec's "instruction-following matters; reasoning depth less so" framing.
4. The reranker is OUTSIDE the hard-gates loop. Predicate exclusion / consent
   blocking / derivation-orphan masking happen in Layer 2 before any candidate
   reaches the reranker (research-retrieval-frontiers.md § Risks #14). The
   reranker may NEVER override a hard gate.
5. Model identifier and the request body's `generationConfig` hash are logged
   into the `recall_event` so OPE at v3 can detect rank-mix when the model
   changes (research-retrieval-frontiers.md § Phase 3 v3 OPE plan).
