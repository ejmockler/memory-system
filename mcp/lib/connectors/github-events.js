// GitHub events connector — polls `gh api /users/<self>/events` and appends
// one source-ledger row per event to storage/sources/github-events.jsonl.
//
// Authoritative spec: kb/connectors-survey.md § github-events row + kb/
// ingestion.md § Connector contract. ConnectorBase (lib/connectors/index.js)
// supplies the cursor + idempotent append + source_policy stamping + health
// + revoke discipline; this module supplies the gh-CLI shell-out, the
// per-event row builder, and the consent classifier.
//
// AUTH: zero credentials owned by this connector. The `gh` CLI is authed
// via the macOS Keychain (operator runs `gh auth login` out-of-band). The
// only PATH requirement is that `gh` is resolvable; the constructor lets
// callers override `ghBin` for tests.
//
// CURSOR STRATEGY: GitHub events carry a numeric, monotonically-increasing
// `id` field (per the events API docs: each event has a unique id and they
// are returned newest-first). We persist `last_event_id` (numeric string,
// preserved as string to avoid 53-bit float drift) and on every poll skip
// any event whose id is <= last_event_id. The first poll has no cursor so
// every returned event ingests. The 30-day retention window (since
// 2025-01-30) means a daemon offline > 30 days loses prior events; that is
// acceptable — github-events is corroborating signal, not the primary
// substrate.
//
// CLASSIFIER: per kb/connectors-survey.md § github-events:
//   - actor.login == username AND repo.owner.login == username
//       => first_party (operator's action on operator's repo)
//   - actor.login == username AND repo.owner.login != username
//       => third_party_inferred (operator's action on someone else's repo
//          — the parent issue/PR may include non-consenting authors)
//   - actor.login != username
//       => SKIP (shouldn't happen on /users/<self>/events but defensive)
//
// RATE LIMIT: gh's REST surface uses the same 5000 req/hour bucket. We
// observe the `X-RateLimit-Remaining` header via `gh api --include`. When
// remaining <= 0 we sleep until `X-RateLimit-Reset` (epoch seconds) before
// retrying. In `runOnce` we report the condition and return appended:0
// rather than blocking.
//
// 5XX BACKOFF: in `runForever` we use exponential backoff (5s, 30s, 300s)
// and tagError() each failure; the cursor crosses CONNECTOR_ERROR_THRESHOLD
// and the supervisor surfaces "degraded" via memory_connectors_list.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { ConnectorBase } from "./index.js";

// F-INFRA-R42-IDENTITY / F-NEW-R42-CONSUMER-MIGRATION (github-events slice):
// Canonical operator-identity module is the single source of truth for
// "is this GitHub login the operator?". Replaces the prior pattern that
// compared `ev.actor.login === this.username` only — we now ALSO honor the
// canonical GITHUB_USERNAMES list so events from any operator-controlled
// account (e.g. example-org alongside alex-example) classify as first_party
// consistently with git-log and other consumers.
import { isOperator, getOperatorIdentities } from "../identity/operator-identity.js";

// F-INFRA-R43-BOT-ACTORS / F-NEW-R43-CONNECTOR-WIRING (github-events slice):
// Canonical bot-actor predicate. Used here to populate raw_content.actor_login
// so the downstream stage-0 filter can detect bot events using the same
// predicate the connector-side classification path agrees with. The inlined
// bot regex previously lived in stage0/githubevents.js as a CAPS-driven
// `new RegExp(...)`; this slice removes that drift in tandem with the stage-0
// migration so connector + stage-0 classification stay in lockstep.
import { isBotActor } from "../identity/bot-actors.js";
// TIME_ANCHORS_MAX_PER_FACT is the RESOLVER's cap. The connector's CAPS bag
// re-exports it (tests read the bag), but it does not re-declare the number:
// the resolver is the single source of truth and this import is what makes
// that sentence true. time-anchor-resolver.js has zero imports of its own, so
// it is a leaf and no cycle is constructible through this edge.
import { TIME_ANCHOR_RESOLVER_CAPS } from "../synthesis/time-anchor-resolver.js";

const SOURCE = "github-events";

// Backoff schedule for 5xx errors. Match the discipline the watermark daemon
// uses for Gemini 5xx (5s, 30s, 300s ladder). Bounded; the supervisor
// restarts the daemon if it stays unhealthy past CONNECTOR_ERROR_THRESHOLD.
const BACKOFF_SCHEDULE_MS = [5000, 30000, 300000];

// Default poll interval in runForever (24h, matches "daily" cadence from
// kb/connectors-survey.md). The cursor restart-recovery property means
// missed polls cost nothing as long as the daemon comes back within the
// 30-day retention window.
const DEFAULT_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

// F-NEW-W7-GITHUB-PUSHEVENT-BACKFILL (R52) — PushEvent commit-message
// backfill cache. The github-events `/users/<self>/events` endpoint
// returns a PushEvent payload whose `commits[]` array is truncated to
// the first 20 commits AND, more commonly, completely empty for
// branch-tip pushes that the events API summarises down to {commits:0,
// first_message:null}. The W7 audit found 366/468 (78%) of github-events
// rows were empty PushEvents shaped that way, which (a) breaks the
// cross-source corroboration path against git-log SHA and (b) makes the
// Stage-0 W7 repo-ownership gate over-drop on operator-owned repos
// whose pushes happen to land in the "empty" shape.
//
// The backfill resolves this by issuing a second gh API call:
//   GET /repos/{owner}/{repo}/compare/{before}...{head}
// which returns the full commit list between the two SHAs. We pick the
// FIRST commit's message and populate raw_content.first_message so the
// downstream Stage-0 empty-push predicate stops firing (the row recovers
// to the substantive_prose path).
//
// Cache is keyed on `${repoFullName}\x00${head}`; head SHA is the
// canonical "did we already resolve this push?" key. TTL is 5 minutes —
// matches the gitlog-SHA index TTL on the Stage-0 side so a freshly
// landed git-log row is visible to the next github-events poll without
// staleness drift. The cache is process-local; the daemon restarts on
// supervisor failure so stale entries clear naturally on restart.
//
// RATE LIMITING: every cache MISS issues one gh API call. The gh REST
// surface shares the 5000 req/hour bucket; pollOnce already surfaces
// rate-limit errors via the existing `gh_rate_limited` tagError path. If
// the compare call returns non-zero we log and leave first_message=null
// — the Stage-0 empty-push rule then handles the row (operator-owned
// → 0.10 downgrade, third-party → quarantine) so a failed backfill is
// strictly non-blocking. NO retry; the next poll will see the same row
// has a non-null first_message via the cache, or re-attempt the fetch
// if the cache entry expired.
const PUSHEVENT_BACKFILL_CACHE_TTL_MS = 5 * 60 * 1000;
const _pushEventBackfillCache = new Map();

