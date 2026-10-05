// salience.js — R25 cascade core. Per kb/salience-design.md (R24.5 synthesis).
//
// Three-layer cascade for promote-time admission control:
//
//   LAYER 1: Source-tiered Stage-0 hard-drops (~10us). Per-source modules in
//            mcp/lib/ingest/stage0/{imessage,screentime,gitlog,githubevents}.js
//            dispatched via stage0/index.js. Each module returns one of:
//              {decision:"DROP", reason} — structurally certain noise (tapback,
//                  urn:biz handle, WatchEvent/ForkEvent, dependabot, Initial
//                  commit, merge-only, /discoverability/signals).
//              {decision:"REDACT_DROP", reason:"otp_pattern"} — OTP / 2FA /
//                  verification-code redaction. Raw content NEVER logged.
//              {decision:"PASS", structural_score?} — proceed to Layer 2/3.
//                  Optional structural_score hints Layer 2's structural
//                  component; we fall back to CAPS.SALIENCE_STRUCTURAL_RULES
//                  table if absent.
//
//   LAYER 2: Mark-and-rank component scoring (~1ms). Six scored components +
//            two zero-weighted decay-feedback grafts (R24.5 CP-5 Trigger A).
//            Persisted on the fact row at features.salience.components so
//            CP-5 Trigger A is a byte-idempotent weight bump + replay rather
//            than a schema migration.
//
//   LAYER 3: ECN corroboration (embed + HNSW kNN). If nearest cosine_distance
//            < CAPS.SALIENCE_CORROBORATE_THRESHOLD[source] => emit
//            policy.corroboration and return CORROBORATE (no new fact row).
//            Otherwise: compute salience = dot(components, WEIGHTS_V1), the
//            caller appends the fact row with features.salience attached.
//
// CONTRACT:
//
//   scoreCandidate(event, ctx) -> one of:
//     {decision: "DROP",        reason, source}
//     {decision: "REDACT_DROP", reason, source}
//     {decision: "CORROBORATE", target_id, source_ref, cosine_distance}
//     {decision: "PROMOTE",     score, components, weights_hash, version}
//
//   On DROP / REDACT_DROP: policy.salience.dropped / .redacted is emitted
//   inside scoreCandidate. The caller MUST NOT append a fact row.
//
//   On CORROBORATE: policy.corroboration is emitted inside scoreCandidate.
//   The caller MUST NOT append a fact row.
//
//   On PROMOTE: NO policy event is emitted (the existing
//   policy.token.consumed event already records the promote-pipeline call).
//   The caller appends the fact row with features.salience built from the
//   returned {score, components, weights_hash, version}.
//
// EMBEDDING REUSE:
//
//   The caller (distill-promote-fact.js) embeds args.content BEFORE calling
//   scoreCandidate and threads the vector in on ctx, so we never double-embed.
//   scoreCandidate uses that embedding for the corroboration kNN AND for the
//   novelty component (1 - max cosine over the k=8 nearest neighbours).
//   The producing client and the ctx key are named in the WU2 paragraph below,
//   which is the single description of this handoff — do not restate them here.
//
//   WU2: the production watermark path pre-fetches the vector via the local
//   Qwen3 server and threads it in on ctx.embedding_4096 (back-compat: the
//   legacy ctx.embedding_mrl_768 still works). If no vector is available AND
//   no ctx.embedder is wired (hermetic tests, empty content, or a local-server
//   outage), scoreCandidate skips Layer 3 entirely: novelty defaults to 0.5
//   and corroboration never fires. The fact still PROMOTEs (with a null
//   embedding on the outage path); the watermark daemon records the fact id to
//   the re-embed sweep file so a later DRAIN can re-embed it — the consumer is
//   daemons/reembed-drain.mjs, a separate daemon reading that file by byte
//   cursor, not a watermark tick. WU2 removed the
//   Gemini-quota EMBED_DEFERRED park + PROMOTE_WITHOUT_EMBED short-circuits —
//   the local backend has no per-key quota to exhaust.
//
// kNN BACKEND (HNSW vs linear scan):
//
//   The recall-layer HnswIndex (mcp/lib/recall/hnsw-index.js) is the single
//   source of truth for 768d unit-norm vectors keyed by memory_id. salience.js
//   reuses it instead of maintaining a parallel index. Below
//   CAPS.SALIENCE_HNSW_INCREMENTAL_THRESHOLD entries we linear-scan via the
//   HnswIndex's own linear-scan fallback (which is what hnsw-index.js does
//   internally when the native hnswlib-node import fails). Above the
//   threshold the native HNSW kNN serves the lookup. The swap is internal;
//   no operator-visible flag.
//
//   When the index is empty (first fact ever), novelty = 1.0 (maximally
//   novel) — matches design's "1 - max(cosine, k=8)" semantics with an
//   empty nearest-neighbour set.

import { CAPS, SALIENCE_WEIGHTS_V1_HASH } from "../validation.js";
import { appendPolicyEvent } from "../policy-events.js";
import { shouldEmitDrop } from "./drop-throttle.js";
import { ATTRIBUTION_KEYS } from "./_attribution-keys.js";
// WU1-promote-time-content-dedup-gate. The EMBEDDING-FREE content-hash
// CORROBORATE lookup. content-index.js is dependency-light (node:fs +
// node:crypto + _ledger-stream); importing it here does NOT pull the recall
// dependency graph into the cascade hot path. The lookup is a pure Map.get.
import { lookupCanonical } from "../synthesis/content-index.js";

// ----------------------------------------------------------------------------
// CRIT-1c (R25.5) — Source-row → canonical-event normalization adapter.
//
// Source-tier ledger rows in storage/sources/*.jsonl carry a `raw_content`
// OBJECT, not a `content` STRING. The watermark daemon (and any other
// non-MCP caller) reads these rows verbatim and passes them as `event` into
// `scoreCandidate`. The MCP `memory_distill_promote_fact` handler instead
// constructs an `event` with `content` already populated (from args.content).
//
// Adapter contract (lives in salience.js so the cascade is callable from
// ANY ingest path — watermark, replay, future agents — not just the MCP
// handler):
//
//   _normalizeSourceEvent(event) -> { ...event, content: string }
//
// - If event.content is already a non-empty string: return as-is (no churn).
// - Otherwise: derive event.content from event.raw_content per source:
//
//     imessage:      raw_content.text  OR raw_content.body
//     screentime:    raw_content.title OR raw_content.url OR
//                    raw_content.query_text OR raw_content.app_bundle_id OR
//                    raw_content.signal OR raw_content.stream
//     git-log:       raw_content.subject + ("\n\n" + raw_content.body)?
//     github-events: raw_content.body OR per-event-type composer
//                    (PushEvent → first commit message + repo + ref;
//                    PullRequestEvent → action + #num + title + repo;
//                    IssuesEvent → action + #num + title + repo;
//                    ReleaseEvent → action + tag + name + body + repo;
//                    IssueCommentEvent / PullRequestReviewEvent /
//                    PullRequestReviewCommentEvent → action + body excerpt;
//                    CreateEvent / DeleteEvent / ForkEvent / WatchEvent /
//                    MemberEvent → action + structural surfaces;
//                    default → action + event_type + repo + scalar subset).
//                    Falls back to raw.action or raw.event_type only when
//                    the composer also produces an empty string. Bug ref:
//                    WU-A2-github-events-content-fix.
//     chat-claude-code: "user: <user_text>\n\nassistant: <assistant_text>"
//                    (matches codex-cli buildContent shape — see
//                    lib/connectors/codex-cli.js buildContent). Empty halves
//                    are omitted so a tool-only turn ('') derives empty
//                    content and Stage-0 drops it on content_mass=0 instead
//                    of routing raw_content.conversation_id (a UUID) into
//                    content via the unknown-source first-scalar fallback.
//                    The stop-hook (hooks/stop-hook.sh) emits chat-cc rows
//                    WITHOUT a top-level `content` field; this branch is the
//                    sole derivation point for the promote-time content.
//     codex-cli:     identical shape to chat-claude-code (the codex-cli
//                    connector pre-stamps row.content via buildContent so
//                    the idempotency short-circuit above usually fires; this
//                    branch defends the watermark path against any future
//                    codex-cli row written without the `content` field).
//     (unknown):     stringify the first scalar found OR "" so content_mass
//                    scores to 0 (the row falls below admission naturally).
//
// Empty derived content is permitted: contentMassScore drops to 0 and the
// row will sit at a low salience score — Layer 2/3 act as the second
// admission gate. We do NOT throw on empty content; the cold-start novelty
// behaviour is the sibling-agent's concern (CRIT-6 lerp).
// ----------------------------------------------------------------------------

