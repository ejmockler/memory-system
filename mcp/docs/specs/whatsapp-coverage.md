# WhatsApp / Telegram-Bot Coverage Gaps

**Node:** F-META-WHATSAPP-COVERAGE
**Status:** SPEC — pending implementation
**Severity:** minor
**Owner:** memory-system core
**Canonical matrix copy:** [`../source-coverage-matrix.md`](../source-coverage-matrix.md)
(higher-level docs-tree home, promoted per
F-NEW-W4-WHATSAPP-COVERAGE-DOCS-CANONICAL — keep this spec doc and the
canonical copy in lockstep)

---

## Problem

The R39 connector audit reviewed 9 sources (git-log, codex-cli,
screentime, imessage, mail, github-events, slack, codex-runtime, telegram)
but the daemon also runs `whatsapp` and `telegram-bot`. The whatsapp
connector exists as code (`mcp/lib/connectors/whatsapp.js`) but its
behavior was reviewed code-only, not ledger-against-corpus. The unified
Stage-0 taxonomy, cross-source dedup contracts, and bot-actor regex
inherited from R43 may not apply uniformly to whatsapp + telegram-bot
because their event shapes differ in undocumented ways.

Concrete failure modes:

- Cross-source dedup (F-T1-IMESSAGE × F-T1-WHATSAPP for the same person
  on both platforms): unimplemented.
- Bot-actor regex (R43) excludes WhatsApp Business API senders by
  default because the regex assumes operator-machine shape (`[bot]@`,
  `dependabot`, etc.); WhatsApp business numbers look like phone numbers
  with a verified-checkmark side channel.
- Stage-0 reasons emitted by whatsapp connector are not yet in
  `REASON_ALLOWLIST` (telemetry buckets them as `invalid_reason`).
- Telegram-bot (the bot-API connector, distinct from `telegram` user
  client) emits a different event shape than the user client and was
  not represented in the R39 sample.

## Goal

1. A source-coverage matrix that maps each connector to each cross-
   source feature, exposing the gaps.
2. An activation checklist for whatsapp + telegram-bot: fixtures,
   reason allowlist, bot-actor regex update, cross-source dedup
   contract.
3. Parity acceptance criteria so future cross-source features land in
   ALL sources, not just the ones the audit happened to sample.

## Source-coverage matrix

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

## WhatsApp activation checklist

1. **Fixture corpus**: `mcp/test/fixtures/whatsapp/` with 50 sample
   rows covering:
   - 1:1 chat (operator-sender, operator-recipient)
   - 1:1 chat (counterparty-sender, operator-recipient)
   - group chat (operator-sender)
   - group chat (counterparty-sender)
   - business message (verified business + OTP-like content)
   - status / story
   - media-only message (image / voice / sticker)
   - call event (missed / placed / received)
   - system message (encryption change, group join, etc.)

2. **Reason allowlist**: extend `REASON_ALLOWLIST` in
   `mcp/lib/ingest/stage0/telemetry.js` with:
   - `whatsapp_system_message`
   - `whatsapp_business_otp`
   - `whatsapp_call_event_no_content`
   - `whatsapp_status_post`
   - `whatsapp_media_only_no_text`

3. **Bot-actor regex**: extend `BOT_ACTOR_REGEX` in
   `mcp/lib/identity/bot-actors.js` with WhatsApp Business API
   indicators:
   - WhatsApp Business Platform IDs (numeric + verified-business flag)
   - Verified-checkmark side channel: presence of
     `verified_business_name` in the row's raw_content flips the
     `is_bot_actor` verdict.

4. **Cross-source dedup contract**: when a phone number appears in both
   imessage + whatsapp ledgers, share a normalized
   `cross_source_party_id` (E.164 normalized) so cross-source
   corroboration finds the same person.

5. **Quarantine semantics**: WhatsApp media messages with missing text
   AND missing transcription MUST quarantine (not permanent drop) so
   the user can review.

## Telegram-bot activation checklist

