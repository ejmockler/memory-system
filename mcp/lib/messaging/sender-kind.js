// lib/messaging/sender-kind.js — the SHARED, GENERIC structural sender-kind
// classifier (WORKUNIT P1). This is an L1-tier helper: it lives ALONGSIDE the
// adapters (each adapter imports it and combines its result with that platform's
// NATIVE signal), and it is deliberately NOT one of the four L2-5 sources the
// abstraction-invariant grep scans (classifier/identity/attention/catchup). The
// upper layers (L2-5) still learn NOTHING here — they only READ the sender.kind
// DATA the adapters stamp.
//
// PRINCIPLE (the whole point — NOT a denylist of specific domains):
//   A PERSON is an entity capable of a two-way human relationship.
//   A NON-PERSON is an automated / broadcast / role channel — a bot, a service,
//   a business/RBM surface, a system feed, an SMS shortcode, or a role address.
// We classify by STRUCTURAL signals that are TRUE ACROSS PLATFORMS (the shape of
// the handle / address itself), never by enumerating individual companies. The
// role-address local-part list below is a SHAPE primitive (the well-known set of
// non-personal mailbox roles defined by convention / RFC 2142), not a denylist of
// vendors: any address whose local-part IS one of these roles is structurally a
// role channel regardless of the domain in front of it.
//
// CONSERVATIVE BY CONSTRUCTION (high-precision exclusion): when NO structural
// signal fires, classifyStructural returns null and the CALLER defaults to
// "person". We NEVER drop a real human — person recall must stay ~1.0. A genuine
// >=7-digit phone number, an ordinary personal email, a named contact: all
// produce null here (no signal) and therefore stay "person".
//
// The kind vocabulary is the FROZEN envelope enum {person,bot,service,system}.
// There is no separate "business" kind: a business/RBM surface is an automated
// SERVICE channel, so it maps to "service" (the closest principled bucket in the
// closed enum). bot/system come from platform-native signals the adapters add on
// top of this shared structural pass (a bot flag; a broadcast/status feed).
//
// PURE: no I/O, no mutation, no throw on odd input. Same input => same output.

// ---------------------------------------------------------------------------
// Role-address local-parts (RFC 2142 + common no-reply / notification roles).
// A SHAPE primitive: the set of mailbox local-parts that denote a NON-PERSONAL
// role/automated channel. Matched case-insensitively against the email's
// local-part, tolerant of a "+tag" suffix and of dot/dash/underscore separators
// inside a compound role (e.g. "no-reply", "no_reply", "donotreply" all collapse
// to the canonical "noreply"). This is NOT a domain denylist — the domain is
// ignored; only the structural ROLE of the local-part matters.
// ---------------------------------------------------------------------------
const ROLE_LOCAL_PARTS = new Set([
  // Outbound-only automated senders.
  "noreply",
  "donotreply",
  "do-not-reply",
  "no-reply",
  // Notifications / alerts (broadcast role channels).
  "notification",
  "notifications",
  "notify",
  "alert",
  "alerts",
  "updates",
  "update",
  "news",
  "newsletter",
  "mailer",
  "mailer-daemon",
  "bounce",
  "bounces",
  "automailer",
  "auto",
  "system",
  "daemon",
  // RFC 2142 role mailboxes (org/role, not a person).
  "support",
  "help",
  "helpdesk",
  "info",
  "hello",
  "contact",
  "team",
  "sales",
  "billing",
  "accounts",
  "admin",
  "administrator",
  "webmaster",
  "postmaster",
  "hostmaster",
  "abuse",
  "security",
  "marketing",
  "careers",
  "jobs",
  "feedback",
  "service",
  "services",
  "membership",
  "orders",
  "order",
  "receipts",
  "invoice",
  "invoices",
]);

/**
 * isShortcode — STRUCTURAL: an SMS/RCS short code is a numeric handle of length
 * 3-6. A real phone number is >=7 digits (NANP local numbers are 7, full numbers
 * 10-11). So a purely-numeric handle with 3-6 significant digits is a shortcode
 * (a one-way A2P / marketing / 2FA channel), NOT a person.
 *
 * Tolerates an iMessage/SMS handle that arrives with a leading "+" or formatting
 * (we strip non-digits first). A handle that contains ANY non-phone character
 * other than the leading "+"/separators (e.g. an "@" -> it's an email, or
 * "urn:" -> it's a business surface) is NOT a shortcode (returns false) — those
 * are handled by the email/business classifiers, keeping each predicate single-
 * purpose.
 *
 * @param {string|null|undefined} handle
 * @returns {boolean}
 */
export function isShortcode(handle) {
  if (typeof handle !== "string") return false;
  const trimmed = handle.trim();
  if (trimmed.length === 0) return false;
  // An email or a urn surface is not a shortcode — defer to those classifiers.
  if (trimmed.includes("@")) return false;
  if (/^[a-z]+:/i.test(trimmed)) return false;
  // Strip phone formatting (spaces, dashes, parens, leading +). Anything LEFT
  // that is not a digit means this is not a bare numeric handle -> not a shortcode.
  const digits = trimmed.replace(/[\s()+\-.]/g, "");
  if (!/^\d+$/.test(digits)) return false;
  return digits.length >= 3 && digits.length <= 6;
}

