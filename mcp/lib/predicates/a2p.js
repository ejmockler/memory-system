// a2p.js
//
// Shared A2P / OTP / regulatory-footer predicates.
//
// Background (R44 / F-INFRA-R44-A2P-PREDICATES):
//   Per-source A2P/OTP detection had drifted because each connector
//   (imessage stage-0, screentime stage-0, future SMS-adjacent sources)
//   reinvented shortcode detection, OTP regex, and regulatory-footer
//   matching. This module is the single source of truth so all sources
//   share the same detection logic.
//
//   Critic-modified contract (per node critic_modifications): the
//   classifier must NOT collapse to a binary DROP. It must expose
//   {match, confidence, suggested_action, triggers} so the caller (the
//   per-source Stage-0 rule) decides whether to REDACT_DROP (high
//   confidence) or REDACT-and-PASS (ambiguous, likely an operator
//   talking ABOUT an OTP rather than a real A2P delivery).
//
//   Confidence bands:
//     high   - shortcode sender + OTP regex + regulatory footer all
//              triggered. Treat as real A2P delivery. suggested_action
//              = "REDACT_DROP".
//     medium - shortcode sender + OTP regex (no footer). Likely real
//              A2P but missing the footer signal. suggested_action =
//              "REDACT_DROP" (still high enough to drop), but callers
//              MAY downgrade to REDACT_PASS if they want footer-required
//              policy (IMESSAGE-F2 chooses this).
//     low    - OTP regex matched but sender is full E.164 (or unknown).
//              Likely an operator/developer conversation ABOUT OTPs
//              ("the OTP flow is broken, can you check the passcode
//              logic"). suggested_action = "REDACT_PASS" so the
//              redacted text still flows through the cascade.
//     none   - no OTP match. suggested_action = "PASS".
//
// ES module. No external dependencies. Pure predicates: safe to require
// from Stage-0 rules, salience scoring, or operator audit tools.

// ---------------------------------------------------------------------------
// (1) isShortcodeSender(handle)
// ---------------------------------------------------------------------------
//
// True iff `handle` is a 3-6 digit numeric string (a North American SMS
// short code or comparable carrier short number). Explicit false for:
//   - full E.164 numbers ('+15555550123')
//   - empty / non-string handles
//   - handles containing any non-digit (letters, '+', '-', spaces, urn:)
//   - numbers shorter than 3 digits or longer than 6 digits
//
// The intent is: only short, plain numeric senders qualify as
// "shortcode" for A2P confidence boosting. Anything with a leading '+'
// is treated as a regular phone number, even if the local portion is
// short.
const SHORTCODE_RE = /^[0-9]{3,6}$/;

export function isShortcodeSender(handle) {
  if (typeof handle !== "string") return false;
  if (handle.length === 0) return false;
  // Any '+' anywhere disqualifies — that's a phone number.
  if (handle.includes("+")) return false;
  return SHORTCODE_RE.test(handle);
}

// ---------------------------------------------------------------------------
// (2) hasRegulatoryFooter(text)
// ---------------------------------------------------------------------------
//
// True iff `text` contains one of the canonical US carrier compliance
// footers required by CTIA / TCPA for A2P traffic:
//   - "Reply STOP"     (opt-out instruction)
//   - "STOP to opt out" / "STOP to opt-out"
//   - "Msg&Data rates may apply" / "Msg & Data rates may apply"
//   - "Message and data rates may apply" (long form)
//   - "Text HELP for help" / "Reply HELP for help"
//
// Case-insensitive. Whitespace is normalised loosely (each pattern
// allows the ampersand or "and" form). These footers are STRONG signals
// of legitimate A2P traffic — operator conversations about OTPs almost
// never include them.
const FOOTER_PATTERNS = [
  /reply\s+stop/i,
  /stop\s+to\s+opt[-\s]?out/i,
  /msg\s*&\s*data\s+rates\s+may\s+apply/i,
  /message\s+and\s+data\s+rates\s+may\s+apply/i,
  /text\s+help\s+for\s+help/i,
  /reply\s+help\s+for\s+help/i,
];

