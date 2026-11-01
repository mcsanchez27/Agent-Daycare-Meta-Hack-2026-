const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.isConnected = true; this.value = ''; }
  append(...items) { items.forEach(item => this.appendChild(item)); }
  appendChild(item) { this.children.push(item); if (this.tag === 'select' && !this.value) this.value = item.value; return item; }
  setAttribute() {}
  focus() {}
  addEventListener(event, fn) { this.listeners[event] = fn; }
  async fire(event) { return this.listeners[event]?.({ preventDefault() {} }); }
}
function fixture(project = null, getOrg = async () => ({})) {
  const calls = [];
  const card = new Element('div');
  const list = project ? [project] : [];
  const api = { getOrg,
    createProject: async req => { calls.push(['create', req]); return { id: 'created' }; },
    updateProject: async req => { calls.push(['update', req]); return project; },
    removeProject: async id => { calls.push(['remove', id]); },
    listProjects: async () => list
  };
  const start = app.indexOf('async function renderProjectForm');
  const end = app.indexOf('// Adds an agent to a chat', start);
  const chooser = { hidden: false, contains: () => true };
  const render = vm.runInNewContext(app.slice(start, end) + '\n; renderProjectForm', {
    el: { chooser }, projectList: list, document: { createElement: tag => new Element(tag) }, api,
    teammates: () => [{ id: 'engineer', name: 'Engineer', vendor: 'claude' }], vendorName: v => v,
    current: () => null, createProjectChat: (id, options) => calls.push(['chat', id, options]), renderChatList() {}, hideChooser() {}, showChooser() {}
  });
  const promise = render(card, project?.id || null);
  const form = card.children[0];
  return { card, form, calls, api, promise, chooser, name: form.children[0].children[0], choice: form.children[1].children[0] };
}

test('project form handles submission while teammate loading is pending', async () => {
  const f = fixture(null, () => new Promise(() => {}));
  assert.equal(typeof f.form.listeners.submit, 'function');
  f.name.value = 'Fight Bot';
  await f.form.fire('submit');
  assert.equal(f.calls[0][0], 'create');
  assert.equal(f.calls[0][1].selection.kind, 'crew');
  assert.equal(f.calls.at(-1)[0], 'chat');
  assert.equal(f.calls.at(-1)[1], 'created');
});

test('rename keeps roster unless explicitly replaced; delete requires a second click', async () => {
  const project = { id: 'p1', name: 'Fight Bot', members: [{ name: 'Codex', vendor: 'codex' }] };
  const f = fixture(project);
  await f.promise;
  f.name.value = 'Renamed';
  await f.form.fire('submit');
  assert.equal(f.calls[0][0], 'update');
  assert.equal(f.calls[0][1].selection, undefined);
  const d = fixture(project);
  await d.promise;
  const remove = d.form.children.at(-1);
  await remove.fire('click');
  assert.equal(d.calls.length, 0);
  await remove.fire('click');
  assert.deepEqual(d.calls[0], ['remove', 'p1']);
});

test('project save errors stay visible and permit retry', async () => {
  const f = fixture();
  await f.promise;
  f.api.createProject = async () => { throw new Error('A project with that name already exists'); };
  await f.form.fire('submit');
  assert.match(f.form.children[4].textContent, /already exists/);
  assert.equal(f.form.children[5].disabled, false);
});


test('finishing project creation after Cancel saves the first chat without taking focus', async () => {
  const f = fixture();
  await f.promise;
  let finish;
  f.api.createProject = () => new Promise(resolve => { finish = resolve; });
  const saving = f.form.fire('submit');
  f.chooser.hidden = true; // hideChooser keeps its card connected in the real app.
  finish({ id: 'created' });
  await saving;
  const chat = f.calls.find(c => c[0] === 'chat');
  assert.equal(chat[1], 'created');
  assert.equal(chat[2].open, false);
});