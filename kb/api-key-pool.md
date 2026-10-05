# Gemini API Key Pool

R29 introduces multi-key rotation in `mcp/lib/gemini-client.js` to work around
the Gemini free-tier per-key daily quota (1500 req/day). R30 replaces the
original sticky-until-429 strategy with **round-robin rotation** and a
short **post-429 skip window** (default 60 seconds).

R29.1 hardens this with a boot-time key-shape validator and a throttled
cold-pool degrade path in the watermark daemon.

R30 swaps the 24h per-key cooldown for a 60s skip window so the daemon
recovers gracefully from per-minute rate limits and only stays parked when
the failure is genuinely per-day. Configure via
`CAPS.GEMINI_KEY_COOLDOWN_SECONDS` (default 60; set to 0 to disable the
skip window entirely).

## Accepted formats

The validator accepts two key shapes, applied to every entry in
`GEMINI_API_KEYS` (and to the legacy `GEMINI_API_KEY` when used as a
degenerate 1-key pool):

- Legacy: `^AIza[A-Za-z0-9_-]{35}$` (39 chars total)
- Current: `^AQ\.[A-Za-z0-9_-]{40,80}$` (43-83 chars total)

Any entry matching neither shape causes the daemon to fail-loud at boot
rather than 401-loop silently. The literal placeholder token
`REPLACE_WITH_COMMA_SEPARATED_KEYS` is rejected explicitly with a message
pointing at the plist path so the user knows where to edit.

Both formats may coexist in the same pool — the user can mix legacy
`AIza...` keys with new `AQ....` keys during rotation.

## Populating GEMINI_API_KEYS

Format: comma-separated, no spaces, no quotes, no trailing comma.

Example (placeholder bytes only):

```
GEMINI_API_KEYS=ABCxxx1,DEFxxx2,GHIxxx3
```

Back-compat: the legacy `GEMINI_API_KEY` is treated as a degenerate 1-key
pool if `GEMINI_API_KEYS` is absent or empty. When both are set,
`GEMINI_API_KEYS` wins and `GEMINI_API_KEY` is ignored.

Hard cap: `GEMINI_KEY_POOL_MAX_SIZE` (default 32). Pools larger than the
cap are truncated.

## Rotation + skip-window semantics (R30)

Each embed call rotates to the next key (round-robin). The scheduler
advances `_lastUsedIndex` on every pick and walks the ring from there;
load spreads evenly across all `N` keys.

When a key returns 429 (or 403, per R29.2), it is **skipped** for the
next `CAPS.GEMINI_KEY_COOLDOWN_SECONDS` (default 60). After the window
elapses, the key is re-eligible on its next ring turn.

If all keys are within their skip window simultaneously, the client
throws `KeyPoolExhaustedError` with `next_retry_at_iso` set to the
earliest `last429_ts + cooldown_seconds` across the pool. The watermark
daemon's `wrapEmbedderWithThrottle` catches this and the cascade routes
the row to the EMBED_DEFERRED cursor-park outcome (the row stays in the
source ledger; the next tick retries embedding). Per R29.3 the daemon
emits ONE throttled `watermark: all keys cooled until <iso>` line per
5-minute throttle window instead of one per row.

### Why 60s?

Google's Gemini API returns 429 for two distinct failures with no reliable
distinguisher in the response: per-minute rate limits (recover in ~1 minute)
and per-day quotas (reset at Pacific midnight). The 60s skip window is
indifferent to which limit hit:

- **Per-minute**: a key 429'd at t0 is skipped for 60s, then re-tried at
  t0+60s — by which time Google's per-minute window has elapsed. Daemon
  self-recovers.
- **Per-day**: every re-try in the next 24h also 429s; the
  ThrottledStructuralError layer absorbs the log; `next_retry_at_iso`
  keeps rolling forward as new 429s update the per-key timestamps. Daemon
  stays parked but with quiet stderr.

### Operator tuning

