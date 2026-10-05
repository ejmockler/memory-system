// contact-spine.js — the CROSS-PLATFORM CONTACT IDENTITY SPINE.
//
// MISSION. Answer "which saved human is this handle?" with ONE person identity
// that spans every messaging platform, built from the address books the
// operator actually curated.
//
// THE DEFECT THIS CLOSES. Before this module, person identity was derived
// PER-PLATFORM from the platform's own handle, so the same saved human was N
// unrelated people. Measured live on 2026-07-31:
//
//     Mom · imessage · person:cc89ee9f143a
//     Mom · whatsapp · person:fef59876c5cb     <- a different "person" entirely
//     rows carrying multi-platform fusion: 0 of 60
//
// This is the SAME defect class as the entity-scope bug fixed earlier in the
// week (mcp/lib/recall/multi-feature-score.js entityMatchKey): an identifier
// that embeds its SOURCE can never match itself across sources. There the fix
// was to strip the source segment before comparison. Here the fix is to derive
// identity from the operator's own address books — where the handles for one
// human are ALREADY grouped by a person record — instead of from the handle.
//
// WHY ADDRESS BOOKS ARE THE RIGHT SPINE. A saved contact is an explicit human
// vouch (contacts-anchor.js: "the strongest single structural signal that they
// matter"). It is also, crucially, an EXISTING person->handles grouping the
// operator maintains by hand. macOS Contacts already models this: ZABCDRECORD
// is the person, and ZABCDPHONENUMBER.ZOWNER / ZABCDEMAILADDRESS.ZOWNER point
// back at it. The prior builder (connectors/_imessage-name-recovery.js
// buildContactMaps) ran exactly that join and then DISCARDED the owner id,
// flattening to handle->name maps. The grouping was always in the schema; it
// was thrown away one line before it became useful.
//
// SOURCES (all READ-ONLY; each degrades independently to "absent"):
//   - macOS Contacts   ~/Library/Application Support/AddressBook/Sources/*/
//                      AddressBook-v22.abcddb  (person = ZABCDRECORD.Z_PK)
//   - WhatsApp         ~/Library/Group Containers/group.net.whatsapp.
//                      WhatsApp.shared/ContactsV2.sqlite
//                      (ZWAADDRESSBOOKCONTACT: ZFULLNAME + ZPHONENUMBER, and
//                      ZWHATSAPPID/ZLID as platform-native handles so a
//                      WhatsApp-only thread can resolve without a phone match)
//   - Telegram         NOT AVAILABLE. Telegram macOS stores its data in an
//                      encrypted postbox (Group Containers/*.ru.keepcoder.
//                      Telegram/stable/account-*/postbox), not a readable
//                      contact table. Telegram handles therefore resolve ONLY
//                      when the same human is saved in Contacts or WhatsApp
//                      under a shared phone/email. Documented, not silently
//                      pretended away.
//
// MERGE. Two contact records are the SAME person when they share ANY normalized
// handle. Handles are normalized to the SAME key shape the rest of the system
// uses (phone: digits, last 10; email: lowercased+trimmed) via the normalizers
// RE-USED from _imessage-name-recovery.js, so spine keys and lookup keys can
// never drift apart. Merging is transitive (union-find): if Contacts links
// {phone A, email B} and WhatsApp links {phone A, waid C}, then A/B/C are one
// person. Transitivity is what makes a WhatsApp-native id resolve to a human
// the operator only ever saved a phone number for.
//
// THESIS #1 (read-only sources / derived projections). Nothing here is
// persisted. The spine is a query-time projection rebuilt from read-only DBs,
// memoized per process. person keys are therefore derived deterministically
// from the merged handle SET (stable within a run, and stable across runs for
// an unchanged address book) rather than from a stored id.
//
// NEVER HARD-DROP A HUMAN. Every failure path degrades to a SMALLER spine, never
// to an exception: an unreadable DB, missing Full Disk Access, absent
// node:sqlite, or a schema variant yields fewer resolved people, and every
// unresolved handle simply stays unanchored (is_contact=false, neutral rank) —
// exactly the pre-spine behaviour. This module never throws to its caller.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  resolveAddressBookDbPaths,
  normalizePhone,
  normalizeEmail,
  isEmailHandle,
  contactFullName,
} from "../connectors/_imessage-name-recovery.js";
import { sourceLedgerPath } from "../config.js";

