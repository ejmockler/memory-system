// catchup-since-ms.test.mjs — WORKUNIT C2 gate. Two halves:
//
//   (a) since_ms SEMANTICS: a thread qualifies by its LAST-ACTIVITY (latest
//       inbound) ts. With fixture threads at T-10d and T-1d, since_ms = 2d must
//       return ONLY the T-1d thread, with stats.after_filter honestly counting
//       the drop, and persona:true unaffected for the RETURNED rows. Proven at
//       the CORE (buildCatchup over a fixture registry) AND end-to-end
//       (loadSourcesFromLedgers over a temp-root ledger with the C1 projection
//       ON and OFF — opts.projection seam and the CATCHUP_PROJECTION=0
//       kill-switch — then through the MCP handler via the loader seam).
//
//   (b) SOURCE-FAILURE SURFACING: a source whose ledger EXISTS but cannot be
//       read (chmod 000 -> EACCES; streamLedgerLines returns counts.readError,
//       it never throws) must be MARKED failed — via the additive
//       opts.onSourceStatus callback at the loader, and as
//       stats.sources_failed / stats.source_status in the handler response —
//       never a silent [] success. A loader-level throw in the handler must
//       likewise mark the REQUESTED sources failed instead of silently serving
//       empty. Sources that read cleanly are NOT marked failed.
//
// Hermetic: node:test + node:assert/strict, mkdtempSync temp roots, fixture
// registries with OPAQUE slugs (source keys are DATA — zero platform tokens),
// no network, no live DB, and the real ledgers are never opened.

// MUST stay the FIRST import (static imports hoist): pins TELEMETRY_BASE_DIR
// before any config.js-loading import below, so no run can ever write into the
// production telemetry sink (the n9 L3b lesson).
import "./_hermetic-telemetry.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCatchup,
  buildAdapterRegistry,
  loadSourcesFromLedgers,
  setDefaultSourceLoader,
  resetDefaultSourceLoader,
  TOOL,
} from "../../lib/messaging/catchup.js";

import {
  _awaitPendingProjectionPersists,
  _clearProjectionMemoryCacheForTests,
  _peekProjectionDiagnosticsForTests,
} from "../../lib/messaging/envelope-projection.js";

