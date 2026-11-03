const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveChatFile, readChatFile, saveChatFile, TEXT_EXTS } = require('../src/chat-files');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-files-'));
  fs.mkdirSync(path.join(root, 'chat1'), { recursive: true });
  return root;
}

test('chat files stay inside the chat folder and are text only', async () => {
  const root = setup();
  assert.equal(resolveChatFile(root, 'chat1', 'index.html'), path.join(root, 'chat1', 'index.html'));
  assert.equal(resolveChatFile(root, 'chat1', 'design/index.html'), path.join(root, 'chat1', 'design', 'index.html'));
  assert.equal(resolveChatFile(root, 'chat1', 'design/../secret.txt'), null);
  assert.equal(resolveChatFile(root, 'chat1', 'design\\index.html'), null);
  assert.equal(resolveChatFile(root, 'chat1', '../secret.txt'), null);
  assert.equal(resolveChatFile(root, 'chat1', 'C:\\evil.js'), null);
  assert.equal(resolveChatFile(root, '../etc', 'a.md'), null);
  assert.equal(resolveChatFile(root, 'chat1', 'run.exe'), null);
  assert.ok(TEXT_EXTS.includes('.md'));
  await saveChatFile(root, 'chat1', 'note.md', 'hello');
  assert.equal(await readChatFile(root, 'chat1', 'note.md'), 'hello');
  fs.mkdirSync(path.join(root, 'chat1', 'design'), { recursive: true });
  await saveChatFile(root, 'chat1', 'design/page.html', '<p>x</p>');
  assert.equal(await readChatFile(root, 'chat1', 'design/page.html'), '<p>x</p>');
  await assert.rejects(() => saveChatFile(root, 'chat1', 'x.exe', 'no'));
});

test('a junction inside the chat folder cannot be read through', async (t) => {
  const root = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  try {
    fs.symlinkSync(outside, path.join(root, 'chat1', 'link'), 'junction');
  } catch (_) {
    t.skip('junction creation not permitted here');
    return;
  }
  await assert.rejects(() => readChatFile(root, 'chat1', 'link/secret.txt'));
  await assert.rejects(() => saveChatFile(root, 'chat1', 'link/new.txt', 'x'));
});
