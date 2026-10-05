# Deprecation Discipline

When a new architecture replaces an old one, the old one must be RETIRED in
its own round, not left as parallel-running tech debt.

## Why this discipline exists

R25 introduced the row-by-row salience cascade as the new promotion path. The
Phase-1 conversational distillation pipeline (the `distillation-supervisor`
launchd job, the `storage/distillation-queue/` claim ring, the
`watermark.tickOnce` conversation-batch path, the
`policy.distillation.batch.*` event family, the `policy.token.minted` flow)
was not retired. It ran in parallel for six rounds. By the start of R32 it
was burning Gemini quota the cascade needed and surfaced as a 14h
`watermark_lag_seconds` in `memory_health` (with `last_distillation_ts: null`
because the path had never produced a fact in its current incarnation).

Two pipelines for one job is two failure modes, two quota draws, and two
mental models that operators must reconcile when reading recent policy
events. R32 closed the legacy pipeline AND introduced this discipline so the
same mistake cannot recur silently.

## The discipline

1. **The round that introduces a new path documents what becomes legacy.** A
   round that names X as "the new way" implicitly names the old X' as
   legacy. The round writeback states it explicitly.

2. **The very next round REMOVES the legacy path** (or batches the removal
   if multiple are scheduled). The legacy path does not earn another round
   of co-existence. If it earns rounds at all, that is itself a decision
   the user makes consciously, not by default.

3. **The forbidden-identifiers list in
   `mcp/lib/forbidden-legacy-identifiers.js` is the single source of truth
   for what is forever-forbidden.** When the removal round closes, every
   identifier the removed path carried is added to that list. The regression
   test (`mcp/test/no-legacy-pipeline-references.test.mjs`) asserts absence;
   the spec-sweep gate (`scripts/spec-sweep.mjs`, category
   `legacy_pattern_seen`) emits a non-zero exit on any hit. Both gates run
   in `npm test`.

4. **Adding code that uses a forbidden identifier fails CI.** No exceptions
   for "just this one place" or "we'll remove it later". The forbidden
   identifier is exactly the kind of name that drifts back into production
   if a single line of code is allowed to keep referencing it.

## Exceptions (the only places forbidden identifiers may appear)

- `kb/legacy-archive.md` - the user-curated history doc. Removed paths
  are summarised here with the round that retired them and the live
  architecture that replaces them. This is the consolidated single source
  for what was there before; scattered "DEPRECATED" comments are not.
- `kb/deprecation-discipline.md` - this file. The policy that names the
  names must reference them to be readable.
- `mcp/lib/forbidden-legacy-identifiers.js` - the list itself, with bounded
  regexes and human-readable notes.
- `mcp/test/no-legacy-pipeline-references.test.mjs` - the test that asserts
  absence. By construction it must hold the identifiers it is asserting
  against.
- `scripts/spec-sweep.mjs` - imports the list and runs the same scan as a
  category in the broader sweep.
- Reviews and task JSON files: historical artefacts, never executed,
  segment-excluded by both gates.

**Comments in code referencing removed features:** NO. Comments referencing
removed features are themselves stale and add cognitive load to readers
trying to understand what the current code does. If the comment was useful,
the code would not have been removed; if the code was removed, the comment
goes with it. The history record lives in `kb/legacy-archive.md` where an
operator who needs it can read it as a coherent whole.

## Adding a new entry to the forbidden list

When a round retires a path:

1. The same round MUST remove all existing references to the identifier from
   production code (everywhere not in the exception list above). This is
   non-negotiable: adding a new forbidden entry while leaving production
   references behind would fail CI on the same commit.
2. The new entry is added to the `FORBIDDEN_IDENTIFIERS` array in
   `mcp/lib/forbidden-legacy-identifiers.js` with:
   - `id`: the literal identifier
   - `pattern`: a bounded regex source string (use the `boundedRe` helper)
   - `note`: which round retired it and what replaced it
3. A section is added to `kb/legacy-archive.md` documenting the removal:
   round, replaced-by architecture, what-was-there summary, on-disk artefact
   shapes (so an operator reading older policy events can still parse them).
4. The original prose in live KB docs that described the now-removed path
   is MOVED to `kb/legacy-archive.md` and DELETED from the source doc.
   `kb/architecture.md`, `kb/build-plan.md`, `kb/ingestion.md`, etc. describe
   the LIVE architecture only.
