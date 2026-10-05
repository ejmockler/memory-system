# Operator Identity Lifecycle Specification

**Node:** F-META-IDENTITY-LIFECYCLE
**Status:** PARTIAL — per-host config file SHIPPED (v1); validity windows,
scoping, hot-reload, audit log and CLI are still FUTURE (v2)
**Severity:** major
**Owner:** memory-system core
**Depends on:** F-INFRA-R42-IDENTITY

---

## Shipped mechanism (v1)

`mcp/lib/identity/operator-identity.js` ships **no identity**. Who counts
as "the user" is per-host configuration, read from one JSON file.

### Path resolution

1. `MEMORY_OPERATOR_IDENTITY_FILE`, when set (any path).
2. Otherwise `<MEMORY_ROOT>/config/operator-identity.json`.

`config/*.json` is git-ignored; the committed template is
`config/operator-identity.example.json` (`config/*.example.json` is kept
in the tree). To configure a host, copy the example to
`config/operator-identity.json` and replace every value.

### File format

Schema tag `operator-identity-config/v1`. Every field is optional. Unless
noted, a field is an array of strings. Keys that are not listed here
(`schema`, `_comment`, `description`, ...) are ignored, so a file can
document itself.

```json
{
  "schema": "operator-identity-config/v1",
  "emails": ["alex@example.com", "alex.example@example.org", "alex@workstation.example.com"],
  "github_usernames": ["alex-example"],
  "github_orgs": ["example-org", "example-labs"],
  "github_org_actor_logins": ["example-org"],
  "imessage_handles": ["alex@example.com", "+15555550100"],
  "phone_numbers": ["+15555550100"],
  "hostname_derived_emails": ["alex@workstation.example.com"],
  "hostname_derived_review_by": "2030-01-01"
}
```

| Field | Meaning |
| --- | --- |
| `emails` | Every address the user sends mail or authors commits as, send-as aliases included. Case-insensitive match. |
| `github_usernames` | Operator-controlled GitHub user logins. Never an organization. |
| `github_orgs` | Organizations the user is a member of. Matched only when `isOperator` is called without a source hint. |
| `github_org_actor_logins` | Org logins that count as the user when they appear as the *actor* on a GitHub source (`github-events`, `github`). Separate from `github_orgs` on purpose: membership of an org does not make an actor with that login the user. |
| `imessage_handles` | Apple-ID addresses or phone handles used on iMessage. |
| `phone_numbers` | E.164 numbers. Exact match. |
| `hostname_derived_emails` | The subset of `emails` that git synthesised as `user@hostname` because `user.email` was unset. Drives the 5% dominance warning and is surfaced by `getIdentityHealth()`. |
| `hostname_derived_review_by` | String (ISO date) or `null`: when those entries should be reviewed. Surfaced as `getIdentityHealth().review_by`. |

The mail connector's former separate canonical/aliases map is gone: its
entries are ordinary `emails` members.

### Failure modes

- **Absent file = empty identity.** Every list is `[]`, `isOperator()`
  is `false` for everything, nothing throws, and exactly one line on
  stderr names the resolved path and the example file. Rows are then
  attributed the way an unregistered address already is
  (`third_party_inferred`).
- **Malformed file = loud.** A present file that cannot be read, is not
  valid JSON, is not a JSON object, or carries a wrong-typed field (a
  non-array list, a non-string member, a non-string
  `hostname_derived_review_by`) makes the import throw an `Error` naming
  the file. A half-read identity would silently mis-attribute rows in
  append-only ledgers.
- **No implicit operator.** Nothing derived from the running host (user
  name, hostname) enters the identity. A hostname-derived address counts
  only when the config file lists it.

### Load timing

The file is read **once, synchronously, at module load** (one read of
one file; the module depends only on node builtins, `mcp/lib/config.js`
and the Stage-0 telemetry module, so it is import-safe from any tier).
There is no reload: **a change to the file takes effect when the process
restarts**. Long-lived connector processes keep the identity they
started with. Rows captured before an address was registered keep their
stored `consent_basis`; ledgers are append-only.

### API (unchanged by the move to a config file)

`isOperator(identifier, source)`, `getOperatorIdentities()`,
`emitHostnameDerivedWarning(...)`, `getHostnameWarnState()`,
`resetHostnameWarnState()`, `getIdentityHealth()`, the frozen
`OPERATOR_IDENTITY` (five arrays) and the default export.

### Tests

Suites must not depend on a host's real config. They set
`MEMORY_OPERATOR_IDENTITY_FILE` to
`mcp/test/fixtures/operator-identity.synthetic.json` **before** the first
(dynamic) import of the module.

---

Everything below this line is the **future (v2) design**. None of it is
implemented: no validity windows, no scope globs, no hot-reload, no
audit log, no admin CLI.

## Problem

Operator identity changes over time:

- Graduation or institutional handle expiry (an institution-issued
  address such as `alex.example@example.org` becomes ambiguous after
  the user leaves; the address may be reassigned).
- Job change introduces new work emails; old work email is deprecated.
- Hostname rotation (operator buys a new machine; the hostname-derived
  address `alex@workstation.example.com` remains valid but maps to a
  different physical machine).
