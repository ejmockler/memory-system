# Registering the Claude Code hooks

The hooks are optional and the installer never registers them. They capture
your Claude Code sessions into the store; see "Claude Code sessions" in
`docs/CONNECTORS.md` for what is kept and the privacy risk.

## The hooks

| Script | Claude Code event | What it does |
| --- | --- | --- |
| `hooks/stop-hook.sh` | `Stop` | Appends one row per turn (your prompt and the assistant's reply) to `<data root>/storage/sources/chat-claude-code.jsonl`. This is the capture hook; the `watermark` service turns those rows into memories. |
| `hooks/recall-engagement-detect.sh` | `UserPromptSubmit` | Appends the submitted prompt to `<data root>/policy/engagement-queue.jsonl` so the `watermark` service can tell whether an earlier recall was used. Only useful when that service runs. |
| `hooks/session-end-hook.sh` | `SessionEnd` | Writes one batch file per session under `<data root>/storage/distillation-queue/pending`. Nothing in this tree reads that queue any more, so registering it has no effect on recall and the files accumulate. Leave it out unless you have your own consumer. |

Every hook always exits 0 and never blocks the agent. Failures are appended to
`<data root>/hooks/hook-errors.jsonl`.

## Requirements

- `jq` and `node` (22.18.0 or newer) on the `PATH` Claude Code runs hooks
  with.
- `flock` is optional. Without it the Stop hook takes a directory lock
  instead.
- The scripts must be executable (they are in a fresh clone).

## Registration

Register at the user level, in `~/.claude/settings.json`, not in a project's
settings: capture is meant to cover every project, and a project-level entry
fires only in that project.

Replace the placeholder with the absolute, real path of your checkout:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/ABSOLUTE/PATH/TO/CHECKOUT/hooks/stop-hook.sh\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/ABSOLUTE/PATH/TO/CHECKOUT/hooks/recall-engagement-detect.sh\""
          }
        ]
      }
    ]
  }
}
```

Claude Code runs each `command` through a shell, so the path is wrapped in
escaped quotes (`\"...\"`); keep them if your checkout path contains a space.


If the file already has a `hooks` object, add these entries to it instead of
replacing it. Leave out the `UserPromptSubmit` entry if you do not run the
services.

## Rules

- **Use the real path, never a symlink.** Each hook finds the checkout (and
  the code under `mcp/lib/` it needs) from its own location, without resolving
  symlinks. A hook started through a symlink in another directory looks for
  the checkout next to the symlink and fails.
- **Same data root as the server.** The hooks write under `MEMORY_ROOT` when
  that variable is set in the environment Claude Code runs them in, otherwise
  under the checkout. If you start the MCP server with a `MEMORY_ROOT`, the
  hooks need the same value. The background services always use the checkout
  (see `INSTALL.md`), so with services running leave `MEMORY_ROOT` unset.
- **Removing them.** Delete the entries from `~/.claude/settings.json`.
  Captured rows stay in the source ledger; to hide them from recall, call the
  `memory_connectors_revoke` tool with the source `chat-claude-code`.