function _coerceString(v) {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

// WU-A2-github-events-content-fix — per-event-type rich content composer.
//
// Pre-fix behaviour: normalizeSourceEvent fell back to `raw_content.action`
// for any github-events row whose `raw_content.body` was empty. Because the
// gh connector's summarizeEvent() does NOT write `raw_content.body` for
// PullRequestEvent / IssuesEvent / ReleaseEvent / PullRequestReviewEvent
// (the substantive surfaces live under {pr_title, issue_title,
// release_name, review_body, comment_body, first_message, ...}), in
// practice the fallback fired on the majority of github-events rows and
// the resulting fact.content was a bare action verb like "merged" /
// "opened" / "published" / "added" / "created". The PR title, issue
// title, repo, tag, etc. were silently discarded.
//
// Composer policy:
//   - Defensive on every shape: a malformed raw_content (missing fields,
//     numeric where a string was expected, undefined event_type) must
//     never throw. We coerce via _coerceString + Number checks and fall
//     through to a generic action+repo string on any miss.
//   - Output is a single human-readable summary per row. Embedded
//     newlines in commit messages / release bodies are preserved (the
//     embedding model handles them); content_mass uses character count,
//     so length matters.
function _composeGithubEventContent(raw) {
  const eventType = _coerceString(raw.event_type) || "UnknownEvent";
  const action = _coerceString(raw.action) || "";
  const repo = _coerceString(raw.repo) || "unknown";
  switch (eventType) {
    case "PushEvent": {
      const firstMessage = _coerceString(raw.first_message);
      const ref = _coerceString(raw.ref) || "unknown-ref";
      if (firstMessage) {
        return `${firstMessage} in ${repo} on ${ref}`;
      }
      // PushEvent with empty commits[] AND failed backfill — keep something
      // structural so the row isn't reduced to bare action. The W7 backfill
      // landed first_message in the common case; this is the rare path.
      const commits = typeof raw.commits === "number" ? raw.commits : null;
      const head = _coerceString(raw.head);
      return `pushed ${commits != null ? `${commits} commit(s)` : "commits"} to ${ref} in ${repo}${head ? ` (head ${head.slice(0, 7)})` : ""}`;
    }
    case "PullRequestEvent": {
      const num = typeof raw.pr_number === "number" ? raw.pr_number : null;
      const title = _coerceString(raw.pr_title) || "";
      const verb = action || "updated";
      const numStr = num != null ? `#${num}` : "#?";
      const titlePart = title ? `: ${title}` : "";
      return `${verb} PR ${numStr}${titlePart} in ${repo}`;
    }
    case "PullRequestReviewEvent": {
      const num = typeof raw.pr_number === "number" ? raw.pr_number : null;
      const title = _coerceString(raw.pr_title) || "";
      const state = _coerceString(raw.review_state) || "";
      const body = _coerceString(raw.review_body) || "";
      const numStr = num != null ? `#${num}` : "#?";
      const stateStr = state ? ` (${state})` : "";
      const titleStr = title ? `: ${title}` : "";
      const bodyStr = body ? ` — ${body.substring(0, 200)}` : "";
      return `${action || "reviewed"} PR ${numStr}${stateStr}${titleStr} in ${repo}${bodyStr}`;
    }
    case "PullRequestReviewCommentEvent": {
      const num = typeof raw.pr_number === "number" ? raw.pr_number : null;
      const body = _coerceString(raw.comment_body) || "";
      const numStr = num != null ? `#${num}` : "#?";
      const bodyStr = body ? `: ${body.substring(0, 200)}` : "";
      return `${action || "commented on"} PR ${numStr} in ${repo}${bodyStr}`;
    }
    case "IssuesEvent": {
      const num = typeof raw.issue_number === "number" ? raw.issue_number : null;
      const title = _coerceString(raw.issue_title) || "";
      const verb = action || "updated";
      const numStr = num != null ? `#${num}` : "#?";
      const titlePart = title ? `: ${title}` : "";
      return `${verb} Issue ${numStr}${titlePart} in ${repo}`;
    }
    case "IssueCommentEvent": {
      const num = typeof raw.issue_number === "number" ? raw.issue_number : null;
      const title = _coerceString(raw.issue_title) || "";
      const body = _coerceString(raw.comment_body) || "";
      const numStr = num != null ? `#${num}` : "#?";
      const titleStr = title ? `: ${title}` : "";
      const bodyStr = body ? ` — ${body.substring(0, 200)}` : "";
      return `${action || "commented on"} Issue ${numStr}${titleStr} in ${repo}${bodyStr}`;
    }
    case "ReleaseEvent": {
      const tag = _coerceString(raw.tag_name) || "";
      const name = _coerceString(raw.release_name) || "";
      const body = _coerceString(raw.release_body) || "";
      const verb = action || "released";
      const tagStr = tag ? ` ${tag}` : "";
      const nameStr = name ? ` (${name})` : "";
      const bodyStr = body ? ` - ${body.substring(0, 200)}` : "";
      return `${verb}${tagStr}${nameStr} in ${repo}${bodyStr}`;
    }
    case "CreateEvent": {
      const refType = _coerceString(raw.ref_type) || "";
      const ref = _coerceString(raw.ref) || "";
      const what = [refType, ref].filter(Boolean).join(" ");
      return `created ${what || "ref"} in ${repo}`;
    }
    case "DeleteEvent": {
      const refType = _coerceString(raw.ref_type) || "";
      const ref = _coerceString(raw.ref) || "";
      const what = [refType, ref].filter(Boolean).join(" ");
      return `deleted ${what || "ref"} in ${repo}`;
    }
    case "ForkEvent": {
      const forkee = _coerceString(raw.forkee_full_name) || "";
      return `forked ${repo}${forkee ? ` to ${forkee}` : ""}`;
    }
    case "MemberEvent": {
      const login = _coerceString(raw.member_login) || "";
      return `${action || "updated"} member${login ? ` ${login}` : ""} in ${repo}`;
    }
    case "WatchEvent": {
      return `${action || "starred"} ${repo}`;
    }
    default: {
      // Generic fallback. Stamp the action+repo and a compact JSON of the
      // remaining scalar fields so any future event_type the connector
      // emits before this file catches up still produces substantive
      // content. JSON.stringify is wrapped in try/catch — a raw_content
      // containing a cycle (shouldn't happen, but defensive) must not
      // throw.
      const verb = action || "did";
      let extras = "";
      try {
        const subset = {};
        for (const k of Object.keys(raw)) {
          if (k === "event_type" || k === "action" || k === "repo") continue;
          if (k === "actor_login" || k === "public" || k === "created_at") continue;
          const v = raw[k];
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            subset[k] = v;
          }
        }
        if (Object.keys(subset).length > 0) {
          extras = ` — ${JSON.stringify(subset)}`;
        }
      } catch {
        extras = "";
      }
      return `${verb} (${eventType}) in ${repo}${extras}`;
    }
  }
}

