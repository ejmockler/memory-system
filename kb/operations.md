# Operations

Concrete semantics for recall and forgetting.

## recall(surrounding_context) → brief

### Inputs

```
surrounding_context: {
  recent_turns: [],            # last N conversation turns
  agent_role,                  # e.g., "assistant", "writer", "scheduler"
  current_query,               # the immediate utterance
  time,                        # ISO timestamp
  ambient: {
    calendar_state,
    inferred_mood,             # heuristic from word choice
    parties_present            # if multi-user
  },
  recent_recall_ids: []        # for damping
}
```

### Output

```
brief: {
  memories: [
    {
      id,
      content,
      provenance: { source, ts, parties, confidence },
      freshness: "fresh" | "stale",  # "potentially_outdated" reserved, never emitted
      derivation_chain: [id, ...]    # if derived
    }
  ],
  density_flag: null | "crowded" | "sparse",
  bounded_by: { max_chars, max_items },
  candidate_set_size,                # post-gate count
  candidate_pool_size,               # pre-hard-gate fused pool; >= candidate_set_size
  recall_id                          # used to log the recall event
}
```

`freshness` is the age of `provenance.ts` measured against the caller's `surrounding_context.time`, thresholded at `CAPS.RECALL_FRESHNESS_STALE_AFTER_MS` (30 days, `mcp/lib/validation.js`). It is produced by `freshnessLabel` in `mcp/lib/recall/multi-feature-score.js` and consumed at exactly one site — the `memories[]` projection in `mcp/lib/tools/recall.js`. `age <= threshold` is `"fresh"` (boundary inclusive), otherwise `"stale"`; an absent, empty, or unparseable timestamp or clock yields `"stale"`, never `"fresh"`. No ambient clock is read: `Date.now()` and `serverTs()` are not on this path, so the label is a total function of (`ts`, `time`).

`"potentially_outdated"` is **reserved and never emitted**. The only honest producer of "outdated" is supersession / derivation state, which is not built; age cannot distinguish *old* from *outdated*. See `mcp-surface.md` § `memory_recall` for the full statement, and its § *Deferred: temporal scoping of the candidate set* for the measurement (`anchored_rate` = 7/272) behind that deferral.

### Scoring

```
score(memory, context) =
    w1 * cos(memory.embedding, context.embedding)
  + w2 * entity_overlap(memory.entities, context.entities)
  + w3 * time_proximity(memory.time_anchors, context.time)
  - w4 * recent_surfacing_penalty(memory.id, context.recent_recall_ids)
  - w5 * unengaged_recency_penalty(memory.recall_trace)
```

Before ranking, policy predicates filter the candidate set: any memory matching an active `exclude` predicate is dropped.

### Density flag

If the top-K score gap is narrow, recall sets `density_flag: "crowded"` (or `"sparse"` when few candidates clear the floor); memories are still returned, and the flag invites a narrower follow-up. See kb/mcp-surface.md for the full output shape.

This is the operational form of "index discrimination erodes" — as neighborhood density grows, the system becomes visibly less specific rather than confidently wrong.

## Forgetting operations

Implemented today: `exclude` (as `memory_exclude`; the global form needs a user-issued token that cannot be minted yet) and its inverse `memory_rescind_policy`. `replace`, `substitute` and `excise` below are designs, not registered tools; see `mcp-surface.md` § Planned, not implemented.

### exclude(recall_id, predicate)

The agent passes a server-issued `recall_id` (from a prior `memory_recall` within `RECALL_LOG_TTL_SECONDS`) plus the predicate body. The server snapshots `context_embedding` and `embedding_model_version` directly from the logged recall event — the agent never supplies a vector. This is the discipline that makes "the agent does not invent context_embedding" mechanical rather than aspirational: there is no field for a hand-crafted vector.

```
input: {
  recall_id,                # server resolves embedding + model_version from this
  predicate: {
    context_entities: [],   # agent-derived from the recall
    similarity_threshold,
    scope: "global" | {     # "global" requires a confirmation token; see mcp-surface.md
      agent_role,
      parties,
      time_range
    }
  }
}
```

Stored predicate (after server snapshot):

```
predicate: {
  context_embedding,            # snapshotted from recall_id's logged event
  embedding_model_version,      # tag from same event; supports drift detection
  context_entities: [],         # echoed from input
  similarity_threshold,
  scope
}
```

Recall-time check: skip memory if context matches captured features within threshold **or** shares any captured entity tag, within scope.

Covers what was tombstone, contextual suppression, and "stop bringing up X."

### replace(old_id, new_event, scope)

Append `new_event` as a fact. Link `old_id` as superseded. Recall-time: when both could surface and scope matches, projection picks `new_event`. Outside scope, `old_id` may still surface ("where did you live in 2019" can legitimately return the old address even after a replace recording the move).

### substitute(target, content_transform)

