# Connectors — Phase 3 (Mail + WhatsApp)

R39 Phase 3 ships two source-tier connectors: Apple Mail (B1) and WhatsApp
Desktop (B2). Both are pure local SQLite reads gated by Full Disk Access on
the node binary their rendered plists name: `scripts/render-launchd.mjs`
writes the `--node <path>` binary, by default the node that ran the render
script, and one grant to that binary (the same one iMessage needs) covers
both paths.

This file carries the canonical row-shape blocks consumed by the connector
implementations and downstream salience / replay machinery. Edits to the
inner content of any `BEGIN-CANONICAL:` block require updating the sha256
in `mcp/policy/canonical-allowlist.json` (and rerunning
`bash mcp/scripts/update-allowlist-sentinel.sh`) in the same change.

## Mail row shape

<!-- BEGIN-CANONICAL: mail_row_shape -->
{
  "id": "<ulid>",
  "ts": "<ISO-8601 from messages.date_received (unix seconds)>",
  "source": "mail",
  "source_msg_id": "<messages.document_id — Apple-stable per-message identifier>",
  "parties": ["<lowercased operator and counterparties from From/To/Cc>"],
  "raw_content": {
    "text": "<text/plain part after signature + quoted-thread strip, or htmlToText fallback>",
    "subject": "<subjects.subject joined from messages.subject>",
    "headers": {
      "from": "<RFC 5322 From: header raw value>",
      "to": "<RFC 5322 To: header raw value or null>",
      "cc": "<RFC 5322 Cc: header raw value or null>",
      "message-id": "<RFC 5322 Message-ID or null>",
      "list-id": "<RFC 2919 List-Id or null>",
      "list-unsubscribe": "<RFC 2369 List-Unsubscribe or null>",
      "auto-submitted": "<RFC 3834 Auto-Submitted or null>",
      "precedence": "<legacy Precedence or null>",
      "return-path": "<RFC 5322 Return-Path or null>",
      "content-type": "<RFC 2045 Content-Type or null>"
    },
    "unsubscribe_type": "<Apple messages.unsubscribe_type — >0 = bulk-mail bucket>",
    "list_id_hash": "<Apple messages.list_id_hash — present = mailing-list-routed>",
    "automated_conversation": "<Apple messages.automated_conversation — >0 = auto-responder>",
    "brand_indicator": "<Apple messages.brand_indicator — sender-brand classification id>",
    "has_plain": false,
    "has_html": false,
    "body_resolved": false
  },
  "attachments": [],
  "source_policy": {
    "deletion_semantics": "full_excise",
    "consent_basis": "first_party | second_party_dm | third_party_inferred"
  },
  "checksum": "<blake2b512-truncated-16-hex of canonical_json without checksum>"
}
<!-- END-CANONICAL: mail_row_shape -->

Mail-specific notes:

- `date_received` is unix seconds (not nanoseconds since Mac epoch like
  iMessage). All values fit in `Number` safe-integer regime — no BigInt
  path needed.
- The connector reads body bytes from `.emlx` files under
  `~/Library/Mail/V<N>/.../Messages/<document_id>.emlx`. Apple's `.emlx`
  format is `<byte-count>\n<RFC 5322 message>\n<binary plist trailer>`;
  `readEmlxBody` slices via the leading byte-count header so the binary
  trailer never reaches the MIME extractor.
- Consent classification asks one question per address: is it the user?
  The answer comes from the user identity config (the `emails` list in
  `config/operator-identity.json`, or the file named by
  `MEMORY_OPERATOR_IDENTITY_FILE`), read by
  `mcp/lib/identity/operator-identity.js`. A caller may also inject an
  `identityMapPath` (JSON shaped `{canonical, aliases[]}`); its addresses
  are unioned with the config, and no such file ships or is read by
  default. Outcomes: a From: address that is the user → `first_party`;
  the user as the only recipient (no other To:, no Cc:) →
  `second_party_dm`; everything else (several recipients, or not addressed
  to the user) → `third_party_inferred`.
- Stage-0 (`mcp/lib/ingest/stage0/mail.js`) drops in priority order: Apple
  `unsubscribe_type > 0` → `list_id_hash != null` → header
  `List-Unsubscribe` → header `List-Id` → header `Auto-Submitted` matches
  `auto-*` → header `Precedence` is `bulk|junk|list` → From: matches
  `noreply|no-reply|donotreply` → Return-Path matches marketing-platform
  (mailchimp/sendgrid/mailgun/sparkpost/amazonses) → Apple
  `automated_conversation > 0` → OTP pattern → placeholder residual.

## WhatsApp row shape

<!-- BEGIN-CANONICAL: whatsapp_row_shape -->
{
  "id": "<ulid>",
  "ts": "<ISO-8601 from ZMESSAGEDATE (Core Data seconds since 2001-01-01)>",
  "source": "whatsapp",
  "source_msg_id": "<ZSTANZAID — XMPP-style stable stanza identifier>",
  "parties": ["<jid_or_user>", "<jid_or_user>"],
  "raw_content": {
    "text": "<ZTEXT or null>",
    "from_jid": "<ZFROMJID or null>",
    "to_jid": "<ZTOJID or null>",
    "session_jid": "<ZWACHATSESSION.ZCONTACTJID or null>",
    "is_from_me": 0,
    "message_type": "<ZMESSAGETYPE int — 7 = reaction>",
    "group_event_type": "<ZGROUPEVENTTYPE int — >0 = system event>",
    "session_type": "<ZWACHATSESSION.ZSESSIONTYPE — 0=1:1, 1=group, 2=broadcast>",
    "message_date_coredata": "<float Core Data seconds, original numeric>",
    "has_media": false,
    "media_local_path": "<ZWAMEDIAITEM.ZMEDIALOCALPATH or null>",
    "media_title": "<ZWAMEDIAITEM.ZTITLE or null>",
    "parent_stanza_id": "<present only on reaction rows>"
  },
  "attachments": [],
  "source_policy": {
    "deletion_semantics": "full_excise",
    "consent_basis": "first_party | second_party_dm | third_party_inferred"
  },
  "kind": "<reaction — present only on ZMESSAGETYPE=7 rows>",
  "derived_from": ["<parent ZSTANZAID — present only on reaction rows>"],
  "checksum": "<blake2b512-truncated-16-hex of canonical_json without checksum>"
}
<!-- END-CANONICAL: whatsapp_row_shape -->

## Notes

- WhatsApp's `ZMESSAGEDATE` is Core Data seconds since 2001-01-01 (float).
  All real values fit in `Number` safe-integer regime — no BigInt path
  needed (contrast: iMessage `message.date` uses nanoseconds and exceeds
  2^53 in production).
- Reactions surface as `ZMESSAGETYPE=7` rows referencing the parent message
  via `ZPARENTMESSAGE`. The connector joins to the parent and stamps
  `derived_from = [parent.ZSTANZAID]`.
- Stage-0 (`mcp/lib/ingest/stage0/whatsapp.js`) drops: reactions, group
  system events (join/leave/etc. — `ZGROUPEVENTTYPE > 0`), broadcast lists
  (`ZSESSIONTYPE = 2`), media-only (no caption text), OTP patterns, and
  placeholder residual (text length &lt; 2).
