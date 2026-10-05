// bm25-streaming-loader.js — WU-RR1-bm25-rebuild.
//
// Streaming reader for the v2 BM25 on-disk format written by
// bm25-rebuild.js's writeBm25IndexAtomic. Loads a multi-hundred-megabyte
// bm25.json file into a Bm25Index WITHOUT ever materializing the whole
// file as a single string (which would exceed Node's MAX_STRING_LENGTH
// cap of ~512 MiB / 0x1FFFFFFF8 — the same cap that necessitated the
// streaming WRITER in bm25-rebuild.js).
//
// v2 format recap (one JSON value per line):
//   line 1   : {"version":2,"params":{"k1":...,"b":...},"total_doc_len":N}
//   line 2..N: ["P"|"L"|"M"|"E"|"D", ...payload]
//
// v1 format detection: the first byte is "{" for both v1 (legacy single-
// object) and v2 (line-delimited). The discriminator is whether the second
// line exists and parses as an array starting with "P"/"L"/"M"/"E"/"D" —
// in practice we route by `version` field on the parsed header.
//
// Defensive: a malformed line is silently skipped (so a torn write at
// rebuild-time falls back gracefully — the Bm25Index ends up missing
// some entries rather than throwing). The caller (index-cache.js) can
// always observe partial-load by comparing the resulting index.size()
// against the ledger fact count.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { Bm25Index } from "./bm25-index.js";

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * loadBm25IndexFromV2File — stream a v2-format bm25.json into a Bm25Index.
 *
 * @param {string} path Absolute path to the bm25.json file.
 * @param {object} [opts]
 * @param {number} [opts.maxLineBytes] Max bytes for a single posting line.
 *                                      Default 64 MiB (the heaviest line
 *                                      is one token's posting list; a
 *                                      pathological token appearing in
 *                                      every doc bounds this above).
 * @returns {Bm25Index}
 */
export function loadBm25IndexFromV2File(path, opts = {}) {
  const maxLineBytes =
    Number.isInteger(opts.maxLineBytes) && opts.maxLineBytes > 0
      ? opts.maxLineBytes
      : 64 * 1024 * 1024;

  const fd = openSync(path, "r");
  // We feed lines into a Bm25Index instance via direct internal mutation —
  // we already trust the disk format (we wrote it). Going through
  // Bm25Index.add would re-tokenize the content, but the on-disk format
  // already contains post-tokenize postings; we want to restore the
  // exact in-memory state, not recompute it.
  const idx = new Bm25Index();
  let headerSeen = false;
  let pending = "";
  let abandonLine = false;
  let position = 0;
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  try {
    while (true) {
      let bytesRead;
      try {
        bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      } catch {
        break;
      }
      if (bytesRead === 0) break;
      position += bytesRead;
      const text = chunk.toString("utf8", 0, bytesRead);
      let cursor = 0;
      while (cursor < text.length) {
        const nl = text.indexOf("\n", cursor);
        if (nl < 0) {
          if (!abandonLine) {
            if (pending.length + (text.length - cursor) > maxLineBytes) {
              abandonLine = true;
              pending = "";
            } else {
              pending += text.slice(cursor);
            }
          }
          break;
        }
        if (abandonLine) {
          abandonLine = false;
        } else {
          if (pending.length + (nl - cursor) > maxLineBytes) {
            pending = "";
          } else {
            const line = pending + text.slice(cursor, nl);
            pending = "";
            if (line.length > 0) {
              try {
                const parsed = JSON.parse(line);
                if (!headerSeen) {
                  applyHeader(idx, parsed);
                  headerSeen = true;
                } else {
                  applyEntry(idx, parsed);
                }
              } catch {
                // Skip torn / malformed line; loader continues.
              }
            }
          }
        }
        cursor = nl + 1;
      }
    }
    if (!abandonLine && pending.length > 0) {
      try {
        const parsed = JSON.parse(pending);
        if (!headerSeen) {
          applyHeader(idx, parsed);
          headerSeen = true;
        } else {
          applyEntry(idx, parsed);
        }
      } catch {
        // skip
      }
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
  if (!headerSeen) {
    throw new Error("loadBm25IndexFromV2File: header line missing or unparseable");
  }
  return idx;
}

function applyHeader(idx, header) {
  if (!header || typeof header !== "object") return;
  if (header.version !== 2) {
    throw new Error(
      `loadBm25IndexFromV2File: unsupported version ${header.version}`,
    );
  }
  const params = header.params || {};
  if (typeof params.k1 === "number") idx.k1 = params.k1;
  if (typeof params.b === "number") idx.b = params.b;
  if (typeof header.total_doc_len === "number") {
    idx._totalDocLen = header.total_doc_len;
  }
}

function applyEntry(idx, entry) {
  if (!Array.isArray(entry) || entry.length < 2) return;
  const tag = entry[0];
  if (tag === "P") {
    // ["P", token, [[docId, tf], ...]]
    if (entry.length < 3) return;
    const token = entry[1];
    const docsArr = entry[2];
    if (typeof token !== "string" || !Array.isArray(docsArr)) return;
    const inner = new Map();
    for (const pair of docsArr) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      if (typeof pair[0] !== "string") continue;
      inner.set(pair[0], pair[1]);
    }
    idx._postings.set(token, inner);
  } else if (tag === "L") {
    // ["L", docId, len]
    if (entry.length < 3) return;
    const docId = entry[1];
    const len = entry[2];
    if (typeof docId !== "string" || typeof len !== "number") return;
    idx._docLen.set(docId, len);
  } else if (tag === "M") {
    // ["M", docId, meta]
    if (entry.length < 3) return;
    const docId = entry[1];
    if (typeof docId !== "string") return;
    idx._docMeta.set(docId, entry[2]);
  } else if (tag === "E") {
    // ["E", ent, [docId, ...]]
    if (entry.length < 3) return;
    const ent = entry[1];
    const docs = entry[2];
    if (typeof ent !== "string" || !Array.isArray(docs)) return;
    idx._entityIndex.set(ent, new Set(docs));
  } else if (tag === "D") {
    // ["D", docId, [ent, ...]]
    if (entry.length < 3) return;
    const docId = entry[1];
    const ents = entry[2];
    if (typeof docId !== "string" || !Array.isArray(ents)) return;
    idx._docEntities.set(docId, new Set(ents));
  }
  // Unknown tags are silently dropped — forward-compat surface for future
  // entry kinds.
}

/**
 * isV2File — peek the first 32 bytes of the file and decide whether it's
 * v2 (line-delimited) or v1 (single-object JSON). Heuristic: v2 always
 * starts with `{"version":2` (the writer is the sole producer; the
 * first line is the header). Anything else routes to the legacy
 * JSON.parse(readFileSync) path in index-cache.js.
 */
export function isV2File(path) {
  try {
    const size = statSync(path).size;
    if (size === 0) return false;
    const fd = openSync(path, "r");
    try {
      const peek = Buffer.alloc(32);
      const n = readSync(fd, peek, 0, peek.length, 0);
      const head = peek.toString("utf8", 0, n);
      return head.startsWith('{"version":2');
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
