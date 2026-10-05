// iMessage connector — read-only poll of ~/Library/Messages/chat.db.
//
// Phase 2b connector. Reads the macOS Messages SQLite DB (chat.db) and emits
// one source-ledger row per message into storage/sources/imessage.jsonl.
// Idempotent on message.guid (the source-native stable id). Cursor is the
// max message.ROWID seen so far; restart picks up from there.
//
// Authoritative spec:
//   - kb/connectors-survey.md § imessage (the seven round-20 classifier rules)
//   - kb/ingestion.md § Connector contract (the six-point contract)
//   - kb/architecture.md § Connectors
//
// Composition: extends ConnectorBase (lib/connectors/index.js). The base
// owns cursor, idempotent append, source_policy stamping, checksum, and
// health. THIS module owns chat.db read + attributedBody decode + classifier.
//
// Deps:
//   - node:sqlite (DatabaseSync) — built-in to Node 22+. No npm dep.
//   - read-only open via { readOnly: true } so we never accidentally write
//     to Apple's source-of-truth chat.db.
//   - WAL snapshot: open with ?immutable=1 path-mode OR just rely on WAL's
//     read-consistent snapshot semantics. DatabaseSync with readOnly:true is
//     sufficient for a poll-style read; Apple's writes through the WAL do
//     not affect our snapshot mid-query (the readonly handle sees a fixed
//     snapshot per transaction).
//
// attributedBody decode (Ventura+):
//   message.text became NULL in macOS Ventura for many message kinds; the
//   text is now stored as an NSKeyedArchiver blob in message.attributedBody.
//   The blob's layout is documented community reverse-engineering:
//     header bytes ... "NSString" marker ... 0x01 0x2b/0x81/0x82 length-byte(s)
//     ... UTF-8 text payload ... trailing NSAttributes objects
//   The robust extractor heuristic:
//     - locate the byte sequence "NSString" (no quotes) in the blob
//     - skip past the class name + serialization framing
//     - read the next length-prefixed UTF-8 string
//   We wrap in try/catch; on decode failure we store
//   raw_content.text=null + raw_content.decode_error=true so the row is
//   still emitted (the salience layer can still surface "user received a
//   message we couldn't decode" without leaking content).
//
// HERMETICITY: this module reads from chatDbPath (default
// ~/Library/Messages/chat.db); tests pass a synthetic in-tmpdir chat.db
// via opts.chatDbPath. The default path is never read by the test suite.
//
// CLI shim:
//   node imessage.js --check          → prints "ok" exits 0 (process-up health probe)
//   node imessage.js --once           → runs runOnce(), prints JSON result, exits
//   node imessage.js                  → runForever() (launchd entry point)

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConnectorBase } from "./index.js";
import { CAPS as VALIDATION_CAPS } from "../validation.js";
import { parseTypedstream } from "./_typedstream.js";
// F-CCS-CONNECTOR-imessage-structural — re-use the substrate slugify so the
// connector-stamped canonical_ids are byte-identical to the cascade text-
// extractor's canonical_ids for the same handle/chat surface (foundation
// spec §6 merge invariant). buildCanonicalId is NOT called inline — it
// raises on the empty-slug sentinel while the connector wants to degrade
// gracefully (drop the entity, keep the row) per the brutalist defensive-
// degradation discipline mirrored from git-log-local.js + github-events.js.
import {
  slugify as entitySlugify,
  ENTITY_SLUG_REGEX,
  SLUG_EMPTY_SENTINEL,
} from "../synthesis/entity-extractor.js";
// TIME_ANCHORS_MAX_PER_FACT is the RESOLVER's cap. The connector's CAPS bag
// re-exports it (tests read the bag), but it does not re-declare the number:
// the resolver is the single source of truth and this import is what makes
// that sentence true. time-anchor-resolver.js has zero imports of its own, so
// it is a leaf and no cycle is constructible through this edge.
import { TIME_ANCHOR_RESOLVER_CAPS } from "../synthesis/time-anchor-resolver.js";
// F-INFRA-R42 / F-INFRA-R43 wiring: every connector now consults the unified
// operator-identity + bot-actor modules so per-source heuristics no longer
// drift. For iMessage specifically:
//   - isOperator is the forward-compat hook for the rare case where a
//     handle_id resolves to a known operator email/phone (e.g., self-DM,
//     SMS-relay loopback). is_from_me is the authoritative chat.db flag for
//     "the operator wrote this", but isOperator widens that to handle-based
//     evidence if the chat.db flag is missing or ambiguous.
//   - isBotActor catches email-shaped handles that match known automation
//     accounts (dependabot@github.com, claude[bot]@...) — uncommon on
//     iMessage but possible when an SMS-to-email gateway forwards bot
//     notifications.
import { isOperator } from "../identity/operator-identity.js";
import { isBotActor } from "../identity/bot-actors.js";
// WU-imessage-name-recovery — forward capture of resolved Contacts names.
// The connector annotates each inbound row's handle with its Contacts display
// name (recovered_handle_name) so the human name survives forward without a
// post-hoc re-query. Recovered names are PII and stay on the local ledger.
import {
  buildContactMaps,
  resolveHandleName,
  resolveAddressBookDbPaths,
} from "./_imessage-name-recovery.js";

// Add the poll interval to CAPS via local constant to avoid mutating the
// frozen CAPS object. The 30-second poll is the design budget per the
// connectors-survey.md § imessage skeleton (human-scale chat polling).
const IMESSAGE_POLL_INTERVAL_MS = 30000;

// Default chat.db path. Tests override via constructor; the daemon entry
// uses this default.
const DEFAULT_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

// Tapback / reaction associated_message_type range. Apple's message kinds
// 2000–2005 are "send" tapbacks (Love/Like/Dislike/Laugh/Emphasize/Question)
// and 3000–3005 are the matching "remove" tapbacks. We treat anything in
// [2000, 3007] as a reaction (a couple of newer types fit the span; the
// exact upper bound is conservative).
const TAPBACK_LO = 2000;
const TAPBACK_HI = 3007;

