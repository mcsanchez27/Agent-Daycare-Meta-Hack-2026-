const test = require('node:test');
const assert = require('node:assert/strict');
const { createThread, addMessage, AGENT_IDS } = require('../src/renderer/thread');

test('messages get increasing ids and keep their order', () => {
  const t = createThread();
  const a = addMessage(t, { from: 'matt', to: 'claude', text: 'hi' });
  const b = addMessage(t, { from: 'claude', text: 'hello' });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.deepEqual(t.messages.map(m => m.text), ['hi', 'hello']);
  assert.ok(!Number.isNaN(Date.parse(a.ts)));
});

test("Matt's messages say which agent they are for; others have no recipient", () => {
  const t = createThread();
  assert.equal(addMessage(t, { from: 'matt', to: 'codex', text: 'x' }).to, 'codex');
  assert.equal(addMessage(t, { from: 'antigravity', to: 'claude', text: 'y' }).to, null);
  assert.equal(addMessage(t, { from: 'system', text: 'z' }).to, null);
});

test('text is trimmed and empty messages are rejected', () => {
  const t = createThread();
  assert.equal(addMessage(t, { from: 'matt', to: 'claude', text: '  hi \n' }).text, 'hi');
  assert.throws(() => addMessage(t, { from: 'matt', to: 'claude', text: '   ' }), /needs text/);
  assert.throws(() => addMessage(t, { from: 'matt', to: 'claude' }), /needs text/);
  assert.equal(t.messages.length, 1);
});

test('unknown senders and missing recipients are rejected', () => {
  const t = createThread();
  assert.throws(() => addMessage(t, { from: 'grok', text: 'x' }), /Unknown sender/);
  assert.throws(() => addMessage(t, { from: 'matt', text: 'x' }), /Pick an agent/);
  assert.throws(() => addMessage(t, { from: 'matt', to: 'grok', text: 'x' }), /Pick an agent/);
  assert.equal(t.messages.length, 0);
});

test('the thread knows the three V1 agents', () => {
  assert.deepEqual(AGENT_IDS, ['antigravity', 'claude', 'codex']);
});
