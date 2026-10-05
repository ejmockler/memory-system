// ledger-stream-by-id.test.mjs — E4 2026-09 regression gate for
// streamLedgerRowsById (lib/synthesis/_ledger-stream.js).
//
// DEFECT (observed live 2026-09-15): the helper's docstring and both callers
// (scripts/reembed-local-4096.mjs collectContents, lib/recall/
// embed-population-census.js) described it as latest-write-wins, but a
// `remaining` counter short-circuited the callback once every wanted id had
// been seen ONCE — so a re-appended id resolved to its FIRST row, not its
// last. Rows [a:OLD, b, a:NEW] with want {a, b} returned a => OLD.
//
// These cases pin:
//   1. re-appended id resolves to its LAST fact row (latest-write-wins);
//   2. ids never seen are absent and never counted toward size;
//   3. a wanted row carrying a raw U+2028 comes back intact (byte-split
//      reader, FE3-1 class — never node:readline);
//   4. a LATER row for a wanted id whose kind !== "fact" does NOT overwrite
//      the earlier fact row (the kind filter runs before the Map write, so
//      latest-write-wins is latest-FACT-write-wins).
//
// HERMETIC: a tmp ledger under mkdtempSync, mirroring dense-reembed-infra
// E1's fixture style. The live ledger is never opened.
//
// Run: node test/synthesis/ledger-stream-by-id.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { streamLedgerRowsById } from "../../lib/synthesis/_ledger-stream.js";

function withLedger(rows, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-by-id-e4-"));
  try {
    const path = join(dir, "memory.jsonl");
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(path, body);
    return fn(path, body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("1: a re-appended wanted id resolves to its LAST fact row (latest-write-wins)", () => {
  withLedger(
    [
      { kind: "fact", id: "a", content: "OLD" },
      { kind: "fact", id: "b", content: "b-content" },
      { kind: "fact", id: "a", content: "NEW" },
    ],
    (path) => {
      const out = streamLedgerRowsById(path, new Set(["a", "b"]));
      assert.equal(out.size, 2, "one entry per wanted id that exists");
      assert.equal(out.get("a").content, "NEW", "the later row wins for a re-appended id");
      assert.ok(out.has("b"), "b is present");
      assert.equal(out.get("b").content, "b-content");
    },
  );
});

test("2: ids never seen are absent; size counts only present ids", () => {
  withLedger(
    [
      { kind: "fact", id: "present_1", content: "x" },
      { kind: "fact", id: "present_2", content: "y" },
      { kind: "fact", id: "unwanted", content: "never requested" },
    ],
    (path) => {
      const out = streamLedgerRowsById(path, new Set(["present_1", "present_2", "ghost_1", "ghost_2"]));
      assert.equal(out.size, 2, "only ids with a ledger row are materialized");
      assert.equal(out.has("ghost_1"), false);
      assert.equal(out.has("ghost_2"), false);
      assert.equal(out.has("unwanted"), false, "non-wanted rows are never retained");
      assert.deepEqual([...out.keys()].sort(), ["present_1", "present_2"]);
    },
  );
});

test("3: a wanted row carrying a raw U+2028 returns intact (byte-split reader)", () => {
  const SEP = " ";
  withLedger(
    [
      { kind: "fact", id: "mem_u2028", content: `before${SEP}after` },
      { kind: "fact", id: "mem_plain", content: "plain" },
    ],
    (path, body) => {
      // Non-vacuity: JSON.stringify leaves U+2028 unescaped, so the fixture
      // really carries the raw separator a readline reader would split on.
      assert.ok(body.includes(SEP), "fixture carries a raw U+2028 inside a JSON string");
      const out = streamLedgerRowsById(path, new Set(["mem_u2028", "mem_plain"]));
      assert.equal(out.size, 2);
      const u = out.get("mem_u2028");
      assert.equal(u.content, `before${SEP}after`, "content is returned intact");
      assert.equal(u.content.charCodeAt(6), 0x2028, "char code 0x2028 at its position");
      assert.equal(out.get("mem_plain").content, "plain", "the row AFTER the U+2028 row still resolves");
    },
  );
});

test("4: a LATER non-fact row for a wanted id does not overwrite the earlier fact row", () => {
  withLedger(
    [
      { kind: "fact", id: "a", content: "FACT" },
      { kind: "note", id: "a", content: "NOTE-LATER" },
      { kind: "reconstructed", id: "a", content: "RECON-LATER" },
    ],
    (path) => {
      const out = streamLedgerRowsById(path, new Set(["a"]));
      assert.equal(out.size, 1);
      assert.equal(out.get("a").kind, "fact", "only kind === 'fact' rows are eligible");
      assert.equal(out.get("a").content, "FACT",
        "latest-write-wins is latest-FACT-write-wins: the kind filter runs before the Map write");
    },
  );
});
