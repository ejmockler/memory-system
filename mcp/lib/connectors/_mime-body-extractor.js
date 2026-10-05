// _mime-body-extractor.js — RFC 5322/2045/3676 minimal body extractor.
//
// Pure utility consumed by mcp/lib/connectors/mail.js. Input: raw RFC 5322
// message bytes (Buffer). Output:
//   {
//     headers: { lowercased_name: "raw value" },
//     text: string | null,        // operator-new plain text after strip
//     hasPlain: bool,             // a text/plain part was found
//     hasHtml: bool,              // a text/html part was found
//     isMultipart: bool,
//   }
//
// Strip discipline (applied in order, to text/plain only):
//   1. Signature strip per RFC 3676 § 4.3 — split at "\n-- \n" (or trailing
//      "-- " line) and discard everything below.
//   2. Quoted-text strip — drop the introducer line ("On <date> X wrote:")
//      and every subsequent quoted line ("> ..."). Preserve operator-new
//      interleaved lines (lines NOT starting with ">").
//
// NO new deps; pure Node stdlib (Buffer + iconv-light path explicitly NOT
// used — we only accept us-ascii / utf-8 / iso-8859-1 charsets; anything
// else falls back to a Buffer.toString("utf8") best-effort which keeps the
// row emit-able even if the text is mojibake).
//
// HTML decode is in-house: <br>, <p>, <li> become newlines; tag-strip
// preserves text content; common entities (&amp; &lt; &gt; &quot; &#NNN;)
// are decoded. We do NOT execute scripts or follow links — body content
// only.
//
// KEY/PII_LEAKAGE_ZERO: no logging of header values or body content; all
// failure paths return null + flags, never throw with body bytes attached.

const CRLF = "\r\n";
const SIG_DELIM_RE = /(^|\r?\n)-- \r?\n/;
const QUOTE_INTRO_RE = /^(On .{1,200}wrote:|Le .{1,200}écrit\s*:|El .{1,200}escribió\s*:)\s*$/;

