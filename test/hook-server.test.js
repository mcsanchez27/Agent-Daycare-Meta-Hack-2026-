const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { HookServer, isLoopbackHost } = require('../src/hook-server');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {}, exception() {} };

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(fn) {
  const events = [];
  const server = new HookServer({ port: 0, logger: quietLogger, onEvent: (id, ev) => events.push({ id, ev }) });
  await server.start();
  try {
    await fn(server, events);
  } finally {
    await server.stop();
  }
}

test('isLoopbackHost accepts loopback hosts with or without ports', () => {
  assert.ok(isLoopbackHost('127.0.0.1:48211'));
  assert.ok(isLoopbackHost('localhost'));
  assert.ok(isLoopbackHost('[::1]:5'));
  assert.ok(!isLoopbackHost('evil.example.com:48211'));
  assert.ok(!isLoopbackHost(undefined));
});

test('delivers a posted event to onEvent keyed by agent id', () => withServer(async (server, events) => {
  const res = await post(server.hookUrl('claude'), JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc' }));
  assert.equal(res.status, 204);
  assert.deepEqual(events, [{ id: 'claude', ev: { hook_event_name: 'Stop', session_id: 'abc' } }]);
}));

test('rejects browser requests, foreign hosts, bad paths, bad JSON', () => withServer(async (server, events) => {
  const url = server.hookUrl('claude');
  assert.equal((await post(url, '{}', { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(url, '{}', { Host: 'evil.example:1' })).status, 403);
  assert.equal((await post(`${server.url}/somewhere/else`, '{}')).status, 404);
  assert.equal((await post(url, 'not json')).status, 400);
  assert.equal((await post(url, '[1,2]')).status, 400);
  assert.equal(events.length, 0);
}));

test('GET / answers a health check', () => withServer(async (server) => {
  const body = await new Promise((resolve, reject) => {
    http.get(server.url + '/', (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  assert.deepEqual(body, { ok: true, app: 'agent-daycare' });
}));

test('an exception inside onEvent is logged, not fatal', async () => {
  const logged = [];
  const server = new HookServer({
    port: 0,
    logger: { ...quietLogger, exception: (src, err, meta) => logged.push({ src, err: err.message, meta }) },
    onEvent: () => { throw new Error('handler blew up'); }
  });
  await server.start();
  try {
    const res = await post(server.hookUrl('claude'), '{}');
    assert.equal(res.status, 204);
    assert.deepEqual(logged, [{ src: 'app', err: 'handler blew up', meta: { phase: 'hook onEvent', agentId: 'claude' } }]);
  } finally {
    await server.stop();
  }
});

test('server listener failure is rejected', async () => {
  const s1 = http.createServer();
  await new Promise(r => s1.listen(0, '127.0.0.1', r));
  const port = s1.address().port;

  const server = new HookServer({ port, logger: quietLogger, onEvent: () => {} });
  try {
    await server.start();
    assert.fail('should have rejected');
  } catch (err) {
    assert.equal(err.code, 'EADDRINUSE');
  } finally {
    s1.close();
  }
});

test('rejects body that is too large', () => withServer(async (server) => {
  const url = server.hookUrl('claude');
  const largeBody = 'x'.repeat(64 * 1024 + 1);

  const res = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST' }, (r) => {
      resolve(r);
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNRESET') resolve({ statusCode: 413 });
      else reject(err);
    });
    req.write(largeBody);
    req.end();
  });

  assert.equal(res.statusCode, 413);

  const res2 = await post(url, '{}');
  assert.equal(res2.status, 204);
}));
