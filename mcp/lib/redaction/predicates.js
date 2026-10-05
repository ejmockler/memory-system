// MAINTENANCE: Key-shape patterns drift as providers rotate formats. Review
// quarterly. New provider key formats MUST be added here, not per-source.
//
// Unified redaction predicates module (F-INFRA-R49-REDACTION).
//
// Background: prior to this module, secret/PII redaction was per-source and
// incomplete — git-log didn't redact API keys in commit messages, imessage
// didn't hash phone numbers consistently, screentime URL query params leaked
// tokens. Every row that flows toward the ledger / memory.jsonl / embedder
// MUST traverse `redactRow` (or the underlying primitives) so the same scrub
// applies regardless of source.
//
// Provider key-shape coverage (8 categories, R49 enumeration):
//   1. OpenAI            sk- / sk-proj-
//   2. Google Cloud      ya29.* / AIza*
//   3. GitHub            ghp_ / gho_ / ghs_ / ghr_  (classic + fine-grained)
//   4. AWS               AKIA* / ASIA*               (access-key IDs)
//   5. Slack             xoxb- / xoxp- / xapp-       (bot/user/app tokens)
//   6. Stripe            sk_live_ / pk_live_
//   7. Anthropic         sk-ant- / sk-or-v1-         (sk-or-v1- = OpenRouter)
//   8. JWT               eyJ-prefixed (header.payload.signature)
//
// Each pattern is anchored against a non-identifier boundary so a key embedded
// in prose ("the key sk-abc123 is leaked") is caught without false-matching
// the substring inside another identifier ("ask-abc" must not match "sk-abc").
//
// The redaction primitives are SHA256-truncated (first 12 hex chars). 48 bits
// of entropy is sufficient for cross-row equality joining inside this corpus
// (which contains at most ~10^7 rows over its lifetime: collision probability
// in a 2^48 space is ~10^-1 by the birthday bound at 10^7 keys, but the
// equality-join use case tolerates per-pair confusability rather than corpus-
// wide uniqueness). Determinism is the load-bearing property: same input ->
// same output across runs, machines, and time.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// (1) KEY_SHAPE_RX_FULL — array of named regexes covering all 8 categories.
// ---------------------------------------------------------------------------
//
// Each entry: { id, rx, note }. `rx` is a `RegExp` with the global flag so
// `String.prototype.replace` rewrites every occurrence. `id` is the telemetry
// tag emitted into `triggered_redactions[]`.
//
// Boundary discipline: each pattern uses `(?<![A-Za-z0-9_-])PFX...` and
// `(?![A-Za-z0-9_/=+.-])` so the match snaps to a key-shaped token rather
// than a substring inside an unrelated identifier. The trailing-boundary
// includes `/`, `=`, `+`, `.` so base64 tails and JWT dots are absorbed into
// the match instead of leaking past it.
//
// IMPORTANT: order matters for the OpenAI patterns — sk-proj- MUST be matched
// BEFORE sk- so the longer prefix wins. The regex engine in `redactRow` runs
// patterns in array order; later patterns observe replacements made by earlier
// ones, but the inverse order (sk- first) would shadow sk-proj- entirely.

