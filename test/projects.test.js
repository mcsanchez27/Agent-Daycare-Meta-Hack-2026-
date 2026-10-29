const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const projects = require('../src/projects');
const { rosterFrom, seedMembers, projectOf, scopedChats, projectGroups } = require('../src/renderer/projects');
const teammates = [{ id: 'engineer', name: 'Engineer', vendor: 'claude', brainFile: 'engineer.md', customInstructions: 'Check tests', skills: ['audit.md'], mcp: ['docs'], model: 'sonnet' }];

test('crew and teammate rosters retain identity/config but seed independent members without sessions', () => {
  assert.deepEqual(rosterFrom({ kind: 'crew' }, []).map(m => m.role), ['design', 'uiux', 'engineering']);
  const roster = rosterFrom({ kind: 'teammates', ids: ['engineer'] }, teammates);
  const first = seedMembers(roster), second = seedMembers(roster);
  first[0].sessions = { main: { id: 'secret-session' } };
  first[0].skills.push('extra.md');
  assert.equal(second[0].sessions, undefined);
  assert.deepEqual(second[0].skills, ['audit.md']);
  assert.equal(second[0].brain, 'engineer.md');
  assert.equal(second[0].persona, 'engineer');
  assert.equal(second[0].customInstructions, 'Check tests');
  assert.equal(second[0].model, 'sonnet');
  for (const choice of [{ kind: 'teammates', ids: [] }, { kind: 'teammates', ids: ['missing'] }, { kind: 'raw', members: teammates }]) assert.throws(() => rosterFrom(choice, teammates));
});

test('project groups and ask scope treat missing/deleted projects as Unfiled', () => {
  const list = [{ id: 'p1', name: 'Fight Bot' }, { id: 'p2', name: 'Other' }];
  const chats = [{ id: 'one', projectId: 'p1' }, { id: 'two', projectId: 'p1' }, { id: 'three', projectId: 'p2' }, { id: 'old', projectId: 'deleted' }, { id: 'loose' }];
  assert.equal(projectOf(chats[0], list).name, 'Fight Bot');
  assert.equal(projectOf(chats[3], list), null);
  assert.deepEqual(scopedChats(chats[0], chats, list).map(c => c.id), ['two']);
  assert.deepEqual(scopedChats(chats[3], chats, list).map(c => c.id), ['loose']);
  assert.deepEqual(projectGroups(chats, list).at(-1).chats.map(c => c.id), ['old', 'loose']);
  assert.equal(projectGroups(chats, list)[0].chats.length, 2);
});

test('queued project CRUD preserves concurrent creates, enforces trimmed unique names and updates only roster snapshots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-projects-'));
  const file = path.join(dir, 'projects.json');
  try {
    assert.deepEqual(await projects.list(file), []);
    const members = rosterFrom({ kind: 'crew' }, []);
    const [one, two] = await Promise.all([projects.create(file, { name: '  Fight Bot  ', members }), projects.create(file, { name: 'Other', members })]);
    assert.equal(one.name, 'Fight Bot');
    assert.equal((await projects.list(file)).length, 2);
    await assert.rejects(projects.create(file, { name: 'fight bot', members }), /already/);
    await assert.rejects(projects.create(file, { name: ' ', members }), /name/i);
    await assert.rejects(projects.create(file, { name: 'Empty', members: [] }), /roster/i);
    const existingChat = { members: seedMembers(one.members) };
    await projects.update(file, { id: one.id, name: 'Renamed', members: rosterFrom({ kind: 'teammates', ids: ['engineer'] }, teammates) });
    assert.equal(existingChat.members.length, 3);
    assert.equal(seedMembers((await projects.list(file)).find(p => p.id === one.id).members).length, 1);
    await projects.remove(file, { id: one.id });
    assert.deepEqual((await projects.list(file)).map(p => p.id), [two.id]);
    fs.writeFileSync(file, '{broken');
    await assert.rejects(projects.create(file, { name: 'Do not overwrite', members }));
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deleting a project preserves saved chat bytes and sessions and groups them Unfiled after restart', async () => {
  const chatFiles = require('../src/chats');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-unfile-'));
  const file = path.join(dir, 'projects.json');
  const chatDir = path.join(dir, 'chats');
  try {
    const project = await projects.create(file, { name: 'Fight Bot', members: rosterFrom({ kind: 'crew' }, []) });
    const members = seedMembers(project.members);
    members[0].sessions = { main: { id: 'existing-session' } };
    await chatFiles.save(chatDir, { id: 'one', projectId: project.id, thread: { members, messages: [] } });
    const before = fs.readFileSync(path.join(chatDir, 'one.json'), 'utf8');
    await projects.remove(file, { id: project.id });
    assert.equal(fs.readFileSync(path.join(chatDir, 'one.json'), 'utf8'), before);
    const chat = await chatFiles.load(chatDir, 'one');
    const catalog = await projects.list(file);
    assert.equal(projectOf(chat, catalog), null);
    assert.equal(projectGroups([chat], catalog).at(-1).chats[0].id, 'one');
    assert.equal(chat.thread.members[0].sessions.main.id, 'existing-session');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
