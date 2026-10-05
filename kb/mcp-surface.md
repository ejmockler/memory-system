# MCP surface

The concrete agent-side tool surface. `architecture.md` § Interface boundaries fixes MCP as the agent ↔ memory protocol; this file fixes the tools.

The server name is `memory`. Every tool is namespaced `memory_*`. Every tool returns the envelope below. The policy tools `memory_exclude` and `memory_rescind_policy` require top-level `conversation_id` and `agent_role`. The other writers do not: `memory_put` requires only `content` and `provenance`, `memory_connectors_revoke` requires only `source`, `memory_distill_promote_fact` carries `conversation_id` inside `provenance`, and `memory_distill_emit_reconstructed` requires `conversation_id` but not `agent_role`. Each tool section lists its required arguments. `ts` is server-stamped, never accepted from the caller.

## Envelope

All tools return:

```
{
  ok: true | false,
  data: { ... } | null,
  error: { code, message, details? } | null,
  meta: { tool, version }
}
```

Defined in `mcp/lib/envelope.js`. One envelope, one error-code enum, no per-tool variation.

## Error codes

```
INVALID_ARGUMENTS    — caller-side shape/cap violation
NOT_FOUND            — id, predicate, connector, quarantine entry, etc.
STATE_CONFLICT       — duplicate, supersession cycle, already-applied policy
SCOPE_BLOCKED        — caller may not invoke this surface in current role
CONSENT_BLOCKED      — source_policy.consent_basis forbids the requested op
PRIVILEGE_REQUIRED   — privileged tool called without confirmation token
INTERNAL_ERROR       — anything else
```

`CONSENT_BLOCKED` and `PRIVILEGE_REQUIRED` are memory-specific; the rest follow the shared envelope pattern in `mcp/lib/envelope.js`. Consent is a write-time check, not a read-time one — see `ingestion.md` § Consent-aware promotion.

## Privilege levels

**Threat model (honest, per `thesis.md` §7 update).** The token discipline below is a **screening and audit layer**, not a privilege boundary against same-uid attackers. On the single-user macOS deployment this release targets, an agent with `Bash` access can read the `0600` signing key, mint a valid daemon-signed token, and call `memory_distill_promote_fact`. The discipline still buys: argument binding (token bound to specific destructive args), single-use enforcement, audit trail in `policy-events-YYYY-MM.jsonl`, schema validation, consent enforcement. It does NOT buy: prevention of forge-by-same-uid-attacker. OS-level privilege separation (separate uid, Keychain-backed key, hardware-backed signing) is not implemented.

**SCOPE_BLOCKED via launch-identity (normative).** stdio MCP servers are per-client subprocesses: Claude Code spawns its own memory MCP instance; a user manually invoking `memory_distill_promote_fact` spawns its own. They do NOT share a stdio pipe, so transport-level caller identification is not available. The mechanism is **launch-time env**: the memory MCP reads `MEMORY_ROLE` at startup (default `"agent"`; a user wanting to call `memory_distill_promote_fact` launches the instance with `MEMORY_ROLE=distillation`). `SCOPE_BLOCKED` fires at step 0 of dispatch — before payload parse, before token verification — when a distillation-only tool is invoked on a server whose `MEMORY_ROLE != "distillation"`. A same-uid attacker can spawn their own server with the env set and bypass this gate, but still needs to read the `0600` signing key to forge a valid token. This is exactly the forge the threat model already concedes — the env gate adds zero new defense against that attacker and provides the *clean* dispatch ordering ("scope before payload") the spec needs. Token verification is NOT the role signal; the env is. The token still binds arguments and enforces single-use after the scope check passes.

Two levels, declared per tool:

- `default` — registered for all agent runtimes; callable without ceremony.
- `privileged` — requires a `confirmation_token` argument. Two token classes exist:
  - **User-issued** for agent-callable privileged operations (today only `memory_exclude` with `scope: "global"`; the planned destructive and control-plane writes in § Planned, not implemented would use the same class). User-issued token issuance is not implemented, so no user-issued token can be minted yet. Minted out-of-band by the user (settings UI, CLI prompt, or signed config) — never by another MCP tool. Payload: `{type: "user", binding_hash, nonce, issued_at, expires_at}`.
  - **Daemon-signed** for `memory_distill_promote_fact` (the preserved manual promote surface). Minted out-of-band (e.g. by the user running `mintToken` from `mcp/lib/daemon-token.js`) from `<data root>/policy/distillation-signing-key.json` — permissions `0600`, `O_NOFOLLOW`, `nlink == 1` (`loadSigningKey` in `mcp/lib/daemon-token.js`). Payload: `{type: "daemon", binding_hash, nonce, issued_at, expires_at}`. The verifier checks `type` first to decide which key to verify against. This is the named §7 exception (`thesis.md`) — see Threat model above for what the exception buys and does not buy. The conversational-pipeline minter that originally drove this surface has been retired; see `kb/legacy-archive.md`.

**Daemon-signed token: signing key + minting.**

The daemon-signed token class is the named §7 exception. Its signing key lives at `<data root>/policy/distillation-signing-key.json`. Same on-disk discipline as the consumed-nonce store: mode `0600`, open with `O_NOFOLLOW`, reject if `nlink != 1` (`loadSigningKey` in `mcp/lib/daemon-token.js`); deviation from the discipline is a conformance failure.

File format (frozen):

```
{
  "version": 1,
  "key_hex": "<64 hex chars>"     // 32 bytes, lowercase hex, no separators
}
```

`version` exists for forward-compatibility with a future key rotation; implementations MUST reject `version != 1` with a startup error and MUST NOT silently fall back. `key_hex` length is exactly 64; the parser rejects shorter, longer, uppercase, or non-hex inputs.

Key lifecycle:

- **First start.** If the file is absent or zero-length, the user (or the test surface in `mcp/lib/daemon-token.js`) generates 32 bytes via `crypto.randomBytes(32)` (Node) or the equivalent OS CSPRNG, hex-encodes lowercase, writes the file with `O_CREAT | O_EXCL | O_WRONLY` and mode `0600`, fsyncs, then re-opens for read using the same `O_NOFOLLOW` + `nlink == 1` checks the verifier uses. Race: two writers starting concurrently — `O_EXCL` resolves it; the loser reads the winner's file.
- **Subsequent starts.** Read existing file; validate `version`, `key_hex` shape, and on-disk discipline. The key is never logged, never returned by any MCP tool, never written to the policy event log.
- **Rotation.** Not implemented; it would be scoped alongside `memory_excise` and the privileged audit channel (§ Planned, not implemented). Until then, the key is generated once and used indefinitely.

Minting (per manual promote call):

1. The minter constructs the `binding_object` per the target tool's row in the Per-tool binding fields table. For `memory_distill_promote_fact` the binding object is `{source_refs_hash, content_hash}`; for the other tools see their rows. The minter and verifier MUST agree on the binding object schema for the tool being minted against — drift here is the same class of bug as the canonical-JSON drift the test vector pins.
2. Compute `binding_hash = sha256(canonical_json(binding_object))` using the same RFC 8785 implementation the verifier uses. The reference implementation at `<checkout>/mcp/lib/validation.js` is the only canonicalization path; minter and verifier share it.
3. Generate a fresh nonce: 16 random bytes via `crypto.randomBytes(16)`, lowercase hex. Per-tick fresh; never reused even within a tick.
4. Compute timestamps: `issued_at = now()` (ISO-8601 with `Z` suffix, millisecond precision); `expires_at = issued_at + DISTILLATION_TOKEN_TTL_SECONDS`. Invariant: `DISTILLATION_TOKEN_TTL_SECONDS <= CONSUMED_NONCE_TTL_SECONDS`. The token's `expires_at` must always fit inside the nonce-store retention window; 300s vs 604800s satisfies this with seven decimal orders of margin.
5. Build the canonical token payload (frozen shape, all drafters share):

   ```
   {
     "type": "daemon",
     "binding_hash": "<sha256 hex>",
     "nonce": "<16-byte hex>",
     "issued_at": "<ISO-8601>",
     "expires_at": "<ISO-8601>"
   }
   ```

6. Sign: `signature = HMAC-SHA256(key, canonical_json(payload))`. The `canonical_json` of the payload uses the same RFC 8785 path as `binding_hash`; bit-identity matters here too (verifier recomputes `canonical_json(payload)` from the decoded token and recomputes the HMAC). **`signature` is the 32-byte raw HMAC-SHA256 output, not hex-encoded** — base64url at step 7 is applied to those 32 raw bytes directly, producing 43 ASCII characters with no padding. Implementations that hex-encode before base64url produce non-conformant tokens.
7. Encode the wire token: `token = base64url(canonical_json(payload)) + "." + base64url(signature)`. The dot-separated `<payload>.<signature>` shape is the wire form; the verifier splits on `.`, base64url-decodes each half (the second half decoded back to 32 raw bytes), recanonicalizes the payload JSON, and verifies the HMAC via constant-time compare on the 32-byte signature buffer. Base64url is per RFC 4648 §5 (no padding).
8. The retired conversational-distillation supervisor emitted a mint event at this step; that event kind is retired (see `kb/legacy-archive.md`). The manual promote path emits only consume/reject entries (steps below).

**Daemon-signed token verification (normative).** Every daemon-signed token consumption runs the same five-step check, in this exact order, before any tool-specific work. Each step is fail-shut; a failure aborts the call and emits one `policy.token.rejected` event with the matching `reason`.

1. **Type and freshness.** Wire-shape malformations (no `.` split, base64url decode failure) reject with reason `"malformed"`. After parse: `payload.type == "daemon"` (mismatch → `"wrong_type"`); `payload.expires_at > now` (→ `"expired"`); `now - payload.issued_at <= DISTILLATION_TOKEN_TTL_SECONDS` (→ `"stale_issue"`); `payload.expires_at <= now + CONSUMED_NONCE_TTL_SECONDS` (→ `"ttl_overrun"`). This step runs FIRST — before signature verification — so that type-routed tokens get a clean `wrong_type` reason rather than a misleading `bad_signature`, and to avoid an HMAC oracle on type-routed tokens.
2. **Signature.** HMAC-SHA256 over `canonical_json(payload)` using the 32-byte key in `<data root>/policy/distillation-signing-key.json`. HMAC mismatch → reason `"bad_signature"`. Constant-time compare (`crypto.timingSafeEqual` after length-equality non-secret check).
3. **Binding.** Recompute `binding_hash = sha256(canonical_json(binding_object))` from the inbound arguments per the tool's binding row. Mismatch → reason `"binding_mismatch"`. The nonce is NOT consumed on binding mismatch — preserves the nonce slot for the legitimate caller.
4. **Nonce single-use.** Open `<data root>/policy/consumed-nonces.jsonl` under the exclusive-lock discipline. Scan for `sha256(payload.nonce)`; if present → reason `"nonce_replayed"`. Otherwise append `{nonce_hash, tool, accepted_at, checksum}` and fsync **before** any tool-specific work.
5. **Tool-specific consent.** For `memory_distill_promote_fact`, after the nonce is durably appended: for each `source_refs[i]`, load the source-ledger row, read `source_policy.consent_basis`, and apply the `ingestion.md § Consent-aware promotion` rules. Any source whose policy forbids promotion → `CONSENT_BLOCKED`. This is where the CONSENT_BLOCKED path fires. Nonce stays consumed; retry requires a fresh token (consent state may have changed; re-binding forces fresh review).

On success, the verifier appends `{kind: "policy.token.consumed", nonce_hash, tool, accepted_at}` to `<data root>/policy/policy-events-YYYY-MM.jsonl` and proceeds with the tool's body. Rejections append `{kind: "policy.token.rejected", nonce_hash_or_null, reason, attempted_at}` to the same log (`nonce_hash` is null when rejection fires before payload parse). The raw token never reaches disk on any path.

Three invariants:

