/**
 * groq-client.service.js — LAST-RESORT LLM fallback.
 *
 * Called ONLY by gemini-client.generateContent() after every Gemini key and
 * every Gemini fallback model has failed with a temporary error (429 / 5xx /
 * timeout). Groq's OpenAI-compatible chat endpoint is fast and its free tier is
 * far more generous per-minute than Gemini's, so it keeps a generation run
 * alive when the Gemini pool is rate-limited.
 *
 * Scope: text/JSON generation only. Embeddings are NEVER routed here — the
 * embedding leg lives behind EMBEDDING_PROVIDER (OpenRouter nemotron embed /
 * legacy Gemini), whose vectors must keep ONE dimension per Qdrant collection.
 *
 * Returns a plain string (same contract as geminiClient.generateContent), so
 * callers need no changes.
 */
import { env } from '../config/env.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 60000;

/** Gemini accepts a string or a { contents:[{parts:[{text}]}] } prompt — flatten either to text. */
function promptToText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (prompt && Array.isArray(prompt.contents)) {
    return prompt.contents
      .flatMap((c) => (Array.isArray(c.parts) ? c.parts : []))
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('\n')
      .trim();
  }
  return String(prompt ?? '');
}

export class GroqFailoverClient {
  constructor(keys = env.GROQ_API_KEYS, model = env.GROQ_MODEL) {
    this.keys = Array.isArray(keys) ? keys.filter(Boolean) : [];
    this.model = model;
    this.cursor = 0;
  }

  get available() {
    return this.keys.length > 0;
  }

  /**
   * @param {string|Object} prompt
   * @param {Object} generationConfig - the Gemini-style config; only
   *   temperature / maxOutputTokens / responseMimeType are used here.
   * @returns {Promise<string>} raw model text
   */
  async generateContent(prompt, generationConfig = {}) {
    if (!this.available) throw new Error('Groq fallback not configured (no GROQ_API_KEYS).');

    const body = {
      model: this.model,
      messages: [{ role: 'user', content: promptToText(prompt) }],
      temperature: Number.isFinite(generationConfig.temperature) ? generationConfig.temperature : 0.6,
      max_tokens: Number.isFinite(generationConfig.maxOutputTokens) ? generationConfig.maxOutputTokens : 8192,
      ...(generationConfig.responseMimeType === 'application/json'
        ? { response_format: { type: 'json_object' } }
        : {}),
    };

    const failures = [];
    for (let n = 0; n < this.keys.length; n++) {
      const idx = (this.cursor + n) % this.keys.length;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

      let r;
      try {
        r = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.keys[idx]}` },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        failures.push(`key#${idx + 1}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
        continue; // network/timeout → rotate key
      }
      clearTimeout(timer);

      if (r.status === 429 || r.status >= 500) {
        failures.push(`key#${idx + 1}: HTTP ${r.status}`);
        continue; // rate-limited / server error → rotate key
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error?.message || `HTTP ${r.status}`;
        if (r.status === 401 || r.status === 403) {
          failures.push(`key#${idx + 1}: ${msg}`);
          continue; // dead key → next
        }
        // 400 etc: a request-shaped error fails identically on every key —
        // stop now instead of a pointless key storm.
        throw new Error(`Groq request rejected: ${msg}`);
      }
      const text = j?.choices?.[0]?.message?.content ?? '';
      this.cursor = (idx + 1) % this.keys.length;
      console.log(`[Groq] model=${this.model} keyIndex=${idx} success (${text.length} chars)`);
      return text;
    }
    throw new Error(`Groq fallback exhausted after ${this.keys.length} key(s): ${failures.slice(0, 4).join(' | ')}`);
  }
}

export const groqClient = new GroqFailoverClient();
export default groqClient;
