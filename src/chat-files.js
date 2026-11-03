// Text files inside one chat's folder, for the in-Daycare editor. Every
// path is resolved and checked: the chat id and file name must be plain
// names, the result must stay inside <root>/<chatId>, and the extension
// must be a text type. No caller-supplied absolute path is ever honoured.
const fs = require('fs');
const path = require('path');

const TEXT_EXTS = ['.html', '.htm', '.md', '.txt', '.js', '.mjs', '.css', '.json', '.csv', '.xml', '.svg'];
const MAX_BYTES = 512 * 1024;
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function resolveChatFile(root, chatId, name) {
  if (!root || !PLAIN_NAME.test(String(chatId || ''))) return null;
  const base = String(name || '');
  if (base.includes('\\')) return null;
  // Chat-relative path: every segment must be a plain name, so dot-dot,
  // absolute paths and dotfiles can never be expressed.
  const segments = base.split('/');
  if (segments.some((seg) => !PLAIN_NAME.test(seg) || seg.startsWith('.'))) return null;
  if (!TEXT_EXTS.includes(path.extname(base).toLowerCase())) return null;
  const dir = path.resolve(root, String(chatId));
  const file = path.resolve(dir, ...segments);
  return file.startsWith(dir + path.sep) ? file : null;
}

async function realInside(root, chatId, file) {
  const dir = await fs.promises.realpath(path.resolve(root, String(chatId)));
  const real = await fs.promises.realpath(file);
  return real.startsWith(dir + path.sep) ? real : null;
}

async function readChatFile(root, chatId, name) {
  const found = resolveChatFile(root, chatId, name);
  if (!found) throw new Error('That file cannot be opened here');
  const file = await realInside(root, chatId, found);
  if (!file) throw new Error('That file cannot be opened here');
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_BYTES) throw new Error('That file is too large to edit here');
  return fs.promises.readFile(file, 'utf8');
}

async function saveChatFile(root, chatId, name, text) {
  const found = resolveChatFile(root, chatId, name);
  if (!found) throw new Error('That file cannot be saved here');
  const dir = await fs.promises.realpath(path.resolve(root, String(chatId)));
  const parent = await fs.promises.realpath(path.dirname(found));
  if (!parent.startsWith(dir)) throw new Error('That file cannot be saved here');
  const file = path.join(parent, path.basename(found));
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('That file is too large to save here');
  await fs.promises.writeFile(file, text, 'utf8');
  return { file: path.basename(file), bytes: Buffer.byteLength(text) };
}

module.exports = { TEXT_EXTS, resolveChatFile, readChatFile, saveChatFile };
