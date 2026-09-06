/**
 * Lightweight Node test-suite for the centralized Gemini failover client.
 * No test framework — run with: node test-gemini-failover.js
 *
 * Covers:
 *   1.  Primary model + first key succeeds.
 *   2.  Key 1 returns 503, Key 2 succeeds (key rotation).
 *   3.  All keys 503 on primary, fallback model succeeds (model fallback).
 *   4.  429 triggers key rotation.
 *   5.  400 fails immediately (no pointless key storm).
 *   6.  401/403 reported clearly (no key storm).
 *   7.  All models fail → aggregated error with diagnostics.
 *   8.  Timeout triggers failover.
 *   9.  API keys never appear in logs or errors.
 *   10. Embedding model configuration is unchanged / never gets LLM fallbacks.
 */
import assert from 'node:assert/strict';
import { GeminiFailoverClient, classifyGeminiError, geminiClient } from './src/services/gemini-client.service.js';
import { env } from './src/config/env.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function tempError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ─── 1. Primary model + first key succeeds ────────────────────────────────
test('primary model + first key succeeds in one attempt', async () => {
  const calls = [];
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2', 'k3'], startKeyIndex: 0 });
  const result = await client.executeWithFailover(
    (genAI, keyIndex, modelName) => { calls.push({ keyIndex, modelName }); return 'ok'; },
    { models: ['gemini-primary'] }
  );
  assert.equal(result, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].keyIndex, 0);
  assert.equal(calls[0].modelName, 'gemini-primary');
});

// ─── 2. Key 1 → 503, Key 2 succeeds ───────────────────────────────────────
test('503 on key 1 rotates to key 2 which succeeds', async () => {
  const calls = [];
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2', 'k3'] });
  const result = await client.executeWithFailover(
    (genAI, keyIndex) => {
      calls.push(keyIndex);
      if (keyIndex === 0) throw tempError(503, '503 Service Unavailable: high demand');
      return 'ok';
    },
    { models: ['gemini-primary'] }
  );
  assert.equal(result, 'ok');
  assert.deepEqual(calls, [0, 1]);
});

// ─── 3. All keys 503 on primary → fallback model succeeds ─────────────────
test('all keys 503 on primary, fallback model succeeds', async () => {
  const calls = [];
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2'] });
  const result = await client.executeWithFailover(
    (genAI, keyIndex, modelName) => {
      calls.push({ keyIndex, modelName });
      if (modelName === 'gemini-primary') throw tempError(503, '503 Service Unavailable');
      return `ok-from-${modelName}`;
    },
    { models: ['gemini-primary', 'gemini-fallback'], modelSwitchDelayMs: 1 }
  );
  assert.equal(result, 'ok-from-gemini-fallback');
  // primary exhausted both keys, then fallback succeeded on its first key
  assert.deepEqual(calls, [
    { keyIndex: 0, modelName: 'gemini-primary' },
    { keyIndex: 1, modelName: 'gemini-primary' },
    { keyIndex: 0, modelName: 'gemini-fallback' },
  ]);
});

// ─── 4. 429 triggers key rotation ─────────────────────────────────────────
test('429 on key 1 rotates to key 2 which succeeds', async () => {
  const calls = [];
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2'] });
  const result = await client.executeWithFailover(
    (genAI, keyIndex) => {
      calls.push(keyIndex);
      if (keyIndex === 0) throw tempError(429, '429 Resource has been exhausted');
      return 'ok';
    },
    { models: ['gemini-primary'] }
  );
  assert.equal(result, 'ok');
  assert.deepEqual(calls, [0, 1]);
});

// ─── 5. 400 fails immediately (no storm) ──────────────────────────────────
test('400 invalid request fails immediately without a key storm', async () => {
  let attempts = 0;
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2', 'k3', 'k4'] });
  await assert.rejects(
    () => client.executeWithFailover(
      () => { attempts++; throw tempError(400, 'Invalid JSON payload'); },
      { models: ['gemini-primary'] }
    ),
    (err) => {
      assert.equal(attempts, 1, 'must not retry other keys on a 400');
      assert.equal(err.status, 400);
      assert.match(err.message, /invalid_request/);
      assert.match(err.message, /Invalid JSON payload/);
      return true;
    }
  );
});

