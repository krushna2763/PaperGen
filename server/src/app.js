import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import { env } from './config/env.js';
import healthRoutes from './routes/health.routes.js';
import paperRoutes from './routes/paper.routes.js';
import questionRoutes from './routes/question.routes.js';
import kbRoutes from './routes/kb.routes.js';

const app = express();

// Middlewares
// SECURITY: restrict origins to the configured CORS_ORIGIN allowlist
// (comma-separated). Requests with no Origin header (curl, same-origin tools)
// are not blocked by cors — browsers are the enforcement point this targets.
app.use(cors({ origin: env.CORS_ORIGIN }));

// Security headers (CSP left off: this is a JSON API, not a served page)
app.use(helmet({ contentSecurityPolicy: false }));

// 10mb JSON limit: /papers/index-questions receives 3072-d embedding vectors in the body,
// which far exceeds the express.json() 100kb default
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

// SECURITY: rate limiting lives in the route files (see
// rate-limit.middleware.js): the tight aiLimiter is mounted on every route
// that triggers paid Gemini calls or heavy ingest, the loose defaultLimiter on
// cheap reads. Keeping tiers per-route avoids double-counting requests that
// would otherwise pass two limiter mounts.

// Routes
app.use('/api', healthRoutes);
app.use('/api/papers', paperRoutes);
app.use('/api/kb', kbRoutes);
app.use('/api', questionRoutes);

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'AI Agentic RAG Question Generator API',
    status: 'running',
    healthCheck: '/api/health'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Route ${req.originalUrl} does not exist.`
  });
});

// Global Error Handler
// NOTE: the 4-argument signature is required — Express identifies error
// handlers by arity. `_next` is intentionally unused (this is the terminal
// handler) but must stay declared.
app.use((err, req, res, _next) => {
  console.error('[Server Error]:', err.stack || err);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    error: err.name || 'ServerError',
    message: err.message || 'An unexpected error occurred on the server.'
  });
});

export default app;
