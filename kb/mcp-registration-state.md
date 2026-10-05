# MCP Registration

How the memory MCP server is registered with an agent host. This page describes the mechanism only; it records nothing about any particular machine.

## Memory-system MCP server

- **Entry point**: `mcp/server.js` in the checkout (declared by `mcp/package.json` as `bin: memory-mcp`, `main: server.js`). It speaks MCP over stdio (`StdioServerTransport` from `@modelcontextprotocol/sdk`) and identifies itself as `serverInfo = {name: "memory", version: "0.0.1"}`.
- **Tool surface**: 14 tools. `mcp-surface.md` § Tool index is the list and the per-tool reference; this page does not repeat it.
- **Privileged tools**: the two `memory_distill_*` tools answer only when the server process was started with `MEMORY_ROLE=distillation`. An ordinary agent registration leaves that variable unset, so those two tools refuse for it. That is by design, not a registration fault.
- **Smoke test**: start `node mcp/server.js`, send `initialize` and then `tools/list` as JSON-RPC on stdin. A healthy server answers both and prints `memory MCP server running (stdio) v0.0.1` on stderr.

In the snippets below, `<checkout>` stands for the absolute path of the directory the repository was cloned into. (`MEMORY_ROOT` is a different thing: the data root, which defaults to the checkout. See `mcp/lib/config.js`.)

## Claude Code

Claude Code keeps MCP registrations in `~/.claude.json`, at one of two scopes:

- **local** (the default of `claude mcp add`): stored under the entry for the directory the command was run in, and visible only to sessions started in that directory.
- **user**: stored in the top-level `mcpServers` map, and visible to sessions started anywhere.

A local-scope registration made from inside the checkout is easy to mistake for a working one: the tools appear there and nowhere else. Register at user scope, running this from the checkout so `$PWD` is `<checkout>`:

```sh
claude mcp add --scope user memory -- node "$PWD/mcp/server.js"
```

To pass environment variables to the server (for example `MEMORY_ROOT` or `MEMORY_PUT_ENABLED`), add `-e NAME=value` after the server name.

If a local-scope entry named `memory` already exists for some directory, remove it from that directory (`claude mcp remove memory -s local`) so it does not shadow the user-scope one. `claude mcp get memory` prints the scope in effect; `claude mcp list`, run from an unrelated directory, confirms the server is reachable.

`mcp/.mcp.json.example` is a template for a project-scope `.mcp.json`, for a checkout that should carry its own registration.

## Codex CLI

Codex CLI reads MCP servers from `~/.codex/config.toml`. Add a stanza with the absolute path of `<checkout>` written out (TOML does not expand variables):

```toml
[mcp_servers.memory]
command = "node"
args = ["<checkout>/mcp/server.js"]
cwd = "<checkout>/mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

No environment variables are needed for recall and the other default tools. `memory_put` is the exception: once the install has a vector index or runs the query daemon, the server refuses it with `SCOPE_BLOCKED` unless started with `MEMORY_PUT_ENABLED=1` (see `INSTALL.md`, "When `memory_put` needs an opt-in"). To enable it, add `env = { MEMORY_PUT_ENABLED = "1" }` to the stanza. Restart Codex after editing the file.

## Claude Desktop

Claude Desktop reads `~/Library/Application Support/Claude/claude_desktop_config.json`. The key `memory` is a common name there and may already belong to a different, unrelated memory server; if this server is added, give it a distinct key (for example `memory-system`) so the two do not collide.

## Checking a registration

1. From a directory outside the checkout, list the host's MCP servers and confirm `memory` is present.
2. In a fresh session, call `memory_health`, then `memory_recall`.
3. Expect the two `memory_distill_*` tools to be refused for an ordinary agent (see Privileged tools above).