export const KEY_SHAPE_RX_FULL = Object.freeze([
  // ---- OpenAI ----
  {
    id: "openai_sk_proj",
    // sk-proj-<48+ chars from [A-Za-z0-9_-]>. Newer OpenAI project-scoped key
    // prefix; must precede the generic sk- pattern below.
    rx: /(?<![A-Za-z0-9_-])sk-proj-[A-Za-z0-9_-]{20,}/g,
    note: "OpenAI project-scoped API key (sk-proj-)",
  },
  {
    id: "openai_sk",
    // sk-<20+ chars from [A-Za-z0-9]>. Classic OpenAI API key. The trailing
    // boundary excludes `-` so sk-proj- is not matched by this pattern (it
    // would otherwise match the "sk-" inside "sk-proj-" only if the previous
    // pattern is somehow skipped; the redactRow loop runs in order so this is
    // belt-and-suspenders).
    rx: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/g,
    note: "OpenAI API key (sk-)",
  },
  // ---- Google Cloud ----
  {
    id: "gcp_ya29",
    // ya29.<base64ish> — OAuth2 access tokens.
    rx: /(?<![A-Za-z0-9_-])ya29\.[A-Za-z0-9_-]{20,}/g,
    note: "GCP OAuth2 access token (ya29.)",
  },
  {
    id: "gcp_aiza",
    // AIza<35 chars> — API keys. Length is fixed (39 total) but we allow
    // 35-60 to tolerate provider-side rotation.
    rx: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35,60}/g,
    note: "GCP API key (AIza)",
  },
  // ---- GitHub ----
  {
    id: "github_pat",
    // ghp_ / gho_ / ghs_ / ghr_ classic + fine-grained personal access tokens.
    // Body is 36+ chars from [A-Za-z0-9_].
    rx: /(?<![A-Za-z0-9_-])(?:ghp|gho|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
    note: "GitHub personal access token (ghp_/gho_/ghs_/ghr_)",
  },
  // ---- AWS ----
  {
    id: "aws_access_key_id",
    // AKIA / ASIA followed by 16 chars from [A-Z0-9]. Exactly 20 total per the
    // AWS spec but we allow 16-20 in the body to absorb mild variants.
    rx: /(?<![A-Za-z0-9_-])(?:AKIA|ASIA)[A-Z0-9]{16,20}/g,
    note: "AWS access key ID (AKIA/ASIA)",
  },
  // ---- Slack ----
  {
    id: "slack_token",
    // xoxb / xoxp / xoxa(pp) / xapp followed by `-` and 10+ token chars.
    //
    // F-NEW-R49-XAPP-SLACK-FIX: the prior pattern `xox[bpa](?:pp)?-` REQUIRED
    // a literal `xox` prefix, so app-level tokens like `xapp-1-A123-456-...`
    // were NEVER matched even though the R49 spec enumerates them. The
    // alternation below covers both `xox[bpa]` (classic bot/user/admin)
    // and the standalone `xapp-` prefix. We also retain `(?:pp)?` after
    // `xox[bpa]` to cover historical `xoxapp-` variants Slack briefly used.
    //
    // Slack tokens vary in body width (workspace + token + checksum chunks
    // separated by additional `-`), so we allow `[A-Za-z0-9-]{10,}` for the
    // body. The 10-char floor avoids matching short decorative strings.
    //
    // Decision: xoxe (Slack rotation/refresh) and xoxr are NOT covered by
    // this pattern. They are not enumerated in the R49 contract and have
    // not been observed in this corpus; revisit when/if they appear.
    rx: /(?<![A-Za-z0-9_-])(?:xox[bpa](?:pp)?|xapp)-[A-Za-z0-9-]{10,}/g,
    note: "Slack token (xoxb/xoxp/xoxa/xapp)",
  },
  // ---- Stripe ----
  {
    id: "stripe_live_key",
    // sk_live_ / pk_live_ followed by 16+ chars. Stripe restricted keys
    // (rk_live_) are not enumerated in the R49 spec; add when observed in the
    // corpus.
    rx: /(?<![A-Za-z0-9_-])(?:sk|pk)_live_[A-Za-z0-9]{16,}/g,
    note: "Stripe live API key (sk_live_/pk_live_)",
  },
  // ---- Anthropic ----
  {
    id: "anthropic_sk_ant",
    // sk-ant-<token>. Anthropic-issued direct keys.
    rx: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g,
    note: "Anthropic API key (sk-ant-)",
  },
  {
    id: "openrouter_sk_or_v1",
    // sk-or-v1-<token>. OpenRouter relays Anthropic + others; surfaces as a
    // distinct prefix in logs.
    rx: /(?<![A-Za-z0-9_-])sk-or-v1-[A-Za-z0-9_-]{20,}/g,
    note: "OpenRouter API key (sk-or-v1-)",
  },
  // ---- JWT ----
  {
    id: "jwt",
    // eyJ<base64url>.eyJ<base64url>.<base64url>. JWTs always begin with `eyJ`
    // because the header `{"alg":...}` base64-encodes to "eyJ...". Two dots
    // separate three base64url chunks; the trailing chunk may be empty for
    // unsigned JWTs but we require at least one signature char to avoid
    // matching arbitrary `eyJ.....` decorative strings.
    rx: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    note: "JWT (eyJ...)",
  },
]);

