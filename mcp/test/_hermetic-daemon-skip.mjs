// _hermetic-daemon-skip.mjs — shared skip-when-daemon-active helper.
//
// CONTEXT: many synthesis/recall hermeticity tests snapshot production
// memory.jsonl + assert byte-identity pre/post test run. Pre-W5-CCS this was
// reliable because the watermark daemon was cursor-parked on every Gemini
// failure. Post-W5-CCS the daemon promotes embed-failed rows with
// features.embedding=null + features.embed_state=true, so the production
// ledger grows during test runs and trips the byte-identity assertion
// through no fault of the test code.
//
// This helper mirrors the r25-end-to-end-cascade.test.mjs skip pattern.
// Import + call at the very top of a test file (before any test() registration)
// to skip the entire file cleanly when the daemon is active.
//
// REG (memperf) — GATE DE-FLAKE: the skip's "0 passed, 0 failed" exit-0 is a
// VACUOUS PASS when it fires inside a gate run (seen live in wave 1: the
// daemon was active, three byte-identity suites "passed" without asserting
// anything). REQUIRE_HERMETIC=1 turns the daemon-active branch into a HARD
// FAILURE (exit 1) so a gate run can never pass vacuously — the gate runner
// sets it; local dev (unset) keeps the exact skip behavior below.
//
// ===========================================================================
// e10 — QUIESCE-AND-WAIT: measure the hazard, not the sampling luck.
// ===========================================================================
//
// THE PREDICATE THAT WAS WRONG. Until e10 the armed branch fired on ONE
// instantaneous sample: "is any tracked state file's mtime younger than 30s
// right now?" That is not a statement about the code under test. It is a
// statement about WHEN THE SUITE HAPPENED TO START relative to the watermark
// daemon's cadence (TICK_INTERVAL_MS = 15s, daemons/watermark.js:234). The
// same unchanged tree fails or passes depending on which second the runner
// reached the file — the gate encodes sampling luck and reports it as a code
// verdict. Two runs, no edit between them, opposite results: that is the
// definition of a flaky gate, and it trains operators to re-run rather than
// to read.
//
// WHAT THE SUITES ACTUALLY NEED. The hazard is not "the daemon exists". It is
// "the daemon WRITES while my byte-identity assertion is open". The direct
// measurement of that is: watch the state files and require that NOTHING
// CHANGES for a window W. A quiet window is evidence about the near future in
// a way that "the last write was 31 seconds ago" simply is not — the latter is
// equally true one second before the next tick.
//
// WHY W = 35s BY DEFAULT. Two full daemon ticks (2 x 15s) plus margin. One
// tick could be straddled by luck; two consecutive missed ticks means the
// daemon is genuinely idle rather than between beats. B = 120s is the patience
// budget: long enough to ride out a burst, short enough that a permanently
// busy daemon is reported as a failure in about the time an operator would
// wait anyway. Both are env-overridable (HERMETIC_QUIESCE_WINDOW_MS,
// HERMETIC_QUIESCE_BUDGET_MS) so BOTH branches are drivable deterministically
// from a test — a knob that only makes the wait longer would leave the
// budget-exhausted branch untestable.
//
// WHAT DID NOT CHANGE, DELIBERATELY:
//   * The hard failure is PRESERVED. Budget exhausted under REQUIRE_HERMETIC=1
//     is exit 1 with the SAME vacuous-pass wording. A vacuous pass is still
//     worse than a loud failure; this changes WHEN the failure fires, never
//     WHETHER it can.
//   * REQUIRE_HERMETIC=1 is never dropped, never inferred, never defaulted.
//   * The daemon is never stopped, signalled, or restarted. This helper only
//     ever calls statSync. Waiting is the whole intervention.
//   * The local-dev branch (REQUIRE_HERMETIC unset) keeps its instant skip.
//     Waiting two minutes to print "skipped" would be a pure tax: a skip is
//     not a verdict about the code, so buying a better one is not worth the
//     wall clock.
//   * The all-quiet fast path is instant. If no tracked file is fresh at the
//     first sample, the helper returns immediately, exactly as before — the
//     common case pays nothing.
//
// ===========================================================================
// e18 — WHICH FILES. The set is DERIVED, and it is TIERED. Read this before
// changing anything below: the previous three-file list was a hardcode that
// had drifted, and the drift was silent in both directions.
// ===========================================================================
//
// THE OLD SET WAS A HARDCODED LIE. Until e18 this file carried three literal
// paths — imessage.json, chat-claude-code.json, git-log.json — frozen at the
// moment the helper was written. Seven more cascade sources have shipped
// since (screentime, github-events, codex-cli, telegram, mail, whatsapp,
// slack). Every one of them can advance a cursor and move ledgers/memory.jsonl
// while a byte-identity assertion is open, and NONE of them was watched. That
// is not a theoretical gap: e16-R2 attributed a red byte-identity run to mail,
// a source this helper could not see.
//
// WHY CAPS AND NOT A DIRECTORY LISTING. The obvious fix — readdirSync the
// state directory — encodes what has RUN, not what is DECLARED. slack is in
// CAPS.WATERMARK_SOURCES but its cursor file does not exist on disk today
// (the slack-connector launchd job is unloaded). A directory listing would
// therefore omit slack, and the day the operator re-enables that connector
// the gate would silently stop covering it. CAPS.WATERMARK_SOURCES is the
// producer's own declaration — the exact list daemons/watermark.js:752
// iterates in listSourceLedgers — so deriving from it means a new source is
// covered by the CAPS edit that creates it, with no second edit here.
// sampleMtimes already treats missing -> present as a CHANGE, so a
// declared-but-absent source fires the instant its connector comes back.
// Trailing-"*" wildcard entries ("chat-claude-code-*") are filtered exactly
// as listSourceLedgers filters them: they are batch-pipeline patterns, not
// cursor names, and stat'ing a literal "chat-claude-code-*.json" would watch
// nothing forever.
//
// TWO TIERS, AND WHY. Watching all ten and GATING on all ten are different
// decisions, and collapsing them is what makes this gate unusable:
//
//   WATCHED (all 10) — chat-claude-code, imessage, screentime, git-log,
//   github-events, codex-cli, telegram, mail, whatsapp, slack. These are
//   sampled by armPostCheck at process exit. If any of them advanced during
//   the suite, the exit hook NAMES it. Watching is free and never blocks, so
//   there is no reason to watch less than everything.
//
//   GATING (7) — imessage, git-log, github-events, telegram, mail, whatsapp,
//   slack. These are the files the suite WAITS on. Three exclusions:
//
//     (a) CAPTURED-ONLY -> note tier. DERIVED, zero new constants: read
//         straight from CAPS.WATERMARK_CAPTURED_ONLY_SOURCES. tickSourcesOnce
//         `continue`s on these (daemons/watermark.js:2209-2215) BEFORE
//         readSourceCursor at :2227, so the cursor structurally CANNOT advance
//         from cascade and cannot move ledgers/memory.jsonl. screentime is the
//         sole member today and its cursor mtime is 65 days old — the
//         empirical confirmation of the structural argument. A file that
//         cannot move must not be able to block.
//
//     (b) ENDOGENOUS agent-runtime hook sources -> note tier. This is the ONE
//         new constant in this file (ENDOGENOUS_SOURCES) and it is argued
//         here rather than smuggled: chat-claude-code and codex-cli tail
//         ledgers written BY THE AGENT RUNTIME. The agent driving this gate is
//         the thing writing the files the gate waits on. Gating on them is the
//         harness waiting out its own operator — a livelock the pre-e18 source
//         already NAMED in its own failure message and then gated on anyway.
//         They stay fully WATCHED, so if they move during a suite the exit
//         hook still says so; they simply cannot hang the suite.
//
//     (c) Everything else GATES. mail is the e16-R2 culprit and it joins the
//         gate; whatsapp, telegram, github-events and slack join with it.
//         Admitting those four is the entire point of this node.
//
// THE HONEST COST, STATED PLAINLY. chat-claude-code moves GATE -> NOTE. That
// is a RELAXATION, and on the most-frequently-firing source in the set. A
// suite that would previously have waited (or failed loudly) because the agent
// was writing chat-claude-code.jsonl will now RUN. That is deliberate — see
// (b) — but it is a loosening and it is not hidden. In exchange the gate
// gained five sources that could previously corrupt a byte-identity assertion
// with no gate and no attribution at all. Net: 3 gating files -> 7, with one
// of the original three demoted.
//
// WHY NARROWING THE GATE DOES NOT REOPEN THE VACUOUS-PASS HOLE. The hole that
// REQUIRE_HERMETIC=1 exists to close is specific to the SKIP BRANCH: exit 0,
// the line "0 passed, 0 failed", nothing asserted, gate green. A narrowed gate
// never produces that. A narrowed gate makes the suite RUN and ASSERT. If the
// daemon then writes mid-suite, armPostCheck — which samples the FULL
// ten-file watched set — names the offending file at exit, and the
// byte-identity assertion goes red with attribution attached. The trade is an
// ATTRIBUTED RED against an UNATTRIBUTED exit(1) hang, which is strictly more
// informative. Narrowing the gate may make a suite RUN; it can never make one
// SKIP. That invariant is unchanged and is pinned by cases (b1)/(b2)/(e1) in
// mcp/test/run-all-tests-hermetic-arm.test.mjs.
//
// ---------------------------------------------------------------------------
// e18 MEASUREMENT — PAIRED, SAME-INSTANT (2026-08-26, this workspace).
//
// Method: three children launched at the same instant, identical
// windowMs=35000 / budgetMs=60000, each running the UNMODIFIED waitForQuiesce
// against a different file set. statSync only; nothing written under storage/,
// no daemon signalled. Two independent trials, ~6 minutes apart.
//
//   OLD_GATE = [imessage, chat-claude-code, git-log]        (the pre-e18 set)
//   NEW_GATE = [imessage, git-log, github-events, telegram, mail, whatsapp,
//               slack]                                       (the e18 set)
//   ALL_TEN  = every non-wildcard CAPS.WATERMARK_SOURCES entry (the control:
//              what a naive "just watch everything" patch would have shipped)
//
// TRIAL 1 — children launched within 11ms of each other. Raw, verbatim:
//
//   {"set":"OLD_GATE","started_at":1787692518843,"quiet":true,
//    "waited_ms":35120,"observations":35,"writes_observed":0,
//    "busy_fraction":0,"hottest":null,"per_file_writes":{},
//    "window_ms":35000,"budget_ms":60000}
//
//   {"set":"NEW_GATE","started_at":1787692518849,"quiet":true,
//    "waited_ms":35123,"observations":35,"writes_observed":0,
//    "busy_fraction":0,"hottest":null,"per_file_writes":{},
//    "window_ms":35000,"budget_ms":60000}
//
//   {"set":"ALL_TEN","started_at":1787692518838,"quiet":true,
//    "waited_ms":59229,"observations":59,"writes_observed":1,
//    "busy_fraction":0.0169,"hottest":"codex-cli.json",
//    "per_file_writes":{"codex-cli.json":1},
//    "window_ms":35000,"budget_ms":60000}
//
// TRIAL 2 — children launched on the same millisecond. Raw, verbatim:
//
//   {"set":"OLD_GATE","started_at":1787692891042,"quiet":true,
//    "waited_ms":35109,"observations":35,"writes_observed":0,
//    "busy_fraction":0,"hottest":null,"per_file_writes":{},
//    "window_ms":35000,"budget_ms":60000}
//
//   {"set":"NEW_GATE","started_at":1787692891042,"quiet":true,
//    "waited_ms":35128,"observations":35,"writes_observed":0,
//    "busy_fraction":0,"hottest":null,"per_file_writes":{},
//    "window_ms":35000,"budget_ms":60000}
//
//   {"set":"ALL_TEN","started_at":1787692891042,"quiet":true,
//    "waited_ms":35126,"observations":35,"writes_observed":0,
//    "busy_fraction":0,"hottest":null,"per_file_writes":{},
//    "window_ms":35000,"budget_ms":60000}
//
// READING IT. In both trials NEW_GATE quiesced on the FIRST possible window
// boundary with ZERO writes observed, within 3ms (trial 1) and 19ms (trial 2)
// of OLD_GATE at the same instant. Adding four sources to the gate cost
// nothing measurable, because those sources are quiet. In trial 1 the ALL_TEN
// control took 59229ms — 69% longer, burning almost the whole 60s budget —
// and its single observed write was codex-cli.json: exactly the endogenous
// agent-runtime source that tier (b) excludes. The control reproduces the
// failure mode the tiering is designed to avoid; the gate set does not.
//
// FALSIFIABILITY, AS STATED IN ADVANCE. The kill condition was: if NEW_GATE
// burned its budget while OLD_GATE quiesced at the same instant, the tiering
// is REFUTED and this node does not land as planned. It did not, in either
// trial.
//
// ---------------------------------------------------------------------------
// e18 BLAST RADIUS — every registered suite that imports this helper.
//
// KEY SIMPLIFICATION: under REQUIRE_HERMETIC=1 a suite's branch is decided
// ENTIRELY by this helper at import time, and that decision is
// SUITE-INDEPENDENT — it depends only on the gate set's mtimes at that
// instant, never on anything the suite does. So the flip table is computable
// from a stat sweep. Running 41 timed suites would not measure 41 suites; it
// would measure 41 different INSTANTS, which is the sampling-luck error e10
// already removed from the predicate. The table is therefore indexed by
// INSTANT CLASS, and the suite column is 41 identical rows.
//
// COUNT CORRECTION, OWNED: the plan for this node enumerated 38 importing
// suites. Cross-referencing grep-importers against run-all-tests.mjs SUITES
// finds 40 — all 40 registered, 0 unregistered. The two the plan's list
// omitted are cascade-verdict-shapes.test.mjs and cursor-stamp-class.test.mjs.
// This node then converges a 41st: integration/r25-end-to-end-cascade.test.mjs
// carried a PRIVATE two-file gate (one of whose entries,
// policy/distillation-state.json, has not existed since R32 retired the
// distiller) and now routes through this helper. The table covers all 41.
//
// SWEEP METHOD: all ten watched files stat'ed once per second, freshness
// judged against the same DAEMON_ACTIVE_THRESHOLD_MS = 30_000 the helper uses,
// spanning many full 15s daemon ticks so the table is not itself a
// sampling-luck artifact.
//
//   SWEEP 1 — 60 samples / 60s (4 ticks):
//     old-gate armed:  0 / 60      new-gate armed:  0 / 60
//     ages at first sample (s): chat-claude-code 67, imessage 19476,
//       screentime 5655691, git-log 1972, github-events 71837, codex-cli 26,
//       telegram 1058, mail 158, whatsapp 1043, slack (file absent)
//
//   SWEEP 2 — 240 samples / 240s (16 ticks). This is the load-bearing one:
//     old-gate armed: 30 / 240  (sole cause: chat-claude-code)
//     new-gate armed: 60 / 240  (sole cause: telegram)
//     cross-tab: neither 150 | old-only 30 | new-only 60 | both 0
//     per-source age range over the sweep (s):
//       chat-claude-code 0..314   codex-cli 0..243   telegram 0..1170
//       mail 241..481   whatsapp 1126..1366   git-log 2056..2296
//       imessage 19559..19799   github-events 71920..72160
//       screentime 5655774..5656014   slack (absent throughout)
//
// THREE INSTANT CLASSES, from the sweep-2 cross-tab:
//
//   CLASS Q (150/240 = 62.5%) — no gate member fresh under either set.
//   CLASS R (30/240 = 12.5%)  — chat-claude-code fresh, nothing else.
//   CLASS T (60/240 = 25.0%)  — telegram fresh, nothing else.
//   (both-armed: 0/240 observed.)
//
//   suite                                          | old-gate branch | new-gate branch | FLIP?
//   -----------------------------------------------+-----------------+-----------------+-------------------
//   ALL 41 SUITES, in class Q                      | fast-path       | fast-path       | no
//   ALL 41 SUITES, in class R                      | quiesce-wait    | fast-path       | YES (relaxation)
//   ALL 41 SUITES, in class T                      | fast-path       | quiesce-wait    | YES (tightening)
//
//   The 41 rows the "ALL 41 SUITES" lines stand for, named in full — every one
//   of them flips in class R and in class T, and none of them flips in class Q:
//
//     backfill-embeddings.test.mjs
//     cascade-verdict-shapes.test.mjs
//     codex-cli-connector.test.mjs
//     connector-base.test.mjs
//     connectors/whatsapp-sender-index.test.mjs
//     cursor-stamp-class.test.mjs
//     embed-callers-migrate.test.mjs
//     git-log-local-connector.test.mjs
//     github-events-connector.test.mjs
//     imessage-connector.test.mjs
//     integration-phase3-v0.test.mjs
//     integration-phase3-v1-rerank.test.mjs
//     integration/r25-end-to-end-cascade.test.mjs   (converged by this node)
//     mail-connector.test.mjs
//     promote-time-embedding.test.mjs
//     recall-log-persistence.test.mjs
//     recall-mask-drop.test.mjs
//     recall-mmr-active-geometry.test.mjs
//     recall/contextual-eval-goldset.test.mjs
//     recall/ledger-offset-index.test.mjs
//     recall/ledger-streaming-recall.test.mjs
//     run-all-tests-hermetic-arm.test.mjs
//     screentime-bigint-overflow.test.mjs
//     screentime-connector.test.mjs
//     synthesis/density-flag-feedback.test.mjs
//     synthesis/engagement-detector.test.mjs
//     synthesis/engagement-loop-end-to-end.test.mjs
//     synthesis/feature-backfill-recall-wiring.test.mjs
//     synthesis/project-aggregator.test.mjs
//     synthesis/recall-content-dedup.test.mjs
//     synthesis/recall-empirical-regression.test.mjs
//     synthesis/recall-integration.test.mjs
//     synthesis/recall-local-4096-query.test.mjs
//     synthesis/recall-log-write-engagement.test.mjs
//     synthesis/substrate-aware-fallback.test.mjs
//     synthesis/thread-aggregator.test.mjs
//     synthesis/time-index-recall-fallback.test.mjs
//     tools/recall-caps-snapshot.test.mjs
//     tools/recall-integration.test.mjs
//     verify-cascade-seed-row-marker.test.mjs
//     whatsapp-connector.test.mjs
//
//   Two non-suite consumers take the same branches and are covered by the same
//   argument: mcp/scripts/run-contextual-eval.mjs and
//   mcp/scripts/rerank-hermeticity-probe.mjs.
//
//   FLIP COUNT: 41 of 41 suites flip, at 90 of 240 sampled instants (37.5% of
//   the sweep) — 30 instants of RELAXATION (class R) and 60 of TIGHTENING
//   (class T). 0 of 41 flip at the other 150 instants (class Q). Both trials
//   of the paired A/B above happened to land in class Q, which is why they
//   show no wall-clock difference: agreement in class Q is exactly what makes
//   the change cheap, and class R / class T are exactly what makes it worth
//   making.
//
// WHAT THE FLIPS MEAN, IN ORDER OF IMPORTANCE.
//   CLASS T is the reason this node exists. telegram was fresh at 60 of 240
//   instants and the old gate could not see it: a suite starting there sailed
//   through the gate with a cascade source actively advancing, and any
//   byte-identity failure that followed was unattributable. Under the new set
//   the suite waits. mail — the e16-R2 culprit — is in the same tier and gets
//   the same coverage; it simply did not happen to be hot during this sweep
//   (age 241..481s throughout).
//   CLASS R is the price, and it is a RELAXATION on the most-frequently-firing
//   source. chat-claude-code was fresh at 30 of 240 instants; under the old
//   gate those suites waited, and under a busy agent could exhaust the budget
//   and exit 1 — a failure caused by the agent running the gate, not by the
//   code. Under the new set they run. See tier (b): that is intended, and the
//   file stays fully WATCHED so armPostCheck still names it if it moves.
// ---------------------------------------------------------------------------
//
// THE RESIDUAL, STATED PLAINLY. Quiesce-and-wait converges only if a quiet
// gap EXISTS. Pre-e18 the chat-claude-code source advanced on operator agent
// activity, so an agent running the very gate that needs the daemon quiet was
// feeding the daemon that failed the gate. Tier (b) breaks that specific loop
// by demoting the endogenous sources out of the gate — but it does not make
// the underlying problem go away, it relocates it: those suites still assert
// byte-identity against the production ledger, and the agent can still move
// that ledger. What changes is that the failure is now an attributed red at
// the assertion with armPostCheck naming the file, instead of an
// unattributable hang. The real fix is still for the suites to stop asserting
// byte-identity against production paths.
//
// FIRST LIVE DEMONSTRATION (gate run, 2026-08-26). The first full
// run-all-tests.mjs pass after this change landed came back 293/296 with three
// byte-identity suites red: git-log-local-connector, integration/
// r25-end-to-end-cascade, synthesis/engagement-detector. All three carried the
// new attribution line, and all three named the SAME file:
//
//   HERMETIC_POST_CHECK: watermark daemon WROTE DURING this suite
//   (git-log-local-connector) — 1 state file(s) advanced:
//   .../codex-cli.json
//
// Read that carefully, because it is the whole argument for this design in one
// line. codex-cli is in NEITHER gate set — not the pre-e18 three-file list, not
// the e18 seven. So no gate set under discussion could have prevented this red;
// the daemon was bulk-cascading a 146k-row codex-cli ledger into
// ledgers/memory.jsonl and any byte-identity assertion open at that moment was
// going to fail. What e18 changed is that the red now says WHY, and names the
// file, instead of arriving as three unexplained diffs against production.
//
// PAIRED FULL-GATE A/B, WHICH SETTLES IT. Four consecutive full
// run-all-tests.mjs runs on the same busy daemon, same workspace, same hour —
// three on this tree, one on HEAD with every e18 change stashed:
//
//   run            | result  | failing suites             | POST_CHECK lines
//   ---------------+---------+----------------------------+------------------
//   e18 pass 1     | 293/296 | git-log-local-connector,   | 6 — all three
//                  |         | integration/r25-end-to-    |     named
//                  |         | end-cascade, synthesis/    |     codex-cli.json
//                  |         | engagement-detector        |
//   e18 pass 2     | 294/296 | memory-jsonl-durability,   | 4 — named
//                  |         | synthesis/feature-         |     codex-cli.json
//                  |         | backfill-recall-wiring     |
//   HEAD (stashed) | 295/296 | mail-connector             | 0
//   e18 pass 3     | 294/296 | promote-time-embedding,    | 2 — mail-connector
//                  |         | mail-connector             |     named
//                  |         |                            |     git-log.json
//
// FIRST: the failing SET differs on every run and never repeats. These are not
// deterministic failures of any suite; they are whichever byte-identity
// assertion happened to be open when the daemon appended. Measured directly at
// the time: production ledgers/memory.jsonl grew 21538 bytes over 120 seconds,
// in steps that landed exactly when codex-cli.json advanced.
//
// SECOND: HEAD fails the same way. The pre-e18 tree is not green on this
// workspace either, so this change did not break the gate. Two corroborations:
// pass 2's memory-jsonl-durability does not import this helper at all, and
// mail-connector went red under HEAD and under e18 alike.
//
// THIRD, and the deliverable: HEAD's red carries ZERO attribution across the
// whole run, because the pre-e18 three-file list contains neither codex-cli nor
// git-log-during-suite — the operator gets an unexplained diff against
// production and no way to separate daemon interference from a real regression.
// Under e18 every byte-identity red named its file.
//
// COST, from the same three e18 passes: two quiesce waits that succeeded
// (recall-mask-drop 35139ms, whatsapp-connector 35148ms), ZERO skips, and ONE
// budget exhaustion — the tightening's own failure mode, quoted next.
//
// THE TIGHTENING'S OWN FAILURE MODE, ALSO OBSERVED LIVE (gate pass 3, same
// hour). A busy gate tier does what it is supposed to do: it stops the suite
// rather than letting it assert against a moving ledger. Verbatim:
//
//   FAIL: watermark daemon active (state file .../telegram.json mtime 4s ago)
//   and REQUIRE_HERMETIC=1 — the daemon-active skip would be a vacuous pass.
//         promote-time-embedding requires daemon quiesce to assert hermeticity
//         on production paths; quiesce the daemon (or unset REQUIRE_HERMETIC
//         for local dev).
//         QUIESCE FAILED: no 35000ms quiet window in 120005ms of a 120000ms
//         budget.
//         hottest source: .../telegram.json | writes observed: 4 of 120
//         sample(s) | busy fraction: 0.033
//         GATE tier (7 file(s)) — these are what blocked:
//           2 write(s): .../telegram.json
//           2 write(s): .../git-log.json
//         NOTE tier (3 file(s), watched but NEVER gating) — 1 write(s)
//         observed, hottest .../codex-cli.json
//           1 write(s): .../codex-cli.json  [note tier — did not block]
//
// That block is the whole e18 diagnostic working at once, and it is worth
// reading line by line. The gate names WHICH source blocked (telegram, newly
// admitted, the e16-R2 class of source the old list could not see). It
// separates that from the note tier, so the operator is not left wondering why
// codex-cli's write did not count. And note the second gate-tier entry:
// git-log wrote twice too, and git-log was in the PRE-e18 list — so this
// particular exhaustion is not purely a cost of the new sources; the old gate
// would have blocked here as well, just without naming telegram.
//
// THE COST, THEREFORE, STATED WITHOUT SPIN: on a busy daemon the wider gate
// can convert a suite that used to run-and-maybe-pass into a loud exit 1 after
// a 120s wait. That is the intended direction — a suite asserting byte-identity
// against a moving production ledger has no business passing — but it is a
// real cost and it is paid in wall clock. Across three e18 gate passes it was
// paid once.
//
// It is also the honest limit of tier (b). Demoting codex-cli out of the gate
// means a suite will RUN while codex-cli cascades, and a byte-identity suite
// that runs then goes red. The alternative measured in trial 1 above is worse,
// not better: gating on codex-cli burned 59229ms of a 60000ms budget, which
// under REQUIRE_HERMETIC=1 is exit 1 with no attribution at all. An attributed
// red beats an unattributed hang. Neither is a suite that can be trusted while
// it asserts byte-identity against a live production ledger — which remains the
// actual defect, and is not one this file can fix.

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CAPS } from "../lib/validation.js";

