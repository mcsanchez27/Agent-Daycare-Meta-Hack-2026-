const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chats = require('../src/chats');

function tmpDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-chats-')), 'chats');
}

const sample = (id, updatedAt, title = 'Hi there') => ({
  id, title, createdAt: updatedAt, updatedAt,
  thread: { messages: [{ id: 1, from: 'matt', to: 'claude', text: 'hi', ts: updatedAt }], nextId: 2 }
});

test('a missing chats folder means no chats yet', async () => {
  assert.deepEqual(await chats.list(tmpDir()), { chats: [], problems: [] });
});

test('save then load round-trips a chat, creating the folder', async () => {
  const dir = tmpDir();
  const c = sample('abc-1', '2026-10-21T10:00:00.000Z');
  await chats.save(dir, c);
  assert.deepEqual(await chats.load(dir, 'abc-1'), c);
  assert.ok(!fs.existsSync(path.join(dir, 'abc-1.json.tmp')), 'no temp file left behind');
});

test('list is newest first and skips unreadable files, reporting them', async () => {
  const dir = tmpDir();
  await chats.save(dir, sample('old', '2026-10-20T10:00:00.000Z', 'Old one'));
  await chats.save(dir, sample('new', '2026-10-21T10:00:00.000Z', 'New one'));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const r = await chats.list(dir);
  assert.deepEqual(r.chats.map(c => c.title), ['New one', 'Old one']);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].file, 'broken.json');
});

test('chat ids that could escape the folder are refused', async () => {
  const dir = tmpDir();
  for (const bad of ['../x', '..\\x', 'a/b', 'A', '', 'x'.repeat(65), null]) {
    await assert.rejects(chats.save(dir, sample(bad, '2026-10-21T10:00:00.000Z')), /Bad chat id/, String(bad));
    await assert.rejects(chats.load(dir, bad), /Bad chat id/, String(bad));
  }
});

test('missing fields are filled in so an odd file still opens', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bare.json'), JSON.stringify({ thread: { messages: [{ id: 1, from: 'system', text: 'x' }] } }));
  const c = await chats.load(dir, 'bare');
  assert.equal(c.id, 'bare');
  assert.equal(c.title, 'New chat');
  assert.equal(c.thread.nextId, 2);
});

test('a renamed chat keeps its title and the flag; members are kept', async () => {
  const dir = tmpDir();
  const members = [{ id: 'm1', vendor: 'claude', model: 'opus', name: 'Claude' }];
  await chats.save(dir, { ...sample('ren-1', '2026-10-22T10:00:00.000Z', 'Mine'), titleSet: true, thread: { messages: [], nextId: 1, members } });
  const c = await chats.load(dir, 'ren-1');
  assert.equal(c.title, 'Mine');
  assert.equal(c.titleSet, true);
  assert.deepEqual(c.thread.members, members);
  await chats.save(dir, sample('ren-2', '2026-10-22T10:00:00.000Z'));
  assert.ok(!(await chats.load(dir, 'ren-2')).titleSet, 'not renamed unless saved as renamed');
});
