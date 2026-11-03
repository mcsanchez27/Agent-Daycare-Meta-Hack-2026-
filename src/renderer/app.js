// Chat window behaviour: the chat list, the main chat and a thread panel
// beside it, each with its own message box. Messages are drawn with
// textContent only, never innerHTML, so nothing an agent prints can run as
// code in this window.
// Sending launches an agent with the recent thread in the prompt and streams
// its reply into a bubble. A reply can be stopped while it streams.
// Chats are saved one file each (TM-53 Batch 2). A reply always lands in the
// chat it was asked in, even if Matt has switched to another one meanwhile.
// Threads: the main chat shows a live summary row under a thread's first
// message; the thread itself opens in the panel (TM-54 Batch 4).
// Members (TM-54): each chat has its own agents (thread.members), picked by
// vendor and model when the chat starts. Each member's reply is one run, named
// `<chatId>/<memberId>`, so two Claudes can answer at once. @Name decides who
// answers; @ a vendor that isn't in the chat and it joins on its default
// model. Agents bring each other in the same way.

// `api` is the global the preload bridge exposes (window.api); declaring it
// again here is a SyntaxError that stops this whole file from running.
const { createThread, addMessage, buildPrompt, promptGuidance, chatTitle, findTarget, splitChatAsks, routeMessage, memorySnapshot, mergeThreads, hopsSinceMatt, hopLimit, HOP_LIMIT, joinIntent } = window.ChatThread;
const { VENDORS, ROLES, CREW, SPARK_CREW, PERSONAS, newMember, ensureMembers, renameRetired, memberById } = window.ChatMembers;
const { folderFile, personaIdOf, teammates, teammateId, skillsFor, folderText, describeAssignment, textSig, mcpFor, claudeMcpConfig, parseCommandLine } = window.ChatOrg;

const { seedMembers, projectOf, scopedChats, projectGroups } = window.ChatProjects;
let projectList = [];
let projectCatalogError = null;
const collapsedProjects = new Set();

// Same rule as the runner's MODEL_TEXT: a typed model goes on a command line.
const MODEL_TEXT = /^[A-Za-z0-9_.:-]{1,64}$/;

const vendors = {}; // vendor -> { id, name, color } from config.json
let models = null; // vendor -> [{ id, label }], from api.listModels()
const chats = new Map(); // id -> { id, title, createdAt, updatedAt, thread? } (thread once loaded)
let currentId = null;
let workingDir = null; // from config.json; each chat works in <workingDir>\<chat id> (TM-59)
// runKey -> the reply being streamed: { chatId, memberId, threadOf, text, stderr, started }.
// One per member: each member runs one process at a time.
const pending = {};
const pendingRows = {}; // runKey -> { row, meta, bubble, view } while on screen
const summaryRows = {}; // thread's first message id -> its summary row in the main chat
const plans = {}; // vendor -> its latest plan usage (Claude reports it: 5-hour and 7-day)
const gitInfoCache = {}; // chatId -> { repo, branch } | null (Workspace row)

const $ = (id) => document.getElementById(id);
const el = {
  chat: document.querySelector('.chat'),
  chatList: $('chat-list'),
  newChat: $('new-chat'),
  folder: $('folder'),
  members: $('members'),
  addAgent: $('add-agent'),
  chooser: $('chooser'),
  panel: $('thread-panel'),
  panelLabel: $('panel-label'),
  panelClose: $('panel-close'),
  plan: $('plan'),
  sidecar: $('sidecar'),
  sidecarContent: $('sidecar-content'),
  chatHeaderTitle: $('chat-header-title'),
  sidecarFolder: $('sidecar-folder'),
  sidecarGit: $('sidecar-git'),
  workspaceGitRow: $('workspace-git-row'),
  sidecarModels: $('sidecar-models'),
  contextGaugeLabel: $('context-gauge-label'),
  contextGaugeVal: $('context-gauge-val'),
  contextBar: $('context-bar'),
  sidecarPlanWrap: $('sidecar-plan-wrap'),
  tabSession: $('tab-session'),
  tabPreview: $('tab-preview'),
  tabToolbelt: $('tab-toolbelt'),
  sidecarExpandBtn: $('sidecar-expand-btn'),
  sidecarPreview: $('sidecar-preview'),
  sidecarToolbelt: $('sidecar-toolbelt'),
  toolbeltList: $('toolbelt-list'),
  previewTitle: $('preview-title'),
  previewReload: $('preview-reload'),
  previewExternal: $('preview-external'),
  previewEmpty: $('preview-empty'),
  previewIframe: $('preview-iframe'),
  notionGlance: $('notion-glance'),
  notionTitle: $('notion-title'),
  notionStatus: $('notion-status'),
  notionPriority: $('notion-priority'),
  notionAssignee: $('notion-assignee'),
  notionDesc: $('notion-desc'),
  notionTasks: $('notion-tasks'),
  notionLink: $('notion-link'),
  navOrgBtn: $('nav-org-btn'),
  orgControl: $('org-control'),
  orgCloseBtn: $('org-close-btn'),
  orgBody: $('org-body'),
  orgTabMemory: $('org-tab-memory'),
  orgTabPersonas: $('org-tab-personas'),
  orgTabMcps: $('org-tab-mcps'),
  orgTabSkills: $('org-tab-skills'),
  orgTabBuilder: $('org-tab-builder')
};

// The two places messages show: the main chat, and the thread panel beside
// it. Each has its own list, message box and @ dropdown. threadOf is null for
// the main chat, and the open thread's first message id for the panel (null
// while the panel is closed).
function makeView(name, ids) {
  return {
    name, threadOf: null,
    list: $(ids.list), empty: ids.empty ? $(ids.empty) : null,
    form: $(ids.form), input: $(ids.input), send: $(ids.send), mentions: $(ids.mentions),
    mention: { items: [], index: 0 }
  };
}
const main = makeView('main', { list: 'thread', empty: 'empty', form: 'composer', input: 'message', send: 'send', mentions: 'mentions' });
const panel = makeView('panel', { list: 'panel-thread', form: 'panel-composer', input: 'panel-message', send: 'panel-send', mentions: 'panel-mentions' });

function panelOpen() {
  return panel.threadOf !== null;
}

function openViews() {
  return panelOpen() ? [main, panel] : [main];
}

