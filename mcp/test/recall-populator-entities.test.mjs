// recall-populator-entities.test.mjs — C2. Pins the query-side gazetteer
// merge in the recall populator (lib/tools/recall.js `_applyQueryGazetteer`,
// wired immediately after the structural extractor's try/catch) and its
// default-off CAP (CAPS.RECALL_QUERY_GAZETTEER_ENABLED, validation.js).
//
// WHY CHILD PROCESSES: the CAP is evaluated ONCE, at validation.js module
// load, from process.env.MEMORY_RECALL_QUERY_GAZETTEER_ENABLED — CAPS is
// Object.freeze()d, so an in-process toggle is impossible by construction.
// Each arm therefore spawns a fresh `node` with the env var set or explicitly
// deleted and reads a single RESULT json line back, the same shape
// test/run-all-tests-hermetic-arm.test.mjs uses for its dynamic matrix.
//
// WHAT IS ACTUALLY BEING MEASURED: the merged entity list feeds THREE recall
// consumers, not one — computeQueryEpisodicity (episodicity_match),
// populatorEntityIds (entity_overlap), and the substrate-fallback candidate
// gate `populatorEntityIds.length > 0`, which ADDS candidates. Every arm below
// asserts on the merged list itself (ids + evidence + stamped_by), never on a
// count, because entities_count is the apparatus metric and not the payoff.
//
// HERMETIC: the driver is written into a mkdtemp temp dir and imports the real
// lib/tools/recall.js, which is pure at module load. No ledger, no index cache,
// no storage/ path is read, written, or stat'ed. The 2.9GB memory.jsonl and
// storage/entity-index.cache.json are never opened.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const MCP_ROOT = join(import.meta.dirname, "..");
const RECALL_PATH = join(MCP_ROOT, "lib", "tools", "recall.js");
const EXTRACTOR_PATH = join(MCP_ROOT, "lib", "synthesis", "entity-extractor.js");

const TMP_ROOT = mkdtempSync(join(tmpdir(), "c2-populator-"));

// Hermetic root. gazetteer.js resolves its default seed ONCE, at module load,
// from <MEMORY_ROOT>/config/gazetteer-seed.json. The arms below literal-pin
// built-in surfaces, so MEMORY_ROOT is pinned to this empty temp root: there
// is no seed file under it and the built-in list is what loads, whatever seed
// the host's own checkout carries. The library is only ever loaded in the
// child driver (runArm passes the same two values in its env); they are set
// here too so nothing imported in this process can see the host root either.
const OPERATOR_IDENTITY_FILE = join(
  import.meta.dirname,
  "fixtures",
  "operator-identity.synthetic.json",
);
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.MEMORY_OPERATOR_IDENTITY_FILE = OPERATOR_IDENTITY_FILE;
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

const SOURCE = "chat-claude-code";

// The driver runs ONE arm in a fresh process and prints one RESULT line.
// argv[2] = arm name, argv[3] = populator text.
const DRIVER_SRC = `
import { pathToFileURL } from "node:url";

const recall = await import(pathToFileURL(${JSON.stringify(RECALL_PATH)}).href);
const extractor = await import(pathToFileURL(${JSON.stringify(EXTRACTOR_PATH)}).href);
const { CAPS } = await import(
  pathToFileURL(${JSON.stringify(join(MCP_ROOT, "lib", "validation.js"))}).href
);

const arm = process.argv[2];
const text = process.argv[3];
const SOURCE = ${JSON.stringify(SOURCE)};

if (arm === "throw") {
  // Force the gazetteer to throw. Production behavior is untouched; the seam
  // defaults back to the real extractor.
  recall.__setGazetteerExtractorForTest(() => {
    throw new Error("forced gazetteer failure (C2 test)");
  });
}

const structural = extractor.extractEntities(text, { source: SOURCE }).entities;
const merged = recall._applyQueryGazetteer(structural, text, SOURCE);

// The populator's canonical-id projection, reproduced verbatim from
// recall.js so the arms assert on the value the fallback gate actually reads.
const populatorEntityIds = merged.entities
  .map((e) => (e && typeof e.canonical_id === "string" ? e.canonical_id : ""))
  .filter((s) => s.length > 0);

process.stdout.write(
  "RESULT " +
    JSON.stringify({
      cap: CAPS.RECALL_QUERY_GAZETTEER_ENABLED,
      same_reference: merged.entities === structural,
      structural,
      entities: merged.entities,
      populatorEntityIds,
      degraded_reason: merged.degraded_reason,
    }) +
    "\\n",
);
`;

