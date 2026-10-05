// Mail connector — read-only poll of Apple Mail's Envelope Index + per-message
// .emlx body files.
//
// OPERATOR IDENTITY NOTE (R42, WU-mail-consumer):
//   Operator identity comes from the per-host operator-identity config file
//   read by mcp/lib/identity/operator-identity.js (see R42
//   F-INFRA-R42-IDENTITY); bot-actor detection lives in
//   mcp/lib/identity/bot-actors.js. This connector ships no addresses and
//   reads no identity file of its own by default.
//
//   A caller MAY still inject an extra alias map by passing an explicit
//   `identityMapPath` (a JSON file shaped {canonical, aliases[]}); its
//   aliases are UNIONED with isOperator(). With no path given the injected
//   map is empty and isOperator() alone decides.
//
//   Identity is wired here so the connector resolves the operator the same
//   way as every other connector as soon as its launchd service is enabled.
//
// R39 Phase 3 connector. Reads ~/Library/Mail/V<N>/MailData/Envelope Index
// (SQLite) and for each new message reads the per-account .emlx body file at
//   ~/Library/Mail/V<N>/<account-uuid>/<mbox>.mbox/<UUID>/Data/<sharded>/Messages/<ROWID>[.partial].emlx
// (basenames are the messages.ROWID — see the ground-truth note at
// defaultBodyResolver) then runs the body through _mime-body-extractor.js.
// Idempotent on source_msg_id (TEXT document_id passthrough, `rowid:<n>`
// fallback otherwise). Cursor is the max messages.ROWID seen so far.
//
// FDA REQUIRED. The connector reads from a TCC-protected location
// (~/Library/Mail/). Operator grants Full Disk Access to the node binary the
// launchd service runs (the pinned node binary named in the rendered plist;
// see launchd/README.md) via System Settings → Privacy & Security → Full Disk
// Access. One grant on that node binary covers Mail + Messages + WhatsApp.
//
// Strategy choice (per R39 Phase A inventory):
//   - Apple Mail SQLite over IMAP: operator uses Mail.app, no extra
//     credentials, push-aware via Mail's own sync, single TCC grant.
//
// Authoritative spec:
//   - kb/connectors-phase3.md § mail_row_shape (the canonical-block contract)
//   - kb/ingestion.md § Connector contract (six-point obligations)
//
// Composition: extends ConnectorBase (lib/connectors/index.js). The base
// owns cursor, idempotent append, source_policy stamping, checksum, health.
// This module owns Envelope-Index read + V-resolution + .emlx body read +
// MIME extraction + identity-based consent classification.
//
// HERMETICITY: this module reads from envelopeIndexPath (default resolved
// from ~/Library/Mail/V<N>/MailData/Envelope Index — V resolver picks the
// highest-numbered V dir present). Tests pass opts.envelopeIndexPath +
// opts.mailRoot to a synthetic SQLite + on-disk .emlx tree under
// mkdtempSync. The default production path is never read by tests.
//
// CLI shim:
//   node mail.js --check  → prints "ok" exits 0 (process-up health probe)
//   node mail.js --once   → runs runOnce(), prints JSON result, exits
//   node mail.js          → runForever() (launchd entry point)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConnectorBase } from "./index.js";
import { CAPS } from "../validation.js";
import { parseEmail } from "./_mime-body-extractor.js";
// R42: canonical operator-identity + bot-actor modules. See the migration
// note at the top of this file for the union-semantics rollout plan.
import { isOperator } from "../identity/operator-identity.js";
import { isBotActor } from "../identity/bot-actors.js";

const MAIL_POLL_INTERVAL_MS = 300000; // 5 min — see CAPS.MAIL_POLL_INTERVAL_SECONDS

// Apple Mail's V<N> path. <N> rolls forward across major Mail.app versions
// (V8 on Big Sur+, V10 on Ventura/Sonoma, etc.). Resolver picks the highest
// numbered V<N> dir whose MailData/Envelope Index exists.
function resolveMailRoot() {
  const home = homedir();
  const mailDir = join(home, "Library", "Mail");
  if (!existsSync(mailDir)) return null;
  let entries;
  try { entries = readdirSync(mailDir); } catch { return null; }
  const versions = entries
    .filter((n) => /^V(\d+)$/.test(n))
    .map((n) => ({ name: n, v: parseInt(n.slice(1), 10) }))
    .sort((a, b) => b.v - a.v);
  for (const v of versions) {
    const candidate = join(mailDir, v.name, "MailData", "Envelope Index");
    if (existsSync(candidate)) return { vDir: join(mailDir, v.name), envelopeIndex: candidate };
  }
  return null;
}

function defaultEnvelopeIndexPath() {
  const r = resolveMailRoot();
  return r ? r.envelopeIndex : join(homedir(), "Library", "Mail", "V10", "MailData", "Envelope Index");
}