/** WhatsApp's saved-contact mirror. Read-only; absent on non-WhatsApp machines. */
/** The mail connector's OUTPUT ledger — the reply-history source reads the
 *  connector's output, never the mail store itself. */
export const DEFAULT_MAIL_LEDGER_PATH = sourceLedgerPath("mail");

export const DEFAULT_WHATSAPP_CONTACTS_PATH = join(
  homedir(),
  "Library",
  "Group Containers",
  "group.net.whatsapp.WhatsApp.shared",
  "ContactsV2.sqlite",
);

/**
 * normalizeHandleKey — the ONE canonical key shape for a handle.
 * Byte-identical to contacts-anchor.js's normalizer by construction (both call
 * the same underlying normalizers), so spine keys join to anchor lookups.
 * Returns null for anything unusable.
 */
export function normalizeHandleKey(handle) {
  if (typeof handle !== "string") return null;
  const raw = handle.trim();
  if (raw === "") return null;
  // WhatsApp-native ids (…@lid, …@s.whatsapp.net) are opaque platform handles:
  // keep them verbatim (lowercased) so they can anchor a WhatsApp-only thread.
  if (raw.includes("@") && (raw.endsWith("@lid") || raw.includes("@s.whatsapp.net"))) {
    return raw.toLowerCase();
  }
  if (isEmailHandle(raw)) {
    const e = normalizeEmail(raw);
    return e || null;
  }
  const p = normalizePhone(raw);
  return p || null;
}

// ---------------------------------------------------------------------------
// Union-find over handle keys. Small (hundreds of contacts), so the simple
// path-compressing implementation is more than adequate and stays readable.
// ---------------------------------------------------------------------------

function makeUnionFind() {
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) {
      parent.set(x, x);
      return x;
    }
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  return { find, union, keys: () => parent.keys() };
}

/**
 * personKeyFor — deterministic identity for a merged handle set.
 * Derived from the SORTED handle set so it is reproducible across runs for an
 * unchanged address book, and never persisted (THESIS #1). Prefixed "person:"
 * to match the shape the catch-up surface already emits.
 */
