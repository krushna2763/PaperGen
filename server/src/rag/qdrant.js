import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID, createHash } from 'crypto';
import { env } from '../config/env.js';

/**
 * Qdrant Vector Store Module (RAG Layer)
 * 
 * Manages the lifecycle of question vectors in the Qdrant collection:
 *  - Connection management via centralized client
 *  - Collection creation with cosine distance and correct vector dimension
 *  - Dimension verification against existing collections
 *  - Batch upsert of question embedding points
 *  - Payload index preparation for future filtered retrieval
 * 
 * Philosophy: ONE QUESTION = ONE CHUNK = ONE EMBEDDING = ONE QDRANT POINT
 */

// ─── Centralized Qdrant Client (singleton) ───────────────────────────────────
let _client = null;

function getClient() {
  if (_client) return _client;

  if (!env.QDRANT_URL) {
    throw new Error('[Qdrant] QDRANT_URL is not configured in environment.');
  }

  _client = new QdrantClient({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY || undefined,
  });

  console.log(`[Qdrant] Client initialized → ${env.QDRANT_URL.replace(/\/\/(.+?)@/, '//***@')}`);
  return _client;
}

// ─── Collection Name ─────────────────────────────────────────────────────────
function getCollectionName() {
  const name = env.QDRANT_COLLECTION;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('[Qdrant] QDRANT_COLLECTION is not configured in environment.');
  }
  return name.trim();
}