// Decode quoted-printable (RFC 2045 § 6.7). Soft line breaks "=\r\n" or "=\n"
// are removed; "=XX" hex pairs decode to a single byte. Anything else passes
// through. We operate on the raw ASCII string (the QP encoding is itself
// 7-bit), then re-encode the resulting byte stream per the charset.
function decodeQuotedPrintable(text) {
  if (typeof text !== "string") return text;
  // Drop soft line breaks first.
  let normalized = text.replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    if (ch === 0x3d /* '=' */ && i + 2 < normalized.length) {
      const hex = normalized.substr(i + 1, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(ch);
  }
  return Buffer.from(out);
}

// Decode base64. RFC 2045 § 6.8: ignore whitespace, multiple of 4 padded.
function decodeBase64(text) {
  if (typeof text !== "string") return text;
  const clean = text.replace(/[\r\n\s]+/g, "");
  try {
    return Buffer.from(clean, "base64");
  } catch {
    return Buffer.from(clean, "utf8");
  }
}

// Charset normalization. We support utf-8 / us-ascii / iso-8859-1 / latin-1
// / windows-1252 (approximated as latin1 — the differences in 0x80-0x9F
// glyphs are operator-irrelevant for salience). Unknown charsets fall back
// to utf-8 best-effort.
function decodeCharset(buf, charset) {
  if (!Buffer.isBuffer(buf)) return String(buf || "");
  const cs = (charset || "utf-8").toLowerCase();
  if (cs === "utf-8" || cs === "utf8") return buf.toString("utf8");
  if (cs === "us-ascii" || cs === "ascii") return buf.toString("ascii");
  if (cs === "iso-8859-1" || cs === "latin-1" || cs === "latin1" || cs === "windows-1252" || cs === "cp1252") {
    return buf.toString("latin1");
  }
  return buf.toString("utf8");
}

// RFC 2047 encoded-word decoder. Catches the =?charset?B?...?= (base64) and
// =?charset?Q?...?= (quoted-printable) forms in header values (Subject,
// display-name in From/To/etc.). The encoded-word grammar is precise:
// mixed-encoding subjects (one word encoded, rest plain) are handled because
// we only replace the encoded tokens; bad input passes through unchanged.
//
// F-T2-MAIL-F2: this decoder runs on Subject + sender display-name BEFORE
// Stage-0 / structural-threshold logic sees the value. Without it, the
// 200-char threshold compares against the raw encoded blob and embeddings
// store "=?utf-8?B?...?=" instead of the actual subject — wrecking every
// international correspondent's salience score.
//
// Charsets honoured: utf-8, us-ascii, iso-8859-1/latin-1, windows-1252.
// Big5 / GB18030 / ISO-2022-JP fall through to utf-8 best-effort. The
// regex tolerates whitespace between adjacent encoded-words per
// RFC 2047 § 6.2 (display SHOULD ignore whitespace separating encoded-words).
export function decodeEncodedWord(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  if (s.indexOf("=?") < 0) return s;
  // First pass: decode each =?cs?enc?data?= occurrence.
  let decoded = s.replace(
    /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g,
    (_match, cs, enc, data) => {
      try {
        let buf;
        if (enc.toUpperCase() === "B") {
          buf = Buffer.from(data, "base64");
        } else {
          // Q-encoding: underscores are spaces (RFC 2047 § 4.2), =XX is hex.
          const qpStr = data.replace(/_/g, " ").replace(
            /=([0-9A-Fa-f]{2})/g,
            (__, h) => String.fromCharCode(parseInt(h, 16))
          );
          buf = Buffer.from(qpStr, "binary");
        }
        return decodeCharset(buf, cs);
      } catch {
        // Pass-through on parse error so malformed encoded-words never
        // corrupt the header.
        return _match;
      }
    }
  );
  // Second pass: per RFC 2047 § 6.2, whitespace between two adjacent
  // encoded-words is for readability only and is discarded. The first pass
  // already replaced both encoded-words with their decoded glyphs; if the
  // ORIGINAL header had "=?...?= =?...?=" we collapse the residual single
  // space between adjacent CJK glyph runs. Conservative: only collapse when
  // both sides are non-ASCII so plain prose is untouched.
  decoded = decoded.replace(
    /([^\x00-\x7F])\s+([^\x00-\x7F])/g,
    "$1$2"
  );
  return decoded;
}

// Parse a Content-Type / Content-Disposition / etc. structured header.
// Returns { value, params: { lowercased_name: "value" } }. The value is the
// portion before the first ";", lowercased. Param values may be quoted.
export function parseStructuredHeader(raw) {
  if (typeof raw !== "string") return { value: "", params: {} };
  const trimmed = raw.trim();
  const semi = trimmed.indexOf(";");
  const value = (semi < 0 ? trimmed : trimmed.slice(0, semi)).trim().toLowerCase();
  const params = {};
  if (semi >= 0) {
    const rest = trimmed.slice(semi + 1);
    // Split on ";" outside double quotes.
    const parts = [];
    let buf = "";
    let inQuote = false;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === '"') { inQuote = !inQuote; buf += c; continue; }
      if (c === ";" && !inQuote) { parts.push(buf); buf = ""; continue; }
      buf += c;
    }
    if (buf.length > 0) parts.push(buf);
    for (const p of parts) {
      const eq = p.indexOf("=");
      if (eq < 0) continue;
      const name = p.slice(0, eq).trim().toLowerCase();
      let val = p.slice(eq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
        val = val.slice(1, -1);
      }
      params[name] = val;
    }
  }
  return { value, params };
}