function defaultMailRoot() {
  const r = resolveMailRoot();
  return r ? r.vDir : join(homedir(), "Library", "Mail", "V10");
}

// Apple's date_received is stored as unix seconds (NOT nanoseconds since
// Mac epoch like chat.db). 32-bit-safe integer regime, no BigInt needed.
function dateReceivedToIso(seconds) {
  if (seconds == null) return null;
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

// .emlx body resolution.
//
// Apple Mail keys body files by messages.ROWID rather than document_id, and a
// partially downloaded body uses the `.partial.emlx` suffix. The resolver
// therefore indexes both basename forms by rowid and prefers the full body.
// The bounded index replaces the old per-miss walk, whose cap could end before
// the matching mailbox directory and cache a false miss.
//
// Strategy: one bounded single-pass walk builds a basename → absolute-path
// index for every *.emlx under mailRoot (lazy, rebuilt at most once per
// cool-down window on a miss so newly synced messages resolve without
// unbounded re-walking). Per-documentId results stay cached across calls.
//
// Tests pass an exact body path via opts.bodyResolver(documentId) →
// absolute path string; production resolution uses this index.
//
// HOW TO READ body_resolved ON THE LEDGER — append order is the relevant axis.
// ---------------------------------------------------------------------------
// RUNTIME-CENSUS: run mcp/scripts/verify-mail-body-coverage.mjs to derive the
// dated corpus total, resolved total, frozen-prefix boundary, and live-suffix
// rate. Keep the output with the investigation; do not copy it into source.
//
// The measurement separates rows written by the former basename resolver from
// rows written by this resolver. Consumers must not substitute the whole-ledger
// rate for the live-suffix rate, or group the defect by message date. The
// measurement streams records using the JSONL newline delimiter because a
// generic line reader also treats Unicode separators inside JSON strings as
// record boundaries.
//
// A live-window miss is a separate defect from a frozen prefix. The verification
// script reports both so a caller does not fold the former into the latter.
//
// Interpretation rules:
//   - Read rows_total as the denominator for historical storage, not as a
//     description of the current resolver.
//   - Read resolved_total alongside its regime boundary; alone it combines
//     output produced by different implementations.
//   - Read frozen_prefix_rows as an append-order segment, not as an age bucket.
//     Message timestamps can move backward while ledger offsets move forward.
//   - Read live_suffix_resolved_rate as the current forward-capture signal.
//     Re-run the producer when that operational question is asked.
//
// Why append order matters:
// The connector advances a durable cursor and does not revisit earlier rows as
// part of ordinary polling. A resolver correction therefore changes future
// output while retained rows continue to describe the earlier implementation.
// Grouping by message date mixes those regimes because delayed and imported
// messages may carry old timestamps while being appended by current code.
//
// Counting discipline:
// The producer splits on the JSONL record delimiter and reports malformed input
// separately. A consumer must keep skipped-line counts visible rather than
// interpreting a failed parse as an unresolved message. The boundary identifiers
// are evidence for locating the regime transition; they are not configuration
// values and must not be copied into this module.
//
// Operational boundary:
// Treat the producer as a read-only diagnostic. Repair requires a supervised
// re-ingest through the fixed resolver and belongs to an explicitly authorized
// write workflow. Forward polling must remain fail-soft if an indexed body is
// absent, partial, malformed, or synchronized after the index was built.
//
// End body-resolution interpretation rules.
// Repairing the prefix would be a SUPERVISED re-ingest of rowids at or below
// the boundary through this (fixed) resolver — a write to storage/, named
// here and deliberately not built, scheduled, or turned into a re-download.
const EMLX_INDEX_DIR_CAP = 65536; // > 21,962 real dirs, still bounded
const EMLX_INDEX_REBUILD_COOLDOWN_MS = 60000;

// Map a connector documentId to the on-disk basenames it may live under.
// 'rowid:<n>' → ['<n>.emlx', '<n>.partial.emlx'] (the production shape);
// a plain TEXT id → ['<id>.emlx', '<id>.partial.emlx']. Order encodes the
// full-over-partial preference.
function emlxCandidateBasenames(documentId) {
  const stem = documentId.startsWith("rowid:")
    ? documentId.slice("rowid:".length)
    : documentId;
  if (stem === "") return [];
  return [stem + ".emlx", stem + ".partial.emlx"];
}

function defaultBodyResolver(mailRoot) {
  const resolved = new Map(); // documentId → absolute path | null
  let index = null; // *.emlx basename → absolute path
  let indexBuiltAtMs = 0;

  // Single bounded walk; never throws. Skips backup/migration scratch dirs
  // (Backups) and the SQLite home (MailData) to bound the traversal.
  function buildIndex() {
    const map = new Map();
    const queue = [mailRoot];
    let visited = 0;
    while (queue.length > 0 && visited < EMLX_INDEX_DIR_CAP) {
      const dir = queue.shift();
      visited += 1;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (ent.isFile()) {
          if (ent.name.endsWith(".emlx")) map.set(ent.name, join(dir, ent.name));
        } else if (ent.isDirectory()) {
          if (ent.name === "Backups" || ent.name === "MailData") continue;
          queue.push(join(dir, ent.name));
        }
      }
    }
    return map;
  }

  return (documentId) => {
    if (typeof documentId !== "string" || documentId === "") return null;
    if (resolved.has(documentId)) return resolved.get(documentId);
    const candidates = emlxCandidateBasenames(documentId);
    const lookup = () => {
      for (const name of candidates) {
        const hit = index.get(name);
        if (hit != null) return hit;
      }
      return null;
    };
    if (index == null) {
      index = buildIndex();
      indexBuiltAtMs = Date.now();
    }
    let found = lookup();
    if (found == null &&
        Date.now() - indexBuiltAtMs >= EMLX_INDEX_REBUILD_COOLDOWN_MS) {
      // Miss on a stale index: allow at most one rebuild per cool-down
      // window so newly synced .emlx files become resolvable.
      index = buildIndex();
      indexBuiltAtMs = Date.now();
      found = lookup();
    }
    resolved.set(documentId, found);
    return found;
  };
}