function _pushEventBackfillCacheKey(repoFullName, head) {
  return `${repoFullName}\x00${head}`;
}

function _pushEventBackfillGet(key) {
  const entry = _pushEventBackfillCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.builtAt > PUSHEVENT_BACKFILL_CACHE_TTL_MS) {
    _pushEventBackfillCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function _pushEventBackfillSet(key, value) {
  // Bound the cache to a small ceiling to avoid unbounded growth on a
  // long-running daemon. 4096 entries × ~120 bytes/entry ≈ 0.5MB worst
  // case. When we exceed the cap, evict the oldest entry — simple FIFO
  // discipline (Map preserves insertion order) is enough; we are not
  // hot-pathing the cache.
  const CAP = 4096;
  if (_pushEventBackfillCache.size >= CAP) {
    const firstKey = _pushEventBackfillCache.keys().next().value;
    if (firstKey !== undefined) _pushEventBackfillCache.delete(firstKey);
  }
  _pushEventBackfillCache.set(key, { value, builtAt: Date.now() });
}

// Test surface — let test harnesses reset the backfill cache so subsequent
// pollOnce invocations re-issue the compare call without TTL waiting.
export function _resetPushEventBackfillCacheForTest() {
  _pushEventBackfillCache.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Numeric compare on event ids. GitHub returns them as STRINGS but they are
// 64-bit monotonic counters. We compare lexically when same length, else by
// length — equivalent to BigInt comparison without the BigInt cost.
// Semantics: returns true iff a strictly > b. A non-null id is always
// greater than null (null is the "no events seen yet" sentinel). Null > X
// is false; null > null is false.
function eventIdGreaterThan(a, b) {
  if (a == null) return false;
  if (b == null) return true;
  if (typeof a !== "string") a = String(a);
  if (typeof b !== "string") b = String(b);
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

// Default _ghExec — shell out to `gh api`. Returns {stdout, stderr, code,
// headers?}. Tests inject a stub via opts._ghExec.
function defaultGhExec(ghBin, args) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(ghBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => { reject(err); });
    child.on("close", (code) => { resolve({ stdout, stderr, code }); });
  });
}

// Build a compact payload_summary for a single event. We carry minimal
// shape per event_type — the row stays small (the source ledger feeds the
// distillation queue, and Gemini Flash sees the truncated excerpt). Anything
// the recall layer needs that isn't in the summary still lives in raw_content
// (we attach the original event under raw_content.event verbatim — costless
// for storage, useful for re-classification if the classifier evolves).
function summarizeEvent(ev) {
  const type = ev?.type || "UnknownEvent";
  const payload = ev?.payload || {};
  switch (type) {
    case "PushEvent": {
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      return {
        event_type: type,
        ref: payload.ref || null,
        commits: commits.length,
        head: payload.head || null,
        first_message: commits[0]?.message ?? null,
      };
    }
    case "IssueCommentEvent": {
      return {
        event_type: type,
        action: payload.action || null,
        issue_number: payload.issue?.number ?? null,
        issue_title: payload.issue?.title ?? null,
        comment_id: payload.comment?.id ?? null,
        comment_body: payload.comment?.body ?? null,
        issue_author: payload.issue?.user?.login ?? null,
      };
    }
    case "PullRequestEvent": {
      // F-NEW-W2-GH-BRANCH-LIFECYCLE-WINDOW (Wave 3): stamp the PR's head
      // ref name (e.g. "feature/foo") so the Stage-0 paired-activity
      // window can index this PullRequestEvent against the same
      // (repoBasename, ref) key it uses for the corresponding
      // CreateEvent/DeleteEvent. Without this field the PR opens never
      // pair with the branch lifecycle events on the same branch and the
      // window check under-counts paired activity. Falls back to null
      // when the payload shape lacks the head — gh's PullRequestEvent
      // payload reliably carries head.ref but we stay defensive.
      const headRef = payload.pull_request?.head?.ref ?? null;
      return {
        event_type: type,
        action: payload.action || null,
        pr_number: payload.number ?? null,
        pr_title: payload.pull_request?.title ?? null,
        pr_author: payload.pull_request?.user?.login ?? null,
        ref: headRef,
      };
    }
    case "PullRequestReviewEvent": {
      return {
        event_type: type,
        action: payload.action || null,
        pr_number: payload.pull_request?.number ?? null,
        pr_title: payload.pull_request?.title ?? null,
        review_state: payload.review?.state ?? null,
        review_body: payload.review?.body ?? null,
        pr_author: payload.pull_request?.user?.login ?? null,
      };
    }
    case "PullRequestReviewCommentEvent": {
      return {
        event_type: type,
        action: payload.action || null,
        pr_number: payload.pull_request?.number ?? null,
        comment_body: payload.comment?.body ?? null,
      };
    }
    case "IssuesEvent": {
      return {
        event_type: type,
        action: payload.action || null,
        issue_number: payload.issue?.number ?? null,
        issue_title: payload.issue?.title ?? null,
        issue_author: payload.issue?.user?.login ?? null,
      };
    }
    case "CreateEvent": {
      return {
        event_type: type,
        ref: payload.ref || null,
        ref_type: payload.ref_type || null,
      };
    }
    case "DeleteEvent": {
      return {
        event_type: type,
        ref: payload.ref || null,
        ref_type: payload.ref_type || null,
      };
    }
    case "ForkEvent": {
      return {
        event_type: type,
        forkee_full_name: payload.forkee?.full_name ?? null,
      };
    }
    case "WatchEvent": {
      return { event_type: type, action: payload.action || null };
    }
    case "ReleaseEvent": {
      return {
        event_type: type,
        action: payload.action || null,
        tag_name: payload.release?.tag_name ?? null,
        release_name: payload.release?.name ?? null,
      };
    }
    case "MemberEvent": {
      return {
        event_type: type,
        action: payload.action || null,
        member_login: payload.member?.login ?? null,
      };
    }
    default:
      return { event_type: type };
  }
}

