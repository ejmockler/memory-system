// m7-cohort.mjs — WORKUNIT M7 (honest-eval) COHORT BUILDER.
//
// MISSION (per TOPOLOGY.md, the W3 closure gate): the existing goldsets
// (ranking-eval-goldset.jsonl, held-out-labels.jsonl) are RECIPROCITY-SATURATED —
// every label already has a two-way history (turn_count>=2). They therefore CANNOT
// SEE the INVISIBLE error M1-M5 exists to fix: a genuine first-contact STRANGER
// who later becomes a real relationship, but whose FIRST message is
// indistinguishable from spam. If the surface silently HARD-DROPS that cold node,
// the operator never gets to triage it and it never converts — a silent failure no
// ranking metric on the saturated goldset can detect.
//
// This module MINES + LABELS a sized cohort straight off a corpus of L1 envelopes
// (the same shape loadEnvelopesFromSources produces from imessage.jsonl /
// whatsapp.jsonl / telegram.jsonl). It NEVER hand-stamps a tier: every label is
// DERIVED from the corpus by computing per-person, per-thread reciprocity EXACTLY
// as the live attention.js pipeline does (reciprocityOfThread — turn_count = the
// number of inbound<->outbound direction transitions). Three disjoint cohorts:
//
//   (a) became-real  — a person whose CHRONOLOGICALLY-FIRST inbound is a COLD
//       first-contact (in that first thread: turn_count===0, i.e. one-directional,
//       no reply yet) AND who LATER reaches a real two-way history
//       (max turn_count over all their threads >= becameRealTurns, default 2).
//       This is the latency-gap cohort: at first sight they look exactly like
//       noise; the system must NOT drop them so feedback + time can convert them.
//   (b) noise        — a person who NEVER reaches a two-way history (max
//       turn_count < becameRealTurns over every thread) AND is NOT a saved contact
//       (a service / business / broadcast / spam — the honest cold-node floor).
//   (c) relationship — a saved contact (an explicit human vouch; is_contact via the
//       supplied contact handle-set), regardless of reciprocity.
//
// THESIS #1 (read-only / derived / append-only): this is a DIAGNOSTIC over an
// in-memory corpus. It performs NO I/O, NO mutation, NEVER writes back to a ledger,
// and is deterministic over its inputs. ZERO platform tokens: it reads opaque
// platform / sender-id / handle strings only and never branches on a platform name.
//
// PURE / DEFENSIVE: total over odd input (a malformed envelope contributes
// nothing), never throws.

import { reciprocityOfThread } from "../../lib/messaging/attention.js";
import { normalizeHandleKey } from "../../lib/messaging/contacts-anchor.js";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The opaque per-person identity key over a corpus of envelopes. We deduplicate a
// person by the SAME key the rank loop's dedup uses: the resolved person_id from the
// injected resolver when present (the N7 cross-platform collapse), else the soft
// `${platform}:${sender_id}` fallback. This MUST match buildCatchup's dedup_key so a
// cohort label resolves back to the surfaced row. NEVER reads the platform token as a
// branch; it is only a prefix.
function personKeyOf(env, resolveFn) {
  if (!isPlainObject(env)) return null;
  if (env.is_from_me === true) return null; // only inbound senders are people to rank.
  const platform = typeof env.platform === "string" ? env.platform : "";
  const senderId = env.sender && typeof env.sender.id === "string" ? env.sender.id : null;
  if (senderId === null || senderId.length === 0) return null;
  if (typeof resolveFn === "function") {
    let pid = null;
    try {
      pid = resolveFn(platform === "" ? null : platform, senderId);
    } catch {
      pid = null;
    }
    if (typeof pid === "string" && pid.length > 0) return pid;
  }
  return `${platform}:${senderId}`;
}

// The candidate handle(s) for a person (for the saved-contact join). The sender id
// IS the handle in the soft path; we also offer the raw tail. Mirrors
// contacts-anchor.handlesForPerson without importing a platform branch.
function handlesOf(env) {
  if (!isPlainObject(env) || env.is_from_me === true) return [];
  const senderId = env.sender && typeof env.sender.id === "string" ? env.sender.id : null;
  return senderId ? [senderId] : [];
}

/**
 * buildAttentionCohort(envelopes, opts) -> the labeled cohort.
 *
 * @param {object[]} envelopes a corpus of L1 envelopes (loadEnvelopesFromSources shape).
 * @param {object} [opts]
 * @param {Set<string>} [opts.contactKeys] canonical contact keys (normalizeHandleKey)
 *        — a person any of whose handles is in this set is a SAVED contact.
 * @param {number} [opts.becameRealTurns] the N at/above which max turn_count counts
 *        as a real two-way relationship (default 3 — strictly past the new-contact
 *        neutral once graded by reciprocityStrength, so the LATEST thread tiers as a
 *        RELATIONSHIP; turns==2 grades exactly AT the neutral and stays unknown).
 * @param {(platform:string|null, senderId:string)=>(string|null)} [opts.resolvePerson]
 *        the SAME N7 resolver buildCatchup uses, so a person's key matches the
 *        surfaced row's dedup_key. Absent => the soft `${platform}:${sender_id}` key.
 * @returns {{
 *   people: Map<string, {
 *     person_key:string, platform:string|null,
 *     thread_ids:string[], handles:string[],
 *     first_thread_id:string|null, first_thread_turns:number,
 *     max_turns:number, is_contact:boolean, label:string,
 *   }>,
 *   becameReal: string[], noise: string[], relationship: string[],
 *   size: number,
 * }}
 */
