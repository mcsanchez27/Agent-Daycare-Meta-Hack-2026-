// Chat window behaviour: the agent picker, the message box and the shared
// thread. Messages are drawn with textContent only, never innerHTML, so
// nothing an agent prints can run as code in this window.
// Sending launches the picked agent with the recent thread in the prompt and
// streams its reply into a bubble.

// `api` is the global the preload bridge exposes (window.api); declaring it
// again here is a SyntaxError that stops this whole file from running.
const { createThread, addMessage, buildPrompt } = window.ChatThread;


const thread = createThread();
const agents = {}; // id -> { id, name, color, status }
let selected = 'claude';
const pending = {}; // agentId -> the reply being streamed: { row, meta, bubble, text, stderr, timer }

const el = {
  thread: document.getElementById('thread'),
  empty: document.getElementById('empty'),
  picker: document.getElementById('picker'),
  form: document.getElementById('composer'),
  input: document.getElementById('message'),
  send: document.getElementById('send'),
  folder: document.getElementById('folder')
};

window.addEventListener('error', (e) => api.log('error', e.message, { file: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => api.log('error', String(e.reason && e.reason.message || e.reason)));

function agentName(id) {
  return agents[id] ? agents[id].name : id;
}

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
  if (atBottom || from === 'matt') scrollToBottom();
  return { row, meta, bubble };
}

function scrollToBottom() {
  el.thread.scrollTop = el.thread.scrollHeight;
}

function renderMessage(m) {
  const metaText = m.from === 'matt' ? `To ${agentName(m.to)} · ${timeLabel(m.ts)}` : `${agentName(m.from)} · ${timeLabel(m.ts)}`;
  createRow(m.from, metaText, m.text);
}

function post(message) {
  renderMessage(addMessage(thread, message));
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
  el.input.placeholder = `Message ${agentName(id)}… (Enter to send, Shift+Enter for a new line)`;
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
// (a new launch would cut its reply off; Batch 4 adds a Stop button).
function updateSendButton() {
  el.send.disabled = !el.input.value.trim() || Boolean(pending[selected]);
  el.send.title = pending[selected] ? `${agentName(selected)} is still answering` : '';
}

function send() {
  const text = el.input.value.trim();
  if (!text || pending[selected]) return;
  const to = selected;
  post({ from: 'matt', to, text });
  el.input.value = '';
  autoGrow();
  ask(to);
}

// Launches the agent with the thread so far and opens a bubble for its reply.
function ask(agentId) {
  const prompt = buildPrompt(thread, agentId, { names: Object.fromEntries(Object.values(agents).map(a => [a.id, a.name])) });
  const row = createRow(agentId, `${agentName(agentId)} · thinking…`, '');
  row.row.classList.add('pending');
  // Antigravity can take ~30s, so the wait shows a seconds counter.
  const started = Date.now();
  const timer = setInterval(() => {
    const p = pending[agentId];
    if (p && !p.text) p.meta.textContent = `${agentName(agentId)} · thinking… ${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  pending[agentId] = { ...row, text: '', stderr: '', timer };
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
  if (!p.text) p.meta.textContent = `${agentName(agentId)} · replying…`;
  const atBottom = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 40;
  p.text += text;
  p.bubble.textContent = p.text.trim();
  if (atBottom) scrollToBottom();
}

// Turns the streamed bubble into a thread message, or reports why there is none.
function finishReply(agentId, code, why) {
  const p = pending[agentId];
  if (!p) return;
  delete pending[agentId];
  clearInterval(p.timer);
  const reply = p.text.trim();
  if (reply) {
    const m = addMessage(thread, { from: agentId, text: reply });
    p.row.classList.remove('pending');
    p.bubble.textContent = m.text;
    p.meta.textContent = `${agentName(agentId)} · ${timeLabel(m.ts)}`;
  } else {
    p.row.remove();
  }
  if (code !== 0 || !reply) {
    const notFound = /ENOENT/.test(p.stderr);
    const reason = why || (notFound ? `the app couldn't find ${agentName(agentId)}. Check its path in config.json`
      : code === 0 ? 'it finished without saying anything' : `it exited with code ${code}`);
    const detail = p.stderr.trim().split(/\r?\n/).slice(-3).join('\n');
    post({ from: 'system', text: `${agentName(agentId)} didn't reply: ${reason}.` + (detail ? `\n${detail}` : '') });
    api.log('warn', 'agent gave no reply', { agentId, code, why: why || null });
  }
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

// ---- Start-up -----------------------------------------------------------------

api.onAgentStatus(({ agentId, status }) => {
  if (!agents[agentId]) return;
  agents[agentId].status = status;
  renderPicker();
});

api.onAgentOutput(onOutput);
api.onAgentDone(({ agentId, code }) => finishReply(agentId, code));
api.onNotice(({ text }) => post({ from: 'system', text }));

async function init() {
  const configs = await api.getAgentConfigs();
  for (const c of configs) agents[c.id] = { id: c.id, name: c.name, color: c.color, status: c.status };
  if (!agents[selected] && configs.length) selected = configs[0].id;

  const { config } = await api.getConfig();
  el.folder.textContent = `Working folder: ${config.workingDir}`;

  select(selected);
  updateSendButton();
  api.log('info', 'chat window ready', { agents: Object.keys(agents), workingDir: config.workingDir });
}

init();
