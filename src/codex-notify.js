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

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.agent-daycare.bak`);
  fs.writeFileSync(file, lines.join('\n'));
}

function status({ file = defaultCodexConfigPath() } = {}) {
  let lines;
  try {
    lines = readLines(file);
  } catch (err) {
    return { installed: false, events: [], file, error: err.message };
  }
  if (!lines) return { installed: false, events: [], file };
  const found = findNotifyLine(lines);
  if (!found) return { installed: false, events: [], file };
  if (found.ours) return { installed: true, events: ['agent-turn-complete'], file };
  return { installed: false, events: [], file, conflict: found.line.trim() };
}

function install({ hookUrl, file = defaultCodexConfigPath() }) {
  if (!hookUrl) throw new Error('hookUrl is required');
  const lines = readLines(file) || [];
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
  writeLines(file, lines);
  return status({ file });
}

function uninstall({ file = defaultCodexConfigPath() } = {}) {
  const lines = readLines(file);
  if (!lines) return status({ file });
  const found = findNotifyLine(lines);
  if (found && found.ours) {
    lines.splice(found.index, 1);
    writeLines(file, lines);
  }
  return status({ file });
}

module.exports = { install, uninstall, status, buildNotifyArgv, defaultCodexConfigPath, MARKER };
