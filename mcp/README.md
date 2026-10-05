# memory MCP server

Developer notes for the server package. What the system is, what it needs and
how to install it are in the [root README](../README.md) and
[INSTALL.md](../INSTALL.md); the tool reference is
[kb/mcp-surface.md](../kb/mcp-surface.md). This page only covers working on the
code in this directory.

## What is here

- `mcp/server.js`: the stdio entry point. It registers the tools that
  `listTools()` in `mcp/lib/dispatch.js` returns (14 today) and answers
  `tools/list` and `tools/call`.
- `mcp/lib/tools/`: one module per tool.
- `mcp/lib/`: everything the tools share. `mcp/lib/config.js` is the single
  source of every data path; `mcp/lib/validation.js` holds the `CAPS` limits.
- `mcp/lib/connectors/`: the ingest connectors
  ([docs/CONNECTORS.md](../docs/CONNECTORS.md)).
- `mcp/daemon/`: the query daemon that keeps the indexes resident.
- `mcp/test/`: the test suites.
- `mcp/scripts/`: the test runner and maintenance scripts.

## Requirements

Node.js 22.18.0 or newer (`engines.node` in `mcp/package.json`). ES modules,
plain JavaScript, no build step. One dependency, the vector index, is a native
module compiled by `npm ci`, so the Xcode Command Line Tools are needed.

## Running

From the repository root, `bash scripts/install.sh --core` installs the
dependencies and checks the result. To do only the dependency step by hand:

```bash
cd mcp
npm ci
node server.js
```

The server prints one line to stderr and then waits for JSON-RPC on stdin;
Ctrl-C stops it. `node scripts/smoke.mjs`, from the repository root, puts and
recalls one memory through a real server on a throwaway data directory.

Data goes to the checkout unless `MEMORY_ROOT` names another directory. Tests
and tools must take every path from `mcp/lib/config.js` so that override keeps
working.

## Tests

```bash
cd mcp
npm test
```

`npm test` runs `mcp/scripts/run-all-tests.mjs`, which runs every suite in its
`SUITES` list and prints a tally. `npm run test:fail-fast` stops at the first
failing suite. A new `*.test.mjs` file must be added to `SUITES` in the same
change, or the runner refuses to start. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for exit codes, running one suite and
the synthetic-data rule.

## Registering with a client

The command is `node` and its one argument is the absolute path of
`mcp/server.js`. `mcp/.mcp.json.example` shows the shape with a placeholder
path. For Claude Code, from the repository root:

```bash
claude mcp add --scope user memory -- node "$PWD/mcp/server.js"
```

The quotes keep a checkout path with spaces in one piece; `--scope user`
makes the tools available in every directory.

## Conventions

- Every tool returns the envelope `{ ok, data, error, meta: { tool, version } }`.
- Error codes: `INVALID_ARGUMENTS`, `NOT_FOUND`, `STATE_CONFLICT`,
  `SCOPE_BLOCKED`, `CONSENT_BLOCKED`, `PRIVILEGE_REQUIRED`, `INTERNAL_ERROR`.
- `ts` is stamped by the server and never accepted from the caller.
- Schemas, limits and error codes follow `kb/mcp-surface.md`. When behaviour
  and that page disagree, fix one of them in the same change.
