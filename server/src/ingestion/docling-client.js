/**
 * docling-client.js — HTTP client for the isolated Python Docling worker
 * (PART 1/2). The worker runs OUT-OF-PROCESS (ingestion/docling, default
 * http://127.0.0.1:8100) — Docling never loads into the Node process.
 */

import { env } from '../config/env.js';

/** GET /health on the worker. Resolves { ok, doclingVersion } or throws. */
export async function doclingHealth() {
  const res = await fetch(`${env.DOCLING_SERVICE_URL}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`docling health HTTP ${res.status}`);
  return res.json();
}

/**
 * POST /convert — send file bytes (base64) and receive the structured document.
 * @param {Buffer} buffer
 * @param {Object} opts - { filename, documentId }
 * @returns {Promise<{ document: Object, meta: Object }>}
 */
export async function doclingConvert(buffer, { filename = 'upload.pdf', documentId } = {}) {
  const res = await fetch(`${env.DOCLING_SERVICE_URL}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileBase64: Buffer.from(buffer).toString('base64'),
      filename,
      documentId,
    }),
    signal: AbortSignal.timeout(env.DOCLING_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success !== true) {
    throw new Error(json?.error || `docling convert HTTP ${res.status}`);
  }
  return { document: json.document, meta: json.meta };
}

export default { doclingHealth, doclingConvert };