// ─── Public API ──────────────────────────────────────────────────────────────
export const qdrantStore = {

  /**
   * Check basic connectivity to the Qdrant instance
   * @returns {Promise<{ connected: boolean, collection: string|null }>}
   */
  async checkConnection() {
    try {
      const client = getClient();
      const collectionName = getCollectionName();

      // A lightweight health-like call — list collections
      const { collections } = await client.getCollections();
      const exists = collections.some(c => c.name === collectionName);

      return {
        connected: true,
        collection: collectionName,
        collectionExists: exists,
        totalCollections: collections.length,
      };
    } catch (err) {
      console.error('[Qdrant] Connection check failed:', err.message);
      return {
        connected: false,
        collection: null,
        collectionExists: false,
        error: err.message,
      };
    }
  },

  /**
   * Ensure the target collection exists with correct vector dimension and cosine distance.
   * If it does not exist, create it.  If it exists, verify dimension match.
   * 
   * @param {number} vectorDimension - Expected vector size (e.g. 3072)
   * @returns {Promise<{ created: boolean, collection: string, vectorDimension: number }>}
   */
  async ensureCollection(vectorDimension) {
    if (!vectorDimension || typeof vectorDimension !== 'number' || vectorDimension <= 0) {
      throw new Error(`[Qdrant] Invalid vector dimension: ${vectorDimension}`);
    }

    const client = getClient();
    const collectionName = getCollectionName();

    const { collections } = await client.getCollections();
    const exists = collections.some(c => c.name === collectionName);

    if (!exists) {
      // Create collection with cosine distance
      console.log(`[Qdrant] Collection "${collectionName}" does not exist — creating with ${vectorDimension}-d cosine vectors...`);

      await client.createCollection(collectionName, {
        vectors: {
          size: vectorDimension,
          distance: 'Cosine',
        },
      });

      // Create payload indexes for future filtered retrieval
      const indexFields = ['sourceDocumentId', 'sourceHash', 'sourceType', 'corpus', 'unit', 'class', 'subject'];
      for (const field of indexFields) {
        try {
          await client.createPayloadIndex(collectionName, {
            field_name: field,
            field_schema: 'keyword',
          });
        } catch (_indexErr) {
          // Non-critical — index creation may fail on some Qdrant tiers; log and continue
          console.warn(`[Qdrant] Payload index for "${field}" could not be created:`, _indexErr.message);
        }
      }

      console.log(`[Qdrant] Collection "${collectionName}" created successfully.`);
      return { created: true, collection: collectionName, vectorDimension };
    }

    // Collection exists — verify vector dimension matches
    const collectionInfo = await client.getCollection(collectionName);
    const existingSize = collectionInfo?.config?.params?.vectors?.size;

    if (existingSize && existingSize !== vectorDimension) {
      throw new Error(
        `[Qdrant] Dimension mismatch! Collection "${collectionName}" expects ${existingSize}-d vectors ` +
        `but the current embedding model produces ${vectorDimension}-d vectors. ` +
        `Refusing to proceed — resolve the configuration or delete the collection manually.`
      );
    }

    console.log(`[Qdrant] Collection "${collectionName}" exists with matching ${existingSize || vectorDimension}-d cosine vectors.`);
    return { created: false, collection: collectionName, vectorDimension: existingSize || vectorDimension };
  },

  /**
   * Upsert an array of embedded question objects as Qdrant points.
   * 
   * @param {Array<Object>} questions - Embedded question objects (must have .text, .embedding)
   * @param {Object} opts - { sourceDocumentId, class, subject }
   * @returns {Promise<{ indexedCount: number, skippedCount: number, pointIds: string[], collection: string, vectorDimension: number }>}
   */
  async upsertQuestions(questions, opts = {}) {
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      throw new Error('[Qdrant] No questions provided for indexing.');
    }

    const sourceDocumentId = opts.sourceDocumentId || `paper_${randomUUID().slice(0, 12)}`;
    const sourceHash = opts.sourceHash || null; // content hash → skip re-ingestion
    const docClass = opts.class || null;
    const docSubject = opts.subject || null;

    // ─── Validate every question before touching Qdrant ──────────────────────
    let detectedDimension = null;
    const validatedPoints = [];
    const skipped = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const label = q.questionNumber || `index-${i}`;

      // Text check
      if (!q.text || typeof q.text !== 'string' || q.text.trim().length === 0) {
        skipped.push({ label, reason: 'Missing or empty question text.' });
        continue;
      }

      // Embedding checks
      if (!q.embedding || !Array.isArray(q.embedding) || q.embedding.length === 0) {
        skipped.push({ label, reason: 'Missing or empty embedding vector.' });
        continue;
      }

      if (!q.embedding.every(v => typeof v === 'number' && isFinite(v))) {
        skipped.push({ label, reason: 'Embedding contains non-numeric or infinite values.' });
        continue;
      }

      if (detectedDimension === null) {
        detectedDimension = q.embedding.length;
      } else if (q.embedding.length !== detectedDimension) {
        skipped.push({ label, reason: `Dimension ${q.embedding.length} does not match expected ${detectedDimension}.` });
        continue;
      }

      // Stable deterministic point ID: hash of sourceDocumentId + questionNumber
      const pointId = generateStableUUID(`${sourceDocumentId}::${q.questionNumber || i}`);

      validatedPoints.push({
        id: pointId,
        vector: q.embedding,
        payload: {
          // TWO CORPORA: past exam questions used ONLY for source-similarity
          // dedup, never as content to ground generation in.
          corpus: 'past_paper',
          sourceDocumentId,
          sourceHash,
          sourceType: 'previous_year_paper',
          questionNumber: q.questionNumber || null,
          parentQuestionNumber: q.parentQuestionNumber || null,
          section: q.section || null,
          type: q.type || null,
          text: q.text,
          marks: q.marks ?? null,
          pageNumber: q.metadata?.pageNumber ?? null,
          class: docClass,
          subject: docSubject,
        },
      });
    }

    if (validatedPoints.length === 0) {
      throw new Error(`[Qdrant] All ${questions.length} questions were invalid or skipped. Nothing to index.`);
    }

    if (skipped.length > 0) {
      console.warn(`[Qdrant] Skipped ${skipped.length} invalid question(s):`, skipped);
    }

    // ─── Ensure collection exists with correct dimension ─────────────────────
    await this.ensureCollection(detectedDimension);

    // ─── Batch upsert ────────────────────────────────────────────────────────
    const client = getClient();
    const collectionName = getCollectionName();

    console.log(`[Qdrant] Upserting ${validatedPoints.length} points into "${collectionName}"...`);

    await client.upsert(collectionName, {
      wait: true,
      points: validatedPoints,
    });

    const pointIds = validatedPoints.map(p => p.id);

    console.log(`[Qdrant] Indexed ${validatedPoints.length} question(s) into "${collectionName}" (dim: ${detectedDimension}).`);

    return {
      indexedCount: validatedPoints.length,
      skippedCount: skipped.length,
      skippedDetails: skipped.length > 0 ? skipped : undefined,
      pointIds,
      sourceDocumentId,
      collection: collectionName,
      vectorDimension: detectedDimension,
    };
  },

  /**
   * Check whether a document with the given content hash is already indexed
   * (source reuse — avoids re-downloading, re-extracting, re-embedding and
   * re-indexing a PDF that was processed before).
   *
   * @param {string} sourceHash - SHA-256 hex digest of the PDF bytes
   * @returns {Promise<{ indexed: boolean, sourceDocumentId: string|null, pointCount: number }>}
   */
  async findExistingByHash(sourceHash) {
    if (!sourceHash || typeof sourceHash !== 'string' || sourceHash.trim().length === 0) {
      return { indexed: false, sourceDocumentId: null, pointCount: 0 };
    }
    try {
      const client = getClient();
      const collectionName = getCollectionName();

      // Qdrant rejects filtered scrolls on fields without a payload index —
      // ensure it lazily (idempotent; errors on pre-existing index are fine).
      try {
        await client.createPayloadIndex(collectionName, {
          field_name: 'sourceHash',
          field_schema: 'keyword',
        });
      } catch (_idxErr) {
        // already indexed → fine
      }

      // Scroll with a payload filter — no vector required.
      const hits = await client.scroll(collectionName, {
        limit: 1,
        with_payload: true,
        with_vector: false,
        filter: { must: [{ key: 'sourceHash', match: { value: sourceHash } }] },
      });
      const points = hits?.points ?? [];
      if (points.length === 0) {
        return { indexed: false, sourceDocumentId: null, pointCount: 0 };
      }
      return {
        indexed: true,
        sourceDocumentId: points[0].payload?.sourceDocumentId ?? null,
        pointCount: points.length,
      };
    } catch (err) {
      console.error(`[Qdrant] findExistingByHash failed: ${err.message}`);
      return { indexed: false, sourceDocumentId: null, pointCount: 0 };
    }
  },

  // ─── Syllabus corpus (notes-grounded generation) ─────────────────────────

  /**
   * Upsert syllabus note chunks. Point IDs are derived from a real SHA-256
   * digest over (sourceHash + chunkIndex) — never the collision-prone
   * generateStableUUID used by the legacy question path.
   *
   * @param {Array<{ text, embedding, chunkIndex }>} chunks
   * @param {Object} opts - { class, subject, unit, sourceHash }
   */
  async upsertSyllabusChunks(chunks, opts = {}) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      throw new Error('[Qdrant] No syllabus chunks provided for indexing.');
    }
    const cls = opts.class != null ? String(opts.class) : null;
    const subject = opts.subject != null ? String(opts.subject) : null;
    const unit = opts.unit != null ? String(opts.unit) : null;
    const sourceHash = opts.sourceHash || null;
    if (!unit) throw new Error('[Qdrant] Syllabus chunks require an explicit unit tag.');
    if (!sourceHash) throw new Error('[Qdrant] Syllabus chunks require a sourceHash.');

    let dim = null;
    const points = [];
    for (const c of chunks) {
      if (!c || !c.text || !Array.isArray(c.embedding) || c.embedding.length === 0) continue;
      if (!c.embedding.every((v) => typeof v === 'number' && isFinite(v))) continue;
      if (dim === null) dim = c.embedding.length;
      else if (c.embedding.length !== dim) continue;
      points.push({
        id: stablePointId(`${sourceHash}:${c.chunkIndex}`),
        vector: c.embedding,
        payload: {
          corpus: 'syllabus',
          class: cls,
          subject,
          unit,
          sourceHash,
          chunkIndex: c.chunkIndex,
          text: c.text,
        },
      });
    }
    if (points.length === 0) throw new Error('[Qdrant] All syllabus chunks were invalid — nothing to index.');

    await this.ensureCollection(dim);
    const client = getClient();
    const name = getCollectionName();
    await client.upsert(name, { wait: true, points });
    console.log(`[Qdrant] Indexed ${points.length} syllabus chunk(s) for unit "${unit}" (${dim}-d).`);
    return { indexedCount: points.length, vectorDimension: dim, unit, sourceHash };
  },

  /**
   * Has this exact notes file (by content hash) already been ingested FOR THE
   * SAME class + subject + unit? Scope matters: the same PDF may legitimately
   * be filed under a different subject/unit, and that must NOT be skipped as a
   * duplicate — otherwise the notes never get tagged for the new paper.
   * @param {string} sourceHash
   * @param {Object} [scope] - { class, subject, unit } — when given, all three must match
   */
  async findSyllabusByHash(sourceHash, scope = {}) {
    if (!sourceHash) return { indexed: false, unit: null, chunkCount: 0 };
    try {
      const client = getClient();
      const name = getCollectionName();
      await ensurePayloadIndex(client, name, 'sourceHash');
      const must = [
        { key: 'corpus', match: { value: 'syllabus' } },
        { key: 'sourceHash', match: { value: sourceHash } },
      ];
      if (scope.class != null && String(scope.class).trim() !== '') must.push({ key: 'class', match: { value: String(scope.class) } });
      if (scope.subject != null && String(scope.subject).trim() !== '') must.push({ key: 'subject', match: { value: String(scope.subject) } });
      if (scope.unit != null && String(scope.unit).trim() !== '') must.push({ key: 'unit', match: { value: String(scope.unit) } });

      const hits = await client.scroll(name, { limit: 256, with_payload: true, with_vector: false, filter: { must } });
      const points = hits?.points ?? [];
      if (points.length === 0) return { indexed: false, unit: null, chunkCount: 0 };
      return { indexed: true, unit: points[0].payload?.unit ?? null, chunkCount: points.length };
    } catch (err) {
      console.error(`[Qdrant] findSyllabusByHash failed: ${err.message}`);
      return { indexed: false, unit: null, chunkCount: 0 };
    }
  },

  /** Distinct syllabus units WITH notes for a class+subject, with chunk counts. */
  async listUnitsWithNotes({ class: cls, subject } = {}) {
    try {
      const client = getClient();
      const name = getCollectionName();
      await ensurePayloadIndex(client, name, 'corpus');
      const must = [{ key: 'corpus', match: { value: 'syllabus' } }];
      if (cls != null && String(cls).trim() !== '') must.push({ key: 'class', match: { value: String(cls) } });
      if (subject != null && String(subject).trim() !== '') must.push({ key: 'subject', match: { value: String(subject) } });

      const counts = new Map();
      let offset;
      do {
        const page = await client.scroll(name, { limit: 256, offset, with_payload: true, with_vector: false, filter: { must } });
        for (const p of page?.points ?? []) {
          const u = p.payload?.unit;
          if (u == null) continue;
          counts.set(String(u), (counts.get(String(u)) ?? 0) + 1);
        }
        offset = page?.next_page_offset ?? undefined;
      } while (offset);

      return [...counts.entries()].map(([id, chunkCount]) => ({ id, label: id, chunkCount }));
    } catch (err) {
      console.error(`[Qdrant] listUnitsWithNotes failed: ${err.message}`);
      return [];
    }
  },

  /** Does a single unit have any notes indexed for this class+subject? */
  async unitHasNotes({ class: cls, subject, unit } = {}) {
    if (unit == null || String(unit).trim() === '') return false;
    try {
      const client = getClient();
      const name = getCollectionName();
      await ensurePayloadIndex(client, name, 'unit');
      const must = [
        { key: 'corpus', match: { value: 'syllabus' } },
        { key: 'unit', match: { value: String(unit) } },
      ];
      if (cls != null && String(cls).trim() !== '') must.push({ key: 'class', match: { value: String(cls) } });
      if (subject != null && String(subject).trim() !== '') must.push({ key: 'subject', match: { value: String(subject) } });
      const page = await client.scroll(name, { limit: 1, with_payload: false, with_vector: false, filter: { must } });
      return (page?.points ?? []).length > 0;
    } catch (err) {
      console.error(`[Qdrant] unitHasNotes failed: ${err.message}`);
      return false;
    }
  },

  /**
   * Semantic vector search over the collection with optional payload filtering.
   *
   * @param {Object} opts - { vector: number[], filter: { corpus?, unit?, class?, subject?, sourceDocumentId? }, topK }
   * @returns {Promise<Array<{ score: number, payload: Object }>>} Ranked hits (vectors not returned)
   */
  async searchVectors({ vector, filter = {}, topK = 10 }) {
    if (!vector || !Array.isArray(vector) || vector.length === 0) {
      throw new Error('[Qdrant] A non-empty vector is required for semantic search.');
    }

    const client = getClient();
    const collectionName = getCollectionName();

    // Build metadata filter from available values (never invent class/subject)
    const must = [];
    if (filter.class !== undefined && filter.class !== null && String(filter.class).trim() !== '') {
      must.push({ key: 'class', match: { value: String(filter.class) } });
    }
    if (filter.subject !== undefined && filter.subject !== null && String(filter.subject).trim() !== '') {
      must.push({ key: 'subject', match: { value: String(filter.subject) } });
    }
    // TWO CORPORA: content retrieval passes corpus:'syllabus' (+ unit), source
    // dedup passes corpus:'past_paper'. `sourceType` is retired as a filter key
    // (kept in the payload for back-compat) — the two pools now differ by design.
    if (filter.corpus) {
      must.push({ key: 'corpus', match: { value: String(filter.corpus) } });
    }
    if (filter.unit !== undefined && filter.unit !== null && String(filter.unit).trim() !== '') {
      must.push({ key: 'unit', match: { value: String(filter.unit) } });
    }
    // `sourceType` is retired as a filter key — corpus replaces it. The payload
    // still carries sourceType on past_paper points for back-compat only.
    if (filter.sourceDocumentId) {
      must.push({ key: 'sourceDocumentId', match: { value: filter.sourceDocumentId } });
    }

    // Note: @qdrant/js-client-rest >= 1.9 dropped the legacy `search` method;
    // the Query API (`query`) is the supported vector-search entry point, and it
    // returns { points: [...] } at the top level (no `result` envelope).
    const result = await client.query(collectionName, {
      query: vector,
      limit: topK,
      with_payload: true,
      with_vector: false,
      filter: must.length > 0 ? { must } : undefined,
    });

    const points = result?.points ?? [];
    return points.map(point => ({ score: point.score, payload: point.payload || {} }));
  },

  /**
   * Get the number of points currently stored in the collection.
   * @returns {Promise<number>}
   */
  async getPointCount() {
    try {
      const client = getClient();
      const collectionName = getCollectionName();
      const info = await client.getCollection(collectionName);
      return info?.points_count ?? 0;
    } catch (err) {
      console.error('[Qdrant] Failed to fetch point count:', err.message);
      return 0;
    }
  },

  /**
   * Retrieve specific points by their IDs (for verification only).
   * @param {string[]} ids 
   * @returns {Promise<Array<Object>>}
   */
  async getPoints(ids) {
    const client = getClient();
    const collectionName = getCollectionName();
    const result = await client.getPoints(collectionName, { ids, with_payload: true, with_vector: false });
    return result;
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deterministic RFC-4122-shaped id from a stable key, backed by a full SHA-256
 * digest. Unlike generateStableUUID (a 32-bit string hash expanded by a linear
 * formula, which collides across unrelated inputs), two different keys here do
 * not collide in practice. Used for the syllabus corpus; the key is
 * `${sourceHash}:${chunkIndex}` so re-uploading the same notes is idempotent.
 * @param {string} key
 * @returns {string} UUID string (Qdrant accepts UUID point ids)
 */
export function stablePointId(key) {
  const hex = createHash('sha256').update(String(key)).digest('hex');
  const b = hex.slice(0, 32).split('');
  b[12] = '8'; // version nibble (8 = SHA-derived / custom)
  b[16] = ((parseInt(b[16], 16) & 0x3) | 0x8).toString(16); // RFC-4122 variant
  const s = b.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Idempotently ensure a keyword payload index exists (some Qdrant tiers need it before a filtered scroll). */
async function ensurePayloadIndex(client, collectionName, field) {
  try {
    await client.createPayloadIndex(collectionName, { field_name: field, field_schema: 'keyword' });
  } catch {
    // already indexed — fine
  }
}

/**
 * Generate a deterministic UUID v5-style identifier from an input string.
 * We use a simple hash-to-UUID approach for idempotent point IDs.
 */
function generateStableUUID(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }

  // Expand the single hash into 16 bytes for a full UUID
  const bytes = new Uint8Array(16);
  const seed = Math.abs(hash);
  for (let i = 0; i < 16; i++) {
    bytes[i] = (seed * (i + 1) * 31 + i * 17) & 0xff;
  }

  // Format as UUID v4-style string (Qdrant accepts UUID strings)
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export default qdrantStore;
