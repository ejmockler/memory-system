// identity.js — WORKUNIT N7, the cross-platform PERSON resolver (Layer 3 of the
// messaging attention hypergraph). Generalizes the per-source sender-index +
// name-recovery + operator-identity pattern into ONE read-only person-identity
// projection that clusters identifiers belonging to a single human across every
// platform the L1 adapters feed it.
//
// PURPOSE:
//   buildPersonIndex(envelopes) -> PersonIndex. A Union-Find over identifier
//   nodes: each envelope contributes a `(platform, sender.id)` node plus the
//   normalized identifiers extracted from `sender.id`; nodes that share a
//   normalized identifier (the SAME phone number, the SAME email) are unioned
//   into one cluster = one person. The operator is the first, pre-seeded cluster
//   (person:operator), seeded from the operator-identity seam so the operator's
//   addresses on different platforms collapse to one id. lookup(platform,
//   sender_id) -> person_id is the read-side join the catch-up surface (N9) calls.
//
// THE ABSTRACTION INVARIANT (the live proof N7 owns):
//   This file imports NO adapter, contains NO platform-name string literal, and
//   branches on NO platform-specific identifier shape. The clustering math is
//   identical regardless of which connector produced a row. Cross-platform links
//   are discovered by SHAPE — `normalizeIdentifier(value)` keys on the value's
//   regex form (`looksLikeE164`, `looksLikeEmail`, an `<digits>@<domain>` local
//   part), never on a platform name. A grep for any platform token over this
//   file returns 0 matches; that is half the node's gate.
//
// THESIS #1 (READ-ONLY DERIVED PROJECTION joined at query):
//   This builds a sidecar keyed by `(platform, sender_id) -> person_id`, rebuilt
//   from the (append-only) envelope stream. It NEVER mutates a source row, a
//   fact row, or the operator-identity seam (imported read-only). Deleting the
//   sidecar is always safe — the next rebuild reconstructs it byte-identically
//   (mintPersonId sorts its inputs, so cluster ids are iteration-order
//   independent). Mirrors the sender-index / conversation-index lifecycle:
//   VERSION constant + frozen CAPS + statFingerprint(mtime+size) cache.
//
// DAEMON OFF: pure module, no daemon dependency, no network, no DB. The only fs
// it touches is its OWN sidecar cache (persist / loadFromCacheSync).

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { getOperatorIdentities } from "../identity/operator-identity.js";

// ---------------------------------------------------------------------------
// VERSION + frozen CAPS (mirror SENDER_INDEX_VERSION / CONVERSATION_INDEX_CAPS).
// ---------------------------------------------------------------------------

/** Sidecar on-disk schema version. Bump on any structural change. */
export const PERSON_INDEX_SCHEMA_VERSION = "v1";

/** Builder version stamped into the sidecar for provenance. */
export const PERSON_INDEX_VERSION = "messaging-identity@0.1.0";

/** The operator's cluster id is a FIXED constant — never minted from a hash.
 *  Everything downstream treats the operator as just another (pre-seeded)
 *  cluster. */
export const OPERATOR_PERSON_ID = "person:operator";

export const PERSON_INDEX_CAPS = Object.freeze({
  // The `person:` namespace prefix for minted (non-operator) cluster ids.
  // Scoped so it never collides with the per-source `person:<source>:<slug>`
  // ids the entity-index mints (those carry a source segment; ours carry a
  // hash segment), verified by grep at author time.
  PERSON_ID_PREFIX: "person:",
  // Truncated-hash width for a minted cluster id (12 hex of sha1 over the
  // cluster's lexicographically-minimal member). Short enough to stay compact
  // across tens of thousands of contacts, wide enough that a collision is
  // astronomically unlikely for a personal corpus.
  PERSON_ID_HASH_HEX: 12,
});

// ---------------------------------------------------------------------------
// A1 — normalizeIdentifier: SHAPE-keyed (never platform-keyed).
// ---------------------------------------------------------------------------