- New ad-hoc emails (operator creates a project-specific address).

The v1 identity file is loaded once at process start, never refreshed,
and never audited. There is no rotation cadence, no add/deprecate audit
log, no validity window per identity, no scoping qualifier (e.g. an
institutional address should only count as operator in repos under
`~/src/university/`), and no health check for hostname-derived
addresses on shared machines.

Consequences:
- Stale identities silently mis-classify historical data: a row authored
  by an institutional address after the user left is wrongly labeled
  `first_party`.
- New identities require a config edit + restart of every long-lived
  process; the user workflow is brittle and error-prone.
- A hostname-derived address over-trusts on shared machines (lab
  machines, lab robots, CI runners) — hence the
  `hostname_derived_review_by` marker in v1.

## Goal

Define the lifecycle for an operator identity:

1. Identity-map schema with versioning, validity windows, scope globs,
   and audit metadata.
2. Add / deprecate / rotate workflow with mandatory audit-log entry.
3. Hot-reload semantics so the daemon picks up identity changes without
   restart.
4. Health checks for stale entries and hostname-derived risk.

## Identity-map schema (FUTURE)

Schema version: 2 (the shipped config file is v1).

Same location as v1 — `config/operator-identity.json`, or the
`MEMORY_OPERATOR_IDENTITY_FILE` override:

```json
{
  "schema_version": 2,
  "identities": [
    {
      "id": "id_001",
      "email": "alex@example.com",
      "type": "primary_email",
      "valid_from": "2024-01-01T00:00:00Z",
      "valid_to": null,
      "scope": null,
      "source": "operator_self_declared",
      "added_by": "operator",
      "added_at": "2026-05-01T17:00:00Z",
      "notes": "current primary work address"
    },
    {
      "id": "id_002",
      "email": "alex.example@example.org",
      "type": "institutional_email",
      "valid_from": "2020-09-01T00:00:00Z",
      "valid_to": "2026-06-15T00:00:00Z",
      "scope": {
        "repo_path_glob": [
          "~/src/university/**",
          "~/projects/university/**"
        ]
      },
      "source": "operator_self_declared",
      "added_by": "operator",
      "added_at": "2024-03-01T00:00:00Z",
      "notes": "left 2026-06-15; address may be reassigned after that"
    },
    {
      "id": "id_003",
      "email": "alex@workstation.example.com",
      "type": "hostname_derived",
      "valid_from": "2023-01-01T00:00:00Z",
      "valid_to": null,
      "scope": {
        "machine_hostname": ["workstation.example.com"],
        "repo_path_glob": ["~/**"]
      },
      "source": "hostname_derived",
      "added_by": "system",
      "added_at": "2023-01-01T00:00:00Z",
      "notes": "fragile — must not match on shared machines (lab machines, CI)"
    }
  ],
  "deprecated_identities": [
    {
      "id": "id_old_001",
      "email": "alex@old-employer.example.com",
      "deprecated_at": "2026-04-30T00:00:00Z",
      "deprecated_by": "operator",
      "reason": "left the old employer 2026-04-30; address forwards but new mail is not operator"
    }
  ]
}
```

Key fields:

- `valid_from` / `valid_to` — rows whose `author_ts` falls outside the
  window are NOT classified as operator-authored even if the email
  matches. `valid_to: null` means "still valid".
- `scope.repo_path_glob` — institutional emails only count inside the
  matching repo paths. Prevents an institutional address from
  over-claiming in unrelated repos.
- `scope.machine_hostname` — hostname-derived identities only count when
  the daemon's current `os.hostname()` matches. On shared lab machines
  the runtime hostname differs from the user's primary machine, and
  the identity is bypassed.
- `type` taxonomy: `primary_email`, `institutional_email`,
  `hostname_derived`, `bot_actor` (added by R43), `alias`,
  `forwarding_only`.

## isOperator() v2 signature (FUTURE)

```js
isOperator(email, source, opts = {})
```

`opts`:
- `as_of_ts` — ISO timestamp to evaluate validity windows against. For
  classifying a historical commit, callers pass the commit's `author_ts`
  so post-graduation addresses don't retroactively claim
  pre-graduation rows.
- `repo_path` — absolute repo path for scope-glob matching.
- `machine_hostname` — defaults to `os.hostname()`.

Backward compatibility: existing callers that pass only `(email, source)`
still work; missing `as_of_ts` defaults to current time, missing
`repo_path` skips scope-glob enforcement (matches v1 behavior).

## Hot-reload (FUTURE)

Not implemented. Today the file is read once at module load and a change
needs a process restart (see Shipped mechanism). The design:

The identity module watches the identity file via `fs.watch` and
reloads on change. Reload errors fall back to the previous
in-memory map and emit a hard stderr warning; the daemon never crashes
on bad identity input.

Polling fallback (when `fs.watch` is not supported, e.g. some network
mounts): re-read on a `IDENTITY_RELOAD_INTERVAL_SEC` cadence
(default 300s).

