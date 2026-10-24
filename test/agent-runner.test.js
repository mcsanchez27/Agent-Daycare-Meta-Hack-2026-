const test = require('node:test');
const assert = require('node:assert/strict');
const AgentRunner = require('../src/agent-runner');

function makeRunner() {
  const sent = [];
  const logEvents = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, d) => sent.push({ ch, d }) } };

  const testLogger = {
    info(agentId, msg, data) { logEvents.push({level: 'info', agentId, msg, data}); },
    warn(agentId, msg, data) { logEvents.push({level: 'warn', agentId, msg, data}); },
    error(agentId, msg, data) { logEvents.push({level: 'error', agentId, msg, data}); },
    debug(agentId, msg, data) { logEvents.push({level: 'debug', agentId, msg, data}); },
    exception() {},
    createLineSink() { return { push() {}, flush() {} }; }
  };

  const runner = new AgentRunner(win, testLogger);
  return { runner, sent, logEvents };
}

const req = (o = {}) => ({ runKey: 'chat1/m1', vendor: 'claude', model: null, prompt: 'x', ...o });

test('run refuses an unknown vendor and an empty prompt', () => {
  const { runner } = makeRunner();
  assert.throws(() => runner.run(req({ vendor: 'deepseek' })), /not found/);
  assert.throws(() => runner.run(req({ prompt: '   ' })), /prompt is required/);
});

test('typed models are checked before anything is launched', () => {
  const { runner, sent } = makeRunner();
  runner._spawnAgentProcess = () => { throw new Error('must not launch'); };
  assert.equal(runner.run(req({ vendor: 'codex', model: 'gpt 5 & del' })), false);
  assert.match(sent.find(s => s.ch === 'agent:output').d.text, /model name/);
  assert.ok(AgentRunner.MODEL_TEXT.test('gpt-5.1-codex'));
  for (const bad of ['gpt 5', 'a&b', '']) assert.ok(!AgentRunner.MODEL_TEXT.test(bad), bad);
});

test('supported agents exist (V1 + grok)', () => {
  const { runner } = makeRunner();
  assert.deepEqual(Object.keys(runner.agents), ['antigravity', 'claude', 'codex', 'grok']);
});