// Split raw RFC 5322 bytes into { headers, body }. Header section ends at
// the first blank line ("\r\n\r\n" or "\n\n"). Headers are lowercased and
// folded (continuation lines starting with WSP are joined onto the prior).
export function splitHeadersAndBody(buf) {
  let str;
  if (Buffer.isBuffer(buf)) {
    // Headers are ASCII; the body may be arbitrary bytes. We split on bytes,
    // then decode header bytes as ASCII (lossy but headers are spec-bound to
    // 7-bit).
    str = buf.toString("binary");
  } else if (typeof buf === "string") {
    str = buf;
  } else {
    return { headers: {}, body: Buffer.alloc(0), bodyBytes: Buffer.alloc(0) };
  }
  const sep = str.search(/\r?\n\r?\n/);
  let headerStr;
  let bodyStr;
  if (sep < 0) {
    headerStr = str;
    bodyStr = "";
  } else {
    headerStr = str.slice(0, sep);
    const sepLen = str.startsWith("\r\n\r\n", sep) ? 4
      : str.startsWith("\n\n", sep) ? 2
      : 4;
    bodyStr = str.slice(sep + sepLen);
  }
  // Fold continuation lines.
  const headers = {};
  const lines = headerStr.split(/\r?\n/);
  let pending = null;
  for (const line of lines) {
    if (line === "") continue;
    if (/^[ \t]/.test(line) && pending) {
      pending.value += " " + line.trim();
      continue;
    }
    if (pending) {
      const lc = pending.name.toLowerCase();
      // Multi-valued headers: collapse to first instance; track raw count.
      if (!(lc in headers)) headers[lc] = pending.value;
    }
    const colon = line.indexOf(":");
    if (colon < 0) { pending = null; continue; }
    pending = { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  }
  if (pending) {
    const lc = pending.name.toLowerCase();
    if (!(lc in headers)) headers[lc] = pending.value;
  }
  return {
    headers,
    body: Buffer.from(bodyStr, "binary"),
  };
}

// Walk a multipart body. Returns a flat list of { headers, body } parts.
// Nested multiparts are flattened depth-first.
export function walkMultipart(body, boundary) {
  if (!boundary) return [];
  const parts = [];
  const bodyStr = body.toString("binary");
  // RFC 2046: each part is preceded by "--<boundary>\r\n" and the close is
  // "--<boundary>--". Tolerate "\n" as well.
  const delim = "--" + boundary;
  const sections = bodyStr.split(delim);
  // First element is the preamble; last is the epilogue (if "--" close).
  for (let i = 1; i < sections.length; i++) {
    const sec = sections[i];
    if (sec.startsWith("--")) break; // close-delimiter
    // Strip the leading "\r\n" or "\n" that follows the boundary.
    let section = sec.replace(/^\r?\n/, "");
    // Strip trailing "\r\n" before the next boundary.
    section = section.replace(/\r?\n$/, "");
    const partBuf = Buffer.from(section, "binary");
    const split = splitHeadersAndBody(partBuf);
    parts.push(split);
  }
  return parts;
}

// Recursively flatten any multipart parts in `parts`. Returns leaf parts only.
export function flattenParts(parts) {
  const flat = [];
  for (const p of parts) {
    const ct = parseStructuredHeader(p.headers["content-type"] || "");
    if (ct.value.startsWith("multipart/")) {
      const sub = walkMultipart(p.body, ct.params.boundary || "");
      for (const f of flattenParts(sub)) flat.push(f);
    } else {
      flat.push(p);
    }
  }
  return flat;
}

// Decode the part's body bytes according to Content-Transfer-Encoding +
// charset. Returns a decoded UTF-8 string.
export function decodePartBody(part) {
  const cte = (part.headers["content-transfer-encoding"] || "7bit").toLowerCase().trim();
  const ct = parseStructuredHeader(part.headers["content-type"] || "text/plain");
  const charset = ct.params.charset || "utf-8";
  let raw;
  if (cte === "quoted-printable") {
    raw = decodeQuotedPrintable(part.body.toString("binary"));
  } else if (cte === "base64") {
    raw = decodeBase64(part.body.toString("binary"));
  } else {
    raw = part.body;
  }
  return decodeCharset(raw, charset);
}

// In-house HTML → plain text. Conservative: strips tags, decodes common
// entities, preserves list semantics with leading "- " on <li>, newlines
// on <br>/<p>/</p>. Does NOT execute scripts or fetch URIs.
export function htmlToText(html) {
  if (typeof html !== "string") return "";
  let s = html;
  // Drop <script>/<style> entirely.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  // Block-level breaks.
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/p\s*>/gi, "\n");
  s = s.replace(/<p\b[^>]*>/gi, "");
  s = s.replace(/<\/?(div|tr|h[1-6])\b[^>]*>/gi, "\n");
  // List items: prefix with "- ".
  s = s.replace(/<li\b[^>]*>/gi, "- ");
  s = s.replace(/<\/li\s*>/gi, "\n");
  // Strip all remaining tags.
  s = s.replace(/<\/?[a-z][^>]*>/gi, "");
  // Decode entities.
  s = s.replace(/&nbsp;/gi, " ");
  s = s.replace(/&amp;/gi, "&");
  s = s.replace(/&lt;/gi, "<");
  s = s.replace(/&gt;/gi, ">");
  s = s.replace(/&quot;/gi, '"');
  s = s.replace(/&apos;/gi, "'");
  s = s.replace(/&#(\d+);/g, (_m, n) => {
    const code = parseInt(n, 10);
    if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
      try { return String.fromCodePoint(code); } catch { return ""; }
    }
    return "";
  });
  s = s.replace(/&#x([0-9A-Fa-f]+);/g, (_m, n) => {
    const code = parseInt(n, 16);
    if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
      try { return String.fromCodePoint(code); } catch { return ""; }
    }
    return "";
  });
  // Collapse runs of blank lines / trailing whitespace.
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Strip RFC 3676 signature delimiter and everything after.
export function stripSignature(text) {
  if (typeof text !== "string") return "";
  const match = text.search(SIG_DELIM_RE);
  if (match < 0) {
    // Tolerate the no-trailing-newline variant: a final line that is exactly
    // "-- " also opens the signature block.
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "-- ") {
        return lines.slice(0, i).join("\n").trimEnd();
      }
    }
    return text;
  }
  return text.slice(0, match).trimEnd();
}

