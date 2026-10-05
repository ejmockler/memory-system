# Workflow Script Template (R34 / B10)

This document defines the required structure for every memory-system workflow
script. A workflow script that breaks these rules is **structurally malformed**
and must not be dispatched.

The standalone validator script that once enforced these rules, and the
in-repo archive of per-round workflow scripts it checked, are not part of the
published tree. The rules remain as an authoring convention, checked at review;
`mcp/scripts/verify-edit.mjs` (the artifact check the rules require) is still
shipped.

## Why

R33 built B7 `verify-edit.mjs` — a hash-based artifact-check that catches
agents claiming-to-edit without actually editing. R33 then DID NOT use it.
R33's Phase B/C agent task prompts mentioned verify-edit only in passing; no
manifests were captured; Gate 6 had nothing to check; R33 commit 2c85d82
failed the gates R33 itself shipped.

The root cause is structural: an optional contract is not a contract. The
agent task **template** must require the dogfood, not the workflow author.

## The Two Rules

Two rules apply to every agent task body:

### R1 — Edit-implies-verify

Any task body that contains an edit directive (`Edit`, `Write`, `EDIT`,
`WRITE`, `CREATE`, `REFACTOR`, `extend`) MUST also contain all three tokens:

- `verify-edit`
- `capture`
- `verify`

These tokens are the minimum surface area for a viable dogfood checklist:
capture-before, verify-after. A task that tells the agent to mutate the
filesystem but does not tell it to fingerprint the mutations is asking for
narrative-instead-of-edits.

### R2 — Phase-B/C-requires-DOGFOOD

Any agent task whose enclosing `phase('...')` title matches a Build or Apply
phase MUST contain the literal token `DOGFOOD` somewhere in its body. The
canonical place for this token is a section header `DOGFOOD checklist:` near
the end of the task body.

The phases that trigger R2:

- `Build foundations`
- `Build root-cause foundations`
- `Apply foundations to close ...`
- `Apply with dogfood discipline`
- anything containing `close-out`, `close r32`, or `with dogfood discipline`

Phase A (inventory), Phase D (operator), Phase E (verification), Phase F
(brutalist), Phase G (triage) are not required to embed a DOGFOOD section.
Those phases either read sources, run commands, or call other tools.

## Canonical Agent Task Template

Every Phase B/C agent task body should include the following section verbatim
or close to it. The exact text is not required — only the
`DOGFOOD` token + the three `verify-edit` / `capture` / `verify` tokens — but
this is the recommended boilerplate:

```
STRICT DOGFOOD CHECKLIST (REQUIRED):
- Step 1: BEFORE any Edit/Write, invoke Bash to run:
    node <checkout>/mcp/scripts/verify-edit.mjs capture \
      --files=<comma-sep list of files you plan to edit> \
      --output=/tmp/<workflow>-<agent>-manifest.json
- Step 2: Make changes via Edit/Write tool calls.
- Step 3: AFTER all edits, invoke Bash to run:
    node <checkout>/mcp/scripts/verify-edit.mjs verify \
      --manifest=/tmp/<workflow>-<agent>-manifest.json \
      --required-changes=<comma-sep list of files that must have changed>
- Step 4: Include the FULL stdout of the verify command in your return text
  VERBATIM, under a "## DOGFOOD verify-edit output" header.
- Step 5: If verify reports any required file as unchanged: that is a contract
  violation; surface as BLOCKER, do not claim completion.

Triage checks your return for the DOGFOOD section. Missing or failing dogfood
= BLOCK.
```

## Shared Agent Context Pattern

Workflow scripts use a `SHARED_<PHASE>_CONTEXT` constant to inject common
prose into every parallel agent task. The shared context MUST end with the
DOGFOOD requirement so every agent inherits it:

```js
const SHARED_FOUNDATION_CONTEXT = ARCH_CONTEXT + '\n\n' +
  PRIOR_ARTIFACTS + '\n\n' +
  'DISCIPLINE:\n' +
  '- ES modules + plain JS, no new deps\n' +
  '- HERMETIC tests\n' +
  '- After every edit: spec-sweep + npm test\n' +
  '- No emojis\n' +
  '- KEY_LEAKAGE_ZERO\n' +
  '- Each agent OWNS specific files per the foundation; no two agents touch the same file\n' +
  '- DOGFOOD: every agent MUST use B7 verify-edit.mjs to confirm its own edits.\n' +
  '  Step 1: node mcp/scripts/verify-edit.mjs capture --files=<list> --output=<manifest>\n' +
  '  Step 2: make changes via Edit/Write\n' +
  '  Step 3: node mcp/scripts/verify-edit.mjs verify --manifest=<manifest> --required-changes=<list>\n' +
  '  Step 4: include the verify-edit verify output VERBATIM in your return\n' +
  '  Failure to dogfood = workflow-side BLOCK by triage\n';
```