// The PRODUCTION state directory, anchored to this checkout (derived from this
// file's own location, never from the environment) and the ONLY path
// derivation in this file. This helper watches the LIVE tree: 41 suites import it
// at module top, most of them BEFORE they set STORAGE_BASE_DIR to a hermetic
// mkdtemp root, and a helper that followed STORAGE_BASE_DIR would end up
// stat'ing an empty temp directory and reporting "quiet" unconditionally —
// a gate that always passes. For the same reason nothing here may import
// mcp/lib/config.js (which freezes STORAGE_BASE_DIR/POLICY_DIR at its own
// import time). CAPS comes from mcp/lib/validation.js, whose only imports are
// node:crypto, ./error-codes.js and canonicalize — no config, no side effects.
const DAEMON_STATE_DIR = fileURLToPath(new URL("../../storage/watermark-state", import.meta.url));

// The one new constant this node introduces; argued in tier (b) above.
// Agent-runtime hook sources: the agent driving the gate writes the ledgers
// these cursors tail, so gating on them is a livelock. Watched, never gating.
export const ENDOGENOUS_SOURCES = Object.freeze(["chat-claude-code", "codex-cli"]);

/**
 * deriveStateFiles — pure. Turns a declared source list into the two tiers.
 *
 * Pure (no CAPS read inside, no module state) so the pin test can drive it
 * over synthetic source lists without mutating frozen CAPS.
 *
 * @param {string[]} sources        e.g. CAPS.WATERMARK_SOURCES
 * @param {string[]} capturedOnly   e.g. CAPS.WATERMARK_CAPTURED_ONLY_SOURCES
 * @param {string[]} endogenous     e.g. ENDOGENOUS_SOURCES
 * @returns {{watched: string[], gating: string[]}} absolute cursor paths
 */
