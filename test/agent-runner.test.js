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
  clearInterval(runner.scanInterval);
  return { runner, sent, logEvents };
}

test('sendInput logs a warning if stdin.write throws', () => {
    const { runner, logEvents } = makeRunner();
    runner.processes.set('claude', {
        stdin: {
            writable: true,
            destroyed: false,
            write: () => {
                throw new Error('Fake write error');
            }
        }
    });

    // We mock startAgent so it doesn't actually launch anything when fallback occurs
    runner.startAgent = () => true;

    runner.sendInput('claude', 'test input');

    const warnLogs = logEvents.filter(l => l.level === 'warn');
    assert.equal(warnLogs.length, 1);
    assert.equal(warnLogs[0].msg, 'stdin write failed, relaunching instead');
    assert.equal(warnLogs[0].data.error, 'Fake write error');
    assert.equal(warnLogs[0].agentId, 'claude');
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
  runner.agents = { testagent: { id: 'testagent', name: 'Test Agent', role: 'tester', title: 't', path: notExe, command: 'testagent', status: 'idle', externalPid: null } };
  runner.hookSessions = { testagent: new Map() };

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
  runner.agents = { 'fake-agent': { id: 'fake-agent', name: 'Fake Agent', role: 'tester', title: 't', path: '/definitely/does/not/exist/fake-agent-bin', command: 'this_command_does_not_exist_at_all_12345', status: 'sleeping', externalPid: null } };
  runner.hookSessions['fake-agent'] = new Map();

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

test('checkExternalProcesses catches a listProcesses failure and warns exactly once', async () => {
  const { runner, logEvents } = makeRunner();
  runner.listProcesses = () => { throw new Error('Simulated tasklist failure'); };
  const warns = () => logEvents.filter(l => l.level === 'warn');

  assert.equal(runner.scanErrorLogged, false);
  await runner.checkExternalProcesses();
  assert.equal(runner.scanErrorLogged, true);
  assert.equal(warns().length, 1);
  assert.equal(warns()[0].data.error, 'Simulated tasklist failure');

  await runner.checkExternalProcesses(); // should not log again
  assert.equal(warns().length, 1);
});

test('stopAgent logs a warning if child.kill throws and still clears the process', () => {
  const { runner, logEvents } = makeRunner();
  runner.processes.set('claude', { pid: 4242, kill() { throw new Error('kill failed hard'); } });

  runner.stopAgent('claude');

  const warn = logEvents.find(l => l.level === 'warn' && l.msg === 'kill failed');
  assert.ok(warn, 'a "kill failed" warning is logged');
  assert.equal(warn.agentId, 'claude');
  assert.equal(warn.data.error, 'kill failed hard');
  assert.equal(runner.processes.has('claude'), false, 'the dead handle is dropped anyway');
  assert.equal(runner.agents.claude.status, 'sleeping');
});
