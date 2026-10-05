// envelope.js — Wave-0 N1 FROZEN CONTRACT for the messaging attention hypergraph.
//
// This module defines the single, platform-agnostic "Envelope" shape that EVERY
// adapter (the per-platform connectors) emits and EVERY downstream layer (the
// addressing classifier, identity resolver, attention engine, catch-up surface)
// reads. It is a DERIVED, in-memory projection: adapters build envelopes at query
// time from retained source rows. This layer NEVER mutates or rewrites a source
// or fact row (Thesis #1) — it only defines a shape and validates instances of it.
//
// THE KEYSTONE: capabilities{}.
//   The abstraction invariant — "a new platform = ONE new adapter; layers 2..5
//   NEVER change" — only holds if every platform's degradation lives in DATA the
//   adapter stamps, not in `if (platform === "...")` branches inside the classifier
//   or attention engine. The adapter is the ONLY code that knows its platform's
//   limits; it encodes them once into capabilities{}, and every downstream layer
//   degrades by reading booleans. This validator therefore carries ZERO platform
//   names: it is agnostic by construction. (Mechanically gated: a grep for any
//   platform token over this file must return 0 matches.)
//
// validateEnvelope(env) is PURE and SYNCHRONOUS: it throws NOTHING, reads no DB,
// imports no adapter, and performs no dynamic import. It returns a flat result
// object { ok, errors: [{ field, reason }] }, mirroring the fail-closed,
// result-object discipline of the sibling lib/envelope.js (ok/error helpers).
// It collects ALL failures (not fail-fast) so fixtures get full diagnostics.

// ---------------------------------------------------------------------------
// Frozen vocabularies — the closed enums the contract is built on.
// ---------------------------------------------------------------------------

// The only legal conversation shapes. Exact match, no casing/whitespace variants.
//   dm      = one-to-one
//   group   = multi-party named/unnamed group
//   channel = broadcast channel (only some platforms can produce this)
export const THREAD_TYPES = Object.freeze(["dm", "group", "channel"]);

// The only legal sender KINDS (N11). An ADDITIVE, OPTIONAL field on sender:
//   person  = a human counterparty (the DEFAULT when `kind` is absent).
//   bot     = an automated bot account (e.g. a platform bot user).
//   service = a platform SERVICE account (login codes, notifications).
//   system  = a system/broadcast pseudo-sender (status feeds, broadcast lists).
// The adapter (L1) stamps this from platform signals; layers 2..5 EXCLUDE
// non-person by reading this DATA — never by branching on a platform name.
// `kind` is OPTIONAL for backward compatibility: an envelope without it is a
// valid `person` envelope, so the contract grows additively (N1 stays frozen
// for every previously-valid instance).
export const SENDER_KINDS = Object.freeze(["person", "bot", "service", "system"]);

// The default kind when an envelope omits sender.kind. Read by L2-5 consumers so
// the "is this a person?" test is total over old + new envelopes.
export const DEFAULT_SENDER_KIND = "person";

// The capabilities{} block — the keystone. EXACTLY these four keys must be present,
// each a strict boolean. An adapter that under-declares (omits a key) or
// over-declares (adds a 5th key) FAILS validation: the contract cannot silently
// grow a per-platform field, because that would be a hidden platform branch.
//   reply_to_available     — does the platform store a reply target at all?
//   structured_mentions    — are mentions structured (vs text-embedded @digits)?
//   self_identity_reliable — can we trust mention_me? (masked self-id => false)
//   addressing_first_class — is "addressed to me" explicit? (To/Cc => true)
export const CAPABILITY_KEYS = Object.freeze([
  "reply_to_available",
  "structured_mentions",
  "self_identity_reliable",
  "addressing_first_class",
]);

// directed_at_me_signals{} — the L2 INPUT surface. EXACTLY these three keys, each a
// strict boolean. These are BOOLEAN EVIDENCE, not scores; the classifier weights
// them by reading capabilities{}. EXACTLY these three keys must be present.
export const SIGNAL_KEYS = Object.freeze([
  "mention_me",
  "reply_to_me",
  "addressed_to_me",
]);

// ---------------------------------------------------------------------------
// Internal predicates (no platform knowledge; pure type/shape checks).
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function isStrictBoolean(v) {
  return v === true || v === false;
}

