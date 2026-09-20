// User settings: where each agent's executable lives and which folder agents
// work in. Stored as config.json next to the app while developing (or in the
// OS user-data folder when packaged). The file is created with defaults on
// first run so it can be edited by hand, and the Scan Agents window edits it
// with Browse… buttons.

const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT_IDS = ['antigravity', 'claude', 'codex', 'grok'];

function defaultAgentPaths() {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return {
    antigravity: { command: win ? 'agy.exe' : 'agy', path: win ? path.join(local, 'agy', 'bin', 'agy.exe') : path.join(home, '.local', 'bin', 'agy') },
    claude: { command: win ? 'claude.exe' : 'claude', path: path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude') },
    codex: { command: win ? 'codex.exe' : 'codex', path: win ? path.join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe') : path.join(home, '.local', 'bin', 'codex') },
    grok: { command: win ? 'grok.exe' : 'grok', path: path.join(home, '.grok', 'bin', win ? 'grok.exe' : 'grok') }
  };
}

function defaultWorkingDir() {
  // The folder the prototype used; fall back to the home folder if it's gone.
  const legacy = path.join(os.homedir(), '.gemini', 'antigravity', 'scratch', 'cli-companions');
  return fs.existsSync(legacy) ? legacy : os.homedir();
}

function defaults() {
  return { workingDir: defaultWorkingDir(), agents: defaultAgentPaths() };
}

// Keeps only the fields we know, with sane types. Unknown agents are dropped.
function sanitize(input, base) {
  const out = { workingDir: base.workingDir, agents: {} };
  if (input && typeof input.workingDir === 'string' && input.workingDir.trim()) {
    out.workingDir = input.workingDir.trim();
  }
  for (const id of AGENT_IDS) {
    const b = base.agents[id];
    const u = input && input.agents && input.agents[id];
    out.agents[id] = {
      command: u && typeof u.command === 'string' && u.command.trim() ? u.command.trim() : b.command,
      path: u && typeof u.path === 'string' && u.path.trim() ? u.path.trim() : b.path
    };
  }
  return out;
}

/**
 * Loads config from `file`, filling gaps with defaults. Creates the file with
 * defaults if missing. A corrupt file is left untouched and reported via
 * `error`, with defaults used for this run.
 */
function load(file) {
  const base = defaults();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') return { config: base, file, error: err.message };
    try {
      save(file, base);
    } catch (writeErr) {
      return { config: base, file, error: `could not create config: ${writeErr.message}` };
    }
    return { config: base, file, created: true };
  }
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return { config: sanitize(parsed, base), file };
  } catch (err) {
    return { config: base, file, error: `config.json is not valid JSON (${err.message}); using defaults` };
  }
}

function save(file, config) {
  const clean = sanitize(config, defaults());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

module.exports = { load, save, defaults, sanitize, AGENT_IDS };
