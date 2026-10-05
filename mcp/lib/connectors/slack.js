// slack.js — R38 Phase 2c Slack connector.
//
// Polls the Slack Web API for the operator's authorised workspaces and
// channels, normalises each message into the canonical source-row shape, and
// appends to storage/sources/slack.jsonl via ConnectorBase. Per-channel
// cursor state lives under storage/sources/slack-cursors/<workspace_id>/
// <channel_id>.json so a daemon restart never re-pulls history.
//
// Authoritative specs:
//   - reviews/r38/inventory.md § Slack design (Phase A inventory).
//   - kb/connectors-phase2c.md § slack_row_shape (canonical row contract).
//   - kb/ingestion.md § Connector contract (the six obligations the base
//     class satisfies; this module supplies polling + per-row normalisation).
//
// Auth: SLACK_USER_TOKEN env var (xoxp-* user OAuth token). One token per
// workspace is the canonical shape; SLACK_USER_TOKEN_<workspace_id> overrides
// the global token per workspace when multiple workspaces have distinct
// tokens. SLACK_WORKSPACE_IDS is a comma-separated list of workspace IDs.
//
// Cursor shape:
//   storage/sources/slack-cursors/<workspace_id>/<channel_id>.json:
//     {
//       last_ts: "<slack-ts>",       // last seen message ts
//       last_polled_ts: ISO-8601,
//     }
//
//   ConnectorBase cursor at connectors/slack/state.json:
//     {
//       workspaces: { "<workspace_id>": { "channels_seen": [<ids>] } },
//       last_polled_ts, last_appended_ts, last_appended_id,
//       last_cursor_advance_ts, error_count, last_error_kind,
//     }
//
// source_msg_id formula (matches reviews/r38/inventory.md):
//   sha256("slack:" + workspace_id + ":" + channel_id + ":" + ts)
// stamped on the row as `slack:<ws>:<ch>:<ts>` for trivial dedup and operator
// auditability (the source_msg_id IS the preimage, not a hashed opaque value;
// matches the codex-cli `codex:<sid>:<turn>` convention).
//
// Per-channel consent (post F-T2-SLACK-F7, Wave 2):
//   im (DM)                         -> first_party if operator authored,
//                                       third_party_inferred otherwise
//                                       (was: first_party for both
//                                       directions per the Phase A spec;
//                                       F-T2-SLACK-F7 tightens DM consent
//                                       so peer-authored DM messages are
//                                       classified the same way as
//                                       peer-authored mpim/private_channel
//                                       rows, consistent with imessage
//                                       /telegram DM treatment).
//   mpim, group, private_channel    -> first_party for own messages,
//                                       third_party_inferred for others
//   public channel                  -> first_party if operator authored,
//                                       public_observation otherwise
//
// Rate-limit handling: 429 responses observe Retry-After (Slack returns it
// in seconds). Exponential backoff caps at SLACK_MAX_BACKOFF_SECONDS so a
// runaway 429 cannot indefinitely block the poll loop; after the cap the
// pollOnce tags an error and returns, leaving the cursor unchanged for the
// next tick.
//
// HERMETICITY: every path is sourced via ConnectorBase config helpers; the
// fetch surface is exposed via opts.fetchImpl so tests override the network
// transport. The slack-connector.test.mjs harness drives the connector with
// a stub fetch that returns synthetic conversations.list +
// conversations.history responses.
//
// KEY_LEAKAGE_ZERO: tokens are read once at construction and used only as
// Authorization headers; no token text reaches stdout/stderr. Per-channel
// state files contain only Slack `ts` values and timestamps — never tokens
// or message bodies.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { ConnectorBase } from "./index.js";
import { CAPS } from "../validation.js";
import { STORAGE_DIR } from "../config.js";
import { serverTs } from "../envelope.js";
import { stage0 as slackStage0 } from "../ingest/stage0/slack.js";

// =============================================================================
// Constants
// =============================================================================

const SOURCE = "slack";

