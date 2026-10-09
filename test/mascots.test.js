const test = require('node:test');
const assert = require('node:assert/strict');

// Mock window object
global.window = {};

// Require the mascots code (this will assign to window.MASCOT_CONFIGS)
require('../src/renderer/mascots.js');

const MASCOT_CONFIGS = window.MASCOT_CONFIGS;

test('MASCOT_CONFIGS is exported and contains all agents', () => {
  assert.ok(MASCOT_CONFIGS);

  const expectedAgents = ['antigravity', 'claude', 'codex', 'grok'];
  const actualAgents = Object.keys(MASCOT_CONFIGS);

  for (const agent of expectedAgents) {
    assert.ok(actualAgents.includes(agent), `Missing agent: ${agent}`);
  }
  assert.equal(actualAgents.length, expectedAgents.length);
});

const crownSvgStr = 'polygon points="16,6 20,12 24,5 28,12 32,6 30,14 18,14" fill="#ffd166"';

for (const agentId of Object.keys(MASCOT_CONFIGS)) {
  const config = MASCOT_CONFIGS[agentId];

  test(`renderAvatar for ${agentId}`, () => {
    // 1. role: lead, status: sleeping
    const html1 = config.renderAvatar('lead', 'sleeping');
    assert.ok(html1.includes('is-lead'), `Expected is-lead for ${agentId}`);
    assert.ok(html1.includes('sleep-bubble'), `Expected sleep-bubble for ${agentId}`);
    assert.ok(html1.includes(crownSvgStr), `Expected crown SVG for ${agentId}`);

    // 2. role: architect, status: working
    const html2 = config.renderAvatar('architect', 'working');
    assert.ok(!html2.includes('is-lead'), `Expected no is-lead for ${agentId} when not lead`);
    assert.ok(!html2.includes(crownSvgStr), `Expected no crown SVG for ${agentId} when not lead`);
    assert.ok(html2.includes(' working '), `Expected ' working ' status class for ${agentId}`);
    assert.ok(!html2.includes('sleep-bubble'), `Expected no sleep-bubble for ${agentId}`);
    assert.ok(!html2.includes('alert-bubble'), `Expected no alert-bubble for ${agentId}`);

    // 3. role: reviewer, status: needs_input
    const html3 = config.renderAvatar('reviewer', 'needs_input');
    assert.ok(html3.includes(' needs_input '), `Expected ' needs_input ' status class for ${agentId}`);
    assert.ok(html3.includes('alert-bubble'), `Expected alert-bubble for ${agentId}`);
  });
}
