// Chat window behaviour: the chat list, the agent picker, the message box and
// the thread of the open chat. Messages are drawn with textContent only, never
// innerHTML, so nothing an agent prints can run as code in this window.
// Sending launches the picked agent with the recent thread in the prompt and
// streams its reply into a bubble. A reply can be stopped while it streams,
// and once finished passed on to another agent in one click (relay).
// Chats are saved one file each (TM-53 Batch 2). A reply always lands in the
// chat it was asked in, even if Matt has switched to another one meanwhile.
// Threads (TM-53 Batch 3): an agent that writes @Name brings that agent in, in
// a thread under its reply. The main chat shows a live summary row under the
// thread's first message; opening it swaps the view to the thread.

// `api` is the global the preload bridge exposes (window.api); declaring it
// again here is a SyntaxError that stops this whole file from running.
const { createThread, addMessage, buildPrompt, chatTitle, findMention, hopsSinceMatt, HOP_LIMIT } = window.ChatThread;

const agents = {}; // id -> { id, name, color, status }
let selected = 'claude';
const chats = new Map(); // id -> { id, title, createdAt, updatedAt, thread? } (thread once loaded)
let currentId = null;
let openThread = null; // id of the open thread's first message, or null for the main chat
// agentId -> the reply being streamed: { chatId, threadOf, text, stderr, started }.
// One per agent: each agent runs one process at a time, whichever chat asked.
const pending = {};
const pendingRows = {}; // agentId -> { row, meta, bubble } while its chat is on screen
const summaryRows = {}; // thread's first message id -> its summary row in the main chat

const el = {
  chatList: document.getElementById('chat-list'),
  newChat: document.getElementById('new-chat'),
  thread: document.getElementById('thread'),
  empty: document.getElementById('empty'),
  picker: document.getElementById('picker'),
  form: document.getElementById('composer'),
  input: document.getElementById('message'),
  send: document.getElementById('send'),
  folder: document.getElementById('folder'),
  threadBar: document.getElementById('thread-bar'),
  threadLabel: document.getElementById('thread-label'),
  back: document.getElementById('back')
};

