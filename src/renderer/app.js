// Chat window behaviour: the agent picker, the message box and the shared
// thread. Messages are drawn with textContent only, never innerHTML, so
// nothing an agent prints can run as code in this window.
// TM-47 Batch 1 is the shell only: sending adds Matt's message to the thread.
// Batch 2 launches the agent and adds its reply.

// `api` is the global the preload bridge exposes (window.api); declaring it
// again here is a SyntaxError that stops this whole file from running.
const { createThread, addMessage } = window.ChatThread;

const thread = createThread();
const agents = {}; // id -> { id, name, color, status }
let selected = 'claude';
let notConnectedShown = false;

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

function renderMessage(m) {
  const row = document.createElement('div');
  const meta = document.createElement('div');
  const bubble = document.createElement('div');
  meta.className = 'meta';
  bubble.className = 'bubble';
  bubble.textContent = m.text;

  if (m.from === 'matt') {
    row.className = 'msg matt';
    meta.textContent = `To ${agentName(m.to)} · ${timeLabel(m.ts)}`;
  } else if (m.from === 'system') {
    row.className = 'msg system';
  } else {
    row.className = 'msg agent';
    row.style.setProperty('--agent-color', agents[m.from] ? agents[m.from].color : '#888');
    meta.textContent = `${agentName(m.from)} · ${timeLabel(m.ts)}`;
  }

  if (m.from !== 'system') row.appendChild(meta);
  row.appendChild(bubble);
  el.empty.hidden = true;
  el.thread.appendChild(row);
  el.thread.scrollTop = el.thread.scrollHeight;
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
  el.input.focus();
}

// ---- Message box --------------------------------------------------------------

function autoGrow() {
  el.input.style.height = 'auto';
  // scrollHeight leaves out the border; without it the box always overflows by 2px.
  el.input.style.height = (el.input.scrollHeight + el.input.offsetHeight - el.input.clientHeight) + 'px';
}

function updateSendButton() {
  el.send.disabled = !el.input.value.trim();
}

function send() {
  const text = el.input.value.trim();
  if (!text) return;
  post({ from: 'matt', to: selected, text });
  el.input.value = '';
  autoGrow();
  updateSendButton();
  if (!notConnectedShown) {
    notConnectedShown = true;
    post({ from: 'system', text: 'Agents are not connected yet. Replies arrive in TM-47 Batch 2.' });
  }
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