// Read an .emlx file and return the RFC 5322 body bytes. Apple's .emlx
// format is:
//   <byte-count>\n<RFC 5322 message>\n<binary plist trailer>
// We use the leading byte count to slice the RFC 5322 region exactly.
export function readEmlxBody(absPath) {
  if (!existsSync(absPath)) return null;
  let buf;
  try { buf = readFileSync(absPath); } catch { return null; }
  if (buf.length === 0) return null;
  // First line is the decimal byte count.
  let nl = buf.indexOf(0x0a /* \n */);
  if (nl < 0) return buf; // no header — treat whole file as message
  const countStr = buf.slice(0, nl).toString("ascii").trim();
  const count = parseInt(countStr, 10);
  if (!Number.isFinite(count) || count <= 0 || count > buf.length - nl - 1) {
    // Fall back to entire post-newline region.
    return buf.slice(nl + 1);
  }
  return buf.slice(nl + 1, nl + 1 + count);
}

// Identity-map lookup for an explicitly injected identityMapPath. Loads the
// JSON; case-insensitive match against canonical + aliases. Caches at
// instance scope.
function loadIdentityMap(path) {
  if (!existsSync(path)) {
    return { canonical: null, aliases: new Set() };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const canonical = typeof parsed.canonical === "string" ? parsed.canonical.toLowerCase() : null;
    const aliases = new Set();
    if (canonical) aliases.add(canonical);
    if (Array.isArray(parsed.aliases)) {
      for (const a of parsed.aliases) {
        if (typeof a === "string") aliases.add(a.toLowerCase());
      }
    }
    return { canonical, aliases };
  } catch {
    return { canonical: null, aliases: new Set() };
  }
}

// Extract one or more email addresses from a structured header value.
// "Foo Bar <foo@example.com>, baz@example.com" → ["foo@example.com", "baz@example.com"]
export function extractEmails(headerValue) {
  if (typeof headerValue !== "string") return [];
  const out = [];
  // Match angle-bracket form first.
  const re = /<([^<>@\s]+@[^<>@\s]+)>|\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g;
  let m;
  while ((m = re.exec(headerValue)) != null) {
    out.push((m[1] || m[2]).toLowerCase());
  }
  return out;
}

// ---------------------------------------------------------------------------
// G2: bound the References header before it lands on a ledger row.
//
// References is the header WE LAND whose length grows with thread depth — every
// reply appends its parent's Message-ID, so a long-lived human thread carries an
// ever-larger copy of the same chain on EVERY row of that thread.
//
// NOT "the only such header". An earlier draft of this comment said exactly that
// and it was false, which is why the scope is now "the header we land":
//   - Thread-Index (Exchange/Outlook's base64 PidTagConversationIndex) is 22
//     bytes plus exactly 5 per response level, so it grows with depth BY
//     CONSTRUCTION — more strictly than References, which MUAs are permitted to
//     trim, making References' own monotonicity a modelling assumption, not a law.
//   - In-Reply-To is 1*msg-id in the RFC 5322 grammar; older clients put the
//     whole chain there.
//   - Subject grows wherever reply prefixes stack.
// None of those are in the allowlist, so none reaches a row — which is why the
// bound below is scoped to what we actually land rather than to mail in general.
// Received is NOT a counterexample: it grows with hop count per message, not
// thread depth, and splitHeadersAndBody keeps only the FIRST instance of a
// header name, so it never accumulates. Measured on the live tail it is small today (p50 29 chars, p90
// 48, max 134), so the cap below never fires on the current corpus; it exists
// so a deep thread cannot make the ledger grow superlinearly.
//
// Truncation must preserve BOTH ENDS. The messaging adapter reads the chain
// from opposite directions (lib/messaging/adapters/mail.js):
//   _threadId   → refs[0]                 — the thread ROOT
//   _replyToId  → refs[refs.length - 1]   — the immediate PARENT
// so a naive head- or tail-slice silently breaks one of the two. We keep the
// first id and the last few, dropping only the interior.
//
// Module-scope + exported (rather than a closure inside _buildLedgerRow like
// extractDkimDomain) so the both-ends-preserved property is directly unit
// testable and the helper is not reallocated per ledger row.
// ACTIVATION — this connector runs as a single long-lived runForever() process
// under launchd KeepAlive:true, so StartInterval is inert: the process never
// exits and therefore never re-reads this module. A source change here does NOT
// take effect on the next poll — it takes effect on
//   launchctl kickstart -k gui/<uid>/com.user.memory-system.mail-connector
// This was learned the expensive way: the reply-header change sat live for hours
// emitting the OLD 13-key shape while a nine-day-old process held the previous
// module in memory, and the commit blamed polling cadence.
export const REFERENCES_MAX_CHARS = 2048;
const REFERENCES_TAIL_KEEP = 4;