window.addEventListener('error', (e) => api.log('error', e.message, { file: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => api.log('error', String(e.reason && e.reason.message || e.reason)));

function runKeyOf(chatId, memberId) {
  return `${chatId}/${memberId}`;
}

// A member's name in a chat (the open one if none is given).
function nameOf(id, chat = current()) {
  const m = chat && chat.thread ? memberById(chat.thread, id) : null;
  return m ? m.name : id;
}

function colorOf(id) {
  const m = current() ? memberById(current().thread, id) : null;
  return m && vendors[m.vendor] ? vendors[m.vendor].color : '#888';
}

function vendorName(v) {
  return vendors[v] ? vendors[v].name : v;
}

function vendorNames() {
  return Object.fromEntries(VENDORS.map(v => [v, vendorName(v)]));
}

function modelText(m) {
  return m.model || 'default model';
}

// A model's display label ("Sonnet" for sonnet), for naming a member.
function modelLabelOf(vendor, model) {
  if (!model) return null;
  const known = models && (models[vendor] || []).find(x => x.id === model);
  return known ? known.label : model;
}

function durationLabel(sec) {
  return sec % 60 === 0 ? `${sec / 60} minute${sec === 60 ? '' : 's'}` : `${sec} seconds`;
}

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? timeLabel(iso) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function current() {
  return chats.get(currentId);
}

function newest() {
  return [...chats.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

// ---- Chats ------------------------------------------------------------------

function newChatId() {
  return crypto.randomUUID();
}

// A new chat starts by picking its agent: vendor, then model (TM-54). It is
// only saved once something is said in it, so empty chats don't pile up.
function startNewChat() {
  closeOrgControl();
  const c = current();
  if (c && c.thread && c.thread.messages.length === 0 && !c.projectId) chats.delete(c.id);
  showChooser('new');
}

function createChat(vendor, model, modelLabel) {
  const now = new Date().toISOString();
  const member = newMember([], { vendor, model }, { vendorNames: vendorNames(), modelLabel });
  const chat = { id: newChatId(), title: 'New chat', createdAt: now, updatedAt: now, thread: createThread([member]) };
  chats.set(chat.id, chat);
  hideChooser();
  showChat(chat.id);
}

// "New crew" (TM-59): Codex designs, Gemini does UI/UX, Claude engineers,
// each on its default model, in one chat with its own folder.
function createCrew(spec = CREW) {
  const now = new Date().toISOString();
  const members = [];
  for (const c of spec) members.push(newMember(members, c, { vendorNames: vendorNames() }));
  const chat = { id: newChatId(), title: 'New chat', createdAt: now, updatedAt: now, thread: createThread(members) };
  chats.set(chat.id, chat);
  hideChooser();
  showChat(chat.id);
  api.log('info', 'crew created', { chatId: chat.id, members: members.map(m => `${m.vendor}:${m.role}`) });
}

function createCustomChat(memberOpts) {
  const now = new Date().toISOString();
  const member = newMember([], memberOpts, { vendorNames: vendorNames() });
  const chat = { id: newChatId(), title: 'New chat', createdAt: now, updatedAt: now, thread: createThread([member]) };
  chats.set(chat.id, chat);
  hideChooser();
  showChat(chat.id);
  api.log('info', 'custom agent chat created', { chatId: chat.id, agent: member.name, vendor: member.vendor });
}

function createProjectChat(projectId, { open = true } = {}) {
  const project = projectList.find(p => p.id === projectId);
  if (!project) return;
  const now = new Date().toISOString();
  const chat = { id: newChatId(), title: 'New chat', projectId, createdAt: now, updatedAt: now,
    thread: createThread(seedMembers(project.members)) };
  chats.set(chat.id, chat);
  collapsedProjects.delete(projectId);
  // A deliberate + chat belongs to the project even before the first message.
  persist(chat);
  if (open) { hideChooser(); showChat(chat.id); } else renderChatList();
}

async function renderProjectForm(card, projectId) {
  const project = projectList.find(p => p.id === projectId);
  if (projectId && !project) return;
  const active = () => card.isConnected && !el.chooser.hidden && el.chooser.contains(card);
  const form = document.createElement('form');
  form.className = 'project-form';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Project name';
  const name = document.createElement('input');
  name.type = 'text'; name.required = true; name.maxLength = 80;
  name.value = project ? project.name : '';
  nameLabel.appendChild(name);
  const rosterLabel = document.createElement('label');
  rosterLabel.textContent = 'Roster for new chats';
  const choice = document.createElement('select');
  const option = (value, text) => {
    const o = document.createElement('option'); o.value = value; o.textContent = text; choice.appendChild(o);
  };
  if (project) option('keep', `Keep current roster (${project.members.map(m => m.name).join(', ')})`);
  option('crew', 'Crew: Codex Design, Gemini UI/UX, Claude Engineering');
  option('teammates', 'Choose teammates');
  rosterLabel.appendChild(choice);
  const picks = document.createElement('fieldset');
  picks.hidden = true;
  const legend = document.createElement('legend'); legend.textContent = 'Teammates (1–20)'; picks.appendChild(legend);
  const help = document.createElement('p'); help.className = 'chooser-note';
  help.textContent = 'Roster edits apply only to new chats. Existing agents, sessions and working folders stay as they are.';
  const error = document.createElement('p'); error.className = 'project-error'; error.setAttribute('role', 'alert');
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = project ? 'Save project' : 'Create project & first chat';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { if (current()) { hideChooser(); showChat(currentId); } else showChooser('new'); });
  form.append(nameLabel, rosterLabel, picks, help, error, save, cancel);
  card.appendChild(form);
  name.focus();
  const checks = [];
  let ready = false;
  api.getOrg().then(org => {
    if (!card.isConnected) return;
    for (const p of teammates(org)) {
      const label = document.createElement('label');
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = p.id;
      input.checked = !!project && project.members.some(m => m.persona === p.id);
      checks.push(input);
      const text = document.createElement('span'); text.textContent = `${p.name} · ${vendorName(p.vendor)}`;
      label.append(input, text); picks.appendChild(label);
    }
    ready = true;
  }).catch(err => { error.textContent = `Could not load teammates: ${err.message}. The crew preset is still available.`; });
  choice.addEventListener('change', () => { picks.hidden = choice.value !== 'teammates'; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    const selection = choice.value === 'keep' ? null : choice.value === 'crew' ? { kind: 'crew' } : { kind: 'teammates', ids: checks.filter(c => c.checked).map(c => c.value) };
    if (choice.value === 'teammates' && (!ready || !selection.ids.length)) { error.textContent = 'Choose at least one available teammate.'; return; }
    save.disabled = true; error.textContent = '';
    try {
      const req = { name: name.value, ...(selection ? { selection } : {}) };
      const saved = project ? await api.updateProject({ id: project.id, ...req }) : await api.createProject(req);
      projectList = await api.listProjects();
      if (!active()) {
        if (!project) createProjectChat(saved.id, { open: false }); else renderChatList();
        return;
      }
      if (!project) createProjectChat(saved.id);
      else { hideChooser(); if (current()) showChat(currentId); else showChooser('new'); renderChatList(); }
    } catch (err) { error.textContent = err.message; save.disabled = false; }
  });
  if (project) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete project…';
    let confirmed = false;
    remove.addEventListener('click', async () => {
      if (save.disabled) return;
      if (!confirmed) { confirmed = true; remove.textContent = 'Confirm delete — keep all chats Unfiled'; return; }
      remove.disabled = true; save.disabled = true;
      try {
        await api.removeProject(project.id);
        projectList = await api.listProjects();
        if (active()) { hideChooser(); if (current()) showChat(currentId); else showChooser('new'); }
        renderChatList();
      } catch (err) { error.textContent = err.message; remove.disabled = false; save.disabled = false; }
    });
    form.appendChild(remove);
  }
}

// Adds an agent to a chat and says so there. opts: model, modelLabel, memory
// ({ title, name, text } from another chat), name (keep this name if it's
// free), fromTitle (for the note), threadOf (where the note goes).
function join(chatId, vendor, { model = null, modelLabel = null, memory = null, name = null, role = null, brain = null, brainText = null, customInstructions = null, mcp = null, skills = null, persona = null, fromTitle = null, threadOf = null } = {}) {
  const chat = chats.get(chatId);
  const names = name ? { ...vendorNames(), [vendor]: name } : vendorNames();
  const member = newMember(chat.thread.members, { vendor, model, memory, role, name, brain, brainText, customInstructions, mcp, skills, persona }, { vendorNames: names, modelLabel });
  chat.thread.members.push(member);
  const what = member.name === vendorName(vendor) ? modelText(member) : `${vendorName(vendor)}, ${modelText(member)}`;
  post(chatId, { from: 'system', threadOf, text: `${member.name} (${what}) joined` + (fromTitle ? ` from "${fromTitle}"` : '') + '.' });
  api.log('info', 'agent joined', { chatId, member: member.id, vendor, model, from: fromTitle });
  if (chatId === currentId) {
    renderMembers();
    if (activeSidecarTab === 'toolbelt') renderToolbelt();
  }
  return member;
}

// Matt takes an agent out of a chat (TM-57): it stops if it's answering and
// is marked `left`, so its old messages keep its name. The chat's own agent
// can't leave.
function removeMember(chatId, memberId) {
  const chat = chats.get(chatId);
  const member = memberById(chat.thread, memberId);
  if (!member || member === chat.thread.members[0] || member.left) return;
  const key = runKeyOf(chatId, memberId);
  if (pending[key]) stopRun(key);
  member.left = true;
  post(chatId, { from: 'system', text: `${member.name} left.` });
  api.log('info', 'agent removed', { chatId, member: memberId });
  if (chatId === currentId) { renderMembers(); openViews().forEach(updatePlaceholder); updateSendButtons(); }
}

// An @ (or a thread) that reaches an agent who left brings it back, with a
// fresh session: it missed what was said while it was out.
function rejoin(chatId, memberId, threadOf = null) {
  const member = memberById(chats.get(chatId).thread, memberId);
  if (!member || !member.left) return memberId;
  delete member.left;
  delete member.sessions;
  delete member.usage;
  post(chatId, { from: 'system', threadOf, text: `${member.name} joined again.` });
  api.log('info', 'agent rejoined', { chatId, member: memberId });
  if (chatId === currentId) renderMembers();
  return memberId;
}

async function loadChat(chat) {
  if (!chat.thread) Object.assign(chat, await api.loadChat(chat.id));
  renameRetired(ensureMembers(chat.thread, vendorNames()), vendorNames());
  return chat;
}

async function openChat(id) {
  const chat = chats.get(id);
  if (!chat) return;
  try {
    await loadChat(chat);
  } catch (err) {
    api.log('error', 'could not open chat', { id, error: err.message });
    return;
  }
  hideChooser();
  showChat(id);
}

function showChat(id) {
  closeOrgControl();
  currentId = id;
  closePanel();
  const c = current();
  if (el.chatHeaderTitle) el.chatHeaderTitle.textContent = c ? c.title : 'Chat';
  // Each chat's agents work in a folder of their own (TM-59).
  if (workingDir) el.folder.textContent = `Working folder: ${workingDir}\\${id}`;
  renderChatList();
  renderMembers();
  renderSidecar();
  renderView(main);
  updatePlaceholder(main);
  updateSendButtons();
  main.input.focus();
}

let activeSidecarTab = 'session'; // 'session' | 'preview' | 'toolbelt'

function setSidecarTab(tab) {
  activeSidecarTab = tab;
  if (panelOpen()) {
    removePendingRows(panel);
    closeMentions(panel);
    panel.threadOf = null;
    panel.list.replaceChildren();
    el.panel.hidden = true;
  }
  if (el.tabSession) el.tabSession.classList.toggle('active', tab === 'session');
  if (el.tabPreview) el.tabPreview.classList.toggle('active', tab === 'preview');
  if (el.tabToolbelt) el.tabToolbelt.classList.toggle('active', tab === 'toolbelt');

  if (el.sidecarContent) el.sidecarContent.hidden = (tab !== 'session');
  if (el.sidecarPreview) el.sidecarPreview.hidden = (tab !== 'preview');
  if (el.sidecarToolbelt) el.sidecarToolbelt.hidden = (tab !== 'toolbelt');

  if (tab === 'session' && currentId) renderSidecar();
  if (tab === 'toolbelt') renderToolbelt();
}

// Opens a thread in the panel beside the main chat.
function openPanel(rootId) {
  const root = current().thread.messages.find(m => m.id === rootId);
  if (!root) return;
  panel.threadOf = rootId;
  if (el.sidecarContent) el.sidecarContent.hidden = true;
  if (el.sidecarPreview) el.sidecarPreview.hidden = true;
  if (el.sidecarToolbelt) el.sidecarToolbelt.hidden = true;
  el.panel.hidden = false;
  el.panelLabel.textContent = `Thread on ${root.from === 'matt' ? 'your' : nameOf(root.from) + "'s"} message`;
  renderView(panel);
  updatePlaceholder(panel);
  updateSendButtons();
  panel.input.focus();
}

function closePanel() {
  removePendingRows(panel);
  closeMentions(panel);
  panel.threadOf = null;
  panel.list.replaceChildren();
  el.panel.hidden = true;
  setSidecarTab(activeSidecarTab);
}

// Whether a message belongs in a view. The panel shows the thread's first message too.
function inView(view, m) {
  if (view === panel && !panelOpen()) return false;
  return view.threadOf === null ? !m.threadOf : m.id === view.threadOf || m.threadOf === view.threadOf;
}

function pendingInView(view, p) {
  if (view === panel && !panelOpen()) return false;
  return p.chatId === currentId && (p.threadOf || null) === view.threadOf;
}

async function persist(chat) {
  try {
    await api.saveChat({ id: chat.id, title: chat.title, titleSet: chat.titleSet, createdAt: chat.createdAt, updatedAt: chat.updatedAt, projectId: chat.projectId, thread: chat.thread });
  } catch (err) {
    api.log('error', 'could not save chat', { id: chat.id, error: err.message });
  }
}

function renderChatList() {
  el.chatList.replaceChildren();
  if (projectCatalogError) {
    const error = document.createElement('p'); error.className = 'project-error'; error.setAttribute('role', 'alert');
    error.textContent = `Projects unavailable: ${projectCatalogError}. Chats are available; cross-chat asks are disabled. Repair projects.json and restart to restore projects.`;
    el.chatList.appendChild(error);
  }
  const sorted = [...chats.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  for (const group of projectGroups(sorted, projectList)) {
    const key = group.project ? group.project.id : 'unfiled';
    const section = document.createElement('section');
    section.className = 'project-group';
    const header = document.createElement('div');
    header.className = 'project-header';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'project-toggle';
    toggle.textContent = `${collapsedProjects.has(key) ? '▸' : '▾'} ${group.project ? group.project.name : projectCatalogError ? 'Chats (projects unavailable)' : 'Unfiled'} (${group.chats.length})`;
    toggle.setAttribute('aria-expanded', String(!collapsedProjects.has(key)));
    toggle.addEventListener('click', () => {
      if (collapsedProjects.has(key)) collapsedProjects.delete(key); else collapsedProjects.add(key);
      renderChatList();
    });
    header.appendChild(toggle);
    if (group.project) {
      const add = document.createElement('button');
      add.type = 'button'; add.textContent = '+ chat';
      add.title = `New chat in ${group.project.name}`;
      add.addEventListener('click', () => createProjectChat(group.project.id));
      const edit = document.createElement('button');
      edit.type = 'button'; edit.textContent = 'Edit';
      edit.title = `Rename or edit ${group.project.name}`;
      edit.addEventListener('click', () => showChooser('project-edit', group.project.id));
      header.append(add, edit);
    }
    section.appendChild(header);
    el.chatList.appendChild(section);
    if (collapsedProjects.has(key)) continue;
    for (const chat of group.chats) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chat-item' + (chat.id === currentId && el.chooser.hidden ? ' active' : '');
    item.title = chat.title;

    const headerRow = document.createElement('div');
    headerRow.className = 'chat-header-row';

    const title = document.createElement('span');
    title.className = 'chat-title';
    title.textContent = chat.title;
    const when = document.createElement('span');
    when.className = 'chat-when';
    const busy = Object.values(pending).filter(p => p.chatId === chat.id).length;
    when.textContent = busy ? 'working…' : dayLabel(chat.updatedAt);
    if (busy) item.classList.add('busy');
    headerRow.append(title, when);

    const agentsRow = document.createElement('div');
    agentsRow.className = 'chat-agents';
    if (chat.thread && chat.thread.members) {
      for (const m of chat.thread.members) {
        if (m.left) continue;
        const dot = document.createElement('span');
        dot.className = 'chat-agent-dot';
        dot.style.setProperty('--agent-color', vendors[m.vendor] ? vendors[m.vendor].color : '#888');
        dot.title = m.name;
        agentsRow.appendChild(dot);
      }
    }

    const rename = document.createElement('span');
    rename.className = 'chat-rename';
    rename.textContent = '✎';
    rename.title = 'Rename';
    rename.addEventListener('click', (e) => { e.stopPropagation(); editTitle(chat, item); });
    const merge = document.createElement('span');
    merge.className = 'chat-merge';
    merge.textContent = '⇆';
    merge.title = 'Merge with another chat (makes a new chat; both stay)';
    merge.addEventListener('click', (e) => { e.stopPropagation(); showChooser('merge', chat.id); });
    item.append(headerRow, agentsRow, rename, merge);
    // The first click opens the chat and redraws this list, so a double-click
    // never lands on one element: the second click's count says it instead.
    item.addEventListener('click', (e) => (e.detail >= 2 ? editTitle(chat, item) : openChat(chat.id)));
    section.appendChild(item);
    }
  }
}

// Rename in place (TM-54): Enter saves, Esc cancels, an empty title goes back
// to following Matt's first message.
// The box replaces the whole list item: inside the item's <button>, a typed
// space would press the button.
function editTitle(chat, item) {
  const input = document.createElement('input');
  input.className = 'chat-title-edit';
  input.value = chat.title;
  input.maxLength = 60;
  item.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    if (save && text !== chat.title) {
      if (!chat.thread) Object.assign(chat, await api.loadChat(chat.id));
      chat.titleSet = Boolean(text);
      chat.title = text || chatTitle(chat.thread);
      // A chat with nothing said in it isn't saved yet; the name sticks once it is.
      if (chat.thread.messages.length || chat.projectId) persist(chat);
    }
    renderChatList();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// The open chat's agents, in the header: name, vendor and model.
function renderMembers() {
  el.members.replaceChildren();
  const owner = current().thread.members[0];
  for (const m of current().thread.members) {
    if (m.left) continue;
    const working = Boolean(pending[runKeyOf(currentId, m.id)]);
    const chip = document.createElement('span');
    chip.className = 'member' + (working ? ' working' : '');
    chip.style.setProperty('--agent-color', vendors[m.vendor] ? vendors[m.vendor].color : '#888');
    const role = m.role && ROLES[m.role];
    chip.textContent = `${m.name} · ${role ? `${role.label} · ` : ''}${modelText(m)}` + (working ? ' · working…' : '');
    chip.title = `${vendorName(m.vendor)}, ${modelText(m)}` + (m.memory ? `, with background from "${m.memory.title}"` : '') + (role ? `\nRole: ${role.brief}` : '');
    // Context meter (TM-55): what its last reply used. Only Claude says how
    // big its window is; the others show tokens.
    const u = m.usage;
    if (u && u.inputTokens) {
      const meter = document.createElement('span');
      meter.className = 'meter';
      meter.textContent = u.contextWindow
        ? `${tokens(u.inputTokens)} / ${tokens(u.contextWindow)}`
        : `${tokens(u.inputTokens)} tokens`;
      if (u.contextWindow) meter.style.setProperty('--fill', `${Math.min(100, (100 * u.inputTokens) / u.contextWindow).toFixed(1)}%`);
      chip.title += `\nContext: its last reply read ${u.inputTokens.toLocaleString()} tokens` +
        (u.contextWindow ? ` of ${u.contextWindow.toLocaleString()} (${((100 * u.inputTokens) / u.contextWindow).toFixed(1)}%)` : ' (this CLI doesn\'t say how big its window is)') +
        `, and wrote ${(u.outputTokens || 0).toLocaleString()}. Updated ${timeLabel(u.at)}.`;
      chip.appendChild(meter);
    }
    if (m !== owner) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'member-remove';
      x.textContent = '×';
      x.title = `Remove ${m.name} from this chat` + (working ? ' (stops its reply)' : '') + '. An @ brings it back.';
      x.setAttribute('aria-label', `Remove ${m.name}`);
      x.addEventListener('click', () => removeMember(currentId, m.id));
      chip.appendChild(x);
    }
    el.members.appendChild(chip);
  }
  renderSidecar();
}

// Sidecar (TM-60): Right rail displaying live session telemetry, context gauges,
// active models, and workspace folder.
function renderSidecar() {
  if (!el.sidecar) return;
  if (activeSidecarTab === 'toolbelt') renderToolbelt();
  const c = current();
  if (!c) {
    if (el.sidecarModels) el.sidecarModels.replaceChildren();
    if (el.contextGaugeVal) el.contextGaugeVal.textContent = '0 tokens';
    if (el.contextBar) el.contextBar.style.width = '0%';
    if (el.sidecarFolder) el.sidecarFolder.textContent = '—';
    if (el.sidecarPlanWrap) el.sidecarPlanWrap.replaceChildren();
    return;
  }

  // Workspace folder
  if (el.sidecarFolder) {
    const fPath = workingDir ? `${workingDir}\\${c.id}` : '—';
    el.sidecarFolder.textContent = fPath;
    el.sidecarFolder.title = fPath;
    // GitHub row: only when the chat's folder really is in a GitHub repo.
    if (el.workspaceGitRow && el.sidecarGit) {
      const showGit = (info) => {
        el.workspaceGitRow.hidden = !info;
        if (info) el.sidecarGit.textContent = info.branch ? `${info.repo} · ${info.branch}` : info.repo;
      };
      if (c.id in gitInfoCache) showGit(gitInfoCache[c.id]);
      else {
        el.workspaceGitRow.hidden = true;
        api.getGitInfo(c.id).then((info) => {
          gitInfoCache[c.id] = info;
          if (current() && current().id === c.id) showGit(info);
        }).catch(() => { gitInfoCache[c.id] = null; });
      }
    }
  }

  // Context gauge: each agent has a context of its own, so the gauge shows
  // the fullest one (by share of its window when the CLI reports one, else
  // by tokens), named. Summing them against one window said nothing real.
  const share = (u) => (u.contextWindow ? u.inputTokens / u.contextWindow : 0);
  const fullest = c.thread.members.filter(m => !m.left && m.usage && m.usage.inputTokens)
    .sort((a, b) => share(b.usage) - share(a.usage) || b.usage.inputTokens - a.usage.inputTokens)[0];
  if (el.contextGaugeVal && el.contextBar && el.contextGaugeLabel) {
    const u = fullest ? fullest.usage : null;
    el.contextGaugeLabel.textContent = fullest ? `Context · ${fullest.name}` : 'Context Window';
    if (u && u.contextWindow) {
      const pct = Math.min(100, 100 * share(u));
      el.contextGaugeVal.textContent = `${tokens(u.inputTokens)} / ${tokens(u.contextWindow)}`;
      el.contextBar.style.width = `${pct.toFixed(1)}%`;
      el.contextBar.title = `${fullest.name}'s last reply read ${u.inputTokens.toLocaleString()} of ${u.contextWindow.toLocaleString()} tokens (${pct.toFixed(1)}%)`;
    } else if (u) {
      el.contextGaugeVal.textContent = `${tokens(u.inputTokens)} tokens`;
      el.contextBar.style.width = '0%';
      el.contextBar.title = `${fullest.name}'s last reply read ${u.inputTokens.toLocaleString()} tokens (its CLI doesn't say how big its window is)`;
    } else {
      el.contextGaugeVal.textContent = '0 tokens';
      el.contextBar.style.width = '0%';
      el.contextBar.title = 'No token usage recorded yet';
    }
  }

  // Claude plan info
  if (el.sidecarPlanWrap) {
    el.sidecarPlanWrap.replaceChildren();
    const p = plans.claude;
    if (p) {
      const pct = (w) => (w ? `${Math.round(w.used * 100)}%` : '?');
      const planDiv = document.createElement('div');
      planDiv.className = 'sidecar-plan' + (p.status && p.status !== 'allowed' || (p.fiveHour && p.fiveHour.used >= 0.8) ? ' warn' : '');
      planDiv.textContent = `Claude plan: 5h ${pct(p.fiveHour)} · 7d ${pct(p.sevenDay)}`;
      el.sidecarPlanWrap.appendChild(planDiv);
    }
  }

  // Active models
  if (el.sidecarModels) {
    el.sidecarModels.replaceChildren();
    for (const m of c.thread.members) {
      if (m.left) continue;
      const working = Boolean(pending[runKeyOf(c.id, m.id)]);
      const item = document.createElement('div');
      item.className = 'sidecar-model-item' + (working ? ' working' : '');

      const left = document.createElement('div');
      left.className = 'sidecar-model-left';

      const dot = document.createElement('span');
      dot.className = 'sidecar-model-dot';
      dot.style.setProperty('--agent-color', vendors[m.vendor] ? vendors[m.vendor].color : '#888');

      const name = document.createElement('span');
      name.className = 'sidecar-model-name';
      name.textContent = m.name;

      left.append(dot, name);

      if (m.role && ROLES[m.role]) {
        const role = document.createElement('span');
        role.className = 'sidecar-model-role';
        role.textContent = ROLES[m.role].label;
        left.appendChild(role);
      }

      const status = document.createElement('span');
      status.className = 'sidecar-model-status';
      status.textContent = working ? 'working…' : modelText(m);

      item.append(left, status);
      el.sidecarModels.appendChild(item);
    }
  }
}

// 66501 -> "67k", 1000000 -> "1M".
function tokens(n) {
  return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

// Claude's plan use (TM-55): its 5-hour and 7-day windows, from the latest
// Claude reply. Kept in this window's storage so it shows after a restart.
function renderPlan() {
  const p = plans.claude;
  el.plan.hidden = !p;
  if (p) {
    const pct = (w) => (w ? `${Math.round(w.used * 100)}%` : '?');
    const when = (w) => (w && w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'unknown');
    el.plan.textContent = `Claude plan · 5h ${pct(p.fiveHour)} · 7d ${pct(p.sevenDay)}`;
    el.plan.title = `5-hour window resets ${when(p.fiveHour)}; 7-day window resets ${when(p.sevenDay)}.` +
      (p.status && p.status !== 'allowed' ? `\nStatus: ${p.status}.` : '') + `\nAs of ${new Date(p.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    el.plan.classList.toggle('warn', p.status !== 'allowed' || (p.fiveHour && p.fiveHour.used >= 0.8));
  }
  renderSidecar();
}

// Sidecar expansion toggle (TM-60 Batch 3)
function toggleSidecarExpand() {
  if (!el.sidecar) return;
  const isExpanded = el.sidecar.classList.toggle('expanded');
  if (el.sidecarExpandBtn) {
    el.sidecarExpandBtn.textContent = isExpanded ? '⤡' : '⤢';
    el.sidecarExpandBtn.title = isExpanded ? 'Collapse sidecar (320px)' : 'Expand sidecar (55vw)';
  }
}

// Renders the toolbelt capabilities tab (TM-60 Batch 3, 4)
function renderToolbelt() {
  if (!el.toolbeltList) return;
  el.toolbeltList.replaceChildren();
  const c = current();
  if (!c || !c.thread || !c.thread.members) return;

  // Central Brain institutional header (TM-60 Batch 4)
  const centralBanner = document.createElement('div');
  centralBanner.className = 'toolbelt-central-banner';
  const cbTitle = document.createElement('div');
  cbTitle.className = 'toolbelt-central-title';
  cbTitle.textContent = '🧠 Central Brain (MMS Operating Doctrine)';
  const cbStatus = document.createElement('div');
  cbStatus.className = 'toolbelt-central-status';
  cbStatus.textContent = '● Active across all agents · Synced from brains/central-brain.md';
  centralBanner.append(cbTitle, cbStatus);
  el.toolbeltList.appendChild(centralBanner);
  // Everything the cards need, read once for the whole tab (not once per
  // member): the assignments, the skills, the directory and the CLIs' lists.
  const loaded = Promise.all([api.getOrg(), api.listSkills(), api.listMcps(), api.listCliMcps()])
    .then(([org, skills, servers, cli]) => ({ org: org || {}, skills: skills || [], servers: servers || [], cli: cli || {} }));

  // What each CLI has as MCP servers, read live (TM-60 Batch 3).
  const lib = document.getElementById('toolbelt-library');
  if (lib) {
    lib.textContent = 'Reading…';
    loaded.then(({ cli }) => {
      lib.replaceChildren();
      for (const v of ['antigravity', 'codex', 'grok']) {
        const row = document.createElement('div');
        row.className = 'library-item';
        const names = (cli[v] || []).filter(x => x.enabled).map(x => x.name);
        row.textContent = `${vendorName(v)}: ${names.length ? names.join(', ') : 'none (or the CLI did not answer)'}`;
        lib.appendChild(row);
      }
      const claude = document.createElement('div');
      claude.className = 'library-item';
      claude.textContent = 'Claude: the servers given to it in the MCP Directory, passed at each launch.';
      lib.appendChild(claude);
    }).catch(() => { lib.textContent = 'Could not read the CLIs.'; });
  }

  for (const m of c.thread.members) {
    if (m.left) continue;
    const card = document.createElement('div');
    card.className = 'toolbelt-agent-card';

    const head = document.createElement('div');
    head.className = 'toolbelt-agent-head';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = m.name;
    const modelSpan = document.createElement('span');
    modelSpan.className = 'sidecar-model-role';
    modelSpan.textContent = modelText(m);
    head.append(nameSpan, modelSpan);

    const caps = document.createElement('div');
    caps.className = 'toolbelt-caps';

    // Persona Chip status
    const chipItem = document.createElement('div');
    chipItem.className = 'toolbelt-cap-item';
    const chipName = document.createElement('span');
    chipName.className = 'toolbelt-cap-name';
    chipName.textContent = m.brain ? `💾 Persona Chip (${m.brain})` : '💾 Persona Chip (Default)';
    const chipStatus = document.createElement('span');
    chipStatus.className = 'toolbelt-cap-status';
    chipStatus.textContent = '● Attached';
    chipItem.append(chipName, chipStatus);
    caps.appendChild(chipItem);

    // The skills this member gets (TM-60 Batch 2), looked up after the card draws.
    const skillsItem = document.createElement('div');
    skillsItem.className = 'toolbelt-cap-item';
    const skillsName = document.createElement('span');
    skillsName.className = 'toolbelt-cap-name';
    skillsName.textContent = '⚡ Skills: …';
    skillsItem.appendChild(skillsName);
    caps.appendChild(skillsItem);
    loaded.then(({ org, skills }) => {
      const mine = skillsFor({ vendor: m.vendor, persona: personaIdOf(m), own: m.skills }, skills, org.skills || {});
      const names = [...mine.engine, ...mine.persona].map(s => s.title);
      const how = folderFile(m.vendor) ? `via ${folderFile(m.vendor)}` : 'in the prompt';
      skillsName.textContent = `⚡ Skills: ${names.length ? `${names.join(', ')} (${how})` : 'none'}`;
    }).catch(() => { skillsName.textContent = '⚡ Skills: unknown'; });

    // Claude gets directory servers at launch. The other engines do not, so
    // the line says that instead of "none assigned" next to a full CLI list.
    const mcpItem = document.createElement('div');
    mcpItem.className = 'toolbelt-cap-item';
    const mcpName = document.createElement('span');
    mcpName.className = 'toolbelt-cap-name';
    mcpName.textContent = '🔌 MCP: …';
    mcpItem.appendChild(mcpName);
    caps.appendChild(mcpItem);
    loaded.then(({ org, servers, cli }) => {
      const mine = mcpFor({ vendor: m.vendor, persona: personaIdOf(m), own: m.mcp }, servers, org.mcp || {});
      if (m.vendor === 'claude') {
        mcpName.textContent = `🔌 MCP: ${mine.length ? `${mine.map(s => s.name).join(', ')} (passed at launch)` : 'none'}`;
      } else if (m.vendor === 'meta') {
        mcpName.textContent = 'MCP: API engine, no per-launch servers.';
      } else {
        const has = new Set((cli[m.vendor] || []).filter(s => s.enabled).map(s => s.name.toLowerCase()));
        mcpName.textContent = `🔌 MCP: not passed by Daycare. Its CLI has ${has.size}.`;
      }
    }).catch(() => { mcpName.textContent = '🔌 MCP: unknown'; });

    card.append(head, caps);
    el.toolbeltList.appendChild(card);
  }
}

// The window isn't connected to Notion (TM-60 built the card, not the
// link). A glance can only open a ticket whose page Matt's work has a link
// for; nothing here is live.
const NOTION_LINKS = {
  'TM-56': 'https://app.notion.com/p/40263104ef7881d7abdbd44ad8f0093b',
  'TM-57': 'https://app.notion.com/p/40263104ef78813b9ea1fd88e575d48d',
  'TM-58': 'https://app.notion.com/p/40263104ef7881419817c02646db0615',
  'TM-59': 'https://app.notion.com/p/40263104ef7881c1a7abda21b02931d0'
};

let currentPreviewUrl = null;

// Displays live webview or native Notion glance in the preview tab
function showPreview({ title, url = null, type = 'html', ticketData = null }) {
  setSidecarTab('preview');
  if (el.previewTitle) el.previewTitle.textContent = title || 'Glance & Live Preview';

  if (type === 'notion' && ticketData) {
    if (el.previewEmpty) el.previewEmpty.hidden = true;
    if (el.previewIframe) {
      el.previewIframe.hidden = true;
      el.previewIframe.src = 'about:blank';
    }
    if (el.notionGlance) {
      el.notionGlance.hidden = false;
      if (el.notionTitle) el.notionTitle.textContent = `${ticketData.id}: ${ticketData.title}`;
      if (el.notionStatus) el.notionStatus.textContent = ticketData.status || 'Active';
      if (el.notionPriority) { el.notionPriority.textContent = ticketData.priority || ''; el.notionPriority.hidden = !ticketData.priority; }
      if (el.notionAssignee) { el.notionAssignee.textContent = ticketData.assignee || ''; el.notionAssignee.hidden = !ticketData.assignee; }
      if (el.notionDesc) el.notionDesc.textContent = ticketData.desc || '';
      if (el.notionLink) { el.notionLink.href = ticketData.url || '#'; el.notionLink.hidden = !ticketData.url; }
      if (el.notionTasks) {
        el.notionTasks.replaceChildren();
        for (const item of (ticketData.tasks || [])) {
          const li = document.createElement('li');
          li.className = 'notion-task-item' + (item.done ? ' done' : '');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = !!item.done;
          box.disabled = true;
          const span = document.createElement('span');
          span.textContent = item.text;
          li.append(box, span);
          el.notionTasks.appendChild(li);
        }
      }
    }
    currentPreviewUrl = ticketData.url || null;
  } else if (url) {
    if (el.notionGlance) el.notionGlance.hidden = true;
    if (el.previewEmpty) el.previewEmpty.hidden = true;
    if (el.previewIframe) {
      el.previewIframe.hidden = false;
      el.previewIframe.src = url;
    }
    currentPreviewUrl = url;
  }
}

function glanceNotionFromText(text) {
  const link = /(https?:\/\/(?:www\.)?notion\.(?:so|com)\/\S+)/i.exec(text);
  const match = /(TM-\d+)/i.exec(text);
  const id = match ? match[1].toUpperCase() : null;
  if (!link) {
    const url = id ? NOTION_LINKS[id] || null : null;
    showPreview({ title: id ? `Notion: ${id}` : 'Notion', type: 'notion', ticketData: {
      id: id || 'Notion',
      title: url ? 'Open in Notion for the live ticket' : 'No link saved for this ticket',
      status: 'not live',
      desc: 'Paste a Notion page link in the chat and this card pulls it live (needs NOTION_API_KEY in .env.local). TM ids alone only link out.',
      url,
      tasks: []
    } });
    return;
  }
  const ref = link[1];
  showPreview({ title: 'Notion', type: 'notion', ticketData: { id: 'Notion', title: 'Loading from Notion...', status: 'loading', desc: ref, url: ref, tasks: [] } });
  api.getNotionTicket(ref).then((out) => {
    if (!out || !out.connected) {
      showPreview({ title: 'Notion', type: 'notion', ticketData: { id: 'Notion', title: 'Not connected to Notion', status: 'not connected', desc: 'Add NOTION_API_KEY to .env.local (a Notion integration token, with this page shared to it), then restart the app.', url: ref, tasks: [] } });
      return;
    }
    const t = out.ticket;
    showPreview({ title: `Notion: ${t.title}`, type: 'notion', ticketData: {
      id: 'Notion', title: t.title, status: t.status || 'live', priority: t.priority || '',
      desc: t.edited ? `Updated ${new Date(t.edited).toLocaleString()} - pulled live from Notion` : 'Pulled live from Notion',
      url: t.url || ref, tasks: t.tasks || []
    } });
  }).catch((err) => {
    showPreview({ title: 'Notion', type: 'notion', ticketData: { id: 'Notion', title: 'Could not pull that page', status: 'failed', desc: `${err.message}. Check the page is shared with your Notion integration.`, url: ref, tasks: [] } });
  });
}

function previewFromText(text) {
  const hostMatch = /(https?:\/\/localhost:\d+[^\s]*)/i.exec(text);
  const htmlMatch = /([a-zA-Z0-9_\-\/]+\.html)/i.exec(text);
  if (hostMatch) {
    showPreview({ title: hostMatch[1], url: hostMatch[1], type: 'html' });
  } else if (htmlMatch) {
    const filename = htmlMatch[1];
    const cFolder = workingDir && currentId ? `${workingDir}/${currentId}`.replace(/\\/g, '/') : '';
    const fUrl = `file:///${cFolder}/${filename}`;
    showPreview({ title: filename, url: fUrl, type: 'html' });
  }
}

// Adds a message to a chat (open or not), saves it, and draws it wherever it shows.
function post(chatId, message) {
  const chat = chats.get(chatId);
  const m = addMessage(chat.thread, message);
  chat.updatedAt = m.ts;
  if (!chat.titleSet) chat.title = chatTitle(chat.thread);
  persist(chat);
  if (chatId === currentId) {
    for (const view of openViews()) {
      if (!inView(view, m)) continue;
      removePendingRows(view);
      renderMessage(view, m);
      renderPendingRows(view);
    }
    if (m.threadOf) renderSummary(m.threadOf);
  }
  renderChatList();
  return m;
}

// ---- Choosing an agent: for a new chat, or to add to this one ---------------------
// mode: 'new' (start a chat), 'add' (add a fresh agent here), 'from' (add an
// agent from another chat). vendor: the vendor picked so far, if any.

function showChooser(mode = 'new', vendor = null) {
  closeOrgControl();
  el.chooser.hidden = false;
  el.chooser.dataset.mode = mode;
  el.chooser.dataset.vendor = vendor || '';
  el.chat.classList.add('choosing');
  closePanel();
  closeMentions(main);
  renderChatList();
  el.chooser.replaceChildren();

  const card = document.createElement('div');
  card.className = 'chooser-card';
  el.chooser.appendChild(card);

  const h = document.createElement('h2');
  card.appendChild(h);
  const options = document.createElement('div');
  options.className = 'options';
  card.appendChild(options);
  const option = (label, sub, color, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'option';
    if (color) b.style.setProperty('--agent-color', color);
    const top = document.createElement('span');
    top.className = 'option-label';
    top.textContent = label;
    b.appendChild(top);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'option-sub';
      s.textContent = sub;
      b.appendChild(s);
    }
    b.addEventListener('click', onClick);
    options.appendChild(b);
    return b;
  };
  const pick = (v, model, label) => {
    if (mode === 'new') return createChat(v, model, label);
    join(currentId, v, { model, modelLabel: label });
    hideChooser();
    showChat(currentId);
  };

  if (mode === 'project' || mode === 'project-edit') {
    h.textContent = mode === 'project' ? 'New project' : 'Edit project';
    renderProjectForm(card, mode === 'project-edit' ? vendor : null);
    el.chooser.onclick = null;
    return;
  } else if (mode === 'merge') {
    // vendor holds the chat being merged on this screen.
    const first = chats.get(vendor);
    h.textContent = `Merge "${first.title}" with which chat?`;
    const note = document.createElement('p');
    note.className = 'chooser-note';
    note.textContent = 'This makes a new chat with both chats\' agents and messages. Both chats stay as they are.';
    card.insertBefore(note, options);
    for (const c of [...chats.values()].filter(c => c.id !== first.id).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))) {
      option(c.title, dayLabel(c.updatedAt), null, () => mergeChats(first, c));
    }
  } else if (mode === 'from') {
    h.textContent = vendor ? 'Which agent from that chat?' : 'Add an agent from which chat?';
    if (!vendor) {
      for (const c of [...chats.values()].filter(c => c.id !== currentId).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))) {
        option(c.title, dayLabel(c.updatedAt), null, async () => {
          await loadChat(c);
          showChooser('from', c.id);
        });
      }
    } else {
      // vendor holds the source chat's id on this screen.
      const src = chats.get(vendor);
      for (const m of src.thread.members) {
        option(m.name, `${vendorName(m.vendor)}, ${modelText(m)}`, vendors[m.vendor] && vendors[m.vendor].color, () => {
          join(currentId, m.vendor, { model: m.model, modelLabel: modelLabelOf(m.vendor, m.model), name: m.name, memory: { title: src.title, name: m.name, text: memorySnapshot(src.thread) }, fromTitle: src.title });
          hideChooser();
          showChat(currentId);
        });
      }
    }
  } else if (!vendor && mode !== 'personas' && mode !== 'builder') {
    h.textContent = mode === 'new' ? 'Who do you want to talk to?' : 'Add which agent to this chat?';
    if (mode === 'new') {
      const newProject = option('New project…', projectCatalogError || 'A saved roster with separate chats filed together', '#2563eb', () => showChooser('project'));
      newProject.disabled = !!projectCatalogError;
      option('Autonomous Crew', CREW.map(c => `${vendorName(c.vendor)} ${ROLES[c.role].label}`).join(' · '), '#2563eb', createCrew);
      option('Spark Crew (demo)', SPARK_CREW.map(c => `${vendorName(c.vendor)} ${ROLES[c.role].label}`).join(' · '), '#2563eb', () => createCrew(SPARK_CREW));
    }
    option('Teammates…', 'Agent Smith, Morpheus, Grok Scout… and the agents you saved', '#8b5cf6', () => showChooser('personas', mode));
    option('Agent Builder…', 'Forge an agent: engine, persona chip, skills, MCP servers; save it as a teammate', '#10b981', () => showChooser('builder', mode));
    for (const v of VENDORS) option(vendorName(v), `Run with ${vendorName(v)} default`, vendors[v] && vendors[v].color, () => showChooser(mode, v));
    if (mode === 'add' && chats.size > 1) option('From another chat…', 'brings that chat as background', null, () => showChooser('from'));
  } else if (mode === 'personas') {
    const prevMode = vendor || 'new';
    h.textContent = 'Teammates';
    const note = document.createElement('p');
    note.className = 'chooser-note';
    note.textContent = 'The built-in personas and the agents you saved from the Builder. Each brings its persona chip, and the skills and MCP servers given to it.';
    card.insertBefore(note, options);
    // Saved teammates live in org.json (TM-60 Batch 4), so this list loads.
    api.getOrg().then((org) => {
      for (const p of teammates(org)) {
        const sub = `${vendorName(p.vendor)}${p.role && ROLES[p.role] ? ` · ${ROLES[p.role].label}` : ''}${p.builtIn ? '' : ' · saved'}`;
        option(p.name, sub, p.color || (vendors[p.vendor] && vendors[p.vendor].color), async () => {
          let brainText = p.brainText || '';
          if (p.brainFile && !brainText) {
            try {
              const brains = await api.listBrains();
              const match = (brains || []).find(b => b.file === p.brainFile);
              if (match) brainText = match.text;
            } catch (_) {}
          }
          const opts = { name: p.name, role: p.role || null, model: p.model || null, modelLabel: modelLabelOf(p.vendor, p.model || null), brain: p.brainFile || null, brainText, customInstructions: p.customInstructions || null, mcp: p.mcp || null, persona: p.id };
          if (prevMode === 'add') {
            join(currentId, p.vendor, opts);
            hideChooser();
            showChat(currentId);
          } else {
            createCustomChat({ vendor: p.vendor, ...opts });
          }
        });
      }
    }).catch((err) => { note.textContent = `Could not load teammates: ${err.message}`; });
  } else if (mode === 'builder') {
    const prevMode = vendor || 'new';
    h.textContent = 'Agent Builder';
    const note = document.createElement('p');
    note.className = 'chooser-note';
    note.textContent = 'Configure a new specialized agent from the ground up.';
    card.insertBefore(note, options);

    const form = document.createElement('form');
    form.className = 'builder-form';
    const builder = builderForm();
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'builder-submit';
    submitBtn.textContent = 'Forge & Deploy Teammate';
    form.append(...builder.fields, submitBtn);
    card.appendChild(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cfg = builder.config();
      if (!cfg.name) return;
      submitBtn.disabled = true;
      const opts = await builderMember(cfg);
      if (prevMode === 'add') {
        join(currentId, cfg.vendor, opts);
        hideChooser();
        showChat(currentId);
      } else {
        createCustomChat({ vendor: cfg.vendor, ...opts });
      }
    });
  } else {
    const color = vendors[vendor] && vendors[vendor].color;
    h.textContent = `Which ${vendorName(vendor)} model?`;
    option('Default', `whatever ${vendorName(vendor)} uses by default`, color, () => pick(vendor, null, null));
    const list = (models && models[vendor]) || [];
    for (const m of list) option(m.label, m.id, color, () => pick(vendor, m.id, m.label));
    if (vendor === 'antigravity' && models && !list.length) {
      const note = document.createElement('p');
      note.className = 'chooser-note';
      note.textContent = "Couldn't get Gemini's model list (agy models), so only its default is offered.";
      card.appendChild(note);
    }
    if (vendor === 'codex') {
      // Codex can't list its models, so its model is typed.
      const row = document.createElement('form');
      row.className = 'typed-model';
      const input = document.createElement('input');
      input.placeholder = 'or type a model, e.g. gpt-6-astra';
      const use = document.createElement('button');
      use.type = 'submit';
      use.textContent = 'Use';
      const check = () => { use.disabled = !MODEL_TEXT.test(input.value.trim()); };
      input.addEventListener('input', check);
      check();
      row.addEventListener('submit', (e) => {
        e.preventDefault();
        if (MODEL_TEXT.test(input.value.trim())) pick('codex', input.value.trim(), input.value.trim());
      });
      row.append(input, use);
      card.appendChild(row);
    }
  }
  const nav = document.createElement('div');
  nav.className = 'chooser-nav';
  if ((vendor || mode === 'from' || mode === 'personas' || mode === 'builder') && mode !== 'merge') {
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '← Back';
    back.addEventListener('click', () => {
      if (mode === 'personas' || mode === 'builder') {
        showChooser(vendor || 'new', null);
      } else {
        showChooser(mode === 'from' && !vendor ? 'add' : mode, null);
      }
    });
    nav.appendChild(back);
  }
  const returnTo = mode === 'new' ? newest() : current();
  if (returnTo) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => openChat(returnTo.id));
    nav.appendChild(cancel);
  }
  card.appendChild(nav);
  el.chooser.onclick = (e) => {
    if (e.target === el.chooser && returnTo) {
      openChat(returnTo.id);
    }
  };
}