The `telegram-bot` connector covers Telegram Bot API events (incoming
messages to a registered bot), as distinct from the `telegram`
connector which covers operator user-client events.

1. **Fixture corpus**: `mcp/test/fixtures/telegram-bot/` with 30 sample
   rows:
   - `/start` command from a user
   - inline-keyboard callback
   - text message in a private chat
   - text message in a group chat
   - channel post
   - edited message
   - error / dropped update

2. **Reason allowlist** additions:
   - `telegram_bot_command`
   - `telegram_bot_callback_query`
   - `telegram_bot_channel_post`
   - `telegram_bot_edited_message`

3. **Bot-actor regex**: telegram-bot ALL author rows are by definition
   bot-actor (the user's own bot is still a bot for actor-typing
   purposes). The bot's user-id flips `is_bot_actor=true` in stage-0
   classification.

4. **Cross-source dedup**: when a Telegram user interacts with both the
   user client AND the bot, share normalized
   `cross_source_party_id` (the Telegram user-id).

## Parity acceptance criteria

A connector is at "parity" with the unified taxonomy when all of:

1. All emitted reasons are in `REASON_ALLOWLIST`.
2. The connector's `getDedupStats()` (or equivalent) returns the same
   field shape as `git-log-local.js`.
3. R42 identity map is consulted for operator emails / handles via the
   canonical `isOperator` predicate.
4. R43 bot-actor predicate is consulted via the canonical `isBotActor`
   predicate.
5. R44 quarantine is invoked for DROP paths that have corroboration
   value (per the brutalist invariant: prefer structural_score
   downgrade over DROP; when DROP is unavoidable, quarantine).
6. R49 redaction is applied at emit.
7. The connector has a fixture corpus of at least 30 rows covering
   the full event taxonomy.
8. The connector ships with an `--once` CLI surface and an
   integration test that exercises it against the fixture corpus.

WhatsApp and telegram-bot do not currently meet criteria 1, 2, 3, 4,
6 (partial), 7, 8.

## Operator process

When the audit identifies a new cross-source feature (R50+):
1. Add a column to the source-coverage matrix.
2. Update every cell — including whatsapp + telegram-bot — to
   "NO" / "partial" / "YES" / "n/a".
3. NO cells become workunit nodes.

This prevents the "we audited 9, forgot whatsapp" failure mode from
recurring.

## Review questions (from node)

1. Is whatsapp covered by cross-source dedup contracts?
   NOT YET — see WhatsApp activation checklist item 4. Spec defines
   what coverage means.
2. Is telegram-bot in the unified bot-actor regex?
   NOT YET — see Telegram-bot activation checklist item 3.
3. Are coverage gaps explicitly enumerated?
   YES — source-coverage matrix above.

## Files to touch (implementation, future PR)

- `mcp/docs/specs/whatsapp-coverage.md` — this file
- `mcp/docs/source-coverage-matrix.md` — canonical copy of the matrix in
  the higher-level docs tree (landed 2026-06-07 per
  F-NEW-W4-WHATSAPP-COVERAGE-DOCS-CANONICAL)
- `mcp/test/fixtures/whatsapp/` — fixtures (new)
- `mcp/test/fixtures/telegram-bot/` — fixtures (new)
- `mcp/lib/ingest/stage0/telemetry.js` — REASON_ALLOWLIST additions
- `mcp/lib/identity/bot-actors.js` — BOT_ACTOR_REGEX additions
- `mcp/lib/connectors/whatsapp.js` — wiring
- `mcp/lib/connectors/telegram-bot.js` — wiring (file may need to be
  created; current state is the user-client `telegram.js`)

## Risk

- WhatsApp Business API formats change over time; the verified-business
  flag is the most stable signal.
- Telegram-bot updates have multiple delivery modes (long-poll vs
  webhook); both produce the same event shape, so this is not a
  classification issue.
- Cross-source party-id normalization requires care with international
  phone formats; E.164 is the spec.
