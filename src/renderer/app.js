// Chat window behaviour: the chat list, the message box and the thread of the
// open chat. Messages are drawn with textContent only, never innerHTML, so
// nothing an agent prints can run as code in this window.
// Sending launches an agent with the recent thread in the prompt and streams
// its reply into a bubble. A reply can be stopped while it streams.
// Chats are saved one file each (TM-53 Batch 2). A reply always lands in the
// chat it was asked in, even if Matt has switched to another one meanwhile.
// Threads (TM-53 Batch 3): the main chat shows a live summary row under a
// thread's first message; opening it swaps the view to the thread.
// Members (TM-54): each chat has its own agents (thread.members), picked by
// vendor and model when the chat starts. Each member's reply is one run, named
// `<chatId>/<memberId>`, so two Claudes can answer at once. @Name decides who
// answers; @ a vendor that isn't in the chat and it joins on its default
// model. Agents bring each other in the same way.

// `api` is the global the preload bridge exposes (window.api); declaring it
// again here is a SyntaxError that stops this whole file from running.
const { createThread, addMessage, buildPrompt, chatTitle, findTarget, routeMessage, memorySnapshot, hopsSinceMatt, HOP_LIMIT } = window.ChatThread;
const { VENDORS, newMember, ensureMembers, memberById } = window.ChatMembers;

// Same rule as the runner's MODEL_TEXT: a typed model goes on a command line.
const MODEL_TEXT = /^[A-Za-z0-9_.:-]{1,64}$/;

const vendors = {}; // vendor -> { id, name, color } from config.json
let models = null; // vendor -> [{ id, label }], from api.listModels()
const chats = new Map(); // id -> { id, title, createdAt, updatedAt, thread? } (thread once loaded)
let currentId = null;
let openThread = null; // id of the open thread's first message, or null for the main chat
// runKey -> the reply being streamed: { chatId, memberId, threadOf, text, stderr, started }.
// One per member: each member runs one process at a time.
const pending = {};
const pendingRows = {}; // runKey -> { row, meta, bubble } while its chat is on screen
const summaryRows = {}; // thread's first message id -> its summary row in the main chat
// The @ dropdown under the message box: the vendors matching what's typed after @.
const mention = { items: [], index: 0 };

const el = {
  chat: document.querySelector('.chat'),
  chatList: document.getElementById('chat-list'),
  newChat: document.getElementById('new-chat'),
  thread: document.getElementById('thread'),
  empty: document.getElementById('empty'),
  form: document.getElementById('composer'),
  input: document.getElementById('message'),
  send: document.getElementById('send'),
  mentions: document.getElementById('mentions'),
  folder: document.getElementById('folder'),
  members: document.getElementById('members'),
  addAgent: document.getElementById('add-agent'),
  chooser: document.getElementById('chooser'),
  threadBar: document.getElementById('thread-bar'),
  threadLabel: document.getElementById('thread-label'),
  back: document.getElementById('back')
};

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

// Adds an agent to a chat and says so there. opts: model, modelLabel, memory
// ({ title, text } from another chat), name (keep this name if it's free),
// fromTitle (for the note), threadOf (where the note goes).
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

async function loadChat(chat) {
  if (!chat.thread) Object.assign(chat, await api.loadChat(chat.id));
  ensureMembers(chat.thread, vendorNames());
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
  renderChatList();
  renderMembers();
  showThread(null);
}

// Switches the view between the main chat (null) and one of its threads.
function showThread(rootId) {
  openThread = rootId;
  const root = rootId === null ? null : current().thread.messages.find(m => m.id === rootId);
  el.threadBar.hidden = !root;
  if (root) el.threadLabel.textContent = `Thread on ${root.from === 'matt' ? 'your' : nameOf(root.from) + "'s"} message`;
  renderThread();
  updatePlaceholder();
  updateSendButton();
  el.input.focus();
}

// Whether a message belongs in the view on screen. A thread shows its first message too.
function inView(m) {
  return openThread === null ? !m.threadOf : m.id === openThread || m.threadOf === openThread;
}