5. The new entry sticks forever. The forbidden-identifiers list grows
   monotonically. Removing an entry would mean re-introducing the identifier
   was intentional; that has not happened, and the discipline does not
   anticipate it.

## Daemon reload after code edits

**Convention (R33 / Foundation B6):** any workflow phase that edits daemon
code MUST end with a daemon reload step:

```bash
bash mcp/scripts/reload-daemon.sh <daemon-name>
```

Specifically, this applies to edits to any of:

- `<checkout>/daemons/*.js` — the daemon entrypoints
  themselves (e.g. `watermark.js`, `screentime-connector.js`)
- `<checkout>/mcp/lib/**` modules that the daemons import,
  transitively. If you edited `mcp/lib/config.js` or `mcp/lib/health.js`
  and a running daemon imports it, the daemon reload is required.

**Why:** file edits on disk do NOT take effect inside a running daemon
process. Node caches every `import`'d module in-memory per process. The
daemon will continue to execute the bytes it loaded at startup until the
process is replaced. Without a reload step the workflow ends with a
contradiction:

- on-disk source: edited (the new behaviour)
- running daemon: stale (the old behaviour)
- `memory_health` / MCP responses: reflect the running daemon, i.e. STALE

Downstream consequences observed in R32.1:

- Verification gates pass against the new on-disk source but the user
  sees old behaviour via the MCP server.
- `memory_health.schema_version` reads as the pre-edit value even after
  the schema was bumped on disk, because the response is served by the
  pre-edit process.
- Future workflows treat the running daemon's behaviour as canon, masking
  the on-disk truth and propagating drift forward.

**Mechanics of `mcp/scripts/reload-daemon.sh`:**

1. `launchctl unload` the agent plist
2. sleep 2; verify `pgrep -f daemons/<name>.js` returns no PID
3. `launchctl load -w` the plist
4. sleep 5; verify `pgrep -f daemons/<name>.js` returns a PID
5. print PID; sleep 30 for warmup; verify process still alive; report RSS

Any step failure prints `FAIL: <step>` and exits non-zero. A workflow
operator-phase Bash step that calls this helper inherits that exit code
and BLOCKS the round, the same way any other gate would.

**Convention regression scaffold:** the policy itself is documented in
`mcp/test/daemon-reload-on-edit.convention.md`. A future workflow that
wants to enforce the convention mechanically (e.g. via a pre-commit
check that scans the round's `git diff --name-only` and asserts the
operator-phase log mentions `reload-daemon.sh`) can copy that scaffold
as its starting point.

## Canonical-content blocks (R34 B12)

A second class of regression is **accidental deletion of machine-consumed
KB content** during a deprecation pass. In R32.1 the agent that stubbed
"Phase 1 — RETIRED (R32)" into `kb/build-plan.md` deleted the
`source_msg_id` preimage formula as prose collateral. The cascade still
uses that formula; the formula remained authoritative; but the consumer
test (`mcp/test/source-msg-id-preimage.test.mjs`) was using regex-on-prose
to extract it and silently broke. The breakage was not surfaced until
R33 brutalist review.

The fix is structural, not procedural. Any KB content that is read
mechanically (formulas, schemas, identifier lists, fixed JSON exemplars)
MUST be wrapped in a CANONICAL block:

```
<!-- BEGIN-CANONICAL: <name> -->
... content ...
<!-- END-CANONICAL: <name> -->
```

Rules:

1. **Names are globally unique** across the kb/ tree. The scanner
   (`mcp/scripts/canonical-block-scan.mjs`) flags duplicates as ERRORs.
2. **Consumers read by name**, not by anchor-text:
   `extractCanonical("kb/build-plan.md", "source_msg_id_formula")`.
   No regex-on-prose. No nested-paren counting against markdown.
3. **The sha256 of every block is locked** in
   `mcp/policy/canonical-allowlist.json` with the named consumer files
   that read it. Editing the inside of a block without updating the
   allowlist fails `npm test`.
4. **Migration discipline**: when a round migrates a section, the
   canonical blocks inside it travel intact. If the new home is a
   different file, update the `file` field in the allowlist in the
   same commit. The scanner reports `moved_block` if those drift.
5. **A deprecation-round that retires a section containing a CANONICAL
   block** must explicitly decide: keep the block (because the content
   is still authoritative — like `source_msg_id_formula`), or remove
   the block AND its allowlist entry AND the consumer in lockstep.

