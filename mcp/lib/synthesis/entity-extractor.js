// Entity extractor (substrate; F-SYN-SUBSTRATE-ENTITY-EXTRACTOR).
// Implements the contract pinned at docs/specs/synthesis/entity-schema.md.
//
// Scope at v0:
//   - HAND-WRITTEN PATTERNS only (no LLM, no NER model). Per-source dispatch
//     defers to the substrate node's design choice; v0 uses regex-driven
//     structural extractors (URLs, emails, GitHub repo paths, phone numbers,
//     file paths, hashtags) and a stopword/min-length conflation gate.
//   - The signature below matches what the WU prompt requests:
//         extractEntities(text, opts={source, language: 'en'})
//             -> {entities: Entity[], model_version: string}
//     This is a simpler v0 surface; the full ExtractInput / ExtractOutput shape
//     in §7.1 of the schema spec is the v1 surface that an integration-tier
//     node will adapt to once `surrounding_context` is wired in.
//   - All slugification, canonical_id formation, kind/source enums, and
//     conflation gate semantics derive from the foundation spec verbatim.
//
// FM-1 defense (salience-design.md A.1):
//   - STOPWORDS blocks `evidence ∈ {handle, kb_lookup, ner_corroborated}` emits.
//   - `evidence: 'structural'` BYPASSES STOPWORDS (schema spec §6.3,
//     example §9.3). This is the invariant I5.
//   - Below the minimum surface-codepoint length, emits are dropped regardless
//     of evidence.
//
// Determinism contract (invariant I1):
//   - No Date.now(), no Math.random(), no I/O. Pure function over (text, opts).
//   - SINGLE DOCUMENTED EXCEPTION: `repoPrecisionEnabled()` reads
//     `process.env.MEMORY_GH_REPO_PRECISE` at CALL time (never cached at module
//     load, so a test can toggle it in-process). The env is stable within a
//     process, so determinism-within-a-process — the property the two-call
//     determinism test pins — still holds. It is not I/O, not a clock, and not
//     a randomness source; it selects between two pure code paths, and the
//     precise path is SUBTRACTIVE ONLY (see harvestGithubRepoPaths).
//   - The operator's own stopword tokens are read ONCE, at module load, from the
//     identity module (which itself reads the per-host config file once). No
//     per-call I/O; the set is frozen for the life of the process.

import { getOperatorIdentities } from "../identity/operator-identity.js";

// ---------------------------------------------------------------------------
// Constants (mirrors mcp/lib/validation.js § CAPS entries the foundation spec
// §8 enumerates; kept module-local so the extractor can ship before the
// CAPS edits land, and so tests can import them directly).
// ---------------------------------------------------------------------------

/** Closed 7-kind enum (foundation spec §3). */
export const ENTITY_KINDS = Object.freeze([
  "person",
  "place",
  "org",
  "project",
  "event",
  "topic",
  "artifact",
]);

/** Closed source-scope enum (foundation spec §4.1). */
export const ENTITY_SOURCE_SCOPES = Object.freeze([
  "imessage",
  "git-log",
  "github-events",
  "screentime",
  "chat-claude-code",
  "manual",
  // 2026-07 connector expansion: id formation is uniform
  // `<kind>:<source>:<slug>`; buildCanonicalId interpolates source verbatim.
  "telegram",
  "whatsapp",
  "mail",
  "slack",
  "codex-cli",
]);

/** Closed evidence-kind enum (foundation spec §4.2). */
export const ENTITY_EVIDENCE_KINDS = Object.freeze([
  "handle",
  "kb_lookup",
  "structural",
  "ner_corroborated",
]);

/** Foundation spec §8 — extractor algorithm version. Bump on logic changes. */
export const ENTITY_EXTRACTOR_VERSION = "v0.1.0";

/** Foundation spec §6.1 (a) — minimum codepoint length on `surface.trim()`. */
export const MIN_ENTITY_LENGTH = 3;

/** Foundation spec §4 — max entities per row. */
export const ENTITY_MAX_PER_ROW = 32;

/** Foundation spec §5.2 step 6 — slug truncation byte length. */
export const ENTITY_SLUG_MAX_LEN = 64;

