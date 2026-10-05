# Security policy

This project stores and indexes personal data on the machine it runs on:
messages, mail, and activity records. Please treat any weakness that could
expose or corrupt that data as a security issue.

## Reporting a vulnerability

Report privately. Do not open a public issue, pull request or discussion for
a suspected vulnerability.

Use GitHub's private vulnerability reporting: on the repository page, open
the **Security** tab and choose **Report a vulnerability**. The report is
visible only to the maintainers until a fix is published.

## What to include

- The commit or version you tested, your macOS version and your Node version.
- What an attacker could do: read data, change data, run code, or bypass a
  check such as signing, role gates or redaction.
- Steps to reproduce, using synthetic data only.
- Any fix or mitigation you have in mind.

## What not to post in public

- Details of an unfixed vulnerability, or proof-of-concept code for one.
- Real personal data of any kind: names, addresses, phone numbers, messaging
  ids, message text, or the contents of your own memory store.
- Keys, tokens, signing material or session credentials. If you find one in
  the tree or its history, report its location (path and line) privately and
  do not quote the value.

## What to expect

The owner will acknowledge a private report, confirm whether it reproduces,
and tell you when a fix lands. This is a small project without a formal
response time or a bug bounty.

## Scope

In scope: the MCP server under `mcp/`, the daemons, hooks and install
scripts in this repository. Out of scope: vulnerabilities in Node.js, macOS or
third-party dependencies themselves; report those to their maintainers.
