const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentRunner = require('../src/agent-runner');

function makeRunner() {
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, d) => sent.push({ ch, d }) } };
  const testLogger = { info() {}, warn() {}, error() {}, exception() {}, createLineSink: () => ({ push() {}, flush() {} }) };
  const runner = new AgentRunner(win, testLogger);
  runner.workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-runner-meta-'));
  return { runner, sent };
}

function aborted() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

// Scriptable stand-in for the meta driver: emits deltas, then resolves (or rejects).
function fakeMeta({ deltas = [], usage = null, error = null, hang = false } = {}) {
  const calls = [];
  return {
    calls,
    loadMetaConfig: () => ({ apiKey: 'fake-key', baseUrl: 'https://fake/v1', model: 'fake-model' }),
    chatCompletions: ({ model, messages, signal, onDelta }) => new Promise((resolve, reject) => {
      calls.push({ model, messages });
      if (signal && signal.aborted) { reject(aborted()); return; }
      const timers = [];
      const cleanup = () => { timers.forEach(clearTimeout); if (signal) signal.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); reject(aborted()); };
      if (signal) signal.addEventListener('abort', onAbort);
      if (hang) return;
      deltas.forEach((d, i) => timers.push(setTimeout(() => { if (onDelta) onDelta(d); }, (i + 1) * 5)));
      timers.push(setTimeout(() => { cleanup(); if (error) reject(error); else resolve({ text: deltas.join(''), usage }); }, deltas.length * 5 + 10));
    })
  };
}

function runMeta(runner, sent, opts = {}) {
  const done = new Promise((resolve) => { runner._send = (ch, d) => { sent.push({ ch, d }); if (ch === 'agent:done') resolve(d); }; });
  const r = runner.run({ runKey: 'c1/m1', vendor: 'meta', prompt: 'hi', ...opts });
  return { r, done };
}

test('meta run streams deltas and finishes with usage, no session', async () => {
  const { runner, sent } = makeRunner();
  const real = AgentRunner.MetaDriver;
  AgentRunner.MetaDriver = fakeMeta({ deltas: ['Hel', 'lo'], usage: { inputTokens: 3, outputTokens: 4 } });
  try {
    const { r, done } = runMeta(runner, sent, {});
    assert.ok(Number.isInteger(r), 'returns the run number');
    const d = await done;
    assert.equal(d.code, 0);
    assert.equal(d.stopped, false);
    assert.equal(d.timedOut, false);
    assert.deepEqual(d.usage, { inputTokens: 3, outputTokens: 4 });
    assert.equal(d.sessionId, undefined, 'api engines keep no vendor session');
    const text = sent.filter(s => s.ch === 'agent:output' && s.d.stream === 'stdout').map(s => s.d.text).join('');
    assert.equal(text, 'Hello');
  } finally { AgentRunner.MetaDriver = real; }
});

test('meta without a key is refused like a bad launch, and says why', () => {
  const { runner, sent } = makeRunner();
  const real = AgentRunner.MetaDriver;
  AgentRunner.MetaDriver = {
    loadMetaConfig: () => { const e = new Error('no key'); e.code = 'META_NO_API_KEY'; throw e; },
    chatCompletions: () => { throw new Error('must not be called'); }
  };
  try {
    assert.equal(runner.run({ runKey: 'c1/m1', vendor: 'meta', prompt: 'hi' }), false);
    assert.match(sent.find(s => s.ch === 'agent:output').d.text, /BASETEN_API_KEY/);
    assert.equal(runner.processes.has('c1/m1'), false);
  } finally { AgentRunner.MetaDriver = real; }
});

test('Stop ends a meta run and its done event says it was stopped', async () => {
  const { runner, sent } = makeRunner();
  const real = AgentRunner.MetaDriver;
  AgentRunner.MetaDriver = fakeMeta({ hang: true });
  try {
    const { done } = runMeta(runner, sent, {});
    runner.stop('c1/m1');
    const d = await done;
    assert.equal(d.stopped, true);
    assert.equal(d.timedOut, false);
    assert.equal(runner.processes.has('c1/m1'), false);
  } finally { AgentRunner.MetaDriver = real; }
});