// Slack Web API base. Operator-overridable for tests so we hit a fake URL
// without ever touching slack.com from the test harness.
const SLACK_API_BASE_DEFAULT = "https://slack.com/api";

// Default per-page row count for conversations.history. Slack caps at 1000
// for user-token endpoints; 200 is the conservative default. Operator can
// override via SLACK_HISTORY_PAGE_LIMIT.
const HISTORY_PAGE_LIMIT_DEFAULT = 200;

// Default channel-list page size. The conversations.list endpoint accepts
// up to 1000 but defaults to 100; we use 200 as a balance.
const CONVERSATIONS_PAGE_LIMIT_DEFAULT = 200;

// Cap on total backoff while a single pollOnce drains 429s. 5 minutes
// (300s) is well within the launchd ThrottleInterval + StartInterval window
// (10 min); beyond this we surrender the tick and let the next StartInterval
// retry naturally.
const SLACK_MAX_BACKOFF_SECONDS = 300;

// Default Retry-After when Slack returns 429 without the header (rare but
// not impossible per their docs).
const SLACK_DEFAULT_RETRY_AFTER_SECONDS = 30;

// =============================================================================
// SlackConnector
// =============================================================================

export class SlackConnector extends ConnectorBase {
  constructor(opts = {}) {
    const {
      // Operator inputs (env-overridable):
      userToken,
      workspaceIds,
      perWorkspaceTokens,
      apiBase,
      historyPageLimit,
      conversationsPageLimit,
      // Self-identity for consent classification: the Slack user_id of the
      // operator on each workspace. Required to distinguish "own message"
      // (first_party) from "other-authored" (third_party_inferred or
      // public_observation). Resolved on first poll via auth.test if absent.
      selfUserIds,
      // Test-only injection points:
      fetchImpl,
      now,
      // ConnectorBase pass-throughs:
      sourceLedgerPath,
      cursorPath,
    } = opts;

    // sourcePolicyForRow: derive consent_basis + deletion_semantics from the
    // per-row `_slack_classification` field stamped at buildRow time. The
    // base class invokes this AFTER buildRow runs; we store the verdict on
    // the row itself rather than re-deriving from channel+user.
    function sourcePolicyForRow(row) {
      const rc = row?.raw_content || {};
      const klass = rc.consent_classification || "first_party";
      return {
        deletion_semantics: "full_excise",
        consent_basis: klass,
      };
    }

    super({
      source: SOURCE,
      sourceLedgerPath,
      cursorPath,
      sourcePolicyForRow,
    });

    this.userToken = typeof userToken === "string" && userToken !== ""
      ? userToken
      : (process.env.SLACK_USER_TOKEN || "");
    this.workspaceIds = Array.isArray(workspaceIds) && workspaceIds.length > 0
      ? workspaceIds
      : parseWorkspaceIds(process.env.SLACK_WORKSPACE_IDS);
    this.perWorkspaceTokens = perWorkspaceTokens && typeof perWorkspaceTokens === "object"
      ? { ...perWorkspaceTokens }
      : parsePerWorkspaceTokens();
    this.apiBase = typeof apiBase === "string" && apiBase !== ""
      ? apiBase
      : (process.env.SLACK_API_BASE || SLACK_API_BASE_DEFAULT);
    this.historyPageLimit = Number.isInteger(historyPageLimit) && historyPageLimit > 0
      ? historyPageLimit
      : (parseIntFromEnv(process.env.SLACK_HISTORY_PAGE_LIMIT) || HISTORY_PAGE_LIMIT_DEFAULT);
    this.conversationsPageLimit = Number.isInteger(conversationsPageLimit) && conversationsPageLimit > 0
      ? conversationsPageLimit
      : (parseIntFromEnv(process.env.SLACK_CONVERSATIONS_PAGE_LIMIT) || CONVERSATIONS_PAGE_LIMIT_DEFAULT);
    this.selfUserIds = selfUserIds && typeof selfUserIds === "object"
      ? { ...selfUserIds }
      : {};
    this._fetchImpl = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
    this._now = typeof now === "function" ? now : serverTs;
  }