// Two chats into a new group chat (TM-54 Batch 6). Both originals stay.
async function mergeChats(a, b) {
  try {
    await loadChat(a);
    await loadChat(b);
  } catch (err) {
    api.log('error', 'could not open a chat to merge', { error: err.message });
    return;
  }
  const now = new Date().toISOString();
  const title = `${a.title} + ${b.title}`.slice(0, 60);
  const chat = { id: newChatId(), title, titleSet: true, createdAt: now, updatedAt: now, thread: mergeThreads(a.thread, b.thread, vendorNames()) };
  const project = projectOf(a, projectList);
  if (project && b.projectId === project.id) chat.projectId = project.id;
  chats.set(chat.id, chat);
  post(chat.id, { from: 'system', text: `Merged from "${a.title}" and "${b.title}". Both of those chats are unchanged.` });
  api.log('info', 'chats merged', { from: [a.id, b.id], into: chat.id, members: chat.thread.members.length, messages: chat.thread.messages.length });
  hideChooser();
  showChat(chat.id);
}

function hideChooser() {
  el.chooser.hidden = true;
  el.chat.classList.remove('choosing');
}

// ---- Drawing messages ---------------------------------------------------------

// Builds one message row in a view. from: 'matt', 'system', 'guest' or a member id.
function createRow(view, from, metaText, text) {
  const row = document.createElement('div');
  const meta = document.createElement('div');
  const bubble = document.createElement('div');
  meta.className = 'meta';
  bubble.className = 'bubble';
  meta.textContent = metaText;
  bubble.textContent = text;

  if (from === 'matt') {
    row.className = 'msg matt';
  } else if (from === 'system') {
    row.className = 'msg system';
  } else {
    row.className = 'msg agent' + (from === 'guest' ? ' guest' : '');
    row.style.setProperty('--agent-color', from === 'guest' ? '#888' : colorOf(from));
  }

  if (from !== 'system') row.appendChild(meta);
  row.appendChild(bubble);
  appendRow(view, row, from === 'matt');
  return { row, meta, bubble };
}

