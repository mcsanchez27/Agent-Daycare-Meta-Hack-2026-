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
const { createThread, addMessage, buildPrompt, chatTitle, findTarget, splitChatAsks, routeMessage, memorySnapshot, mergeThreads, hopsSinceMatt, hopLimit, HOP_LIMIT } = window.ChatThread;
const { VENDORS, ROLES, CREW, newMember, ensureMembers, renameRetired, memberById } = window.ChatMembers;

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
  sidecarModels: $('sidecar-models'),
  contextGaugeLabel: $('context-gauge-label'),
  contextGaugeVal: $('context-gauge-val'),
  contextBar: $('context-bar'),
  sidecarPlanWrap: $('sidecar-plan-wrap')
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
  const c = current();
  if (c && c.thread && c.thread.messages.length === 0) chats.delete(c.id);
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
function createCrew() {
  const now = new Date().toISOString();
  const members = [];
  for (const c of CREW) members.push(newMember(members, c, { vendorNames: vendorNames() }));
  const chat = { id: newChatId(), title: 'New chat', createdAt: now, updatedAt: now, thread: createThread(members) };
  chats.set(chat.id, chat);
  hideChooser();
  showChat(chat.id);
  api.log('info', 'crew created', { chatId: chat.id, members: members.map(m => `${m.vendor}:${m.role}`) });
}

// Adds an agent to a chat and says so there. opts: model, modelLabel, memory
// ({ title, name, text } from another chat), name (keep this name if it's
// free), fromTitle (for the note), threadOf (where the note goes).
function join(chatId, vendor, { model = null, modelLabel = null, memory = null, name = null, fromTitle = null, threadOf = null } = {}) {
  const chat = chats.get(chatId);
  const names = name ? { ...vendorNames(), [vendor]: name } : vendorNames();
  const member = newMember(chat.thread.members, { vendor, model, memory }, { vendorNames: names, modelLabel });
  chat.thread.members.push(member);
  const what = member.name === vendorName(vendor) ? modelText(member) : `${vendorName(vendor)}, ${modelText(member)}`;
  post(chatId, { from: 'system', threadOf, text: `${member.name} (${what}) joined` + (fromTitle ? ` from "${fromTitle}"` : '') + '.' });
  api.log('info', 'agent joined', { chatId, member: member.id, vendor, model, from: fromTitle });
  if (chatId === currentId) renderMembers();
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
  if (pending[key]) api.stop(key);
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

// Opens a thread in the panel beside the main chat.
function openPanel(rootId) {
  const root = current().thread.messages.find(m => m.id === rootId);
  if (!root) return;
  panel.threadOf = rootId;
  if (el.sidecarContent) el.sidecarContent.hidden = true;
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
  if (el.sidecarContent) el.sidecarContent.hidden = false;
  if (currentId) renderSidecar();
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
    await api.saveChat({ id: chat.id, title: chat.title, titleSet: chat.titleSet, createdAt: chat.createdAt, updatedAt: chat.updatedAt, thread: chat.thread });
  } catch (err) {
    api.log('error', 'could not save chat', { id: chat.id, error: err.message });
  }
}

