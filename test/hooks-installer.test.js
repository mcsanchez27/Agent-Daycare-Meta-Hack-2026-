const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('../src/hooks-installer');

const URL = 'http://127.0.0.1:48211/agent-daycare/hook/claude';

function tmpSettings(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-hooks-'));
  const file = path.join(dir, 'settings.json');
  if (initial !== undefined) fs.writeFileSync(file, initial);
  return file;
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('install creates the settings file with one hook per event', async () => {
  const file = tmpSettings();
  const result = await installer.install({ hookUrl: URL, file });
  assert.equal(result.installed, true);
  assert.deepEqual(result.events.sort(), [...installer.CLAUDE_EVENTS].sort());

  const s = read(file);
  for (const ev of installer.CLAUDE_EVENTS) {
    assert.equal(s.hooks[ev].length, 1);
    assert.equal(s.hooks[ev][0].hooks[0].type, 'command');
    assert.ok(s.hooks[ev][0].hooks[0].command.includes(URL));
  }
});

test('install preserves unrelated settings and hooks; uninstall removes only ours', async () => {
  const file = tmpSettings(JSON.stringify({
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }]
    }
  }));

  await installer.install({ hookUrl: URL, file });
  let s = read(file);
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done');
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Bash');
  assert.ok(fs.existsSync(`${file}.agent-daycare.bak`), 'backup written');

  const result = await installer.uninstall({ file });
  assert.equal(result.installed, false);
  s = read(file);
  assert.deepEqual(s, {
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }]
    }
  });
});

test('install is idempotent and refreshes the URL when the port changes', async () => {
  const file = tmpSettings();
  await installer.install({ hookUrl: URL, file });
  await installer.install({ hookUrl: URL, file });
  await installer.install({ hookUrl: 'http://127.0.0.1:50000/agent-daycare/hook/claude', file });
  const s = read(file);
  for (const ev of installer.CLAUDE_EVENTS) {
    assert.equal(s.hooks[ev].length, 1, `${ev} should have exactly one group`);
    assert.ok(s.hooks[ev][0].hooks[0].command.includes(':50000/'));
  }
});

test('status reports not-installed for a missing file and errors for corrupt JSON without touching it', async () => {
  const missing = tmpSettings();
  assert.deepEqual(await installer.status({ file: missing }), { installed: false, events: [], file: missing });

  const corrupt = tmpSettings('{ not json');
  const st = await installer.status({ file: corrupt });
  assert.equal(st.installed, false);
  assert.ok(st.error);
  await assert.rejects(async () => await installer.install({ hookUrl: URL, file: corrupt }));
  assert.equal(fs.readFileSync(corrupt, 'utf8'), '{ not json');
});

test('uninstall on a file without our hooks is a no-op', async () => {
  const file = tmpSettings('{"model":"x"}\n');
  const before = fs.readFileSync(file, 'utf8');
  await installer.uninstall({ file });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(!fs.existsSync(`${file}.agent-daycare.bak`));
});

test('readSettings propagates unexpected fs errors (e.g. EACCES)', async (t) => {
  const file = tmpSettings();
  const originalReadFile = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', (path, options) => {
    if (path === file) {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      return Promise.reject(err);
    }
    return originalReadFile(path, options);
  });

  await assert.rejects(() => installer.install({ hookUrl: URL, file }), { code: 'EACCES' });
  await assert.rejects(() => installer.uninstall({ file }), { code: 'EACCES' });
  const st = await installer.status({ file });
  assert.equal(st.installed, false);
  assert.equal(st.error, 'EACCES: permission denied');
});
