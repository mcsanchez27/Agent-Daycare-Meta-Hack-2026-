const test = require('node:test');
const assert = require('node:assert');
const meta = require('../src/providers/meta');
const providers = require('../src/providers/index');

function sseBody(lines) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line + '\n';
    }
  };
}

function okFetch(lines, seen = {}) {
  return async (url, opts) => {
    seen.url = url;
    seen.opts = opts;
    return { ok: true, status: 200, body: sseBody(lines) };
  };
}

test('loadMetaConfig defaults the Baseten URL and Spark model', () => {
  const cfg = meta.loadMetaConfig({ BASETEN_API_KEY: 'k' });
  assert.equal(cfg.baseUrl, 'https://inference.baseten.co/v1');
  assert.equal(cfg.model, 'meta-models/muse-spark-open-1026');
});

test('loadMetaConfig honors overrides and strips trailing slashes', () => {
  const cfg = meta.loadMetaConfig({ META_API_KEY: 'k', BASETEN_BASE_URL: 'https://x.test/v1///', META_SPARK_MODEL: 'm' });
  assert.equal(cfg.baseUrl, 'https://x.test/v1');
  assert.equal(cfg.model, 'm');
});

test('loadMetaConfig throws a coded error without a key', () => {
  assert.throws(() => meta.loadMetaConfig({}), (err) => err.code === 'META_NO_API_KEY');
});

test('chatCompletions accumulates SSE deltas and streams them', async () => {
  const seen = {};
  const deltas = [];
  const out = await meta.chatCompletions({
    apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: okFetch([
      'data: {"choices":[{"delta":{"content":"ap"}}]}',
      'data: {"choices":[{"delta":{"content":"ple"}}]}',
      'data: [DONE]'
    ], seen),
    onDelta: (t) => deltas.push(t)
  });
  assert.equal(out.text, 'apple');
  assert.deepEqual(deltas, ['ap', 'ple']);
  assert.equal(seen.url, 'https://x.test/v1/chat/completions');
  assert.equal(seen.opts.headers.Authorization, 'Bearer k');
  const sent = JSON.parse(seen.opts.body);
  assert.equal(sent.stream, true);
  assert.equal(sent.model, 'm');
});

test('chatCompletions tolerates split chunks, whole messages and usage', async () => {
  const body = {
    async *[Symbol.asyncIterator]() {
      yield 'data: {"choices":[{"delta":{"cont';
      yield 'ent":"a"}}]}\n';
      yield 'data: {"choices":[{"message":{"content":"b"}}]}\n';
      yield 'data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n';
      yield 'data: [DONE]';
    }
  };
  const out = await meta.chatCompletions({
    apiKey: 'k', baseUrl: 'https://x', model: 'm', messages: [],
    fetchImpl: async () => ({ ok: true, status: 200, body })
  });
  assert.equal(out.text, 'ab');
  assert.deepEqual(out.usage, { inputTokens: 3, outputTokens: 4 });
});

test('chatCompletions throws coded HTTP errors with a truncated body', async () => {
  const err = await meta.chatCompletions({
    apiKey: 'k', baseUrl: 'https://x', model: 'm', messages: [],
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'nope' })
  }).then(() => null, (e) => e);
  assert.equal(err.code, 'META_HTTP_ERROR');
  assert.equal(err.status, 401);
  assert.match(err.message, /401/);
});

test('provider registry: meta is api-type, CLI vendors stay cli-type', () => {
  assert.equal(providers.get('meta').type, 'api');
  for (const v of providers.CLI_VENDORS) assert.equal(providers.get(v).type, 'cli');
  assert.equal(providers.isApiProvider('meta'), true);
  assert.equal(providers.isApiProvider('claude'), false);
  assert.equal(providers.isApiProvider('nope'), false);
  assert.throws(() => providers.get('nope'), /unknown provider/);
});