// Apple stores message.date in nanoseconds since 2001-01-01 (Mac epoch).
// Convert to ISO-8601 by adding the epoch offset and dividing to ms.
// Mac epoch: 2001-01-01T00:00:00Z = 978307200 unix seconds.
//
// R23 BigInt-safety (Phase A2 catalog CRIT-A): real chat.db message.date values
// can exceed Number.MAX_SAFE_INTEGER (values on the order of 8e17 ns,
// well over 2^53). The query CASTs date to TEXT (imessage.js:818) so we
// receive a string here. For values whose magnitude exceeds 2^53 we route
// through BigInt to preserve millisecond precision; smaller values use the
// fast Number path. Either way we return a millisecond-precise ISO string.
const MAC_EPOCH_UNIX_SECONDS = 978307200;
const MAC_EPOCH_UNIX_MS_BIG = 978307200000n;
const NANOS_PER_MS_BIG = 1000000n;
function macEpochNsToIso(ns) {
  if (ns == null) return null;
  // Apple's date column is integer nanoseconds since Mac epoch on Ventura+;
  // on older OS versions it's integer seconds. If the value is less than
  // ~10^11 it is definitely seconds (10^11 sec = year ~5000); otherwise
  // assume nanoseconds.
  const asNumber = Number(ns);
  if (!Number.isFinite(asNumber)) return null;
  // Seconds path — values are always safe-integer in this regime.
  if (Math.abs(asNumber) < 1e11) {
    const unixMs = (asNumber + MAC_EPOCH_UNIX_SECONDS) * 1000;
    if (!Number.isFinite(unixMs)) return null;
    return new Date(unixMs).toISOString();
  }
  // Nanoseconds path. If the value fits in Number safely, take the fast
  // path. Otherwise use BigInt to keep ms precision exact.
  const asString = String(ns);
  let unixMs;
  if (Number.isSafeInteger(asNumber)) {
    unixMs = asNumber / 1e6 + MAC_EPOCH_UNIX_SECONDS * 1000;
  } else {
    try {
      // Strip a leading sign for BigInt parsing; reject anything not a
      // pure base-10 integer string.
      if (!/^-?\d+$/.test(asString)) return null;
      const big = BigInt(asString);
      const unixMsBig = big / NANOS_PER_MS_BIG + MAC_EPOCH_UNIX_MS_BIG;
      unixMs = Number(unixMsBig);
    } catch {
      return null;
    }
  }
  if (!Number.isFinite(unixMs)) return null;
  return new Date(unixMs).toISOString();
}

