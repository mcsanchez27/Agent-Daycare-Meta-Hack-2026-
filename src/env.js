// Minimal .env loader so `SENTRY_DSN=...` in a git-ignored .env next to
// package.json works for `npm start` and the smoke script, as the README
// promises. Deliberately tiny: KEY=VALUE lines, # comments, optional single or
// double quotes, `export ` prefix. Variables already set in the environment
// win, so a shell export still overrides the file. Never throws: a missing or
// unreadable file just means nothing is loaded.
const fs = require('fs');
const path = require('path');

function parse(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2];
      if (quoted[1] === '"') value = value.replace(/\\n/g, '\n');
    } else {
      // Unquoted values may carry a trailing comment.
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Loads `file` (default: <project root>/.env) into process.env without
 * overriding variables that are already set.
 * @returns {string[]} names of the variables that were applied
 */
function load(file = path.join(__dirname, '..', '.env'), env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const applied = [];
  for (const [key, value] of Object.entries(parse(text))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

module.exports = { load, parse };