| Setting | When to use |
| ------- | ----------- |
| 60 (default) | Handles per-minute rate limits gracefully; safe default for most operators. |
| Higher (e.g. 300) | Set when persistent per-day quotas are the dominant failure mode; reduces pointless re-try traffic at the cost of slower per-minute recovery. |
| 0 (disabled) | Pure round-robin with no skip window; a key that 429'd 1ms ago is immediately eligible again on its next ring turn. Only useful in tests or when the user explicitly accepts the abuse-pattern risk (Google may treat this as rate-limit hammering). |

Override via `CAPS.GEMINI_KEY_COOLDOWN_SECONDS` in
`mcp/lib/validation.js`. There is no environment variable for this knob;
edits require an edit + daemon reload.

### State persistence

State is in-memory only. SIGTERM / launchd restart clears the
`_key429TsByIndex` ring. SIGUSR1 also clears in-flight skip state without
a full restart.

## Operator-facing error meanings

When stderr surfaces a `gemini-client:` line referencing a redacted key
prefix, the HTTP status drives both the rotation behavior and the
operator action required.

| Status | Rotation | Skip window | Meaning | Operator action |
| ------ | -------- | ----------- | ------- | --------------- |
| 200    | n/a      | none        | Success | none |
| 400    | no       | none        | Malformed request (client bug, not a key issue) | file a bug; the daemon should not have constructed this body |
| 401    | no       | none        | Invalid key bytes — wrong characters, revoked, or wrong API surface | open Google Cloud Console; revoke + regenerate the key matching the redacted prefix; update the plist and reload |
| 403    | YES      | 60s (R30)   | "Your project has been denied access" — the GCP project owning this key has not enabled the Generative Language API OR billing is suspended | open the Google Cloud project owning the key matching the redacted prefix; enable Generative Language API; confirm billing is active. The key is re-eligible after the 60s skip window AND on the next ring turn; persistent 403s will re-cool the key on each turn (effectively parking it) until fixed. |
| 429    | YES      | 60s (R30)   | Per-minute rate limit OR per-day quota exhausted (Google does not distinguish in the response) | per-minute: daemon self-recovers in ~60s. per-day: daemon stays parked; ThrottledStructuralError absorbs the log; wait for Pacific-midnight reset (free tier) or add more keys via the rollout procedure above. |
| 5xx / network | no | none | Gemini infrastructure failure | none — gemini-client retries same key with backoff (200/600/1800 ms) |
| KeyPoolExhaustedError | n/a | (all keys within skip window) | Every key in the pool is within the 60s post-429 skip window (any mix of 429s and 403s) | check `next_retry_at_iso` in the watermark throttle line; address whichever 403'd projects are fixable OR wait the 60s for the per-minute case OR wait for the per-day quota window. Send `SIGUSR1` after fixes to clear in-memory skip state without a full daemon restart. |

The redacted prefix in every line is the first 12 characters of the key
(per `redactKey()`) followed by `...`. That is enough entropy to pick the
matching key out of a 5-key pool in the Google Cloud Console without
exposing the secret bytes.

## Daemons that use the key pool

| Daemon                                           | Embeds? | `GEMINI_API_KEYS` in plist     |
| ------------------------------------------------ | ------- | ------------------------------ |
| `com.user.memory-system.watermark`               | yes (direct, via `embedSingle`/`embedBatch` in `daemons/watermark.js`) | yes (populated post-R29) |
| `com.user.memory-system.imessage-connector`      | no (source-tier capture only) | no — untouched by R29 |
| `com.user.memory-system.screentime-connector`    | no (source-tier capture only) | no — untouched by R29 |
| `com.user.memory-system.git-log-connector`       | no (source-tier capture only) | no — untouched by R29 |
| `com.user.memory-system.github-events-connector` | no (source-tier capture only) | no — untouched by R29 |

The connector plists do NOT carry credentials. A second embed-direct row
originally listed here (the Phase-1 conversational-pipeline supervisor
plist) was retired; see `kb/legacy-archive.md`.

## How to add a new key

1. Open the plist:

   ```
   ~/Library/LaunchAgents/com.user.memory-system.watermark.plist
   ```

2. Append the new key to the comma-separated string under the
   `GEMINI_API_KEYS` `<string>` element. No spaces, no trailing comma.

3. Lint:

   ```
   plutil -lint <path-to-plist>
   ```

