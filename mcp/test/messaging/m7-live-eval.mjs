// m7-live-eval.mjs — RUN-ONCE live eval of the who-matters surface over the REAL
// source ledgers + the REAL operator AddressBook. NOT a node:test (no hermetic fixture);
// it exercises the production read path so the reported metrics are honest numbers over
// the operator's actual corpus.
//
// HISTORY / WHY THIS WAS REWRITTEN (the approach-revisit, hand-edit pass):
// The first M7 eval reported became_real_recall=1.0 as the headline safety metric. A
// brutalist re-ran it and falsified that: on live data the became_real cohort is EMPTY
// (a person collapses into one thread, so the cold-first/deep-later shape never occurs),
// so 1.0 was the empty-set default over a never-hard-drop surface — a TAUTOLOGY. And the
// precision metric compared RAW SCORES across tiers while the surface renders TIER-SORTED,
// so it measured a quantity the operator never sees. This rewrite measures what the
// operator ACTUALLY experiences:
//   (1) RENDERED-ORDER precision at the REAL limit: in the surfaced list, does any
//       unknown-tier row appear ABOVE any relationship-tier row? (teeth; passes today).
//   (2) FINDABILITY: are KNOWN-IMPORTANT people present within the rendered fold? Two
//       panels — (a) the REAL saved contacts that appear in the corpus, (b) an authored
//       PERSONA PANEL (m7-persona-panel.mjs) supplying the buried-stranger / became-real
//       shapes live data cannot, so the buried-stranger gate finally has teeth.
// The became_real cohort numbers are still printed for transparency, but are NO LONGER a
// gate (they are structurally empty on live data — see m7-cohort.mjs).
//
// THESIS #1: read-only. No writes, no mutation.

import {
  buildCatchup,
  loadEnvelopesFromSources,
  loadSourcesFromLedgers,
  ADAPTER_REGISTRY,
} from "../../lib/messaging/catchup.js";
import { TIER } from "../../lib/messaging/person-enrichment.js";
import { buildPersonIndex, lookup as personLookup } from "../../lib/messaging/identity.js";
import {
  buildContactMaps,
  resolveAddressBookDbPaths,
} from "../../lib/connectors/_imessage-name-recovery.js";
import { buildHandleSetFromContactMaps } from "../../lib/messaging/contacts-anchor.js";
import { buildAttentionCohort } from "./m7-cohort.mjs";
import { buildPersonaPanel } from "./m7-persona-panel.mjs";
import { MEMORY_ROOT } from "../../lib/config.js";

const NOW = Date.now();
const BECAME_REAL_TURNS = 3;
// The REAL render budget the operator sees (CATCHUP_CAPS.DEFAULT_LIMIT). Findability is
// "present within this fold", not "survives an infinite window".
const FOLD = 50;

function digits(s) {
  return typeof s === "string" ? s.replace(/[^0-9]/g, "").slice(-10) : "";
}

// Match a rendered row to a persona robustly: by the RESOLVED person_id (the same N7
// hash buildCatchup's dedup uses), by exact name, or by the soft key / handle digits.
function rowMatches(r, p) {
  if (p.resolvedId && (r.person_id === p.resolvedId || r.person === p.resolvedId)) return true;
  if (p.name && typeof r.name === "string" && r.name === p.name) return true;
  if (p.key && (r.person_id === p.key || r.person === p.key)) return true;
  const need = digits(p.handle);
  if (need.length >= 7 && digits(`${r.person_id || ""} ${r.person || ""}`).includes(need)) return true;
  return false;
}

function rankOf(rows, target) {
  for (let i = 0; i < rows.length; i++) if (rowMatches(rows[i], target)) return i;
  return -1;
}

