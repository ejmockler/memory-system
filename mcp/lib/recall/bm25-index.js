// bm25-index.js — Phase 3 v0 (recall layer / Layer 1 hybrid candidate gen).
//
// In-memory BM25 inverted index over IndexEntry.content, with a secondary
// entity inverted index over IndexEntry.entities. Serializable to a plain
// JSON object for persistence at
// `indices/<embedding_model_version>/bm25.json`.
//
// Authoritative shape contracts: kb/phase3-v0-contracts.md.
// Authoritative spec: kb/research-retrieval-frontiers.md.
//
// Pipeline role: BM25 supplies one of two candidate streams for RRF (k=60)
// in the hybrid retriever. The graceful-degrade path also uses BM25 alone
// when Gemini is unavailable at recall-time (emits `degraded_recall=true`).
//
// Tokenization: lowercase, split on /\W+/, drop empty tokens and a small
// built-in English stopword list (~50 words). No stemming in v0 — defer to
// v1 once we observe real recall traffic. The stopword list and tokenizer
// are also re-applied at query-time (search) and entity-normalization at
// indexing/search; this keeps the index symmetric with the query.
//
// Entity index integration: a separate Map<entity_lowercased, Set<memory_id>>.
// `searchEntities(entityList, topK)` returns memories ranked by how many of
// the supplied entities they carry. This feeds the entity_overlap_jaccard
// soft feature in Layer 2 scoring; the BM25 index proper does NOT pollute
// its IDF statistics with entity tokens, since entities can be arbitrary
// strings (names, places, agent_ids) whose IDF would dominate the corpus.
//
// BM25 parameters: standard k1=1.2, b=0.75. Score for a query Q and doc d:
//   score(d, Q) = Σ_{t in Q} IDF(t) * (tf(t,d) * (k1+1))
//                              / (tf(t,d) + k1 * (1 - b + b * |d|/avgdl))
// where IDF(t) = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1).
//
// remove(memory_id) propagates an excise: it removes the doc from postings,
// doc-stats, and the entity index; subsequent searches will not return it.

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

// Small built-in English stopword list (~50). Intentionally short — BM25's
// IDF already down-weights common terms; this list catches the worst noise.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by",
  "for", "from", "had", "has", "have", "he", "her", "his",
  "i", "if", "in", "into", "is", "it", "its", "itself",
  "me", "my", "no", "not", "of", "off", "on", "or", "our",
  "she", "so", "that", "the", "their", "them", "then", "there",
  "they", "this", "to", "too", "was", "we", "were", "what",
  "when", "where", "which", "who", "will", "with", "would",
  "you", "your", "yours",
]);