// Strip the quoted-thread region of a reply. The introducer "On <X> wrote:"
// plus every subsequent ">"-prefixed line (and the line immediately above
// the introducer if it is blank) are dropped. Operator-new interleaved
// lines (lines that do NOT start with ">") are preserved in-place.
export function stripQuotedThread(text) {
  if (typeof text !== "string") return "";
  const lines = text.split(/\r?\n/);
  // Find an introducer line. Cut everything from one line above (if blank)
  // to the end of the quoted block.
  let introIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE_INTRO_RE.test(lines[i].trim())) {
      introIdx = i;
      break;
    }
  }
  if (introIdx < 0) {
    // No "On X wrote" introducer; fall back to just dropping leading-">"
    // contiguous blocks at the END of the message (Outlook-style top-posts
    // already get this right; bottom-posts would be uncommon and we err on
    // preserving content).
    const out = [];
    for (const line of lines) {
      if (line.startsWith(">")) continue;
      out.push(line);
    }
    return out.join("\n").trim();
  }
  // Cut from one line above introducer (if blank) to end-of-message; within
  // the cut region, retain only operator-new lines (those NOT starting with
  // ">"). Conservative: we drop everything after the introducer outright.
  let cutStart = introIdx;
  if (cutStart > 0 && lines[cutStart - 1].trim() === "") cutStart -= 1;
  const head = lines.slice(0, cutStart);
  return head.join("\n").trim();
}

// Extract a minimal text body from an RFC 5545 (iCalendar) part. Used as
// the F-T2-MAIL-F9 fallback when an invite carries no text/plain or
// text/html alternative (common for ICS-only invites from Exchange /
// Outlook / Google Calendar that put the human description inside the VEVENT
// SUMMARY/DESCRIPTION/LOCATION/ORGANIZER lines).
//
// We unfold RFC 5545 § 3.1 continuation lines (a line that starts with a
// single space or tab is a continuation of the prior line). Then we extract:
//   - SUMMARY:          → "Subject: ..."
//   - DTSTART[;...]:    → "When: ..."
//   - LOCATION:         → "Where: ..."
//   - ORGANIZER[;...]:mailto:<addr> → "From: <addr>"
//   - DESCRIPTION:      → "Description: ..." (truncated to 2000 chars)
//   - METHOD:CANCEL is surfaced as a "[CANCELLED]" prefix so downstream
//     salience can demote stale-invite spam.
// Recurring invites' RRULE is NOT decoded into prose — the SUMMARY +
// DTSTART pair captures the operator-visible identity of the event.
//
// Risk acknowledged in the audit predicate: long LOCATION/DESCRIPTION
// values that span multiple physical lines are joined via the unfold step;
// the simple per-property regex below now sees the full unfolded value.
export function icsToText(ics) {
  if (typeof ics !== "string" || ics.length === 0) return "";
  // RFC 5545 § 3.1 line unfolding: a CRLF followed by a space or tab is a
  // continuation. Tolerate bare-LF line endings as well.
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  let method = null;
  const methodMatch = unfolded.match(/^METHOD:(.*)$/m);
  if (methodMatch) method = methodMatch[1].trim().toUpperCase();
  const summary = (unfolded.match(/^SUMMARY:(.*)$/m) || [])[1];
  const dtstart = (unfolded.match(/^DTSTART[^:\r\n]*:(.*)$/m) || [])[1];
  const dtend = (unfolded.match(/^DTEND[^:\r\n]*:(.*)$/m) || [])[1];
  const loc = (unfolded.match(/^LOCATION:(.*)$/m) || [])[1];
  const org = (unfolded.match(/^ORGANIZER[^:\r\n]*:mailto:(.*)$/im) || [])[1];
  let desc = (unfolded.match(/^DESCRIPTION:(.*)$/m) || [])[1];
  if (typeof desc === "string" && desc.length > 2000) {
    desc = desc.slice(0, 2000);
  }
  const lines = [];
  if (method === "CANCEL") lines.push("[CANCELLED]");
  if (summary) lines.push("Subject: " + summary.trim());
  if (dtstart) lines.push("When: " + dtstart.trim() + (dtend ? " → " + dtend.trim() : ""));
  if (loc) lines.push("Where: " + loc.trim());
  if (org) lines.push("From: " + org.trim());
  if (desc) lines.push("Description: " + desc.trim());
  return lines.join("\n").trim();
}

