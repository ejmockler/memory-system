#!/usr/bin/env node
// run-all-tests.mjs
//
// F-NEW-W4-VERIFY-NPM-CHAIN — sequential test runner with aggregated exit codes.
//
// PROBLEM (root cause):
//   The legacy `npm test` script was a single long `&&` chain. The first
//   failing suite short-circuited the chain and masked every downstream
//   suite — so a brittle stage0 assertion could hide regressions in 50+
//   other suites. Operators saw "tests fail" but had no idea how many.
//
// FIX:
//   Drive each test suite ourselves: spawn `node <suite>`, capture stdout +
//   stderr, record the exit code, and continue to the next suite regardless
//   of pass/fail. At the end, print a tally and exit non-zero iff ANY suite
//   failed. Every suite always gets a chance to run.
//
// Discipline:
//   - Node stdlib only. No new deps.
//   - Hermetic at the script level (delegates to existing suite hermeticity).
//   - Resolves the suite list from the hard-coded SUITES literal below (:47),
//     which is the SOLE authority. It is NOT read from package.json: that
//     file's `test` script is only `node scripts/run-all-tests.mjs`.
//     (Corrected 2026-08-12 — the previous claim here sent an agent down a
//     package.json path that nothing dispatches through.)
//
// CLI:
//   node mcp/scripts/run-all-tests.mjs            # run every suite
//   node mcp/scripts/run-all-tests.mjs --fail-fast # stop at first failure
//   node mcp/scripts/run-all-tests.mjs --quiet     # only print summary
//   node mcp/scripts/run-all-tests.mjs --preflight-only
//                                   # check the Node runtime, run nothing
//
// Node preflight: main() first checks that the running Node is >= MIN_NODE
// and really has the stdlib the suites need (node:zlib crc32, node:sqlite).
// On an unsupported Node it prints one sentence and exits 2 with no suite
// run. This file must keep parsing and loading on old Node (18+), so the
// refusal is reached instead of a link-time crash or a silent no-op.
//
// Exit codes:
//   0 = every suite exited 0 (or --preflight-only on a supported Node)
//   1 = at least one suite failed, or zero suites ran
//   2 = runner-level refusal: unsupported Node, unknown arg, parity drift