4. Reload the affected daemon:

   ```
   launchctl unload <path-to-plist>
   launchctl load -w <path-to-plist>
   ```

5. On the next embed call, stderr will log
   `gemini-client: loaded N-key pool` where `N` reflects the new size.

## How to remove a key

When a key expires, is revoked, or you no longer trust it:

1. Edit the same plist(s); remove the key (and its leading or trailing
   comma) from the comma-separated string.
2. `plutil -lint` to validate.
3. `launchctl unload` + `launchctl load -w` to apply.
4. If a removed key was in cooldown, removal also flushes its cooldown
   state on restart (state is in-memory).

If the pool would become empty after removal, either restore at least one
working key OR remove the `GEMINI_API_KEYS` line entirely so the legacy
`GEMINI_API_KEY` fallback engages.

## Rollout procedure (full R29.1 cutover)

1. Generate / collect the keys you want in the pool. Keep them off shared
   surfaces; never paste them into review files or task notes.
2. Open the watermark plist and replace
   `REPLACE_WITH_COMMA_SEPARATED_KEYS` with the actual comma-separated
   list:

   ```
   ~/Library/LaunchAgents/com.user.memory-system.watermark.plist
   ```

3. Lint the edited plist:

   ```
   plutil -lint ~/Library/LaunchAgents/com.user.memory-system.watermark.plist
   ```

4. Reload the LaunchAgent:

   ```
   launchctl unload ~/Library/LaunchAgents/com.user.memory-system.watermark.plist
   launchctl load -w ~/Library/LaunchAgents/com.user.memory-system.watermark.plist
   ```

5. Verify rotation. On the first embed call after reload, stderr should
   log:

   ```
   gemini-client: loaded N-key pool
   ```

   where `N` is the pool size. Only a 12-char prefix of each key is ever
   logged; full keys are never written to stderr or to any review file.

6. On 429: stderr logs `gemini-client: key #N of M (prefix ...) hit 429,
   rotating to key #M (prefix ...)`, and subsequent embeds advance through
   the round-robin ring, skipping the 429'd key for the configured skip
   window (R30: 60s default). When all keys are within the skip window,
   the watermark daemon emits one throttled
   `watermark: all keys cooled until <iso>` line per 5-minute throttle
   window and the cascade routes affected rows to the EMBED_DEFERRED
   cursor-park outcome.

## Resetting skip state

Send `SIGUSR1` to the daemon to clear in-memory per-key 429 timestamps
(e.g. after a billing upgrade or quota top-up). A full
`launchctl unload / load -w` cycle also resets state. Either action makes
every key in the pool immediately eligible on the next round-robin turn.

## Operator security checklist

- [ ] Confirm `GEMINI_API_KEYS` in
      `com.user.memory-system.watermark.plist` is populated with the
      full pool (R29.1 state: done — 5 AQ-format keys).
- [ ] After the plist is populated and verified via `plutil -lint`,
      revoke the legacy `GEMINI_API_KEY` value in the Google Cloud
      Console.
- [ ] Once revoked, remove the `GEMINI_API_KEY` `<key>` /
      `<string>` pair from the plist. The pool already wins over the
      legacy single-key path; leaving a revoked key in the plist is
      harmless but inviting a future-you confusion.
- [ ] Re-run `plutil -lint` on the plist after the removal.
- [ ] `launchctl unload` + `launchctl load -w` the plist; tail
      `daemons/logs/watermark.stderr` for the
      `gemini-client: loaded N-key pool` line.
- [ ] Confirm no real key bytes appear in any review file, audit
      report, test fixture, or chat transcript. The validator logs and
      cooldown logs redact to a 12-char prefix.
- [ ] Rotate keys at least every 90 days; on rotation, the
      add-then-remove sequence above keeps the pool warm with zero
      embed downtime.

## Workspace markdown / artifact discipline (R29.3)

