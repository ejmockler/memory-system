// alias-candidates.js — B2 (memory-roots): operator alias-candidate tally.
//
// The identity map (lib/identity/operator-identity.js EMAILS, loaded from
// the per-host config file) is hand-maintained, and more than once an
// operator mailbox (an institutional address, send-as aliases on
// operator-owned domains) was found unregistered by accident. Nothing
// observed which addresses receive mail
// in the operator's OWN Apple Mail accounts. This module is that observer.
//
// It rides the existing 7-day mail tail scan (lib/ingest/source-effective-
// empty-rate.js computeEffectiveEmptyRate — every in-window mail row is
// already JSON.parsed there) and adds ZERO bytes, blocks, or fs opens: the
// scan hands each parsed row to observe(), and summarize() runs once at the
// end. Two keys, both config-free:
//
//   account_dominant — the address is the top To/Cc recipient of one Apple
//       Mail account (raw_content.mailbox_url `imap://<UUID>/...`), holding
//       >= CAPS.OPERATOR_ALIAS_CANDIDATE.min_account_share of that account's
//       rows in an account with >= min_account_rows rows. A mailbox receives
//       mail addressed to itself, so the axis IS the account's own address.
//   name_token — the address's local-part shares an alpha token (>= 3 chars)
//       with a registered EMAILS local-part AND it received >= min_direct_rows
//       INBOUND SOLE-recipient direct mails AND it holds a nonzero share of
//       some Apple Mail account (at least one row with a parseable
//       mailbox_url). A row counts as inbound-sole for an address iff ALL of:
//         - direct: Stage-0 rules 1-4 silent (listDropReason === null);
//         - inbound: no From: address is registered — the operator's own
//           OUTBOUND mail (From: a registered address To: a third party)
//           is the third party's address, not an alias (B6);
//         - sole-To: the address is in To:, every other To: address is
//           registered (a self-forward To: alias + a registered address
//           still counts),
//           and the row carries no Cc:;
//         - not in a folder the operator already curated away: Rule 0's
//           Junk/Spam/Trash/Bulk Mail/Deleted Messages test
//           (isOperatorJunkFolder, one regex definition) or a Drafts
//           folder, where To: is whoever the operator was writing to (B6).
//       Catches low-volume forwarders invisible to dominance; a third-party
//       Cc: on a mail To: someone else is never sole and never elects (B5).
//
// Registered addresses (isOperator(addr, "mail")) count toward account row
// totals but are NEVER candidates, so a fully registered map yields [].
//
// PII bound: a candidate carries only the address and counts — no subject,
// message-id, mailbox path or body. The name_token key is guarded in code
// (inbound: no registered From:; sole-To on direct rows with every other
// To: registered; no Cc:; not in a Junk/Spam/Trash/Bulk Mail/Deleted
// Messages or Drafts folder; nonzero account share) so a third party merely
// Cc'd on, written to, or drafted to by the operator cannot be named; the
// account_dominant key names only the top recipient of one of the
// operator's OWN accounts.
// Surface: `source_health_probes.mail.alias_candidates` (the snapshot passes
// through the connectors-list tool unmodified) and the ADVISORY
// `operator_alias_candidate:` health_notes[] string — no new top-level health
// key (closed envelope), no connectors_list.warnings[] entry, no level change.
//
// Pure: no fs, no network. Imports only the five collaborators below.

import { extractEmails } from "../connectors/mail.js";
import { isOperatorJunkFolder, listDropReason } from "../ingest/stage0/mail.js";
import { getOperatorIdentities, isOperator } from "./operator-identity.js";
import { CAPS } from "../validation.js";

// Apple Mail account key: the UUID authority of the mailbox URL.
const ACCOUNT_RE = /^imap:\/\/([^\/]+)/;
const MIN_TOKEN_LEN = 3;

function localPartTokens(email) {
  if (typeof email !== "string") return [];
  const at = email.indexOf("@");
  const local = (at === -1 ? email : email.slice(0, at)).toLowerCase();
  return local.split(/[^a-z]+/).filter((t) => t.length >= MIN_TOKEN_LEN);
}

// deriveNameTokens — alpha tokens (>= 3 chars, split on /[^a-z]+/ after
// lowercasing) of every registered email's local-part, as a Set. E.g.
// alex.example@example.com and ops@example.org yield {alex, example, ops}.
export function deriveNameTokens(emails) {
  const out = new Set();
  if (!Array.isArray(emails)) return out;
  for (const e of emails) for (const t of localPartTokens(e)) out.add(t);
  return out;
}