import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
// Namespace import on purpose: a named `crc32` import would fail at link time
// on a Node without it, before the preflight could refuse.
import * as zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Authoritative suite list — this array is the SOLE authority for what the
// gate runs. Adding a new suite? Add it HERE, and here only. A per-suite
// `test:*` alias in package.json is optional convenience, not a requirement:
// 81 of the previously-registered suites have no alias at all, and no test
// reads package.json for suite parity. (Corrected 2026-08-12; the previous
// "add it to package.json too" instruction was measurably stale.) The parity
// guard below (suiteParityDrift, enforced in main()) fails loudly if this list
// ever falls out of sync with test/**/*.test.mjs on disk.
export const SUITES = [
  "test/canonical-json.test.mjs",
  "test/predicate-lifecycle.test.mjs",
  "test/envelope-dispatch.test.mjs",
  "test/negative-paths.test.mjs",
  "test/daemon-token.test.mjs",
  "test/nonce-store.test.mjs",
  "test/policy-events-recall-feedback.test.mjs",
  "test/memory-role-gate.test.mjs",
  "test/source-msg-id-preimage.test.mjs",
  "test/watermark-multi-source.test.mjs",
  "test/daemons/watermark-multisource.test.mjs",
  "test/health-real-data.test.mjs",
  "test/health-read-failures.test.mjs",
  "test/signing-key-discipline.test.mjs",
  "test/memory-jsonl-durability.test.mjs",
  "test/gemini-client.test.mjs",
  "test/gemini-client-key-pool.test.mjs",
  "test/throttled-structural-error.test.mjs",
  "test/no-key-leakage-in-artifacts.test.mjs",
  "test/gemini-flash-client.test.mjs",
  "test/hard-gates.test.mjs",
  "test/transitive-orphan.test.mjs",
  "test/bm25-index.test.mjs",
  // WU-RR1 — BM25 full-rebuild from canonical ledger + daemon idle-tick
  // trigger (CAPS.BM25_REBUILD_THRESHOLD). Closes the recall Layer-1
  // candidate_set_size=0 case caused by months of incremental-promote drift.
  "test/bm25-rebuild.test.mjs",
  "test/hnsw-index.test.mjs",
  "test/propensity.test.mjs",
  "test/multi-feature-score.test.mjs",
  "test/mmr.test.mjs",
  "test/rerank.test.mjs",
  "test/promote-time-embedding.test.mjs",
  // WU2-inline-embed-and-remove-gemini-quota-machinery — cascade embeds inline
  // via the local client (mocked) and promotes WITH features.embedding_4096;
  // on LocalEmbedUnavailableError it promotes with embedding=null and records
  // the fact id to the re-embed sweep file.
  "test/cascade-inline-local-embed.test.mjs",
  "test/verify-cascade-seed-row-marker.test.mjs",
  "test/backfill-embeddings.test.mjs",
  "test/integration-phase3-v0.test.mjs",
  "test/integration-phase3-v1-rerank.test.mjs",
  "test/connector-base.test.mjs",
  "test/typedstream-parser.test.mjs",
  "test/typedstream-corpus.test.mjs",
  "test/imessage-connector.test.mjs",
  "test/connectors/imessage-name-recovery.test.mjs",
  "test/screentime-connector.test.mjs",
  "test/screentime-bigint-overflow.test.mjs",
  "test/github-events-connector.test.mjs",
  "test/git-log-local-connector.test.mjs",
  "test/codex-cli-connector.test.mjs",
  "test/mail-connector.test.mjs",
  "test/whatsapp-connector.test.mjs",
  // wa-voice-stt — on-device 1:1 voice-note transcription: V1 core
  // (whatsapp-voice.js), V3 connector wiring (in-band + late path +
  // --backfill-voice, fake runner, mkdtemp only) and V2 catch-up fold.
  "test/whatsapp-voice.test.mjs",
  "test/whatsapp-voice-connector.test.mjs",
  "test/messaging/whatsapp-voice-fold.test.mjs",
  // WORKUNIT wa-sender-names — WhatsApp facts surface WHO said it. The connector
  // LEFT JOINs ZWAGROUPMEMBER + forward-stamps raw_content.sender_jid/sender_name
  // (group: ZCONTACTNAME||ZFIRSTNAME||pushname; 1:1: partner; outbound: "user")
  // and fixes parties[] to the real member sender. A DERIVED read-only sender-
  // index (source_msg_id -> {sender_jid, sender_name}) backfills EXISTING facts;
  // recall.js joins it onto provenance.parties. Thesis #1: never mutates fact rows.
  "test/connectors/whatsapp-sender-index.test.mjs",
  "test/connectors-list-live.test.mjs",
  "test/connector-revoke-wiring.test.mjs",
  // WORKUNIT N1 — Wave-0 FROZEN Envelope contract (mcp/lib/messaging/envelope.js
  // + fixtures/). The platform-agnostic shape every adapter emits and layers 2..5
  // read. validateEnvelope() rejects missing capabilities{} (the keystone),
  // bad thread_type enum, non-integer-ms ts; the validator carries ZERO platform
  // tokens (degradation lives in capabilities{} DATA, not code branches).
  "test/messaging/envelope.test.mjs",
  // WORKUNIT N2 — L2 addressing classifier (mcp/lib/messaging/classifier.js).
  // classifyDirectedAtMe(envelope) is PLATFORM-AGNOSTIC: degrades via
  // capabilities{} DATA (reply_to_available false -> redistribute, not negate;
  // self_identity_reliable false -> down-weight mention; addressing_first_class
  // gates addressed_to_me). ZERO platform tokens, NO adapter import (both
  // asserted in-test). A capability bit-flip moves the score (the gate delta).
  "test/messaging/n2-classifier.test.mjs",
  // WORKUNIT N3 — the WhatsApp ADAPTER (mcp/lib/messaging/adapters/whatsapp.js):
  // _toEnvelope(raw_whatsapp_row) -> N1 Envelope. Stamps the maximally-degraded
  // WhatsApp capability profile (all four FALSE) as DATA; thread_type by JID-suffix
  // + session_type; ISO ts -> integer ms. FILLS the 1:1 partner-name gap in
  // whatsapp-sender-index.js (ZWAPROFILEPUSHNAME[from_jid] fallback): over 400 real
  // 1:1 inbound rows, sender_name null-rate 14.0% -> 5.8% (Y<X). Real-row fixture.
  "test/messaging/n3-whatsapp-adapter.test.mjs",
  // WORKUNIT N4 — iMessage L1 adapter (mcp/lib/messaging/adapters/imessage.js).
  // Pure row->Envelope projection (Thesis #1: read-only over the connector's
  // ledger row, no chat.db / AddressBook re-query). Proves the field map +
  // gate (valid=N/N reply_present=K/K group_parties_ok=M/M), the inline
  // isGroupChat parity (imessage.js:473-486), reply_to_available=true (the
  // WhatsApp contrast), ISO->integer-ms ts, and capabilities-as-data (no
  // platform branch, no frozen-layer import).
  "test/messaging/n4-imessage-adapter.test.mjs",
  // WORKUNIT N5 — Email (Mail) L1 adapter (mcp/lib/messaging/adapters/mail.js).
  // Pure raw_mail_row->Envelope projection (Thesis #1: read-only over the mail
  // connector's ledger row, no Envelope-Index re-query). THE platform that sets
  // capabilities.addressing_first_class=true: addressed_to_me is read DIRECTLY
  // off To:/Cc: membership via the union isOperatorEmail (local alias map ∪
  // isOperator(.,"mail")), not inferred. Proves the gate (valid=N/N
  // addressed_true=1 addressed_false=1), In-Reply-To precedence + References-root
  // thread grouping, seconds->integer-ms ts (the unit trap), reply_to_me NOT
  // faked at L1, mentions=[] / structured_mentions=false, orphan rowid:<n>
  // fallback, and zero foreign-platform tokens (capabilities-as-data, no branch).
  "test/messaging/n5-mail-adapter.test.mjs",
  // WORKUNIT N6 — Telegram L1 adapter (mcp/lib/messaging/adapters/telegram.js).
  // _toEnvelope(raw_telegram_row)->Envelope behind an ACTIVATION gate (login not
  // yet active: collect() returns []+inactive marker until a session exists; the
  // pure mapper still emits valid envelopes from fixtures). capabilities.
  // structured_mentions=true (platform nature + adapter readiness) but mentions=[]
  // until telegram_tail.py lands message_entities extraction (documented gap).
  // user->dm wire trap, supergroup->group collapse, tg:-namespaced reply ids,
  // is_outgoing||is_self is_from_me, ISO->integer-ms ts. Conforms to the N1
  // frozen Envelope; ZERO platform branches escape this file (Thesis #1 read-only).
  "test/messaging/n6-telegram-adapter.test.mjs",
  // WORKUNIT N7 — cross-platform PERSON resolver (mcp/lib/messaging/identity.js).
  // buildPersonIndex(envelopes) Union-Finds identifier nodes into one person:
  // is_from_me + seeded operator-identity links anchor person:operator; nodes
  // sharing a normalized identifier (same E.164 — bare OR digits@domain, same
  // email) cluster into one person. PLATFORM-AGNOSTIC: imports NO adapter, ZERO
  // platform tokens (grep gate), branches on identifier SHAPE not platform name;
  // group ids are quarantined (a shared room never merges people). Read-only
  // derived sidecar (Thesis #1): persist/loadFromCacheSync with mtime+size
  // fingerprint, deterministic (mintPersonId sorts inputs -> byte-identical
  // rebuild), deleting the cache is always safe. GATE-A operator unified across
  // >=2 platforms; GATE-B a contact unified across 2 platforms; name != identity;
  // no operator over-merge; self_identity_reliable=false + is_from_me=true still
  // unions to operator. Operator seam imported read-only, never mutated.
  "test/messaging/n7-identity.test.mjs",
  // WORKUNIT N8 — L4 attention / response-state engine
  // (mcp/lib/messaging/attention.js). computeAttention(Envelope[]) emits a
  // read-only per-thread "are they waiting on me?" projection from three
  // platform-agnostic signals: they-spoke-last (unanswered), staleness
  // (now-last_ts bucketed), and substance (REUSES scoreValence to drop
  // closer-only tails — "ah cool!"/"thanks!"/👍). Gates each trailing-run
  // message through N2's directed-at-me (a group needs a mention/reply/
  // addressing signal; a DM is structural). SOFT edge to N7: resolvePerson is
  // injected, defaults to identity (sender.id), dedups cross-platform DMs when
  // a real resolver is present. ZERO platform tokens, NO adapter import (both
  // asserted in-suite). P=R=1.0 over a 42-thread hand-labeled corpus; the
  // closer-only negative control surfaces=false (the headline gate clause).
  "test/messaging/n8-attention.test.mjs",
  // WORKUNIT N9 — L5 CATCH-UP surface (mcp/lib/messaging/catchup.js) + the
  // memory_catchup MCP tool. buildCatchup({sources,now,limit}) loads each
  // platform's source rows through a GENERIC adapter REGISTRY (platform ->
  // {toEnvelope, ledgerPath}, keyed off each adapter's own PLATFORM constant —
  // catchup.js never names a platform), maps -> Envelope[], runs N8 attention
  // (which calls N2 classifier) + N7 identity to resolve+dedup by person, and
  // returns a ranked (score non-increasing) cross-platform "waiting on you"
  // list. A person on two platforms collapses to ONE row (also_waiting_on[]);
  // closer-only / i-spoke-last threads are excluded; N7-absent degrades to
  // per-platform dedup (SOFT edge). Registered in dispatch.js; ZERO platform
  // tokens over catchup.js (M10 grep). Read-only join (Thesis #1): no source
  // mutation, no fs write.
  "test/messaging/n9-catchup.test.mjs",
  // WORKUNIT N11 — CATCH-UP QUALITY (two fixes, no platform branch above L1).
  // (A1) WhatsApp 1:1 @lid sender-name reaches the catch-up: a genuine push name
  // (sender-index) wins; an unresolvable @lid surfaces a best-effort NON-RAW
  // floor label (whatsapp.js bestEffortLidLabel) so the surface never shows a raw
  // @lid jid. (A2) Service/bot/system exclusion as DATA: the envelope contract
  // grows an ADDITIVE, OPTIONAL sender.kind ∈ {person,bot,service,system}
  // (validateEnvelope stays backward-compat — absent === person); each adapter
  // stamps it in L1 (telegram 777000=service / is_bot=bot; whatsapp
  // status/broadcast=system; imessage/mail=person); attention.js + catchup.js
  // EXCLUDE non-person by READING sender.kind — ZERO platform tokens in L2-5
  // (proven via the canonical n10-invariant-eval grep). Gate:
  // names_resolved=100% service_excluded=true platform_tokens_L2to5=0.
  "test/messaging/n11-catchup-quality.test.mjs",
  // WORKUNIT N11b — the OPTIONAL, GENERIC adapter `prepareContext()` hook. L1's
  // WhatsApp adapter exports prepareContext(): it opens ChatStorage.sqlite
  // READ-ONLY and builds the three name sidecars _toEnvelope consumes
  // ({partnerByJid,pushByJid,memberNames}), memoized per process. The L5 catch-up
  // surface calls adapter.prepareContext?.() ONCE per registry adapter — GENERIC,
  // no platform branch — and threads the result as ctx into toEnvelope(row, ctx).
  // Result: a WhatsApp 1:1 @lid DM whose name the DB genuinely knows resolves to
  // that REAL name at catch-up; the floor label fires ONLY when the DB lacks it.
  // Adapters without prepareContext (telegram/imessage/mail) default to {} →
  // unchanged. Hermetic: a throwaway tmp ChatStorage fixture opened read-only +
  // ONE real whatsapp.jsonl sample (synthetic fallback). 0 platform tokens in L2-5.
  "test/messaging/n11b-whatsapp-preparecontext.test.mjs",
  // WORKUNIT N11e — the iMessage adapter's OPTIONAL, GENERIC prepareContext()
  // (mirrors WhatsApp's). L1's iMessage adapter exports prepareContext(): it globs
  // + opens the operator's local AddressBook *.abcddb sources READ-ONLY and builds
  // the contact maps {phoneToName,emailToName} (via _imessage-name-recovery.js),
  // memoized per process. The L5 catch-up surface calls adapter.prepareContext?.()
  // ONCE per registry adapter — GENERIC, no platform branch — and threads the
  // result as ctx into toEnvelope(row, ctx). Result: an inbound iMessage DM whose
  // handle the AddressBook genuinely knows resolves to that REAL name at catch-up
  // even when the connector never stamped recovered_handle_name (the live ledger
  // nulls it on ~all rows -> sender.name was null -> person:<hash>). A
  // connector-stamped name still WINS (precedence, backward-compat). Adapters
  // without prepareContext (telegram/mail) default to {} -> unchanged; whatsapp's
  // own preparer is untouched. Hermetic: a throwaway tmp AddressBook-v22.abcddb
  // opened read-only + ONE real imessage.jsonl sample (synthetic fallback). 0
  // platform tokens in L2-5.
  "test/messaging/n11e-imessage-preparecontext.test.mjs",
  // WORKUNIT N12 (telegram-daemon) — the STAGING READ-OFFSET WATERMARK fix in
  // mcp/lib/connectors/telegram.js. The old truncation guard
  // `startOffset < raw.length` reset the byte-offset cursor to 0 in the
  // steady state (startOffset === raw.length, i.e. fully caught up), re-read
  // the WHOLE staging file every poll, and re-appended every row that had
  // fallen out of the bounded source_msg_id dedup tail (CONNECTOR_DEDUP_TAIL_
  // LINES). Fixed to `startOffset > raw.length ? 0 : startOffset` so a replay
  // of an unchanged staging appends ZERO new rows (the work unit's
  // replay_dups=0 / cursor_persisted=true invariant). T2 is an OVER-CAP
  // regression guard (head rows outside the dedup window); T3 is the
  // cursorless negative control proving the bounded dedup ALONE is
  // insufficient. Hermetic (mkdtempSync + env overrides); no DB, no MTProto.
  "test/messaging/n12-telegram-daemon-cursor.test.mjs",
  // WORKUNIT N11d — the GENERIC source-ledger reader (loadSourcesFromLedgers)
  // + the memory_catchup handler wired to it. The reader loops the adapter
  // registry, tail-reads each entry's OWN ledgerPath under a configurable root
  // into a BOUNDED window of recent raw rows (since_ms / limit honored, missing
  // ledger -> [], ZERO platform branch), returning { platform -> rawRow[] }. The
  // handler runs each adapter's prepareContext + buildCatchup over those real
  // rows, returning a ranked, deduped, NAMED cross-platform "waiting on you"
  // list. Tests redirect every read to a TEMP root (no real-ledger dependency)
  // and re-assert catchup.js stays at 0 platform tokens after the reader landed.
  "test/messaging/n11d-ledger-source-loader.test.mjs",
  // WORKUNIT N11f — (1) the iMessage DISPLAY FLOOR: when no contact name resolves
  // for an inbound handle, sender.name is a FORMATTED handle (a readable phone
  // number / the email / a short shortcode label) so the catch-up NEVER shows
  // person:<hash> for a handle-bearing iMessage row. A real contact name (stamped
  // recovered_handle_name, or a ctx contact map) still WINS; the floor is OPT-OUT
  // via handleNameFloor:false (the genuine-resolution metric). (2) the previously-
  // RED N4 regression repaired: the read-only AddressBook build moved to the
  // adapter-layer sibling adapters/_imessage-context.js (re-exported from
  // imessage.js), so the PURE mapper imports nothing from connectors/* and names no
  // source surface — the N4 source-purity grep is GREEN. (3) a GENERIC per-platform
  // DIVERSITY CAP on the catch-up output (CAPS-gated round-robin interleave, default
  // <=6 per platform) so the ranked window spans platforms instead of being
  // saturated by the dominant one — ZERO platform-name branch (groups by the row's
  // own `platform` DATA field). 0 platform tokens in L2-5 reconfirmed.
  "test/messaging/n11f-imessage-floor-diversity.test.mjs",
  // WORKUNIT P1 — PRINCIPLED person/non-person classification. A SHARED, GENERIC
  // L1-tier structural classifier (mcp/lib/messaging/sender-kind.js) detects
  // cross-platform NON-PERSON surfaces by SHAPE, never a vendor denylist: an SMS
  // shortcode (numeric handle len 3-6), a business/RBM surface (urn:biz /
  // @rbm.goog / RCS agent), and a role-address email (no-reply / support /
  // notifications local-part) -> the automated-channel kind "service"; NO signal
  // -> null so the caller defaults "person" (CONSERVATIVE: a real phone / contact
  // / personal email is never dropped — person recall ~1.0). Each adapter combines
  // this with its platform-native signal: imessage + mail wire classifyStructural;
  // telegram (777000=service, is_bot=bot) and whatsapp (status/broadcast=system)
  // keep their native stamps. L2-5 EXCLUDE every non-person kind by READING
  // sender.kind DATA — the helper is GENERIC (names no platform) and the four L2-5
  // sources stay at 0 platform/structural tokens. Hermetic (pure mappers over
  // hand-built rows + source-byte grep gates).
  "test/messaging/p1-sender-kind.test.mjs",
  // WORKUNIT P2 — RECIPROCITY, the FIRST PERSONA ATTRIBUTE. A relationship is
  // TWO-WAY: reciprocity(thread) = have you EVER reciprocated (any outbound
  // is_from_me from you to them). Computed IN-MEMORY from envelope.is_from_me in
  // L4 (attention.js reciprocityOfThread -> {reciprocated, outbound_count,
  // inbound_count, turn_count, last_outbound_ts} attached to each AttentionRecord)
  // and consumed as a SOFT rank factor in L5 (catchup.js reciprocityFactor folds
  // into rankScore: reciprocated=>1, 0-reciprocity=>CAPS RECIPROCITY_FLOOR). It is
  // the behavioral signal that sinks spam-that-looks-human (gibberish-domain
  // emails, notification senders structurally person-shaped) which P1's STRUCTURAL
  // gate cannot catch. CONSERVATIVE: a 0-reciprocity thread DOWN-RANKS but is NEVER
  // hard-dropped — a genuine brand-new contact still appears, lower (never drop a
  // human). Surfaced on the row (reciprocity block + reasons token). ZERO platform
  // tokens in L4/L5 (the abstraction invariant holds; 5th-adapter empty-diff).
  // Hermetic (pure engines over hand-built rows + source-byte grep gate).
  "test/messaging/p2-reciprocity.test.mjs",
  // WORKUNIT M1 — the PERSON-ENRICHMENT SEAM (W0 barrier of the who-matters model).
  // The injected, bounded, cached enrichPerson resolver contract (person_id ->
  // {is_contact, reciprocity_strength, feedback_score, anchor_factor}) + the
  // MONOTONE anchorFactor up-rank in [1, MAX] (cold/unknown => 1.0 neutral, NEVER a
  // hard-drop) + the DEFAULT-NEUTRAL enricher (anchor_factor=1.0 => ranking BYTE-
  // IDENTICAL to pre-M1, gate-OFF safety). Wired into catchup.js rankScore. ZERO
  // platform tokens in person-enrichment.js + catchup.js. Hermetic (pure engines).
  "test/messaging/m1-person-enrichment.test.mjs",
  // WORKUNIT M2 — the CONTACTS-ANCHOR SOURCE MODULE (mcp/lib/messaging/contacts-anchor.js).
  // A READ-ONLY, MEMOIZED address-book join that produces the `is_contact` signal of
  // the M1 enrichment shape: buildContactAnchorIndex() reads saved contacts ONCE,
  // isContact(handles[]) is an O(1) saved-name oracle (true => the strongest single
  // ANCHOR lift), a miss is a zero-signal (neutral, NEVER a hard-drop). DEGRADES to
  // the empty all-false index when no address book is readable => ranking byte-
  // identical. ZERO platform tokens in the module LOGIC; sourced from the address
  // book, NOT the fact-ledger. The REAL-AddressBook check cannot be sandboxed.
  "test/messaging/m2-contacts-anchor.test.mjs",
  // WORKUNIT M3 (feedback-log) — the APPEND-ONLY operator-engagement log
  // (mcp/lib/messaging/feedback-log.js) + the memory_catchup_feedback MCP tool.
  // recordFeedback appends one immutable JSONL row (storage/feedback/
  // engagement.jsonl, 0600, atomic O_APPEND) per operator triage action ∈
  // {surfaced,opened,replied,dismissed,flagged_spam}; feedbackScore /
  // buildFeedbackIndex+lookupFeedbackScore read the log at QUERY TIME into a
  // feedback_score ∈ [0,1] for the M1 person-enrichment seam (M5/W2 composes it
  // via makeEnricherFromIndex). NEUTRAL (0) when the log is empty / a subject is
  // never triaged; replied/opened LIFT, dismissed/flagged_spam LOWER toward the
  // 0 FLOOR — never below (the non-drop guarantee). Append-only (never mutates,
  // Thesis #1), defensive reader (torn/malformed lines skipped, never throws),
  // 0 platform tokens (subject_id is opaque). Hermetic (mkdtempSync opts.path).
  "test/messaging/m3-feedback-log.test.mjs",
  // WORKUNIT M6 (p1-roleaddr-prefix-fix) — the SHARED structural classifier's
  // isRoleAddress (mcp/lib/messaging/sender-kind.js) is now PREFIX/TAG-aware: a
  // role address often arrives with a machine tag after a separator
  // ("support.zq4821@…", "notifications.batch789@…", "no-reply.tx12@…"). The fix
  // classifies the LEADING separator-delimited token run when it collapses to a
  // known role mailbox AND is followed by a tag, WITHOUT misfiring on a personal
  // "firstname.lastname@…" or a role-as-substring ("supportername@") or a
  // role-as-suffix ("john.support@"). CONSERVATIVE (never hard-drops a human);
  // PURE / DETERMINISTIC / GENERIC (0 platform tokens). Gate:
  // support_zq4821_service=true normal_personal_email_person=true
  // firstname_lastname_person=true.
  "test/messaging/m6-roleaddr-prefix.test.mjs",
  // WORKUNIT M6r (roleaddr-tighten) — TIGHTENS M6's PREFIX/TAG rule per the
  // review:reject. M6 classified ANY "role-word.<anything>@…" as a role address,
  // over-firing on "info.john@" / "team.smith@" (a PERSON who shares a first name
  // with an RFC 2142 role word). M6r adds the discriminator: a leading role token
  // + a TAG is a role ONLY when the TAG looks MACHINE-generated (the tail carries
  // a DIGIT — zq4821 / batch789 / tx12 / x9 / abc123). A pure-ALPHABETIC tail
  // (john / smith / team) is a plausible human name/word => stays PERSON; when
  // ambiguous => PERSON (never hard-drop a human, RAISES recall). "support.zq4821@"
  // stays service. PURE / DETERMINISTIC / GENERIC (0 platform tokens). Gate:
  // support_zq4821_service=true info_john_person=true team_smith_person=true.
  "test/messaging/m6r-roleaddr-tighten.test.mjs",
  // WORKUNIT M5 (catchup-anchoring + the honest UNKNOWN/first-contact TIER) —
  // COMPOSES the W1 sources into the real enrichPerson resolver injected at
  // buildCatchup (replacing the neutral default): M2 contacts-anchor (is_contact),
  // M3 feedback-log (feedback_score), P2r reciprocity_strength (per-thread), folded
  // by M1's MONOTONE anchorFactor into an UP-rank multiplier. Then it LABELS every
  // surfaced row with a first-class TIER — "relationship" (a saved contact OR a
  // deep two-way history OR positive feedback) vs "unknown" (a cold node: a genuine
  // new contact, spam, or a business — indistinguishable in the message). The
  // UNKNOWN tier is surfaced + grouped BELOW relationships + LABELED, NEVER dropped
  // (a contact out-ranks an unanchored stranger; the genuine new contact lives in
  // unknown, not deleted). NEUTRAL when no anchor opt-in (byte-identical, gate-OFF);
  // SOFT-guarded (a throwing source => neutral); 0 platform tokens; NOT the
  // fact-ledger. The production memory_catchup tool opts in (anchor:true).
  "test/messaging/m5-catchup-anchoring.test.mjs",
  // WORKUNIT M5b — the LIVE contacts-bridge (spawned by the M5 review). Locks the
  // person_id->handles BRIDGE in buildCatchup: the rank loop's opaque dedup key
  // (resolved person_id, else soft `${platform}:${sender_id}`) must resolve back to
  // the sender HANDLES it collapsed, so the M2 contact join lifts a SAVED human.
  // The headline gate: a saved contact (anchor>1, relationship) out-ranks a chatty
  // reciprocity-only BUSINESS — within a tier the address-book vouch sorts ABOVE a
  // non-contact (MONOTONE; never a hard-drop; the join is on the handle, not the
  // self-set display name). A genuine NEW contact still survives in unknown.
  "test/messaging/m5b-live-contacts-bridge.test.mjs",
  // WORKUNIT M7 — the honest-eval W3 CLOSURE gate for the WHO-MATTERS attention
  // model (mcp/test/messaging/m7-attention-eval.test.mjs + m7-cohort.mjs). The
  // existing goldsets are RECIPROCITY-SATURATED and structurally BLIND to the
  // INVISIBLE error M1-M5 fixes: a genuine first-contact STRANGER who later becomes
  // a real relationship, but whose first message looks like spam. M7 MINES a sized,
  // LABELED cohort straight off per-thread reciprocity (became-real = cold first
  // thread turn_count===0 + later turn_count>=3; noise = never two-way + not saved;
  // relationship = saved contact) and measures (1) the SILENT-ERROR metric = recall
  // of the became-real cohort in the surfaced set (must be 1.0 anchor ON *and* OFF —
  // the non-drop is structural, never a hard-drop), and (2) precision: within a
  // platform no UNKNOWN out-scores a RELATIONSHIP + the M5b saved-human-over-chatty-
  // business inversion. Labels are DERIVED (never hand-stamped); 0 platform tokens;
  // not the fact-ledger; deterministic + total.
  "test/messaging/m7-attention-eval.test.mjs",
  // WORKUNIT e17 — the TIME TERM of the catch-up rank, and the substance decision
  // that moved with it (mcp/lib/messaging/catchup.js). rankScore multiplied
  // recencyFactor by stalenessFactor over what is the SAME age for a
  // they-spoke-last thread, making the time term a band-pass: a message that
  // arrived a minute ago scored ~0 and a two-day-old one peaked. stalenessFactor
  // was DELETED from the product (still exported, still tested). The substance
  // drop moved below the enrichment/reciprocity/tier block, where a closer can be
  // RESCUED on context — a saved-contact vouch, or an inbound run answering the
  // operator's own message — kept, down-ranked by substanceFactor and labeled
  // `low_substance`, with the remaining drops counted in stats. RED-1/2/3/4 fail
  // on the pre-e17 checkout; GREEN-KEEP pins that tier stays the primary key.
  "test/messaging/e17-time-term.test.mjs",
  "test/ingest/stage0-modules.test.mjs",
  // WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — promotional / scam / URL-only +
  // issuer-prefixed inverted OTP coverage for the iMessage Stage-0 module.
  "test/ingest/stage0-imessage-spam-filter.test.mjs",
  "test/ingest/stage0-screentime-real-stream-names.test.mjs",
  "test/ingest/salience-knn-backend.test.mjs",
  "test/ingest/salience-cascade.test.mjs",
  "test/ingest/salience-cascade-integration.test.mjs",
  "test/ingest/chat-cc-content-derivation.test.mjs",
  "test/ingest/cold-start-novelty.test.mjs",
  "test/ingest/sync-embed-corroborate.test.mjs",
  // WU-A3-git-log-content-dedup — SAME-source content-hash dedup contract.
  "test/ingest/git-log-content-dedup.test.mjs",
  "test/recall-log-persistence.test.mjs",
  "test/tools/recall-integration.test.mjs",
  "test/tools/recall-caps-snapshot.test.mjs",
  // WORKUNIT N8 — memory_put operator-authored direct write (>=12 assertions).
  "test/tools/put.test.mjs",
  // F1 — memory_get ledger-backed read (>=12 assertion groups).
  "test/tools/get.test.mjs",
  // WORKUNIT N8 — time-index WIRE: temporal substrate fallback in recall.
  "test/synthesis/time-index-recall-fallback.test.mjs",
  "test/recall/hard-gates-salience.test.mjs",
  // recent_recall_ids honored as damping (lib/recall/recent-surfaced-damping.js
  // + the surfaced_memory_ids stamp on the in-process recall log).
  "test/recall/recent-surfaced-damping.test.mjs",
  // WU-iter3-incrementalize-remaining-scans — the shared hard-gates _scanLedger
  // (the remaining per-query full-ledger pass behind loadDerivationExciseSet +
  // loadTransitiveOrphanMap) is routed through the iter-2 append-aware tail-merge
  // helper. This gate proves the tail-merge is byte-identical to a full rebuild
  // (raw scan + both loaders), shrink/mtime-regression rebuilds cleanly, torn-
  // line tolerance, and recall gating (orphan excise + derivation exclude +
  // connector_revoke source-appears-after-revoke) stays correct.
  "test/recall/hard-gates-incremental-scan.test.mjs",
  // WU-hnsw-ndjson-persistence — the linear-scan HNSW persists/loads via
  // STREAMED NDJSON (header line + one {id,iid,v} per vector) so a multi-GB
  // index never materializes a >512MB JS string. Proves round-trip fidelity,
  // streamed load over the legacy parse guard, v1 back-compat, the
  // v1-too-big rebuild error, and malformed-line tolerance.
  "test/recall/hnsw-ndjson-persistence.test.mjs",
  "test/recall/ledger-streaming-recall.test.mjs",
  // N3-local-reranker — local Qwen3-Reranker backend for Layer-3 (offline mock
  // tests of the client shape, reorder-only, degrade-to-final_score, env gate).
  "test/recall/local-reranker.test.mjs",
  // WU1-context-prefix-and-contextual-bm25 — deterministic THREAD-FIRST
  // context prefix (lib/recall/context-prefix.js) concatenated into the BM25
  // tokenized field at rebuild time, gated by CAPS.CONTEXTUAL_BM25_ENABLED
  // (default false; opts.contextualPrefix for hermetic A/B). Proves a
  // prefix-only entity term becomes BM25-matchable only in the contextual
  // index.
  "test/recall/contextual-bm25.test.mjs",
  // WU2-eval-harness-failure-rate — the Anthropic-comparable Top-20 failure-rate
  // metric (lib/recall/eval-failure-rate.js) that gates every contextual-
  // retrieval tier. Synthetic goldset + recallFn; exercises failure rate,
  // recall@k, per-stratum, per-leg attribution, and golden-not-found.
  "test/recall/eval-failure-rate.test.mjs",
  // WU-goldset-decircularize — guards the LIVE contextual-eval goldset
  // (ledgers/contextual-eval-goldset.jsonl) against the circularity that broke
  // the eval: it asserts a meaningful fraction of (query, golden) pairs are
  // BM25-baseline MISSES (real K=20 headroom), every golden is a real ledger id,
  // a findable control cohort exists, and the pinned canonical case is
  // present. Real-data test; skips cleanly when the ingest daemon is active.
  "test/recall/contextual-eval-goldset.test.mjs",
  "test/hermeticity/r25-no-real-reads.test.mjs",
  "test/integration/r25-end-to-end-cascade.test.mjs",
  "test/integration/exports-not-anti-tested.test.mjs",
  "test/integration/lib-loader-not-muffled.test.mjs",
  "test/identity/operator-identity.test.mjs",
  "test/redaction/predicates.test.mjs",
  "test/no-legacy-pipeline-references.test.mjs",
  "test/no-orphan-exports.test.mjs",
  "test/no-orphan-test-imports.test.mjs",
  "test/spec-sweep-exit-policy.test.mjs",
  "test/state-schema-classifier-allowlist.test.mjs",
  "test/synthesis/damping-log.test.mjs",
  "test/synthesis/engagement-detector.test.mjs",
  "test/synthesis/recall-integration.test.mjs",
  "test/synthesis/reconstruction-emitter.test.mjs",
  "test/synthesis/distill-emit-reconstructed.test.mjs",
  "test/synthesis/derivation-graph-recall-pathway.test.mjs",
  // WU-incrementalize-recall-recomputes — the append-aware tail-merge shared by
  // derivation-graph / entity-index / feature-backfill: cold==full, tail-merge
  // ==fresh full rebuild, shrink/mtime-regression rebuild, torn-final-line
  // tolerance, and recall still gates (orphan excised, backfill applied).
  "test/synthesis/append-aware-ledger-projection.test.mjs",
  "test/synthesis/cp5-trigger-a.test.mjs",
  "test/synthesis/single-producer-recall-feedback.test.mjs",
  "test/synthesis/coverage-probe.test.mjs",
  // W10 — engagement-loop closure (KEYSTONE) tests.
  "test/synthesis/engagement-loop-end-to-end.test.mjs",
  "test/synthesis/recall-log-write-engagement.test.mjs",
  // W11 — offline-eval harness (F-SYN-OPERATIONAL-offline-eval-harness)
  "test/synthesis/eval-harness.test.mjs",
  // W11 — reconstructed-trigger advisor (F-SYN-BEHAVIOR-reconstructed-trigger-logic)
  "test/synthesis/reconstructed-trigger-advisor.test.mjs",
  // W11 — forgetting-propagation through synthesis (F-SYN-BEHAVIOR-forgetting-propagation-through-synthesis)
  "test/synthesis/forgetting-propagation.test.mjs",
  "test/synthesis/single-producer-forgetting-cascade.test.mjs",
  // W11 — density-flag-feedback (F-SYN-BEHAVIOR-density-flag-feedback /
  // CROWDED_NEIGHBORHOOD signal emission from recall.js).
  "test/synthesis/density-flag-feedback.test.mjs",
  // W12 — damping + propagation CAPS calibration loop
  // (F-SYN-OPERATIONAL-damping-calibration-loop). O5 calibration deferred
  // since W2: tunes the damping/propagation CAPS against the held-out
  // labeled set using the W11 offline-eval harness.
  "test/synthesis/calibration-loop.test.mjs",
  // N1-calibration — EXTEND the calibration sweep to the LIVE scorer weights
  // SCORE_WEIGHT_{ENGAGEMENT,DAMPING,CORROBORATION}_PRIOR (the namespace gap:
  // these multiply NORMALIZED candidate.priors, NOT the surfaced[] re-rank
  // counts). Wires the minimal engagement prior (use_count from
  // recall-feedback), emits an append-only policy.recall.score_weights
  // projection, and reads it back through a CAPS/env-gated overlay
  // (MEMORY_SCORE_WEIGHTS_ENABLED). Gate OFF ⇒ byte-identical; never mutates
  // the frozen CAPS or any fact row (thesis #1).
  "test/synthesis/calibration-live-weights.test.mjs",
  // W12 — mutual-cycle closure: damping-from-recall-log ↔
  // corroboration-propagation. Both behaviors feed independent bounded
  // scalars into multi-feature-score; the directional read/write interface
  // resolves the foundation/behavior islanding.
  "test/synthesis/damping-reader.test.mjs",
  "test/synthesis/corroboration-propagator.test.mjs",
  // N6 — stamp candidate.priors {damping_coefficient, corroboration_boost} +
  // build engagementPriorById at recall so the three SCORE_WEIGHT_*_PRIOR
  // weights have NON-neutral inputs. buildDampingCoefficientMap does ONE
  // damping-log scan per recall (latency-safe equivalent of per-id reads);
  // stamping at weight 0.0 is ranking byte-identical (safe to ship).
  "test/synthesis/stamp-priors-recall.test.mjs",
  // N10 — persist candidate.priors {engagement_prior, damping_coefficient,
  // corroboration_boost} into the recall.jsonl surfaced[] emission (top-level
  // .priors) so run-calibration-cycle's rescoreSurfacedWithLiveWeights reads
  // the REAL non-neutral priors the live scorer used instead of degrading
  // every row to neutral (the rank-invariant ndcg_delta=0 trap N1/N6 found).
  "test/synthesis/priors-persistence-seam.test.mjs",
  // N11 — RANKING-sensitive eval goldset (build-ranking-eval-goldset.mjs).
  // The de-circularized contextual goldset has RETRIEVAL headroom but baseline
  // NDCG@12=1.0 (single binary already-retrieved golden → no ranking headroom);
  // this substrate emits GRADED multi-golden labels whose goldens sit at mid/low
  // positions in the REAL recall order so baseline NDCG@12 < 1.0 and a
  // priors-driven re-rank measurably lifts NDCG. --ranking-goldset points
  // run-calibration-cycle at it. Goldens are validated REAL ledger facts.
  "test/synthesis/ranking-eval-goldset.test.mjs",
  // W7 — propensity-calculator synthesis-tier facade
  // (F-SYN-OPERATIONAL-propensity-logging-soak). Plackett-Luce softmax with
  // 5%-of-|score| jitter over scored candidates.
  "test/synthesis/propensity-calculator.test.mjs",
  // W12 — phase-transition criteria gate
  // (F-SYN-OPERATIONAL-phase-transition-criteria). Refuses to claim
  // "advanced to v1/v2/v3" without measurable evidence.
  "test/synthesis/phase-transition-gate.test.mjs",
  // W12 — thread-aggregator (F-SYN-BEHAVIOR-thread-aggregation). Daemon-
  // side bucketing of N atomic facts into ONE reconstructed per
  // {chat|repo, day} bucket.
  "test/synthesis/thread-aggregator.test.mjs",
  // WU-forward-conversation-stamp — NEW facts carry conversational provenance.
  // deriveConversationId() builds "daemon:thread:<bucket_key>" from a source
  // row (reusing extractThreadKey) so the promote path stamps
  // provenance.conversation_id forward-only; recall/context-prefix.js already
  // reads it. Covers imessage(chat_guid)/whatsapp(session_jid)/git/generic +
  // the no-key-omit-no-throw degrade.
  "test/synthesis/conversation-stamp.test.mjs",
  // WU-backward-conversation-index — DERIVED projection fact_id ->
  // {conversation_id, thread_label} for the EXISTING corpus (the Tier-0
  // material context-prefix.js documents as 0% thread coverage). Joins each
  // fact's source_refs[].source_msg_id to its retained source row and reuses
  // thread-aggregator.extractThreadKey so backward labels are byte-identical to
  // the daemon's. Wires into context-prefix.js (buildContextPrefix(row, opts)).
  // Never mutates fact rows (thesis #1); cache invalidates on mtime+size.
  "test/synthesis/conversation-index.test.mjs",
  // W13 — project-aggregator (F-SYN-BEHAVIOR-project-aggregation). Mirror
  // of thread-aggregator at PROJECT-grain ({repo, author, ISO-week}); only
  // sources git-log + github-events, MIN_FACTS_PER_PROJECT=2.
  "test/synthesis/project-aggregator.test.mjs",
  // INCREMENTAL-AGGREGATION arc (design.md agg_hypergraph). CKPT — the
  // offset-checkpoint primitive (storage/aggregator-state/{thread,project}.json):
  // stringified offsets, atomic tmp/fsync/rename, self-heal on offset>size OR
  // inode change.
  "test/synthesis/agg-checkpoint.test.mjs",
  // PIDX — the compact persistent parent index that replaces the emitter's
  // whole-ledger byId rebuild: projections == full-scan, tail-merge on growth,
  // self-heal on shrink, seekRows ascending-offset order, and end-to-end
  // flag-OFF vs flag-ON emit equivalence (incl. reconcile.substitute).
  "test/synthesis/parent-index.test.mjs",
  // VERIFY (LOAD-BEARING gate) — golden equivalence: thread + project
  // aggregation flag-OFF (full rescan) vs flag-ON (incremental fold) emit the
  // IDENTICAL reconstructed/reconcile.* row SET over the SAME synthetic ledgers.
  // Fixtures: cold baseline, window eviction, backfilled-old-ts-at-tail,
  // excise-after-derive, zero-append no-op, cold-restart+future-ts, torn tail,
  // checkpoint self-heal, reconciliation substitute.
  "test/synthesis/incremental-agg-equivalence.test.mjs",
  // WU-B1 — daemon RSS bloat fix. Regression test for the 4.2GB-in-20-min
  // climb caused by per-tick readFileSync on a 308MB memory.jsonl from
  // three independent consumers (thread+project aggregators +
  // embed-backfill-worker). Exercises the new _ledger-stream.js helpers
  // (streamLedgerLines, streamLedgerRowsInTimeWindow, streamLedgerRowsById)
  // against a 10k-row fixture and bounds per-call RSS delta.
  "test/synthesis/daemon-rss-bloat-fix.test.mjs",
  // E4 2026-09 — streamLedgerRowsById latest-write-wins (the first-seen
  // short-circuit removed): [a:OLD, b, a:NEW] => a:NEW, U+2028 inside a row
  // intact, a non-fact later row does not overwrite the wanted fact row.
  "test/synthesis/ledger-stream-by-id.test.mjs",
  // W14 — substrate polish: time-anchor recurring crash + fuzzy floor telemetry
  // + multi-anchor conflict; valence-scorer lexicon overlay + CAPS + telemetry;
  // recall mood-vocabulary closed-enum CAPS table + miss counter.
  "test/synthesis/time-anchor-resolver.test.mjs",
  "test/synthesis/valence-scorer.test.mjs",
  "test/synthesis/recall-mood-vocabulary.test.mjs",
  // W14 closeout — held-out-labels engineering surface (sampler + synthetic
  // v0 bootstrap). Operator labeling for v1 supersession is tracked as an
  // operator action item, not an engineering gap.
  "test/synthesis/held-out-bootstrap.test.mjs",
  // W1-CCS — F-CCS-CASCADE-row-parties-as-entities. Cheap structural-feature
  // win that propagates row.parties[] into features.entities[] as kind='person'
  // entities scoped per entity-schema §5.3 surface derivation table.
  "test/synthesis/cascade-row-parties-as-entities.test.mjs",
  // WORKUNIT A-promote-projection — promote-time feature completeness. The four
  // additive CAPS-gated stamps (valence object + scalar projection, gazetteer
  // kb_lookup entities, forwarded thread_keys, top-level ts mirror) plus the
  // sentinel discipline (*_version always stamped; synth_degraded.reasons[]
  // reuses the recall populator vocabulary) on every NEW fact at appendFactRow.
  // Drives promoteSourceRow directly; asserts Thesis #1 (existing row untouched).
  "test/synthesis/promote-projection-completeness.test.mjs",
  // F-CCS-CASCADE-structured-features-merge — connector-emitted
  // structured_features (entities + time_anchors) merge into the fact's
  // features at promote time. WU2 removed the embed-decouple half of this
  // suite (the deleted async embed-queue / drainEmbedQueue / backfill-overlay
  // path); the structured-features-merge contract is kept.
  "test/synthesis/cascade-decoupling-and-merge.test.mjs",
  // W3-CCS — F-CCS-CONNECTOR-chat-claude-code-structural. Pure helper that
  // derives structured_features for a chat-claude-code source row at emit
  // time. Addresses the W9 audit finding (chat-cc 59.8% empty-rate over 7d)
  // by giving the cascade a stable structural anchor (conversation_id +
  // cwd-basename) per turn.
  "test/synthesis/chat-claude-code-structural.test.mjs",
  // W3-CCS — F-CCS-CONNECTOR-imessage-structural. Connector emits handle_id
  // → person, chat_guid → topic (group only), ts → absolute time anchor on
  // every imessage row. Closes the empty-parties[] surface seen across all
  // imessage facts; handle_id is the canonical identity even when contact
  // name is unknown.
  "test/synthesis/imessage-structural.test.mjs",
  // W3-CCS — F-CCS-CONNECTOR-codex-cli-structural. Connector emits
  // conversation_id → topic, basename(cwd) → project (when present), and
  // turn_ts → absolute time anchor on every codex-cli row. Mirrors the
  // chat-claude-code-structural pattern; per memory.md operator notes,
  // codex thread_ids are tracked via `--json thread_id` capture and are
  // the stable cross-turn join key.
  "test/synthesis/codex-cli-structural.test.mjs",
  // W4-CCS — F-CCS-BACKFILL-trigger. Extends drift-detector to enqueue a
  // backfill task into <MEMORY_ROOT>/policy/backfill-queue.jsonl when an
  // extractor_version_bump alert fires; ships the read + drain helpers the
  // operator CLI and daemon idle tick share. Dedupe-by-alert-id is the
  // idempotence surface.
  "test/synthesis/backfill-trigger.test.mjs",
  // ccs-coverage-recheck: unit + CLI tests for the synthesis-coverage
  // recheck script (pure diff helpers + CLI end-to-end).
  "test/synthesis/ccs-coverage-recheck.test.mjs",
  // WU-RR2 — substrate-aware Layer-1c fallback. Adds an entity-index-driven
  // candidate path that fires when BM25 + HNSW return < threshold unique
  // candidates AND the populator extracted any entities. Telemetry on the
  // brief envelope + recall.jsonl row surface fallback_triggered count +
  // fallback_added_candidates count for operator attribution.
  "test/synthesis/substrate-aware-fallback.test.mjs",
  // WU-RR3 — empirical recall regression test against the live ledger.
  // Default-skips unless MEMSYS_FORCE_EMPIRICAL_RECALL=1 (operator-driven
  // verification pass). Closes the loop on RR1+RR2: asserts that BM25
  // full-rebuild + substrate-aware fallback actually move the needle on
  // four representative query shapes.
  "test/synthesis/recall-empirical-regression.test.mjs",
  // WU-recall-content-dedup — content-dedup at the recall projection. The
  // live 1.46M-fact ledger is ~97% byte-identical duplicate facts; with
  // features.embedding=null (Gemini outage) MMR has no vector to diversify on
  // and returns the same answer N times. This pass collapses exact
  // normalized-content matches AFTER the score-sort and BEFORE rerank+MMR,
  // keeping the highest-scored representative + annotating duplicate_count.
  "test/synthesis/recall-content-dedup.test.mjs",
  "test/synthesis/content-dedup-gate.test.mjs",

  // WU1-local-embedder-client-and-dim4096 — local Qwen3 embedding client +
  // the full-4096 dimension contract (no MRL truncation; operator chose full
  // fidelity). Guards the client request/response shape (HTTP mocked),
  // unit-norm renorm, isQuery flag, LocalEmbedUnavailableError, plus the
  // contract side: index-cache reads embedding_4096 (back-compat 3072),
  // s_emb cross-model isolation, and the model-versioned empty-HNSW dim.
  "test/synthesis/local-embedder-client.test.mjs",

  // WU-recall-flip-to-local-4096 — the LIVE memory_recall handler now embeds
  // the query via the local Qwen3-8B server (4096, isQuery:true) and reads the
  // ACTIVE 4096 index, so degraded_recall flips FALSE and semantic ranking is
  // real. Guards: query routes through embedSingle (is_query:true, dim:4096),
  // s_emb fires on embedding_4096 candidates, partial-coverage facts get
  // s_emb=0 (no crash), LocalEmbedUnavailable -> BM25-only degrade (no throw),
  // and the recall.jsonl event stamps the active 4096 model_version.
  "test/synthesis/recall-local-4096-query.test.mjs",

  // WU-dense-reembed-infra — full-fidelity contextual dense re-embed + recall
  // wiring. Guards: (A) re-embed full-text no-truncation + turn-aware giant
  // chunking with FULL coverage (no gaps) + length-bucketed batching; (B) the
  // recall s_emb SIDECAR overlay (_resolveCandidateEmbedding) fires for a row
  // lacking embedding_4096 (the gap fix: s_emb 0 -> >0) while leaving row-vector
  // and gemini-3072 facts invariant (geometry-mix guard); (C) chunk-id strip +
  // dedup (_stripChunkSuffix) collapses a giant's chunks to one candidate keeping
  // the best chunk; (D) HnswIndex.getVectorByMemoryId index-side accessor.
  "test/synthesis/dense-reembed-infra.test.mjs",

  // N5-contextual-retrieval — the DENSE leg of contextual retrieval (situate-
  // then-embed) + its CAPS.CONTEXTUAL_DENSE_ENABLED kill-switch + the BM25
  // contextual materialization script. Guards: cap exists/frozen/default-OFF;
  // cap-OFF embeds RAW content (baseline byte-identical); cap-ON embeds
  // prefix+"\n\n"+content (anaphor term recovered); conversation-index hit
  // injects the thread label into the embedded text; degrade-to-on-row when the
  // index is absent; prefix never overflows chunk #0 / the embed ceiling; whole-
  // fact prefixing (chunk #0 only); determinism; rebuild-bm25-index.mjs
  // --contextual materializes the -contextual tree only (baseline untouched,
  // prefix-only term matches contextual not baseline); computeFailureRate
  // registers the lift; the A/B driver emits all cells + per-leg deltas.
  "test/synthesis/contextual-dense-embed.test.mjs",

  // WU2-retroactive-dedup-compaction — compact-duplicate-facts.mjs emits
  // retroactive policy.corroboration events (canonical = earliest; ledger
  // byte-unchanged per Thesis #1). WU2-inline-embed dropped the Part-B
  // prune-embed-queue-duplicates half (the embed queue + its band-aid pruner
  // were deleted).
  "test/synthesis/dedup-compaction.test.mjs",

  // WU-recall-latency-fix — byte-offset ledger row resolution. The measured
  // profile showed loadLedgerRowsByIds streamed the whole 1.8 GB ledger per
  // query (~5.2s, 83% of recall latency) just to materialize a few hundred
  // candidate rows. The fix seeks each wanted row by BYTE OFFSET via a module-
  // cached, tail-merged offset index/sidecar instead of a full stream. Guards:
  // offset-seek round-trip, tail-merge-on-append (cache-hit-no-full-reload),
  // loadLedgerRowsByIds parity with the legacy stream, stale-offset SAFETY
  // (verify + stream back-fill never returns a wrong row), sidecar round-trip,
  // full-4096 rescore fidelity preserved end-to-end (NN fact ranks #1), and
  // back-compat with an existing index that never had an offset sidecar.
  "test/recall/ledger-offset-index.test.mjs",
  // A3 (msg-attribution hypergraph) — end-to-end proof that A1's write-side
  // attribution shape (top-level parties[] + bounded features.attribution) is
  // stamped by the REAL promoteSourceRow chokepoint and surfaced by A2's
  // read-side __resolveProvenanceAttribution. Hermetic; additive.
  "test/attribution-e2e.test.mjs",
  // A3 (memory-recall hypergraph) — reproducible ledger-population pin
  // (scripts/pin-ledger-snapshot.mjs): eof / sha256 of [0,eof) / line,
  // id-row and kind counts, so coverage claims get a FIXED denominator.
  // Hermetic (mkdtempSync fixtures); the live-ledger arm is env-opt-in
  // (MEMSYS_PIN_LIVE_LEDGER=1) and default-skipped, so this suite never
  // pulls the 2.9 GB ledger under `npm test`.
  "test/ledger-snapshot-pin.test.mjs",
  // A1 (memory-recall hypergraph) — the recall-liveness GATE: verdict algebra
  // (green / red / inconclusive, sample gates before threshold), the
  // ledgerPath canary proving memory.jsonl is never scanned, and loud
  // rejection of an absent recall log. Four hermetic mkdtemp cases plus a
  // LIVE read-only pass over ledgers/recall.jsonl (~20 MB) that PRINTS its
  // rate/sample/verdict as the recorded baseline and asserts only
  // well-formedness — never a colour, so the suite stays green whether the
  // query side is dead (today) or alive (after the C-track populator fix).
  "test/recall-liveness-gate.test.mjs",
  // B1 (memory-recall hypergraph) — the BM25 candidate-coverage probe:
  // distinct indexed doc ids over eligible ledger LINES, as a PERCENT, with
  // the id-vs-line asymmetry, the loader's silent partial-load and the
  // manifest cross-check all STAMPED in the result. Also the single home for a
  // coverage threshold (assertCoverageFloor), which B2/B3/B4 bind. Thirteen
  // hermetic mkdtemp arms plus an fs-write-interception canary; the LIVE arm
  // over indices/qwen3-embedding-8b-fp16/ + ledgers/memory.jsonl is env-opt-in
  // (MEMSYS_PROBE_LIVE_BM25=1) and default-skipped, so this suite never pulls
  // the 2.9 GB ledger under `npm test`, and it PRINTS its triple rather than
  // asserting a threshold that would fail the day the B-track fixes the index.
  "test/bm25-coverage-probe.test.mjs",

  // C2 (memory-recall hypergraph) — the QUERY-side gazetteer merge in the
  // recall populator, behind the default-off CAP
  // RECALL_QUERY_GAZETTEER_ENABLED. Six hermetic arms, five of them spawning
  // child processes because the CAP is env-evaluated at validation.js module
  // load: flag-OFF array identity, flag-ON kb_lookup adds, structural-wins
  // dedupe on a colliding canonical_id, the `canonical_id`/`canonicalJson`
  // substring hazard the whole-word boundary rule is the only guard against,
  // and the forced-throw degrade (query_gazetteer_threw, structural intact).
  // No ledger, index cache, or storage/ path is touched.
  "test/recall-populator-entities.test.mjs",

  // ── REGINT (memperf) — registration-gap closure ─────────────────────────
  // The suites below existed on disk but were never added to this array
  // (each earlier work unit registered its own suite here; these landed
  // through other seams and were only reachable one-off). Registered so
  // `npm test` runs the FULL on-disk mcp/test/**/*.test.mjs set. Suites
  // that carry an in-file env/service gate KEEP the gate and document it
  // inline (cf. the WU-RR3 entry above) — never silently omitted.
  "test/auto-drain.test.mjs",
  "test/canonical-block-integrity.test.mjs",
  "test/cursor-lag-alarm.test.mjs",
  "test/daemon/queryd-client.test.mjs",
  "test/daemon/queryd.test.mjs",
  "test/daemons/bm25-growth-check.test.mjs",
  "test/daemons/watermark-aggregation-throttle.test.mjs",
  // G1 (memory-recall hypergraph) — pins the watermark ERROR-row seam: the
  // cursor advances under the flag OFF, the row is quarantined with the cursor
  // still advancing under the flag ON, a cascade load failure aborts with
  // cursors pinned, and a quarantine WRITE failure cannot stall the source.
  // Hermetic (mkdtemp MEMORY_ROOT + POLICY/STORAGE/LEDGERS base dirs).
  "test/daemons/watermark-append-failure.test.mjs",
  "test/daemons/watermark-breaker-tick-abort.test.mjs",
  "test/daemons/watermark-embed-timeout.test.mjs",
  "test/daemons/watermark-queryd.test.mjs",
  // Pre-hypergraph (Jul 29, untracked alongside lib/ingest/drop-throttle.js)
  // and never registered — pins the shared policy.salience.dropped breadcrumb
  // throttle: windows are per (source, reason), volume is bounded by TIME not
  // traffic, and BOTH producers (salience.js and the daemons/watermark.js
  // mirror) import the one module. Pure in-memory + read-only source reads.
  "test/drop-throttle.test.mjs",
  // C1 (memory-recall hypergraph) — entity-index witness cache: mtime equality
  // alone must not seed a stale index, rewritten prefix bytes force a full
  // rebuild, and every corrupt/missing/legacy cache path rebuilds while
  // preserving the cache file. Hermetic (mkdtemp ledger + cache per case; the
  // live ledgers/memory.jsonl and storage/entity-index.cache.json are untouched).
  "test/entity-index-witness-cache.test.mjs",
  "test/entity-source-allowlist.test.mjs",
  // D2 — episodicity ablation arm (MEMORY_SCORE_EPISODICITY_ABLATE, default OFF;
  // only the exact string "1" enables it): pins the 1.1359-f falling-in-f
  // episodicityMatch shape, the byte-identical default path, and the top-12
  // churn the arm induces. Hermetic (pure scorer calls; no ledger, index or
  // daemon access).
  "test/episodicity-ablation.test.mjs",
  // A2 — proves run-held-out-eval.mjs --assert CAN refuse; the pre-change
  // script exited 0 even on a zero-recall substrate. Hermetic (mkdtemp
  // fixtures + explicit --labels/--recall); the LIVE eval is NOT run here.
  "test/eval-gate-can-fail.test.mjs",
  // E2 — GitHub owner/repo precision gate (MEMORY_GH_REPO_PRECISE, default OFF):
  // prose slash-pairs stop minting org/project entities; subtractive-only.
  "test/github-repo-path-precision.test.mjs",
  "test/index-save-debounce.test.mjs",
  "test/ingest/cross-source-dedup.test.mjs",
  "test/ingest/github-events-content-composer.test.mjs",
  "test/ingest/screentime-burst-collapse.test.mjs",
  "test/ingest/screentime-duration-bands.test.mjs",
  "test/ingest/stage0-mail-rules.test.mjs",
  "test/ingest/stage0-telemetry.test.mjs",
  "test/ingest/whatsapp-f9-xsrc-dedup-contract.test.mjs",
  "test/kb-spec-extract.test.mjs",
  // C4 (memory-recall hypergraph) — source-agnostic entity lookup
  // (MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP, default OFF): an id stamped under a
  // different source is reachable by match key, flag-OFF stays byte-identical
  // to lookupByEntity and builds no derived map, and addToIndex invalidates the
  // memo. Hermetic (mkdtemp MEMORY_ROOT + in-memory Map fixtures only; neither
  // the live ledger nor storage/entity-index.cache.json is opened).
  "test/lookup-entity-matchkey.test.mjs",
  // wave 4 (codex executor): registered by the orchestrator — four concurrent
  // codex processes could not safely share this file (see FINDINGS F35).
  "test/bm25-projection.test.mjs",
  "test/bm25-embed-decoupling.test.mjs",
  "test/entity-overlap-idf.test.mjs",
  // wave 5 (codex executor): registered by the orchestrator (concurrent writers).
  "test/bm25-rebuild-target.test.mjs",
  "test/entity-alias-overlay.test.mjs",
  "test/matchkey-memo-invalidation.test.mjs",
  // wave 6 (codex executor): registered by the orchestrator (concurrent writers).
  "test/entity-df-wiring.test.mjs",
  "test/entity-index-grow-persist.test.mjs",
  "test/messaging/catchup-projection.test.mjs",
  "test/messaging/catchup-since-ms.test.mjs",
  "test/messaging/m7r-rendered-order.test.mjs",
  "test/messaging/n10-integration.test.mjs",
  // f5-catchup-seam: the messaging module graph must stay a DAG.
  "test/messaging/no-static-import-cycles.test.mjs",
  "test/messaging/persona-contract.test.mjs",
  "test/messaging/persona-derive-arc.test.mjs",
  "test/messaging/persona-derive-identity.test.mjs",
  "test/messaging/persona-derive-relationship.test.mjs",
  "test/messaging/persona-derive-topics.test.mjs",
  "test/messaging/persona-eval.test.mjs",
  "test/messaging/persona-live-wiring.test.mjs",
  "test/messaging/persona-resolver.test.mjs",
  "test/messaging/persona-surface.test.mjs",
  "test/null-marker-scoreable.test.mjs",
  "test/observability-source-propagation.test.mjs",
  "test/policy-group-commit.test.mjs",
  "test/predicate-gate-4096.test.mjs",
  // Byte-identity hermeticity suites over PRODUCTION recall paths. In-file
  // gate: skipIfDaemonActive (test/_hermetic-daemon-skip.mjs) skips cleanly
  // when the watermark daemon is active (state-file mtime <30s). Under THIS
  // runner REQUIRE_HERMETIC=1 (see runOne) turns that skip into a hard
  // failure so a gate run never passes vacuously — quiesce the daemon for
  // gate runs (mirrors the WU-RR3 env-gate documentation convention).
  "test/recall-mask-drop.test.mjs",
  "test/recall-mmr-active-geometry.test.mjs",
  "test/recall/golden-queries.test.mjs",
  "test/recall/hnsw-delta-flush.test.mjs",
  "test/recall/index-manifest-v1-format.test.mjs",
  "test/recall/index-manifest.test.mjs",
  "test/recall/index-wal.test.mjs",
  // S3g — heal allowlist drift: PROTECTED must cover the live WAL filenames by
  // their index-wal.js constants (the hardcoded "index-wal.applied-cursor.json"
  // never matched the real WAL_CURSOR_FILE, so the cursor hard-stop was inert).
  "test/recall/heal-index-manifest-protected.test.mjs",
  // FU3 (memperf) — hermetic-arm regression: statically pins THIS runner's
  // runOne REQUIRE_HERMETIC:"1" spawn-env injection (a revert to
  // `env: process.env` fails the suite) and dynamically exercises the
  // _hermetic-daemon-skip.mjs matrix (armed hard-fail / clean skip /
  // stale run-through) in child processes against temp state files only.
  "test/run-all-tests-hermetic-arm.test.mjs",
  // REGINT (memperf) — suite-parity guard: SUITES must cover every
  // test/**/*.test.mjs on disk (minus ANNOTATED_SKIP); main() exits 2 on drift
  // so a newly added suite can never silently go unregistered again.
  "test/run-all-tests-suite-parity.test.mjs",
  // FU2 (memperf) — refused-generation visibility: in-band degraded_reason
  // on the recall envelope when the active index generation is refused.
  "test/recall/generation-refused-envelope.test.mjs",
  "test/server-lifecycle.test.mjs",
  "test/slack-connector.test.mjs",
  "test/source-effective-empty-rate.test.mjs",
  "test/spec-sweep-robust.test.mjs",
  "test/stage0-mail-passrate.test.mjs",
  // g3 — mail body-resolution coverage. Pins the four never-collapsed numbers
  // (rows_total / resolved_total / frozen_prefix_rows /
  // live_suffix_resolved_rate), the append-order boundary, and the falsifier
  // that refuses a frozen-prefix story on an interleaved ledger. Also pins the
  // mail emptiness predicate, without which health says nothing about mail
  // content at all.
  "test/mail-body-coverage.test.mjs",
  "test/synthesis/cascade-row-ts-as-anchor.test.mjs",
  "test/synthesis/cascade-stamps-entities.test.mjs",
  "test/synthesis/cascade-stamps-episodicity.test.mjs",
  "test/synthesis/content-index-incremental.test.mjs",
  "test/synthesis/derivation-graph-incremental.test.mjs",
  "test/synthesis/derivation-graph.test.mjs",
  "test/synthesis/drift-detector.test.mjs",
  "test/synthesis/entity-extractor.test.mjs",
  "test/synthesis/entity-index-fail-closed.test.mjs",
  "test/synthesis/entity-index.test.mjs",
  "test/synthesis/episodicity-scorer.test.mjs",
  "test/synthesis/feature-backfill-recall-overlay.test.mjs",
  // Same skipIfDaemonActive in-file gate as recall-mask-drop above: asserts
  // hermeticity against production paths; daemon-active is a hard failure
  // under this runner's REQUIRE_HERMETIC=1, a clean skip in local dev.
  "test/synthesis/feature-backfill-recall-wiring.test.mjs",
  "test/synthesis/feature-backfill.test.mjs",
  "test/synthesis/git-log-structural.test.mjs",
  "test/synthesis/github-events-structural.test.mjs",
  "test/synthesis/health-reducers.test.mjs",
  "test/synthesis/kind-taxonomy-invariant.test.mjs",
  "test/synthesis/ledger-checkpoint.test.mjs",
  "test/synthesis/reconciliation.test.mjs",
  "test/synthesis/screentime-structural.test.mjs",
  "test/synthesis/single-producer-feature-backfill.test.mjs",
  "test/synthesis/time-index.test.mjs",
  "test/telegram-connector.test.mjs",
  "test/telemetry.test.mjs",
  "test/test-exit-discipline.test.mjs",
  "test/test-ops-daemon-quiesce.test.mjs",
  "test/time-index-stream.test.mjs",
  "test/verify-edit-hash-checker.test.mjs",
  "test/verify-gate-harness.test.mjs",
  "test/whatsapp-name-recovery.test.mjs",
  // ── memfix hypergraph wave-1 (2026-08-12) ──────────────────────────────
  // Registered in one block by node g1-suite-registration, the sole owner of
  // this file: each sibling node shipped its suite UNREGISTERED so that 14+
  // agents would not collide on this one file in a shared checkout. Order here
  // is execution order only; membership is what suiteParityDrift checks.
  //
  // s8-cascade-verdict-shapes — verify-cascade-correctness verdict semantics:
  // population scoped by row kind, absence is never corruption, any corrupt
  // fact row forces FAIL.
  "test/cascade-verdict-shapes.test.mjs",
  // c2-capture-staleness-alarm — capture-side liveness keyed on
  // connectors/<source>/state.json, which cursor-lag cannot see (a dead source
  // lets the cursor catch up, so lag collapses to 0 and reads as healthy).
  "test/connector-staleness.test.mjs",
  // c3-cursor-stamp-class — last_cursor_advance_ts must be stamped only when a
  // cursor actually moved; a per-poll stamp makes the staleness sensor refresh
  // itself forever (lib/connectors/index.js:601,607-611 and :701,707-711).
  "test/cursor-stamp-class.test.mjs",
  // p1-framedecoder-quadratic — queryd FrameDecoder reassembly: copy budget
  // (O(N^2) concat-per-chunk), retention bound, aliasing, behavioural parity.
  "test/daemon/queryd-protocol-framedecoder.test.mjs",
  // m2 — the DISCOVERED half of memory_health's ledger_byte_counts must not
  // launder a failed stat into a value, and is covered by the string-cap probe.
  "test/ledger-discovery-laundering.test.mjs",
  // s1-stringcap-guard — static class guard: no whole-file readFileSync(ledger,
  // "utf8"), which throws ERR_STRING_TOO_LONG (3.07 GB vs a 536,870,888 B cap).
  "test/no-ledger-readfilesync.test.mjs",
  // m1-hygiene — mechanical bars on the four 2026-08-11 "ops defect" claims:
  // one real (ledger_byte_counts missed 7 production ledgers), three correct
  // behaviours pinned so nobody "fixes" them into defects.
  "test/ops-hygiene.test.mjs",
  // q1-index-generation-refusal — publish-window false-positive: the member
  // writes precede the manifest rename, so a member-fingerprint mismatch during
  // that window must not be read as a corrupt index.
  "test/recall/index-publish-ordering.test.mjs",
  // v3-ledger-embedding-reroute — the 4096-dim embedding must stop being
  // stamped onto ledger fact rows (87,998 B of an 88,347 B average row).
  "test/recall/ledger-embedding-reroute.test.mjs",
  // s10-remaining-stringcap-sites-2 — three whole-file ledger reads whose
  // readFileSync argument is spelled `path`, so the static guard cannot see
  // them: two in ingest/stage0/githubevents.js, one in backfill-embeddings.mjs.
  "test/remaining-stringcap-sites-2.test.mjs",
  // s9-remaining-stringcap-sites — the same resolved-target class in
  // scripts/backfill-from-sources.mjs and lib/tools/distill-promote-fact.js.
  "test/remaining-stringcap-sites.test.mjs",
  // c1-captured-only-guard — pins the captured_only carve-out (screentime is
  // captured but deliberately out of cascade). FILENAME IS A PRESERVED
  // MISNOMER; the suite's own header forbids renaming it.
  "test/screentime-revive.test.mjs",
  // s7-scripts-stringcap — the ERR_STRING_TOO_LONG class across scripts/.
  "test/scripts-stringcap.test.mjs",
  // s3-feature-backfill-bounded — feature-backfill must stream the ledger: the
  // whole-file read threw into a bare catch, so the engine saw a ZERO-ROW
  // ledger and judged every fact "already covered".
  "test/synthesis/feature-backfill-stringcap.test.mjs",
  // s4-landmine-sites-stream — the two DORMANT whole-file sites (no production
  // caller today) that go live the instant anyone wires them.
  "test/synthesis/landmine-stringcap.test.mjs",
  // s2-reconciliation-latent — the last lib/synthesis/ ledger fallback that
  // read the whole file into one string. Latent landmine, not a live outage.
  "test/synthesis/reconciliation-stringcap.test.mjs",
  // ── legacypurge hypergraph (2026-08-15) ───────────────────────────────────
  // Registered in one block by node l9-suite-gate, the sole owner of this file
  // for this wave: each sibling node below shipped its suite UNREGISTERED so
  // that concurrent agents would not collide on this one file in a shared
  // checkout. Order here is execution order only; membership is what
  // suiteParityDrift checks — do NOT alphabetize, the array is wave-grouped.
  // All seven were measured passing standalone immediately before this block
  // landed (counts noted per entry); none is annotated-skipped.
  //
  // L1 — the one-shot BM25 rebuild CLI must be pointable at the ACTIVE index
  // tree, containable to a scratch output root, and able to MEASURE what it
  // built. Hermetic under mkdtemp; never points a rebuild at the production
  // ledger. Standalone baseline 15 pass / 0 fail.
  "test/bm25-full-rebuild.test.mjs",
  // l4 — pins scripts/verify-lexical-coverage-gate.mjs, the read-only
  // executable form of the "may the legacy Gemini index be deleted?" ruling.
  // Drives the CLI with spawnSync because its exit code IS the contract.
  // Standalone baseline 8 pass / 0 fail.
  "test/lexical-coverage-gate.test.mjs",
  // l11 — the argument-less BM25 rebuild target is the ACTIVE embedding model,
  // not the legacy Gemini tree: T2 asserts an argument-less rebuild leaves
  // indices/gemini-embedding-001 non-existent. Standalone baseline 11 pass /
  // 0 fail.
  "test/rebuild-target-retarget.test.mjs",
  // l12-vector-math-extract — guards the L2/MRL primitives extracted out of
  // gemini-client.js into lib/vector-math.js, including bit-exact parity
  // against goldens captured from the PRE-extraction build. Standalone
  // baseline 67 passed / 0 failed.
  "test/vector-math.test.mjs",
  // l14-embed-callers-migrate — distill-promote-fact.js and ingest/
  // _corroborate.js now take their embed fn from local-embedder-client.js, not
  // gemini-client.js (different signature, dims and failure class). NOTE: this
  // is the ONE suite of these seven that calls skipIfDaemonActive, so under the
  // gate's REQUIRE_HERMETIC=1 it HARD-FAILS (exit 1) while a watermark daemon
  // is active rather than skipping. Standalone baseline 8 passed / 0 failed.
  "test/embed-callers-migrate.test.mjs",
  // L8 — read-side entity-noise filter: conversational role labels and
  // codex-cli conversation-id topics inflate the Jaccard denominator and dilute
  // a 0.7-weighted recall feature. Fully literal fixtures. Standalone baseline
  // 17 pass / 0 fail.
  "test/entity-noise-blocklist.test.mjs",
  // Carries no origin-node label in its own header (measured, not inferred).
  // Pins HnswIndex's JS-side `maxElements` mirror to the native graph's own
  // capacity report — independent provenance let the guard stay silent while
  // hnswlib threw "number of elements exceeds the specified limit". Self-skips
  // unless HNSW_BACKEND === "hnswlib-node". Standalone baseline 3 pass / 0 fail.
  "test/hnsw-capacity-mirror.test.mjs",
];

