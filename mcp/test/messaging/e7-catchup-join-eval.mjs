// e7-catchup-join-eval.mjs — READ-ONLY population eval of the catch-up surface's
// PERSON-IDENTITY JOIN and its reciprocity branch mix, over the FULL deduped-thread
// population (never the visible top-N).
//
// NOT a node:test. It is a harness in the m7-live-eval.mjs / persona-eval.mjs mould:
// a plain .mjs so the registered SUITES list (run-all-tests.mjs) stays byte-identical
// and suite parity drift stays 0. It adds NOTHING to the scoring path — it observes
// the rows buildCatchup already emits.
//
// WHY: e7 round 1 established (F7-1) that a newsletter's reciprocity=0.7 is
// CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL — a DEFAULT for an unknown contact,
// not a measurement. F7-4 (the arithmetic decomposition) then pins recencyFactor's
// saturation at RECENCY_FLOOR as the dominant term. F7-5 is the falsifiable claim
// this harness exists to settle: if the person-identity join is returning nothing in
// production, then anchor / is_contact / cross-platform DM collapse ALL silently
// degrade to neutral and arrival time is all that is left. Three counts settle it:
//   - person_id non-null       (the N7 identity join: resolveFn(platform, sender_id))
//   - anchor_factor > 1        (the M1 enrichment join: enrichFn(dedupKey))
//   - enrichment.is_contact    (the M2 address-book join)
// plus the reciprocityStrength BRANCH HISTOGRAM (which of a..f each thread landed in).
//
// THESIS #1 / node invariants — READ-ONLY, and provably so:
//   - `projection: false` is passed to loadSourcesFromLedgers. The C1 projection
//     fast path persists derived cache files under storage/catchup-projection/ after
//     a full-stream serve; disabling it means this harness performs ZERO writes
//     anywhere under storage/ (or ledgers/, indices/, connectors/, policy/).
//   - The only path it ever writes is an explicit --out / --snapshot argument, which
//     the caller points OUTSIDE the repo (a scratchpad).
//   - No daemon is started, signalled or restarted. No git operation.
//
// SNAPSHOT MODE — the ledgers are appended to continuously by live daemons, so a
// naive before/after run measures ledger drift, not the code change. `--snapshot`
// freezes the loaded source rows + `now` to one file; `--sources <file>` replays it.
// A before/after rank-churn table MUST be produced from ONE snapshot on both sides.
//
// USAGE
//   node mcp/test/messaging/e7-catchup-join-eval.mjs --snapshot /tmp/x/snap.json
//   node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json \
//        --out /tmp/x/before.json
//   node mcp/test/messaging/e7-catchup-join-eval.mjs --churn /tmp/x/before.json \
//        --against /tmp/x/after.json
//
// ROUND 3 ADDS TWO MEASUREMENT MODES, both answering a question the source
// comments had previously ASSERTED:
//
//   --vouch-source  Which SPINE_SOURCE bought each `a_is_contact` row its tier?
//                   Iterates the SPINE_SOURCES REGISTRY itself (never a hardcoded
//                   list, so a future fourth source is covered automatically),
//                   normalizes every handle it returns through the SAME
//                   normalizeHandleKey the anchor uses, and joins that provenance
//                   map onto the population's vouched rows.
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json \
//          --vouch-source --out /tmp/x/vouch.json
//
//   --min-messages  The DECISION TABLE for REPLY_HISTORY_MIN_MESSAGES. Re-runs the
//                   FULL partitioned population once per N against ONE frozen
//                   snapshot and reports, per N, vouched rows / tier crossings in
//                   BOTH directions / rank churn up-down-unchanged. It CHOOSES
//                   NOTHING: the shipped default stays 1 and the table is for the
//                   operator to read.
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json \
//          --min-messages 1,2,3,5 --out /tmp/x/table.json
//
// ROUND 4 (e11) ADDS TWO MORE MODES AND ONE MISSING COLUMN:
//
//   --saturation        The recency floor as a POPULATION, not an anecdote: how
//                       many rows sit pinned at CATCHUP_CAPS.RECENCY_FLOOR, split
//                       by TIER and by CAUSE; the staleness-saturation age DERIVED
//                       BY BISECTION; the co-saturation band of the combined time
//                       term against its analytic value; and the adjacent-pair
//                       score-delta distribution — delta min/median/max plus the
//                       at-ulp-scale count, which is the RE-ENTRY DETECTOR for a
//                       near-tie band.
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json \
//          --saturation --out /tmp/x/sat.json
//
//   --score-resolution  RETIRED (f1). It measured an ordering grid that no longer
//                       exists; its final reading is stanza (14) below and is the
//                       evidence the grid was deleted on. Passing it now writes a
//                       line to stderr and exits non-zero — it never falls through
//                       to the default report. Its surviving measurement is
//                       --saturation's adjacent_pair_distribution.
//
// ROUND 5 (e17) ADDS TWO MORE MODES AND SPLITS THE DECOMPOSITION:
//
//   --time-term         The DECISION TABLE for rankScore's TIME TERM. Over ONE
//                       frozen population it publishes the score and time-term
//                       distribution by age bucket SPLIT BY TIER, the count of
//                       rows whose time term is below 0.1 at each end (and in the
//                       middle band, never summed into either end), and a
//                       candidate table — product baseline, recency-only,
//                       staleness-only, max, staleness-gated-on-directed — with
//                       churn in BOTH directions, tier crossings and entered/left.
//                       Like every table mode here it RE-RANKS EMITTED HEADS: it
//                       measures ORDERING churn, not HEAD churn.
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json \
//          --time-term --out /tmp/x/tt.json
//
//   --substance         What the CONTEXT-GATED SUBSTANCE RESCUE actually puts on
//                       the list: rows entering, rows leaving, the top-N delta in
//                       both directions, split by tier and by rescue reason, plus
//                       the rows the surface STILL drops (read from the build's own
//                       stats.dropped_low_substance).
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json \
//          --substance --out /tmp/x/sub.json
//
//   decompose()         SPLIT. It used to recover directedness x staleness as ONE
//                       residual; it now computes staleness from the row's own `ts`
//                       and reports `directed` alone, which is what makes a
//                       time-term candidate re-scorable. The field renamed from
//                       `decomp.directed_x_staleness` to `decomp.directed`.
//
//   head_changed        A NEW BUCKET IN EVERY CHURN REPORT. Until e11 churn
//                       compared RANK, SCORE and RECIPROCITY only — head identity
//                       was NEVER in scope. compareDesc is also the dedup
//                       HEAD-SELECTION key, so the same person at the same rank
//                       with the same score can be shown a different thread, and
//                       every other column would read "unchanged".
//
// ---------------------------------------------------------------------------
// MEASURED, ROUND 3 — one frozen snapshot of deduped threads, partitioned by
// source (the partitions sum to the combined run's after_dedup).
// Recorded here, at the seat that measured them, so the next reader inherits
// numbers instead of adjectives.
//
// SNAPSHOT IDENTITY (e9 stamp — no measurement removed, only identified). Every
// figure in this header comes from ONE frozen snapshot, and this is which one:
//
//     (snapshot identity — freeze time and per-source dev_ino / size / mtime_ms —
//     is printed by --snapshot and recorded with the run, not in the repo)
//
// Reproduce by FREEZING first, then reading only the frozen file:
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --snapshot /tmp/x/snap.json
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json \
//          --min-messages 1,2,3,5 --out /tmp/x/table.json
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json \
//          --vouch-source
// A snapshot is ~27 MB and lives outside the repo, so the INVOCATION is the durable
// artifact, not the file; the dev_ino/size/mtime_ms triple the snapshot records is
// what proves a later re-run read the same bytes (a path can be re-created underneath you).
//
// A SECOND SNAPSHOT, TAKEN LATER, DISAGREES ON ONE COLUMN — DRIFT, NOT REGRESSION.
//     Two sources had grown by a few KB; the other two were byte-identical.
// That run reports the SAME population (401), the SAME vouched counts (11 at N=1,
// 10 at N in {2,3,5}), and the SAME single downward crossing (`Example, Alex`) —
// but rank churn 14 up / 1 down / 386 unchanged, where the table in (2) below
// records 9 / 1 / 391. Rank churn counts rows that MOVED, so on an append-only
// ledger it is a function of WHEN the snapshot was taken, not of the code. BOTH
// readings are kept: (2) is the first snapshot's, and a later re-run that differs
// on the churn column alone has drifted, not regressed.
//
// (1) VOUCH PROVENANCE. All 11 relationship rows enter via classifyTier branch
//     (a) is_contact. Their vouching SPINE_SOURCES:
//         address-book+messaging-contacts 3 · messaging-contacts 4 ·
//         address-book 2 · reply-history 2.
//     `Example Harbour Hotel` is reply-history, NOT address-book: the operator
//     sent 24 outbound messages to reservations@example.com. Round 2's source
//     comment named the address book for this row and was wrong.
//
// (2) THE MIN-MESSAGES DECISION TABLE (baseline N=1, all 401 rows both sides):
//         N=1  vouched 11   up   0  down 0  unchanged 401  cross_in 0  cross_out 0
//         N=2  vouched 10   up   9  down 1  unchanged 391  cross_in 0  cross_out 1
//         N=3  vouched 10   up   9  down 1  unchanged 391  cross_in 0  cross_out 1
//         N=5  vouched 10   up   9  down 1  unchanged 391  cross_in 0  cross_out 1
//     The single crossing is always the same row and always DOWNWARD: `Example,
//     Alex` (alex.example@example.org, ONE outbound message) leaves the
//     relationship tier. The hotel is unaffected at every N (its count is 24).
//     REPLY_HISTORY_MIN_MESSAGES stays 1; the table is the operator's to act on.
//
// (3) F7-1/F7-4 — WHY A NEWSLETTER OUT-SCORES FAMILY, as arithmetic.
//     `--pair "Example|Dad" --report` on the same snapshot:
//         Example Test Prep (mail, tier unknown)  score 0.287984
//             recency 0.693168 · reciprocity 0.700 · anchor 1.0 · dir×stale 0.593515
//         Dad (imessage, tier relationship)      score 0.026250
//             recency 0.050000 · reciprocity 0.700 · anchor 1.5 · dir×stale 0.500000
//     The reciprocity terms are IDENTICAL and the anchor FAVOURS Dad. The entire
//     ~10.97x score gap is time: recency 13.86x against Dad (0.05 is exactly
//     CATCHUP_CAPS.RECENCY_FLOOR — Dad's thread is 34.8 days old, far past the
//     7-day RECENCY_WINDOW_MS, so the term is SATURATED at its floor and carries
//     no information beyond "older than a week"), times 1.19x on dir×stale,
//     divided by the 1.5x anchor. 13.86 × 1.187 ÷ 1.5 = 10.97. ✓
//     e17 ANNOTATION: `dir×stale` is a ROUND-3 field name. decompose() no longer
//     fuses those two — it reports `directed` alone — and stalenessFactor is no
//     longer a rankScore term at all, so a re-run of this pair prints a different
//     shape. The 10.97x arithmetic above is preserved as the round-3 reading.
//     RESIDUAL, NAMED AND NOT FIXED HERE: the recency term's saturation is the
//     dominant adverse factor for every relationship older than the window. Its
//     ratio (up to 1/RECENCY_FLOOR = 20x) is strictly wider than the whole range
//     of the reciprocity term (RELATIONSHIP_MAX / BROADCAST_FLOOR), which the
//     F7-4 tests in p2-reciprocity.test.mjs already pin. Tuning it is a separate
//     node; NO weight was changed here.
//
// (4) SCORE IS NOT RANK — both statements are true and not in conflict.
//     The rank order is catchup.js's ORDER_KEY_SEQUENCE, and the score key sits
//     BELOW the tier key and the M5b vouch in it. Example out-SCORES Dad (0.288 vs
//     0.026) while Dad out-RANKS Example (relationship+contact vs unknown).
//     `score` is a WITHIN-TIER key.
//
// (5) MOM IS TWO ROWS — MEASURED, AND DELIBERATELY NOT FIXED HERE.
//         imessage|Mom  rank 0  score 0.411132  handle 5555550123
//                       vouched by address-book+messaging-contacts
//         whatsapp|Mom  rank 2  score 0.026248  handle 100555010000009@lid
//                       vouched by messaging-contacts
//     `partition_stats` proves this is not a partitioning artifact: the per-
//     platform after_dedup values (125+272+4) sum EXACTLY to the combined run's
//     401, i.e. the combined build collapsed ZERO cross-platform DMs. The two Mom
//     rows carry different person_ids because no source links the WhatsApp @lid
//     handle to the phone number. That join belongs to the IDENTITY /
//     CONTACT-SPINE seat (contact-spine.js's union-find over saved-contact
//     records, which merges on a SHARED normalized handle) — not to this scoring
//     seam. A cross-platform merge added inside catchup.js would be a second,
//     divergent identity model. Reported and deferred, not patched.
//
// ---------------------------------------------------------------------------
// MEASURED, ROUND 4 (e11) — THE RECENCY FLOOR AND THE ORDER IT LEFT BEHIND.
//
// A DIFFERENT SNAPSHOT FROM ROUND 3. Every figure below comes from ONE freeze,
// and this is which one — nothing in this section may be compared against a
// ROUND-3 number without re-running both sides on one file:
//
//     (snapshot identity — freeze time and per-source dev_ino / size / mtime_ms —
//     is printed by --snapshot and recorded with the run, not in the repo)
//
// Reproduce by FREEZING first, then reading only the frozen file:
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --snapshot /tmp/x/snap.json
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json \
//          --saturation
// (The second command this round used, `--score-resolution`, was retired by f1
// with the grid it measured; the table below is preserved as the record.)
// The rank-churn column is a function of WHEN the snapshot was taken; a later
// re-run that differs on it alone has DRIFTED, not regressed (the precedent set
// by the round-3 note above, and it still holds).
//
// (6) THE PINNED POPULATION (`--saturation`, objective 1). 158 of 393 deduped
//     threads — 40.2% — sit with recencyFactor at exactly RECENCY_FLOOR.
//         relationship   6 of   9   (66.67%)
//         unknown      152 of 384   (39.58%)
//     BY CAUSE, and the two are never summed silently: age_past_window 158,
//     absent_or_non_finite_ts 0. The floor here is entirely the DESIGNED shape,
//     not missing timestamps — which is itself a finding, because the two guards
//     in recencyFactor return the same value for opposite reasons.
//
// (7) THE TWO ORDERING REGIMES (`--saturation`, objective 2). The
//     staleness-saturation age is DERIVED BY BISECTION from
//     CATCHUP_CAPS.STALENESS_HALFLIFE_MS — never written down — and lands at
//     4665600000 ms (54.0 days), where 1 - 2**(-age/H) reaches exactly 1 and one
//     millisecond below it is 0.9999999999999999. The pinned set straddles it
//     almost evenly: 79 rows past it, 79 inside it.
//     Walking the emitted order and keeping adjacent pairs that agree on tier and
//     on the saved-contact sub-key — the pairs the SCORE key actually decided —
//     gives 153 pinned pairs:
//         exact ties (already reach the ts tiebreak)          73
//         separated by a score difference                     80
//           delta min 3.47e-18 · median 1.37e-6 · max 8.44e-3
//           within 8 ulps of their operands       2  ( 2.50%)
//           above 8 ulps                         78  (97.50%)
//     THE EVIDENCE THAT DECIDES THE RESOLUTION: 97.5% of the separations are
//     bigger than the arithmetic could have invented. A median of 1.37e-6 on
//     scores of order 1.75e-2 is ~1e11 ulps — a real product of directedness x
//     staleness x reciprocity x anchor. Absorbing THOSE would discard signal.
//
// (8) THE RESOLUTION DECISION TABLE (round 4; the `--score-resolution` mode was
//     RETIRED by f1 and this stanza is now a historical record, not a recipe).
//     Baseline is the RAW FLOAT KEY (resolution 0), so the table reads the same
//     before and after the comparator change. absorbed / 80 separated adjacent
//     pinned pairs, then rank
//     churn up / down / unchanged, then tier crossings:
//         R=1e-15    4  ( 5.00%)     3 /  66 / 324    crossings 0   largest age inversion 138.98d
//         R=1e-12    9  (11.25%)     7 /  67 / 319    crossings 0   largest age inversion 138.98d
//         R=1e-9    18  (22.50%)    15 /  73 / 305    crossings 0   largest age inversion 148.36d
//         R=1e-6    39  (48.75%)    33 /  78 / 282    crossings 0   largest age inversion 158.90d
//         R=1e-3    76  (95.00%)   101 / 148 / 144    crossings 0   largest age inversion 140.14d
//     1e-9 IS KEPT, and the table is the argument: it covers the residue band
//     (largest separation within 8 ulps is ~1e-16, seven orders below the grid)
//     and stops there. 1e-6 and 1e-3 absorb 48.75% and 95%, moving 111 and 249 of
//     393 rows respectively — at that width the grid is discarding distinctions
//     the model expresses, not residue. 1e-12 leaves separations at 1e-13..1e-10
//     deciding order, five to eight orders below the ~1.8e-4 a two-decimal weight
//     change moves a pinned score by. THE COVERAGE FRACTION AT THE SHIPPED VALUE
//     IS 22.5% (18 of 80) — the same 22.5% that was quoted, from this snapshot, at
//     the constant's own seat in catchup.js while it still existed.
//     `--saturation` reports the same 153 / 73 / 80 / 18 on the raw-float ordering
//     and on the quantized one, so the fraction is a property of the population,
//     not a self-report of whichever comparator produced the order it walked.
//     The largest age inversion never goes away: score differences the model does
//     express still put older rows above newer ones, and that is the surface
//     working, not a residual.
//
// (9) THE BEFORE/AFTER, ONE FROZEN SNAPSHOT, BOTH SIDES (`--out` then `--churn`).
//     BEFORE was built from this instrumented harness against the UNCHANGED
//     comparator; AFTER from the same file against the quantized one:
//         population 393 -> 393    entered 0    left 0
//         rank        15 up · 73 down · 305 unchanged
//         rescored     0 up ·  0 down          (no score value moved)
//         tier_crossings                    0
//         head_identity_comparable       true
//         head_changed                      0
//     The 15/73/305 is IDENTICAL to the R=1e-9 row of (8), which is that mode's
//     mirror agreeing with the real build — the check its own bound asked for.
//     head_changed = 0 IS NOT VACUOUS ON THIS POPULATION: 143 of the 393 emitted
//     rows are collapsed dedup groups (1151 threads in total, the largest group
//     71 threads), so head selection ran on every one of them and chose the same
//     thread on both sides. LATENT IS NOT IMPOSSIBLE: compareDesc remains the
//     head-selection key, and a wider resolution would reach it. That is why the
//     bucket exists and is emitted even at zero.
//
// (10) THE DECLINED RE-WEIGHTING, WITH ITS ARITHMETIC (`--saturation`, objective
//     3). The proposal was to lean the relationship tier's time term on
//     stalenessFactor, since recency is pinned for 66.67% of that tier. Past
//     RECENCY_WINDOW_MS the staleness term is CO-SATURATED with recency: the
//     combined time term is confined to
//         measured  [0.04960984001133094, 0.05]        spread 0.7803%
//         analytic  [0.049609375,         0.05)        spread 0.7812%
//     — under one percent of its own value across the entire pinned set. A
//     staleness-leaning weight is therefore a near-uniform 1/RECENCY_FLOOR = 20x
//     rescale over that band; it restores NO ordering information, and the only
//     structure it would amplify is the float tail this round just stopped
//     ordering on. DECLINED, and recorded here so the next reader inherits the
//     arithmetic instead of re-proposing it. No weight was tuned and no constant
//     moved to make any named person rank higher.
//
//     e17 ANNOTATION — WHAT WAS DONE INSTEAD, so this note and round 5 do not
//     read as contradicting each other. (10) declined leaning ON stalenessFactor.
//     e17 went the other way and DELETED stalenessFactor from rankScore's product
//     entirely. The two readings agree on the arithmetic and differ only in which
//     direction it points: past the window the two time factors carry under 1% of
//     ordering information between them, so LEANING on staleness buys nothing —
//     and, e17 adds, MULTIPLYING by it costs something everywhere else, because
//     the same factor that is inert past the window is what zeroed the fresh end.
//     Nothing in (10) is retracted; the co-saturation band it measures is the same
//     band, and the `--saturation` mode still reports it, now labelled as a
//     measurement of a product the score no longer computes.
//
// ---------------------------------------------------------------------------
// MEASURED, ROUND 5 (e17) — THE TIME TERM, AND THE SUBSTANCE SEAT.
//
// A THIRD SNAPSHOT. Nothing below may be compared with a round-3 or round-4
// number without re-running both sides on one file:
//
//     (snapshot identity — freeze time and per-source dev_ino / size / mtime_ms —
//     is printed by --snapshot and recorded with the run, not in the repo)
//
// Reproduce by FREEZING first, then reading only the frozen file:
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --snapshot /tmp/x/snap.json
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json --time-term
//     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources /tmp/x/snap.json --substance
// (This round also ran `--score-resolution`; that mode was retired by f1 on the
// evidence in stanza (14). --saturation carries what survived of it.)
//
// (11) THE TIME-TERM CANDIDATE TABLE (`--time-term`). Every candidate scored from
//     the SAME decomposition over the SAME 401 rows; churn against the pre-e17
//     product; tier crossings 0, entered 0 and left 0 in every row:
//         candidate                     up/down/unchanged   <0.1 fresh/mid/stale
//         product (baseline)              0 /  0 / 401         28 /  6 / 164
//         recency-only  <- shipped      117 /265 /  19          0 /  6 / 164
//         staleness-only                202 /182 /  17         28 /  0 /   0
//         max(recency, staleness)       231 /165 /   5          0 /  0 /   0
//         staleness gated on `directed`   0 /  0 / 401         28 /  6 / 164
//     The product's own range over the population is min 0.0035, median 0.1040,
//     max 0.5488: the band-pass never gave any row more than 55% of a term whose
//     range is (0,1). recency-only is the ONLY candidate that empties the fresh
//     end without emptying the stale one. max() lifts both ends to a median of
//     0.9856 (min 0.7395) and stops carrying ordering information. The gated
//     candidate is inert because the min_score filter already opened its gate.
//
// (12) THE REAL BEFORE/AFTER, ONE FROZEN SNAPSHOT, BOTH CHECKOUTS. BEFORE was
//     produced by THIS harness against the pre-e17 lib (git 72218a8), AFTER by the
//     same harness against the shipped one:
//         population 398 -> 401     entered 3     left 0     tier_crossings 0
//         rank        127 up · 254 down · 17 unchanged
//         rescored    319 up ·   0 down
//         head_changed                        78   members_identical on all 78
//     THE HEAD COLUMN IS THE FINDING. compareDesc is also the dedup
//     HEAD-SELECTION key, so 78 people are now shown a DIFFERENT thread — the same
//     set of threads collapsed in every case and the head moved to the newer
//     message (a 56-thread group's head moved from 2.2 days old to 6 hours old).
//     A rank-churn table alone would have reported that as ordinary movement. The
//     3 entered rows are the substance rescue's, not the time term's.
//
// (13) THE SUBSTANCE SEAT (`--substance`). The context-gated rescue on the same
//     snapshot:
//         rescued 3 (+0.75%)   still dropped 48   left 0   tier crossings 0
//         by reason: vouch_is_contact 2 · answers_outbound 1
//         by tier:   relationship 2 · unknown 1
//         landing rank within partition: min 0 · median 3 · max 125
//         rows pushed OUT of the top 20: 0        head_swaps_possible: 0
//     The ungated alternative — keep every closer — would have admitted all 51.
//     The 48 it declines are rows whose only evidence is that a sender the operator
//     has never saved and never written to said a word.
//
// (14) THE ORDERING GRID, RE-MEASURED (round 5, via the now-retired
//     `--score-resolution`; this is the number that changed most, and it is the
//     evidence f1 deleted the grid on). With one time term the pinned band
//     collapses:
//         pinned at RECENCY_FLOOR                  164 of 401  (40.9%)
//         adjacent pinned pairs                    160
//           exact ties                             153
//           separated                                7  (2.0e-3 .. 1.84e-2)
//         absorbed by the grid at 1e-9               0  (0.00%)
//     Before e17 the same walk gave 153 pairs / 73 ties / 80 separated / 18
//     absorbed — the 22.5% coverage fraction quoted in round 4. It is now 0%, and
//     every grid from 1e-15 to 1e-6 is indistinguishable from the raw float key
//     (0 up / 0 down / 401 unchanged); only 1e-3 moves anything (9 / 10 / 382).
//
// (15) THE GRID IS GONE (f1). Round 5 kept the constant on the argument that a
//     mechanism absorbing nothing also costs nothing. f1 re-ran the same table on
//     a fresh freeze (a few more rows, the same pinned-pair / exact-tie /
//     separated shape at 2.0e-3..1.84e-2, 0 at ulp scale) and got the identical shape: 0 absorbed and 0/0/406 rank churn at
//     1e-15, 1e-12, 1e-9 and 1e-6, with only 1e-3 moving anything (8 / 7 / 391).
//     Two independent freezes, two rounds apart, both reading zero. The score key
//     is now the RAW SCORE under a totality clamp; the clamp — not the grid — is
//     what keeps compareDesc a consistent strict weak ordering on a degenerate
//     score, and it is written at the comparison site with that argument beside
//     it. `--score-resolution` was retired in the same change, because a mode
//     whose only output is "the thing I measure does not exist" is not an
//     instrument. What replaced it as the RE-ENTRY DETECTOR is --saturation's
//     adjacent_pair_distribution: delta_min/median/max and at_ulp_scale, which go
//     non-zero the moment a future factor re-opens a near-tie band, and which need
//     no grid to be chosen first. Measured before/after on the same frozen file:
//     0 rank moves up, 0 down, 0 tier crossings, 0 head changes.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  buildCatchup,
  loadSourcesFromLedgers,
  loadEnvelopesFromSources,
  buildHandlesByPerson,
  recencyFactor,
  stalenessFactor,
  rankScore,
  ADAPTER_REGISTRY,
  CATCHUP_CAPS,
  makeCompareDesc,
} from "../../lib/messaging/catchup.js";
import { ANCHOR_CAPS } from "../../lib/messaging/person-enrichment.js";
import { buildPersonIndex, lookup as personLookup } from "../../lib/messaging/identity.js";
import { SPINE_SOURCES, normalizeHandleKey } from "../../lib/messaging/contact-spine.js";
import { handlesForPerson } from "../../lib/messaging/contacts-anchor.js";
import { MEMORY_ROOT } from "../../lib/config.js";