  // ---------------------------------------------------------------------------
  // Auth surface
  // ---------------------------------------------------------------------------

  // refusesToStart: production guard at the daemon entry point. If no token is
  // configured we refuse to poll. Tests pass userToken via opts so they
  // bypass this guard.
  assertConfigured() {
    if (this.userToken === "" && Object.keys(this.perWorkspaceTokens).length === 0) {
      throw new Error(
        "SlackConnector: no token configured — set SLACK_USER_TOKEN " +
        "(or SLACK_USER_TOKEN_<workspace_id>) in env (xoxp-* user OAuth token)",
      );
    }
    if (this.workspaceIds.length === 0) {
      throw new Error(
        "SlackConnector: no workspaces configured — set SLACK_WORKSPACE_IDS " +
        "(comma-separated workspace IDs, e.g. T01ABC,T02DEF)",
      );
    }
  }

  tokenForWorkspace(workspaceId) {
    if (this.perWorkspaceTokens[workspaceId]) return this.perWorkspaceTokens[workspaceId];
    return this.userToken;
  }

  // ---------------------------------------------------------------------------
  // Cursor (per-channel) — storage/sources/slack-cursors/<ws>/<ch>.json
  // ---------------------------------------------------------------------------

  channelCursorPath(workspaceId, channelId) {
    const root = join(STORAGE_DIR, "sources", "slack-cursors", workspaceId);
    return join(root, `${channelId}.json`);
  }

  readChannelCursor(workspaceId, channelId) {
    const p = this.channelCursorPath(workspaceId, channelId);
    if (!existsSync(p)) return { last_ts: null, last_polled_ts: null };
    try {
      const raw = readFileSync(p, "utf8");
      if (raw === "") return { last_ts: null, last_polled_ts: null };
      const parsed = JSON.parse(raw);
      return {
        last_ts: typeof parsed?.last_ts === "string" ? parsed.last_ts : null,
        last_polled_ts: typeof parsed?.last_polled_ts === "string" ? parsed.last_polled_ts : null,
      };
    } catch {
      return { last_ts: null, last_polled_ts: null };
    }
  }

  writeChannelCursor(workspaceId, channelId, state) {
    const p = this.channelCursorPath(workspaceId, channelId);
    const dir = dirname(p);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const body = JSON.stringify(
      {
        last_ts: typeof state.last_ts === "string" ? state.last_ts : null,
        last_polled_ts: this._now(),
      },
      null,
      2,
    ) + "\n";
    writeFileSync(p, body, { mode: 0o600 });
  }

  // ---------------------------------------------------------------------------
  // HTTP — rate-limit-aware Slack Web API call
  // ---------------------------------------------------------------------------