function tokenize(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const lower = text.toLowerCase();
  const raw = lower.split(/\W+/);
  const out = [];
  for (const tok of raw) {
    if (tok.length === 0) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

function normalizeEntity(ent) {
  if (typeof ent !== "string") return null;
  const trimmed = ent.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export class Bm25Index {
  constructor({ k1 = DEFAULT_K1, b = DEFAULT_B } = {}) {
    this.k1 = k1;
    this.b = b;

    // Inverted index: token -> Map<memory_id, term_frequency>.
    this._postings = new Map();
    // doc_id -> doc length (number of post-stopword tokens).
    this._docLen = new Map();
    // doc_id -> { kind, ts } metadata kept light; not used in BM25 itself,
    // but useful for callers that want to filter post-hoc. v0 only stores
    // the bare minimum to keep serialization compact.
    this._docMeta = new Map();
    // Running sum of all doc lengths for O(1) avgdl computation.
    this._totalDocLen = 0;

    // Secondary entity index: entity (lowercased) -> Set<memory_id>.
    this._entityIndex = new Map();
    // Reverse lookup for excise propagation: doc_id -> Set<entity>.
    this._docEntities = new Map();
  }

  size() {
    return this._docLen.size;
  }

  avgDocLen() {
    const n = this._docLen.size;
    if (n === 0) return 0;
    return this._totalDocLen / n;
  }

  add(entry) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Bm25Index.add: entry must be an object");
    }
    const id = entry.memory_id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("Bm25Index.add: entry.memory_id required");
    }
    // Re-adding the same memory_id is treated as a replacement.
    if (this._docLen.has(id)) {
      this.remove(id);
    }

    const tokens = tokenize(entry.content || "");
    const tf = new Map();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    for (const [t, freq] of tf) {
      let postings = this._postings.get(t);
      if (!postings) {
        postings = new Map();
        this._postings.set(t, postings);
      }
      postings.set(id, freq);
    }
    this._docLen.set(id, tokens.length);
    this._totalDocLen += tokens.length;
    this._docMeta.set(id, {
      kind: entry.kind || null,
      ts: entry.ts || null,
    });

    // Entity index.
    const entitySet = new Set();
    if (Array.isArray(entry.entities)) {
      for (const raw of entry.entities) {
        const norm = normalizeEntity(raw);
        if (norm === null) continue;
        entitySet.add(norm);
        let bucket = this._entityIndex.get(norm);
        if (!bucket) {
          bucket = new Set();
          this._entityIndex.set(norm, bucket);
        }
        bucket.add(id);
      }
    }
    if (entitySet.size > 0) {
      this._docEntities.set(id, entitySet);
    }
  }

  addBulk(entries) {
    if (!Array.isArray(entries)) {
      throw new Error("Bm25Index.addBulk: entries must be an array");
    }
    for (const e of entries) this.add(e);
  }

  remove(memory_id) {
    if (typeof memory_id !== "string") return;
    const len = this._docLen.get(memory_id);
    if (len === undefined) return;

    // Remove from postings.
    for (const [token, postings] of this._postings) {
      if (postings.has(memory_id)) {
        postings.delete(memory_id);
        if (postings.size === 0) this._postings.delete(token);
      }
    }
    this._docLen.delete(memory_id);
    this._totalDocLen -= len;
    this._docMeta.delete(memory_id);

    // Remove from entity index.
    const ents = this._docEntities.get(memory_id);
    if (ents) {
      for (const ent of ents) {
        const bucket = this._entityIndex.get(ent);
        if (bucket) {
          bucket.delete(memory_id);
          if (bucket.size === 0) this._entityIndex.delete(ent);
        }
      }
      this._docEntities.delete(memory_id);
    }
  }

  _idf(token) {
    const postings = this._postings.get(token);
    const df = postings ? postings.size : 0;
    const N = this._docLen.size;
    // Standard BM25 IDF with +1 smoothing to avoid negative IDF for very
    // common tokens. ln((N - df + 0.5) / (df + 0.5) + 1).
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  }

  search(query, topK = 50) {
    const tokens = tokenize(query);
    if (tokens.length === 0 || this._docLen.size === 0) return [];

    const avgdl = this.avgDocLen() || 1;
    const k1 = this.k1;
    const b = this.b;

    const scores = new Map(); // memory_id -> accumulated score

    // Deduplicate query tokens — IDF*tf-saturation is naturally additive over
    // unique terms; counting duplicates would double-count IDF.
    const uniqTokens = new Set(tokens);
    for (const token of uniqTokens) {
      const postings = this._postings.get(token);
      if (!postings) continue;
      const idf = this._idf(token);
      for (const [docId, tf] of postings) {
        const dl = this._docLen.get(docId) || 0;
        const denom = tf + k1 * (1 - b + b * (dl / avgdl));
        const contribution = idf * ((tf * (k1 + 1)) / denom);
        scores.set(docId, (scores.get(docId) || 0) + contribution);
      }
    }

    const arr = [];
    for (const [memory_id, score] of scores) {
      arr.push({ memory_id, score });
    }
    // Sort: descending score, then memory_id ascending for deterministic ties.
    arr.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0;
    });
    const out = arr.slice(0, Math.max(0, topK));
    return out.map((r, i) => ({
      memory_id: r.memory_id,
      score: r.score,
      rank: i,
    }));
  }

  searchEntities(entityList, topK = 50) {
    if (!Array.isArray(entityList) || entityList.length === 0) return [];
    const wanted = new Set();
    for (const raw of entityList) {
      const norm = normalizeEntity(raw);
      if (norm !== null) wanted.add(norm);
    }
    if (wanted.size === 0) return [];

    const counts = new Map(); // memory_id -> count of matching entities
    for (const ent of wanted) {
      const bucket = this._entityIndex.get(ent);
      if (!bucket) continue;
      for (const docId of bucket) {
        counts.set(docId, (counts.get(docId) || 0) + 1);
      }
    }
    const arr = [];
    for (const [memory_id, count] of counts) {
      arr.push({ memory_id, count });
    }
    arr.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0;
    });
    const out = arr.slice(0, Math.max(0, topK));
    return out.map((r, i) => ({
      memory_id: r.memory_id,
      count: r.count,
      rank: i,
    }));
  }

  serialize() {
    // Plain JSON-safe object. Maps become arrays of [key, value] entries;
    // Sets become arrays. This is the format persisted to bm25.json.
    const postings = [];
    for (const [token, docs] of this._postings) {
      const docsArr = [];
      for (const [docId, tf] of docs) docsArr.push([docId, tf]);
      postings.push([token, docsArr]);
    }
    const docLen = [];
    for (const [docId, len] of this._docLen) docLen.push([docId, len]);
    const docMeta = [];
    for (const [docId, meta] of this._docMeta) docMeta.push([docId, meta]);
    const entityIndex = [];
    for (const [ent, docs] of this._entityIndex) {
      entityIndex.push([ent, Array.from(docs)]);
    }
    const docEntities = [];
    for (const [docId, ents] of this._docEntities) {
      docEntities.push([docId, Array.from(ents)]);
    }
    return {
      version: 1,
      params: { k1: this.k1, b: this.b },
      postings,
      doc_len: docLen,
      doc_meta: docMeta,
      total_doc_len: this._totalDocLen,
      entity_index: entityIndex,
      doc_entities: docEntities,
    };
  }

  static deserialize(data) {
    if (!data || typeof data !== "object") {
      throw new Error("Bm25Index.deserialize: data must be an object");
    }
    if (data.version !== 1) {
      throw new Error(
        `Bm25Index.deserialize: unsupported version ${data.version}`,
      );
    }
    const params = data.params || {};
    const idx = new Bm25Index({
      k1: typeof params.k1 === "number" ? params.k1 : DEFAULT_K1,
      b: typeof params.b === "number" ? params.b : DEFAULT_B,
    });
    for (const [token, docsArr] of data.postings || []) {
      const inner = new Map();
      for (const [docId, tf] of docsArr) inner.set(docId, tf);
      idx._postings.set(token, inner);
    }
    for (const [docId, len] of data.doc_len || []) idx._docLen.set(docId, len);
    for (const [docId, meta] of data.doc_meta || []) {
      idx._docMeta.set(docId, meta);
    }
    idx._totalDocLen = typeof data.total_doc_len === "number"
      ? data.total_doc_len
      : 0;
    for (const [ent, docs] of data.entity_index || []) {
      idx._entityIndex.set(ent, new Set(docs));
    }
    for (const [docId, ents] of data.doc_entities || []) {
      idx._docEntities.set(docId, new Set(ents));
    }
    return idx;
  }
}

export const _internals = { tokenize, normalizeEntity, STOPWORDS };
