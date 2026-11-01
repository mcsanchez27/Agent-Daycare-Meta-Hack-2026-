const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const members = require('../src/renderer/members');
const providers = require('../src/providers');
const AgentRunner = require('../src/agent-runner');

test('every provider has config, vendor tables and a runner entry', async () => {
  const d = await config.defaults();
  const win = { isDestroyed: () => true, webContents: { send() {} } };
  const log = { info() {}, warn() {}, error() {}, exception() {} };
  const runner = new AgentRunner(win, log, d);
  for (const id of [...providers.CLI_VENDORS, 'meta']) {
    assert.ok(members.VENDORS.includes(id), `${id} in members VENDORS`);
    assert.ok(members.VENDOR_NAMES[id], `${id} has a display name`);
    assert.ok(d.agents[id] && d.agents[id].name, `${id} in config defaults`);
    assert.ok(runner.agents[id], `${id} in runner agents`);
  }
  assert.equal(providers.get('meta').type, 'api');
  for (const id of providers.CLI_VENDORS) assert.equal(providers.get(id).type, 'cli');
});