// Decode attributedBody NSKeyedArchiver blob → text string. Returns the
// decoded UTF-8 string or null on any decode failure. NEVER throws — the
// caller treats null + decode_error=true as the failure mode.
//
// The blob is a `typedstream` archive (the classic NeXT/Cocoa serialization).
// The text-extraction heuristic:
//   1. Find the byte sequence "NSString" (8 bytes).
//   2. After NSString class declaration, find the next length-prefixed
//      string. The length is encoded as:
//        - if first byte < 0x81, that byte IS the length
//        - if first byte == 0x81, next 1 byte is the length (uint8)
//        - if first byte == 0x82, next 2 bytes are the length (big-endian uint16)
//        - if first byte == 0x83, next 4 bytes are the length (big-endian uint32)
//   3. Read `length` UTF-8 bytes; that is the message text.
//
// Reference: Apple typedstream format (community reverse-engineering, e.g.
// https://github.com/dgelessus/python-typedstream). We implement the minimum
// viable parser; deep formatting attributes are out of scope.
export function decodeAttributedBody(blob) {
  if (blob == null) return null;
  let buf;
  if (Buffer.isBuffer(blob)) {
    buf = blob;
  } else if (blob instanceof Uint8Array) {
    buf = Buffer.from(blob);
  } else {
    return null;
  }
  if (buf.length === 0) return null;
  try {
    // Find "NSString" class marker.
    const marker = Buffer.from("NSString", "utf8");
    let idx = buf.indexOf(marker);
    if (idx < 0) return null;
    // After NSString, there is a small framing window (class signature +
    // version + the "+" or "*" type code). The body text length-prefix
    // appears within ~16 bytes of the NSString end. Scan a short window
    // for a plausible length byte. The pattern in practice is:
    //   ... 'NSString' 0x86 0x84 0x01 0x2b/0x81 <len-bytes> <utf8 ...>
    // We scan starting just past NSString for the first byte that looks
    // like a length prefix and try to decode. If the resulting UTF-8 fully
    // validates we accept it; otherwise we try the next candidate position.
    const scanStart = idx + marker.length;
    const scanEnd = Math.min(buf.length, scanStart + 32);
    for (let i = scanStart; i < scanEnd; i++) {
      const b = buf[i];
      let len = -1;
      let payloadStart = -1;
      if (b === 0x81) {
        if (i + 1 >= buf.length) continue;
        len = buf[i + 1];
        payloadStart = i + 2;
      } else if (b === 0x82) {
        if (i + 2 >= buf.length) continue;
        len = buf.readUInt16BE(i + 1);
        payloadStart = i + 3;
      } else if (b === 0x83) {
        if (i + 4 >= buf.length) continue;
        len = buf.readUInt32BE(i + 1);
        payloadStart = i + 5;
      } else if (b > 0 && b < 0x80) {
        // Single-byte length. Skip if the byte is small enough to be
        // framing rather than text length — require at least 1 char.
        len = b;
        payloadStart = i + 1;
      } else {
        continue;
      }
      if (len <= 0 || payloadStart + len > buf.length) continue;
      const candidate = buf.subarray(payloadStart, payloadStart + len);
      // Validate the candidate is plausible UTF-8 by round-tripping.
      const s = candidate.toString("utf8");
      const reencoded = Buffer.from(s, "utf8");
      // If round-trip matches, accept. Also require at least one printable
      // character — pure framing bytes round-trip but yield mojibake.
      if (reencoded.equals(candidate) && /\S/.test(s)) {
        return s;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Classify a row per the seven round-20 rules in kb/connectors-survey.md
// § imessage. Returns {consent_basis, deletion_semantics, kind, derived_from}
// where:
//   - consent_basis ∈ {"first_party", "second_party_dm", "third_party_inferred"}
//   - deletion_semantics is always "full_excise" (iMessage is local to the
//     operator's machine; revoke deletes storage/sources/imessage.jsonl).
//   - kind is "reaction" for tapbacks, otherwise undefined (caller omits)
//   - derived_from is the tapback target guid array, otherwise undefined
//
// `row` is the raw chat.db join row with these fields:
//   is_from_me, cache_roomnames, participant_count, handle_id, service,
//   associated_message_type, associated_message_guid, thread_originator_guid
export function classifyRow(row) {
  const isFromMe = row.is_from_me === 1 || row.is_from_me === true;
  const cacheRoomnames = row.cache_roomnames;
  const participantCount = Number.isInteger(row.participant_count)
    ? row.participant_count
    : (row.participant_count != null ? Number(row.participant_count) : 0);
  const handleId = typeof row.handle_id === "string" ? row.handle_id : "";
  const service = typeof row.service === "string" ? row.service : "";
  const associatedType = Number.isInteger(row.associated_message_type)
    ? row.associated_message_type
    : Number(row.associated_message_type || 0);
  const associatedGuid = typeof row.associated_message_guid === "string"
    ? row.associated_message_guid
    : null;

  // Rule 5: tapback / reaction. Emit kind:"reaction" + derived_from.
  // Consent basis inherits from target — but at the connector layer we
  // don't have the target's classification handy. The reactor's authorship
  // still trumps audience (round-20 C1), so:
  //   - is_from_me=1 reaction → first_party (own reaction is own authored event)
  //   - is_from_me=0 reaction → inherits from target context:
  //       - 1:1 room → second_party_dm
  //       - group room → third_party_inferred
  //       - business handle → third_party_inferred
  // That matches the round-20 close: tapbacks ARE authored events for
  // consent purposes; the "inheritance" is rendering-only (the salience
  // layer at promotion time can re-link to the target's classification).
  const isReaction = associatedType >= TAPBACK_LO && associatedType <= TAPBACK_HI;

  // Rule 4: business iMessage edge.
  const isBusiness =
    /^BIZ:/.test(handleId) || service === "BusinessChat";

  // F-INFRA-R42 wiring — handle-derived operator evidence. When the inbound
  // handle resolves to a known operator identity (e.g., self-DM via SMS-relay
  // loopback, or a registered operator email-handle in the chat.db) we
  // upgrade the consent basis to first_party even when is_from_me=0. This
  // preserves the chat.db `is_from_me` flag as authoritative AND adds a
  // second evidence source so handle-only loopback cases aren't misfiled.
  const handleLooksLikeOperator =
    !isFromMe && handleId.length > 0 && isOperator(handleId, "imessage");

  // F-INFRA-R43 wiring — bot-actor detection on email-shaped handles. The
  // chat.db rarely stamps a bot identity into handle_id, but SMS-to-email
  // gateways can forward dependabot@github.com / claude[bot]@... onto an
  // operator's phone. We surface this on the classifier output so the
  // Stage-0 module (or future operator tooling) can route on it.
  const handleIsBot = !isFromMe && handleId.length > 0 && isBotActor(handleId);

  let consentBasis;
  if (isFromMe || handleLooksLikeOperator) {
    // Rule 1: outbound is always first_party (round-20 C1). Same outcome
    // when the inbound handle resolves to a known operator identity per
    // F-INFRA-R42.
    consentBasis = "first_party";
  } else if (isBusiness) {
    // Rule 4: inbound from business merchant.
    consentBasis = "third_party_inferred";
  } else if (cacheRoomnames != null || participantCount > 2) {
    // Rule 3: inbound group.
    consentBasis = "third_party_inferred";
  } else if (participantCount === 2) {
    // Rule 2: inbound 1:1.
    consentBasis = "second_party_dm";
  } else {
    // Edge: participant_count==1 (shouldn't happen for inbound) or unknown.
    // Be conservative: treat as third_party_inferred.
    consentBasis = "third_party_inferred";
  }

  const result = {
    consent_basis: consentBasis,
    deletion_semantics: "full_excise",
  };
  // Forward the bot-actor signal so Stage-0 sees a single per-row hint
  // instead of re-running isBotActor against handle_id. The flag is
  // additive metadata; it does NOT short-circuit the round-20 classifier.
  if (handleIsBot) {
    result.bot_actor = true;
  }
  if (isReaction) {
    result.kind = "reaction";
    if (associatedGuid) {
      result.derived_from = [associatedGuid];
    }
  }
  return result;
}

// =============================================================================
// F-CCS-CONNECTOR-imessage-structural — buildStructuredFeatures (per-row)
// =============================================================================
//
// Closes the empty-parties[] surface seen across all imessage facts: the
// salience cascade currently re-derives entities and time anchors from the
// flat raw_content text, and a handle_id like `sam@example.org` (the
// canonical identity for a sender whose contact name is unknown) was being
// dropped on the floor because the text-extractor only saw the message body.
// This connector ALREADY KNOWS — at emit time — who the party is
// (raw_content.handle_id), which thread the message belongs to
// (raw_content.chat_guid + cache_roomnames distinguishes group vs DM), and
// when the event happened (row.ts derived from message.date). The
// structured-features payload pins all three so downstream cascades stop
// forcing the text extractor to re-discover them.
//
// Shape pinned by mcp/docs/specs/ccs/structured-features-schema.md §3.1.
// Entity + TimeAnchor sub-shapes reference (not redefine) the canonical
// extractor in mcp/lib/synthesis/entity-extractor.js so two slugify
// implementations diverging by a single step is a defect (W2 git-log-
// structural discipline). evidence:'structural' bypasses the FM-1 STOPWORDS
// check per entity-schema §6.3 — exactly the antidote that lets the opaque
// handle survive the gate.

/** Frozen schema discriminator for the v1 ship of structured_features. */
export const STRUCTURED_FEATURES_SCHEMA_VERSION = "v1";

/**
 * Frozen emitter version. Conforms to STRUCTURED_FEATURES_EMITTER_VERSION_REGEX
 * `/^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/` so the future
 * cascade-side validator accepts the payload. Format `<name>@<semver>` keeps
 * the drift-detector (OQ1) able to spot upgrades and re-extract.
 */
export const STRUCTURED_FEATURES_EMITTER_VERSION = "imessage-structural@1.0.0";

/**
 * Source-scope this connector stamps. Closed enum from entity-extractor.js
 * ENTITY_SOURCE_SCOPES — stamping a non-enum source_scope would make the
 * canonical_id drift from the cascade text-extractor path and break the
 * union-by-canonical-id merge invariant (foundation spec §6).
 */
export const STRUCTURED_FEATURES_SOURCE_SCOPE = "imessage";

/** Per-row evidence kind. Connector-emit allowlist is {handle, structural,
 *  kb_lookup} per foundation spec §3.2; the imessage connector knows the
 *  handle_id + chat_guid structurally, so 'structural' is the only honest
 *  value (a `handle` evidence kind in entity-schema is reserved for opaque
 *  per-source handles that the cascade later promotes; the connector itself
 *  emits structural because the surface is structurally-typed in the row). */
const STRUCTURED_EVIDENCE = "structural";

/** Module VERSION export per the WU engineering discipline. Bumped when the
 *  structured-features emission logic changes (NOT when the chat.db parser
 *  changes — the parser does not affect the pinned canonical_id discipline). */
export const VERSION = "1.0.0";

/** Frozen CAPS bag for the WU discipline + test introspection. Tests read
 *  CAPS.SCHEMA_VERSION etc. directly without poking at named exports. The
 *  ENTITY_KINDS + connector-evidence allowlist are inlined defensively so
 *  the connector ships before downstream CAPS edits land (mirrors W2). */
export const CAPS = Object.freeze({
  SCHEMA_VERSION: STRUCTURED_FEATURES_SCHEMA_VERSION,
  EMITTER_VERSION: STRUCTURED_FEATURES_EMITTER_VERSION,
  SOURCE_SCOPE: STRUCTURED_FEATURES_SOURCE_SCOPE,
  ENTITY_KINDS: Object.freeze([
    "person", "place", "org", "project", "event", "topic", "artifact",
  ]),
  VALID_EVIDENCE_AT_CONNECTOR: Object.freeze([
    "handle", "structural", "kb_lookup",
  ]),
  ENTITY_MAX_PER_ROW: 32,
  // NOT a local literal: read from the resolver that owns the cap.
  TIME_ANCHORS_MAX_PER_FACT: TIME_ANCHOR_RESOLVER_CAPS.TIME_ANCHORS_MAX_PER_FACT,
});

/**
 * _structuralEntity: build one Entity (entity-schema §4 shape) from a raw
 * surface. Returns null if the surface slugifies to the empty sentinel
 * (defensive degradation — the cascade still has the text-extractor path
 * for that surface). Pure function. No I/O, no Date.now(), no Math.random().
 */
function _structuralEntity(kind, surface) {
  if (typeof surface !== "string" || surface === "") return null;
  let slug;
  try {
    slug = entitySlugify(surface);
  } catch {
    return null;
  }
  if (slug === SLUG_EMPTY_SENTINEL) return null;
  if (!ENTITY_SLUG_REGEX.test(slug)) return null;
  return {
    kind,
    canonical_id: `${kind}:${STRUCTURED_FEATURES_SOURCE_SCOPE}:${slug}`,
    surface,
    source_scope: STRUCTURED_FEATURES_SOURCE_SCOPE,
    evidence: STRUCTURED_EVIDENCE,
    confidence: 1.0,
    extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
  };
}

/**
 * isGroupChat: classify a raw imessage row as a group (vs 1:1 DM).
 *
 * Heuristic mirrors classifyRow's round-20 rule 3 closely so the topic-
 * entity emit path agrees with the consent-basis classifier:
 *   - cache_roomnames non-null → group (Apple's canonical group flag on
 *     Ventura/Sonoma; aliased from c.room_name on Tahoe+ in pollOnce).
 *   - participant_count > 2 → group (covers any chat.db where
 *     cache_roomnames was NULLed but the chat is still multi-party).
 *   - chat_guid starting with the literal `chat` substring (after the
 *     `any;+;` or `any;-;` framing) → group fallback for legacy rows where
 *     neither cache_roomnames nor participant_count survived.
 *
 * The three are OR'd because they each catch a different chat.db variant
 * and false-positives on this heuristic only add a topic entity (no
 * consent-basis change, no row drop) — defense-in-depth bias toward
 * surfacing the thread identity over hiding it.
 */
function isGroupChat(rawContent) {
  if (rawContent == null || typeof rawContent !== "object") return false;
  if (typeof rawContent.cache_roomnames === "string" && rawContent.cache_roomnames.length > 0) {
    return true;
  }
  const pc = Number(rawContent.participant_count);
  if (Number.isFinite(pc) && pc > 2) return true;
  const chatGuid = typeof rawContent.chat_guid === "string" ? rawContent.chat_guid : "";
  // Apple's group chat_guids carry the literal `chat<digits>` suffix in the
  // third segment (e.g. `any;+;chat100000000000000001`); 1:1 chat_guids carry
  // the handle (e.g. `any;-;sam@example.org` or `any;-;+15551234567`).
  if (/;[+-];chat\d+/.test(chatGuid)) return true;
  return false;
}

/**
 * buildStructuredFeatures: derive the structured_features payload for a
 * single imessage row from its raw_content. Returns the payload object on
 * success OR undefined when the raw_content is missing the structurally-
 * typed fields we need (defensive degradation per the brutalist hot-path
 * discipline — the connector emits the row without structured_features and
 * the cascade falls back to the text-extractor path, which is the explicit
 * backwards-compat invariant from foundation spec §7).
 *
 * Inputs we read from raw_content (the connector ALREADY KNOWS these):
 *   - handle_id : the per-message sender identifier (phone, email, urn:biz:…).
 *                  Becomes person entity. handle_id is the canonical identity
 *                  even when the contact name is unknown.
 *   - chat_guid : the thread identifier. For group chats becomes a topic
 *                  entity so the cascade can join across messages on the
 *                  same thread.
 * And from the row envelope:
 *   - ts : the message clock (already converted from Apple's nanosecond
 *          mac-epoch via macEpochNsToIso); becomes the absolute time
 *          anchor with parsed.iso = UTC-normalized.
 *   - is_from_me : flips the parties[] order (outbound → ["user", handle];
 *                  inbound → [handle, "user"]).
 *
 * Failure modes that route to undefined (NOT throw — never block emit):
 *   - row is not a plain object
 *   - row.raw_content is not a plain object
 *   - handle_id AND chat_guid AND ts all missing/empty (no structural
 *     surface at all — text-only path is the correct fallback)
 *
 * Otherwise: returns a partial payload (some fields may be empty arrays if
 * their input was malformed). The cascade merger is union-with-precedence
 * so partial structural emission is strictly additive (foundation spec §6).
 */
export function buildStructuredFeatures(row) {
  if (row == null || typeof row !== "object" || Array.isArray(row)) return undefined;
  const rc = row.raw_content;
  if (rc == null || typeof rc !== "object" || Array.isArray(rc)) return undefined;

  const entities = [];

  // Person entity from handle_id. The handle_id IS the canonical surface
  // per entity-schema §5.3 — even when the contact name is unknown, the
  // handle is the persistent identifier (re-keyed across reboots, app
  // upgrades, contact-card edits). For outbound messages handle_id may
  // be null (Apple stamps handle_id=0 / NULL for is_from_me=1); we skip
  // the person entity in that case because the operator is represented
  // by the "user" sentinel in parties[], not by a structural canonical_id.
  const handleId = typeof rc.handle_id === "string" ? rc.handle_id : "";
  const personEntity = handleId.length > 0 ? _structuralEntity("person", handleId) : null;
  if (personEntity) entities.push(personEntity);

  // Topic entity from chat_guid for group chats. DMs are NOT stamped as
  // topics because the canonical thread identity for a 1:1 IS the person
  // (the person entity above already supplies that join key). Stamping a
  // topic for DMs would inflate the entity count without adding a unique
  // join surface and would dilute the topic-coverage statistics the
  // cascade uses for thread-level salience.
  const chatGuid = typeof rc.chat_guid === "string" ? rc.chat_guid : "";
  let topicEntity = null;
  if (chatGuid.length > 0 && isGroupChat(rc)) {
    topicEntity = _structuralEntity("topic", chatGuid);
    if (topicEntity) entities.push(topicEntity);
  }

  // Absolute time anchor from the row ts (already UTC-normalized via
  // macEpochNsToIso). raw_phrase preserves the form the connector saw;
  // parsed.iso is UTC-normalized so the cascade dedupe key (kind,
  // parsed.iso) is stable across TZ-offset variants of the same instant.
  // Date(...).toISOString() normalizes to UTC by construction.
  const timeAnchors = [];
  const ts = typeof row.ts === "string" ? row.ts : null;
  if (ts != null && ts.length > 0) {
    const parsedMs = Date.parse(ts);
    if (Number.isFinite(parsedMs)) {
      let iso;
      try {
        iso = new Date(parsedMs).toISOString();
      } catch {
        iso = null;
      }
      if (typeof iso === "string" && iso !== "") {
        timeAnchors.push({
          kind: "absolute",
          raw_phrase: ts,
          parsed: { iso },
          extractor_confidence: 1.0,
          extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
          // structural=true is the connector's pinning that this anchor
          // comes from a structurally-typed field — the merger uses this
          // to win tie-breaks over text-extracted anchors of the same
          // (kind, iso) per foundation spec §6 OQ5.
          structural: true,
        });
      }
    }
  }

  // parties[]: canonical projection of the row.parties[] ordering, keyed
  // by either the person canonical_id (for the non-operator party) or the
  // "user" sentinel (for the operator). is_from_me decides the order so
  // the merger can compute authorship-vs-audience downstream.
  //   - outbound (is_from_me=1) → ["user", <handle canonical_id>]
  //   - inbound  (is_from_me=0) → [<handle canonical_id>, "user"]
  //
  // BOTH endpoints are required for parties[] to be informative — "user"
  // alone is structurally redundant (every imessage row involves the
  // operator by definition; the salience layer learns nothing new from
  // ["user"]). When the handle_id is missing or slugifies away we emit
  // parties=[] so the merger short-circuits to the text-only path for
  // parties (the cascade's row-parties-as-entities node can still recover
  // the opaque handle via row.parties[] separately).
  const isFromMe = rc.is_from_me === 1 || rc.is_from_me === true;
  const parties = [];
  if (personEntity) {
    if (isFromMe) {
      parties.push("user", personEntity.canonical_id);
    } else {
      parties.push(personEntity.canonical_id, "user");
    }
  }

  // If we found NOTHING structural at all, return undefined so the row
  // emits without structured_features (backwards-compat path; cascade
  // text extractor runs as today). The check is conservative: even an
  // empty entities[] is OK as long as the parties[] carries the operator
  // sentinel — that still wins over text-only re-derivation.
  if (entities.length === 0 && timeAnchors.length === 0 && parties.length === 0) {
    return undefined;
  }

  // Sort entities by canonical_id (foundation spec §3.1 — array MUST be
  // sorted ascending for byte-stable merge / dedupe).
  entities.sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0,
  );

  // Cap at ENTITY_MAX_PER_ROW; defense-in-depth (the merger also caps).
  const cappedEntities = entities.slice(0, CAPS.ENTITY_MAX_PER_ROW);
  const cappedAnchors = timeAnchors.slice(0, CAPS.TIME_ANCHORS_MAX_PER_FACT);

  return {
    schema_version: STRUCTURED_FEATURES_SCHEMA_VERSION,
    emitter_version: STRUCTURED_FEATURES_EMITTER_VERSION,
    entities: cappedEntities,
    time_anchors: cappedAnchors,
    parties,
  };
}

// ---------------------------------------------------------------------------
// IMessageConnector
// ---------------------------------------------------------------------------

export class IMessageConnector extends ConnectorBase {
  constructor({
    chatDbPath = DEFAULT_CHAT_DB_PATH,
    sourceLedgerPath,
    cursorPath,
    now,
    // WU-imessage-name-recovery — forward-capture knobs.
    //   addressBookDbPaths : explicit *.abcddb paths (test hook). When omitted,
    //                        the production Sources dir is globbed at poll time.
    //   resolveContactNames: set false to skip the Contacts join entirely
    //                        (e.g. a hermetic test that does not exercise it).
    addressBookDbPaths,
    resolveContactNames = true,
  } = {}) {
    super({
      source: "imessage",
      sourceLedgerPath,
      cursorPath,
      // ConnectorBase requires a classifier closure; we route through
      // the row-shape stamped onto raw_content so the base stamps the
      // returned policy. The kind/derived_from are NOT stamped via
      // sourcePolicyForRow — they live as top-level keys on the row,
      // which ConnectorBase copies through verbatim.
      sourcePolicyForRow: (row) => {
        const classified = classifyRow(row.raw_content || {});
        return {
          deletion_semantics: classified.deletion_semantics,
          consent_basis: classified.consent_basis,
        };
      },
    });
    this.chatDbPath = chatDbPath;
    // Override-for-test pattern: tests pass opts.now to make timestamps
    // deterministic. Production code uses the default Date().toISOString().
    this._now = typeof now === "function" ? now : null;
    // WU-imessage-name-recovery — Contacts forward-capture config + per-poll
    // cache. _contactMaps is populated once per pollOnce (defensive) and read
    // by _buildLedgerRow to annotate recovered_handle_name.
    this._addressBookDbPaths = Array.isArray(addressBookDbPaths)
      ? addressBookDbPaths
      : null;
    this._resolveContactNames = resolveContactNames !== false;
    this._contactMaps = null;
  }

  _serverTs() {
    if (this._now) return this._now();
    return new Date().toISOString();
  }

  // WU-imessage-name-recovery — return the Set of column names on the `chat`
  // table for the open DB. Used by pollOnce to conditionally SELECT the
  // optional display_name / style columns (absent on the test fixture + some
  // legacy schemas). Defensive: returns an empty Set on any pragma failure so
  // the caller falls back to NULL-literal aliases (never throws, never blocks
  // the poll).
  _chatTableColumns(db) {
    const cols = new Set();
    try {
      const rows = db.prepare("PRAGMA table_info(chat)").all();
      for (const r of rows) {
        if (r && typeof r.name === "string") cols.add(r.name);
      }
    } catch {
      // No chat table / pragma unavailable — caller degrades to NULL aliases.
    }
    return cols;
  }

  // pollOnce — execute one SELECT batch against chat.db, append new rows,
  // advance cursor. Returns {appended, errors, latest_message_rowid}.
  //
  // The query joins message → chat_message_join → chat → handle (left join
  // on handle since outbound rows have handle_id=0). We compute
  // participant_count as a subquery so the classifier can see the chat's
  // room size at message time.
  async pollOnce(opts = {}) {
    const limit = typeof opts.limit === "number" ? opts.limit : 1000;
    if (!existsSync(this.chatDbPath)) {
      await this.tagError("chat_db_absent");
      return { appended: 0, errors: 1, latest_message_rowid: null };
    }

    let db;
    let DatabaseSync;
    try {
      // Lazy import so the module can be required for type checks without
      // node:sqlite being available (e.g. in older Node test contexts).
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch (err) {
      await this.tagError("sqlite_module_unavailable");
      return { appended: 0, errors: 1, latest_message_rowid: null };
    }

    try {
      db = new DatabaseSync(this.chatDbPath, { readOnly: true });
    } catch (err) {
      await this.tagError("chat_db_open_failed");
      return { appended: 0, errors: 1, latest_message_rowid: null };
    }

    let appended = 0;
    let errors = 0;
    let latestRowid = null;

    // WU-imessage-name-recovery (forward capture): build the Contacts
    // phone/email -> name maps ONCE per poll so _buildLedgerRow can annotate
    // each inbound row's handle with its recovered_handle_name. Every failure
    // mode (TCC/FDA denied for AddressBook, node:sqlite missing, no Sources
    // dir) degrades to null maps — the row still lands, just without the
    // human-name annotation. NEVER blocks the poll.
    // HERMETICITY: resolve Contacts ONLY when (a) explicit addressBookDbPaths
    // were injected (a test exercising the join with its own fixture abcddb),
    // OR (b) we are polling the PRODUCTION chat.db. A test that points
    // chatDbPath at a tmpdir fixture is, by construction, NOT the real Messages
    // DB — globbing the operator's real AddressBook against a synthetic chat.db
    // would be incoherent AND would breach the hermetic test contract. So the
    // real-Sources glob is suppressed unless we are on the production path.
    this._contactMaps = null;
    const onProductionChatDb = this.chatDbPath === DEFAULT_CHAT_DB_PATH;
    if (
      this._resolveContactNames &&
      (Array.isArray(this._addressBookDbPaths) || onProductionChatDb)
    ) {
      try {
        const abPaths = Array.isArray(this._addressBookDbPaths)
          ? this._addressBookDbPaths
          : resolveAddressBookDbPaths();
        if (Array.isArray(abPaths) && abPaths.length > 0) {
          const maps = await buildContactMaps(abPaths);
          if (maps && (maps.phoneToName.size > 0 || maps.emailToName.size > 0)) {
            this._contactMaps = maps;
          }
        }
      } catch {
        this._contactMaps = null;
      }
    }

    try {
      const cursor = (await this.readCursor()) || {};
      const lastRowid =
        Number.isInteger(cursor.last_message_rowid) ? cursor.last_message_rowid : 0;

      // WU-imessage-name-recovery (forward capture): probe the `chat` table for
      // the optional display_name / style columns. They exist on the live
      // chat.db (verified) but NOT on every fixture / legacy schema. We select
      // them only when present so the connector never fails `prepare` on a DB
      // that lacks them (the test fixture chat table predates these columns).
      const chatCols = this._chatTableColumns(db);
      const hasDisplayName = chatCols.has("display_name");
      const hasStyle = chatCols.has("style");
      const displayNameSelect = hasDisplayName
        ? "c.display_name AS chat_display_name,"
        : "NULL AS chat_display_name,";
      const styleSelect = hasStyle
        ? "c.style AS chat_style,"
        : "NULL AS chat_style,";

      // The query. message.attributedBody is BLOB; node:sqlite returns it as
      // Uint8Array. We classify with cache_roomnames + participant_count
      // joined from the chat table.
      const sql = `
        SELECT
          m.ROWID                     AS rowid,
          m.guid                      AS guid,
          m.text                      AS text,
          m.attributedBody            AS attributedBody,
          m.is_from_me                AS is_from_me,
          m.associated_message_type   AS associated_message_type,
          m.associated_message_guid   AS associated_message_guid,
          m.thread_originator_guid    AS thread_originator_guid,
          -- CAST date to TEXT to avoid JS Number-precision loss on the
          -- Ventura+ nanosecond column (values larger than 2^53 exceed
          -- Number.MAX_SAFE_INTEGER). The connector parses the string
          -- back to a number in macEpochNsToIso, where the divide-by-1e6
          -- to ms happens before precision matters.
          CAST(m.date AS TEXT)        AS date,
          m.service                   AS service,
          h.id                        AS handle_id,
          c.guid                      AS chat_guid,
          -- macOS schema variance (round-21 activation fix): Ventura/Sonoma
          -- chat table has cache_roomnames; Tahoe (macOS 26+, Darwin 25+)
          -- renamed it to room_name with identical semantics: NULL for 1:1,
          -- non-NULL group identifier for groups. Verified against this
          -- operator chat.db: 743 chats with room_name NULL all have
          -- style=45 (1:1); 58 chats with room_name set all have style=43
          -- (group). The alias cache_roomnames is preserved so the
          -- downstream classifier reads it unchanged. display_name is
          -- independent (set on most chats regardless of kind, so it is
          -- NOT a safe fallback). v2.1 hardening: switch to c.style for a
          -- column-name-stable signal.
          c.room_name                 AS cache_roomnames,
          -- WU-imessage-name-recovery (forward capture): the chat's
          -- operator-set subject (group display name) and the style
          -- discriminator (45=DM, 43=group). display_name is captured so a
          -- HUMAN group subject ("Family", "Roommates") survives onto the
          -- ledger row going forward; the Apple-auto-token gate
          -- (isAppleAutoToken) is applied at LABEL time, not here — the
          -- connector records the raw value verbatim. style lets the label
          -- deriver distinguish group/DM without re-counting participants.
          -- Column presence is probed (chatCols) so a fixture / legacy schema
          -- lacking either column falls back to a NULL literal alias.
          ${displayNameSelect}
          ${styleSelect}
          -- chat_handle_join stores OTHER parties only -- Apple omits the
          -- operator from the join. So a 1:1 DM has count=1 and a group of
          -- N has count=N-1. Rules 2 and 3 in connectors-survey.md compare
          -- against the chat participant count INCLUDING the operator, so
          -- we add 1: a 1:1 yields 2, a 3-person group yields 4.
          (
            SELECT COUNT(*) + 1 FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID
          )                           AS participant_count
        FROM message m
        LEFT JOIN handle h            ON h.ROWID = m.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat c              ON c.ROWID = cmj.chat_id
        WHERE m.ROWID > ?
        ORDER BY m.ROWID ASC
        LIMIT ?
      `;

      let stmt;
      try {
        stmt = db.prepare(sql);
      } catch (err) {
        await this.tagError("chat_db_query_prepare_failed");
        return { appended: 0, errors: 1, latest_message_rowid: null };
      }

      let rows;
      try {
        rows = stmt.all(lastRowid, limit);
      } catch (err) {
        await this.tagError("chat_db_query_run_failed");
        return { appended: 0, errors: 1, latest_message_rowid: null };
      }

      // F-T2-IMESSAGE-F7 — outbound parties[] repair.
      //
      // chat.db quirk: for outbound messages (is_from_me=1) Apple stamps
      // handle_id=0 (the operator is not in the handle table), so the
      // LEFT JOIN above yields h.id=NULL. The pre-fix `parties` builder
      // collapsed to ["user"] alone, losing audience metadata for ~1.0%
      // of ledger rows (~158 in this operator's corpus). The salience
      // layer's authorship + structural scorers then mis-attribute the
      // recipient cohort, lowering downstream scores incorrectly.
      //
      // Repair: when is_from_me=1 AND handle_id is NULL, look up the
      // chat's participants via chat_handle_join and stamp them onto a
      // synthetic `chat_participants` field on the row. _buildLedgerRow
      // consumes that field to widen `parties` to
      // ["user", ...participant_handles].
      //
      // We amortize the DB cost with a per-batch participants cache keyed
      // by chat_guid (each batch is ≤1000 rows; chat_guid cardinality is
      // small so the cache hit-rate is high in real corpora).
      //
      // Fallback: when chat_handle_join is missing (legacy chat.db
      // versions before macOS El Capitan) the SELECT yields no rows; we
      // fall back to parties=["user"] silently (matches legacy behaviour).
      const outboundNeedsParticipants = rows.some(
        (r) => (r.is_from_me === 1 || r.is_from_me === true) && (r.handle_id == null || r.handle_id === ""),
      );
      const participantsCache = new Map();
      if (outboundNeedsParticipants) {
        let chatPartsStmt;
        try {
          chatPartsStmt = db.prepare(`
            SELECT h.id AS handle
            FROM chat c
            JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
            JOIN handle h            ON h.ROWID    = chj.handle_id
            WHERE c.guid = ?
          `);
        } catch (_err) {
          chatPartsStmt = null;
        }
        if (chatPartsStmt) {
          for (const r of rows) {
            const isFromMeRow = r.is_from_me === 1 || r.is_from_me === true;
            const handleMissing = r.handle_id == null || r.handle_id === "";
            if (!isFromMeRow || !handleMissing) continue;
            const chatGuid = typeof r.chat_guid === "string" ? r.chat_guid : null;
            if (!chatGuid) continue;
            if (participantsCache.has(chatGuid)) continue;
            try {
              const partsRows = chatPartsStmt.all(chatGuid);
              const handles = [];
              for (const pr of partsRows) {
                if (typeof pr.handle === "string" && pr.handle.length > 0) {
                  handles.push(pr.handle);
                }
              }
              participantsCache.set(chatGuid, handles);
            } catch {
              // Legacy chat.db without chat_handle_join, or a transient
              // sqlite error. Cache an empty array so we don't re-query
              // the same chat for every row in the batch.
              participantsCache.set(chatGuid, []);
            }
          }
        }
      }

      for (const dbRow of rows) {
        try {
          // F-T2-IMESSAGE-F7 — stamp the cached chat participants onto
          // the row so _buildLedgerRow can widen parties. No-op when the
          // cache miss returns [] (legacy chat.db) or when this is not
          // an outbound-with-null-handle row.
          const isFromMeRow = dbRow.is_from_me === 1 || dbRow.is_from_me === true;
          const handleMissing = dbRow.handle_id == null || dbRow.handle_id === "";
          if (isFromMeRow && handleMissing && typeof dbRow.chat_guid === "string") {
            const cached = participantsCache.get(dbRow.chat_guid);
            if (Array.isArray(cached) && cached.length > 0) {
              dbRow.chat_participants = cached;
            }
          }
          const stamped = this._buildLedgerRow(dbRow);
          const result = await this.appendLedgerRow(stamped);
          if (result.appended) appended += 1;
          if (Number.isFinite(Number(dbRow.rowid))) {
            const n = Number(dbRow.rowid);
            if (latestRowid == null || n > latestRowid) latestRowid = n;
          }
        } catch (err) {
          errors += 1;
          // Do not tagError per-row to avoid flapping; only the batch-level
          // failures (open / query) increment error_count. A single bad row
          // is logged via errors return value.
        }
      }

      // Advance cursor.
      if (latestRowid != null) {
        const ts = this._serverTs();
        const nextState = {
          ...cursor,
          last_message_rowid: latestRowid,
          last_appended_ts: ts,
          last_cursor_advance_ts: ts,
        };
        // Preserve the last appended row's id if we minted any.
        if (appended > 0) {
          // The base returns id; we don't track it per-row here. The cursor's
          // last_appended_id is informational only; leave whatever was there.
        }
        await this.writeCursor(nextState);
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }

    return { appended, errors, latest_message_rowid: latestRowid };
  }

  // Build a ledger row from a raw chat.db join row. Decodes attributedBody
  // if text is null. Stamps the round-20 classifier output (kind +
  // derived_from for tapbacks) as top-level row fields; ConnectorBase
  // copies these through verbatim and stamps source_policy via the
  // sourcePolicyForRow closure.
  _buildLedgerRow(dbRow) {
    const classified = classifyRow({
      is_from_me: dbRow.is_from_me,
      cache_roomnames: dbRow.cache_roomnames,
      participant_count: dbRow.participant_count,
      handle_id: dbRow.handle_id,
      service: dbRow.service,
      associated_message_type: dbRow.associated_message_type,
      associated_message_guid: dbRow.associated_message_guid,
    });

    // Source-fidelity decode (round-22): prefer the typedstream-encoded
    // canonical NSString from message.attributedBody (the source of truth on
    // macOS Ventura+) over the legacy m.text TEXT column (which Apple
    // populates with the Object Replacement Character U+FFFC as a placeholder
    // whenever attributedBody is the canonical store). On parse failure we
    // fall back to m.text and stamp attributedBody_decode_error=true so the
    // operator-visible state explains the placeholder content. When the
    // legacy text column is the only source available, text_source records
    // that fact so the salience layer can corroborate against signal sources.
    //
    // R23 (Phase A1 HIGH-I): when the legacy m.text column is literally a
    // single U+FFFC Object Replacement Character (Apple's placeholder for
    // "see attributedBody"), the placeholder is operator-irrelevant content
    // that pollutes salience. We scrub it to null in two cases:
    //   - attributedBody is present and decoded successfully (text already
    //     came from attributedBody so the legacy column is unused), or
    //   - attributedBody decode failed AND m.text is U+FFFC (we have no
    //     useful text; emit text=null + attributedBody_decode_error=true).
    //
    // R23 (Phase A1 CRIT-B): rows with BOTH text=NULL and attributedBody=NULL
    // (1.75% of real chat.db rows; status/tapback shells) yield text=null +
    // text_source=null. The row is still emitted (the classifier carries
    // useful policy + parties).
    let text = null;
    let textSource = null;
    let attributedBodyDecodeError = false;
    const legacyText = typeof dbRow.text === "string" ? dbRow.text : null;
    const legacyIsPlaceholder = legacyText === "￼";
    if (dbRow.attributedBody != null) {
      const parsed = parseTypedstream(dbRow.attributedBody);
      if (parsed != null) {
        text = parsed.text;
        textSource = "attributedBody";
      } else {
        attributedBodyDecodeError = true;
        if (legacyText != null && !legacyIsPlaceholder) {
          text = legacyText;
          textSource = "legacy_text_column";
        }
      }
    } else if (legacyText != null && !legacyIsPlaceholder) {
      text = legacyText;
      textSource = "legacy_text_column";
    }

    const rawContent = {
      text,
      handle_id: typeof dbRow.handle_id === "string" ? dbRow.handle_id : null,
      chat_guid: typeof dbRow.chat_guid === "string" ? dbRow.chat_guid : null,
      cache_roomnames: dbRow.cache_roomnames != null ? String(dbRow.cache_roomnames) : null,
      is_from_me: dbRow.is_from_me === 1 || dbRow.is_from_me === true ? 1 : 0,
      associated_message_type: dbRow.associated_message_type != null
        ? Number(dbRow.associated_message_type) : 0,
      thread_originator_guid: typeof dbRow.thread_originator_guid === "string"
        && dbRow.thread_originator_guid !== ""
        ? dbRow.thread_originator_guid : null,
      service: typeof dbRow.service === "string" ? dbRow.service : null,
      date_apple: dbRow.date != null ? String(dbRow.date) : null,
      participant_count: Number.isFinite(Number(dbRow.participant_count))
        ? Number(dbRow.participant_count) : 0,
    };
    // WU-imessage-name-recovery (forward capture): record the chat's
    // operator-set subject (group display name) + the style discriminator on
    // the ledger row so a HUMAN group subject survives forward without a
    // re-query of chat.db, and so the conversation-index label deriver can
    // distinguish group/DM. Both are raw (un-gated) values — the
    // Apple-auto-token gate is applied at LABEL time, not at capture time.
    rawContent.chat_display_name =
      typeof dbRow.chat_display_name === "string" && dbRow.chat_display_name.length > 0
        ? dbRow.chat_display_name
        : null;
    rawContent.chat_style = Number.isFinite(Number(dbRow.chat_style))
      ? Number(dbRow.chat_style)
      : null;
    // WU-imessage-name-recovery (forward capture): resolve the inbound handle's
    // contact name from the Contacts maps the poll loaded once (defensive —
    // null when no maps, no match, or an outbound row). PII: lives only on the
    // local ledger row, never sent anywhere. The opaque handle_id stays the
    // canonical join key; this is an additive human-readable annotation.
    let recoveredHandleName = null;
    if (
      this._contactMaps &&
      rawContent.handle_id != null &&
      !(rawContent.is_from_me === 1)
    ) {
      try {
        recoveredHandleName = resolveHandleName(rawContent.handle_id, this._contactMaps);
      } catch {
        recoveredHandleName = null;
      }
    }
    if (recoveredHandleName) {
      rawContent.recovered_handle_name = recoveredHandleName;
    }
    if (textSource != null) {
      rawContent.text_source = textSource;
    }
    if (attributedBodyDecodeError) {
      rawContent.attributedBody_decode_error = true;
    }
    // F-NEW-W1-R43-CODEX-IMESSAGE-WIRING: stamp raw_content.sender_is_bot at
    // row-build time so downstream consumers (Stage-0 dispatch, salience
    // scoring, quarantine restore) read a precomputed boolean rather than
    // re-running isBotActor() per dispatch. The signal is sourced from
    // classifyRow's `bot_actor` flag, which already routes the handle_id
    // through the unified F-INFRA-R43 predicate. Outbound rows (is_from_me=1)
    // are stamped `false` by construction: the operator IS the sender and
    // the operator is not a bot. Inbound rows are stamped based on the
    // handle_id check. The field is always present (boolean) so a
    // missing-key sentinel is never ambiguous with "we didn't check".
    rawContent.sender_is_bot = classified.bot_actor === true;
    // Reply threading: store the in_reply_to pointer (rule 7). Classifier
    // does NOT inherit consent_basis from the originator.
    if (rawContent.thread_originator_guid) {
      rawContent.in_reply_to = rawContent.thread_originator_guid;
    }

    // parties[]: outbound → ["user", handle.id]; inbound → [handle.id, "user"].
    // For group chats we just record both ends; the room is the cache_roomnames
    // string available in raw_content for richer reconstruction.
    //
    // F-T2-IMESSAGE-F7 — when the outbound row has no handle_id (Apple
    // stamps handle_id=0 for the operator's own writes), pollOnce supplied
    // a `chat_participants` list recovered from chat_handle_join. Widen
    // `parties` to ["user", ...participants] so audience metadata survives
    // for the salience layer's authorship + structural scorers.
    //
    // F-NEW-W2-IMESSAGE-PARTIES-REPAIRED-COUNTER — stamp a connector_marker
    // (raw_content.parties_source = "chat_handle_join") whenever the F7
    // lookup path executes for this row, regardless of whether the lookup
    // found participants. The marker lets the Stage-0 telemetry layer
    // distinguish three cases:
    //   1. F7 lookup ran AND found participants (parties.length >= 2)
    //        → reason="imessage_outbound_parties_repaired"  (success bucket)
    //   2. F7 lookup ran but found NO participants (parties == ["user"])
    //        → reason="imessage_outbound_parties_repaired_empty"
    //          (true zero-participant legacy chat — chat_handle_join row
    //          existed but was empty, or the chat carries no other handles)
    //   3. F7 lookup did NOT run (handle_id present, or non-outbound)
    //        → no F9 reason emitted
    // Stamping the marker even on the cache-miss branch (case 2) is what
    // makes the empty case observable; without it, Stage-0 cannot tell a
    // legitimate solo-outbound row (no F7 path) from a true legacy zero-
    // participant chat that DID hit the F7 path. The dbRow.chat_participants
    // signal is connector-internal scaffolding and is NOT persisted on the
    // ledger row, so raw_content.parties_source is the only post-hoc handle.
    let parties;
    let partiesSource = null;
    if (rawContent.is_from_me) {
      if (rawContent.handle_id != null) {
        parties = ["user", rawContent.handle_id];
      } else if (Array.isArray(dbRow.chat_participants) && dbRow.chat_participants.length > 0) {
        parties = ["user", ...dbRow.chat_participants];
        partiesSource = "chat_handle_join";
      } else {
        // F7 path took the cache-miss branch (legacy chat.db without
        // chat_handle_join, or chat had no other participants). We still
        // mark the connector_marker so Stage-0 can bucket this as the
        // empty-repair case.
        parties = ["user"];
        partiesSource = "chat_handle_join";
      }
    } else {
      parties = [rawContent.handle_id, "user"].filter((p) => p != null);
    }
    if (partiesSource != null) {
      rawContent.parties_source = partiesSource;
    }

    // Use message.date converted to ISO for the row's ts so the salience
    // layer sees authoring time, not ingest time. Fall back to server time
    // if the date is unparseable.
    const messageTs = macEpochNsToIso(dbRow.date) || this._serverTs();

    const row = {
      ts: messageTs,
      source_msg_id: typeof dbRow.guid === "string" && dbRow.guid !== ""
        ? dbRow.guid
        : `rowid:${dbRow.rowid}`,
      parties,
      raw_content: rawContent,
      attachments: [],
    };
    if (classified.kind) row.kind = classified.kind;
    if (classified.derived_from) row.derived_from = classified.derived_from;

    // F-CCS-CONNECTOR-imessage-structural — stamp connector-known structural
    // surfaces (handle_id → person, chat_guid → topic for groups, ts →
    // absolute time anchor) onto row.structured_features so the salience
    // cascade does not re-derive them from the message text. The helper
    // returns undefined on any structural violation; ConnectorBase's
    // "extra top-level keys copy-through" path carries the field verbatim
    // when present, and the consumer-side `sf?.entities ?? []`
    // short-circuit handles absence (rows missing structured_features
    // cascade unchanged via the text-only path, per foundation spec §7.1).
    let structuredFeatures;
    try {
      structuredFeatures = buildStructuredFeatures({
        raw_content: rawContent,
        ts: messageTs,
      });
    } catch {
      // Defensive degradation per W2-W12 discipline: a buildStructured
      // throw must NOT block the row from landing via the text-only path.
      structuredFeatures = undefined;
    }
    if (structuredFeatures !== undefined) {
      row.structured_features = structuredFeatures;
    }

    return row;
  }

  // runOnce — single poll loop. Returns aggregated stats.
  async runOnce(opts = {}) {
    const result = await this.pollOnce(opts);
    return { appended: result.appended, errors: result.errors };
  }

  // runForever — never resolves. Polls every IMESSAGE_POLL_INTERVAL_MS.
  // Used by the launchd entry point. Tests do NOT exercise this path
  // (would block indefinitely); they call runOnce.
  async runForever(opts = {}) {
    const interval = opts.intervalMs || IMESSAGE_POLL_INTERVAL_MS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.pollOnce(opts);
      } catch (err) {
        // Defensive: pollOnce should self-handle errors via tagError.
        try { await this.tagError("poll_unexpected_throw"); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

// ---------------------------------------------------------------------------
// CLI shim — launchd entry point + operator probes
// ---------------------------------------------------------------------------
// Direct-execution semantics: if this file is the script Node was invoked
// with, dispatch on argv[2]. We compare import.meta.url against the
// process.argv[1] file URL form per the documented Node idiom.

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const mode = process.argv[2];
  if (mode === "--check") {
    process.stdout.write("ok\n");
    process.exit(0);
  } else if (mode === "--once") {
    const c = new IMessageConnector({});
    c.runOnce().then((r) => {
      process.stdout.write(JSON.stringify(r) + "\n");
      process.exit(0);
    }).catch((err) => {
      process.stderr.write(`runOnce error: ${err?.stack || err}\n`);
      process.exit(1);
    });
  } else {
    const c = new IMessageConnector({});
    c.runForever().catch((err) => {
      process.stderr.write(`runForever error: ${err?.stack || err}\n`);
      process.exit(1);
    });
  }
}
