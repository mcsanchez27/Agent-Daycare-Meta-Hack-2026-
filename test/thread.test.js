const test = require('node:test');
const assert = require('node:assert/strict');
const { createThread, addMessage, buildPrompt, chatTitle, findMention, hopsSinceMatt, HOP_LIMIT, VENDORS } = require('../src/renderer/thread');
const { ensureMembers } = require('../src/renderer/members');

// The three V1 agents as members, with the vendor ids as member ids (as old chats are moved over).
const V1 = () => ensureMembers({ messages: [{ from: 'claude' }, { from: 'antigravity' }, { from: 'codex' }] }).members;

test('messages get increasing ids and keep their order', () => {
  const t = createThread(V1());
  const a = addMessage(t, { from: 'matt', to: 'claude', text: 'hi' });
  const b = addMessage(t, { from: 'claude', text: 'hello' });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.deepEqual(t.messages.map(m => m.text), ['hi', 'hello']);
  assert.ok(!Number.isNaN(Date.parse(a.ts)));
});

test("Matt's messages say which agent they are for; others have no recipient", () => {
  const t = createThread(V1());
  assert.equal(addMessage(t, { from: 'matt', to: 'codex', text: 'x' }).to, 'codex');
  assert.equal(addMessage(t, { from: 'antigravity', to: 'claude', text: 'y' }).to, null);
  assert.equal(addMessage(t, { from: 'system', text: 'z' }).to, null);
});

test('text is trimmed and empty messages are rejected', () => {
  const t = createThread(V1());
  assert.equal(addMessage(t, { from: 'matt', to: 'claude', text: '  hi \n' }).text, 'hi');
  assert.throws(() => addMessage(t, { from: 'matt', to: 'claude', text: '   ' }), /needs text/);
  assert.throws(() => addMessage(t, { from: 'matt', to: 'claude' }), /needs text/);
  assert.equal(t.messages.length, 1);
});

test('unknown senders and missing recipients are rejected', () => {
  const t = createThread(V1());
  assert.throws(() => addMessage(t, { from: 'grok', text: 'x' }), /Unknown sender/);
  assert.throws(() => addMessage(t, { from: 'matt', text: 'x' }), /Pick an agent/);
  assert.throws(() => addMessage(t, { from: 'matt', to: 'grok', text: 'x' }), /Pick an agent/);
  assert.equal(t.messages.length, 0);
});

test('the thread knows the three V1 agents', () => {
  assert.deepEqual(VENDORS, ['antigravity', 'claude', 'codex']);
});

test("buildPrompt ends with Matt's newest message and includes earlier history", () => {
  const t = createThread(V1());
  addMessage(t, { from: 'matt', to: 'codex', text: 'Codex, plan it' });
  addMessage(t, { from: 'codex', text: 'Step 1, step 2' });
  addMessage(t, { from: 'system', text: 'an app note' });
  addMessage(t, { from: 'matt', to: 'claude', text: 'Claude, thoughts?' });
  const p = buildPrompt(t, 'claude');
  assert.match(p, /^You are Claude \(claude, model default\), one of 3 AI agents/);
  assert.match(p, /Recent conversation:\nMatt \(to Codex\): Codex, plan it\n\nCodex: Step 1, step 2/);
  assert.ok(p.endsWith("Matt's message to you:\nClaude, thoughts?"));
  assert.ok(!p.includes('an app note'), 'app notes are left out');
});

test('buildPrompt with no history has no history section', () => {
  const t = createThread(V1());
  addMessage(t, { from: 'matt', to: 'claude', text: 'hi' });
  const p = buildPrompt(t, 'claude');
  assert.ok(!p.includes('Recent conversation'));
  assert.ok(p.endsWith("Matt's message to you:\nhi"));
});

test('buildPrompt keeps the newest history when it has to cut', () => {
  const t = createThread(V1());
  for (let i = 1; i <= 30; i++) addMessage(t, { from: 'claude', text: `reply ${i}` });
  addMessage(t, { from: 'matt', to: 'claude', text: 'go' });
  const byCount = buildPrompt(t, 'claude', { maxMessages: 3 });
  assert.match(byCount, /Claude: reply 28\n\nClaude: reply 29\n\nClaude: reply 30/);
  assert.ok(!byCount.includes('reply 27'));
  const byChars = buildPrompt(t, 'claude', { maxChars: 30 });
  assert.ok(byChars.includes('reply 30') && !byChars.includes('reply 28'));
});

