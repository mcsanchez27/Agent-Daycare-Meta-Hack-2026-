const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

test('all source files pass syntax validation', () => {
  const files = [
    'src/main.js',
    'src/preload.js',
    'src/config.js',
    'src/chats.js',
    'src/logger.js',
    'src/agent-runner.js',
    'src/cli-mcp.js',
    'src/spellcheck.js',
    'src/projects.js',
    'src/env.js',
    'src/providers/index.js',
    'src/providers/meta.js',
    'src/renderer/org.js',
    'src/renderer/members.js',
    'src/renderer/thread.js',
    'src/renderer/projects.js',
    'src/renderer/app.js'
  ];

  for (const f of files) {
    const full = path.join(__dirname, '..', f);
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['-c', full]);
    }, `Syntax error in ${f}`);
  }
});