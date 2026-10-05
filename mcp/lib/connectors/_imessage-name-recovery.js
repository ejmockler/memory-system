// _imessage-name-recovery.js — WU-imessage-name-recovery.
//
// PURPOSE:
//   Recover a human LABEL for an opaque iMessage chat_guid by joining the
//   thread-bearing identifiers the imessage connector already persists in
//   raw_content against two read-only side tables:
//     - chat.db        : chat_guid -> chat.display_name (group subject)
//                        chat_guid -> participant handle.id list (style 43/45)
//     - AddressBook    : handle.id (phone/email) -> Contacts display name
//   ...producing a chat_guid -> label map that conversation-index.js layers on
//   top of the existing opaque `daemon:thread:chat:<chat_guid>:day:<day>`
//   descriptor.
//
// THESIS #1 (never mutate fact rows): this is a DERIVED side-table join. It
//   NEVER opens chat.db or AddressBook for write; both are opened read-only
//   (?mode=ro). The resolved label map is persisted into the imessage
//   connector's own state.json (a derived cursor file, NOT the ledger) and
//   re-resolved only when a source-DB mtime changes. Recovered names are PII
//   and stay in the local derived index ONLY.
//
// LABEL ORDER (per the WU grounding plan, imessage_recovery):
//   1. group with a HUMAN display_name (Apple auto-tokens gated out)   -> display_name
//   2. group with no human subject but >=1 resolved contact            -> "Group: <names>(+N)"
//   3. DM whose single handle resolves to a contact / business name    -> contact name
//   4. unresolved                                                       -> null (caller keeps
//                                                                          its current opaque label)
//
// NORMALIZATION (must be byte-identical to how Contacts and chat.db store the
//   same identifier so the join is deterministic):
//   - phone : strip every non-digit, keep the LAST 10 digits. handle.id is
//             E.164 (+1...) and ZFULLNUMBER appears in >=5 human formats; the
//             last-10 rule collapses both. Shorter strings (SMS shortcodes
//             like "55501") never reach 10 digits -> never match a contact.
//   - email : lower(trim()).
//
// DEFENSIVE: every fs/sqlite op is wrapped; an unreadable chat.db / locked
//   AddressBook / unresolved handle degrades to an empty map (caller keeps the
//   opaque label). This module NEVER throws to the connector poll path or the
//   conversation-index rebuild path.
//
// HERMETICITY: all source paths are injectable. Tests build tiny in-tmpdir
//   sqlite DBs and pass chatDbPath + addressBookDbPaths explicitly; the live
//   ~/Library paths are only the production defaults and are never read by the
//   suite.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Frozen CAPS + production default paths
// ---------------------------------------------------------------------------

export const NAME_RECOVERY_VERSION = "imessage-name-recovery@1.0.0";

/** Production default chat.db path (Messages). Tests override. */
export const DEFAULT_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

/** Production AddressBook Sources directory. Each Source/<UUID>/ holds an
 *  AddressBook-v22.abcddb. The top-level AddressBook-v22.abcddb is the empty
 *  aggregate db (2 placeholder records on this operator) and is deliberately
 *  NOT globbed. */
export const DEFAULT_ADDRESSBOOK_SOURCES_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "AddressBook",
  "Sources",
);

export const NAME_RECOVERY_CAPS = Object.freeze({
  // chat.style discriminator (verified against this operator's chat.db):
  //   45 == 1:1 DM, 43 == group. We do not hard-fail on other values; the
  //   participant-count + display_name heuristics still apply.
  STYLE_DM: 45,
  STYLE_GROUP: 43,
  // Cap the number of contact names spelled out in a "Group: a, b, c (+N)"
  // label so a 40-person group does not produce a 2KB label string.
  GROUP_LABEL_MAX_NAMES: 3,
  // Cap on resolved handles per chat we will scan (defense against a
  // pathological chat_handle_join row count).
  MAX_PARTICIPANTS_PER_CHAT: 256,
  // The label-map cache schema persisted into state.json under
  // state.name_recovery. Bump on any structural change.
  STATE_SCHEMA_VERSION: "v1",
});

