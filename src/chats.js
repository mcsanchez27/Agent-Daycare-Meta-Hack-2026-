// Saved chats (TM-53 Batch 2): one JSON file per chat in the chats folder
// (project root while developing, the OS user-data folder when packaged).
// A chat is { id, title, createdAt, updatedAt, thread: { messages, nextId } };
// the thread is the one renderer/thread.js builds.

const fs = require('fs');
const path = require('path');

// Chat ids come from the window, so they are checked before they touch a path.
const CHAT_ID = /^[a-z0-9-]{1,64}$/;

function fileFor(dir, id) {
  if (typeof id !== 'string' || !CHAT_ID.test(id)) throw new Error(`Bad chat id: ${id}`);
  return path.join(dir, `${id}.json`);
}

// Keeps only the fields we know, so a chat file stays readable by later versions.
function clean(chat) {
  if (!chat || typeof chat !== 'object') throw new Error('A chat is required');
  const thread = chat.thread || {};
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const now = new Date().toISOString();
  return {
    id: chat.id,
    title: typeof chat.title === 'string' && chat.title.trim() ? chat.title.trim() : 'New chat',
    createdAt: typeof chat.createdAt === 'string' ? chat.createdAt : now,
    updatedAt: typeof chat.updatedAt === 'string' ? chat.updatedAt : now,
    thread: { messages, nextId: Number.isInteger(thread.nextId) ? thread.nextId : messages.length + 1 }
  };
}

// Newest first: [{ id, title, updatedAt }]. Unreadable files are skipped and
// reported in `problems` rather than hiding every other chat.
async function list(dir) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { chats: [], problems: [] };
    throw err;
  }
  const chats = [];
  const problems = [];
  for (const name of names) {
    const m = /^([a-z0-9-]{1,64})\.json$/.exec(name);
    if (!m) continue;
    try {
      const c = clean({ ...JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8')), id: m[1] });
      chats.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
    } catch (err) {
      problems.push({ file: name, error: err.message });
    }
  }
  chats.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { chats, problems };
}

async function load(dir, id) {
  return clean({ ...JSON.parse(await fs.promises.readFile(fileFor(dir, id), 'utf8')), id });
}

// Writes to a temporary file first and renames it over the old one, so a
// crash mid-save leaves the previous version rather than half a file.
async function save(dir, chat) {
  const file = fileFor(dir, chat && chat.id);
  const c = clean(chat);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(c, null, 2) + '\n');
  await fs.promises.rename(tmp, file);
  return { id: c.id, title: c.title, updatedAt: c.updatedAt };
}

module.exports = { list, load, save, CHAT_ID };