function pendingInView(p) {
  return p.chatId === currentId && (p.threadOf || null) === openThread;
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
    const title = document.createElement('span');
    title.className = 'chat-title';
    title.textContent = chat.title;
    const when = document.createElement('span');
    when.className = 'chat-when';
    const busy = Object.values(pending).filter(p => p.chatId === chat.id).length;
    when.textContent = busy ? 'working…' : dayLabel(chat.updatedAt);
    if (busy) item.classList.add('busy');
    const rename = document.createElement('span');
    rename.className = 'chat-rename';
    rename.textContent = '✎';
    rename.title = 'Rename';
    rename.addEventListener('click', (e) => { e.stopPropagation(); editTitle(chat, item); });
    item.append(title, when, rename);
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
  for (const m of current().thread.members) {
    const working = Boolean(pending[runKeyOf(currentId, m.id)]);
    const chip = document.createElement('span');
    chip.className = 'member' + (working ? ' working' : '');
    chip.style.setProperty('--agent-color', vendors[m.vendor] ? vendors[m.vendor].color : '#888');
    chip.textContent = `${m.name} · ${modelText(m)}` + (working ? ' · working…' : '');
    chip.title = `${vendorName(m.vendor)}, ${modelText(m)}` + (m.memory ? `, with background from "${m.memory.title}"` : '');
    el.members.appendChild(chip);
  }
}