export function normalizeSourceEvent(event) {
  if (event == null || typeof event !== "object") return event;
  if (typeof event.content === "string" && event.content.length > 0) {
    return event;
  }
  const raw = event.raw_content;
  let derived = "";
  if (raw != null && typeof raw === "object") {
    const src = event.source;
    if (src === "imessage") {
      derived = _coerceString(raw.text) || _coerceString(raw.body) || "";
    } else if (src === "screentime") {
      derived =
        _coerceString(raw.title) ||
        _coerceString(raw.url) ||
        _coerceString(raw.query_text) ||
        _coerceString(raw.app_bundle_id) ||
        _coerceString(raw.signal) ||
        _coerceString(raw.stream) ||
        "";
    } else if (src === "git-log" || src === "gitlog") {
      const subject = _coerceString(raw.subject);
      const body = _coerceString(raw.body);
      if (subject && body) derived = subject + "\n\n" + body;
      else derived = subject || body || _coerceString(raw.message) || "";
    } else if (src === "github-events" || src === "githubevents") {
      // WU-A2-github-events-content-fix: derive substantive content per
      // event_type. The legacy path dropped to raw.action ("merged" /
      // "opened" / "published") whenever raw.body was empty — which it is
      // for every gh event_type except IssueCommentEvent (where some
      // upstream paths flatten comment_body → body). The PR title, issue
      // title, commit message, release tag, repo, etc. live elsewhere in
      // raw_content; _composeGithubEventContent stitches them into a
      // human-readable summary.
      //
      // raw.body still wins when present — preserves the
      // IssueCommentEvent-with-body shape the existing T5 contract pins.
      derived =
        _coerceString(raw.body) ||
        _composeGithubEventContent(raw) ||
        _coerceString(raw.action) ||
        _coerceString(raw.event_type) ||
        "";
    } else if (src === "chat-claude-code" || src === "codex-cli") {
      // WU-A1-chat-cc-content-fix: derive chat-cc / codex-cli content from
      // user_text + assistant_text (the turn text), NOT from the first scalar
      // in raw_content. The unknown-source fallback below would otherwise
      // pick raw_content.conversation_id (a UUID) — observed in production:
      // every chat-claude-code-promoted fact in the queue carried
      // content=conv_id rather than the actual turn text. Mirrors the
      // codex-cli buildContent helper at mcp/lib/connectors/codex-cli.js
      // (parts joined with "\n\n"; empty halves omitted so tool-only turns
      // derive "" and Stage-0 drops them on content_mass=0).
      const userText = _coerceString(raw.user_text);
      const assistantText = _coerceString(raw.assistant_text);
      const parts = [];
      if (userText) parts.push(`user: ${userText}`);
      if (assistantText) parts.push(`assistant: ${assistantText}`);
      derived = parts.join("\n\n");
    } else {
      // Unknown source: best-effort scalar pluck.
      for (const k of Object.keys(raw)) {
        const v = raw[k];
        if (typeof v === "string" && v.length > 0) { derived = v; break; }
      }
    }
  }
  return { ...event, content: derived };
}

// ----------------------------------------------------------------------------
// A1 — Carry attribution through promotion (WRITE-SIDE).
//
// extractAttributionFromSourceRow(sourceRow) — PURE + DEFENSIVE extractor that
// pulls a bounded, closed-key attribution subset out of a connector-authored
// source row's raw_content. The cascade calls this at the single promote
// chokepoint (distill-promote-fact.js) so a promoted fact can carry sender +
// direction WITHOUT re-attaching the full raw_content (bloat / PII). It NEVER
// throws into the cascade (whole body is try/catch → {}). It returns ONLY keys
// in the 9-key allowlist below, {} for non-messaging sources, and normalizes
// each source's native direction into the canonical is_outgoing / is_self keys.
//
// Closed allowlist (nothing outside this set is ever emitted):
//   sender_id, sender_name, peer_id, peer_name, peer_type,
//   is_outgoing, is_self, reply_to, fwd_from

// Retain a candidate as a NON-boolean scalar (string non-empty, or finite
// number); everything else → null (drop). Used for id / name / peer / reply /
// fwd fields where a boolean would be nonsensical.
function _attrText(v) {
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

// Best-effort RFC5322 display-name / addr-spec split of a mail `From` header.
//   "Alex Example <notifications@github.com>" → {name:"Alex Example",
//     email:"notifications@github.com"}; a bare address → {name:null,
//     email:<whole>}; absent → {name:null, email:null}.
function _parseMailFrom(from) {
  const s = _coerceString(from);
  if (s == null) return { name: null, email: null };
  const m = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    let name = m[1].trim();
    if (name.length >= 2 && name[0] === '"' && name[name.length - 1] === '"') {
      name = name.slice(1, -1).trim();
    }
    const email = m[2].trim();
    return {
      name: name.length > 0 ? name : null,
      email: email.length > 0 ? email : null,
    };
  }
  return { name: null, email: s };
}

