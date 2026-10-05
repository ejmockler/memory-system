# Convention: daemon-reload after on-disk edits

**Status:** convention scaffold (R33 / Foundation B6). Not yet a hard CI
gate; future workflows may copy this into a `.test.mjs` enforcer.

## The rule

Any workflow phase that edits files matching either of:

- `daemons/*.js`
- `mcp/lib/**` (transitively imported by a daemon)

MUST conclude with the operator-phase Bash step:

```bash
bash mcp/scripts/reload-daemon.sh <daemon-name>
```

…where `<daemon-name>` matches the suffix of
`~/Library/LaunchAgents/com.user.memory-system.<daemon-name>.plist`.

Currently in scope: `watermark`. (`distillation-supervisor` was retired
in R32; its plist no longer exists.)

## Why this exists

See `kb/deprecation-discipline.md` section "Daemon reload after code
edits" for the full rationale. Summary: Node module cache is per-process;
on-disk edits are invisible to the running daemon until the process is
replaced.

## R32.1 evidence (the failure this prevents)

- `mcp/lib/health.js` was edited on disk to bump `schema_version` to 3.
- The watermark daemon kept running with the pre-edit module cache.
- `memory_health` over MCP reported `schema_version: 2`.
- Verification gates that polled `memory_health` saw the stale value and
  could not tell whether the on-disk edit had landed.

## Mechanical enforcement (future, optional)

A future workflow that wants to make this a CI gate would convert this
scaffold into `mcp/test/daemon-reload-on-edit.test.mjs` with logic
approximately:

```js
// pseudo-code; do not implement until operator approves the CI gate
const changed = gitDiffNames();              // git diff --name-only
const daemonTouched =
  changed.some(p => /^daemons\/.*\.js$/.test(p)) ||
  changed.some(p => /^mcp\/lib\//.test(p) && importedByAnyDaemon(p));
if (daemonTouched) {
  const log = readOperatorPhaseLog();        // round writeback or session log
  assert.match(log, /bash mcp\/scripts\/reload-daemon\.sh\s+\w+/);
}
```

Until that gate lands, this convention is enforced by humans (workflow
authors) and by the helper itself (which fails loud, blocking the round,
if a reload is attempted and does not succeed).

## Out of scope

- Edits to `mcp/lib/**` modules that NO daemon imports (pure
  request/response code paths). The daemon does not need to be reloaded
  because it does not load that code at all. The MCP server process is
  separate and is restarted by its own host (Claude Code / Codex).
- Edits to `kb/**`, `scripts/**`, `mcp/test/**`. None are imported by
  daemons at runtime.
- Edits to `mcp/scripts/reload-daemon.sh` itself. It is invoked fresh per
  call; no in-process cache.

## Helper contract recap

`mcp/scripts/reload-daemon.sh <daemon-name>`:

- exit 0 on successful reload (post-warmup PID + RSS reported)
- exit 1 on any step failure (unload, stop-verify, load, start-verify,
  warmup-die), with `FAIL: <step>` on stderr
- prints the final PID + RSS on success so the operator can compare
  across rounds (memory leak detection)