// Trailing checks (not test/*.test.mjs but part of the historical chain).
const TRAILING_CHECKS = [
  // spec-sweep is a static spec check; treat it like a suite for tallying.
  { label: "spec-sweep", cmd: "node", args: ["../scripts/spec-sweep.mjs"] },
];

// ---------------------------------------------------------------------------
// SUITE-PARITY GUARD (REGINT memperf). SUITES was grown to ~247 hand-
// registered paths with NO disk-vs-registry check, so a newly added
// test/**/*.test.mjs can silently go UNREGISTERED and never run under the
// gate — the exact drift the mass registration closed can recur. The two
// pure helpers below make SUITES self-checking: main() computes drift and
// fails loudly (exit 2) before running anything, and
// test/run-all-tests-suite-parity.test.mjs pins the behavior.
//
// DELIBERATE omissions (a disk suite intentionally NOT run by the gate) go in
// ANNOTATED_SKIP with a one-line reason, so the guard stays green without
// hiding accidental drift. Entries may be a "test/..." string or
// { path, reason }.
//
// An entry here is NOT a way to park a suite that fails. A suite whose live
// assertion is currently false does not belong here — it belongs in SUITES
// with its live case reporting (printing) the defect instead of asserting it.
// test/recall-liveness-gate.test.mjs was the one entry and is now registered
// in SUITES: it exits 0 and prints its RED baseline as a diagnostic line.
export const ANNOTATED_SKIP = [
  // e.g. { path: "test/foo-soak.test.mjs", reason: "manual-only 30m soak" },
];

