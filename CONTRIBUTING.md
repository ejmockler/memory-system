# Contributing

Thanks for looking at this project. This page covers what you need to run the
tests and the two rules every change has to follow.

## Supported Node versions

- Minimum: Node 22.18.0 (`engines.node` in `mcp/package.json`).
- Tested: Node 24.15.0, the version the suites are developed and run against.

The floor comes from what the code and the suites import: `zlib.crc32`
(Node 22.2) and the built-in `node:sqlite` module without a flag (Node 22.13).
The stated minimum sits just above those, at 22.18.0, which is the lowest
version CI runs. Older Node versions are refused by the test runner with a
clear message; they are not supported.

CI runs the full suite on macOS for both versions above.

## Running the tests

```sh
cd mcp
npm ci
npm test                 # every suite, with a tally at the end
npm run test:fail-fast   # stop at the first failing suite
```

`npm test` takes about four minutes. It needs no network, no model server and
no cloud key. Passing suites print a lot of output, including lines that look
alarming but are expected, because the suites provoke those conditions on
purpose in throwaway directories. Two examples:

- `CRITICAL: signing key at ... is inside a git working tree ...`
- `[git-log dedup] STREAMING LEDGER SCAN FAILED (read-error:EISDIR) ...`

Judge a run by the summary at the end (`failed: 0`) and the exit code, not by
such lines.

To check only that your Node is supported, without running any suite:

```sh
cd mcp && node scripts/run-all-tests.mjs --preflight-only
```

To run a single suite, call it directly from `mcp/`:

```sh
node test/<suite>.test.mjs
```

Some suites use the `node:test` runner; for those `node --test test/<suite>.test.mjs`
gives nicer output. Either form works.

Runner exit codes: `0` every suite passed, `1` a suite failed or nothing ran,
`2` the runner refused to start (unsupported Node, unknown argument, or a suite
registry mismatch).

## One suite registry

The `SUITES` array in `mcp/scripts/run-all-tests.mjs` is the only list of
suites that `npm test` runs.

- When you add a test file under `mcp/test/` named `*.test.mjs`, add its path
  to `SUITES` in the same change.
- When you delete or rename one, update `SUITES` in the same change.
- A parity guard compares `SUITES` with the files on disk before anything
  runs and fails on any difference, so an unregistered or stale entry cannot
  slip through.
- A file that is deliberately not run goes in `ANNOTATED_SKIP` with a reason.
- The `test:*` aliases in `mcp/package.json` are optional shortcuts. Nothing
  depends on them, and adding one does not register a suite.

## Synthetic data only

Fixtures, tests, comments, docs and commit messages must contain synthetic
data only. Never commit a real name, e-mail address, phone number, messaging
id, message text, account id, or any secret or key.

Use these forms instead:

| Kind | Use |
| --- | --- |
| E-mail address | `alex@example.com`, `sam@example.org` |
| Phone number | `+1 555 0100` to `+1 555 0199` |
| Person name | `Alex Example`, `Sam Sample` |
| WhatsApp id | `15550100001@s.whatsapp.net` |

If a test needs realistic structure, keep the structure and replace every
value. If you find real data anywhere in the tree, do not copy it into an
issue; see `SECURITY.md`.

## Reporting security problems

Please do not open a public issue for a vulnerability. Follow `SECURITY.md`.