This pairs with the forbidden-identifiers list: forbidden identifiers
say "this name is dead, never use it"; canonical blocks say "this
exact text is alive, never accidentally delete it".

### Machine-consumed KB regions — operator-readable map (R35 M2)

R34 wrapped ONE block (`source_msg_id_formula`) and left the rest of the
machine-consumed KB surface unprotected — the foundation was one block
deep. R35 M2 closes the recursion-floor by enumerating every region a
script or test reads from the KB and wrapping each in a CANONICAL block.
Below is the live map: any future region the system reads mechanically
MUST be added to this list AND to `mcp/policy/canonical-allowlist.json`
in the same edit. The live invariant is enforced by
`mcp/test/canonical-block-integrity.test.mjs` (the `R35_REQUIRED_BLOCKS`
list inside it).

| Canonical block name | KB file | Consumer(s) | What the block holds |
|---|---|---|---|
| `source_msg_id_formula` | `kb/build-plan.md` | `mcp/test/source-msg-id-preimage.test.mjs` | Authoritative `source_msg_id = sha256(canonical_json({conversation_id, content_sha256, prev_source_msg_id}))` preimage formula. Cascade row-identity. |
| `source_msg_id_inline_formula` | `kb/agent-integration.md` | `mcp/test/source-msg-id-preimage.test.mjs` | Same formula in extractable form on the second spec file. Spec-spec byte-equality assertion binds structurally on both sites. |
| `watermark_state_schema_v1` | `kb/agent-integration.md` | `daemons/watermark.js` | Authoritative per-source watermark state shape (`policy/watermark-state.json`). Field-name drift here is a conformance failure. |
| `policy_event_kinds_table` | `kb/agent-integration.md` | `scripts/spec-sweep.mjs`, `mcp/test/daemon-token.test.mjs` | Closed enumeration of `policy.*` event kinds and their authorized producers. spec-sweep cross-checks every producer-call against this table. |
| `health_envelope_schema_v1` | `kb/mcp-surface.md` | `mcp/test/health-real-data.test.mjs` | Closed field set for `memory_health` output. Wrapping enables future structural extraction and locks the field set against silent KB drift now. |

When adding a new machine-consumed region:

1. Wrap it in `<!-- BEGIN-CANONICAL: <name> --> ... <!-- END-CANONICAL: <name> -->`.
2. Add a row to the table above AND to `R35_REQUIRED_BLOCKS` in
   `mcp/test/canonical-block-integrity.test.mjs`.
3. Update the consumer to call `extractCanonical(kbPath, "<name>")`
   instead of anchor-text matching. A fallback anchor-text path is
   permitted during migration; flag it as tech-debt for the next round.
4. Run `node mcp/scripts/canonical-block-scan.mjs --emit-index=...` to
   compute the sha256 and add the entry to
   `mcp/policy/canonical-allowlist.json`.
5. `node mcp/scripts/canonical-block-scan.mjs` must exit 0.

### Canonical-allowlist editing protocol (R36 S2 / B13 sentinel)

R35 left a recursion gap: every CANONICAL block was protected by
`mcp/policy/canonical-allowlist.json`, but the allowlist itself was not
under structural protection. An operator who edited a block AND silently
updated only the matching `sha256` field in the allowlist would pass the
B12 gate — the gate that guards the gates was itself ungated. R36 closes
this with a self-hash sentinel.

**The chain:** every legitimate canonical-content edit now follows
exactly three steps, and the sentinel makes any 2-step shortcut a
structural failure:

1. Edit the canonical block in the source `.md` file.
2. Update its `content_sha256` (the `blocks.<name>.sha256` field) in
   `mcp/policy/canonical-allowlist.json`. This is the R34 discipline.
3. Run `bash mcp/scripts/update-allowlist-sentinel.sh` to refresh
   `mcp/policy/canonical-allowlist.sha256.sentinel`. This is the R36
   discipline.

All three files must be committed together. Any 2-step variant is
caught by `mcp/test/canonical-block-integrity.test.mjs` FIXTURE 5:

- Edit block + skip step 2: B12 (R34) flags sha256 drift between the
  block and the allowlist entry.
- Edit allowlist + skip step 3: B13 (R36) flags sha256 drift between
  the allowlist file and the sentinel.
- Edit allowlist + edit sentinel + skip step 1: B12 flags drift between
  the allowlist entry and the actual block content on disk.

The chain is closed: a silent mutation now requires a coordinated
multi-file conspiracy that surfaces in any single failed assertion.

