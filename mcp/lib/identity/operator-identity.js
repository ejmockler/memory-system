// operator-identity.js
//
// Unified operator-identity map. Single source of truth for "is this person
// the operator?" across every ingest connector (git-log-local, github-events,
// imessage, screentime, mail, etc.).
//
// Background (R42): before this module, operator identity was scattered:
//   - the git-log connector held its own default operator e-mail list
//   - the mail connector held a *separate* canonical + aliases map
//   - github-events looked up usernames per-call with no shared list
//   - imessage inferred operator handles from phone-number heuristics
// Drift between these lists meant the same operator authoring the same
// change got classified first_party in one source and third_party_inferred
// in another. R42 consolidates the discipline: one module, one map, all
// consumers.
//
// WHERE THE DATA LIVES. This module ships NO identity. The operator's
// addresses, logins and handles are per-host configuration, read from one
// JSON file:
//
//   process.env.MEMORY_OPERATOR_IDENTITY_FILE, when set, else
//   <MEMORY_ROOT>/config/operator-identity.json
//
// The file is untracked (.gitignore keeps config/*.json out of the tree);
// config/operator-identity.example.json is the committed, documented
// template. Schema tag: operator-identity-config/v1. Fields, all optional,
// each an array of strings unless noted:
//
//   emails                     — every address the operator sends or commits
//                                as (mail, git author, send-as aliases).
//   github_usernames           — operator-controlled GitHub user logins.
//   github_orgs                — GitHub organizations the operator belongs to.
//   imessage_handles           — Apple-ID e-mail or phone handles.
//   phone_numbers              — E.164 phone numbers.
//   hostname_derived_emails    — the subset of `emails` that git synthesised
//                                from user@hostname because user.email was
//                                not configured. Over-trusted on shared
//                                machines; drives the dominance warning.
//   hostname_derived_review_by — string (ISO date) or null: when the
//                                hostname-derived entries should be reviewed.
//   github_org_actor_logins    — org logins that count as the operator when
//                                they appear as an event ACTOR on a GitHub
//                                source (see isOperator). Deliberately a
//                                separate list from github_orgs: listing an
//                                org as a membership does not make an actor
//                                with that login the operator.
//
// Any other key (schema, _comment, description, …) is ignored, so a config
// file can document itself.
//
// FAILURE MODES.
//   - File absent (ENOENT): the identity is EMPTY — every list is [], nobody
//     is the operator, and one line on stderr says how to configure it. This
//     is the same degradation an unregistered address already gets
//     (consent_basis falls back to third-party); nothing throws.
//   - File present but unreadable, not JSON, not an object, or carrying a
//     wrong-typed field: the import THROWS an Error naming the file. A
//     half-read identity would silently mis-attribute rows in append-only
//     ledgers, so a broken config must stop the process.
//
// NO IMPLICIT OPERATOR. Nothing derived from the running host (user name,
// hostname) enters the identity unless the config file lists it. On an
// unconfigured host a synthesised user@hostname address would make whoever
// runs the code a silent operator.
//
// Institution-issued addresses can be reassigned after the operator leaves;
// a future revision (R42-v2, planned) should scope identifiers by
// (email, repo_path_glob) or (email, time_window) so neither they nor
// hostname-derived addresses are over-trusted. Until then the
// hostname-derived entries carry an explicit review date in the config.
//
// ES module. Data + small helpers. At import time it performs exactly ONE
// synchronous read of ONE file and depends only on node builtins,
// ../config.js (MEMORY_ROOT) and the telemetry module below — no network,
// no daemon dependencies — so every consumer can import it from any tier
// without worrying about init order. The file is read once: a change to it
// takes effect on the next process start. Loaded-at timestamp is captured
// at module-load and surfaced via getIdentityHealth() so the daemon health
// endpoint can show "identity map loaded N entries at T".