// F-NEW-W7-GITHUB-PUSHEVENT-BACKFILL (R52) — fetch the first commit
// message for an empty PushEvent via the gh `compare` REST API. Returns
// the message string on success, or null on any failure (network,
// non-zero gh exit, JSON parse error, missing/empty commits[] in the
// response). All failure modes are non-blocking: the caller leaves
// first_message=null and the Stage-0 empty-push rule handles the row.
//
// Cache lookup happens upstream of this call in pollOnce so we can avoid
// a gh subprocess when the cache hits; this function is the slow path.
async function _fetchFirstCommitMessage(ghExec, repoFullName, beforeSha, headSha) {
  if (
    typeof repoFullName !== "string" ||
    !repoFullName.includes("/") ||
    typeof beforeSha !== "string" ||
    beforeSha.length === 0 ||
    typeof headSha !== "string" ||
    headSha.length === 0
  ) {
    return null;
  }
  // Skip the all-zero "before" SHA — GitHub uses 40 zeros to signal a
  // brand-new branch where the push has no predecessor commit. The
  // compare API cannot resolve that, so we'd waste a gh request.
  if (/^0+$/.test(beforeSha)) return null;

  const path = `/repos/${repoFullName}/compare/${beforeSha}...${headSha}`;
  let res;
  try {
    res = await ghExec(["api", path]);
  } catch {
    return null;
  }
  if (!res || res.code !== 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || "");
  } catch {
    return null;
  }
  const commits = Array.isArray(parsed?.commits) ? parsed.commits : [];
  if (commits.length === 0) return null;
  const msg = commits[0]?.commit?.message ?? commits[0]?.message ?? null;
  return typeof msg === "string" && msg.length > 0 ? msg : null;
}

// F-CCS-CONNECTOR-github-events-structural (W2-CCS) — module identity for
// the structured-features payload. The cascade-side validator (per
// docs/specs/ccs/structured-features-schema.md §3.2 + §7.2) rejects any
// emitter_version that does not match STRUCTURED_FEATURES_EMITTER_VERSION_REGEX
// `/^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/`. Format `<name>@<semver>`
// keeps the drift-detector path (OQ1) able to spot upgrades and re-extract.
// Workunit task identifier was "github-events-structural-v1"; we encode the same
// intent in the regex-conforming form.
export const STRUCTURED_FEATURES_EMITTER_VERSION = "github-events-structural@1.0.0";
export const STRUCTURED_FEATURES_SCHEMA_VERSION = "v1";

// CAPS frozen at module scope per W2-W12 discipline (`VERSION + frozen CAPS`).
// These mirror the foundation-spec §3.2 surface but are kept module-local so
// the connector can ship before `mcp/lib/synthesis/structured-features-schema.js`
// (the validator) lands. Defense-in-depth: emit-side caps stop oversized
// payloads at the source; the future merger MUST re-enforce its own copy.
export const CAPS = Object.freeze({
  // Same closed enum from entity-extractor.js + foundation spec §3.
  ENTITY_KINDS: Object.freeze([
    "person", "place", "org", "project", "event", "topic", "artifact",
  ]),
  // Connector-emit allowlist per foundation spec §3.2 — `ner_corroborated`
  // is reserved for the cascade text-extractor path exclusively.
  VALID_EVIDENCE_AT_CONNECTOR: Object.freeze([
    "handle", "structural", "kb_lookup",
  ]),
  // Foundation spec §3.2.
  ENTITY_MAX_PER_ROW: 32,
  // NOT a local literal: read from the resolver that owns the cap.
  TIME_ANCHORS_MAX_PER_FACT: TIME_ANCHOR_RESOLVER_CAPS.TIME_ANCHORS_MAX_PER_FACT,
  // Foundation spec §5.2 — surface-to-slug pipeline parameters reused locally
  // so the connector does not depend on entity-extractor.js for emit-time
  // canonicalization. Two slugify implementations diverging by a single step
  // is a defect; this one mirrors the 7 ordered steps verbatim and tests pin
  // byte-equality against the canonical pipeline.
  ENTITY_SLUG_MAX_LEN: 64,
  MIN_ENTITY_SURFACE_LEN: 3,
  SLUG_EMPTY_SENTINEL: "_empty_",
  ENTITY_SLUG_REGEX: /^[a-z0-9]+(_[a-z0-9]+)*$/,
});

// Module VERSION constant per W2-W12 discipline. The emitter_version above
// is the on-row payload identity; VERSION here is the file/module identity
// (matches the connector module's role in the supervisor inventory).
export const VERSION = "1.0.0";

