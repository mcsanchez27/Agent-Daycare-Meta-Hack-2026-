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

test('sendInput launches a new one-shot process with the message', () => {
  const { runner } = makeRunner();
  const calls = [];
  runner.startAgent = (id, prompt) => { calls.push([id, prompt]); return true; };
  assert.equal(runner.sendInput('claude', 'hello'), true);
  assert.deepEqual(calls, [['claude', 'hello']]);
  assert.equal(runner.sendInput('nobody', 'hello'), false);
});

test('startAgent refuses an empty prompt', () => {
  const { runner } = makeRunner();
  assert.throws(() => runner.startAgent('claude', '   '), /prompt is required/);
});

test('only the three V1 agents exist', () => {
  const { runner } = makeRunner();
  assert.deepEqual(Object.keys(runner.agents), ['antigravity', 'claude', 'codex']);
});

test('agent arguments: -p for antigravity and claude; codex exec reads the prompt from stdin', () => {
  const { runner } = makeRunner();
  assert.deepEqual(runner._buildAgentArgs('antigravity', 'hi'), { args: ['-p', 'hi'], stdin: null });
  assert.deepEqual(runner._buildAgentArgs('claude', 'hi'), { args: ['-p', 'hi'], stdin: null });
  assert.deepEqual(runner._buildAgentArgs('codex', 'hi'), { args: ['exec', '--skip-git-repo-check', '-'], stdin: 'hi' });
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
  assert.equal(runner.startAgent('codex', 'ignored'), true);
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

test('stopAgent logs a warning if child.kill throws and still clears the process', () => {
  const { runner, logEvents } = makeRunner();
  // No pid: on Windows killTree would run a real taskkill on it instead of kill().
  runner.processes.set('claude', { kill() { throw new Error('kill failed hard'); } });

  runner.stopAgent('claude');

  const warn = logEvents.find(l => l.level === 'warn' && l.msg === 'kill failed');
  assert.ok(warn, 'a "kill failed" warning is logged');
  assert.equal(warn.agentId, 'claude');
  assert.equal(warn.data.error, 'kill failed hard');
  assert.equal(runner.processes.has('claude'), false, 'the dead handle is dropped anyway');
  assert.equal(runner.agents.claude.status, 'idle');
});

test('agent output reaches the window as plain text too, tagged with the run', () => {
  const { runner, sent } = makeRunner();
  runner.runCounts.set('claude', 3);
  runner.emitOutput('claude', '\x1b[1mHello\x1b[0m there');
  const out = sent.find(s => s.ch === 'agent:output').d;
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
  runner.startAgent('claude', 'x');
  await new Promise(r => setTimeout(r, 300));
  runner.stopAgent('claude');
  const d = await done;
  assert.equal(d.stopped, true);
  assert.equal(runner.agents.claude.status, 'idle');
  assert.equal(runner.processes.has('claude'), false);
});
