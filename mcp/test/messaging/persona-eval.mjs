// persona-eval.mjs — RUN-ONCE, READ-ONLY transparency print of the PERSONA facets
// over the REAL operator corpus (plus the authored findability panel). NOT a
// node:test — it asserts NOTHING about the apparatus; it exercises the production
// read path so the printed personas are honest projections of the actual ledgers.
//
// This is the persona sibling of m7-live-eval.mjs: same loader shape
// (loadSourcesFromLedgers -> loadEnvelopesFromSources(ADAPTER_REGISTRY)), same N7
// person index, but instead of ranking it folds a few REAL personas via the real
// makePersonaResolver and prints them between JSON markers for inspection.
//
// THESIS #1: read-only. No ledger mutation, no persist, no fs write. The panel is
// overlaid purely for visual comparison; nothing here gates pass/fail.

import {
  loadEnvelopesFromSources,
  loadSourcesFromLedgers,
  ADAPTER_REGISTRY,
} from "../../lib/messaging/catchup.js";
import { buildPersonIndex, lookup as personLookup, OPERATOR_PERSON_ID } from "../../lib/messaging/identity.js";
import { makePersonaResolver } from "../../lib/messaging/persona-resolver.js";
import { buildPersonaPanel } from "./m7-persona-panel.mjs";
import { MEMORY_ROOT } from "../../lib/config.js";

const NOW = Date.now();
// How many real personas to print (a transparency sample, not the whole corpus).
const SAMPLE = 12;

async function main() {
  // 1. Load the REAL source ledgers (the production loader; READ-ONLY, bounded).
  const sources = await loadSourcesFromLedgers(ADAPTER_REGISTRY, { root: MEMORY_ROOT, now: NOW });
  const liveEnvelopes = await loadEnvelopesFromSources(sources, ADAPTER_REGISTRY);

  // 2. The N7 person index over the live corpus + the real resolver. We pass the
  //    index so identity (display_name/handles) populates; topics/arc derive from
  //    the envelopes alone. resolvePerson is SOFT (a miss => null, never throws).
  const index = buildPersonIndex(liveEnvelopes);
  const resolvePerson = (platform, sid) => {
    try {
      return personLookup(index, platform, sid);
    } catch {
      return null;
    }
  };
  const resolveLive = makePersonaResolver({
    index,
    envelopes: liveEnvelopes,
    resolvePerson,
    now: NOW,
  });

  // 3. Sample some REAL (non-operator) persons and print their derived personas.
  //    We prefer those whose facets actually fired (non-empty topics or a real arc
  //    trend) so the print is informative, capped at SAMPLE.
  const livePersonas = [];
  for (const personId of index.persons.keys()) {
    if (personId === OPERATOR_PERSON_ID) continue;
    const persona = resolveLive(personId);
    const interesting =
      (Array.isArray(persona.topics) && persona.topics.length > 0) ||
      (persona.arc && persona.arc.trend !== null);
    if (!interesting) continue;
    livePersonas.push({
      person_id: personId,
      display_name: persona.identity ? persona.identity.display_name : null,
      relationship_tier: persona.relationship ? persona.relationship.tier : null,
      role: persona.role, // null today — no role deriver (transparency)
      topics: persona.topics,
      arc: persona.arc,
    });
    if (livePersonas.length >= SAMPLE) break;
  }

  // 4. Overlay the AUTHORED panel personas (the findability fixtures) for side-by-
  //    side comparison against their authored truth — purely informational.
  const panel = buildPersonaPanel(NOW);
  const panelIndex = buildPersonIndex(panel.envelopes);
  const panelResolvePerson = (platform, sid) => {
    try {
      return personLookup(panelIndex, platform, sid);
    } catch {
      return null;
    }
  };
  const resolvePanel = makePersonaResolver({
    index: panelIndex,
    envelopes: panel.envelopes,
    resolvePerson: panelResolvePerson,
    now: NOW,
  });
  const panelPersonas = panel.panel.map((p) => {
    const rid = panelResolvePerson(p.platform, p.sid) || p.key;
    const persona = resolvePanel(rid);
    return {
      label: p.label,
      person_id: rid,
      derived: { topics: persona.topics, arc: persona.arc, role: persona.role },
      truth: p.truth,
    };
  });

  const out = {
    now: NOW,
    live_envelopes: liveEnvelopes.length,
    live_clusters: index.persons.size,
    live_persona_sample: livePersonas,
    panel_personas: panelPersonas,
  };
  console.log("PERSONA_EVAL_JSON_START");
  console.log(JSON.stringify(out, null, 2));
  console.log("PERSONA_EVAL_JSON_END");
}

main().catch((e) => {
  console.error("PERSONA_EVAL_ERROR", e && e.stack ? e.stack : e);
  process.exit(1);
});
