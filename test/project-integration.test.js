const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const chatFiles = require('../src/chats');
const thread = require('../src/renderer/thread');
const members = require('../src/renderer/members');
const helpers = require('../src/renderer/projects');
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
function extract(start, end) { return app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))); }

test('chat projectId survives save, load and sidebar listing; malformed IDs are dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-chats-'));
  try {
    await chatFiles.save(dir, { id: 'one', projectId: 'project-one', thread: {} });
    assert.equal((await chatFiles.load(dir, 'one')).projectId, 'project-one');
    assert.equal((await chatFiles.list(dir)).chats[0].projectId, 'project-one');
    await chatFiles.save(dir, { id: 'one', projectId: '../bad', thread: {} });
    assert.equal((await chatFiles.load(dir, 'one')).projectId, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('project prompts identify the container in new and resumed sessions', () => {
  const m = members.newMember([], { vendor: 'codex' });
  const t = thread.createThread([m]);
  thread.addMessage(t, { from: 'matt', to: m.id, text: 'Help' });
  for (const since of [null, 0]) assert.match(thread.buildPrompt(t, m.id, { projectName: 'Fight Bot', since }), /Project: Fight Bot/);
  assert.ok(!thread.buildPrompt(t, m.id).includes('Project:'));
});

test('app persistence forwards projectId and otherChats enforces project scope', async () => {
  let saved;
  const persist = vm.runInNewContext(extract('async function persist(chat)', '\nfunction renderChatList') + '; persist', { api: { saveChat: async c => { saved = c; }, log() {} } });
  await persist({ id: 'one', projectId: 'p1', thread: {} });
  assert.equal(saved.projectId, 'p1');
  const chats = new Map([['one', { id: 'one', title: 'Design', projectId: 'p1' }], ['two', { id: 'two', title: 'Engineering', projectId: 'p1' }], ['other', { id: 'other', title: 'Other', projectId: 'p2' }]]);
  const otherChats = vm.runInNewContext(extract('function otherChats(chatId)', '\nconst SIDE_STATES') + '; otherChats', { chats, projectCatalogError: null, projectList: [{ id: 'p1' }, { id: 'p2' }], ...helpers });
  assert.deepEqual(JSON.parse(JSON.stringify(otherChats('one'))), [{ id: 'two', title: 'Engineering' }]);
});

test('project + chat uses the latest roster and preserves existing agent sessions', () => {
  const chats = new Map();
  const projectList = [{ id: 'p1', name: 'Fight Bot', members: helpers.rosterFrom({ kind: 'crew' }, []) }];
  let saved;
  let nextId = 0;
  const context = { chats, projectList, ...helpers, ...thread, newChatId: () => `chat-${++nextId}`, hideChooser() {}, showChat() {}, renderChatList() {}, persist: c => { saved = c; }, collapsedProjects: new Set() };
  const create = vm.runInNewContext(extract('function createProjectChat(projectId', '\nasync function renderProjectForm') + '; createProjectChat', context);
  create('p1');
  assert.equal(saved.projectId, 'p1');
  assert.equal(saved.thread.members.length, 3);
  const first = saved;
  first.thread.members[0].sessions = { main: { id: 'keep' } };
  projectList[0].members = [projectList[0].members[2]];
  create('p1');
  assert.equal(saved.thread.members.length, 1);
  assert.equal(saved.thread.members[0].sessions, undefined);
  assert.equal(first.thread.members[0].sessions.main.id, 'keep');
});

test('dispatch refuses a cross-project ask before loading or launching the target', async () => {
  // Extract through the next top-level function, independent of line endings.
  const start = app.indexOf('async function askChat(');
  const end = app.indexOf('\nfunction ', start + 1);
  const chats = new Map([['a', { id: 'a', projectId: 'p1' }], ['b', { id: 'b', projectId: 'p2' }]]);
  let loaded = false, launched = false;
  const ask = vm.runInNewContext(app.slice(start, end) + '\n; askChat', { chats, otherChats: () => [], post() {}, loadChat: () => { loaded = true; }, ask: () => { launched = true; } });
  await ask({ fromChatId: 'a', targetId: 'b', asker: 'matt', hop: 0, text: 'secret' });
  assert.equal(loaded, false);
  assert.equal(launched, false);
});

test('starting an Unfiled chat does not discard an empty saved project chat', () => {
  const chat = { id: 'empty', projectId: 'p1', thread: { messages: [] } };
  const chats = new Map([['empty', chat]]);
  const start = vm.runInNewContext(extract('function startNewChat()', '\nfunction createChat') + '; startNewChat', { current: () => chat, chats, closeOrgControl() {}, showChooser() {} });
  start();
  assert.equal(chats.has('empty'), true);
});

test('a catalog read failure leaves existing chats usable and disables project-scoped asks', async () => {
  let loadedChats = false, opened = null;
  const saved = [{ id: 'existing', title: 'Old chat', projectId: 'p1' }];
  const chats = new Map();
  const context = {
    chats, vendors: {}, plans: {}, localStorage: { getItem: () => null }, renderPlan() {},
    el: { chooser: { hidden: true, dataset: {} }, folder: {} }, workingDir: null, projectList: [], projectCatalogError: null,
    openChat: id => { opened = id; }, showChooser() {},
    api: { getAgentConfigs: async () => [], listModels: async () => ({}), getConfig: async () => ({ config: {} }),
      listProjects: async () => { throw new Error('Invalid JSON'); }, listChats: async () => { loadedChats = true; return { chats: saved }; }, log() {} }
  };
  const initStart = app.indexOf('async function init()');
  const initEnd = app.indexOf('\ninit();', initStart);
  const init = vm.runInNewContext(app.slice(initStart, initEnd) + '\n; init', context);
  await init();
  assert.equal(loadedChats, true);
  assert.equal(opened, 'existing');
  assert.match(context.projectCatalogError, /Invalid JSON/);
  const otherChats = vm.runInNewContext(extract('function otherChats(chatId)', '\nconst SIDE_STATES') + '\n; otherChats', { chats, projectList: [], projectCatalogError: 'Invalid JSON', ...helpers });
  assert.equal(otherChats('existing').length, 0);
});

test('ask scope is rechecked after the target chat finishes loading', async () => {
  const chats = new Map([['a', { id: 'a', title: 'Design', projectId: 'p1' }], ['b', { id: 'b', title: 'Engineering', projectId: 'p1' }]]);
  const source = extract('async function askChat(', '\nfunction settleSide');
  let posts = 0;
  const ask = vm.runInNewContext(source + '\n; askChat', {
    chats, otherChats: id => helpers.scopedChats(chats.get(id), [...chats.values()], [{ id: 'p1' }, { id: 'p2' }]),
    loadChat: async dst => { dst.projectId = 'p2'; }, HOP_LIMIT: 3,
    post: () => { posts++; return { id: 1 }; }, api: { log() {} }
  });
  await ask({ fromChatId: 'a', targetId: 'b', asker: 'matt', hop: 0, text: 'secret' });
  assert.ok(posts <= 1);
});

test('deleting a container gives resumed agents explicit Unfiled context', () => {
  const chat = { id: 'one', projectId: 'p1' };
  const list = [{ id: 'p1', name: 'Fight Bot' }];
  const projectNameFor = vm.runInNewContext(extract('function projectNameFor(chatId)', '\nfunction otherChats') + '; projectNameFor', { chats: new Map([['one', chat]]), projectList: list, projectCatalogError: null, ...helpers });
  assert.equal(projectNameFor('one'), 'Fight Bot');
  list.length = 0;
  const member = members.newMember([], { vendor: 'claude' });
  const t = thread.createThread([member]);
  thread.addMessage(t, { from: 'matt', to: member.id, text: 'Continue' });
  assert.match(thread.buildPrompt(t, member.id, { since: 0, projectName: projectNameFor('one') }), /Project: Unfiled/);
});