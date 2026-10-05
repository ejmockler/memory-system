// template-dedup.js
//
// Shared boilerplate/template cluster-dedup helper.
//
// Background (F-CROSS-TEMPLATE-DEDUP, cross-source):
//   * git-log has 15,574+ WIP/Checkpoint/Cleanup/Fix typo/Remove dead code/
//     chore: rows.
//   * codex-cli has 1,500+ "Still X.", "Another X.", "N more passed." filler.
//   * iMessage has hundreds of exact-template duplicates (vendor pickup
//     reminders, membership renewals, "Reply 1 to cancel").
//
//   All are templated low-signal text the embedder will cluster tightly.
//   Each source had no shared infrastructure for "have I seen this exact
//   template enough times from this sender within this window?".
//
// Critic-modified contract (per node critic_modifications, derived from
// GIT_LOG-F7 adversarial verdict):
//   * BLOCK git-log template dedup until %B body or --numstat capture
//     lands (F-META-GIT-LOG-NUMSTAT). Subject-only is dangerous — "WIP:
//     refactor the salience cascade" and "WIP" are not the same row.
//   * iMessage and codex-cli can ship now (their text fields capture the
//     entire payload).
//   * Operator-meaningful template messages (renewal reminders, court
//     dates) MUST be preserved. The cluster-counter operates on
//     (hash, sender_or_class) — a single renewal reminder from a single
//     business never crosses the threshold; only the Nth identical
//     marketing blast does.
//
// Contract:
//
//   const cluster = createTemplateClusterCounter({
//     thresholdK: 5,            // PASS the first K-1, DROP the Kth+
//     windowMs:   24*3600*1000, // sliding window
//     memoryBudget: 10_000,     // max distinct (hash,sender) keys
//   });
//
//   cluster.observe({hash, sender, ts})
//     -> { count, dropped, dropReason }
//
//   * count        : occurrences within the window after this observation
//   * dropped      : true ⇔ count >= thresholdK
//   * dropReason   : 'template_dedup' when dropped, else null
//
// The caller computes `hash(text)` (any stable string digest — e.g. SHA-1
// of `text.trim().toLowerCase()`) and supplies `sender` (or a "class"
// string like "imessage:shortcode-marketing"). The library is pure
// bookkeeping; it does not run regexes or content-classify.
//
// Memory bound:
//   When the in-memory Map exceeds `memoryBudget`, the LRU half is evicted.
//   This is a soft bound — the budget is documented per-source. Eviction
//   biases toward "old sparse senders forgotten first", which is the
//   correct behaviour: a chatty templated sender's recent counts survive.
//
// ES module. No external dependencies.

// ---------------------------------------------------------------------------
// Defaults (chosen to be safe — callers SHOULD override per source).
// ---------------------------------------------------------------------------
export const DEFAULT_THRESHOLD_K = 5;
export const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
export const DEFAULT_MEMORY_BUDGET = 10_000;

// ---------------------------------------------------------------------------
// makeKey(hash, sender)
//
// Stable cluster key. Both components are coerced to strings; missing
// sender is normalised to the empty string so callers that only have the
// hash (e.g. a "class" of bulk-marketing) get a deterministic key.
// ---------------------------------------------------------------------------
export function makeKey(hash, sender) {
  const h = typeof hash === "string" ? hash : String(hash || "");
  const s = typeof sender === "string" ? sender : String(sender || "");
  return `${h}::${s}`;
}