test('agent arguments: everyone may write in the working folder; codex reads the prompt from stdin', () => {
  const { runner } = makeRunner();
  assert.deepEqual(runner._buildAgentArgs('antigravity', 'hi'), { args: ['--mode', 'accept-edits', '--sandbox', '--dangerously-skip-permissions', '--output-format', 'stream-json', '-p', 'hi'], stdin: null });
  assert.deepEqual(runner._buildAgentArgs('claude', 'hi'), { args: ['-p', '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '--strict-mcp-config', '--allowedTools', 'Bash,PowerShell', '--output-format', 'stream-json', '--verbose', 'hi'], stdin: null });
  assert.deepEqual(runner._buildAgentArgs('codex', 'hi'), { args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-'], stdin: 'hi' });
  // grok: the prompt goes in a file, so every argument stays shim-safe (its grok.cmd runs through cmd.exe).
  const grok = runner._buildAgentArgs('grok', 'hi there & "you"', 'grok-4.6', '0f2c7a1e-1b2c-4d3e-8f90-123456789abc');
  assert.deepEqual(grok, { args: ['--output-format', 'streaming-messages-json', '--permission-mode', 'acceptEdits', '--always-approve', '-m', 'grok-4.6', '--resume', '0f2c7a1e-1b2c-4d3e-8f90-123456789abc', '--prompt-file', '.daycare-prompt.txt'], stdin: null, promptFile: 'hi there & "you"' });
  assert.ok(AgentRunner.launchCommand('C:\\Users\\Matth\\AppData\\Roaming\\npm\\grok.cmd', grok.args, 'win32'), 'safe for the grok.cmd shim');
  // Codex's arguments must stay safe for a codex.cmd shim.
  assert.ok(AgentRunner.launchCommand('C:\\npm\\codex.cmd', runner._buildAgentArgs('codex', 'x').args, 'win32'));
});

test('model flags per vendor', () => {
  const { runner } = makeRunner();
  assert.deepEqual(runner._buildAgentArgs('claude', 'hi', 'opus').args, ['-p', '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '--strict-mcp-config', '--allowedTools', 'Bash,PowerShell', '--output-format', 'stream-json', '--verbose', '--model', 'opus', 'hi']);
  assert.deepEqual(runner._buildAgentArgs('antigravity', 'hi', 'gemini-4-argon-high').args, ['--mode', 'accept-edits', '--sandbox', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--model', 'gemini-4-argon-high', '-p', 'hi']);
  assert.deepEqual(runner._buildAgentArgs('codex', 'hi', 'gpt-5'), { args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-m', 'gpt-5', '-'], stdin: 'hi' });
  assert.ok(AgentRunner.launchCommand('C:\\npm\\codex.cmd', runner._buildAgentArgs('codex', 'x', 'gpt-5.1-codex').args, 'win32'), 'still safe for codex.cmd');
});

test('launchCommand runs a safe Codex .cmd shim through cmd.exe and refuses anything a shell could misread', () => {
  const lc = AgentRunner.launchCommand;
  const shim = 'C:\\Users\\Matth\\AppData\\Roaming\\npm\\codex.cmd';
  const cmd = lc(shim, ['exec', '--skip-git-repo-check', '-'], 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(cmd.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(cmd.args, ['/d', '/s', '/c', `""${shim}" exec --skip-git-repo-check -"`]);
  assert.equal(cmd.options.windowsVerbatimArguments, true);
  // A prompt as an argument would reach the shell, so it is refused.
  assert.equal(lc(shim, ['-p', 'hi & del *'], 'win32'), null);
  assert.equal(lc(shim, ['-p', 'two words'], 'win32'), null);
  assert.equal(lc('C:\\x\\a&b.cmd', ['exec'], 'win32'), null);
  // Real executables are run directly with any arguments.
  assert.deepEqual(lc('C:\\x\\claude.exe', ['-p', 'hi & bye'], 'win32'), { file: 'C:\\x\\claude.exe', args: ['-p', 'hi & bye'], options: {} });
  assert.deepEqual(lc('/usr/bin/codex.cmd', ['-p', 'a b'], 'linux').args, ['-p', 'a b']);
});

test('resolveExecutable: configured path, then `where` on Windows (.exe first, npm .cmd shims found)', () => {
  const r = AgentRunner.resolveExecutable;
  const agent = { path: 'C:\\nope\\codex.exe', command: 'codex.exe' };
  assert.equal(r({ ...agent, path: 'C:\\ok\\codex.exe' }, { platform: 'win32', exists: () => true, where: () => [] }), 'C:\\ok\\codex.exe');

  const npm = { 'codex': ['C:\\npm\\codex', 'C:\\npm\\codex.cmd'] };
  assert.equal(r(agent, { platform: 'win32', exists: () => false, where: n => npm[n] || [] }), 'C:\\npm\\codex.cmd', 'codex.exe missing, codex.cmd found');

  const both = { 'codex': ['C:\\npm\\codex.cmd', 'C:\\bin\\codex.exe'] };
  assert.equal(r({ ...agent, command: 'codex' }, { platform: 'win32', exists: () => false, where: n => both[n] || [] }), 'C:\\bin\\codex.exe');

  assert.equal(r(agent, { platform: 'win32', exists: () => false, where: () => [] }), 'codex.exe', 'nothing found: spawn reports it');
  assert.equal(r({ path: '/nope', command: 'codex' }, { platform: 'linux', exists: () => false, where: () => { throw new Error('not used'); } }), 'codex');
});

test('codex gets the whole prompt on stdin, shell characters and new lines intact', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runner, sent } = makeRunner();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-codex-'));
  // A stand-in Codex: node, printing its arguments and what it read on stdin.
  const script = path.join(dir, 'fake.js');
  fs.writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:s})));");
  runner.agents.codex.path = process.execPath;
  runner._buildAgentArgs = () => ({ args: [script, 'exec', '-'], stdin: 'hi & "you" | %PATH%\nline 2' });
  runner.workingDir = dir;

  const done = new Promise(resolve => { runner._send = (ch, d) => { sent.push({ ch, d }); if (ch === 'agent:done') resolve(d); }; });
  assert.equal(runner.run(req({ vendor: 'codex', prompt: 'ignored' })), true);
  const result = await done;
  assert.equal(result.code, 0);
  const out = JSON.parse(sent.filter(s => s.ch === 'agent:output' && s.d.stream === 'stdout').map(s => s.d.text).join(''));
  assert.deepEqual(out.args, ['exec', '-']);
  assert.equal(out.stdin, 'hi & "you" | %PATH%\nline 2');
});

test('versionCommand runs executables directly and only routes safe Windows batch shims through cmd.exe', () => {
  const vc = AgentRunner.versionCommand;
  assert.deepEqual(vc('C:\\tools\\claude.exe', 'win32'), { file: 'C:\\tools\\claude.exe', args: ['--version'], options: {} });
  assert.deepEqual(vc('claude', 'win32'), { file: 'claude', args: ['--version'], options: {} });
  assert.deepEqual(vc('/home/me/claude.cmd', 'linux'), { file: '/home/me/claude.cmd', args: ['--version'], options: {} });

  const shim = 'C:\\Users\\Matt Sanchez\\AppData\\Roaming\\npm\\claude.cmd';
  const viaCmd = vc(shim, 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(viaCmd.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(viaCmd.args, ['/d', '/s', '/c', `""${shim}" --version"`]);
  assert.equal(viaCmd.options.windowsVerbatimArguments, true);
  assert.equal(vc(shim, 'win32', {}).file, 'cmd.exe');

  // Anything cmd.exe could interpret is refused rather than escaped.
  for (const bad of ['C:\\x\\a&b.cmd', 'C:\\x\\a|b.cmd', 'C:\\x\\%TEMP%\\a.cmd', 'C:\\x\\a"b.cmd', 'C:\\x\\a^b.cmd', 'C:\\x\\a!b.cmd', 'relative\\a.cmd']) {
    assert.equal(vc(bad, 'win32'), null, bad);
  }
});

// Ported from Jules PRs #28, #7, #6 and #2, rewritten for the async scanAgents.

test('scanAgents falls back to "Installed" when the --version check fails', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runner, logEvents } = makeRunner();
  // A real file that exists but cannot be executed, on any platform.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-scan-'));
  const notExe = path.join(dir, 'not-an-executable.txt');
  fs.writeFileSync(notExe, 'hello');
  runner.agents = { testagent: { id: 'testagent', name: 'Test Agent', path: notExe, command: 'testagent', status: 'idle' } };

  const results = await runner.scanAgents();

  assert.equal(runner.agents.testagent.installed, true, 'installed flag stays true: the file exists');
  assert.equal(runner.agents.testagent.version, 'Installed');
  assert.equal(results[0].version, 'Installed');
  const dbg = logEvents.find(l => l.level === 'debug' && l.msg === '--version check failed');
  assert.ok(dbg, 'the failed version check is logged at debug');
  assert.equal(dbg.data.path, notExe);
});

test('scanAgents reports an agent missing from PATH as not installed and logs why', async () => {
  const { runner, logEvents } = makeRunner();
  runner.agents = { 'fake-agent': { id: 'fake-agent', name: 'Fake Agent', path: '/definitely/does/not/exist/fake-agent-bin', command: 'this_command_does_not_exist_at_all_12345', status: 'idle' } };

  const results = await runner.scanAgents();

  assert.equal(results.length, 1);
  assert.equal(results[0].installed, false);
  assert.equal(runner.agents['fake-agent'].installed, false);
  const dbg = logEvents.find(l => l.level === 'debug' && l.msg === 'not found on PATH');
  assert.ok(dbg, 'expected log.debug "not found on PATH"');
  assert.equal(dbg.agentId, 'fake-agent');
  assert.equal(dbg.data.path, '/definitely/does/not/exist/fake-agent-bin');
  assert.ok(dbg.data.error.length > 0, 'the underlying error message is captured');
});

test('stop logs a warning if child.kill throws and still clears the process', () => {
  const { runner, logEvents } = makeRunner();
  // No pid: on Windows killTree would run a real taskkill on it instead of kill().
  runner.processes.set('chat1/m1', { vendor: 'claude', run: 1, kill() { throw new Error('kill failed hard'); } });

  runner.stop('chat1/m1');

  const warn = logEvents.find(l => l.level === 'warn' && l.msg === 'kill failed');
  assert.ok(warn, 'a "kill failed" warning is logged');
  assert.equal(warn.agentId, 'claude');
  assert.equal(warn.data.error, 'kill failed hard');
  assert.equal(runner.processes.has('chat1/m1'), false, 'the dead handle is dropped anyway');
});

test('agent output reaches the window as plain text too, tagged with the run', () => {
  const { runner, sent } = makeRunner();
  runner.emitOutput({ runKey: 'chat1/m1', vendor: 'claude', run: 3 }, '\x1b[1mHello\x1b[0m there');
  const out = sent.find(s => s.ch === 'agent:output').d;
  assert.equal(out.runKey, 'chat1/m1');
  assert.equal(out.text, 'Hello there');
  assert.equal(out.raw, '\x1b[1mHello\x1b[0m there');
  assert.equal(out.run, 3);
  assert.equal(out.stream, 'stdout');
});

test('killTree uses taskkill /T on Windows so a .cmd shim\'s children die too', () => {
  const calls = [];
  const child = { pid: 99, kill: () => calls.push('kill') };
  AgentRunner.killTree(child, 'win32', (file, args) => calls.push([file, args]));
  assert.deepEqual(calls, [['taskkill', ['/pid', '99', '/T', '/F']]]);
  calls.length = 0;
  AgentRunner.killTree(child, 'linux', () => calls.push('taskkill'));
  assert.deepEqual(calls, ['kill']);
});

test('Stop ends a running agent and its done event says it was stopped', async () => {
  const os = require('node:os');
  const { runner } = makeRunner();
  runner.agents.claude.path = process.execPath;
  runner._buildAgentArgs = () => ({ args: ['-e', 'process.stdout.write("partial"); setInterval(() => {}, 1000)'], stdin: null });
  runner.workingDir = os.tmpdir();
  const events = [];
  const done = new Promise(resolve => { runner._send = (ch, d) => { events.push({ ch, d }); if (ch === 'agent:done') resolve(d); }; });
  runner.run(req());
  await new Promise(r => setTimeout(r, 300));
  runner.stop('chat1/m1');
  const d = await done;
  assert.equal(d.stopped, true);
  assert.equal(d.runKey, 'chat1/m1');
  assert.equal(runner.processes.has('chat1/m1'), false);
});

test('two runs of one vendor are separate', async () => {
  const os = require('node:os');
  const { runner } = makeRunner();
  runner.agents.claude.path = process.execPath;
  runner._buildAgentArgs = () => ({ args: ['-e', 'setInterval(() => {}, 1000)'], stdin: null });
  runner.workingDir = os.tmpdir();
  const done = {};
  const ended = new Promise(resolve => { runner._send = (ch, d) => { if (ch === 'agent:done') { done[d.runKey] = d; if (Object.keys(done).length === 2) resolve(); } }; });
  assert.equal(runner.run(req({ runKey: 'a/m1' })), true);
  assert.equal(runner.run(req({ runKey: 'b/m1' })), true);
  runner.stop('a/m1');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(runner.processes.has('a/m1'), false);
  assert.equal(runner.processes.has('b/m1'), true, 'the other Claude keeps going');
  runner.stop('b/m1');
  await ended;
  assert.equal(done['a/m1'].stopped, true);
});

test('a reply that runs past its timeout is stopped and reported as timed out', async () => {
  const os = require('node:os');
  const { runner, logEvents } = makeRunner();
  runner.agents.claude.path = process.execPath;
  runner.agents.claude.timeoutSec = 0.3;
  runner._buildAgentArgs = () => ({ args: ['-e', 'setInterval(() => {}, 1000)'], stdin: null });
  runner.workingDir = os.tmpdir();
  const done = new Promise(resolve => { runner._send = (ch, d) => { if (ch === 'agent:done') resolve(d); }; });
  runner.run(req());
  const d = await done;
  assert.equal(d.timedOut, true);
  assert.equal(d.stopped, false);
  assert.equal(d.timeoutSec, 0.3);
  assert.ok(logEvents.find(l => l.msg === 'timed out, stopping'));
  assert.equal(runner.processes.has('chat1/m1'), false);
});

test('a reply that finishes in time does not trip the timeout', async () => {
  const os = require('node:os');
  const { runner } = makeRunner();
  runner.agents.claude.path = process.execPath;
  runner.agents.claude.timeoutSec = 2;
  runner._buildAgentArgs = () => ({ args: ['-e', 'process.stdout.write("ok")'], stdin: null });
  runner.workingDir = os.tmpdir();
  const done = new Promise(resolve => { runner._send = (ch, d) => { if (ch === 'agent:done') resolve(d); }; });
  runner.run(req());
  const d = await done;
  assert.equal(d.code, 0);
  assert.equal(d.timedOut, false);
});

test('applyConfig picks up per-agent timeouts', () => {
  const { runner } = makeRunner();
  runner.applyConfig({ agents: { antigravity: { timeoutSec: 600 } } });
  assert.equal(runner.agents.antigravity.timeoutSec, 600);
});

test('a name from config replaces the default everywhere the window looks', () => {
  const { runner } = makeRunner();
  runner.applyConfig({ agents: { claude: { name: 'Cyclops' } } });
  assert.equal(runner.getConfigs().find(a => a.id === 'claude').name, 'Cyclops');
});

test('agy model list is parsed', () => {
  const text = 'Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\r\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n\n';
  assert.deepEqual(AgentRunner.parseAgyModels(text), [
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' }
  ]);
});

test('listModels: Antigravity from agy, Claude fixed, Codex typed; agy failing leaves it empty', async () => {
  const { runner } = makeRunner();
  runner._agyModelsText = async () => 'x\tX model\n';
  const m = await runner.listModels();
  assert.deepEqual(m.antigravity, [{ id: 'x', label: 'X model' }]);
  assert.deepEqual(m.claude.map(x => x.id), ['opus', 'sonnet', 'haiku']);
  assert.deepEqual(m.codex, []);
  assert.deepEqual(m.grok.map(x => x.id), ['grok-4.6', 'grok-4.5']);
  const { runner: r2 } = makeRunner();
  r2._agyModelsText = async () => { throw new Error('agy missing'); };
  assert.deepEqual((await r2.listModels()).antigravity, []);
});

// ---- Vendor sessions (TM-55 Batch 1) ----
const { parseEvent } = AgentRunner;

test('claude stream-json: text, session, usage with context window, plan usage', () => {
  assert.deepEqual(parseEvent('claude', JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })), { sessionId: 's1' });
  assert.deepEqual(parseEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hel' }, { type: 'tool_use' }, { type: 'text', text: 'lo' }] } })), { text: 'Hello', steps: ['Using a tool'] });
  const r = parseEvent('claude', JSON.stringify({ type: 'result', session_id: 's1', usage: { input_tokens: 4, cache_read_input_tokens: 60459, cache_creation_input_tokens: 71789, output_tokens: 11 },
    modelUsage: { 'claude-opus-5-5[1m]': { contextWindow: 1000000 } } }));
  assert.deepEqual(r, { sessionId: 's1', usage: { inputTokens: 132252, outputTokens: 11, contextWindow: 1000000 } });
  const rl = parseEvent('claude', JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.03, resetsAt: 1 }, seven_day: { utilization: 0.04, resetsAt: 2 } } } }));
  assert.deepEqual(rl, { plan: { status: 'allowed', fiveHour: { used: 0.03, resetsAt: 1 }, sevenDay: { used: 0.04, resetsAt: 2 } } });
  assert.equal(parseEvent('claude', 'not json'), null);
});

test('codex --json: thread id, agent message, turn usage', () => {
  assert.deepEqual(parseEvent('codex', '{"type":"thread.started","thread_id":"t1"}'), { sessionId: 't1' });
  assert.deepEqual(parseEvent('codex', '{"type":"item.completed","item":{"type":"agent_message","text":"pineapple"}}'), { text: 'pineapple' });
  assert.equal(parseEvent('codex', '{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}'), null);
  assert.deepEqual(parseEvent('codex', '{"type":"turn.completed","usage":{"input_tokens":51646,"cached_input_tokens":21504,"output_tokens":11}}'), { usage: { inputTokens: 51646, outputTokens: 11 } });
});

test('antigravity json: the whole envelope', () => {
  assert.deepEqual(parseEvent('antigravity', '{"conversation_id":"c1","status":"SUCCESS","response":"pineapple\\n","usage":{"input_tokens":26117,"output_tokens":521}}'),
    { sessionId: 'c1', text: 'pineapple\n', usage: { inputTokens: 26117, outputTokens: 521 } });
});

test('resuming: each vendor gets its session flag, still safe for a codex.cmd shim', () => {
  const { runner } = makeRunner();
  assert.deepEqual(runner._buildAgentArgs('claude', 'hi', null, 's1').args, ['-p', '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '--strict-mcp-config', '--allowedTools', 'Bash,PowerShell', '--output-format', 'stream-json', '--verbose', '--resume', 's1', 'hi']);
  assert.deepEqual(runner._buildAgentArgs('antigravity', 'hi', 'm', 'c1').args, ['--mode', 'accept-edits', '--sandbox', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--model', 'm', '--conversation', 'c1', '-p', 'hi']);
  const codex = runner._buildAgentArgs('codex', 'hi', 'gpt-6-astra', '01a16915-c682-73f1-bf39-7e19fbecb8a1');
  assert.deepEqual(codex, { args: ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', '-m', 'gpt-6-astra', '01a16915-c682-73f1-bf39-7e19fbecb8a1', '-'], stdin: 'hi' });
  assert.ok(AgentRunner.launchCommand('C:\\npm\\codex.cmd', codex.args, 'win32'), 'safe for codex.cmd');
  assert.deepEqual(runner._buildAgentArgs('codex', 'hi').args, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-']);
});

test('a session id that is not a plain id is refused before launch', () => {
  const { runner, sent } = makeRunner();
  runner._spawnAgentProcess = () => { throw new Error('must not launch'); };
  assert.equal(runner.run({ runKey: 'c/m1', vendor: 'codex', model: null, sessionId: 'x & del *', prompt: 'hi' }), false);
  assert.match(sent.find(s => s.ch === 'agent:output').d.text, /session/);
});

test('session ids: no leading hyphen, and ids the CLIs report are checked too', () => {
  const { runner, sent } = makeRunner();
  runner._spawnAgentProcess = () => { throw new Error('must not launch'); };
  assert.equal(runner.run({ runKey: 'c/m1', vendor: 'claude', model: null, sessionId: '-rf', prompt: 'hi' }), false);
  assert.match(sent.find(s => s.ch === 'agent:output').d.text, /session/);
  assert.equal(parseEvent('codex', '{"type":"thread.started","thread_id":"--yolo"}'), null);
  assert.equal(parseEvent('claude', JSON.stringify({ type: 'system', subtype: 'init', session_id: { x: 1 } })), null);
  assert.deepEqual(parseEvent('antigravity', '{"conversation_id":"-x","response":"hi"}'), { text: 'hi' }, 'a bad id is dropped, the reply kept');
});

test('each chat runs in its own folder inside the working folder (TM-59)', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const runner = new AgentRunner(null, { info() {}, warn() {}, error() {}, exception() {} });
  runner.workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-work-'));
  const dir = runner.chatFolder('f5bff68d-d665-4cba-9f20-f02026e7f4b9/m1');
  assert.equal(dir, path.join(runner.workingDir, 'f5bff68d-d665-4cba-9f20-f02026e7f4b9'));
  assert.ok(fs.statSync(dir).isDirectory(), 'created on first use');
  assert.equal(runner.chatFolder('../evil/m1'), runner.workingDir, 'a bad chat id never becomes a path');
  assert.equal(runner.chatFolder('justakey'), path.join(runner.workingDir, 'justakey'));
});

test('tool steps (TM-59), from real CLI output: Claude tool_use, Codex item.started, agy stream-json', () => {
  const { parseEvent } = AgentRunner;
  assert.deepEqual(parseEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:\\Users\\Matth\\AgentDaycare\\chat\\_probe\\note.txt' } }] } })), { steps: ['Reading note.txt'] });
  assert.deepEqual(parseEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } })).steps, ['Running npm test']);
  assert.deepEqual(parseEvent('codex', JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'Get-Content -LiteralPath note.txt -Raw\'' } })), { steps: ['Running Get-Content -LiteralPath note.txt -Raw'] });
  assert.deepEqual(parseEvent('codex', JSON.stringify({ type: 'item.started', item: { type: 'file_change', changes: [{ path: 'C:\\proj\\index.html', kind: 'add' }] } })), { steps: ['Editing index.html'] });
  assert.equal(parseEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'x' } })), null, 'one step per command, on start');
  assert.deepEqual(parseEvent('antigravity', JSON.stringify({ event: 'init', conversation_id: 'f16d456f-8b34-4734-b966-26d2f7b315ca', init: {} })), { sessionId: 'f16d456f-8b34-4734-b966-26d2f7b315ca' });
  const step = (state, error) => JSON.stringify({ event: 'step_update', step_update: { state, step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'Get-ChildItem -Path .' }, ...(error ? { error } : {}) } } });
  assert.deepEqual(parseEvent('antigravity', step('ACTIVE')), { steps: ['Running Get-ChildItem -Path .'] });
  assert.deepEqual(parseEvent('antigravity', step('ERROR', { message: 'permission check failed: user denied permission to run' })), { steps: ['Running Get-ChildItem -Path . (failed: not allowed)'] });
  assert.equal(parseEvent('antigravity', step('DONE')), null);
  assert.deepEqual(parseEvent('antigravity', JSON.stringify({ event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'C:\\chat\\x\\hello.txt' } } } })), { steps: ['Reading hello.txt'] });
  assert.deepEqual(parseEvent('antigravity', JSON.stringify({ event: 'result', result: { conversation_id: 'f16d456f-8b34-4734-b966-26d2f7b315ca', status: 'SUCCESS', response: 'banana', usage: { input_tokens: 23009, output_tokens: 272 } } })),
    { sessionId: 'f16d456f-8b34-4734-b966-26d2f7b315ca', text: 'banana', usage: { inputTokens: 23009, outputTokens: 272 } });
});