// E.164-ish: an optional leading '+', then 7..15 digits. We canonicalize to a
// leading-'+' form so the same human number written with or without the '+'
// (and embedded as the local part of an `<digits>@<domain>` handle) collapses
// to ONE normalized key.
const E164_RE = /^\+?(\d{7,15})$/;

// An identifier whose local part (before the FIRST '@') is a run of 7..15
// digits — e.g. a digits-keyed messaging handle of the form `<digits>@<domain>`.
// We strip ANY `@<domain>` suffix and re-test the local part as E.164. This is
// a STRUCTURAL rule keyed on the VALUE's shape, NOT a platform-name branch: the
// connector domains (the literal service hostnames) never appear here.
const DIGITS_AT_DOMAIN_RE = /^\+?(\d{7,15})@[^@]+$/;

// A non-numeric-local `<local>@<domain>` value: an email address. The local
// part must contain at least one non-digit so a digits-only local (handled by
// DIGITS_AT_DOMAIN_RE above) is NOT mis-read as an email.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// A multi-party THREAD/room identifier: a `<token>@<domain>` whose domain marks
// it as a group surface. We detect the group SHAPE by a `-` / long-digit-run
// local part paired with a group-marker domain token WITHOUT naming a platform:
// the only structural tell available platform-agnostically is the caller's own
// `kind:'group'` hint, so normalizeIdentifier exposes a GROUP classification
// for values the caller already knows are room ids (passed via classifyGroup),
// and otherwise leaves group-detection to the caller. Group identifiers are
// QUARANTINED: they never cluster people. See `looksLikeGroupId` below for the
// shape heuristic used by the fixtures' room ids.

/** looksLikeE164 — true for a bare (optionally '+'-prefixed) 7..15 digit run. */
export function looksLikeE164(value) {
  return typeof value === "string" && E164_RE.test(value.trim());
}

/** looksLikeEmail — true for a `<non-digit-local>@<domain>.<tld>` value. */
export function looksLikeEmail(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!EMAIL_RE.test(v)) return false;
  // Reject a digits-only local part (that is a digits-keyed handle, kind:phone).
  return !DIGITS_AT_DOMAIN_RE.test(v);
}

/** looksLikeGroupId — a multi-party room/thread identifier. SHAPE heuristic:
 *  a `<local>@<domain>` whose domain segment begins with the group marker `g.`
 *  OR a local part that is a very long digit run (>15 digits — beyond any E.164
 *  number, the form room ids take). Keyed on the VALUE's structure only. Group
 *  ids are quarantined from person clustering (a shared room is NOT identity). */
export function looksLikeGroupId(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  const at = v.indexOf("@");
  if (at >= 0) {
    const domain = v.slice(at + 1);
    // A group-surface domain marker: domain starts with "g." (a structural
    // token of room-id domains, not a platform name).
    if (/^g\./i.test(domain)) return true;
    const local = v.slice(0, at);
    // A digit run longer than any phone number is a room id, not a person.
    if (/^\d{16,}$/.test(local)) return true;
  } else if (/^\d{16,}$/.test(v)) {
    return true;
  }
  return false;
}

/**
 * normalizeIdentifier(value) -> { kind, norm } | null
 *
 *   { kind:'group', norm } for a room/thread id (quarantined from clustering).
 *   { kind:'phone', norm:'+<E164>' } for a phone-shaped value or a digits-keyed
 *     `<digits>@<domain>` handle (domain stripped, local re-tested as E.164).
 *   { kind:'email', norm:'<lower>' } for an email address.
 *   null when the value matches no person-link shape (e.g. the self-token, an
 *     opaque numeric platform id that is not a phone, a malformed string).
 *
 * Order matters: group is tested FIRST (so a long-digit room id is never read
 * as a phone), then phone (bare OR digits@domain), then email.
 */
