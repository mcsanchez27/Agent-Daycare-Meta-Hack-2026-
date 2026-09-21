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
    debug() {},
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