**Why a separate sentinel file and not a field inside the allowlist?**
A self-referential `sha256_of_self` field would have to be computed by
excluding itself from the hash — an order-dependent operation that
re-introduces the silent-mutation risk it was supposed to close. A
separate file makes "the sentinel must match the file as a whole" a
trivially-decidable property of raw bytes.

## MCP-server hard-restart after code edits

**Convention (R36 / S3):** any workflow phase that edits code under
`mcp/lib/**` (especially `mcp/lib/tools/*.js`) or any module that
`mcp/server.js` transitively imports MUST end with:

```bash
bash mcp/scripts/hard-restart-mcp-server.sh
```

This is in addition to `reload-daemon.sh`, not a replacement.
`reload-daemon.sh` ONLY restarts launchd-managed daemons (the watermark
loop and connectors). MCP server children are different: they are stdio
subprocesses owned by long-lived hosts (Claude Code, Codex CLI), not
launchd jobs.

**Why MCP children need their own restart helper:** the host spawns one
or more MCP server children at session start, then keeps them alive
across hours of usage. Each child loads its imports into the Node module
cache at boot. On-disk file edits are invisible to that child. The host
will not respawn the child until the child exits — so the only way to
force a refresh is `kill -9` on every PID matching the `server.js`
command-line; the host detects the broken stdio pipe and respawns a
fresh child against the post-edit bytes on the next MCP call.

**Observed failure mode (R35 → R36 trigger):** R32.1 bumped
`HEALTH_SCHEMA_VERSION` from 2 to 3 in `mcp/lib/tools/health.js`. Source
on disk read 3. Live `memory_health` calls returned 2 for multiple
rounds because the MCP child that Claude Code spawned BEFORE the edit
was still serving cached bytes. Up to 10 stale children were observed
simultaneously by R36 Phase A.

**Mechanics of `mcp/scripts/hard-restart-mcp-server.sh`:**

1. `launchctl unload` the watermark plist (drain in-flight ticks).
2. sleep 2.
3. `pgrep -f "memory-system/mcp/server\.js"` — enumerate stale MCP PIDs.
4. `kill -9` each PID. Host will respawn lazily on next MCP call.
5. sleep 1; verify no MCP children remain.
6. `launchctl load -w` the watermark plist.
7. sleep 5.
8. Smoke-test: spawn a fresh MCP server via the vendored node, send
   `initialize` + `notifications/initialized` + `tools/call`
   `memory_health`, parse `schema_version` from the response, assert
   it equals 3 (the current live value as of R32.1).
9. Print `Hard-restart complete. schema_version=3 verified.`

`--dry-run` mode is supported: prints the PIDs that would be killed and
skips the destructive steps. Useful for verifying the script is wired up
correctly before pulling the trigger.

Any step failure prints `FAIL: <step>` and exits non-zero. As with
`reload-daemon.sh`, the workflow operator-phase Bash step that calls
this helper inherits that exit code and BLOCKS the round.

**Decision matrix:**

| What you edited | Run `reload-daemon.sh` | Run `hard-restart-mcp-server.sh` |
|---|---|---|
| `daemons/watermark.js` or imports it uses | yes | only if MCP also reads the same modules |
| `daemons/<connector>.js` (e.g. screentime) | yes (specific name) | no |
| `mcp/lib/tools/*.js` (any MCP tool) | no | yes |
| `mcp/server.js` or `mcp/lib/dispatch.js` | no | yes |
| `mcp/lib/<shared>.js` imported by both | yes (per affected daemon) | yes |
| Pure KB doc (`kb/*.md`) with no machine consumer | no | no |
| Canonical-allowlist or sentinel | no | no (test-time only) |

If unsure: run both. They are idempotent and the cost is small.

## What this discipline does NOT cover

- **Operator-facing config changes** (MCP server registration in Claude
  Code / Codex): those are documented per round and live in
  `kb/mcp-registration-state.md`. They are not "legacy" in the
  forbidden-identifier sense.
- **Runtime and dependency upgrades**: Node.js is not vendored; the
  supported range is `engines.node` in `mcp/package.json` and the CI matrix,
  and npm dependencies are pinned by `mcp/package-lock.json`. Upgrading them
  changes versions, not identifiers.
- **Experimental / future paths** that exist as a stub but are not yet wired
  into production: not legacy because they were never the current
  architecture. The forbidden list is for paths that WERE live and are now
  gone.
