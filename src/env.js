// Local-only environment loader: reads KEY=VALUE lines from a git-ignored
// dotenv file (.env.local beside the config) into process.env. Only sets keys
// that are not already set, so real environment always wins. Never logs or
// returns values -- only key names.
const fs = require('fs');

function parseLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  if (value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
       (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadLocalEnv(file, env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { file, loaded: [], missing: true };
    throw err;
  }
  const loaded = [];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (env[parsed.key] === undefined || env[parsed.key] === '') {
      env[parsed.key] = parsed.value;
      loaded.push(parsed.key);
    }
  }
  return { file, loaded, missing: false };
}

module.exports = { loadLocalEnv, parseLine };