test('a meta reply that runs past its timeout is reported as timed out', async () => {
  const { runner, sent } = makeRunner();
  const real = AgentRunner.MetaDriver;
  AgentRunner.MetaDriver = fakeMeta({ hang: true });
  try {
    runner.agents.meta.timeoutSec = 0.05;
    const { done } = runMeta(runner, sent, {});
    const d = await done;
    assert.equal(d.timedOut, true);
    assert.equal(d.stopped, false);
    assert.equal(d.timeoutSec, 0.05);
  } finally { AgentRunner.MetaDriver = real; }
});

test('model aliases resolve to the configured model; typed ids pass through', async () => {
  assert.equal(AgentRunner.resolveMetaModel(null, 'cfg'), 'cfg');
  assert.equal(AgentRunner.resolveMetaModel('spark', 'cfg'), 'cfg');
  assert.equal(AgentRunner.resolveMetaModel('default', 'cfg'), 'cfg');
  assert.equal(AgentRunner.resolveMetaModel('custom-x', 'cfg'), 'custom-x');
  assert.deepEqual(AgentRunner.META_MODELS, [{ id: 'spark', label: 'Muse Spark' }]);
  assert.ok(AgentRunner.MODEL_TEXT.test('spark'));
  const { runner, sent } = makeRunner();
  const fake = fakeMeta({});
  const real = AgentRunner.MetaDriver;
  AgentRunner.MetaDriver = fake;
  try {
    const a = runMeta(runner, sent, { model: 'spark' });
    await a.done;
    const b = runMeta(runner, sent, { model: 'custom-x' });
    await b.done;
    assert.equal(fake.calls[0].model, 'fake-model');
    assert.equal(fake.calls[1].model, 'custom-x');
  } finally { AgentRunner.MetaDriver = real; }
});

test('meta runs write only allow-listed folder files into the chat folder', async () => {
  const { runner, sent } = makeRunner();
  const dir = runner.workingDir;
  const real = AgentRunner.MetaDriver;
  AgentRunner.MetaDriver = fakeMeta({});
  try {
    const { done } = runMeta(runner, sent, { files: { 'AGENTS.md': '# brain', 'evil.md': 'no' } });
    await done;
    assert.equal(fs.readFileSync(path.join(dir, 'c1', 'AGENTS.md'), 'utf8'), '# brain');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'c1')), ['AGENTS.md']);
  } finally { AgentRunner.MetaDriver = real; }
});

test('an api failure reaches the chat and finishes with code 1', async () => {
  const { runner, sent } = makeRunner();
  const real = AgentRunner.MetaDriver;
  AgentRunner.MetaDriver = fakeMeta({ error: new Error('rate limited (429)') });
  try {
    const { done } = runMeta(runner, sent, {});
    const d = await done;
    assert.equal(d.code, 1);
    assert.equal(d.stopped, false);
    assert.match(sent.filter(s => s.ch === 'agent:output').map(s => s.d.text).join(''), /rate limited/);
  } finally { AgentRunner.MetaDriver = real; }
});

test('a superseding launch stops the older meta run', async () => {
  const { runner, sent } = makeRunner();
  const real = AgentRunner.MetaDriver;
  AgentRunner.MetaDriver = fakeMeta({ hang: true });
  try {
    const dones = [];
    const both = new Promise((resolve) => { runner._send = (ch, d) => { sent.push({ ch, d }); if (ch === 'agent:done') { dones.push(d); if (dones.length === 2) resolve(); } }; });
    const r1 = runner.run({ runKey: 'c1/m1', vendor: 'meta', prompt: 'one' });
    const r2 = runner.run({ runKey: 'c1/m1', vendor: 'meta', prompt: 'two' });
    assert.ok(Number.isInteger(r1) && Number.isInteger(r2) && r2 > r1);
    runner.stop('c1/m1');
    await both;
    assert.equal(dones[0].stopped, true, 'the superseded run was stopped');
  } finally { AgentRunner.MetaDriver = real; }
});