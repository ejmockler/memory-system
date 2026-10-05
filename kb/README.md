# kb/ — design notes and reference

This directory holds the system's design knowledge base. Some files describe how
the code works today; others record how it got that way. Start with the current
reference below. For installing and running the system, use `README.md`,
`INSTALL.md` and `docs/` at the top of the repository instead.

Conventions used throughout `kb/`:

- `<checkout>` is the directory the repository was cloned into.
- `<data root>` is where the server keeps its data (`MEMORY_ROOT`; it defaults to
  the checkout, see `mcp/lib/config.js`). Some older text writes it as
  `<MEMORY_ROOT>` or, inside hash-pinned blocks, `~/memory-system`.
- "The user" is the one person whose memory the install holds. Code and config
  call that person the *operator* (for example the operator-identity config).
- Blocks between `<!-- BEGIN-CANONICAL: … -->` and `<!-- END-CANONICAL: … -->`
  are hash-pinned and read by tests (`mcp/policy/canonical-allowlist.json`);
  they are kept verbatim even where their wording is dated.
- Ids such as `R32`, `round-20` or `Phase 2b` in the history files name internal
  development rounds and phases. They carry no meaning outside these notes.

## Current reference

- `mcp-surface.md` — every MCP tool: arguments, outputs, errors, privileges, and which designed tools are not implemented.
- `mcp-registration-state.md` — registering the server with Claude Code, Codex CLI and Claude Desktop.
- `architecture.md` — the layers (source ledgers to recall), promotion path, interface boundaries, lock discipline.
- `agent-integration.md` — how agent runtimes connect: hooks, the watermark daemon, per-source cursors, policy-event ownership.
- `ingestion.md` — the connector contract, consent classes and how raw events reach the memory ledger.
- `operations.md` — recall and forgetting semantics, damping, and activating the iMessage, Screen Time, git-log and GitHub connectors.
- `glossary.md` — definitions of the terms used across `kb/`.
- `thesis.md` — the seven design principles.
- `open-problems.md` — known unsolved product risks.
- `inheritance.md` — which patterns come from an earlier event-ledger design and which are inverted.

## Contracts and specs read by code or tests

- `connectors-phase2c.md` — Telegram and Slack row-shape contracts (hash-pinned).
- `connectors-phase3.md` — Apple Mail and WhatsApp row-shape contracts (hash-pinned).
- `phase3-v0-contracts.md` — recall-layer shape contracts: index entry, score components, recall ledger event.
- `phase3-v1-rerank-contracts.md` — reranker contract additions; written for a Gemini reranker (a local reranker, `local-embedder/rerank_server.py`, is now the default path).
- `source-fidelity-spec.md` — iMessage typedstream decoding and Screen Time stream coverage.
- `salience-design.md` — design of the row-by-row salience cascade that promotes source rows.

## Contributor conventions

- `test-discipline.md` — rules every test under `mcp/test/` follows (hermeticity, no writes to real data).
- `deprecation-discipline.md` — how a replaced component is retired and its prose moved to `legacy-archive.md`.
- `workflow-script-template.md` — structure required of multi-agent workflow scripts used during development.

## Design history

- `build-plan.md` — the original phased build plan, with each phase's status.
- `connectors-survey.md` — the connector survey that set the build order (2026-06-02).
- `research-retrieval-frontiers.md` — retrieval research behind the recall layer.
- `phase3-v1-reranker-model.md` — how the Gemini reranker model was chosen.
- `api-key-pool.md` — Gemini API key rotation (the Gemini paths are optional; the default embedder and reranker run locally).
- `asymmetric-margin-investigation.md` — investigation of a recall-evaluation metric discrepancy.
- `transitive-orphan-design.md` — design of derivation-orphan propagation at recall time (now implemented).
- `legacy-archive.md` — retired components and why they were removed.