// ─── 6. 401/403 are KEY-scoped: rotate past a dead key ───────────────────
test('403 on key 1 rotates to key 2 which succeeds (auth is key-scoped)', async () => {
  const calls = [];
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2', 'k3', 'k4'] });
  const result = await client.executeWithFailover(
    (genAI, keyIndex) => {
      calls.push(keyIndex);
      if (keyIndex === 0) throw tempError(403, 'Permission denied for this model');
      return 'ok';
    },
    { models: ['gemini-primary'] }
  );
  assert.equal(result, 'ok');
  assert.deepEqual(calls, [0, 1], 'one dead key must not kill the request');
});

test('403 on EVERY key fails fast with a clear auth error (no model fallback)', async () => {
  let attempts = 0;
  let fallbackModelTried = false;
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2', 'k3', 'k4'] });
  await assert.rejects(
    () => client.executeWithFailover(
      (genAI, keyIndex, modelName) => {
        attempts++;
        if (modelName !== 'gemini-primary') fallbackModelTried = true;
        throw tempError(403, 'Permission denied for this model');
      },
      { models: ['gemini-primary', 'gemini-fallback'], modelSwitchDelayMs: 0 }
    ),
    (err) => {
      assert.equal(attempts, 4, 'all keys tried once, then auth reported');
      assert.equal(fallbackModelTried, false, 'must not waste calls on fallback models for auth errors');
      assert.equal(err.status, 403);
      assert.match(err.message, /\(auth\)/);
      return true;
    }
  );
});

// ─── 7. All models fail → aggregated error ────────────────────────────────
test('all models fail returns aggregated error with diagnostics', async () => {
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2'] });
  const started = Date.now();
  await assert.rejects(
    () => client.executeWithFailover(
      () => { throw tempError(503, '503 Service Unavailable'); },
      { models: ['gemini-a', 'gemini-b'], modelSwitchDelayMs: 0 }
    ),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /temporarily unavailable/);
      assert.equal(err.code, 'GEMINI_FAILOVER_EXHAUSTED');
      assert.deepEqual(err.details.modelsAttempted, ['gemini-a', 'gemini-b']);
      assert.equal(err.details.keysAttempted, 2);
      assert.equal(err.details.totalAttempts, 4);
      assert.ok(err.details.failureCategories.includes('overload'));
      assert.equal(typeof err.details.elapsedMs, 'number');
      assert.ok(err.details.elapsedMs >= 0 && err.details.elapsedMs <= Date.now() - started + 100);
      return true;
    }
  );
});

// ─── 8. Timeout triggers failover ─────────────────────────────────────────
test('timeout triggers key failover', async () => {
  const calls = [];
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2'] });
  const result = await client.executeWithFailover(
    (genAI, keyIndex) => {
      calls.push(keyIndex);
      if (keyIndex === 0) return new Promise(() => {}); // hangs forever
      return 'ok-after-timeout';
    },
    { models: ['gemini-primary'], timeoutMs: 50 }
  );
  assert.equal(result, 'ok-after-timeout');
  assert.deepEqual(calls, [0, 1]);
});

test('pure timeout failure is classified as temporary (timeout category)', async () => {
  const client = new GeminiFailoverClient({ keys: ['k1', 'k2'] });
  await assert.rejects(
    () => client.executeWithFailover(
      () => new Promise(() => {}), // hangs forever on every key
      { models: ['gemini-primary'], timeoutMs: 30 }
    ),
    (err) => {
      assert.equal(err.status, 503);
      assert.ok(err.details.failureCategories.includes('timeout'));
      return true;
    }
  );
});

