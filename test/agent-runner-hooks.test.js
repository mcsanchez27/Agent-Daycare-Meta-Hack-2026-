const test = require('node:test');
const assert = require('node:assert/strict');
const AgentRunner = require('../src/agent-runner');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {}, exception() {}, createLineSink() { return { push() {}, flush() {} }; } };

function makeRunner() {
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, d) => sent.push({ ch, d }) } };
  const runner = new AgentRunner(win, quietLogger);
  clearInterval(runner.scanInterval); // no tasklist polling in tests
  return { runner, sent, statuses: () => sent.filter(m => m.ch === 'agent:status').map(m => m.d.status) };
}

test('a Claude session walks through idle -> working -> needs_input -> idle -> gone', () => {
  const { runner, sent, statuses } = makeRunner();
  const ev = (name, extra = {}) => runner.handleHookEvent('claude', { hook_event_name: name, session_id: 's1', cwd: 'C:\\proj', ...extra });

  ev('SessionStart');
  assert.equal(runner.agents.claude.status, 'idle');

  ev('UserPromptSubmit', { prompt: 'fix the bug' });
  ev('PreToolUse', { tool_name: 'Edit' });
  assert.equal(runner.agents.claude.status, 'working');

  ev('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
  assert.equal(runner.agents.claude.status, 'needs_input');
  assert.equal(runner.agents.claude.unreadPrompt, 'Claude needs your permission to use Bash');
  const prompt = sent.find(m => m.ch === 'agent:prompt');
  assert.equal(prompt.d.promptSnippet, 'Claude needs your permission to use Bash');
  assert.ok(sent.some(m => m.ch === 'agent:team-message' && m.d.type === 'alert'));

  ev('PreToolUse', { tool_name: 'Bash' }); // user approved; tool runs
  assert.equal(runner.agents.claude.status, 'working');
  assert.equal(runner.agents.claude.unreadPrompt, null);

  ev('Stop');
  assert.equal(runner.agents.claude.status, 'idle');

  ev('SessionEnd');
  assert.equal(runner.agents.claude.status, 'sleeping');
  assert.equal(runner.hookSessions.claude.size, 0);

  assert.deepEqual(statuses(), ['idle', 'working', 'working', 'needs_input', 'working', 'idle', 'sleeping']);
});

test('with two sessions, any session needing input wins, then any working, then idle', () => {
  const { runner } = makeRunner();
  const ev = (sid, name, extra = {}) => runner.handleHookEvent('claude', { hook_event_name: name, session_id: sid, ...extra });

  ev('a', 'Stop');
  ev('b', 'PreToolUse', { tool_name: 'Read' });
  assert.equal(runner.agents.claude.status, 'working');

  ev('a', 'Notification', { message: 'Waiting for your input' });
  assert.equal(runner.agents.claude.status, 'needs_input');

  ev('a', 'Stop');
  assert.equal(runner.agents.claude.status, 'working'); // b is still working

  ev('b', 'Stop');
  assert.equal(runner.agents.claude.status, 'idle');
  assert.equal(runner.hookSessions.claude.size, 2);
});

test('unknown agent ids are rejected; unknown event names are tolerated', () => {
  const { runner } = makeRunner();
  assert.equal(runner.handleHookEvent('nope', { hook_event_name: 'Stop' }), false);
  assert.equal(runner.handleHookEvent('claude', { hook_event_name: 'SomethingNew', session_id: 'x' }), true);
  assert.equal(runner.agents.claude.status, 'working'); // new session defaults to working
});

test('stale sessions expire and the agent goes back to sleep', () => {
  const { runner } = makeRunner();
  runner.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 'old' });
  runner.hookSessions.claude.get('old').updatedAt = Date.now() - AgentRunner.HOOK_SESSION_TTL_MS - 1;
  assert.equal(runner.expireHookSessions(), true);
  assert.equal(runner.agents.claude.status, 'sleeping');
  assert.equal(runner.expireHookSessions(), false);
});

test('the process scanner respects hook-reported state and clears sessions when the process vanishes', () => {
  const { runner } = makeRunner();
  let procs = new Map([['claude.exe', '4242']]);
  runner.listProcesses = () => procs;

  runner.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 's' });
  assert.equal(runner.agents.claude.status, 'idle');

  runner.checkExternalProcesses();
  assert.equal(runner.agents.claude.externalPid, '4242');
  assert.equal(runner.agents.claude.status, 'idle', 'hook state wins over "process exists"');

  procs = new Map();
  runner.checkExternalProcesses();
  assert.equal(runner.agents.claude.externalPid, null);
  assert.equal(runner.hookSessions.claude.size, 0, 'sessions cleared when the process is gone');
  assert.equal(runner.agents.claude.status, 'sleeping');

  // Without hook sessions the scanner behaves as before: a found process means working.
  procs = new Map([['codex.exe', '7']]);
  runner.checkExternalProcesses();
  assert.equal(runner.agents.codex.status, 'working');
});