  // _slackApiCall: POST application/x-www-form-urlencoded to the Slack Web
  // API; respect 429 Retry-After; back off exponentially when no header is
  // present. Returns parsed JSON body on success. Throws on cap exceeded.
  async _slackApiCall(method, params, workspaceId) {
    const token = this.tokenForWorkspace(workspaceId);
    if (!token) {
      throw new Error(`SlackConnector: no token for workspace ${workspaceId}`);
    }
    const url = `${this.apiBase}/${method}`;
    const body = new URLSearchParams(params).toString();
    let totalBackoff = 0;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let res;
      try {
        res = await this._fetchImpl(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body,
        });
      } catch (err) {
        // Network / DNS / transport error. Treat as retryable with
        // bounded backoff; the daemon's launchd ThrottleInterval is the
        // outer safety net.
        if (totalBackoff >= SLACK_MAX_BACKOFF_SECONDS) {
          throw new Error(`slack_network_error: ${err && err.code ? err.code : "fetch_failed"}`);
        }
        const wait = Math.min(2 ** attempt, 30);
        totalBackoff += wait;
        await sleep(wait * 1000);
        continue;
      }
      if (res.status === 429) {
        // Slack rate limit: respect Retry-After (seconds).
        const retryAfter = parseInt(
          (res.headers && (res.headers.get ? res.headers.get("retry-after") : res.headers["retry-after"])) || "",
          10,
        );
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : SLACK_DEFAULT_RETRY_AFTER_SECONDS;
        if (totalBackoff + wait > SLACK_MAX_BACKOFF_SECONDS) {
          throw new Error("slack_rate_limited");
        }
        totalBackoff += wait;
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) {
        throw new Error(`slack_http_${res.status}`);
      }
      let parsed;
      try {
        parsed = await res.json();
      } catch {
        throw new Error("slack_parse_error");
      }
      if (parsed && parsed.ok === false) {
        // Slack returns ok:false with an `error` field for application
        // errors (invalid_auth, channel_not_found, missing_scope, etc.).
        // We surface these as enumerated codes via tagError; no token
        // text ever flows here.
        const code = typeof parsed.error === "string" ? parsed.error : "unknown";
        // Auth-class errors are fatal at the pollOnce level.
        if (code === "invalid_auth" || code === "not_authed" || code === "account_inactive" || code === "token_revoked") {
          throw new Error(`slack_auth_${code}`);
        }
        throw new Error(`slack_api_${code}`);
      }
      return parsed;
    }
  }

  // ---------------------------------------------------------------------------
  // Conversation enumeration
  // ---------------------------------------------------------------------------

  // listConversations: enumerate every channel/DM the operator participates
  // in for one workspace. Returns an array of {id, kind} where kind is one of
  // "im", "mpim", "private_channel", "public_channel".
  async listConversations(workspaceId) {
    const out = [];
    let cursor = "";
    let pageCount = 0;
    while (pageCount < 64) {
      pageCount += 1;
      const params = {
        limit: String(this.conversationsPageLimit),
        types: "public_channel,private_channel,mpim,im",
        exclude_archived: "true",
      };
      if (cursor) params.cursor = cursor;
      const res = await this._slackApiCall("conversations.list", params, workspaceId);
      const channels = Array.isArray(res.channels) ? res.channels : [];
      for (const ch of channels) {
        if (!ch || typeof ch.id !== "string") continue;
        // Skip explicitly archived channels even if exclude_archived missed one.
        if (ch.is_archived === true) continue;
        const kind = classifyChannelKind(ch);
        out.push({ id: ch.id, kind });
      }
      cursor = res.response_metadata && typeof res.response_metadata.next_cursor === "string"
        ? res.response_metadata.next_cursor
        : "";
      if (!cursor) break;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // History per channel
  // ---------------------------------------------------------------------------

  // fetchChannelHistory: walk conversations.history with cursor pagination
  // starting from oldest = last_ts. Returns an array of Slack message events,
  // oldest-first across the WHOLE history (Slack returns each page
  // newest-first; we reverse within each page AND concat pages in reverse so
  // the final array is oldest-first across all pages). Caps iteration to a
  // defensive page count so a runaway backfill cannot consume the entire
  // poll window.
  async fetchChannelHistory(workspaceId, channelId, sinceTs) {
    const pages = [];
    let cursor = "";
    let pageCount = 0;
    const maxPages = 16;
    while (pageCount < maxPages) {
      pageCount += 1;
      const params = {
        channel: channelId,
        limit: String(this.historyPageLimit),
        inclusive: "false",
      };
      if (sinceTs) params.oldest = sinceTs;
      if (cursor) params.cursor = cursor;
      const res = await this._slackApiCall("conversations.history", params, workspaceId);
      const messages = Array.isArray(res.messages) ? res.messages : [];
      pages.push(messages);
      cursor = res.response_metadata && typeof res.response_metadata.next_cursor === "string"
        ? res.response_metadata.next_cursor
        : "";
      const hasMore = res.has_more === true;
      if (!cursor || !hasMore) break;
    }
    // Slack returns each page newest-first; subsequent pages walk further
    // back in time. To produce a single oldest-first stream across all
    // pages, iterate the pages in reverse and reverse each page's contents.
    const out = [];
    for (let p = pages.length - 1; p >= 0; p--) {
      const msgs = pages[p];
      for (let i = msgs.length - 1; i >= 0; i--) {
        out.push(msgs[i]);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Self-identity (auth.test)
  // ---------------------------------------------------------------------------

  // resolveSelfUserId: call auth.test once per workspace to learn the
  // operator's user_id on that workspace. Required for consent classification
  // (own-vs-other authorship). Cached on the connector instance for the
  // process lifetime; cursor file does NOT persist it (a session-rotation
  // could change user_id, so we re-derive each daemon start).
  async resolveSelfUserId(workspaceId) {
    if (typeof this.selfUserIds[workspaceId] === "string" && this.selfUserIds[workspaceId] !== "") {
      return this.selfUserIds[workspaceId];
    }
    try {
      const res = await this._slackApiCall("auth.test", {}, workspaceId);
      const userId = typeof res.user_id === "string" ? res.user_id : null;
      if (userId) {
        this.selfUserIds[workspaceId] = userId;
        return userId;
      }
    } catch (err) {
      // Fatal — without a self-id we cannot safely classify consent.
      // Tag the error and let the caller skip the workspace.
      await this.tagError(err && err.message ? err.message : "slack_auth_resolve_error");
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // pollOnce — main per-tick entry point
  // ---------------------------------------------------------------------------

  async pollOnce() {
    this.assertConfigured();
    const state = (await this.readCursor()) || {};
    const workspaces = state.workspaces && typeof state.workspaces === "object"
      ? { ...state.workspaces }
      : {};

    let appendedCount = 0;
    let errorCount = 0;
    let lastAppendedTs = state.last_appended_ts || null;
    let lastAppendedId = state.last_appended_id || null;
    let channelsProcessed = 0;
    // c3-cursor-stamp-class: did ANY per-channel cursor move this poll? See
    // the write site at the tail of this method for why.
    let cursorAdvanced = false;

    for (const workspaceId of this.workspaceIds) {
      let selfUserId;
      try {
        selfUserId = await this.resolveSelfUserId(workspaceId);
      } catch (err) {
        errorCount += 1;
        await this.tagError(err && err.message ? err.message : "slack_self_id_error");
        continue;
      }
      if (!selfUserId) {
        errorCount += 1;
        // already tagged inside resolveSelfUserId
        continue;
      }

      let conversations;
      try {
        conversations = await this.listConversations(workspaceId);
      } catch (err) {
        errorCount += 1;
        await this.tagError(err && err.message ? err.message : "slack_list_error");
        continue;
      }

      const channelsSeen = [];
      for (const conv of conversations) {
        channelsSeen.push(conv.id);
        channelsProcessed += 1;
        const cursor = this.readChannelCursor(workspaceId, conv.id);
        let messages;
        try {
          messages = await this.fetchChannelHistory(workspaceId, conv.id, cursor.last_ts);
        } catch (err) {
          errorCount += 1;
          await this.tagError(err && err.message ? err.message : "slack_history_error");
          continue;
        }
        let newLastTs = cursor.last_ts;
        for (const msg of messages) {
          if (!msg || typeof msg.ts !== "string") continue;
          const built = buildRow({
            workspaceId,
            channelId: conv.id,
            channelKind: conv.kind,
            selfUserId,
            msg,
          });
          if (built == null) continue; // structurally unbuildable (no text, etc.)
          // Stage-0 probe (cheap; runs before checksum + atomic-append).
          const probe = {
            source: SOURCE,
            raw_content: built.raw_content,
          };
          const stage0Verdict = slackStage0(probe);
          if (stage0Verdict && stage0Verdict.decision === "DROP") {
            // Advance the channel cursor past this ts so we don't re-process
            // a Stage-0-dropped event next tick.
            newLastTs = msg.ts;
            continue;
          }
          try {
            const res = await this.appendLedgerRow(built);
            if (res.appended) {
              appendedCount += 1;
              lastAppendedTs = this._now();
              lastAppendedId = res.id;
            }
            newLastTs = msg.ts;
          } catch (err) {
            errorCount += 1;
            await this.tagError(err && err.code ? err.code : "slack_append_error");
            // Do NOT advance newLastTs on append failure; retry next tick.
            break;
          }
        }
        if (newLastTs && newLastTs !== cursor.last_ts) {
          this.writeChannelCursor(workspaceId, conv.id, { last_ts: newLastTs });
          // c3-cursor-stamp-class: this is the ONLY place a slack cursor moves.
          // It covers both real progress kinds — an appended message and a
          // Stage-0-dropped message we skip past (newLastTs = msg.ts above).
          cursorAdvanced = true;
        }
      }

      workspaces[workspaceId] = { channels_seen: channelsSeen };
    }

    const nowTs = this._now();
    // c3-cursor-stamp-class fix (ports telegram.js:255-264): bump
    // last_cursor_advance_ts ONLY when a channel cursor genuinely advanced this
    // poll. The prior unconditional `nowTs` stamped an advance on EVERY poll
    // even when nothing moved, which refreshed the timestamp forever and
    // defeated the staleness classifiers (index.js _healthFromState :601,607-611
    // and metadataFromState :701,707-711 compare this field against
    // CAPS.CONNECTOR_HEALTH_STALE_SECONDS) — slack could never go `stale`.
    //
    // Observed failure shape: with an invalid OAuth token, resolveSelfUserId
    // (:429-441) returns null and the workspace is skipped at :470-474 — the
    // error count climbs into the thousands, last_error_kind is
    // "slack_auth_invalid_auth", workspaces is {}, and last_appended_ts is
    // null (storage/sources/slack.jsonl never exists) — yet
    // last_cursor_advance_ts was stamped milliseconds AFTER last_error_ts on
    // every poll. A connector that had never appended a row was reporting a
    // fresh cursor advance every 30 s.
    //
    // last_polled_ts stays unconditional (it means "we ran"); last_appended_ts
    // only moves on a real append.
    const carriedAdvanceTs =
      typeof state.last_cursor_advance_ts === "string" ? state.last_cursor_advance_ts : null;
    const nextState = {
      ...state,
      workspaces,
      last_polled_ts: nowTs,
      last_appended_ts: lastAppendedTs,
      last_appended_id: lastAppendedId,
      last_cursor_advance_ts: cursorAdvanced ? nowTs : carriedAdvanceTs,
      error_count: Number.isInteger(state.error_count) ? state.error_count : 0,
    };
    const reloaded = (await this.readCursor()) || {};
    if (Number.isInteger(reloaded.error_count) && reloaded.error_count >= nextState.error_count) {
      nextState.error_count = reloaded.error_count;
      nextState.last_error_kind = reloaded.last_error_kind;
      nextState.last_error_ts = reloaded.last_error_ts;
    }
    await this.writeCursor(nextState);

    return {
      appended: appendedCount,
      errors: errorCount,
      channels: channelsProcessed,
      workspaces: this.workspaceIds.length,
    };
  }
}

// =============================================================================
// Helpers (module-private)
// =============================================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseIntFromEnv(v) {
  if (typeof v !== "string" || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseWorkspaceIds(envVal) {
  if (typeof envVal !== "string" || envVal === "") return [];
  return envVal
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Parse SLACK_USER_TOKEN_<workspace_id> env vars into a map. e.g.
// SLACK_USER_TOKEN_T01ABC=xoxp-... -> { T01ABC: "xoxp-..." }.
function parsePerWorkspaceTokens() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v === "") continue;
    if (k.startsWith("SLACK_USER_TOKEN_")) {
      const wsId = k.slice("SLACK_USER_TOKEN_".length);
      if (wsId !== "") out[wsId] = v;
    }
  }
  return out;
}

// classifyChannelKind: map a conversations.list channel object to one of
// our four canonical kinds. Slack carries multiple boolean fields; we use
// the most specific one. Order matters: im > mpim > private > public.
function classifyChannelKind(ch) {
  if (ch.is_im === true) return "im";
  if (ch.is_mpim === true) return "mpim";
  if (ch.is_private === true || ch.is_group === true) return "private_channel";
  return "public_channel";
}

// classifyConsent: per-row consent_basis derivation.
//
// F-T2-SLACK-F7 (Wave 2) — DM consent tightening. The Phase A spec said
// im -> first_party for BOTH directions; the audit found that peer-
// authored DM messages were being labelled first_party even though the
// peer never granted consent for their words to land in the operator's
// memory ledger. Tightened classification:
//   im                              -> first_party if author == selfUserId
//                                       else third_party_inferred
//   mpim / private_channel          -> first_party if author == selfUserId
//                                       else third_party_inferred
//   public_channel                  -> first_party if author == selfUserId
//                                       else public_observation
// This matches the imessage and telegram DM treatment (peer-authored DM
// messages are third_party_inferred in both, per F-T1-IMESSAGE-* and the
// telegram source policy). Operator's own DM messages remain first_party
// — that's the half the review_question Q1 asks about.
function classifyConsent(channelKind, authorUserId, selfUserId) {
  const isSelf = typeof authorUserId === "string" && authorUserId === selfUserId;
  if (channelKind === "im") {
    return isSelf ? "first_party" : "third_party_inferred";
  }
  if (channelKind === "mpim" || channelKind === "private_channel") {
    return isSelf ? "first_party" : "third_party_inferred";
  }
  // public_channel and any unknown kind
  return isSelf ? "first_party" : "public_observation";
}

// buildRow: assemble the canonical source-row from a Slack message. Returns
// null if the message has no normalised text AND no subtype that the
// connector would emit (the Stage-0 module gets the final say on PASS/DROP;
// buildRow only refuses to construct rows that carry no structural payload).
function buildRow({ workspaceId, channelId, channelKind, selfUserId, msg }) {
  const ts = typeof msg.ts === "string" ? msg.ts : null;
  if (ts === null) return null;
  // F-T2-SLACK-F10: Slackbot system messages don't carry a `user` field
  // in every shape; some carry user="USLACKBOT" while reminders carry the
  // bot_id but no user. We still want the user_id present on the row when
  // it exists so Stage-0 rule 2 (USLACKBOT) fires. The connector itself
  // does NOT drop USLACKBOT here — Stage-0 is the canonical drop point so
  // the recordDrop telemetry counter sees the fire rate per the standard
  // observability discipline.
  const authorUserId = typeof msg.user === "string" ? msg.user : null;
  const subtype = typeof msg.subtype === "string" ? msg.subtype : null;
  // F-T2-SLACK-F4: when the event is a message_changed, msg.text is empty
  // and the new body lives at msg.message.text. We promote it into
  // raw_content.text so Stage-0 rule 8 (empty_message) does NOT fire
  // before rule 7's edit-diff check. We also stamp previous_text from
  // msg.previous_message.text so rule 7 can compute whether the edit
  // changed anything; without it the rule would always see "" and DROP
  // every edit.
  let text;
  let previousText = null;
  if (subtype === "message_changed") {
    const innerNew = msg.message && typeof msg.message.text === "string"
      ? msg.message.text
      : "";
    const innerPrev = msg.previous_message && typeof msg.previous_message.text === "string"
      ? msg.previous_message.text
      : "";
    text = innerNew !== "" ? innerNew : (typeof msg.text === "string" ? msg.text : "");
    previousText = innerPrev;
  } else {
    text = typeof msg.text === "string" ? msg.text : "";
  }
  // Convert the slack "ts" (seconds.microseconds) into an ISO-8601 timestamp
  // so downstream tooling that keys on `ts` does not need a Slack parser.
  const tsIso = slackTsToIso(ts);
  const consent = classifyConsent(channelKind, authorUserId, selfUserId);
  const sourceMsgId = `slack:${workspaceId}:${channelId}:${ts}`;
  // Detect bot-author rows: Slack messages emitted by bots carry either
  // bot_id (legacy app integrations) or app_id (modern apps) + bot_profile.
  const isBot = typeof msg.bot_id === "string" && msg.bot_id !== "";
  // file_share without text — Stage-0 will drop; we still construct so the
  // dispatch sees the raw structural fields.
  const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
  const rawContent = {
    workspace_id: workspaceId,
    channel_id: channelId,
    channel_kind: channelKind,
    ts,
    user: authorUserId,
    subtype,
    text,
    is_bot: isBot,
    has_files: hasFiles,
    consent_classification: consent,
  };
  // F-T2-SLACK-F4: stamp previous_text so Stage-0 rule 7 can do the
  // edit-diff check. Only present for subtype === "message_changed" — we
  // do not synthesise an empty previous_text for normal rows because that
  // would attach a misleading field.
  if (subtype === "message_changed" && previousText !== null) {
    rawContent.previous_text = previousText;
  }
  // Preserve Slack thread linkage for downstream cross-reference.
  if (typeof msg.thread_ts === "string" && msg.thread_ts !== "") {
    rawContent.thread_ts = msg.thread_ts;
  }
  // Parties: self vs. other; useful for downstream authorship gating.
  const parties = [];
  if (consent === "first_party" && authorUserId === selfUserId) {
    parties.push("self");
  } else if (typeof authorUserId === "string" && authorUserId !== "") {
    parties.push(authorUserId);
  }
  return {
    source_msg_id: sourceMsgId,
    ts: tsIso,
    parties,
    raw_content: rawContent,
    content: text,
  };
}

// slackTsToIso: convert "1730000000.123456" -> ISO-8601 string. Slack ts is
// seconds-since-epoch with microsecond precision after the dot. We preserve
// millisecond precision in the ISO string (Date does not natively support
// microseconds).
function slackTsToIso(ts) {
  if (typeof ts !== "string" || ts === "") return new Date().toISOString();
  const dot = ts.indexOf(".");
  const seconds = dot === -1 ? parseInt(ts, 10) : parseInt(ts.slice(0, dot), 10);
  if (!Number.isFinite(seconds)) return new Date().toISOString();
  const ms = dot === -1
    ? 0
    : Math.floor(parseInt(ts.slice(dot + 1).padEnd(6, "0").slice(0, 6), 10) / 1000);
  return new Date(seconds * 1000 + (Number.isFinite(ms) ? ms : 0)).toISOString();
}

// =============================================================================
// CLI / daemon entry points
// =============================================================================

export async function runOnce(opts = {}) {
  const c = new SlackConnector(opts);
  return c.pollOnce();
}

export async function runForever(opts = {}) {
  const intervalSec = Number.isInteger(opts.intervalSec) && opts.intervalSec > 0
    ? opts.intervalSec
    : parseIntFromEnv(process.env.SLACK_POLL_INTERVAL_SECONDS) || 600;
  const c = new SlackConnector(opts);
  for (;;) {
    try { await c.pollOnce(); }
    catch { /* tagError already invoked; loop continues */ }
    await sleep(intervalSec * 1000);
  }
}

export async function run(opts = {}) {
  if (opts && opts.once) return runOnce(opts);
  return runForever(opts);
}

export async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--check")) {
    const c = new SlackConnector();
    const h = c.reportHealth();
    process.stdout.write(JSON.stringify(h) + "\n");
    return 0;
  }
  if (args.includes("--once")) {
    const res = await runOnce();
    process.stdout.write(JSON.stringify(res) + "\n");
    return 0;
  }
  await runForever();
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      // KEY_LEAKAGE_ZERO: we never echo err.message verbatim because the
      // Slack API helper may have stamped a token-bearing error from a
      // misconfigured fetch. Restrict to the error name + code prefix.
      const safe = err && err.message ? err.message.split(":")[0] : "fatal";
      process.stderr.write(`slack-connector fatal: ${safe}\n`);
      process.exit(1);
    },
  );
}

// Test-only exports.
export const _internals = {
  buildRow,
  classifyChannelKind,
  classifyConsent,
  slackTsToIso,
  parseWorkspaceIds,
};