function appendRow(view, row, alwaysScroll = false) {
  if (view.empty) view.empty.hidden = true;
  const atBottom = view.list.scrollHeight - view.list.scrollTop - view.list.clientHeight < 40;
  view.list.appendChild(row);
  // Next frame: callers add the meta text and buttons after this returns.
  if (atBottom || alwaysScroll) requestAnimationFrame(() => scrollToBottom(view));
}

// ---- Background asks between chats (TM-54 Batch 5) ----------------------------

function projectNameFor(chatId) {
  return projectCatalogError ? 'Unavailable — cross-chat asks disabled' : projectOf(chats.get(chatId), projectList)?.name || 'Unfiled';
}

function otherChats(chatId) {
  if (projectCatalogError) return [];
  return scopedChats(chats.get(chatId), [...chats.values()], projectList).filter(c => c.title).map(c => ({ id: c.id, title: c.title }));
}

const SIDE_STATES = { asking: 'asking…', answered: 'answered', stopped: 'stopped', busy: 'busy', failed: "didn't answer" };

// The row for a background ask: "Claude ⇄ Codex solo · asking…", which opens
// to the question and the answer (streamed in while it comes).
function sideRow(m) {
  const s = m.side;
  const row = document.createElement('div');
  row.className = 'msg side' + (s.state === 'asking' ? ' live' : '');
  row.dataset.id = m.id;
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'side-head';
  const who = s.asker === 'matt' ? 'You' : nameOf(s.asker);
  head.textContent = `${who} ⇄ ${s.chatTitle} · ${SIDE_STATES[s.state] || s.state}  ›`;
  head.title = 'Show the question and the answer';
  const body = document.createElement('div');
  body.className = 'side-body';
  body.hidden = s.state !== 'asking';
  const q = document.createElement('div');
  q.className = 'side-q';
  q.textContent = s.question;
  const a = document.createElement('div');
  a.className = 'side-a';
  a.textContent = s.answer || s.note || '';
  body.append(q, a);
  head.addEventListener('click', () => { body.hidden = !body.hidden; });
  row.append(head, body);
  const buttons = [{ label: `Open "${s.chatTitle}"`, title: 'Go to that chat', onClick: () => openChat(s.chatId) }];
  if (s.state === 'asking') buttons.unshift({ label: 'Stop', title: 'Stop the other chat answering', onClick: () => stopRun(s.runKey) });
  addActions(row, buttons);
  return row;
}

// Redraws a background ask's row wherever it shows.
function redrawSide(chatId, m) {
  if (chatId !== currentId) return;
  for (const view of openViews()) {
    const old = view.list.querySelector(`.msg.side[data-id="${m.id}"]`);
    if (old) {
      const row = sideRow(m);
      if (!old.querySelector('.side-body').hidden) row.querySelector('.side-body').hidden = false;
      old.replaceWith(row);
    }
  }
}

// Asks another chat in the background: the question goes to that chat's own
// agent as a guest message, answered there; this chat gets a live row. An
// agent that asked is launched again with the answer (see settleSide).
async function askChat({ fromChatId, asker, text, targetId, hop, threadOf = null, group = null }) {
  const src = chats.get(fromChatId);
  const dst = chats.get(targetId);
  if (!src || !dst || !otherChats(fromChatId).some(c => c.id === targetId)) {
    if (src) post(fromChatId, { from: 'system', threadOf, text: 'That chat is outside this project or is no longer available.' });
    return;
  }
  const askerName = asker === 'matt' ? 'Matt' : nameOf(asker, src);
  if (hop > HOP_LIMIT) {
    post(fromChatId, { from: 'system', threadOf, text: `${askerName} asked "${dst.title}", but chats have asked each other ${HOP_LIMIT} times in a row. Reply here to keep going.` });
    api.log('info', 'background ask refused: hop limit', { from: fromChatId, to: targetId, hop });
    return;
  }
  let loadError = null;
  try {
    await loadChat(dst);
  } catch (err) {
    loadError = err.message;
  }
  if (!otherChats(fromChatId).some(c => c.id === targetId)) {
    post(fromChatId, { from: 'system', threadOf, text: 'That chat is outside this project or is no longer available.' });
    return;
  }
  const owner = dst.thread ? dst.thread.members[0] : null;
  const runKey = owner ? runKeyOf(targetId, owner.id) : null;
  const side = post(fromChatId, { from: 'system', threadOf, text: `${askerName} asked "${dst.title}" in the background.`, side: { chatId: targetId, chatTitle: dst.title, asker, question: text, state: 'asking', hop, runKey, ...(group || {}) } });
  api.log('info', 'background ask', { from: fromChatId, to: targetId, asker, hop });
  if (!owner) {
    // The row must not sit at "asking…" forever when the chat can't be opened.
    api.log('error', 'background ask: could not open the chat', { to: targetId, error: loadError });
    settleSide(fromChatId, side, 'failed', `The chat "${dst.title}" couldn't be opened${loadError ? ` (${loadError})` : ''}.`);
    return;
  }
  if (pending[runKey]) {
    settleSide(fromChatId, side, 'busy', `${owner.name} in "${dst.title}" is busy answering something else. Try again once it's done.`);
    return;
  }
  post(targetId, { from: 'guest', to: owner.id, guest: { chatId: fromChatId, chatTitle: src.title, name: askerName }, text });
  ask(targetId, owner.id, null, { side: { chatId: fromChatId, messageId: side.id, hop } });
}

// Records how a background ask ended, and lets an agent that asked carry on
// with the answer (or with why there is none).
function settleSide(chatId, m, state, text) {
  const chat = chats.get(chatId);
  m.side.state = state;
  if (state === 'answered') m.side.answer = text;
  else m.side.note = text;
  persist(chat);
  redrawSide(chatId, m);
  renderChatList();
  api.log('info', 'background ask settled', { chatId, to: m.side.chatId, state });
  const asker = m.side.asker;
  if (asker === 'matt' || !memberById(chat.thread, asker)) return;
  if (pending[runKeyOf(chatId, asker)]) return;
  // One reply can ask several chats (TM-57): the asker carries on once every
  // one of them has settled, with all the answers.
  let asks = [m];
  if (m.side.group != null) {
    asks = chat.thread.messages.filter(x => x.side && x.side.group === m.side.group);
    if (asks.length < m.side.groupSize || asks.some(x => x.side.state === 'asking')) return;
  }
  const answers = asks.map(x => ({ chatTitle: x.side.chatTitle, text: x.side.state === 'answered' ? x.side.answer : x.side.note }));
  ask(chatId, asker, m.threadOf || null, { answer: answers, hop: m.side.hop });
}

function scrollToBottom(view) {
  view.list.scrollTop = view.list.scrollHeight;
}

function renderMessage(view, m) {
  if (m.side) {
    appendRow(view, sideRow(m));
    return;
  }
  if (m.from === 'guest') {
    const { row } = createRow(view, 'guest', `${m.guest.name} from "${m.guest.chatTitle}" · to ${nameOf(m.to)} · ${timeLabel(m.ts)}`, m.text);
    row.dataset.id = m.id;
    return;
  }
  if (m.handoff) {
    // Drawn from the ids, so a renamed agent shows its current name.
    const { row } = createRow(view, 'system', '', `${nameOf(m.handoff.from)} › ${nameOf(m.handoff.to)} · Sent to ${nameOf(m.handoff.to)} ›`);
    row.classList.add('handoff');
    return;
  }
  let metaText = `${nameOf(m.from)} · ${timeLabel(m.ts)}` + (m.endedAs ? ` · ${m.endedAs}` : '');
  if (m.from === 'matt') {
    metaText = m.relayOf
      ? `To ${nameOf(m.to)} · passing on ${nameOf(m.relayOf)}'s reply · ${timeLabel(m.ts)}`
      : `To ${nameOf(m.to)} · ${timeLabel(m.ts)}`;
  }
  const { row } = createRow(view, m.from, metaText, m.text);
  row.dataset.id = m.id;
  if (m.steps && m.steps.length) addSteps(row, m.steps);
  if (view === panel && m.id === panel.threadOf) row.classList.add('root');
  if (view === main && m.from !== 'system') {
    const buttons = [{ label: 'Thread', title: 'Open a thread on this message beside the chat', onClick: () => openPanel(m.id) }];
    if (/([a-zA-Z0-9_\-\/]+\.html|https?:\/\/localhost:\d+)/i.test(m.text)) {
      buttons.push({ label: '👁 Preview', title: 'Live preview in sidecar inspector', onClick: () => previewFromText(m.text) });
    }
    if (/(TM-\d+|notion\.(so|com))/i.test(m.text)) {
      buttons.push({ label: '📋 Glance Ticket', title: 'Glance Notion ticket card in inspector', onClick: () => glanceNotionFromText(m.text) });
    }
    addActions(row, buttons);
  }
}