Append a reframe event linking `target`. Recall projects the transformed content under provenance "reframed at time T from original". The original stays in the ledger; current recall surfaces the reframed version.

Distinct from `replace` because replace wins the projection cleanly between two facts. Substitute rewrites the content of one fact under audit.

### excise(target, scope)

Privileged. Mutates the ledger:

- Tombstone `target` in the memory ledger
- Propagate through derivation graph — derivatives are marked epistemically orphaned (configurable: drop, retain, or re-derive without the excised parent)
- If `scope` includes source: also mutate the source ledger
- May or may not emit a policy event — the *silent excise* class refuses to log the excision itself

This is the only operation that violates append-only. It needs its own audit channel that is itself privileged. See `open-problems.md` for the silent-excise paradox.

## Damping

Per-surfacing decay:

- Each `recall` event records which memory ids were in the brief
- For each surfaced memory, decrement an in-context boost for K turns
- If the user **engages** with the memory (responds to it, builds on it, corrects it) within K turns, *reverse* the dampening and add a reinforcement boost

Net effect: passive surfacing fades fast. Active engagement sticks. Prevents positive-feedback dominance where a memory that happened to surface once colonizes the rest of the conversation.

## Discrimination

Operationalized as the top-K gap threshold in the recall function (see Density flag above). The conceptual claim — "the index erodes" — becomes a concrete behavior: when many memories crowd a neighborhood, the recall returns *no specific memory* with a flag, rather than a confidently-wrong pick.

## Activating the iMessage, Screen Time, git-log and GitHub connectors

`docs/CONNECTORS.md` is the maintained guide to every connector (how to render, enable, test and disable each one); this section keeps the detail for four of them: `imessage`, `screentime`, `git-log`, and `github-events`. Two require a macOS Full Disk Access (FDA) grant; two do not. Their launchd plists are rendered from the templates in `launchd/` (see `docs/CONNECTORS.md`) into `~/Library/LaunchAgents/com.user.memory-system.<source>-connector.plist` and are deliberately **not auto-loaded** — the user activates each one only after confirming the per-source preconditions below.

| Source           | TCC grant required               | Other auth                                     | Storage ledger                          |
|------------------|----------------------------------|------------------------------------------------|-----------------------------------------|
| `imessage`       | FDA on the shared `node` binary  | None                                           | `storage/sources/imessage.jsonl`        |
| `screentime`     | FDA on the shared `node` binary  | None                                           | `storage/sources/screentime.jsonl`      |
| `git-log`        | None                             | None — `git` on PATH                           | `storage/sources/git-log.jsonl`         |
| `github-events`  | None                             | `gh auth status` must report a logged-in user  | `storage/sources/github-events.jsonl`   |

### One-time FDA grant (per Mac, shared by iMessage + ScreenTime)

The iMessage connector reads `~/Library/Messages/chat.db` and the ScreenTime connector reads `~/Library/Application Support/Knowledge/knowledgeC.db`. Both paths are under FDA protection on Ventura+. Both daemons use the same `node` binary as their launchd `ProgramArguments` first element, so a SINGLE FDA toggle covers both — you do not see two prompts.

1. Locate the node binary the launchd plists invoke. Both `~/Library/LaunchAgents/com.user.memory-system.imessage-connector.plist` and `com.user.memory-system.screentime-connector.plist` reference the same absolute path: the node binary `scripts/render-launchd.mjs` wrote into them (by default the node that ran the script; `--node` overrides it). If you upgrade or move Node, that path changes and the grant must be reissued.
2. Open `System Settings → Privacy & Security → Full Disk Access`.
3. Click `+`, press `Cmd-Shift-G`, paste the node binary path, hit Return, select `node`, click Open.
4. Toggle the new `node` row ON. macOS will not prompt you again for FDA on this binary until the binary path changes or you toggle it off.

### Activating the connectors

