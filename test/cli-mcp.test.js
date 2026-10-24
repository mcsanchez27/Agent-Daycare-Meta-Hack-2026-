const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAgyMcpList, parseCodexMcpList, parseGrokMcpList, readCliMcpLists } = require('../src/cli-mcp');

test('agy mcp list: name, type, enabled, command', () => {
  const text = [
    'NAME                   TYPE   STATUS   COMMAND/URL',
    'StitchMCP              stdio  enabled  npx -y mcp-remote https://stitch.googleapis.com/mcp --header X-Goog-Api-Key: SECRET',
    'google-home-developer  http   enabled  https://homedevelopers.googleapis.com/mcp',
    'unity                  stdio  disabled C:\\Users\\Matth\\AppData\\Local\\Unity\\bin\\unity.exe mcp'
  ].join('\n');
  const list = parseAgyMcpList(text);
  assert.deepEqual(list.map(s => [s.name, s.type, s.enabled]), [['StitchMCP', 'stdio', true], ['google-home-developer', 'http', true], ['unity', 'stdio', false]]);
  assert.equal(list[0].command, 'npx -y mcp-remote https://stitch.googleapis.com/mcp --header X-Goog-Api-Key: SECRET');
});

test('codex mcp list: first column is the name, header skipped, disabled seen', () => {
  const text = [
    'Name       Command   Args   Env   Cwd   Status    Auth',
    'codex_app  cmd.exe   /d     X     -     disabled  Unsupported',
    'github     npx       -y @modelcontextprotocol/server-github   GITHUB_PERSONAL_ACCESS_TOKEN=*****   -   enabled   Unsupported',
    ''
  ].join('\n');
  assert.deepEqual(parseCodexMcpList(text), [{ name: 'codex_app', enabled: false }, { name: 'github', enabled: true }]);
});

test('grok mcp list: "name: target" lines', () => {
  const text = '  linear: https://mcp.linear.app/mcp\n  chrome-devtools: npx -y chrome-devtools-mcp@1.9.0\n';
  assert.deepEqual(parseGrokMcpList(text).map(s => s.name), ['linear', 'chrome-devtools']);
  assert.equal(parseGrokMcpList(text)[1].command, 'npx -y chrome-devtools-mcp@1.9.0');
});

test('readCliMcpLists asks each CLI and tolerates one failing', async () => {
  const run = (cmd, _opts, cb) => {
    if (cmd.startsWith('grok')) return cb(new Error('not installed'), '');
    if (cmd.startsWith('codex')) return cb(null, 'Name  Command\npdf   npx -y x\n');
    cb(null, 'NAME TYPE STATUS COMMAND/URL\nStitchMCP stdio enabled npx -y mcp-remote x\n');
  };
  const lists = await readCliMcpLists({ run });
  assert.deepEqual(Object.keys(lists).sort(), ['antigravity', 'codex', 'grok']);
  assert.deepEqual(lists.grok, []);
  assert.deepEqual(lists.codex.map(s => s.name), ['pdf']);
  assert.deepEqual(lists.antigravity.map(s => s.name), ['StitchMCP']);
});