// Local slugify — 7 ordered steps mirroring `mcp/lib/synthesis/entity-extractor.js`
// `slugify()` verbatim. Kept module-local so the connector emit path does not
// pull a synthesis import (and so a CI grep on slugify drift can flag any
// divergence between the two call sites). Pure-functional; no I/O.
function slugify(surface) {
  if (typeof surface !== "string") return CAPS.SLUG_EMPTY_SENTINEL;
  let x = surface;
  x = x.normalize("NFC");
  x = x.normalize("NFD").replace(/\p{M}/gu, "");
  // eslint-disable-next-line no-control-regex
  x = x.replace(/[^\x00-\x7F]/g, "");
  x = x.toLowerCase();
  x = x.replace(/[^a-z0-9]+/g, "_");
  x = x.replace(/^_+|_+$/g, "");
  if (x.length > CAPS.ENTITY_SLUG_MAX_LEN) x = x.slice(0, CAPS.ENTITY_SLUG_MAX_LEN);
  x = x.replace(/_+$/g, "");
  if (x.length === 0) return CAPS.SLUG_EMPTY_SENTINEL;
  return x;
}

// Build one Entity record matching the synthesis entity-schema.md §4 shape.
// Returns null if the surface trims to < MIN_ENTITY_SURFACE_LEN or slugifies
// to the empty sentinel (defensive: the emit path MUST NOT stamp the
// sentinel; per foundation spec §5.2 step 7 the gate drops it).
function buildEntity({ kind, surface, evidence }) {
  if (!CAPS.ENTITY_KINDS.includes(kind)) return null;
  if (!CAPS.VALID_EVIDENCE_AT_CONNECTOR.includes(evidence)) return null;
  if (typeof surface !== "string") return null;
  const trimmed = surface.trim();
  if ([...trimmed].length < CAPS.MIN_ENTITY_SURFACE_LEN) return null;
  const slug = slugify(trimmed);
  if (slug === CAPS.SLUG_EMPTY_SENTINEL) return null;
  if (!CAPS.ENTITY_SLUG_REGEX.test(slug)) return null;
  return {
    kind,
    canonical_id: `${kind}:github-events:${slug}`,
    surface: trimmed,
    source_scope: "github-events",
    evidence,
    confidence: 1.0,
    extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
  };
}

// F-CCS-CONNECTOR-github-events-structural (W2-CCS) — emit-time structural
// extraction. Switches on the gh `event_type` and stamps the connector-known
// surfaces (actor.login, repo basename + owner_repo, ref, pr_number,
// issue_number) into `structured_features.entities[]` + `time_anchors[]` so
// the salience cascade does not have to re-derive them from the flat
// `PushEvent refs/heads/X SHA` summary text. Per the W6 smoke-test finding
// (2026-06-20): the text-extractor saw 0 entities for github-events rows
// because the structural payload was buried inside `raw_content` — this
// helper lifts it to `row.structured_features` where the merger consumes it.
//
// SHAPE: returns the structured_features object per
// docs/specs/ccs/structured-features-schema.md §3.1, or `undefined` if the
// row is too malformed to extract anything safely (defensive degradation per
// W2-W12 discipline — backwards-compat with rows missing structured_features
// is preserved by the consumer-side `sf?.entities ?? []` short-circuit).
export function buildStructuredFeatures(row) {
  // Defensive: every input is hostile. Return undefined on any structural
  // violation so the cascade falls back to the text-extractor-only path
  // (per foundation spec §7.1 the merger short-circuits via `?? []`).
  if (row == null || typeof row !== "object") return undefined;
  const rc = row.raw_content;
  if (rc == null || typeof rc !== "object") return undefined;

  const eventType = typeof rc.event_type === "string" ? rc.event_type : "UnknownEvent";
  const repoFullName = typeof rc.repo === "string" ? rc.repo : "";
  const actorLogin = typeof rc.actor_login === "string" ? rc.actor_login : "";
  const createdAt = typeof rc.created_at === "string" ? rc.created_at : null;

  const entities = [];

  // Actor → person. Operator's gh login or (for events the connector never
  // emits but downstream re-extractors might process) any actor.login.
  if (actorLogin.length > 0) {
    const e = buildEntity({
      kind: "person",
      surface: actorLogin,
      evidence: "structural",
    });
    if (e) entities.push(e);
  }

  // Repo → project. Per workunit task: `project:gh:SLUG(owner_repo)` —
  // slugified `owner/repo` (the `/` collapses to `_`). The source_scope is
  // the schema-enum-valid "github-events"; the `gh:` shorthand in the node
  // JSON's implementation_hints is just naming convenience.
  if (repoFullName.length > 0) {
    const e = buildEntity({
      kind: "project",
      surface: repoFullName,
      evidence: "structural",
    });
    if (e) entities.push(e);
  }

  // Per-event-kind dispatch. Default arm is the "unknown event_type" path
  // (per workunit "default unknown event_type: minimal (actor + repo if
  // extractable)") — the actor + repo entities above already covered that.
  switch (eventType) {
    case "PushEvent": {
      // ref → topic. Surface preserved verbatim (`refs/heads/main`); slugify
      // canonicalizes to `refs_heads_main`. The topic carries enough surface
      // length to clear MIN_ENTITY_SURFACE_LEN even for the shortest branch
      // names (e.g. `main` → 4 chars).
      const ref = typeof rc.ref === "string" ? rc.ref : "";
      if (ref.length > 0) {
        const e = buildEntity({
          kind: "topic",
          surface: ref,
          evidence: "structural",
        });
        if (e) entities.push(e);
      }
      break;
    }
    case "PullRequestEvent": {
      // PR number → topic, with surface `pr-<number>` so the slug clears
      // MIN_ENTITY_SURFACE_LEN=3 even for PR #1 (`pr-1` → `pr_1`, length 4).
      const prNumber = rc.pr_number;
      if (typeof prNumber === "number" && Number.isFinite(prNumber) && prNumber >= 0) {
        const e = buildEntity({
          kind: "topic",
          surface: `pr-${prNumber}`,
          evidence: "structural",
        });
        if (e) entities.push(e);
      }
      // Also stamp the head ref if present (the connector already extracts
      // it for paired-activity windowing; surfacing it as topic too gives
      // the cascade a join key against CreateEvent/DeleteEvent rows).
      const ref = typeof rc.ref === "string" ? rc.ref : "";
      if (ref.length > 0) {
        const e = buildEntity({
          kind: "topic",
          surface: ref,
          evidence: "structural",
        });
        if (e) entities.push(e);
      }
      break;
    }
    case "IssuesEvent": {
      // Issue number → topic, same `issue-<number>` shape as PR for length.
      const issueNumber = rc.issue_number;
      if (typeof issueNumber === "number" && Number.isFinite(issueNumber) && issueNumber >= 0) {
        const e = buildEntity({
          kind: "topic",
          surface: `issue-${issueNumber}`,
          evidence: "structural",
        });
        if (e) entities.push(e);
      }
      break;
    }
    default: {
      // Unknown event_type: minimal payload (actor + repo if extractable).
      // No additional entities — the defaults above already cover it.
      break;
    }
  }

  // Sort entities by canonical_id (foundation spec invariant I7).
  entities.sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 :
    a.canonical_id > b.canonical_id ? 1 : 0,
  );

  // Cap at ENTITY_MAX_PER_ROW; defense-in-depth (the merger also caps).
  const cappedEntities = entities.slice(0, CAPS.ENTITY_MAX_PER_ROW);

  // time_anchors: prefer the EVENT clock (raw_content.created_at — the
  // moment the action happened on github.com) over row.ts (the moment the
  // connector polled). Per foundation spec §5.2 worked example: the
  // connector stamps the event clock; the cascade's row-ts-as-anchor node
  // separately stamps row.ts. The dedupe key collapses identical (kind, iso)
  // pairs so they coexist.
  const tsForAnchor = createdAt || (typeof row.ts === "string" ? row.ts : null);
  const timeAnchors = [];
  if (typeof tsForAnchor === "string" && tsForAnchor.length > 0) {
    timeAnchors.push({
      kind: "absolute",
      raw_phrase: tsForAnchor,
      parsed: { iso: tsForAnchor },
      extractor_confidence: 1.0,
      extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
      structural: true,
    });
  }

  // parties: canonicalized projection of `row.parties[]` reserved for
  // person-kind canonical_ids only (foundation spec §3.1). The operator
  // (actor) gets a canonical_id when actorLogin is non-empty; non-operator
  // parties go through the merger via `row.parties[]` separately (the
  // cascade's row-parties-as-entities node owns that path).
  const partiesCanonical = [];
  if (actorLogin.length > 0) {
    const slug = slugify(actorLogin);
    if (slug !== CAPS.SLUG_EMPTY_SENTINEL && CAPS.ENTITY_SLUG_REGEX.test(slug)) {
      partiesCanonical.push(`person:github-events:${slug}`);
    }
  }

  return {
    schema_version: STRUCTURED_FEATURES_SCHEMA_VERSION,
    emitter_version: STRUCTURED_FEATURES_EMITTER_VERSION,
    entities: cappedEntities,
    time_anchors: timeAnchors.slice(0, CAPS.TIME_ANCHORS_MAX_PER_FACT),
    parties: partiesCanonical,
  };
}