- The raw token never reaches `policy-events-YYYY-MM.jsonl`. Only `sha256(payload.nonce)` (`nonce_hash`).
- The nonce store and the policy-events log are two files for two purposes: the nonce store is the single-use enforcement surface (hot path, exclusive lock); the policy-events log is the auditable timeline (append-only, no read-side concurrency requirement).
- The nonce-store append (step 4) commits before tool-specific work begins (step 5). Atomic check, fail-shut on TTL expiry, no half-applied side-effects.

**Argument binding (canonical rule).** `binding_hash = sha256(canonical_json(binding_object))` where `binding_object` is the **complete set of arguments that determine the operation's scope or destructiveness** — never a single field. Each privileged tool's binding fields are declared in its section. The verifier recomputes `binding_hash` from inbound arguments and rejects with `PRIVILEGE_REQUIRED` when it does not match. A token minted for `{target: A, scope: "memory_ledger_only", silent: false, derivation_policy: "retain"}` cannot be redirected to `{target: A, scope: "include_source_ledgers", silent: true, derivation_policy: "drop"}` — consent is for the verb, not just the noun. Same rule for `memory_quarantine_excise` and the distillation tools.

**Canonical JSON encoding (normative).** `canonical_json(x)` is **RFC 8785 (JSON Canonicalization Scheme / JCS)**. The minter (settings UI, CLI prompt, signed config) and the verifier (memory server) MUST produce bit-identical bytes for the same `binding_object`, or every privileged call silently fails `PRIVILEGE_REQUIRED` with the preimage forbidden from logs. RFC 8785 is summarized for implementers:

- Object keys sorted lexicographically by their UTF-16 code units (NOT byte-wise — JCS specifies code-unit order)
- No whitespace anywhere, no trailing commas
- Strings preserved as-is per RFC 8785 §3.2.2.2; **NFC normalization MUST NOT be applied at canonicalization time** (RFC 8785 leaves Unicode normalization to the caller's data-entry pipeline, not the canonicalizer; applying NFC silently rewrites caller content and breaks bit-identity with non-normalizing implementations)
- Numbers serialized per ECMA-262 `Number.prototype.toString` (IEEE-754 shortest-round-trip; integers without trailing `.0`)
- Arrays preserve insertion order
- `null`, `true`, `false` as literals; no implementation-defined values

Implementers MUST use an existing JCS library, not roll their own (canonicalization edge cases around float exponent ranges and surrogate pairs are subtle). Reference implementations: `cyberphone/json-canonicalization` (JS/Java/Python/Go/.NET) is the canonical test source. The JS reference implementation at `<checkout>/mcp/lib/validation.js` uses the `canonicalize` npm package (cyberphone JS port).

**Test vector** (required to pass; pin in integration tests):

```
binding_object = {
  "target": "mem_01HZX8K9PQRS",
  "scope": "memory_ledger_only",
  "derivation_policy": "retain",
  "silent": false
}

canonical_json bytes (102 bytes):
{"derivation_policy":"retain","scope":"memory_ledger_only","silent":false,"target":"mem_01HZX8K9PQRS"}

sha256 (lowercase hex):
5d6109a311a8ed773135c518c8a5e72bc226d68ef7d592d74c3321a1dc30a17d
```

This hex is **frozen and authoritative**, computed by the reference implementation (`<checkout>/mcp/lib/validation.js` `canonical_json` helper, which delegates to the `canonicalize` npm package + Node `crypto.createHash('sha256')`). Every implementation must match this byte-for-byte; mismatch on this test vector is a conformance failure.

**Non-ASCII conformance probe** (catches NFC-normalization bugs):

```
probe_precomposed = {"target": "Å"}            // U+00C5 LATIN CAPITAL LETTER A WITH RING ABOVE
probe_decomposed  = {"target": "Å"}            // U+0041 + U+030A (A + combining ring above)

canonical_json(probe_precomposed):
{"target":"Å"}                                  // 15 bytes (Å is 2 bytes UTF-8: 0xC3 0x85)
sha256:
568cccda11871a435749f7503e3657bb283794efa33633771813bc2c9e9a9023

canonical_json(probe_decomposed):
{"target":"Å"}                                  // 16 bytes (1-byte A + 2-byte combining ring U+030A: 0xCC 0x8A)
sha256:
ecaa0f3a5eaf4bd3b38de5c2b6284002e2387eb75b208d0638caff0fa4e9e535
```

These two probes MUST produce different sha256 hashes. An implementation that returns the same hash for both is silently NFC-normalizing and is non-conformant per RFC 8785 §3.2.2.2. The reference test at `<checkout>/mcp/test/canonical-json.test.mjs` asserts both probes against their frozen hashes plus the binding_object hash.

`similarity_threshold` for `memory_exclude`'s global binding is a `number` (float). JCS serializes it per ECMA-262 shortest-round-trip. `0.85` canonicalizes to `0.85`; `0.85000000001` canonicalizes to `0.85000000001`. The float comparison happens on the *string* form post-canonicalization — implementations MUST NOT re-parse and re-serialize at the verifier, or single-bit perturbations from arithmetic libraries silently break binding.

Per-tool binding fields:

| Tool | Binding object |
|---|---|
| `memory_excise` *(planned, not registered)* | `{target, scope, derivation_policy, silent}` |
| `memory_quarantine_excise` *(planned, not registered)* | `{quarantine_id}` |
| `memory_quarantine_approve` *(planned, not registered)* | `{quarantine_id, override_reason}` |
| `memory_connector_pause` *(planned, not registered)* | `{source, reason}` |
| `memory_connector_resume` *(planned, not registered)* | `{source}` |
| `memory_exclude` (when `scope: "global"`) | `{recall_id, scope, similarity_threshold, context_entities_hash}` where `context_entities_hash = sha256(canonical_json(sorted(context_entities)))` — entities affect recall-time match (the predicate's OR includes entity tags), so consent must cover them |
| `memory_distill_promote_fact` | `{source_refs_hash, content_hash}` |
| `memory_distill_emit_policy` *(planned, not registered)* | `{kind, triggered_by, payload_hash}` |
| `memory_distill_emit_reconstructed` | `{content_hash, parent_set_hash, conversation_id, scope}` where `content_hash = sha256(content)` over raw UTF-8 bytes and `parent_set_hash = sha256(canonical_json(sorted(parents)))` (`computeBindingObject` in `mcp/lib/synthesis/reconstruction-emitter.js`) |
| `memory_rescind_policy` (when target was privileged-emit) | `{policy_event_id, target_kind}` — `target_kind` is the policy kind of the event being rescinded, server-resolved |

### Consumed-nonce store

The verifier-internal append-only log at `<data root>/policy/consumed-nonces.jsonl` that mediates the single-use property of every confirmation token (both user-issued and daemon-signed). One critical section per privileged call; no agent or hook reaches it directly. Live, together with the daemon-signed token class.

**Line format.** One JSON object per line, no trailing whitespace, `\n`-terminated:

```
{
  "nonce_hash": "<sha256 lowercase hex of token.nonce>",
  "tool": "<MCP tool name, e.g. memory_distill_promote_fact>",
  "accepted_at": "<ISO-8601 UTC, server-stamped>",
  "checksum": "<blake2b512 truncated to 16 bytes, lowercase hex (32 hex chars), of canonical_json({nonce_hash, tool, accepted_at})>"
}
```

`nonce_hash` not raw nonce: the raw nonce never reaches disk after consumption. `tool` is the resolved MCP tool name the token was actually consumed against, not whatever the caller claimed — the verifier resolves it before append. `accepted_at` is server-stamped and monotonic per file (the lock guarantees this). `checksum` is **`blake2b512(canonical_json({nonce_hash, tool, accepted_at}))` truncated to the first 16 bytes, lowercase hex** (32 hex characters), where `canonical_json` is the same RFC 8785 implementation specified above — no second canonicalization library.

**Why "blake2b512 truncated to 16 bytes" and not "blake2b-128".** BLAKE2 folds the configured digest length into its IV; a native `blake2b-128` (i.e. BLAKE2b configured with `digest_length=16`) is NOT the same value as `blake2b512` truncated to 16 bytes. The spec used to say "blake2b-128" but the Node reference implementation (`crypto.createHash('blake2b512')`) produces the 64-byte digest and slices the first 16. The two would silently produce different checksums for the same input — a conformance trap. The spec is **frozen at "blake2b512 truncated to 16 bytes"** to match the reference implementation; "blake2b-128" as a phrase is **deleted from the spec** everywhere it appears.

The choice of truncated blake2b512 over truncated sha256 is performance: nonce-store appends are on the hot path of every privileged call, and BLAKE2b is meaningfully faster than SHA-256 on the small inputs involved. Collision resistance is not the threat model; corruption detection is. 16 bytes is 128 bits, ample for a per-line corruption sentinel.

**Atomicity (the critical section).** The verifier opens the data file `O_RDWR | O_APPEND | O_NOFOLLOW`, acquires the exclusive lock via the sidecar `consumed-nonces.lock` (atomic `O_CREAT | O_EXCL | O_NOFOLLOW` create + `fstat(fd).nlink === 1` post-open check; see § acquireExclusiveLockFile lock-discipline below and `mcp/lib/nonce-store.js`), then performs the entire read-scan-then-append sequence under the lock. The sidecar `O_EXCL` + `nlink` discipline matches what ships (Node has no first-class `flock(2)`); the macOS-only deployment target accepts either pattern at the POSIX level, but the spec and tests are pinned to the sidecar pattern so conformance is verifiable byte-for-byte against the reference implementation.

1. `lseek` to start; scan line-by-line; for each line verify `checksum`; compare `nonce_hash` against the candidate nonce's hash.
2. If a match is found within `CONSUMED_NONCE_TTL_SECONDS` window: release lock, return `PRIVILEGE_REQUIRED` with `details.reason: "nonce_replayed"`. (Replay defense.)
3. If no match: construct the new line, `fsync` the append, release lock, return success.

Concurrent privileged calls serialize on this lock. The lock spans scan *and* append because a check-then-act with a gap is the classic replay window.

**Stale-lock recovery.** A separate sidecar file `<data root>/policy/consumed-nonces.lock` records the lock holder's PID and an mtime-refreshing heartbeat. (Filename matches the frozen SYMBOL_CONTRACT path used by `mcp/lib/nonce-store.js`; the earlier draft naming `consumed-nonces.jsonl.lock` was retired to keep the spec and code byte-identical.) On daemon startup or after a hung-lock detection:

1. Read the sidecar; if absent, proceed to acquire normally.
2. If the recorded PID is non-live (no `/proc/<pid>` on Linux, `kill -0` ENOENT on macOS) AND the sidecar's mtime is older than `STALE_LOCK_RECOVERY_SECONDS` (60s), reclaim: delete the sidecar, retry lock acquisition.
3. If the recorded PID is live, wait with bounded backoff up to `STALE_LOCK_RECOVERY_SECONDS`, then escalate via `memory_health.health_notes`.

Daemons MUST update the sidecar's mtime at least every `STALE_LOCK_RECOVERY_SECONDS / 2` while holding the lock — the heartbeat distinguishes a long-but-live critical section from a stuck owner.

**TTL pruning (compaction sweeper).** A background sweeper rewrites the file dropping entries with `accepted_at < now - CONSUMED_NONCE_TTL_SECONDS`. Runs:

- Once at daemon startup, after corrupt-tail recovery, before the daemon begins minting tokens.
- Once per hour during idle (no token traffic in the past `STALE_LOCK_RECOVERY_SECONDS`).
- Never during active token traffic — the sweeper acquires the same `consumed-nonces.lock` sidecar (per § acquireExclusiveLockFile) and would starve verification under load.

The sweep is copy-and-rename: read all live entries, write to `consumed-nonces.jsonl.tmp` in the same directory, `fsync`, `rename(2)` atomically over the original. The verifier's open file descriptor must be re-opened after rename — detect via stat-comparing `st_ino` before each critical section. Truncate-and-rewrite was rejected because a crash mid-truncate destroys the entire nonce history, opening a replay window for every unexpired token.

The TTL pairs with the token-issuance rule: `token.expires_at <= now + CONSUMED_NONCE_TTL_SECONDS`. A token whose `expires_at` falls beyond the TTL is rejected at mint time, not at verify time, so pruning cannot orphan a valid token.

**Corrupt-tail handling.** On startup, the verifier scans end-to-end and validates `checksum` on every line. The first line whose checksum mismatches its body terminates valid history: the file is truncated to the byte offset just before that line, the pre-truncation contents are preserved, an event of kind `policy.token.rejected` with `reason: "corrupt_tail_truncated"` and `nonce_hash_or_null: null` is appended to `policy-events-YYYY-MM.jsonl`, and the daemon proceeds. Torn writes cannot fail open — a half-written nonce entry must be treated as never consumed, not as silently consumed.

**Mid-file corruption (not the tail) is a distinct failure.** If a checksum mismatch is followed by valid checksums on subsequent lines, the file has been tampered with or has suffered storage corruption beyond the torn-write model. The daemon refuses to mint new tokens, emits a `policy.token.rejected` event with `reason: "nonce_store_corrupted"`, surfaces a notification via `memory_health.health_notes`, and waits for manual intervention. There is no automated recovery from mid-file corruption.

**First-start recovery.** If the file is missing on first start, create it empty (`open` with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0600`). If creation fails because the file appeared between the check and the create, fall through to the normal open path.

**Verification is atomic; nonce is consumed on attempt at step 4 (before consent).** The full check-then-mark sequence runs under the lock. Steps 1 (type/freshness), 2 (signature), and 3 (binding) are pre-consumption checks: failure of any of them leaves the nonce **not** appended. Step 4 (nonce single-use) appends to the consumed-nonce store under the `consumed-nonces.lock` sidecar (per § acquireExclusiveLockFile) and fsyncs **before** step 5 (tool-specific consent) runs. **On `CONSENT_BLOCKED` (step 5 failure), the nonce STAYS consumed** — preventing replay of a denied request. Retry requires a freshly minted token, which forces fresh review of consent state (consent state may have changed between calls).

Rationale: consumed-on-attempt-at-step-4 is the only viable order under a single critical section. Consumed-iff-committed would require nested locking across the MCP handler's nonce-store lock and the memory-ledger append lock, opening a deadlock surface and a TOCTOU window between consent check and ledger write. The five-step ordering in § Privilege levels → Daemon-signed token verification is the single normative truth; this paragraph is the operational consequence.

**Logging.** Token consume / reject events stream to `<data root>/policy/policy-events-YYYY-MM.jsonl`:

```
<data root>/policy/policy-events-YYYY-MM.jsonl
  {kind: "policy.token.consumed", nonce_hash, tool, accepted_at, checksum}
  {kind: "policy.token.rejected", nonce_hash_or_null, reason, attempted_at, checksum}
```

(The mint-time event kind that the retired conversational-distillation supervisor wrote at trigger time was retired with it; see `kb/legacy-archive.md`. The manual mint path does not write a mint event — only the verifier-side consume/reject pair is durable.)

`checksum` is **`blake2b512(canonical_json(event_without_checksum))` truncated to the first 16 bytes, lowercase hex** (32 hex characters) — same engine and discipline as the consumed-nonce store; see § Consumed-nonce store → "Why blake2b512 truncated to 16 bytes and not blake2b-128". The audit log is multi-writer (the MCP handler and the watermark daemon append concurrently) so every append acquires the sidecar `<data root>/policy/policy-events.lock` via the **acquireExclusiveLockFile** discipline (`architecture.md § acquireExclusiveLockFile`) for the duration of write + fsync. Without the lock, two concurrent appends can interleave bytes mid-line; without the per-line checksum, a torn write (kernel crash, drive yank) cannot be distinguished from a valid line.

Reason vocabulary for rejections: `"malformed"`, `"bad_signature"`, `"wrong_type"`, `"expired"`, `"stale_issue"`, `"ttl_overrun"`, `"binding_mismatch"`, `"nonce_replayed"`, plus the nonce-store operational reasons `"corrupt_tail_truncated"` and `"nonce_store_corrupted"`, plus the policy-events operational reason `"policy_events_corrupt_tail_truncated"`, all surfaced via `memory_health.health_notes`. Never the raw token, never the `binding_hash` preimage. The raw token never reaches disk after consumption.

**Rotation.** The policy-events log is monthly-rotated: the active file is `<data root>/policy/policy-events-YYYY-MM.jsonl` keyed on the writer's local-timezone month-of-write. At month boundaries the verifier opens the new file on next-event-write; old months stay on disk indefinitely as audit history. **Corrupt-tail handling mirrors the consumed-nonce store:** on startup-scan, the first line whose `checksum` fails its body becomes the corrupt-tail boundary; the file is truncated to that byte offset (write-tmp+rename to preserve forensics) and a follow-on `{kind: "policy.token.rejected", reason: "policy_events_corrupt_tail_truncated", nonce_hash_or_null: null, attempted_at}` event is appended to the new (post-truncation) file. Mid-file corruption (a checksum failure followed by valid checksums) halts the writer with `health_notes` escalation; there is no automatic recovery. The rotation boundary itself is safe: the writer re-derives the active path inside the `policy-events.lock` critical section, so a month-boundary append during the rotation event is observed atomically. Implementation: `memory_health` reports `policy_events_active_file` and `policy_events_disk_bytes` (sum across all rotated files); manual offline archival of older files is fine (no daemon reads them after rotation).

Privileged tools registered today: the two distillation-only write tools, `memory_distill_promote_fact` and `memory_distill_emit_reconstructed`, plus `memory_exclude` when `scope: "global"`. The other privileged tools this design names are not registered; see § Planned, not implemented.

## Promotion overview

Promotion to the memory ledger happens through two paths:

- **Row-by-row salience cascade** (in-process, live). The watermark daemon's `tickSourcesOnce` walks each `storage/sources/<src>.jsonl` past the per-source cursor and runs Stage-0 dispatch -> Stage-1 score -> Stage-2 embed+kNN -> CORROBORATE / PROMOTE / EMBED_DEFERRED / DROP. On PROMOTE the daemon calls `promoteSourceRow` directly. No batch file, no LLM-summarisation, no token-mint at trigger time. Full design in `kb/salience-design.md`.
- **`memory_distill_promote_fact` MCP tool** (manual). The named §7 exception (`thesis.md`). The user manually mints a daemon-signed token from `<data root>/policy/distillation-signing-key.json` and calls the tool through an MCP client whose memory-server instance was launched with `MEMORY_ROLE=distillation`. Useful for promoting auto-memory `pre_distilled` entries that pre-dated the cascade or for a manual recovery promote.

The conversational-distillation pipeline (a long-lived process watching a per-batch queue directory, claiming batches via atomic rename, minting tokens at trigger time, calling `memory_distill_promote_fact` from a spawned MCP child) is retired; see `kb/legacy-archive.md`. The on-disk artifacts (the queue directory, the per-conversation watermark state file, the launchd plist) are gone. The retired `policy.*` event kinds emitted by the conversational-pipeline watermark are listed in `kb/legacy-archive.md`.

Token verification, the consumed-nonce store, and the policy-events audit log all stay live — they back both the manual `memory_distill_promote_fact` path and `memory_distill_emit_reconstructed`, and would back the planned agent-callable privileged tools (§ Planned, not implemented) if they ship.

**Schema cross-links (AUTHORITATIVE in `agent-integration.md`).** Per-source watermark state shape lives in `agent-integration.md § Watermark daemon`. The token-event producer ownership table is in `agent-integration.md § Token-event ownership table (AUTHORITATIVE)`.

SCOPE_BLOCKED and CONSENT_BLOCKED both stay reachable: any in-conversation caller hitting `memory_distill_promote_fact` (or any other distillation-only tool) gets SCOPE_BLOCKED before payload validation; any source whose `consent_basis` forbids promotion gets CONSENT_BLOCKED after nonce consumption.

The auto-memory bridge (`agent-integration.md § Bridging Claude Code's auto-memory`) remains a legitimate caller of `memory_distill_promote_fact` — promoting `pre_distilled` entries from `storage/sources/auto-memory.jsonl` with `provenance.confidence: "pre_distilled"`.

## Caps

Hard server-side caps on recall briefs and on every write payload. The caller may request smaller; the server never exceeds these.

```
RECALL_MAX_ITEMS                = 12
RECALL_MAX_CHARS                = 4000
RECALL_PER_MEMORY_CONTENT_CHARS = 600
RECALL_LOG_TTL_SECONDS          = 86400      // predicate creation from older recalls rejected
PREDICATE_MAX_ENTITIES          = 32
PREDICATE_MAX_EMBEDDING_DIMS    = 1536
PREDICATE_MAX_ACTIVE            = 1024       // hard cap; rescind to make room; a dedicated predicate index is future work
REPLACE_NEW_EVENT_CONTENT_CHARS = 4000
SUBSTITUTE_TRANSFORM_CHARS      = 4000
CONTENT_MAX_CHARS               = 16384      // memory_distill_promote_fact.content + memory_distill_emit_reconstructed.content cap; 16384 chosen to match worst-case distilled-fact length observed in early dogfooding; 4000 was an initial estimate. Larger than recall/replace because a distillation caller may consolidate multi-row content into a single fact; no security rationale for a smaller cap.
DERIVATION_WALK_MAX_DEPTH       = 6
DERIVATION_WALK_MAX_NODES       = 64
EXCISE_REDERIVE_MAX_NODES       = 64         // cascade cap; over-cap returns job_id
CONSUMED_NONCE_TTL_SECONDS      = 604800     // 7 days; bounds nonce-store retention
STALE_LOCK_RECOVERY_SECONDS     = 60         // lock with non-live PID + mtime > this is reclaimed
DISTILLATION_TOKEN_TTL_SECONDS  = 300        // 5 min; daemon-signed token lifetime for manual memory_distill_promote_fact calls; invariant <= CONSUMED_NONCE_TTL_SECONDS
// (The conversational pipeline's idle-watermark and batch-cap caps are retired; see kb/legacy-archive.md.)
LIST_PREDICATES_MAX_ITEMS       = 100
LIST_QUARANTINE_MAX_ITEMS       = 50
LIST_CONNECTORS_MAX_ITEMS       = 32
```

Oversized fields are rejected with `INVALID_ARGUMENTS`. Field names use the vocabulary already established in `operations.md` (`surrounding_context`, `recall_id`, `derivation_chain`, etc.).

---

## Tool index

| Tool | Privilege |
|---|---|
| `memory_recall` | default |
| `memory_put` | default † |
| `memory_exclude` | default \* |
| `memory_rescind_policy` | default |
| `memory_get` | default |
| `memory_get_predicate` | default |
| `memory_list_predicates` | default |
| `memory_connectors_list` | default |
| `memory_connectors_revoke` | default |
| `memory_health` | default |
| `memory_catchup` | default |
| `memory_catchup_feedback` | default |
| `memory_distill_promote_fact` | privileged |
| `memory_distill_emit_reconstructed` | privileged |

\* `memory_exclude` is `default` for scoped exclusions. `scope: "global"` requires a user-issued confirmation token (situational privilege). User-issued token issuance is not implemented, so global exclude is **not callable** — only scoped exclusions are available. See the `memory_exclude` section.

† `memory_put` needs no token but is gated. With `MEMORY_PUT_ENABLED` unset it is on only for a standalone first run with no vector index; on any other install it returns `SCOPE_BLOCKED` until the server is launched with `MEMORY_PUT_ENABLED=1`. `MEMORY_PUT_ENABLED=0` forces it off everywhere. A put made that way is not returned by `memory_recall` by default: it has no embedding, no re-embed sweep entry is written (only the re-embed drain's opt-in `REEMBED_WORK_SET=ledger` mode finds it), and it is lexically indexed only under `MEMORY_BM25_DECOUPLE_EMBED=1` (default off). See the `memory_put` section.

Fourteen tools — exactly the set `listTools()` in `mcp/lib/dispatch.js` returns and the server answers to `tools/list`. Names that earlier revisions of this page documented but the server does not register are listed, without per-tool reference, under § Planned, not implemented.

The policy-rescind tool replaces the earlier `memory_rescind_predicate` name, which no longer exists. It is the single inverse for `memory_exclude`.

---

## Recall

### `memory_recall`

One-line description (this is what the agent reads): "Retrieve a bounded brief of memories relevant to the surrounding conversational context. Call once per turn; do not loop."

Input:

```
{
  surrounding_context: {
    recent_turns: [ { role, content } ],   // max 8 turns, each <= 2000 chars
    agent_role: string,                    // e.g. "assistant", "writer", "scheduler"
    current_query: string,                 // <= 2000 chars
    time: string,                          // ISO-8601; server validates
    ambient?: {
      calendar_state?: object,
      inferred_mood?: string,
      parties_present?: string[]
    },
    recent_recall_ids?: string[]           // for damping; <= 16 ids — memories those recalls surfaced have final_score × RECALL_RECENT_SURFACED_DAMPING_FACTOR (see below)
  },
  conversation_id: string,                 // required
  max_items?: integer,                     // <= RECALL_MAX_ITEMS
  max_chars?: integer                      // <= RECALL_MAX_CHARS
}
```

Output `data`:

```
{
  recall_id: string,                       // server-generated; logged as recall event
  memories: [
    {
      id: string,
      content: string,                     // <= RECALL_PER_MEMORY_CONTENT_CHARS
      provenance: { source, ts, parties, direction, authored_by, chat_type, reply_to, fwd_from, conversation_id, confidence, confidence_score, strictest_consent_basis },
      freshness: "fresh" | "stale",        // "potentially_outdated" reserved; see below
      derivation_chain: string[],          // one hop = the row's derived_from; F3 walks deeper
      derived_from: string[],              // parent memory ids of a reconstructed memory; [] for every other kind
      derived_from_titles: string[],       // first 80 chars of each parent's content ("" if the parent is missing); [] for non-reconstructed
      source_refs: [ { source, source_msg_id, event_id, consent_basis } ],  // first 4; see source_refs_count
      source_refs_count: integer
    }
  ],
  density_flag: null | "crowded" | "sparse",  // mmr.js emitDensityFlag returns "ok" | "crowded" | "sparse"; the brief reports "ok" as null
  bounded_by: { max_chars, max_items },
  truncated: boolean,                      // true if scored set exceeded caps
  degraded_recall: boolean,                // true when retrieval ran without its full dense leg (no query vector, refused or empty index, failed vector prefetch or dense search)
  degraded_reason?: string,                // present only when degraded: "index_unservable" reason, "dense_search_bad_request", "vector_prefetch_failed", "index_generation_refused" or "queryd_model_missing" (later wins)
  index_unservable?: { code, reason, model_version, index_source, sizes_measured, hnsw_empty?, bm25_empty? },  // present only when the active vector index is empty or the daemon lacks the model
  candidate_set_size: integer,             // post-gate: what survived to scoring
  candidate_pool_size: integer,            // pre-hard-gate fused pool; >= candidate_set_size
  deduped_count: integer,                  // candidates collapsed because their content was byte-identical to another's; 0 when none or dedup is off
  degraded_recall_layer3: boolean,         // true when the rerank step (Layer 3) degraded and the pre-rerank order was kept
  rerank_failed_reason: string | null,     // why Layer 3 degraded; null on success or when rerank was not attempted
  layer3_latency_ms: number,               // milliseconds spent in the rerank step (0 when it was skipped)
  rerank_input_count: integer,             // candidates sent to the reranker
  rerank_output_count: integer,            // candidates the reranker returned
  recent_surfaced_damped_count: integer,   // candidates damped because a recall in recent_recall_ids already surfaced them
  populator: {                             // what the server extracted from surrounding_context: counts and versions, not the extracted values
    degraded, degraded_reasons, entities_count, time_anchors_count, has_time_anchor, valence_set,
    entity_extractor_version, time_anchor_resolver_version, valence_model_version, episodicity_version,
    mood_vocab_version, mood_table_miss, fallback_triggered, fallback_added_candidates, fallback_skip_reason
  },
  index_source?: "queryd",                 // present only when the query daemon served the call
  generation?: string | null               // index generation the daemon answered from; present with index_source
}
```

Errors: `INVALID_ARGUMENTS`, `INTERNAL_ERROR`.

#### `recent_recall_ids` — damping, not paging

Each id is resolved through the in-process recall log (`mcp/lib/recall-log.js`, TTL `RECALL_LOG_TTL_SECONDS`); the memory ids that recall surfaced are unioned, and every scored candidate in the union has its `final_score` multiplied by `CAPS.RECALL_RECENT_SURFACED_DAMPING_FACTOR` (0.25) before the rerank slice. The damped entry keeps `final_score_pre_damping` and `recent_surfaced_damping_factor` on its score components in the recall event, and the envelope reports `recent_surfaced_damped_count`. Producer: `mcp/lib/recall/recent-surfaced-damping.js`; the stamp it reads is `surfaced_memory_ids` on the `recordRecall` entry.

Consequences the caller should expect: a memory the agent was just shown reappears only if it out-scores fresh candidates by 1/factor, so the brief stays a one-shot projection rather than a stream (the paging rejection below stands). Ids from another server process, from before this stamp existed, or older than the TTL resolve to nothing and damp nothing — the field degrades to a no-op, never to an error.

#### `provenance` — what it actually means

Every value is read off the ledger row already in memory on the recall path (`ledger.byId`) by `__projectBriefProvenance` in `mcp/lib/tools/recall.js`; nothing is looked up, derived, or backfilled at recall time, and a null or malformed row degrades to the legacy literals rather than throwing.

- `source` is the connector the row came from, and the ledger writes two ref shapes. Promoted facts carry `row.source` plus `source_refs[{source, source_msg_id, consent_basis}]`, so `source` is `row.source` (falling back to `source_refs[0].source`). Daemon reconstructed rows (`reconstruction-emitter.js` consentWalk, :562 and the :1237-1241 fallback) carry NO connector source at all — their refs are `source_refs[{event_id, consent_basis, role}]` where `event_id` is the parent memory id — so the brief reports `provenance.source: "reconstructed"` and each projected ref carries `event_id` with `source` / `source_msg_id` null. `"memory_ledger"` is emitted only for rows with neither a connector source nor any ref (the legacy/null degrade). Historically `"memory_ledger"` was the literal for every hit regardless of origin.
- `conversation_id` is a pass-through of the row's promote-time thread key, `daemon:thread:<bucket>:day:<date>`, stamped by `mcp/lib/synthesis/conversation-stamp.js` — a day-bucketed thread key, not the connector's native thread id. It is `null` on the older ledger (before the promote-time stamp), on daemon reconstructed rows (`reconstruction-emitter.js` sets it only in agent mode), on telegram / mail rows because `thread-aggregator.extractThreadKey` has no branch for them, and on github-events rows because they share the git-log branch (`thread-aggregator.js:253`) but that branch returns null (:263-267) when `raw_content` lacks `author_email` / `author` — `github-events.js` emits only `actor_login` / `member_login` / `issue_author` / `pr_author` (:224, :243, :310, :927). It is NOT a thread lookup: the conversation index is never loaded on this path. The thread relation an agent should use is derivation membership — `derivation_chain` here (one hop) and the deeper F3 walk.
- `confidence` is the row's string verbatim. Every live fact carries `"pre_distilled"` (the watermark promote path); no grader has ever assigned `high` / `medium` / `low`, and before this projection the brief reported the literal `"medium"` for every hit. `confidence_score` is the reconstructed row's numeric self-report (a finite number in [0,1], e.g. daemon 1.0 / agent 0.6) and `null` otherwise — the string enum has no honest bucket for a number, so it is not translated into one.
- `source_refs` carries the first 4 refs as exactly `{source, source_msg_id, event_id, consent_basis}` and nothing else (`raw_content`, `role`, `via`, `corroboration_event_id` and other ref keys are never projected); `source_refs_count` is the full length so a 16-ref reconstructed row is visibly truncated. `source_msg_id` is an opaque connector key (promoted facts; `event_id` null); `event_id` is the parent memory id (reconstructed rows; `source` / `source_msg_id` null). `consent_basis` travels with each ref so the consumer can honour `kb/ingestion.md` § Consent-aware promotion (no verbatim quoting for `second_party_dm` / `third_party_inferred`). `provenance.strictest_consent_basis` is the row-level strictest basis across the refs (`row.strictest_consent_basis`, stamped on reconstructed rows by the consent walk — `derived` when the walk could not determine one) and `null` on rows that do not carry it.
- `max_chars` counts `content` only (`enforceBriefCaps` in `mcp/lib/recall/mmr.js` measures `content_excerpt`); provenance and `source_refs` sit outside the budget and are bounded by the 4-ref cap.

#### `freshness` — what it actually means

`freshness` is the **age of `provenance.ts` measured against `surrounding_context.time`**, thresholded at `CAPS.RECALL_FRESHNESS_STALE_AFTER_MS` (30 days — `mcp/lib/validation.js`, declared immediately after `RECALL_TIME_FALLBACK_WINDOW_MS`).

- Producer: `freshnessLabel({ candidate_ts, now_iso })` in `mcp/lib/recall/multi-feature-score.js` — the single definition.
- Consumer: `mcp/lib/tools/recall.js`, the `memories[]` projection, which is its **only** call site.
- Clock: `surrounding_context.time`, which the tool's `inputSchema` requires and `assertIso8601` validates at the top of the handler. `Date.now()`, `serverTs()`, and the handler's internal test-only `opts.now` are **not** consulted on this path, so two callers passing the same `time` get identical labels.
- `age <= threshold -> "fresh"` (boundary inclusive); otherwise `"stale"`.
- A future-dated `ts` clamps to age 0 and is `"fresh"` — the same clock-skew clamp `powerLawDecay` applies in the same file.
- An absent, empty, or unparseable `ts` or `time` is `"stale"`. Unknown age is never reported as fresh; absence of evidence is not evidence of freshness.

`"potentially_outdated"` is **reserved and never emitted** at this version. It is left declared rather than deleted so a future emitter does not have to widen the enum, but it is deliberately given no definition here: the only honest producer of "outdated" is supersession / derivation state (a memory contradicted or replaced by a later one), and age alone cannot distinguish *old* from *outdated* — a five-year-old birthdate is old and perfectly current. Writing a plausible-sounding definition into this page would be worse than the reservation, because the next reader would build on it. The emitted label set is exactly `{"fresh","stale"}`.

Before this was computed, the field was the literal `"fresh"` on every row: an April memory surfaced in August reported itself fresh.

Notes. The brief is bounded by `max_chars` / `max_items` and is one-shot — there is no paging. Pagination was considered and rejected: a brief is supposed to be the context-conditional projection at this moment, not a stream the agent walks. If the candidate set exceeds caps, the server returns the top-scoring items, sets `truncated: true`, and trusts the recall function's scoring to be load-bearing. `density_flag` describes the brief it accompanies (`emitDensityFlag` in `mcp/lib/recall/mmr.js`): `"crowded"` when the surfaced memories are near-duplicates of one another (average pairwise cosine above `CAPS.DENSITY_FLAG_PAIRWISE_COSINE_THRESHOLD`) or more than 6 of the top 12 reranked candidates scored within 5% of the top score, `"sparse"` when fewer than 3 memories were surfaced, and `null` otherwise. The memories are returned in every case; the flag only tells the caller to ask for more diversity or more breadth.

The call logs a `recall` event in the memory ledger keyed by `recall_id` regardless of outcome. The recall log is the input to damping; see `operations.md` § Damping.

#### Deferred: temporal scoping of the candidate set ("what happened over the past three weeks")

Recall has no way to scope a brief to a time WINDOW. This section records why that was measured and deferred rather than built, so the next reader starts from the evidence instead of re-deriving it.

**What was measured.** `computeRecallObservables` (`mcp/lib/recall/recall-observables.js`) now emits `anchored_rate` and `time_anchors_count_histogram` per segment. Example measurement from one development install's `ledgers/recall.jsonl` (read-only; your numbers will differ): 7 of 272 rows carrying a `populator` block resolved a time anchor (`anchored_rate` ≈ 0.026), all stamped `time_anchor_resolver_version` = `"rule-v1"`.

**The honest limit on that number.** The recall ledger stores `query.surrounding_context_hash` and `query.context_embedding` and **no raw query text**. The share of queries that carried time *language* is therefore not measurable from this substrate at all. An `anchored_rate` like this is a floor on anchor **resolution**, not a measurement of demand.

**The motivating phrase does not parse.** "over the past three weeks" matches neither rule in `mcp/lib/synthesis/time-anchor-resolver.js`:

- Rule 5 (`scanRelativeSpans`) uses `/\b(last|next|this|past|coming)\s+(week|weeks|month|months|year|years|summer|winter|spring|autumn|fall)\b/gi` — the intervening quantifier ("three") defeats the `\s+`.
- Rule 6 (`scanNumericOffsets`) requires "N units ago" or "in N units"; the phrase is neither.

Executed against the shipped resolver with `now = 2026-08-20`, `resolveTimeAnchors("what did we do over the past three weeks")` returns `[]`, while `"last week"` and `"3 weeks ago"` both resolve.

**Span data exists; no consumer does.** Rule 5 emits a non-null `duration_ms` on its anchor (`time-anchor-resolver.js`, the `scanRelativeSpans` return). Nothing in `mcp/lib` or `daemons` reads it — the only other `duration_ms` in the tree is `bm25-rebuild.js`'s elapsed-time field, which is unrelated. The window is already being computed and thrown away.

**Three alternatives, weighed.**

1. *A time filter over the candidate set, before rerank.* Free — it touches at most 50 rows. Near-useless: the pool is capped by `CAPS.RECALL_CANDIDATE_SET_SIZE = 50` and was selected by lexical/dense similarity **without** the window, so applying a three-week filter after the fact usually converts a bad brief into an empty one. **Rejected.**
2. *A recency prior in scoring.* **Already shipping** — `powerLawDecay`, weighted by `CAPS.SCORE_WEIGHT_TIME_DECAY = 0.3`. It is monotone over the whole corpus rather than windowed, so raising it biases everything toward recent instead of answering "the past three weeks". **Rejected as a scoping mechanism**, and recorded here as already-present so nobody re-proposes it as new.
3. *A caller-set `since_ms` on the tool surface.* The honest option when query language is ambiguous, and additive to the ABI — `recall.js`'s `inputSchema` marks only `recent_turns`/`agent_role`/`current_query`/`time` required, and its `additionalProperties: false` blocks (the args root and `surrounding_context`) accept a new **optional** property without breaking existing callers. But it only works if threaded into candidate **generation**, and the only ts-scoped substrate on disk, `queryTimeRange` (`mcp/lib/synthesis/time-index.js`, currently unwired into recall — it has no caller outside its own module), keys on `features.time_anchors[]`, not on row `ts`. It therefore cannot answer a row-age window. A ts-sorted index over a large ledger (the development install had about 1.5M rows) would require persisting a new cache under `storage/`.

**Recommendation, and what is not being done.** Temporal scoping belongs at **candidate generation**, behind a caller-set `since_ms` — not in the reranker and not as a post-filter. It is **deferred** until a ts-keyed row index exists. Concretely, recall has no `since_ms` parameter, no time filter, no scoring change for this, and no new index; what exists is the freshness label, the `candidate_pool_size` envelope field, and the `anchored_rate` measurement above.

**Re-check condition.** Revisit when `anchored_rate` rises materially on a real install, or when any ts-keyed row index lands.

## Direct write

### `memory_put`

Description: "Record a user-authored memory directly. First-party write: the user asserts the fact (consent_basis=first_party), no daemon token required. The fact inherits the full synthesis stamp cascade (entities, time anchors, valence, episodicity) and is returned by memory_recall by default only on a standalone first run with no vector index; on a configured install the row is written without an inline vector and is recalled only when the server also runs with MEMORY_BM25_DECOUPLE_EMBED=1. On by default only for a standalone first run with no vector index; otherwise dark unless MEMORY_PUT_ENABLED=1 (MEMORY_PUT_ENABLED=0 forces it off). Use when the user KNOWS a fact and wants it remembered without a source connector."

Privilege: `default` — no `confirmation_token`, no `MEMORY_ROLE` requirement.

**Disabled by default on a configured install; enabled on a standalone first run.** The handler's first step checks the gate, before the payload is parsed (`mcp/lib/tools/put.js`, `putEnabled`). The gate is evaluated at call time, in this order: the environment variable `MEMORY_PUT_ENABLED=1` (or `=true`) turns the tool on; `MEMORY_PUT_ENABLED=0` (or `=false`) turns it off and wins over everything below; `CAPS.MEMORY_PUT_ENABLED` true turns it on (it ships `false`); with the variable unset, or set to any other value, the tool is on only for a standalone first run with no vector index — the server process is not a queryd client and the on-disk index tree for the active embedding model holds no vector index and is intact — and off otherwise. An index that is refused, truncated or unreadable does not count as a first run. When the gate is off, every call returns `SCOPE_BLOCKED` and writes nothing. The variable is read from the server's own environment, so set it where the MCP server is launched (the `env` block of the client's MCP server registration), not in the calling shell. To put a memory and then recall it: on a fresh standalone install call `memory_put` with no opt-in, then call `memory_recall` with a `current_query` about the same subject; once the install has a vector index or is served by queryd, launch the server with `MEMORY_PUT_ENABLED=1` first. On such a configured install the put succeeds but `memory_recall` does not return it by default: the row lands with no embedding, no re-embed sweep entry is written for it, and it joins the lexical index only when the server is also launched with `MEMORY_BM25_DECOUPLE_EMBED=1` (default off). `memory_get` with the returned `memory_event_id` does return it.

Input:

```
{
  content: string,                         // required; non-empty, <= CONTENT_MAX_CHARS (16384)
  provenance: {                            // required object; may be {} — every field is optional
    agent_id?: string,
    conversation_id?: string,
    confidence?: "high" | "medium" | "low" // defaults to "high"; "pre_distilled" is not accepted here
  },
  source_refs?: [                          // optional
    { source: string, source_msg_id?: string }   // source required and non-empty
  ],
  derived_from?: string[]                  // optional; memory ids this fact was inferred from
}
```

No other top-level field is accepted (`additionalProperties: false`); `ts` and `consent_basis` are server-stamped (`first_party`), never caller-supplied.

Output `data`:

```
{
  memory_event_id: string,                 // id of the appended fact row; pass to memory_get
  promoted_at: string                      // server ts
}
```

Errors: `SCOPE_BLOCKED` (the put surface is disabled — see above), `INVALID_ARGUMENTS`, `INTERNAL_ERROR` (ledger append failed).

The row is appended without an inline embedding, so an embedder outage does not block the put. With the default configuration nothing re-embeds the row: a put writes no re-embed sweep entry, so the re-embed drain in its default `REEMBED_WORK_SET=sweep` mode never sees it (`mcp/lib/tools/put.js`; `appendOperatorFact` in `mcp/lib/tools/distill-promote-fact.js`). The drain's opt-in `REEMBED_WORK_SET=ledger` mode (`docs/ENVIRONMENT.md`; `daemons/reembed-drain.mjs`) does enumerate ledger rows whose `features.embed_state` is `true`, which includes a put row written without a vector, and hands them to `mcp/scripts/reembed-local-4096.mjs`; that writes the vector to the `vectors.jsonl` sidecar, subject to the sidecar-to-index caveat below. No other supported route adds the row to the vector index afterwards. `node mcp/scripts/reembed-local-4096.mjs --ids-file <file>`, with the embedding server running and `<file>` holding the returned `memory_event_id`, writes the row's vector to the `vectors.jsonl` sidecar, but the only step that turns the sidecar into an index is that script's `--build-hnsw` mode, which rebuilds from the sidecar alone and so drops the vectors of facts that were embedded at ingest and never mirrored into it; do not run it on an install whose index was filled by ingest. `scripts/backfill-embeddings.mjs` is not a route: it produces 3072-dimension Gemini vectors, not the active index's. Each successful put also appends a `policy.memory.put` audit event to `policy-events-YYYY-MM.jsonl`; a failure of that audit write does not roll back the fact row.

---

---

## Policy operations

One forgetting verb is registered: `exclude`. Agents invoke it when the user expresses a forgetting intent. The design names three more verbs (`replace`, `substitute`, `excise`); none of them is registered — see § Planned, not implemented. The propose-back pattern is described below.

### `memory_exclude`

Description: "Hide memories matching a predicate in matching contexts. Use for 'stop bringing up X' and contextual suppression. Bound to a prior recall_id; the embedding is server-snapshotted, never caller-supplied."

Input:

```
{
  recall_id: string,                       // server-issued id from a prior memory_recall
                                           //   within RECALL_LOG_TTL_SECONDS; server snapshots
                                           //   context_embedding + embedding_model_version
                                           //   from this recall's logged event
  predicate: {
    context_entities: string[],            // <= PREDICATE_MAX_ENTITIES; agent-derived
    similarity_threshold: number,          // 0.0..1.0
    scope: "global" | {
      agent_role?: string,
      parties?: string[],
      time_range?: { start, end }          // ISO-8601
    }
  },
  confirmation_token?: string,             // REQUIRED when scope == "global";
                                           //   user-issued, bound_field "recall_id"
  conversation_id: string,
  agent_role: string,
  rationale?: string                       // <= 500 chars; surfaced in propose-back
}
```

Output `data`:

```
{
  predicate_id: string,                    // for memory_get_predicate / memory_rescind_policy
  applied_at: string,                      // server ts
  embedding_model_version: string,         // tag from the snapshotted recall
  scope_applied: object,                   // echoes input scope
  active_predicates_count: integer         // total after this write; <= PREDICATE_MAX_ACTIVE
}
```

Errors: `INVALID_ARGUMENTS`, `NOT_FOUND` (`recall_id` not found or expired beyond TTL), `STATE_CONFLICT` (predicate identical to an active one *for the same `recall_id`*; or `PREDICATE_MAX_ACTIVE` reached — rescind to make room), `PRIVILEGE_REQUIRED` (global scope without valid token), `INTERNAL_ERROR`.

Dedup scope is **per-recall_id**: two predicates with identical `{context_entities, similarity_threshold, scope}` against the *same* `recall_id` collide and the second is rejected with `STATE_CONFLICT`. Two distinct `recall_id`s carrying identical predicate bodies are NOT deduped — each recall is a separate consent context, and the propose-back UX deliberately allows the user to reaffirm the same intent across recalls. Cross-recall dedup is not implemented; it would require predicate canonicalization across the index; it is not an invariant today.

The predicate is the snapshot-at-emit-time form from `operations.md` § exclude. **The agent does not supply `context_embedding`** — it passes only the `recall_id`, and the server reads the embedding (plus its `embedding_model_version` tag) directly from the recall log entry. This is the discipline that makes "the agent does not invent context_embedding" enforceable rather than aspirational: a hand-crafted vector cannot reach the predicate store because there is no field to put it in.

`recall_id` must reference a recall logged within `RECALL_LOG_TTL_SECONDS` (default 24h). Predicate creation from older recalls is rejected with `NOT_FOUND` — the freshness window prevents stockpiling old recall_ids for later use.

`scope: "global"` requires a user-issued confirmation token because a global exclude can blind huge regions of recall. Binding fields: `{recall_id, scope, similarity_threshold, context_entities_hash}` — the token cannot be redirected to a different recall, a different scope, a different threshold, or a different entity set within the same recall. `context_entities_hash` is `sha256(canonical_json(sorted(context_entities)))`; including it closes the otherwise-open path where the agent showed the user one entity list at consent time and submitted a fatter one with the token. Scoped exclusions (`agent_role`, `parties`, `time_range`) are unprivileged because their blast radius is bounded by the scope itself.

**Availability.** User-issued token issuance is not implemented (see § Current status), so `scope: "global"` returns `PRIVILEGE_REQUIRED` unconditionally. Callers must use a non-global scope.

Recall-time check: skip any memory whose features match within `similarity_threshold` or that shares any captured entity tag, within scope.

---

## Read introspection

These let the agent inspect captured policy state without writing. `memory_get_predicate` is load-bearing for the propose-back UX pattern described below.

### `memory_get_predicate`

Description: "Read a captured exclude predicate by id. Use this to surface an interpretation back to the user for confirmation before a write."

Input:

```
{
  predicate_id: string
}
```

Output `data`:

```
{
  predicate_id: string,
  captured_at: string,
  emitted_by: { conversation_id, agent_role },
  context_entities: string[],
  similarity_threshold: number,
  scope: object,
  rationale: string | null,
  embedding_model_version: string,         // tag from the snapshotted recall log entry;
                                           //   surfaces the model-version actually captured
                                           //   so propose-back honestly shows the binding
  embedding_summary: {
    nearest_entities: string[],            // human-readable proxy for the vector
    nearest_memories: [ { id, content_snippet } ]  // <= 3
  },
  active: boolean
}
```

Errors: `NOT_FOUND`, `INTERNAL_ERROR`.

This is how the propose-back UX pattern lands — see `open-problems.md` § 2. When the user says "stop bringing this up," the agent captures the recall context, calls `memory_exclude` to get a `predicate_id`, then calls `memory_get_predicate` to render the captured predicate (entities, scope, what nearby memories were caught) back to the user. The user confirms or refines. If they refine, the agent emits a fresh `memory_exclude` and the prior predicate is left active or rescinded depending on the refinement. Propose-back is a usage pattern over these two tools, not a separate tool.

`embedding_summary.nearest_entities` and `nearest_memories` are the human-readable proxy for the otherwise-opaque vector. Without this, the predicate is uninspectable and the propose-back pattern collapses.

### `memory_rescind_policy`

Description: "Deactivate an active forgetting-policy event (exclude predicate, replace, or substitute). Append-only: the policy event stays in the ledger marked rescinded; recall no longer applies it. The single inverse for every apply-only forgetting verb."

Input:

```
{
  policy_event_id: string,                 // predicate_id from memory_exclude
  conversation_id: string,
  agent_role: string,
  rationale?: string                       // <= 500 chars
}
```

Output `data`:

```
{
  policy_event_id: string,
  policy_kind: "exclude",                  // resolved server-side; the only kind the
                                           //   handler resolves today
  rescinded_at: string,
  was_active: boolean,                     // false if already rescinded (idempotent)
  active_predicates_count: integer         // total active predicates after this write
}
```

Errors: `NOT_FOUND`, `INVALID_ARGUMENTS`, `PRIVILEGE_REQUIRED` (privilege mismatch — see below), `INTERNAL_ERROR`.

Privilege: **rescind privilege matches emit privilege.** If the target policy event was emitted with a confirmation token (e.g. a global-scope `memory_exclude` or any privileged op), `memory_rescind_policy` requires a user-issued confirmation token bound to `{policy_event_id, target_kind}`. If the target policy event was emitted without a token (e.g. a scoped-exclude predicate at default privilege), rescind is also default privilege.

The "more reachable = safer" rule does not generalize: rescinding a privacy-motivated exclude resurfaces the protected memory; rescinding a substitute resurfaces the un-reframed original (which the user may have deliberately replaced with a kinder framing). The rescind-privilege-matches-emit-privilege rule prevents an unprivileged caller from cheaply undoing privileged work, and it prevents prompt-injected agents from enumerating predicates via `memory_list_predicates` (default) and silently destroying them.

`policy_kind` is resolved server-side from the `policy_event_id`'s ledger entry. The server also resolves whether the target was privileged-emit (by checking for the policy event's `binding_hash` field) and enforces the token requirement accordingly. Repeated rescind on an already-rescinded policy event is idempotent (`was_active: false`); the privilege check still runs (no information leak about target privilege via idempotency).

Current behaviour: the handler resolves `policy_event_id` only against the exclude-predicate registry, so only `exclude` policies can be rescinded, and only scoped (non-global) excludes can be emitted at all. Every rescind is therefore default-privilege, and the input schema has no `confirmation_token` argument; the privilege-matching rule above is the design for when privileged-emit policies exist. Any other id — including the `revoke_event_id` returned by `memory_connectors_revoke` — returns `NOT_FOUND`.

Without this tool, `active: boolean` on every policy event is write-only-true and propose-back's "rescinded" branch is unreachable. The same argument would apply to the planned `replace` and `substitute` verbs and to `corroboration` events — one tool, one inverse — but only `exclude` is wired today.

### `memory_list_predicates`

Description: "List active exclude predicates. For debugging; not the daily path."

Input:

```
{
  scope_filter?: { agent_role?, parties? },
  max_items?: integer                       // <= LIST_PREDICATES_MAX_ITEMS
}
```

Output `data`:

```
{
  predicates: [
    { predicate_id, captured_at, context_entities, scope, active }
  ],
  total_active: integer,
  truncated: boolean
}
```

Errors: `INVALID_ARGUMENTS`, `INTERNAL_ERROR`.

### `memory_get`

Description: "Fetch a single memory event by id with full provenance. Read-only. Use to answer 'where did you get that?' for a specific memory, or to render the read-before-destroy preview for `memory_excise`."

Input:

```
{
  id: string
}
```

Output `data`:

```
{
  id: string,
  kind: "fact" | "policy" | "recall" | "reconstructed",
  content: string,                         // full content; not snippet-capped
  provenance: { source, ts, parties, confidence, agent_id?, conversation_id? },
  source_refs: [                           // effective set: original + all corroborations joined
    {
      source: string,
      source_msg_id: string,
      via: "original" | "corroboration",
      corroboration_event_id: string | null    // non-null when via == "corroboration"
    }
  ],
  derived_from: string[],                  // memory ids
  features: {
    entities: string[],
    time_anchors: string[],
    valence: number | null,
    embedding_model_version: string        // tag from when the embedding was computed
  },
  created_at: string,
  superseded_by: string | null,            // memory id, if a memory_replace targeted this
  reframed_by: string | null,              // memory id, if a memory_substitute targeted this
  rescinded_at: string | null              // policy-kind events only
}
```

Errors: `NOT_FOUND`, `INVALID_ARGUMENTS`, `INTERNAL_ERROR`.

Privilege: `default`. Read-only over the memory ledger; respects nothing beyond ledger integrity. Does not surface excised memories — those return `NOT_FOUND` regardless of `silent` status (silent excise is opaque to this tool by construction; non-silent excise tombstones leave a record visible only via the excise audit channel).

**`source_refs` is corroboration-joined**, computed by folding all `corroboration`-kind policy events whose `targets[]` includes this memory id. The original promotion is included with `via: "original"`; each later corroboration appears with `via: "corroboration"` and its own `corroboration_event_id` (useful for rescinding the corroboration via `memory_rescind_policy` without removing the original promotion). This matches the contract from `ingestion.md` § Cross-source dedupe and is the form `memory_excise` walks for blast-radius computation. If the projection's `corroboration` index is `stale` per `memory_health.index_status`, the server recomputes fresh from the ledger before returning.

The raw embedding vector is deliberately omitted from output. Vectors are large, model-version-dependent, and useless to an agent in this context — `embedding_model_version` plus the `embedding_summary` proxy (available via `memory_get_predicate` for predicates) is the inspection path. If a future tool needs the vector itself, add it then.

---

## Control plane

Connector state, connector revocation, and system health. All three registered tools are default-privilege. Pause/resume and quarantine review are designed but not registered — see § Planned, not implemented.

### `memory_connectors_list`

Description: "List ingestion connectors and their state."

Input: `{}` (no arguments).

Output `data`:

```
{
  connectors: [
    {
      source: string,                       // "telegram" | "whatsapp" | "email" | ...
      state: "running" | "paused" | "catching_up" | "backfilling" | "auth_pending" | "unhealthy",
      cursor_age_seconds: integer,
      last_ingested_ts: string | null,
      pending_quarantine_count: integer,
      health_notes: string[]                // recent supervisor messages
    }
  ]
}
```

Errors: `INTERNAL_ERROR`.

**Additive operational fields (open envelope).** Beyond `connectors[]`, the live
handler emits additive top-level health projections that older callers ignore
safely: `stage0_counters`, `source_health_probes`, `embed_cost_counters`,
`cursor_lag`, `health` ({level, warnings}), and — B1 (task-hypergraph) —
`drain_liveness`. The last is the Telegram drain-liveness snapshot from
`lib/connectors/telegram-drain-liveness.js`:
`{installed, staging_present, staging_mtime_ms, staging_size, ledger_mtime_ms,
ledger_size, ledger_age_ms, staging_age_ms, last_appended_ts, last_polled_ts,
staging_offset, unconsumed_bytes, drain_stalled, status}`. It fires
`drain_stalled=true` (and `status="unhealthy"`) when the source ledger's mtime
is stale (> `CAPS.TELEGRAM_DRAIN_STALL_THRESHOLD_MS`, 6h) WHILE the upstream
staging file is still live (mtime < `CAPS.TELEGRAM_STAGING_LIVE_WINDOW_MS`, 1h)
— the silent drain-stall class W7 cursor-lag is structurally blind to (a frozen
ledger has `ledger_growing=false`). `drain_stalled` rolls into
`health.level="WARN"`. The same detector backs `memory_health`
`telegram_connector_status` (a stall maps to the existing `"unhealthy"` enum
value plus a `telegram_drain_stalled:` `health_notes` entry — no new enum value,
no new health field). B2 (memory-roots) adds `source_health_probes.mail.alias_candidates`
— `[{address, direct_rows, total_rows, account_share, reason}]`, unregistered
addresses tallied inside the existing 7-day mail tail scan under two keys:
`account_dominant` (the top To/Cc recipient of one of the user's own Apple
Mail accounts, `>= CAPS.OPERATOR_ALIAS_CANDIDATE.min_account_share` of an
account with `>= min_account_rows` rows) and `name_token` (local-part shares an
operator name token AND `>= min_direct_rows` INBOUND sole-To direct rows — no
registered From:, no Cc:, every other To: address registered, not in a
Junk/Spam/Trash/Bulk Mail/Deleted Messages or Drafts folder — plus a nonzero
account share; B5/B6). Registered addresses are never candidates. The matching
advisory `operator_alias_candidate: <addr> (N direct non-list mails in Wd,
<reason>[, share=D.DDD])` `health_notes` entry on `memory_health` renders the
share at 3 dp fixed for account-dominant reasons only (no new top-level field,
no `warnings[]` entry, no `health.level` change).

### `memory_connectors_revoke`

Description: "Revoke an active connector. Takes only `source`. Appends a policy/connector_revoke event that the transitive-orphan BFS picks up to hide every memory derived from that source at recall time. The source ledger file is kept on disk. There is no tool-level un-revoke: memory_rescind_policy does not accept the returned revoke_event_id (it returns NOT_FOUND)."

Privilege: `default` — no `confirmation_token`.

Input:

```
{
  source: string,                           // required; connector source string, e.g. "telegram"; <= 64 chars
}
// The advertised schema also lists delete_ledger?: boolean, but the handler
// rejects it with INVALID_ARGUMENTS (see below). Pass source alone.
```

Output `data`:

```
{
  revoke_event_id: string,                  // id of the appended policy row (policy_kind: "connector_revoke")
  target_source: string,                    // echoes source
  recognized: boolean,                      // false when source is not a known connector (likely a typo);
                                            //   the event is appended either way
  deleted_ledger: boolean,                  // always false today (delete_ledger is rejected)
  deleted_ledger_path: string | null        // always null today
}
```

Errors: `INVALID_ARGUMENTS`, `INTERNAL_ERROR`.

The revoke appends one `policy`-kind row to the memory ledger; recall then hides every memory whose `source_refs[].source` equals `source`. Revoking twice appends two rows; the second changes nothing at recall.

Two limits on what the handlers do today, both visible in `mcp/lib/tools/`:

- The input schema declares `delete_ledger`, but the handler's own shape check (`connectors-revoke.js`, `assertObjectShape(args, "args", ["source"])`) allows only `source`, so a call that passes `delete_ledger` is rejected with `INVALID_ARGUMENTS`. Call with `source` alone.
- There is no tool-level un-revoke. `memory_rescind_policy` resolves ids only against the exclude-predicate registry (`rescind-policy.js`), so a `revoke_event_id` returns `NOT_FOUND`.

### `memory_health`

Description: "System health summary. Read-only. Cheap. Safe to call from a status line."

Input: `{}`.

**Output `data` (AUTHORITATIVE FIELD SET — single closed block; every field listed here is required; no field outside this list may be returned).**

<!-- BEGIN-CANONICAL: health_envelope_schema_v1 -->
```
{
  schema_version: integer,                  // HEALTH envelope schema version; bumped on any field add/remove/rename.
  server_started_at: string,                // ISO-8601 of MCP server boot
  time_now: string,                         // ISO-8601 of this call (server-stamped)
  tools_registered: integer,                // count of tools the MCP surface actually registered this boot — never a hardcoded constant
  telegram_connector_status: "running" | "paused" | "catching_up" | "backfilling" | "auth_pending" | "unhealthy" | "not_installed",
  source_event_counts: {
    auto_memory: integer,
    chat_claude_code: integer,
    telegram: integer
  },
  ledger_byte_counts: {
    "<source>": integer                     // one entry per active source ledger (chat-*.jsonl, auto-memory.jsonl, telegram.jsonl, ...)
  },
  policy_events_active_file: string,        // absolute path to ~/memory-system/policy/policy-events-YYYY-MM.jsonl currently being written
  policy_events_disk_bytes: integer,        // sum across all rotated policy-events-*.jsonl files
  rederive_jobs_pending: integer,           // count of in-flight rederive jobs spawned by memory_excise re_derive_without
  distillation_state: {
    watermark_lag_seconds: null,            // deprecated; the per-conversation idle-watermark concept retired in R32
    last_distillation_ts: null,             // deprecated; the conversational supervisor that settled batches retired in R32
    in_flight_batch_count: 0,               // deprecated; the conversational queue retired in R32
    deprecated: true                        // operator dashboards should render this block as "n/a"; see kb/legacy-archive.md
  },
  synthesis_coverage: {                     // F-SYN-OPERATIONAL-synthesis-coverage-probe (Wave-10). Rolling-window probe over the cascade + recall ledgers so the operator can SEE whether new facts are being stamped with entities/time_anchors/valence/episodicity and whether recalls are populating scoringContext. Best-effort: probe failure surfaces a note in health_notes and this object is null.
    window_days: integer,                   // rolling-window length (default 7)
    built_at: string,                       // ISO-8601 clock anchor used to compute [now-windowDays, now]
    facts_in_window: integer,               // count of memory.jsonl fact-shaped rows whose ts falls in window
    entity_coverage:        { populated: integer, empty: integer, pct: number },  // share of facts in window whose features.entities is a non-empty array
    time_anchor_coverage:   { populated: integer, empty: integer, pct: number },  // share with features.time_anchors[] non-empty
    valence_coverage:       { populated: integer, empty: integer, pct: number },  // share with features.valence as a finite number
    episodicity_coverage:   { populated: integer, empty: integer, pct: number },  // share with features.episodicity as a finite number
    extractor_versions: {                   // version histograms — operator-visible drift signal across the rolling window
      entity_extractor_version:      { "<version-string>": integer },
      episodicity_version:           { "<version-string>": integer },
      time_anchor_resolver_version:  { "<version-string>": integer },
      valence_model_version:         { "<version-string>": integer }
    },
    recall_population: {                    // recall.jsonl-side: share of recalls whose populator counts > 0
      recalls_in_window: integer,
      non_empty_entities_pct: number,
      non_empty_time_anchor_pct: number,
      non_empty_valence_pct: number,
      degraded_recall_pct: number
    }
  } | null,
  health_notes: [ string ]                  // operator-visible notes (stale lock, corrupt nonce-store, etc.); empty array means healthy
}
```
<!-- END-CANONICAL: health_envelope_schema_v1 -->

The block above is hash-pinned and kept verbatim, so a few of its comments use older wording. Read `~/memory-system/` as the data root (`<data root>`, which defaults to the checkout; see `mcp/lib/config.js`). "Retired in R32" means the conversational-distillation pipeline that fed those fields is retired (see `kb/legacy-archive.md`). The internal ids in the `synthesis_coverage` comment are historical labels for the change that added that probe.

Errors: `INTERNAL_ERROR`.

**No drift permitted.** Any field mentioned elsewhere in this document under § Rotation, § Consumed-nonce store, § excise, etc. that surfaces a health condition MUST appear in this block. If a section names a health field not present above, the discrepancy is a spec bug — reconcile by adding to this block or removing from the section. Implementations MUST return real data; hardcoded values (e.g. a hardcoded literal `tools_registered` value instead of `toolCount()`, `watermark_lag_seconds: null` when batches exist) are a conformance failure (an earlier review found `memory_health` reporting hardcoded values).

The `ledger_writable` and `index_status` fields previously listed here are **deleted from this block** in favor of being surfaced via `health_notes` when degraded (a healthy system has no note, a non-writable ledger emits a note like `"ledger_not_writable: storage/memory.jsonl EACCES"`, a rebuilding index emits `"index_rebuilding: vector"`). This keeps the field set closed against unbounded one-off booleans.

The `connectors_healthy` / `connectors_total` / `pending_quarantine_total` summary fields are **deleted from this block**; connector state is reachable via `memory_connectors_list`. `memory_health` is for daemon-lifecycle and pipeline-health surfacing, not connector enumeration.

## Messaging catch-up

A read-only inbox view over the messaging source ledgers and the feedback loop that tunes its ranking. Both tools are default-privilege and take no token. They are implemented in `mcp/lib/messaging/` rather than `mcp/lib/tools/`.

### `memory_catchup`

The catch-up inbox.

Description: "Cross-platform 'waiting on you' inbox: a ranked, deduped list of threads where someone spoke last and addressed you — fused across every messaging platform via the adapter registry. A short closing message ('ok', 'thanks') is dropped UNLESS the thread carries context that says otherwise (a saved contact, or a reply to something you sent), in which case it is kept and ranked down with a low_substance reason. Read-only; the right instrument for 'catch me up', not memory_recall."

Input (every argument is optional; `{}` is a valid call):

```
{
  limit?: integer,                          // 1..500; default 50
  since_ms?: integer,                       // >= 1
  platforms?: string[],                     // restrict to these adapter-registry keys
  min_score?: number,                       // 0..1
  reciprocity_floor?: number,               // 0..1; 1 disables the reciprocity down-rank
  persona?: boolean                         // default true; false omits the per-row persona block
}
```

Output `data`:

```
{
  rows: [ object ],                         // ranked thread rows; a row carries `persona` unless persona: false
  count: integer,                           // rows.length
  generated_at: string,                     // server ts (ISO-8601)
  generated_at_ms: integer,                 // the same build clock, epoch milliseconds
  stats: {
    threads_considered: integer,
    after_filter: integer,
    after_dedup: integer,
    truncated: boolean,
    platforms: object,
    tiers: { relationship: integer, unknown: integer },
    sources_failed: string[],               // sorted keys of sources whose ledger read failed
    source_status: { "<source>": { failed: boolean, stage: string | null, error: string | null } }
  }
}
```

Errors: `INVALID_ARGUMENTS`.

A source whose ledger cannot be read does not fail the call: the healthy sources' rows are still returned and the failed source is named in `stats.sources_failed`. The per-row field set is not specified on this page; read `buildCatchup` in `mcp/lib/messaging/catchup.js`.

### `memory_catchup_feedback`

Catch-up feedback.

Description: "Record a triage action on a memory_catchup row (the who-matters engagement loop). action ∈ {surfaced, opened, replied, dismissed, flagged_spam}; subject_id is the surfaced person_id (or thread_id). Append-only — flag a noisy sender or dismiss a row and the who-matters ranking learns from it over time. Read it back as a feedback_score in [0,1] (replies/opens lift, flag/dismiss lower; a never-triaged subject stays neutral and is never dropped)."

Input:

```
{
  subject_id: string,                       // required; 1..512 chars; the person_id (or thread_id) of a catch-up row
  action: "surfaced" | "opened" | "replied" | "dismissed" | "flagged_spam",   // required
  note?: string                             // optional; <= 512 chars
}
```

Output `data`:

```
{
  recorded: object,                         // the appended feedback row (subject_id, action, server-stamped ts, note if given)
  subject_id: string,
  feedback_score: number,                   // 0..1, read back after the append
  generated_at: string                      // server ts
}
```

Errors: `INVALID_ARGUMENTS`.

---

---

## Distillation surface

Distillation tools run outside the live conversation thread — invoked as a manual recovery / promote path. They are the *only* legitimate callers of the tools below. Agents in-conversation must not call them; **the `MEMORY_ROLE` launch-identity env enforces this** (see § Privilege levels → SCOPE_BLOCKED via launch-identity). **In-conversation callers attempting any distillation tool receive `SCOPE_BLOCKED` at step 0 — before any payload validation runs** — the error appears in every distillation tool's Errors list below.

This boundary is explicit because the principle "agents cannot write durably" (`thesis.md` § 7) admits one exception: the manual promote path, which the user has explicitly authorized by minting a daemon-signed token out-of-band. The memory MCP instance must be launched with `MEMORY_ROLE=distillation` (see § Privilege levels → SCOPE_BLOCKED via launch-identity); the instance therefore accepts distillation-only tools. Agent-spawned instances default to `MEMORY_ROLE=agent` and get `SCOPE_BLOCKED` at step 0. The caller presents a daemon-signed confirmation token (a screening signal, not an OS-role boundary against same-uid attackers — see Threat model preamble) derived from the daemon signing key (`loadSigningKey` in `mcp/lib/daemon-token.js`). The conversational-pipeline path that originally drove this surface is retired; see `kb/legacy-archive.md`.

`memory_distill_promote_fact` verifies `source_policy.consent_basis` on every referenced source event before promoting. A `third_party_inferred` source event may still promote, but with reduced recall ranking weight and no verbatim quoting in briefs — see `ingestion.md` § Consent-aware promotion. The check happens at this layer, not at recall.

### `memory_distill_promote_fact`

Description: "Distillation-only. Promote a raw source event (or set of correlated events) into the memory ledger as a fact."

Privilege: `privileged`.

Input:

```
{
  source_refs: [ { source: string, source_msg_id: string } ],   // 1..16
  content: string,                          // <= CONTENT_MAX_CHARS (16384); the distilled fact
  derived_from?: string[],                  // memory ids if this is an inference
  provenance: {
    agent_id: string,
    conversation_id: string | null,         // null when promoted from non-chat source
    confidence: "high" | "medium" | "low" | "pre_distilled"
  },
  confirmation_token: string                // REQUIRED; daemon-signed.
                                            //   Binding object: {source_refs_hash, content_hash}
                                            //   source_refs_hash = sha256(canonical_json(source_refs))
                                            //   content_hash     = sha256(content)   // raw utf-8 bytes
}
```

`source_refs`, `content`, `provenance` (with all three of `agent_id`, `conversation_id`, `confidence`) and `confirmation_token` are required; `derived_from` is optional. No other field is accepted — in particular there is no `features` argument: entities, time anchors, valence and the embedding are computed server-side.

Output `data`:

```
{
  memory_event_id: string | null,           // null when dedupe_action == "corroborated_existing"
                                            //   (no new fact row appended)
  promoted_at: string,
  dedupe_action: "promoted" | "corroborated_existing" | "linked_via_derivation",
  corroborated_into?: string,               // existing memory id, when dedupe_action == "corroborated_existing"
  corroboration_event_id?: string,          // the policy-kind row appended for the corroboration;
                                            //   targets memory_rescind_policy
  linked_to?: string                        // existing memory id, when dedupe_action == "linked_via_derivation"
}
```

Errors, in verification order (earlier errors fire before later checks even run):

1. `SCOPE_BLOCKED` — caller not in distillation role. Fires before payload parse.
2. `INVALID_ARGUMENTS` — payload shape, cap violations, missing `confirmation_token`.
3. `PRIVILEGE_REQUIRED` — token verification failed (type/freshness, signature, binding, or replay; reason logged to `policy-events-YYYY-MM.jsonl` AND surfaced to the caller as `error.details.reason` from the vocabulary in § Logging — debugging legitimate clients needs the discriminator, and the only adversarial info-leak risk left on the table is a timing-side-channel between differential code paths, which the spec already accepts as in-scope for the threat model. The raw token, binding-hash preimage, and signing key MUST NOT appear in `error.details`; only the symbolic reason string. Same step ordering as § Privilege levels → Daemon-signed token verification).
4. `NOT_FOUND` — a `source_refs[i]` does not resolve in any source ledger.
5. `CONSENT_BLOCKED` — `source_policy.consent_basis` on any `source_refs[i]` forbids promotion.
6. `STATE_CONFLICT` — cross-source dedupe surfaces a hard conflict not resolvable by the three `dedupe_action` outcomes.
7. `INTERNAL_ERROR` — anything else.

**Handler steps (normative).** The verifier runs these in order; the first failure terminates the call:

1. Scope check via `MEMORY_ROLE` launch-identity env (SCOPE_BLOCKED if env is not `"distillation"` — see § Privilege levels → SCOPE_BLOCKED via launch-identity). Runs before payload parse.
2. Payload validation (caps, required-field presence including `confirmation_token`).
3. Daemon-signed token verification — the five-step sequence from § Privilege levels → Daemon-signed token verification (normative). This step encompasses **all five sub-steps**: type-and-freshness, signature, binding, nonce single-use append, and tool-specific consent. Subsequent handler steps assume the five-step sequence has succeeded (token is verified, nonce is consumed, consent has passed). Binding object is `{source_refs_hash, content_hash}` where:
   - `source_refs_hash = sha256(canonical_json(source_refs))` — JCS preserves array insertion order, so the minter must hash and submit in the same order. A minter that sorts refs before hashing is non-conformant.
   - `content_hash = sha256(content)` — raw UTF-8 bytes of the `content` field, NOT canonicalized. NFC normalization MUST NOT be applied at hash time (same discipline as the non-ASCII probe in § Privilege levels).
4. Dedupe (`ingestion.md § Cross-source dedupe at salience`) → one of `promoted | corroborated_existing | linked_via_derivation`.
5. Ledger append (`fact`-kind or `policy`-kind `corroboration` row, per dedupe outcome).
6. Return envelope.

The earlier dual listing (separate handler steps for "Nonce append" and "Source-ledger consent check") was redundant: those are sub-steps of the five-step sequence that runs inside handler step 3. The five-step list in § Privilege levels is the single normative ordering for what happens *inside* token verification; the handler list above is the ordering for *outside* it (scope, payload-shape, dedupe, write).

**Caller boundary.** The original callers were the distillation supervisor (now retired; see `kb/legacy-archive.md`) and the hook bridge (see `agent-integration.md`). Today a caller is the user, or a script acting for the user, minting one daemon-signed token per call from the signing key, with `expires_at = issued_at + DISTILLATION_TOKEN_TTL_SECONDS`. The hook bridge promoting auto-memory `pre_distilled` entries is the inaugural caller; every promotion of an auto-memory entry into the memory ledger flows through this tool with `provenance.confidence: "pre_distilled"` and the corresponding `source_refs` pointing at `storage/sources/auto-memory.jsonl`.

A CONSENT_BLOCKED failure during the five-step sequence (specifically its step 5, Tool-specific consent — which runs inside handler step 3) still leaves the nonce consumed — the caller must mint a fresh token for the retry, which is correct (consent state may have changed between calls; re-binding forces fresh review).

The `pre_distilled` confidence is the bridge for Claude Code's auto-memory entries described in `agent-integration.md` § Bridging Claude Code's auto-memory — those bypass the salience filter on first pass.

`dedupe_action` encodes the cross-source dedupe outcomes from `ingestion.md` § Cross-source dedupe at salience:

- `promoted` — no near-duplicate found; new `fact`-kind row appended. `memory_event_id` is its id.
- `corroborated_existing` — near-duplicate found with high confidence; **no new fact row** is appended (the prior memory row is not mutated, per `architecture.md` § Memory ledger). Instead, a `policy`-kind row with `policy_kind: "corroboration"`, `targets: [corroborated_into]`, and `payload: {source_ref: <the new source ref>}` is appended. The projection joins it with the existing fact at read time; `memory_get`'s `source_refs[]` returns the union with `via: "corroboration"` marking the new entries. `memory_event_id` is null; `corroboration_event_id` is the appended policy row's id (targets `memory_rescind_policy`).
- `linked_via_derivation` — ambiguous match; new `fact`-kind row appended with `derived_from` linking the prior memory. `memory_event_id` is the new fact; `linked_to` echoes the prior.

### `memory_distill_emit_reconstructed`

Description: "Distillation-only. Emit a reconstructed memory derived from existing parents (agent-driven summarization)."

Privilege: `privileged`. Like every distillation tool it returns `SCOPE_BLOCKED` unless the server was launched with `MEMORY_ROLE=distillation`.

Input:

```
{
  parents: string[],                        // required; 1..16 memory ids the reconstruction is derived from
  content: string,                          // required; 24..CONTENT_MAX_CHARS (16384) chars
  scope: "conversation_local" | "agent_role_scoped" | "cross_session",   // required
  confidence?: number,                      // optional; 0..1
  agent_role?: string,                      // optional
  conversation_id: string,                  // required
  confirmation_token: string                // required; daemon-signed. Binding object:
                                            //   {content_hash, parent_set_hash, conversation_id, scope}
                                            //   content_hash    = sha256(content)   // raw utf-8 bytes
                                            //   parent_set_hash = sha256(canonical_json(sorted(parents)))
}
```

No other field is accepted (`additionalProperties: false`) — there is no `derived_from`, `features`, or `provenance` argument; the parent set is `parents`.

Output `data`:

```
{
  memory_event_id: string,
  dedupe_action: "appended" | "rejected_idempotent",   // "rejected_idempotent": an identical emit already
                                                       //   exists; memory_event_id is the prior row's id
  dropped: false
}
```

Errors: `SCOPE_BLOCKED` (caller not in distillation role), `INVALID_ARGUMENTS`, `PRIVILEGE_REQUIRED` (token rejected; `error.details.reason` carries the symbolic reason), `NOT_FOUND` (a `parents` id is missing or is not a valid parent kind), `STATE_CONFLICT` (a parent is excised or transitively orphaned), `INTERNAL_ERROR`. On `NOT_FOUND` / `STATE_CONFLICT` the nonce is already consumed and `error.details` carries `{reason, dropped, drop_reason}`; a retry needs a fresh token.

Trigger boundary for `reconstructed` is fuzzy and unresolved — see `open-problems.md` § 6.

---

## Planned, not implemented

The names below appear in the design (`build-plan.md`, `operations.md`) and in earlier revisions of this page. **The server does not register any of them**: they are absent from `tools/list`. Calling one returns `NOT_FOUND` (`Unknown tool`), with one exception: `memory_distill_emit_policy` is already in the dispatch layer's distillation-only set (`DISTILLATION_ONLY_TOOLS` in `mcp/lib/dispatch.js`), so on a default-role server it returns `SCOPE_BLOCKED` before the registry is consulted; on a server launched with `MEMORY_ROLE=distillation` it passes that gate and returns `NOT_FOUND` like the rest. They are listed so a reader who meets a name elsewhere in `kb/` knows its status; nothing here is a callable contract.

- `memory_replace` — append a new fact that supersedes an old one within a scope.
- `memory_substitute` — reframe a fact's content under audit, keeping the original in the ledger.
- `memory_excise` — privileged destructive removal that propagates through the derivation graph.
- `memory_walk_derivation` — bounded walk of the derivation graph from a memory id.
- `memory_connector_pause` — privileged pause of an ingestion connector.
- `memory_connector_resume` — privileged resume of a paused connector.
- `memory_quarantine_list` — list quarantined raw events awaiting review.
- `memory_quarantine_approve` — privileged release of a quarantined entry into the salience pipeline.
- `memory_quarantine_excise` — privileged deletion of a quarantined entry without releasing it.
- `memory_distill_emit_policy` — distillation-only emit of `replace` / `substitute` / `corroboration` policy events.

Also not implemented: user-issued confirmation-token issuance. Its only registered consumer is `memory_exclude` with `scope: "global"`, which therefore always returns `PRIVILEGE_REQUIRED`.

## Current status

Fourteen tools are registered (`mcp/lib/dispatch.js`); `memory_health.tools_registered` reports the live count.

- **Default privilege, callable on a default-role server:** `memory_recall`, `memory_exclude` (scoped only), `memory_rescind_policy`, `memory_get`, `memory_get_predicate`, `memory_list_predicates`, `memory_health`, `memory_connectors_list`, `memory_connectors_revoke`, `memory_catchup`, `memory_catchup_feedback`.
- **Default privilege, gated:** `memory_put` — callable with no opt-in only on a standalone first run with no vector index; on any other install launch the server with `MEMORY_PUT_ENABLED=1`. `MEMORY_PUT_ENABLED=0` forces it off. A put made that way is not returned by `memory_recall` by default: it has no embedding, no re-embed sweep entry is written (only the re-embed drain's opt-in `REEMBED_WORK_SET=ledger` mode finds it), and it is lexically indexed only under `MEMORY_BM25_DECOUPLE_EMBED=1` (default off).
- **Privileged, distillation role only:** `memory_distill_promote_fact` and `memory_distill_emit_reconstructed` — the server must be launched with `MEMORY_ROLE=distillation` and each call carries a daemon-signed `confirmation_token`. Daemon-signed token verification, the consumed-nonce store, the `policy-events-YYYY-MM.jsonl` audit log, `SCOPE_BLOCKED` and `CONSENT_BLOCKED` are all live.

`memory_connectors_list` is live and multi-source: it reports every installed connector, not a single-ledger placeholder.

Routine promotion into the memory ledger is done by the row-by-row salience cascade (`kb/salience-design.md`), not by a tool call; the conversational-distillation pipeline that once drove `memory_distill_promote_fact` was retired (see `kb/legacy-archive.md`), and the tool remains as the manual promote surface.

Everything else this design names is in § Planned, not implemented.

## Cross-references

- Envelope/error-code pattern: `mcp/lib/envelope.js`, `mcp/lib/error-codes.js`.
- Bounded-brief discipline: `enforceBriefCaps` in `mcp/lib/recall/mmr.js`.
- Confirmation-token discipline: `mcp/lib/daemon-token.js` (signing key, mint, verify) and `mcp/lib/nonce-store.js`.
- Predicate semantics: `kb/operations.md` § exclude.
- Recall output shape: `kb/operations.md` § recall.
- Consent enforcement at write: `kb/ingestion.md` § Consent-aware promotion.
- Propose-back UX pattern: `kb/open-problems.md` § 2.
- Silent-excise paradox (design for the planned excise verb): `kb/open-problems.md` § 4.
- Screening-layer rationale: `kb/thesis.md` § 7 (privilege model is screening + audit, not a boundary against same-uid attackers).