export function deriveStateFiles(sources, capturedOnly, endogenous) {
  const noteOnly = new Set([
    ...(Array.isArray(capturedOnly) ? capturedOnly : []),
    ...(Array.isArray(endogenous) ? endogenous : []),
  ]);
  const watched = [];
  const gating = [];
  const seen = new Set();
  for (const entry of Array.isArray(sources) ? sources : []) {
    if (typeof entry !== "string" || entry === "") continue;
    // Wildcard entries are batch-pipeline patterns, not cursor names —
    // dropped exactly as listSourceLedgers drops them (watermark.js:752).
    if (entry.endsWith("*")) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    const path = `${DAEMON_STATE_DIR}/${entry}.json`;
    watched.push(path);
    if (!noteOnly.has(entry)) gating.push(path);
  }
  return { watched, gating };
}

const _tiers = deriveStateFiles(
  CAPS.WATERMARK_SOURCES,
  CAPS.WATERMARK_CAPTURED_ONLY_SOURCES,
  ENDOGENOUS_SOURCES,
);

/** Every declared cursor. armPostCheck attribution samples these. */
export const WATCHED_STATE_FILES = Object.freeze(_tiers.watched);
/** The subset a suite actually WAITS on. See the tier argument above. */
export const GATING_STATE_FILES = Object.freeze(_tiers.gating);
/** Watched-but-not-gating: reported in the budget-exhausted diagnostic. */
export const NOTE_STATE_FILES = Object.freeze(
  WATCHED_STATE_FILES.filter((p) => !GATING_STATE_FILES.includes(p)),
);

