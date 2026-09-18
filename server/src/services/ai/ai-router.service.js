/**
 * ai-router.service.js — one `generate()` over an ordered provider chain.
 *
 *   Apinex (free/deepseek-v4.1-flash) → Token Harbor → xKiro → Groq →
 *   OpenRouter → clear error
 *
 * Order comes from env (AI_PRIMARY_PROVIDER + AI_FALLBACK_PROVIDERS); the
 * default is the chain above. The rest of the app calls `aiRouter.generate(...)`
 * and never needs to know which provider answered. Gemini is NOT part of the
 * chain anymore (registered for back-compat only, no keys configured).
 *
 * FREE-only fail-safe: when AI_FREE_ONLY is true, a provider whose configured
 * model is not a verified FREE model is SKIPPED — the router never issues an
 * accidental paid request. If every free provider is unavailable it returns:
 *   "All configured free AI providers are currently unavailable."
 *
 * Fallback happens only for TEMPORARY provider failures (429 / timeout / 5xx /
 * network). A request-shaped failure (400 / 401 / 403 / malformed prompt /
 * app-logic JSON error) throws immediately — those need fixing, not retrying.
 *
 * VISION/MULTIMODAL REQUESTS (opts.images non-empty) are a SEPARATE route,
 * not a filtered pass through the text chain above: xKiro/Groq/OpenRouter are
 * text-only and cannot process image input, so they are never even evaluated
 * for an image request — it goes directly to the AI_VISION_PROVIDERS chain
 * (default: Apinex, then Token Harbor's mimo-v2.5:free). If every configured
 * vision provider is unavailable or fails, the request fails fast with
 * NO_VISION_PROVIDER — never Gemini unless explicitly added to that chain,
 * never a text-only provider.
 */
import { env } from '../../config/env.js';
import { PROVIDERS } from './providers.js';
import { NonRetryableAiError } from './openai-compat.client.js';

export const ALL_FREE_UNAVAILABLE = 'All configured free AI providers are currently unavailable.';
export const NO_VISION_PROVIDER = 'NO_VISION_PROVIDER';

/** Ordered, de-duplicated provider list from env (primary first). */
export function providerOrder() {
  const seen = new Set();
  const out = [];
  for (const name of [env.AI_PRIMARY_PROVIDER, ...env.AI_FALLBACK_PROVIDERS]) {
    const key = String(name || '').toLowerCase();
    if (PROVIDERS[key] && !seen.has(key)) { seen.add(key); out.push(key); }
  }
  // Safety net: if env named nothing valid, use the documented default chain.
  if (out.length === 0) return ['apinex', 'tokenharbor', 'xkiro', 'groq', 'openrouter'];
  return out;
}

/**
 * Classify a caught provider error:
 *   'retry' — transient (429 / 5xx / timeout / network) → try the next provider
 *   'skip'  — this provider is misconfigured for THIS request (bad/unknown
 *             model id, or its own auth failure) → try the next provider; a
 *             different provider has a different model + key
 *   'abort' — the REQUEST itself is bad (malformed prompt / payload / schema)
 *             and would fail identically everywhere → surface it, do not retry
 *
 * Spec note: §9 says "do not fall back on 400/401/404". §4 says "if the exact
 * FREE OpenRouter model is unavailable, SKIP OpenRouter and continue to
 * Gemini". A bad model id / provider auth is provider-scoped config, not a
 * broken request — so it is 'skip', not 'abort'. A 400/422 that names the
 * prompt/messages/content/token/schema is a real app error → 'abort'.
 */
export function classifyError(err) {
  const s = `${err && err.message || ''}`.toLowerCase();
  // transient
  if (!(err instanceof NonRetryableAiError) && err && err.retryable !== false) {
    if (/\b(408|409|425|429|5\d\d)\b/.test(s) || /timeout|timed out|socket|network|econn|fetch failed|aborterror/.test(s)) return 'retry';
  }
  // request/payload error — identical on every provider → abort
  if (/\b(400|422)\b/.test(s) && /(prompt|message|content|token|payload|schema|too (long|large)|context length)/.test(s)) return 'abort';
  // provider-scoped: unknown/invalid model, or that provider's auth → skip it
  if (/\b(400|401|403|404)\b/.test(s)
      || /(not a valid model|invalid model|model .*(not found|does not exist|unavailable)|model_not_found|unknown model)/.test(s)
      || /(invalid api key|unauthor|forbidden|permission)/.test(s)
      || err instanceof NonRetryableAiError) {
    return 'skip';
  }
  // anything else transient-looking → try the next provider rather than dying
  return 'retry';
}

/** Back-compat: true when the error is worth trying the next provider for. */
export function isRetryable(err) {
  return classifyError(err) !== 'abort';
}

function log(parts) {
  console.log(`[AI] ${parts.join(' | ')}`);
}

/**
 * Vision provider list (ordered). Precedence: an EXPLICIT AI_VISION_PROVIDERS
 * (raw process.env, comma-separated) wins — e.g. "gemini,tokenharbor" for
 * Gemini-primary + mimo-fallback; otherwise the legacy single
 * env.AI_VISION_PROVIDER value applies (read DYNAMICALLY so runtime overrides
 * keep working).
 */
function visionProviderNames() {
  const raw = String(process.env.AI_VISION_PROVIDERS ?? '').trim();
  if (raw) return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [env.AI_VISION_PROVIDER || 'tokenharbor'];
}