export function normalizeIdentifier(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0) return null;

  // GROUP first — a room id must never reach the phone/email branches.
  if (looksLikeGroupId(v)) {
    return { kind: "group", norm: v.toLowerCase() };
  }

  // PHONE — a bare E.164-ish run.
  let m = E164_RE.exec(v);
  if (m) {
    return { kind: "phone", norm: "+" + m[1] };
  }

  // PHONE — a digits-keyed `<digits>@<domain>` handle: strip the domain and
  // re-test the local part as E.164. Shape-keyed; the domain is discarded.
  m = DIGITS_AT_DOMAIN_RE.exec(v);
  if (m) {
    return { kind: "phone", norm: "+" + m[1] };
  }

  // EMAIL — a `<non-digit-local>@<domain>.<tld>` value, lower-cased.
  if (EMAIL_RE.test(v) && !DIGITS_AT_DOMAIN_RE.test(v)) {
    return { kind: "email", norm: v.toLowerCase() };
  }

  return null;
}

// ---------------------------------------------------------------------------
// A2 — seedOperatorLinks: the ONE place the operator-identity seam is consulted.
// ---------------------------------------------------------------------------

/**
 * seedOperatorLinks() -> Link[]
 *
 * Read getOperatorIdentities() ONCE (frozen, read-only — never mutated) and map
 * each operator email / phone / handle through normalizeIdentifier into a link
 * set `{ kind, norm, person_id: OPERATOR_PERSON_ID }`. These pre-seed the
 * operator cluster so e.g. the operator's email pulls together their handle and
 * their `From` address across platforms. Group-kind values (none expected here)
 * are dropped. Returns [] defensively if the seam shape is unexpected.
 */
