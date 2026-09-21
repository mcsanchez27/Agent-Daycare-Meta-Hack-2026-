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