// F-NEW-W3-R42-HOSTNAME-LAZY-IMPORT-RACE — eagerly import the telemetry
// layer at module-load time so the FIRST emitHostnameDerivedWarning call
// in a fresh process actually increments the recordDrop counter. Pre-W3
// the import was deferred via `await import("../ingest/stage0/telemetry.js")`
// inside getTelemetryModule(); the first warn-trigger kicked off the
// load but the recordDrop call SKIPPED because _telemetryModule was still
// null when safeRecordDrop checked it. The next warn-trigger then won —
// but the warn is debounced to once per hour, so the first poll per
// process under-counted by one. Eager-importing at the top here costs
// the load once at daemon startup (which already loads STORAGE_DIR +
// envelope.serverTs anyway) and closes the race for every subsequent
// warn including the first one.
//
// CIRCULAR-DEP CHECK: telemetry.js does NOT import operator-identity.js
// today; this eager import is safe. If a future telemetry expansion adds
// an identity import, the circular would need a single-pass break (e.g.
// move the telemetry sink call into a one-off async post-startup phase).
import * as _telemetryStaticModule from "../ingest/stage0/telemetry.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_ROOT } from "../config.js";

const LOADED_AT = new Date().toISOString();

const CONFIG_SCHEMA = "operator-identity-config/v1";
const EXAMPLE_CONFIG_RELPATH = "config/operator-identity.example.json";

// Resolved once at module load; see WHERE THE DATA LIVES above.
const IDENTITY_FILE =
  process.env.MEMORY_OPERATOR_IDENTITY_FILE ||
  join(MEMORY_ROOT, "config", "operator-identity.json");

const LIST_FIELDS = Object.freeze([
  "emails",
  "github_usernames",
  "github_orgs",
  "imessage_handles",
  "phone_numbers",
  "hostname_derived_emails",
  "github_org_actor_logins",
]);

// loadIdentityConfig — one synchronous read. ENOENT => empty identity plus
// one stderr hint line (stderr only: callers parse stdout). Anything else
// wrong with a PRESENT file throws an Error naming the file.
function loadIdentityConfig(file) {
  const out = { hostname_derived_review_by: null };
  for (const field of LIST_FIELDS) out[field] = [];

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      process.stderr.write(
        `[operator-identity] no operator identity configured: ${file} not found; ` +
          `nobody is treated as the operator. Copy ${EXAMPLE_CONFIG_RELPATH} to that ` +
          `path (or set MEMORY_OPERATOR_IDENTITY_FILE) and restart.\n`,
      );
      return out;
    }
    throw new Error(
      `[operator-identity] cannot read operator identity file ${file}: ` +
        `${err && err.message ? err.message : err}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `[operator-identity] operator identity file ${file} is not valid JSON ` +
        `(${CONFIG_SCHEMA}): ${err && err.message ? err.message : err}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `[operator-identity] operator identity file ${file} must hold a JSON object ` +
        `(${CONFIG_SCHEMA}); see ${EXAMPLE_CONFIG_RELPATH}`,
    );
  }

  for (const field of LIST_FIELDS) {
    const value = parsed[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new Error(
        `[operator-identity] operator identity file ${file}: field "${field}" ` +
          `must be an array of strings (${CONFIG_SCHEMA})`,
      );
    }
    out[field] = [...value];
  }

  const reviewBy = parsed.hostname_derived_review_by;
  if (reviewBy !== undefined && reviewBy !== null) {
    if (typeof reviewBy !== "string") {
      throw new Error(
        `[operator-identity] operator identity file ${file}: field ` +
          `"hostname_derived_review_by" must be a string or null (${CONFIG_SCHEMA})`,
      );
    }
    out.hostname_derived_review_by = reviewBy;
  }
  return out;
}

const CONFIG = loadIdentityConfig(IDENTITY_FILE);

// EMAILS — canonical operator email addresses across every mail-like source
// (mail connector, git commit author, github noreply, imessage email-handle).
// Match is CASE-INSENSITIVE (isOperator lowercases before comparing).
//
// What registering an address changes: rows From: it are attributed to the
// operator (consent_basis=first_party) instead of third_party_inferred, and
// rows To: it read as addressed to the operator. What leaving one out costs:
// the operator's own mail (self-forwards, send-as aliases, drafts) surfaces
// as an inbound message from a third party and can rank at the top of the
// catch-up surface as "someone waiting on a reply". Rows captured before an
// address was registered keep their stored consent_basis (ledgers are
// append-only), and a long-lived connector process only sees a new entry
// after its next start.
const EMAILS = Object.freeze(CONFIG.emails);

