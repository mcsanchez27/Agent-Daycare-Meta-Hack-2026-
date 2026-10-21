const test = require('node:test');
const assert = require('node:assert/strict');
const { createThread, addMessage, buildPrompt, AGENT_IDS } = require('../src/renderer/thread');

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

test("buildPrompt ends with Matt's newest message and includes earlier history", () => {
  const t = createThread();
  addMessage(t, { from: 'matt', to: 'codex', text: 'Codex, plan it' });
  addMessage(t, { from: 'codex', text: 'Step 1, step 2' });
  addMessage(t, { from: 'system', text: 'an app note' });
  addMessage(t, { from: 'matt', to: 'claude', text: 'Claude, thoughts?' });
  const p = buildPrompt(t, 'claude');
  assert.match(p, /^You are Claude, one of three AI agents/);
  assert.match(p, /Recent conversation:\nMatt \(to Codex\): Codex, plan it\n\nCodex: Step 1, step 2/);
  assert.ok(p.endsWith("Matt's message to you:\nClaude, thoughts?"));
  assert.ok(!p.includes('an app note'), 'app notes are left out');
});

test('buildPrompt with no history has no history section', () => {
  const t = createThread();
  addMessage(t, { from: 'matt', to: 'claude', text: 'hi' });
  const p = buildPrompt(t, 'claude');
  assert.ok(!p.includes('Recent conversation'));
  assert.ok(p.endsWith("Matt's message to you:\nhi"));
});

test('buildPrompt keeps the newest history when it has to cut', () => {
  const t = createThread();
  for (let i = 1; i <= 30; i++) addMessage(t, { from: 'claude', text: `reply ${i}` });
  addMessage(t, { from: 'matt', to: 'claude', text: 'go' });
  const byCount = buildPrompt(t, 'claude', { maxMessages: 3 });
  assert.match(byCount, /Claude: reply 28\n\nClaude: reply 29\n\nClaude: reply 30/);
  assert.ok(!byCount.includes('reply 27'));
  const byChars = buildPrompt(t, 'claude', { maxChars: 30 });
  assert.ok(byChars.includes('reply 30') && !byChars.includes('reply 28'));
});

test('buildPrompt stays under the Windows command-line limit even with huge messages', () => {
  const t = createThread();
  for (let i = 0; i < 20; i++) addMessage(t, { from: 'claude', text: 'x'.repeat(5000) });
  addMessage(t, { from: 'matt', to: 'claude', text: 'go' });
  assert.ok(buildPrompt(t, 'claude').length < 16000);
});

test("buildPrompt refuses when the newest message isn't Matt's message to that agent", () => {
  const t = createThread();
  assert.throws(() => buildPrompt(t, 'claude'), /not from Matt/);
  addMessage(t, { from: 'matt', to: 'codex', text: 'hi' });
  assert.throws(() => buildPrompt(t, 'claude'), /not from Matt to claude/);
});