/** Foundation spec §5.2 — validation regex for non-sentinel slugs. */
export const ENTITY_SLUG_REGEX = /^[a-z0-9]+(_[a-z0-9]+)*$/;

/** Foundation spec §5.2 step 7 — empty-slug sentinel. Never appears in stamped
 *  entities; the gate drops anything that slugifies to this. */
export const SLUG_EMPTY_SENTINEL = "_empty_";

/**
 * Foundation spec §6.3 — the FM-1 stopword blocklist.
 * Members are lowercased + ASCII-folded. Matches `normalizeForBlocklist(surface)`.
 *
 * SCOPE INVARIANT (I5): STOPWORDS gates `evidence ∈ {handle, kb_lookup,
 * ner_corroborated}` only. `evidence: 'structural'` bypasses STOPWORDS — the
 * FM-1 conflation does not occur on structurally-typed surfaces (e.g. a GitHub
 * `actor.login` of "alex-example" is admitted; an iMessage NL mention of
 * "alex-example" is dropped, when that is one of the operator's own tokens).
 *
 * OPERATOR TOKENS. The FM-1 self-reference members (the operator's own
 * first-name / login tokens) are NOT literals here: they are derived at module
 * load from the per-host identity config (lib/identity/operator-identity.js) —
 * every e-mail local-part plus every GitHub username, each folded through
 * `normalizeForBlocklist`. An unconfigured identity contributes none.
 */
function operatorSelfTokens() {
  const { emails, github_usernames } = getOperatorIdentities();
  const out = [];
  for (const email of emails) {
    if (typeof email !== "string") continue;
    const at = email.indexOf("@");
    out.push(normalizeForBlocklist(at > 0 ? email.slice(0, at) : email));
  }
  for (const login of github_usernames) out.push(normalizeForBlocklist(login));
  return out.filter((tok) => tok.length > 0);
}

export const STOPWORDS = Object.freeze(new Set([
  // Pronouns / determiners / prepositions / conjunctions / copula
  "i", "me", "my", "mine", "myself",
  "you", "your", "yours", "yourself",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "it", "its", "itself",
  "we", "us", "our", "ours", "ourselves",
  "they", "them", "their", "theirs", "themselves",
  "this", "that", "these", "those",
  "a", "an", "the",
  "and", "or", "but", "so", "because", "if",
  "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "done",
  "has", "have", "had", "having",
  // FM-1 specific (foundation spec §6.3): the operator's own tokens (from the
  // identity config, see operatorSelfTokens above) plus the assistant's name.
  ...operatorSelfTokens(),
  "claude",
  // Common iMessage chitchat that NER promotes
  "thanks", "thank", "cool", "yeah", "okay", "ok",
  "hey", "hi", "hello", "bye",
  "today", "tomorrow", "yesterday", "now", "later",
  "thing", "stuff", "things",
  "someone", "something", "somewhere", "anyone", "anything",
  "maybe", "perhaps", "probably", "definitely",
]));

// ---------------------------------------------------------------------------
// READ-SIDE ENTITY NOISE VOCABULARY (L8)
//
// Distinct from STOPWORDS above and deliberately NOT part of it. STOPWORDS
// gates extraction under invariant I5 (`evidence ∈ {handle, kb_lookup,
// ner_corroborated}`, bypassed for `structural`); the vocabulary below gates
// NOTHING at extraction time. It is consumed only by the recall-time overlap
// filter in lib/recall/multi-feature-score.js, behind a default-off env flag.
//
// Why read-side: the ledger is append-only, so rows already carrying these
// ids keep them forever and no producer-side change can repair them. Two
// producers emit this noise today — buildPartyEntity in
// lib/tools/distill-promote-fact.js (role labels) and the conversation-id
// topic emit in lib/connectors/codex-cli.js (uuid topics); neither routes
// through admitEntity, so a STOPWORDS edit would be provably inert here.
//
// Why a surface/slug filter and not a kind/source/evidence filter: the noise
// and the real signal are produced by the same code paths with the same kinds,
// sources and `evidence` values. `project:codex-cli:atlas` and
// `topic:codex-cli:<uuid>` differ only in their slug.
// ---------------------------------------------------------------------------