// Collect non-actor parties from the event payload. The classifier needs the
// repo owner; downstream recall may want issue/pr authors (since those are
// other people whose content is implicitly attached). We do NOT include the
// actor (operator) — they go in via parties[0] = "user".
function extractParties(ev, username) {
  const parties = ["user"];
  const repoOwner = ev?.repo?.name ? ev.repo.name.split("/")[0] : null;
  if (repoOwner && repoOwner !== username) {
    parties.push(`gh:${repoOwner}`);
  }
  const payload = ev?.payload || {};
  const candidates = [
    payload.issue?.user?.login,
    payload.pull_request?.user?.login,
    payload.comment?.user?.login,
    payload.review?.user?.login,
    payload.member?.login,
  ];
  for (const login of candidates) {
    if (typeof login === "string" && login !== "" && login !== username) {
      const tag = `gh:${login}`;
      if (!parties.includes(tag)) parties.push(tag);
    }
  }
  return parties;
}

// ---------------------------------------------------------------------------
// GitHubEventsConnector
// ---------------------------------------------------------------------------

export class GitHubEventsConnector extends ConnectorBase {
  constructor({ ghBin = "gh", username = null, _ghExec = null, operatorOrgs = null } = {}) {
    super({
      source: SOURCE,
      // Closure captures the resolved username from pollOnce. Set lazily
      // before the first appendLedgerRow; the constructor caller may also
      // supply username up-front and we honor it.
      sourcePolicyForRow: (row) => this._classify(row),
    });
    this.ghBin = ghBin;
    this.username = username;
    this._ghExec = _ghExec || ((args) => defaultGhExec(this.ghBin, args));
    // F-T2-GITHUB_EVENTS-F7 (Wave 2): explicit operator-orgs allowlist.
    // Resolves from the canonical R42 identity map (`github_orgs`) so the
    // connector reflects whatever the central identity registry knows. The
    // constructor honors a caller-supplied override (tests / env injection)
    // ahead of the central map; otherwise it pulls from getOperatorIdentities().
    // Surfaced in reportHealth() for operator-side debuggability.
    if (Array.isArray(operatorOrgs)) {
      this.operatorOrgs = operatorOrgs.slice();
    } else {
      try {
        const ids = getOperatorIdentities();
        this.operatorOrgs = Array.isArray(ids?.github_orgs)
          ? ids.github_orgs.slice()
          : [];
      } catch {
        this.operatorOrgs = [];
      }
    }
  }