function renderChatList() {
  el.chatList.replaceChildren();
  const sorted = [...chats.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  for (const chat of sorted) {
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
    el.chatList.appendChild(item);
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
      if (chat.thread.messages.length) persist(chat);
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
  }

  // Context gauge and tokens
  let totalTokens = 0;
  let maxWindow = 0;
  for (const m of c.thread.members) {
    if (m.left) continue;
    if (m.usage && m.usage.inputTokens) {
      totalTokens += m.usage.inputTokens;
      if (m.usage.contextWindow && m.usage.contextWindow > maxWindow) {
        maxWindow = m.usage.contextWindow;
      }
    }
  }

  if (el.contextGaugeVal && el.contextBar) {
    if (maxWindow > 0) {
      const pct = Math.min(100, (100 * totalTokens) / maxWindow);
      el.contextGaugeVal.textContent = `${tokens(totalTokens)} / ${tokens(maxWindow)}`;
      el.contextBar.style.width = `${pct.toFixed(1)}%`;
      el.contextBar.title = `${totalTokens.toLocaleString()} of ${maxWindow.toLocaleString()} tokens (${pct.toFixed(1)}%)`;
    } else if (totalTokens > 0) {
      el.contextGaugeVal.textContent = `${tokens(totalTokens)} tokens`;
      el.contextBar.style.width = '25%';
      el.contextBar.title = `${totalTokens.toLocaleString()} tokens read in last responses`;
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

  if (mode === 'merge') {
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
  } else if (!vendor) {
    h.textContent = mode === 'new' ? 'Who do you want to talk to?' : 'Add which agent to this chat?';
    for (const v of VENDORS) option(vendorName(v), null, vendors[v] && vendors[v].color, () => showChooser(mode, v));
    if (mode === 'new') {
      option('Crew', CREW.map(c => `${vendorName(c.vendor)} ${ROLES[c.role].label}`).join(' · '), null, createCrew);
    }
    if (mode === 'add' && chats.size > 1) option('From another chat…', 'brings that chat as background', null, () => showChooser('from'));
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
  if ((vendor || mode === 'from') && mode !== 'merge') {
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '← Back';
    back.addEventListener('click', () => showChooser(mode === 'from' && !vendor ? 'add' : mode, null));
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

function otherChats(chatId) {
  return [...chats.values()].filter(c => c.id !== chatId && c.title).map(c => ({ id: c.id, title: c.title }));
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
  if (s.state === 'asking') buttons.unshift({ label: 'Stop', title: 'Stop the other chat answering', onClick: () => api.stop(s.runKey) });
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
  const askerName = asker === 'matt' ? 'Matt' : nameOf(asker, src);
  if (hop > HOP_LIMIT) {
    post(fromChatId, { from: 'system', threadOf, text: `${askerName} asked "${dst.title}", but chats have asked each other ${HOP_LIMIT} times in a row. Reply here to keep going.` });
    api.log('info', 'background ask refused: hop limit', { from: fromChatId, to: targetId, hop });
    return;
  }
  await loadChat(dst);
  const owner = dst.thread.members[0];
  const runKey = runKeyOf(targetId, owner.id);
  const side = post(fromChatId, { from: 'system', threadOf, text: `${askerName} asked "${dst.title}" in the background.`, side: { chatId: targetId, chatTitle: dst.title, asker, question: text, state: 'asking', hop, runKey, ...(group || {}) } });
  api.log('info', 'background ask', { from: fromChatId, to: targetId, asker, hop });
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
    addActions(row, [{ label: 'Thread', title: 'Open a thread on this message beside the chat', onClick: () => openPanel(m.id) }]);
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
    if (!inView(view, m)) continue;
    renderMessage(view, m);
    if (view === main) renderSummary(m.id);
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
  if (info.live) addActions(row, [{ label: 'Stop', title: `Stop ${nameOf(info.live)}`, onClick: () => api.stop(info.liveKey) }]);
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
    addActions(r.row, [{ label: 'Stop', title: `Stop ${nameOf(p.memberId)}`, onClick: () => api.stop(key) }]);
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
function onStep({ runKey, step }) {
  const p = pending[runKey];
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

// A member's finished reply that names another agent with @ brings it in,
// in the same place (the main chat or the thread it is in). An agent not in
// the chat joins on its default model. After hopLimit (3, or 6 in a crew) handoffs in a row
// there, Matt has to say something first.
function handOff(chatId, m) {
  const chat = chats.get(chatId);
  const target = findTarget(m.text, m.from, chat.thread.members, vendorNames());
  if (!target) return;
  const where = m.threadOf || null;
  const name = (id) => nameOf(id, chat);
  const toName = target.memberId ? name(target.memberId) : vendorName(target.vendor);
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

// Launches a member with the chat so far and opens a bubble for its reply.
// threadOf: the thread it answers in, or null for the main chat. extra
// (background asks): side ({ chatId, messageId, hop }) when this reply answers
// another chat; answer ({ chatTitle, text }, or a list of them) for an asker's follow-up; hop,
// how many chats have asked each other so far in this chain.
function ask(chatId, memberId, threadOf = null, { side = null, answer = null, hop = 0 } = {}) {
  const thread = chats.get(chatId).thread;
  const member = memberById(thread, memberId);
  // The newest 15 other chats with real titles, so the agent can ask one with #.
  const chatTitles = otherChats(chatId).filter(c => c.title !== 'New chat')
    .sort((a, b) => (chats.get(a.id).updatedAt < chats.get(b.id).updatedAt ? 1 : -1)).slice(0, 15).map(c => c.title);
  // Its vendor session for this place (TM-55): the main chat, or one thread.
  // Resuming sends only what's new since it last saw the chat.
  const where = threadOf === null ? 'main' : String(threadOf);
  const session = (member.sessions || {})[where] || null;
  const prompt = buildPrompt(thread, memberId, { threadOf, answer, chatTitles, since: session ? session.lastId : null });
  const runKey = runKeyOf(chatId, memberId);
  pending[runKey] = {
    chatId, memberId, threadOf, side, answer, hop: side ? side.hop : hop, text: '', stderr: '', steps: [], started: Date.now(),
    where, sessionId: session ? session.id : null, seenUpTo: thread.nextId - 1
  };
  if (chatId === currentId) {
    openViews().forEach(renderPendingRows);
    renderMembers();
    if (threadOf !== null) renderSummary(threadOf);
  }
  renderChatList();
  updateSendButtons();

  api.run({ runKey, vendor: member.vendor, model: member.model, sessionId: pending[runKey].sessionId, prompt }).then((started) => {
    if (started === false) finishReply(runKey, null, 'it could not be started');
  }).catch((err) => finishReply(runKey, null, err.message));
}

function onOutput({ runKey, stream, text }) {
  const p = pending[runKey];
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
  // ask again once with a fresh session and the usual recent history.
  if (p.sessionId && member && !p.text.trim() && !stopped && !timedOut && !why) {
    delete member.sessions[p.where];
    post(p.chatId, { from: 'system', threadOf: p.threadOf || null, text: `${name}'s saved session couldn't be resumed, so it's starting a fresh one.` });
    api.log('warn', 'session resume failed, starting fresh', { runKey, code, sessionId: p.sessionId });
    ask(p.chatId, p.memberId, p.threadOf || null, { side: p.side, answer: p.answer, hop: p.hop });
    return;
  }
  // Remember the session to resume next time, and what it has seen; usage for the meter.
  if (member && sessionId && !stopped && !timedOut) {
    member.sessions = { ...(member.sessions || {}), [p.where]: { id: sessionId, lastId: p.seenUpTo } };
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

// ---- Start-up -----------------------------------------------------------------

wireComposer(main);
wireComposer(panel);
el.newChat.addEventListener('click', startNewChat);
el.addAgent.addEventListener('click', () => showChooser('add'));
el.panelClose.addEventListener('click', () => { closePanel(); main.input.focus(); });

api.onAgentOutput(onOutput);
api.onAgentStep(onStep);
api.onAgentDone(({ runKey, code, ...outcome }) => finishReply(runKey, code, null, outcome));
api.onNotice(({ text }) => { if (current()) post(currentId, { from: 'system', text }); });

async function init() {
  try { Object.assign(plans, JSON.parse(localStorage.getItem('plans') || '{}')); } catch (_) { /* nothing saved */ }
  renderPlan();
  const configs = await api.getAgentConfigs();
  for (const c of configs) vendors[c.id] = { id: c.id, name: c.name, color: c.color };
  // Asked once in the background; the chooser shows models once they arrive.
  api.listModels().then((m) => {
    models = m;
    if (!el.chooser.hidden && el.chooser.dataset.mode !== 'from') showChooser(el.chooser.dataset.mode, el.chooser.dataset.vendor || null);
  }).catch((err) => api.log('warn', 'could not list models', { error: err.message }));

  const { config } = await api.getConfig();
  workingDir = config.workingDir;
  el.folder.textContent = `Working folder: ${workingDir}`;

  const { chats: saved } = await api.listChats();
  for (const s of saved) chats.set(s.id, { ...s });
  // Open the most recent chat, or pick an agent for the first one.
  if (saved.length) await openChat(saved[0].id);
  else showChooser('new');
  api.log('info', 'chat window ready', { vendors: Object.keys(vendors), workingDir: config.workingDir, chats: saved.length });
}

init();