export function personKeyFor(handles) {
  const sorted = [...new Set(handles)].filter(Boolean).sort();
  const h = createHash("sha256").update(sorted.join("\u0000")).digest("hex");
  return `person:${h.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Source readers. Each returns an array of {name, handles[]} contact records,
// and each is individually fail-soft.
// ---------------------------------------------------------------------------

async function openReadOnly(path) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * readMacOSContacts — person-GROUPED read of the macOS address books.
 * Unlike buildContactMaps (handle->name), this preserves ZABCDRECORD.Z_PK, the
 * person record that owns the handles. That owner id IS the grouping this whole
 * module exists to recover.
 */
export async function readMacOSContacts(dbPaths) {
  const out = [];
  if (!Array.isArray(dbPaths)) return out;
  for (const dbPath of dbPaths) {
    if (typeof dbPath !== "string" || !dbPath || !existsSync(dbPath)) continue;
    const db = await openReadOnly(dbPath);
    if (db == null) continue;
    try {
      // One row per (person, handle). Grouped below by the person's record pk.
      const byRecord = new Map();
      const collect = (rows, field) => {
        for (const row of rows || []) {
          const key = normalizeHandleKey(row[field]);
          if (key === null) continue;
          const pk = row.pk;
          if (pk == null) continue;
          if (!byRecord.has(pk)) {
            byRecord.set(pk, {
              name: contactFullName({
                first: row.first,
                last: row.last,
                org: row.org,
                nickname: row.nickname,
              }),
              handles: [],
            });
          }
          byRecord.get(pk).handles.push(key);
        }
      };
      try {
        collect(
          db
            .prepare(
              `SELECT r.Z_PK AS pk, p.ZFULLNUMBER AS num,
                      r.ZFIRSTNAME AS first, r.ZLASTNAME AS last,
                      r.ZORGANIZATION AS org, r.ZNICKNAME AS nickname
               FROM ZABCDPHONENUMBER p
               JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER`,
            )
            .all(),
          "num",
        );
      } catch {
        /* schema variant without phones — skip phones only */
      }
      try {
        collect(
          db
            .prepare(
              `SELECT r.Z_PK AS pk, e.ZADDRESS AS addr,
                      r.ZFIRSTNAME AS first, r.ZLASTNAME AS last,
                      r.ZORGANIZATION AS org, r.ZNICKNAME AS nickname
               FROM ZABCDEMAILADDRESS e
               JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER`,
            )
            .all(),
          "addr",
        );
      } catch {
        /* schema variant without emails — skip emails only */
      }
      for (const rec of byRecord.values()) {
        if (rec.handles.length > 0) out.push(rec);
      }
    } catch {
      /* unreadable source — contributes nothing */
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/**
 * readWhatsAppContacts — the operator's SAVED WhatsApp contacts.
 * ZWAADDRESSBOOKCONTACT is WhatsApp's mirror of the phone address book, so a
 * row here is a genuine saved-contact vouch. ZWHATSAPPID/ZLID are carried as
 * handles so a WhatsApp thread keyed on a platform-native id still resolves
 * even when the phone never matches anything in Contacts.
 */
export async function readWhatsAppContacts(dbPath = DEFAULT_WHATSAPP_CONTACTS_PATH) {
  const out = [];
  if (typeof dbPath !== "string" || !dbPath || !existsSync(dbPath)) return out;
  const db = await openReadOnly(dbPath);
  if (db == null) return out;
  try {
    const rows = db
      .prepare(
        `SELECT ZFULLNAME AS name, ZGIVENNAME AS given, ZLASTNAME AS last,
                ZPHONENUMBER AS phone, ZWHATSAPPID AS waid, ZLID AS lid
         FROM ZWAADDRESSBOOKCONTACT`,
      )
      .all();
    for (const row of rows) {
      const handles = [];
      for (const h of [row.phone, row.waid, row.lid]) {
        const k = normalizeHandleKey(h);
        if (k !== null) handles.push(k);
      }
      if (handles.length === 0) continue;
      const name =
        (typeof row.name === "string" && row.name.trim()) ||
        contactFullName({ first: row.given, last: row.last }) ||
        null;
      out.push({ name, handles });
    }
  } catch {
    /* schema variant / unreadable — contributes nothing */
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The spine.
// ---------------------------------------------------------------------------

/**
 * buildSpineFromRecords — PURE. Merge contact records into people.
 * Exported separately from the IO so the merge logic is testable without a
 * database. Two records join when they share any normalized handle; merging is
 * transitive via union-find.
 *
 * @param {{name:string|null, handles:string[]}[]} records
 * @returns {{personByHandle:Map<string,string>, handlesByPerson:Map<string,string[]>,
 *            nameByPerson:Map<string,string>, stats:object}}
 */
export function buildSpineFromRecords(records) {
  const uf = makeUnionFind();
  const namesByRoot = new Map();

  for (const rec of records || []) {
    const handles = (rec && Array.isArray(rec.handles) ? rec.handles : []).filter(Boolean);
    if (handles.length === 0) continue;
    const first = handles[0];
    for (const h of handles) uf.union(first, h);
  }
  // Second pass: attach names to the (now-settled) roots.
  for (const rec of records || []) {
    const handles = (rec && Array.isArray(rec.handles) ? rec.handles : []).filter(Boolean);
    if (handles.length === 0) continue;
    const root = uf.find(handles[0]);
    if (rec.name && !namesByRoot.has(root)) namesByRoot.set(root, rec.name);
  }

  // Group handles by connected component.
  const handlesByRoot = new Map();
  for (const h of uf.keys()) {
    const root = uf.find(h);
    if (!handlesByRoot.has(root)) handlesByRoot.set(root, []);
    handlesByRoot.get(root).push(h);
  }

  const personByHandle = new Map();
  const handlesByPerson = new Map();
  const nameByPerson = new Map();
  let multiHandle = 0;

  for (const [root, handles] of handlesByRoot) {
    const sorted = [...new Set(handles)].sort();
    const pid = personKeyFor(sorted);
    handlesByPerson.set(pid, sorted);
    for (const h of sorted) personByHandle.set(h, pid);
    const nm = namesByRoot.get(root);
    if (nm) nameByPerson.set(pid, nm);
    if (sorted.length > 1) multiHandle += 1;
  }

  return {
    personByHandle,
    handlesByPerson,
    nameByPerson,
    stats: {
      records: (records || []).length,
      people: handlesByPerson.size,
      handles: personByHandle.size,
      multi_handle_people: multiHandle,
    },
  };
}

/**
 * readReplyHistoryContacts — DERIVED source: people the operator has WRITTEN TO.
 *
 * Rationale. The stores above answer "who did the operator SAVE". This answers
 * the strictly stronger question "who did the operator ANSWER" — an outbound
 * message is a costlier, more deliberate vouch than an address-book entry, and
 * it needs no curation to stay current. It closes the gap where a real
 * correspondent (a collaborator, a bug-bounty triager, a client) is never in
 * any address book and so ranks below nothing at all.
 *
 * Source of truth is the CONNECTOR'S OUTPUT (storage/sources/mail.jsonl), not
 * the mail store — this module consumes ledgers, it does not re-implement a
 * connector. Operator authorship is decided by the CANONICAL identity module
 * (isOperator), never a local email list.
 *
 * Threshold: REPLY_HISTORY_MIN_MESSAGES outbound MESSAGES — distinct messages,
 * not ledger rows; see COUNTING below — to the same address.
 * 1 is deliberate — writing to someone even once is a real signal, and the
 * merge below is union-only so a false positive costs an unneeded up-rank, not
 * a drop.
 *
 * e12 — COUNTING IS PER DISTINCT MESSAGE, NOT PER LEDGER ROW, AND THIS IS A
 * READ-TIME BACK-COMPAT DEFENCE. A NEW CONSUMER MUST NOT COPY THIS PATTERN.
 *
 * The mechanism it defends against is Gmail-IMAP MAILBOX-COPY FAN-OUT. Apple
 * Mail exposes one sent message once per Gmail label, so a single send lands
 * in [Gmail]/Drafts, [Gmail]/All Mail and [Gmail]/Trash. The connector walks
 * the mailbox table and emits each copy as its own row. Measured on the live
 * mail ledger for one correspondent: 24 outbound rows carrying 11 distinct
 * message-ids — a 2.2x inflation of a vouch that is supposed to mean "the
 * operator wrote to this person 24 times".
 *
 * What was RULED OUT, so nobody re-diagnoses this as an ingest bug: it is NOT
 * a windowed re-ingest, NOT a cursor rewind, and NOT a duplicate poll. The
 * three copies of one message carry CONSECUTIVE, DISTINCT source_msg_ids
 * (rowid:1194381 / 1194382 / 1194384) under a strictly-increasing
 * `m.ROWID > ?` cursor — a rewind or a replay would re-emit the SAME rowid and
 * be swallowed by append-time dedup. Three rowids means three source rows.
 * They are real, distinct rows describing one real, single message.
 *
 * WHY THIS IS NOT FIXED AT INGEST, where identity defects belong (the general
 * rule; contrast the git-log connector, where the fix WAS an ingest-time
 * identity correction). Three reasons, each independently sufficient:
 *   (1) mailbox_url is LOAD-BEARING DOWNSTREAM. Stage-0 reads it to filter
 *       Junk/Spam (mcp/lib/ingest/stage0/mail.js). Collapsing the copies at
 *       ingest destroys the field that a different consumer correctly depends
 *       on.
 *   (2) message-id is ABSENT on the large majority of corpus rows — headers
 *       are populated only when the .emlx body resolves — so it cannot serve
 *       as a universal ingest-time key without silently dropping rows.
 *   (3) WHICH COPY IS "FIRST" IS ARBITRARY. Drafts/All Mail/Trash arrive in
 *       mailbox-walk order, so an ingest-time keep-first would pick a copy on
 *       a coin flip, and the ledger is append-only: that choice is permanent.
 * So the rows stay, and the COUNT-LIKE CONSUMER deduplicates at read time and
 * says so at the call site. That is the whole exception: where identity cannot
 * be fixed at ingest, counting consumers dedup at read time, explicitly.
 *
 * COVERAGE BOUND for the key used: of the outbound rows that actually reach
 * the counter (parties.length >= 2 AND an operator From:), 100% carry a
 * message-id — measured 40/40 on the live ledger. That is not luck: headers
 * exist only when the body resolved, and a row without a resolved body has no
 * To:/Cc: either, so it is already skipped below. The ordinal fallback is
 * therefore a correctness guarantee for header-less history, not the hot path.
 *
 * THE GENERAL RULE, stated here because this is the site that EXEMPTS itself
 * from it and an exemption is only honest if the rule is next to it:
 *   (a) IDENTITY IS THE CONNECTOR'S OBLIGATION. source_msg_id must key the
 *       EVENT, not the surface it was observed through.
 *   (b) ENFORCEMENT BELONGS AT THE LEDGER APPEND AND NOWHERE ELSE. One site,
 *       already built. Per-consumer dedup is how this contamination reached the
 *       e7 catch-up join in the first place, and it does not scale past the
 *       first consumer.
 *   (c) THIS FUNCTION IS THE BOUNDED EXCEPTION, for the three reasons argued
 *       above — and it is bounded to COUNTING. Nothing else here dedups.
 *
 * HISTORICAL ROWS ARE NOT REWRITTEN. storage/sources/mail.jsonl is append-only;
 * the Drafts/All Mail/Trash copies stay on disk. That is not a deferral, it is
 * the design: this defence is read-time precisely because the rows are staying.
 *
 * UNFIXED RESIDUAL, named rather than silently patched: an UNSENT DRAFT still
 * counts as one outbound vouch. That is a SEMANTIC defect (the operator typed
 * at someone but never sent), which is a different bug from the duplication
 * fixed here, and it is cheap under a union-only merge. Fixing it means
 * distinguishing a draft from its sent copy — which needs the mailbox
 * semantics this function deliberately does not model. Left open on purpose.
 *
 * e7 — THE THRESHOLD IS NOW MEASURABLE WITHOUT BEING MOVED. `opts.minMessages`
 * overrides the constant for ONE call; absent, the shipped constant is used and
 * the production spine is byte-identical. This exists so the choice of 1 can be
 * defended by a DECISION TABLE over the real population (a harness sweeps N and
 * reports the rank churn each N causes — mcp/test/messaging/e7-catchup-join-eval.mjs
 * `--min-messages`) instead of by the assertion in this comment. The number
 * itself is NOT changed here: picking it is an operator decision, and the diff
 * that measures it is not the diff that makes it.
 *
 * Each emitted record also carries `outbound_count` (the measured n — now the
 * number of DISTINCT outbound messages) and
 * `source: "reply-history"`. buildSpineFromRecords reads ONLY `name` and
 * `handles`, so both fields are inert to the merge — they exist so a reader can
 * attribute a vouch to the source and the count that bought it, rather than
 * inferring it from a name or a domain.
 *
 * NOTE ON COVERAGE — the two real bounds of this source, stated so no caller
 * mistakes it for a universal vouch:
 *   (1) IT IS MAIL-ONLY. It reads the MAIL ledger. It therefore cannot vouch an
 *       iMessage / WhatsApp / Telegram sender who never appears in mail, no
 *       matter how much the operator has replied to them on that platform.
 *   (2) IT IS BOUNDED BY THE CONNECTOR'S OWN HISTORY. Rows predating the
 *       recipient-recovery fix in mcp/lib/connectors/mail.js carry no To:/Cc:
 *       (the .emlx body does not resolve for Sent mail), so they contribute
 *       nothing until re-ingested. Newly polled mail carries recipients.
 */
export const REPLY_HISTORY_MIN_MESSAGES = 1;

export async function readReplyHistoryContacts(opts = {}) {
  const out = [];
  // The threshold is a PARAMETER with the shipped constant as its default, so an
  // absent opt is byte-identical to the pre-e7 behaviour. Non-finite / <1 values
  // fall back to the constant rather than silently admitting everything.
  const minMessages =
    Number.isFinite(opts.minMessages) && opts.minMessages >= 1
      ? Math.floor(opts.minMessages)
      : REPLY_HISTORY_MIN_MESSAGES;
  const path =
    typeof opts.mailLedgerPath === "string"
      ? opts.mailLedgerPath
      : DEFAULT_MAIL_LEDGER_PATH;
  if (!path || !existsSync(path)) return out;

  let isOperatorFn = null;
  try {
    ({ isOperator: isOperatorFn } = await import("../identity/operator-identity.js"));
  } catch {
    return out; // no canonical identity => cannot tell outbound from inbound
  }
  const isOp = (addr) => {
    try {
      return isOperatorFn(addr, "mail") === true;
    } catch {
      return false;
    }
  };

  // e12: Map<handleKey, Set<messageKey>> — a SET, not an integer. See the
  // COUNTING note in the doc comment above: one sent message can be three
  // ledger rows (Gmail-IMAP mailbox-copy fan-out), so an integer counter
  // measures rows and reports messages.
  const counts = new Map();
  // Line ordinal over the WHOLE file, incremented before any skip, so it is a
  // stable per-row identifier independent of which rows the filters admit.
  let lineOrdinal = 0;
  try {
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");
    const rl = createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      lineOrdinal += 1;
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const parties = Array.isArray(row && row.parties) ? row.parties : [];
      if (parties.length < 2) continue; // sender only => no counterparty
      // OUTBOUND means the operator is the SENDER. Testing "operator appears in
      // parties" is wrong: parties is From ∪ To ∪ Cc, so every INBOUND message
      // addressed to the operator matches it too, turning this signal into
      // "anyone who emailed me" — which includes cold senders and is exactly
      // the weak signal this source exists to improve on. Measured: the loose
      // test yielded 484 "correspondents" against 6 genuine ones.
      const from = row && row.raw_content && row.raw_content.headers
        ? row.raw_content.headers.from
        : null;
      if (typeof from !== "string" || from === "") continue;
      const fromAddrs = from.match(/[\w.+-]+@[\w.-]+/g) || [];
      if (!fromAddrs.some((a) => isOp(a))) continue;

      // e12 — THE MESSAGE KEY. Preference order, most-to-least identifying:
      //   1. message-id header — the RFC 5322 identity of the MESSAGE. Every
      //      mailbox copy of one send carries the same value, which is exactly
      //      the collapse we want. 100% present on rows that reach here.
      //   2. source_msg_id — per-ROW (rowid:N), so it does NOT collapse the
      //      copies; it is here only so a header-less row still gets a stable
      //      key rather than an ordinal that shifts if the file is re-read.
      //   3. '#'+lineOrdinal — per-row-unique by construction.
      // Requirement (3) is NOT defensive padding: a shared null sentinel would
      // make every header-less row one "message", collapsing counts of 1/2/3
      // to 1/1/1 for the pre-header history this function must keep counting
      // exactly as it did before. The fallback chain therefore guarantees
      // DEFAULT-PATH BYTE-IDENTICALITY: with no message-id anywhere, set.size
      // equals the old row count, row for row.
      const headers = row && row.raw_content ? row.raw_content.headers : null;
      const msgIdRaw = headers && typeof headers["message-id"] === "string" ? headers["message-id"].trim() : "";
      const srcIdRaw = typeof row.source_msg_id === "string" ? row.source_msg_id.trim() : "";
      const msgKey = msgIdRaw !== "" ? msgIdRaw : srcIdRaw !== "" ? srcIdRaw : `#${lineOrdinal}`;

      for (const p of parties) {
        if (typeof p !== "string" || !p.includes("@")) continue;
        if (isOp(p)) continue;
        const key = normalizeHandleKey(p);
        if (key === null) continue;
        let seen = counts.get(key);
        if (seen === undefined) {
          seen = new Set();
          counts.set(key, seen);
        }
        seen.add(msgKey);
      }
    }
  } catch {
    return out;
  }

  for (const [handle, msgKeys] of counts) {
    // e12: the threshold is compared against DISTINCT messages. Same shape as
    // before, one field deeper — the emitted record is otherwise untouched.
    const n = msgKeys.size;
    if (n < minMessages) continue;
    // outbound_count / source are INERT to buildSpineFromRecords (it reads only
    // `name` and `handles`) — they are provenance for a reader, not merge input.
    out.push({ name: null, handles: [handle], outbound_count: n, source: "reply-history" });
  }
  return out;
}