// GITHUB_USERNAMES — operator-controlled github accounts. Used by the
// github-events connector to classify event.actor.login as first_party.
//
// IMPORTANT (F-NEW-R42-DISAMBIGUATE-ORG-LOGIN): an ORG login does not belong
// in this list. An org conflated with a username risks false-positive
// first_party tagging via username lookups against any user whose login
// happens to equal the org name. Orgs live ONLY in GITHUB_ORGS below; the
// runtime disambiguation lives in isOperator(), driven by the config's
// github_org_actor_logins.
const GITHUB_USERNAMES = Object.freeze(CONFIG.github_usernames);

// GITHUB_ORGS — github organizations the operator is a member of. Events
// inside these orgs are *audience*-first-party (operator has authoring
// privileges); authorship still has to match a username for the
// authorship-trumps-audience rule (see git-log-local Round-20 close C1).
const GITHUB_ORGS = Object.freeze(CONFIG.github_orgs);

// GITHUB_ORG_ACTOR_LOGINS — org logins treated as the operator when they
// appear as an actor on a GitHub source. Not exported; see isOperator().
const GITHUB_ORG_ACTOR_LOGINS = Object.freeze(CONFIG.github_org_actor_logins);

// IMESSAGE_HANDLES — apple-id email or phone-number handles the operator
// uses on iMessage. The imessage connector uses this to classify the
// is_from_me column heuristically when the message direction is ambiguous
// (e.g. messages synced from another device).
const IMESSAGE_HANDLES = Object.freeze(CONFIG.imessage_handles);

// PHONE_NUMBERS — operator phone numbers in E.164 form. Used by imessage
// and any future SMS/voice connector. Empty array is acceptable; the
// imessage connector falls back to is_from_me=1 when no phone match.
const PHONE_NUMBERS = Object.freeze(CONFIG.phone_numbers);

// Per-source lookup hint. isOperator(identifier, source) narrows the
// candidate lists to the source's natural keyspace. Unknown source =>
// all lists are checked.
const SOURCE_LOOKUP = Object.freeze({
  "git-log": { emails: true },
  "git-log-local": { emails: true },
  "github-events": { github_usernames: true, github_orgs: false, emails: true },
  "github": { github_usernames: true, github_orgs: false, emails: true },
  "imessage": { imessage_handles: true, phone_numbers: true, emails: true },
  "screentime": { emails: true },
  "mail": { emails: true },
});

// Lower-cased set for case-insensitive email match. Built once at module load.
const EMAIL_SET_LC = new Set(EMAILS.map((e) => e.toLowerCase()));
const GITHUB_USERNAME_SET_LC = new Set(
  GITHUB_USERNAMES.map((u) => u.toLowerCase()),
);
const GITHUB_ORG_SET_LC = new Set(GITHUB_ORGS.map((o) => o.toLowerCase()));
const GITHUB_ORG_ACTOR_LOGIN_SET_LC = new Set(
  GITHUB_ORG_ACTOR_LOGINS.map((o) => o.toLowerCase()),
);
const IMESSAGE_HANDLE_SET_LC = new Set(
  IMESSAGE_HANDLES.map((h) => h.toLowerCase()),
);
const PHONE_SET = new Set(PHONE_NUMBERS);

