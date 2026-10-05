// entity-index-grow-persist.test.mjs — H3 regression coverage for the
// checkpoint-cache warm-grow persistence seam.
//
// Run: cd mcp && node test/entity-index-grow-persist.test.mjs

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadOrRebuildIndex,
  lookupByEntity,
  rebuildEntityIndex,
  _resetEntityIndexCache,
} from "../lib/synthesis/entity-index.js";
import { verifyPrefix } from "../lib/synthesis/ledger-checkpoint.js";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "h3-entity-grow-persist-"));
const FLAG = "ENTITY_INDEX_CHECKPOINT_CACHE";

after(() => {
  delete process.env[FLAG];
  _resetEntityIndexCache();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function rowLine(id, canonicalIds) {
  return `${JSON.stringify({
    id,
    kind: "fact",
    ts: "2026-08-06T00:00:00Z",
    features: {
      entities: canonicalIds.map((canonical_id) => ({ canonical_id })),
    },
  })}\n`;
}

function cacheAt(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("flag-on warm grow advances a witness-certified disk cache in the same process", async () => {
  const ws = join(TMP_ROOT, "warm-grow");
  const ledgerPath = join(ws, "memory.jsonl");
  const cachePath = join(ws, "entity-index.cache.json");
  mkdirSync(ws, { recursive: true, mode: 0o700 });

  process.env[FLAG] = "1";
  _resetEntityIndexCache();
  writeFileSync(ledgerPath, rowLine("mem-1", ["person:h3:alice"]), {
    mode: 0o600,
  });

  await loadOrRebuildIndex({ ledgerPath, cachePath });
  const before = cacheAt(cachePath);
  assert.ok(before.checkpoint, "the cold flag-on cache must carry a checkpoint");

  // Deliberately stay process-warm: this second call must take the shared
  // projection's grow branch, not cold-seed again.
  appendFileSync(ledgerPath, rowLine("mem-2", ["person:h3:bob"]));
  const future = new Date(Date.now() + 5000);
  utimesSync(ledgerPath, future, future);
  const warm = await loadOrRebuildIndex({ ledgerPath, cachePath });

  assert.deepEqual(lookupByEntity(warm, "person:h3:bob"), ["mem-2"]);
  const afterGrowBytes = readFileSync(cachePath, "utf8");
  const afterGrow = JSON.parse(afterGrowBytes);
  const ledgerStat = statSync(ledgerPath);
  assert.equal(
    afterGrow.ledger_mtime_ms,
    warm.ledgerMtime,
    "the advisory float mtime advances with the warm projection",
  );
  assert.equal(afterGrow.ledger_mtime_ms, ledgerStat.mtimeMs);
  assert.ok(afterGrow.checkpoint.eof > before.checkpoint.eof);
  assert.equal(
    afterGrow.checkpoint.eof,
    ledgerStat.size,
    "the persisted witness certifies exactly the bytes folded into entries",
  );
  assert.deepEqual(afterGrow.entries["person:h3:bob"], ["mem-2"]);
  assert.deepEqual(verifyPrefix(ledgerPath, afterGrow.checkpoint), {
    ok: true,
    reason: null,
  });

  // A simulated fresh process must accept the advanced cache without rewriting
  // it. Byte stability here distinguishes an exact checkpoint hit from a
  // rebuild that merely happens to return the same logical entries.
  _resetEntityIndexCache();
  const cold = await loadOrRebuildIndex({ ledgerPath, cachePath });
  assert.deepEqual(lookupByEntity(cold, "person:h3:bob"), ["mem-2"]);
  assert.equal(readFileSync(cachePath, "utf8"), afterGrowBytes);
});

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

async function proveParity({ flagOn, name, seed }) {
  const ws = join(TMP_ROOT, name);
  const ledgerPath = join(ws, "memory.jsonl");
  const cachePath = join(ws, "entity-index.cache.json");
  mkdirSync(ws, { recursive: true, mode: 0o700 });
  writeFileSync(ledgerPath, "", { mode: 0o600 });
  if (flagOn) process.env[FLAG] = "1";
  else delete process.env[FLAG];
  _resetEntityIndexCache();

  const random = prng(seed);
  let rowSeq = 0;
  let checked = 0;
  for (let round = 0; round < 140; round++) {
    const rowsThisRound = 1 + (random() % 3);
    for (let n = 0; n < rowsThisRound; n++) {
      const entities = [];
      const entitiesThisRow = 1 + (random() % 3);
      for (let e = 0; e < entitiesThisRow; e++) {
        entities.push(`topic:h3:key_${random() % 200}`);
      }
      appendFileSync(ledgerPath, rowLine(`mem-${rowSeq++}`, entities));
    }

    // `loaded` exercises the process-warm append-aware path. `oracle` streams
    // the complete ledger independently, so this is observed semantic parity,
    // not an assertion that the flag-off code "should be unchanged".
    const loaded = await loadOrRebuildIndex({ ledgerPath, cachePath });
    const oracle = await rebuildEntityIndex({ ledgerPath });
    for (let key = 0; key < 200; key++) {
      const canonicalId = `topic:h3:key_${key}`;
      assert.deepEqual(
        lookupByEntity(loaded, canonicalId),
        lookupByEntity(oracle, canonicalId),
        `${name}: round ${round}, ${canonicalId}`,
      );
      checked += 1;
    }
  }
  return checked;
}

test("flag-off and flag-on warm paths each match full rebuild truth over 28,000 deterministic fuzzed lookups", async () => {
  const offChecked = await proveParity({
    flagOn: false,
    name: "parity-off",
    seed: 0x48334f46,
  });
  const onChecked = await proveParity({
    flagOn: true,
    name: "parity-on",
    seed: 0x48334f4e,
  });
  assert.equal(offChecked, 28_000);
  assert.equal(onChecked, 28_000);
});