export function boundReferences(headerValue) {
  if (typeof headerValue !== "string" || headerValue.length === 0) return null;
  if (headerValue.length <= REFERENCES_MAX_CHARS) return headerValue;
  const ids = headerValue.match(/<[^<>]+>/g);
  // No parseable message-ids — nothing structural to preserve, just bound it.
  if (ids == null || ids.length === 0) return headerValue.slice(0, REFERENCES_MAX_CHARS);
  if (ids.length <= REFERENCES_TAIL_KEEP + 1) return ids.join(" ");
  return [ids[0], ...ids.slice(-REFERENCES_TAIL_KEEP)].join(" ");
}

// Per-row consent classification. Operator authorship trumps audience.
//   - From: matches operator alias → first_party (round-20 C1)
//   - 1:1 inbound (To: operator only, no Cc/Bcc list) → second_party_dm
//   - otherwise (mailing list, group To, mass-Bcc) → third_party_inferred
//   - deletion_semantics is always "full_excise" (operator-local index)
//
// UNION semantics: "is this email an operator identity?" is answered by
// UNION of (a) the identityMap.aliases Set, populated only when a caller
// injected an explicit identityMapPath, and (b) the canonical isOperator()
// helper, which reads the operator-identity config file. Either match is
// sufficient. Tests that pass a synthetic identityMap (T18) continue to
// work; with no injected map the Set is empty and any address listed in
// the operator-identity config is picked up automatically.
function isOperatorEmail(email, identityMap) {
  if (typeof email !== "string" || email.length === 0) return false;
  if (identityMap && identityMap.aliases && identityMap.aliases.has(email)) return true;
  if (isOperator(email, "mail")) return true;
  return false;
}

export function classifyMailRow(rowMeta, identityMap) {
  const { from, to, cc } = rowMeta;
  const fromEmails = extractEmails(from || "");
  const toEmails = extractEmails(to || "");
  const ccEmails = extractEmails(cc || "");
  const isFromOperator = fromEmails.some((e) => isOperatorEmail(e, identityMap));
  let consentBasis;
  if (isFromOperator) {
    consentBasis = "first_party";
  } else {
    const operatorInTo = toEmails.some((e) => isOperatorEmail(e, identityMap));
    const otherRecipients = toEmails.filter((e) => !isOperatorEmail(e, identityMap)).length + ccEmails.length;
    if (operatorInTo && otherRecipients === 0) {
      consentBasis = "second_party_dm";
    } else {
      consentBasis = "third_party_inferred";
    }
  }
  return {
    consent_basis: consentBasis,
    deletion_semantics: "full_excise",
  };
}

// ---------------------------------------------------------------------------
// MailConnector
// ---------------------------------------------------------------------------

export class MailConnector extends ConnectorBase {
  constructor({
    envelopeIndexPath,
    mailRoot,
    identityMapPath,
    bodyResolver,
    sourceLedgerPath,
    cursorPath,
    now,
  } = {}) {
    super({
      source: "mail",
      sourceLedgerPath,
      cursorPath,
      sourcePolicyForRow: (row) => row.__policy || {
        deletion_semantics: "full_excise",
        consent_basis: "third_party_inferred",
      },
    });
    this.envelopeIndexPath = envelopeIndexPath || defaultEnvelopeIndexPath();
    this.mailRoot = mailRoot || defaultMailRoot();
    // No default: the alias map is loaded only when a caller injects a path.
    this.identityMapPath = identityMapPath || null;
    this.bodyResolver = typeof bodyResolver === "function"
      ? bodyResolver
      : defaultBodyResolver(this.mailRoot);
    this._now = typeof now === "function" ? now : null;
    this._identityMap = null;
  }