function renderView(view) {
  removePendingRows(view);
  view.list.replaceChildren(...(view.empty ? [view.empty] : []));
  if (view === main) Object.keys(summaryRows).forEach(id => delete summaryRows[id]);
  const chat = current();
  if (!chat || (view === panel && !panelOpen())) return;
  if (view.empty) {
    view.empty.hidden = chat.thread.messages.length > 0;
    view.empty.textContent = `Say hi to ${chat.thread.members[0].name}. Type @ to bring in another agent.`;
  }
  for (const m of chat.thread.messages) {
    if (inView(view, m)) renderMessage(view, m);
  }
  // Summary rows only under messages that have a thread (or a reply coming
  // in one): asking every message would scan the whole history each time.
  if (view === main) {
    const roots = new Set(chat.thread.messages.filter(m => m.threadOf).map(m => m.threadOf));
    for (const p of Object.values(pending)) if (p.chatId === chat.id && p.threadOf) roots.add(p.threadOf);
    for (const id of roots) renderSummary(id);
  }
  renderPendingRows(view);
  scrollToBottom(view);
}

// What the main chat says under a thread's first message, or null for no thread:
// live while an agent answers in it, otherwise how many replies and from whom.
function threadSummary(rootId) {
  const msgs = current().thread.messages.filter(m => m.threadOf === rootId);
  const liveKey = Object.keys(pending).find(k => pending[k].chatId === currentId && pending[k].threadOf === rootId);
  if (liveKey) {
    const live = pending[liveKey].memberId;
    const hop = msgs.filter(m => m.handoff).pop();
    const text = hop && hop.handoff.to === live
      ? `${nameOf(hop.handoff.from)} ⇄ ${nameOf(live)} talking…`
      : `${nameOf(live)} replying in the thread…`;
    return { text, live, liveKey };
  }
  if (!msgs.length) return null;
  const replies = msgs.filter(m => m.from !== 'system');
  const who = [...new Set(replies.filter(m => m.from !== 'matt').map(m => nameOf(m.from)))];
  return { text: `${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}` + (who.length ? ` · ${who.join(', ')}` : '') };
}

// Draws or updates the summary row right under a thread's first message in the main chat.
function renderSummary(rootId) {
  const old = summaryRows[rootId];
  const info = threadSummary(rootId);
  if (!info) {
    if (old) old.remove();
    delete summaryRows[rootId];
    return;
  }
  const row = document.createElement('div');
  row.className = 'msg summary' + (info.live ? ' live' : '');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'summary-open';
  open.textContent = `${info.text}  ›`;
  open.title = 'Open the thread beside the chat';
  open.addEventListener('click', () => openPanel(rootId));
  row.appendChild(open);
  // One Stop ends the thread: a stopped reply never hands off.
  if (info.live) addActions(row, [{ label: 'Stop', title: `Stop ${nameOf(info.live)}`, onClick: () => stopRun(info.liveKey) }]);
  if (old) old.replaceWith(row);
  else {
    const rootRow = main.list.querySelector(`[data-id="${rootId}"]`);
    if (!rootRow) return;
    rootRow.after(row);
  }
  summaryRows[rootId] = row;
}

// The bubbles of replies still coming in always sit at the bottom of their view.
function renderPendingRows(view) {
  for (const [key, p] of Object.entries(pending)) {
    if (!pendingInView(view, p) || pendingRows[key]) continue;
    const r = createRow(view, p.memberId, '', p.text.trim());
    r.row.classList.add('pending');
    addActions(r.row, [{ label: 'Stop', title: `Stop ${nameOf(p.memberId)}`, onClick: () => stopRun(key) }]);
    pendingRows[key] = { ...r, view };
    updatePendingMeta(key);
  }
}

function removePendingRows(view) {
  for (const [key, r] of Object.entries(pendingRows)) {
    if (r.view !== view) continue;
    r.row.remove();
    delete pendingRows[key];
  }
}

function updatePendingMeta(key) {
  const p = pending[key];
  const r = pendingRows[key];
  if (!p || !r) return;
  // Antigravity can take ~30s, so the wait shows a seconds counter, and
  // what the agent is doing right now (TM-59) once it uses a tool.
  const secs = `${Math.round((Date.now() - p.started) / 1000)}s`;
  const now = p.steps.length ? p.steps[p.steps.length - 1] : null;
  r.meta.textContent = p.text && !now ? `${nameOf(p.memberId)} · replying…`
    : now ? `${nameOf(p.memberId)} · ${now} · ${secs}`
    : `${nameOf(p.memberId)} · thinking… ${secs}`;
  if (p.steps.length) {
    if (!r.steps) {
      r.steps = document.createElement('ol');
      r.steps.className = 'steps live';
      r.bubble.after(r.steps);
    }
    // The last few, newest at the bottom; the reply keeps all of them.
    r.steps.replaceChildren(...p.steps.slice(-4).map(t => Object.assign(document.createElement('li'), { textContent: t })));
  }
}

// An agent used a tool (TM-59): "Reading note.txt", "Running npm test".
function onStep({ runKey, run, step }) {
  const p = pendingFor(runKey, run);
  if (!p || !step) return;
  p.steps.push(step);
  updatePendingMeta(runKey);
}

// What an agent did while it answered, folded under its reply.
function addSteps(row, steps) {
  const d = document.createElement('details');
  d.className = 'steps';
  const s = document.createElement('summary');
  s.textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  const ol = document.createElement('ol');
  ol.replaceChildren(...steps.map(t => Object.assign(document.createElement('li'), { textContent: t })));
  d.append(s, ol);
  row.querySelector('.bubble').after(d);
}

setInterval(() => Object.keys(pendingRows).forEach(updatePendingMeta), 1000);

// A row of small buttons under a bubble.
function addActions(row, buttons) {
  const bar = document.createElement('div');
  bar.className = 'actions';
  for (const { label, title, onClick } of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    bar.appendChild(b);
  }
  row.appendChild(bar);
  return bar;
}

// A member's finished reply that @-names someone already in the chat brings
// them in. A vendor who is not in the chat is not joined from prose (models
// echo "@Claude"). @Name alone on its own line asks Matt to type it himself,
// unless his latest message already asked for that vendor.
function lastMattText(thread, threadOf) {
  let text = '';
  for (const m of thread.messages) {
    if ((m.threadOf || null) !== threadOf) continue;
    if (m.from === 'matt') text = m.text;
  }
  return text;
}

function handOff(chatId, m) {
  const chat = chats.get(chatId);
  const names = vendorNames();
  const target = findTarget(m.text, m.from, chat.thread.members, names);
  if (!target) return;
  const where = m.threadOf || null;
  const intent = joinIntent(m.text, target, { mattText: lastMattText(chat.thread, where), vendorNames: names });
  const name = (id) => nameOf(id, chat);
  const toName = target.memberId ? name(target.memberId) : vendorName(target.vendor);
  if (intent === 'ignore') return;
  if (intent === 'confirm') {
    post(chatId, { from: 'system', threadOf: where, text: `${name(m.from)} put @${toName} on its own line. Type @${toName} if you want them in this chat.` });
    api.log('info', 'join needs Matt', { chatId, where, from: m.from, vendor: target.vendor });
    return;
  }
  const hops = hopsSinceMatt(chat.thread, where);
  const limit = hopLimit(chat.thread);
  if (hops >= limit) {
    post(chatId, { from: 'system', threadOf: where, text: `${name(m.from)} asked for ${toName}, but the agents have handed off ${limit} times in a row. Reply here to keep going.` });
    api.log('info', 'hop limit reached', { chatId, where, from: m.from, to: target });
    return;
  }
  const to = target.memberId ? rejoin(chatId, target.memberId, where) : join(chatId, target.vendor, { threadOf: where }).id;
  if (pending[runKeyOf(chatId, to)]) {
    post(chatId, { from: 'system', threadOf: where, text: `${name(m.from)} asked for ${name(to)}. ${busyText(chatId, to)}` });
    return;
  }
  post(chatId, { from: 'system', threadOf: where, handoff: { from: m.from, to }, text: `${name(m.from)} › ${name(to)}` });
  api.log('info', 'handoff', { chatId, where, from: m.from, to, hop: hops + 1 });
  ask(chatId, to, where);
}

function busyText(chatId, memberId) {
  const name = nameOf(memberId, chats.get(chatId));
  return `${name} is still answering. Send it once ${name} is done, or stop it first.`;
}

// ---- Message boxes and the @ dropdown ---------------------------------------------

function autoGrow(view) {
  view.input.style.height = 'auto';
  // scrollHeight leaves out the border; without it the box always overflows by 2px.
  view.input.style.height = (view.input.scrollHeight + view.input.offsetHeight - view.input.clientHeight) + 'px';
}

// Who the text in a view's box would go to: { memberId } or { vendor } (joins).
function target(view) {
  return routeMessage(current().thread, view.input.value, view.threadOf, vendorNames());
}

function updatePlaceholder(view) {
  if (!current() || (view === panel && !panelOpen())) return;
  const to = routeMessage(current().thread, '', view.threadOf, vendorNames()).memberId;
  view.input.placeholder = view === main ? `Message ${nameOf(to)}… (@ agent, # ask another chat)` : `Reply to ${nameOf(to)} in the thread… (@ agent, # another chat)`;
}

// Send is off while the box is empty or the agent it would go to is still
// answering (a new launch would cut its reply off; use Stop instead).
function updateSendButton(view) {
  const chatAsks = current() ? splitChatAsks(view.input.value, otherChats(currentId)) : [];
  if (chatAsks.length) {
    view.send.disabled = false;
    view.send.title = `Asks ${chatAsks.map(a => `"${chats.get(a.chatId).title}"`).join(' and ')} in the background`;
    return;
  }
  const t = current() && view.input.value.trim() ? target(view) : null;
  const busy = Boolean(t && t.memberId && pending[runKeyOf(currentId, t.memberId)]);
  view.send.disabled = !t || busy;
  view.send.title = busy ? busyText(currentId, t.memberId)
    : t && t.vendor ? `${vendorName(t.vendor)} isn't in this chat yet: it joins on its default model`
    : t && memberById(current().thread, t.memberId).left ? `${nameOf(t.memberId)} left this chat: it joins again`
    : t ? `Goes to ${nameOf(t.memberId)}` : '';
}

function updateSendButtons() {
  openViews().forEach(updateSendButton);
}

function send(view) {
  const text = view.input.value.trim();
  if (!text || !current()) return;
  // #chat: ask that chat in the background; the answer lands in a row here.
  const chatAsks = splitChatAsks(text, otherChats(currentId));
  if (chatAsks.length) {
    view.input.value = '';
    autoGrow(view);
    closeMentions(view);
    for (const a of chatAsks) askChat({ fromChatId: currentId, asker: 'matt', text: a.question, targetId: a.chatId, hop: 1, threadOf: view.threadOf });
    return;
  }
  const t = target(view);
  if (t.memberId && pending[runKeyOf(currentId, t.memberId)]) return;
  const to = t.memberId ? rejoin(currentId, t.memberId, view.threadOf) : join(currentId, t.vendor, { threadOf: view.threadOf }).id;
  post(currentId, { from: 'matt', to, text, threadOf: view.threadOf });
  view.input.value = '';
  autoGrow(view);
  closeMentions(view);
  ask(currentId, to, view.threadOf);
}

// The `@word` being typed right before the cursor, or null.
// The `@word` or `#chat` being typed right before the cursor, or null. A chat
// title may have spaces, so `#` reads to the cursor.
function mentionQuery(view) {
  const before = view.input.value.slice(0, view.input.selectionStart);
  const m = /(^|\s)@([\w-]*)$/.exec(before) || /(^|\s)#([^#@\n]{0,60})$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, sigil: before[before.length - m[2].length - 1], query: m[2].toLowerCase() };
}

// What the dropdown offers. For @, our three vendors (Matt, TM-54): one
// already in the chat is reached by its name; one that isn't joins on its
// default model. For #, the other chats, to ask in the background.
function mentionItems(q) {
  if (q.sigil === '#') {
    return otherChats(currentId).filter(c => c.title.toLowerCase().startsWith(q.query)).slice(0, 8)
      .map(c => ({ key: c.id, label: c.title, sub: 'ask in the background', color: null, insert: `#${c.title} ` }));
  }
  const members = current().thread.members;
  const status = (n) => {
    const m = members.find(x => x.name.toLowerCase() === n.toLowerCase());
    return !m ? 'joins on its default model' : m.left ? 'left: joins again' : 'in this chat';
  };
  return VENDORS.filter(v => vendorName(v).toLowerCase().startsWith(q.query)).map(v => ({
    key: v, label: vendorName(v), color: vendors[v] ? vendors[v].color : '#888', insert: `@${vendorName(v)} `,
    sub: status(vendorName(v))
  }));
}

function updateMentions(view) {
  const q = mentionQuery(view);
  const items = q && current() ? mentionItems(q) : [];
  if (!items.length) return closeMentions(view);
  if (view.mention.items.map(i => i.key).join() !== items.map(i => i.key).join()) view.mention.index = 0;
  view.mention.items = items;
  view.mentions.replaceChildren();
  items.forEach((item, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention' + (i === view.mention.index ? ' active' : '');
    b.style.setProperty('--agent-color', item.color || 'var(--line)');
    const name = document.createElement('span');
    name.className = 'mention-name';
    name.textContent = item.label;
    const sub = document.createElement('span');
    sub.className = 'mention-sub';
    sub.textContent = item.sub;
    b.append(name, sub);
    // mousedown, not click: the box must keep focus and its cursor.
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(view, item); });
    view.mentions.appendChild(b);
  });
  view.mentions.hidden = false;
}

function closeMentions(view) {
  view.mention.items = [];
  view.mentions.hidden = true;
}

function pickMention(view, item) {
  const q = mentionQuery(view);
  if (!q) return closeMentions(view);
  const end = view.input.selectionStart;
  view.input.value = view.input.value.slice(0, q.start) + item.insert + view.input.value.slice(end);
  const caret = q.start + item.insert.length;
  view.input.setSelectionRange(caret, caret);
  closeMentions(view);
  autoGrow(view);
  updateSendButton(view);
}