// isOperator — returns true iff the (lower-cased) identifier matches any
// known operator identity. Optional source hint narrows the candidate
// lists; unknown or omitted source checks every list.
//
// Email match is case-insensitive (RFC 5321 local part is technically
// case-sensitive, but every real-world MTA treats it case-insensitively;
// matching case-insensitively here is the safer default and matches what
// the pre-R42 mail identity map already did).
//
// GitHub username match is case-insensitive (github logins are
// case-preserving but case-insensitive for routing).
//
// Phone match is exact (callers must normalise to E.164 before calling).
export function isOperator(identifier, source) {
  if (typeof identifier !== "string" || identifier.length === 0) return false;
  const lc = identifier.toLowerCase();
  const hint = source ? SOURCE_LOOKUP[source] : null;

  // F-NEW-R42-DISAMBIGUATE-ORG-LOGIN: a login listed in the config's
  // github_org_actor_logins is an org, not a user. When a GitHub connector
  // passes it as an actor.login, treat it as an org-membership signal (the
  // operator IS a member of that org). A full org-vs-user disambiguation
  // would require a live GitHub API call (`gh api users/<login>` /
  // `gh api orgs/<login>`) which we cannot make at predicate-evaluation
  // time. For now we always return true for a listed login when source is
  // github-like, because every operator-relevant event from an actor in
  // that namespace would be either the org bot acting on the operator's
  // behalf or a user event we want to surface. With any other source, or
  // none, the login falls through to the normal list checks (where it can
  // only match via github_orgs). The rule applies ONLY to listed logins,
  // never to every github_orgs entry. Follow-up: replace with a cached
  // GitHub API check (TODO: R42-v2).
  if (
    GITHUB_ORG_ACTOR_LOGIN_SET_LC.has(lc) &&
    (source === "github-events" || source === "github")
  ) {
    return true;
  }

  // No hint => check every list.
  if (!hint) {
    if (EMAIL_SET_LC.has(lc)) return true;
    if (GITHUB_USERNAME_SET_LC.has(lc)) return true;
    if (GITHUB_ORG_SET_LC.has(lc)) return true;
    if (IMESSAGE_HANDLE_SET_LC.has(lc)) return true;
    if (PHONE_SET.has(identifier)) return true;
    return false;
  }

  if (hint.emails && EMAIL_SET_LC.has(lc)) return true;
  if (hint.github_usernames && GITHUB_USERNAME_SET_LC.has(lc)) return true;
  if (hint.github_orgs && GITHUB_ORG_SET_LC.has(lc)) return true;
  if (hint.imessage_handles && IMESSAGE_HANDLE_SET_LC.has(lc)) return true;
  if (hint.phone_numbers && PHONE_SET.has(identifier)) return true;
  return false;
}

// getOperatorIdentities — read-only view of the five identity arrays.
// Stable shape: {emails, github_usernames, github_orgs, imessage_handles,
// phone_numbers}. Used by connectors that need to iterate (e.g.
// git-log-local's operatorEmailSet construction) without pulling the
// default export.
export function getOperatorIdentities() {
  return {
    emails: EMAILS,
    github_usernames: GITHUB_USERNAMES,
    github_orgs: GITHUB_ORGS,
    imessage_handles: IMESSAGE_HANDLES,
    phone_numbers: PHONE_NUMBERS,
  };
}

// HOSTNAME_DERIVED_EMAILS — emails in EMAILS that were derived from a
// machine hostname (rather than an explicit user.email). Comes from the
// config's hostname_derived_emails and is empty when unconfigured; it is
// never computed from the running host. Used by
// emitHostnameDerivedWarning() and surfaced via getIdentityHealth().
const HOSTNAME_DERIVED_EMAILS = Object.freeze(CONFIG.hostname_derived_emails);
const HOSTNAME_DERIVED_REVIEW_BY = CONFIG.hostname_derived_review_by;
const HOSTNAME_DERIVED_SET_LC = new Set(
  HOSTNAME_DERIVED_EMAILS.map((e) => e.toLowerCase()),
);

