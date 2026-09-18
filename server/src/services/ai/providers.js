/**
 * providers.js — the AI providers behind the common `generate()` interface.
 *
 * Each provider exposes:
 *   { name, get model(), get available(), isFree(), async generate(opts) -> string }
 *
 * `opts` = { prompt, systemPrompt, responseFormat: 'json'|'text', temperature, maxTokens, images? }
 *
 *   apinex      — OpenAI-compatible; PRIMARY text LLM + PRIMARY vision route
 *                 (free/deepseek-v4.1-flash for both)
 *   tokenharbor — OpenAI-compatible; FALLBACK text + vision
 *                 (text: deepseek-v4.1-flash:free, vision: mimo-v2.5:free)
 *   xkiro       — OpenAI-compatible (services/ai/openai-compat.client.js)
 *   groq        — wraps the EXISTING groq-client.service.js (not replaced)
 *   openrouter  — OpenAI-compatible, with OpenRouter attribution headers
 *   gemini      — wraps the EXISTING gemini-client.service.js key/model failover
 *                 (registered for back-compat; NOT in the default chain — see
 *                 AI_VISION_PROVIDERS for its place as a last-resort vision fallback)
 */
import { env } from '../../config/env.js';
import { OpenAICompatClient } from './openai-compat.client.js';
import { groqClient } from '../groq-client.service.js';
import { geminiClient } from '../gemini-client.service.js';

/** FREE-model verification. Never let an accidental paid model through. */
export function isModelFree(providerName, model) {
  const m = String(model || '').trim();
  if (!m) return false;
  switch (providerName) {
    case 'xkiro':
    case 'openrouter':
      // These aggregators expose a paid and a `:free` variant of the same slug.
      return m.endsWith(':free');
    case 'tokenharbor':
      // Token Harbor exposes a paid and a `:free` variant of the same slug
      // (e.g. deepseek-v4.1-flash:free vs deepseek-v4.1-flash). Same rule.
      return m.endsWith(':free');
    case 'groq':
      // Groq's dev tier: this exact model is the approved free one.
      return m === 'openai/gpt-oss-120b' || m.startsWith('openai/gpt-oss-');
    case 'apinex':
      // Apinex marks its free tier with a `free/` model-slug prefix.
      return m.startsWith('free/');
    case 'gemini': {
      // Only models verified free on the Gemini API free tier.
      const FREE_GEMINI = new Set([
        'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
        'gemini-flash-latest', 'gemini-flash-lite-latest',
        'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-001',
        'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-flash-latest',
      ]);
      return FREE_GEMINI.has(m);
    }
    default:
      return false;
  }
}

/* ── xKiro (PRIMARY) ─────────────────────────────────────────────────────── */
const xkiroClient = new OpenAICompatClient({
  name: 'xkiro',
  baseUrlRef: () => env.XKIRO_BASE_URL,
  keysRef: () => env.XKIRO_API_KEYS,
  modelRef: () => env.XKIRO_MODEL,
  visionModelRef: () => env.XKIRO_VISION_MODEL || env.XKIRO_MODEL,
  buildImageParts: (images) => OpenAICompatClient.toImageParts(images),
});
export const xkiroProvider = {
  name: 'xkiro',
  get model() { return env.XKIRO_MODEL; },
  get visionModel() { return env.XKIRO_VISION_MODEL || env.XKIRO_MODEL; },
  get available() { return xkiroClient.available; },
  get supportsVision() { return /(-vl|vision|flash|deepseek)/i.test(String(env.XKIRO_VISION_MODEL || env.XKIRO_MODEL || '')); },
  isFree() { return isModelFree('xkiro', env.XKIRO_MODEL); },
  generate: (opts) => xkiroClient.generate(opts),
};

/* ── Groq (FALLBACK) — reuse the existing client ─────────────────────────── */
export const groqProvider = {
  name: 'groq',
  get model() { return env.GROQ_MODEL; },
  get available() { return groqClient.available; },
  get supportsVision() { return false; },
  isFree() { return isModelFree('groq', env.GROQ_MODEL); },
  // groqClient.generateContent(prompt, generationConfig) — adapt the common opts.
  generate: ({ prompt, systemPrompt, responseFormat, temperature, maxTokens } = {}) =>
    groqClient.generateContent(
      systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
      {
        temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: responseFormat === 'json' ? 'application/json' : undefined,
      },
    ),
};