window.addEventListener('error', (e) => api.log('error', e.message, { file: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => api.log('error', String(e.reason && e.reason.message || e.reason)));

function agentName(id) {
  return agents[id] ? agents[id].name : id;
}

function names() {
  return Object.fromEntries(Object.values(agents).map(a => [a.id, a.name]));
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

// ---- Chats ------------------------------------------------------------------

function newChatId() {
  return crypto.randomUUID();
}

// A new chat is only saved once something is said in it, so empty chats
// don't pile up in the list.
function startNewChat() {
  const c = current();
  if (c && c.thread && c.thread.messages.length === 0) {
    el.input.focus();
    return;
  }
  const now = new Date().toISOString();
  const chat = { id: newChatId(), title: 'New chat', createdAt: now, updatedAt: now, thread: createThread() };
  chats.set(chat.id, chat);
  showChat(chat.id);
}

async function openChat(id) {
  const chat = chats.get(id);
  if (!chat) return;
  if (!chat.thread) {
    try {
      Object.assign(chat, await api.loadChat(id));
    } catch (err) {
      api.log('error', 'could not open chat', { id, error: err.message });
      return;
    }
  }
  showChat(id);
}

function showChat(id) {
  currentId = id;
  renderChatList();
  showThread(null);
}

// Switches the view between the main chat (null) and one of its threads.
function showThread(rootId) {
  openThread = rootId;
  const root = rootId === null ? null : current().thread.messages.find(m => m.id === rootId);
  el.threadBar.hidden = !root;
  if (root) el.threadLabel.textContent = `Thread on ${root.from === 'matt' ? 'your' : agentName(root.from) + "'s"} message`;
  renderThread();
  select(selected);
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
    item.className = 'chat-item' + (chat.id === currentId ? ' active' : '');
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

// ---- Thread -----------------------------------------------------------------

// Builds one message row. from: 'matt', 'system' or an agent id.
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
    row.style.setProperty('--agent-color', agents[from] ? agents[from].color : '#888');
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
    const { row } = createRow('system', '', `${agentName(m.handoff.from)} › ${agentName(m.handoff.to)} · Sent to ${agentName(m.handoff.to)} ›`);
    row.classList.add('handoff');
    return;
  }
  let metaText = `${agentName(m.from)} · ${timeLabel(m.ts)}` + (m.endedAs ? ` · ${m.endedAs}` : '');
  if (m.from === 'matt') {
    metaText = m.relayOf
      ? `To ${agentName(m.to)} · passing on ${agentName(m.relayOf)}'s reply · ${timeLabel(m.ts)}`
      : `To ${agentName(m.to)} · ${timeLabel(m.ts)}`;
  }
  const { row } = createRow(m.from, metaText, m.text);
  row.dataset.id = m.id;
  const buttons = [];
  if (agents[m.from]) {
    buttons.push(...Object.values(agents).filter(a => a.id !== m.from).map(a => ({
      label: `Send to ${a.name}`,
      title: `Pass this reply on to ${a.name}`,
      onClick: () => relay(m.from, m.text, a.id)
    })));
  }
  if (m.from !== 'system' && openThread === null) {
    buttons.push({ label: 'Reply in thread', title: 'Open a thread under this message', onClick: () => showThread(m.id) });
  }
  if (buttons.length) addActions(row, buttons);
}

function renderThread() {
  el.thread.replaceChildren(el.empty);
  Object.keys(pendingRows).forEach(id => delete pendingRows[id]);
  Object.keys(summaryRows).forEach(id => delete summaryRows[id]);
  const chat = current();
  el.empty.hidden = Boolean(chat && chat.thread.messages.length);
  if (!chat) return;
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
  const live = Object.keys(pending).find(id => pending[id].chatId === currentId && pending[id].threadOf === rootId);
  if (live) {
    const hop = msgs.filter(m => m.handoff).pop();
    const text = hop && hop.handoff.to === live
      ? `${agentName(hop.handoff.from)} ⇄ ${agentName(live)} talking…`
      : `${agentName(live)} replying in the thread…`;
    return { text, live };
  }
  if (!msgs.length) return null;
  const replies = msgs.filter(m => m.from !== 'system');
  const who = [...new Set(replies.filter(m => agents[m.from]).map(m => agentName(m.from)))];
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
  if (info.live) addActions(row, [{ label: 'Stop', title: `Stop ${agentName(info.live)}`, onClick: () => api.stopAgent(info.live) }]);
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
  for (const [agentId, p] of Object.entries(pending)) {
    if (!pendingInView(p) || pendingRows[agentId]) continue;
    const r = createRow(agentId, '', p.text.trim());
    r.row.classList.add('pending');
    addActions(r.row, [{ label: 'Stop', title: `Stop ${agentName(agentId)}`, onClick: () => api.stopAgent(agentId) }]);
    pendingRows[agentId] = r;
    updatePendingMeta(agentId);
  }
}

function removePendingRows() {
  for (const [agentId, r] of Object.entries(pendingRows)) {
    r.row.remove();
    delete pendingRows[agentId];
  }
}

function updatePendingMeta(agentId) {
  const p = pending[agentId];
  const r = pendingRows[agentId];
  if (!p || !r) return;
  // Antigravity can take ~30s, so the wait shows a seconds counter.
  r.meta.textContent = p.text
    ? `${agentName(agentId)} · replying…`
    : `${agentName(agentId)} · thinking… ${Math.round((Date.now() - p.started) / 1000)}s`;
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

// Relay: Matt passes one agent's finished reply to another agent.
function relay(fromAgent, text, to) {
  if (pending[to]) {
    post(currentId, { from: 'system', text: busyText(to), threadOf: openThread });
    scrollToBottom(); // the note lands at the bottom, likely out of view of the button clicked
    return;
  }
  post(currentId, { from: 'matt', to, text, relayOf: fromAgent, threadOf: openThread });
  ask(currentId, to, openThread);
}

// An agent's finished reply that names another agent with @Name brings that
// agent in, in a thread under the reply (or in the thread it was already in).
// After HOP_LIMIT handoffs in a row Matt has to say something in the thread.
function handOff(chatId, m) {
  const to = findMention(m.text, m.from, names());
  if (!to) return;
  const root = m.threadOf || m.id;
  const hops = hopsSinceMatt(chats.get(chatId).thread, root);
  if (hops >= HOP_LIMIT) {
    post(chatId, { from: 'system', threadOf: root, text: `${agentName(m.from)} asked for ${agentName(to)}, but the agents have handed off ${HOP_LIMIT} times in a row. Reply in this thread to keep going.` });
    api.log('info', 'hop limit reached', { chatId, root, from: m.from, to });
    return;
  }
  if (pending[to]) {
    post(chatId, { from: 'system', threadOf: root, text: `${agentName(m.from)} asked for ${agentName(to)}. ${busyText(to)}` });
    return;
  }
  post(chatId, { from: 'system', threadOf: root, handoff: { from: m.from, to }, text: `${agentName(m.from)} › ${agentName(to)}` });
  api.log('info', 'handoff', { chatId, root, from: m.from, to, hop: hops + 1 });
  ask(chatId, to, root);
}

function busyText(agentId) {
  const p = pending[agentId];
  const where = p && p.chatId !== currentId && chats.get(p.chatId) ? ` in "${chats.get(p.chatId).title}"` : '';
  return `${agentName(agentId)} is still answering${where}. Send it once ${agentName(agentId)} is done, or stop it first.`;
}

// ---- Agent picker -------------------------------------------------------------

function renderPicker() {
  el.picker.replaceChildren();
  for (const a of Object.values(agents)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick' + (a.status === 'working' ? ' working' : '');
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(a.id === selected));
    btn.style.setProperty('--agent-color', a.color);
    btn.addEventListener('click', () => select(a.id));

    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.textContent = a.name;
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = a.status === 'working' ? 'working…' : 'idle';

    btn.append(dot, name, status);
    el.picker.appendChild(btn);
  }
}

function select(id) {
  if (!agents[id]) return;
  selected = id;
  el.input.placeholder = `${openThread === null ? 'Message' : 'Reply in the thread to'} ${agentName(id)}… (Enter to send, Shift+Enter for a new line)`;
  renderPicker();
  updateSendButton();
  el.input.focus();
}

// ---- Message box --------------------------------------------------------------

function autoGrow() {
  el.input.style.height = 'auto';
  // scrollHeight leaves out the border; without it the box always overflows by 2px.
  el.input.style.height = (el.input.scrollHeight + el.input.offsetHeight - el.input.clientHeight) + 'px';
}

// Send is off while the box is empty or the picked agent is still answering
// (in any chat: a new launch would cut its reply off; use Stop instead).
function updateSendButton() {
  el.send.disabled = !el.input.value.trim() || Boolean(pending[selected]) || !current();
  el.send.title = pending[selected] ? busyText(selected) : '';
}

function send() {
  const text = el.input.value.trim();
  if (!text || pending[selected] || !current()) return;
  const to = selected;
  post(currentId, { from: 'matt', to, text, threadOf: openThread });
  el.input.value = '';
  autoGrow();
  ask(currentId, to, openThread);
}

// Launches the agent with the chat so far and opens a bubble for its reply.
// threadOf: the thread it answers in, or null for the main chat.
function ask(chatId, agentId, threadOf = null) {
  const prompt = buildPrompt(chats.get(chatId).thread, agentId, { names: names(), threadOf });
  pending[agentId] = { chatId, threadOf, text: '', stderr: '', started: Date.now() };
  if (chatId === currentId) {
    renderPendingRows();
    if (openThread === null && threadOf !== null) renderSummary(threadOf);
  }
  renderChatList();
  updateSendButton();

  api.sendInput(agentId, prompt).then((started) => {
    if (started === false) finishReply(agentId, null, 'it could not be started');
  }).catch((err) => finishReply(agentId, null, err.message));
}

function onOutput({ agentId, stream, text }) {
  const p = pending[agentId];
  if (!p || !text) return;
  if (stream === 'stderr') {
    p.stderr = (p.stderr + text).slice(-2000);
    return;
  }
  p.text += text;
  const r = pendingRows[agentId];
  if (!r) return;
  const atBottom = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 40;
  r.bubble.textContent = p.text.trim();
  updatePendingMeta(agentId);
  if (atBottom) scrollToBottom();
}

// Turns the streamed reply into a message in its chat, or reports why there is none.
// outcome: { stopped, timedOut, timeoutSec } from agent:done.
function finishReply(agentId, code, why, { stopped = false, timedOut = false, timeoutSec = 0 } = {}) {
  const p = pending[agentId];
  if (!p) return;
  delete pending[agentId];
  if (pendingRows[agentId]) {
    pendingRows[agentId].row.remove();
    delete pendingRows[agentId];
  }
  const reply = p.text.trim();
  const threadOf = p.threadOf || null;
  let m = null;
  if (reply) {
    m = post(p.chatId, { from: agentId, text: reply, endedAs: stopped ? 'stopped' : timedOut ? 'timed out' : null, threadOf });
  }
  if (timedOut) {
    post(p.chatId, { from: 'system', threadOf, text: `${agentName(agentId)} took longer than ${durationLabel(timeoutSec)} and was stopped.` + (reply ? ' Its reply so far is above.' : '') + ' The limit is timeoutSec in config.json.' });
    api.log('warn', 'agent timed out', { agentId, timeoutSec });
  } else if (stopped) {
    if (!reply) post(p.chatId, { from: 'system', threadOf, text: `${agentName(agentId)} was stopped before it replied.` });
  } else if (code !== 0 || !reply) {
    const notFound = /ENOENT/.test(p.stderr);
    const reason = why || (notFound ? `the app couldn't find ${agentName(agentId)}. Check its path in config.json`
      : code === 0 ? 'it finished without saying anything' : `it exited with code ${code}`);
    const detail = p.stderr.trim().split(/\r?\n/).slice(-3).join('\n');
    post(p.chatId, { from: 'system', threadOf, text: `${agentName(agentId)} didn't reply: ${reason}.` + (detail ? `\n${detail}` : '') });
    api.log('warn', 'agent gave no reply', { agentId, code, why: why || null });
  } else {
    handOff(p.chatId, m);
  }
  if (p.chatId === currentId && openThread === null && threadOf !== null) renderSummary(threadOf);
  renderChatList();
  updateSendButton();
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

el.input.addEventListener('input', () => {
  autoGrow();
  updateSendButton();
});

el.newChat.addEventListener('click', startNewChat);
el.back.addEventListener('click', () => showThread(null));

// ---- Start-up -----------------------------------------------------------------

api.onAgentStatus(({ agentId, status }) => {
  if (!agents[agentId]) return;
  agents[agentId].status = status;
  renderPicker();
});

api.onAgentOutput(onOutput);
api.onAgentDone(({ agentId, code, stopped, timedOut, timeoutSec }) => finishReply(agentId, code, null, { stopped, timedOut, timeoutSec }));
api.onNotice(({ text }) => { if (current()) post(currentId, { from: 'system', text }); });

async function init() {
  const configs = await api.getAgentConfigs();
  for (const c of configs) agents[c.id] = { id: c.id, name: c.name, color: c.color, status: c.status };
  if (!agents[selected] && configs.length) selected = configs[0].id;

  const { config } = await api.getConfig();
  el.folder.textContent = `Working folder: ${config.workingDir}`;

  const { chats: saved } = await api.listChats();
  for (const s of saved) chats.set(s.id, { ...s });
  select(selected);
  // Open the most recent chat, or a fresh one the first time.
  if (saved.length) await openChat(saved[0].id);
  else startNewChat();
  api.log('info', 'chat window ready', { agents: Object.keys(agents), workingDir: config.workingDir, chats: saved.length });
}

init();
