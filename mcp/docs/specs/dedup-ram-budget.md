# Dedup RAM Budget Specification

**Node:** F-META-DEDUP-RAM-BUDGET
**Status:** SPEC — pending implementation
**Severity:** major
**Owner:** memory-system core
**Blocks:** F-INFRA-DEDUP-FULLSCAN

---

## Problem

Memory growth from in-process dedup Sets is not bounded. Per-source
`Set<source_msg_id>` instances are held in RAM by every connector that has
escaped the base class's bounded tail dedup. Concretely:

| Source     | Current ledger rows | Per-row key size (approx) | Set bytes (approx) |
|------------|---------------------|---------------------------|--------------------|
| git-log    | ~670,000            | 36 bytes (`git:<hash>:<sha>` + Set overhead) | ~75 MB |
| codex-cli  | ~33,000             | 28 bytes                  | ~3 MB   |
| screentime | ~19,000             | 30 bytes                  | ~2 MB   |
| imessage   | ~15,000             | 26 bytes                  | ~1 MB   |
| mail       | (variable)          | 40 bytes                  | (variable) |
| github     | (variable)          | 24 bytes                  | (variable) |
| codex-runtime| (variable)        | 24 bytes                  | (variable) |
| **system_prompt_hashes** | (recall-time cache) | 64 bytes | (variable) |
| **cross-source caches**  | (variable)         | (variable) | (variable) |

The audit treats Stage-0 dedup as a correctness fix and ignores the RAM
footprint. After F-INFRA-DEDUP-FULLSCAN ships across all sources, the
cumulative resident set can easily exceed 200 MB and grow unbounded as
ledgers grow. There is no eviction policy, no high-water alert, and no
fallback when the budget is exceeded.

## Goal

Codify a per-source RAM budget for every in-process dedup Set, an
LRU-style eviction policy when the budget is exceeded, a Bloom-filter
fallback that lets us bound memory at the cost of a documented
false-positive rate, and a telemetry surface for resident-set growth so
the user can detect drift.

## Per-source RAM caps

CAPS additions in `mcp/lib/validation.js`:

```js
DEDUP_MAX_BYTES_PER_SOURCE: {
  "git-log":     150 * 1024 * 1024,  // 150 MB — git-log is the worst offender
  "codex-cli":    20 * 1024 * 1024,
  "screentime":   10 * 1024 * 1024,
  "imessage":     10 * 1024 * 1024,
  "mail":         30 * 1024 * 1024,
  "github":       10 * 1024 * 1024,
  "codex-runtime":10 * 1024 * 1024,
  "system_prompt_hashes": 5 * 1024 * 1024,
  "cross-source": 20 * 1024 * 1024,
  default:        10 * 1024 * 1024,
},
DEDUP_HIGH_WATER_RATIO: 0.85,        // emit a stderr warning at 85% of cap
DEDUP_OVERFLOW_STRATEGY: "bloom",    // "bloom" | "lru-evict" | "tail-fallback"
DEDUP_BLOOM_FALSE_POSITIVE_RATE: 0.001,  // 0.1% — keys collide ~1 in 1000
```

Each cap is informed by current ledger sizes × growth headroom (3-5×
factor). The git-log cap is the most generous because that source is the
most likely to outgrow it; the others are tight to surface drift.

## Resident-set measurement

Implementation: the dedup Set lives behind a small wrapper class
`BoundedDedupSet` in `mcp/lib/ingest/dedup.js`. The wrapper tracks
approximate bytes-per-entry:

```js
class BoundedDedupSet {
  constructor({ source, maxBytes, perEntryOverhead = 56 /* V8 Set entry */ }) {
    this.source = source;
    this.maxBytes = maxBytes;
    this.perEntryOverhead = perEntryOverhead;
    this._set = new Set();
    this._approxBytes = 0;
    this._evictedCount = 0;
    this._fallbackEngaged = false;
    this._bloom = null;  // engaged lazily under DEDUP_OVERFLOW_STRATEGY=bloom
  }
  add(key) {
    const size = key.length * 2 /* UTF-16 chars */ + this.perEntryOverhead;
    if (this._approxBytes + size > this.maxBytes) {
      this._engageOverflow();
    }
    if (this._fallbackEngaged) {
      this._bloom.add(key);
      return;
    }
    if (!this._set.has(key)) {
      this._set.add(key);
      this._approxBytes += size;
    }
  }
  has(key) {
    if (this._set.has(key)) return true;
    if (this._fallbackEngaged && this._bloom.has(key)) return true;
    return false;
  }
}
```

`_engageOverflow()` switches based on `DEDUP_OVERFLOW_STRATEGY`:
- `bloom` — initializes a sized Bloom filter with the configured
  false-positive rate and absorbs all subsequent adds.