function wireComposer(view) {
  view.form.addEventListener('submit', (e) => {
    e.preventDefault();
    send(view);
  });
  view.input.addEventListener('keydown', (e) => {
    // While the @ dropdown is open, arrows move in it and Enter or Tab picks.
    const items = view.mention.items;
    if (!view.mentions.hidden && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        view.mention.index = (view.mention.index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        updateMentions(view);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(view, items[view.mention.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentions(view);
        return;
      }
    }
    if (e.key === 'Escape' && view === panel) {
      closePanel();
      main.input.focus();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(view);
    }
  });
  view.input.addEventListener('input', () => {
    autoGrow(view);
    updateMentions(view);
    updateSendButton(view);
  });
  view.input.addEventListener('click', () => updateMentions(view));
  view.input.addEventListener('blur', () => closeMentions(view));
}

// ---- Runs -------------------------------------------------------------------

// Stop for a reply: kills the process once launched; before that (the brain
// files are still being read) it ends the reply here, so the launch never
// happens and the member isn't left "working" with nothing running.
function stopRun(runKey) {
  const p = pending[runKey];
  if (p && !p.launched) finishReply(runKey, null, null, { stopped: true });
  else api.stop(runKey);
}

// Launches a member with the chat so far and opens a bubble for its reply.
// threadOf: the thread it answers in, or null for the main chat. extra
// (background asks): side ({ chatId, messageId, hop }) when this reply answers
// another chat; answer ({ chatTitle, text }, or a list of them) for an asker's follow-up; hop,
// how many chats have asked each other so far in this chain.
async function ask(chatId, memberId, threadOf = null, { side = null, answer = null, hop = 0 } = {}) {
  const thread = chats.get(chatId).thread;
  const member = memberById(thread, memberId);
  // The newest 15 other chats with real titles, so the agent can ask one with #.
  const chatTitles = otherChats(chatId).filter(c => c.title !== 'New chat')
    .sort((a, b) => (chats.get(a.id).updatedAt < chats.get(b.id).updatedAt ? 1 : -1)).slice(0, 15).map(c => c.title);
  // Its vendor session for this place (TM-55): the main chat, or one thread.
  // Resuming sends only what's new since it last saw the chat.
  const where = threadOf === null ? 'main' : String(threadOf);
  const session = (member.sessions || {})[where] || null;
  // The reply is pending from here, before the brain files are read (an
  // await): Send stays off, so a second send can't launch the agent twice.
  const runKey = runKeyOf(chatId, memberId);
  const p = pending[runKey] = {
    chatId, memberId, threadOf, side, answer, hop: side ? side.hop : hop, text: '', stderr: '', steps: [], started: Date.now(),
    where, sessionId: session ? session.id : null, seenUpTo: thread.nextId - 1, brainSig: '', launched: false
  };
  if (chatId === currentId) {
    openViews().forEach(renderPendingRows);
    renderMembers();
    if (threadOf !== null) renderSummary(threadOf);
  }
  renderChatList();
  updateSendButtons();

  // TM-60 Batch 4: Dynamic Central Brain & Persona Chip Resolution
  let centralBrain = null;
  let personaChip = null;
  let personaSkills = [];
  let brainUpdate = null;
  let files = null;
  try {
    const resolved = await api.resolveBrains({ personaFile: member.brain });
    if (resolved && resolved.central) centralBrain = resolved.central.text;
    if (resolved && resolved.persona) personaChip = resolved.persona.text;
  } catch (err) {
    api.log('warn', 'brain resolution failed', { error: err.message });
  }

  // Skills (TM-60 Batch 2): the Central Brain and the engine's skills go into
  // the chat folder as the file this CLI reads on its own; persona skills
  // ride in the prompt. Grok has no such file, so it keeps both in the prompt.
  try {
    const [org, skills] = await Promise.all([api.getOrg(), api.listSkills()]);
    const mine = skillsFor({ vendor: member.vendor, persona: personaIdOf(member), own: member.skills }, skills || [], (org && org.skills) || {});
    const file = folderFile(member.vendor);
    if (file) {
      files = { [file]: folderText(centralBrain, mine.engine) };
      centralBrain = null;
    } else if (mine.engine.length) {
      centralBrain = `${centralBrain || ''}\n\n${mine.engine.map(s => s.text.trim()).join('\n\n')}`;
    }
    personaSkills = mine.persona;
  } catch (err) {
    api.log('warn', 'skills resolution failed', { error: err.message });
  }
  // MCP servers (TM-60 Batch 3): what the directory gives this member (all,
  // its engine, its persona, or picked in the Builder). Only Claude takes
  // them per launch; the other CLIs use their own lists.
  let mcp = null;
  if (member.vendor === 'claude') {
    try {
      const [org, servers] = await Promise.all([api.getOrg(), api.listMcps()]);
      const mine = mcpFor({ vendor: member.vendor, persona: personaIdOf(member), own: member.mcp }, servers || [], (org && org.mcp) || {});
      if (mine.length) mcp = claudeMcpConfig(mine);
    } catch (err) {
      api.log('warn', 'mcp resolution failed', { error: err.message });
    }
  }
  if (pending[runKey] !== p) return; // stopped or replaced while the brains were read
  // What rides in this agent's prompt header (the folder file carries the
  // rest). A resumed session only saw the header once, so when this text
  // differs from what the session last got (an edit, a new skill, or a
  // session from before the brains worked), the launch carries it again.
  const promptBrain = promptGuidance(member, { centralBrain, personaChip, personaSkills });
  p.brainSig = promptBrain ? textSig(promptBrain) : '';
  if (session && p.brainSig !== (session.brainSig || '')) brainUpdate = promptBrain || 'No additional directives remain. Discard the previous additional directives.';
  // The prompt answers the chat as it was when this reply was asked for
  // (upTo): a message to someone else posted during the awaits above is not
  // this member's to answer, and must not strand it as "working".
  let prompt;
  try {
    prompt = buildPrompt(thread, memberId, {
      threadOf,
      answer,
      chatTitles,
      since: session ? session.lastId : null,
      centralBrain,
      personaChip,
      personaSkills,
      brainUpdate,
      projectName: projectNameFor(chatId),
      upTo: p.seenUpTo
    });
  } catch (err) {
    api.log('error', 'could not build the prompt', { runKey, error: err.message });
    finishReply(runKey, null, `the app couldn't build its prompt (${err.message})`);
    return;
  }

  p.launched = true;
  api.run({ runKey, vendor: member.vendor, model: member.model, sessionId: p.sessionId, prompt, files, mcp }).then((started) => {
    if (started === false) finishReply(runKey, null, 'it could not be started');
    else if (pending[runKey] === p) p.run = started;
  }).catch((err) => finishReply(runKey, null, err.message));
}

// An event belongs to the reply pending under its runKey unless it comes
// from an earlier launch of the same key that was superseded (its late
// output or exit must not land in, or end, the newer reply).
function pendingFor(runKey, run) {
  const p = pending[runKey];
  return p && (p.run == null || run == null || run === p.run) ? p : null;
}

function onOutput({ runKey, run, stream, text }) {
  const p = pendingFor(runKey, run);
  if (!p || !text) return;
  if (stream === 'stderr') {
    p.stderr = (p.stderr + text).slice(-2000);
    return;
  }
  p.text += text;
  // An answer to another chat streams into that chat's ask row too.
  if (p.side && p.side.chatId === currentId) {
    for (const view of openViews()) {
      const a = view.list.querySelector(`.msg.side[data-id="${p.side.messageId}"] .side-a`);
      if (a) a.textContent = p.text.trim();
    }
  }
  const r = pendingRows[runKey];
  if (!r) return;
  const list = r.view.list;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  r.bubble.textContent = p.text.trim();
  updatePendingMeta(runKey);
  if (atBottom) scrollToBottom(r.view);
}

// Turns the streamed reply into a message in its chat, or reports why there is none.
// outcome: { stopped, timedOut, timeoutSec } from agent:done.
// outcome also carries what the vendor reported (TM-55): sessionId, usage, plan.
function finishReply(runKey, code, why, { stopped = false, timedOut = false, timeoutSec = 0, sessionId = null, usage = null, plan = null } = {}) {
  const p = pending[runKey];
  if (!p) return;
  delete pending[runKey];
  if (pendingRows[runKey]) {
    pendingRows[runKey].row.remove();
    delete pendingRows[runKey];
  }
  const name = nameOf(p.memberId, chats.get(p.chatId));
  const member = memberById(chats.get(p.chatId).thread, p.memberId);
  if (plan && member) {
    plans[member.vendor] = { ...plan, at: Date.now() };
    try { localStorage.setItem('plans', JSON.stringify(plans)); } catch (_) { /* storage off: shown until restart */ }
    renderPlan();
  }
  // A saved session that couldn't be resumed (expired, deleted): forget it and
  // ask again once with a fresh session and the usual recent history. An
  // agent that used tools but said nothing did resume, so it keeps its session.
  if (p.sessionId && member && !p.text.trim() && !p.steps.length && !stopped && !timedOut && !why) {
    delete member.sessions[p.where];
    post(p.chatId, { from: 'system', threadOf: p.threadOf || null, text: `${name}'s saved session couldn't be resumed, so it's starting a fresh one.` });
    api.log('warn', 'session resume failed, starting fresh', { runKey, code, sessionId: p.sessionId });
    ask(p.chatId, p.memberId, p.threadOf || null, { side: p.side, answer: p.answer, hop: p.hop });
    return;
  }
  // Remember the session to resume next time, and what it has seen; usage for the meter.
  if (member && sessionId && !stopped && !timedOut) {
    member.sessions = {
      ...(member.sessions || {}),
      [p.where]: { id: sessionId, lastId: p.seenUpTo, brainSig: p.brainSig || '' }
    };
  }
  if (member && usage) member.usage = { ...usage, at: new Date().toISOString() };
  const reply = p.text.trim();
  const threadOf = p.threadOf || null;
  let m = null;
  if (reply) {
    m = post(p.chatId, { from: p.memberId, text: reply, endedAs: stopped ? 'stopped' : timedOut ? 'timed out' : null, threadOf, steps: p.steps });
  }
  if (timedOut) {
    post(p.chatId, { from: 'system', threadOf, text: `${name} took longer than ${durationLabel(timeoutSec)} and was stopped.` + (reply ? ' Its reply so far is above.' : '') + ' The limit is timeoutSec in config.json.' });
    api.log('warn', 'agent timed out', { runKey, timeoutSec });
  } else if (stopped) {
    if (!reply) post(p.chatId, { from: 'system', threadOf, text: `${name} was stopped before it replied.` });
  } else if (code !== 0 || !reply) {
    const notFound = /ENOENT/.test(p.stderr);
    const reason = why || (notFound ? `the app couldn't find ${name}. Check its path in config.json`
      : code === 0 ? 'it finished without saying anything' : `it exited with code ${code}`);
    const detail = p.stderr.trim().split(/\r?\n/).slice(-3).join('\n');
    const lastStep = p.steps.length ? `\nIts last step: ${p.steps[p.steps.length - 1]}.` : '';
    post(p.chatId, { from: 'system', threadOf, text: `${name} didn't reply: ${reason}.` + lastStep + (detail ? `\n${detail}` : '') });
    api.log('warn', 'agent gave no reply', { runKey, code, why: why || null });
  } else {
    // #chat asks other chats in the background; otherwise @ may hand off
    // here, unless this reply answers another chat's question (TM-57): an
    // agent answering a background ask can't pull agents into its chat.
    const chatAsks = splitChatAsks(m.text, otherChats(p.chatId));
    const group = chatAsks.length > 1 ? { group: m.id, groupSize: chatAsks.length } : null;
    for (const a of chatAsks) askChat({ fromChatId: p.chatId, asker: p.memberId, text: a.question, targetId: a.chatId, hop: (p.hop || 0) + 1, threadOf, group });
    if (!chatAsks.length && !p.side) handOff(p.chatId, m);
  }
  // This reply answered another chat: settle that chat's ask.
  if (p.side) {
    const src = chats.get(p.side.chatId);
    const sm = src && src.thread && src.thread.messages.find(x => x.id === p.side.messageId);
    if (sm) {
      if (reply && !stopped && !timedOut && code === 0) settleSide(p.side.chatId, sm, 'answered', reply);
      else if (stopped) settleSide(p.side.chatId, sm, 'stopped', `${name} was stopped before it finished answering.` + (reply ? ` What it had so far: ${reply}` : ''));
      else settleSide(p.side.chatId, sm, 'failed', `${name} didn't answer` + (timedOut ? ' in time.' : '.'));
    }
  }
  if (p.chatId === currentId) {
    if (threadOf !== null) renderSummary(threadOf);
    renderMembers();
  }
  renderChatList();
  updateSendButtons();
}

// ---- Organization Control Deck (TM-60 Batch 5) -----------------------------

let isOrgControlOpen = false;
let activeOrgTab = 'memory'; // 'memory' | 'personas' | 'mcps' | 'skills' | 'builder'

function openOrgControl(tab = 'memory') {
  isOrgControlOpen = true;
  activeOrgTab = tab;
  if (el.orgControl) el.orgControl.hidden = false;
  if (el.navOrgBtn) el.navOrgBtn.classList.add('active');
  hideChooser();
  renderOrgDeck();
}

function closeOrgControl() {
  isOrgControlOpen = false;
  if (el.orgControl) el.orgControl.hidden = true;
  if (el.navOrgBtn) el.navOrgBtn.classList.remove('active');
}

function setOrgTab(tab) {
  activeOrgTab = tab;
  renderOrgDeck();
}

function getChipDeploymentStats() {
  const stats = {};
  for (const [cId, chat] of chats) {
    if (!chat || !chat.thread || !chat.thread.members) continue;
    for (const m of chat.thread.members) {
      if (m.left) continue;
      const b = m.brain || 'unassigned';
      if (!stats[b]) stats[b] = [];
      stats[b].push({ chatId: cId, chatTitle: chat.title || 'Untitled', memberName: m.name, vendor: m.vendor });
    }
  }
  return stats;
}

async function renderOrgDeck() {
  if (!el.orgBody) return;
  el.orgBody.replaceChildren();

  const tabBtns = [el.orgTabMemory, el.orgTabPersonas, el.orgTabMcps, el.orgTabSkills, el.orgTabBuilder];
  tabBtns.forEach(btn => {
    if (btn) btn.classList.toggle('active', btn.dataset.tab === activeOrgTab);
  });

  const panel = document.createElement('div');
  panel.className = 'org-panel';
  el.orgBody.appendChild(panel);

  if (activeOrgTab === 'memory') {
    await renderOrgMemory(panel);
  } else if (activeOrgTab === 'personas') {
    await renderOrgPersonas(panel);
  } else if (activeOrgTab === 'mcps') {
    await renderOrgMcps(panel);
  } else if (activeOrgTab === 'skills') {
    await renderOrgSkills(panel);
  } else if (activeOrgTab === 'builder') {
    await renderOrgBuilder(panel);
  }
}

async function renderOrgMemory(panel) {
  const card = document.createElement('div');
  card.className = 'org-section-card';

  const head = document.createElement('div');
  head.className = 'org-card-head';
  const title = document.createElement('div');
  title.className = 'org-card-title';
  title.textContent = '🧠 Central Brain (MMS Operating Doctrine)';
  const badge = document.createElement('span');
  badge.className = 'org-card-badge';
  badge.textContent = '● Active across all agents · Synced';
  head.append(title, badge);

  const desc = document.createElement('p');
  desc.className = 'org-item-desc';
  desc.textContent = 'Foundational institutional memory, workspace boundaries, engine labor division, and collaboration rules. Automatically inherited by every teammate across all chats. Save to hot-reload directly into all active sessions.';

  const editorWrap = document.createElement('div');
  editorWrap.className = 'org-editor-wrap';

  const textarea = document.createElement('textarea');
  textarea.className = 'org-textarea';
  textarea.rows = 15;

  let centralData = null;
  try {
    centralData = await api.getCentralBrain();
    if (centralData) textarea.value = centralData.text;
  } catch (_) {}

  const actions = document.createElement('div');
  actions.className = 'org-editor-actions';

  const meta = document.createElement('div');
  meta.className = 'org-meta-info';
  meta.textContent = centralData ? `File: brains/${centralData.file} · Synced: ${new Date(centralData.mtime).toLocaleTimeString()}` : 'File: brains/central-brain.md';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'org-save-btn';
  saveBtn.textContent = '💾 Save & Push to All Active Agents';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const res = await api.saveCentralBrain(textarea.value);
      saveBtn.textContent = '✓ Pushed to All Agents!';
      meta.textContent = `File: brains/${res.file} · Pushed: ${new Date(res.mtime).toLocaleTimeString()}`;
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save & Push to All Active Agents';
      }, 2000);
    } catch (_) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Error saving';
    }
  });

  actions.append(meta, saveBtn);
  editorWrap.append(textarea, actions);
  card.append(head, desc, editorWrap);
  panel.appendChild(card);
}