  _serverTs() {
    if (this._now) return this._now();
    return new Date().toISOString();
  }

  _getIdentityMap() {
    if (this._identityMap == null) {
      this._identityMap = this.identityMapPath
        ? loadIdentityMap(this.identityMapPath)
        : { canonical: null, aliases: new Set() };
    }
    return this._identityMap;
  }

  async pollOnce(opts = {}) {
    const limit = typeof opts.limit === "number" ? opts.limit : 500;
    if (!existsSync(this.envelopeIndexPath)) {
      await this.tagError("envelope_index_absent");
      return { appended: 0, errors: 1, latest_rowid: null };
    }

    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      await this.tagError("sqlite_module_unavailable");
      return { appended: 0, errors: 1, latest_rowid: null };
    }

    let db;
    try {
      db = new DatabaseSync(this.envelopeIndexPath, { readOnly: true });
    } catch (err) {
      // Single-line error detail on stderr (idiom shared with the sibling
      // connectors' fatal handlers) — tagError() records only the kind.
      process.stderr.write(`mail-connector envelope_index_open_failed: ${err?.message || err}\n`);
      await this.tagError("envelope_index_open_failed");
      return { appended: 0, errors: 1, latest_rowid: null };
    }

    let appended = 0;
    let errors = 0;
    let latestRowid = null;

    try {
      const cursor = (await this.readCursor()) || {};
      const lastRowid = Number.isInteger(cursor.last_message_rowid) ? cursor.last_message_rowid : 0;

      // Join messages → addresses (sender) → subjects → mailboxes. The
      // Envelope Index does NOT store body text; we read body from the
      // .emlx file. The Apple-derived classifier columns (unsubscribe_type,
      // list_id_hash, automated_conversation) come straight from the
      // messages table — Apple's own bulk-mail classifier signals.
      //
      // F-T2-MAIL-F11 (WU-mail-extend): the mailboxes LEFT JOIN surfaces
      // the per-message mailbox URL (e.g. imap://user@example.com/Junk,
      // mbox://Trash, ews://Bulk Mail). The operator's own folder
      // placement is the highest-fidelity human spam signal available;
      // Stage-0 reads raw_content.mailbox_url to filter Junk / Spam /
      // Trash / Bulk Mail / Deleted Messages BEFORE any header rules
      // fire (Apple's localized folder names are handled by the
      // case-insensitive regex in stage0/mail.js Rule 0). The JOIN is
      // O(rowcount) over the small mailboxes table (typically <100 rows
      // even on power-user mail libraries) and is index-backed via
      // mailboxes.ROWID — performant on multi-100K-message archives.
      //
      // L30 (64-bit INTEGER regime): m.list_id_hash is Apple's 64-bit
      // mailing-list hash and MUST be CAST AS TEXT. In the operator's real
      // Envelope Index 54,250 of 276,565 rows exceed 2^53 (e.g.
      // 1234567890123456789) and node:sqlite's stmt.all() throws
      // ERR_OUT_OF_RANGE on any such row rather than silently truncating
      // — 323 of the first 500 rows overflowed, so the first batch ALWAYS
      // threw, the cursor never advanced, and the connector never appended
      // a single row. The TEXT string crosses the FFI boundary losslessly;
      // _buildLedgerRow Number()s it back down (lossy above 2^53, which is
      // safe — see the raw_content stamping comment there).
      // CAPABILITY PROBE for the recipient-recovery join. The `recipients`
      // table is present in Apple Mail's real Envelope Index (1.78M rows here)
      // but is NOT part of the minimal schema synthetic fixtures build, and we
      // cannot assume it across Mail versions. Referencing a missing table
      // fails PREPARE, which would take down the entire poll — the connector
      // would append nothing at all rather than degrade. So probe once and
      // select the SQL variant: with the table we recover recipients, without
      // it we emit exactly the pre-existing query and behaviour is unchanged.
      let hasRecipients = false;
      try {
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='recipients'",
        ).get() && (hasRecipients = true);
      } catch {
        hasRecipients = false;
      }
      const recipientCols = hasRecipients
        ? `,
          (SELECT group_concat(ra.address, ', ')
             FROM recipients r
             JOIN addresses ra ON ra.ROWID = r.address
            WHERE r.message = m.ROWID AND r.type = 0) AS recipient_to,
          (SELECT group_concat(ra.address, ', ')
             FROM recipients r
             JOIN addresses ra ON ra.ROWID = r.address
            WHERE r.message = m.ROWID AND r.type = 1) AS recipient_cc`
        : "";