Reload semantics:
- Atomic swap. A reload either fully replaces the in-memory map or
  is rolled back; partial updates are impossible.
- An in-flight `isOperator()` call observes either the old map or the
  new map consistently. No mid-call mutation.

## Audit log (FUTURE)

Not implemented.

Path: `storage/identity-audit.jsonl` (single shared, append-only).

Row schema (one row per add/deprecate/rotate/error):

```json
{
  "ts": "2026-06-07T12:00:00Z",
  "action": "add" | "deprecate" | "rotate" | "reload_ok" | "reload_error",
  "identity_id": "id_004",
  "email_hash": "blake2b-trunc-16-hex of lowercased email",
  "actor": "operator" | "system",
  "reason": "free-form notes",
  "schema_version": 2
}
```

`email_hash` is used (not raw email) so the audit log is not itself a
PII leak surface; the user can reverse-lookup via the identities
file.

Mutation rules:
- The audit log is APPEND-ONLY. Never edit prior rows.
- Every mutation to the identity file MUST be paired with an
  audit-log entry. Mutations without an entry are detected by the
  health check (mtime-diff vs last audit entry) and flagged.
- Tamper detection (v2 feature): each row carries
  `prev_row_checksum` for chained verification.

## CLI surface (FUTURE)

Not implemented. Today the user edits the JSON file by hand.

New tool: `mcp/scripts/identity-admin.mjs`

```
identity-admin add --email X --type primary_email [--valid-from ISO] [--scope-glob G] --reason "..."
identity-admin deprecate --id id_001 --reason "..."
identity-admin rotate --from id_001 --to id_002 --reason "..."
identity-admin list [--include-deprecated]
identity-admin audit [--since ISO]
identity-admin health
```

The `health` subcommand reports:
- Stale entries: any identity whose `valid_to < now` but is not in
  `deprecated_identities`.
- Hostname-derived risk: `hostname_derived` identities with no
  `scope.machine_hostname` qualifier.
- Audit-log gap: mutations without paired audit entries.
- File integrity: checksum mismatch between current file and last
  audit-derived expected checksum.

## Hostname-derived health check (FUTURE)

v1 ships only the 5% dominance warning (`emitHostnameDerivedWarning`)
over the config's `hostname_derived_emails`. The scoped check below is
not implemented.

Daemon-start (and per `IDENTITY_RELOAD_INTERVAL_SEC` reload) check:

```
for each identity where type = "hostname_derived":
  if scope.machine_hostname is null OR
     os.hostname() not in scope.machine_hostname:
    emit stderr warning + memory_connectors_list.health.identity =
      "hostname-derived-without-scope"
```

This catches the failure mode where a hostname-derived address is loaded on a
shared lab Mac and would silently mis-classify everyone's git commits
as the user's.

## Migration from v1 (FUTURE)

A one-shot migration tool (`identity-admin migrate-from-v1`) reads the
current v1 config file and writes a v2 file with:
- All current entries marked `type: primary_email`,
  `valid_from: 1970-01-01`, `valid_to: null`, `scope: null`.
- Audit log seeded with a single `migrate-from-v1` row per identity.

The user MUST then manually annotate:
- Institutional emails → set `valid_to` + `scope.repo_path_glob`.
- Hostname-derived emails → set `scope.machine_hostname`.
- Bot actors → either move to R43 bot list or set `type: bot_actor`.

The migration tool emits a stderr message naming each entry that should
be reviewed; the user gets a forced checklist.

## Review questions (from node)

1. Are validity windows per identity supported?
   YES — `valid_from` / `valid_to` per entry; `isOperator()` evaluates
   against `as_of_ts`.
2. Is the audit log durable and tamper-evident?
   Durable: append-only file, paired with every mutation. Tamper-evident:
   `prev_row_checksum` chain (v2 enhancement).
3. Does the spec address hostname-derived risk?
   YES — `scope.machine_hostname` qualifier + daemon-start health check
   + warning emission on un-scoped hostname-derived entries.
4. How are stale identities detected at runtime?
   `identity-admin health` reports them; the daemon emits a warning at
   reload time for any entry whose `valid_to` is in the past but is not
   in `deprecated_identities`.

## Open questions / future work

- Multi-operator support: schema is single-operator only. If the
  memory-system is ever shared between humans (unlikely, but possible
  for a partner / co-founder shared rig), the schema needs an `owner`
  field per identity.
- HSM / Yubikey binding for the audit log (out of scope for v1).

## Files to touch (implementation, future PR)

- `mcp/lib/identity/operator-identity.js` — v2 schema reader, scope
  evaluator, hot-reload
- `mcp/scripts/identity-admin.mjs` — new CLI
- `config/operator-identity.json` — v2 format (migrated from the v1 file)
- `storage/identity-audit.jsonl` — new audit log
- `mcp/lib/tools/memory_connectors_list.js` — surface identity health

## Risk

- File-watch unreliability on some filesystems → polling fallback.
- Operator confusion between "deprecate" and "rotate" actions; the CLI
  prompts disambiguate.
- Schema migration creates the obligation to annotate institutional
  identities; without the annotation, post-departure
  mis-classification persists.