## Triage Schema

The triage agent in Phase G must record a per-agent field
`dogfood_status: "PASS" | "FAIL" | "MISSING"`. Brutalist Phase F runs
verify-edit independently against the union of all agent edit lists and cross-
checks. Discrepancies between agent-reported PASS and brutalist-verified PASS
are themselves triage findings.

## R33 vs R34 Contrast

| Workflow | DOGFOOD tokens | verify-edit references | Verdict under the rules |
|----------|----------------|------------------------|-------------------------|
| R33      | 0              | 19                     | FAIL              |
| R34      | many           | many                   | PASS              |

R33 mentioned verify-edit nineteen times in prose but never required any agent
to USE it. R34 bakes the DOGFOOD checklist into every Phase B and Phase C
agent task body and into the shared context. R33 is the historical regression
case the rules were written for.

## Agent return persistence (R36 convention)

R35 brutalist Phase (e) verified DOGFOOD enforcement via script-scan but could
not perform an independent per-return audit because agent return text was not
persisted to disk. The orchestrator received each agent's return into memory,
synthesized it into a final report, and discarded the raw text. There was no
on-disk artifact a downstream auditor could inspect per-agent.

R36 closes this observability gap with a workflow-harness convention:

### Convention

1. Every workflow script creates `/tmp/<workflow-name>/agent-returns/` at the
   top of its body (before dispatching any phases).
2. Every Phase B/C agent task prompt includes a Step 6 in its DOGFOOD checklist
   requiring the agent to append its return text to
   `/tmp/<workflow-name>/agent-returns/<slug>.md` before returning. The slug is
   the agent's task label (e.g. `S4-agent-return-persistence`).
3. Triage Phase G can then walk the directory and perform per-return DOGFOOD
   audit on every agent independently — confirming the verify-edit output is
   present, the required-changes list is non-empty, the agent did not skip
   any structural discipline.

### Canonical Step 6 boilerplate

Append this line verbatim to the DOGFOOD CHECKLIST of every Phase B/C agent
task body, alongside Steps 1-5:

```
- Step 6: Append your return text to /tmp/<workflow-name>/agent-returns/<slug>.md before returning.
```

### Why per-return persistence matters

- R35 brutalist could only verify DOGFOOD compliance at the workflow-script
  level (the R34 B10 script scan). It could not confirm individual agents emitted
  the verify-edit output their task required.
- A future R32-style accident (agent claims edits but did not edit) becomes
  triage-detectable per-agent: the agent's return file is read, its DOGFOOD
  section inspected, and discrepancies surface immediately.
- The convention is workflow-script-side discipline (the orchestrator writes
  the directory; the agent appends its return). No code-level change to the
  agent-runtime is required.

### Rule R3 — agent-returns-persistence

A third rule applies to R36+ workflow scripts: the script MUST contain the
literal token `agent-returns` somewhere in its agent task bodies (the signal
that the convention is followed). R33, R34 and R35 predate the rule.

A workflow that fails R3 is structurally incompatible with per-return audit
and must not be dispatched.

## Canonical-content blocks (B12) — required for machine-consumed KB content

A R34+ workflow that introduces new machine-consumed KB content (formulas,
schemas, identifier lists, fixed JSON exemplars) MUST wrap that content in a
CANONICAL block in the source markdown:

```
<!-- BEGIN-CANONICAL: <name> -->
... content ...
<!-- END-CANONICAL: <name> -->
```

The consumer test or production module reads by name via
`extractCanonical(filePath, name)` from
`mcp/scripts/canonical-block-scan.mjs`. The block sha256 is locked in
`mcp/policy/canonical-allowlist.json` with the consumer files listed in the
`consumers` field. `npm test` runs `canonical-block-integrity.test.mjs` which
diffs the tree against the allowlist; any unrecorded mutation, deletion, or
move fails.

The first canonical block, locked in R34, is `source_msg_id_formula` in
`kb/build-plan.md`. See `kb/deprecation-discipline.md § Canonical-content
blocks (R34 B12)` for the full rule set.

### Migration discipline

When a deprecation round migrates or retires a section of a KB doc, it MUST:

1. List every CANONICAL block inside the section being touched.
2. For each: explicitly decide KEEP (block survives, content authoritative)
   or REMOVE (block + allowlist entry + consumer wiring all retired in
   lockstep).
3. Run `node mcp/scripts/canonical-block-scan.mjs` against the post-edit
   tree before the round closes.

A round that fails this discipline produces the R32.1 failure mode: machine-
consumed content silently deleted, regression visible only at npm test or
brutalist phase. R34 ships this discipline AND applies it to itself.
