const test = require('node:test');
const assert = require('node:assert/strict');
const { createThread, addMessage, buildPrompt, findThreadSignal, findTargets } = require('../src/renderer/thread');
const { newMember } = require('../src/renderer/members');

function claudeAndSonnet() {
  const members = [newMember([], { vendor: 'claude' })];
  members.push(newMember(members, { vendor: 'claude', model: 'sonnet' }, { modelLabel: 'Sonnet' }));
  return createThread(members);
}

test('findThreadSignal: thread @Name alone on a line starts a thread', () => {
  const t = claudeAndSonnet();
  assert.deepEqual(findThreadSignal('let us split this off\nthread @Sonnet', 'm1', t.members), { memberId: 'm2' });
  assert.equal(findThreadSignal('thread @Claude', 'm1', t.members), null, 'not yourself');
  assert.equal(findThreadSignal('we could thread @Sonnet here', 'm1', t.members), null, 'not prose');
  assert.equal(findThreadSignal('```\nthread @Sonnet\n```', 'm1', t.members), null, 'not fenced code');
  assert.equal(findThreadSignal('thread @Nobody', 'm1', t.members), null);
});

test('@all: every member can be prompted from one Matt message', () => {
  const t = claudeAndSonnet();
  addMessage(t, { from: 'matt', to: 'm1', text: '@all what is your take?' });
  assert.match(buildPrompt(t, 'm1'), /what is your take/);
  assert.match(buildPrompt(t, 'm2'), /what is your take/);
});

test('findTargets: every agent named in a Matt message, in order', () => {
  const t = claudeAndSonnet();
  assert.deepEqual(findTargets('@Sonnet and @Claude, thoughts?', null, t.members), [{ memberId: 'm2' }, { memberId: 'm1' }]);
  assert.deepEqual(findTargets('no mentions here', null, t.members), []);
  assert.deepEqual(findTargets('@Claude only', 'm1', t.members), [], 'self never a target');
});

test('@thread: a second named agent can be prompted inside the thread', () => {
  const t = claudeAndSonnet();
  const root = addMessage(t, { from: 'matt', to: 'm1', text: '@Claude and @Sonnet, @thread evaluate this' });
  assert.match(buildPrompt(t, 'm2', { threadOf: root.id }), /evaluate this/);
});

test('without @all, a Matt message prompts only its addressee', () => {
  const t = claudeAndSonnet();
  addMessage(t, { from: 'matt', to: 'm1', text: 'just you' });
  assert.throws(() => buildPrompt(t, 'm2'), /not from Matt/);
});