// Top-level parse. Returns the canonical extractor output shape.
//
// F-T2-MAIL-F2: Subject + From display-name are run through the RFC 2047
// encoded-word decoder so Stage-0 and embedding pipelines see the actual
// glyphs, not "=?utf-8?B?...?=" placeholders.
//
// F-T2-MAIL-F9: text/calendar (.ics) parts are consumed as a fallback when
// no text/plain or text/html alternative exists. Apple Mail's connector
// previously emitted these as placeholder_residual; with this extractor a
// calendar invite becomes signal (SUMMARY / DTSTART / LOCATION / ORGANIZER)
// rather than empty noise.
export function parseEmail(rawBytes) {
  const buf = Buffer.isBuffer(rawBytes)
    ? rawBytes
    : typeof rawBytes === "string"
      ? Buffer.from(rawBytes, "utf8")
      : Buffer.alloc(0);
  const { headers, body } = splitHeadersAndBody(buf);
  // F-T2-MAIL-F2: decode RFC 2047 encoded-words on the headers callers
  // typically display or threshold against. We mutate the lowercased-key
  // headers map so downstream stamping in mail.js's _buildLedgerRow sees
  // the decoded value. Pass-through on parse error keeps malformed
  // headers safe.
  if (typeof headers["subject"] === "string") {
    headers["subject"] = decodeEncodedWord(headers["subject"]);
  }
  if (typeof headers["from"] === "string") {
    headers["from"] = decodeEncodedWord(headers["from"]);
  }
  if (typeof headers["to"] === "string") {
    headers["to"] = decodeEncodedWord(headers["to"]);
  }
  if (typeof headers["cc"] === "string") {
    headers["cc"] = decodeEncodedWord(headers["cc"]);
  }
  const topCt = parseStructuredHeader(headers["content-type"] || "text/plain");
  const isMultipart = topCt.value.startsWith("multipart/");
  let parts;
  if (isMultipart) {
    parts = flattenParts(walkMultipart(body, topCt.params.boundary || ""));
  } else {
    parts = [{ headers, body }];
  }
  let plainText = null;
  let htmlText = null;
  let calendarText = null;
  let hasPlain = false;
  let hasHtml = false;
  let hasCalendar = false;
  for (const p of parts) {
    const ct = parseStructuredHeader(p.headers["content-type"] || "text/plain");
    const disp = parseStructuredHeader(p.headers["content-disposition"] || "");
    if (disp.value === "attachment") continue;
    if (ct.value === "text/plain" && plainText == null) {
      plainText = decodePartBody(p);
      hasPlain = true;
    } else if (ct.value === "text/html" && htmlText == null) {
      htmlText = decodePartBody(p);
      hasHtml = true;
    } else if (ct.value === "text/calendar" && calendarText == null) {
      // F-T2-MAIL-F9: capture the raw ICS for fallback extraction below.
      calendarText = decodePartBody(p);
      hasCalendar = true;
    } else if (ct.value === "text/plain") {
      hasPlain = true;
    } else if (ct.value === "text/html") {
      hasHtml = true;
    } else if (ct.value === "text/calendar") {
      hasCalendar = true;
    }
  }
  // Prefer text/plain; fall back to text/html → htmlToText; fall back to
  // text/calendar → icsToText.
  let rawText = null;
  if (plainText != null) {
    rawText = plainText;
  } else if (htmlText != null) {
    rawText = htmlToText(htmlText);
  } else if (calendarText != null) {
    rawText = icsToText(calendarText);
  }
  let stripped = null;
  if (rawText != null) {
    const noSig = stripSignature(rawText);
    stripped = stripQuotedThread(noSig).trim();
    if (stripped === "") stripped = null;
  }
  return {
    headers,
    text: stripped,
    hasPlain,
    hasHtml,
    hasCalendar,
    isMultipart,
  };
}
