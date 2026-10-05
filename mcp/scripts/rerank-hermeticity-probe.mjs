#!/usr/bin/env node
// rerank-hermeticity-probe.mjs — census, by RESOLUTION, of which registered
// test suites dial the local rerank server.
//
// WHY THIS IS A SCRIPT AND NOT A TEST
//   It is deliberately NOT named `*.test.mjs`. `test/**/*.test.mjs` on disk is
//   parity-checked against the SUITES registry in scripts/run-all-tests.mjs
//   (suiteParityDrift, enforced in that runner's main()); a new test file here
//   would either have to be registered — making the gate spawn a whole-registry
//   fan-out inside itself — or drift the parity guard off 0/0. A plain script
//   needs neither, so run-all-tests.mjs and package.json stay byte-identical.
//
//   The registry's SIZE is deliberately not written down anywhere in this file.
//   It is printed at runtime as SUITES.length in the census header, and it is
//   the same number the three buckets are asserted to sum to. rerank.js's
//   "no count of test callers is recorded here on purpose" paragraph makes the
//   same commitment for the same reason and points at this script; that is the
//   one place the rationale lives, so it is not restated here.
//
// WHY A SCRIPT AND NOT A NUMBER IN A REPORT
//   Every quantity in this area decays: the suite registry grows, tests get
//   their env-staging seams rewritten, and CAPS.LOCAL_RERANKER_ENABLED has
//   already flipped once. A count written into a comment or a report is a
//   claim with an expiry date. This is the re-derivation procedure instead:
//   re-run it and the buckets are current by construction.
//
// WHAT IT MEASURES
//   For every entry in the SUITES registry (the WHOLE domain — not a grep of
//   the flag name, not a hand-picked recall-looking list), spawn `node <suite>`
//   with the ambient environment plus exactly one change:
//
//       LOCAL_RERANKER_URL = http://127.0.0.1:<a closed port>
//
//   Nothing else is touched. In particular LOCAL_RERANKER_ENABLED is NOT set
//   (the probe must observe the real default resolution through
//   _localRerankerEnabled()'s fall-through to CAPS.LOCAL_RERANKER_ENABLED) and
//   REQUIRE_HERMETIC is NOT set (so the daemon-active skip stays a clean skip
//   and is observable as such rather than being converted to a hard failure).
//
//   A suite that reaches recall Layer-3 with the local backend selected will
//   POST to that dead port; local-reranker-client.js's LocalRerankUnavailableError
//   stamps "local-reranker: network failure" into the message, rerank.js
//   classifies it as reason=network and degrades to the final_score sort. The
//   marker string in the child's output is therefore evidence that the suite
//   dialed — and, because the port is dead, the probe run never touches the
//   live rerank server.
//
// THE MARKER ALONE IS NOT SUFFICIENT — CORROBORATION PASS
//   Measured 2026-08-15: test/recall/local-reranker.test.mjs prints the marker
//   without opening a socket. Its B1/C2 cases stub globalThis.fetch and throw
//   `new LocalRerankUnavailableError("server down")` themselves, and rerank.js
//   faithfully logs "local-reranker: network failure: server down" from that
//   hermetic, self-manufactured error. Reporting that suite as a dialer would
//   be exactly the sample-read-as-population error this census exists to avoid,
//   in miniature: the string was read as the event.
//
//   So every suite that shows the marker gets a SECOND, separately-labelled run
//   with LOCAL_RERANKER_ENABLED="0" added (the tri-state OFF override, which
//   beats the CAP). The question that run answers is the only one that matters:
//   does this marker DEPEND on the default flag resolution?
//     marker disappears under "0"  -> the dial came from default resolution
//                                     selecting the local backend. REAL DIAL.
//     marker persists under "0"    -> the suite manufactures the error itself
//                                     with no backend selected. HERMETIC.
//   This is a differential measurement, not string forensics on the error
//   cause, so it does not rot when undici changes its wording. The census pass
//   itself never sets LOCAL_RERANKER_ENABLED — only this corroboration pass
//   does, and its results are printed under their own heading.
//
// THE OFF-OVERRIDE DIFFERENCE HAS ONE KNOWN FALSE NEGATIVE — SENTINEL PASS
//   _logRerankDegradeOnce dedupes per REASON per PROCESS. A suite that first
//   synthesizes a `network` error and only LATER really dials emits one line,
//   and that line survives the OFF override — so the differential books it
//   NO-DIAL/synthesized while a socket was in fact opened. No amount of string
//   comparison can see past a log line that was never printed twice.
//
//   So the synthesized bucket gets a THIRD pass, decided by the socket instead
//   of the log: each such suite is re-run under the DEFAULT resolution against
//   a sentinel HTTP listener the probe binds itself on a port it owns, which
//   counts accepted connections and answers 500. An empty bucket prints its
//   heading and says so — the pass is skipped, never silently omitted.
//
//   THE SENTINEL PROVES EXACTLY ONE DIRECTION. An accepted connection is a dial
//   no matter how the child words its degrade, so n > 0 reclassifies the suite
//   to DIALS with the connection count as the evidence. n === 0 proves nothing
//   ON ITS OWN — a child that never reached Layer-3 also accepts no connections.
//   So zero is only allowed to leave the suite in NO-DIAL after blockedReason()
//   finds evidence that the re-run ran — a stated assertion count, nothing
//   less; otherwise the suite goes to UNMEASURED naming the block, and a
//   sentinel re-run that self-skips for its own reasons lands there rather than
//   confirming a negative. The printed label for the surviving zero case is
//   "no connection observed under default resolution" — a statement about what
//   was seen — and not a confirmation of a negative.
//
// THE RAN-CHECK — ONE DEFINITION, blockedReason(), USED BY EVERY PASS
//   Each of the three passes above reads a child's output and decides something
//   from it. All three are worthless on a child that did not run: absence of a
//   marker, or of a connection, in a run that never happened is not evidence
//   that the suite does not dial. blockedReason() is the single place that
//   answers "did this run leave evidence that it ran?" — which is the most that
//   can be asked from outside a child process — and the census pass, the
//   corroboration pass, the sentinel pass and BOTH positive-control directions
//   call it. classify() is a thin caller of it, not a second copy — two copies
//   of one rule is a defect shape this program has already paid for.
//
//   IT IS AN ALLOWLIST, NOT A LIST OF WAYS TO FAIL. The default answer is
//   BLOCKED. There is exactly one route out of it: tallySignals() parsed a
//   tally out of the child's combined output and at least one parsed signal
//   counted a nonzero number of assertions. That is the child's own statement
//   that it executed assertions, and it is the only thing in a child's output
//   that distinguishes work from silence. Every other ending — an unrecognized
//   crash idiom, an exit through the suite's own handler, no output at all,
//   bytes that do not decode — is UNMEASURED.
//
//   The earlier design was the other way round: a ladder of known failure
//   shapes, and anything that matched none of them was called measured. That is
//   an enumeration, and an enumeration is only ever as complete as the
//   imagination of whoever wrote it. Each shape it fails to name is a suite
//   promoted to a verdict it did not earn, which is precisely the error this
//   whole instrument exists to refuse. An allowlist's incompleteness costs
//   coverage instead — and coverage is a bucket the census prints, sizes and
//   can act on, whereas a false verdict is invisible by construction.
//
//   Elapsed time is not part of it in any form. A fast run is not evidence that
//   nothing happened and a slow one is not evidence that something did; the
//   previous revision's "no tally AND sub-second" conjunction is gone, and no
//   duration decides a bucket anywhere in this file.
//
//   THE TALLY IS THE MEASUREMENT; THE IDIOM LIST IS ONLY WORDING NOW.
//   The skip idioms were derived by measurement over the registered suites
//   rather than from memory, and the derivation found that the corpus has no
//   single skip idiom — it has several, in several unrelated shapes. Enumerating
//   them can therefore only ever be a net with holes in it, which is why the net
//   no longer decides anything. A suite that self-skips with a listed idiom and
//   one that self-skips with an unlisted one are both blocked; SKIP_IDIOM_NET
//   survives so the first kind can be reported with a more specific reason than
//   the second. The same is true of the fatal-banner and zero-tally detections:
//   they refine the wording of a block, and they keep a run that tallied and
//   then crashed blocked, but none of them is what makes any run measured.
//
// THREE BUCKETS, SUMMING EXACTLY TO THE DOMAIN SIZE
//   DIALS      marker observed AND corroborated as flag-dependent, or a socket
//              accepted by the probe-owned sentinel.
//   NO-DIAL    the child stated a nonzero assertion count, and under THIS
//              resolution no dial was observed: either no marker appeared, or
//              the marker was corroborated as test-synthesized and the sentinel
//              re-run accepted no connection. Synthesized-marker suites are
//              listed by name under the census so the reader sees why they are
//              here.
//
//              NO-DIAL NEVER MEANS "THIS SUITE CANNOT DIAL". It is a statement
//              about one run under one resolution, nothing more. A suite whose
//              rerank path is behind a fixture, an opt-in env var, or a code
//              path this run did not enter lands here on exactly the same
//              evidence as a suite with no rerank path at all, and the bucket
//              cannot tell them apart. Read it as "ran to completion, no dial
//              observed", never as a property of the file.
//   UNMEASURED the run cannot support either verdict — blockedReason() named a
//              block in whichever pass was deciding. That is the DEFAULT: it
//              covers every run that did not state a nonzero assertion count,
//              whatever the reason, including reasons nothing here enumerates.
//              A blocked CORROBORATION or SENTINEL re-run lands here too: the
//              census pass may have seen a marker, but nothing downstream was
//              able to say whether it was flag-dependent.
//
//   UNMEASURED is BLOCKED, never folded into NO-DIAL. Absence of the marker in
//   a run that did not happen is not an observation that the suite does not
//   dial. Re-probe those in a quiet window rather than reclassifying them.
//
//   NOTE on NO-DIAL and exit codes: a non-zero exit is NOT by itself a reason
//   to call a run unmeasured. A registered suite that is red runs every
//   assertion, prints its own tally and exits 1 deliberately — it measured
//   fine, it just failed. How many suites are red at any moment is not stated
//   here; it is a moving population, and this file records none of those.
//   What separates "ran and failed" from "did not run" is the TALLY, and only
//   the tally: a child that states a nonzero assertion count is measured at any
//   exit code, and a child that states none is blocked at any exit code. The
//   Node fatal banner is still detected, because "crashed" is a more useful
//   thing to print than "no tally", but it is no longer the separator of
//   record — a crash that leaves no banner (a suite's own uncaught-exception
//   handler, a bare process.exit) is blocked all the same.
//
// DISCRIMINATION CONTROL
//   Any classifier that fires for everything, or for nothing, proves nothing.
//   So the run carries one control in each direction.
//
//   NEGATIVE CONTROL — test/rerank.test.mjs, a registered suite that MUST land
//   in NO-DIAL. It pins LOCAL_RERANKER_ENABLED="0" at its env seam, so it is
//   hermetic by construction and a marker sighting there would mean the
//   classifier fires for everything.
//
//   POSITIVE CONTROL — a synthetic child this probe WRITES ITSELF into a
//   mkdtemp directory and runs directly (not through the census). It is not a
//   registered suite and it lives nowhere under mcp/test/.
//
//   WHY A REGISTERED SUITE CANNOT SERVE AS THE POSITIVE CONTROL. The previous
//   revision named test/recall-mask-drop.test.mjs and required it to land in
//   DIALS. That was invalid on both ends. A test suite is maintained for its
//   OWN assertions: recall-mask-drop needs a deterministic ranking, so it pins
//   LOCAL_RERANKER_ENABLED="0" at its env seam — which makes DIALS unreachable
//   for it and the control permanently VIOLATED. And the direction of that
//   maintenance is exactly backwards for a control: every suite in the registry
//   is being actively driven TOWARD hermeticity, so any suite chosen as a
//   "must dial" control is a control scheduled for deletion. Worse, a control
//   that could only be repaired by REMOVING a suite's pin would make the probe
//   an instrument that damages the property it exists to measure. The control
//   must therefore be owned by the probe, which is the only way it can be valid
//   BY CONSTRUCTION rather than by the current state of somebody else's file.
//
//   The control child imports rerankCandidates from lib/recall/rerank.js with
//   NO _generateRanking injection and no gemini keys in its env, and calls it
//   on two candidates. Both directions are asserted IN THE SAME RUN:
//     census env (LOCAL_RERANKER_ENABLED unset) -> default resolution falls
//       through to the CAP, the local backend is selected, it POSTs the dead
//       port, and the marker MUST appear.
//     same child + LOCAL_RERANKER_ENABLED="0"   -> the OFF override beats the
//       CAP, the gemini key gate applies, no key is present, so it degrades
//       api_key_missing without opening a socket and the marker MUST NOT
//       appear.
//   One direction alone proves nothing: marker-always and marker-never are both
//   consistent with a broken classifier. Requiring the marker to appear AND
//   disappear on the flag is what makes the census's DIALS/NO-DIAL distinction
//   meaningful. A violated control invalidates the census (exit 2) — do not
//   read the buckets past that line.
//
//   THE CONTROL IS HELD TO THE SAME RAN-CHECK AS THE CENSUS. Both directions go
//   through blockedReason(). "Marker ABSENT in the OFF direction" is the whole
//   of the control's negative leg, and it is worth nothing if that direction
//   crashed before it could dial — exactly the false positive the census passes
//   were fixed for. A BLOCKED control direction is therefore reported as
//   BLOCKED and exits 2 alongside a VIOLATED one: a control that could not run
//   has validated nothing, and letting it pass would leave the qualifier on the
//   buckets vacuous.
//
//   --break-positive-control is the control's own falsification self-test: it
//   injects the OFF override into the ON-direction env, where the marker is
//   REQUIRED. A control that still passes under that flag is vacuous. The probe
//   must print CONTROL VIOLATED (positive) and exit 2.
//
//   --self-test-ran-check is the falsification self-test for blockedReason()
//   itself, in the same probe-owned-child idiom. It replaces the census domain
//   with the synthetic children built by selfTestChildSource(), written into the
//   same mkdtemp mechanism, and runs them through the REAL passes rather than a
//   mock of them. Every child MUST land in UNMEASURED; the per-child shapes and
//   which pass decides each are documented at selfTestChildSource().
//
//   HALF OF THEM EXIST TO FALSIFY AN ENUMERATION, NOT A BUG. A and B present
//   failure shapes an enumerating ran-check names outright — a Node fatal
//   banner, a listed skip idiom. C, D, E and F deliberately present none: an
//   exit through the child's own handler, total silence, an unlisted self-skip
//   wording, and undecodable bytes, each taking over a second so no fast-exit
//   heuristic can reach it either. Against a ran-check that decides from a list
//   of failures, those four are booked DIALS or NO-DIAL — a red/green pair whose
//   red half is what makes the green half worth anything. Against an allowlist,
//   all of them are UNMEASURED for the same single reason: none stated an
//   assertion count.
//
//   Every child exits 0, or exits 1 through its own handler, in the directions
//   that matter, so a probe deciding from failure shapes sees nothing wrong with
//   any of them — which is the point.
//
// FILESYSTEM: ONE WRITE, OUTSIDE THE REPO
//   This script writes exactly one kind of thing: its own synthetic children —
//   the positive control always, plus the --self-test-ran-check children when
//   that flag is given — into mkdtempSync directories under the OS temp
//   dir, each removed in a finally. Nothing is ever written inside the repo, in
//   particular nothing under mcp/test/, so suiteParityDrift stays 0/0 and
//   run-all-tests.mjs and package.json stay byte-identical. Otherwise it spawns
//   children and prints. Nothing under ledgers/, indices/, storage/ or
//   connectors/*/state.json is opened for writing; the only thing this script
//   does to storage/ is statSync three watermark state files under --wait-quiet.
//
// NETWORK: WHAT ACTUALLY HAPPENS ON THE WIRE
//   The probe itself makes two kinds of connection, both to 127.0.0.1 and both
//   as preconditions rather than measurements: portIsListening() opens and
//   immediately destroys a socket against the census port and the sentinel port
//   to prove the first is closed and the second is free.
//
//   The census and corroboration passes bind nothing. Their children POST to
//   LOCAL_RERANKER_URL, which the probe has pointed at a port it verified is
//   CLOSED, so those POSTs are refused at connect — that refusal is the whole
//   measurement.
//
//   The sentinel pass DOES bind: it stands up an http.createServer listener on
//   a probe-owned port, points that pass's children at it, counts the accepted
//   connections and answers 500, and closes the listener in a finally. So the
//   claim is not "no listener": it is that the only listener is this probe's
//   own, on a port checked free before binding, for the duration of one pass.
//
//   LIVE_RERANKER_PORT is never any of this: not a census target, not a
//   sentinel bind target, and refused at startup for either role. No daemon is
//   signalled, restarted, quiesced or health-checked — --wait-quiet observes the
//   watermark daemon by reading mtimes and never touches it. Children inherit
//   the ambient env, so a child that dials something else on its own account
//   does so exactly as it would under the normal test runner.
//
// SAFETY RAILS (all refuse-to-start, not warn-and-continue)
//   - port 8360 is rejected outright: that is the live rerank server, and
//     pointing the census at it would measure nothing while generating load
//     against production.
//   - the chosen port must be closed. If something is listening, the marker
//     would never appear and every suite would silently look like NO-DIAL.
//   - the sentinel port must be a DIFFERENT port, must not be 8360 (the
//     sentinel BINDS, so the live daemon is not even a legal bind target), and
//     must be free — a foreign listener would pollute the connection counts.
//   - LOCAL_RERANKER_ENABLED / REQUIRE_HERMETIC must be absent from the
//     ambient env, since either one would make the children resolve something
//     other than the real default.
//
// CLI
//   node mcp/scripts/rerank-hermeticity-probe.mjs
//   node mcp/scripts/rerank-hermeticity-probe.mjs --port 8461
//   node mcp/scripts/rerank-hermeticity-probe.mjs --sentinel-port 8462
//   node mcp/scripts/rerank-hermeticity-probe.mjs --concurrency 4
//   node mcp/scripts/rerank-hermeticity-probe.mjs --timeout-ms 180000
//   node mcp/scripts/rerank-hermeticity-probe.mjs --suites a.test.mjs,b.test.mjs
//        (subset re-probe — for re-running the UNMEASURED set in a quiet
//         window. The header prints SUBSET so a subset run can never be
//         mistaken for a full census.)
//   node mcp/scripts/rerank-hermeticity-probe.mjs --wait-quiet
//        (before each spawn, poll the watermark state files READ-ONLY until
//         all three are older than skipIfDaemonActive's 30s threshold, so the
//         suite does not skip itself. Polling only — the daemon is never
//         signalled, quiesced, or written to. This is how the UNMEASURED set
//         gets re-probed instead of being assumed.)
//   node mcp/scripts/rerank-hermeticity-probe.mjs --quiet-wait-ms 300000
//        (cap on how long --wait-quiet will poll for one spawn before giving
//         up and booking that suite UNMEASURED with the no-window reason.)
//   node mcp/scripts/rerank-hermeticity-probe.mjs --break-positive-control
//        (falsification self-test of the positive control — see DISCRIMINATION
//         CONTROL above. MUST print CONTROL VIOLATED (positive) and exit 2.)
//   node mcp/scripts/rerank-hermeticity-probe.mjs --self-test-ran-check
//        (falsification self-test of blockedReason() — see DISCRIMINATION
//         CONTROL above. Replaces the domain with the probe-owned synthetic
//         children listed in SELF_TEST_CHILDREN and built by
//         selfTestChildSource(), and runs them through the real passes. There
//         are no per-child flags: one flag runs the whole set, and the run
//         prints each child's file and bucket by name.
//           A  fatal-banner crash under the OFF override    -> corroboration
//           B  listed skip idiom under the sentinel re-run  -> sentinel
//           C  exit 1 via the child's OWN handler, no banner, no tally, >1s
//                                                           -> corroboration
//           D  exit 0 in total silence, no output at all, >1s
//                                                           -> corroboration
//           E  unlisted self-skip wording under the sentinel, no tally, >1s
//                                                           -> sentinel
//           F  non-UTF8 bytes on stdout, exit 0, >1s         -> corroboration
//         EVERY child MUST land in UNMEASURED; a build in which any lands in
//         DIALS or NO-DIAL is deciding from a list of failure shapes instead of
//         from evidence that the child ran. C through F are the ones that
//         distinguish those two designs — they are on nobody's list.)
//
// Exit codes: 0 = census completed (whatever the buckets say)
//             2 = refused to start, or a control was VIOLATED or BLOCKED
//
// LIMITATIONS — WHAT THIS INSTRUMENT CANNOT SEE
//   Arrival at recall Layer-3 is positively establishable in ONE direction
//   only. A dial leaves a positive trace: the marker under a resolution where
//   it disappears with the flag off, or a connection accepted by the sentinel.
//   There is no equivalent trace for the negative. Nothing a child prints says
//   "I reached the rerank seam and chose not to dial", so the negative case
//   rests entirely on completion evidence — the child stated a nonzero
//   assertion count and no dial was seen — and that is a weaker thing than the
//   positive case by construction, not by oversight. NO-DIAL is therefore a
//   report about one run, and reading it as a property of the suite is the
//   error this file is built to prevent.
//
//   The allowlist has a known and deliberate cost. UNMEASURED will include
//   suites that ran perfectly and simply print no counts in any form
//   TALLY_FORMS parses — a suite that asserts silently and exits 0 is
//   indistinguishable, from outside, from one that exited before asserting
//   anything. Those suites are not evidence of anything and are not claimed to
//   be; they are reported in the allowlist-default row of the per-rule table so
//   their size is visible. The remedy is to widen TALLY_FORMS against a fresh
//   sweep of the corpus, which shrinks UNMEASURED with evidence. Loosening the
//   ran-check would shrink it without evidence, which is the trade this
//   revision exists to refuse.
//
//   The sentinel's zero is likewise not a proof. It says this run, under this
//   resolution, accepted no connection; a child that never reached the rerank
//   seam accepts none either. Only n > 0 proves anything on its own.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SUITES } from "./run-all-tests.mjs";
// e18: the gate set is DERIVED from CAPS.WATERMARK_SOURCES and TIERED, and it
// lives in exactly one place. This probe used to carry a byte-identical copy
// of a three-path list under a comment asserting it matched what
// skipIfDaemonActive stats — an assertion that was already false (the helper
// had drifted) and would have gone false again at the next source. Importing the
// tier is the only way the two can never disagree. Importing the module does
// not call skipIfDaemonActive; it only materialises the frozen path lists.
import { GATING_STATE_FILES } from "../test/_hermetic-daemon-skip.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// The live rerank server. Never a legal probe target.
const LIVE_RERANKER_PORT = 8360;
const DEFAULT_PROBE_PORT = 8461;
// The sentinel pass binds this one itself. Distinct from the dead census port,
// and — like every other port here — never 8360.
const DEFAULT_SENTINEL_PORT = 8462;

