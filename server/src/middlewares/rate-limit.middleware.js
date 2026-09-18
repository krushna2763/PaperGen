import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * SECURITY: shared rate limiters.
 *
 * aiLimiter — the TIGHT tier, mounted on every route that triggers PAID Gemini
 * calls (generate / analyze / notes ingest / embeddings) or heavy ingest work
 * (Cloudinary upload, PDF fetch + OCR). Unauthenticated spend protection.
 *
 * defaultLimiter — the LOOSE tier, a read/abuse backstop for cheap endpoints
 * (health, job status, unit listing). It is also mounted above every router,
 * so AI routes are counted by both tiers (the tight tier still gates first).
 *
 * Both are module singletons, so counters are shared across every route that
 * mounts them — one bucket per client IP per 60s window. If deploying behind
 * a reverse proxy, set app.set('trust proxy', ...) in server.js so req.ip
 * resolves to the real client address, otherwise all clients share one bucket.
 *
 * Tiers are tuned via env: RATE_LIMIT_AI_PER_MINUTE (default 6) and
 * RATE_LIMIT_DEFAULT_PER_MINUTE (default 120).
 */

const limiterOptions = (limit, message) => ({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RateLimitExceeded',
    message
  }
});

export const aiLimiter = rateLimit(
  limiterOptions(
    env.RATE_LIMIT_AI_PER_MINUTE,
    'Too many AI-triggering requests. Please wait a minute before retrying.'
  )
);

export const defaultLimiter = rateLimit(
  limiterOptions(
    env.RATE_LIMIT_DEFAULT_PER_MINUTE,
    'Too many requests. Please slow down.'
  )
);