// ---------------------------------------------------------------------------
// Pure normalization + gating helpers
// ---------------------------------------------------------------------------

/**
 * normalizePhone — strip non-digits, return the last 10 digits, or null when
 * fewer than 10 digits are present (SMS shortcodes / malformed handles never
 * normalize to a joinable key). E.164 "+15555550123" and the Contacts forms
 * "(555) 555-0123" / "555-555-0123" / "+1 555 555 0123" all collapse to
 * "5555550123".
 */
export function normalizePhone(s) {
  if (typeof s !== "string") return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/** normalizeEmail — lower(trim()). Returns null on empty / non-string. */
export function normalizeEmail(s) {
  if (typeof s !== "string") return null;
  const out = s.trim().toLowerCase();
  return out.length > 0 ? out : null;
}

/** isEmailHandle — a handle.id is an email iff it contains an '@' and is not
 *  a urn:biz / business surface (those carry ':' framing, handled separately). */
export function isEmailHandle(h) {
  return typeof h === "string" && h.includes("@") && !h.startsWith("urn:");
}

/**
 * isAppleAutoToken — gate out machine-generated chat.display_name values that
 * are NOT human-chosen group subjects. Apple auto-stamps short hex/base36
 * tokens (e.g. "wDYf", "424484", "b11550", "15555550144_jsidet", "817.c")
 * onto group rows that have no operator-set subject. A human group subject is
 * something like "Family", "Trip 2024", "Roommates". The heuristic:
 *   - empty / whitespace                          -> auto (reject)
 *   - matches a pure-token shape (all alnum/._-,
 *     no spaces, AND (looks hex-ish OR mostly digits
 *     OR <=6 chars with mixed case))              -> auto (reject)
 * A name with a space, or a longer human word, passes. The bias is toward
 * REJECTING ambiguous tokens (we'd rather fall through to the contact-name
 * join than surface "b11550" as a "name").
 */
export function isAppleAutoToken(name) {
  if (typeof name !== "string") return true;
  const n = name.trim();
  if (n.length === 0) return true;
  // Any whitespace => human-typed multi-word subject. Accept.
  if (/\s/.test(n)) return false;
  // Pure digits (e.g. "424484", "15555550143") => auto.
  if (/^\d+$/.test(n)) return true;
  // Token charset only (alnum + . _ -) with no separators a human would use.
  if (/^[A-Za-z0-9._-]+$/.test(n)) {
    // Hex-looking (all chars in [0-9a-f] and at least one digit) => auto.
    if (/^[0-9a-f]+$/.test(n) && /\d/.test(n)) return true;
    // Contains a digit and is short/token-shaped (e.g. "a237576", "817.c",
    // "15555550144_jsidet") => auto.
    if (/\d/.test(n)) return true;
    // Short mixed-case opaque token with no vowel cluster (e.g. "wDYf",
    // "BSLhO") => auto. A short all-letters token that has no lowercase
    // vowel is almost certainly an Apple token, not an English word.
    if (n.length <= 6 && /[a-z]/.test(n) && /[A-Z]/.test(n) && !/[aeiou]/.test(n)) {
      return true;
    }
  }
  return false;
}

/**
 * contactFullName — assemble a display name from a ZABCDRECORD row.
 *   first + last (space-joined) wins; else organization (business name); else
 *   nickname; else null. Apple stores a separate ZNICKNAME we accept as a
 *   last resort.
 */
export function contactFullName({ first, last, org, nickname } = {}) {
  const f = typeof first === "string" ? first.trim() : "";
  const l = typeof last === "string" ? last.trim() : "";
  const parts = [f, l].filter((p) => p.length > 0);
  if (parts.length > 0) return parts.join(" ");
  const o = typeof org === "string" ? org.trim() : "";
  if (o.length > 0) return o;
  const nk = typeof nickname === "string" ? nickname.trim() : "";
  if (nk.length > 0) return nk;
  return null;
}

// ---------------------------------------------------------------------------
// sqlite plumbing (lazy node:sqlite import, read-only)
// ---------------------------------------------------------------------------

async function openReadOnly(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  try {
    // ?mode=ro path-mode keeps us strictly read-only even if readOnly option
    // semantics ever drift; the option is also set for belt-and-braces.
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/** statMtimeMs — best-effort source-db fingerprint for cache invalidation. */
export function statMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contact-map builder (AddressBook side)
// ---------------------------------------------------------------------------

/**
 * buildContactMaps — UNION across every AddressBook source db the maps
 *   normalizedPhone -> contact name
 *   normalizedEmail -> contact name
 * First non-null name for a key wins (sources are scanned in the order given).
 *
 * Returns { phoneToName: Map, emailToName: Map, sourcesRead, sourcesFailed }.
 * Defensive: a db that fails to open / query is skipped (counted in
 * sourcesFailed); the union of the readable ones is still returned.
 *
 * @param {string[]} addressBookDbPaths absolute paths to *.abcddb files.
 */
export async function buildContactMaps(addressBookDbPaths) {
  const phoneToName = new Map();
  const emailToName = new Map();
  let sourcesRead = 0;
  let sourcesFailed = 0;
  if (!Array.isArray(addressBookDbPaths)) {
    return { phoneToName, emailToName, sourcesRead, sourcesFailed };
  }
  for (const dbPath of addressBookDbPaths) {
    if (typeof dbPath !== "string" || dbPath.length === 0 || !existsSync(dbPath)) {
      continue;
    }
    const db = await openReadOnly(dbPath);
    if (db == null) {
      sourcesFailed += 1;
      continue;
    }
    let touched = false;
    try {
      // Phones.
      try {
        const rows = db
          .prepare(
            `SELECT p.ZFULLNUMBER AS num,
                    r.ZFIRSTNAME  AS first,
                    r.ZLASTNAME   AS last,
                    r.ZORGANIZATION AS org,
                    r.ZNICKNAME   AS nickname
             FROM ZABCDPHONENUMBER p
             JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER`,
          )
          .all();
        for (const row of rows) {
          const key = normalizePhone(row.num);
          if (key === null) continue;
          if (phoneToName.has(key)) continue;
          const name = contactFullName({
            first: row.first,
            last: row.last,
            org: row.org,
            nickname: row.nickname,
          });
          if (name) phoneToName.set(key, name);
        }
        touched = true;
      } catch {
        // Source missing the phone table / column variant — skip phones only.
      }
      // Emails.
      try {
        const rows = db
          .prepare(
            `SELECT e.ZADDRESS AS addr,
                    r.ZFIRSTNAME AS first,
                    r.ZLASTNAME  AS last,
                    r.ZORGANIZATION AS org,
                    r.ZNICKNAME  AS nickname
             FROM ZABCDEMAILADDRESS e
             JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER`,
          )
          .all();
        for (const row of rows) {
          const key = normalizeEmail(row.addr);
          if (key === null) continue;
          if (emailToName.has(key)) continue;
          const name = contactFullName({
            first: row.first,
            last: row.last,
            org: row.org,
            nickname: row.nickname,
          });
          if (name) emailToName.set(key, name);
        }
        touched = true;
      } catch {
        // Skip emails only.
      }
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    if (touched) sourcesRead += 1;
    else sourcesFailed += 1;
  }
  return { phoneToName, emailToName, sourcesRead, sourcesFailed };
}

/**
 * resolveHandleName — map one chat.db handle.id to a contact name via the
 * normalized maps. Email handles route to emailToName; everything else
 * normalizes as a phone. Returns null on a miss (including SMS shortcodes,
 * business urn:biz handles, international numbers absent from Contacts).
 */
export function resolveHandleName(handle, { phoneToName, emailToName } = {}) {
  if (typeof handle !== "string" || handle.length === 0) return null;
  if (isEmailHandle(handle)) {
    const key = normalizeEmail(handle);
    if (key === null) return null;
    return (emailToName instanceof Map ? emailToName.get(key) : null) || null;
  }
  const key = normalizePhone(handle);
  if (key === null) return null;
  return (phoneToName instanceof Map ? phoneToName.get(key) : null) || null;
}

// ---------------------------------------------------------------------------
// Chat-side reader (chat.db)
// ---------------------------------------------------------------------------

/**
 * readChatThreads — read chat.db into an array of thread descriptors:
 *   { guid, style, display_name, handles: string[] }
 * Defensive: returns [] on any open/query failure. Read-only.
 *
 * macOS schema variance: Ventura/Sonoma `chat` carries display_name; the
 * style column (45=DM, 43=group) is stable across versions. We do NOT depend
 * on cache_roomnames vs room_name here — display_name + style + the joined
 * handle list are sufficient for label derivation.
 */
export async function readChatThreads(chatDbPath) {
  const out = [];
  if (typeof chatDbPath !== "string" || !existsSync(chatDbPath)) return out;
  const db = await openReadOnly(chatDbPath);
  if (db == null) return out;
  try {
    let chats;
    try {
      chats = db
        .prepare(
          `SELECT ROWID AS rowid, guid AS guid, style AS style,
                  display_name AS display_name
           FROM chat`,
        )
        .all();
    } catch {
      return out;
    }
    let handleStmt;
    try {
      handleStmt = db.prepare(
        `SELECT h.id AS id
         FROM chat_handle_join chj
         JOIN handle h ON h.ROWID = chj.handle_id
         WHERE chj.chat_id = ?`,
      );
    } catch {
      handleStmt = null;
    }
    for (const c of chats) {
      const guid = typeof c.guid === "string" ? c.guid : null;
      if (guid === null) continue;
      const handles = [];
      if (handleStmt) {
        try {
          const hrows = handleStmt.all(c.rowid);
          for (const hr of hrows) {
            if (typeof hr.id === "string" && hr.id.length > 0) {
              handles.push(hr.id);
            }
            if (handles.length >= NAME_RECOVERY_CAPS.MAX_PARTICIPANTS_PER_CHAT) {
              break;
            }
          }
        } catch {
          // Leave handles=[] for this chat; label can still come from a
          // human display_name.
        }
      }
      out.push({
        guid,
        style: Number.isFinite(Number(c.style)) ? Number(c.style) : null,
        display_name:
          typeof c.display_name === "string" && c.display_name.length > 0
            ? c.display_name
            : null,
        handles,
      });
    }
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
// Label derivation (the join)
// ---------------------------------------------------------------------------

/**
 * deriveChatLabel — apply the WU label order to one thread descriptor.
 *
 * @param {{guid,style,display_name,handles:string[]}} thread
 * @param {{phoneToName:Map, emailToName:Map}} contactMaps
 * @returns {string|null} the human label, or null when nothing resolves.
 */
export function deriveChatLabel(thread, contactMaps) {
  if (thread == null || typeof thread !== "object") return null;
  const style = Number.isFinite(Number(thread.style)) ? Number(thread.style) : null;
  const handles = Array.isArray(thread.handles) ? thread.handles : [];
  const isGroup =
    style === NAME_RECOVERY_CAPS.STYLE_GROUP || handles.length > 1;

  // 1. Group with a HUMAN display_name.
  if (isGroup) {
    const dn = thread.display_name;
    if (typeof dn === "string" && !isAppleAutoToken(dn)) {
      return dn.trim();
    }
    // 2. Group with >=1 resolved contact -> "Group: a, b (+N)".
    const names = [];
    for (const h of handles) {
      const nm = resolveHandleName(h, contactMaps);
      if (nm && !names.includes(nm)) names.push(nm);
    }
    if (names.length > 0) {
      const shown = names.slice(0, NAME_RECOVERY_CAPS.GROUP_LABEL_MAX_NAMES);
      const extra = names.length - shown.length;
      const head = shown.join(", ");
      return extra > 0 ? `Group: ${head} (+${extra})` : `Group: ${head}`;
    }
    return null;
  }

  // 3. DM -> single handle's contact / business name.
  const handle = handles.length > 0 ? handles[0] : null;
  if (handle) {
    const nm = resolveHandleName(handle, contactMaps);
    if (nm) return nm;
  }
  return null;
}

// ---------------------------------------------------------------------------
// state.json persistence (the derived label-map cache)
// ---------------------------------------------------------------------------

/** readState — parse the connector state.json, or {} when absent/corrupt. */
function readState(statePath) {
  if (typeof statePath !== "string" || !existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/** writeState — atomic (tmp + rename), 0600. Defensive: swallows write errors
 *  (the label cache is derived; failing to persist it only forces a re-resolve
 *  next run, never blocks the connector). */
function writeStateAtomic(statePath, state) {
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, statePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * fingerprintSources — { chatDb: mtimeMs|null, addressBook: [mtimeMs|null, ...] }
 * for the cache-validity check. A change to ANY source mtime invalidates the
 * persisted label map (Contacts edits, new threads).
 */
function fingerprintSources(chatDbPath, addressBookDbPaths) {
  return {
    chat_db_mtime_ms: statMtimeMs(chatDbPath),
    addressbook_mtimes: (Array.isArray(addressBookDbPaths)
      ? addressBookDbPaths
      : []
    ).map((p) => statMtimeMs(p)),
  };
}

function fingerprintsEqual(a, b) {
  if (a == null || b == null) return false;
  if (a.chat_db_mtime_ms !== b.chat_db_mtime_ms) return false;
  const am = Array.isArray(a.addressbook_mtimes) ? a.addressbook_mtimes : [];
  const bm = Array.isArray(b.addressbook_mtimes) ? b.addressbook_mtimes : [];
  if (am.length !== bm.length) return false;
  for (let i = 0; i < am.length; i++) {
    if (am[i] !== bm[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * recoverImessageLabels — the public entry. Resolves chat_guid -> human label
 * by reading chat.db + AddressBook (read-only), gated by a state.json mtime
 * cache so the join is only recomputed when a source db changes.
 *
 * @param {object} opts
 * @param {string} [opts.chatDbPath]            default ~/Library/Messages/chat.db
 * @param {string[]} [opts.addressBookDbPaths]  explicit abcddb paths (tests)
 * @param {string} [opts.addressBookSourcesDir] dir to glob *.abcddb from when
 *                                              addressBookDbPaths is omitted
 * @param {string} [opts.statePath]             where to persist/read the cache
 * @param {boolean} [opts.persist=true]         persist the resolved map to state
 * @param {boolean} [opts.force=false]          ignore the mtime cache, re-resolve
 * @returns {Promise<{
 *   byChatGuid: Map<string,string>,         // chat_guid -> label
 *   handleToName: Map<string,string>,        // normalized lookups (forward use)
 *   fromCache: boolean,
 *   stats: { chats_seen, labeled, named_groups, group_via_contacts, dms_resolved,
 *            contacts_phones, contacts_emails, sources_read, sources_failed },
 * }>}
 */
export async function recoverImessageLabels(opts = {}) {
  const chatDbPath =
    typeof opts.chatDbPath === "string" ? opts.chatDbPath : DEFAULT_CHAT_DB_PATH;
  const addressBookDbPaths = Array.isArray(opts.addressBookDbPaths)
    ? opts.addressBookDbPaths
    : resolveAddressBookDbPaths(opts.addressBookSourcesDir);
  const statePath = typeof opts.statePath === "string" ? opts.statePath : null;
  const persist = opts.persist !== false;
  const force = opts.force === true;

  const fp = fingerprintSources(chatDbPath, addressBookDbPaths);

  // Cache hit: state.json carries a label map under name_recovery whose
  // fingerprint matches the current source mtimes.
  if (!force && statePath) {
    const state = readState(statePath);
    const cached = state && state.name_recovery;
    if (
      cached &&
      cached.schema_version === NAME_RECOVERY_CAPS.STATE_SCHEMA_VERSION &&
      fingerprintsEqual(cached.fingerprint, fp) &&
      cached.labels &&
      typeof cached.labels === "object"
    ) {
      const byChatGuid = new Map();
      for (const k of Object.keys(cached.labels)) {
        const v = cached.labels[k];
        if (typeof v === "string" && v.length > 0) byChatGuid.set(k, v);
      }
      return {
        byChatGuid,
        handleToName: new Map(),
        fromCache: true,
        stats:
          cached.stats && typeof cached.stats === "object"
            ? cached.stats
            : emptyStats(),
      };
    }
  }

  // Cache miss / forced: do the join.
  const contactMaps = await buildContactMaps(addressBookDbPaths);
  const threads = await readChatThreads(chatDbPath);

  const byChatGuid = new Map();
  const handleToName = new Map();
  const stats = emptyStats();
  stats.chats_seen = threads.length;
  stats.contacts_phones = contactMaps.phoneToName.size;
  stats.contacts_emails = contactMaps.emailToName.size;
  stats.sources_read = contactMaps.sourcesRead;
  stats.sources_failed = contactMaps.sourcesFailed;

  for (const thread of threads) {
    // Record forward-usable handle->name resolutions (for connector enrich).
    for (const h of thread.handles) {
      if (handleToName.has(h)) continue;
      const nm = resolveHandleName(h, contactMaps);
      if (nm) handleToName.set(h, nm);
    }
    let label;
    try {
      label = deriveChatLabel(thread, contactMaps);
    } catch {
      label = null;
    }
    if (typeof label === "string" && label.length > 0) {
      byChatGuid.set(thread.guid, label);
      stats.labeled += 1;
      const isGroup =
        thread.style === NAME_RECOVERY_CAPS.STYLE_GROUP ||
        thread.handles.length > 1;
      if (isGroup) {
        if (label.startsWith("Group: ")) stats.group_via_contacts += 1;
        else stats.named_groups += 1;
      } else {
        stats.dms_resolved += 1;
      }
    }
  }

  if (persist && statePath) {
    const state = readState(statePath);
    const labels = {};
    for (const [k, v] of byChatGuid) labels[k] = v;
    state.name_recovery = {
      schema_version: NAME_RECOVERY_CAPS.STATE_SCHEMA_VERSION,
      version: NAME_RECOVERY_VERSION,
      built_at: new Date().toISOString(),
      fingerprint: fp,
      stats,
      labels,
    };
    writeStateAtomic(statePath, state);
  }

  return { byChatGuid, handleToName, fromCache: false, stats };
}

function emptyStats() {
  return {
    chats_seen: 0,
    labeled: 0,
    named_groups: 0,
    group_via_contacts: 0,
    dms_resolved: 0,
    contacts_phones: 0,
    contacts_emails: 0,
    sources_read: 0,
    sources_failed: 0,
  };
}

/**
 * resolveAddressBookDbPaths — glob the AddressBook Sources dir for every
 * Source/<UUID>/AddressBook-v22.abcddb. The top-level aggregate db is NOT
 * included (it is the empty 2-record placeholder on this operator). Returns []
 * when the dir is unreadable. Synchronous + defensive.
 */
export function resolveAddressBookDbPaths(sourcesDir) {
  const dir =
    typeof sourcesDir === "string" && sourcesDir.length > 0
      ? sourcesDir
      : DEFAULT_ADDRESSBOOK_SOURCES_DIR;
  const out = [];
  try {
    if (!existsSync(dir)) return out;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const ent of entries) {
      if (!ent.isDirectory || !ent.isDirectory()) continue;
      const candidate = join(dir, ent.name, "AddressBook-v22.abcddb");
      if (existsSync(candidate)) out.push(candidate);
    }
  } catch {
    return out;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test-only internal surface
// ---------------------------------------------------------------------------

export const __internal = Object.freeze({
  buildContactMaps,
  readChatThreads,
  deriveChatLabel,
  resolveHandleName,
  contactFullName,
  isAppleAutoToken,
  normalizePhone,
  normalizeEmail,
  isEmailHandle,
  fingerprintSources,
  fingerprintsEqual,
  readState,
  writeStateAtomic,
  resolveAddressBookDbPaths,
});