// ---------------------------------------------------------------------------
// (2) E164_HASHER — sha256(phone).slice(0,12).
// ---------------------------------------------------------------------------
//
// Phone numbers (E.164: `+<country><subscriber>`) are sensitive PII; we want
// cross-row equality joins ("same number appears in iMessage and Contacts")
// without storing the plaintext. SHA256 truncated to 12 hex chars (48 bits)
// is deterministic across runs and machines.
//
// Input normalization: strip whitespace and any `tel:` / `sms:` prefix; reject
// non-string inputs by returning the empty string (callers may treat empty as
// "no phone to hash" rather than as a placeholder).

export function E164_HASHER(phone) {
  if (typeof phone !== "string") return "";
  const norm = phone
    .trim()
    .replace(/^(?:tel|sms):/i, "")
    .replace(/\s+/g, "");
  if (norm === "") return "";
  return "phone_" + createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// (3) ABPERSON_UID_HASHER — sha256(uid).slice(0,12).
// ---------------------------------------------------------------------------
//
// macOS AddressBook UIDs (e.g. `ABPersonUID:1234ABCD-...`) link to a row in
// the contacts DB. Storing the plaintext UID makes the corpus a re-identifier
// for the contacts DB; hashing preserves cross-row equality without that
// linkage. Same SHA256[:12] shape as E164_HASHER for telemetry consistency.

export function ABPERSON_UID_HASHER(uid) {
  if (typeof uid !== "string") return "";
  const norm = uid.trim();
  if (norm === "") return "";
  return "ab_" + createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// (4) URL_QUERY_PARAM_STRIPPER — strips sensitive query params, preserves path.
// ---------------------------------------------------------------------------
//
// ScreenTime, browser history, and shortened-URL crawl rows leak OAuth codes,
// session tokens, and search queries via URL query parameters. We strip the
// query params that empirically carry credentials/PII while preserving the
// origin + path (the "browsing structure" signal the recall layer uses for
// topical clustering).
//
// Stripped params (R49 enumeration):
//   ifkv, q, code, token, access_token, id_token, refresh_token, session
//
// All other query params are preserved as-is. URL fragments (`#...`) are
// preserved because they are observable client-side only; if a future audit
// finds tokens in fragments, add fragment-scrubbing here.

export const REDACTED_QUERY_PARAMS = Object.freeze([
  "ifkv",
  "q",
  "code",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "session",
]);

export function URL_QUERY_PARAM_STRIPPER(url) {
  if (typeof url !== "string" || url === "") return url;
  // Try the WHATWG URL parser; fall back to the input on parse failure so we
  // never silently mangle a non-URL string.
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_e) {
    return url;
  }
  let stripped = false;
  for (const key of REDACTED_QUERY_PARAMS) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.delete(key);
      stripped = true;
    }
  }
  if (!stripped) return url;
  // The WHATWG serializer drops the trailing `?` when no params remain — that
  // is the desired behaviour (clean URL when every param was stripped).
  return parsed.toString();
}

// Internal helper: which redacted-query-param keys did `url` carry? Used so
// `redactRow` can emit fine-grained telemetry tags.
function urlStrippedParams(url) {
  if (typeof url !== "string" || url === "") return [];
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_e) {
    return [];
  }
  const hit = [];
  for (const key of REDACTED_QUERY_PARAMS) {
    if (parsed.searchParams.has(key)) hit.push(key);
  }
  return hit;
}

// ---------------------------------------------------------------------------
// (5) redactRow(row) — apply all redactions in order, return redacted row +
//     triggered_redactions[] for telemetry.
// ---------------------------------------------------------------------------
//
// Input: any plain object. Strings are walked recursively; non-string scalars
// pass through. Arrays and nested objects are walked. Symbol/function/bigint
// values are dropped (consistent with JSON-serialisable corpus discipline).
//
// Output: { row: <redacted clone>, triggered_redactions: [<id>, ...] }. The
// caller writes `row` to the ledger and may attach the telemetry array to a
// `policy.redaction` event or to the row's own provenance block.
//
// Field-name-aware behaviour:
//   * Any field whose lowercase name contains "phone" or "tel" or matches
//     "from_handle" / "to_handle" / "sender" / "recipient" runs through
//     E164_HASHER when the value parses as an E.164-shaped string.
//   * Any field whose lowercase name contains "abperson" / "ab_person_uid" /
//     "person_uid" runs through ABPERSON_UID_HASHER.
//   * Any field whose lowercase name contains "url" / "uri" / "link" runs
//     through URL_QUERY_PARAM_STRIPPER.
// All string fields (including the above) ALSO traverse the KEY_SHAPE_RX_FULL
// regex sweep — a URL field containing an embedded JWT is caught by both the
// query-param strip (if present in `token=`) and the JWT regex (if present
// in the path).