// ---------------------------------------------------------------------------
// createTemplateClusterCounter(opts)
//
// Returns an object with `observe(obs)`, `peek(obs)`, and `reset()`.
//
// observe(obs):
//   obs = { hash, sender, ts? }   ts is ms-epoch; defaults to Date.now()
//   * Trims the entry's timestamps to within the window.
//   * Appends the new timestamp.
//   * Returns { count, dropped, dropReason }.
//
// peek(obs):
//   Read-only: same return shape as observe(), but does NOT record the
//   observation. Useful for "what would happen if I emitted this row?".
//
// reset():
//   Wipes the Map. For tests and for daemon restart in absence of
//   persistence (the library is in-process only).
// ---------------------------------------------------------------------------
export function createTemplateClusterCounter(opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const thresholdK = Number.isFinite(options.thresholdK) && options.thresholdK > 0
    ? Math.floor(options.thresholdK)
    : DEFAULT_THRESHOLD_K;
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? Math.floor(options.windowMs)
    : DEFAULT_WINDOW_MS;
  const memoryBudget = Number.isFinite(options.memoryBudget) && options.memoryBudget > 0
    ? Math.floor(options.memoryBudget)
    : DEFAULT_MEMORY_BUDGET;

  // Map<key, number[]> where the value is the ms-epoch timestamps within
  // the active window. Append-and-trim keeps the slice bounded by the
  // sender's emission rate within `windowMs`.
  const counts = new Map();
  // LRU tracker: parallel Map<key, lastSeenMs>. Used only when we need
  // to evict under memoryBudget pressure.
  const lru = new Map();

  function _trim(entry, now) {
    const cutoff = now - windowMs;
    let i = 0;
    // Timestamps are appended in monotonic order; the in-window slice
    // is the suffix from the first ts >= cutoff.
    while (i < entry.length && entry[i] < cutoff) i += 1;
    if (i > 0) entry.splice(0, i);
    return entry;
  }

  function _evictIfOver() {
    if (counts.size <= memoryBudget) return;
    // Evict the oldest half by LRU last-seen. Soft bound; keeping chatty
    // senders' state alive is the correct bias.
    const sorted = [...lru.entries()].sort((a, b) => a[1] - b[1]);
    const toEvict = Math.floor(counts.size / 2);
    for (let i = 0; i < toEvict; i += 1) {
      const [k] = sorted[i];
      counts.delete(k);
      lru.delete(k);
    }
  }

  function _observeOrPeek(obs, record) {
    const ts = typeof obs?.ts === "number" && Number.isFinite(obs.ts)
      ? obs.ts
      : Date.now();
    const key = makeKey(obs?.hash, obs?.sender);

    const existing = counts.get(key);
    const entry = Array.isArray(existing) ? existing.slice() : [];
    _trim(entry, ts);
    entry.push(ts);

    const count = entry.length;
    const dropped = count >= thresholdK;
    const dropReason = dropped ? "template_dedup" : null;

    if (record) {
      counts.set(key, entry);
      lru.set(key, ts);
      _evictIfOver();
    }

    return { count, dropped, dropReason };
  }

  return {
    observe(obs) { return _observeOrPeek(obs, true); },
    peek(obs)    { return _observeOrPeek(obs, false); },
    reset() { counts.clear(); lru.clear(); },
    // Diagnostic — for tests and operator audit only. NOT a public API.
    _size() { return counts.size; },
    // Configuration introspection.
    config() {
      return Object.freeze({ thresholdK, windowMs, memoryBudget });
    },
  };
}

// ---------------------------------------------------------------------------
// hashTemplateText(text)
//
// Convenience normaliser + DJB2-style 32-bit hash. Strips leading/trailing
// whitespace, lower-cases, then hashes. Callers that need a stronger hash
// (cryptographic, or cross-process stable) should compute their own and
// pass it to observe()/peek() directly.
//
// Stable within a single process / single Node version. NOT a security
// boundary — this is a clustering aid for low-signal templated text.
// ---------------------------------------------------------------------------
export function hashTemplateText(text) {
  if (typeof text !== "string" || text.length === 0) return "0";
  const norm = text.trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < norm.length; i += 1) {
    h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
  }
  // Unsigned, base36 for compactness.
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Per-source recommendations. Callers may override; these are documented
// defaults derived from the predicate evidence:
//
//   imessage: 807 exact-template dupes from a small set of marketing
//             shortcodes. K=3 within 7 days catches the Nth blast while
//             preserving the first 2 (so a real "renewal due" reminder
//             from a single sender still reaches the operator).
//
//   codex-cli: 1,500+ "Still X." / "Another X." / "N more passed." filler
//              from a single agent class. K=5 within 24h is conservative
//              given that operator-meaningful repetition is rare in a
//              single day from a single agent.
//
//   git-log:   BLOCKED until %B body capture lands. The export below is
//              deliberately commented out to make accidental import
//              visible at code review.
// ---------------------------------------------------------------------------
export const RECOMMENDED_BY_SOURCE = Object.freeze({
  imessage: Object.freeze({
    thresholdK: 3,
    windowMs: 7 * 24 * 3600 * 1000,
    memoryBudget: 5_000,
  }),
  "codex-cli": Object.freeze({
    thresholdK: 5,
    windowMs: 24 * 3600 * 1000,
    memoryBudget: 10_000,
  }),
  // git-log INTENTIONALLY OMITTED. See header — blocked until --numstat
  // / %B body capture lands (F-META-GIT-LOG-NUMSTAT).
});

export default {
  DEFAULT_THRESHOLD_K,
  DEFAULT_WINDOW_MS,
  DEFAULT_MEMORY_BUDGET,
  RECOMMENDED_BY_SOURCE,
  makeKey,
  hashTemplateText,
  createTemplateClusterCounter,
};