async function main() {
  // 1. The REAL contact key-set from the operator's saved AddressBook (READ-ONLY).
  const dbPaths = resolveAddressBookDbPaths();
  let contactKeys = new Set();
  let abSize = 0;
  if (Array.isArray(dbPaths) && dbPaths.length > 0) {
    const { phoneToName, emailToName } = await buildContactMaps(dbPaths);
    contactKeys = buildHandleSetFromContactMaps({ phoneToName, emailToName });
    abSize = contactKeys.size;
  }

  // 2. Load the REAL source ledgers (the production handler's loader).
  const sources = await loadSourcesFromLedgers(ADAPTER_REGISTRY, { root: MEMORY_ROOT, now: NOW });
  const liveEnvelopes = await loadEnvelopesFromSources(sources, ADAPTER_REGISTRY);

  // 3. The authored FINDABILITY persona panel (the buried-stranger / became-real shapes
  //    live data cannot produce). Injected into the corpus via the test-only seam. Resolve
  //    each persona's person_id over the SAME (live+panel) corpus buildCatchup indexes, so
  //    a panel entry matches its surfaced row's (N7-hashed) dedup key.
  const panel = buildPersonaPanel(NOW);
  const rankIndex = buildPersonIndex(liveEnvelopes.concat(panel.envelopes));
  for (const p of panel.panel) {
    let rid = null;
    try { rid = personLookup(rankIndex, p.platform, p.sid); } catch { rid = null; }
    p.resolvedId = typeof rid === "string" && rid.length > 0 ? rid : p.key;
  }

  // 4. Transparency-only cohort (NOT a gate): the live became_real band is structurally
  //    empty; we print it to keep the honest record visible, never to pass/fail on it.
  const index = buildPersonIndex(liveEnvelopes);
  const resolvePerson = (platform, senderId) => {
    try { return personLookup(index, platform, senderId); } catch { return null; }
  };
  const cohort = buildAttentionCohort(liveEnvelopes, {
    contactKeys, becameRealTurns: BECAME_REAL_TURNS, resolvePerson,
  });

  // 5. Rank the REAL corpus + the injected persona panel, anchor ON, at the REAL FOLD
  //    (what the operator sees) and at a wide window (to report the honest rank of a
  //    persona even when it falls outside the fold — buriedness must be VISIBLE).
  const common = { sources, now: NOW, min_score: 0.0, anchor: true, extraEnvelopes: panel.envelopes };
  const resFold = await buildCatchup({ ...common, limit: FOLD });
  const resWide = await buildCatchup({ ...common, limit: 100000 });

  // ---- METRIC (teeth): RENDERED-ORDER precision at the fold. In the actually-surfaced
  //      list, no UNKNOWN-tier row may appear ABOVE a RELATIONSHIP-tier row. ----
  let seenUnknown = false, renderedViolations = 0, relAfterUnknown = [];
  for (const r of resFold.rows) {
    if (r.tier === TIER.UNKNOWN) seenUnknown = true;
    else if (r.tier === TIER.RELATIONSHIP && seenUnknown) {
      renderedViolations += 1;
      if (relAfterUnknown.length < 3) relAfterUnknown.push(r.name || r.person_id);
    }
  }
  const renderedOrderClean = renderedViolations === 0;

  // ---- METRIC (teeth): FINDABILITY of the persona panel within the fold. ----
  const panelResults = panel.panel.map((p) => {
    const rankWide = rankOf(resWide.rows, p);
    const rowFold = resFold.rows.find((r) => rowMatches(r, p));
    return {
      label: p.label,
      findable: rowFold !== undefined,           // present within the rendered fold
      rank: rankWide,                             // honest rank in the full list
      tier: rowFold ? rowFold.tier : (rankWide >= 0 ? resWide.rows[rankWide].tier : "(dropped)"),
    };
  });
  const panelFindable = panelResults.filter((p) => p.findable).length;
  const panelTotal = panelResults.length;

  // ---- METRIC (teeth): FINDABILITY of REAL saved contacts present in the corpus. ----
  //      Every relationship-tier row in the wide list is a real anchored person; what
  //      fraction render within the fold, and what is the worst (deepest) rank?
  const relWide = resWide.rows.filter((r) => r.tier === TIER.RELATIONSHIP);
  const relInFold = relWide.filter((r, i) => resWide.rows.indexOf(r) < FOLD).length;
  const worstRelRank = relWide.reduce((mx, r) => Math.max(mx, resWide.rows.indexOf(r)), -1);
  const realContactFindability = relWide.length === 0 ? 1.0 : relInFold / relWide.length;

  // ---- GATE ----
  const gatePass =
    renderedOrderClean &&
    panelFindable === panelTotal &&
    realContactFindability >= 1.0;

  const out = {
    address_book_size: abSize,
    live_envelopes: liveEnvelopes.length,
    panel_envelopes: panel.envelopes.length,
    fold: FOLD,
    rows_fold: resFold.rows.length,
    rows_wide: resWide.rows.length,
    cohort_transparency: {
      size: cohort.size,
      relationship: cohort.relationship.length,
      became_real_live: cohort.becameReal.length, // structurally ~0 on live data (see m7-cohort.mjs)
      noise: cohort.noise.length,
      note: "became_real is empty on live data by construction; the persona panel provides the buried-stranger teeth instead.",
    },
    metrics: {
      rendered_order_clean: renderedOrderClean,
      rendered_order_violations: renderedViolations,
      rendered_order_examples: relAfterUnknown,
      panel_findable: `${panelFindable}/${panelTotal}`,
      panel: panelResults,
      real_contacts_in_corpus: relWide.length,
      real_contact_findability: Number(realContactFindability.toFixed(3)),
      real_contact_worst_rank: worstRelRank,
    },
    gate_pass: gatePass,
    gate_line:
      `rendered_order_clean=${renderedOrderClean} rendered_violations=${renderedViolations} ` +
      `panel_findable=${panelFindable}/${panelTotal} real_contact_findability=${realContactFindability.toFixed(3)} ` +
      `real_contacts=${relWide.length} fold=${FOLD}`,
  };
  console.log("M7_LIVE_EVAL_JSON_START");
  console.log(JSON.stringify(out, null, 2));
  console.log("M7_LIVE_EVAL_JSON_END");
}

main().catch((e) => { console.error("M7_LIVE_EVAL_ERROR", e && e.stack ? e.stack : e); process.exit(1); });