// ─── 9. API keys never printed ────────────────────────────────────────────
test('API keys never appear in logs or errors', async () => {
  const keys = ['SUPER-SECRET-KEY-1', 'SUPER-SECRET-KEY-2', 'SUPER-SECRET-KEY-3'];
  const captured = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => captured.push(a.join(' '));
  console.warn = (...a) => captured.push(a.join(' '));

  try {
    const client = new GeminiFailoverClient({ keys });
    await assert.rejects(
      () => client.executeWithFailover(
        () => { throw tempError(503, '503 Service Unavailable'); },
        { models: ['gemini-primary'] }
      )
    );
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  for (const line of captured) {
    for (const key of keys) {
      assert.ok(!line.includes(key), `log line leaked a key: ${line}`);
    }
  }
});

// ─── 10. Embedding model unchanged / never gets LLM fallbacks ─────────────
test('embedding model configuration is unchanged', async () => {
  const expected = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
  assert.equal(env.EMBEDDING_MODEL, expected);
});

test('embedContent passes ONLY the embedding model (no LLM fallbacks)', async () => {
  let capturedModels = null;
  const original = geminiClient.executeWithFailover;
  geminiClient.executeWithFailover = async (op, opts) => {
    capturedModels = opts.models;
    return [0.1, 0.2];
  };
  try {
    const vec = await geminiClient.embedContent('hello world');
    assert.deepEqual(vec, [0.1, 0.2]);
    assert.deepEqual(capturedModels, [env.EMBEDDING_MODEL]);
  } finally {
    geminiClient.executeWithFailover = original;
  }
});

test('generateContent wires primary + configured fallback models', async () => {
  let capturedModels = null;
  const original = geminiClient.executeWithFailover;
  geminiClient.executeWithFailover = async (op, opts) => {
    capturedModels = opts.models;
    return '{"ok":true}';
  };
  try {
    const text = await geminiClient.generateContent('x');
    assert.equal(text, '{"ok":true}');
    assert.deepEqual(capturedModels, [env.GEMINI_MODEL, ...env.GEMINI_FALLBACK_MODELS]);
  } finally {
    geminiClient.executeWithFailover = original;
  }
});

// ─── Error classification unit checks ─────────────────────────────────────
test('classifyGeminiError distinguishes all required categories', () => {
  assert.deepEqual(classifyGeminiError(tempError(400, 'bad request')), { category: 'invalid_request', temporary: false, status: 400 });
  assert.deepEqual(classifyGeminiError(tempError(401, 'unauthorized')), { category: 'auth', temporary: false, status: 401 });
  assert.deepEqual(classifyGeminiError(tempError(403, 'forbidden')), { category: 'auth', temporary: false, status: 403 });
  assert.equal(classifyGeminiError(tempError(404, 'models/gemini-x is not found')).category, 'model_not_found');
  assert.equal(classifyGeminiError(tempError(429, 'too many requests')).category, 'rate_limit');
  assert.equal(classifyGeminiError(tempError(500, 'internal')).category, 'server_error');
  assert.equal(classifyGeminiError(tempError(503, 'high demand')).category, 'overload');
  assert.equal(classifyGeminiError(new Error('request timed out after 90000ms')).category, 'timeout');
  assert.equal(classifyGeminiError(new Error('fetch failed')).category, 'network');
  // temporary flag correctness
  for (const s of [429, 500, 503]) assert.equal(classifyGeminiError(tempError(s, 'x')).temporary, true);
  for (const s of [400, 401, 403, 404]) assert.equal(classifyGeminiError(tempError(s, 'x')).temporary, false);
  assert.equal(classifyGeminiError(new Error('timed out')).temporary, true);
});

// ─── Env parsing of fallback models ───────────────────────────────────────
test('GEMINI_FALLBACK_MODELS parses comma-separated values', async () => {
  process.env.GEMINI_FALLBACK_MODELS = 'alpha, beta ,,gamma';
  process.env.LLM_FALLBACK_MODELS = 'legacy-model';
  const freshEnv = await import(`./src/config/env.js?fallback-parse=${Date.now()}`);
  assert.deepEqual(freshEnv.env.GEMINI_FALLBACK_MODELS, ['alpha', 'beta', 'gamma']);
  process.env.GEMINI_FALLBACK_MODELS = '';
  process.env.LLM_FALLBACK_MODELS = '';
  const freshEnv2 = await import(`./src/config/env.js?fallback-parse2=${Date.now()}`);
  assert.deepEqual(freshEnv2.env.GEMINI_FALLBACK_MODELS, []);
});

// ─── Runner ───────────────────────────────────────────────────────────────
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`PASS  ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${t.name}`);
    console.error(`      ${err.message}`);
  }
}
console.log(failed === 0 ? `\nAll ${tests.length} tests passed.` : `\n${failed}/${tests.length} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);