Workspace markdown files (README.md, kb/**, any
top-level *.md) must never commit raw key bytes. Use prefix-only
redaction (first 12 chars + `...`, e.g. `AIzaSyEXAMP...`,
`AQ.SYN0000_s...`).

- The `mcp/test/no-key-leakage-in-artifacts.test.mjs` regression test
  catches violations. Its scope was originally `kb/` + `mcp/lib/` +
  `mcp/test/`; R29.3 expanded it to include `<workspace-root>/*.md`
  (README.md and any other top-level file) after the R29.2 brutalist found a
  real key leaked in a top-level status file (since removed from the tree)
  that the original scope missed.
- The test allow-lists synthetic fixtures (`FAKE`, `JUNK`, `AIzaXX`,
  `synthetic`, `fixture`, `REPLACE_WITH`, `MOCK`, `test_not_used`); any
  match outside that allow-list is treated as a real leak.
- Plist files (`~/Library/LaunchAgents/*.plist`) remain exempt — they
  are the legitimate on-disk key store per operator decision and live
  outside the repo.
- When writing brutalist reviews, status updates, or operator runbooks
  that need to reference a leaked key, ALWAYS use the redacted prefix
  form. The reviewer / agent must never paste full key bytes into a
  tracked artifact, even when documenting that a leak was found.

## Operator post-cooldown verification (R29.4, hardened R29.5; R30 timing)

After the pool's skip window elapses (R30: 60s default, replacing the prior
R29 24h cooldown), OR after the per-day quota window passes (Pacific
midnight on the free tier), the watermark daemon will resume PROMOTE and
emit real production rows with embeddings into `ledgers/memory.jsonl`. To
verify the cascade-skip-on-embed-failure guarantee (R29.3) actually held —
that no row was promoted with a missing or malformed embedding — run:

```
node \
  "$MEMORY_ROOT"/mcp/scripts/verify-cascade-correctness.mjs
```

R29.5: strict checks (L2-norm within 1e-6 of 1.0, all-finite, non-zero) are
the DEFAULT. The previous loose default silently accepted zero-vector and
NaN-laced embeddings; the new default rejects them.

Flags:
- `--sample=N` (default 100): reservoir sample size.
- `--lenient`: opt out of the L2-norm + non-zero checks ONLY. The declared
  length and the all-finite check still run. Length is per-key, not a fixed
  768: `features.embedding_4096` must be 4096, `features.embedding_3072`
  must be 3072, and `features.embedding_mrl_768` / `embedding_mrl_768` /
  `features.embedding` / `embedding` must be 768. A wrong-length or
  non-finite vector is therefore STILL a FAIL under `--lenient`. Not
  recommended — exists for the rare debug case where the user wants to
  inspect partial-state rows without the norm check rejecting them.
- `--strict`: no-op alias preserved for back-compat with operator scripts
  written before R29.5. Strict is the default; passing it emits a one-line
  stderr note and has no behavioral effect.
- `--ledger=PATH`: override default ledger path (used by tests).

Only `kind: "fact"` rows are scored. `reconstructed` and `policy` rows are
counted into a `not_applicable` block and never scored — a
`policy_kind: "embedding_backfill"` row's `embedding` is the payload destined
for a DIFFERENT row (`target_fact_id`), not its own vector. The verdict is a
pure function of a FULL-CORPUS census computed in the single streaming pass;
`sampled` and `failed_ids_first_10` are the only sample-derived fields and
never affect the verdict.

**Expected result: `verdict: PARTIAL_INLINE_COVERAGE`, exit code 0.** Partial
inline coverage is the healthy steady state BY DESIGN — most vectors live in
the sidecar `indices/qwen3-embedding-8b-fp16/vectors.jsonl`, not inline on the
ledger row. Measured on the live ledger at 2026-08-11T22:56:46Z
(`ledgers/memory.jsonl` = 3,069,168,583 bytes):

```
verdict PARTIAL_INLINE_COVERAGE   exit 0
total_rows 1,519,025   smoke_rows 1,410,113
production_rows 108,912  =  fact 106,029 + reconstructed 1,832 + policy 1,051
policy_by_kind: embedding_backfill 701 | salience.recall_feedback 267
                | feature_backfill 83
fact_bucket_census: F-NULL-MARKER 93,894 | F-VALID-4096 12,132 | F-VALID-768 3
with_embedding 12,135   without_embedding 93,894   corrupt_fact_rows 0
bad_norm 0   pct_with_embedding 11.44%   unknown_kinds {}
```

The partition closes both ways, and that is the check to re-run rather than
matching any count above: the `fact_bucket_census` values sum to `fact_rows`
(93,894 + 12,132 + 3 = 106,029), and
`with_embedding + without_embedding + corrupt_fact_rows === fact_rows`
(12,135 + 93,894 + 0 = 106,029).

These counts drift upward continuously — the ledger is live. What must NOT
drift is the shape: `corrupt_fact_rows: 0` and `unknown_kinds: {}`.

**Absence of an inline vector is NOT corruption.** This script can only verify
the MALFORMED half of the R29.3 guarantee. An absent inline vector is not
evidence of a missing embedding, because the vector may be in the sidecar.
An explicit `null` under an embedding key is the NULL MARKER — it means
"we tried, there is no inline vector" (read at dispatch by
`mcp/lib/recall/multi-feature-score.js`) — and classes as ABSENT, never
corrupt.

All verdicts:
- exit 2 (no JSON emitted): ledger missing (`ENOENT`) or unreadable (any
  other errno). The stderr line distinguishes the two.
- `NO_PRODUCTION_ROWS` (exit 0): no post-wipe rows have been promoted yet.
  Wait for backfill progress and re-run.
- `UNKNOWN_ROW_KINDS` (exit 1): a non-smoke row carries a `kind` outside the
  censused set (`fact`, `reconstructed`, `policy`). The summary NAMES the
  kinds and their counts. Silent absorption of a new row kind is the exact
  pathology this check exists to close — investigate before doing anything
  else, because every other count may now be scoped wrongly.
- `NO_FACT_ROWS` (exit 0): non-smoke rows exist but none is `kind: "fact"`.
  Vacuous — neither pass nor fail. Nothing was verified.
- `FAIL` (exit 1) when `corrupt_fact_rows > 0`: at least one fact row carries
  a MALFORMED inline vector — wrong length, non-finite element, zero vector,
  bad norm, a non-array value, an envelope object on a fact row, or a shape
  the census cannot name. This is a real silent-promote or degraded-embedding
  path; reopen as R29.4+. `fact_bucket_census` names which shape, and the
  first 10 failing memory_ids are reported in `failed_ids_first_10`.
  Corruption always wins — a corrupt row FAILs whatever else is in the corpus.
- `PASS` (exit 0): zero corrupt and EVERY fact row carries a valid inline
  vector.
- `NO_INLINE_EMBEDDINGS` (exit 0): zero corrupt and zero valid — every fact
  row is absent. Healthy pure-sidecar shape.
- `PARTIAL_INLINE_COVERAGE` (exit 0): zero corrupt, some valid, some absent.
  Today's live state; see above.

### Smoke / seed row marker convention (R29.5)

Any writer that emits a smoke or seed row into `memory.jsonl` MUST set
`provenance.is_seed_row: true` on the row at construction time. The
verify-cascade reader checks this marker first, with the legacy heuristics
(`conversation_id === "conv_smoke"`, known smoke-content strings, or
`created_at < WIPE_THRESHOLD`) as fallback for the 3 pre-R29.5 legacy rows
in the current ledger. The one-shot backfill at
`<checkout>/mcp/scripts/backfill-seed-row-marker.mjs`
retrofits the marker onto those legacy rows. It is idempotent: re-runs on
an already-marked ledger are no-ops and report `updated=0`. Atomic write
via `tmp + fsync + rename`.

After backfill, all matching rows in `memory.jsonl` carry
`provenance.is_seed_row: true`. Future seed/smoke writers MUST set the
marker at construction time. Once no unmarked legacy rows remain in any
ledger, the back-compat fallback in `verify-cascade-correctness.mjs` can
be removed in a future round.

The script filters out pre-wipe smoke rows via the `WIPE_THRESHOLD` constant
(currently `2026-06-03T03:57:00Z`). Future ledger wipes MUST bump this
constant in `mcp/scripts/verify-cascade-correctness.mjs`.

## Out of scope (deferred)

- mlx local embedder (R30).
- Disk-persisted cooldown state.
- Per-tier quota tracking and auto-billing-upgrade detection.