test('buildPrompt stays under the Windows command-line limit even with huge messages', () => {
  const t = createThread(V1());
  for (let i = 0; i < 20; i++) addMessage(t, { from: 'claude', text: 'x'.repeat(5000) });
  addMessage(t, { from: 'matt', to: 'claude', text: 'go' });
  assert.ok(buildPrompt(t, 'claude').length < 16000);
});

test("buildPrompt refuses when the newest message isn't Matt's message to that agent", () => {
  const t = createThread(V1());
  assert.throws(() => buildPrompt(t, 'claude'), /not from Matt/);
  addMessage(t, { from: 'matt', to: 'codex', text: 'hi' });
  assert.throws(() => buildPrompt(t, 'claude'), /not from Matt to claude/);
});

test('a relay is Matt passing one agent\'s reply to another', () => {
  const t = createThread(V1());
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
  const t = createThread(V1());
  assert.throws(() => addMessage(t, { from: 'matt', to: 'claude', text: 'x', relayOf: 'claude' }), /Can't relay/);
  assert.throws(() => addMessage(t, { from: 'codex', text: 'x', relayOf: 'claude' }), /Can't relay/);
  assert.throws(() => addMessage(t, { from: 'matt', to: 'codex', text: 'x', relayOf: 'grok' }), /Can't relay/);
  assert.equal(addMessage(t, { from: 'matt', to: 'codex', text: 'x' }).relayOf, undefined);
});

test('renamed agents are called by their new names throughout the prompt', () => {
  const t = createThread(V1());
  const names = { antigravity: 'Storm', claude: 'Cyclops', codex: 'Beast' };
  for (const m of t.members) m.name = names[m.id];
  addMessage(t, { from: 'codex', text: 'design ready' });
  addMessage(t, { from: 'matt', to: 'claude', text: 'review it', relayOf: null });
  const p = buildPrompt(t, 'claude');
  assert.match(p, /^You are Cyclops \(claude, model default\), one of 3 AI agents \(Cyclops, Storm and Beast\)/);
  assert.match(p, /Beast: design ready/);
  assert.ok(!/Claude|Codex|Antigravity/.test(p), 'no default names leak in');
});

test("a chat is titled from Matt's first message, one line, at most 40 characters", () => {
  const t = createThread(V1());
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
  const t = createThread(V1());
  assert.equal(addMessage(t, { from: 'claude', text: 'partial', endedAs: 'stopped' }).endedAs, 'stopped');
  assert.equal(addMessage(t, { from: 'codex', text: 'partial', endedAs: 'timed out' }).endedAs, 'timed out');
  assert.equal(addMessage(t, { from: 'codex', text: 'whole' }).endedAs, undefined);
  assert.throws(() => addMessage(t, { from: 'matt', to: 'claude', text: 'x', endedAs: 'stopped' }), /Bad ending/);
  assert.throws(() => addMessage(t, { from: 'claude', text: 'x', endedAs: 'exploded' }), /Bad ending/);
});

// ---- Threads and agent-to-agent hops (TM-53 Batch 3) ----

test('a thread hangs off a main-chat message, and handoffs are app notes between two agents', () => {
  const t = createThread(V1());
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
  const names = V1().map(m => (m.id === 'claude' ? { ...m, name: 'Cyclops' } : m));
  assert.equal(findMention('Over to @codex, then @Gemini.', 'claude', names), 'codex');
  assert.equal(findMention('@Gemini first, then @Codex', 'claude', names), 'antigravity');
  assert.equal(findMention('I am @Cyclops', 'claude', names), null, 'not yourself');
  assert.equal(findMention('ask @Claude', 'codex', names), null, 'old names do not count');
  assert.equal(findMention('ask @Cyclops.', 'codex', names), 'claude');
  assert.equal(findMention('email me@Codexample.com', 'claude', names), null, 'must be a whole name');
  assert.equal(findMention('Codex could help', 'claude', names), null, 'needs the @');
});

test('hops count handoffs since Matt last spoke in the thread', () => {
  const t = createThread(V1());
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
  const t = createThread(V1());
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
  const t = createThread(V1());
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

// ---- @ and group chats (TM-54 Batch 3) ----
const { newMember } = require('../src/renderer/members');
const { findTarget, routeMessage, memorySnapshot } = require('../src/renderer/thread');
const VN = { antigravity: 'Antigravity', claude: 'Claude', codex: 'Codex' };

function claudeAndSonnet() {
  const members = [newMember([], { vendor: 'claude' })];
  members.push(newMember(members, { vendor: 'claude', model: 'sonnet' }, { modelLabel: 'Sonnet' }));
  return createThread(members);
}

test('findTarget: a member by name, else an absent vendor, else nothing', () => {
  const t = claudeAndSonnet();
  assert.deepEqual(findTarget('hey @sonnet, thoughts?', null, t.members, VN), { memberId: 'm2' });
  assert.deepEqual(findTarget('@Codex look at this', null, t.members, VN), { vendor: 'codex' });
  assert.deepEqual(findTarget('ask @claude', 'm2', t.members, VN), { memberId: 'm1' });
  assert.equal(findTarget('ask @claude', 'm1', t.members, VN), null, 'not yourself, and Claude is taken');
  assert.equal(findTarget('email@codex.com', null, t.members, VN), null);
  assert.deepEqual(findTarget('@codex then @sonnet', null, t.members, VN), { vendor: 'codex' }, 'the first one wins');
});

test('routeMessage: the first @, else the thread root author, else the owner', () => {
  const t = claudeAndSonnet();
  assert.deepEqual(routeMessage(t, 'hi', null, VN), { memberId: 'm1' });
  assert.deepEqual(routeMessage(t, 'hi @Sonnet', null, VN), { memberId: 'm2' });
  assert.deepEqual(routeMessage(t, '@antigravity hi', null, VN), { vendor: 'antigravity' });
  const fromSonnet = addMessage(t, { from: 'm2', text: 'an idea' });
  const fromMatt = addMessage(t, { from: 'matt', to: 'm1', text: 'a question' });
  assert.deepEqual(routeMessage(t, 'more?', fromSonnet.id, VN), { memberId: 'm2' });
  assert.deepEqual(routeMessage(t, 'more?', fromMatt.id, VN), { memberId: 'm1' });
});

test('handoffs can happen in the main chat, and hops count per view', () => {
  const t = claudeAndSonnet();
  const a = addMessage(t, { from: 'm1', text: '@Sonnet?' });
  addMessage(t, { from: 'system', text: 'h', handoff: { from: 'm1', to: 'm2' } });
  addMessage(t, { from: 'system', text: 'h', threadOf: a.id, handoff: { from: 'm1', to: 'm2' } });
  assert.equal(hopsSinceMatt(t, null), 1);
  assert.equal(hopsSinceMatt(t, a.id), 1);
  addMessage(t, { from: 'matt', to: 'm1', text: 'ok' });
  assert.equal(hopsSinceMatt(t, null), 0);
  assert.equal(hopsSinceMatt(t, a.id), 1, 'Matt spoke in the main chat, not the thread');
});

test('snapshot keeps the newest and stays within its limit', () => {
  const t = claudeAndSonnet();
  for (let i = 1; i <= 50; i++) addMessage(t, { from: 'm1', text: `note ${i} ` + 'x'.repeat(150) });
  const s = memorySnapshot(t);
  assert.ok(s.length <= 4000, s.length);
  assert.ok(s.trimEnd().endsWith('note 50 ' + 'x'.repeat(150)));
  assert.ok(!s.includes('note 1 '), 'oldest dropped');
});

test('memory counts toward the size limit and comes before the conversation', () => {
  const members = [newMember([], { vendor: 'claude' })];
  members.push(newMember(members, { vendor: 'codex', memory: { title: 'Old plan', text: 'M'.repeat(4000) } }));
  const t = createThread(members);
  for (let i = 0; i < 20; i++) addMessage(t, { from: 'm1', text: `msg ${i} ` + 'y'.repeat(1000) });
  addMessage(t, { from: 'matt', to: 'm2', text: 'go' });
  const p = buildPrompt(t, 'm2');
  assert.match(p, /Background from your earlier chat 'Old plan':\nM{4000}/);
  t.members[1].memory.name = 'Beast';
  assert.match(buildPrompt(t, 'm2'), /Background from your earlier chat 'Old plan' \(you were called Beast there\):/);
  assert.ok(p.indexOf('Background') < p.indexOf('Recent conversation'));
  assert.ok(p.includes('msg 19 '), 'the newest message is kept');
  const history = p.slice(p.indexOf('Background'), p.lastIndexOf("Matt's message"));
  assert.ok(history.length <= 12000 + 200, history.length);
});

// ---- Background asks between chats (TM-54 Batch 5) ----
const { findChatMention } = require('../src/renderer/thread');

test('findChatMention: the longest chat title after #, as a whole phrase', () => {
  const chats = [{ id: 'a', title: 'Codex' }, { id: 'b', title: 'Codex solo' }, { id: 'c', title: 'Plan (v2)' }];
  assert.deepEqual(findChatMention('#codex solo what is X?', chats), { chatId: 'b' });
  assert.deepEqual(findChatMention('ask #Codex about X', chats), { chatId: 'a' });
  assert.deepEqual(findChatMention('# Codex solo What is 7 times 8?', chats), { chatId: 'b' }, 'one space after # (markdown habit)');
  assert.equal(findChatMention('# Notes for today', chats), null, 'a heading that is not a chat');
  assert.deepEqual(findChatMention('see #Plan (v2): ok', chats), { chatId: 'c' }, 'punctuation in titles');
  assert.equal(findChatMention('#Codexy', chats), null);
  assert.equal(findChatMention('email#Codex', chats), null);
  assert.equal(findChatMention('no hash here', chats), null);
});

test('a guest from another chat is answered like Matt, and named with its chat', () => {
  const t = createThread([newMember([], { vendor: 'codex' })]);
  assert.throws(() => addMessage(t, { from: 'guest', to: 'm1', text: 'x' }), /guest/);
  const g = addMessage(t, { from: 'guest', to: 'm1', guest: { chatId: 'c1', chatTitle: 'Claude solo', name: 'Claude' }, text: 'What is 2+2?' });
  assert.equal(g.to, 'm1');
  const p = buildPrompt(t, 'm1');
  assert.ok(p.endsWith("Claude (from chat 'Claude solo') asks you:\nWhat is 2+2?"), p);
  addMessage(t, { from: 'm1', text: '4' });
  addMessage(t, { from: 'matt', to: 'm1', text: 'what did Claude ask?' });
  assert.match(buildPrompt(t, 'm1'), /Claude \(from chat 'Claude solo'\): What is 2\+2\?/);
});

test('an answered background ask shows in later prompts; the follow-up prompt ends with the answer', () => {
  const t = createThread([newMember([], { vendor: 'claude' })]);
  addMessage(t, { from: 'matt', to: 'm1', text: 'ask Codex solo for a number' });
  addMessage(t, { from: 'm1', text: '#Codex solo pick a number' });
  const side = addMessage(t, { from: 'system', text: 'Claude asked', side: { chatId: 'x', chatTitle: 'Codex solo', asker: 'm1', question: '#Codex solo pick a number', state: 'asking', hop: 1 } });
  side.side.state = 'answered';
  side.side.answer = '7';
  const follow = buildPrompt(t, 'm1', { answer: { chatTitle: 'Codex solo', text: '7' } });
  assert.ok(follow.endsWith("The chat 'Codex solo' answered your question:\n7\n\nFinish your reply to Matt."), follow);
  addMessage(t, { from: 'matt', to: 'm1', text: 'and?' });
  assert.match(buildPrompt(t, 'm1'), /\(in the background\) Claude asked the chat 'Codex solo': #Codex solo pick a number\nIt answered: 7/);
});

test("agents are told the titles of Matt's other chats, so they can ask one with #", () => {
  const t = createThread([newMember([], { vendor: 'claude' })]);
  addMessage(t, { from: 'matt', to: 'm1', text: 'ask the codex chat' });
  const p = buildPrompt(t, 'm1', { chatTitles: ['Codex solo', 'Plan'] });
  assert.match(p, /Matt's other chats: "Codex solo", "Plan"\./);
  assert.ok(!buildPrompt(t, 'm1').includes("Matt's other chats:"), 'no list, no line');
});

// ---- Merging chats (TM-54 Batch 6) ----
const { mergeThreads } = require('../src/renderer/thread');

test('merge: both agents and histories in time order, every reference remapped, originals untouched', () => {
  const a = createThread([newMember([], { vendor: 'claude', model: 'sonnet' })]);
  const b = ensureMembers({ messages: [], nextId: 1 }); // an old chat: member ids are vendor ids
  b.members.push({ id: 'codex', vendor: 'codex', model: null, name: 'Codex' });
  const at = (m, ts) => { m.ts = ts; return m; };
  at(addMessage(a, { from: 'matt', to: 'm1', text: 'A1' }), '2026-10-23T01:00:00.000Z');
  const aRoot = at(addMessage(a, { from: 'm1', text: 'A2 @Codex?' }), '2026-10-23T01:02:00.000Z');
  at(addMessage(b, { from: 'matt', to: 'codex', text: 'B1' }), '2026-10-23T01:01:00.000Z');
  at(addMessage(b, { from: 'claude', text: 'B2' }), '2026-10-23T01:03:00.000Z');
  at(addMessage(a, { from: 'matt', to: 'm1', text: 'A3 in thread', threadOf: aRoot.id }), '2026-10-23T01:04:00.000Z');
  at(addMessage(b, { from: 'system', text: 'hop', handoff: { from: 'claude', to: 'codex' } }), '2026-10-23T01:05:00.000Z');
  const before = JSON.stringify([a, b]);

  const t = mergeThreads(a, b);
  assert.equal(JSON.stringify([a, b]), before, 'originals unchanged');
  assert.deepEqual(t.members.map(m => [m.id, m.vendor, m.model, m.name]),
    [['m1', 'claude', 'sonnet', 'Claude'], ['m2', 'claude', null, 'Claude 2'], ['m3', 'codex', null, 'Codex']]);
  assert.deepEqual(t.messages.map(m => m.text), ['A1', 'B1', 'A2 @Codex?', 'B2', 'A3 in thread', 'hop']);
  assert.deepEqual(t.messages.map(m => m.id), [1, 2, 3, 4, 5, 6]);
  assert.equal(t.nextId, 7);
  const [a1, b1, a2, b2, a3, hop] = t.messages;
  assert.equal(a1.to, 'm1');
  assert.equal(b1.to, 'm3');
  assert.equal(a2.from, 'm1');
  assert.equal(b2.from, 'm2');
  assert.equal(a3.threadOf, a2.id, 'the thread still hangs off its message');
  assert.deepEqual(hop.handoff, { from: 'm2', to: 'm3' });
  // The merged chat works: a new message gets a fresh id and prompts build.
  assert.equal(addMessage(t, { from: 'matt', to: 'm3', text: 'next' }).id, 7);
  assert.match(buildPrompt(t, 'm3'), /one of 3 AI agents \(Claude, Claude 2 and Codex\)/);
});

// ---- Vendor sessions (TM-55 Batch 1) ----
test('resuming a session: only what is new since the last turn, not the agent\'s own words, no header', () => {
  const members = [newMember([], { vendor: 'claude' })];
  members.push(newMember(members, { vendor: 'codex' }));
  const t = createThread(members);
  addMessage(t, { from: 'matt', to: 'm1', text: 'old question' });
  const seen = addMessage(t, { from: 'm1', text: 'old answer' });
  addMessage(t, { from: 'm2', text: 'Codex chimed in' });
  addMessage(t, { from: 'system', text: 'a note' });
  addMessage(t, { from: 'matt', to: 'm1', text: 'new question' });
  const p = buildPrompt(t, 'm1', { since: seen.id });
  assert.ok(!p.includes('You are'), 'the session already has the header');
  assert.ok(!p.includes('old question') && !p.includes('old answer'));
  assert.match(p, /^New in this chat since your last reply:\nCodex: Codex chimed in\n\nMatt's message to you:\nnew question$/);
  addMessage(t, { from: 'matt', to: 'm1', text: 'and again' });
  assert.equal(buildPrompt(t, 'm1', { since: 999 }), "Matt's message to you:\nand again", 'nothing new: just the message');
});

test('an agent who left (TM-57) is out of the prompt, still a name in history, and can be @ named back', () => {
  const t = createThread(V1());
  t.members[2].left = true; // codex
  addMessage(t, { from: 'matt', to: 'claude', text: 'hi' });
  addMessage(t, { from: 'codex', text: 'I was here before' });
  addMessage(t, { from: 'matt', to: 'claude', text: 'and now?' });
  const p = buildPrompt(t, 'claude');
  assert.match(p, /one of 2 AI agents \(Claude and Gemini\)/);
  assert.match(p, /Codex: I was here before/);
  assert.equal(findMention('over to @Codex', 'claude', t.members), 'codex', 'a left agent is still reachable by name');
});

test('mergeThreads keeps who left', () => {
  const a = createThread(V1());
  a.members[1].left = true;
  const m = mergeThreads(a, createThread([]));
  assert.deepEqual(m.members.map(x => Boolean(x.left)), [false, true, false]);
});

const { findChatMentions, splitChatAsks } = require('../src/renderer/thread');

test('every #chat in a message is asked, in order, each once; several get their own part (TM-57)', () => {
  const chats = [{ id: 'a', title: 'Codex solo' }, { id: 'b', title: 'Codex solo 1' }, { id: 'c', title: 'Codex solo 2' }];
  assert.deepEqual(findChatMentions('#Codex solo 1 What is 2+2? #Codex solo 2 What is 3+3?', chats).map(f => f.chatId), ['b', 'c']);
  assert.deepEqual(splitChatAsks('#Codex solo 1 What is 2+2? #Codex solo 2 What is 3+3?', chats), [
    { chatId: 'b', question: '#Codex solo 1 What is 2+2?' },
    { chatId: 'c', question: '#Codex solo 2 What is 3+3?' }
  ]);
  assert.deepEqual(splitChatAsks('Checking. #Codex solo what is 9*9?', chats), [{ chatId: 'a', question: 'Checking. #Codex solo what is 9*9?' }], 'one ask keeps the whole text');
  assert.deepEqual(findChatMentions('#Codex solo hi, again #codex solo', chats).map(f => f.chatId), ['a'], 'once per chat');
  assert.deepEqual(splitChatAsks('nothing here', chats), []);
});

test('a follow-up with several answers lists them all, and leaves the asks out of history', () => {
  const t = createThread([{ id: 'm1', vendor: 'claude', model: null, name: 'Claude' }]);
  addMessage(t, { from: 'matt', to: 'm1', text: 'ask both' });
  addMessage(t, { from: 'm1', text: '#One q1 #Two q2' });
  addMessage(t, { from: 'system', text: 'asked One', side: { chatId: 'x', chatTitle: 'One', asker: 'm1', question: '#One q1', state: 'answered', answer: '4', hop: 1, group: 2, groupSize: 2 } });
  addMessage(t, { from: 'system', text: 'asked Two', side: { chatId: 'y', chatTitle: 'Two', asker: 'm1', question: '#Two q2', state: 'answered', answer: '6', hop: 1, group: 2, groupSize: 2 } });
  const p = buildPrompt(t, 'm1', { answer: [{ chatTitle: 'One', text: '4' }, { chatTitle: 'Two', text: '6' }] });
  assert.ok(p.endsWith("The chats you asked answered:\n\n'One': 4\n\n'Two': 6\n\nFinish your reply to Matt."), p);
  assert.ok(!p.includes('It answered: 4'), 'the answered asks are not repeated in history');
});

test('a reply keeps its steps (TM-59); notes and Matt never do', () => {
  const t = createThread(V1());
  addMessage(t, { from: 'matt', to: 'claude', text: 'go', steps: ['x'] });
  const r = addMessage(t, { from: 'claude', text: 'done', steps: Array.from({ length: 60 }, (_, i) => `step ${i}`) });
  assert.equal(r.steps.length, 50);
  assert.equal(r.steps[49], 'step 59', 'the newest are kept');
  assert.equal(t.messages[0].steps, undefined);
  assert.equal(addMessage(t, { from: 'claude', text: 'no tools', steps: [] }).steps, undefined);
});

test('a crew gets 6 handoffs in a row before Matt, other chats 3 (TM-59)', () => {
  const { hopLimit } = require('../src/renderer/thread');
  const { newMember: nm, CREW } = require('../src/renderer/members');
  const crew = [];
  for (const c of CREW) crew.push(nm(crew, c));
  assert.equal(hopLimit(createThread(crew)), 6);
  assert.equal(hopLimit(createThread(V1())), 3);
  assert.equal(hopLimit(createThread(crew.map(m => ({ ...m, left: true })))), 3, 'only agents still in the chat count');
});