/* ── OpenRouter (FALLBACK) ──────────────────────────────────────────────── */
const openrouterClient = new OpenAICompatClient({
  name: 'openrouter',
  baseUrlRef: () => env.OPENROUTER_BASE_URL,
  keysRef: () => env.OPENROUTER_API_KEYS,
  modelRef: () => env.OPENROUTER_MODEL,
  extraHeaders: {
    // OpenRouter attribution (optional but recommended). No secrets.
    'HTTP-Referer': 'https://papergen.local',
    'X-Title': 'PaperGen AI',
  },
});
export const openrouterProvider = {
  name: 'openrouter',
  get model() { return env.OPENROUTER_MODEL; },
  get available() { return openrouterClient.available; },
  get supportsVision() { return /(-vl|vision)/i.test(String(env.OPENROUTER_MODEL || '')); },
  isFree() { return isModelFree('openrouter', env.OPENROUTER_MODEL); },
  generate: (opts) => openrouterClient.generate(opts),
};

/* ── Token Harbor (FALLBACK text + vision) ───────────────────────────────── */
const tokenharborClient = new OpenAICompatClient({
  name: 'tokenharbor',
  baseUrlRef: () => env.TOKENHARBOR_BASE_URL,
  keysRef: () => env.TOKENHARBOR_API_KEYS,
  modelRef: () => env.TOKENHARBOR_MODEL,
  // Vision requests route to the vision-capable model on the same endpoint.
  visionModelRef: () => env.TOKENHARBOR_VISION_MODEL,
  buildImageParts: (images) => OpenAICompatClient.toImageParts(images),
});
export const tokenharborProvider = {
  name: 'tokenharbor',
  get model() { return env.TOKENHARBOR_MODEL; },
  get visionModel() { return env.TOKENHARBOR_VISION_MODEL; },
  get available() { return tokenharborClient.available; },
  get supportsVision() { return /(-vl|vision|mimo)/i.test(String(env.TOKENHARBOR_VISION_MODEL || '')); },
  isFree() { return isModelFree('tokenharbor', env.TOKENHARBOR_MODEL); },
  generate: (opts) => tokenharborClient.generate(opts),
};

/* ── Gemini (LAST FALLBACK) — reuse the existing failover client ─────────── */
export const geminiProvider = {
  name: 'gemini',
  get model() { return env.GEMINI_MODEL; },
  get available() { return Array.isArray(env.GEMINI_API_KEYS) && env.GEMINI_API_KEYS.length > 0; },
  get supportsVision() { return true; },
  isFree() { return isModelFree('gemini', env.GEMINI_MODEL); },
  // geminiClient.generateRaw() → pure Gemini key/model failover (NOT
  // generateContent, which now delegates back to the router). A caller-supplied
  // `responseSchema` (Gemini structured output) is forwarded only here — the
  // OpenAI-style providers get JSON mode and rely on the prompt's schema text.
  generate: ({ prompt, systemPrompt, responseFormat, temperature, maxTokens, responseSchema, images } = {}) =>
    geminiClient.generateRaw(
      systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
      {
        temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: responseFormat === 'json' ? 'application/json' : undefined,
        ...(responseSchema ? { responseSchema } : {}),
        ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
      },
    ),
};

/* ── Apinex (PRIMARY text + vision) ───────────────────────────────────────
 * Verified live: text + vision both succeed on free/deepseek-v4.1-flash at
 * https://api.apinex.bond/v1 (direct HTTP check, both a plain chat call and
 * an image_url content-part call returned HTTP 200 with a correct answer).
 * Vision on this endpoint has since shown a transient 502 (provider gateway,
 * not a key issue — reproduced identically on two different keys); the
 * router's normal 5xx retry/fallback to tokenharbor covers that case.
 */
const apinexClient = new OpenAICompatClient({
  name: 'apinex',
  baseUrlRef: () => env.APINEX_BASE_URL,
  keysRef: () => env.APINEX_API_KEYS,
  modelRef: () => env.APINEX_MODEL,
  visionModelRef: () => env.APINEX_VISION_MODEL,
  buildImageParts: (images) => OpenAICompatClient.toImageParts(images),
});
export const apinexProvider = {
  name: 'apinex',
  get model() { return env.APINEX_MODEL; },
  get visionModel() { return env.APINEX_VISION_MODEL; },
  get available() { return apinexClient.available; },
  get supportsVision() { return true; },
  isFree() { return isModelFree('apinex', env.APINEX_MODEL); },
  generate: (opts) => apinexClient.generate(opts),
};

export const PROVIDERS = {
  tokenharbor: tokenharborProvider,
  apinex: apinexProvider,
  xkiro: xkiroProvider,
  groq: groqProvider,
  openrouter: openrouterProvider,
  gemini: geminiProvider,
};

export default PROVIDERS;
