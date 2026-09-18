/**
 * openai-compat.client.js
 *
 * A tiny OpenAI-compatible client with round-robin key rotation, used by the
 * xKiro, OpenRouter and Token Harbor providers. (Groq keeps its own existing
 * client — groq-client.service.js — which this deliberately does not replace.)
 *
 * Returns the assistant message content as a plain string, so every provider in
 * services/ai/ exposes the same `generate()` shape.
 *
 * VISION: `opts.images` (asset records with dataUri / data / base64) are merged
 * into the user message as OpenAI multimodal content parts
 * ({ type: 'image_url', image_url: { url } }), so a vision-capable model on the
 * same endpoint receives exactly what the app already sent to Gemini.
 */

const DEFAULT_TIMEOUT_MS = 60000;

/** Marks an error the router must NOT blindly fall back on (bad request / auth). */
export class NonRetryableAiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonRetryableAiError';
    this.retryable = false;
  }
}

/** True for transient conditions worth trying the next provider for. */
export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export class OpenAICompatClient {
  /**
   * `keysRef` / `modelRef` / `baseUrlRef` are functions so the model, keys and
   * base URL are read from env LIVE on every call — the code never freezes or
   * silently overrides a model name (finalize spec §14).
   *
   * @param {Object} cfg
   * @param {string} cfg.name        - provider label for logs
   * @param {() => string} cfg.baseUrlRef
   * @param {() => string[]} cfg.keysRef
   * @param {() => string} cfg.modelRef
   * @param {() => string} [cfg.visionModelRef] - model used when opts.images is
   *   non-empty (vision-capable variant on the same endpoint); optional — when
   *   absent the text model receives the images (plain passthrough)
   * @param {(images: Array<string|Object>) => Array<{type: string, image_url: {url: string}}>} [cfg.buildImageParts]
   *   converts the app's image asset records into OpenAI content parts
   * @param {Object} [cfg.extraHeaders] - static extra headers (OpenRouter attribution)
   * @param {number} [cfg.timeoutMs]
   */
  constructor({ name, baseUrlRef, keysRef, modelRef, visionModelRef, buildImageParts, extraHeaders = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.name = name;
    this._baseUrlRef = baseUrlRef;
    this._keysRef = keysRef;
    this._modelRef = modelRef;
    this._visionModelRef = visionModelRef || null;
    this._buildImageParts = buildImageParts || OpenAICompatClient.toImageParts;
    this.extraHeaders = extraHeaders;
    this.timeoutMs = timeoutMs;
    this.cursor = 0;
  }

  get baseUrl() { return String(this._baseUrlRef() || '').replace(/\/+$/, ''); }
  get keys() { const k = this._keysRef(); return Array.isArray(k) ? k.filter(Boolean) : []; }
  get model() { return this._modelRef(); }

  get available() {
    return this.keys.length > 0 && !!this.model && !!this.baseUrl;
  }

  /**
   * Turn the app's image asset records (dataUri | data | base64 strings or
   * objects) into OpenAI multimodal content parts. Shared shape with the
   * Gemini-era buildImageParts (gemini-client.service.js).
   */
  static toImageParts(images) {
    return (Array.isArray(images) ? images : []).map((img) => {
      const raw = typeof img === 'string' ? img : (img.dataUri || img.data || img.base64 || '');
      const url = String(raw || '');
      return url ? { type: 'image_url', image_url: { url } } : null;
    }).filter(Boolean);
  }

  /**
   * @param {Object} opts
   * @param {string} opts.prompt
   * @param {string} [opts.systemPrompt]
   * @param {'json'|'text'} [opts.responseFormat]
   * @param {number} [opts.temperature]
   * @param {number} [opts.maxTokens]
   * @param {Array<string|Object>} [opts.images] - image asset records; non-empty
   *   switches to the vision model (when configured) with multimodal content
   * @returns {Promise<string>} assistant text
   */
  async generate({ prompt, systemPrompt, responseFormat, temperature, maxTokens, images } = {}) {
    if (!this.available) throw new Error(`${this.name}: not configured (missing key or model)`);

    // Snapshot env-backed config once per call — the exact model name comes
    // straight from the environment, never rewritten.
    const keys = this.keys;
    const model = this.model;
    const baseUrl = this.baseUrl;

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });

    const imageParts = this._buildImageParts && Array.isArray(images) && images.length > 0
      ? this._buildImageParts(images)
      : [];
    const useVisionModel = imageParts.length > 0 && !!this._visionModelRef;
    const effectiveModel = useVisionModel ? this._visionModelRef() : model;
    if (!effectiveModel) throw new Error(`${this.name}: vision model is not configured`);

    if (imageParts.length > 0) {
      // OpenAI multimodal shape: text + image_url parts in ONE user message.
      messages.push({ role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }, ...imageParts] });
    } else {
      messages.push({ role: 'user', content: String(prompt ?? '') });
    }

    const body = {
      model: effectiveModel,
      messages,
      temperature: Number.isFinite(temperature) ? temperature : 0.6,
      max_tokens: Number.isFinite(maxTokens) ? maxTokens : 8192,
      ...(responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    };

    const failures = [];
    for (let n = 0; n < keys.length; n++) {
      const idx = (this.cursor + n) % keys.length;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);

      let res;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${keys[idx]}`,
            ...this.extraHeaders,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        failures.push(`key#${idx + 1}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
        continue; // network / timeout → next key
      }
      clearTimeout(timer);

      if (isRetryableStatus(res.status)) {
        failures.push(`key#${idx + 1}: HTTP ${res.status}`);
        continue; // rate-limit / server error → next key
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = j?.error?.message || j?.message || `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) {
          failures.push(`key#${idx + 1}: ${msg}`);
          continue; // this key is bad → try the next
        }
        // 400 / 404 / 422: request- or model-shaped — identical on every key.
        throw new NonRetryableAiError(`${this.name} rejected the request: ${msg}`);
      }

      // Some OpenAI-compat APIs (e.g. MiniMax via xKiro) return error payloads
      // with HTTP 200.  Detect them and treat as a retriable key failure so the
      // next key (or the next provider) is tried.
      if (j?.error) {
        const errMsg = j.error?.message || JSON.stringify(j.error);
        failures.push(`key#${idx + 1}: model error (200): ${errMsg}`);
        console.warn(`[${this.name}] key#${idx + 1} returned error body on HTTP 200: ${errMsg}`);
        continue; // rotate to next key / provider
      }

      const text = j?.choices?.[0]?.message?.content;
      // Empty content is a retriable fault — the model produced no output.
      if (text == null || String(text).trim() === '') {
        const detail = `empty content (finish_reason=${j?.choices?.[0]?.finish_reason ?? 'unknown'})`;
        failures.push(`key#${idx + 1}: ${detail}`);
        console.warn(`[${this.name}] key#${idx + 1} returned ${detail} — rotating key`);
        continue;
      }

      this.cursor = (idx + 1) % keys.length;
      return text;
    }

    // Every key hit a transient failure → the whole provider is (temporarily) down.
    throw new Error(`${this.name} unavailable after ${keys.length} key(s): ${failures.slice(0, 4).join(' | ')}`);
  }
}

export default OpenAICompatClient;