  // The per-row source_policy closure. ConnectorBase invokes this once per
  // append; the row carries `_classifier_repo_owner` set by pollOnce so the
  // classifier never has to re-parse the raw event.
  //
  // F-NEW-R42-CONSUMER-MIGRATION (github-events slice): consent classification
  // now consults isOperator() against the canonical R42 GITHUB_USERNAMES map
  // rather than comparing against `this.username` alone. Rationale:
  // `this.username` is the operator's *active* gh login (the account `gh auth`
  // is currently bound to), but the operator may control multiple gh accounts
  // (e.g. alex-example + example-org) that all need to classify as first_party when
  // they appear as `repo.owner.login`. We keep the cheap `repoOwner ===
  // this.username` short-circuit for the common case to avoid an extra Set
  // lookup per row, then fall through to the canonical map.
  _classify(row) {
    const repoOwner = row?._classifier_repo_owner;
    if (typeof repoOwner === "string" && repoOwner !== "") {
      // F-T2-GITHUB_EVENTS-F7 (Wave 2): repo-owner first-party classification
      // now consults three signals in priority order:
      //   1. operator's active gh login (cheap string compare, common case)
      //   2. explicit operatorOrgs allowlist (e.g. ["example-org","example-labs"])
      //      derived from the canonical R42 identity map at construction time
      //      — this is the load-bearing line the predicate names verbatim
      //   3. canonical isOperator() lookup against the R42 GITHUB_USERNAMES /
      //      GITHUB_ORGS sets (catches alt accounts the operator controls but
      //      the active gh session is not bound to).
      // The operatorOrgs Array.includes() is O(n) but n is tiny (typically <10)
      // so the indirection cost is well under the cost of the row-write.
      const ownerLc =
        typeof repoOwner === "string" ? repoOwner.toLowerCase() : "";
      const orgsLc = (this.operatorOrgs || []).map((o) =>
        typeof o === "string" ? o.toLowerCase() : "",
      );
      if (
        repoOwner === this.username ||
        orgsLc.includes(ownerLc) ||
        isOperator(repoOwner, "github-events")
      ) {
        return { deletion_semantics: "full_excise", consent_basis: "first_party" };
      }
    }
    return { deletion_semantics: "full_excise", consent_basis: "third_party_inferred" };
  }