/**
 * isBusinessHandle — STRUCTURAL: a verified-business / RBM (RCS Business
 * Messaging) surface. These are platform-issued business-channel identifiers, not
 * human handles:
 *   - "urn:biz:..."        — Apple Business Chat / Messages-for-Business URN.
 *   - "...@rbm.goog"       — Google RBM agent address.
 *   - "...@rcs..." / "rcs.*@..." / "...@bot.*" — RCS/agent business channels.
 * A two-way human relationship is impossible with these; they are automated
 * business SERVICE channels.
 *
 * Matched on STRUCTURE (the urn scheme / the agent-domain shape), never on a
 * specific brand. Case-insensitive.
 *
 * @param {string|null|undefined} handle
 * @returns {boolean}
 */
export function isBusinessHandle(handle) {
  if (typeof handle !== "string") return false;
  const h = handle.trim().toLowerCase();
  if (h.length === 0) return false;
  // Apple Business Chat / Messages-for-Business opaque business URN.
  if (h.startsWith("urn:biz") || h.startsWith("urn:business")) return true;
  // Google RBM agent address / RCS business-agent domains.
  if (h.endsWith("@rbm.goog") || h.includes("@rbm.")) return true;
  if (h.endsWith("@rcs.goog") || h.includes("@rcs.")) return true;
  // An RCS/agent business channel keyed by an "rcs"/"agent"/"bot" subdomain or
  // local-part marker (structural agent-domain shape, not a brand).
  if (/@(?:.*\.)?(?:rcs|rbm)\b/.test(h)) return true;
  return false;
}

/**
 * isRoleAddress — STRUCTURAL: an email whose LOCAL-PART is a well-known
 * non-personal ROLE (no-reply, support, notifications, billing, …). Domain-
 * agnostic by design: the role of the mailbox, not the company, is the signal.
 *
 * Normalizes the local-part: lowercases, drops a "+tag" suffix, and collapses
 * dot/dash/underscore separators so "no-reply", "no_reply", "no.reply" and
 * "donotreply" all match the canonical role set. A non-email input (no "@")
 * returns false.
 *
 * PREFIX/TAG-aware (the M6 extension, TIGHTENED by M6r): a role address often
 * arrives with a MACHINE-generated tag appended after a separator —
 * "support.zq4821@…", "notifications.batch789@…", "no-reply.tx12@…". These are
 * still ROLE mailboxes (the LEADING token is the role; the trailing token is a
 * per-message/per-ticket OPAQUE id). We classify them as roles WITHOUT misfiring
 * on (a) a normal personal "firstname.lastname@…" and (b) — the M6r review
 * reject — a "role-word.humanname@…" like "info.john@" or "team.smith@", which
 * is a PERSON who happens to share a first name with a role word. The trailing
 * TAG must look MACHINE-generated, not like a human name.
 *
 * The discriminator (CONSERVATIVE — when ambiguous, PERSON):
 *   - the leading SEPARATOR-delimited token run must collapse to a known role;
 *   - AND the remaining TAIL (everything after that leading role run) must look
 *     like an OPAQUE id — operationalized as "contains at least one DIGIT"
 *     (zq4821, batch789, tx12, inv001, x9, abc123). A purely-ALPHABETIC tail
 *     (john, smith, hand, mercial) is a plausible human name / word, so it stays
 *     PERSON.
 *
 * Crucially this matches only on TOKEN boundaries — "supportername@" (no
 * separator after "support") and "infomercial@" stay person, because their
 * leading token is the whole word, not the role.
 *
 * Examples (M6r):
 *   "support.zq4821@"      -> true  (digit tail => opaque machine id)
 *   "notifications.batch789@" -> true
 *   "no-reply.tx12@"       -> true  (compound role + digit tail)
 *   "info.john@"           -> FALSE (alpha tail "john" is a name => PERSON)
 *   "team.smith@"          -> FALSE (alpha tail "smith" is a name => PERSON)
 *   "support.team@"        -> FALSE (alpha tail, ambiguous => PERSON)
 *   "firstname.lastname@"  -> FALSE (leading run is not a role)
 *
 * @param {string|null|undefined} email
 * @returns {boolean}
 */