/**
 * Conversational role labels that a transcript's "who spoke" marker turns into
 * a `person`. Exactly two members; matched against the WHOLE slug, never a
 * prefix or substring, so `username` and `user_group` survive.
 *
 * Measured in this session, read-only, over the last 60 MB of
 * ledgers/memory.jsonl (`tail -c 60000000` into a scratch file, then
 * `grep -oE '"person:[a-z0-9-]+:(user|assistant)"' | sort | uniq -c`):
 *   332 person:codex-cli:user          332 person:codex-cli:assistant
 *    75 person:chat-claude-code:user    75 person:chat-claude-code:assistant
 *     4 person:whatsapp:user             2 person:imessage:user
 * The role label is the whole slug in every one of these, which is why the
 * match is on the whole slug and not a prefix.
 */
export const ENTITY_NOISE_ROLE_SURFACES = Object.freeze(new Set([
  "user",
  "assistant",
]));

/**
 * A conversation-id slug: underscore-separated hex groups of length
 * 8-4-4-4-12. Slugs use `_` as the separator (never `-`) per
 * ENTITY_SLUG_REGEX above, so the UUID arrives already underscore-folded.
 *
 * Measured in this session over the same read-only 60 MB ledger tail: 59
 * distinct ids of this shape, every one of them kind `topic` and source
 * `codex-cli`, e.g. `topic:codex-cli:00000000_0000_4000_8000_000000000001`.
 *
 * NON-GLOBAL on purpose: a `g` flag makes RegExp carry `lastIndex` between
 * calls, which makes `.test()` alternate true/false on identical input.
 */
