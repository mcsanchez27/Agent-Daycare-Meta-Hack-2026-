const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const orgTools = require('../src/renderer/org');
const threadTools = require('../src/renderer/thread');
const { newMember } = require('../src/renderer/members');
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

// Exercise the actual renderer functions without starting Electron or a CLI.
function functionSource(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
const cleanSource = functionSource(main, 'function cleanOrg(org)', "handle('org:get'");
const cleanOrg = vm.runInNewContext(cleanSource + '; cleanOrg', {
  str: (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '',
  SKILL_FILE: /^[a-z0-9][a-z0-9-]*\.md$/i, SERVER_ID: /^[a-z0-9-]+$/, PERSONA_ID: /^[a-z0-9-]+$/,
  userConfig: { AGENT_IDS: ['claude', 'codex', 'antigravity', 'grok'] },
  AgentRunner: { MODEL_TEXT: /^[a-z0-9.-]+$/i }, cleanAssignment: a => a
});

test('Builder save, disk reload, summon and chat reload retain custom instructions and skills', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-instructions-'));
  const file = path.join(dir, 'org.json');
  try {
    const api = {
      getOrg: async () => fs.existsSync(file) ? cleanOrg(JSON.parse(fs.readFileSync(file, 'utf8'))) : {},
      saveOrg: async org => fs.writeFileSync(file, JSON.stringify(cleanOrg(org))), log() {}
    };
    const save = vm.runInNewContext(functionSource(app, 'async function saveTeammate(cfg)', 'async function removeTeammate') + '; saveTeammate', { api, teammates: orgTools.teammates });
    const custom = '  Keep the original wording.\n\nCheck café notes.  ';
    await save({ name: 'Verifier', vendor: 'codex', brain: 'persona.md', brainText: 'Cached persona', customInstructions: custom, skills: ['audit.md'] });
    const p = orgTools.teammates(await api.getOrg()).find(p => p.id === 'verifier');
    assert.equal(p.customInstructions, custom);
    // Run the same restoration block as the teammate chooser.
    const restore = functionSource(app, "          let brainText = p.brainText", "          if (prevMode === 'add')");
    const opts = await vm.runInNewContext('(async () => {' + restore + '; return opts; })()', { p, api, modelLabelOf: () => null });
    const member = newMember([], { vendor: p.vendor, ...opts });
    const reloaded = JSON.parse(JSON.stringify(member));
    assert.equal(reloaded.customInstructions, custom);
    assert.equal(reloaded.brainText, 'Cached persona');
    assert.equal(orgTools.skillsFor({ vendor: 'codex', persona: reloaded.persona }, [{ file: 'audit.md', text: 'Audit carefully.' }], (await api.getOrg()).skills).persona.length, 1);
    const legacy = cleanOrg({ agents: [{ id: 'old', name: 'Old', vendor: 'claude' }, { id: 'text', name: 'Text', vendor: 'claude', brainText: 'Legacy custom' }] });
    assert.equal(legacy.agents[0].customInstructions, '');
    assert.equal(legacy.agents[1].brainText, 'Legacy custom');
    assert.equal(cleanOrg({ agents: [{ id: 'bad', name: 'Bad', vendor: 'claude', customInstructions: {} }] }).agents[0].customInstructions, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const vendor of ['claude', 'codex', 'antigravity', 'grok']) {
  test(`${vendor}: fresh and resumed launches compose guidance without repeated unchanged context`, async () => {
    const member = newMember([], { vendor, brain: 'persona.md', brainText: 'Old snapshot', customInstructions: 'Custom rule', persona: 'verifier' });
    const thread = threadTools.createThread([member]);
    threadTools.addMessage(thread, { from: 'matt', to: member.id, text: 'Start' });
    let persona = 'Live persona';
    let skills = [{ file: 'audit.md', text: 'Persona skill' }, { file: 'engine.md', text: 'Engine skill' }];
    let launched;
    const pending = {};
    const context = {
      ...orgTools, ...threadTools, chats: new Map([['chat', { thread }]]), pending, currentId: null,
      memberById: (t, id) => t.members.find(m => m.id === id), otherChats: () => [], runKeyOf: (c, m) => `${c}/${m}`,
      renderChatList() {}, updateSendButtons() {},
      api: {
        resolveBrains: async () => ({ central: { text: 'Central rule' }, persona: { text: persona } }),
        getOrg: async () => ({ skills: { 'audit.md': { personas: ['verifier'] }, 'engine.md': { engines: [vendor], personas: ['verifier'] } } }),
        listSkills: async () => skills, listMcps: async () => [], log() {},
        run: async args => { launched = args; return true; }
      }
    };
    const ask = vm.runInNewContext(functionSource(app, 'async function ask(', 'function onOutput(') + '; ask', context);
    await ask('chat', member.id);
    const full = launched.prompt + JSON.stringify(launched.files);
    for (const text of ['Central rule', 'Live persona', 'Custom rule', 'Persona skill', 'Engine skill']) assert.equal(full.split(text).length - 1, 1, text);
    assert.ok(!full.includes('Old snapshot'));
    member.sessions = { main: { id: 'session', lastId: 1, brainSig: pending[`chat/${member.id}`].brainSig } };
    await ask('chat', member.id);
    assert.ok(!launched.prompt.includes('Notice:'));
    assert.ok(!launched.prompt.includes('Custom rule'));
    member.customInstructions = 'Updated custom rule';
    await ask('chat', member.id);
    assert.match(launched.prompt, /Notice:/);
    assert.equal(launched.prompt.split('Updated custom rule').length - 1, 1);
    member.sessions.main.brainSig = pending[`chat/${member.id}`].brainSig;
    await ask('chat', member.id);
    assert.ok(!launched.prompt.includes('Notice:'));
    persona = 'Changed persona';
    await ask('chat', member.id);
    assert.match(launched.prompt, /Changed persona/);
    member.sessions.main.brainSig = pending[`chat/${member.id}`].brainSig;
    skills[0].text = 'Changed skill';
    await ask('chat', member.id);
    assert.match(launched.prompt, /Changed skill/);
    // Pre-signature sessions catch up on the next turn.
    member.sessions.main.brainSig = '';
    await ask('chat', member.id);
    assert.match(launched.prompt, /Updated custom rule/);
    threadTools.addMessage(thread, { from: 'matt', to: member.id, text: 'Thread reply', threadOf: 1 });
    member.sessions['1'] = { id: 'thread-session', lastId: 1, brainSig: '' };
    await ask('chat', member.id, 1);
    assert.equal(launched.sessionId, 'thread-session');
    assert.match(launched.prompt, /Updated custom rule/);
    member.sessions['1'].brainSig = pending[`chat/${member.id}`].brainSig;
    await ask('chat', member.id, 1);
    assert.ok(!launched.prompt.includes('Notice:'));
    member.customInstructions = '';
    member.brain = null;
    member.brainText = '';
    persona = '';
    skills = [];
    context.api.resolveBrains = async () => ({});
    await ask('chat', member.id, 1);
    assert.match(launched.prompt, /No additional directives remain/);
    member.sessions['1'].brainSig = pending[`chat/${member.id}`].brainSig;
    await ask('chat', member.id, 1);
    assert.ok(!launched.prompt.includes('Notice:'));
  });
}

test('legacy free text coexists with skills; snapshots and identical text are not duplicated', () => {
  assert.match(threadTools.promptGuidance({ brainText: 'Legacy custom' }, { personaSkills: [{ text: 'Skill' }] }), /Legacy custom.*Assigned skill:\nSkill/s);
  const result = threadTools.promptGuidance({ brain: 'p.md', brainText: 'Cached', customInstructions: 'Same' }, { personaChip: 'Same', personaSkills: [{ text: 'Same' }] });
  assert.equal(result.split('Same').length - 1, 1);
  assert.ok(!result.includes('Cached'));
  assert.match(threadTools.promptGuidance({ brain: 'p.md', brainText: 'Cached' }), /Cached/);
});

test('merging chats retains custom instructions', () => {
  const member = newMember([], { vendor: 'claude', customInstructions: 'Keep this rule' });
  const merged = threadTools.mergeThreads(threadTools.createThread([member]), threadTools.createThread([]));
  assert.equal(merged.members[0].customInstructions, 'Keep this rule');
});