/**
 * SPINE_SOURCES — the saved-contact source REGISTRY.
 *
 * Each entry is { key, scoped, read(opts) -> Promise<{name,handles[]}[]> }.
 * `scoped: true` marks a reader that honours an injected address-book scope and
 * may therefore run under pinnedSourcesOnly; everything else is suppressed in
 * that mode so a hermetic caller can never reach the live machine.
 *
 * Extending the spine = appending here. buildContactSpine never changes.
 */
export const SPINE_SOURCES = Object.freeze([
  {
    key: "address-book",
    scoped: true,
    read: (opts) =>
      readMacOSContacts(
        Array.isArray(opts.addressBookDbPaths)
          ? opts.addressBookDbPaths
          : resolveAddressBookDbPaths(opts.addressBookSourcesDir),
      ),
  },
  {
    key: "messaging-contacts",
    scoped: false,
    read: (opts) => readWhatsAppContacts(opts.whatsappContactsPath),
  },
  {
    key: "reply-history",
    scoped: false,
    read: (opts) => readReplyHistoryContacts(opts),
  },
]);

let _memo = null;

/**
 * buildContactSpine — read every available saved-contact store ONCE per
 * process and return the merged spine. Memoized; injectable for tests.
 * NEVER throws: any unreadable source contributes zero records.
 */
