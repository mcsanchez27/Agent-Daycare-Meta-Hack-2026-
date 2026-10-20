// User settings: where each agent's executable lives and which folder agents
// work in. Stored as config.json next to the app while developing (or in the
// OS user-data folder when packaged). The file is created with defaults on
// first run so it can be edited by hand.

const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT_IDS = ['antigravity', 'claude', 'codex'];

async function defaultAgentPaths() {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  let codexPath = win ? path.join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe') : path.join(home, '.local', 'bin', 'codex');
  if (win && !(await fs.promises.access(codexPath).then(() => true).catch(() => false))) {
    const codexBinDir = path.join(local, 'OpenAI', 'Codex', 'bin');
    if (await fs.promises.access(codexBinDir).then(() => true).catch(() => false)) {
      try {
        for (const sub of await fs.promises.readdir(codexBinDir)) {
          const candidate = path.join(codexBinDir, sub, 'codex.exe');
          if (await fs.promises.access(candidate).then(() => true).catch(() => false)) {
            codexPath = candidate;
            break;
          }
        }
      } catch (_) {}
    }
  }
  return {
    antigravity: { command: win ? 'agy.exe' : 'agy', path: win ? path.join(local, 'agy', 'bin', 'agy.exe') : path.join(home, '.local', 'bin', 'agy') },
    claude: { command: win ? 'claude.exe' : 'claude', path: path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude') },
    codex: { command: win ? 'codex.exe' : 'codex', path: codexPath }
  };
}

// Agents run in a folder of their own, never a real project: Codex writes
// files without asking in headless mode (TM-47 Batch 0).
function chatDir() {
  return path.join(os.homedir(), 'AgentDaycare', 'chat');
}

async function defaultWorkingDir() {
  return chatDir();
}

// Working folders the old dashboard defaulted to. A config still pointing at
// one of these was never chosen on purpose, so it moves to the chat folder.
function legacyWorkingDirs() {
  const home = os.homedir();
  return [home, path.join(home, '.gemini', 'antigravity', 'scratch', 'cli-companions')]
    .map(d => path.resolve(d).toLowerCase());
}

function isLegacyWorkingDir(dir) {
  return typeof dir === 'string' && dir.trim() !== '' && legacyWorkingDirs().includes(path.resolve(dir.trim()).toLowerCase());
}

// Creates the working folder if it does not exist yet, so the first launch
// does not fail on a missing cwd.
async function ensureWorkingDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function defaults() {
  return { workingDir: await defaultWorkingDir(), agents: await defaultAgentPaths() };
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
async function load(file) {
  const base = await defaults();
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') return { config: base, file, error: err.message };
    try {
      await save(file, base);
    } catch (writeErr) {
      return { config: base, file, error: `could not create config: ${writeErr.message}` };
    }
    return { config: base, file, created: true };
  }
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (isLegacyWorkingDir(parsed.workingDir)) {
      const migratedFrom = parsed.workingDir;
      delete parsed.workingDir;
      const clean = await save(file, parsed);
      return { config: clean, file, migratedFrom };
    }
    return { config: sanitize(parsed, base), file };
  } catch (err) {
    return { config: base, file, error: `config.json is not valid JSON (${err.message}); using defaults` };
  }
}

async function save(file, config) {
  const clean = sanitize(config, await defaults());
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

module.exports = { load, save, defaults, sanitize, chatDir, ensureWorkingDir, isLegacyWorkingDir, AGENT_IDS };
