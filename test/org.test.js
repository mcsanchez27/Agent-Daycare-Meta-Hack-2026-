const test = require('node:test');
const assert = require('node:assert/strict');
const { folderFile, personaIdOf, skillsFor, folderText, describeAssignment } = require('../src/renderer/org');

const skills = [
  { file: 'security-audit.md', title: 'Security Auditing', text: '# Security Auditing\n\nCheck the fence.' },
  { file: 'notion-sync.md', title: 'Notion Sync', text: '# Notion Sync\n\nKeep tickets current.' },
  { file: 'stitch.md', title: 'Stitch', text: '# Stitch\n\nDesign in Stitch.' }
];
const assignments = {
  'security-audit.md': { all: false, engines: ['claude'], personas: ['smith'] },
  'notion-sync.md': { all: true },
  'stitch.md': { all: false, engines: [], personas: ['uiux'] }
};

test('skills reach an engine through its folder file, a persona through the prompt (TM-60)', () => {
  const claude = skillsFor({ vendor: 'claude', persona: null }, skills, assignments);
  assert.deepEqual(claude.engine.map(s => s.file), ['security-audit.md', 'notion-sync.md']);
  assert.deepEqual(claude.persona, []);
  const smith = skillsFor({ vendor: 'antigravity', persona: 'smith' }, skills, assignments);
  assert.deepEqual(smith.engine.map(s => s.file), ['notion-sync.md'], '"all" counts as the engine');
  assert.deepEqual(smith.persona.map(s => s.file), ['security-audit.md']);
  const codex = skillsFor({ vendor: 'codex' }, skills, assignments);
  assert.deepEqual(codex.engine.map(s => s.file), ['notion-sync.md']);
  assert.deepEqual(skillsFor({ vendor: 'grok' }, skills, {}), { engine: [], persona: [] }, 'nothing assigned, nothing given');
});

test('each CLI has its folder file; Grok has none', () => {
  assert.equal(folderFile('claude'), 'CLAUDE.md');
  assert.equal(folderFile('codex'), 'AGENTS.md');
  assert.equal(folderFile('antigravity'), 'GEMINI.md');
  assert.equal(folderFile('grok'), null);
});

test('a member made from a saved persona is recognised by its brain file', () => {
  assert.equal(personaIdOf({ brain: 'agent-smith.md' }), 'smith');
  assert.equal(personaIdOf({ brain: 'my-custom.md' }), null);
  assert.equal(personaIdOf({}), null);
});

test('the folder file carries the Central Brain, then the skills as written', () => {
  const text = folderText('# Central Brain\n\nRule 1.', skills.slice(0, 1));
  assert.ok(text.startsWith('<!-- Written by Agent Daycare'), text);
  assert.match(text, /# Central Brain\n\nRule 1\.\n\n# Security Auditing\n\nCheck the fence\.\n$/);
  assert.equal(folderText(null, []).split('\n').length, 2, 'just the note when there is nothing');
});

test('an assignment reads back in plain words', () => {
  assert.equal(describeAssignment(null), 'no one yet');
  assert.equal(describeAssignment({ all: true }), 'all agents');
  assert.equal(describeAssignment(assignments['security-audit.md']), 'Claude; Agent Smith');
  assert.equal(describeAssignment({ engines: ['codex', 'antigravity'] }), 'Codex, Gemini');
});

test('textSig changes with the text and is stable', () => {
  const { textSig } = require('../src/renderer/org');
  assert.equal(textSig('abc'), textSig('abc'));
  assert.notEqual(textSig('abc'), textSig('abd'));
  assert.notEqual(textSig('a'), textSig('aa'));
  assert.match(textSig('hello'), /^5:[0-9a-f]+$/);
});

test('MCP servers reach a member by assignment or its own pick; Claude gets a --mcp-config (TM-60 Batch 3)', () => {
  const { mcpFor, claudeMcpConfig, parseCommandLine } = require('../src/renderer/org');
  const servers = [
    { id: 'pdf', name: 'PDF', command: 'npx', args: ['-y', '@modelcontextprotocol/server-pdf', '--stdio'] },
    { id: 'stitch', name: 'Stitch', url: 'https://stitch.googleapis.com/mcp', headers: { 'X-Goog-Api-Key': 'k' } },
    { id: 'gh', name: 'GitHub', command: 'npx', args: ['-y', 'x'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 't' } }
  ];
  const assign = { pdf: { all: true }, stitch: { engines: [], personas: ['uiux'] } };
  assert.deepEqual(mcpFor({ vendor: 'claude' }, servers, assign).map(s => s.id), ['pdf']);
  assert.deepEqual(mcpFor({ vendor: 'claude', own: ['gh'] }, servers, assign).map(s => s.id), ['pdf', 'gh']);
  assert.deepEqual(mcpFor({ vendor: 'antigravity', persona: 'uiux' }, servers, assign).map(s => s.id), ['pdf', 'stitch']);
  const cfg = claudeMcpConfig(mcpFor({ vendor: 'claude', own: ['gh', 'stitch'] }, servers, assign));
  assert.deepEqual(cfg, { mcpServers: {
    pdf: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-pdf', '--stdio'] },
    stitch: { type: 'http', url: 'https://stitch.googleapis.com/mcp', headers: { 'X-Goog-Api-Key': 'k' } },
    gh: { command: 'npx', args: ['-y', 'x'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 't' } }
  } });
  assert.deepEqual(parseCommandLine('npx -y mcp-remote https://x/mcp --header "X-Goog-Api-Key: SECRET"'), { command: 'npx', args: ['-y', 'mcp-remote', 'https://x/mcp', '--header', 'X-Goog-Api-Key: SECRET'] });
  assert.deepEqual(parseCommandLine(''), { command: '', args: [] });
});
