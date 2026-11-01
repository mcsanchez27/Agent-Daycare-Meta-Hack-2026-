const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');

test('meta is a fifth engine with a name and timeout but no executable', async () => {
  assert.ok(config.AGENT_IDS.includes('meta'));
  const d = await config.defaults();
  assert.equal(d.agents.meta.name, 'Spark');
  assert.equal(d.agents.meta.timeoutSec, 300);
  assert.equal(d.agents.meta.command, undefined);
  assert.equal(d.agents.meta.path, undefined);
});

test('meta settings round-trip; command/path are never kept for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-config-meta-'));
  const file = path.join(dir, 'config.json');
  const saved = await config.save(file, { agents: { meta: { name: '  Sparky  ', command: 'x', path: '/y', timeoutSec: 42 } } });
  assert.deepEqual(saved.agents.meta, { name: 'Sparky', timeoutSec: 42 });
  assert.deepEqual((await config.load(file)).config.agents.meta, { name: 'Sparky', timeoutSec: 42 });
});