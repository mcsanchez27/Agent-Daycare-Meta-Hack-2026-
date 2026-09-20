// Installs / removes the Claude Code hook entries that report into HookServer.
//
// Claude Code reads hooks from ~/.claude/settings.json in this shape:
//   { "hooks": { "Notification": [ { "hooks": [ { "type": "command", "command": "..." } ] } ] } }
//
// We only ever add or remove entries whose command contains our marker path
// (/agent-daycare/hook/), so anything else the user has configured is left alone.
// A backup of the file is written before every change.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = '/agent-daycare/hook/';

// Events that tell us what the agent is doing. Order doesn't matter.
const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];

function defaultClaudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function buildCommand(hookUrl) {
  // curl ships with Windows 10+, macOS and most Linux. Reads the event JSON
  // from stdin (--data-binary @-), gives up after 3s so a stopped app never
  // slows Claude down, and stays silent (-s) so nothing shows in the transcript.
  return `curl -s -m 3 -X POST -H "Content-Type: application/json" --data-binary @- ${hookUrl}`;
}

function isOurs(hook) {
  return hook && typeof hook.command === 'string' && hook.command.includes(MARKER);
}

function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw); // a corrupt file is a real error — don't overwrite it
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object`);
  }
  return parsed;
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.agent-daycare.bak`);
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

// Removes our entries from every event; drops groups/events left empty.
function stripOurs(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map(group => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const hooks = group.hooks.filter(h => !isOurs(h));
        return hooks.length === group.hooks.length ? group : { ...group, hooks };
      })
      .filter(group => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

/**
 * Returns { installed: boolean, events: string[], file } describing whether our
 * hooks are present (for any URL — a port change still counts as installed).
 */
function status({ file = defaultClaudeSettingsPath() } = {}) {
  let settings;
  try {
    settings = readSettings(file);
  } catch (err) {
    return { installed: false, events: [], file, error: err.message };
  }
  const events = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (Array.isArray(groups) && groups.some(g => g && Array.isArray(g.hooks) && g.hooks.some(isOurs))) {
      events.push(event);
    }
  }
  return { installed: events.length > 0, events, file };
}

/**
 * Adds (or refreshes) our hook for every event in CLAUDE_EVENTS.
 */
function install({ hookUrl, file = defaultClaudeSettingsPath() }) {
  if (!hookUrl) throw new Error('hookUrl is required');
  const settings = stripOurs(readSettings(file));
  settings.hooks = settings.hooks || {};
  const command = buildCommand(hookUrl);
  for (const event of CLAUDE_EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
    settings.hooks[event] = groups;
  }
  writeSettings(file, settings);
  return status({ file });
}

function uninstall({ file = defaultClaudeSettingsPath() } = {}) {
  let settings;
  try {
    settings = readSettings(file);
  } catch (err) {
    if (err.code === 'ENOENT') return status({ file });
    throw err;
  }
  const before = JSON.stringify(settings);
  stripOurs(settings);
  if (JSON.stringify(settings) !== before) writeSettings(file, settings);
  return status({ file });
}

module.exports = { install, uninstall, status, buildCommand, defaultClaudeSettingsPath, CLAUDE_EVENTS, MARKER };