export function isRoleAddress(email) {
  if (typeof email !== "string") return false;
  const at = email.indexOf("@");
  if (at <= 0) return false; // no local-part, or no "@"
  let local = email.slice(0, at).trim().toLowerCase();
  if (local.length === 0) return false;
  // Drop a "+tag" subaddress suffix (support+ticket123@… is still "support").
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  // Exact role match first (covers "do-not-reply", "mailer-daemon", "no-reply").
  if (ROLE_LOCAL_PARTS.has(local)) return true;
  // Collapse separators and retry (no-reply -> noreply, no_reply -> noreply).
  const collapsed = local.replace(/[._-]/g, "");
  if (ROLE_LOCAL_PARTS.has(collapsed)) return true;
  // PREFIX/TAG-aware match (M6r-TIGHTENED): split on the separator set into
  // tokens and test whether a LEADING run of tokens forms a role FOLLOWED BY a
  // tail that looks MACHINE-generated (contains a digit), never a human name.
  //   "support.zq4821"   -> ["support","zq4821"]      role + "zq4821" (digit) => role
  //   "no-reply.tx12"    -> ["no","reply","tx12"]     role + "tx12"  (digit) => role
  //   "do_not_reply.x9"  -> ["do","not","reply","x9"] role + "x9"    (digit) => role
  //   "info.john"        -> ["info","john"]           role + "john"  (alpha) => PERSON
  //   "team.smith"       -> ["team","smith"]          role + "smith" (alpha) => PERSON
  // CONSERVATIVE: a naked "support" (no tail) is handled above; a normal
  // "firstname.lastname" never collapses its leading token(s) to a role, so it
  // stays person. We require a REMAINING tail (so a role word is never matched as
  // the WHOLE local-part here — that path is the exact/collapsed check above) AND
  // that the tail carry a digit. When the tail is pure-alpha (ambiguous between a
  // tag and a name) we default to PERSON — never hard-drop a human.
  const tokens = local.split(/[._-]/).filter((t) => t.length > 0);
  if (tokens.length >= 2) {
    // Try progressively longer leading runs (role words may themselves contain
    // separators, e.g. "no-reply" -> tokens ["no","reply"]). Stop before the
    // last token so there is always a real trailing tail.
    let leading = "";
    for (let i = 0; i < tokens.length - 1; i += 1) {
      leading += tokens[i];
      if (ROLE_LOCAL_PARTS.has(leading)) {
        // The TAIL is every remaining token after this leading role run.
        const tail = tokens.slice(i + 1).join("");
        // Only an OPAQUE (digit-bearing) tail is a machine tag. A pure-alpha
        // tail could be a human name => stay PERSON (the M6r reject fix).
        if (/[0-9]/.test(tail)) return true;
        // Leading run IS a role but the tail looks like a name -> ambiguous ->
        // PERSON. Keep scanning longer leading runs in case a LATER, longer run
        // is also a role with a different (digit) tail; none of the role words
        // here are prefixes of one another with a digit tail, so this loop simply
        // exhausts and falls through to the conservative `false` below.
      }
    }
  }
  return false;
}

/**
 * classifyStructural — the single GENERIC entry point an adapter calls. Given a
 * handle and/or email and/or a free id, return the NON-PERSON kind a STRUCTURAL
 * signal proves, or null when NO structural signal fires (the caller then defaults
 * to "person" — the conservative, high-recall behavior).
 *
 * Precedence (most specific structural surface first):
 *   1. business/RBM surface (urn:biz / @rbm.goog / rcs agent)  -> "service"
 *   2. role address (email local-part is a role mailbox)       -> "service"
 *   3. SMS/RCS shortcode (numeric handle, 3-6 digits)          -> "service"
 *   else                                                        -> null (=> person)
 *
 * All three structural non-person surfaces are AUTOMATED/role channels, so they
 * map to the single principled enum bucket "service". (A platform-native bot flag
 * or a broadcast/status feed -> "bot"/"system" is added by the adapter ON TOP of
 * this shared result; this helper only owns the cross-platform STRUCTURAL signals.)
 *
 * Inputs are all optional and order-independent; an adapter passes whatever it
 * has on the row. `handle` and `id` are checked against the shortcode/business
 * predicates; `email` (and a handle/id that LOOKS like an email) is checked
 * against the role-address and business predicates.
 *
 * @param {{id?: string|null, email?: string|null, handle?: string|null}} [input]
 * @returns {"service"|null}
 */
export function classifyStructural(input) {
  if (input == null || typeof input !== "object") return null;
  const handle = typeof input.handle === "string" ? input.handle : null;
  const id = typeof input.id === "string" ? input.id : null;
  const email = typeof input.email === "string" ? input.email : null;

  // An email may be passed explicitly OR ride in on handle/id (an iMessage handle
  // can be an email address). Gather every email-shaped candidate.
  const candidates = [handle, id, email].filter(
    (v) => typeof v === "string" && v.length > 0,
  );

  // 1. Business / RBM surface — any candidate that is structurally a business id.
  for (const c of candidates) {
    if (isBusinessHandle(c)) return "service";
  }
  // 2. Role address — any candidate that is an email with a role local-part.
  for (const c of candidates) {
    if (isRoleAddress(c)) return "service";
  }
  // 3. Shortcode — any candidate that is a bare numeric 3-6 digit handle.
  for (const c of candidates) {
    if (isShortcode(c)) return "service";
  }
  // No structural signal -> caller defaults to "person" (conservative).
  return null;
}

export default classifyStructural;
