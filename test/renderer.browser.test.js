// Drives the real renderer (src/renderer/index.html) in headless Chromium with
// a stand-in for preload.js, and checks that agent cards update in place.
//
// Optional: skipped unless `playwright-core` is installed and a Chromium is
// available (CHROME_PATH, or Playwright's own download via
// `npx playwright install chromium`). Everything else in test/ runs without it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

let chromium = null;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {}

const executablePath = process.env.CHROME_PATH || undefined;

test('agent cards are updated in place, not rebuilt, on status broadcasts', { skip: !chromium && 'playwright-core not installed' }, async () => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  } catch (err) {
    test.skip(`no Chromium available: ${err.message.split('\n')[0]}`);
    return;
  }
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.addInitScript(() => {
      const agents = [
        { id: 'antigravity', name: 'Antigravity', title: 'Team Lead & Orchestrator', role: 'lead', status: 'sleeping', version: '1', installed: true, path: 'x' },
        { id: 'claude', name: 'Claude Code', title: 'Code Architect & Builder', role: 'architect', status: 'sleeping', version: '2', installed: true, path: 'x' },
        { id: 'codex', name: 'Codex', title: 'QA & Logic Engineer', role: 'tester', status: 'sleeping', version: '3', installed: true, path: 'x' },
        { id: 'grok', name: 'Grok', title: 'Sentry & Code Reviewer', role: 'reviewer', status: 'sleeping', version: '4', installed: true, path: 'x' }
      ];
      window.api = {
        scanAgents: async () => agents, getAgentConfigs: async () => agents,
        getHookStatus: async () => ({ listening: true, agents: {} }),
        startAgent: async () => true, stopAgent: async () => {}, sendInput: async () => true, updateAgentRole: async () => {},
        forwardToAgent: async () => true, log: () => {}, openLogsFolder: async () => ({ path: '/x' }),
        installHooks: async () => {}, uninstallHooks: async () => {},
        onAgentOutput: () => {}, onAgentStatus: cb => { window.__status = cb; }, onAgentPrompt: () => {}, onTeamMessage: () => {},
        minimizeWindow() {}, maximizeWindow() {}, closeWindow() {}
      };
    });

    await page.goto('file://' + path.resolve(__dirname, '..', 'src', 'renderer', 'index.html'));
    await page.waitForFunction(() => document.querySelectorAll('.agent-card').length === 4 && window.__status, null, { timeout: 10000 });

    const r = await page.evaluate(() => {
      const out = {};
      const sprite = () => document.querySelector('#card-claude .mascot-sprite');
      const card = () => document.getElementById('card-claude');
      const status = (s, sessions = 0) => window.__status({ agentId: 'claude', status: s, role: 'architect', title: 'Code Architect & Builder', externalPid: null, hookSessions: sessions });
      const card0 = card(), sprite0 = sprite(), grok0 = document.querySelector('#card-grok .mascot-sprite');

      status('sleeping');
      out.noopKeepsSprite = sprite() === sprite0 && card() === card0;

      status('working', 2);
      out.changeSwapsSpriteOnly = sprite() !== sprite0 && card() === card0 && document.querySelector('#card-grok .mascot-sprite') === grok0;
      out.working = sprite().classList.contains('working');
      out.statusText = card().querySelector('.status-tag span:last-child').textContent;

      const sprite1 = sprite();
      status('working', 2);
      out.repeatKeepsSprite = sprite() === sprite1;

      status('needs_input', 1);
      out.alert = card().classList.contains('alert') && !!card().querySelector('.alert-bubble');
      out.cards = document.querySelectorAll('.agent-card').length;
      return out;
    });

    assert.deepEqual(errors, []);
    assert.equal(r.noopKeepsSprite, true);
    assert.equal(r.changeSwapsSpriteOnly, true);
    assert.equal(r.working, true);
    assert.equal(r.statusText, 'WORKING ×2');
    assert.equal(r.repeatKeepsSprite, true);
    assert.equal(r.alert, true);
    assert.equal(r.cards, 4);
  } finally {
    await browser.close();
  }
});