export function hasRegulatoryFooter(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  for (const re of FOOTER_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// (3) MODERN_OTP_REGEX
// ---------------------------------------------------------------------------
//
// Single regex covering the seven issuer patterns named in the node spec
// plus the generic OTP families. Case-insensitive (caller wraps with /i
// or constructs `new RegExp(MODERN_OTP_REGEX, "i")`).
//
// Patterns covered:
//   PayPal     - "PayPal: <N> is your security code", "Your PayPal code is <N>"
//   Schwab     - "Schwab: <N> is your authentication code",
//                "Your Schwab verification code is <N>"
//   Facebook   - "<#> <N> is your Facebook confirmation code"
//                (the "<#>" prefix is Facebook's app-hash convention)
//   Capital One- "Capital One: Your verification code is <N>"
//   Apple      - "Your Apple ID Code is: <N>", "Apple ID code: <N>"
//   Stripe     - "Stripe: Your verification code is <N>"
//   Anthropic  - "Your Anthropic verification code is: <N>"
//   Generic    - "<N> is your code"
//              - "use code <N>"
//              - "passcode is <N>", "passcode: <N>"
//              - "OTP: <N>", "OTP is <N>", "your OTP is <N>"
//              - "Authentication Code: <N>", "Authentication code is <N>"
//              - "verification code is <N>", "verification code: <N>"
//              - "security code is <N>", "security code: <N>"
//
// Code value: 4-10 alphanumeric characters (most OTPs are 4-8 digits,
// some issuers use alphanumeric, allow up to 10 for safety margin).
//
// The regex is exported as a SOURCE STRING so callers can construct
// `new RegExp(MODERN_OTP_REGEX, "i")` per the existing pattern in
// stage0/imessage.js (which reads CAPS.SALIENCE_OTP_REGEX the same way).
// The exported `modernOtpRegex()` helper returns a fresh compiled
// case-insensitive instance for convenience.

// Code token: 4-10 digits, or 4-10 alphanumerics containing at least
// one digit. Pure-letter "codes" are too noisy ("CODE", "HELP" etc).
// Two alternatives keep the regex simple under /i.
const CODE_TOKEN = "(?:[0-9]{4,10}|[A-Z0-9]{0,9}[0-9][A-Z0-9]{0,9})";

// FILLER: short stretch of "non-code" characters between an issuer
// keyword and the code itself. Allowed: whitespace, punctuation, and
// short connector words ("is", "your", "code", "the", "a", "to", "for",
// numerics already inside a longer token are caught by the boundary).
// We use a length-bounded `.{0,60}?` so the regex stays cheap; the
// lazy quantifier means we lock onto the EARLIEST code token.
const FILLER = ".{0,60}?";

const OTP_PATTERN_PARTS = [
  // Issuer-prefixed patterns. Issuer keyword followed by some short
  // filler, then a code token. The lazy `.{0,60}?` filler tolerates
  // "is", "your", "code", and punctuation between issuer and code
  // without needing to enumerate them.
  `paypal${FILLER}\\b${CODE_TOKEN}\\b`,
  `schwab${FILLER}\\b${CODE_TOKEN}\\b`,
  // Facebook "<#>" app-hash prefix is the strongest issuer signal.
  `<#>${FILLER}\\b${CODE_TOKEN}\\b`,
  `facebook${FILLER}\\b${CODE_TOKEN}\\b`,
  `capital\\s*one${FILLER}\\b${CODE_TOKEN}\\b`,
  `apple(?:\\s+id)?${FILLER}\\b${CODE_TOKEN}\\b`,
  `stripe${FILLER}\\b${CODE_TOKEN}\\b`,
  `anthropic${FILLER}\\b${CODE_TOKEN}\\b`,
  // Generic "<N> is your code" / "<N> is your <X> code".
  `\\b${CODE_TOKEN}\\s+is\\s+your\\s+(?:[A-Za-z]+\\s+){0,3}?code\\b`,
  // Generic "use code <N>".
  `\\buse\\s+code[:\\s]+${CODE_TOKEN}\\b`,
  // Generic "passcode is <N>" / "passcode: <N>".
  `\\bpasscode(?:\\s+is|\\s*:)\\s*${CODE_TOKEN}\\b`,
  // Generic OTP family.
  `\\b(?:your\\s+)?otp(?:\\s+is|\\s*:)\\s*${CODE_TOKEN}\\b`,
  // Generic "Authentication Code: <N>" / "Authentication code is <N>".
  `\\bauthentication\\s+code(?:\\s+is|\\s*:)\\s*${CODE_TOKEN}\\b`,
  // Generic "verification code is <N>" / "verification code: <N>".
  `\\bverification\\s+code(?:\\s+is|\\s*:)\\s*${CODE_TOKEN}\\b`,
  // Generic "security code is <N>" / "security code: <N>".
  `\\bsecurity\\s+code(?:\\s+is|\\s*:)\\s*${CODE_TOKEN}\\b`,
  // Generic "confirmation code is <N>" / "confirmation code: <N>".
  `\\bconfirmation\\s+code(?:\\s+is|\\s*:)\\s*${CODE_TOKEN}\\b`,
];

export const MODERN_OTP_REGEX = `(?:${OTP_PATTERN_PARTS.join("|")})`;

export function modernOtpRegex() {
  return new RegExp(MODERN_OTP_REGEX, "i");
}

// ---------------------------------------------------------------------------
// (4) classifyA2P(row)
// ---------------------------------------------------------------------------
//
// Classifies a row for A2P / OTP suspicion and returns a structured
// verdict the caller uses to choose between REDACT_DROP, REDACT_PASS,
// and PASS.
//
// Input shape (the union of fields the SMS-adjacent connectors emit):
//   {
//     handle?:        string  // sender id (preferred)
//     handle_id?:     string  // alias used by imessage source rows
//     sender?:        string  // alias used by some screentime rows
//     text?:          string  // body
//     raw_content?:   { handle_id?, sender?, text?, body? }
//                              // imessage source-row envelope
//   }
//
// Output:
//   {
//     match: bool,                            // OTP regex matched at all?
//     confidence: 'high' | 'medium' | 'low' | 'none',
//     suggested_action: 'REDACT_DROP' | 'REDACT_PASS' | 'PASS',
//     triggers: string[]                      // which signals fired
//   }
//
// Decision table:
//   shortcode + OTP + footer  -> high   / REDACT_DROP
//   shortcode + OTP           -> medium / REDACT_DROP
//   non-shortcode + OTP       -> low    / REDACT_PASS
//   no OTP                    -> none   / PASS
//
// Footer-without-OTP is treated as none (a marketing message with the
// compliance footer but no code is not an OTP — the caller's marketing
// policy handles that elsewhere).

function _pickHandle(row) {
  if (!row || typeof row !== "object") return "";
  if (typeof row.handle === "string" && row.handle.length > 0) return row.handle;
  if (typeof row.handle_id === "string" && row.handle_id.length > 0) return row.handle_id;
  if (typeof row.sender === "string" && row.sender.length > 0) return row.sender;
  const rc = row.raw_content;
  if (rc && typeof rc === "object") {
    if (typeof rc.handle_id === "string" && rc.handle_id.length > 0) return rc.handle_id;
    if (typeof rc.sender === "string" && rc.sender.length > 0) return rc.sender;
  }
  return "";
}

function _pickText(row) {
  if (!row || typeof row !== "object") return "";
  if (typeof row.text === "string" && row.text.length > 0) return row.text;
  const rc = row.raw_content;
  if (rc && typeof rc === "object") {
    if (typeof rc.text === "string" && rc.text.length > 0) return rc.text;
    if (typeof rc.body === "string" && rc.body.length > 0) return rc.body;
  }
  return "";
}

export function classifyA2P(row) {
  const triggers = [];
  const handle = _pickHandle(row);
  const text = _pickText(row);

  const shortcode = isShortcodeSender(handle);
  if (shortcode) triggers.push("shortcode_sender");

  const otpRe = modernOtpRegex();
  const otpMatch = text.length > 0 && otpRe.test(text);
  if (otpMatch) triggers.push("otp_regex");

  const footer = hasRegulatoryFooter(text);
  if (footer) triggers.push("regulatory_footer");

  // No OTP regex hit → not an A2P/OTP row at all. PASS.
  if (!otpMatch) {
    return {
      match: false,
      confidence: "none",
      suggested_action: "PASS",
      triggers,
    };
  }

  // OTP regex matched. Decide confidence band.
  if (shortcode && footer) {
    return {
      match: true,
      confidence: "high",
      suggested_action: "REDACT_DROP",
      triggers,
    };
  }
  if (shortcode) {
    return {
      match: true,
      confidence: "medium",
      suggested_action: "REDACT_DROP",
      triggers,
    };
  }
  // OTP regex on a non-shortcode sender (full E.164, empty handle, or
  // anything else). Most likely an operator/developer conversation ABOUT
  // an OTP rather than a real delivery. Caller should redact the code
  // and PASS the row through so the cascade still sees the conversation.
  return {
    match: true,
    confidence: "low",
    suggested_action: "REDACT_PASS",
    triggers,
  };
}
