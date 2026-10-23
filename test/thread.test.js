const test = require('node:test');
const assert = require('node:assert/strict');
const { createThread, addMessage, buildPrompt, chatTitle, findMention, hopsSinceMatt, HOP_LIMIT, AGENT_IDS } = require('../src/renderer/thread');

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

test('a relay is Matt passing one agent\'s reply to another', () => {
  const t = createThread();
  addMessage(t, { from: 'matt', to: 'claude', text: 'plan it' });
  addMessage(t, { from: 'claude', text: 'Step 1: do the thing' });
  const r = addMessage(t, { from: 'matt', to: 'codex', text: 'Step 1: do the thing', relayOf: 'claude' });
  assert.equal(r.relayOf, 'claude');
  const p = buildPrompt(t, 'codex');
  assert.ok(p.endsWith("Matt passed you this reply from Claude. Respond to it:\nStep 1: do the thing"));
  assert.equal(p.split('Step 1: do the thing').length - 1, 1, 'the relayed text is in the prompt once');
  assert.match(p, /Matt \(to Claude\): plan it/);

  addMessage(t, { from: 'codex', text: 'Looks good' });
  addMessage(t, { from: 'matt', to: 'claude', text: 'ok?' });
  const later = buildPrompt(t, 'claude');
  assert.match(later, /Matt \(to Codex\): \[passed on Claude's reply\]/);
  assert.equal(later.split('Step 1: do the thing').length - 1, 1, 'the relayed text appears once in history');
});

test('relays must come from Matt and go to a different agent', () => {
  const t = createThread();
  assert.throws(() => addMessage(t, { from: 'matt', to: 'claude', text: 'x', relayOf: 'claude' }), /Can't relay/);
  assert.throws(() => addMessage(t, { from: 'codex', text: 'x', relayOf: 'claude' }), /Can't relay/);
  assert.throws(() => addMessage(t, { from: 'matt', to: 'codex', text: 'x', relayOf: 'grok' }), /Can't relay/);
  assert.equal(addMessage(t, { from: 'matt', to: 'codex', text: 'x' }).relayOf, undefined);
});

test('renamed agents are called by their new names throughout the prompt', () => {
  const t = createThread();
  const names = { antigravity: 'Storm', claude: 'Cyclops', codex: 'Beast' };
  addMessage(t, { from: 'codex', text: 'design ready' });
  addMessage(t, { from: 'matt', to: 'claude', text: 'review it', relayOf: null });
  const p = buildPrompt(t, 'claude', { names });
  assert.match(p, /^You are Cyclops, one of three AI agents \(Storm, Cyclops and Beast\)/);
  assert.match(p, /Beast: design ready/);
  assert.ok(!/Claude|Codex|Antigravity/.test(p), 'no default names leak in');
});

test("a chat is titled from Matt's first message, one line, at most 40 characters", () => {
  const t = createThread();
  assert.equal(chatTitle(t), 'New chat');
  addMessage(t, { from: 'system', text: 'note' });
  assert.equal(chatTitle(t), 'New chat');
  addMessage(t, { from: 'matt', to: 'claude', text: 'Lets talk\nabout the UX design mocks for the new chat list please' });
  addMessage(t, { from: 'matt', to: 'claude', text: 'second' });
  const title = chatTitle(t);
  assert.ok(title.length <= 40, title);
  assert.ok(title.startsWith('Lets talk about the UX design mocks'));
  assert.ok(title.endsWith('…'));
});

test('an agent reply can be marked as stopped or timed out', () => {
  const t = createThread();
  assert.equal(addMessage(t, { from: 'claude', text: 'partial', endedAs: 'stopped' }).endedAs, 'stopped');
  assert.equal(addMessage(t, { from: 'codex', text: 'partial', endedAs: 'timed out' }).endedAs, 'timed out');
  assert.equal(addMessage(t, { from: 'codex', text: 'whole' }).endedAs, undefined);
  assert.throws(() => addMessage(t, { from: 'matt', to: 'claude', text: 'x', endedAs: 'stopped' }), /Bad ending/);
  assert.throws(() => addMessage(t, { from: 'claude', text: 'x', endedAs: 'exploded' }), /Bad ending/);
});

// ---- Threads and agent-to-agent hops (TM-53 Batch 3) ----

test('a thread hangs off a main-chat message, and handoffs are app notes between two agents', () => {
  const t = createThread();
  const root = addMessage(t, { from: 'claude', text: 'Let me ask @Codex' });
  const marker = addMessage(t, { from: 'system', text: 'Claude › Codex', threadOf: root.id, handoff: { from: 'claude', to: 'codex' } });
  assert.equal(marker.threadOf, root.id);
  assert.deepEqual(marker.handoff, { from: 'claude', to: 'codex' });
  assert.equal(addMessage(t, { from: 'codex', text: 'here', threadOf: root.id }).threadOf, root.id);
  assert.throws(() => addMessage(t, { from: 'codex', text: 'x', threadOf: 99 }), /Bad thread/);
  assert.throws(() => addMessage(t, { from: 'codex', text: 'x', threadOf: marker.id }), /Bad thread/, 'no threads inside threads');
  assert.throws(() => addMessage(t, { from: 'claude', text: 'x', handoff: { from: 'claude', to: 'codex' } }), /Bad handoff/);
  assert.throws(() => addMessage(t, { from: 'system', text: 'x', handoff: { from: 'claude', to: 'claude' } }), /Bad handoff/);
});

test('findMention finds the first other agent named with @, by its current name', () => {
  const names = { antigravity: 'Antigravity', claude: 'Cyclops', codex: 'Codex' };
  assert.equal(findMention('Over to @codex, then @Antigravity.', 'claude', names), 'codex');
  assert.equal(findMention('@Antigravity first, then @Codex', 'claude', names), 'antigravity');
  assert.equal(findMention('I am @Cyclops', 'claude', names), null, 'not yourself');
  assert.equal(findMention('ask @Claude', 'codex', names), null, 'old names do not count');
  assert.equal(findMention('ask @Cyclops.', 'codex', names), 'claude');
  assert.equal(findMention('email me@Codexample.com', 'claude', names), null, 'must be a whole name');
  assert.equal(findMention('Codex could help', 'claude', names), null, 'needs the @');
});

test('hops count handoffs since Matt last spoke in the thread', () => {
  const t = createThread();
  const root = addMessage(t, { from: 'claude', text: '@Codex?' });
  const hop = (from, to) => addMessage(t, { from: 'system', text: 'h', threadOf: root.id, handoff: { from, to } });
  assert.equal(hopsSinceMatt(t, root.id), 0);
  hop('claude', 'codex');
  addMessage(t, { from: 'codex', text: '@Claude', threadOf: root.id });
  hop('codex', 'claude');
  assert.equal(hopsSinceMatt(t, root.id), 2);
  addMessage(t, { from: 'matt', to: 'codex', text: 'keep going', threadOf: root.id });
  assert.equal(hopsSinceMatt(t, root.id), 0);
  hop('codex', 'antigravity');
  assert.equal(hopsSinceMatt(t, root.id), 1);
  assert.equal(HOP_LIMIT, 3);
});

test('a handoff prompt sees the main chat up to the thread, then the thread, and who brought it in', () => {
  const t = createThread();
  addMessage(t, { from: 'matt', to: 'claude', text: 'plan the menu' });
  const root = addMessage(t, { from: 'claude', text: 'Soup first. @Codex can you price it?' });
  addMessage(t, { from: 'matt', to: 'claude', text: 'later main-chat message' });
  addMessage(t, { from: 'system', text: 'Claude › Codex', threadOf: root.id, handoff: { from: 'claude', to: 'codex' } });
  const p = buildPrompt(t, 'codex', { threadOf: root.id });
  assert.match(p, /^You are Codex/);
  assert.match(p, /thread/);
  assert.match(p, /Matt \(to Claude\): plan the menu/);
  assert.ok(!p.includes('later main-chat message'), 'main chat after the thread started is left out');
  assert.ok(p.endsWith('Claude brought you in with this message:\nSoup first. @Codex can you price it?'));
  assert.equal(p.split('Soup first').length - 1, 1, 'the handoff text is in once');
  assert.throws(() => buildPrompt(t, 'antigravity', { threadOf: root.id }), /not from Matt/, 'only the agent mentioned is brought in');
});

test('Matt can talk in a thread, and the main chat sees thread messages marked as such', () => {
  const t = createThread();
  const root = addMessage(t, { from: 'claude', text: '@Codex price it' });
  addMessage(t, { from: 'codex', text: 'About $4', threadOf: root.id });
  addMessage(t, { from: 'matt', to: 'codex', text: 'cheaper?', threadOf: root.id });
  assert.ok(buildPrompt(t, 'codex', { threadOf: root.id }).endsWith("Matt's message to you:\ncheaper?"));
  addMessage(t, { from: 'codex', text: 'About $3', threadOf: root.id });
  addMessage(t, { from: 'matt', to: 'claude', text: 'so what did Codex say?' });
  const main = buildPrompt(t, 'claude');
  assert.match(main, /\(in a thread\) Codex: About \$3/);
  assert.match(main, /@Name/, 'agents are told how to bring another agent in');
});