      const sql = `
        SELECT
          m.ROWID                       AS rowid,
          m.document_id                 AS document_id,
          a.address                     AS sender_address,
          a.comment                     AS sender_comment,
          s.subject                     AS subject_text,
          mb.url                        AS mailbox_url,
          m.date_received               AS date_received,
          m.unsubscribe_type            AS unsubscribe_type,
          CAST(m.list_id_hash AS TEXT)  AS list_id_hash,
          m.automated_conversation      AS automated_conversation,
          m.brand_indicator             AS brand_indicator${recipientCols}
        FROM messages m
        LEFT JOIN addresses a  ON a.ROWID  = m.sender
        LEFT JOIN subjects  s  ON s.ROWID  = m.subject
        LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox
        WHERE m.ROWID > ? AND m.deleted = 0
        ORDER BY m.ROWID ASC
        LIMIT ?
      `;

      let stmt;
      try {
        stmt = db.prepare(sql);
      } catch (err) {
        // Single-line error detail on stderr — see the open-failed site.
        process.stderr.write(`mail-connector envelope_index_query_prepare_failed: ${err?.message || err}\n`);
        await this.tagError("envelope_index_query_prepare_failed");
        return { appended: 0, errors: 1, latest_rowid: null };
      }

      let rows;
      try {
        rows = stmt.all(lastRowid, limit);
      } catch (err) {
        // Surface the underlying error on stderr. tagError() records only
        // the kind (last_error_kind), and a fully-swallowed `catch {}` here
        // hid the list_id_hash ERR_OUT_OF_RANGE overflow (L30) behind
        // 3,886 opaque envelope_index_query_run_failed counts with an
        // empty stderr — one per 5-min poll, with zero rows ever appended.
        // The message makes the next opaque failure class diagnosable.
        process.stderr.write(`mail-connector envelope_index_query_run_failed: ${err?.message || err}\n`);
        await this.tagError("envelope_index_query_run_failed");
        return { appended: 0, errors: 1, latest_rowid: null };
      }

      const idMap = this._getIdentityMap();

      for (const dbRow of rows) {
        try {
          const stamped = this._buildLedgerRow(dbRow, idMap);
          if (stamped == null) {
            errors += 1;
          } else {
            const result = await this.appendLedgerRow(stamped);
            if (result.appended) appended += 1;
          }
          const n = Number(dbRow.rowid);
          if (Number.isFinite(n) && (latestRowid == null || n > latestRowid)) {
            latestRowid = n;
          }
        } catch {
          errors += 1;
        }
      }

      if (latestRowid != null) {
        const ts = this._serverTs();
        const nextState = {
          ...cursor,
          last_message_rowid: latestRowid,
          last_appended_ts: ts,
          last_cursor_advance_ts: ts,
        };
        await this.writeCursor(nextState);
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }

    return { appended, errors, latest_rowid: latestRowid };
  }

  _buildLedgerRow(dbRow, identityMap) {
    const documentId = typeof dbRow.document_id === "string" && dbRow.document_id !== ""
      ? dbRow.document_id
      : `rowid:${dbRow.rowid}`;
    const bodyPath = this.bodyResolver(documentId);
    let extracted = null;
    if (bodyPath) {
      const bodyBytes = readEmlxBody(bodyPath);
      if (bodyBytes != null) {
        extracted = parseEmail(bodyBytes);
      }
    }

    const headers = extracted ? extracted.headers : {};
    // Synthesize a From: header from the joined addresses table if the
    // extracted RFC 5322 has no body (orphan envelope row, e.g. metadata-only
    // archive).
    if (!headers.from && typeof dbRow.sender_address === "string") {
      const name = typeof dbRow.sender_comment === "string" ? dbRow.sender_comment : "";
      headers.from = name ? `${name} <${dbRow.sender_address}>` : dbRow.sender_address;
    }
    // Same fallback for the OTHER side of the envelope. Sent mail rarely has a
    // resolvable .emlx body, so without this the recipients are lost and the
    // outbound half of the correspondence graph does not exist. The envelope
    // DB's `recipients` join supplies them regardless of the body. Only fills a
    // GAP — a parsed header always wins, so inbound behaviour is unchanged.
    if (!headers.to && typeof dbRow.recipient_to === "string" && dbRow.recipient_to !== "") {
      headers.to = dbRow.recipient_to;
    }
    if (!headers.cc && typeof dbRow.recipient_cc === "string" && dbRow.recipient_cc !== "") {
      headers.cc = dbRow.recipient_cc;
    }

    const policy = classifyMailRow(
      { from: headers.from, to: headers.to, cc: headers.cc },
      identityMap,
    );

    const text = extracted ? extracted.text : null;
    // F-T2-MAIL-F5 + F-T2-MAIL-F2: prefer the RFC 5322 Subject header (which
    // _mime-body-extractor.js has already RFC 2047-decoded) over the Apple
    // Envelope Index subjects table (which Apple stores as-encoded, leaking
    // "=?utf-8?B?...?=" blobs into the structural-threshold and embedding
    // pipelines for international correspondents). Falls back to the Apple
    // column when the body lacks a Subject header (orphan envelope row).
    const headerSubject = typeof headers["subject"] === "string" && headers["subject"].length > 0
      ? headers["subject"]
      : null;
    const subject = headerSubject ||
      (typeof dbRow.subject_text === "string" ? dbRow.subject_text : null);

    // F-T2-MAIL-F4: extract the DKIM-Signature d= domain and the
    // Authentication-Results dkim=...header.d= or smtp.mailfrom= domain.
    // Either domain matching MARKETING_PLATFORM_RE is a more reliable
    // marketing-platform signal than Return-Path alone — many ESPs forge
    // a customer-domain Return-Path while signing with their own d=
    // domain. Robust against quoted/folded headers because
    // splitHeadersAndBody already collapses continuation lines.
    function extractDkimDomain(headerValue) {
      if (typeof headerValue !== "string" || headerValue.length === 0) return null;
      // DKIM-Signature has the form "v=1; a=rsa-sha256; d=example.com; s=...".
      // Tolerate quoted values and extra whitespace around the =.
      const m = headerValue.match(/(?:^|[;\s])d\s*=\s*"?([A-Za-z0-9.\-]+)"?/i);
      return m ? m[1].toLowerCase() : null;
    }
    function extractAuthResultsDomain(headerValue) {
      if (typeof headerValue !== "string" || headerValue.length === 0) return null;
      // Authentication-Results shape: "mx.example.com; dkim=pass header.d=esp.com; spf=pass smtp.mailfrom=esp.com".
      // We prefer header.d= (the DKIM signing domain) then smtp.mailfrom=.
      const hd = headerValue.match(/header\.d\s*=\s*"?([A-Za-z0-9.\-]+)"?/i);
      if (hd) return hd[1].toLowerCase();
      const mf = headerValue.match(/smtp\.mailfrom\s*=\s*"?([A-Za-z0-9.\-]+)"?/i);
      return mf ? mf[1].toLowerCase() : null;
    }
    const dkimDDomain = extractDkimDomain(headers["dkim-signature"] || "");
    const authResultsDDomain = extractAuthResultsDomain(headers["authentication-results"] || "");

    // R42: sender bot detection via the canonical bot-actors module. The
    // raw From: header can hold display-name + angle-brackets; we test each
    // extracted email AND the raw value (covers `<no-reply@github.com>` and
    // `no-reply@github.com`-style suffix patterns). Surfaced on raw_content
    // so downstream Stage-0 / salience layers can use the signal; the
    // existing Stage-0 noreply_sender regex remains the load-bearing rule.
    const fromEmailsForBot = extractEmails(headers.from || "");
    const senderIsBot = fromEmailsForBot.some((e) => isBotActor(e)) ||
      (typeof headers.from === "string" && isBotActor(headers.from));

    const rawContent = {
      text,
      subject,
      headers: {
        from: headers.from || null,
        to: headers.to || null,
        cc: headers.cc || null,
        // F-T2-MAIL-F5: surface the Subject header so Stage-0 can match
        // SUBJECT_AUTOREPLY_RE / SUBJECT_BRACKET_NOISE_RE. The header value
        // is the RFC 2047-decoded form (F-T2-MAIL-F2) so encoded-word
        // subjects are matchable.
        subject: headerSubject,
        "message-id": headers["message-id"] || null,
        // G2: the reply triple reads together — message-id names THIS message,
        // in-reply-to names its immediate parent, references carries the whole
        // ancestor chain (oldest first). splitHeadersAndBody already collects
        // both of these into the full lowercased header map; they were simply
        // dropped by this allowlist, so mail rows carried no thread linkage at
        // all. Present-and-null when the source header is absent (the same
        // `|| null` convention as every key beside them) — never omitted, and
        // never implying body resolution: on an orphan-envelope row there is no
        // .emlx to parse, so `headers` is `{}` and both land as null.
        "in-reply-to": headers["in-reply-to"] || null,
        references: boundReferences(headers["references"]) || null,
        "list-id": headers["list-id"] || null,
        "list-unsubscribe": headers["list-unsubscribe"] || null,
        "auto-submitted": headers["auto-submitted"] || null,
        precedence: headers["precedence"] || null,
        "return-path": headers["return-path"] || null,
        "content-type": headers["content-type"] || null,
        // F-T2-MAIL-F4: surface the DKIM-Signature + Authentication-Results
        // header values for Stage-0's marketing-platform check (more
        // reliable than the Return-Path-only path).
        "dkim-signature": headers["dkim-signature"] || null,
        "authentication-results": headers["authentication-results"] || null,
      },
      // Apple-derived signals (Stage-0 reads these first).
      unsubscribe_type: dbRow.unsubscribe_type != null ? Number(dbRow.unsubscribe_type) : 0,
      // L30: list_id_hash arrives as a TEXT string (CAST in the SELECT —
      // real values exceed 2^53 and would throw ERR_OUT_OF_RANGE unCAST).
      // Number() here is lossy above 2^53 but SAFE: the only consumer
      // (stage0/mail.js Rule 2) checks != null / !== 0, never equality
      // against the exact hash — and keeping the number type preserves the
      // pre-CAST semantics exactly (Number("0") === 0, so a zero hash
      // still does NOT fire Rule 2).
      list_id_hash: dbRow.list_id_hash != null ? Number(dbRow.list_id_hash) : null,
      automated_conversation: dbRow.automated_conversation != null
        ? Number(dbRow.automated_conversation) : 0,
      brand_indicator: dbRow.brand_indicator != null ? Number(dbRow.brand_indicator) : null,
      has_plain: extracted ? extracted.hasPlain : false,
      has_html: extracted ? extracted.hasHtml : false,
      // F-T2-MAIL-F9: hasCalendar surfaces when the message had a
      // text/calendar (.ics) alternative. Stage-0's placeholder_residual
      // rule no longer fires for calendar invites because parseEmail now
      // synthesises a text body from SUMMARY / DTSTART / LOCATION /
      // ORGANIZER lines.
      has_calendar: extracted ? !!extracted.hasCalendar : false,
      // F-T2-MAIL-F4: extracted ESP-signing domain (DKIM d=) and the
      // Authentication-Results header.d= / smtp.mailfrom= domain. Stage-0's
      // MARKETING_PLATFORM_RE check runs against both alongside Return-Path
      // — the d= domain is the canonical ESP identity that customer-domain
      // Return-Path forgery cannot hide.
      dkim_d_domain: dkimDDomain,
      auth_results_d_domain: authResultsDDomain,
      // HONEST GATE: true only when a body file was found AND readEmlxBody
      // returned non-null bytes AND parseEmail produced an extraction.
      // Previously this was `bodyPath != null`, which reported true even
      // when the read failed and no body was ever extracted.
      body_resolved: extracted != null,
      // R42: canonical bot-actor signal for the From: header. True iff any
      // address extracted from From: matches the BOT_ACTOR_REGEX (covers
      // dependabot, renovate, github-actions, web-flow, claude[bot], plus
      // the generic `[bot]@` suffix catch-all).
      sender_is_bot: senderIsBot,
      // F-T2-MAIL-F11 (WU-mail-extend): per-message mailbox URL surfaced
      // from the mailboxes JOIN. Stage-0 reads this BEFORE running any
      // header rule so the operator's own Junk/Spam/Trash/Bulk
      // Mail/Deleted Messages curation acts as the highest-priority
      // filter. Null when the mailboxes row is missing or the JOIN
      // returned no match (defensive — the connector always reads via
      // LEFT JOIN so the row still surfaces).
      mailbox_url: typeof dbRow.mailbox_url === "string" ? dbRow.mailbox_url : null,
    };

    // Parties: From + To + Cc (deduplicated, lowercased).
    const partySet = new Set();
    for (const e of extractEmails(headers.from || "")) partySet.add(e);
    for (const e of extractEmails(headers.to || "")) partySet.add(e);
    for (const e of extractEmails(headers.cc || "")) partySet.add(e);
    const parties = Array.from(partySet);

    const ts = dateReceivedToIso(dbRow.date_received) || this._serverTs();

    const row = {
      ts,
      source_msg_id: documentId,
      parties,
      raw_content: rawContent,
      attachments: [],
      // ConnectorBase's sourcePolicyForRow reads this internal handoff key
      // so the per-row classifier is computed exactly once.
      __policy: policy,
    };
    return row;
  }

  async runOnce(opts = {}) {
    const r = await this.pollOnce(opts);
    return { appended: r.appended, errors: r.errors };
  }

  async runForever(opts = {}) {
    const interval = opts.intervalMs || MAIL_POLL_INTERVAL_MS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try { await this.pollOnce(opts); }
      catch { try { await this.tagError("poll_unexpected_throw"); } catch {} }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

// ---------------------------------------------------------------------------
// CLI shim
// ---------------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const mode = process.argv[2];
  if (mode === "--check") {
    process.stdout.write("ok\n");
    process.exit(0);
  } else if (mode === "--once") {
    const c = new MailConnector({});
    c.runOnce().then((r) => {
      process.stdout.write(JSON.stringify(r) + "\n");
      process.exit(0);
    }).catch((err) => {
      process.stderr.write(`runOnce error: ${err?.stack || err}\n`);
      process.exit(1);
    });
  } else {
    const c = new MailConnector({});
    c.runForever().catch((err) => {
      process.stderr.write(`runForever error: ${err?.stack || err}\n`);
      process.exit(1);
    });
  }
}