// Stamped by LocalRerankUnavailableError's constructor in
// mcp/lib/recall/local-reranker-client.js. rerank.js's _classifyError keys on
// the same substring to label the degrade reason "network".
const DIAL_MARKER = "local-reranker: network failure";
// Printed by skipIfDaemonActive (test/_hermetic-daemon-skip.mjs) on its clean
// skip branch — the branch taken when REQUIRE_HERMETIC is unset, as it is here.
const SKIP_MARKER = "SKIP: watermark daemon active";
// Node prints its version banner as the last line of a fatal uncaught
// exception / unhandled rejection dump, and only then. This is what separates
// "crashed" from "asserted, tallied, exited non-zero".
const NODE_FATAL_BANNER = /^Node\.js v\d/m;

// --- The ran-check's evidence sources ------------------------------------
//
// PRIMARY: the tally. Derived by measurement over the corpus, not from memory.
// The enumerating command was:
//
//   for f in $(node -e 'import("./scripts/run-all-tests.mjs").then(m=>
//       console.log(m.SUITES.join("\n")))'); do
//     LOCAL_RERANKER_URL=http://127.0.0.1:<dead> node "$f" 2>&1 | tail -3; done
//
// run over a strided sample of the whole SUITES registry, printing the last
// lines each suite emits and grouping them by shape. The corpus does not have
// one tally convention; it has these, and every one below was observed in that
// output rather than assumed. Each entry is (passed, failed) or a passed-only
// count; a form that matches contributes a signal, and a form that does not is
// simply silent. tallySignals() returns every signal it found, and the ran-check
// asks whether ANY of them saw an assertion — a union, so one convention failing
// to match can never by itself make a suite look blocked.
const TALLY_FORMS = [
  // node:test's own summary, as printed by every suite that imports from
  // "node:test" — the most common harness in the corpus, though how common is
  // not written down here for the same reason the registry size is not. Both
  // halves are separate lines.
  (all) => {
    const p = all.match(/^[ℹ#]\s*pass\s+(\d+)\s*$/m);
    const f = all.match(/^[ℹ#]\s*fail\s+(\d+)\s*$/m);
    return p || f ? { form: "node:test summary", passed: p ? Number(p[1]) : 0, failed: f ? Number(f[1]) : 0 } : null;
  },
  // "67 passed, 0 failed" / "27 pass, 0 fail" / "15 pass / 0 fail" — the
  // hand-rolled tally, comma or slash separated, singular or past tense. Last
  // match wins: a suite that quotes the form in prose before printing its own.
  (all) => {
    const m = [...all.matchAll(/(\d+)\s+pass(?:ed)?\s*[,/]\s*(\d+)\s+fail(?:ed|ures)?/g)].pop();
    return m ? { form: "n passed, m failed", passed: Number(m[1]), failed: Number(m[2]) } : null;
  },
  // "Passed: 11" / "Failed: 0" — the labelled column form.
  (all) => {
    const p = all.match(/^\s*Passed:\s*(\d+)\s*$/m);
    const f = all.match(/^\s*Failed:\s*(\d+)\s*$/m);
    return p || f ? { form: "Passed:/Failed:", passed: p ? Number(p[1]) : 0, failed: f ? Number(f[1]) : 0 } : null;
  },
  // Per-assertion lines: "PASS  <label>" / "FAIL  <label>", counted.
  (all) => {
    const p = (all.match(/^\s*PASS\b/gm) || []).length;
    const f = (all.match(/^\s*FAIL\b/gm) || []).length;
    return p + f > 0 ? { form: "PASS/FAIL lines", passed: p, failed: f } : null;
  },
  // Per-assertion lines, lowercase-with-colon: "pass: T14: ..." / "fail: ...".
  (all) => {
    const p = (all.match(/^\s*pass:/gm) || []).length;
    const f = (all.match(/^\s*fail:/gm) || []).length;
    return p + f > 0 ? { form: "pass:/fail: lines", passed: p, failed: f } : null;
  },
  // TAP assertion lines: "ok - <label>" / "not ok - <label>", counted. Emitted
  // by node:test's reporter and by several hand-rolled harnesses.
  (all) => {
    const p = (all.match(/^\s*ok\b/gm) || []).length;
    const f = (all.match(/^\s*not ok\b/gm) || []).length;
    return p + f > 0 ? { form: "tap ok/not ok lines", passed: p, failed: f } : null;
  },
  // "69 assertions passed" — a passed-only statement of the count.
  (all) => {
    const m = [...all.matchAll(/\b(\d+)\s+assertions?\s+(?:passed|ran)\b/g)].pop();
    return m ? { form: "n assertions passed", passed: Number(m[1]), failed: 0 } : null;
  },
  // "self-test: PASS (10 assertions)" — the count parenthesised after a verdict.
  (all) => {
    const m = [...all.matchAll(/\bPASS\s*\(\s*(\d+)\s+assertions?\b/g)].pop();
    return m ? { form: "PASS (n assertions)", passed: Number(m[1]), failed: 0 } : null;
  },
];

function tallySignals(all) {
  const sigs = [];
  for (const form of TALLY_FORMS) {
    const s = form(all);
    if (s) sigs.push(s);
  }
  return sigs;
}

// SECONDARY: a NET, NOT A CENSUS. These are the skip idioms that were visible in
// the same corpus sweep, but the sweep's actual finding was that the corpus has
// no single idiom and no reason to converge on one — so this list is certain to
// be incomplete, and it is consulted only when tallySignals() found no tally at
// all. It exists to catch a suite that skips itself without printing any count;
// the tally above is what catches the rest, including idioms added later.
// The observed idioms, all of which reduce to a line whose first word is SKIP
// or SKIPPING, which is why one regex covers them:
//   "SKIP: <reason>"   test/synthesis/recall-empirical-regression.test.mjs's
//                      opt-in gate, and skipIfDaemonActive's clean-skip line in
//                      test/_hermetic-daemon-skip.mjs (that one is matched
//                      earlier, by SKIP_MARKER, and never reaches this net)
//   "SKIPPING <what>"  the GEMINI_API_KEY-absent branches in
//                      test/gemini-flash-client.test.mjs and
//                      test/gemini-client.test.mjs, and
//                      test/integration-phase3-v1-rerank.test.mjs's own opt-out
//   "SKIP  <label>"    the labelled form in test/integration-phase3-v0.test.mjs,
//                      test/recall/contextual-eval-goldset.test.mjs and
//                      test/validate-workflow-script.test.mjs
// Note what the gating buys: the two gemini suites print a SKIPPING line for
// their key-absent cases and then run and tally the rest. Because a parsed
// tally is consulted first and shows assertions ran, they are NOT blocked — a
// literal-first design would have booked both UNMEASURED on a partial skip.
const SKIP_IDIOM_NET = /^\s*SKIP(?:PING)?\b/m;

// The negative control is a registered suite (it must run inside the census to
// prove the classifier does not fire for everything). The positive control is
// NOT — it is the synthetic child below, owned by this probe. See the
// DISCRIMINATION CONTROL section for why a registered suite cannot fill that
// role.
const NEGATIVE_CONTROL = "test/rerank.test.mjs";

// Source of the probe-owned positive control. Two candidates, the real
// rerankCandidates, no _generateRanking injection, no gemini keys — so the ONLY
// thing that decides whether a socket is attempted is _localRerankerEnabled()'s
// resolution of LOCAL_RERANKER_ENABLED against the CAP. That is precisely the
// property the census reads, which is what makes this control valid by
// construction rather than by the current contents of some suite.
function positiveControlSource(rerankJsUrl) {
  return `// probe-owned synthetic positive control — written by
// mcp/scripts/rerank-hermeticity-probe.mjs into a mkdtemp dir, deleted after.
// NOT a registered suite and NOT under mcp/test/, so suiteParityDrift stays 0/0.
import { rerankCandidates } from ${JSON.stringify(rerankJsUrl)};

// No gemini key in either direction. With the flag OFF this is what makes the
// degrade land on api_key_missing (no socket); with the flag ON the key gate is
// skipped entirely and the local backend dials.
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;

const pool = [
  { candidate: { memory_id: "ctl_a", content: "control candidate alpha", kind: "fact" },
    score_components: { final_score: 0.9 } },
  { candidate: { memory_id: "ctl_b", content: "control candidate bravo", kind: "fact" },
    score_components: { final_score: 0.1 } },
];

const res = await rerankCandidates({
  surrounding_context: {
    current_query: "positive control query",
    recent_turns: [{ role: "user", content: "control" }],
    agent_role: "primary_assistant",
    entities: [],
  },
  candidates_with_scores: pool,
  opts: {}, // NO _generateRanking injection — the default resolution decides.
});

console.log(
  "positive-control: degraded=" + res.degraded +
  " reason=" + res.rerank_failed_reason +
  " kept=" + res.reranked.length,
);
// The control is held to the same ran-check as the census, so it has to speak
// the census's language: one rerankCandidates call completed, stated in a form
// tallySignals() parses. That line is not decoration. The ran-check is an
// allowlist whose default is BLOCKED, so without it this child prints no
// assertion count, blockedReason() correctly reports it as blocked however fast
// or slow it was, and the control reports on its own silence instead of on its
// result — leaving the qualifier it puts on the buckets vacuous.
console.log("positive-control: 1 passed, 0 failed");
`;
}

// Run the synthetic control in BOTH directions in the same probe run.
//   ON  direction: census env, LOCAL_RERANKER_ENABLED unset -> marker REQUIRED.
//   OFF direction: same child + LOCAL_RERANKER_ENABLED="0"  -> marker FORBIDDEN.
// Returns { ok, on, off, dir } for printing. `breakIt` injects the OFF override
// into the ON-direction env — the falsification self-test, which MUST fail.
async function runPositiveControl(childEnv, timeoutMs, breakIt) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rerank-hermeticity-control-"));
  try {
    const file = path.join(dir, "positive-control.mjs");
    const rerankJsUrl = pathToFileURL(
      path.join(REPO_ROOT, "lib", "recall", "rerank.js"),
    ).href;
    writeFileSync(file, positiveControlSource(rerankJsUrl), { mode: 0o600 });

    const onEnv = { ...childEnv };
    delete onEnv.LOCAL_RERANKER_ENABLED;
    if (breakIt) onEnv.LOCAL_RERANKER_ENABLED = "0";
    const offEnv = { ...childEnv, LOCAL_RERANKER_ENABLED: "0" };

    const onRun = await runSuite(file, onEnv, timeoutMs);
    const offRun = await runSuite(file, offEnv, timeoutMs);
    const onMarked = `${onRun.out}\n${onRun.err}`.includes(DIAL_MARKER);
    const offMarked = `${offRun.out}\n${offRun.err}`.includes(DIAL_MARKER);

    // Same ran-check as every census pass. The negative leg of this control is
    // an ABSENCE ("marker gone under the OFF override"), which is worth exactly
    // nothing if that direction never ran — the identical false positive the
    // corroboration pass was fixed for. The positive leg is a presence and
    // would survive a blocked run, but a control whose two directions are held
    // to different standards is the uneven discipline this probe exists to
    // stop, so both are checked and either one blocking blocks the control.
    const onBlocked = blockedReason(onRun);
    const offBlocked = blockedReason(offRun);
    const blocked = onBlocked || offBlocked;

    return {
      // BLOCKED is not "ok". A control that could not run has validated nothing,
      // and main() exits 2 on it exactly as it does on a violated one.
      ok: !blocked && onMarked && !offMarked,
      blocked,
      onBlocked,
      offBlocked,
      onMarked,
      offMarked,
      onRun,
      offRun,
    };
  } finally {
    // The one write this probe makes, undone. Never inside the repo.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort; a leftover temp dir is not a census result.
    }
  }
}

// --- --self-test-ran-check: falsification harness for blockedReason() ------
//
// Probe-owned synthetic children, written with the SAME mkdtemp mechanism
// runPositiveControl() uses, then handed to the census as its domain so they
// travel through the REAL passes. Each is built to be invisible to a probe
// whose ran-check enumerates failure shapes, and unmistakable to one that
// requires evidence of success. Every one of them MUST land in UNMEASURED.
//
// A: prints the marker under the census env (-> MARKER), then throws uncaught
//    under the OFF override. Marker gone, Node fatal banner, no socket ever
//    opened, so the corroboration pass would otherwise read the absence as
//    flag-dependence and book DIALS — the actionable bucket — from a child that
//    never opened a socket.
// B: prints the marker under the census env AND under the OFF override (-> the
//    synthesized bucket, which is what feeds the sentinel pass), then, when it
//    sees the sentinel's URL, prints a recognized skip idiom, no tally, and
//    exits 0 without dialing, where the sentinel pass would otherwise read zero
//    connections as a confirmed NO-DIAL.
//
// A and B are shapes an enumerating ran-check already names (a fatal banner; a
// listed skip idiom). C through F are deliberately none of them — each starves
// a different deciding pass of evidence while presenting nothing on any list:
//
// C: marker under the census env; under the OFF override it installs its OWN
//    top-level handler, prints its own diagnostic and exits 1 after more than a
//    second. No fatal banner (the handler ate it), no tally, no skip idiom, not
//    a fast exit. Decided by the CORROBORATION pass.
// D: marker under the census env; under the OFF override it prints nothing at
//    all and exits 0 after more than a second. Silence is the entire output.
//    Decided by the CORROBORATION pass.
// E: marker under the census env AND under the OFF override (-> the synthesized
//    bucket); under the sentinel's URL it self-skips with an idiom deliberately
//    outside the SKIP/SKIPPING net ("bail out: ..."), prints no tally, opens no
//    socket and takes more than a second. Decided by the SENTINEL pass.
// F: marker under the census env; under the OFF override it writes a non-UTF8
//    byte sequence to stdout and exits 0 after more than a second — output that
//    no tally form can parse and no idiom list can name. Decided by the
//    CORROBORATION pass.
//
// All of them distinguish the passes only from what the passes actually vary —
// the OFF override, and LOCAL_RERANKER_URL's port — so none is told which pass
// it is in by anything the probe would not really change. All exit 0, or exit 1
// through their own handler, in the directions that matter, so a probe that
// decides from failure shapes sees nothing wrong with any of them.
const SELF_TEST_CHILDREN = ["A", "B", "C", "D", "E", "F"];

// The census direction of every child: show the marker, and state one completed
// assertion in a form tallySignals() parses, so the child is a measured datum
// wherever the probe is not deliberately starving it of evidence.
function selfTestCensusDirection(which) {
  return `console.log("${DIAL_MARKER}: self-test child ${which} (synthetic, no socket opened)");
console.log("self-test child ${which}: 1 passed, 0 failed");
`;
}

function selfTestChildSource(which, sentinelPort) {
  const head = `// probe-owned self-test child ${which} (--self-test-ran-check). mkdtemp, deleted after.\n`;
  if (which === "A") {
    return `${head}// Census env -> marker. OFF override -> uncaught throw, no socket, no marker.
if (process.env.LOCAL_RERANKER_ENABLED === "0") {
  throw new Error("self-test child A: crashes under the OFF override before it could dial");
}
${selfTestCensusDirection("A")}`;
  }
  if (which === "B") {
    return `${head}// Census env AND OFF override -> marker (so it reaches the synthesized bucket).
// Sentinel re-run -> a recognized skip idiom, no tally, no socket.
if ((process.env.LOCAL_RERANKER_URL || "").includes(":${sentinelPort}")) {
  console.log("SKIPPING self-test child B: declines to run under the sentinel");
  process.exit(0);
}
${selfTestCensusDirection("B")}`;
  }
  if (which === "C") {
    return `${head}// Census env -> marker. OFF override -> the child installs its OWN top-level
// handler, prints its OWN diagnostic and exits 1 after more than a second, so
// there is no Node fatal banner, no tally, no skip idiom and no fast exit.
if (process.env.LOCAL_RERANKER_ENABLED === "0") {
  process.on("uncaughtException", (e) => {
    process.stderr.write("self-test child C: own handler took it -> " + e.message + "\\n");
    process.exit(1);
  });
  setTimeout(() => {
    throw new Error("self-test child C: fails under the OFF override, handled in-process");
  }, 1200);
} else {
${selfTestCensusDirection("C")}}
`;
  }
  if (which === "D") {
    return `${head}// Census env -> marker. OFF override -> total silence, then exit 0 after more
// than a second. No output of any kind is the whole of the evidence.
if (process.env.LOCAL_RERANKER_ENABLED === "0") {
  setTimeout(() => process.exit(0), 1200);
} else {
${selfTestCensusDirection("D")}}
`;
  }
  if (which === "E") {
    return `${head}// Census env AND OFF override -> marker (so it reaches the synthesized bucket).
// Sentinel re-run -> a self-skip idiom that is NOT in the SKIP/SKIPPING net,
// no tally, no socket, and more than a second on the clock.
if ((process.env.LOCAL_RERANKER_URL || "").includes(":${sentinelPort}")) {
  process.stdout.write("bail out: fixture unavailable, self-test child E declines this run\\n");
  setTimeout(() => process.exit(0), 1200);
} else {
${selfTestCensusDirection("E")}}
`;
  }
  return `${head}// Census env -> marker. OFF override -> a non-UTF8 byte sequence on stdout and
// exit 0 after more than a second: output that cannot be read as any tally.
if (process.env.LOCAL_RERANKER_ENABLED === "0") {
  process.stdout.write(Buffer.from([0xff, 0xfe, 0xff, 0x00, 0xc0, 0x80]));
  setTimeout(() => process.exit(0), 1200);
} else {
${selfTestCensusDirection("F")}}
`;
}

function writeSelfTestChildren(sentinelPort) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rerank-hermeticity-selftest-"));
  const files = SELF_TEST_CHILDREN.map((which) => {
    const file = path.join(dir, `self-test-child-${which}.mjs`);
    writeFileSync(file, selfTestChildSource(which, sentinelPort), { mode: 0o600 });
    return file;
  });
  return { dir, files };
}

// --wait-quiet gating. These are exactly the files skipIfDaemonActive GATES
// on — imported from the helper, never copied — and the same 30s threshold; we
// wait for all of them to age past it (plus a margin) so the child does not
// skip itself the instant it starts. Waiting on the GATE tier and not the
// WATCHED tier is deliberate and matches the helper: the note-tier sources
// (captured-only, and the endogenous agent-runtime hooks the probe's own
// operator is writing) can never be waited out, so gating on them here would
// make --wait-quiet hang for its full budget for no benefit.
// READ-ONLY: statSync and nothing else. The daemon is never signalled.
const DAEMON_STATE_FILES = GATING_STATE_FILES;
const DAEMON_ACTIVE_THRESHOLD_MS = 30_000;
const QUIET_MARGIN_MS = 5_000;

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PROBE_PORT,
    sentinelPort: DEFAULT_SENTINEL_PORT,
    concurrency: 1,
    timeoutMs: 180_000,
    suites: null,
    waitQuiet: false,
    quietWaitMs: 900_000,
    breakPositiveControl: false,
    selfTestRanCheck: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--sentinel-port") opts.sentinelPort = Number(argv[++i]);
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--wait-quiet") opts.waitQuiet = true;
    else if (a === "--break-positive-control") opts.breakPositiveControl = true;
    else if (a === "--self-test-ran-check") opts.selfTestRanCheck = true;
    else if (a === "--quiet-wait-ms") opts.quietWaitMs = Number(argv[++i]);
    else if (a === "--suites") opts.suites = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else {
      process.stderr.write(`rerank-hermeticity-probe: unknown arg ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function refuse(msg) {
  process.stderr.write(`rerank-hermeticity-probe: REFUSING TO START — ${msg}\n`);
  process.exit(2);
}

// Is anything accepting connections on 127.0.0.1:<port>? A listening port
// would swallow the children's POSTs and turn the whole census into a silent
// false negative, so this is a hard precondition, not a warning.
function portIsListening(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, "127.0.0.1");
  });
}

// Youngest state-file age in ms, or Infinity when none exist. READ-ONLY.
function daemonQuietForMs() {
  let youngest = Infinity;
  for (const p of DAEMON_STATE_FILES) {
    try {
      const age = Date.now() - statSync(p).mtimeMs;
      if (age < youngest) youngest = age;
    } catch {
      // A state file that does not exist cannot make the daemon look active —
      // skipIfDaemonActive swallows the same stat error.
    }
  }
  return youngest;
}

async function awaitQuietWindow(maxWaitMs) {
  const need = DAEMON_ACTIVE_THRESHOLD_MS + QUIET_MARGIN_MS;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    if (daemonQuietForMs() >= need) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function runSuite(rel, env, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("node", [rel], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ rel, code: null, signal: null, spawnError: String(e && e.message), out, err, timedOut, ms: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ rel, code, signal, spawnError: null, out, err, timedOut, ms: Date.now() - started });
    });
  });
}

// THE RAN-CHECK. One question, one definition, one implementation: did this
// child run end-to-end, such that what it did or did not print is evidence of
// anything? Returns a reason string when the run is BLOCKED, or null when the
// caller may decide from the output.
//
// Every consumer calls this: classify() below (census pass), the markerRows
// loop (corroboration pass), the synthRows loop (sentinel pass), and both
// directions of runPositiveControl(). There is deliberately no second copy —
// a rule with two implementations is a rule with two behaviours.
//
// IT IS AN ALLOWLIST. There is exactly ONE route to a measured verdict, and it
// is the presence of evidence rather than the absence of a known failure: a
// tally that tallySignals() parsed and that counted at least one assertion.
// Everything else — every unrecognized ending, every silence, every shape
// nobody thought of — returns a reason and is UNMEASURED. An enumeration of
// failure shapes can only ever be as complete as the imagination of whoever
// wrote it, and each hole in it is a suite promoted to a verdict it did not
// earn; an allowlist's holes cost coverage instead, which is a bucket the
// census already prints and can act on.
//
// The specific detections below are REASON REFINEMENT, not decisions. They run
// ahead of the generic fallback so the census keeps its diagnostic wording (and
// so a run that tallied and THEN crashed stays blocked, exactly as before), but
// none of them is what makes a run measured. Elapsed time is not evidence that
// code ran and no longer appears here in any form.
function blockedReason(r) {
  const all = `${r.out}\n${r.err}`;
  if (r.timedOut) return `timed out after ${r.ms}ms`;
  if (r.spawnError) return `spawn error: ${r.spawnError}`;
  if (r.signal) return `killed by ${r.signal}`;
  if (all.includes(SKIP_MARKER)) return "skipIfDaemonActive skipped the file";
  if (NODE_FATAL_BANNER.test(all)) return `crashed (node fatal banner, exit=${r.code})`;

  // THE ONE ROUTE TO MEASURED. A parsed tally with a nonzero assertion count is
  // the child's own statement that it executed assertions; nothing else in a
  // child's output distinguishes work from silence.
  const sigs = tallySignals(all);
  if (sigs.some((s) => s.passed + s.failed > 0)) return null;

  // Everything below is blocked. The branches differ only in what they can tell
  // the reader about WHY, so the census's per-rule table stays legible.
  if (sigs.length > 0) {
    return `tally parsed but 0 passed / 0 failed — no assertion ran [${sigs.map((s) => s.form).join(", ")}]`;
  }
  if (SKIP_IDIOM_NET.test(all)) return "no tally, and a recognized skip idiom (SKIP/SKIPPING) in the output";
  return `no parsed tally with a nonzero assertion count (exit=${r.code}, ${r.ms}ms)`;
}

// Provisional classification from a single census run. A marker sighting wins
// outright even if the process later fell over — but it yields the PROVISIONAL
// bucket "MARKER", which the corroboration pass resolves into DIALS, NO-DIAL or
// UNMEASURED. Everything after that is blockedReason().
function classify(r) {
  const all = `${r.out}\n${r.err}`;
  if (all.includes(DIAL_MARKER)) return { bucket: "MARKER", why: "marker observed (awaiting corroboration)" };
  const blocked = blockedReason(r);
  if (blocked) return { bucket: "UNMEASURED", why: blocked };
  return { bucket: "NO-DIAL", why: `ran to completion, exit=${r.code}, no marker` };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    refuse(`--port ${opts.port} is not a valid TCP port`);
  }
  if (opts.port === LIVE_RERANKER_PORT) {
    refuse(
      `--port ${LIVE_RERANKER_PORT} is the LIVE rerank server. The probe needs a ` +
        `dead port; aiming it at the live daemon would measure nothing and load production.`,
    );
  }
  // Same rails for the sentinel port. It is BOUND rather than dialed, so aiming
  // it at the live daemon's port would not merely mismeasure — it would be an
  // attempt to bind over production.
  if (!Number.isInteger(opts.sentinelPort) || opts.sentinelPort < 1 || opts.sentinelPort > 65535) {
    refuse(`--sentinel-port ${opts.sentinelPort} is not a valid TCP port`);
  }
  if (opts.sentinelPort === LIVE_RERANKER_PORT) {
    refuse(
      `--sentinel-port ${LIVE_RERANKER_PORT} is the LIVE rerank server. The sentinel BINDS its ` +
        `port; the live daemon is never a measurement target and never a bind target.`,
    );
  }
  if (opts.sentinelPort === opts.port) {
    refuse(
      `--sentinel-port ${opts.sentinelPort} collides with the census port. The census port must ` +
        `stay CLOSED (that is what makes a marker evidence of a dial); the sentinel is LISTENING.`,
    );
  }
  if (await portIsListening(opts.sentinelPort)) {
    refuse(
      `something is already LISTENING on 127.0.0.1:${opts.sentinelPort}. The sentinel must own its ` +
        `port outright, or its connection counts would include someone else's traffic.`,
    );
  }
  if (typeof process.env.LOCAL_RERANKER_ENABLED === "string") {
    refuse(
      `LOCAL_RERANKER_ENABLED is set in the ambient env (=${JSON.stringify(process.env.LOCAL_RERANKER_ENABLED)}). ` +
        `The census must observe the DEFAULT resolution; unset it and re-run.`,
    );
  }
  if (typeof process.env.REQUIRE_HERMETIC === "string") {
    refuse(
      `REQUIRE_HERMETIC is set in the ambient env. It converts the daemon-active skip ` +
        `into a hard failure, which would hide the UNMEASURED bucket. Unset it and re-run.`,
    );
  }
  if (await portIsListening(opts.port)) {
    refuse(
      `something is LISTENING on 127.0.0.1:${opts.port}. A live listener would absorb the ` +
        `children's POSTs and every suite would look like NO-DIAL. Pick a closed port.`,
    );
  }

  // process.exit() does not run finally blocks, and this script exits from
  // several places, so temp-dir removal is registered here and drained by
  // finish() rather than relying on unwinding.
  const cleanups = [];
  const finish = (code) => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // best-effort; a leftover temp dir is not a census result.
      }
    }
    process.exit(code);
  };

  let domain = opts.suites || SUITES;
  let isSubset = Boolean(opts.suites);
  if (opts.selfTestRanCheck) {
    const st = writeSelfTestChildren(opts.sentinelPort);
    cleanups.push(() => rmSync(st.dir, { recursive: true, force: true }));
    domain = st.files;
    isSubset = true;
    process.stdout.write(
      `*** --self-test-ran-check: the domain is ${st.files.length} probe-owned synthetic children, not the registry.\n` +
        `    This is a falsification test of blockedReason(), not a census. EVERY child MUST land in\n` +
        `    UNMEASURED. A crashes under the OFF override having opened no socket; B self-skips under\n` +
        `    the sentinel re-run with a listed idiom; C exits 1 through its own handler with no banner\n` +
        `    and no tally; D exits 0 in total silence; E self-skips under the sentinel with an idiom\n` +
        `    outside the net; F writes non-UTF8 bytes and exits 0 — C through F all take more than a\n` +
        `    second, so no fast-exit heuristic can reach them. A build that books any of them as DIALS\n` +
        `    or NO-DIAL is deciding from the shapes of failure it happens to enumerate. ***\n\n`,
    );
  }
  const probeUrl = `http://127.0.0.1:${opts.port}`;

  const childEnv = { ...process.env, LOCAL_RERANKER_URL: probeUrl };

  process.stdout.write(`rerank-hermeticity-probe\n`);
  process.stdout.write(`  SUITES.length          = ${SUITES.length}\n`);
  process.stdout.write(`  domain probed          = ${domain.length}${isSubset ? "   *** SUBSET RE-PROBE (not a full census) ***" : "   (full registry)"}\n`);
  process.stdout.write(`  LOCAL_RERANKER_URL     = ${probeUrl}   (verified closed)\n`);
  process.stdout.write(`  sentinel port          = ${opts.sentinelPort}   (verified free; bound only for the sentinel pass)\n`);
  process.stdout.write(`  LOCAL_RERANKER_ENABLED = <unset>  (default resolution under test)\n`);
  process.stdout.write(`  REQUIRE_HERMETIC       = <unset>  (clean skip stays observable)\n`);
  process.stdout.write(`  concurrency            = ${opts.concurrency}, per-suite timeout ${opts.timeoutMs}ms\n`);
  process.stdout.write(`  wait-quiet             = ${opts.waitQuiet ? `on (up to ${opts.quietWaitMs}ms per suite, read-only polling)` : "off"}\n\n`);

  const rows = await mapWithConcurrency(domain, opts.concurrency, async (rel, i) => {
    if (opts.waitQuiet) {
      const quiet = await awaitQuietWindow(opts.quietWaitMs);
      if (!quiet) {
        process.stderr.write(`[${String(i + 1).padStart(3)}/${domain.length}] UNMEASURED no quiet window within ${opts.quietWaitMs}ms  ${rel}\n`);
        return { rel, bucket: "UNMEASURED", why: `no daemon-quiet window within ${opts.quietWaitMs}ms`, code: null, ms: 0 };
      }
    }
    const r = await runSuite(rel, childEnv, opts.timeoutMs);
    const c = classify(r);
    process.stderr.write(`[${String(i + 1).padStart(3)}/${domain.length}] ${c.bucket.padEnd(10)} ${rel}  (${r.ms}ms)\n`);
    return { rel, ...c, code: r.code, ms: r.ms };
  });

  // --- Corroboration pass -------------------------------------------------
  // Only the marker-showing suites, and only to answer: is this marker
  // dependent on the DEFAULT flag resolution, or does the suite manufacture it
  // itself? This is the ONE place LOCAL_RERANKER_ENABLED is set, and it is set
  // in a separate run that is never mixed into the census pass above.
  const markerRows = rows.filter((r) => r.bucket === "MARKER");
  if (markerRows.length > 0) {
    process.stdout.write(`--- corroboration pass: ${markerRows.length} marker suite(s) re-run with LOCAL_RERANKER_ENABLED="0" ---\n`);
    const offEnv = { ...childEnv, LOCAL_RERANKER_ENABLED: "0" };
    for (const row of markerRows) {
      if (opts.waitQuiet) await awaitQuietWindow(opts.quietWaitMs);
      const r2 = await runSuite(row.rel, offEnv, opts.timeoutMs);
      const stillMarked = `${r2.out}\n${r2.err}`.includes(DIAL_MARKER);
      // Ran-check FIRST, because the DIALS arm below is an inference from an
      // ABSENCE. A child that crashes under the OFF override before it could
      // dial also shows no marker, and reading that as "the marker disappeared
      // because the flag turned the backend off" books a suite into DIALS —
      // the actionable bucket — on the strength of a run that never happened.
      const blocked2 = blockedReason(r2);
      if (stillMarked) {
        // Presence decides however the child ended: the marker was printed, so
        // it was printed without the default resolution's help. A run that
        // crashed AFTER printing it still printed it.
        row.bucket = "NO-DIAL";
        row.synthesized = true;
        row.why = 'marker is TEST-SYNTHESIZED — it persists with LOCAL_RERANKER_ENABLED="0", so no socket depends on the default resolution';
      } else if (blocked2) {
        row.bucket = "UNMEASURED";
        row.synthesized = false;
        row.why = `corroboration pass BLOCKED (${blocked2}) — the marker is absent from a run that did not happen, which is not evidence that the marker was flag-dependent`;
      } else {
        row.bucket = "DIALS";
        row.why = 'marker is FLAG-DEPENDENT — it disappears with LOCAL_RERANKER_ENABLED="0", so default resolution selected the local backend and dialed';
      }
      const detail = stillMarked
        ? "marker persisted"
        : blocked2
          ? `marker gone, but BLOCKED: ${blocked2}`
          : "marker gone";
      process.stdout.write(`  ${row.rel} -> ${row.bucket} (${detail} under OFF override)\n`);
    }
    process.stdout.write("\n");
  }

  // --- Sentinel pass: SOCKET EVIDENCE for the synthesized bucket -----------
  // The corroboration pass has one known false negative. _logRerankDegradeOnce
  // dedupes per REASON per PROCESS, so a suite that first synthesizes a
  // `network` error (stubbed fetch, thrown LocalRerankUnavailableError) and
  // LATER really dials emits only the first line. Its marker therefore persists
  // under the OFF override and it is booked NO-DIAL/synthesized — even though a
  // socket was opened.
  //
  // String differencing cannot resolve that; only the socket can. So every
  // synthesized-bucket suite is re-run once more against a sentinel HTTP
  // listener THIS PROBE BINDS ITSELF, on a port it owns, counting accepted
  // connections and answering 500 (which the client turns into the usual typed
  // error, so the child still degrades reorder-only). An accepted connection is
  // a dial regardless of what any log line says, and reclassifies the suite to
  // DIALS. :8360 is never a legal sentinel port — the live daemon is never a
  // measurement target.
  const synthRows = rows.filter((r) => r.bucket === "NO-DIAL" && r.synthesized);
  process.stdout.write(
    `--- sentinel pass: SOCKET EVIDENCE for the ${synthRows.length} synthesized-marker suite(s) ---\n`,
  );
  if (synthRows.length === 0) {
    process.stdout.write(
      `  bucket is empty — no suite showed a marker that survived the OFF override, so there is\n` +
        `  nothing for the dedupe false-negative to hide. Pass skipped (not omitted).\n\n`,
    );
  } else {
    let accepted = 0;
    const perSuite = new Map();
    const sentinel = http.createServer((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"sentinel"}');
    });
    sentinel.on("connection", () => {
      accepted += 1;
    });
    await new Promise((resolve, reject) => {
      sentinel.once("error", reject);
      sentinel.listen(opts.sentinelPort, "127.0.0.1", resolve);
    });
    try {
      const sentinelUrl = `http://127.0.0.1:${opts.sentinelPort}`;
      process.stdout.write(`  sentinel listening on ${sentinelUrl} (probe-owned, counting accepted connections)\n`);
      const sentinelEnv = { ...process.env, LOCAL_RERANKER_URL: sentinelUrl };
      delete sentinelEnv.LOCAL_RERANKER_ENABLED; // default resolution, as in the census
      for (const row of synthRows) {
        if (opts.waitQuiet) await awaitQuietWindow(opts.quietWaitMs);
        const before = accepted;
        // runSuite's result is CONSUMED here, not discarded. Zero accepted
        // connections from a child that never ran is not an observation about
        // that child's sockets, and leaving the suite in NO-DIAL on it would be
        // the same absence-as-verdict error the corroboration pass just fixed.
        const r3 = await runSuite(row.rel, sentinelEnv, opts.timeoutMs);
        const n = accepted - before;
        const blocked3 = blockedReason(r3);
        perSuite.set(row.rel, n);
        let label;
        if (n > 0) {
          // An accepted connection is a dial regardless of how the child ended,
          // so this arm does not consult the ran-check: the socket already
          // happened.
          row.bucket = "DIALS";
          row.synthesized = false;
          row.why = `SOCKET EVIDENCE — ${n} connection(s) accepted by the probe-owned sentinel under default resolution, despite the marker persisting under the OFF override`;
          label = "RECLASSIFIED to DIALS";
        } else if (blocked3) {
          row.bucket = "UNMEASURED";
          row.synthesized = false;
          row.why = `sentinel pass BLOCKED (${blocked3}) — zero connections from a run that did not happen is not evidence that the suite does not dial`;
          label = `UNMEASURED — sentinel run blocked: ${blocked3}`;
        } else {
          // Stays where the corroboration pass left it. The claim is bounded by
          // what was observed: this run, under this resolution, opened nothing.
          label = "no connection observed under default resolution";
        }
        process.stdout.write(`  ${row.rel} -> ${n} connection(s) accepted  [${label}]\n`);
      }
    } finally {
      await new Promise((resolve) => sentinel.close(resolve));
    }
    process.stdout.write("\n");
  }

  const dials = rows.filter((r) => r.bucket === "DIALS");
  const noDial = rows.filter((r) => r.bucket === "NO-DIAL");
  const unmeasured = rows.filter((r) => r.bucket === "UNMEASURED");

  process.stdout.write(`\n=== census ===\n`);
  process.stdout.write(`domain      : ${domain.length}${isSubset ? " (SUBSET)" : " (= SUITES.length)"}\n`);
  process.stdout.write(`DIALS       : ${dials.length}\n`);
  process.stdout.write(`NO-DIAL     : ${noDial.length}\n`);
  process.stdout.write(`UNMEASURED  : ${unmeasured.length}   <- blocked, NOT evidence of not dialing\n`);
  process.stdout.write(`sum         : ${dials.length + noDial.length + unmeasured.length} (must equal ${domain.length})\n`);

  process.stdout.write(`\n--- DIALS (${dials.length}) ---\n`);
  for (const r of dials) process.stdout.write(`  ${r.rel}\n`);

  const synthesized = noDial.filter((r) => r.synthesized);
  process.stdout.write(`\n--- NO-DIAL, marker seen but TEST-SYNTHESIZED (${synthesized.length}) ---\n`);
  for (const r of synthesized) process.stdout.write(`  ${r.rel}   [${r.why}]\n`);

  process.stdout.write(`\n--- UNMEASURED (${unmeasured.length}) — blocked, re-probe in a quiet window ---\n`);
  for (const r of unmeasured) process.stdout.write(`  ${r.rel}   [${r.why}]\n`);

  // How much of the domain each blocking rule is deciding. The first row is the
  // ALLOWLIST DEFAULT — no rule fired, the child simply never stated an
  // assertion count — so its size is printed rather than left for the reader to
  // count. A large default class is a coverage statement about TALLY_FORMS, not
  // a finding about the suites: it means the corpus is printing counts in a
  // shape this file does not yet parse, or printing none at all. Widening
  // TALLY_FORMS is the response; loosening the ran-check is not.
  const blockClasses = [
    ["no parsed tally with a nonzero assertion count (allowlist default)", (w) => w.startsWith("no parsed tally with a nonzero assertion count")],
    ["tally parsed as 0 passed / 0 failed", (w) => w.startsWith("tally parsed but 0 passed / 0 failed")],
    ["skip idiom, no tally (secondary net)", (w) => w.startsWith("no tally, and a recognized skip idiom")],
    ["skipIfDaemonActive", (w) => w.startsWith("skipIfDaemonActive")],
    ["crashed / timed out / signalled / spawn error", (w) => /^(crashed|timed out|killed by|spawn error)/.test(w)],
    ["blocked in the corroboration pass", (w) => w.startsWith("corroboration pass BLOCKED")],
    ["blocked in the sentinel pass", (w) => w.startsWith("sentinel pass BLOCKED")],
    ["no daemon-quiet window", (w) => w.startsWith("no daemon-quiet window")],
  ];
  process.stdout.write(`\n--- UNMEASURED by blocking rule (which rule decided, and how much it is deciding) ---\n`);
  let classified = 0;
  for (const [label, pred] of blockClasses) {
    const n = unmeasured.filter((r) => pred(String(r.why))).length;
    classified += n;
    process.stdout.write(`  ${String(n).padStart(4)}  ${label}\n`);
  }
  process.stdout.write(`  ${String(unmeasured.length - classified).padStart(4)}  (unattributed — a block reason no class above matches)\n`);

  // Controls last, so the reader hits them after the numbers they qualify.
  let controlViolated = false;

  // Positive control: the probe-owned synthetic child, run in BOTH directions.
  // It is not part of `domain` and never enters the buckets — it qualifies the
  // classifier, it is not a datum of the census.
  const pc = await runPositiveControl(childEnv, opts.timeoutMs, opts.breakPositiveControl);
  if (!pc.ok) controlViolated = true;
  const pcVerdict = pc.ok ? "OK" : pc.blocked ? "BLOCKED" : "VIOLATED";
  process.stdout.write(
    `\nCONTROL ${pcVerdict} (positive): probe-owned synthetic child ` +
      `[mkdtemp, not a registered suite]\n` +
      `    flag unset (CAP resolves ON)  -> marker ${pc.onMarked ? "PRESENT" : "ABSENT"} (want PRESENT)  exit=${pc.onRun.code}  ran-check: ${pc.onBlocked || "ran"}\n` +
      `    LOCAL_RERANKER_ENABLED="0"    -> marker ${pc.offMarked ? "PRESENT" : "ABSENT"} (want ABSENT)   exit=${pc.offRun.code}  ran-check: ${pc.offBlocked || "ran"}\n`,
  );
  if (pc.blocked) {
    process.stdout.write(
      `    [a control direction was BLOCKED (${pc.blocked}). A control that could not run has\n` +
        `     validated nothing, so this exits 2 exactly as a violated control does — the buckets\n` +
        `     above are unqualified, not merely unconfirmed.]\n`,
    );
  }
  if (opts.breakPositiveControl) {
    process.stdout.write(
      `    [--break-positive-control: the OFF override was injected into the ON-direction env.\n` +
        `     A VIOLATED verdict here is the REQUIRED result — it proves the control is not vacuous.]\n`,
    );
  }
  if (domain.includes(NEGATIVE_CONTROL)) {
    const got = rows.find((r) => r.rel === NEGATIVE_CONTROL);
    const ok = got && got.bucket === "NO-DIAL";
    if (!ok) controlViolated = true;
    process.stdout.write(`CONTROL ${ok ? "OK" : "VIOLATED"} (negative): ${NEGATIVE_CONTROL} -> ${got ? got.bucket : "absent"} (want NO-DIAL)\n`);
  }
  if (controlViolated) {
    process.stdout.write(
      `\nA control was violated: the classifier is not discriminating, so the buckets above ` +
        `are not evidence. Fix the probe before reading them.\n`,
    );
    finish(2);
  }
  finish(0);
}

main();
