# Source-Coverage Matrix

**Canonical home for the unified-taxonomy coverage table.**
**Node:** F-META-WHATSAPP-COVERAGE → F-NEW-W4-WHATSAPP-COVERAGE-DOCS-CANONICAL
**Related spec:** [`specs/whatsapp-coverage.md`](./specs/whatsapp-coverage.md)

---

## Purpose

This file is the higher-level docs-tree home for the source-coverage
matrix originally drafted in `specs/whatsapp-coverage.md`. The spec doc
holds the full activation checklists, parity criteria, and operator
process; this file surfaces the matrix at a path operators will find
when navigating top-level docs (and stays in lockstep with the spec).

When updating the matrix:

1. Edit the table here.
2. Mirror the change into `specs/whatsapp-coverage.md`.
3. If the change adds a new column (a new cross-source feature),
   open a workunit node per the user process documented in the
   spec.

## Matrix

(One row per source; one column per cross-source feature.)

| Source         | R40 telemetry | R41 dedup | R42 identity | R43 bot regex | R44 quarantine | R49 redact | A/B harness | Salience shadow |
|----------------|---------------|-----------|--------------|---------------|----------------|------------|-------------|------------------|
| git-log        | YES           | YES       | YES          | YES           | YES            | YES        | spec-only   | spec-only       |
| codex-cli      | YES           | partial   | YES          | YES           | YES            | YES        | spec-only   | spec-only       |
| screentime     | YES           | partial   | n/a          | n/a           | partial        | YES        | spec-only   | spec-only       |
| imessage       | YES           | partial   | YES          | YES           | YES            | YES        | spec-only   | spec-only       |
| mail           | YES           | partial   | YES          | YES           | YES            | YES        | spec-only   | spec-only       |
| github-events  | YES           | YES       | YES          | YES           | YES            | YES        | spec-only   | spec-only       |
| slack          | YES           | partial   | YES          | YES           | YES            | YES        | spec-only   | spec-only       |
| codex-runtime  | YES           | partial   | n/a          | n/a           | partial        | YES        | spec-only   | spec-only       |
| telegram (user)| YES           | partial   | YES          | YES           | YES            | YES        | spec-only   | spec-only       |
| **whatsapp**   | partial       | NO        | partial      | NO            | partial        | YES        | spec-only   | spec-only       |
| **telegram-bot**| NO           | NO        | partial      | NO            | NO             | partial    | spec-only   | spec-only       |

"partial" = covered for some event types within the source, but not
all. "n/a" = the feature is structurally inapplicable to this source
(screentime/codex-runtime are operator-machine sources with no remote
party).

## Legend

- **R40 telemetry**: reasons recorded in `mcp/lib/ingest/stage0/telemetry.js`
  `REASON_ALLOWLIST`; per-source counters wired through `recordDrop`.
- **R41 dedup**: cross-source duplicate substrate
  (`mcp/lib/ingest/cross-source-dedup.js`) consults the source.
- **R42 identity**: operator identity map applied via `isOperator`.
- **R43 bot regex**: bot-actor predicate applied via `isBotActor`.
- **R44 quarantine**: DROP paths with corroboration value route through
  `quarantineRow` (30d restorability) rather than irreversible DROP.
- **R49 redact**: redaction predicates applied at emit time.
- **A/B harness**: connector participates in the shadow-run harness.
- **Salience shadow**: salience cascade shadow-run wiring present.

## Activation checklists

Full activation steps (fixtures, reason-allowlist additions, bot-actor
regex extensions, cross-source dedup contracts) for WhatsApp and
Telegram-Bot live in [`specs/whatsapp-coverage.md`](./specs/whatsapp-coverage.md)
under "WhatsApp activation checklist" and "Telegram-bot activation
checklist".

## Parity acceptance criteria

A connector is at "parity" with the unified taxonomy when all eight
criteria in [`specs/whatsapp-coverage.md`](./specs/whatsapp-coverage.md)
§ "Parity acceptance criteria" hold. WhatsApp and telegram-bot do not
currently meet criteria 1, 2, 3, 4, 6 (partial), 7, 8.

## Provenance (W4 reconciliation)

This file was promoted from `specs/whatsapp-coverage.md` per
F-NEW-W4-WHATSAPP-COVERAGE-DOCS-CANONICAL after the W4 meta-specs
reconciler observed the predicate's canonical path
(`docs/source-coverage-matrix.md`) was missing.

- F-META-WHATSAPP-COVERAGE: spec written at `mcp/docs/specs/whatsapp-coverage.md`
  (DO 2026-06-07T10:10:46Z) — content covers matrix + WhatsApp/Telegram-Bot
  activation checklists + 8-criteria parity definition + operator process.
- F-NEW-W4-WHATSAPP-COVERAGE-DOCS-CANONICAL: canonical-path copy promoted
  to this file (DO 2026-06-07T20:00:00Z), with back-link added to the
  spec doc so the two stay paired.
