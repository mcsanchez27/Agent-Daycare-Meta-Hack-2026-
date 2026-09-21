const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codex = require('../src/codex-notify');

const URL = 'http://127.0.0.1:48211/agent-daycare/hook/codex';

function tmpConfig(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-codex-'));
  const file = path.join(dir, 'config.toml');
  if (initial !== undefined) fs.writeFileSync(file, initial);
  return file;
}

test('install creates config.toml with a notify line whose last argv is --data-binary', async () => {
  const file = tmpConfig();
  const st = await codex.install({ hookUrl: URL, file });
  assert.equal(st.installed, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^notify = \["curl", .*"--data-binary"\]\n$/);
  assert.ok(text.includes(URL));
});

test('install goes above existing tables and leaves the rest untouched; uninstall restores it', async () => {
  const original = 'model = "o3"\n\n[sandbox]\nmode = "read-only"\n';
  const file = tmpConfig(original);
  await codex.install({ hookUrl: URL, file });
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.ok(lines[0].startsWith('notify = ['));
  assert.equal(lines.slice(1).join('\n'), original);
  assert.ok(fs.existsSync(`${file}.agent-daycare.bak`));

  await codex.uninstall({ file });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal((await codex.status({ file })).installed, false);
});

test('re-install replaces our own line (port change) instead of adding a second', async () => {
  const file = tmpConfig();
  await codex.install({ hookUrl: URL, file });
  await codex.install({ hookUrl: 'http://127.0.0.1:50000/agent-daycare/hook/codex', file });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal((text.match(/^notify = /gm) || []).length, 1);
  assert.ok(text.includes(':50000/'));
});

test('a foreign notify command is reported as a conflict and never overwritten', async () => {
  const original = 'notify = ["python3", "/home/me/notify.py"]\n';
  const file = tmpConfig(original);
  const st = await codex.status({ file });
  assert.equal(st.installed, false);
  assert.ok(st.conflict.includes('notify.py'));
  await assert.rejects(async () => await codex.install({ hookUrl: URL, file }), /already has a notify command/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await codex.uninstall({ file });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('a notify key inside a table is not treated as top-level', async () => {
  const file = tmpConfig('[profiles.x]\nnotify = ["something"]\n');
  assert.equal((await codex.status({ file })).installed, false);
  assert.equal((await codex.status({ file })).conflict, undefined);
  await codex.install({ hookUrl: URL, file });
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('notify = ["curl"'));
});

test('readLines propagates non-ENOENT errors (e.g. EACCES)', () => {
  const original = fs.readFileSync;
  let called = false;
  fs.readFileSync = (file, encoding) => {
    called = true;
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    throw err;
  };
  try {
    const file = tmpConfig();
    assert.throws(() => codex.install({ hookUrl: URL, file }), { code: 'EACCES' });
    assert.ok(called);
  } finally {
    fs.readFileSync = original;
  }
});
