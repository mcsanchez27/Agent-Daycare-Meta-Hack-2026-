const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLocalEnv, parseLine } = require('../src/env');

function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-env-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test('parseLine reads KEY=VALUE, quotes, comments and blanks', () => {
  assert.deepEqual(parseLine('A=1'), { key: 'A', value: '1' });
  assert.deepEqual(parseLine('  BASETEN_API_KEY = "b10_fixture" '), { key: 'BASETEN_API_KEY', value: 'b10_fixture' });
  assert.deepEqual(parseLine("K='v=v'"), { key: 'K', value: 'v=v' });
  assert.equal(parseLine('# comment'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('no-equals'), null);
  assert.equal(parseLine('9BAD=x'), null);
});

test('loadLocalEnv sets missing keys and never overrides real environment', () => {
  const file = tempFile('.env.local', '# secrets\nBASETEN_API_KEY=file-key\nSHARED=file\n');
  const env = { SHARED: 'real' };
  const result = loadLocalEnv(file, env);
  assert.deepEqual(result.loaded, ['BASETEN_API_KEY']);
  assert.equal(env.BASETEN_API_KEY, 'file-key');
  assert.equal(env.SHARED, 'real');
  assert.ok(!JSON.stringify(result).includes('file-key'));
});

test('loadLocalEnv reports a missing file instead of throwing', () => {
  const result = loadLocalEnv(path.join(os.tmpdir(), 'daycare-env-does-not-exist-12345'), {});
  assert.equal(result.missing, true);
  assert.deepEqual(result.loaded, []);
});