export function buildAttentionCohort(envelopes, opts = {}) {
  const o = isPlainObject(opts) ? opts : {};
  const contactKeys = o.contactKeys instanceof Set ? o.contactKeys : new Set();
  const becameRealTurns =
    typeof o.becameRealTurns === "number" && Number.isFinite(o.becameRealTurns) && o.becameRealTurns >= 1
      ? o.becameRealTurns
      : 3;
  const resolveFn = typeof o.resolvePerson === "function" ? o.resolvePerson : null;

  const list = Array.isArray(envelopes) ? envelopes : [];

  // 1. Group every envelope (inbound + outbound) by (person, thread). The OUTBOUND
  //    messages in a thread are attributed to the inbound person of that thread so
  //    reciprocityOfThread can count the back-and-forth. We bucket per thread first,
  //    then assign each thread to its inbound person.
  const threadEnvs = new Map(); // thread_id -> envelope[]
  const threadPerson = new Map(); // thread_id -> person_key (the inbound sender)
  const personHandles = new Map(); // person_key -> Set<handle>
  const personPlatform = new Map(); // person_key -> platform

  for (const env of list) {
    if (!isPlainObject(env)) continue;
    const threadId = typeof env.thread_id === "string" && env.thread_id.length > 0 ? env.thread_id : null;
    if (threadId === null) continue;
    let arr = threadEnvs.get(threadId);
    if (arr === undefined) {
      arr = [];
      threadEnvs.set(threadId, arr);
    }
    arr.push(env);

    const pk = personKeyOf(env, resolveFn); // null for outbound / malformed
    if (pk !== null) {
      // The inbound person of the thread (first inbound sender wins; a 1:1 DM has one).
      if (!threadPerson.has(threadId)) threadPerson.set(threadId, pk);
      let hs = personHandles.get(pk);
      if (hs === undefined) {
        hs = new Set();
        personHandles.set(pk, hs);
      }
      for (const h of handlesOf(env)) hs.add(h);
      if (!personPlatform.has(pk)) {
        personPlatform.set(pk, typeof env.platform === "string" ? env.platform : null);
      }
    }
  }

  // 2. For each thread, compute reciprocity (ts-ascending) and the earliest inbound ts.
  const people = new Map(); // person_key -> aggregate record
  for (const [threadId, envs] of threadEnvs) {
    const pk = threadPerson.get(threadId);
    if (pk === undefined) continue; // an all-outbound thread (no person to rank).
    const sorted = [...envs].sort((a, b) => {
      const ta = typeof a.ts === "number" ? a.ts : 0;
      const tb = typeof b.ts === "number" ? b.ts : 0;
      return ta - tb;
    });
    const recip = reciprocityOfThread(sorted);
    // The earliest INBOUND ts in this thread — when the person first reached out.
    let firstInboundTs = Infinity;
    for (const e of sorted) {
      if (e.is_from_me === true) continue;
      const t = typeof e.ts === "number" ? e.ts : null;
      if (t !== null && t < firstInboundTs) firstInboundTs = t;
    }

    let rec = people.get(pk);
    if (rec === undefined) {
      rec = {
        person_key: pk,
        platform: personPlatform.get(pk) || null,
        thread_ids: [],
        handles: [...(personHandles.get(pk) || new Set())],
        first_thread_id: null,
        first_thread_turns: 0,
        first_inbound_ts: Infinity,
        max_turns: 0,
      };
      people.set(pk, rec);
    }
    rec.thread_ids.push(threadId);
    if (recip.turn_count > rec.max_turns) rec.max_turns = recip.turn_count;
    // Track the CHRONOLOGICALLY-FIRST thread for this person (their first contact).
    if (firstInboundTs < rec.first_inbound_ts) {
      rec.first_inbound_ts = firstInboundTs;
      rec.first_thread_id = threadId;
      rec.first_thread_turns = recip.turn_count;
    }
  }

  // 3. Label each person. is_contact from the supplied contact key-set (the saved
  //    human vouch). Then the three disjoint cohorts.
  const becameReal = [];
  const noise = [];
  const relationship = [];
  for (const rec of people.values()) {
    rec.is_contact = rec.handles.some((h) => {
      const k = normalizeHandleKey(h);
      return k !== null && contactKeys.has(k);
    });
    delete rec.first_inbound_ts; // an internal sort key, not part of the label.

    if (rec.is_contact) {
      rec.label = "relationship";
      relationship.push(rec.person_key);
      continue;
    }
    // The latency-gap cohort: cold on first contact (first thread had NO reply yet),
    // but later a real two-way history. The exact INVISIBLE error.
    if (rec.first_thread_turns === 0 && rec.max_turns >= becameRealTurns) {
      rec.label = "became_real";
      becameReal.push(rec.person_key);
      continue;
    }
    // Everyone else who never reached a two-way history is the honest noise floor.
    if (rec.max_turns < becameRealTurns) {
      rec.label = "noise";
      noise.push(rec.person_key);
      continue;
    }
    // A non-contact with a two-way history that was ALREADY two-way on the first
    // thread (reciprocity-saturated — exactly what the existing goldsets cover). We
    // exclude it from all three cohorts (it is the saturated case M7 does NOT test).
    rec.label = "saturated";
  }

  return {
    people,
    becameReal,
    noise,
    relationship,
    size: becameReal.length + noise.length + relationship.length,
  };
}

/**
 * contactKeySet(handles) -> a Set of canonical contact keys (normalizeHandleKey)
 * for a list of saved handle strings. The small helper a test uses to declare which
 * handles are "saved" without re-deriving the normalizer.
 */
export function contactKeySet(handles) {
  const set = new Set();
  if (!Array.isArray(handles)) return set;
  for (const h of handles) {
    const k = normalizeHandleKey(h);
    if (k !== null) set.add(k);
  }
  return set;
}