export async function buildContactSpine(opts = {}) {
  if (_memo && !opts.force) return _memo;
  const promise = (async () => {
    const records = [];
    const sources = { telegram: "unavailable:encrypted-postbox" };

    // Iterate the SOURCE REGISTRY rather than a hardcoded sequence. Adding a
    // saved-contact store is now an append to SPINE_SOURCES — the merge, the
    // scoping contract, and the failure handling below are never touched
    // (open/closed). Each reader is substitutable: same records[] contract,
    // same fail-soft obligation, so one unreadable store only ever shrinks the
    // spine.
    for (const src of SPINE_SOURCES) {
      // pinnedSourcesOnly: honour a caller that injected explicit sources —
      // only readers marked as address-book-scoped may run. This is the
      // hermetic/offline contract; it lets contacts-anchor.js request scoping
      // without naming any store.
      if (opts.pinnedSourcesOnly === true && src.scoped !== true) continue;
      try {
        const rows = await src.read(opts);
        sources[src.key] = Array.isArray(rows) ? rows.length : 0;
        if (Array.isArray(rows)) records.push(...rows);
      } catch {
        sources[src.key] = "error";
      }
    }

    const spine = buildSpineFromRecords(records);
    spine.stats.sources = sources;
    return spine;
  })();
  const spine = await promise;
  // A FORCED build is a scoped/hermetic build (pinned sources). It must never
  // become the process-wide memo, or a test's empty spine would be served to
  // every later production caller.
  if (!opts.force) _memo = spine;
  return spine;
}

/** Test-only: drop the memo so suites stay order-independent. */
export function __resetContactSpineMemo() {
  _memo = null;
}

/**
 * resolvePerson — the O(1) lookup the ranking path uses.
 * Returns {person_id, name, is_contact:true} for a handle belonging to a saved
 * contact, else null (caller keeps its per-platform fallback identity).
 */
export function resolvePerson(spine, handles) {
  if (!spine || !(spine.personByHandle instanceof Map)) return null;
  const list = Array.isArray(handles) ? handles : [handles];
  for (const h of list) {
    const key = normalizeHandleKey(h);
    if (key === null) continue;
    const pid = spine.personByHandle.get(key);
    if (pid) {
      return {
        person_id: pid,
        name: spine.nameByPerson.get(pid) || null,
        is_contact: true,
      };
    }
  }
  return null;
}