export const ENTITY_NOISE_UUID_SLUG_RE =
  /^[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/i;

/**
 * Classify a SOURCE-STRIPPED entity match key as read-side noise.
 *
 * PURE: no I/O, no clock, no randomness, no env reads. The env flag that
 * decides whether to consult this function lives in
 * lib/recall/multi-feature-score.js and is read at call time.
 *
 * @param {unknown} key — a `<kind>:<slug>` key as produced by
 *        `entityMatchKey` (which drops the middle `source` segment).
 * @returns {boolean} true iff the key is a conversational role label under
 *          kind `person`, or a conversation-id UUID under kind `topic`.
 *          Non-strings, the empty string and keys with no `:` are false.
 */
export function isNoiseEntityMatchKey(key) {
  if (typeof key !== "string" || key === "") return false;
  // Split on the FIRST ':' only, so a slug containing ':' survives intact —
  // entityMatchKey is colon-safe and passes such ids through.
  const sep = key.indexOf(":");
  if (sep < 0) return false;
  const kind = key.slice(0, sep);
  const slug = key.slice(sep + 1);
  if (slug === "") return false;
  if (kind === "person") return ENTITY_NOISE_ROLE_SURFACES.has(slug);
  if (kind === "topic") return ENTITY_NOISE_UUID_SLUG_RE.test(slug);
  return false;
}

// ---------------------------------------------------------------------------
// slugify (foundation spec §5.2)
//
// 7 ordered steps. Two implementations diverging by a single step is a defect.
// ---------------------------------------------------------------------------

/**
 * Deterministic surface-to-slug pipeline. Pure-functional. UTF-8 safe.
 *
 * @param {string} surface — the raw surface as seen in the source row.
 * @returns {string} — slug matching ENTITY_SLUG_REGEX, OR SLUG_EMPTY_SENTINEL
 *          if the pipeline drained the input. The gate is responsible for
 *          dropping entities with the sentinel slug.
 */
export function slugify(surface) {
  if (typeof surface !== "string") {
    throw new TypeError(`slugify: expected string, got ${typeof surface}`);
  }
  let x = surface;
  // Step 1 — Unicode NFC normalization (pin form explicitly).
  x = x.normalize("NFC");
  // Step 2 — ASCII-fold: decompose to NFD, strip combining marks, drop any
  //          remaining non-ASCII codepoint.
  x = x.normalize("NFD").replace(/\p{M}/gu, "");
  // eslint-disable-next-line no-control-regex
  x = x.replace(/[^\x00-\x7F]/g, "");
  // Step 3 — Lowercase (after ASCII-fold this is pure-ASCII lowercase).
  x = x.toLowerCase();
  // Step 4 — Collapse runs of non-alphanumeric to a single underscore.
  x = x.replace(/[^a-z0-9]+/g, "_");
  // Step 5 — Strip leading and trailing underscores.
  x = x.replace(/^_+|_+$/g, "");
  // Step 6 — Truncate to ENTITY_SLUG_MAX_LEN. After step 2 every codepoint is
  //          single-byte ASCII so .length is both char and byte length.
  if (x.length > ENTITY_SLUG_MAX_LEN) x = x.slice(0, ENTITY_SLUG_MAX_LEN);
  // Step 6.5 — re-strip if truncation left a trailing underscore.
  x = x.replace(/_+$/g, "");
  // Step 7 — Sentinel for empty pipeline output.
  if (x.length === 0) return SLUG_EMPTY_SENTINEL;
  return x;
}

// ---------------------------------------------------------------------------
// canonical_id formation (foundation spec §5.1, §7.2)
// ---------------------------------------------------------------------------

/**
 * Form a canonical id: `<kind>:<source_scope>:<slugify(text)>`.
 *
 * Throws on:
 *   - unknown kind / source_scope (closed-enum invariant I4)
 *   - slug pipeline draining to SLUG_EMPTY_SENTINEL (the spec forbids stamping
 *     the sentinel; emitters MUST refuse).
 *
 * @param {{source: string, kind: string, text: string}} args
 * @returns {string} canonical_id
 */
export function buildCanonicalId({ source, kind, text }) {
  if (!ENTITY_KINDS.includes(kind)) {
    throw new Error(`buildCanonicalId: unknown kind '${kind}'`);
  }
  if (!ENTITY_SOURCE_SCOPES.includes(source)) {
    throw new Error(`buildCanonicalId: unknown source_scope '${source}'`);
  }
  const slug = slugify(text);
  if (slug === SLUG_EMPTY_SENTINEL) {
    throw new Error(
      `buildCanonicalId: surface '${text}' slugifies to empty sentinel; ` +
      `gate must drop before reaching id formation`,
    );
  }
  if (!ENTITY_SLUG_REGEX.test(slug)) {
    // Defensive: should be impossible after slugify(), but defends against a
    // future bug where slugify() changes shape.
    throw new Error(`buildCanonicalId: slug '${slug}' violates ENTITY_SLUG_REGEX`);
  }
  return `${kind}:${source}:${slug}`;
}

// ---------------------------------------------------------------------------
// Internal: normalizeForBlocklist
// ---------------------------------------------------------------------------

/**
 * Lowercase + ASCII-fold + trim, matching the foundation spec §6.1(b) check.
 * STOPWORDS members are stored in this normalized form.
 */
function normalizeForBlocklist(surface) {
  if (typeof surface !== "string") return "";
  let x = surface.trim();
  x = x.normalize("NFC").normalize("NFD").replace(/\p{M}/gu, "");
  // eslint-disable-next-line no-control-regex
  x = x.replace(/[^\x00-\x7F]/g, "");
  return x.toLowerCase();
}

// ---------------------------------------------------------------------------
// Conflation gate (foundation spec §6.1)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GateCandidate
 * @property {string} kind
 * @property {string} source
 * @property {string} surface
 * @property {string} evidence
 */

/**
 * Apply the universal gate to a candidate. Returns `{admit: true, canonical_id}`
 * or `{admit: false, reason}` where `reason` is one of:
 *   'surface_too_short' | 'stopword' | 'empty_slug_after_normalize' |
 *   'evidence_rule_failed' | 'unknown_source' | 'unknown_kind' | 'unknown_evidence'
 *
 * Per invariant I5: `structural` evidence bypasses the STOPWORDS check; every
 * other evidence kind is subject to it.
 */
function admitEntity(candidate) {
  const { kind, source, surface, evidence } = candidate;

  if (!ENTITY_KINDS.includes(kind)) {
    return { admit: false, reason: "unknown_kind" };
  }
  if (!ENTITY_SOURCE_SCOPES.includes(source)) {
    return { admit: false, reason: "unknown_source" };
  }
  if (!ENTITY_EVIDENCE_KINDS.includes(evidence)) {
    return { admit: false, reason: "unknown_evidence" };
  }

  const trimmed = (typeof surface === "string") ? surface.trim() : "";
  // (a) Minimum codepoint length on the trimmed surface.
  if ([...trimmed].length < MIN_ENTITY_LENGTH) {
    return { admit: false, reason: "surface_too_short" };
  }

  // (b) STOPWORDS — scoped per invariant I5: bypassed for `structural`.
  if (evidence !== "structural") {
    if (STOPWORDS.has(normalizeForBlocklist(trimmed))) {
      return { admit: false, reason: "stopword" };
    }
  }

  // (c) Empty slug after the pipeline.
  const slug = slugify(trimmed);
  if (slug === SLUG_EMPTY_SENTINEL) {
    return { admit: false, reason: "empty_slug_after_normalize" };
  }

  const canonical_id = `${kind}:${source}:${slug}`;
  return { admit: true, canonical_id };
}

// Exported for test introspection — not part of the public surface that the
// cascade-stamper or recall-populator should rely on.
export const __internal = Object.freeze({
  admitEntity,
  normalizeForBlocklist,
  repoPrecisionEnabled,
  // Lazy accessor on purpose: GH_MARKER_RE is declared next to the harvester it
  // guards (below), so a plain property here would evaluate inside its temporal
  // dead zone at module-init. The getter defers the read to first use.
  get GH_MARKER_RE() { return GH_MARKER_RE; },
});

// ---------------------------------------------------------------------------
// Hand-written structural patterns (v0 substrate)
//
// Each pattern is a deterministic regex pass over `text`. Matches are routed
// through `admitEntity()` with `evidence: 'structural'` (the FM-1 risk does not
// apply to structurally-typed surfaces). Patterns deliberately err toward
// precision over recall — false-conflate poisons the predicate index forever
// (foundation spec §1).
// ---------------------------------------------------------------------------

/**
 * Iterate regex matches into typed candidates.
 *
 * @param {RegExp} regex — must be /g flag.
 * @param {string} text
 * @param {(match: RegExpExecArray) => {kind: string, surface: string} | null} mapper
 * @returns {Array<{kind: string, surface: string, span: [number, number]}>}
 */
function harvest(regex, text, mapper) {
  const out = [];
  let m;
  // Reset lastIndex defensively (regex literals are recreated per call below,
  // but in case a caller passes a shared global regex).
  regex.lastIndex = 0;
  while ((m = regex.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    const mapped = mapper(m);
    if (mapped) out.push({ ...mapped, span: [start, end] });
    // Defend against zero-width matches.
    if (m.index === regex.lastIndex) regex.lastIndex += 1;
  }
  return out;
}

/**
 * Pattern: emails. Maps to kind:'person' (per foundation spec §5.3 git-log row:
 * "author-email IS the surface"; the same shape applies elsewhere as a v0
 * heuristic — emails are persistently person-shaped). Surface preserved verbatim.
 */
function harvestEmails(text) {
  // Pragmatic email regex. Not RFC 5322 strict; rejects spaces and angle
  // brackets, requires a TLD letter.
  const re = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  return harvest(re, text, (m) => ({ kind: "person", surface: m[0] }));
}

/**
 * Is the GitHub repo-path precision gate armed?
 *
 * Read at CALL time — never cached at module load — so a test (or an operator
 * flipping the env between daemon restarts) sees the change without a module
 * reload. Default OFF: unset, or any value other than the exact string "1",
 * leaves the emit path byte-identical to the pre-gate behavior.
 */
function repoPrecisionEnabled() {
  return process.env.MEMORY_GH_REPO_PRECISE === "1";
}

/**
 * Allowlist marker for the precision gate: text that actually talks about
 * GitHub. Deliberately NOT /g — a global regex carries `lastIndex` state across
 * calls and would make `.test()` alternate true/false on identical input.
 */
const GH_MARKER_RE = /github\.com\/|git@github|gh repo/i;

/**
 * Pattern: GitHub `owner/repo` paths. Two emits: org:<owner>, project:<repo>.
 * Avoid false matches inside file paths (`a/b/c.js`) by requiring a leading
 * word boundary AND no preceding slash.
 *
 * PRECISION GATE (flag `MEMORY_GH_REPO_PRECISE`, default OFF — unset or != "1"
 * runs the historical path verbatim). When ON:
 *   - ALLOWLIST: the harvester only runs when `opts.source === 'github-events'`
 *     (the whole corpus is repo-shaped) or the text carries a GitHub marker
 *     (`github.com/`, `git@github`, `gh repo`). Otherwise it returns [].
 *   - Additionally drops all-digit owners (`150/300`) and repos with no letter
 *     at all, which are arithmetic/ratios rather than repo names.
 *
 * SUBTRACTIVE ONLY. The gate filters matches the regex above ALREADY produced;
 * it is never a new match trigger. In particular a `github.com/` marker must
 * not make `https://github.com/o/r` start emitting org/project — the
 * `(?<![A-Za-z0-9_\-./])` lookbehind already suppresses that, and the gate does
 * not touch the pattern. Consequence: for every input, the ON emit set is a
 * subset of the OFF emit set.
 *
 * Trade: a bare `owner/repo` in a git-log commit subject with no GitHub marker
 * is also suppressed — accepted precision-over-recall, consistent with the
 * precision-first contract stated above.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.source] — the caller's ENTITY_SOURCE_SCOPES value;
 *                 only read by the allowlist, never validated here (the public
 *                 entry point already validated it).
 */
function harvestGithubRepoPaths(text, opts = {}) {
  // Owner + repo: 1-39 chars for owner (GitHub max), 1-100 for repo, both
  // limited to URL-safe charset. Reject when followed by another `/` (would be
  // a deeper path like `owner/repo/blob/...`, which the URL harvester takes).
  const re = /(?<![A-Za-z0-9_\-./])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})(?![A-Za-z0-9_\-./])/g;
  // Single call-time env read; stable for the duration of this call.
  const precise = repoPrecisionEnabled();
  if (precise) {
    const allowed = opts.source === "github-events" || GH_MARKER_RE.test(text);
    if (!allowed) return [];
  }
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const owner = m[1];
    const repo = m[2];
    // Skip if `repo` ends in a common extension (would be a file like a/b.js).
    if (/\.(js|ts|jsx|tsx|mjs|cjs|json|md|txt|py|rb|go|rs|css|html|sh|yml|yaml|toml|lock|log)$/i.test(repo)) {
      if (m.index === re.lastIndex) re.lastIndex += 1;
      continue;
    }
    // Precision gate, second stage: arithmetic/ratio shapes. An all-digit owner
    // ("150/300") or a repo with no letter at all ("2/3") is never a repo path.
    // Keeps the same zero-width guard as every other `continue` in this loop.
    if (precise && (/^\d+$/.test(owner) || !/[A-Za-z]/.test(repo))) {
      if (m.index === re.lastIndex) re.lastIndex += 1;
      continue;
    }
    const start = m.index;
    const ownerEnd = start + owner.length;
    out.push({
      kind: "org",
      surface: owner,
      span: [start, ownerEnd],
    });
    out.push({
      kind: "project",
      surface: repo,
      span: [ownerEnd + 1, ownerEnd + 1 + repo.length],
    });
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

/**
 * Pattern: URLs. Maps to kind:'artifact'. Surface is the URL (verbatim).
 * The schema spec §5.3 says iMessage artifacts should be `host + first path
 * segment` — that normalization is a per-source detail; at v0 we preserve the
 * URL as the surface (slugify will collapse punctuation), and the per-source
 * adapter in a later wave can post-process.
 */
function harvestUrls(text) {
  const re = /\bhttps?:\/\/[^\s<>"')]+/gi;
  return harvest(re, text, (m) => ({ kind: "artifact", surface: m[0] }));
}

/**
 * Pattern: phone numbers (US-ish + E.164). Maps to kind:'person' — handles in
 * the iMessage corpus are phone numbers, which are person identifiers.
 */
function harvestPhones(text) {
  // E.164 (+1234567890) OR 10-digit US formats (parens optional, separators ' ', '-', '.').
  const re = /(\+\d{7,15}|\b\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b)/g;
  return harvest(re, text, (m) => ({ kind: "person", surface: m[0] }));
}

/**
 * Pattern: file paths. Maps to kind:'artifact'.
 * Conservative match: absolute path (`/foo/bar`) OR relative path with at least
 * one `/` AND a recognized file extension. Avoids gobbling prose like
 * "either/or".
 */
function harvestFilePaths(text) {
  const re = /(?<![A-Za-z0-9_\-./])((?:\/[A-Za-z0-9._-]+){2,}|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})(?![A-Za-z0-9_\-./])/g;
  return harvest(re, text, (m) => ({ kind: "artifact", surface: m[1] }));
}

/**
 * Pattern: hashtags. Maps to kind:'topic'.
 * Hashtags are exactly the case where `topic` is admissible — they are
 * operator-authored, structurally marked, and not subject to the FM-1 risk.
 */
function harvestHashtags(text) {
  const re = /(?<![A-Za-z0-9_])#([A-Za-z][A-Za-z0-9_]{2,63})\b/g;
  return harvest(re, text, (m) => ({ kind: "topic", surface: m[1] }));
}

// ---------------------------------------------------------------------------
// Public: extractEntities (v0 substrate surface)
// ---------------------------------------------------------------------------

/**
 * Extract entities from arbitrary text using hand-written patterns.
 *
 * @param {string} text — the prose to scan.
 * @param {object} opts
 * @param {string} opts.source — one of ENTITY_SOURCE_SCOPES. The source-scope
 *                 prefix on every emitted canonical_id.
 * @param {string} [opts.language='en'] — informational at v0; the patterns are
 *                 English-leaning but operate on structural surfaces, so they
 *                 work language-agnostically. Stored back on the output for
 *                 traceability; not surfaced on the Entity itself.
 * @returns {{
 *   entities: Array<{
 *     kind: string,
 *     canonical_id: string,
 *     surface: string,
 *     source_scope: string,
 *     evidence: string,
 *     confidence: number,
 *     extractor_version: string,
 *     span: [number, number] | null,
 *   }>,
 *   model_version: string,
 * }}
 */
export function extractEntities(text, opts = {}) {
  const { source, language = "en" } = opts;
  void language; // reserved for v1 multilingual gating

  if (typeof text !== "string") {
    throw new TypeError(`extractEntities: text must be a string, got ${typeof text}`);
  }
  if (!ENTITY_SOURCE_SCOPES.includes(source)) {
    throw new Error(
      `extractEntities: unknown source '${source}'. ` +
      `Expected one of ${ENTITY_SOURCE_SCOPES.join(",")}.`,
    );
  }

  // Collect raw candidates from every pattern. v0 evidence is uniformly
  // 'structural' — the patterns are precision-first.
  const raw = [
    ...harvestUrls(text),
    ...harvestEmails(text),
    ...harvestGithubRepoPaths(text, { source }),
    ...harvestPhones(text),
    ...harvestFilePaths(text),
    ...harvestHashtags(text),
  ];

  // Apply the gate. Drop reasons are silent at v0 (telemetry hookup deferred
  // to the cascade-stamper integration node).
  const admitted = [];
  for (const cand of raw) {
    const result = admitEntity({
      kind: cand.kind,
      source,
      surface: cand.surface,
      evidence: "structural",
    });
    if (!result.admit) continue;
    admitted.push({
      kind: cand.kind,
      canonical_id: result.canonical_id,
      surface: cand.surface,
      source_scope: source,
      evidence: "structural",
      confidence: 1.0,
      extractor_version: ENTITY_EXTRACTOR_VERSION,
      span: cand.span || null,
    });
  }

  // Coalesce duplicate canonical_ids — keep highest confidence; ties keep the
  // earliest-spanning surface (deterministic).
  const byId = new Map();
  for (const e of admitted) {
    const prior = byId.get(e.canonical_id);
    if (!prior) {
      byId.set(e.canonical_id, e);
      continue;
    }
    if (e.confidence > prior.confidence) {
      byId.set(e.canonical_id, e);
    }
    // Else: keep prior. Order through `admitted` is harvester order, which is
    // stable: URLs then emails then repos then phones then files then tags.
  }

  // Sort ascending by canonical_id (foundation spec §4.3, invariant I3).
  let entities = [...byId.values()].sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0,
  );

  // Cap (foundation spec §4.3).
  if (entities.length > ENTITY_MAX_PER_ROW) {
    entities = entities.slice(0, ENTITY_MAX_PER_ROW);
  }

  return {
    entities,
    model_version: ENTITY_EXTRACTOR_VERSION,
  };
}
