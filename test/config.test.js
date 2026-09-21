const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');

function tmpFile(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-config-'));
  const file = path.join(dir, 'config.json');
  if (initial !== undefined) fs.writeFileSync(file, initial);
  return file;
}

test('first load creates the file with defaults', () => {
  const file = tmpFile();
  const r = config.load(file);
  assert.equal(r.created, true);
  assert.ok(fs.existsSync(file));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.agents).sort(), [...config.AGENT_IDS].sort());
  assert.ok(onDisk.workingDir);
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8').includes('Matth'), 'no hardcoded username in config.js');
});

test('user values override defaults; missing fields fall back', () => {
  const file = tmpFile(JSON.stringify({ workingDir: '/work/proj', agents: { claude: { path: '/opt/claude' }, bogus: { path: '/x' } } }));
  const r = config.load(file);
  assert.equal(r.error, undefined);
  assert.equal(r.config.workingDir, '/work/proj');
  assert.equal(r.config.agents.claude.path, '/opt/claude');
  assert.equal(r.config.agents.claude.command, config.defaults().agents.claude.command);
  assert.equal(r.config.agents.codex.path, config.defaults().agents.codex.path);
  assert.equal(r.config.agents.bogus, undefined);
});

test('a corrupt file is reported, not overwritten, and defaults are used', () => {
  const file = tmpFile('{ nope');
  const r = config.load(file);
  assert.match(r.error, /not valid JSON/);
  assert.equal(r.config.workingDir, config.defaults().workingDir);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ nope');
});

test('save round-trips and strips blanks/unknowns', () => {
  const file = tmpFile();
  const saved = config.save(file, { workingDir: '  /w  ', agents: { grok: { path: '  ' }, claude: { path: 'C:\\c\\claude.exe' } } });
  assert.equal(saved.workingDir, '/w');
  assert.equal(saved.agents.grok.path, config.defaults().agents.grok.path);
  assert.equal(saved.agents.claude.path, 'C:\\c\\claude.exe');
  assert.deepEqual(config.load(file).config, saved);
});