- `lru-evict` — drops the oldest 10% of keys (requires an insertion-order
  queue; the JS Set already iterates in insertion order).
- `tail-fallback` — falls back to ConnectorBase's bounded tail-dedup;
  emits stderr warning that the source has exceeded budget and is now in
  reduced-correctness mode.

Default is `bloom`. The Bloom filter has zero risk of false negatives
(every truly-duplicate row is correctly dropped) and a documented
false-positive rate (some unique rows are incorrectly classified as
duplicates and DROPPED before emit). For dedup specifically, false
positives ARE acceptable at 0.1% — the user loses one row per
thousand at the budget edge; the corroboration system absorbs the loss.

## Bloom filter sizing

For a desired false-positive rate `p` and expected key count `n`:

```
m = -(n * ln(p)) / (ln(2)^2)   // bits
k = (m/n) * ln(2)              // hash functions
```

At p=0.001 and n=1,000,000: m ≈ 14.4 Mbit ≈ 1.8 MB; k=10. The Bloom
filter is itself bounded by `DEDUP_MAX_BYTES_PER_SOURCE` — the wrapper
sizes the filter on engagement to fit the remaining budget. If even the
filter would exceed budget, the wrapper falls through to
`tail-fallback` and emits a HARD warning.

## Telemetry

Per `mcp/lib/ingest/dedup.js` wrapper, expose:

```js
getStats() {
  return {
    source: this.source,
    backing: this._fallbackEngaged ? "bloom" : "set",
    entries: this._set.size,
    approx_bytes: this._approxBytes,
    max_bytes: this.maxBytes,
    utilization: this._approxBytes / this.maxBytes,
    evicted_count: this._evictedCount,
    bloom_fp_rate: this._fallbackEngaged ? this._bloom.fp_rate : null,
  };
}
```

Sources surface `getStats()` through `getDedupStats()` (existing pattern
in `git-log-local.js`). The supervisor / `memory_connectors_list` reads
the union and emits a stderr warning when any source crosses the
high-water ratio.

Per-day rollup row appended to
`storage/telemetry/dedup_budget_<UTC-date>.jsonl`:

```json
{ "ts": "ISO", "source": "git-log", "entries": 670123,
  "approx_bytes": 95000000, "max_bytes": 157286400,
  "backing": "set", "fallback_engaged": false }
```

## Graceful degradation order

1. Set ≤ high-water ratio: business as usual.
2. Set crosses high-water: emit stderr warning, surface in
   `memory_connectors_list.health.dedup_budget` = "warn".
3. Set at cap: engage overflow per `DEDUP_OVERFLOW_STRATEGY`. Health =
   "fallback".
4. Bloom filter at cap (rare): tail-fallback mode + hard stderr warning.
   Health = "degraded".

The degradation order is monotone: once a source is in `bloom` mode it
does NOT promote back to plain Set until the connector instance
restarts.

## Review questions (from node)

1. Is the per-source RAM ceiling documented?
   YES — `DEDUP_MAX_BYTES_PER_SOURCE` table above, with operator-tunable
   CAPS values.
2. Is the Bloom filter false-positive rate operator-acceptable?
   YES at 0.001 — losing 1-in-1000 rows at the budget edge is preferable
   to OOM. The rate is operator-tunable via CAPS.
3. Is there a graceful degradation path when ceiling is hit?
   YES — Section "Graceful degradation order" defines the four-stage
   monotone fallback.

## Files to touch (implementation, future PR)

- `mcp/lib/ingest/dedup.js` — new `BoundedDedupSet` wrapper
- `mcp/lib/validation.js` — CAPS additions
- `mcp/lib/connectors/git-log-local.js` — replace plain Set with wrapper
- `mcp/lib/connectors/*.js` — same for codex-cli, screentime, imessage,
  mail, github, codex-runtime, whatsapp, telegram
- `mcp/lib/recall/*.js` — system_prompt_hashes cache wrapping
- `mcp/lib/tools/memory_connectors_list.js` — surface budget stats in
  health output
- `storage/telemetry/` — new daily rollup file

## Risk

- Bloom filter introduces non-zero false-positive rate. Mitigated by
  small `p` and operator-tunable strategy.
- Approximate byte counter is exactly that — approximate. V8 internals
  may diverge by 2-3×. The cap is a budget, not a hard limit; the
  wrapper-side counter just decides WHEN to engage overflow.
- LRU eviction is incorrect for git-log because evicting an old
  source_msg_id allows it to re-emit. Hence `bloom` is the default for
  git-log; `lru-evict` is only safe when re-emit is acceptable (rare).