// ---------------------------------------------------------------------------
// arg parsing (tiny, total).
// ---------------------------------------------------------------------------
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : true;
}

// ---------------------------------------------------------------------------
// IDENTITY, NOT NAMES — record dev:ino for every ledger path read, so a later
// reader can prove which bytes produced these numbers even if a path was
// re-created underneath it.
// ---------------------------------------------------------------------------
function ledgerIdentities(registry, root) {
  const out = [];
  for (const [platform, entry] of registry.entries()) {
    const abs = join(root, entry.ledgerPath);
    try {
      const st = statSync(abs);
      out.push({ platform, path: abs, dev_ino: `${st.dev}:${st.ino}`, size: st.size, mtime_ms: Math.round(st.mtimeMs) });
    } catch (e) {
      out.push({ platform, path: abs, dev_ino: null, error: e && e.code ? e.code : String(e) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// BRANCH LABELLER — a read-only MIRROR of reciprocityStrength's branch order, used
// ONLY to bucket rows for reporting. It is deliberately a separate function in the
// HARNESS (not an export from the scoring path): the scoring path must not grow an
// observability seam for a one-shot measurement. Kept in the same priority order as
// the grader so a mislabel is a visible divergence, not a silent one.
// ---------------------------------------------------------------------------
function branchOf(r) {
  const turns = Number.isFinite(r.turn_count) && r.turn_count > 0 ? r.turn_count : 0;
  const outbound = Number.isFinite(r.outbound_count) && r.outbound_count > 0 ? r.outbound_count : 0;
  const inbound = Number.isFinite(r.inbound_count) && r.inbound_count > 0 ? r.inbound_count : 0;
  const TURN_REL = CATCHUP_CAPS.RECIPROCITY_TURN_RELATIONSHIP;
  const BROADCAST_IN = CATCHUP_CAPS.RECIPROCITY_BROADCAST_INBOUND_MIN;
  const NEW_IN_MAX = CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_INBOUND_MAX;
  if (turns >= TURN_REL) return "a_relationship";
  if (turns >= 2) return "b_graded_relationship";
  if (turns <= 1 && outbound <= 1 && inbound >= BROADCAST_IN) return "c_broadcast";
  if (turns === 1 && outbound >= 1) return "d_established_low_turn";
  if (turns === 0 && inbound < NEW_IN_MAX) return "e_new_contact";
  return "f_graded_middle";
}

// ---------------------------------------------------------------------------
// F7-2 — TIER VOUCH ATTRIBUTION. classifyTier (person-enrichment.js) admits a row
// to TIER.RELATIONSHIP through ONE of three ordered branches; the emitted row does
// not say WHICH fired, and "the hotel is in the relationship tier" is not an
// answer until we know which vouch bought it. This reads classifyTier's OWN inputs
// back off the row — the same three signals buildCatchupCore passes it:
//   (a) is_contact === true                         -> row.enrichment.is_contact
//   (b) feedback_score > TIER_FEEDBACK_MIN          -> row.enrichment.feedback_score
//   (c) reciprocity_strength >= RELATIONSHIP_RECIP_MIN AND sender_kind === "person"
//                                                   -> row.reciprocity_strength
// (a) and (b) are reproduced EXACTLY. sender_kind is not surfaced on the emitted
// row, so (c) is attributed as the residual: a RELATIONSHIP row where neither (a)
// nor (b) fired can only have come from (c), and its reciprocity_strength must
// clear RELATIONSHIP_RECIP_MIN — if it does not, the row is reported as
// `mislabelled` rather than silently bucketed. This is a HARNESS mirror on
// purpose: the scoring path does not grow an observability seam for a one-shot
// measurement (same rule as branchOf above).
//
// CAVEAT recorded, not hidden: buildCatchupCore's dedup promotes a collapsed
// head's tier to the BEST tier across its members. This harness partitions by
// platform, so a promotion can only come from another thread of the SAME person on
// the SAME platform, whose signals are the same three read here.
// ---------------------------------------------------------------------------
function tierVouchOf(row) {
  const enr = row && typeof row.enrichment === "object" && row.enrichment !== null ? row.enrichment : {};
  const isContact = enr.is_contact === true;
  const feedback = Number.isFinite(enr.feedback_score) ? enr.feedback_score : 0;
  const recip = Number.isFinite(row.reciprocity_strength) ? row.reciprocity_strength : 0;
  if (row.tier !== "relationship") return "none_unknown_tier";
  if (isContact) return "a_is_contact";
  if (feedback > ANCHOR_CAPS.TIER_FEEDBACK_MIN) return "b_feedback";
  if (recip >= CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN) return "c_reciprocity_person";
  return "mislabelled_no_branch_fires";
}

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// e17 — WHICH TIME TERM IS ON DISK, ASKED OF rankScore ITSELF rather than read
// from a flag. This harness must decompose rows produced by EITHER build (the
// product time term recency x staleness, or the single-variable recency term
// e17 ships), and the two need different arithmetic to recover the residual.
// The probe is one call to the exported scorer on a JUST-ARRIVED row: under the
// product term stalenessFactor(0) === 0 zeroes the whole score, and under a
// single-variable recency term the same row scores strictly positive. No CAPS
// flag, no source parsing — the capability is read from the function.
// ---------------------------------------------------------------------------
const PROBE_NOW = 1700000000000;
const STALENESS_IS_A_RANK_TERM =
  rankScore({ lastInboundTs: PROBE_NOW, directed: 1, ageMs: 0, now: PROBE_NOW, reciprocated: true }) === 0;

// ---------------------------------------------------------------------------
// F7-1 / F7-4 — PER-FACTOR DECOMPOSITION of the emitted score, SPLIT (e17) SO A
// TIME-TERM CANDIDATE CAN BE RE-SCORED.
//
// Until e17 this recovered `directednessFactor(directed) * stalenessFactor(ageMs)`
// as ONE residual named `directed_x_staleness`. That is enough to EXPLAIN a pair
// and not enough to RE-SCORE one: a candidate that replaces the staleness half
// cannot be evaluated while the two halves are fused into a single number.
//
// The split is available because the staleness half is reconstructible from the
// digest's own `ts`: for a they-spoke-last row `rec.staleness.ms` (now - last_ts)
// and (now - lastInboundTs) are THE SAME QUANTITY — the finding recorded at the
// rankScore seat in catchup.js. So `staleness` is computed here by calling the
// surface's own exported stalenessFactor on (now - row.ts), and the residual is
// reported as `directed` ALONE, exactly recoverable as
//     score / (timeTerm * reciprocity * anchor)
// where timeTerm is `recency * staleness` on the pre-e17 build and `recency` on
// the shipped one (the probe above decides which, per report). `directed` is now
// the ONE factor the emitted row does not surface; every other field here is
// either read off the row (reciprocity, anchor) or recomputed by calling the
// surface's OWN factor on the row's own `ts`.
//
// THE BOUND — the same one the `--saturation` mode already states, repeated
// because this function now depends on it: staleness is reconstructed BY
// SUBTRACTION, whereas the pre-e17 scoring path PREFERRED the attention record's
// `rec.staleness.ms` when it carried one and fell back to exactly this
// subtraction otherwise. The two agree for a they-spoke-last thread except where
// plausibleTs clamped a corrupt `ts`, so `directed` is a reconstruction, not a
// read-back, and a row whose `ts` was clamped will carry a residual that absorbs
// the difference.
//
// ONE MORE THING THE RESIDUAL ABSORBS after e17's second seat: a row rescued by
// the substance gate carries `score = base * substanceFactor(s)`, and since
// substanceFactor is not recoverable from the emitted row either, it rides inside
// `directed` (bounded above by 1 there, since directedness <= 1 and the substance
// multiplier <= 1). That is the correct behaviour for --time-term, where the
// substance down-rank must ride along UNCHANGED across every candidate; it is a
// caveat for anyone reading `directed` as the classifier's own score, and such a
// row is identifiable by its `low_substance` flag in the same digest.
// ---------------------------------------------------------------------------
function decompose(row, now) {
  const recency = typeof row.ts === "number" ? recencyFactor(row.ts, now) : null;
  const staleness = typeof row.ts === "number" ? stalenessFactor(now - row.ts) : null;
  const recip = Number.isFinite(row.reciprocity_strength) ? row.reciprocity_strength : null;
  const anchor = Number.isFinite(row.anchor_factor) && row.anchor_factor > 1 ? row.anchor_factor : 1;
  // The time term of the build that PRODUCED this row (see the probe above).
  const timeTerm =
    recency === null ? null : (STALENESS_IS_A_RANK_TERM ? recency * staleness : recency);
  const known = timeTerm !== null && recip !== null ? timeTerm * recip * anchor : null;
  return {
    recency,
    // A MEASUREMENT of a candidate time term after e17, not a factor of the
    // shipped score. Kept because --time-term scores candidates from it.
    staleness,
    reciprocity: recip,
    anchor,
    // directednessFactor(directed) ALONE — the only unsurfaced factor left.
    directed: known && known !== 0 ? +(row.score / known).toFixed(6) : null,
  };
}

// ---------------------------------------------------------------------------
// e11 — HEAD IDENTITY HELPERS.
//
// shortSha: a report file must never carry message text, and a head-identity
// comparison does not need it — two heads whose last message hashes alike carried
// the same message. Absent content is null, never the hash of the empty string
// (which would make "no message" look like a specific message).
// ---------------------------------------------------------------------------
function shortSha(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// memberThreadIds: the collapsed dedup group's membership, order-independent —
// the head's own thread plus every also_waiting_on thread, sorted. A HEAD SWAP
// inside a group leaves this list IDENTICAL (the same threads, differently
// headed), which is precisely why head identity needs its own comparison and
// cannot be inferred from group membership or from group size.
function memberThreadIds(row) {
  const ids = [row && row.thread_id];
  for (const w of row && Array.isArray(row.also_waiting_on) ? row.also_waiting_on : []) {
    ids.push(w && w.thread_id);
  }
  return ids.filter((t) => typeof t === "string" && t.length > 0).sort();
}

function rowDigest(row, now, partition, rank) {
  return {
    // The emitted row's stable identity is `person` (person_id || person_name ||
    // the soft dedup key) — buildCatchupCore's own dedup head key. Prefixed by the
    // partition so a person present on two platforms stays two comparable rows.
    key: `${partition}|${row.person}`,
    // The RAW dedup key, kept unprefixed so --vouch-source can feed it to the
    // enricher's own handlesForPerson(person_id, handlesByPerson) — the identical
    // resolution makeContactsLookup performs — instead of re-deriving handles.
    person: row.person,
    partition,
    rank,
    platform: row.platform,
    thread_id: row.thread_id,
    thread_type: row.thread_type,
    name: row.person_name,
    person_id: row.person_id,
    tier: row.tier,
    score: row.score,
    recip: row.reciprocity_strength,
    anchor: row.anchor_factor,
    is_contact: !!(row.enrichment && row.enrichment.is_contact),
    turn_count: row.reciprocity ? row.reciprocity.turn_count : null,
    outbound_count: row.reciprocity ? row.reciprocity.outbound_count : null,
    inbound_count: row.reciprocity ? row.reciprocity.inbound_count : null,
    last_outbound_ts: row.reciprocity ? row.reciprocity.last_outbound_ts : null,
    inbound_since_last_outbound: row.reciprocity && "inbound_since_last_outbound" in row.reciprocity
      ? row.reciprocity.inbound_since_last_outbound
      : null,
    age_days: typeof row.ts === "number" ? +((now - row.ts) / DAY).toFixed(2) : null,
    // ---- e11 — HEAD IDENTITY, the fields this digest never carried. -------
    // compareDesc in catchup.js is BOTH the emitted-order key AND
    // buildCatchupCore's dedup HEAD-SELECTION key: the member of a dedup group
    // that sorts first BECOMES the head, and the head is what supplies platform,
    // thread_id, ts, last_msg, score, reciprocity, anchor, enrichment and persona
    // to the emitted row. Before e11 this digest carried rank, score and the
    // reciprocity counts and nothing else, so `churnReports` could only ever see
    // ORDERING and SCORING change — head identity was never in scope, and a
    // comparator change that swapped which thread of a person became the head
    // would have been reported as `unchanged`. The four fields below are what the
    // head_changed bucket compares; `group_size` and `member_thread_ids` are
    // reported alongside so a head swap can be told apart from a group that
    // gained or lost a member.
    ts: typeof row.ts === "number" ? row.ts : null,
    last_msg_sha: shortSha(row.last_msg),
    group_size: 1 + (Array.isArray(row.also_waiting_on) ? row.also_waiting_on.length : 0),
    member_thread_ids: memberThreadIds(row),
    branch: branchOf(row.reciprocity || {}),
    // ---- e17 — THE SUBSTANCE RESCUE, read off the row's OWN reason tokens.
    // buildCatchupCore pushes `low_substance` into `reasons` for a row N8 graded
    // a closer that this seat KEPT on context evidence (a saved-contact vouch, or
    // an inbound run that answers something the operator sent). The rescue REASON
    // is not a separate token — it is recoverable from fields the digest already
    // carries, and is recovered here in the SAME priority order the seat applies:
    // the vouch first, then the non-null last_outbound_ts. A row with neither is
    // not rescuable and never reaches the surface at all, so it cannot appear here.
    low_substance: Array.isArray(row.reasons) && row.reasons.includes("low_substance"),
    rescue_reason: !(Array.isArray(row.reasons) && row.reasons.includes("low_substance"))
      ? null
      : (row.enrichment && row.enrichment.is_contact === true
          ? "vouch_is_contact"
          : (row.reciprocity && typeof row.reciprocity.last_outbound_ts === "number"
              ? "answers_outbound"
              : "unattributed")),
    // F7-2 — which classifyTier branch bought this row its tier.
    tier_vouch: tierVouchOf(row),
    // F7-3/F7-5 — the N7 identity join's own fallback. dedupKey is personId when
    // resolveFn returned one, else the SOFT `${platform}:${sender_id}` key, so
    // person_id === null is EXACTLY "this row fell back to the soft key".
    soft_key_fallback: !(typeof row.person_id === "string" && row.person_id.length > 0),
    // F7-1/F7-4 — the arithmetic, per row.
    decomp: decompose(row, now),
  };
}

// ---------------------------------------------------------------------------
// CHURN — the population-level before/after judgement. Reports BOTH directions
// (moved up, moved down, unchanged) plus tier-boundary crossings, and the rows
// that entered/left the population. Never summarised as "improved".
// ---------------------------------------------------------------------------
function churn(beforePath, afterPath) {
  return churnReports(
    JSON.parse(readFileSync(beforePath, "utf8")),
    JSON.parse(readFileSync(afterPath, "utf8")),
  );
}

// churnReports — the SAME comparison, over already-in-memory reports. Split out
// (not re-implemented) so the --min-messages sweep can reuse the exact churn
// arithmetic the before/after CLI mode uses; `churn(pathA, pathB)` is now a thin
// file-reading wrapper over it and its output is unchanged.
//
// e11 — WHAT THIS COMPARISON COVERED, AND WHAT IT DID NOT. Until e11 it compared
// RANK, SCORE and RECIPROCITY (plus tier crossings and the entered/left sets) and
// nothing else. That is a complete reading of ORDERING and of SCORING, and it is
// NOT a complete reading of the emitted surface: compareDesc is also the dedup
// HEAD-SELECTION key, so the same person, at the same rank, with the same score,
// can be shown a DIFFERENT thread — different platform, different timestamp,
// different message — and every column above would read "unchanged". The
// head_changed bucket closes that gap; it is emitted even when it is 0, because a
// zero is a finding and an absent field is indistinguishable from a report that
// never looked.
function churnReports(before, after) {
  const bIdx = new Map(before.rows.map((r) => [r.key, { r, i: r.rank }]));
  const aIdx = new Map(after.rows.map((r) => [r.key, { r, i: r.rank }]));
  let up = 0, down = 0, same = 0;
  const tierCross = [];
  const moved = [];
  // A rank-churn table alone can hide a change: a row's SCORE can move without its
  // position moving. Both are reported, in both directions.
  const rescored = [];
  const headChanged = [];
  // A report written before the head-identity fields existed cannot be compared on
  // them; saying so is the honest answer, and is not the same as reporting 0.
  const headComparable =
    before.rows.every((r) => r !== null && typeof r === "object" && "last_msg_sha" in r) &&
    after.rows.every((r) => r !== null && typeof r === "object" && "last_msg_sha" in r);
  for (const [key, a] of aIdx.entries()) {
    const b = bIdx.get(key);
    if (!b) continue;
    if (
      headComparable &&
      (a.r.platform !== b.r.platform ||
        a.r.thread_id !== b.r.thread_id ||
        a.r.ts !== b.r.ts ||
        a.r.last_msg_sha !== b.r.last_msg_sha)
    ) {
      headChanged.push({
        key,
        name: a.r.name,
        rank_before: b.i,
        rank_after: a.i,
        group_size_before: b.r.group_size,
        group_size_after: a.r.group_size,
        // TRUE => the same set of threads collapsed and only the CHOICE of head
        // moved. FALSE => the group itself changed, so the head change is a
        // consequence of membership, not of the comparator.
        members_identical:
          JSON.stringify(b.r.member_thread_ids || null) === JSON.stringify(a.r.member_thread_ids || null),
        before: { platform: b.r.platform, thread_id: b.r.thread_id, ts: b.r.ts, last_msg_sha: b.r.last_msg_sha, score: b.r.score },
        after: { platform: a.r.platform, thread_id: a.r.thread_id, ts: a.r.ts, last_msg_sha: a.r.last_msg_sha, score: a.r.score },
      });
    }
    if (a.r.score !== b.r.score || a.r.recip !== b.r.recip) {
      rescored.push({ key, name: a.r.name, tier: a.r.tier, rank: a.r.rank, score_before: b.r.score, score_after: a.r.score, recip_before: b.r.recip, recip_after: a.r.recip, branch: a.r.branch, is_contact: a.r.is_contact });
    }
    const d = b.i - a.i; // positive => moved UP the list
    if (d > 0) up += 1; else if (d < 0) down += 1; else same += 1;
    if (d !== 0) moved.push({ key, name: a.r.name, from: b.i, to: a.i, delta: d, score_before: b.r.score, score_after: a.r.score, recip_before: b.r.recip, recip_after: a.r.recip, branch_before: b.r.branch, branch_after: a.r.branch });
    if (b.r.tier !== a.r.tier) tierCross.push({ key, name: a.r.name, from: b.r.tier, to: a.r.tier });
  }
  const entered = [...aIdx.keys()].filter((k) => !bIdx.has(k));
  const left = [...bIdx.keys()].filter((k) => !aIdx.has(k));
  moved.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return {
    population_before: before.rows.length,
    population_after: after.rows.length,
    moved_up: up,
    moved_down: down,
    unchanged: same,
    entered: entered.length,
    left: left.length,
    tier_crossings: tierCross,
    rescored_up: rescored.filter((r) => r.score_after > r.score_before).length,
    rescored_down: rescored.filter((r) => r.score_after < r.score_before).length,
    rescored,
    // e11 — HEAD IDENTITY. `head_identity_comparable: false` means one side of the
    // comparison predates the fields and the question was not asked; a 0 with
    // `head_identity_comparable: true` means it was asked and the answer was none.
    head_identity_comparable: headComparable,
    head_changed_count: headComparable ? headChanged.length : null,
    head_changed: headChanged,
    moved,
    branch_before: before.branch_histogram,
    branch_after: after.branch_histogram,
    join_before: before.join,
    join_after: after.join,
    tier_vouch_before: before.tier_vouch_histogram,
    tier_vouch_after: after.tier_vouch_histogram,
  };
}

// ---------------------------------------------------------------------------
// THE POPULATION, NOT THE FOLD. buildCatchupCore clamps `limit` at
// CATCHUP_CAPS.MAX_LIMIT, so ONE combined call can only ever express 500 of the
// deduped threads (stats.truncated === true). To cover EVERY deduped thread we
// PARTITION by the `platforms` DATA filter — a membership test the tool already
// supports, not a re-implementation of ranking — and let the tool rank each
// partition itself. The partitions are exhaustive and disjoint (their after_dedup
// values sum to the combined run's after_dedup, which is itself the measurement
// that NO cross-platform DM collapse is occurring). Ranks are therefore
// WITHIN-partition, which is what a rank-churn table needs.
//
// `anchorOpt` is passed VERBATIM to buildCatchup's own `anchor` seam: `true` is
// the production wiring, and an options object is the hermetic/parameterised one
// (e.g. { contacts: { noMemo, spine: { force, minMessages } } }). The harness
// never builds an enricher itself — it drives the seam the surface already has.
// ---------------------------------------------------------------------------
async function buildPopulation({ sources, now, identities, anchorOpt = true }) {
  const combined = await buildCatchup({ sources, now, limit: CATCHUP_CAPS.MAX_LIMIT, anchor: anchorOpt });
  const partitions = Array.isArray(combined.stats && combined.stats.platforms) ? combined.stats.platforms : [];

  const rows = [];
  const partitionStats = {};
  for (const p of partitions) {
    const res = await buildCatchup({ sources, now, limit: CATCHUP_CAPS.MAX_LIMIT, platforms: [p], anchor: anchorOpt });
    partitionStats[p] = { after_dedup: res.stats.after_dedup, returned: res.rows.length, truncated: res.stats.truncated };
    res.rows.forEach((r, i) => rows.push(rowDigest(r, now, p, i)));
  }

  const hist = {};
  for (const r of rows) hist[r.branch] = (hist[r.branch] || 0) + 1;
  const vouchHist = {};
  for (const r of rows) vouchHist[r.tier_vouch] = (vouchHist[r.tier_vouch] || 0) + 1;

  return {
    now,
    ledger_identities: identities,
    stats: combined.stats,
    partition_stats: partitionStats,
    population: rows.length,
    join: {
      person_id_non_null: rows.filter((r) => typeof r.person_id === "string" && r.person_id.length > 0).length,
      anchor_gt_1: rows.filter((r) => Number.isFinite(r.anchor) && r.anchor > 1).length,
      is_contact_true: rows.filter((r) => r.is_contact === true).length,
      tier_relationship: rows.filter((r) => r.tier === "relationship").length,
      // F7-3/F7-5 — the count that settles whether the identity join returns
      // anything at all in production. person_id_non_null + soft_key_fallback
      // partitions the population exactly.
      soft_key_fallback: rows.filter((r) => r.soft_key_fallback === true).length,
    },
    branch_histogram: hist,
    // F7-2 — which classifyTier vouch admitted each relationship row.
    tier_vouch_histogram: vouchHist,
    rows,
  };
}

// ---------------------------------------------------------------------------
// F7-2 (round 3) — VOUCH PROVENANCE, READ BACK THROUGH THE REGISTRY.
//
// Round 2 asserted in a source comment that a saved business reached
// TIER.RELATIONSHIP through "the operator's own saved contacts", i.e. the address
// book. That was never measured: the spine unions THREE readers and the emitted
// row only says `is_contact: true`. This builds the missing map.
//
// METHOD, and why each step is the reused seam rather than a new one:
//   1. Iterate SPINE_SOURCES ITSELF — never a hardcoded ["address-book", ...].
//      A fourth source appended to the registry is measured automatically, which
//      is the whole point of the registry being open/closed.
//   2. Call each entry's read() ONCE with the same opts shape buildContactSpine
//      passes, and normalize every returned handle through contact-spine.js's
//      normalizeHandleKey — the SAME normalizer whose key shape the anchor's
//      isContact lookup joins on (pinned by the m2 "no dead keys" test). A
//      hand-rolled normalizer here would measure a different join than the one
//      that ran.
//   3. Resolve each vouched row's handles with contacts-anchor.js's OWN
//      handlesForPerson over buildHandlesByPerson's map — literally the pair
//      makeContactsLookup used to decide is_contact for that row.
//
// A row whose handles hit NO source is reported as `unattributed`, not silently
// bucketed: that is the honest label for "the anchor said contact, and this
// reconstruction cannot say which reader supplied the handle" (e.g. the anchor's
// non-spine base builder, or a handle-shape the row carries but the map does not).
// ---------------------------------------------------------------------------
async function sourceKeysByHandle(spineOpts = {}) {
  const map = new Map();
  const perSource = {};
  for (const src of SPINE_SOURCES) {
    let rows = [];
    try {
      rows = await src.read(spineOpts);
    } catch (e) {
      perSource[src.key] = { records: 0, handles: 0, error: e && e.code ? e.code : String(e) };
      continue;
    }
    let handles = 0;
    for (const rec of Array.isArray(rows) ? rows : []) {
      for (const h of rec && Array.isArray(rec.handles) ? rec.handles : []) {
        const key = normalizeHandleKey(h);
        if (key === null) continue;
        handles += 1;
        let arr = map.get(key);
        if (arr === undefined) {
          arr = [];
          map.set(key, arr);
        }
        if (!arr.includes(src.key)) arr.push(src.key);
      }
    }
    perSource[src.key] = { records: Array.isArray(rows) ? rows.length : 0, handles };
  }
  return { map, perSource };
}

async function vouchSourceReport({ sources, now, identities }) {
  const report = await buildPopulation({ sources, now, identities, anchorOpt: true });

  // The enricher's own handle map, rebuilt from the SAME envelopes and the SAME
  // N7 resolver buildCatchup builds internally (REUSE — loadEnvelopesFromSources /
  // buildPersonIndex / buildHandlesByPerson are the surface's own functions).
  const envelopes = await loadEnvelopesFromSources(sources, ADAPTER_REGISTRY);
  let resolvePerson = () => null;
  try {
    const index = buildPersonIndex(envelopes);
    resolvePerson = (platform, senderId) => {
      try {
        return personLookup(index, platform, senderId);
      } catch {
        return null;
      }
    };
  } catch {
    resolvePerson = () => null;
  }
  const handlesByPerson = buildHandlesByPerson(envelopes, resolvePerson);

  const { map, perSource } = await sourceKeysByHandle({});

  const hist = {};
  const vouchedRows = [];
  for (const r of report.rows) {
    if (r.tier_vouch !== "a_is_contact") continue;
    const raw = handlesForPerson(r.person, handlesByPerson);
    const keys = raw.map((h) => normalizeHandleKey(h)).filter((k) => k !== null);
    const hit = [];
    for (const k of keys) {
      for (const s of map.get(k) || []) if (!hit.includes(s)) hit.push(s);
    }
    hit.sort();
    const label = hit.length === 0 ? "unattributed" : hit.join("+");
    hist[label] = (hist[label] || 0) + 1;
    vouchedRows.push({
      key: r.key,
      name: r.name,
      partition: r.partition,
      rank: r.rank,
      tier: r.tier,
      score: r.score,
      person: r.person,
      handles_raw: raw,
      handles_normalized: keys,
      vouch_sources: hit,
      vouch_source_label: label,
    });
  }

  return {
    now: report.now,
    population: report.population,
    partition_stats: report.partition_stats,
    tier_vouch_histogram: report.tier_vouch_histogram,
    spine_source_keys: SPINE_SOURCES.map((s) => s.key),
    spine_source_stats: perSource,
    spine_handles_indexed: map.size,
    vouched_rows: vouchedRows.length,
    vouch_source_histogram: hist,
    rows: vouchedRows,
  };
}

// ---------------------------------------------------------------------------
// THE DECISION TABLE for REPLY_HISTORY_MIN_MESSAGES — published, not applied.
//
// For each N, the FULL partitioned population is rebuilt against the SAME frozen
// snapshot, with the threshold injected through seams that already exist:
//   anchor: { contacts: { noMemo: true, spine: { force: true, minMessages: N } } }
// `noMemo` bypasses buildContactAnchorIndex's per-process memo and `force`
// bypasses buildContactSpine's, so each N genuinely re-reads rather than
// returning the first N's cached index. Every N is compared to N=1 (the shipped
// default) with the harness's OWN churn arithmetic, in BOTH directions.
//
// This mode changes nothing. The shipped default stays 1; the table is evidence
// for the operator to decide with.
// ---------------------------------------------------------------------------
async function minMessagesTable({ sources, now, identities, list }) {
  const runs = [];
  const reports = new Map();
  for (const n of list) {
    const rep = await buildPopulation({
      sources,
      now,
      identities,
      anchorOpt: { contacts: { noMemo: true, spine: { force: true, minMessages: n } } },
    });
    reports.set(n, rep);
    runs.push({
      min_messages: n,
      population: rep.population,
      is_contact_true: rep.join.is_contact_true,
      tier_relationship: rep.join.tier_relationship,
      vouch_a_is_contact: rep.tier_vouch_histogram.a_is_contact || 0,
      vouch_b_feedback: rep.tier_vouch_histogram.b_feedback || 0,
      vouch_c_reciprocity_person: rep.tier_vouch_histogram.c_reciprocity_person || 0,
    });
  }

  const baseN = list[0];
  const base = reports.get(baseN);
  const table = [];
  for (const n of list) {
    const c = churnReports(base, reports.get(n));
    const up = c.tier_crossings.filter((t) => t.from !== "relationship" && t.to === "relationship");
    const down = c.tier_crossings.filter((t) => t.from === "relationship" && t.to !== "relationship");
    table.push({
      min_messages: n,
      baseline: baseN,
      ...runs.find((r) => r.min_messages === n),
      rank_moved_up: c.moved_up,
      rank_moved_down: c.moved_down,
      rank_unchanged: c.unchanged,
      rescored_up: c.rescored_up,
      rescored_down: c.rescored_down,
      tier_crossings_total: c.tier_crossings.length,
      tier_crossings_into_relationship: up.length,
      tier_crossings_out_of_relationship: down.length,
      tier_crossings: c.tier_crossings,
      entered: c.entered,
      left: c.left,
    });
  }
  return {
    now,
    baseline_min_messages: baseN,
    shipped_default_unchanged: true,
    note:
      "REPLY_HISTORY_MIN_MESSAGES is NOT changed by this run. This table is published for the operator to choose from.",
    runs: table,
  };
}


// ---------------------------------------------------------------------------
// e11 — SHARED MEASUREMENT PRIMITIVES for --saturation (and, until f1 retired it,
// for --score-resolution).
// Both modes read the SAME frozen population buildPopulation already produces;
// neither rebuilds it a second way and neither adds a seam to the scoring path.
// ---------------------------------------------------------------------------

// ULP SCALE — the bound this harness calls "float residue", stated once at the
// seat that applies it. rankScore is a PRODUCT of five factors, so each of the
// four multiplications rounds once and the worst-case relative error of the
// product is about 5 * 2**-53 ~= 5.6e-16 of the larger operand. ULP_ENVELOPE is
// that bound rounded up to a power of two: a separation at or below
// ULP_ENVELOPE ulps of the larger operand is arithmetic noise, and a separation
// above it is a difference the five factors genuinely produced. Every "is this
// float residue?" claim in the e11 report is this comparison and nothing else.
const ULP_ENVELOPE = 8;
function ulpScaleOf(a, b) {
  return Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * ULP_ENVELOPE;
}

function medianOf(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((x, y) => x - y);
  const m = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// A row is PINNED when recencyFactor returns exactly the floor for it — the same
// call the scoring path makes, on the row's own `ts` and the snapshot's own `now`,
// so this is a reproduction and not an estimate.
function isPinned(row, now) {
  return recencyFactor(row.ts, now) === CATCHUP_CAPS.RECENCY_FLOOR;
}

// recencyFactor has exactly TWO returns of the floor, and they mean opposite
// things: one is the DESIGNED shape (a thread older than the window), the other is
// MISSING DATA wearing the same value (no usable timestamp at all). They are never
// summed silently. `unexplained` exists so a row that is pinned for neither reason
// is reported rather than bucketed into whichever label is nearest.
function pinnedCause(row, now) {
  if (typeof row.ts !== "number" || !Number.isFinite(row.ts)) return "absent_or_non_finite_ts";
  if (typeof now !== "number" || !Number.isFinite(now)) return "absent_or_non_finite_ts";
  if (now - row.ts >= CATCHUP_CAPS.RECENCY_WINDOW_MS) return "age_past_window";
  return "unexplained";
}

// THE STALENESS-SATURATION AGE, DERIVED BY BISECTION and never written down: the
// smallest age at which 1 - 2**(-age/H) evaluates to exactly 1 in IEEE-754 double.
// BELOW it the staleness tail is still representable and separates two otherwise
// identical rows by a residue; AT OR ABOVE it the tail underflows and their scores
// collide exactly. Bisected from the CAPS half-life so this measurement tracks the
// constant instead of hard-coding whatever age it currently works out to.
function stalenessSaturationAgeMs() {
  let hi = CATCHUP_CAPS.STALENESS_HALFLIFE_MS;
  while (stalenessFactor(hi) < 1) hi *= 2;
  let lo = Math.floor(hi / 2);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (stalenessFactor(mid) < 1) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ADJACENT PAIRS THE SCORE KEY DECIDED. Walks each partition in EMITTED rank order
// and keeps consecutive pairs that agree on everything compareDesc consults BEFORE
// score (tier, then the saved-contact sub-key) — for those, and only those, the
// score comparison is what put one above the other. `pinnedOnly` further restricts
// to pairs where BOTH rows sit at the recency floor, which is the population e11
// objective 2 is about.
function adjacentScorePairs(rows, now, { pinnedOnly = false } = {}) {
  const byPartition = new Map();
  for (const r of rows) {
    let arr = byPartition.get(r.partition);
    if (arr === undefined) {
      arr = [];
      byPartition.set(r.partition, arr);
    }
    arr.push(r);
  }
  const pairs = [];
  for (const [partition, arr] of byPartition.entries()) {
    const ordered = [...arr].sort((x, y) => x.rank - y.rank);
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const above = ordered[i];
      const below = ordered[i + 1];
      if (above.tier !== below.tier) continue;
      if ((above.is_contact === true) !== (below.is_contact === true)) continue;
      if (pinnedOnly && !(isPinned(above, now) && isPinned(below, now))) continue;
      const delta = Math.abs(above.score - below.score);
      pairs.push({
        partition,
        tier: above.tier,
        is_contact: above.is_contact === true,
        above: { name: above.name, thread_id: above.thread_id, age_days: above.age_days, score: above.score },
        below: { name: below.name, thread_id: below.thread_id, age_days: below.age_days, score: below.score },
        score_delta: delta,
        at_ulp_scale: delta <= ulpScaleOf(above.score, below.score),
        age_inversion_days:
          typeof above.age_days === "number" && typeof below.age_days === "number" && above.age_days > below.age_days
            ? +(above.age_days - below.age_days).toFixed(2)
            : 0,
      });
    }
  }
  return pairs;
}

// THE RE-ENTRY DETECTOR for the near-tie band. `separated` are the pairs whose
// scores differ at all; `exact_ties` already reach the explicit ts tiebreak
// without any help. delta_min / median / max and `at_ulp_scale` say HOW FAR apart
// the separated pairs are, in absolute terms and relative to the float precision
// of their own operands — no resolution parameter required, and none accepted.
//
// f1 RETIRED THE RESOLUTION KEYS (`resolution`, `absorbed_below_resolution`,
// `residue_coverage_pct`) along with the ordering grid they described. The
// measurement that mattered survives: if a future factor re-opens a band where
// adjacent pinned pairs are separated by float residue, `at_ulp_scale` goes
// non-zero and delta_min collapses toward the ulp scale. That is the signal, and
// it is readable without choosing a grid first.
function deltaDistribution(pairs) {
  const separated = pairs.filter((p) => p.score_delta > 0);
  const deltas = separated.map((p) => p.score_delta);
  const atUlp = separated.filter((p) => p.at_ulp_scale);
  return {
    pairs_total: pairs.length,
    exact_ties: pairs.length - separated.length,
    separated: separated.length,
    delta_min: deltas.length ? Math.min(...deltas) : null,
    delta_median: medianOf(deltas),
    delta_max: deltas.length ? Math.max(...deltas) : null,
    at_ulp_scale: atUlp.length,
    at_ulp_scale_pct: separated.length ? +((100 * atUlp.length) / separated.length).toFixed(4) : null,
    above_ulp_scale: separated.length - atUlp.length,
    above_ulp_scale_pct: separated.length
      ? +((100 * (separated.length - atUlp.length)) / separated.length).toFixed(4)
      : null,
    smallest_separations: separated
      .slice()
      .sort((x, y) => x.score_delta - y.score_delta)
      .slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// --saturation — THE RECENCY FLOOR, MEASURED (e11 objectives 1, 2 and 3).
//
// Reuses buildPopulation and rowDigest verbatim: no new build path, no new
// scoring-path seam. Everything below is a reading of the rows buildCatchup
// already emitted for the frozen snapshot.
//
//   (a) how many rows sit with recencyFactor pinned at exactly RECENCY_FLOOR,
//       as a count and a fraction, SPLIT BY TIER;
//   (b) the CAUSE split across recencyFactor's two floor returns — designed
//       shape (age past the window) vs missing data (no usable ts);
//   (c) the staleness-saturation age, DERIVED BY BISECTION, never a literal;
//   (d) the co-saturation band of the combined time term, measured against the
//       analytic value it must agree with;
//   (e) the adjacent-pair score-delta distribution among the pinned set —
//       min / median / max and the share that is at ULP scale of its operands
//       versus the share that is not. (e) is the evidence the resolution
//       decision is made from; it exists before any resolution is chosen.
//
// BOUND, stated where the mode lives: (d) reconstructs the staleness term as
// stalenessFactor(now - row.ts). The scoring path prefers the attention record's
// own `staleness.ms` when it carries one and falls back to exactly this
// subtraction otherwise, so the band below is the fallback's reading. It is used
// to compare a MEASURED band against an ANALYTIC one, and both endpoints of the
// analytic band are computed here from CAPS rather than quoted.
// ---------------------------------------------------------------------------
async function saturationReport({ sources, now, identities }) {
  const rep = await buildPopulation({ sources, now, identities, anchorOpt: true });
  const FLOOR = CATCHUP_CAPS.RECENCY_FLOOR;
  const W = CATCHUP_CAPS.RECENCY_WINDOW_MS;

  const pinned = rep.rows.filter((r) => isPinned(r, now));

  // (a) BY TIER.
  const byTier = {};
  for (const r of rep.rows) {
    const t = typeof r.tier === "string" ? r.tier : "unknown";
    if (byTier[t] === undefined) byTier[t] = { population: 0, pinned: 0, pinned_pct: null };
    byTier[t].population += 1;
    if (isPinned(r, now)) byTier[t].pinned += 1;
  }
  for (const t of Object.keys(byTier)) {
    byTier[t].pinned_pct = +((100 * byTier[t].pinned) / byTier[t].population).toFixed(2);
  }

  // (b) BY CAUSE.
  const byCause = {};
  for (const r of pinned) {
    const c = pinnedCause(r, now);
    byCause[c] = (byCause[c] || 0) + 1;
  }

  // (d) THE CO-SATURATION BAND. Past the window the recency term is a constant, so
  // the entire time contribution is recency x staleness, and staleness is itself
  // approaching 1 from below. The analytic band is [FLOOR * stalenessFactor(W),
  // FLOOR): its width is the whole ordering information the time terms retain over
  // the pinned set, and 1/FLOOR is the uniform factor a staleness-leaning
  // re-weighting would multiply that band by.
  const combined = [];
  for (const r of pinned) {
    if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) continue;
    combined.push(recencyFactor(r.ts, now) * stalenessFactor(now - r.ts));
  }
  const analyticInfimum = FLOOR * stalenessFactor(W);
  const measuredMin = combined.length ? Math.min(...combined) : null;
  const measuredMax = combined.length ? Math.max(...combined) : null;

  // (e) THE DISTRIBUTION.
  const pinnedPairs = adjacentScorePairs(rep.rows, now, { pinnedOnly: true });
  const distribution = deltaDistribution(pinnedPairs);

  const satAge = stalenessSaturationAgeMs();

  return {
    now,
    ledger_identities: identities,
    population: rep.population,
    caps: {
      RECENCY_FLOOR: FLOOR,
      RECENCY_WINDOW_MS: W,
      STALENESS_HALFLIFE_MS: CATCHUP_CAPS.STALENESS_HALFLIFE_MS,
    },
    // (a) + (b)
    objective_1_pinned_population: {
      pinned: pinned.length,
      population: rep.population,
      pinned_pct: +((100 * pinned.length) / rep.population).toFixed(2),
      by_tier: byTier,
      by_cause: byCause,
      note:
        "recencyFactor returns exactly RECENCY_FLOOR from TWO guards. `age_past_window` is the DESIGNED shape; `absent_or_non_finite_ts` is missing data wearing the same value. They are never summed silently.",
    },
    // (c) + (e)
    objective_2_ordering_regimes: {
      staleness_saturation_age_ms: satAge,
      staleness_saturation_age_days: +(satAge / DAY).toFixed(4),
      staleness_at_boundary: stalenessFactor(satAge),
      staleness_one_ms_below_boundary: stalenessFactor(satAge - 1),
      pinned_rows_past_staleness_saturation: pinned.filter(
        (r) => typeof r.ts === "number" && now - r.ts >= satAge,
      ).length,
      pinned_rows_inside_staleness_saturation: pinned.filter(
        (r) => typeof r.ts === "number" && now - r.ts < satAge,
      ).length,
      adjacent_pair_distribution: distribution,
    },
    // (d)
    objective_3_co_saturation: {
      measured_min: measuredMin,
      measured_max: measuredMax,
      measured_spread_pct:
        measuredMin !== null && measuredMax > 0 ? +((100 * (measuredMax - measuredMin)) / measuredMax).toFixed(4) : null,
      analytic_infimum_at_window: analyticInfimum,
      analytic_supremum: FLOOR,
      analytic_spread_pct: +((100 * (FLOOR - analyticInfimum)) / FLOOR).toFixed(4),
      uniform_rescale_factor: 1 / FLOOR,
      note:
        "Past RECENCY_WINDOW_MS the staleness term was CO-SATURATED with recency, so the PRE-e17 combined time term was confined to a fraction of a percent across the whole pinned set. Re-weighting a tier toward stalenessFactor is a near-uniform 1/RECENCY_FLOOR rescale over that band and restores no ordering information; that re-weighting was DECLINED on this arithmetic. e17 did the OPPOSITE and deleted stalenessFactor from the product instead, so this block now measures a product the score no longer computes — it is kept as the record of the declined alternative, and the same arithmetic is why the pinned band collapsed to exact ties — see objective_2's adjacent_pair_distribution, where 160 of 166 adjacent pinned pairs collide exactly and none of the 6 separated pairs is at ulp scale.",
    },
  };
}

// ---------------------------------------------------------------------------
// THE SHARED RE-RANK KEY every table mode sorts on — IMPORTED, NOT MIRRORED.
//
// THIS FILE OWNS NO KEY ORDER. It used to: a hand-written if-ladder over tier,
// is_contact, score, ts and thread_id, carrying a bound that admitted the ordering
// was the one thing it could not import. That duplicated ladder is DELETED, and so
// is the bound. catchup.js declares the order ONCE as ORDER_KEY_SEQUENCE and
// exports the factory that builds a comparator from it; this seat calls that
// factory and gets the surface's own comparator. There is no longer any way for
// the measurement's order to drift from the surface's, because there is no longer
// a second copy of it to drift.
//
// WHAT REMAINS INJECTED, AND WHY IT IS NOT AN APPROXIMATION. This file compares
// DIGEST rows, which carry the M5b vouch as a FLAT `is_contact` field (rowDigest
// writes it that way) rather than nested under `enrichment`, so it passes its own
// `readContact`. That is a FIELD PATH, not a key order — the sequence, the score
// clamp and the tiebreaks are the surface's own.
//
// THE BOUND THAT STILL APPLIES, and it is about SCOPE and not about ordering: this
// re-ranks EMITTED HEADS and never re-runs dedup HEAD SELECTION, which the same
// comparator also decides. It therefore measures ORDERING churn, not HEAD churn.
// Head churn is measured exactly by the real before/after build (`--sources <snap>
// --out`, then `--churn ... --against`) and reported there in the head_changed
// bucket. When a table built here disagrees with that build, this mode's SCOPE is
// what is wrong — the order cannot be, since it is imported.
// ---------------------------------------------------------------------------
const DIGEST_COMPARE = makeCompareDesc({
  // The digest's field path for the M5b vouch. Not a key order.
  readContact: (r) => r.is_contact === true,
});

function rerankReport(base) {
  const byPartition = new Map();
  for (const r of base.rows) {
    let arr = byPartition.get(r.partition);
    if (arr === undefined) {
      arr = [];
      byPartition.set(r.partition, arr);
    }
    arr.push(r);
  }
  const cmp = DIGEST_COMPARE;
  const rows = [];
  for (const [, arr] of byPartition.entries()) {
    const sorted = [...arr].sort(cmp);
    sorted.forEach((r, i) => rows.push({ ...r, rank: i }));
  }
  return { ...base, rows };
}

// ---------------------------------------------------------------------------
// --time-term — e17's DECISION TABLE for the TIME TERM of rankScore, in the
// --min-messages mould and reusing buildPopulation,
// rerankReport / DIGEST_COMPARE and churnReports VERBATIM.
//
// THE QUESTION. rankScore multiplied recencyFactor(ts, now) by
// stalenessFactor(ageMs). Those two arguments are the SAME QUANTITY for a
// they-spoke-last thread — `rec.staleness.ms` is now - last_ts and last_ts IS the
// latest inbound ts — so the product is a BAND-PASS in one variable: it is 0 at
// age 0 (a message that arrived a minute ago is unrankable), rises to a peak near
// STALENESS_HALFLIFE_MS x a-couple, and decays after. Nobody designed that shape;
// it fell out of multiplying two normalizers that were each documented alone.
// This mode scores the candidates over ONE frozen population so the replacement
// is chosen from a table instead of from an argument.
//
// HOW A CANDIDATE IS SCORED — from the DECOMPOSITION, not from a second scorer.
// decompose() recovers recency, staleness, reciprocity, anchor and `directed`
// exactly for every emitted row (see its own block), so a candidate score is
//     directed * reciprocity * anchor * T(recency, staleness, directed)
// with T the only thing that varies. No candidate re-runs buildCatchup and no
// candidate adds a seam to the scoring path.
//
// THE BOUND, the same one every table mode carries: this mode RE-RANKS EMITTED
// HEADS. It does not re-run buildCatchupCore and therefore does not re-run dedup
// HEAD SELECTION, which compareDesc also decides. It measures ORDERING churn, not
// HEAD churn. `head_changed_count` is reported anyway and is 0 by construction — a
// non-zero would be a defect in the mirror, not a finding about the candidate.
//
// NOTHING HERE IS PRE-BLESSED. The baseline is the PRE-e17 SHIPPED PRODUCT
// (recency x staleness), recomputed from the decomposition rather than read off
// `row.score`, so the table reads the SAME before and after the scoring change —
// the property that makes it evidence rather than a self-report.
// ---------------------------------------------------------------------------
const TIME_TERM_AGE_BUCKETS = [
  { name: "lt_0.25d", maxMs: 0.25 * DAY },
  { name: "0.25_1d", maxMs: 1 * DAY },
  { name: "1_2d", maxMs: 2 * DAY },
  { name: "2_3d", maxMs: 3 * DAY },
  { name: "3_7d", maxMs: 7 * DAY },
  { name: "gt_7d", maxMs: Infinity },
];

function ageBucketOf(ageMs) {
  const a = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
  for (const b of TIME_TERM_AGE_BUCKETS) if (a < b.maxMs) return b.name;
  return TIME_TERM_AGE_BUCKETS[TIME_TERM_AGE_BUCKETS.length - 1].name;
}

// The candidates, as DATA. Each `term(recency, staleness, directed)` is a pure
// function of factors the decomposition already recovered.
const TIME_TERM_CANDIDATES = [
  {
    key: "product",
    baseline: true,
    label: "recency x staleness — the pre-e17 shipped product (the band-pass)",
    term: (recency, staleness) => recency * staleness,
  },
  {
    key: "recency_only",
    label: "recency alone — stalenessFactor DELETED from the product",
    term: (recency) => recency,
  },
  {
    key: "staleness_only",
    label: "staleness alone — recencyFactor deleted instead (older ranks higher)",
    term: (_recency, staleness) => staleness,
  },
  {
    key: "max_recency_staleness",
    label: "max(recency, staleness) — U-shaped: both the fresh and the overdue end lift",
    term: (recency, staleness) => Math.max(recency, staleness),
  },
  {
    key: "staleness_gated_on_directed",
    label:
      "recency x (directed >= DEFAULT_MIN_SCORE ? staleness : 1) — staleness applied only to a directed row. INERT BY CONSTRUCTION on any emitted population: the min_score filter already admits only rows above that threshold, so the gate is always open and this candidate reproduces the baseline. CAVEAT: the gate reads the RECOVERED `directed` residual, which for a substance-rescued row also contains substanceFactor and can therefore fall below the threshold — such a row shows as `rescored` here. That is a property of the reconstruction, not of the surface.",
    term: (recency, staleness, directed) =>
      recency * (Number.isFinite(directed) && directed >= CATCHUP_CAPS.DEFAULT_MIN_SCORE ? staleness : 1),
  },
];

// Score one digest row under one candidate. Returns null when the decomposition
// could not be recovered (no usable ts / no reciprocity term) — such a row keeps
// its emitted score so it is never silently dropped from the population.
function candidateScore(row, cand) {
  const d = row.decomp;
  if (!d || d.recency === null || d.staleness === null || d.reciprocity === null || d.directed === null) {
    return { score: row.score, time_term: null, recovered: false };
  }
  const t = cand.term(d.recency, d.staleness, d.directed);
  return { score: d.directed * d.reciprocity * d.anchor * t, time_term: t, recovered: true };
}

function statsOf(xs) {
  if (xs.length === 0) return { n: 0, min: null, median: null, max: null };
  return { n: xs.length, min: Math.min(...xs), median: medianOf(xs), max: Math.max(...xs) };
}

async function timeTermTable({ sources, now, identities }) {
  const built = await buildPopulation({ sources, now, identities, anchorOpt: true });
  const rows = built.rows;

  // ---- (a) DISTRIBUTION by age bucket, SPLIT BY TIER. The emitted score and
  // every candidate's time term, so the shape of each candidate over the real
  // age distribution is visible before any churn number is read.
  const distribution = [];
  for (const bucket of TIME_TERM_AGE_BUCKETS) {
    for (const tier of ["relationship", "unknown"]) {
      const inBucket = rows.filter(
        (r) =>
          r.tier === tier &&
          typeof r.ts === "number" &&
          ageBucketOf(now - r.ts) === bucket.name,
      );
      if (inBucket.length === 0) continue;
      const terms = {};
      for (const cand of TIME_TERM_CANDIDATES) {
        terms[cand.key] = statsOf(
          inBucket.map((r) => candidateScore(r, cand).time_term).filter((t) => t !== null),
        );
      }
      distribution.push({
        age_bucket: bucket.name,
        tier,
        rows: inBucket.length,
        emitted_score: statsOf(inBucket.map((r) => r.score)),
        time_term: terms,
      });
    }
  }

  // ---- THE TABLE. Baseline is the product candidate, reranked by the SAME
  // mirror every other mode uses.
  const scored = new Map();
  for (const cand of TIME_TERM_CANDIDATES) {
    scored.set(
      cand.key,
      rerankReport({ ...built, rows: rows.map((r) => ({ ...r, score: candidateScore(r, cand).score })) }),
    );
  }
  const baselineKey = TIME_TERM_CANDIDATES.find((c) => c.baseline === true).key;
  const baseline = scored.get(baselineKey);

  const runs = [];
  for (const cand of TIME_TERM_CANDIDATES) {
    const candidate = scored.get(cand.key);
    const c = churnReports(baseline, candidate);

    // THE TWO ENDS OF THE TIME TERM. A term below 0.1 means "this row's time
    // factor has all but zeroed its score". The two ends mean OPPOSITE things and
    // are NEVER summed, so the age axis is cut at the two CAPS boundaries that
    // define them and the leftover band is reported as its own count rather than
    // folded into whichever end is nearest:
    //   FRESH  age <  STALENESS_HALFLIFE_MS — a just-arrived message. This is the
    //          operator's complaint: the product term is ~0 here BY CONSTRUCTION.
    //   STALE  age >= RECENCY_WINDOW_MS — past the window, where recencyFactor is
    //          pinned at RECENCY_FLOOR. e11's finding lives in this count.
    //   MIDDLE everything between — where the ramp, not either saturation, is
    //          what made the term small.
    let lowFresh = 0;
    let lowStale = 0;
    let lowMiddle = 0;
    let unrecovered = 0;
    const termValues = [];
    for (const r of rows) {
      const cs = candidateScore(r, cand);
      if (!cs.recovered) { unrecovered += 1; continue; }
      termValues.push(cs.time_term);
      if (cs.time_term >= 0.1) continue;
      const age = typeof r.ts === "number" ? now - r.ts : Infinity;
      if (age < CATCHUP_CAPS.STALENESS_HALFLIFE_MS) lowFresh += 1;
      else if (age >= CATCHUP_CAPS.RECENCY_WINDOW_MS) lowStale += 1;
      else lowMiddle += 1;
    }

    runs.push({
      candidate: cand.key,
      baseline: baselineKey,
      label: cand.label,
      time_term: statsOf(termValues),
      rows_unrecovered: unrecovered,
      time_term_below_0_1_fresh_end: lowFresh,
      time_term_below_0_1_stale_end: lowStale,
      time_term_below_0_1_middle: lowMiddle,
      rank_moved_up: c.moved_up,
      rank_moved_down: c.moved_down,
      rank_unchanged: c.unchanged,
      rescored_up: c.rescored_up,
      rescored_down: c.rescored_down,
      tier_crossings_total: c.tier_crossings.length,
      tier_crossings: c.tier_crossings,
      entered: c.entered,
      left: c.left,
      // 0 BY CONSTRUCTION — this mode re-ranks heads and never re-selects them.
      head_changed_count: c.head_changed_count,
    });
  }

  return {
    now,
    ledger_identities: identities,
    population: built.population,
    shipped_time_term: STALENESS_IS_A_RANK_TERM
      ? "recencyFactor(ts, now) * stalenessFactor(ageMs) — the pre-e17 product"
      : "recencyFactor(ts, now) alone — stalenessFactor is no longer a rankScore term",
    baseline:
      "the PRE-e17 SHIPPED PRODUCT (recency x staleness), recomputed from the decomposition so the table reads identically before and after the scoring change",
    bound:
      "Re-ranks EMITTED HEADS on the frozen population: ORDERING churn, not HEAD churn (head_changed_count is 0 by construction here). tier_crossings is 0 by construction too — the mirror sorts tier first and a re-rank never reclassifies a row; it is reported so a non-zero would be visible as a mirror defect.",
    age_buckets: TIME_TERM_AGE_BUCKETS.map((b) => b.name),
    distribution_by_age_bucket_and_tier: distribution,
    runs,
  };
}

// ---------------------------------------------------------------------------
// --substance — e17's SECOND SEAT, MEASURED on the same frozen snapshot and with
// the same primitives (buildPopulation, rerankReport / DIGEST_COMPARE,
// churnReports). It answers the question the source comment must not answer for
// itself: what does the context-gated substance rescue actually put on the list?
//
// HOW THE BASELINE IS OBTAINED WITHOUT A SECOND BUILD. A rescued row announces
// itself — buildCatchupCore pushes `low_substance` into its reasons — so the
// PRE-RESCUE population is exactly this population with those rows removed, and
// the rescued rows are exactly the ones a pre-e17 build would have dropped. The
// baseline is that subset, re-ranked by the same mirror; the candidate is the full
// population. No second scoring path, no injected flag, no re-run.
//
// THE BOUND, and it is the same one --time-term carries with
// one addition: this compares EMITTED ROWS. Removing the rescued rows reproduces
// the pre-rescue ORDER exactly, but it cannot reproduce a pre-rescue DEDUP HEAD —
// if a rescued thread became the head of a person's group, the pre-e17 build would
// have shown that person's next-best thread instead, and this reconstruction shows
// the person as absent. `entered` is therefore an upper bound on rows a pre-e17
// operator would not have seen at all; `head_swaps_possible` counts how many
// rescued rows head a group of more than one thread, which is exactly the
// population where that distinction can bite.
//
// ROWS STILL DROPPED are not visible here at all — by construction, they are not
// on the surface. They are counted by the build itself, in
// stats.dropped_low_substance, and reported below from there.
// ---------------------------------------------------------------------------
const SUBSTANCE_TOP_N = 20;

async function substanceReport({ sources, now, identities }) {
  const built = await buildPopulation({ sources, now, identities, anchorOpt: true });

  const rescued = built.rows.filter((r) => r.low_substance === true);
  const candidate = rerankReport(built);
  const baseline = rerankReport({ ...built, rows: built.rows.filter((r) => r.low_substance !== true) });
  const c = churnReports(baseline, candidate);

  // TOP-N, BOTH DIRECTIONS, per partition. `entered_top_n` are rows now visible in
  // the first N of their partition that were not before (the rescued rows plus
  // anything they pushed nothing out of); `left_top_n` are rows pushed OUT of the
  // first N by a rescued row — the cost of the rescue, which is the direction a
  // one-sided report would omit.
  const rankBefore = new Map(baseline.rows.map((r) => [r.key, r.rank]));
  const rankAfter = new Map(candidate.rows.map((r) => [r.key, r.rank]));
  const enteredTopN = [];
  const leftTopN = [];
  for (const r of candidate.rows) {
    const before = rankBefore.has(r.key) ? rankBefore.get(r.key) : null;
    const after = rankAfter.get(r.key);
    if (after < SUBSTANCE_TOP_N && (before === null || before >= SUBSTANCE_TOP_N)) {
      enteredTopN.push({ key: r.key, name: r.name, partition: r.partition, tier: r.tier, rank_before: before, rank_after: after, low_substance: r.low_substance === true, rescue_reason: r.rescue_reason });
    }
    if (before !== null && before < SUBSTANCE_TOP_N && after >= SUBSTANCE_TOP_N) {
      leftTopN.push({ key: r.key, name: r.name, partition: r.partition, tier: r.tier, rank_before: before, rank_after: after });
    }
  }

  // SPLIT BY TIER AND BY RESCUE REASON — the rescued rows themselves.
  const byTier = {};
  const byReason = {};
  const landing = [];
  for (const r of rescued) {
    const t = typeof r.tier === "string" ? r.tier : "unknown";
    byTier[t] = (byTier[t] || 0) + 1;
    const reason = r.rescue_reason === null ? "unattributed" : r.rescue_reason;
    byReason[reason] = (byReason[reason] || 0) + 1;
    landing.push({
      key: r.key,
      name: r.name,
      partition: r.partition,
      tier: r.tier,
      rescue_reason: reason,
      rank: rankAfter.get(r.key),
      partition_size: candidate.rows.filter((x) => x.partition === r.partition).length,
      score: r.score,
      is_contact: r.is_contact,
      last_outbound_ts: r.last_outbound_ts,
      group_size: r.group_size,
      age_days: r.age_days,
    });
  }
  landing.sort((a, b) => a.rank - b.rank);
  const landingRanks = landing.map((x) => x.rank);

  return {
    now,
    ledger_identities: identities,
    population_with_rescue: built.population,
    population_without_rescue: built.population - rescued.length,
    // The rows the surface STILL drops: N8 graded them closers and no context
    // vouched for them. Read from the build's own additive stat, not inferred.
    still_dropped_low_substance: built.stats.dropped_low_substance,
    rescued_rows: rescued.length,
    rescued_pct_of_population: built.population
      ? +((100 * rescued.length) / built.population).toFixed(2)
      : null,
    rescued_by_tier: byTier,
    rescued_by_reason: byReason,
    rescued_landing_rank: {
      min: landingRanks.length ? Math.min(...landingRanks) : null,
      median: medianOf(landingRanks),
      max: landingRanks.length ? Math.max(...landingRanks) : null,
    },
    head_swaps_possible: rescued.filter((r) => (r.group_size || 1) > 1).length,
    churn: {
      entered: c.entered,
      left: c.left,
      rank_moved_up: c.moved_up,
      rank_moved_down: c.moved_down,
      rank_unchanged: c.unchanged,
      tier_crossings_total: c.tier_crossings.length,
    },
    top_n: SUBSTANCE_TOP_N,
    entered_top_n: enteredTopN,
    left_top_n: leftTopN,
    bound:
      "Compares EMITTED ROWS on one frozen snapshot: the baseline is this population with the low_substance rows removed, which reproduces the pre-rescue ORDER exactly but not a pre-rescue DEDUP HEAD. `entered` is an upper bound on rows a pre-e17 operator would not have seen; head_swaps_possible counts the rescued rows that head a multi-thread group, where the distinction can bite.",
    rescued: landing,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  // F7-1/F7-2 — `--pair "<nameA>|<nameB>" --report <out.json>`: print the per-factor
  // decomposition and the classifyTier vouch for two named rows of an ALREADY
  // MEASURED report. Reads a file; loads nothing live.
  const pair = arg("pair");
  if (typeof pair === "string") {
    const rep = JSON.parse(readFileSync(arg("report"), "utf8"));
    const wanted = pair.split("|").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const picked = [];
    for (const w of wanted) {
      const hits = rep.rows.filter((r) => (r.name || "").toLowerCase().includes(w) || (r.thread_id || "").toLowerCase().includes(w));
      picked.push({ query: w, matches: hits.length, rows: hits.slice(0, 5) });
    }
    process.stdout.write(JSON.stringify({ now: rep.now, population: rep.population, picked }, null, 2) + "\n");
    return;
  }

  const churnPath = arg("churn");
  if (typeof churnPath === "string") {
    const against = arg("against");
    const res = churn(churnPath, against);
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  const snapshotOut = arg("snapshot");
  const sourcesIn = arg("sources");

  let sources;
  let now;
  let identities;
  if (typeof sourcesIn === "string") {
    const snap = JSON.parse(readFileSync(sourcesIn, "utf8"));
    sources = snap.sources;
    now = snap.now;
    identities = snap.ledger_identities;
  } else {
    now = Date.now();
    identities = ledgerIdentities(ADAPTER_REGISTRY, MEMORY_ROOT);
    // READ-ONLY: projection:false suppresses the C1 cache WRITE under
    // storage/catchup-projection/. The ledgers themselves are opened O_RDONLY.
    //
    // NO `limit` IS PASSED — deliberately. ledgerRetainCap(limit) scales the
    // per-source retained tail by LEDGER_RETAIN_MULTIPLE, so `limit` silently
    // decides HOW MUCH HISTORY every downstream count is computed over. Passing
    // the handler's default (absent => CATCHUP_CAPS.DEFAULT_LIMIT => a 2000-row
    // tail per source) is what makes this harness measure the PRODUCTION
    // population rather than a wider window the operator never sees.
    sources = loadSourcesFromLedgers(ADAPTER_REGISTRY, {
      root: MEMORY_ROOT,
      now,
      projection: false,
    });
  }

  if (typeof snapshotOut === "string") {
    writeFileSync(snapshotOut, JSON.stringify({ now, ledger_identities: identities, sources }));
    process.stderr.write(`snapshot written: ${snapshotOut}\n`);
  }

  // --vouch-source — F7-2 provenance, measured through the SPINE_SOURCES registry.
  if (arg("vouch-source") !== null) {
    const vr = await vouchSourceReport({ sources, now, identities });
    const outPath = arg("out");
    if (typeof outPath === "string") writeFileSync(outPath, JSON.stringify(vr, null, 2));
    const { rows: _vrows, ...vsummary } = vr;
    process.stdout.write(JSON.stringify(vsummary, null, 2) + "\n");
    return;
  }

  // --saturation — e11's population reading of the recency floor.
  if (arg("saturation") !== null) {
    const sr = await saturationReport({ sources, now, identities });
    const outPath = arg("out");
    if (typeof outPath === "string") writeFileSync(outPath, JSON.stringify(sr, null, 2));
    process.stdout.write(JSON.stringify(sr, null, 2) + "\n");
    return;
  }

  // --substance — e17's second seat: what the context-gated rescue surfaces.
  if (arg("substance") !== null) {
    const sr = await substanceReport({ sources, now, identities });
    const outPath = arg("out");
    if (typeof outPath === "string") writeFileSync(outPath, JSON.stringify(sr, null, 2));
    const { rescued: _rows, ...summary } = sr;
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  // --time-term — e17's decision table for rankScore's TIME TERM.
  if (arg("time-term") !== null) {
    const tt = await timeTermTable({ sources, now, identities });
    const outPath = arg("out");
    if (typeof outPath === "string") writeFileSync(outPath, JSON.stringify(tt, null, 2));
    process.stdout.write(JSON.stringify(tt, null, 2) + "\n");
    return;
  }

  // --score-resolution — RETIRED by f1 along with the ordering grid it measured.
  // It is recognised EXPLICITLY rather than ignored: an unknown flag would fall
  // through to the default population report and hand the operator a plausible
  // JSON document that answers a different question than the one they asked.
  if (arg("score-resolution") !== null) {
    process.stderr.write(
      "--score-resolution was retired with the ordering grid it measured (the grid absorbed nothing: 0 rank moves and 0 tier crossings from 1e-15 through 1e-6). Use --saturation, whose adjacent_pair_distribution reports delta_min/median/max and at_ulp_scale — the re-entry detector for a near-tie band, with no grid to choose.\n",
    );
    process.exitCode = 2;
    return;
  }

  // --min-messages 1,2,3,5 — the published decision table (no default is moved).
  const mm = arg("min-messages");
  if (typeof mm === "string") {
    const list = mm.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 1);
    const tbl = await minMessagesTable({ sources, now, identities, list });
    const outPath = arg("out");
    if (typeof outPath === "string") writeFileSync(outPath, JSON.stringify(tbl, null, 2));
    process.stdout.write(JSON.stringify(tbl, null, 2) + "\n");
    return;
  }

  const report = await buildPopulation({ sources, now, identities, anchorOpt: true });

  const out = arg("out");
  if (typeof out === "string") writeFileSync(out, JSON.stringify(report, null, 2));

  const { rows: _omit, ...summary } = report;
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(`e7-catchup-join-eval FAILED: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
