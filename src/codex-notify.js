// Installs / removes the Codex `notify` command in ~/.codex/config.toml.
//
// Codex runs the configured program after each turn, appending the event as a
// JSON string in the LAST argument, e.g.
//   {"type":"agent-turn-complete","turn-id":"…","last-assistant-message":"…"}
// curl accepts options after the URL, so we end our argv with "--data-binary"
// and Codex's appended JSON becomes its value.
//
// Codex allows exactly one notify command, so if a different one is already
// configured we refuse rather than silently replace it.
//
// We only edit the top-level `notify = [...]` line (top-level keys must come
// before any [table] in TOML); everything else in the file is left byte-for-byte.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = '/agent-daycare/hook/';

function defaultCodexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function buildNotifyArgv(hookUrl) {
  return ['curl', '-s', '-m', '3', '-X', 'POST', '-H', 'Content-Type: application/json', hookUrl, '--data-binary'];
}

function tomlArray(argv) {
  // TOML basic strings share JSON's escaping for everything we emit.
  return `notify = [${argv.map(a => JSON.stringify(a)).join(', ')}]`;
}

// Finds the top-level notify line. Returns { index, line, ours } or null.
function findNotifyLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[/.test(line)) break; // first table header: top-level section over
    if (/^\s*notify\s*=/.test(line)) {
      return { index: i, line, ours: line.includes(MARKER) };
    }
  }
  return null;
}

async function readLines(file) {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    return raw.split(/\r?\n/);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeLines(file, lines) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) await fs.promises.copyFile(file, `${file}.agent-daycare.bak`);
  await fs.promises.writeFile(file, lines.join('\n'));
}

async function status({ file = defaultCodexConfigPath() } = {}) {
  let lines;
  try {
    lines = await readLines(file);
  } catch (err) {
    return { installed: false, events: [], file, error: err.message };
  }
  if (!lines) return { installed: false, events: [], file };
  const found = findNotifyLine(lines);
  if (!found) return { installed: false, events: [], file };
  if (found.ours) return { installed: true, events: ['agent-turn-complete'], file };
  return { installed: false, events: [], file, conflict: found.line.trim() };
}

async function install({ hookUrl, file = defaultCodexConfigPath() }) {
  if (!hookUrl) throw new Error('hookUrl is required');
  const lines = (await readLines(file)) || [];
  const found = findNotifyLine(lines);
  if (found && !found.ours) {
    throw new Error(`Codex already has a notify command configured (${found.line.trim()}). Remove it from ${file} first.`);
  }
  const ourLine = tomlArray(buildNotifyArgv(hookUrl));
  if (found) {
    lines[found.index] = ourLine;
  } else {
    lines.unshift(ourLine);
  }
  if (lines[lines.length - 1] !== '') lines.push('');
  await writeLines(file, lines);
  return await status({ file });
}

async function uninstall({ file = defaultCodexConfigPath() } = {}) {
  const lines = await readLines(file);
  if (!lines) return await status({ file });
  const found = findNotifyLine(lines);
  if (found && found.ours) {
    lines.splice(found.index, 1);
    await writeLines(file, lines);
  }
  return await status({ file });
}

module.exports = { install, uninstall, status, buildNotifyArgv, defaultCodexConfigPath, MARKER };