After the FDA toggle (if applicable), load the launchd jobs in any order:

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.memory-system.imessage-connector.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.memory-system.screentime-connector.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.memory-system.git-log-connector.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.memory-system.github-events-connector.plist
```

Verify with `launchctl list | grep memory-system` — all four jobs should appear.

### Expected first-poll timeline

Each daemon writes `connectors/<source>/state.json` on its first successful poll, which is what `memory_connectors_list` reads.

| Source           | First state.json appears | First row in `storage/sources/<source>.jsonl` |
|------------------|--------------------------|------------------------------------------------|
| `imessage`       | ≤ 30 s after bootstrap   | ≤ 30 s if `chat.db` has any unread messages above the initial ROWID watermark; otherwise on next inbound message |
| `screentime`     | ≤ 60 s after bootstrap   | ≤ 60 s — `knowledgeC.db`'s `ZOBJECT` table is continuously appended-to by macOS |
| `git-log`        | ≤ 5 min after bootstrap  | ≤ 5 min — walks every configured repo root once per cycle |
| `github-events`  | ≤ 24 h after bootstrap   | ≤ 24 h — `gh api /users/<self>/events` is polled daily, not continuously |

After the expected window, `memory_connectors_list` returns `status="ok"` for each. If a connector's `last_appended_ts` is `null` past the window above, treat it as degraded and consult the troubleshooting matrix.

### Kill switch — revoking one connector

Two-step revoke. Both steps are required: the launchctl bootout stops new ingestion, the MCP `memory_connectors_revoke` call writes the policy marker that the recall layer's transitive-orphan BFS reads.

1. `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.user.memory-system.<source>-connector.plist`
2. Call the `memory_connectors_revoke` MCP tool with `{source: "<imessage|screentime|git-log|github-events>"}` (`source` is the only required argument; the schema rejects unknown keys such as `reason`). This appends a `kind:"policy"` `policy_kind:"connector_revoke"` row to `ledgers/memory.jsonl` with `target_source: <source>`. The recall layer treats every memory whose `source_refs[].source` matches as a transitive-orphan seed (see `kb/transitive-orphan-design.md`).

The `connectors/<source>/state.json` cursor is **preserved** across revoke — re-activating the connector later resumes from the last-known watermark rather than re-ingesting the historical tail. To deliberately drop the cursor, `rm connectors/<source>/state.json` AFTER step 1 and BEFORE the next bootstrap.

### Kill switch — revoking FDA entirely (both Apple-native sources)

Toggle the node binary OFF in `System Settings → Privacy & Security → Full Disk Access`. Both `imessage` and `screentime` daemons will start tagging `knowledgeC_missing` / `chat_db_missing` errors within 30s; `error_count` crosses `CAPS.CONNECTOR_ERROR_THRESHOLD` (5) and `reportHealth().status` flips to `degraded` and then `failed` if the daemon explicitly sets the status field. Re-enabling FDA resumes polling from the last-known cursor.

### Troubleshooting matrix

| Symptom                                                       | Likely cause                                        | Check                                                                                       | Fix                                                                                                 |
|---------------------------------------------------------------|-----------------------------------------------------|----------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `imessage` or `screentime` `status=degraded`, repeated errors | TCC grant missing or revoked                        | `sqlite3 ~/Library/Messages/chat.db ".tables"` from the same node binary — `unable to open` means FDA is off | Re-add the node binary in `System Settings → Privacy & Security → Full Disk Access`                |
| `imessage` `status=degraded`, error kind `sqlite_locked`      | `chat.db` WAL contention (Messages.app writing)     | `lsof ~/Library/Messages/chat.db-wal`                                                       | Transient — the daemon retries the next poll cycle. Persistent locks suggest a corrupt WAL: kill Messages.app, then `touch ~/Library/Messages/chat.db-shm` to force WAL checkpoint |
| `github-events` `status=degraded`, error kind `gh_auth_failed`| `gh` token expired or revoked                       | `gh auth status`                                                                            | `gh auth login` then `launchctl kickstart -k gui/$(id -u)/com.user.memory-system.github-events-connector` |
| `github-events` `status=degraded`, error kind `rate_limited`  | Polling more often than the 30-day API window allows| `gh api rate_limit`                                                                          | Back off — the daemon's default poll cadence is daily; reduce by editing the plist's `StartInterval` |
| `git-log` `status=degraded`, error kind `repo_not_found`      | A configured repo root was moved or deleted         | `cat connectors/git-log/state.json | jq .configured_roots`                                  | Edit the root list, then `launchctl kickstart -k gui/$(id -u)/com.user.memory-system.git-log-connector` |
| Any connector `status=stale`, zero errors                     | `last_cursor_advance_ts` older than `CAPS.CONNECTOR_HEALTH_STALE_SECONDS` (3600s) | `launchctl list | grep memory-system` — the daemon may have crashed without restart-on-fail | `launchctl kickstart -k gui/$(id -u)/com.user.memory-system.<source>-connector` |
| `memory_connectors_list` returns an empty array               | No connector has written `connectors/<source>/state.json` yet | `ls connectors/`                                                                            | Wait for the first-poll window above; if exceeded, check `launchctl list` and the daemon's stderr in `~/Library/Logs/com.user.memory-system.<source>-connector.log` |
| iMessage row stamped `decode_error: true` in `raw_content`    | `attributedBody` NSKeyedArchiver blob layout drift   | Inspect the row's `raw_content.attributedBody_b64` (when logged at debug level)             | File a bug — the salience layer still surfaces "user received a message we couldn't decode" without leaking content |

The single-source-of-truth for `error_count`, `error_rate`, and `last_error_kind` is `connectors/<source>/state.json`; the `memory_connectors_list` MCP tool projects the derived `{status, last_appended_ts, last_cursor_advance_ts}` view but deliberately does NOT leak the source-native cursor field or per-kind error counts.
