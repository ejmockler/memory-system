# Test Discipline

Conventions that every test under `mcp/test/` MUST follow. Violations have
historically produced flaky CI signal (R25.x) or false hermeticity failures
(R29.1 CRIT-3).

## 1. Hermeticity

Tests MUST NOT mutate any production path under `<MEMORY_ROOT>/`.
Specifically: `ledgers/memory.jsonl`, `indices/**`, `policy/**`,
`storage/**`, `ledgers/source-status.jsonl`.

Pattern:

1. `mkdtempSync(join(tmpdir(), "memory-system-<test-tag>-"))` at the very
   top of the test file.
2. Set `MEMORY_ROOT`, `POLICY_BASE_DIR`, `STORAGE_BASE_DIR`,
   `LEDGERS_BASE_DIR` to subpaths of the temp root.
3. **All of the above MUST happen BEFORE the first dynamic import** of any
   memory-system module. The configured modules read these env vars at
   import time.
4. Snapshot production path `(mtime, size)` before the test body; assert
   byte-identical after. The snapshot-and-assert step is the safety net
   that catches accidental mutations and concurrent-daemon false-positives.

## 2. Daemon-quiesce gate (R29.2, e10, e18)

Tests that snapshot production paths MUST gate on the watermark daemon being
idle. The daemon advances `storage/watermark-state/<source>.json` on every
per-source cursor move and appends to `ledgers/memory.jsonl` as it cascades.
If it ticks between snapshot-before and snapshot-after, the hermeticity
assertion fires even though THIS test never touched production — the daemon
did.

**Do not copy a state-file list into your test.** There is exactly one gate
and it lives in `mcp/test/_hermetic-daemon-skip.mjs`. Import it and call it
at the very top of the file, before any `test()` registration:

```js
import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("my-suite-tag");
```

That is the whole convention. Everything below is what the helper does for
you, and why hand-rolling it has repeatedly gone wrong.

**Why a copied list is a defect, not a shortcut.** Every private copy of this
gate that has existed in this repo drifted: they watched 1-2 files while ten
cascade sources shipped, and the first entry each one carried
(`policy/distillation-state.json`) stopped existing when R32 retired the
distiller — so the "gate" spent most of its stat calls on a phantom. e16-R2
burned a red byte-identity run on `mail`, a source no copy watched. A list
that is written down twice will disagree with itself; a list that is derived
once cannot.

**The set is DERIVED, and it is TIERED.** The helper builds both tiers from
`CAPS.WATERMARK_SOURCES` (the producer's own declaration — the same list
`daemons/watermark.js` iterates), dropping trailing-`*` wildcard entries:

- **WATCHED — every declared source.** Sampled at process exit by
  `armPostCheck`, which NAMES any file that advanced during the suite. This
  is the attribution that tells a real byte-identity regression apart from
  daemon interference. Watching never blocks, so nothing is left out.
- **GATING — the subset a suite actually waits on.** WATCHED minus
  `CAPS.WATERMARK_CAPTURED_ONLY_SOURCES` (cascade `continue`s before the
  cursor read, so those cursors structurally cannot advance) minus the
  endogenous agent-runtime hook sources `chat-claude-code` and `codex-cli`
  (the agent running the gate writes the ledgers those cursors tail — gating
  on them is the harness waiting out its own operator).

A new connector is covered by the `CAPS.WATERMARK_SOURCES` edit that creates
it. No second edit anywhere. If you believe a source belongs in a different
tier, argue it in the helper's header and pin it in
`mcp/test/run-all-tests-hermetic-arm.test.mjs`.

**Behaviour, by environment.** The helper does not judge one instantaneous
mtime — that measured when the suite started, not what the daemon is doing:

- No gating file fresh (< 30s): returns instantly. The common case pays
  nothing.
- Gating file fresh, `REQUIRE_HERMETIC` unset (local dev): prints a skip and
  exits 0.
- Gating file fresh, `REQUIRE_HERMETIC=1` (every gate run — `run-all-tests.mjs`
  injects it): waits for a real quiet window (35s default, 120s budget). Quiet
  window found -> the suite runs. Budget exhausted -> **exit 1**, with the
  hottest source, write counts and busy fraction printed.

The exit-1 branch is load-bearing: under `REQUIRE_HERMETIC=1` a skip would be
a vacuous pass ("0 passed, 0 failed", nothing asserted, gate green). No code
path may reintroduce one.

Apply this gate to any test that reads, writes, or snapshots:

- `ledgers/memory.jsonl`
- `indices/**` (BM25 + HNSW under the active embed-model version)
- `storage/watermark-state/*.json`

Helper coverage: `mcp/test/test-ops-daemon-quiesce.test.mjs` exercises the
fresh / stale / missing / mixed / boundary cases against synthetic state
files, and `mcp/test/run-all-tests-hermetic-arm.test.mjs` pins the derivation,
the tiering, and every branch of the helper in child processes (no production
paths touched by either).

## 3. KEY_LEAKAGE_ZERO

Tests MUST NOT echo real API key bytes — in source, in fixtures, in
stderr, in test output. Use synthetic strings (e.g. `AIzaFAKE_<...>`) or
the boot-time validator's minimum-shape value
(`AIzaJUNK_test_not_used_xxxxxxxxxxxxxxxxx`).

When inspecting key state, use the `redactKey(key)` helper (12-char prefix
+ ellipsis) — never log the full string.

## 4. No emoji in test output

`spec-sweep` greps for emoji and fails the test-set if any are present in
source or stdout/stderr.

## 5. Plain JS, ES modules, no new deps

Tests are `.mjs` ES modules. No TypeScript. No new dependencies in
`package.json` without operator sign-off.