// ts contract: integer milliseconds since epoch, strictly > 0. This REJECTS
// floats, ISO-8601 strings (the literal shape a raw row carries), and numeric
// strings. Enforced here so a non-converting adapter is caught at the boundary,
// preventing the classic "string sorts lexically, breaks staleness downstream" bug.
function isIntegerMs(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

// Validate that `obj` has EXACTLY `keys` (no missing, no extra), each a strict
// boolean. Returns an array of {field, reason} (empty when valid). `prefix` names
// the parent block for diagnostics (e.g. "capabilities" / "directed_at_me_signals").
function validateExactBooleanBlock(obj, keys, prefix) {
  const errors = [];
  if (!isPlainObject(obj)) {
    errors.push({ field: prefix, reason: "missing-or-not-an-object" });
    return errors;
  }
  const present = Object.keys(obj);
  // Missing keys.
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) {
      errors.push({ field: `${prefix}.${k}`, reason: "missing-key" });
    } else if (!isStrictBoolean(obj[k])) {
      errors.push({ field: `${prefix}.${k}`, reason: "not-a-strict-boolean" });
    }
  }
  // Extra keys (strict shape — the contract cannot silently grow).
  for (const k of present) {
    if (!keys.includes(k)) {
      errors.push({ field: `${prefix}.${k}`, reason: "unexpected-key" });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// validateEnvelope — the single public validator.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EnvelopeMention
 * @property {string} id   - non-empty stable identifier of the mentioned party.
 * @property {string|null} name - display name, or null when unresolved.
 */

/**
 * @typedef {Object} EnvelopeSender
 * @property {string} id   - non-empty stable identifier; the literal "user" for self.
 * @property {string|null} name - display name, or null when unresolved.
 * @property {"person"|"bot"|"service"|"system"} [kind] - OPTIONAL sender kind
 *   (default "person"); the adapter stamps it from platform signals so L2-5 can
 *   exclude non-person senders by reading DATA, never a platform name.
 */

/**
 * @typedef {Object} DirectedAtMeSignals
 * @property {boolean} mention_me     - was the operator structurally mentioned?
 * @property {boolean} reply_to_me    - is this a reply to an operator message?
 * @property {boolean} addressed_to_me- is the operator a first-class addressee?
 */

/**
 * @typedef {Object} Capabilities
 * @property {boolean} reply_to_available
 * @property {boolean} structured_mentions
 * @property {boolean} self_identity_reliable
 * @property {boolean} addressing_first_class
 */

/**
 * @typedef {Object} Envelope
 * @property {string} platform     - non-empty platform id (e.g. a per-source slug).
 * @property {string} thread_id    - non-empty conversation key.
 * @property {"dm"|"group"|"channel"} thread_type
 * @property {EnvelopeSender} sender
 * @property {string[]} recipients - person-ref strings; may be empty.
 * @property {boolean} is_from_me
 * @property {number} ts           - integer ms since epoch, > 0 (NOT an ISO string).
 * @property {string|null} content - text, or null for media-only/placeholder rows.
 * @property {string|null} [reply_to_id] - present only when the platform stores a reply target.
 * @property {EnvelopeMention[]} mentions - structured mentions; may be empty.
 * @property {DirectedAtMeSignals} directed_at_me_signals
 * @property {Capabilities} capabilities  - THE KEYSTONE; degradation as data.
 * @property {string} source_msg_id - non-empty join key back to the raw source row.
 */

/**
 * Validate an Envelope instance against the frozen contract.
 *
 * Pure, synchronous, throws nothing, reads no DB, imports no adapter. Collects
 * ALL failures so callers (fixtures, the gate, adapter self-checks) get a full
 * diagnostic list rather than a single fail-fast reason.
 *
 * @param {*} env - a candidate envelope (any type; non-objects fail closed).
 * @returns {{ ok: boolean, errors: Array<{ field: string, reason: string }> }}
 */
export function validateEnvelope(env) {
  const errors = [];

  // Fail-closed root guard: anything that is not a plain object is rejected
  // wholesale, without throwing (mirrors the sibling envelope.js coercion ethos).
  if (!isPlainObject(env)) {
    return { ok: false, errors: [{ field: "<root>", reason: "not-an-object" }] };
  }

  // platform — non-empty string.
  if (!isNonEmptyString(env.platform)) {
    errors.push({ field: "platform", reason: "must-be-non-empty-string" });
  }

  // thread_id — non-empty string.
  if (!isNonEmptyString(env.thread_id)) {
    errors.push({ field: "thread_id", reason: "must-be-non-empty-string" });
  }

  // thread_type — exact enum membership (no casing/whitespace variants).
  if (!THREAD_TYPES.includes(env.thread_type)) {
    errors.push({ field: "thread_type", reason: "not-in-thread-type-enum" });
  }

  // sender — object with id (non-empty string) and name (string OR null).
  if (!isPlainObject(env.sender)) {
    errors.push({ field: "sender", reason: "missing-or-not-an-object" });
  } else {
    if (!isNonEmptyString(env.sender.id)) {
      errors.push({ field: "sender.id", reason: "must-be-non-empty-string" });
    }
    if (!(typeof env.sender.name === "string" || env.sender.name === null)) {
      errors.push({ field: "sender.name", reason: "must-be-string-or-null" });
    }
    // sender.kind — OPTIONAL (N11). Absent is legal (treated as "person"
    // downstream), keeping the contract backward-compatible. When PRESENT it
    // must be one of the closed SENDER_KINDS enum; an unknown kind rejects so a
    // typo cannot silently disable the non-person exclusion.
    if (Object.prototype.hasOwnProperty.call(env.sender, "kind")) {
      if (!SENDER_KINDS.includes(env.sender.kind)) {
        errors.push({ field: "sender.kind", reason: "if-present-must-be-in-sender-kind-enum" });
      }
    }
  }

  // recipients — array (empty allowed); each element a non-empty string.
  if (!Array.isArray(env.recipients)) {
    errors.push({ field: "recipients", reason: "must-be-array" });
  } else {
    env.recipients.forEach((r, i) => {
      if (!isNonEmptyString(r)) {
        errors.push({ field: `recipients[${i}]`, reason: "must-be-non-empty-string" });
      }
    });
  }

  // is_from_me — strict boolean (rejects 0/1 ints, "true", null).
  if (!isStrictBoolean(env.is_from_me)) {
    errors.push({ field: "is_from_me", reason: "must-be-strict-boolean" });
  }

  // ts — integer ms, > 0 (rejects floats, ISO strings, numeric strings).
  if (!isIntegerMs(env.ts)) {
    errors.push({ field: "ts", reason: "must-be-positive-integer-ms" });
  }

  // content — string OR null (null = media-only / placeholder row).
  if (!(typeof env.content === "string" || env.content === null)) {
    errors.push({ field: "content", reason: "must-be-string-or-null" });
  }

  // reply_to_id — OPTIONAL: absent is legal (some platforms never store a reply
  // target). When present it must be string or null; a wrong type is rejected.
  if (Object.prototype.hasOwnProperty.call(env, "reply_to_id")) {
    if (!(typeof env.reply_to_id === "string" || env.reply_to_id === null)) {
      errors.push({ field: "reply_to_id", reason: "if-present-must-be-string-or-null" });
    }
  }

  // mentions — array (empty allowed); each element {id: non-empty string, name: string|null}.
  if (!Array.isArray(env.mentions)) {
    errors.push({ field: "mentions", reason: "must-be-array" });
  } else {
    env.mentions.forEach((m, i) => {
      if (!isPlainObject(m)) {
        errors.push({ field: `mentions[${i}]`, reason: "must-be-an-object" });
        return;
      }
      if (!isNonEmptyString(m.id)) {
        errors.push({ field: `mentions[${i}].id`, reason: "must-be-non-empty-string" });
      }
      if (!(typeof m.name === "string" || m.name === null)) {
        errors.push({ field: `mentions[${i}].name`, reason: "must-be-string-or-null" });
      }
    });
  }

  // directed_at_me_signals — EXACTLY SIGNAL_KEYS, each a strict boolean.
  for (const e of validateExactBooleanBlock(
    env.directed_at_me_signals,
    SIGNAL_KEYS,
    "directed_at_me_signals",
  )) {
    errors.push(e);
  }

  // capabilities — THE KEYSTONE. EXACTLY CAPABILITY_KEYS, each a strict boolean.
  // Missing block, missing key, extra key, or non-boolean value all reject. An
  // adapter that forgets to declare its degradation cannot pass validation.
  for (const e of validateExactBooleanBlock(
    env.capabilities,
    CAPABILITY_KEYS,
    "capabilities",
  )) {
    errors.push(e);
  }

  // source_msg_id — non-empty string (join key back to the raw source row).
  if (!isNonEmptyString(env.source_msg_id)) {
    errors.push({ field: "source_msg_id", reason: "must-be-non-empty-string" });
  }

  return { ok: errors.length === 0, errors };
}
