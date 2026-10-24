// What each CLI already has as MCP servers (TM-60 Batch 3). Gemini (agy),
// Codex and Grok keep their own global lists; Daycare reads them with each
// CLI's `mcp list` so the directory can show who has what. Claude gets its
// servers per launch instead (see agent-runner `--mcp-config`).
const { exec } = require('child_process');

// agy: a table "NAME TYPE STATUS COMMAND/URL", one server per line.
function parseAgyMcpList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\S+)\s+(stdio|http|sse)\s+(enabled|disabled)\s+(.+?)\s*$/.exec(line);
    if (m && m[1] !== 'NAME') out.push({ name: m[1], type: m[2], enabled: m[3] === 'enabled', command: m[4] });
  }
  return out;
}

// codex: a wide table whose first column is the name; the header row says "Name".
function parseCodexMcpList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\S+)\s+\S/.exec(line);
    if (!m || m[1] === 'Name') continue;
    out.push({ name: m[1], enabled: !/\bdisabled\b/.test(line) });
  }
  return out;
}

// grok: "  name: url-or-command" lines.
function parseGrokMcpList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([\w.-]+):\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ name: m[1], enabled: true, command: m[2] });
  }
  return out;
}

const PARSERS = { antigravity: parseAgyMcpList, codex: parseCodexMcpList, grok: parseGrokMcpList };
const COMMANDS = { antigravity: 'agy mcp list', codex: 'codex mcp list', grok: 'grok mcp list' };

// { antigravity: [...], codex: [...], grok: [...] }; a CLI that fails or is
// missing gives []. The commands are fixed strings, so a shell is fine here.
function readCliMcpLists({ timeoutMs = 15000, run = exec } = {}) {
  return Promise.all(Object.keys(COMMANDS).map(vendor => new Promise((resolve) => {
    run(COMMANDS[vendor], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve([vendor, err && !stdout ? [] : PARSERS[vendor](stdout || '')]);
    });
  }))).then(pairs => Object.fromEntries(pairs));
}

module.exports = { parseAgyMcpList, parseCodexMcpList, parseGrokMcpList, readCliMcpLists, COMMANDS };