// Adds a message to a chat (open or not), saves it, and draws it if on screen.
function post(chatId, message) {
  const chat = chats.get(chatId);
  const m = addMessage(chat.thread, message);
  chat.updatedAt = m.ts;
  if (!chat.titleSet) chat.title = chatTitle(chat.thread);
  persist(chat);
  if (chatId === currentId && inView(m)) {
    removePendingRows();
    renderMessage(m);
    renderPendingRows();
  } else if (chatId === currentId && openThread === null && m.threadOf) {
    renderSummary(m.threadOf);
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
  closeMentions();
  renderChatList();
  el.chooser.replaceChildren();
  const h = document.createElement('h2');
  el.chooser.appendChild(h);
  const options = document.createElement('div');
  options.className = 'options';
  el.chooser.appendChild(options);
  const option = (label, sub, color, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'option';
    if (color) b.style.setProperty('--agent-color', color);
    const main = document.createElement('span');
    main.className = 'option-label';
    main.textContent = label;
    b.appendChild(main);
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

  if (mode === 'from') {
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
    if (mode === 'add' && chats.size > 1) option('From another chat…', 'brings that chat as background', null, () => showChooser('from'));
  } else {
    const color = vendors[vendor] && vendors[vendor].color;
    h.textContent = `Which ${vendorName(vendor)} model?`;
    option('Default', `whatever ${vendor} uses by default`, color, () => pick(vendor, null, null));
    const list = (models && models[vendor]) || [];
    for (const m of list) option(m.label, m.id, color, () => pick(vendor, m.id, m.label));
    if (vendor === 'antigravity' && models && !list.length) {
      const note = document.createElement('p');
      note.className = 'chooser-note';
      note.textContent = "Couldn't get Antigravity's model list (agy models), so only its default is offered.";
      el.chooser.appendChild(note);
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
      el.chooser.appendChild(row);
    }
  }
  const nav = document.createElement('div');
  nav.className = 'chooser-nav';
  if (vendor || mode === 'from') {
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
  el.chooser.appendChild(nav);
}

function hideChooser() {
  el.chooser.hidden = true;
  el.chat.classList.remove('choosing');
}

// ---- Thread -----------------------------------------------------------------

// Builds one message row. from: 'matt', 'system' or a member id.
function createRow(from, metaText, text) {
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
    row.className = 'msg agent';
    row.style.setProperty('--agent-color', colorOf(from));
  }

  if (from !== 'system') row.appendChild(meta);
  row.appendChild(bubble);
  el.empty.hidden = true;
  const atBottom = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 40;
  el.thread.appendChild(row);
  // Next frame: callers add the meta text and buttons after this returns.
  if (atBottom || from === 'matt') requestAnimationFrame(scrollToBottom);
  return { row, meta, bubble };
}

function scrollToBottom() {
  el.thread.scrollTop = el.thread.scrollHeight;
}

function renderMessage(m) {
  if (m.handoff) {
    // Drawn from the ids, so a renamed agent shows its current name.
    const { row } = createRow('system', '', `${nameOf(m.handoff.from)} › ${nameOf(m.handoff.to)} · Sent to ${nameOf(m.handoff.to)} ›`);
    row.classList.add('handoff');
    return;
  }
  let metaText = `${nameOf(m.from)} · ${timeLabel(m.ts)}` + (m.endedAs ? ` · ${m.endedAs}` : '');
  if (m.from === 'matt') {
    metaText = m.relayOf
      ? `To ${nameOf(m.to)} · passing on ${nameOf(m.relayOf)}'s reply · ${timeLabel(m.ts)}`
      : `To ${nameOf(m.to)} · ${timeLabel(m.ts)}`;
  }
  const { row } = createRow(m.from, metaText, m.text);
  row.dataset.id = m.id;
  if (m.from !== 'system' && openThread === null) {
    addActions(row, [{ label: 'Reply in thread', title: 'Open a thread under this message', onClick: () => showThread(m.id) }]);
  }
}

function renderThread() {
  el.thread.replaceChildren(el.empty);
  Object.keys(pendingRows).forEach(id => delete pendingRows[id]);
  Object.keys(summaryRows).forEach(id => delete summaryRows[id]);
  const chat = current();
  el.empty.hidden = Boolean(chat && chat.thread.messages.length);
  if (!chat) return;
  el.empty.textContent = `Say hi to ${chat.thread.members[0].name}. Type @ to bring in another agent.`;
  for (const m of chat.thread.messages) {
    if (!inView(m)) continue;
    renderMessage(m);
    if (openThread === null) renderSummary(m.id);
  }
  renderPendingRows();
  scrollToBottom();
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

// Draws or updates the summary row right under a thread's first message.
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
  open.title = 'Open the thread';
  open.addEventListener('click', () => showThread(rootId));
  row.appendChild(open);
  // One Stop ends the thread: a stopped reply never hands off.
  if (info.live) addActions(row, [{ label: 'Stop', title: `Stop ${nameOf(info.live)}`, onClick: () => api.stop(info.liveKey) }]);
  if (old) old.replaceWith(row);
  else {
    const rootRow = el.thread.querySelector(`[data-id="${rootId}"]`);
    if (!rootRow) return;
    rootRow.after(row);
  }
  summaryRows[rootId] = row;
}

// The bubbles of replies still coming in always sit at the bottom.
function renderPendingRows() {
  for (const [key, p] of Object.entries(pending)) {
    if (!pendingInView(p) || pendingRows[key]) continue;
    const r = createRow(p.memberId, '', p.text.trim());
    r.row.classList.add('pending');
    addActions(r.row, [{ label: 'Stop', title: `Stop ${nameOf(p.memberId)}`, onClick: () => api.stop(key) }]);
    pendingRows[key] = r;
    updatePendingMeta(key);
  }
}

function removePendingRows() {
  for (const [key, r] of Object.entries(pendingRows)) {
    r.row.remove();
    delete pendingRows[key];
  }
}

function updatePendingMeta(key) {
  const p = pending[key];
  const r = pendingRows[key];
  if (!p || !r) return;
  // Antigravity can take ~30s, so the wait shows a seconds counter.
  r.meta.textContent = p.text
    ? `${nameOf(p.memberId)} · replying…`
    : `${nameOf(p.memberId)} · thinking… ${Math.round((Date.now() - p.started) / 1000)}s`;
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
// the chat joins on its default model. After HOP_LIMIT handoffs in a row
// there, Matt has to say something first.
function handOff(chatId, m) {
  const chat = chats.get(chatId);
  const target = findTarget(m.text, m.from, chat.thread.members, vendorNames());
  if (!target) return;
  const view = m.threadOf || null;
  const name = (id) => nameOf(id, chat);
  const toName = target.memberId ? name(target.memberId) : vendorName(target.vendor);
  const hops = hopsSinceMatt(chat.thread, view);
  if (hops >= HOP_LIMIT) {
    post(chatId, { from: 'system', threadOf: view, text: `${name(m.from)} asked for ${toName}, but the agents have handed off ${HOP_LIMIT} times in a row. Reply here to keep going.` });
    api.log('info', 'hop limit reached', { chatId, view, from: m.from, to: target });
    return;
  }
  const to = target.memberId || join(chatId, target.vendor, { threadOf: view }).id;
  if (pending[runKeyOf(chatId, to)]) {
    post(chatId, { from: 'system', threadOf: view, text: `${name(m.from)} asked for ${name(to)}. ${busyText(chatId, to)}` });
    return;
  }
  post(chatId, { from: 'system', threadOf: view, handoff: { from: m.from, to }, text: `${name(m.from)} › ${name(to)}` });
  api.log('info', 'handoff', { chatId, view, from: m.from, to, hop: hops + 1 });
  ask(chatId, to, view);
}

function busyText(chatId, memberId) {
  const name = nameOf(memberId, chats.get(chatId));
  return `${name} is still answering. Send it once ${name} is done, or stop it first.`;
}

// ---- Message box and the @ dropdown -----------------------------------------------

function autoGrow() {
  el.input.style.height = 'auto';
  // scrollHeight leaves out the border; without it the box always overflows by 2px.
  el.input.style.height = (el.input.scrollHeight + el.input.offsetHeight - el.input.clientHeight) + 'px';
}

// Who the text in the box would go to: { memberId } or { vendor } (joins).
function target() {
  return routeMessage(current().thread, el.input.value, openThread, vendorNames());
}

function updatePlaceholder() {
  if (!current()) return;
  const to = routeMessage(current().thread, '', openThread, vendorNames()).memberId;
  el.input.placeholder = `${openThread === null ? 'Message' : 'Reply in the thread to'} ${nameOf(to)}… (@ to bring in another agent, Shift+Enter for a new line)`;
}

// Send is off while the box is empty or the agent it would go to is still
// answering (a new launch would cut its reply off; use Stop instead).
function updateSendButton() {
  const t = current() && el.input.value.trim() ? target() : null;
  const busy = Boolean(t && t.memberId && pending[runKeyOf(currentId, t.memberId)]);
  el.send.disabled = !t || busy;
  el.send.title = busy ? busyText(currentId, t.memberId)
    : t && t.vendor ? `${vendorName(t.vendor)} isn't in this chat yet: it joins on its default model`
    : t ? `Goes to ${nameOf(t.memberId)}` : '';
}

function send() {
  const text = el.input.value.trim();
  if (!text || !current()) return;
  const t = target();
  if (t.memberId && pending[runKeyOf(currentId, t.memberId)]) return;
  const to = t.memberId || join(currentId, t.vendor, { threadOf: openThread }).id;
  post(currentId, { from: 'matt', to, text, threadOf: openThread });
  el.input.value = '';
  autoGrow();
  closeMentions();
  ask(currentId, to, openThread);
}

// The `@word` being typed right before the cursor, or null.
function mentionQuery() {
  const before = el.input.value.slice(0, el.input.selectionStart);
  const m = /(^|\s)@([\w-]*)$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

// The dropdown lists our three vendors (Matt, TM-54): one already in the chat
// is reached by its name; one that isn't joins on its default model.
function updateMentions() {
  const q = mentionQuery();
  const items = q && current() ? VENDORS.filter(v => vendorName(v).toLowerCase().startsWith(q.query)) : [];
  if (!items.length) return closeMentions();
  if (mention.items.join() !== items.join()) mention.index = 0;
  mention.items = items;
  el.mentions.replaceChildren();
  const inChat = new Set(current().thread.members.map(m => m.name.toLowerCase()));
  items.forEach((v, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention' + (i === mention.index ? ' active' : '');
    b.style.setProperty('--agent-color', vendors[v] ? vendors[v].color : '#888');
    const name = document.createElement('span');
    name.className = 'mention-name';
    name.textContent = vendorName(v);
    const sub = document.createElement('span');
    sub.className = 'mention-sub';
    sub.textContent = inChat.has(vendorName(v).toLowerCase()) ? 'in this chat' : 'joins on its default model';
    b.append(name, sub);
    // mousedown, not click: the box must keep focus and its cursor.
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(v); });
    el.mentions.appendChild(b);
  });
  el.mentions.hidden = false;
}

function closeMentions() {
  mention.items = [];
  el.mentions.hidden = true;
}

function pickMention(v) {
  const q = mentionQuery();
  if (!q) return closeMentions();
  const end = el.input.selectionStart;
  const word = `@${vendorName(v)} `;
  el.input.value = el.input.value.slice(0, q.start) + word + el.input.value.slice(end);
  const caret = q.start + word.length;
  el.input.setSelectionRange(caret, caret);
  closeMentions();
  autoGrow();
  updateSendButton();
}

// Launches a member with the chat so far and opens a bubble for its reply.
// threadOf: the thread it answers in, or null for the main chat.
function ask(chatId, memberId, threadOf = null) {
  const thread = chats.get(chatId).thread;
  const member = memberById(thread, memberId);
  const prompt = buildPrompt(thread, memberId, { threadOf });
  const runKey = runKeyOf(chatId, memberId);
  pending[runKey] = { chatId, memberId, threadOf, text: '', stderr: '', started: Date.now() };
  if (chatId === currentId) {
    renderPendingRows();
    renderMembers();
    if (openThread === null && threadOf !== null) renderSummary(threadOf);
  }
  renderChatList();
  updateSendButton();

  api.run({ runKey, vendor: member.vendor, model: member.model, prompt }).then((started) => {
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
  const r = pendingRows[runKey];
  if (!r) return;
  const atBottom = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 40;
  r.bubble.textContent = p.text.trim();
  updatePendingMeta(runKey);
  if (atBottom) scrollToBottom();
}

// Turns the streamed reply into a message in its chat, or reports why there is none.
// outcome: { stopped, timedOut, timeoutSec } from agent:done.
function finishReply(runKey, code, why, { stopped = false, timedOut = false, timeoutSec = 0 } = {}) {
  const p = pending[runKey];
  if (!p) return;
  delete pending[runKey];
  if (pendingRows[runKey]) {
    pendingRows[runKey].row.remove();
    delete pendingRows[runKey];
  }
  const name = nameOf(p.memberId, chats.get(p.chatId));
  const reply = p.text.trim();
  const threadOf = p.threadOf || null;
  let m = null;
  if (reply) {
    m = post(p.chatId, { from: p.memberId, text: reply, endedAs: stopped ? 'stopped' : timedOut ? 'timed out' : null, threadOf });
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
    post(p.chatId, { from: 'system', threadOf, text: `${name} didn't reply: ${reason}.` + (detail ? `\n${detail}` : '') });
    api.log('warn', 'agent gave no reply', { runKey, code, why: why || null });
  } else {
    handOff(p.chatId, m);
  }
  if (p.chatId === currentId) {
    if (openThread === null && threadOf !== null) renderSummary(threadOf);
    renderMembers();
  }
  renderChatList();
  updateSendButton();
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

el.input.addEventListener('keydown', (e) => {
  // While the @ dropdown is open, arrows move in it and Enter or Tab picks.
  if (!el.mentions.hidden && mention.items.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % mention.items.length;
      updateMentions();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickMention(mention.items[mention.index]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMentions();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

el.input.addEventListener('input', () => {
  autoGrow();
  updateMentions();
  updateSendButton();
});
el.input.addEventListener('click', updateMentions);
el.input.addEventListener('blur', closeMentions);

el.newChat.addEventListener('click', startNewChat);
el.addAgent.addEventListener('click', () => showChooser('add'));
el.back.addEventListener('click', () => showThread(null));

// ---- Start-up -----------------------------------------------------------------

api.onAgentOutput(onOutput);
api.onAgentDone(({ runKey, code, stopped, timedOut, timeoutSec }) => finishReply(runKey, code, null, { stopped, timedOut, timeoutSec }));
api.onNotice(({ text }) => { if (current()) post(currentId, { from: 'system', text }); });

async function init() {
  const configs = await api.getAgentConfigs();
  for (const c of configs) vendors[c.id] = { id: c.id, name: c.name, color: c.color };
  // Asked once in the background; the chooser shows models once they arrive.
  api.listModels().then((m) => {
    models = m;
    if (!el.chooser.hidden && el.chooser.dataset.mode !== 'from') showChooser(el.chooser.dataset.mode, el.chooser.dataset.vendor || null);
  }).catch((err) => api.log('warn', 'could not list models', { error: err.message }));

  const { config } = await api.getConfig();
  el.folder.textContent = `Working folder: ${config.workingDir}`;

  const { chats: saved } = await api.listChats();
  for (const s of saved) chats.set(s.id, { ...s });
  // Open the most recent chat, or pick an agent for the first one.
  if (saved.length) await openChat(saved[0].id);
  else showChooser('new');
  api.log('info', 'chat window ready', { vendors: Object.keys(vendors), workingDir: config.workingDir, chats: saved.length });
}

init();
