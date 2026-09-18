import app from './app.js';
import { env } from './config/env.js';
import { canonicalizeStoredScopes } from './rag/qdrant.js';

const PORT = env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running in ${env.NODE_ENV} mode on http://localhost:${PORT}`);
  console.log(`🔍 Health check: http://localhost:${PORT}/api/health`);

  // Repair pass: canonicalize class/subject payload values written before
  // scope canonicalization existed, so old corpora stay visible to canonical
  // read filters. Idempotent (no-op once clean) and non-blocking — a Qdrant
  // outage here must never stop the server from serving.
  canonicalizeStoredScopes().catch((err) => {
    console.warn(`[Qdrant] Scope canonicalization skipped: ${err.message}`);
  });
});