async function renderOrgPersonas(panel) {
  // Chats not opened yet this session have no members in memory; read them,
  // so the deployment counts cover every chat, not only the ones opened.
  await Promise.all([...chats.values()].filter(c => !c.thread).map(c => loadChat(c).catch((err) => api.log('warn', 'could not read a chat for the persona counts', { id: c.id, error: err.message }))));
  const stats = getChipDeploymentStats();

  const topCard = document.createElement('div');
  topCard.className = 'org-section-card';
  const topHead = document.createElement('div');
  topHead.className = 'org-card-head';
  const topTitle = document.createElement('div');
  topTitle.className = 'org-card-title';
  topTitle.textContent = '💾 Specialized Persona Chips (Operational Roles)';
  const topBadge = document.createElement('span');
  topBadge.className = 'org-card-badge';
  topBadge.textContent = 'Dynamic Disk Hot-Reloading';
  topHead.append(topTitle, topBadge);

  const topDesc = document.createElement('p');
  topDesc.className = 'org-item-desc';
  topDesc.textContent = 'Specialized persona directives layered on top of the Central Brain. Track deployment across active chats and edit chip directives directly on disk.';
  topCard.append(topHead, topDesc);
  panel.appendChild(topCard);

  // Chip creation card
  const createCard = document.createElement('div');
  createCard.className = 'org-section-card';
  const createTitle = document.createElement('div');
  createTitle.className = 'org-card-title';
  createTitle.textContent = '➕ Forge New Persona Chip';
  const formRow = document.createElement('div');
  formRow.className = 'org-form-row';
  const nameInput = document.createElement('input');
  nameInput.className = 'org-input';
  nameInput.placeholder = 'Chip Name (e.g. Database Architect, Fuzzing Specialist)';
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'org-action-btn primary';
  createBtn.textContent = 'Forge Chip';
  formRow.append(nameInput, createBtn);
  createCard.append(createTitle, formRow);

  createBtn.addEventListener('click', async () => {
    const val = nameInput.value.trim();
    if (!val) return;
    createBtn.disabled = true;
    try {
      await api.createPersonaBrain(val);
      nameInput.value = '';
      renderOrgDeck();
    } catch (_) {
      createBtn.disabled = false;
    }
  });
  panel.appendChild(createCard);

  // List chips in grid
  const grid = document.createElement('div');
  grid.className = 'org-grid-2';

  let brains = [];
  try {
    brains = await api.listBrains();
  } catch (_) {}

  for (const b of brains) {
    const chipCard = document.createElement('div');
    chipCard.className = 'org-item-card';

    const cHead = document.createElement('div');
    cHead.className = 'org-item-head';
    const cTitle = document.createElement('div');
    cTitle.className = 'org-item-title';
    cTitle.textContent = b.title || b.file;

    const deployed = stats[b.file] || [];
    const invBadge = document.createElement('span');
    invBadge.className = 'org-inventory-badge';
    invBadge.textContent = deployed.length ? `● ${deployed.length} active agent${deployed.length > 1 ? 's' : ''}` : '○ 0 deployed';
    cHead.append(cTitle, invBadge);

    const cDesc = document.createElement('div');
    cDesc.className = 'org-item-desc';
    if (deployed.length) {
      cDesc.textContent = `Deployed in: ${deployed.map(d => `${d.memberName} ("${d.chatTitle}")`).join(', ')}`;
    } else {
      cDesc.textContent = `File: brains/${b.file} · Ready to equip on any teammate.`;
    }

    const editorBox = document.createElement('textarea');
    editorBox.className = 'org-textarea';
    editorBox.style.minHeight = '140px';
    editorBox.value = b.text;
    editorBox.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'org-item-actions';
    const toggleEditBtn = document.createElement('button');
    toggleEditBtn.type = 'button';
    toggleEditBtn.className = 'org-action-btn';
    toggleEditBtn.textContent = 'Edit Directives';

    const saveChipBtn = document.createElement('button');
    saveChipBtn.type = 'button';
    saveChipBtn.className = 'org-action-btn primary';
    saveChipBtn.textContent = 'Save & Push Down';
    saveChipBtn.hidden = true;

    toggleEditBtn.addEventListener('click', () => {
      const isEditing = !editorBox.hidden;
      editorBox.hidden = isEditing;
      saveChipBtn.hidden = isEditing;
      toggleEditBtn.textContent = isEditing ? 'Edit Directives' : 'Collapse';
    });

    saveChipBtn.addEventListener('click', async () => {
      saveChipBtn.disabled = true;
      saveChipBtn.textContent = 'Saving…';
      try {
        await api.savePersonaBrain(b.file, editorBox.value);
        saveChipBtn.textContent = '✓ Saved!';
        setTimeout(() => {
          saveChipBtn.disabled = false;
          saveChipBtn.textContent = 'Save & Push Down';
        }, 1500);
      } catch (_) {
        saveChipBtn.disabled = false;
        saveChipBtn.textContent = 'Error';
      }
    });

    actions.append(toggleEditBtn, saveChipBtn);
    chipCard.append(cHead, cDesc, editorBox, actions);
    grid.appendChild(chipCard);
  }
  panel.appendChild(grid);
}

// Secrets in a command line ("--header X-Goog-Api-Key: …") are hidden on screen.
function maskSecrets(text) {
  return String(text || '').replace(/((?:key|token|secret|password)\s*[:=]\s*)\S+/gi, '$1••••');
}

// MCP Directory (TM-60 Batch 3): the servers Daycare knows, who gets them,
// and what each CLI already has. Only a Claude agent takes its servers at
// launch; Gemini, Codex and Grok keep their own lists.
async function renderOrgMcps(panel) {
  const topCard = document.createElement('div');
  topCard.className = 'org-section-card';
  const topHead = document.createElement('div');
  topHead.className = 'org-card-head';
  const topTitle = document.createElement('div');
  topTitle.className = 'org-card-title';
  topTitle.textContent = '🔌 MCP Directory';
  const topBadge = document.createElement('span');
  topBadge.className = 'org-card-badge';
  topBadge.textContent = 'Claude: per launch · others: show what they have';
  topHead.append(topTitle, topBadge);
  const topDesc = document.createElement('p');
  topDesc.className = 'org-item-desc';
  topDesc.textContent = "Servers Daycare knows, kept in mcp-servers.json beside config.json (never in git, since entries can carry keys). Give one to all agents, engines or personas. A Claude agent receives its servers when it launches. Gemini, Codex and Grok keep their own lists, so each card shows which of them already has the server; adding it to those CLIs is still done in the CLI (agy mcp add, codex mcp add, grok mcp add).";
  topCard.append(topHead, topDesc);
  panel.appendChild(topCard);

  let servers = [];
  let org = { mcp: {} };
  let cli = {};
  try {
    [servers, org, cli] = await Promise.all([api.listMcps(), api.getOrg(), api.listCliMcps()]);
    org = org || { mcp: {} };
    cli = cli || {};
  } catch (err) {
    api.log('warn', 'mcp directory could not load', { error: err.message });
  }
  const cliHas = (vendor, s) => ((cli[vendor] || []).some(x => x.enabled && (x.name.toLowerCase() === s.name.toLowerCase() || x.name.toLowerCase() === s.id)));

  // Add a server by hand.
  const addCard = document.createElement('div');
  addCard.className = 'org-section-card';
  const addTitle = document.createElement('div');
  addTitle.className = 'org-card-title';
  addTitle.textContent = '➕ Add a server';
  const formRow = document.createElement('div');
  formRow.className = 'org-form-row';
  const nameInput = document.createElement('input');
  nameInput.className = 'org-input';
  nameInput.placeholder = 'Name (e.g. SQLite)';
  const cmdInput = document.createElement('input');
  cmdInput.className = 'org-input';
  cmdInput.placeholder = 'Command line (npx -y @modelcontextprotocol/server-sqlite) or an https:// URL';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'org-action-btn primary';
  addBtn.textContent = 'Add';
  formRow.append(nameInput, cmdInput, addBtn);
  const addNote = document.createElement('div');
  addNote.className = 'org-meta-info';
  addNote.textContent = 'Keys go in the command line as the CLI would take them; they are hidden on screen.';
  addCard.append(addTitle, formRow, addNote);
  addBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const line = cmdInput.value.trim();
    if (!name || !line) return;
    addBtn.disabled = true;
    try {
      const server = /^https?:\/\//i.test(line) ? { name, url: line } : { name, ...parseCommandLine(line) };
      await api.saveMcp(server);
      renderOrgDeck();
    } catch (err) {
      addNote.textContent = `Could not add: ${err.message}`;
      addBtn.disabled = false;
    }
  });
  panel.appendChild(addCard);

  // Import from Gemini: its list shows full command lines.
  const known = new Set(servers.map(s => s.name.toLowerCase()));
  const importable = (cli.antigravity || []).filter(x => x.enabled && !known.has(x.name.toLowerCase()));
  if (importable.length) {
    const impCard = document.createElement('div');
    impCard.className = 'org-section-card';
    const impTitle = document.createElement('div');
    impTitle.className = 'org-card-title';
    impTitle.textContent = `📥 In Gemini's CLI but not here (${importable.length})`;
    const impRow = document.createElement('div');
    impRow.className = 'org-item-actions wrap';
    for (const x of importable) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'org-action-btn';
      b.textContent = `Import ${x.name}`;
      b.title = maskSecrets(x.command);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const server = x.type === 'http' ? { name: x.name, url: x.command } : { name: x.name, ...parseCommandLine(x.command), description: 'Imported from Gemini (agy mcp list)' };
          await api.saveMcp(server);
          renderOrgDeck();
        } catch (_) { b.disabled = false; }
      });
      impRow.appendChild(b);
    }
    impCard.append(impTitle, impRow);
    panel.appendChild(impCard);
  }

  const grid = document.createElement('div');
  grid.className = 'org-grid-2';
  for (const s of servers) {
    const card = document.createElement('div');
    card.className = 'org-item-card';
    const head = document.createElement('div');
    head.className = 'org-item-head';
    const title = document.createElement('div');
    title.className = 'org-item-title';
    title.textContent = s.name;
    const live = document.createElement('span');
    live.className = 'org-inventory-badge';
    const haves = ['antigravity', 'codex', 'grok'].filter(v => cliHas(v, s)).map(v => vendorName(v));
    live.textContent = haves.length ? `in ${haves.join(', ')}` : 'in no CLI yet';
    live.title = 'Which of Gemini, Codex and Grok list this server (read live). Claude gets it at launch.';
    head.append(title, live);
    const desc = document.createElement('div');
    desc.className = 'org-item-desc';
    const given = (a) => `${s.description ? s.description + ' · ' : ''}given to: ${describeAssignment(a, vendorNames(), teammates(org))}`;
    desc.textContent = given((org.mcp || {})[s.id]);
    const cmd = document.createElement('div');
    cmd.className = 'org-meta-info';
    cmd.textContent = s.url ? s.url : maskSecrets([s.command, ...(s.args || [])].join(' '));
    const assign = assignmentRow((org.mcp || {})[s.id], async (a) => {
      org.mcp = { ...(org.mcp || {}), [s.id]: a };
      try {
        org = await api.saveOrg(org);
        desc.textContent = given((org.mcp || {})[s.id]);
      } catch (err) {
        desc.textContent = `Could not save: ${err.message}`;
      }
    }, teammates(org));
    const actions = document.createElement('div');
    actions.className = 'org-item-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'org-action-btn';
    remove.textContent = 'Remove from directory';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try { await api.removeMcp(s.id); renderOrgDeck(); } catch (_) { remove.disabled = false; }
    });
    actions.appendChild(remove);
    card.append(head, desc, cmd, assign, actions);
    grid.appendChild(card);
  }
  if (!servers.length) {
    const empty = document.createElement('p');
    empty.className = 'org-item-desc';
    empty.textContent = 'No servers yet. Add one above, or import from Gemini.';
    grid.appendChild(empty);
  }
  panel.appendChild(grid);
}

// Tick boxes for an assignment: "All agents", then each engine and each saved
// persona. onChange gets the new { all, engines, personas }.
function assignmentRow(current, onChange, team = null) {
  const a = { all: Boolean(current && current.all), engines: [...((current && current.engines) || [])], personas: [...((current && current.personas) || [])] };
  const row = document.createElement('div');
  row.className = 'assign-row';
  const label = document.createElement('span');
  label.className = 'assign-label';
  label.textContent = 'Give to';
  row.appendChild(label);
  const boxes = [];
  const box = (text, checked, onToggle, cls = '') => {
    const l = document.createElement('label');
    l.className = 'assign-box' + (cls ? ` ${cls}` : '');
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = checked;
    c.addEventListener('change', () => { onToggle(c.checked); sync(); onChange({ ...a }); });
    const t = document.createElement('span');
    t.textContent = text;
    l.append(c, t);
    row.appendChild(l);
    boxes.push({ c, l });
    return c;
  };
  const allBox = box('All agents', a.all, (on) => { a.all = on; }, 'all');
  const engineBoxes = VENDORS.map(v => box(vendorName(v), a.engines.includes(v), (on) => {
    a.engines = on ? [...new Set([...a.engines, v])] : a.engines.filter(x => x !== v);
  }));
  const personaBoxes = (team || Object.values(PERSONAS)).map(p => box(p.name, a.personas.includes(p.id), (on) => {
    a.personas = on ? [...new Set([...a.personas, p.id])] : a.personas.filter(x => x !== p.id);
  }, 'persona'));
  // With "All agents" on, the single boxes don't matter, so they grey out.
  const sync = () => { for (const c of [...engineBoxes, ...personaBoxes]) { c.disabled = allBox.checked; c.closest('label').classList.toggle('muted', allBox.checked); } };
  sync();
  return row;
}

async function renderOrgSkills(panel) {
  const topCard = document.createElement('div');
  topCard.className = 'org-section-card';
  const topHead = document.createElement('div');
  topHead.className = 'org-card-head';
  const topTitle = document.createElement('div');
  topTitle.className = 'org-card-title';
  topTitle.textContent = '⚡ Operational Skills & Playbooks Library';
  const topBadge = document.createElement('span');
  topBadge.className = 'org-card-badge';
  topBadge.textContent = 'Institutional Skills';
  topHead.append(topTitle, topBadge);

  const topDesc = document.createElement('p');
  topDesc.className = 'org-item-desc';
  topDesc.textContent = "Drop a .md into skills/ (or add one below) and say who gets it. An engine's skills, with the Central Brain, are written into each chat's folder as the file that CLI reads on its own (CLAUDE.md, AGENTS.md for Codex, GEMINI.md) before every launch; a persona's skills go into that agent's prompt; Grok gets everything in its prompt.";
  topCard.append(topHead, topDesc);
  panel.appendChild(topCard);

  // Add Skill Card
  const addCard = document.createElement('div');
  addCard.className = 'org-section-card';
  const addTitle = document.createElement('div');
  addTitle.className = 'org-card-title';
  addTitle.textContent = '➕ Add Institutional Skill';
  const formRow = document.createElement('div');
  formRow.className = 'org-form-row';
  const nameInput = document.createElement('input');
  nameInput.className = 'org-input';
  nameInput.placeholder = 'Skill Name (e.g. Database Migrations, API Design)';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'org-action-btn primary';
  addBtn.textContent = 'Create Skill';
  formRow.append(nameInput, addBtn);
  addCard.append(addTitle, formRow);

  addBtn.addEventListener('click', async () => {
    const sName = nameInput.value.trim();
    if (!sName) return;
    addBtn.disabled = true;
    try {
      await api.createSkill(sName);
      nameInput.value = '';
      renderOrgDeck();
    } catch (_) {
      addBtn.disabled = false;
    }
  });
  panel.appendChild(addCard);

  // List skills
  const grid = document.createElement('div');
  grid.className = 'org-grid-2';

  let skills = [];
  let org = { skills: {} };
  try {
    [skills, org] = await Promise.all([api.listSkills(), api.getOrg()]);
    org = org || { skills: {} };
  } catch (_) {}

  for (const s of skills) {
    const sCard = document.createElement('div');
    sCard.className = 'org-item-card';

    const sHead = document.createElement('div');
    sHead.className = 'org-item-head';
    const sTitle = document.createElement('div');
    sTitle.className = 'org-item-title';
    sTitle.textContent = s.title || s.file;
    sHead.append(sTitle);

    const sDesc = document.createElement('div');
    sDesc.className = 'org-item-desc';
    const given = (a) => `Playbook file: skills/${s.file} · given to: ${describeAssignment(a, vendorNames(), teammates(org))}`;
    sDesc.textContent = given((org.skills || {})[s.file]);
    // Who gets this skill (TM-60 Batch 2): everyone, or chosen engines and teammates.
    const assign = assignmentRow((org.skills || {})[s.file], async (a) => {
      org.skills = { ...(org.skills || {}), [s.file]: a };
      try {
        org = await api.saveOrg(org);
        sDesc.textContent = given((org.skills || {})[s.file]);
      } catch (err) {
        sDesc.textContent = `Could not save: ${err.message}`;
      }
    }, teammates(org));

    const editorBox = document.createElement('textarea');
    editorBox.className = 'org-textarea';
    editorBox.style.minHeight = '140px';
    editorBox.value = s.text;
    editorBox.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'org-item-actions';
    const toggleEditBtn = document.createElement('button');
    toggleEditBtn.type = 'button';
    toggleEditBtn.className = 'org-action-btn';
    toggleEditBtn.textContent = 'Edit Playbook';

    const saveSkillBtn = document.createElement('button');
    saveSkillBtn.type = 'button';
    saveSkillBtn.className = 'org-action-btn primary';
    saveSkillBtn.textContent = 'Save Skill';
    saveSkillBtn.hidden = true;

    toggleEditBtn.addEventListener('click', () => {
      const isEditing = !editorBox.hidden;
      editorBox.hidden = isEditing;
      saveSkillBtn.hidden = isEditing;
      toggleEditBtn.textContent = isEditing ? 'Edit Playbook' : 'Collapse';
    });

    saveSkillBtn.addEventListener('click', async () => {
      saveSkillBtn.disabled = true;
      saveSkillBtn.textContent = 'Saving…';
      try {
        await api.saveSkill(s.file, editorBox.value);
        saveSkillBtn.textContent = '✓ Saved!';
        setTimeout(() => {
          saveSkillBtn.disabled = false;
          saveSkillBtn.textContent = 'Save Skill';
        }, 1500);
      } catch (_) {
        saveSkillBtn.disabled = false;
        saveSkillBtn.textContent = 'Error';
      }
    });

    actions.append(toggleEditBtn, saveSkillBtn);
    sCard.append(sHead, sDesc, assign, editorBox, actions);
    grid.appendChild(sCard);
  }
  panel.appendChild(grid);
}