// F-NEW-R42-HOSTNAME-WARN-RULE + F-NEW-W1-R42-HOSTNAME-OBSERVABILITY.
//
// emitHostnameDerivedWarning(weeklyCommits) — health-check helper that
// emits a console.warn when more than THRESHOLD_FRACTION of recent
// commits were authored under a hostname-derived address (the config's
// hostname_derived_emails).
//
// Argument shape:
//   weeklyCommits: either
//     (a) a number — total commit count over the trailing 7-day window;
//         AND a second positional argument with the hostname-derived
//         match count. Kept for backwards compatibility with the original
//         critic_modification phrasing ("if count > weeklyCommits * 0.10").
//     (b) an array of {author_email, ts} commit rows over the trailing
//         7-day window. The function will count hostname-derived matches
//         itself.
//   opts (optional, 3rd positional in two-arg form OR 2nd positional in
//         one-arg form): { source } where source is the connector name
//         that triggered the check (e.g. "git-log-local"). Used to key
//         the LAST_WARN_BY_SOURCE map surfaced via getHostnameWarnState()
//         so memory_connectors_list can show per-source warning state.
//
// Two-arg form: emitHostnameDerivedWarning(totalCommits, hostnameMatches[, opts])
// One-arg form: emitHostnameDerivedWarning(commitRows[, opts])
//
// Threshold is fixed at 5% (THRESHOLD_FRACTION) per
// F-NEW-W1-R42-HOSTNAME-OBSERVABILITY critic_modifications. The prior
// 10% threshold was too permissive: a shared lab Mac with three coworkers
// all committing under the same hostname-derived address would routinely
// hit 30%+ but never trigger a 10% canary. Halving the threshold to 5%
// catches drift earlier without false-positives on a single-operator
// machine (typical: 0% hostname-derived authorship when user.email is
// configured, 100% when it is not — both far from 5%).
//
// Side effects on trigger:
//   1. console.warn — kept for dev visibility.
//   2. telemetry.recordDrop({source: 'identity', decision: 'WARN',
//      reason: 'identity_hostname_dominance_warn'}) — surfaces the warning
//      into the Stage-0 telemetry stream so operators can see the warn
//      rate alongside drop counters. NOT a real DROP — the WARN decision
//      keeps the row in the ledger; this is purely observability.
//   3. LAST_WARN_BY_SOURCE[source] = {ts, fraction, total, matches} — so
//      memory_connectors_list can surface the most recent warning per
//      connector under health.warnings[].
//
// The recordDrop call is wrapped in try/catch so a telemetry-layer
// failure (e.g. missing import in a test harness) never crashes the
// health-check.
//
// Caller contract: invoke this from a periodic health-check (e.g. the
// daemon's per-poll tally over git-log commits in the last 7 days).
// Recommended cadence: once per poll, debounced to at most once per
// hour. See implementation_hints in F-NEW-R42-HOSTNAME-WARN-RULE.

// Internal state: most-recent warning per source. Read-only externally
// via getHostnameWarnState().
const LAST_WARN_BY_SOURCE = new Map();

// F-NEW-W3-R42-HOSTNAME-LAZY-IMPORT-RACE — the telemetry module is now
// eagerly imported at the top of this file. `_telemetryStaticModule` is
// guaranteed to be populated by the time the first emitHostnameDerivedWarning
// call lands, so safeRecordDrop never has to defer the increment. The
// `_telemetryModule` cache below is retained as a forward-compat seam for
// the test surface (resetHostnameWarnState + tests that want to swap a
// mock recordDrop in via a future helper) and so existing module-internals
// debuggers find the expected symbol.
const _telemetryModule = _telemetryStaticModule;

// Synchronous recordDrop. The telemetry module is statically imported at
// the top of this file (F-NEW-W3-R42-HOSTNAME-LAZY-IMPORT-RACE) so the
// FIRST warn-trigger in a fresh process actually counts. Errors from
// recordDrop are swallowed — the warn surface is observability, not
// load-bearing, and we never want a telemetry-layer failure to crash the
// health-check.
function safeRecordDrop() {
  if (_telemetryModule && typeof _telemetryModule.recordDrop === "function") {
    try {
      _telemetryModule.recordDrop(
        "identity",
        "identity_hostname_dominance_warn",
        "WARN"
      );
    } catch {
      /* never let telemetry fail the warn */
    }
  }
}