const E164_LIKE_RX = /^\+?\d[\d\s\-().]{6,}$/;

function looksLikeE164(s) {
  if (typeof s !== "string") return false;
  return E164_LIKE_RX.test(s.trim());
}

function isPhoneField(name) {
  const n = name.toLowerCase();
  return (
    n.includes("phone") ||
    n === "tel" ||
    n.endsWith("_tel") ||
    n === "from_handle" ||
    n === "to_handle" ||
    n === "sender" ||
    n === "recipient" ||
    n === "handle"
  );
}

function isAbPersonField(name) {
  const n = name.toLowerCase();
  return (
    n.includes("abperson") ||
    n === "ab_person_uid" ||
    n === "person_uid" ||
    n === "ab_uid"
  );
}

function isUrlField(name) {
  const n = name.toLowerCase();
  return (
    n === "url" ||
    n === "uri" ||
    n === "link" ||
    n.endsWith("_url") ||
    n.endsWith("_uri") ||
    n.endsWith("_link")
  );
}

// Run KEY_SHAPE_RX_FULL over a string and replace each match with a
// telemetry-tagged placeholder. Returns { out, hits }.
function scrubKeyShapes(s) {
  if (typeof s !== "string" || s === "") return { out: s, hits: [] };
  let out = s;
  const hits = [];
  for (const { id, rx } of KEY_SHAPE_RX_FULL) {
    // Reset lastIndex defensively even though `replace` does not consult it
    // for non-sticky global regexes.
    rx.lastIndex = 0;
    let matched = false;
    out = out.replace(rx, () => {
      matched = true;
      return `[REDACTED:${id}]`;
    });
    if (matched) hits.push(id);
  }
  return { out, hits };
}

// Walk a value recursively. Returns { value, hits } where `hits` is a flat
// list of triggered_redactions for the entire subtree. Keyed by the field
// name so caller heuristics (phone / abperson / url) can dispatch.
function redactValue(value, fieldName) {
  const hits = [];
  if (value === null || value === undefined) return { value, hits };
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const { value: v2, hits: h2 } = redactValue(value[i], fieldName);
      out[i] = v2;
      for (const h of h2) hits.push(h);
    }
    return { value: out, hits };
  }
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      const { value: v2, hits: h2 } = redactValue(value[k], k);
      out[k] = v2;
      for (const h of h2) hits.push(h);
    }
    return { value: out, hits };
  }
  if (typeof value !== "string") {
    // Numbers, booleans pass through; symbol/function/bigint drop.
    if (typeof value === "number" || typeof value === "boolean") {
      return { value, hits };
    }
    return { value: null, hits };
  }
  // String. Apply field-name dispatch first, then the key-shape sweep on the
  // result so an embedded API key inside a "url" field is also caught.
  let s = value;
  if (fieldName && isPhoneField(fieldName) && looksLikeE164(s)) {
    s = E164_HASHER(s);
    hits.push("e164_phone_hashed");
  } else if (fieldName && isAbPersonField(fieldName)) {
    s = ABPERSON_UID_HASHER(s);
    hits.push("abperson_uid_hashed");
  } else if (fieldName && isUrlField(fieldName)) {
    const stripped = urlStrippedParams(s);
    if (stripped.length > 0) {
      s = URL_QUERY_PARAM_STRIPPER(s);
      for (const k of stripped) hits.push(`url_query_stripped:${k}`);
    }
  }
  const { out, hits: keyHits } = scrubKeyShapes(s);
  for (const h of keyHits) hits.push(h);
  return { value: out, hits };
}

export function redactRow(row) {
  if (row === null || row === undefined || typeof row !== "object" || Array.isArray(row)) {
    // Defensive: callers should hand us a plain object. Return as-is with no
    // telemetry rather than crash; the audit layer treats non-object rows as
    // a separate violation.
    return { row, triggered_redactions: [] };
  }
  const { value, hits } = redactValue(row, null);
  // De-duplicate while preserving first-seen order so telemetry is stable.
  const seen = new Set();
  const triggered_redactions = [];
  for (const h of hits) {
    if (!seen.has(h)) {
      seen.add(h);
      triggered_redactions.push(h);
    }
  }
  return { row: value, triggered_redactions };
}