// Recursively enumerate every test/**/*.test.mjs under rootDir as POSIX
// repo-relative paths ("test/...") sorted — the exact shape of SUITES. A
// missing test/ dir yields [] (fixture roots may omit it).
export function enumerateDiskSuites(rootDir) {
  const out = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(path.join(absDir, ent.name), rel);
      } else if (ent.isFile() && ent.name.endsWith(".test.mjs")) {
        out.push(rel);
      }
    }
  };
  walk(path.join(rootDir, "test"), "test");
  return out.sort();
}

// Pure parity diff. Returns { missingFromSuites, staleInSuites }:
//   missingFromSuites — on disk but neither registered nor annotated-skipped
//                       (an unregistered suite the gate would never run).
//   staleInSuites     — registered but absent from disk (a dangling entry).
// Both sorted; both empty ⇔ SUITES covers disk exactly. skip entries may be
// "test/..." strings or { path } objects.
export function suiteParityDrift(suites, diskSuites, { skip = [] } = {}) {
  const suitesSet = new Set(suites);
  const diskSet = new Set(diskSuites);
  const skipSet = new Set(
    skip.map((s) => (typeof s === "string" ? s : s && s.path)),
  );
  const missingFromSuites = diskSuites
    .filter((d) => !suitesSet.has(d) && !skipSet.has(d))
    .sort();
  const staleInSuites = suites.filter((s) => !diskSet.has(s)).sort();
  return { missingFromSuites, staleInSuites };
}

