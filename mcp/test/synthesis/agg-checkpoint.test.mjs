import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readCheckpoint,
  resolveStartOffset,
  writeCheckpoint,
} from "../../lib/synthesis/_agg-checkpoint.js";

function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agg-ckpt-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fresh checkpoint reads as offset 0", () => {
  withScratch((dir) => {
    assert.equal(readCheckpoint(join(dir, "thread.json")), 0);
  });
});

test("round-trip preserves offset and stores offset as a string", () => {
  withScratch((dir) => {
    const path = join(dir, "thread.json");

    assert.equal(writeCheckpoint(path, 1_900_000_000, { aggregator: "thread" }), true);
    assert.equal(readCheckpoint(path), 1_900_000_000);

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.version, 1);
    assert.equal(typeof parsed.last_offset, "string");
    assert.equal(parsed.last_offset, "1900000000");
  });
});

test("atomic write leaves a parseable checkpoint and no tmp sibling", () => {
  withScratch((dir) => {
    const path = join(dir, "project.json");

    assert.equal(writeCheckpoint(path, 42, { aggregator: "project" }), true);

    const names = readdirSync(dir);
    assert.deepEqual(
      names.filter((name) => name.includes(".tmp.")),
      [],
    );
    assert.equal(names.includes("project.json"), true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).last_offset, "42");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("offset beyond ledger size self-heals to 0 while grown ledger resumes", () => {
  withScratch((dir) => {
    const path = join(dir, "thread.json");

    assert.equal(writeCheckpoint(path, 5000, { aggregator: "thread" }), true);
    assert.equal(readCheckpoint(path, { ledgerSize: 1000 }), 0);
    assert.equal(readCheckpoint(path, { ledgerSize: 6000 }), 5000);
  });
});

test("inode change self-heals to 0 and matching inode resumes", () => {
  withScratch((dir) => {
    const path = join(dir, "thread.json");

    assert.equal(writeCheckpoint(path, 5000, { aggregator: "thread", ino: 111 }), true);
    assert.equal(readCheckpoint(path, { ledgerSize: 1e9, ledgerIno: 222 }), 0);
    assert.equal(readCheckpoint(path, { ledgerSize: 1e9, ledgerIno: 111 }), 5000);
  });
});

test("corrupt or wrong-version checkpoint reads as 0", () => {
  withScratch((dir) => {
    const path = join(dir, "thread.json");

    writeFileSync(path, "{not json", { mode: 0o600 });
    assert.equal(readCheckpoint(path), 0);

    writeFileSync(path, JSON.stringify({ version: 2, last_offset: "123" }), {
      mode: 0o600,
    });
    assert.equal(readCheckpoint(path), 0);
  });
});

test("resolveStartOffset uses ledger stat fingerprint and tolerates missing ledger", () => {
  withScratch((dir) => {
    const checkpointPath = join(dir, "thread.json");
    const ledgerPath = join(dir, "memory.jsonl");
    const row = `${JSON.stringify({ id: "m1", kind: "fact" })}\n`;

    writeFileSync(ledgerPath, row.repeat(10), { mode: 0o600 });
    const st = statSync(ledgerPath);
    const offset = Math.max(1, Math.floor(st.size / 2));

    assert.equal(
      writeCheckpoint(checkpointPath, offset, {
        aggregator: "thread",
        ino: st.ino,
        ledgerSize: st.size,
      }),
      true,
    );
    assert.equal(resolveStartOffset(checkpointPath, ledgerPath), offset);

    truncateSync(ledgerPath, offset - 1);
    assert.equal(resolveStartOffset(checkpointPath, ledgerPath), 0);
    assert.equal(resolveStartOffset(checkpointPath, join(dir, "missing.jsonl")), 0);
  });
});
