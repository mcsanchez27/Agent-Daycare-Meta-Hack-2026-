// Pet window: a small always-on-top chat with the agent Matt took with
// him. It owns no chat state; the main window runs the agent and relays
// replies back here through the preload bridge.
const log = document.getElementById('pet-log');
const form = document.getElementById('pet-form');
const input = document.getElementById('pet-input');
const nameEl = document.getElementById('pet-name');
const agentName = new URLSearchParams(location.search).get('name') || 'Agent';
nameEl.textContent = agentName;
document.title = `Daycare Pet — ${agentName}`;

function add(text, who) {
  const row = document.createElement('div');
  row.className = `pet-msg ${who}`;
  row.textContent = text;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

add(`${agentName} is with you. Messages go to your chat in Daycare.`, 'sys');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  add(text, 'matt');
  api.petSend(text);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

api.onPetReply(({ text }) => {
  if (text) add(text, 'agent');
});