import { grepPlatformTokens } from "../../lib/messaging/n10-invariant-eval.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATCHUP_SRC = path.resolve(__dirname, "../../lib/messaging/catchup.js");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Pinned clock for the core/loader tests (deterministic since-window math).
const NOW = Date.parse("2026-07-01T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Fixture corpus. OPAQUE source slugs (DATA, not platform names); already
// L1-shaped Envelope rows so identity-mapper fixture adapters pass them
// through untouched (the n9/n11d T9 pattern). Numeric `ts` doubles as the raw
// ledger row ts (rawRowTsMs accepts a finite number).
// ---------------------------------------------------------------------------
function envRow({ slug, threadId, senderId, senderName, ts, content, smid }) {
  return {
    platform: slug,
    thread_id: threadId,
    thread_type: "dm",
    sender: { id: senderId, name: senderName },
    recipients: ["user"],
    is_from_me: false,
    ts,
    content,
    mentions: [],
    directed_at_me_signals: { mention_me: false, reply_to_me: false, addressed_to_me: false },
    capabilities: {
      reply_to_available: true,
      structured_mentions: true,
      self_identity_reliable: true,
      addressing_first_class: false,
    },
    source_msg_id: smid,
  };
}

function fixtureRegistry(slugs) {
  return buildAdapterRegistry(
    slugs.map((p) => ({ PLATFORM: p, _toEnvelope: (r) => r })),
  );
}

// Two DM threads on one source: Stale Sal (last activity T-10d) and Fresh Fran
// (last activity T-1d). Both are substantive, directed, they-spoke-last — both
// surface with NO window; since_ms = 2d must keep ONLY Fresh Fran.
function twoThreadRows(slug, now) {
  return [
    envRow({
      slug,
      threadId: "dm_stale",
      senderId: "+15550000010",
      senderName: "Stale Sal",
      ts: now - 10 * DAY,
      content: "did you ever decide on the venue? can you reply?",
      smid: `${slug}:sal:1`,
    }),
    envRow({
      slug,
      threadId: "dm_fresh",
      senderId: "+15550000020",
      senderName: "Fresh Fran",
      ts: now - 1 * DAY,
      content: "can you review the doc and send notes when you get a chance?",
      smid: `${slug}:fran:1`,
    }),
  ];
}

function makeRoot(tag) {
  const root = mkdtempSync(path.join(tmpdir(), `c2-since-${tag}-`));
  mkdirSync(path.join(root, "storage", "sources"), { recursive: true });
  return root;
}

function writeLedger(root, slug, rows) {
  const p = path.join(root, "storage", "sources", `${slug}.jsonl`);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

function personNames(rows) {
  return rows.map((r) => r.person_name).sort();
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// ===========================================================================
// (a) since_ms — CORE path (buildCatchup over a fixture registry).
// ===========================================================================

test("A1: core — no window returns BOTH threads; since_ms=2d returns ONLY the T-1d thread with honest after_filter", async () => {
  const slug = "src_dm";
  const REG = fixtureRegistry([slug]);
  const sources = { [slug]: twoThreadRows(slug, NOW) };

  const base = await buildCatchup({ sources, now: NOW, registry: REG });
  assert.deepEqual(
    personNames(base.rows),
    ["Fresh Fran", "Stale Sal"],
    "baseline (no since_ms) surfaces both threads",
  );
  assert.equal(base.stats.after_filter, 2, "baseline after_filter counts both");

  const windowed = await buildCatchup({
    sources,
    now: NOW,
    since_ms: 2 * DAY,
    registry: REG,
  });
  assert.deepEqual(
    personNames(windowed.rows),
    ["Fresh Fran"],
    "since_ms=2d returns ONLY the T-1d thread",
  );
  assert.equal(windowed.rows[0].thread_id, "dm_fresh", "the returned thread is dm_fresh");
  assert.equal(
    windowed.stats.after_filter,
    1,
    "after_filter honestly reflects the since_ms drop (2 -> 1)",
  );
  assert.equal(windowed.stats.threads_considered, 2, "both threads were considered");
});

test("A2: core — persona:true is unaffected for RETURNED rows under a since_ms window", async () => {
  const slug = "src_dm";
  const REG = fixtureRegistry([slug]);
  const sources = { [slug]: twoThreadRows(slug, NOW) };

  const base = await buildCatchup({ sources, now: NOW, registry: REG, persona: true });
  const fran = base.rows.find((r) => r.person_name === "Fresh Fran");
  assert.ok(fran, "Fresh Fran surfaces at baseline");
  assert.ok(
    fran.persona !== null && typeof fran.persona === "object",
    "persona:true attaches a persona to the returned row",
  );

  const windowed = await buildCatchup({
    sources,
    now: NOW,
    since_ms: 2 * DAY,
    registry: REG,
    persona: true,
  });
  assert.equal(windowed.rows.length, 1, "windowed run returns only the fresh thread");
  assert.deepEqual(
    windowed.rows[0].persona,
    fran.persona,
    "the returned row's persona is unchanged by the since_ms window",
  );
});

// ===========================================================================
// (a) since_ms — END-TO-END over a temp-root ledger, projection ON and OFF.
// ===========================================================================

test("A3: end-to-end — loadSourcesFromLedgers + buildCatchup honor since_ms with the projection ON, OFF (opts seam), and killed (CATCHUP_PROJECTION=0)", async () => {
  const slug = "src_led";
  const REG = fixtureRegistry([slug]);
  const root = makeRoot("a3");
  _clearProjectionMemoryCacheForTests();
  try {
    writeLedger(root, slug, twoThreadRows(slug, NOW));

    // Seed the projection: first (unwindowed) call full-streams and schedules
    // the post-serve rebuild; await it so the next call CAN serve from the
    // projection (non-vacuity below).
    const seeded = loadSourcesFromLedgers(REG, { root, now: NOW });
    assert.equal(seeded[slug].length, 2, "seed read served both rows");
    await _awaitPendingProjectionPersists();

    // Projection ON (the live default path).
    const on = loadSourcesFromLedgers(REG, { root, now: NOW, since_ms: 2 * DAY });
    assert.equal(
      _peekProjectionDiagnosticsForTests().serves[slug].mode,
      "projection",
      "non-vacuity: the windowed read actually served from the projection",
    );

    // Projection OFF via the opts seam.
    const off = loadSourcesFromLedgers(REG, {
      root,
      now: NOW,
      since_ms: 2 * DAY,
      projection: false,
    });

    // Projection killed via the ops env switch.
    let killed;
    const prev = process.env.CATCHUP_PROJECTION;
    process.env.CATCHUP_PROJECTION = "0";
    try {
      killed = loadSourcesFromLedgers(REG, { root, now: NOW, since_ms: 2 * DAY });
    } finally {
      if (prev === undefined) delete process.env.CATCHUP_PROJECTION;
      else process.env.CATCHUP_PROJECTION = prev;
    }

    assert.equal(
      JSON.stringify(on[slug]),
      JSON.stringify(off[slug]),
      "projection ON rows byte-identical to projection OFF",
    );
    assert.equal(
      JSON.stringify(killed[slug]),
      JSON.stringify(off[slug]),
      "CATCHUP_PROJECTION=0 rows byte-identical to the opts seam",
    );

    // Each path pruned the stale row pre-corpus (the bounded-read optimization).
    assert.equal(off[slug].length, 1, "the windowed ledger read keeps only the fresh row");
    assert.equal(off[slug][0].thread_id, "dm_fresh", "…and it is the T-1d row");

    // Through the full build (the handler wiring: window at the loader AND at
    // query time): ONLY the fresh thread, honest after_filter.
    for (const [label, sources] of [["on", on], ["off", off], ["killed", killed]]) {
      const res = await buildCatchup({
        sources,
        now: NOW,
        since_ms: 2 * DAY,
        registry: REG,
      });
      assert.deepEqual(
        personNames(res.rows),
        ["Fresh Fran"],
        `projection=${label}: only the T-1d thread is returned`,
      );
      assert.equal(res.stats.after_filter, 1, `projection=${label}: after_filter honest`);
    }

    // And with NO window over the same ledger, the stale thread still returns
    // (the window, not the reader, is what dropped it).
    const unwindowed = await buildCatchup({
      sources: loadSourcesFromLedgers(REG, { root, now: NOW, projection: false }),
      now: NOW,
      registry: REG,
    });
    assert.deepEqual(
      personNames(unwindowed.rows),
      ["Fresh Fran", "Stale Sal"],
      "no window over the same ledger returns both threads",
    );
  } finally {
    await _awaitPendingProjectionPersists();
    rmSync(root, { recursive: true, force: true });
  }
});

// NOTE: the handler's buildCatchup runs over the PRODUCTION ADAPTER_REGISTRY
// (there is deliberately no registry seam on the tool), so fixture-slug sources
// cannot flow ROWS through the handler; handler-level since_ms row honoring
// over real adapters is already pinned by n11d T14. What C2 pins HERE is the
// handler->loader THREADING contract: the validated window reaches the bounded
// reader, the loader clock is the SAME clock the build stamps with, and (new)
// the per-source status sink is threaded so failures can reach the response.
test("A4: handler — threads the validated since_ms/limit/platforms window, a coherent clock, and the status sink into the source loader", async () => {
  const seen = [];
  try {
    setDefaultSourceLoader((parsed, ctx) => {
      seen.push({ parsed, ctx });
      return {};
    });
    const env = await TOOL.handler({ since_ms: 2 * DAY, limit: 7, persona: false });
    assert.equal(env.ok, true, "handler ok");
    assert.equal(seen.length, 1, "the loader ran once");
    const { parsed, ctx } = seen[0];
    assert.equal(parsed.since_ms, 2 * DAY, "validated since_ms reaches the loader");
    assert.equal(parsed.limit, 7, "validated limit reaches the loader");
    assert.ok(
      typeof ctx.now === "number" && Number.isFinite(ctx.now),
      "the loader receives the build clock",
    );
    assert.equal(
      env.data.generated_at_ms,
      ctx.now,
      "the since-window clock IS the clock the build stamped (coherent window)",
    );
    assert.equal(
      typeof ctx.onSourceStatus,
      "function",
      "the per-source status sink is threaded to the loader (failure surfacing seam)",
    );
  } finally {
    resetDefaultSourceLoader();
  }
});

// ===========================================================================
// (b) source-failure surfacing.
// ===========================================================================

test("B1: loader — an EACCES ledger (readError, no throw) is reported failed via onSourceStatus; a clean source is not; the return shape is unchanged", { skip: isRoot ? "chmod-based unreadability is not enforceable as root" : false }, async () => {
  const okSlug = "src_ok";
  const badSlug = "src_broken";
  const REG = fixtureRegistry([okSlug, badSlug]);
  const root = makeRoot("b1");
  _clearProjectionMemoryCacheForTests();
  const badPath = writeLedger(root, badSlug, twoThreadRows(badSlug, NOW));
  try {
    writeLedger(root, okSlug, twoThreadRows(okSlug, NOW));
    chmodSync(badPath, 0o000);

    const statuses = {};
    const sources = loadSourcesFromLedgers(REG, {
      root,
      now: NOW,
      onSourceStatus: (key, status) => {
        statuses[key] = status;
      },
    });

    // Return shape UNCHANGED (the n11d contract): { slug -> rawRow[] }.
    assert.deepEqual(sources[badSlug], [], "unreadable ledger still yields [] rows");
    assert.equal(sources[okSlug].length, 2, "the healthy source still serves its rows");

    // The failure is now VISIBLE.
    assert.ok(statuses[badSlug], "the failed source got a status callback");
    assert.equal(statuses[badSlug].failed, true, "the EACCES source is marked failed");
    assert.equal(statuses[badSlug].stage, "full-stream", "the failure stage is the full stream");
    assert.ok(
      typeof statuses[badSlug].error === "string" && statuses[badSlug].error.length > 0,
      "the readError message is carried",
    );
    assert.ok(statuses[okSlug], "the clean source also reports a status");
    assert.equal(statuses[okSlug].failed, false, "…and it is NOT marked failed");

    // A missing ledger (ENOENT) is an honest empty, NEVER a failure.
    const REG3 = fixtureRegistry(["src_absent"]);
    const statuses3 = {};
    const s3 = loadSourcesFromLedgers(REG3, {
      root,
      now: NOW,
      onSourceStatus: (key, status) => {
        statuses3[key] = status;
      },
    });
    assert.deepEqual(s3.src_absent, [], "missing ledger -> []");
    assert.ok(statuses3.src_absent, "missing ledger still reports a status");
    assert.equal(statuses3.src_absent.failed, false, "missing ledger is NOT a failure");

    // A THROWING observer never breaks the read (soft-guarded seam).
    const s4 = loadSourcesFromLedgers(REG, {
      root,
      now: NOW,
      onSourceStatus: () => {
        throw new Error("observer exploded");
      },
    });
    assert.equal(s4[okSlug].length, 2, "a throwing onSourceStatus does not break the loader");

    // Through the FULL build: the degraded sources map still serves the healthy
    // source's threads — one unreadable ledger never takes down the surface.
    const res = await buildCatchup({ sources, now: NOW, registry: REG });
    assert.deepEqual(
      personNames(res.rows),
      ["Fresh Fran", "Stale Sal"],
      "the healthy source's threads still surface over the degraded map",
    );
    assert.ok(
      res.rows.every((r) => r.platform === okSlug),
      "every surfaced row came from the healthy source",
    );
  } finally {
    try {
      chmodSync(badPath, 0o600);
    } catch {
      // already gone
    }
    await _awaitPendingProjectionPersists();
    rmSync(root, { recursive: true, force: true });
  }
});

test("B2: handler — a failed source is marked in stats.sources_failed / stats.source_status; clean sources are not; rows still serve", { skip: isRoot ? "chmod-based unreadability is not enforceable as root" : false }, async () => {
  const okSlug = "src_ok";
  const badSlug = "src_broken";
  const REG = fixtureRegistry([okSlug, badSlug]);
  const root = makeRoot("b2");
  const hnow = Date.now();
  _clearProjectionMemoryCacheForTests();
  const badPath = writeLedger(root, badSlug, twoThreadRows(badSlug, hnow));
  try {
    writeLedger(root, okSlug, twoThreadRows(okSlug, hnow));
    chmodSync(badPath, 0o000);

    setDefaultSourceLoader((parsed, ctx) =>
      loadSourcesFromLedgers(REG, {
        root,
        now: ctx && typeof ctx.now === "number" ? ctx.now : Date.now(),
        since_ms: parsed.since_ms,
        limit: parsed.limit,
        platforms: parsed.platforms,
        onSourceStatus: ctx ? ctx.onSourceStatus : undefined,
      }),
    );

    const env = await TOOL.handler({ persona: false });
    assert.equal(env.ok, true, "one failed source never aborts the surface");
    assert.deepEqual(
      env.data.stats.sources_failed,
      [badSlug],
      "stats.sources_failed carries EXACTLY the failed source key",
    );
    const status = env.data.stats.source_status;
    assert.ok(status && typeof status === "object", "stats.source_status is present");
    assert.equal(status[badSlug].failed, true, "per-source status marks the failure");
    assert.equal(status[badSlug].stage, "full-stream", "…with the failing stage");
    assert.ok(
      typeof status[badSlug].error === "string" && status[badSlug].error.length > 0,
      "…and the error message",
    );
    assert.equal(status[okSlug].failed, false, "the clean source is NOT marked failed");
    // (Row-level non-abort over a degraded map is pinned in B1 through the full
    // build; the handler's own registry is the production one, so fixture-slug
    // rows deliberately cannot surface here.)
    // Existing stats stay intact (additive fields only).
    for (const k of ["threads_considered", "after_filter", "after_dedup", "truncated", "platforms", "tiers"]) {
      assert.ok(k in env.data.stats, `existing stats key '${k}' still present`);
    }
  } finally {
    resetDefaultSourceLoader();
    try {
      chmodSync(badPath, 0o600);
    } catch {
      // already gone
    }
    await _awaitPendingProjectionPersists();
    rmSync(root, { recursive: true, force: true });
  }
});

test("B3: handler — a loader-level THROW marks the REQUESTED sources failed instead of silently serving empty", async () => {
  try {
    setDefaultSourceLoader(() => {
      throw new Error("loader exploded");
    });
    const env = await TOOL.handler({ platforms: ["src_zeta"], persona: false });
    assert.equal(env.ok, true, "the surface still answers");
    assert.deepEqual(env.data.rows, [], "no rows can be served");
    assert.deepEqual(
      env.data.stats.sources_failed,
      ["src_zeta"],
      "the requested source is marked failed — not a silent empty success",
    );
    assert.equal(env.data.stats.source_status.src_zeta.failed, true, "per-source status set");
    assert.ok(
      typeof env.data.stats.source_status.src_zeta.error === "string" &&
        env.data.stats.source_status.src_zeta.error.includes("loader exploded"),
      "the loader error is carried",
    );

    // With NO platforms filter, ALL registry sources were requested — every
    // registry key (read as DATA, never a literal) must be marked failed.
    const { ADAPTER_REGISTRY } = await import("../../lib/messaging/catchup.js");
    const allKeys = [...ADAPTER_REGISTRY.keys()].sort();
    const env2 = await TOOL.handler({ persona: false });
    assert.deepEqual(
      env2.data.stats.sources_failed,
      allKeys,
      "an unfiltered loader throw marks EVERY registry source failed (sorted)",
    );
  } finally {
    resetDefaultSourceLoader();
  }
});

test("B4: handler — a clean run reports NO failed sources (sources_failed is [])", async () => {
  const slug = "src_clean";
  const REG = fixtureRegistry([slug]);
  const root = makeRoot("b4");
  const hnow = Date.now();
  _clearProjectionMemoryCacheForTests();
  try {
    writeLedger(root, slug, twoThreadRows(slug, hnow));
    setDefaultSourceLoader((parsed, ctx) =>
      loadSourcesFromLedgers(REG, {
        root,
        now: ctx && typeof ctx.now === "number" ? ctx.now : Date.now(),
        since_ms: parsed.since_ms,
        limit: parsed.limit,
        platforms: parsed.platforms,
        onSourceStatus: ctx ? ctx.onSourceStatus : undefined,
      }),
    );
    const env = await TOOL.handler({ persona: false });
    assert.equal(env.ok, true, "ok");
    assert.deepEqual(env.data.stats.sources_failed, [], "no failures on a clean run");
    assert.equal(
      env.data.stats.source_status[slug].failed,
      false,
      "the clean source's status is failed:false",
    );
  } finally {
    resetDefaultSourceLoader();
    await _awaitPendingProjectionPersists();
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// Invariant — catchup.js stays platform-token-free after C2.
// ===========================================================================

test("C1: catchup.js carries ZERO platform tokens after C2", () => {
  const { count, matches } = grepPlatformTokens([CATCHUP_SRC]);
  assert.equal(count, 0, `catchup.js must stay token-free; offending: ${JSON.stringify(matches)}`);
});
