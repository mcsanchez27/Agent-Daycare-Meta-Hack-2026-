const test = require('node:test');
const assert = require('node:assert/strict');
const { createThread, findKick } = require('../src/renderer/thread');
const { newMember } = require('../src/renderer/members');

function claudeAndSonnet() {
  const members = [newMember([], { vendor: 'claude' })];
  members.push(newMember(members, { vendor: 'claude', model: 'sonnet' }, { modelLabel: 'Sonnet' }));
  return createThread(members);
}

test('findKick: kick @Name alone on a line removes that member only', () => {
  const t = claudeAndSonnet();
  assert.deepEqual(findKick('this is derailing\nkick @Sonnet', 'm1', t.members), { memberId: 'm2' });
  assert.equal(findKick('kick @Claude', 'm1', t.members), null, 'not yourself');
  assert.equal(findKick('we should kick @Sonnet out', 'm1', t.members), null, 'not prose');
  assert.equal(findKick('kick @Nobody', 'm1', t.members), null);
});

test('findKick: a kick line inside a fenced code block is an example, not an order', () => {
  const t = claudeAndSonnet();
  assert.equal(findKick('for example:\n```\nkick @Sonnet\n```', 'm1', t.members), null);
  assert.deepEqual(findKick('```\nsome code\n```\nkick @Sonnet', 'm1', t.members), { memberId: 'm2' });
});

test('findKick: a member who already left cannot be kicked again', () => {
  const t = claudeAndSonnet();
  t.members[1].left = true;
  assert.equal(findKick('kick @Sonnet', 'm1', t.members), null);
});