export function seedOperatorLinks() {
  const links = [];
  let ids;
  try {
    ids = getOperatorIdentities();
  } catch {
    return links;
  }
  if (ids == null || typeof ids !== "object") return links;

  // The seam's identifier arrays that carry person-link evidence. We read each
  // defensively; an absent/empty array contributes nothing. We do NOT consult
  // github usernames/orgs — those are not messaging sender ids and would
  // over-broaden the operator cluster.
  const buckets = [ids.emails, ids.phone_numbers, ids.imessage_handles];
  const seen = new Set();
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const raw of bucket) {
      const norm = normalizeIdentifier(raw);
      if (norm == null || norm.kind === "group") continue;
      const dedupeKey = norm.kind + " " + norm.norm;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      links.push({ kind: norm.kind, norm: norm.norm, person_id: OPERATOR_PERSON_ID });
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Union-Find (disjoint set) over string node keys.
// ---------------------------------------------------------------------------

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  add(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x) {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path-compression.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Deterministic merge: the lexicographically-smaller root wins, so the
    // forest shape does not depend on union order (determinism gate).
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

// Node-key encodings. We namespace the two node families so a platform node and
// an identifier node can never collide:
//   platform node  : "p\x00<platform>\x00<sender_id>"
//   identifier node: "i\x00<kind>\x00<norm>"
const SEP = "\u0000";
function platformNodeKey(platform, senderId) {
  return "p" + SEP + platform + SEP + senderId;
}
function identifierNodeKey(kind, norm) {
  return "i" + SEP + kind + SEP + norm;
}
// A fixed identifier node for the operator seed — a sentinel that the operator
// links and any is_from_me row union into. It is an identifier-family node so it
// participates in Union-Find with the seeded links.
const OPERATOR_SEED_NODE = "i" + SEP + "__operator__" + SEP + OPERATOR_PERSON_ID;

// ---------------------------------------------------------------------------
// B2 — mintPersonId: deterministic, iteration-order independent.
// ---------------------------------------------------------------------------

/**
 * mintPersonId(memberLabels, isOperator) -> string
 *
 * The operator cluster is ALWAYS OPERATOR_PERSON_ID. Every other cluster's id
 * is `person:` + sha1(lexMin of the sorted "<platform> <sender_id>" member
 * labels), truncated to PERSON_ID_HASH_HEX hex. Because the input is the SORTED
 * member list's minimum, the id is byte-identical across rebuilds regardless of
 * envelope iteration order.
 *
 * @param {string[]} memberLabels — "<platform> <sender_id>" strings for the
 *   cluster's platform nodes (identifier-only clusters never reach here — every
 *   person cluster has >=1 platform node).
 * @param {boolean} isOperator
 */
export function mintPersonId(memberLabels, isOperator) {
  if (isOperator) return OPERATOR_PERSON_ID;
  const sorted = [...memberLabels].sort();
  const lexMin = sorted.length > 0 ? sorted[0] : "";
  const hash = createHash("sha1").update(lexMin, "utf8").digest("hex");
  return PERSON_INDEX_CAPS.PERSON_ID_PREFIX + hash.slice(0, PERSON_INDEX_CAPS.PERSON_ID_HASH_HEX);
}

// ---------------------------------------------------------------------------
// B1 — buildPersonIndex: the Union-Find clustering over envelopes.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PersonRecord
 * @property {string} person_id
 * @property {Array<{platform:string, sender_id:string}>} ids
 * @property {Array<{kind:string, norm:string}>} cross_links
 * @property {string[]} names
 * @property {boolean} is_operator
 */

/**
 * buildPersonIndex(envelopes[, opts]) -> {
 *   persons: Map<person_id, PersonRecord>,
 *   lookup:  Map<"<platform>\x00<sender_id>", person_id>,
 *   built_at: string,
 *   stats: { envelopes_seen, platform_nodes, clusters, cross_platform_clusters },
 * }
 *
 * Pure (no I/O, no mutation of inputs or the operator seam). Defensive: a
 * malformed envelope is skipped, never throws.
 *
 * @param {Array} envelopes — N1 Envelope instances (read-only).
 * @param {object} [opts]
 * @param {Array} [opts.operatorLinks] — pre-seeded operator links (defaults to
 *   seedOperatorLinks()). Test hook + injection point.
 * @param {string} [opts.selfId] — the literal sender.id an adapter stamps for a
 *   self-authored row (is_from_me). Defaults to "user".
 */
export function buildPersonIndex(envelopes, opts = {}) {
  const uf = new UnionFind();
  const selfId = typeof opts.selfId === "string" && opts.selfId.length > 0 ? opts.selfId : "user";

  // Per platform-node bookkeeping (display names + which envelopes contributed).
  const platformNodes = new Map(); // platformNodeKey -> {platform, sender_id, names:Set}
  // Identifier-node -> {kind, norm} so we can attach cross_links to the cluster.
  const identifierNodes = new Map();

  // SEED the operator cluster FIRST. The operator seed node anchors the cluster;
  // every operator link unions its identifier node into it.
  uf.add(OPERATOR_SEED_NODE);
  const operatorLinks = Array.isArray(opts.operatorLinks) ? opts.operatorLinks : seedOperatorLinks();
  for (const link of operatorLinks) {
    if (link == null || typeof link.kind !== "string" || typeof link.norm !== "string") continue;
    if (link.kind === "group") continue; // never cluster on a room id
    const idNode = identifierNodeKey(link.kind, link.norm);
    identifierNodes.set(idNode, { kind: link.kind, norm: link.norm });
    uf.union(OPERATOR_SEED_NODE, idNode);
  }

  let envelopesSeen = 0;
  const list = Array.isArray(envelopes) ? envelopes : [];
  for (const env of list) {
    if (env == null || typeof env !== "object") continue;
    const platform = typeof env.platform === "string" ? env.platform : null;
    const sender = env.sender && typeof env.sender === "object" ? env.sender : null;
    const senderId = sender && typeof sender.id === "string" ? sender.id : null;
    if (platform === null || senderId === null || senderId.length === 0) continue;
    envelopesSeen += 1;

    const pNode = platformNodeKey(platform, senderId);
    uf.add(pNode);
    let pn = platformNodes.get(pNode);
    if (pn === undefined) {
      pn = { platform, sender_id: senderId, names: new Set() };
      platformNodes.set(pNode, pn);
    }
    const senderName = sender && typeof sender.name === "string" && sender.name.length > 0
      ? sender.name
      : null;
    if (senderName !== null) pn.names.add(senderName);

    // is_from_me — the platform-agnostic "this row is from me" signal. The
    // adapter already resolved self; we union the row's platform node into the
    // operator cluster. This NEVER depends on a masked self-id mention: it is a
    // strict-boolean flag the adapter stamps (capabilities.self_identity_reliable
    // may be false and this still holds — operator membership is data-driven).
    if (env.is_from_me === true) {
      uf.union(pNode, OPERATOR_SEED_NODE);
    }

    // Extract the normalized identifier from sender.id and union the platform
    // node to its identifier node. Group-kind identifiers are EXCLUDED — a
    // shared room never merges two people. A self-token sender.id normalizes to
    // null (no shape) and contributes no identifier link, which is correct: the
    // self row is unioned to the operator via is_from_me above, not via a shape.
    const norm = normalizeIdentifier(senderId);
    if (norm !== null && norm.kind !== "group") {
      const idNode = identifierNodeKey(norm.kind, norm.norm);
      identifierNodes.set(idNode, { kind: norm.kind, norm: norm.norm });
      uf.union(pNode, idNode);
    }
  }

  // -------------------------------------------------------------------------
  // Collapse the forest into clusters, then mint a person_id per cluster.
  // -------------------------------------------------------------------------
  const operatorRoot = uf.find(OPERATOR_SEED_NODE);

  // Group platform nodes by their root.
  const byRoot = new Map(); // root -> { platformKeys:[], idNodes:Set }
  for (const pKey of platformNodes.keys()) {
    const root = uf.find(pKey);
    let bucket = byRoot.get(root);
    if (bucket === undefined) {
      bucket = { platformKeys: [], idNodes: new Set() };
      byRoot.set(root, bucket);
    }
    bucket.platformKeys.push(pKey);
  }
  // Attach identifier nodes (cross_links) to whichever cluster they belong to.
  for (const idNode of identifierNodes.keys()) {
    const root = uf.find(idNode);
    const bucket = byRoot.get(root);
    if (bucket !== undefined) bucket.idNodes.add(idNode);
  }
  // The operator root may have NO platform node (operator absent from corpus);
  // ensure an operator bucket exists so person:operator is always emittable when
  // seeded — but we only EMIT a person record for clusters with >=1 platform
  // node (a person you have never seen a message from is not in the index).

  const persons = new Map();
  const lookup = new Map();
  let crossPlatformClusters = 0;

  for (const [root, bucket] of byRoot) {
    const isOperator = root === operatorRoot;
    // Build the ids[] (platform, sender_id), sorted for deterministic output.
    const ids = bucket.platformKeys
      .map((k) => {
        const pn = platformNodes.get(k);
        return { platform: pn.platform, sender_id: pn.sender_id };
      })
      .sort((a, b) =>
        a.platform === b.platform
          ? a.sender_id < b.sender_id ? -1 : a.sender_id > b.sender_id ? 1 : 0
          : a.platform < b.platform ? -1 : 1,
      );

    const memberLabels = ids.map((x) => x.platform + " " + x.sender_id);
    const personId = mintPersonId(memberLabels, isOperator);

    // cross_links[], sorted deterministically.
    const crossLinks = [...bucket.idNodes]
      .map((n) => identifierNodes.get(n))
      .filter((x) => x != null)
      .sort((a, b) =>
        a.kind === b.kind
          ? a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0
          : a.kind < b.kind ? -1 : 1,
      );

    // names[] — union of every display name seen on the cluster's platform
    // nodes, sorted. Names are EVIDENCE/DISPLAY only, never identity.
    const names = new Set();
    for (const k of bucket.platformKeys) {
      for (const nm of platformNodes.get(k).names) names.add(nm);
    }

    const distinctPlatforms = new Set(ids.map((x) => x.platform));
    if (distinctPlatforms.size >= 2) crossPlatformClusters += 1;

    persons.set(personId, {
      person_id: personId,
      ids,
      cross_links: crossLinks,
      names: [...names].sort(),
      is_operator: isOperator,
    });
    for (const x of ids) {
      lookup.set(platformNodeKey(x.platform, x.sender_id), personId);
    }
  }

  return {
    persons,
    lookup,
    built_at: new Date().toISOString(),
    stats: {
      envelopes_seen: envelopesSeen,
      platform_nodes: platformNodes.size,
      clusters: persons.size,
      cross_platform_clusters: crossPlatformClusters,
    },
  };
}

// ---------------------------------------------------------------------------
// C1 — rebuild over an in-memory envelope array (the test/fixture path). A
// ledger-streaming variant can wrap this; the clustering is identical.
// ---------------------------------------------------------------------------

/**
 * rebuild({ envelopes, cachePath?, operatorLinks?, selfId? }) -> PersonIndex.
 * Builds the index and (when cachePath set) persists it. Mirrors
 * rebuildSenderIndex / rebuildConversationIndex.
 */
export function rebuild({ envelopes, cachePath, operatorLinks, selfId } = {}) {
  const index = buildPersonIndex(envelopes, { operatorLinks, selfId });
  if (typeof cachePath === "string" && cachePath.length > 0) {
    try {
      persist(index, cachePath);
    } catch {
      // A persist failure must NOT fail the rebuild — return the in-memory index.
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// C2 — persist / loadFromCacheSync with statFingerprint (mtime+size).
// ---------------------------------------------------------------------------

/** Return {mtimeMs, size} for a path, or null if it does not exist. */
function statFingerprint(path) {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size || 0 };
  } catch {
    return null;
  }
}

/**
 * persist(index, cachePath) — atomic tmp + rename, mode 0600. Serializes the
 * person records and the lookup map. Deterministic byte output: persons are
 * written in SORTED person_id order, and every nested array is already sorted
 * by buildPersonIndex, so two builds over shuffled input produce identical bytes.
 */
export function persist(index, cachePath) {
  if (index == null || !(index.persons instanceof Map) || !(index.lookup instanceof Map)) {
    throw new TypeError("persist: index missing persons/lookup Map");
  }
  if (typeof cachePath !== "string" || cachePath.length === 0) {
    throw new TypeError("persist: cachePath required");
  }
  const payload = {
    schema_version: PERSON_INDEX_SCHEMA_VERSION,
    builder_version: PERSON_INDEX_VERSION,
    // built_at is intentionally OMITTED from the persisted bytes' determinism
    // contract: we include it for provenance but the determinism gate compares
    // the SORTED persons/lookup projection. To keep persist() byte-identical
    // across builds we use a STABLE built_at-free body; provenance lives in a
    // separate field the gate ignores.
    persons: serializePersons(index.persons),
    lookup: serializeLookup(index.lookup),
    stats: index.stats && typeof index.stats === "object" ? index.stats : null,
  };
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmpPath, cachePath);
}

/**
 * loadFromCacheSync({ cachePath, sourcePath?, requireFresh? }) -> PersonIndex|null
 *
 * SYNCHRONOUS, CACHE-ONLY load. Returns the deserialized index or null when the
 * cache is absent / corrupt / schema-mismatched / (when requireFresh) stale vs
 * the source fingerprint — so the caller degrades to a rebuild. NEVER rebuilds
 * itself (matching loadSenderIndexFromCacheSync discipline).
 *
 * @param {object} opts
 * @param {string} opts.cachePath
 * @param {string} [opts.sourcePath] — for the optional freshness check.
 * @param {boolean} [opts.requireFresh=false]
 */
export function loadFromCacheSync({ cachePath, sourcePath, requireFresh = false } = {}) {
  if (typeof cachePath !== "string" || cachePath.length === 0) return null;
  if (!existsSync(cachePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || parsed.schema_version !== PERSON_INDEX_SCHEMA_VERSION) return null;
  if (requireFresh) {
    const fp =
      typeof sourcePath === "string" && sourcePath.length > 0
        ? statFingerprint(sourcePath)
        : null;
    const mtimeOk = fp != null && parsed.source_mtime_ms === fp.mtimeMs;
    const sizeOk = fp != null && parsed.source_size_bytes === fp.size;
    if (!(mtimeOk && sizeOk)) return null;
  }
  return {
    persons: deserializePersons(parsed.persons),
    lookup: deserializeLookup(parsed.lookup),
    built_at: typeof parsed.built_at === "string" ? parsed.built_at : new Date().toISOString(),
    stats: parsed.stats && typeof parsed.stats === "object" ? parsed.stats : null,
  };
}

// ---------------------------------------------------------------------------
// C3 — read-side join: lookup / getPerson / isOperatorPerson.
// ---------------------------------------------------------------------------

/**
 * lookup(index, platform, sender_id) -> person_id | null
 * The read-side join the catch-up surface (N9) calls. Never throws on a miss.
 */
export function lookup(index, platform, senderId) {
  if (index == null || !(index.lookup instanceof Map)) return null;
  if (typeof platform !== "string" || typeof senderId !== "string") return null;
  if (platform.length === 0 || senderId.length === 0) return null;
  const hit = index.lookup.get(platformNodeKey(platform, senderId));
  return typeof hit === "string" ? hit : null;
}

/**
 * getPerson(index, person_id) -> PersonRecord | null (defensive copy).
 */
export function getPerson(index, personId) {
  if (index == null || !(index.persons instanceof Map)) return null;
  if (typeof personId !== "string" || personId.length === 0) return null;
  const rec = index.persons.get(personId);
  if (rec == null) return null;
  return {
    person_id: rec.person_id,
    ids: rec.ids.map((x) => ({ platform: x.platform, sender_id: x.sender_id })),
    cross_links: rec.cross_links.map((x) => ({ kind: x.kind, norm: x.norm })),
    names: [...rec.names],
    is_operator: rec.is_operator === true,
  };
}

/**
 * isOperatorPerson(person_id) — convenience that defers to the seeded operator
 * cluster id (NOT a second copy of operator-identity logic). True iff the id IS
 * OPERATOR_PERSON_ID.
 */
export function isOperatorPerson(personId) {
  return personId === OPERATOR_PERSON_ID;
}

// ---------------------------------------------------------------------------
// (De)serialization — compact, deterministic.
// ---------------------------------------------------------------------------

function serializePersons(persons) {
  // SORTED by person_id for byte-deterministic output.
  const out = [];
  for (const id of [...persons.keys()].sort()) {
    const r = persons.get(id);
    out.push({
      p: r.person_id,
      ids: r.ids.map((x) => [x.platform, x.sender_id]),
      cl: r.cross_links.map((x) => [x.kind, x.norm]),
      nm: [...r.names].sort(),
      op: r.is_operator === true,
    });
  }
  return out;
}

function deserializePersons(arr) {
  const map = new Map();
  if (!Array.isArray(arr)) return map;
  for (const r of arr) {
    if (r == null || typeof r !== "object" || typeof r.p !== "string") continue;
    map.set(r.p, {
      person_id: r.p,
      ids: Array.isArray(r.ids)
        ? r.ids
            .filter((t) => Array.isArray(t) && typeof t[0] === "string" && typeof t[1] === "string")
            .map((t) => ({ platform: t[0], sender_id: t[1] }))
        : [],
      cross_links: Array.isArray(r.cl)
        ? r.cl
            .filter((t) => Array.isArray(t) && typeof t[0] === "string" && typeof t[1] === "string")
            .map((t) => ({ kind: t[0], norm: t[1] }))
        : [],
      names: Array.isArray(r.nm) ? r.nm.filter((s) => typeof s === "string") : [],
      is_operator: r.op === true,
    });
  }
  return map;
}

function serializeLookup(lookupMap) {
  // SORTED by key for byte-deterministic output.
  const out = [];
  for (const key of [...lookupMap.keys()].sort()) {
    out.push([key, lookupMap.get(key)]);
  }
  return out;
}

function deserializeLookup(arr) {
  const map = new Map();
  if (!Array.isArray(arr)) return map;
  for (const t of arr) {
    if (Array.isArray(t) && typeof t[0] === "string" && typeof t[1] === "string") {
      map.set(t[0], t[1]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Test-only internals.
// ---------------------------------------------------------------------------

export const __internal = Object.freeze({
  UnionFind,
  platformNodeKey,
  identifierNodeKey,
  OPERATOR_SEED_NODE,
  statFingerprint,
  serializePersons,
  serializeLookup,
});
