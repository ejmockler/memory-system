# A/B Parallel-Run Mechanism for Stage-0 Rule Changes

**Node:** F-META-AB-PARALLEL-RUN
**Status:** SPEC — pending implementation
**Severity:** major
**Owner:** memory-system core
**Depends on:** F-INFRA-R40-TELEMETRY

---

## Problem

Today, every Stage-0 rule change is ship-and-pray. There is no infrastructure
that lets the user observe the new rule's verdict alongside the old
rule's verdict on the SAME row, on the SAME corpus, in real time, before
committing the rule to production. For a corpus shift on the order of 96%
(git-log dedup, R41) this is an unacceptable engineering posture.

The audit roadmap codifies the rules but provides no comparison harness;
operators cannot answer:

1. "How many rows did the new rule DROP that the old rule PASSED?"
2. "How many rows did the new rule PASS that the old rule DROPPED?"
3. "What is the user-visible character of the disagreement set?"

Without those answers, every rule change is a blind cutover.

## Goal

Add a Stage-0 parallel-run mechanism that, for a configurable 7-day default
window, executes BOTH the old and new dispatch verdict on each row,
persists both verdicts to a shadow ledger, and supplies a diff CLI that
surfaces the per-source disagreement set. After operator sign-off, a
documented promotion step swaps the new ruleset into production. Old
shadow data ages out under a documented retention policy.

## Non-goals

- Real-time per-event UI. The diff CLI produces operator-readable JSONL
  windows; an interactive UI is out of scope for v1.
- Multi-way A/B (more than two rulesets). Two-way only; multi-way is a
  later expansion.
- Cross-source A/B coupling. Each source's old/new ruleset is independent
  of the others.

## Design

### 1. AB_MODE CAPS flag

Add to `mcp/lib/validation.js`:

```js
// CAPS additions
AB_MODE_ENABLED: false,           // master toggle
AB_MODE_SOURCES: [],              // list of source IDs (e.g. ["git-log"])
                                  // an empty list with AB_MODE_ENABLED=true
                                  // is an error; must be explicit per source.
AB_MODE_WINDOW_DAYS: 7,           // shadow ledger retention
AB_MODE_DISAGREEMENT_SAMPLE: 50,  // max rows per source per day to retain
                                  // in agreement-class buckets so the diff
                                  // CLI returns operator-friendly samples
                                  // (full-volume capture is reserved for
                                  // disagreement rows).
```

Env-overrides follow the existing CAPS convention (`AB_MODE_ENABLED=1`,
`AB_MODE_SOURCES=git-log,codex-cli`).

### 2. Dispatch shadow execution

Modify `mcp/lib/ingest/stage0/index.js::stage0Dispatch(row, source)`:

```js
if (CAPS.AB_MODE_ENABLED && CAPS.AB_MODE_SOURCES.includes(source)) {
  const oldVerdict = stage0DispatchOld(row, source);
  const newVerdict = stage0DispatchNew(row, source);
  writeShadowLedgerRow({
    source,
    source_msg_id: row.source_msg_id,
    ts: serverTs(),
    old_verdict: oldVerdict,   // {decision, reason}
    new_verdict: newVerdict,   // {decision, reason}
    agreement: oldVerdict.decision === newVerdict.decision,
    raw_content: redactRow(row),  // already-redacted; never raw secrets
  });
  // Production behavior: emit OLD verdict during the parallel run so
  // the live ledger is unchanged until promotion. This is the
  // load-bearing invariant: A/B never affects what hits the production
  // source ledger.
  return oldVerdict;
}
return stage0DispatchNew(row, source);  // default once A/B is off
```

Both implementations live in-process. The OLD rules are the
last-known-good production verdicts at the moment A/B is enabled; the NEW
rules are the candidate. We do NOT keep arbitrary historical versions.

### 3. Shadow ledger storage

Path: `storage/ab-ledgers/<source>/<UTC-YYYY-MM-DD>.jsonl`

One row per Stage-0 verdict-pair. Rotation is daily UTC, matching the
existing telemetry sink discipline. Retention is governed by
`AB_MODE_WINDOW_DAYS` (default 7). A nightly rotator (cron / launchd) deletes
files older than the retention window.

Row schema:

```json
{
  "ts": "ISO-8601",
  "source": "git-log",
  "source_msg_id": "git:abc123:def456",
  "old_verdict": { "decision": "PASS", "reason": null },
  "new_verdict": { "decision": "DROP", "reason": "git_log_upstream_repo_downgrade" },
  "agreement": false,
  "raw_content_redacted": { /* shape matches connector emit, with redactRow() applied */ }
}
```