export function extractAttributionFromSourceRow(sourceRow) {
  try {
    if (sourceRow == null || typeof sourceRow !== "object") return {};
    const raw = sourceRow.raw_content;
    if (raw == null || typeof raw !== "object") return {};
    const src = sourceRow.source;
    const out = {};

    const putText = (k, v) => {
      const t = _attrText(v);
      if (t != null) out[k] = t;
    };

    if (src === "telegram") {
      // Connector-authored identity envelope forwarded verbatim.
      putText("sender_id", raw.sender_id);
      putText("sender_name", raw.sender_name);
      putText("peer_id", raw.peer_id);
      putText("peer_name", raw.peer_name);
      putText("peer_type", raw.peer_type);
      if (typeof raw.is_outgoing === "boolean") out.is_outgoing = raw.is_outgoing;
      if (typeof raw.is_self === "boolean") out.is_self = raw.is_self;
      putText("reply_to", raw.reply_to);
      putText("fwd_from", raw.fwd_from);
    } else if (src === "imessage") {
      // Direction is derived from is_from_me; no sender_name for imessage.
      putText("sender_id", raw.handle_id);
      out.is_outgoing = raw.is_from_me === 1 || raw.is_from_me === true;
      out.is_self = false;
      // A4 — peer_type: group iff participant_count>2 OR cache_roomnames is a
      // non-empty string OR the chat_guid carries Apple's `chat<digits>` group
      // suffix (all three OR'd — mirrors the imessage connector's isGroupChat
      // rule-1/2/3 at connectors/imessage.js), else dm. The chat_guid rule-3 is
      // the load-bearing fallback for LEGACY group rows whose cache_roomnames
      // was NULLed and whose participant_count did not survive — without it such
      // a row misclassifies as dm. peer_name from cache_roomnames (the group
      // subject) when present; peer_id from chat_guid (thread key).
      const pc = Number(raw.participant_count);
      const roomnames =
        typeof raw.cache_roomnames === "string" && raw.cache_roomnames.length > 0
          ? raw.cache_roomnames
          : null;
      const chatGuid =
        typeof raw.chat_guid === "string" ? raw.chat_guid : "";
      const imGroup =
        (Number.isFinite(pc) && pc > 2) ||
        roomnames != null ||
        /;[+-];chat\d+/.test(chatGuid);
      out.peer_type = imGroup ? "group" : "dm";
      if (roomnames != null) out.peer_name = roomnames;
      putText("peer_id", raw.chat_guid);
    } else if (src === "whatsapp") {
      // Connector may forward-stamp sender_name / sender_jid; direction from
      // is_from_me. from_jid is the fallback sender identity.
      putText("sender_id", raw.sender_jid || raw.from_jid);
      putText("sender_name", raw.sender_name);
      out.is_outgoing = raw.is_from_me === 1 || raw.is_from_me === true;
      out.is_self = false;
      // A4 — peer_type: group iff the session/to jid ends `@g.us` OR
      // session_type indicates a group (ZSESSIONTYPE_GROUP=1), else dm
      // (`@s.whatsapp.net` 1:1). peer_id from session_jid (the chat/group jid).
      const jid =
        (typeof raw.session_jid === "string" && raw.session_jid) ||
        (typeof raw.to_jid === "string" && raw.to_jid) ||
        "";
      const sessionType =
        typeof raw.session_type === "number"
          ? raw.session_type
          : raw.session_type != null
            ? Number(raw.session_type)
            : null;
      const waGroup = jid.endsWith("@g.us") || sessionType === 1;
      out.peer_type = waGroup ? "group" : "dm";
      putText("peer_id", raw.session_jid);
      // g1-whatsapp-reply-linkage — the connector now stamps the quoted-reply
      // parent as `reply_to` (the same canonical key telegram emits above).
      // Already a member of the frozen 9-key ATTRIBUTION_KEYS allowlist and
      // already surfaced by recall as attribution.reply_to, so this is pure
      // reuse: no new key, no allowlist edit, no schema change.
      putText("reply_to", raw.reply_to);
    } else if (src === "mail") {
      // Sender lives in the `From` header; no message-level direction flag
      // (inbound corpus → A2 reads absent direction as incoming).
      const from =
        raw.headers && typeof raw.headers === "object" ? raw.headers.from : null;
      const parsed = _parseMailFrom(from);
      if (parsed.name != null) out.sender_name = parsed.name;
      let sid = parsed.email;
      if (sid == null && Array.isArray(sourceRow.parties)) {
        sid = _coerceString(sourceRow.parties[0]);
      }
      if (sid != null) out.sender_id = sid;
    } else {
      // git-log / screentime / github-events / codex-cli / chat-claude-code /
      // manual / any unknown source: no attribution (keeps clean promotes
      // byte-compatible with pre-A1 rows).
      return {};
    }

    // Defense-in-depth final sweep: emit ONLY allowlisted keys, dropping any
    // null / undefined / empty-string / NaN that slipped through. Direction
    // flags are booleans and are retained.
    const cleaned = {};
    for (const k of ATTRIBUTION_KEYS) {
      if (!(k in out)) continue;
      const v = out[k];
      if (typeof v === "string" && v.length > 0) cleaned[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) cleaned[k] = v;
      else if (typeof v === "boolean") cleaned[k] = v;
    }
    return cleaned;
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------------------
// Stage-0 registry. Sibling agent (A2) populates mcp/lib/ingest/stage0/
// modules + dispatcher. We lazily import to tolerate any load-ordering edge
// case where salience.js is imported before the stage0 dir has its index.js;
// in that case we degrade to "PASS" for every source (the safer half of the
// fail-open / fail-closed choice — Layer 2/3 still gate against admission).
// ----------------------------------------------------------------------------

let _stage0Dispatch = null;
let _stage0DispatchAttempted = false;

async function loadStage0Dispatch() {
  if (_stage0DispatchAttempted) return _stage0Dispatch;
  _stage0DispatchAttempted = true;
  // R25.7 CRIT-A1: do NOT wrap loadModule in catch{}. The R25.6
  // structural defense throws a clear "missing expected export" at
  // boot when the stage0 module's export name drifts; the R25.6 catch
  // here silently swallowed that throw and preserved the original
  // R25.5 silent-fallthrough failure mode. Let the throw propagate so
  // the caller sees the error at import-time rather than silently
  // skipping Stage-0 for every event.
  //
  // Absolute URL (built from import.meta.url) is REQUIRED: dynamic
  // import inside loadModule resolves relative to lib-loader.js, not
  // to this file.
  const { loadModule } = await import(
    new URL("../lib-loader.js", import.meta.url).href
  );
  const mod = await loadModule(
    new URL("./stage0/index.js", import.meta.url).href,
    ["dispatch"],
  );
  _stage0Dispatch = mod.dispatch;
  return _stage0Dispatch;
}

// Test-time override hook. Tests inject a dispatcher fn directly so they
// don't need the stage0/ directory to exist on disk.
export function _setStage0DispatchForTest(fn) {
  _stage0DispatchAttempted = true;
  _stage0Dispatch = typeof fn === "function" ? fn : null;
}

// A5 — test-time override for CAPS.SALIENCE_CORROBORATE_SPEAKER_GUARD_ENABLED.
// CAPS is Object.freeze'd (validation.js), so the flag-off routing (the
// pre-A5 byte-for-byte kNN CORROBORATE) is only reachable hermetically
// through this hook. `null` (the default, and what any non-boolean restores)
// defers to CAPS; a boolean pins the guard for the process. Same pattern as
// _setStage0DispatchForTest above; tests wrap it in try/finally(null).
let _speakerGuardOverride = null;
export function _setSpeakerGuardForTest(v) {
  _speakerGuardOverride = typeof v === "boolean" ? v : null;
}

// ----------------------------------------------------------------------------
// HNSW kNN injection point. Tests + the production distill-promote-fact
// callers pass in an HNSW (or a stub) via ctx.hnsw. The interface contract:
//   hnsw.size() -> number of live entries (SYNCHRONOUS)
//   hnsw.search(query_vector, topK) -> [{memory_id, cosine_distance, rank}]
//     — sync (HnswIndex) or async (Q3 memperf: the watermark daemon's
//     queryd-backed handle); scoreCandidate awaits the result either way.
// Matches the existing mcp/lib/recall/hnsw-index.js HnswIndex class.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Layer 2 component scorers
// ----------------------------------------------------------------------------

// recency: exp(-Δt_seconds / τ_source_seconds). Clamped to [0, 1]. Future
// timestamps (clock skew) clamp to 1.0; very old rows decay toward 0.
function recencyScore(eventTsMs, source, nowMs) {
  const tauSec =
    CAPS.SALIENCE_TAU_SECONDS[source] ||
    CAPS.SALIENCE_TAU_SECONDS["chat-claude-code"];
  const deltaSec = Math.max(0, (nowMs - eventTsMs) / 1000);
  const v = Math.exp(-deltaSec / tauSec);
  if (!Number.isFinite(v)) return 0;
  if (v > 1) return 1;
  if (v < 0) return 0;
  return v;
}

// authorship: who WROTE the turn, not who consented to its ingestion.
// kb/ingestion.md:140: "consent_basis is about consent to ingestion, not
// about authorship ... How to weight assistant turns vs. user turns in recall
// is a separate concern handled by the recall function's scoring". The
// pre-A3 implementation collapsed this axis to a consent lookup, and on the
// daemon path (raw source row, consent under source_policy) never even saw
// the field — every scored fact carried 0.6.
//
// A3 (memory-roots node codex-authorship-axis), behind
// CAPS.SALIENCE_SPEAKER_AUTHORSHIP_ENABLED:
//   - codex-cli / chat-claude-code: speaker-derived. A turn carrying
//     operator words (raw_content.user_text non-blank, the same string-or-""
//     + trim() emptiness Stage-0 uses at stage0/codex-cli.js:496 and
//     stage0/chat-claude-code.js:227) is operator-authored → 1.0; an
//     assistant-only turn is agent-authored → CAPS.SALIENCE_AUTHORSHIP_AGENT
//     (0.4, one rung below the R21 third-party human value).
//   - every other source: consent stays the proxy, resolved as
//     event.consent_basis ?? event.source_policy.consent_basis so the daemon
//     path finally delivers the R21 dampener. first_party → 1.0, else 0.6.
//     Unknown / missing basis defaults to 0.6 (fail safer toward dampening,
//     never amplifying, an unattributable signal).
// Flag off (`speakerEnabled: false`, the only hermetic route since CAPS is
// frozen): byte-identical to the pre-A3 rule, INCLUDING the missing
// source_policy hoist, so the 0.6-everywhere regime is reproducible for a
// census diff. The hoist never ships alone — hoist-only would lift
// codex/chat-cc/git-log to 1.0 while telegram/mail stay 0.6 and widen the
// codex rerank edge.
// Rerank information only (kb/salience-design.md:54); never a gate, never a
// consent / authority / redaction input.
function authorshipScore(
  event,
  { speakerEnabled = CAPS.SALIENCE_SPEAKER_AUTHORSHIP_ENABLED } = {},
) {
  if (
    speakerEnabled &&
    (event.source === "codex-cli" || event.source === "chat-claude-code")
  ) {
    const userText =
      typeof event.raw_content?.user_text === "string"
        ? event.raw_content.user_text
        : "";
    return userText.trim().length > 0 ? 1.0 : CAPS.SALIENCE_AUTHORSHIP_AGENT;
  }
  const basis = speakerEnabled
    ? (event.consent_basis ?? event.source_policy?.consent_basis)
    : event.consent_basis;
  if (basis === "first_party") return 1.0;
  return 0.6;
}

// content_mass: min(1, log2(uniq_tokens+1)/6). Hard-zero on boilerplate
// regex (CAPS.SALIENCE_BOILERPLATE_REGEX). uniq_tokens is the unique
// whitespace-split token count of the content string; we lower-case and
// strip surrounding punctuation per token before deduplicating.
const _BOILERPLATE_RE = new RegExp(CAPS.SALIENCE_BOILERPLATE_REGEX, "i");

// A5 (memory-roots node codex-speaker-guard) — "is this row the operator
// speaking?" predicate for the kNN CORROBORATE speaker guard.
//
// Compiled from CAPS.SALIENCE_SPEAKER_GUARD_SCAFFOLD_REGEX with the same "i"
// flag Stage-0 uses for SCAFFOLD_USER_RE (stage0/codex-cli.js). The CAPS
// string mirrors that regex character-for-character (T-A5-6 pins the
// equality); we do not import stage0 here because salience.js loads Stage-0
// dynamically (loadStage0Dispatch) and a static import would invert that.
const _SPEAKER_GUARD_SCAFFOLD_RE = new RegExp(
  CAPS.SALIENCE_SPEAKER_GUARD_SCAFFOLD_REGEX,
  "i",
);

// isOperatorWordsTurn(event) — PURE. True iff the row carries the operator's
// own words: raw_content is an object whose user_text is a non-blank string
// (Stage-0's isEmpty semantics: string-or-"" + trim()), the connector did NOT
// stamp it auto_injected === true, and the text does not match the scaffold
// regex (a harness envelope threaded in as a pseudo-user turn). raw_content
// is read from event.raw_content (the watermark daemon passes the raw source
// row) and then event.raw.raw_content (the MCP promote path forwards the
// source row under `raw`). Anything else — no raw_content, no user_text,
// assistant-only, imessage / telegram / mail rows whose payload lives under
// other keys — is NOT operator words. Deliberately no source list: the
// user_text key exists only on the two agent-transcript sources, and a
// source list would be a second place to forget. Deliberately not widened to
// the harness texts no regex names (`<task-notification>`, `[Request
// interrupted by user]`, context-continuation — FA4-1's 125 rows); those
// count as operator words here exactly as Stage-0 counts them.
//
// Distinct from authorshipScore above: that is A3's rerank axis, where a
// scaffold pseudo-user turn scores as operator-authored (its measured
// contract); this predicate feeds a routing decision and must not.
function isOperatorWordsTurn(event) {
  if (event == null || typeof event !== "object") return false;
  const rc = event.raw_content ?? event.raw?.raw_content;
  if (rc == null || typeof rc !== "object") return false;
  if (typeof rc.user_text !== "string") return false;
  if (rc.user_text.trim().length === 0) return false;
  if (rc.auto_injected === true) return false;
  if (_SPEAKER_GUARD_SCAFFOLD_RE.test(rc.user_text)) return false;
  return true;
}
function contentMassScore(content) {
  if (typeof content !== "string" || content.length === 0) return 0;
  if (_BOILERPLATE_RE.test(content)) return 0;
  const tokens = new Set();
  for (const raw of content.split(/\s+/)) {
    const tok = raw.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (tok.length > 0) tokens.add(tok);
  }
  const u = tokens.size;
  const v = Math.log2(u + 1) / 6;
  if (v >= 1) return 1;
  if (v <= 0) return 0;
  return v;
}

// source_prior: per-source baseline. Unknown sources default to 0.50 (the
// neutral midpoint — admit but don't favour).
function sourcePriorScore(source) {
  const p = CAPS.SALIENCE_SOURCE_PRIORS[source];
  return typeof p === "number" ? p : 0.50;
}

// structural: per-source rule-table lookup. The Stage-0 module returns an
// optional `structural_score` hint for PASS rows; we honour it when present
// and fall back to CAPS.SALIENCE_STRUCTURAL_RULES[source][reason] when the
// caller supplies a reason code. Unknown / missing rule defaults to 0.50.
function structuralScore(source, stage0Hint, reason) {
  if (typeof stage0Hint === "number" && stage0Hint >= 0 && stage0Hint <= 1) {
    return stage0Hint;
  }
  const tbl = CAPS.SALIENCE_STRUCTURAL_RULES[source];
  if (tbl) {
    if (reason && typeof tbl[reason] === "number") return tbl[reason];
    if (typeof tbl.default === "number") return tbl.default;
    if (typeof tbl.substantive_prose === "number") return tbl.substantive_prose;
  }
  return 0.50;
}

// novelty: 1 - max(cosine_similarity, k=8 nearest neighbours).
// hnsw.search returns cosine_distance = 1 - cosine_similarity, ordered
// smallest-first. The k=0 (empty index) case returns 1.0 by design.
function noveltyAndCorroborationFromKnn(knnResults) {
  if (!Array.isArray(knnResults) || knnResults.length === 0) {
    return { novelty: 1.0, nearest: null };
  }
  // nearest cosine_distance is the smallest in the result list (kNN sorted)
  const nearest = knnResults[0];
  // novelty derives from the closest neighbour: small distance => not novel.
  const dist = Math.max(0, Math.min(1, nearest.cosine_distance));
  const novelty = dist; // novelty = 1 - max(sim) = 1 - (1 - dist) = dist
  return { novelty, nearest };
}

// ----------------------------------------------------------------------------
// Weights dot-product
// ----------------------------------------------------------------------------

const _WEIGHTS = CAPS.SALIENCE_WEIGHTS_V1;
const _COMPONENT_KEYS = Object.freeze([
  "recency",
  "authorship",
  "content_mass",
  "source_prior",
  "structural",
  "novelty",
  "last_retrieved_ts",
  "use_count",
]);

function weightedScore(components) {
  let s = 0;
  for (const k of _COMPONENT_KEYS) {
    const w = _WEIGHTS[k];
    const c = components[k];
    if (typeof w !== "number" || typeof c !== "number") continue;
    s += w * c;
  }
  if (!Number.isFinite(s)) return 0;
  if (s < 0) return 0;
  if (s > 1) return 1;
  return s;
}

// ----------------------------------------------------------------------------
// Policy-event emit helpers. All raw content is forbidden in
// policy.salience.redacted — the OTP path MUST not log the OTP itself.
//
// W3 group-commit: each helper takes an optional `sink` (threaded from
// scoreCandidate's ctx.policyEventSink by the watermark cascade call site).
// When present, the event object is PUSHED into the sink — the daemon
// buffers it and lands the whole tick's events via appendPolicyEventsBatch
// (one lock + one fsync per <=500 events) instead of one fsync per event.
// When absent, behavior is unchanged: a synchronous durable
// appendPolicyEvent, so MCP-process callers keep per-event durability.
// ----------------------------------------------------------------------------

function emitPolicyEvent(event, sink) {
  if (sink != null && typeof sink.push === "function") {
    sink.push(event);
    return;
  }
  appendPolicyEvent(event);
}

// Throttle window for Stage-0 drop rows. A drop event records that we did
// NOT remember something structurally-certain to be noise (automated mail,
// list traffic, no-reply senders). The per-message row carries no audit
// value the aggregate lacks: July 2026 measured 1,080,947 such rows =
// 202 MB = 92% of the month's entire policy-event volume, and the top four
// reasons (apple_automated / noreply_sender / list_unsubscribe / list_id)
// all mean the same thing — "machine-generated, not a human message".
//
// Convention follows the two throttled kinds already in EVENT_KINDS:
// policy.salience.recall_feedback ("one audit row per recall, not one row
// per surfaced memory — the per-row alternative was rejected at architect
// time for 5-10x ledger inflation without added audit value") and the
// watermark auto-mute signal ("throttled daemon-side to once per mute
// window (module-level already-signalled set)").
//
// Semantics: the FIRST drop for a (source, reason) pair in each window
// emits normally, carrying suppressed_count = how many rows the PREVIOUS
// window elided. Subsequent drops increment the counter and write nothing.
// Volume becomes bounded by TIME (pairs x windows) rather than by traffic,
// so a mail backfill can no longer inflate the log at all. The keyspace is
// bounded — reasons come from the fixed Stage-0 rule set, sources from the
// fixed connector set — so the Map does not grow without limit.
//
// Contract: the ">=1 dropped event per source" assertion in
// mcp/test/integration/r25-end-to-end-cascade.test.mjs T4 still holds,
// because the first drop of every (source, reason) pair always emits.
// suppressed_count is additive-optional — policy.salience.dropped predates
// the synthesis wave, so validatePerKindShape (mcp/lib/policy-events.js)
// no-ops for it and existing readers ignore the extra key.
function emitDropped({ source, sourceMsgId, reason, nowIso, sink }) {
  const r = reason || "unspecified";
  const { emit, suppressed } = shouldEmitDrop({ source, reason: r, nowIso });
  if (!emit) return;

  emitPolicyEvent({
    kind: "policy.salience.dropped",
    source,
    source_msg_id: sourceMsgId || null,
    reason: r,
    ts: nowIso,
    suppressed_count: suppressed,
  }, sink);
}

function emitRedacted({ source, sourceMsgId, nowIso, sink }) {
  emitPolicyEvent({
    kind: "policy.salience.redacted",
    source,
    source_msg_id: sourceMsgId || null,
    reason: "otp_pattern",
    ts: nowIso,
  }, sink);
}

function emitCorroboration({
  source,
  sourceMsgId,
  targetMemoryId,
  cosineDistance,
  reason,
  nowIso,
  sink,
}) {
  emitPolicyEvent({
    kind: "policy.corroboration",
    target_memory_id: targetMemoryId,
    source_ref: {
      source,
      source_msg_id: sourceMsgId || null,
    },
    // WU1: cosine_distance is OPTIONAL. The Layer-3 embed+kNN path supplies a
    // real distance; the Layer-2.5 content-hash dedup path has no embedding,
    // so it passes null. The optional `reason` distinguishes the two
    // corroboration producers in the policy ledger
    // (e.g. "content_duplicate_no_embed").
    cosine_distance: typeof cosineDistance === "number" ? cosineDistance : null,
    ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
    weights_hash: SALIENCE_WEIGHTS_V1_HASH,
    salience_version: CAPS.SALIENCE_VERSION,
    ts: nowIso,
  }, sink);
}

// ----------------------------------------------------------------------------
// scoreCandidate — public entry point
// ----------------------------------------------------------------------------
//
// event shape (caller-supplied; what distill-promote-fact knows about):
//   {
//     source:          string,   // e.g. "imessage"
//     source_msg_id:   string,
//     content:         string,   // the args.content the caller will append
//     consent_basis:   string,   // "first_party" | "third_party_inferred" | ...
//     ts:              string,   // ISO 8601; the source-ledger row's ts
//     raw:             object?,  // optional: the full source-ledger raw row,
//                                // forwarded to Stage-0 modules (tapback,
//                                // urn:biz, ZSTREAMNAME, WatchEvent, etc.)
//   }
//
// ctx shape:
//   {
//     embedding_mrl_768: number[] | null,  // pre-computed by caller
//     hnsw:              HnswIndex | null, // recall-layer HNSW handle
//     now:               Date | number?,   // test injection; defaults to Date.now
//   }
//
// Returns: see header. Caller MUST honour DROP / REDACT_DROP / CORROBORATE
// by short-circuiting and NOT appending a fact row.
export async function scoreCandidate(event, ctx = {}) {
  if (event == null || typeof event !== "object") {
    throw new TypeError("scoreCandidate: event must be an object");
  }
  if (typeof event.source !== "string" || event.source.length === 0) {
    throw new TypeError("scoreCandidate: event.source must be a non-empty string");
  }
  // CRIT-1c (R25.5): the watermark daemon passes raw source-ledger rows
  // whose payload lives in `raw_content` (object), not `content` (string).
  // Normalize at the boundary so the cascade is callable from any caller.
  // The empty-string outcome is permitted; contentMassScore drops to 0 and
  // Layer 2 acts as the second admission gate.
  event = normalizeSourceEvent(event);
  if (typeof event.content !== "string") {
    throw new TypeError("scoreCandidate: event.content must be a string");
  }

  const nowMs =
    ctx.now instanceof Date
      ? ctx.now.getTime()
      : typeof ctx.now === "number"
        ? ctx.now
        : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // -------------------- LAYER 1: Stage-0 hard-drop --------------------
  const dispatch = await loadStage0Dispatch();
  let stage0Hint = null;
  let stage0Reason = null;
  if (dispatch != null) {
    let stage0Result;
    try {
      stage0Result = dispatch(event.source, event);
    } catch {
      stage0Result = { decision: "PASS" };
    }
    if (stage0Result && stage0Result.decision === "DROP") {
      emitDropped({
        source: event.source,
        sourceMsgId: event.source_msg_id,
        reason: stage0Result.reason || "stage0_drop",
        nowIso,
        sink: ctx.policyEventSink,
      });
      return {
        decision: "DROP",
        reason: stage0Result.reason || "stage0_drop",
        source: event.source,
      };
    }
    if (stage0Result && stage0Result.decision === "REDACT_DROP") {
      emitRedacted({
        source: event.source,
        sourceMsgId: event.source_msg_id,
        nowIso,
        sink: ctx.policyEventSink,
      });
      return {
        decision: "REDACT_DROP",
        reason: stage0Result.reason || "otp_pattern",
        source: event.source,
      };
    }
    if (stage0Result && stage0Result.decision === "PASS") {
      if (typeof stage0Result.structural_score === "number") {
        stage0Hint = stage0Result.structural_score;
      }
      if (typeof stage0Result.reason === "string") {
        stage0Reason = stage0Result.reason;
      }
    }
  }

  // -------------------- LAYER 2 components (pre-embed) --------------------
  const eventTsMs = (() => {
    if (typeof event.ts === "string") {
      const t = Date.parse(event.ts);
      if (Number.isFinite(t)) return t;
    }
    return nowMs;
  })();

  const componentsPartial = {
    recency: recencyScore(eventTsMs, event.source, nowMs),
    authorship: authorshipScore(event),
    content_mass: contentMassScore(event.content),
    source_prior: sourcePriorScore(event.source),
    structural: structuralScore(event.source, stage0Hint, stage0Reason),
    // novelty + decay-feedback grafts populated below
    last_retrieved_ts: 0, // weight=0 in V1; admit-time value is null on the
                          // fact row but 0 in the scoring vector so the
                          // weighted dot-product is well-defined.
    use_count: 0,         // weight=0 in V1; CP-5 Trigger A activates this.
  };

  // -------------------- LAYER 2.5: EMBEDDING-FREE content-dedup gate --------
  // WU1-promote-time-content-dedup-gate. The "stop allowing it" fix.
  //
  // Fires AFTER Stage-1 structural PASS (the row is structurally admissible)
  // and BEFORE the Layer-3 embed branch. When no embedding is available (a
  // local-server outage → null embedding), the entire Layer-3 corroboration
  // path is dead (no embeddings → no kNN → no CORROBORATE), so duplicate
  // content streams straight through to PROMOTE. This content-hash analog
  // catches exact normalized-content duplicates with NO embedding at all.
  //
  // Fires ONLY when:
  //   - CAPS.CASCADE_CONTENT_DEDUP_ENABLED is true (default), AND
  //   - ctx.contentIndex is wired (the daemon builds it once per tick batch),
  //     AND
  //   - the candidate content is non-empty (empty content never dedups —
  //     lookupCanonical returns null for empty content), AND
  //   - lookupCanonical returns an EARLIER canonical fact_id that is NOT the
  //     candidate's own id (a row re-scored against itself must not collapse).
  //
  // On a hit: return CORROBORATE (no new fact row), pointing target_id at the
  // canonical (earliest) fact. The existing policy.corroboration emit is
  // reused with cosine_distance=null + reason="content_duplicate_no_embed".
  //
  // DEFENSIVE (cascade hot path): the entire gate is wrapped so a dedup-gate
  // failure DEGRADES to normal promote and NEVER blocks capture. A thrown
  // lookup (malformed index, etc.) is swallowed and the row continues to the
  // embed/promote branches exactly as if the gate were absent.
  if (
    CAPS.CASCADE_CONTENT_DEDUP_ENABLED === true &&
    ctx.contentIndex != null &&
    typeof event.content === "string" &&
    event.content.length > 0
  ) {
    let canonicalId = null;
    try {
      canonicalId = lookupCanonical(ctx.contentIndex, event.content);
    } catch {
      // Dedup-gate failure must DEGRADE to normal promote, never block
      // capture. Treat any lookup throw as a miss.
      canonicalId = null;
    }
    // The candidate's own id (when re-scoring an existing ledger row) lives at
    // event.id or event.source_msg_id depending on caller; never collapse a
    // row onto itself.
    const ownId =
      (typeof event.id === "string" && event.id) ||
      (typeof event.source_msg_id === "string" && event.source_msg_id) ||
      null;
    if (
      typeof canonicalId === "string" &&
      canonicalId.length > 0 &&
      canonicalId !== ownId
    ) {
      try {
        emitCorroboration({
          source: event.source,
          sourceMsgId: event.source_msg_id,
          targetMemoryId: canonicalId,
          cosineDistance: null,
          reason: "content_duplicate_no_embed",
          nowIso,
          sink: ctx.policyEventSink,
        });
      } catch {
        // Emit failure must not block the decision — the CORROBORATE return
        // below is the contract; the policy breadcrumb is best-effort.
      }
      return {
        decision: "CORROBORATE",
        target_id: canonicalId,
        source_ref: {
          source: event.source,
          source_msg_id: event.source_msg_id || null,
        },
        reason: "content_duplicate_no_embed",
      };
    }
  }

  // -------------------- LAYER 3: kNN novelty + corroboration --------------------
  // R25.5 CRIT-6 cold-start novelty lerp + corroboration disable.
  //
  // Two guards prevent backfill-ordering artifacts that the R25 brutalist
  // flagged as the top-week-1 risk:
  //
  //   1. Novelty lerp toward 0.5 while hnsw.size() < SALIENCE_NOVELTY_LERP_FLOOR
  //      (default 200). The raw novelty signal (1 - cosine_similarity to nearest
  //      neighbour) is meaningless when the index has very few entries — the
  //      "nearest" neighbour is essentially random. Linearly blending toward
  //      the neutral midpoint (0.5) while the index is sparse means the first
  //      ~200 backfill rows neither over- nor under-credit themselves on
  //      novelty. Without this guard, alphabetical phase ordering admits
  //      ~130k git-log rows at novelty=1.0 first, and ~80k rows later
  //      iMessage rows paraphrasing the same topics would collapse to
  //      corroboration against those inflated git-log facts — destroying
  //      iMessage provenance.
  //
  //   2. Corroboration disabled while hnsw.size() < SALIENCE_CORROBORATE_MIN_INDEX_SIZE
  //      (default 50). A single nearest-neighbour vote at this scale is just
  //      as likely coincidence as semantic agreement. Let everything PASS
  //      through to PROMOTE; corroboration re-enables automatically as the
  //      index grows past the threshold.
  //
  // R25.7 CRIT-A2: sync-embed wiring. If ctx.embedder is supplied AND
  // ctx.embedding_mrl_768 is absent, embed inline before the kNN lookup.
  // This is what makes Layer-3 corroboration actually fire in production —
  // the previous deferred-embed pattern (promoteSourceRow setting
  // embedding_pending=true and a separate backfill loop minting the vector
  // later) meant scoreCandidate never had a vector to consult, so
  // corroboration NEVER fired for watermark-path rows. The embedder is CALLED
  // as embedder({ text, taskType, dims, source }) — see the await below — and
  // its result is read TOLERANTLY, first match wins: r.vector_4096, then
  // r.vector_mrl_renormalized, then r.vector (the corroborateOrPromote-style
  // shape used by _corroborate.js test stubs). Tests inject a deterministic
  // stub. Embed failure propagates — the caller wraps the cascade in
  // try/catch and degrades to PROMOTE-without-salience-block.
  // WU2-inline-embed-and-remove-gemini-quota-machinery. The cascade embeds
  // inline via the local Qwen3 server (4096-dim) and threads the vector in on
  // ctx.embedding_4096. Back-compat: a caller that supplies the legacy 768-d
  // ctx.embedding_mrl_768 (Gemini-era hermetic tests, the manual MCP path)
  // still works — `emb` is dimension-agnostic for the kNN search; we just
  // remember which field carried it so the PROMOTE return surfaces the right
  // key for promoteSourceRow to persist.
  let emb = null;
  let embIs4096 = false;
  if (Array.isArray(ctx.embedding_4096) && ctx.embedding_4096.length > 0) {
    emb = ctx.embedding_4096;
    embIs4096 = true;
  } else if (Array.isArray(ctx.embedding_mrl_768) && ctx.embedding_mrl_768.length > 0) {
    emb = ctx.embedding_mrl_768;
  }

  // Back-compat inline-embed fallback: when no vector was pre-fetched AND a
  // ctx.embedder is wired (hermetic tests, legacy callers), embed inline.
  // WU2 removed the Gemini-quota PROMOTE_WITHOUT_EMBED / EMBED_DEFERRED
  // short-circuits — the local server has no per-key quota to exhaust. On the
  // production watermark path the daemon pre-fetches via the local client and
  // does NOT wire ctx.embedder, so this branch is hermetic-test-only now.
  if ((!Array.isArray(emb) || emb.length === 0) &&
      typeof ctx.embedder === "function" &&
      typeof event.content === "string" && event.content.length > 0) {
    const r = await ctx.embedder({
      text: event.content,
      taskType: "RETRIEVAL_DOCUMENT",
      dims: CAPS.GEMINI_EMBEDDING_DIMS_MRL,
      source:
        typeof event.source === "string" && event.source.length > 0
          ? event.source
          : "cascade-promote",
    });
    if (r && Array.isArray(r.vector_4096) && r.vector_4096.length > 0) {
      emb = r.vector_4096;
      embIs4096 = true;
    } else if (r && Array.isArray(r.vector_mrl_renormalized) &&
        r.vector_mrl_renormalized.length > 0) {
      emb = r.vector_mrl_renormalized;
    } else if (r && Array.isArray(r.vector) && r.vector.length > 0) {
      // Tolerate the corroborateOrPromote-style { vector } shape used by
      // _corroborate.js test stubs.
      emb = r.vector;
    }
    // If r is null / mis-shaped: emb stays null; the row PROMOTES with a null
    // embedding (novelty-0.5 floor). The watermark daemon records the fact id
    // to the re-embed sweep file so a later DRAIN can re-embed it
    // (daemons/reembed-drain.mjs consumes the file; it is not a watermark tick).
  }

  const hnsw = ctx.hnsw;
  let novelty = 0.5; // neutral midpoint when embed unavailable
  let nearest = null;
  let hnswSize = 0;
  if (Array.isArray(emb) && emb.length > 0 && hnsw && typeof hnsw.search === "function") {
    let knnResults = [];
    try {
      hnswSize = typeof hnsw.size === "function" ? hnsw.size() : 0;
      if (hnswSize > 0) {
        const k = Math.min(CAPS.SALIENCE_KNN_K, hnswSize);
        // Q3 (memperf): ctx.hnsw may be the watermark daemon's queryd-backed
        // handle whose search() is async — await it (a no-op on the sync
        // in-process HnswIndex). The surrounding try/catch now also catches
        // async rejections, so a queryd failure degrades THIS row to
        // knn-empty instead of leaking a Promise into
        // noveltyAndCorroborationFromKnn.
        knnResults = (await hnsw.search(emb, k)) || [];
      }
    } catch {
      knnResults = [];
    }
    const r = noveltyAndCorroborationFromKnn(knnResults);
    novelty = r.novelty;
    nearest = r.nearest;
  } else if (!Array.isArray(emb) || emb.length === 0) {
    // embed-pending path: novelty stays at 0.5; corroboration cannot fire.
    novelty = 0.5;
  }

  // R25.5 CRIT-6 (a): cold-start novelty lerp toward 0.5. Blend
  // effective_novelty = 0.5 * (1 - t) + raw * t   where  t = size / FLOOR.
  // At size=0  → effective=0.5 (raw 1.0 is fully suppressed).
  // At size>=FLOOR → effective=raw (no-op).
  const lerpFloor = CAPS.SALIENCE_NOVELTY_LERP_FLOOR;
  if (typeof lerpFloor === "number" && lerpFloor > 0 && hnswSize < lerpFloor) {
    const t = hnswSize / lerpFloor; // in [0, 1)
    novelty = 0.5 * (1 - t) + novelty * t;
  }

  // R25.5 CRIT-6 (b): corroboration disabled while hnsw is too sparse.
  const corrobMinSize = CAPS.SALIENCE_CORROBORATE_MIN_INDEX_SIZE;
  const corroborationEnabled =
    typeof corrobMinSize === "number" ? hnswSize >= corrobMinSize : true;

  // Corroboration branch: if nearest cosine_distance under threshold, do
  // NOT promote — emit policy.corroboration and return CORROBORATE.
  //
  // A5 (memory-roots node codex-speaker-guard) — speaker guard, behind
  // CAPS.SALIENCE_CORROBORATE_SPEAKER_GUARD_ENABLED (test override:
  // _setSpeakerGuardForTest). A row that is the operator speaking
  // (isOperatorWordsTurn: non-blank raw_content.user_text, not
  // auto_injected, not a scaffold envelope) is never folded into a
  // nearest-neighbour fact by distance alone; it falls through to the PROMOTE
  // return below with `novelty` = the raw kNN distance (the persisted fold
  // distance is the after-census key). Nothing new is emitted and no reason
  // string is added: flag off is byte-for-byte the routing above this
  // comment.
  //
  // Why: a corroboration keeps only a target_id, so the operator's words
  // leave the ledger. Measured 2026-09-02..09-08 (FA4-1 / FA4-4): codex-cli
  // 663 operator-word rows, 338 promoted, 230 kNN-corroborated at the 0.25
  // threshold (51.0% admission; 81/week folded into a target that is not an
  // operator turn); chat-claude-code 274 / 116 / 158 (42.3%). Assistant-only
  // rows (14,237 codex / week) and scaffold rows (237 codex; the 118
  // reply-less `<recommended_plugins>` envelopes now DROP at Stage-0, the 103
  // with a reply still reach this branch) are untouched by the guard.
  //
  // Precedence: the Layer-2.5 content-hash branch (lookupCanonical, above)
  // runs first and is not guarded, so a byte-identical re-paste of an
  // operator turn still CORROBORATEs with reason="content_duplicate_no_embed"
  // — the guard protects distinct operator words, not repeats.
  //
  // Rejected variant (target-aware: "skip the fold unless the TARGET is
  // itself an operator turn"): the target's speaker is unavailable at this
  // decision point. ctx.hnsw.search returns only {memory_id, cosine_distance,
  // rank} — the watermark daemon's queryd-backed handle passes queryd's
  // results through verbatim (daemons/watermark.js __makeQuerydSalienceHnsw)
  // — and resolving the target fact's source row here would add a ledger
  // read to the cascade hot path. Measured but unbuildable in this branch
  // (FA5-3).
  const speakerGuardOn =
    _speakerGuardOverride ??
    CAPS.SALIENCE_CORROBORATE_SPEAKER_GUARD_ENABLED === true;
  const corroborateThr =
    CAPS.SALIENCE_CORROBORATE_THRESHOLD[event.source] ?? null;
  if (
    corroborationEnabled &&
    nearest != null &&
    typeof corroborateThr === "number" &&
    nearest.cosine_distance < corroborateThr &&
    !(speakerGuardOn && isOperatorWordsTurn(event))
  ) {
    emitCorroboration({
      source: event.source,
      sourceMsgId: event.source_msg_id,
      targetMemoryId: nearest.memory_id,
      cosineDistance: nearest.cosine_distance,
      nowIso,
      sink: ctx.policyEventSink,
    });
    return {
      decision: "CORROBORATE",
      target_id: nearest.memory_id,
      source_ref: {
        source: event.source,
        source_msg_id: event.source_msg_id || null,
      },
      cosine_distance: nearest.cosine_distance,
    };
  }

  const components = {
    ...componentsPartial,
    novelty,
  };
  const score = weightedScore(components);

  // Surface the embedding vector on the PROMOTE return so the caller
  // (promoteSourceRow / distill-promote-fact handler) can persist it onto the
  // fact row AND append it to the recall HNSW without re-embedding. WU2: the
  // active local backend produces a 4096-dim vector surfaced as
  // embedding_4096; the legacy Gemini path surfaces embedding_mrl_768. Both
  // are null when no vector was available (empty content OR local-server
  // outage), in which case the row promotes with a null embedding.
  const embOut = Array.isArray(emb) && emb.length > 0 ? emb : null;
  return {
    decision: "PROMOTE",
    score,
    components,
    weights_hash: SALIENCE_WEIGHTS_V1_HASH,
    version: CAPS.SALIENCE_VERSION,
    embedding_4096: embIs4096 ? embOut : null,
    embedding_mrl_768: embIs4096 ? null : embOut,
  };
}

// ----------------------------------------------------------------------------
// buildSalienceFeaturesBlock — helper for the caller (distill-promote-fact)
// to construct the features.salience sub-object from a PROMOTE result. The
// stored decay-feedback columns are NULL/0 at admit (the dot-product used
// the 0 placeholders); they are populated later by the projection script
// reading recall.jsonl. Storing null vs 0 here matches the design's
// "null at admit (decay-feedback graft)" wording for last_retrieved_ts.
// ----------------------------------------------------------------------------
export function buildSalienceFeaturesBlock(promoteResult) {
  if (promoteResult == null || promoteResult.decision !== "PROMOTE") {
    throw new Error("buildSalienceFeaturesBlock: expected PROMOTE result");
  }
  const c = promoteResult.components;
  return {
    score: promoteResult.score,
    components: {
      recency: c.recency,
      authorship: c.authorship,
      content_mass: c.content_mass,
      source_prior: c.source_prior,
      structural: c.structural,
      novelty: c.novelty,
      last_retrieved_ts: null, // graft; populated post-recall
      use_count: 0,            // graft; populated post-recall
    },
    weights_hash: promoteResult.weights_hash,
    version: promoteResult.version,
  };
}

// ----------------------------------------------------------------------------
// Internal exports for tests / replay scripts. Not part of the public API.
// ----------------------------------------------------------------------------
export const _internals = {
  recencyScore,
  authorshipScore,
  contentMassScore,
  sourcePriorScore,
  structuralScore,
  noveltyAndCorroborationFromKnn,
  weightedScore,
  WEIGHTS: _WEIGHTS,
  COMPONENT_KEYS: _COMPONENT_KEYS,
  // A5 — speaker guard predicate + flag override, for the suite (T-A5-*) and
  // the read-only replay (memory-roots maps/codex_speaker_guard_replay.mjs).
  isOperatorWordsTurn,
  _setSpeakerGuardForTest,
};
