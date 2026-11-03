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
  assert.equal(resolveChatFile(root, 'chat1', '../secret.txt'), null);
  assert.equal(resolveChatFile(root, 'chat1', 'C:\\evil.js'), null);
  assert.equal(resolveChatFile(root, '../etc', 'a.md'), null);
  assert.equal(resolveChatFile(root, 'chat1', 'run.exe'), null);
  assert.ok(TEXT_EXTS.includes('.md'));
  await saveChatFile(root, 'chat1', 'note.md', 'hello');
  assert.equal(await readChatFile(root, 'chat1', 'note.md'), 'hello');
  await assert.rejects(() => saveChatFile(root, 'chat1', 'x.exe', 'no'));
});