/**
 * Direct vision route for a request carrying real image payload(s).
 * Never enters the text provider chain — xKiro/Groq/OpenRouter are text-only
 * and would only waste a round-trip before being skipped anyway.
 *
 * Providers come from visionProviderNames(): the FIRST available entry is the
 * primary and the remaining entries are cross-provider failover, tried in
 * order ONLY on a provider failure (never falling through to a text-only
 * provider). Each provider keeps its own internal key/model rotation
 * (e.g. geminiClient.generateRaw).
 * @param {Object} opts - same shape as generate(), always with opts.images
 * @returns {Promise<string>}
 */
async function generateVision(opts) {
  const names = visionProviderNames().filter((n) => PROVIDERS[n]);
  const usable = [];
  for (const name of names) {
    const provider = PROVIDERS[name];
    if (!provider.available || (env.AI_FREE_ONLY && !provider.isFree())) {
      log([`provider=${name}`, 'route=vision-direct', 'SKIP: not configured or not FREE-tier eligible']);
      continue;
    }
    usable.push({ name, provider });
  }
  if (usable.length === 0) {
    log([`route=vision-direct`, `SKIP: no vision-capable provider configured (asked for: ${names.join(', ') || 'none'})`]);
    const e = new Error('No vision-capable AI provider is configured or FREE-tier eligible.');
    e.code = NO_VISION_PROVIDER;
    throw e;
  }

  let lastErr = null;
  for (const { name, provider } of usable) {
    const startedAt = Date.now();
    const visionModel = provider.visionModel || provider.model;
    try {
      const text = await provider.generate(opts);
      const ms = Date.now() - startedAt;
      log([`provider=${name}`, 'route=vision-direct', `Model: ${visionModel}`, 'Status: SUCCESS', `${ms}ms`]);
      return text;
    } catch (err) {
      const ms = Date.now() - startedAt;
      log([`provider=${name}`, 'route=vision-direct', 'Status: FAILED', `${ms}ms`, err.message]);
      lastErr = err;
      // Only vision-capable providers are in the list, so falling through to
      // the NEXT VISION provider is safe; a text-only provider is never tried.
    }
  }
  const e = new Error(`Vision request failed: ${lastErr?.message ?? 'no provider succeeded'}`);
  e.code = NO_VISION_PROVIDER;
  e.cause = lastErr;
  throw e;
}

/**
 * @param {Object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.systemPrompt]
 * @param {'json'|'text'} [opts.responseFormat]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {Array<Object|string>} [opts.images] - image payload(s); non-empty
 *   routes DIRECTLY to Gemini vision, bypassing the text provider chain.
 * @returns {Promise<string>} raw model text (unchanged internal format)
 */
export async function generate(opts = {}) {
  if (!opts || typeof opts.prompt !== 'string' || opts.prompt.trim() === '') {
    // App-logic error — not a provider failure. Do not enter the fallback chain.
    throw new NonRetryableAiError('aiRouter.generate: a non-empty { prompt } string is required');
  }

  if (Array.isArray(opts.images) && opts.images.length > 0) {
    return generateVision(opts);
  }

  const order = providerOrder();
  const attempts = [];
  let sawUsable = false;

  for (const name of order) {
    const provider = PROVIDERS[name];
    if (!provider.available) {
      log([`Provider: ${name}`, 'SKIP: not configured']);
      attempts.push({ name, skipped: 'not configured' });
      continue;
    }
    if (env.AI_FREE_ONLY && !provider.isFree()) {
      log([`Provider: ${name}`, `Model: ${provider.model}`, 'SKIP: model not verified FREE (AI_FREE_ONLY)']);
      attempts.push({ name, skipped: 'not free' });
      continue;
    }
    sawUsable = true;
    const startedAt = Date.now();
    try {
      const text = await provider.generate(opts);
      const ms = Date.now() - startedAt;
      log([`provider=${name}`, `Provider: ${name}`, `Model: ${provider.model}`, 'Status: SUCCESS', `${ms}ms`]);
      return text;
    } catch (err) {
      const ms = Date.now() - startedAt;
      const kind = classifyError(err); // 'retry' | 'skip' | 'abort'
      log([`${name} failed after ${ms}ms (${kind}): ${err.message}`]);
      attempts.push({ name, error: err.message, kind });
      if (kind === 'abort') {
        // the REQUEST is bad (malformed prompt / payload) — identical on every
        // provider, so surface it now instead of a 4-provider storm.
        throw err;
      }
      // 'retry' (transient) or 'skip' (this provider misconfigured for this
      // request) → move to the next provider.
      const next = order[order.indexOf(name) + 1];
      if (next) log([`Falling back to ${next}`]);
    }
  }

  if (!sawUsable) {
    // Nothing was configured, or FREE-only skipped every provider. (Vision
    // requests never reach this loop — see generateVision() above.)
    const e = new Error(ALL_FREE_UNAVAILABLE);
    e.attempts = attempts;
    throw e;
  }
  const e = new Error(ALL_FREE_UNAVAILABLE);
  e.attempts = attempts;
  throw e;
}

export const aiRouter = { generate, providerOrder, isRetryable, classifyError, ALL_FREE_UNAVAILABLE };
export default aiRouter;