const DRIVER_PATH = join(TMP_ROOT, "driver.mjs");
writeFileSync(DRIVER_PATH, DRIVER_SRC, "utf8");

/**
 * Run one arm in a child process.
 * @param {{flag: boolean, arm?: string, text: string}} spec
 */
function runArm({ flag, arm = "plain", text }) {
  const env = { ...process.env };
  env.MEMORY_ROOT = TMP_ROOT;
  env.MEMORY_OPERATOR_IDENTITY_FILE = OPERATOR_IDENTITY_FILE;
  if (flag) {
    env.MEMORY_RECALL_QUERY_GAZETTEER_ENABLED = "1";
  } else {
    delete env.MEMORY_RECALL_QUERY_GAZETTEER_ENABLED;
  }
  const res = spawnSync(process.execPath, [DRIVER_PATH, arm, text], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    res.status,
    0,
    `driver exited ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
  const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `driver printed no RESULT line\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(line.slice("RESULT ".length));
  assert.equal(
    parsed.cap,
    flag,
    `CAPS.RECALL_QUERY_GAZETTEER_ENABLED was ${parsed.cap} with the env ` +
      `${flag ? "set to 1" : "deleted"} — the operator lever is not wired`,
  );
  return parsed;
}

// Prose text: the structural extractor sees NOTHING here (no url, email, repo
// path, phone, file path or hashtag). This is the 260/265 case.
const PROSE = "the Fernwick FW-3 run";
// Collision text: `example-org/Fernwick` is a GitHub repo path, so the STRUCTURAL
// pass emits project:chat-claude-code:fernwick; the gazetteer's `Fernwick`
// seed entry mints the SAME canonical_id. The `gh repo` marker keeps the
// structural emit alive under MEMORY_GH_REPO_PRECISE=1 as well as unset.
const COLLIDING = "gh repo view example-org/Fernwick";
// Precision hazard: `Ledger` is in DEFAULT_GAZETTEER_SEED, and these two
// identifiers contain it as a SUBSTRING. Only findWholeWord's boundary rule
// stops them.
const LEDGER_HAZARD =
  "rebuild the ledgerIndex from subledgers before hashing";

test("(a) flag OFF: merged set is the structural set, unchanged and un-copied", () => {
  const off = runArm({ flag: false, text: PROSE });

  assert.equal(off.degraded_reason, null);
  // Identity, not just deep-equality: off cannot be a re-derivation.
  assert.equal(
    off.same_reference,
    true,
    "flag-OFF must return the SAME array reference the structural extractor produced",
  );
  assert.deepEqual(off.entities, off.structural);
  assert.equal(
    off.entities.some((e) => e.evidence === "kb_lookup"),
    false,
    "flag-OFF must never surface a kb_lookup entity",
  );
  // Non-vacuity: this text really is one the structural pass cannot see, so
  // the ON arm below has something to prove.
  assert.equal(
    off.entities.length,
    0,
    "PROSE must extract 0 structural entities — otherwise arm (b) proves nothing",
  );
});

test("(b) flag ON: prose query gains kb_lookup entities from the default seed", () => {
  const on = runArm({ flag: true, text: PROSE });

  assert.equal(on.degraded_reason, null);
  assert.ok(
    on.populatorEntityIds.includes("project:chat-claude-code:fernwick"),
    `populatorEntityIds missing the gazetteer id: ${JSON.stringify(on.populatorEntityIds)}`,
  );
  const fernwick = on.entities.find(
    (e) => e.canonical_id === "project:chat-claude-code:fernwick",
  );
  assert.ok(fernwick, "no entity for project:chat-claude-code:fernwick");
  assert.equal(fernwick.evidence, "kb_lookup");
  assert.equal(fernwick.stamped_by, "cascade:gazetteer");
  assert.equal(fernwick.source_scope, SOURCE);
  // `FW-3` is a second seed surface in the same text; the merge must not stop
  // at the first hit.
  assert.ok(
    on.populatorEntityIds.includes("project:chat-claude-code:fw_3"),
    `populatorEntityIds missing the second seed hit: ${JSON.stringify(on.populatorEntityIds)}`,
  );
  // The substrate fallback (recall.js: `populatorEntityIds.length > 0`) is the
  // gate this arm actually unblocks.
  assert.ok(on.populatorEntityIds.length > 0);
});

test("(c) flag ON: a surface both extractors reach appears ONCE, structural wins", () => {
  const on = runArm({ flag: true, text: COLLIDING });

  assert.equal(on.degraded_reason, null);
  // Non-vacuity: the structural pass must genuinely have produced the id, or
  // there is no collision to dedupe.
  assert.ok(
    on.structural.some(
      (e) => e.canonical_id === "project:chat-claude-code:fernwick",
    ),
    "structural pass did not emit the colliding id — the arm would be vacuous",
  );
  const hits = on.entities.filter(
    (e) => e.canonical_id === "project:chat-claude-code:fernwick",
  );
  assert.equal(hits.length, 1, "duplicate canonical_id survived the merge");
  assert.equal(
    hits[0].evidence,
    "structural",
    "the gazetteer row displaced the structural one — structural must win",
  );
  // Structural rows keep their order; the gazetteer may only append.
  assert.deepEqual(on.entities.slice(0, on.structural.length), on.structural);
});

test("(d) flag ON: `ledgerIndex` / `subledgers` do NOT mint the Ledger entity", () => {
  const on = runArm({ flag: true, text: LEDGER_HAZARD });

  assert.equal(on.degraded_reason, null);
  assert.equal(
    on.populatorEntityIds.includes("project:chat-claude-code:ledger"),
    false,
    "substring match leaked: `Ledger` matched inside ledgerIndex/subledgers",
  );
  // Guard the guard: the same seed entry MUST still match as a whole word,
  // otherwise arm (d) would pass for the wrong reason (a dead seed entry).
  const live = runArm({ flag: true, text: "the Ledger project ships today" });
  assert.ok(
    live.populatorEntityIds.includes("project:chat-claude-code:ledger"),
    "the Ledger seed entry no longer matches at all — (d) proves nothing",
  );
});

test("(e) flag ON + gazetteer throws: degrades to structural, one reason, no loss", () => {
  const on = runArm({ flag: true, arm: "throw", text: COLLIDING });

  assert.equal(on.degraded_reason, "query_gazetteer_threw");
  // Structural entities SURVIVE — the throw may not empty the axis.
  assert.ok(
    on.structural.length > 0,
    "COLLIDING must yield structural entities — otherwise survival proves nothing",
  );
  assert.deepEqual(on.entities, on.structural);
  assert.equal(on.same_reference, true);
  assert.equal(on.populatorEntityIds.length, on.structural.length);
});

test("(f) the handler wires the merge between the structural extractor and the time-anchor resolver", () => {
  // The five arms above exercise `_applyQueryGazetteer` directly. This arm
  // pins that the recall handler still CALLS it, and calls it at the position
  // whose blast radius the comments describe — deleting the wire-up while
  // keeping the helper would otherwise leave this suite green.
  const src = readFileSync(RECALL_PATH, "utf8");
  const structuralCatch = src.indexOf(
    'populatorDegradedReasons.push("entity_extractor_threw")',
  );
  const callSite = src.indexOf("_applyQueryGazetteer(\n      populatorEntities,");
  const timeAnchor = src.indexOf("const { anchors } = resolveTimeAnchors(populatorText");

  assert.ok(structuralCatch > 0, "structural extractor try/catch not found");
  assert.ok(
    callSite > 0,
    "handler no longer calls _applyQueryGazetteer(populatorEntities, ...)",
  );
  assert.ok(timeAnchor > 0, "time-anchor resolver call not found");
  assert.ok(
    structuralCatch < callSite && callSite < timeAnchor,
    "the gazetteer merge must sit AFTER the structural try/catch and BEFORE " +
      "the time-anchor resolver (it feeds computeQueryEpisodicity downstream)",
  );
  // The recognizer must come from the shipped module and must be called with
  // NO `seed` option, so it falls through to the curated DEFAULT_GAZETTEER_SEED
  // rather than a seed built from the entity substrate.
  assert.ok(
    /import \{ extractGazetteerEntities \} from "\.\.\/synthesis\/gazetteer\.js";/.test(src),
    "recall.js no longer imports extractGazetteerEntities from lib/synthesis/gazetteer.js",
  );
  assert.equal(
    /__gazetteerImpl\(text, \{ source \}\)/.test(src),
    true,
    "the gazetteer call must pass ONLY {source} — no seed override",
  );
});
