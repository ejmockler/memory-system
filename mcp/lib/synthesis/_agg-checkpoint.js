// Aggregation-incremental checkpoint primitive.
// Mirrors the watermark source-cursor discipline: a tiny JSON cursor with
// stringified offsets, atomic tmp/fsync/rename persistence, and stale-state
// self-heal against ledger size/inode fingerprints.

import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

const CHECKPOINT_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function fsyncDirSafe(dirPath) {
  let fd = -1;
  try {
    fd = openSync(dirPath, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch (err) {
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL" && err.code !== "ENOENT") {
      throw err;
    }
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort directory durability only.
      }
    }
  }
}

function finiteIntegerOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

function offsetForWrite(offset) {
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function optionalIntegerString(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(Math.trunc(n));
}

function isoNow(now) {
  const d = now instanceof Date ? now : now == null ? new Date() : new Date(now);
  if (Number.isFinite(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

function parseCheckpoint(checkpointPath) {
  let raw;
  try {
    raw = readFileSync(checkpointPath, "utf8");
  } catch {
    return null;
  }
  if (raw === "") return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.version !== CHECKPOINT_VERSION) return null;
  return parsed;
}

export function readCheckpointRecord(checkpointPath) {
  return parseCheckpoint(checkpointPath);
}

export function readCheckpoint(checkpointPath, { ledgerSize, ledgerIno } = {}) {
  try {
    const record = parseCheckpoint(checkpointPath);
    if (record == null) return 0;

    const offset = finiteIntegerOrNull(record.last_offset);
    if (offset == null) return 0;

    if (Number.isFinite(ledgerSize) && offset > ledgerSize) return 0;

    const storedIno =
      record.ino === undefined || record.ino === null
        ? null
        : finiteIntegerOrNull(record.ino);
    if (Number.isFinite(ledgerIno) && storedIno != null && storedIno !== ledgerIno) {
      return 0;
    }

    return offset;
  } catch {
    return 0;
  }
}

export function writeCheckpoint(
  checkpointPath,
  offset,
  { aggregator = "", ino, ledgerSize, now } = {},
) {
  const dir = dirname(checkpointPath);
  const tmp = `${checkpointPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  let fd = -1;

  const record = {
    version: CHECKPOINT_VERSION,
    aggregator: String(aggregator ?? ""),
    last_offset: String(offsetForWrite(offset)),
    updated_at: isoNow(now),
  };

  const inoString = optionalIntegerString(ino);
  if (inoString != null) record.ino = inoString;

  const ledgerSizeString = optionalIntegerString(ledgerSize);
  if (ledgerSizeString != null) record.ledger_size = ledgerSizeString;

  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fd = openSync(tmp, "w", FILE_MODE);

    const buf = Buffer.from(JSON.stringify(record), "utf8");
    let written = 0;
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written);
      if (n <= 0) throw new Error("short checkpoint write");
      written += n;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;

    renameSync(tmp, checkpointPath);
    fsyncDirSafe(dir);
    return true;
  } catch {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors during failed checkpoint persistence.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Ignore cleanup errors; callers get false.
    }
    return false;
  }
}

export function resolveStartOffset(checkpointPath, ledgerPath, { aggregator } = {}) {
  void aggregator;
  try {
    const st = statSync(ledgerPath);
    return readCheckpoint(checkpointPath, {
      ledgerSize: st.size,
      ledgerIno: st.ino,
    });
  } catch {
    return 0;
  }
}