async function renderOrgBuilder(panel) {
  const card = document.createElement('div');
  card.className = 'org-section-card';

  const head = document.createElement('div');
  head.className = 'org-card-head';
  const title = document.createElement('div');
  title.className = 'org-card-title';
  title.textContent = '🛠️ Agent Builder Workbench';
  const badge = document.createElement('span');
  badge.className = 'org-card-badge';
  badge.textContent = 'Fabrication Bench';
  head.append(title, badge);

  const desc = document.createElement('p');
  desc.className = 'org-item-desc';
  desc.textContent = 'Forge a specialized teammate from the ground up: choose engine, attach Persona Chip (with Central Brain inherited automatically), equip MCP capabilities and skills, and deploy into your missions.';
  card.append(head, desc);

  const form = document.createElement('div');
  form.className = 'builder-form';
  const builder = builderForm({ defaultName: 'Custom Teammate' });

  // Action buttons
  const actionRow = document.createElement('div');
  actionRow.style.display = 'flex';
  actionRow.style.gap = '.8rem';
  actionRow.style.marginTop = '.6rem';

  const deployNewBtn = document.createElement('button');
  deployNewBtn.type = 'button';
  deployNewBtn.className = 'org-save-btn';
  deployNewBtn.textContent = '🚀 Deploy into New Mission Chat';

  const deployCurrentBtn = document.createElement('button');
  deployCurrentBtn.type = 'button';
  deployCurrentBtn.className = 'org-action-btn primary';
  deployCurrentBtn.style.padding = '.5rem 1rem';
  deployCurrentBtn.textContent = '👥 Summon into Current Chat';

  const getBuilderConfig = () => { const cfg = builder.config(); cfg.name = cfg.name || 'Custom Agent'; return cfg; };

  deployNewBtn.addEventListener('click', async () => {
    const cfg = getBuilderConfig();
    const opts = await builderMember(cfg);
    closeOrgControl();
    createCustomChat({ vendor: cfg.vendor, ...opts });
  });

  deployCurrentBtn.addEventListener('click', async () => {
    const cfg = getBuilderConfig();
    const opts = await builderMember(cfg);
    closeOrgControl();
    if (currentId) {
      join(currentId, cfg.vendor, opts);
      showChat(currentId);
    } else {
      createCustomChat({ vendor: cfg.vendor, ...opts });
    }
  });

  actionRow.append(deployNewBtn, deployCurrentBtn);
  form.append(...builder.fields, actionRow);
  card.appendChild(form);
  panel.appendChild(card);

  // The teammates saved so far, with a way out.
  const savedCard = document.createElement('div');
  savedCard.className = 'org-section-card';
  const savedTitle = document.createElement('div');
  savedTitle.className = 'org-card-title';
  savedTitle.textContent = '👥 Saved teammates';
  const savedList = document.createElement('div');
  savedList.className = 'org-item-actions wrap';
  const savedNote = document.createElement('div');
  savedNote.className = 'org-item-desc';
  savedNote.textContent = 'Offered in "+ New chat → Teammates" and as "Give to" targets in the Skills Library and MCP Directory. Removing one also drops it from those rows.';
  try {
    const org = await api.getOrg();
    const saved = teammates(org).filter(t => !t.builtIn);
    if (!saved.length) savedList.textContent = 'None yet. Forge one above with "Save as a teammate" ticked.';
    for (const t of saved) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'org-action-btn';
      b.textContent = `✕ ${t.name} (${vendorName(t.vendor)})`;
      b.title = `Remove ${t.name} from the saved teammates`;
      b.addEventListener('click', async () => { b.disabled = true; try { await removeTeammate(t.id); renderOrgDeck(); } catch (_) { b.disabled = false; } });
      savedList.appendChild(b);
    }
  } catch (_) {}
  savedCard.append(savedTitle, savedNote, savedList);
  panel.appendChild(savedCard);
}

// A model pick for the Builders (TM-60 Batch 5): the engine's models as the
// chooser offers them (Gemini from agy, Claude's three, Grok's two), with
// "Default" first; Codex has no list, so its model is typed. Refills when
// the engine changes.
function modelField(engineSelect) {
  const field = document.createElement('div');
  field.className = 'builder-field';
  const label = document.createElement('label');
  label.className = 'builder-label';
  label.textContent = 'Model';
  const select = document.createElement('select');
  select.className = 'builder-select';
  const typed = document.createElement('input');
  typed.className = 'builder-input';
  typed.placeholder = 'Codex model id, blank for its default (e.g. gpt-5.1-codex)';
  const fill = () => {
    const v = engineSelect.value;
    select.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default';
    select.appendChild(def);
    for (const m of (models && models[v]) || []) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      select.appendChild(o);
    }
    select.hidden = v === 'codex';
    typed.hidden = v !== 'codex';
    typed.value = '';
  };
  engineSelect.addEventListener('change', fill);
  fill();
  field.append(label, select, typed);
  const value = () => {
    if (engineSelect.value === 'codex') { const t = typed.value.trim(); return MODEL_TEXT.test(t) ? t : null; }
    return select.value || null;
  };
  return { field, value };
}

// The fields both Builders share (the chooser's and Org Control's): name,
// engine, model, persona chip, MCP servers, skills and "save as a teammate".
// config() reads them: { name, vendor, model, brain, brainText, mcp, skills, save }.
function builderForm({ defaultName = '' } = {}) {
  const field = (text, control) => {
    const f = document.createElement('div');
    f.className = 'builder-field';
    const l = document.createElement('label');
    l.className = 'builder-label';
    l.textContent = text;
    f.append(l, control);
    return f;
  };
  // A grid of tick boxes filled once a list arrives: boxes[key] -> checkbox.
  const grid = (load, key, label, emptyText) => {
    const g = document.createElement('div');
    g.className = 'builder-tools-grid';
    const boxes = {};
    load.then((list) => {
      for (const x of list || []) {
        const item = document.createElement('label');
        item.className = 'builder-tool-item';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.value = key(x);
        boxes[key(x)] = chk;
        const t = document.createElement('span');
        t.textContent = label(x);
        item.append(chk, t);
        g.appendChild(item);
      }
      if (!(list || []).length) g.textContent = emptyText;
    }).catch(() => {});
    return { grid: g, boxes, picked: () => Object.keys(boxes).filter(k => boxes[k].checked) };
  };

  const nameInput = document.createElement('input');
  nameInput.className = 'builder-input';
  nameInput.placeholder = 'e.g. Agent Smith, Neo, Security Auditor';
  nameInput.required = true;
  nameInput.value = defaultName;

  const engineSelect = document.createElement('select');
  engineSelect.className = 'builder-select';
  for (const v of VENDORS) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = vendorName(v);
    engineSelect.appendChild(opt);
  }
  const modelPick = modelField(engineSelect);

  // Persona chip (TM-60 Batch 4): a brain file, or none (Central Brain only).
  const brainSelect = document.createElement('select');
  brainSelect.className = 'builder-select';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'Standard Teammate (Central Brain only)';
  brainSelect.appendChild(noneOpt);
  let loadedBrains = [];
  api.listBrains().then((list) => {
    loadedBrains = list || [];
    for (const b of loadedBrains) {
      const opt = document.createElement('option');
      opt.value = b.file;
      opt.textContent = `${b.title} (${b.file})`;
      brainSelect.appendChild(opt);
    }
  }).catch(() => {});

  // Free-text instructions (PR #57), kept beside the persona chip rather than
  // replaced by it; they ride in the prompt as "Your custom instructions".
  const instructions = document.createElement('textarea');
  instructions.className = 'org-textarea';
  instructions.rows = 4;
  instructions.placeholder = 'Anything this teammate should always know or do';

  // MCP servers from the directory. Only Claude takes them at launch, so the
  // other engines get a sentence instead of ticks that would do nothing.
  const tools = grid(api.listMcps(), s => s.id, s => s.name, 'No servers in the MCP Directory yet (Org Control → MCP Directory).');
  const mcpNote = document.createElement('p');
  mcpNote.className = 'builder-note';
  mcpNote.textContent = 'Daycare can only hand servers to Claude at launch. Gemini, Codex and Grok keep whatever is already in their own CLI (agy mcp add, codex mcp add, grok mcp add).';
  const mcpWrap = document.createElement('div');
  mcpWrap.append(mcpNote, tools.grid);
  const syncMcp = () => {
    const claude = engineSelect.value === 'claude';
    tools.grid.hidden = !claude;
    mcpNote.hidden = claude;
    if (!claude) for (const box of Object.values(tools.boxes)) box.checked = false;
  };
  engineSelect.addEventListener('change', syncMcp);
  syncMcp();
  const skills = grid(api.listSkills(), s => s.file, s => s.title, 'No skills in the library yet.');

  const saveField = document.createElement('label');
  saveField.className = 'builder-tool-item builder-save';
  const saveBox = document.createElement('input');
  saveBox.type = 'checkbox';
  saveBox.checked = true;
  const saveText = document.createElement('span');
  saveText.textContent = 'Save as a teammate (offered in + New chat, and a "Give to" target)';
  saveField.append(saveBox, saveText);

  const fields = [
    field('Agent Name', nameInput),
    field('CLI Engine (Vendor)', engineSelect),
    modelPick.field,
    field('Persona Chip (Central Brain inherited automatically)', brainSelect),
    field('Custom instructions', instructions),
    field('MCP servers', mcpWrap),
    field('Skills (given to this teammate)', skills.grid),
    saveField
  ];
  const config = () => {
    const brain = brainSelect.value;
    const match = loadedBrains.find(b => b.file === brain);
    return { name: nameInput.value.trim(), vendor: engineSelect.value, model: modelPick.value(), brain, brainText: match ? match.text : '', customInstructions: instructions.value.trim(), mcp: engineSelect.value === 'claude' ? tools.picked() : [], skills: skills.picked(), save: saveBox.checked };
  };
  return { fields, config };
}

// A Builder config as the options for a new member. Saving first (TM-60
// Batch 4) gives the member its teammate id, so the skills and servers given
// to that teammate reach it from the first turn; its own picks ride on the
// member too, so an agent that was not saved still has them.
async function builderMember(cfg) {
  return { name: cfg.name, model: cfg.model, modelLabel: modelLabelOf(cfg.vendor, cfg.model), brain: cfg.brain || null, brainText: cfg.brainText || null, customInstructions: cfg.customInstructions || null, mcp: cfg.mcp, skills: cfg.skills, persona: cfg.save ? await saveTeammate(cfg) : null };
}

// A Builder agent becomes a saved teammate: it joins org.agents, and its
// skills and servers become assignments to it, so the usual resolution
// gives them to every member made from it. Same name re-saves it, and what
// was unticked this time is taken away again.
async function saveTeammate(cfg) {
  const org = (await api.getOrg()) || {};
  const same = teammates(org).find(t => !t.builtIn && t.name === cfg.name);
  const id = same ? same.id : teammateId(cfg.name, teammates(org).map(t => t.id));
  org.agents = [...(org.agents || []).filter(a => a.id !== id), { id, name: cfg.name, vendor: cfg.vendor, model: cfg.model || null, role: cfg.role || '', brainFile: cfg.brain || '', brainText: cfg.brainText || '', customInstructions: cfg.customInstructions || '', mcp: cfg.mcp || [], skills: cfg.skills || [] }];
  org.skills = org.skills || {};
  org.mcp = org.mcp || {};
  for (const map of [org.skills, org.mcp]) for (const a of Object.values(map)) a.personas = (a.personas || []).filter(p => p !== id);
  const give = (map, key) => {
    const a = map[key] || { all: false, engines: [], personas: [] };
    a.personas = [...(a.personas || []), id];
    map[key] = a;
  };
  for (const f of cfg.skills || []) give(org.skills, f);
  for (const s of cfg.mcp || []) give(org.mcp, s);
  await api.saveOrg(org);
  api.log('info', 'teammate saved', { id, vendor: cfg.vendor, skills: (cfg.skills || []).length, mcp: (cfg.mcp || []).length });
  return id;
}

async function removeTeammate(id) {
  const org = (await api.getOrg()) || {};
  org.agents = (org.agents || []).filter(a => a.id !== id);
  for (const map of [org.skills || {}, org.mcp || {}]) {
    for (const a of Object.values(map)) a.personas = (a.personas || []).filter(p => p !== id);
  }
  await api.saveOrg(org);
  api.log('info', 'teammate removed', { id });
}

// ---- Start-up -----------------------------------------------------------------

wireComposer(main);
wireComposer(panel);
el.newChat.addEventListener('click', startNewChat);
el.addAgent.addEventListener('click', () => showChooser('add'));
el.panelClose.addEventListener('click', () => { closePanel(); main.input.focus(); });
if (el.tabSession) el.tabSession.addEventListener('click', () => setSidecarTab('session'));
if (el.tabPreview) el.tabPreview.addEventListener('click', () => setSidecarTab('preview'));
if (el.tabToolbelt) el.tabToolbelt.addEventListener('click', () => setSidecarTab('toolbelt'));
if (el.sidecarExpandBtn) el.sidecarExpandBtn.addEventListener('click', toggleSidecarExpand);
if (el.previewReload) el.previewReload.addEventListener('click', () => { if (el.previewIframe && currentPreviewUrl) el.previewIframe.src = currentPreviewUrl; });
if (el.previewExternal) el.previewExternal.addEventListener('click', () => { if (currentPreviewUrl) window.open(currentPreviewUrl, '_blank'); });

if (el.navOrgBtn) {
  el.navOrgBtn.addEventListener('click', () => {
    if (isOrgControlOpen) closeOrgControl();
    else openOrgControl('memory');
  });
}
if (el.orgCloseBtn) el.orgCloseBtn.addEventListener('click', closeOrgControl);
if (el.orgTabMemory) el.orgTabMemory.addEventListener('click', () => setOrgTab('memory'));
if (el.orgTabPersonas) el.orgTabPersonas.addEventListener('click', () => setOrgTab('personas'));
if (el.orgTabMcps) el.orgTabMcps.addEventListener('click', () => setOrgTab('mcps'));
if (el.orgTabSkills) el.orgTabSkills.addEventListener('click', () => setOrgTab('skills'));
if (el.orgTabBuilder) el.orgTabBuilder.addEventListener('click', () => setOrgTab('builder'));

api.onAgentOutput(onOutput);
api.onAgentStep(onStep);
api.onAgentDone(({ runKey, code, run, ...outcome }) => {
  if (!pendingFor(runKey, run)) return api.log('warn', 'ignored a done event from a superseded launch', { runKey, run });
  finishReply(runKey, code, null, outcome);
});
api.onNotice(({ text }) => { if (current()) post(currentId, { from: 'system', text }); });

async function init() {
  try { Object.assign(plans, JSON.parse(localStorage.getItem('plans') || '{}')); } catch (_) { /* nothing saved */ }
  renderPlan();
  const configs = await api.getAgentConfigs();
  for (const c of configs) vendors[c.id] = { id: c.id, name: c.name, color: c.color };
  // Asked once in the background; the chooser shows models once they arrive.
  api.listModels().then((m) => {
    models = m;
    // Only the model screen changes with the list; redrawing the Builder
    // would throw away a half-filled form.
    const { mode, vendor } = el.chooser.dataset;
    if (!el.chooser.hidden && vendor && (mode === 'new' || mode === 'add')) showChooser(mode, vendor);
  }).catch((err) => api.log('warn', 'could not list models', { error: err.message }));

  const { config } = await api.getConfig();
  workingDir = config.workingDir;
  el.folder.textContent = `Working folder: ${workingDir}`;

  try { projectList = await api.listProjects(); }
  catch (err) { projectCatalogError = err.message; api.log('error', 'project catalog could not be loaded', { error: err.message }); }
  const { chats: saved } = await api.listChats();
  for (const s of saved) chats.set(s.id, { ...s });
  // Open the most recent chat, or pick an agent for the first one.
  if (saved.length) await openChat(saved[0].id);
  else showChooser('new');
  api.log('info', 'chat window ready', { vendors: Object.keys(vendors), workingDir: config.workingDir, chats: saved.length });
}

init();