const DAEMON_ACTIVE_THRESHOLD_MS = 30_000;

// 2 x TICK_INTERVAL_MS (daemons/watermark.js:234) + margin.
export const DEFAULT_QUIESCE_WINDOW_MS = 35_000;
export const DEFAULT_QUIESCE_BUDGET_MS = 120_000;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Synchronous sleep. skipIfDaemonActive is called at module top level, BEFORE
// any test() registration, so it cannot await — an async wait would let the
// suite body register and run underneath the wait, which is precisely the race
// being avoided. Atomics.wait on a private SharedArrayBuffer parks the thread
// without spinning the CPU and without touching the event loop.
function sleepSync(ms) {
  if (!(ms > 0)) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

// Sample the tracked mtimes. A missing file is `null`, and null-to-number is a
// CHANGE: a state file appearing mid-wait is a daemon write like any other.
// (This is what makes a DECLARED-but-absent source such as slack safe to carry
// in the derived set: the day its connector is re-enabled, the file's
// appearance registers as motion rather than as silence.)
function sampleMtimes(stateFiles) {
  const out = new Map();
  for (const p of stateFiles) {
    try {
      out.set(p, statSync(p).mtimeMs);
    } catch {
      out.set(p, null);
    }
  }
  return out;
}

function diffSamples(prev, next) {
  const changed = [];
  for (const [p, v] of next) {
    if (prev.get(p) !== v) changed.push(p);
  }
  return changed;
}

function freshFile(stateFiles, thresholdMs) {
  for (const p of stateFiles) {
    try {
      const ageMs = Date.now() - statSync(p).mtimeMs;
      if (ageMs < thresholdMs) return { path: p, ageMs };
    } catch {
      // file missing → not a signal
    }
  }
  return null;
}

/**
 * waitForQuiesce — poll until no GATING mtime changes for `windowMs`, or the
 * budget runs out.
 *
 * Exported so a registered suite can drive both outcomes without a production
 * path, and so the numbers it reports are inspectable rather than only
 * printable.
 *
 * `noteFiles` (e18) are sampled on the same poll cadence but NEVER restart the
 * quiet window. Their motion is counted purely so the budget-exhausted
 * diagnostic can say "gate quiet on 7, but codex-cli moved 14x" instead of
 * presenting a silent asymmetry the operator has to guess at.
 *
 * @returns {{quiet: boolean, waited_ms: number, observations: number,
 *            writes_observed: number, busy_fraction: number,
 *            per_file_writes: Record<string, number>, hottest: string|null,
 *            note_writes_observed: number,
 *            note_per_file_writes: Record<string, number>,
 *            note_hottest: string|null,
 *            window_ms: number, budget_ms: number}}
 */
export function waitForQuiesce(
  stateFiles,
  { windowMs, budgetMs, nowFn = Date.now, noteFiles = [] } = {},
) {
  const W = windowMs ?? envInt("HERMETIC_QUIESCE_WINDOW_MS", DEFAULT_QUIESCE_WINDOW_MS);
  const B = budgetMs ?? envInt("HERMETIC_QUIESCE_BUDGET_MS", DEFAULT_QUIESCE_BUDGET_MS);
  // Poll fast enough that a window can actually be observed to close, but
  // never faster than 25ms — the point is to wait, not to spin.
  const pollMs = Math.max(25, Math.min(1000, Math.floor(W / 4) || 25));

  const t0 = nowFn();
  const perFile = Object.create(null);
  const notePerFile = Object.create(null);
  const notes = Array.isArray(noteFiles) ? noteFiles : [];
  let observations = 0;
  let writes = 0;
  let noteWrites = 0;
  let prev = sampleMtimes(stateFiles);
  let notePrev = sampleMtimes(notes);
  let windowStart = t0;

  const report = (quiet) => ({
    quiet,
    waited_ms: nowFn() - t0,
    observations,
    writes_observed: writes,
    busy_fraction: observations > 0 ? writes / observations : 0,
    per_file_writes: perFile,
    hottest: hottestOf(perFile),
    note_writes_observed: noteWrites,
    note_per_file_writes: notePerFile,
    note_hottest: hottestOf(notePerFile),
    window_ms: W,
    budget_ms: B,
  });

  // Budget 0 (or a window that can never close inside the budget) is an
  // immediate, deliberate exhaustion — that is the seam the pin test uses to
  // drive the failure branch without waiting two minutes.
  while (nowFn() - t0 < B) {
    if (nowFn() - windowStart >= W) return report(true);
    sleepSync(Math.min(pollMs, Math.max(1, B - (nowFn() - t0))));
    observations += 1;
    const next = sampleMtimes(stateFiles);
    const changed = diffSamples(prev, next);
    if (changed.length > 0) {
      writes += 1;
      for (const p of changed) perFile[p] = (perFile[p] || 0) + 1;
      windowStart = nowFn(); // the quiet window restarts at every write
    }
    prev = next;
    if (notes.length > 0) {
      const noteNext = sampleMtimes(notes);
      const noteChanged = diffSamples(notePrev, noteNext);
      if (noteChanged.length > 0) {
        noteWrites += 1;
        for (const p of noteChanged) notePerFile[p] = (notePerFile[p] || 0) + 1;
        // deliberately does NOT touch windowStart — note files never gate.
      }
      notePrev = noteNext;
    }
  }

  // Budget expired. One last chance: the window may have closed on the final
  // iteration boundary.
  return report(nowFn() - windowStart >= W && W > 0);
}

function hottestOf(perFile) {
  let best = null;
  let bestN = 0;
  for (const [p, n] of Object.entries(perFile)) {
    if (n > bestN) {
      best = p;
      bestN = n;
    }
  }
  return best;
}

// Registered at most once, and only on the run-through path: re-sample the
// WATCHED mtimes (all ten, not just the gating seven) at process exit and say
// so if the daemon woke DURING the suite. This is the attribution that used to
// be missing — a byte-identity assertion going red downstream looks identical
// whether the code changed or the daemon breathed, and telling those apart by
// hand was the most expensive part of every red run. Watching the full set
// here is what makes narrowing the GATE safe: a note-tier source that moves
// mid-suite is still named. The hook prints; it NEVER touches the exit code.
let postCheckArmed = false;
function armPostCheck(stateFiles, baseline, testLabel) {
  if (postCheckArmed) return;
  postCheckArmed = true;
  process.on("exit", () => {
    try {
      const after = sampleMtimes(stateFiles);
      const changed = diffSamples(baseline, after);
      if (changed.length === 0) return;
      console.log(
        `HERMETIC_POST_CHECK: watermark daemon WROTE DURING this suite (${testLabel}) — ` +
          `${changed.length} state file(s) advanced: ${changed.join(", ")}`,
      );
      console.log(
        "HERMETIC_POST_CHECK: any byte-identity failure above is attributable to daemon " +
          "interference, not to the code under test. Re-run against a quiet daemon before " +
          "believing the diff.",
      );
    } catch {
      // A post-check that throws would be worse than one that says nothing.
    }
  });
}

/**
 * skipIfDaemonActive — the module-top gate.
 *
 * `_stateFilesForTest` is the test-only seam (codebase convention, cf.
 * index-cache._resetCaches): the production tiers are derived against the LIVE
 * tree, so exercising the branches hermetically needs an injected list.
 * Production callers pass only the label. Two accepted forms:
 *
 *   ARRAY  — unchanged pre-e18 meaning: the array is BOTH watched and gating.
 *            The pre-existing dynamic-matrix cases depend on exactly this.
 *   OBJECT — { watched, gating }, e18. Lets a pin case drive a FRESH note-tier
 *            file against a STALE gate-tier file, which is the only way to
 *            assert that note-tier freshness does not block.
 */
export function skipIfDaemonActive(testLabel = "hermetic", _stateFilesForTest = null) {
  let watchedFiles = WATCHED_STATE_FILES;
  let gatingFiles = GATING_STATE_FILES;
  if (Array.isArray(_stateFilesForTest)) {
    watchedFiles = _stateFilesForTest;
    gatingFiles = _stateFilesForTest;
  } else if (_stateFilesForTest != null && typeof _stateFilesForTest === "object") {
    if (Array.isArray(_stateFilesForTest.watched)) watchedFiles = _stateFilesForTest.watched;
    if (Array.isArray(_stateFilesForTest.gating)) gatingFiles = _stateFilesForTest.gating;
  }
  const noteFiles = watchedFiles.filter((p) => !gatingFiles.includes(p));

  const armed = process.env.REQUIRE_HERMETIC === "1";

  // FAST PATH: no GATING file has been written recently. Identical to the
  // pre-e10 behavior and instant — the overwhelmingly common case pays nothing
  // for the quiesce machinery. Note-tier freshness never reaches here.
  const fresh = freshFile(gatingFiles, DAEMON_ACTIVE_THRESHOLD_MS);
  if (!fresh) {
    armPostCheck(watchedFiles, sampleMtimes(watchedFiles), testLabel);
    return;
  }

  // LOCAL DEV (REQUIRE_HERMETIC unset): unchanged instant skip. A skip is not
  // a verdict about the code, so it is not worth minutes of wall clock.
  if (!armed) {
    console.log(
      `  SKIP: watermark daemon active (state file ${fresh.path} mtime ${Math.round(fresh.ageMs / 1000)}s ago)`,
    );
    console.log(
      `        ${testLabel} requires daemon quiesce to assert hermeticity on production paths.`,
    );
    console.log("0 passed, 0 failed (skipped — daemon-active)");
    process.exit(0);
  }

  // ARMED: wait for a real quiet window rather than judging one instant.
  const q = waitForQuiesce(gatingFiles, { noteFiles });
  if (q.quiet) {
    console.log(
      `  HERMETIC_QUIESCE: daemon quiet for ${q.window_ms}ms after waiting ${q.waited_ms}ms ` +
        `(${q.writes_observed} write(s) observed across ${q.observations} sample(s)) — ${testLabel} proceeding.`,
    );
    armPostCheck(watchedFiles, sampleMtimes(watchedFiles), testLabel);
    return;
  }

  // Budget exhausted. Same hard failure as before, but ATTRIBUTABLE: which
  // source was hot, how many writes landed, and what fraction of the wait was
  // busy. Without these three numbers the operator's next move is a guess.
  console.error(
    `FAIL: watermark daemon active (state file ${fresh.path} mtime ` +
      `${Math.round(fresh.ageMs / 1000)}s ago) and REQUIRE_HERMETIC=1 — ` +
      `the daemon-active skip would be a vacuous pass.`,
  );
  console.error(
    `      ${testLabel} requires daemon quiesce to assert hermeticity on production paths; ` +
      `quiesce the daemon (or unset REQUIRE_HERMETIC for local dev).`,
  );
  console.error(
    `      QUIESCE FAILED: no ${q.window_ms}ms quiet window in ${q.waited_ms}ms of a ` +
      `${q.budget_ms}ms budget.`,
  );
  console.error(
    `      hottest source: ${q.hottest ?? "(none observed — the initial sample was already fresh)"} | ` +
      `writes observed: ${q.writes_observed} of ${q.observations} sample(s) | ` +
      `busy fraction: ${q.busy_fraction.toFixed(3)}`,
  );
  console.error(`      GATE tier (${gatingFiles.length} file(s)) — these are what blocked:`);
  for (const [p, n] of Object.entries(q.per_file_writes)) {
    console.error(`        ${n} write(s): ${p}`);
  }
  // e18 — the note tier is sampled on the same cadence but never gates. Print
  // it so the asymmetry is visible: an operator staring at a quiet gate needs
  // to know the daemon was in fact busy elsewhere.
  console.error(
    `      NOTE tier (${noteFiles.length} file(s), watched but NEVER gating) — ` +
      `${q.note_writes_observed} write(s) observed` +
      (q.note_hottest ? `, hottest ${q.note_hottest}` : ""),
  );
  for (const [p, n] of Object.entries(q.note_per_file_writes)) {
    console.error(`        ${n} write(s): ${p}  [note tier — did not block]`);
  }
  console.error(
    "      Since e18 the endogenous agent-runtime sources (chat-claude-code, codex-cli) are " +
      "NOTE tier: if they are the hot ones above, they did NOT cause this failure and the " +
      "suite would have RUN on their account — the harness no longer waits out its own " +
      "operator. A gate-tier source is genuinely busy; look there.",
  );
  process.exit(1);
}