function finiteOr(v, dflt) {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function resolveCaps(opts) {
  const c = opts.caps && typeof opts.caps === "object" ? opts.caps : CAPS.OPERATOR_ALIAS_CANDIDATE;
  return {
    min_direct_rows: finiteOr(c && c.min_direct_rows, 3),
    min_account_share: finiteOr(c && c.min_account_share, 0.5),
    min_account_rows: finiteOr(c && c.min_account_rows, 5),
    name_tokens_override: c && Array.isArray(c.name_tokens_override) ? c.name_tokens_override : null,
  };
}

// Registered-address predicate. Seams (tests / the live injection check):
// opts.isRegistered(addr) wins; else opts.registeredEmails (array) is the
// whole registry; else the real isOperator(addr, "mail").
function resolveRegistered(opts) {
  if (typeof opts.isRegistered === "function") return (addr) => opts.isRegistered(addr) === true;
  if (Array.isArray(opts.registeredEmails)) {
    const set = new Set(
      opts.registeredEmails.filter((e) => typeof e === "string").map((e) => e.toLowerCase())
    );
    return (addr) => set.has(addr);
  }
  return (addr) => isOperator(addr, "mail") === true;
}

// Name-token set. Seams: opts.nameTokens (Set or array) wins; else the CAPS
// env override when non-null; else derived from opts.registeredEmails when
// given, else from the live registry.
function resolveNameTokens(opts, caps) {
  if (opts.nameTokens instanceof Set) {
    return new Set([...opts.nameTokens].map((t) => String(t).toLowerCase()));
  }
  if (Array.isArray(opts.nameTokens)) {
    return new Set(opts.nameTokens.map((t) => String(t).toLowerCase()));
  }
  if (caps.name_tokens_override && caps.name_tokens_override.length > 0) {
    return new Set(caps.name_tokens_override.map((t) => String(t).toLowerCase()));
  }
  const emails = Array.isArray(opts.registeredEmails)
    ? opts.registeredEmails
    : getOperatorIdentities().emails;
  return deriveNameTokens(emails);
}

// createAliasCandidateTally — {observe(parsedRow), summarize()}.
//
// observe() reads raw_content.headers.{to,cc} through extractEmails
// (lowercased; angle-bracket and bare forms), dedupes addresses within the
// row, keys the account on raw_content.mailbox_url, and calls the row
// "direct" iff listDropReason(rc, rc.headers) === null. A row without a
// parseable account still counts per address (total/direct) but joins no
// account tally. The internal sole_direct_rows counter (never emitted)
// increments for a To: address only on a direct row that is inbound (no
// From: address registered), carries no Cc:, whose other To: addresses are
// all registered, and whose mailbox_url is neither an operator junk folder
// (isOperatorJunkFolder) nor a Drafts folder — the name_token key's guard.
// Only that counter reads From: and the folder; total_rows / direct_rows /
// byAccount / accountRows (the account_dominant key) are untouched.
// Malformed input never throws: a non-object row, a null raw_content,
// headers that are not an object, a non-string From: or mailbox_url are
// simply skipped (extractEmails returns [] for non-string input).
//
// summarize() applies CAPS.OPERATOR_ALIAS_CANDIDATE (opts.caps seam) and
// returns [{address, direct_rows, total_rows, account_share, reason}] sorted
// by direct_rows desc (address asc as tiebreak); account_share is the max
// over accounts of rows(addr,acct)/rows(acct), 3 dp; reason is
// "account_dominant" | "name_token" | "both".
export function createAliasCandidateTally(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const caps = resolveCaps(o);
  const isRegistered = resolveRegistered(o);
  const nameTokens = resolveNameTokens(o, caps);

  // address -> { total_rows, direct_rows, byAccount: Map<account, rows> }
  const byAddress = new Map();
  // account -> rows seen in that account (every row with a parseable key,
  // registered recipients included — they are the denominator).
  const accountRows = new Map();

  function observe(parsed) {
    if (!parsed || typeof parsed !== "object") return;
    const rc = parsed.raw_content;
    if (!rc || typeof rc !== "object") return;
    const headers = rc.headers && typeof rc.headers === "object" ? rc.headers : {};
    const m = typeof rc.mailbox_url === "string" ? ACCOUNT_RE.exec(rc.mailbox_url) : null;
    const account = m ? m[1] : null;
    if (account !== null) accountRows.set(account, (accountRows.get(account) || 0) + 1);

    const toAddrs = [...new Set(extractEmails(headers.to))];
    const ccAddrs = extractEmails(headers.cc);
    const addrs = new Set([...toAddrs, ...ccAddrs]);
    if (addrs.size === 0) return;
    const direct = listDropReason(rc, headers) === null;
    // B6: the operator's own outbound mail (From: registered) names the
    // third party in To:, and Junk/Spam/Trash/Bulk Mail/Deleted Messages
    // or Drafts folders hold rows the operator curated away or authored —
    // neither is evidence that To: is an operator alias. Both feed ONLY
    // the sole predicate below.
    const fromAddrs = extractEmails(headers.from);
    const outbound = fromAddrs.some((a) => isRegistered(a));
    const excludedFolder =
      typeof rc.mailbox_url === "string" &&
      (isOperatorJunkFolder(rc.mailbox_url) || /\/Drafts\b/i.test(rc.mailbox_url));
    for (const addr of addrs) {
      let entry = byAddress.get(addr);
      if (!entry) {
        entry = { total_rows: 0, direct_rows: 0, sole_direct_rows: 0, byAccount: new Map() };
        byAddress.set(addr, entry);
      }
      entry.total_rows += 1;
      if (direct) entry.direct_rows += 1;
      // Inbound sole recipient: not outbound, not in an excluded folder, in
      // To: (a Cc-only address is never sole), no Cc: on the row, and every
      // other To: address registered (self-forwards To: alias + a registered
      // address keep counting; a third party alongside does not).
      if (
        direct &&
        !outbound &&
        !excludedFolder &&
        ccAddrs.length === 0 &&
        toAddrs.includes(addr) &&
        toAddrs.every((a) => a === addr || isRegistered(a))
      ) {
        entry.sole_direct_rows += 1;
      }
      if (account !== null) {
        entry.byAccount.set(account, (entry.byAccount.get(account) || 0) + 1);
      }
    }
  }

  function summarize() {
    const out = [];
    for (const [address, entry] of byAddress) {
      if (isRegistered(address)) continue;
      let maxShare = 0;
      let dominant = false;
      for (const [account, n] of entry.byAccount) {
        const total = accountRows.get(account) || 0;
        if (total <= 0) continue;
        const share = n / total;
        if (share > maxShare) maxShare = share;
        if (total >= caps.min_account_rows && share >= caps.min_account_share) dominant = true;
      }
      const tokenHit = localPartTokens(address).some((t) => nameTokens.has(t));
      const nameToken = tokenHit && entry.sole_direct_rows >= caps.min_direct_rows && maxShare > 0;
      if (!dominant && !nameToken) continue;
      out.push({
        address,
        direct_rows: entry.direct_rows,
        total_rows: entry.total_rows,
        account_share: Math.round(maxShare * 1000) / 1000,
        reason: dominant && nameToken ? "both" : dominant ? "account_dominant" : "name_token",
      });
    }
    out.sort(
      (a, b) =>
        b.direct_rows - a.direct_rows ||
        (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)
    );
    return out;
  }

  return { observe, summarize };
}

// buildAliasCandidateHealthNotes — pure formatter for the memory_health
// note strings, mirroring buildEmptyRateHealthNotes in
// lib/ingest/source-effective-empty-rate.js. Input is the MAIL snapshot
// (the `mail` entry of computeEffectiveEmptyRatesForSources). Returns [] on
// null/absent input or when alias_candidates is absent / not an array.
//
//   operator_alias_candidate: <addr> (N direct non-list mails in <W>d, <reason>[, share=D.DDD])
//
// The share suffix appears only for account-dominant reasons
// ("account_dominant" | "both"); a name-token-only hit has no meaningful share.
// share is rendered at 3 dp FIXED (0.889, 0.750, 1.000 — never "0.75" or
// "1"), so one regex `(, share=[01]\.\d{3})?` pins every note (B5).
export function buildAliasCandidateHealthNotes(mailSnapshot) {
  const notes = [];
  if (!mailSnapshot || typeof mailSnapshot !== "object") return notes;
  const candidates = mailSnapshot.alias_candidates;
  if (!Array.isArray(candidates)) return notes;
  const windowDays =
    typeof mailSnapshot.window_days === "number" && Number.isFinite(mailSnapshot.window_days)
      ? mailSnapshot.window_days
      : "?";
  for (const c of candidates) {
    if (!c || typeof c !== "object" || typeof c.address !== "string") continue;
    const reason = typeof c.reason === "string" ? c.reason : "unknown";
    const share =
      (reason === "account_dominant" || reason === "both") &&
      typeof c.account_share === "number" &&
      Number.isFinite(c.account_share)
        ? `, share=${c.account_share.toFixed(3)}`
        : "";
    notes.push(
      `operator_alias_candidate: ${c.address} (${c.direct_rows} direct non-list mails in ${windowDays}d, ${reason}${share})`
    );
  }
  return notes;
}