  // Resolve the operator's gh login. Cached on `this.username` after first
  // call; also persisted in the cursor as `username` so a fresh process can
  // skip the resolution call.
  async _resolveUsername(opts = {}) {
    if (this.username) return this.username;
    const state = await this.readCursor();
    if (state && typeof state.username === "string" && state.username !== "") {
      this.username = state.username;
      return this.username;
    }
    if (opts._whoami) {
      this.username = opts._whoami;
      return this.username;
    }
    const res = await this._ghExec(["api", "/user"]);
    if (res.code !== 0) {
      const reason = res.stderr ? res.stderr.split("\n")[0] : `gh exit ${res.code}`;
      const err = new Error(`gh api /user failed: ${reason}`);
      err.kind = "gh_user_resolve_failed";
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (e) {
      const err = new Error(`gh api /user returned non-JSON: ${e.message}`);
      err.kind = "gh_user_resolve_failed";
      throw err;
    }
    if (!parsed || typeof parsed.login !== "string" || parsed.login === "") {
      const err = new Error("gh api /user response missing login field");
      err.kind = "gh_user_resolve_failed";
      throw err;
    }
    this.username = parsed.login;
    return this.username;
  }

  // pollOnce — fetch events for the operator, dedupe via cursor, append.
  //
  // opts:
  //   _ghExec      — override gh shell-out (used by tests)
  //   _whoami      — short-circuit /user lookup with this login (tests)
  //   _fixtureEvents — array of events to use instead of shelling out
  //   now          — () => Date, override for deterministic ts
  //
  // Returns {appended, skipped, errors}.
  async pollOnce(opts = {}) {
    const now = typeof opts.now === "function" ? opts.now : () => new Date();
    if (opts._ghExec) this._ghExec = opts._ghExec;

    let username;
    try {
      username = await this._resolveUsername(opts);
    } catch (err) {
      await this.tagError(err.kind || "gh_user_resolve_failed");
      // Mark cursor as failed so reportHealth surfaces it. Preserve any
      // prior state so the next successful poll picks up clean.
      const prior = (await this.readCursor()) || {};
      await this.writeCursor({ ...prior, status: "failed", last_error_ts: now().toISOString() });
      return { appended: 0, skipped: 0, errors: 1 };
    }

    // Fetch events. Either inject a fixture or shell out.
    let events;
    if (Array.isArray(opts._fixtureEvents)) {
      events = opts._fixtureEvents;
    } else {
      const res = await this._ghExec(["api", `/users/${username}/events`, "--paginate"]);
      if (res.code !== 0) {
        const isAuth = /HTTP 401|authentication|not logged in/i.test(res.stderr || "");
        const isRate = /rate limit|HTTP 403/i.test(res.stderr || "");
        const kind = isAuth ? "gh_auth_failed" : isRate ? "gh_rate_limited" : "gh_api_failed";
        await this.tagError(kind);
        const prior = (await this.readCursor()) || {};
        await this.writeCursor({ ...prior, status: kind === "gh_auth_failed" ? "failed" : (prior.status || "ok"), last_error_ts: now().toISOString() });
        return { appended: 0, skipped: 0, errors: 1 };
      }
      try {
        events = JSON.parse(res.stdout);
      } catch (e) {
        await this.tagError("gh_response_parse_failed");
        return { appended: 0, skipped: 0, errors: 1 };
      }
      if (!Array.isArray(events)) {
        await this.tagError("gh_response_not_array");
        return { appended: 0, skipped: 0, errors: 1 };
      }
    }

    const priorState = (await this.readCursor()) || {};
    const cursor = priorState.last_event_id || null;
    // Round-21 (h) hot-fix: GitHub's event.id is "monotonic-ish" with rare
    // out-of-order delivery during partition events. Previous behavior was
    // strict skip on evId <= cursor — out-of-order LOWER ids got dropped
    // FOREVER. The corrected semantic: maintain a recent-ids LRU and only
    // skip if we've seen this specific id, not if it's "below the cursor".
    // The cursor still advances to max-seen-id (so the next poll's --paginate
    // can short-circuit at the right point), but the LRU is what we actually
    // dedupe against. Window size matches the API's typical out-of-order
    // window (a few hundred events at most).
    const RECENT_IDS_LRU_SIZE = 512;
    const recentIdsPrior = Array.isArray(priorState.recent_event_ids)
      ? priorState.recent_event_ids
      : [];
    const recentIdsSet = new Set(recentIdsPrior);
    let highestId = cursor;
    let appended = 0;
    let skipped = 0;
    let errors = 0;

    // Process oldest-first so the on-disk ledger order matches event order
    // (GitHub returns newest-first). Helps human-readable tails.
    const ordered = [...events].sort((a, b) => {
      const ai = a?.id || "";
      const bi = b?.id || "";
      if (ai.length !== bi.length) return ai.length - bi.length;
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });

    for (const ev of ordered) {
      if (ev == null || typeof ev !== "object") { skipped += 1; continue; }
      const evId = ev.id != null ? String(ev.id) : null;
      if (!evId) { skipped += 1; continue; }
      // Defensive: skip events where actor isn't the operator.
      const actorLogin = ev?.actor?.login;
      if (actorLogin !== username) { skipped += 1; continue; }
      // Cursor gating (round-21 (h) hot-fix): dedupe against the recent-ids
      // LRU rather than strict cursor monotonicity. Out-of-order events with
      // lower ids than `cursor` are STILL ingested as long as we haven't
      // seen their specific id before.
      if (recentIdsSet.has(evId)) { skipped += 1; continue; }
      const repoFullName = ev?.repo?.name || "";
      const repoOwner = repoFullName.includes("/") ? repoFullName.split("/")[0] : "";
      const summary = summarizeEvent(ev);
      // F-NEW-W7-GITHUB-PUSHEVENT-BACKFILL (R52): if this is a PushEvent
      // whose summarised commits[] is empty AND first_message is null,
      // attempt to backfill the first commit message via gh's compare API
      // (cached per (repo, head) for 5min). Success populates
      // summary.first_message so the Stage-0 empty-push predicate stops
      // firing and the row recovers via the substantive_prose path. On
      // any failure (rate limit, missing perms, malformed response) we
      // leave first_message=null and let Stage-0 handle the row per the
      // W7 ownership gate (operator-owned → 0.10 downgrade for git-log
      // SHA corroboration; third-party → quarantine).
      if (
        summary.event_type === "PushEvent" &&
        (summary.commits === 0 ||
          summary.commits == null ||
          (Array.isArray(summary.commits) && summary.commits.length === 0)) &&
        (summary.first_message == null ||
          (typeof summary.first_message === "string" &&
            summary.first_message.trim() === "")) &&
        typeof summary.head === "string" &&
        summary.head.length > 0 &&
        repoFullName.length > 0 &&
        repoFullName.includes("/")
      ) {
        const cacheKey = _pushEventBackfillCacheKey(repoFullName, summary.head);
        let backfilled = _pushEventBackfillGet(cacheKey);
        if (backfilled === undefined) {
          // Cache miss. The payload's `before` SHA is needed for the
          // compare call; defensive parse to tolerate missing field.
          const beforeSha = typeof ev?.payload?.before === "string"
            ? ev.payload.before
            : "";
          backfilled = await _fetchFirstCommitMessage(
            this._ghExec,
            repoFullName,
            beforeSha,
            summary.head,
          );
          // Cache BOTH success AND null — caching null avoids re-hammering
          // gh for the same (repo, head) when the compare call fails for
          // a structural reason (private fork, missing perms, all-zero
          // before SHA). The 5-min TTL bounds the staleness window.
          _pushEventBackfillSet(cacheKey, backfilled);
        }
        if (typeof backfilled === "string" && backfilled.length > 0) {
          summary.first_message = backfilled;
        }
      }
      const parties = extractParties(ev, username);
      // F-NEW-R43-CONNECTOR-WIRING (github-events slice): the audit found
      // that stage0/githubevents.js reads `raw_content.actor_login` to drive
      // bot detection, but summarizeEvent never wrote that field — so the
      // bot regex always ran against an empty string, dropping zero rows.
      // We now persist the gh `actor.login` (already validated above to
      // equal `username` for operator-side events) onto every row's
      // raw_content so the unified isBotActor() predicate downstream sees
      // a non-empty input. Persisting here (not via summarizeEvent's
      // event_type switch) keeps the field present on EVERY event_type
      // regardless of payload shape.
      const rawContent = {
        ...summary,
        repo: repoFullName,
        public: ev.public === true,
        created_at: ev.created_at || null,
        actor_login: actorLogin,
      };
      // F-CCS-CONNECTOR-github-events-structural (W2-CCS) — stamp the
      // connector-known structural surfaces (actor.login, repo basename,
      // ref, pr_number, issue_number) onto row.structured_features so the
      // salience cascade does not re-derive them from the flat summary
      // text. The helper returns undefined on any structural violation;
      // ConnectorBase's "extra top-level keys copy-through" path carries
      // the field verbatim when present, and the consumer-side
      // `sf?.entities ?? []` short-circuit handles absence (rows missing
      // structured_features cascade unchanged via the text-only path, per
      // foundation spec §7.1).
      let structuredFeatures;
      try {
        structuredFeatures = buildStructuredFeatures({
          raw_content: rawContent,
          ts: rawContent.created_at || now().toISOString(),
        });
      } catch {
        // Defensive degradation per W2-W12 discipline: a buildStructured
        // throw must NOT block the row from landing via the text-only path.
        structuredFeatures = undefined;
      }
      const row = {
        source_msg_id: `gh-event:${evId}`,
        ts: now().toISOString(),
        parties,
        raw_content: rawContent,
        // _classifier_repo_owner is consumed by _classify then dropped before
        // ConnectorBase stamps the row — but ConnectorBase passes the row to
        // sourcePolicyForRow before stamping, so the field round-trips
        // unconditionally. To keep the on-disk schema clean we strip it via
        // raw_content not carrying it; the top-level field is allowed by
        // ConnectorBase's "extra fields copy-through" path. Use a leading
        // underscore convention — downstream readers (distillation queue)
        // ignore underscore-prefixed top-level fields.
        _classifier_repo_owner: repoOwner,
        kind: "github_event",
      };
      // Only attach structured_features when defined — preserves backwards-
      // compat (rows without the field follow the text-only path).
      if (structuredFeatures !== undefined) {
        row.structured_features = structuredFeatures;
      }
      try {
        const res = await this.appendLedgerRow(row);
        if (res.appended) appended += 1; else skipped += 1;
      } catch (e) {
        errors += 1;
        await this.tagError("append_failed");
        continue;
      }
      // Round-21 (h) hot-fix: track the event id in the LRU on every successful
      // process attempt (including dedup-skips inside this loop body). Note: ids
      // we skipped via the early `recentIdsSet.has(evId)` short-circuit are
      // already in the set so this is a no-op for them.
      recentIdsSet.add(evId);
      if (eventIdGreaterThan(evId, highestId)) highestId = evId;
    }

    // Round-21 (h) hot-fix: trim the LRU to size. Sort by lexicographic id
    // (matches the API's "monotonic-ish" ordering); keep the most recent N.
    const recentIdsArray = Array.from(recentIdsSet).sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const recentIdsTrimmed = recentIdsArray.slice(-RECENT_IDS_LRU_SIZE);

    // Cursor advance — write whenever we advanced highestId OR added new
    // ids to the LRU (out-of-order events with id below cursor still need
    // to land in the LRU even though they don't move the cursor).
    const lruChanged = recentIdsTrimmed.length !== recentIdsPrior.length ||
      recentIdsTrimmed.some((id, i) => id !== recentIdsPrior[i]);
    if (highestId !== priorState.last_event_id || lruChanged) {
      const nowIso = now().toISOString();
      await this.writeCursor({
        ...priorState,
        username,
        last_event_id: highestId,
        recent_event_ids: recentIdsTrimmed,
        last_appended_ts: appended > 0 ? nowIso : priorState.last_appended_ts || null,
        last_appended_id: appended > 0 ? `gh-event:${highestId}` : priorState.last_appended_id || null,
        last_cursor_advance_ts: nowIso,
        error_count: 0,
        status: "ok",
      });
    } else if (priorState.username !== username) {
      // First-ever poll with no new events still needs to persist username +
      // mark the cursor as alive.
      const nowIso = now().toISOString();
      await this.writeCursor({
        ...priorState,
        username,
        last_event_id: priorState.last_event_id || null,
        recent_event_ids: recentIdsTrimmed,
        last_cursor_advance_ts: nowIso,
        error_count: 0,
        status: "ok",
      });
    }

    return { appended, skipped, errors };
  }

  // runOnce — single poll, then exit. Caller maps {appended, errors} to
  // a process exit code (0 if no errors, 1 otherwise).
  async runOnce(opts = {}) {
    return await this.pollOnce(opts);
  }

  // runForever — poll on a fixed cadence with bounded backoff on errors.
  // Tests do not exercise this path; the launchd plist invokes runOnce
  // periodically instead (KeepAlive=false + StartCalendarInterval).
  async runForever(opts = {}) {
    const intervalMs = opts.intervalMs || DEFAULT_POLL_INTERVAL_MS;
    let backoffAttempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.pollOnce(opts);
      if (res.errors > 0) {
        const sleep = BACKOFF_SCHEDULE_MS[Math.min(backoffAttempt, BACKOFF_SCHEDULE_MS.length - 1)];
        backoffAttempt += 1;
        await new Promise((r) => setTimeout(r, sleep));
      } else {
        backoffAttempt = 0;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI surface — `node lib/connectors/github-events.js [--once|--check]`
// ---------------------------------------------------------------------------
// `--check`  : print reportHealth() as JSON, exit 0
// `--once`   : run a single poll, print {appended, skipped, errors}, exit
// (no flag) : runForever (launchd KeepAlive path)
//
// This is the only entry-point the operator-installed plist invokes.

function isMain(metaUrl) {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  try {
    const url = new URL(metaUrl);
    return url.pathname === process.argv[1] || url.pathname.endsWith(process.argv[1].replace(/^.*\//, ""));
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const connector = new GitHubEventsConnector({});
  if (args.includes("--check")) {
    const h = connector.reportHealth();
    // F-T2-GITHUB_EVENTS-F7 (Wave 2): surface operatorOrgs in --check so the
    // operator can confirm the first-party allowlist that drives consent
    // classification. Review-question Q1 ("is the org list configurable via
    // env override?") is answered: yes, via the R42 identity map. This line
    // shows the operator what is currently in effect at process start.
    const out = { ...h, operatorOrgs: connector.operatorOrgs || [] };
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(0);
  } else if (args.includes("--once")) {
    connector.runOnce().then((r) => {
      process.stdout.write(JSON.stringify(r) + "\n");
      process.exit(r.errors > 0 ? 1 : 0);
    }).catch((e) => {
      process.stderr.write(`github-events runOnce error: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
  } else {
    connector.runForever().catch((e) => {
      process.stderr.write(`github-events runForever error: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
  }
}