export function emitHostnameDerivedWarning(
  weeklyCommits,
  hostnameMatches,
  opts
) {
  const THRESHOLD_FRACTION = 0.05;

  let total = 0;
  let matches = 0;
  let resolvedOpts =
    opts && typeof opts === "object" && !Array.isArray(opts) ? opts : null;

  if (Array.isArray(weeklyCommits)) {
    for (const row of weeklyCommits) {
      total++;
      const email =
        row && typeof row.author_email === "string"
          ? row.author_email.toLowerCase()
          : null;
      if (email && HOSTNAME_DERIVED_SET_LC.has(email)) matches++;
    }
    // One-arg shape: opts may have been passed as `hostnameMatches`.
    if (
      !resolvedOpts &&
      hostnameMatches &&
      typeof hostnameMatches === "object" &&
      !Array.isArray(hostnameMatches)
    ) {
      resolvedOpts = hostnameMatches;
    }
  } else if (typeof weeklyCommits === "number") {
    total = weeklyCommits;
    matches =
      typeof hostnameMatches === "number" && hostnameMatches >= 0
        ? hostnameMatches
        : 0;
  } else {
    // Invalid input: nothing to warn about.
    return { triggered: false, reason: "invalid_input", total: 0, matches: 0 };
  }

  if (total <= 0) {
    return { triggered: false, reason: "zero_total", total, matches };
  }

  const fraction = matches / total;
  if (matches > total * THRESHOLD_FRACTION) {
    console.warn(
      `[operator-identity] hostname-derived author dominance: ${matches}/${total} ` +
        `(${(fraction * 100).toFixed(1)}%) of last 7d commits authored under a ` +
        `hostname-derived email (${HOSTNAME_DERIVED_EMAILS.join(", ")}). ` +
        `Threshold is ${THRESHOLD_FRACTION * 100}%. ` +
        `Hostname-derived addresses are over-trusted on shared machines; ` +
        `consider configuring git user.email explicitly. ` +
        `See F-NEW-R42-HOSTNAME-WARN-RULE.`,
    );
    // F-NEW-W1-R42-HOSTNAME-OBSERVABILITY: stamp telemetry + per-source
    // last-warn state.
    safeRecordDrop();
    const source =
      resolvedOpts && typeof resolvedOpts.source === "string"
        ? resolvedOpts.source
        : "identity";
    LAST_WARN_BY_SOURCE.set(source, {
      ts: new Date().toISOString(),
      fraction,
      total,
      matches,
      threshold_fraction: THRESHOLD_FRACTION,
    });
    return { triggered: true, reason: "threshold_exceeded", total, matches, fraction };
  }

  return { triggered: false, reason: "under_threshold", total, matches, fraction };
}

// getHostnameWarnState — read-only snapshot of the most-recent
// hostname-derived warning per source. Surfaced via
// memory_connectors_list under health.warnings[] (see
// lib/tools/connectors-list.js). Returns a plain object map
// {source: {ts, fraction, total, matches, threshold_fraction}} — empty
// when no warnings have fired this process lifetime.
//
// Used by F-NEW-W1-R42-HOSTNAME-OBSERVABILITY. Do NOT use this as the
// drop-counter (telemetry.snapshotCounters() handles that); this is the
// human-readable "last warn timestamp + fraction" overlay.
export function getHostnameWarnState() {
  const out = {};
  for (const [source, state] of LAST_WARN_BY_SOURCE.entries()) {
    out[source] = { ...state };
  }
  return out;
}

// resetHostnameWarnState — test-only escape hatch. Clears the per-source
// last-warn map so tests can run in isolation.
export function resetHostnameWarnState() {
  LAST_WARN_BY_SOURCE.clear();
}

// getIdentityHealth — surface the loaded map size + load timestamp so the
// daemon health endpoint can show identity-map state. R42 critic_modification
// requires this for the future health-check that warns when >X% of new
// commits per week match a hostname-derived address (the hostname-derived
// trust-erosion canary).
export function getIdentityHealth() {
  return {
    schema: "operator-identity/v1",
    loaded_at: LOADED_AT,
    counts: {
      emails: EMAILS.length,
      github_usernames: GITHUB_USERNAMES.length,
      github_orgs: GITHUB_ORGS.length,
      imessage_handles: IMESSAGE_HANDLES.length,
      phone_numbers: PHONE_NUMBERS.length,
    },
    hostname_derived_emails: [...HOSTNAME_DERIVED_EMAILS],
    review_by: HOSTNAME_DERIVED_REVIEW_BY,
  };
}

// Frozen export of the raw map for connectors that need to iterate (e.g.
// git-log-local's operatorEmails Set construction). Consumers MUST NOT
// mutate these arrays; they are frozen at module load.
export const OPERATOR_IDENTITY = Object.freeze({
  emails: EMAILS,
  github_usernames: GITHUB_USERNAMES,
  github_orgs: GITHUB_ORGS,
  imessage_handles: IMESSAGE_HANDLES,
  phone_numbers: PHONE_NUMBERS,
});

// Default export for ergonomic single-import usage.
export default {
  emails: EMAILS,
  github_usernames: GITHUB_USERNAMES,
  github_orgs: GITHUB_ORGS,
  imessage_handles: IMESSAGE_HANDLES,
  phone_numbers: PHONE_NUMBERS,
  isOperator,
  getIdentityHealth,
  getOperatorIdentities,
  emitHostnameDerivedWarning,
  getHostnameWarnState,
  resetHostnameWarnState,
};