test('folder files (TM-60): only CLAUDE.md, AGENTS.md and GEMINI.md are written, into the chat folder', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runner } = makeRunner();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-files-'));
  runner.agents.claude.path = process.execPath;
  runner._buildAgentArgs = () => ({ args: ['-e', 'process.stdout.write("ok")'], stdin: null });
  runner.workingDir = dir;
  const done = new Promise(resolve => { runner._send = (ch, d) => { if (ch === 'agent:done') resolve(d); }; });
  assert.equal(runner.run({ runKey: 'c1/m1', vendor: 'claude', prompt: 'hi', files: { 'CLAUDE.md': '# brain', 'evil.md': 'no', '../up.md': 'no' } }), true);
  await done;
  assert.equal(fs.readFileSync(path.join(dir, 'c1', 'CLAUDE.md'), 'utf8'), '# brain');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'c1')), ['CLAUDE.md']);
  assert.ok(!fs.existsSync(path.join(dir, 'up.md')));
});

test('Claude gets its MCP servers per launch as a --mcp-config string; others never (TM-60 Batch 3)', () => {
  const { runner } = makeRunner();
  const mcp = { mcpServers: { pdf: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-pdf', '--stdio'] } } };
  const claude = runner._buildAgentArgs('claude', 'hi', null, null, mcp).args;
  const i = claude.indexOf('--mcp-config');
  assert.ok(i > 0 && claude[i - 1] === '--strict-mcp-config', 'right after --strict-mcp-config');
  assert.deepEqual(JSON.parse(claude[i + 1]), mcp);
  assert.ok(!runner._buildAgentArgs('claude', 'hi', null, null, { mcpServers: {} }).args.includes('--mcp-config'), 'no servers, no flag');
  assert.ok(!runner._buildAgentArgs('codex', 'hi', null, null, mcp).args.join(' ').includes('mcp'));
  assert.ok(!runner._buildAgentArgs('antigravity', 'hi', null, null, mcp).args.join(' ').includes('mcp'));
});
