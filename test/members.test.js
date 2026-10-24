const test = require('node:test');
const assert = require('node:assert/strict');
const { newMember, ensureMembers, renameRetired, memberById, VENDORS, ROLES, CREW } = require('../src/renderer/members');
const { createThread, addMessage, buildPrompt } = require('../src/renderer/thread');

test('newMember names: vendor, then model, then number', () => {
  const members = [];
  members.push(newMember(members, { vendor: 'claude', model: 'sonnet' }, { modelLabel: 'Sonnet' }));
  members.push(newMember(members, { vendor: 'claude', model: 'opus' }, { modelLabel: 'Opus' }));
  members.push(newMember(members, { vendor: 'claude' }));
  members.push(newMember(members, { vendor: 'claude', model: 'sonnet' }, { modelLabel: 'Sonnet' }));
  members.push(newMember(members, { vendor: 'claude', model: 'sonnet' }, { modelLabel: 'Sonnet' }));
  assert.deepEqual(members.map(m => m.name), ['Claude', 'Opus', 'Claude 2', 'Sonnet', 'Claude 3']);
  assert.deepEqual(members.map(m => m.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(members[2].model, null);
  assert.throws(() => newMember(members, { vendor: 'deepseek' }), /Unknown vendor/);
});

test('a renamed vendor gives new members its name; memory is kept', () => {
  const m = newMember([], { vendor: 'codex', memory: 'old chat' }, { vendorNames: { codex: 'Beast' } });
  assert.equal(m.name, 'Beast');
  assert.equal(m.memory, 'old chat');
});

test('moved-over chats keep their senders', () => {
  const t = { messages: [], nextId: 1 };
  t.messages.push({ id: 1, from: 'matt', to: 'codex', text: 'hi', ts: 'x' });
  t.messages.push({ id: 2, from: 'codex', text: 'Step 1', ts: 'x' });
  t.messages.push({ id: 3, from: 'matt', to: 'claude', text: 'Step 1', relayOf: 'codex', ts: 'x' });
  t.nextId = 4;
  ensureMembers(t);
  assert.deepEqual(t.members, [
    { id: 'codex', vendor: 'codex', model: null, name: 'Codex' },
    { id: 'claude', vendor: 'claude', model: null, name: 'Claude' }
  ]);
  assert.equal(memberById(t, 'claude').name, 'Claude');
  const p = buildPrompt(t, 'claude');
  assert.ok(p.endsWith('Matt passed you this reply from Codex. Respond to it:\nStep 1'));
  addMessage(t, { from: 'claude', text: 'done' });
  assert.equal(ensureMembers(t).members.length, 2, 'only moves a chat over once');
});

test('an empty old chat gets Claude as its agent', () => {
  assert.deepEqual(ensureMembers({ messages: [], nextId: 1 }).members.map(m => m.id), ['claude']);
});

test('one-on-one header names the vendor and model', () => {
  const t = createThread([newMember([], { vendor: 'claude', model: 'opus' })]);
  addMessage(t, { from: 'matt', to: 'm1', text: 'hi' });
  const p = buildPrompt(t, 'm1');
  assert.ok(p.startsWith('You are Claude (claude, model opus), chatting one-on-one with Matt.'), p);
  assert.match(p, /@Gemini, @Claude, @Codex or @Grok/);
});

test('group header lists the members', () => {
  const members = [newMember([], { vendor: 'claude' })];
  members.push(newMember(members, { vendor: 'claude', model: 'haiku' }, { modelLabel: 'Haiku' }));
  const t = createThread(members);
  addMessage(t, { from: 'matt', to: 'm2', text: 'hi' });
  const p = buildPrompt(t, 'm2');
  assert.match(p, /^You are Haiku \(claude, model haiku\)/);
  assert.match(p, /Claude and Haiku/);
  assert.ok(!p.includes('one-on-one'));
  assert.deepEqual(VENDORS, ['antigravity', 'claude', 'codex', 'grok']);
});

test('saved members named Antigravity become Gemini (TM-57), unless the name is taken', () => {
  const t = { members: [
    { id: 'm1', vendor: 'antigravity', name: 'Antigravity' },
    { id: 'm2', vendor: 'antigravity', name: 'Antigravity 2' },
    { id: 'm3', vendor: 'antigravity', name: 'Scout' },
    { id: 'm4', vendor: 'claude', name: 'Antigravity' }
  ] };
  assert.deepEqual(renameRetired(t).members.map(m => m.name), ['Gemini', 'Gemini 2', 'Scout', 'Antigravity']);
  const clash = { members: [{ id: 'm1', vendor: 'claude', name: 'Gemini' }, { id: 'm2', vendor: 'antigravity', name: 'Antigravity' }] };
  assert.deepEqual(renameRetired(clash).members.map(m => m.name), ['Gemini', 'Antigravity']);
});

test('a crew (TM-59): Codex designs, Gemini does UI/UX, Claude engineers; each prompt carries its role', () => {
  const members = [];
  for (const c of CREW) members.push(newMember(members, c));
  assert.deepEqual(members.map(m => [m.id, m.name, m.role]), [['m1', 'Codex', 'design'], ['m2', 'Gemini', 'uiux'], ['m3', 'Claude', 'engineering']]);
  const t = createThread(members);
  addMessage(t, { from: 'matt', to: 'm2', text: 'design the screen' });
  const p = buildPrompt(t, 'm2');
  assert.match(p, /one of 3 AI agents \(Codex \(Design\), Gemini \(UI\/UX\) and Claude \(Engineering\)\)/);
  assert.ok(p.includes(`Your role: UI/UX. ${ROLES.uiux.brief}`), p);
  assert.match(ROLES.uiux.brief, /Stitch/);
  assert.equal(newMember([], { vendor: 'claude', role: 'nonsense' }).role, undefined, 'unknown roles are dropped');
});