Disagreement rows are written in full. Agreement rows are SAMPLED at
`AB_MODE_DISAGREEMENT_SAMPLE`/day/source to keep storage bounded — full
capture of the agreeing set is not necessary; the diff CLI primarily
serves the disagreeing set.

### 4. Storage budget

Per-source per-day budget:
- Disagreement rows: unbounded (their volume IS the signal).
- Agreement-sample rows: bounded by `AB_MODE_DISAGREEMENT_SAMPLE`.
- Total per-source per-day cap (soft): 100 MB. The rotator alerts via
  stderr and `memory_connectors_list` health channel when a file exceeds
  the cap. Operator can extend manually if needed.

Across 7 sources × 7 days × 100MB ≈ 4.9 GB worst case. Acceptable for
operator-machine usage.

### 5. Diff CLI

New file: `mcp/scripts/ab-diff.mjs`

Usage:
```
node mcp/scripts/ab-diff.mjs --source git-log --window 7d \
    [--decision-flip PASS_TO_DROP|DROP_TO_PASS|ANY] \
    [--reason <reason>] \
    [--sample N] \
    [--format table|json]
```

Outputs:
- Summary: per-source, per-decision-flip counts (PASS_TO_DROP, DROP_TO_PASS,
  PASS_PASS_REASON_FLIP, DROP_DROP_REASON_FLIP).
- Sample: N rows from the requested flip class, with side-by-side
  verdicts and the redacted raw_content. Default N=20.
- Reason histogram: top-K new-side reasons and old-side reasons within
  the flip class.

Acceptance: an operator can determine, in ≤2 minutes, whether the new
ruleset's disagreement set is mostly noise (safe to promote) or mostly
signal (DO NOT promote).

### 6. Promotion path

```
1. Operator runs ab-diff and accepts the disagreement set.
2. Operator sets CAPS.AB_MODE_ENABLED=false in the launch plist (or
   removes the source from AB_MODE_SOURCES for partial promotions).
3. Daemon restarts.
4. Old shadow ledger files age out under AB_MODE_WINDOW_DAYS.
5. The pre-promotion stage0DispatchOld code is REMOVED in the next
   commit. There is no "indefinite shadow" mode — A/B is a transient
   harness, not a permanent surface.
```

Failure-revert path: if the new ruleset proves bad post-promotion,
re-introduce the old code as the new "new" and the bad code as the
"old" inside a second A/B window. This restores symmetry.

## Telemetry hooks

- `recordDrop` is called only for the OLD verdict during shadow mode,
  matching the load-bearing invariant that A/B never changes production
  emit. NEW-verdict drops are visible only via the shadow ledger + diff
  CLI.
- The shadow ledger sink emits stderr warnings under three conditions:
  (a) shadow disk usage > soft cap; (b) shadow write failure (does NOT
  block production); (c) AB_MODE_SOURCES contains a source not registered
  in stage0Dispatch.

## Review questions (from node)

1. Does the shadow ledger correctly capture both old and new verdicts?
   YES — both verdicts plus an explicit `agreement` boolean for fast
   filtering.
2. Is the storage cost bounded?
   YES — per-day disagreement is unbounded by design (the signal IS the
   volume); agreement is sampled; 7-day rotation enforces decay; soft
   100MB/day/source alert protects against runaway corpora.
3. Can the diff CLI produce operator-friendly samples?
   YES — `--sample N` with optional `--decision-flip` / `--reason`
   filters.
4. Is there a documented promote-to-production path?
   YES — Section 6 above. Critical detail: post-promotion the
   `stage0DispatchOld` code path is REMOVED, not left dormant. A/B is
   transient.

## Open questions / future work

- Should A/B mode also write to a SEPARATE recall index so operators
  can run query-side experiments against the new corpus shape? Out of
  scope for v1; depends on F-META-SALIENCE-RECALIBRATION-PLAN.
- A 14-day window for slower-moving sources (mail, calendar) may be
  desirable; currently a single AB_MODE_WINDOW_DAYS governs all sources.
  Per-source override is a v2 enhancement.

## Files to touch (implementation, future PR)

- `mcp/lib/ingest/stage0/index.js` — dispatch shim
- `mcp/lib/connector-base.js` — pass-through unchanged
- `mcp/lib/validation.js` — CAPS additions
- `storage/ab-ledgers/` — new directory
- `mcp/scripts/ab-diff.mjs` — new CLI
- `mcp/scripts/ab-rotator.mjs` — nightly retention sweeper

## Risk

- Doubles compute per Stage-0 invocation during the window.
- Doubles disk write per Stage-0 invocation during the window (shadow
  ledger).
- Both are operator-machine acceptable but DO require a documented
  off-by-default discipline. The CAPS flag remains `false` outside the
  active A/B window.