function parseArgs(argv) {
  const opts = { failFast: false, quiet: false, preflightOnly: false };
  for (const a of argv.slice(2)) {
    if (a === "--fail-fast") opts.failFast = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--preflight-only") opts.preflightOnly = true;
    else {
      console.error(`run-all-tests: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function runOne(label, cmd, args, cwd) {
  const start = Date.now();
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    // REGINT (memperf) — gate runs are HERMETIC-OR-FAIL: REQUIRE_HERMETIC=1
    // arms the daemon-active branch in test/_hermetic-daemon-skip.mjs so a
    // suite that would skip-because-daemon-active hard-fails (exit 1) here
    // instead of passing vacuously ("0 passed, 0 failed"). Local dev running
    // a suite directly (env unset) keeps the clean skip.
    env: { ...process.env, REQUIRE_HERMETIC: "1" },
  });
  const ms = Date.now() - start;
  const code = res.status == null ? 1 : res.status;
  return { label, code, ms, signal: res.signal || null };
}

// True only when this file is the script Node was started with. Portable
// stand-in for import.meta.main, which old Node lacks (there it is undefined,
// so the runner used to exit 0 having run nothing).
function isMainModule() {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

// Lowest supported Node. Keep in step with engines.node in package.json.
// Hard requirements from what the code and suites import: zlib.crc32 (22.2)
// and node:sqlite without a flag (22.13). The floor sits just above those, at
// the release that added import.meta.main (22.18), and is the lowest version
// CI runs; nothing older is tested.
export const MIN_NODE = "22.18.0";

// Pure runtime check: { ok, reason }. Compares `version` numerically against
// MIN_NODE, then probes the features themselves so a runtime that reports a
// new enough version but lacks them is still refused.
export function nodePreflight({ version = process.versions.node } = {}) {
  const parse = (v) =>
    String(v)
      .replace(/^v/, "")
      .split(".")
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0);
  const have = parse(version);
  const need = parse(MIN_NODE);
  for (let i = 0; i < 3; i += 1) {
    const h = have[i] || 0;
    const n = need[i] || 0;
    if (h > n) break;
    if (h < n) return { ok: false, reason: `older than ${MIN_NODE}` };
  }
  if (typeof zlib.crc32 !== "function") {
    return { ok: false, reason: "node:zlib has no crc32" };
  }
  try {
    createRequire(import.meta.url)("node:sqlite");
  } catch {
    return { ok: false, reason: "node:sqlite is not available" };
  }
  return { ok: true, reason: "" };
}

function main() {
  // Refuse an unsupported Node before anything else: before argument side
  // effects, the parity guard and any spawn.
  const pre = nodePreflight();
  if (!pre.ok) {
    process.stderr.write(
      `run-all-tests: Node ${process.versions.node} is unsupported (${pre.reason}); ` +
        `this project requires Node >= ${MIN_NODE} (needs node:zlib crc32 and node:sqlite). ` +
        "No suites were run.\n",
    );
    process.exit(2);
  }

  const opts = parseArgs(process.argv);
  if (opts.preflightOnly) {
    process.stderr.write(
      `run-all-tests: preflight ok, Node ${process.versions.node} satisfies >= ${MIN_NODE}. No suites were run.\n`,
    );
    process.exit(0);
  }

  // Fail loudly on disk-vs-registry drift BEFORE running anything: an
  // unregistered test/**/*.test.mjs would otherwise never run under the gate,
  // and a stale SUITES entry would spawn `node <missing-file>` (exit 1) with a
  // confusing error. Deliberate omissions live in ANNOTATED_SKIP.
  const { missingFromSuites, staleInSuites } = suiteParityDrift(
    SUITES,
    enumerateDiskSuites(REPO_ROOT),
    { skip: ANNOTATED_SKIP },
  );
  if (missingFromSuites.length > 0 || staleInSuites.length > 0) {
    process.stderr.write(
      "\nrun-all-tests: SUITE PARITY DRIFT — disk and the SUITES registry disagree.\n",
    );
    if (missingFromSuites.length > 0) {
      process.stderr.write(
        `  ${missingFromSuites.length} test file(s) on disk are NOT registered in SUITES ` +
          "(they never run under the gate):\n",
      );
      for (const s of missingFromSuites) process.stderr.write(`    + ${s}\n`);
      process.stderr.write(
        "  Register each in scripts/run-all-tests.mjs SUITES (or add it to ANNOTATED_SKIP with a reason).\n",
      );
    }
    if (staleInSuites.length > 0) {
      process.stderr.write(
        `  ${staleInSuites.length} SUITES entr(y/ies) point at a file that no longer exists on disk:\n`,
      );
      for (const s of staleInSuites) process.stderr.write(`    - ${s}\n`);
      process.stderr.write("  Remove each stale entry from SUITES.\n");
    }
    process.exit(2);
  }

  const results = [];

  const suiteJobs = SUITES.map((rel) => ({
    label: rel,
    cmd: "node",
    args: [rel],
  }));
  const allJobs = [...suiteJobs, ...TRAILING_CHECKS];

  let failed = 0;
  for (const job of allJobs) {
    if (!opts.quiet) {
      process.stderr.write(`\n=== ${job.label} ===\n`);
    }
    const r = runOne(job.label, job.cmd, job.args, REPO_ROOT);
    results.push(r);
    if (r.code !== 0) {
      failed += 1;
      if (opts.failFast) break;
    }
  }

  // Never report success for an empty run: zero suites is a failure.
  if (results.length === 0) {
    process.stderr.write(
      "\nrun-all-tests: zero suites ran, so nothing was verified. Failing.\n",
    );
    process.exit(1);
  }

  // Summary tally — always printed.
  process.stderr.write(`\n=== run-all-tests summary ===\n`);
  process.stderr.write(`  total:  ${results.length}\n`);
  process.stderr.write(`  passed: ${results.length - failed}\n`);
  process.stderr.write(`  failed: ${failed}\n`);
  if (failed > 0) {
    process.stderr.write(`\nfailing suites:\n`);
    for (const r of results) {
      if (r.code !== 0) {
        process.stderr.write(
          `  - ${r.label} (exit=${r.code}${r.signal ? `, signal=${r.signal}` : ""})\n`,
        );
      }
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

// Run the gate only under direct invocation (node scripts/run-all-tests.mjs),
// so importing SUITES / enumerateDiskSuites / suiteParityDrift for the parity
// meta-test triggers no spawns and no process.exit.
if (isMainModule()) main();
