const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, parse } = require('../src/env');

test('parse handles comments, blanks, quotes, export prefix and trailing comments', () => {
  const text = [
    '# comment',
    '',
    'SENTRY_DSN=https://abc@o1.ingest.sentry.io/1',
    'export PORT = 48211',
    'QUOTED="a b # not a comment"',
    "SINGLE='x=y'",
    'ESCAPED="line1\\nline2"',
    'TRAILING=value # comment',
    'not a valid line',
    '9BAD=starts-with-digit'
  ].join('\n');
  assert.deepEqual(parse(text), {
    SENTRY_DSN: 'https://abc@o1.ingest.sentry.io/1',
    PORT: '48211',
    QUOTED: 'a b # not a comment',
    SINGLE: 'x=y',
    ESCAPED: 'line1\nline2',
    TRAILING: 'value'
  });
});

test('load applies the file without overriding existing variables and tolerates a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'A=from-file\nB=from-file\n');
  const env = { A: 'from-shell' };
  assert.deepEqual(load(file, env), ['B']);
  assert.deepEqual(env, { A: 'from-shell', B: 'from-file' });
  assert.deepEqual(load(path.join(dir, 'missing.env'), env), []);
});
