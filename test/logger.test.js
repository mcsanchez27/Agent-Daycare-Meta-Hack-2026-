const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Logger, stripAnsi, redact } = require('../src/logger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-log-'));
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

test('stripAnsi removes colour, cursor and OSC sequences', () => {
  const input = '\x1b]0;title\x07\x1b[32mgreen\x1b[0m \x1b[?25lhidden\x1b[2K';
  assert.equal(stripAnsi(input), 'green hidden');
});

test('redact masks common secret shapes but keeps the prefix', () => {
  assert.equal(redact('key sk-ant-abcdefghijklmnop done'), 'key [REDACTED] done');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnopqrstuv'), 'Authorization: Bearer [REDACTED]');
  assert.equal(redact('API_KEY=supersecretvalue123'), 'API_KEY=[REDACTED]');
  assert.equal(redact('token: ghp_abcdefghijklmnopqrstuvwxyz0123'), 'token: [REDACTED]');
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});

test('writes JSONL entries with the standard fields', async () => {
  const dir = tmpDir();
  const logger = new Logger({ dir }).open();
  logger.info('claude', 'hello \x1b[31mworld\x1b[0m', { run: 2, extra: 'x' });
  logger.error('app', 'boom');
  await logger.close();

  const lines = readLines(path.join(dir, 'latest.log'));
  assert.equal(lines[0].msg, 'log opened');
  assert.deepEqual(
    { level: lines[1].level, source: lines[1].source, run: lines[1].run, msg: lines[1].msg, extra: lines[1].extra },
    { level: 'info', source: 'claude', run: 2, msg: 'hello world', extra: 'x' }
  );
  assert.equal(lines[2].level, 'error');
  assert.ok(lines[2].ts);
});

test('line sink splits chunks into lines and handles split UTF-8 and \\r spinners', async () => {
  const dir = tmpDir();
  const logger = new Logger({ dir }).open();
  const sink = logger.createLineSink('codex', { stream: 'stdout' });

  const emoji = Buffer.from('✅ done\n', 'utf8'); // 3-byte char split across chunks
  sink.push(emoji.subarray(0, 2));
  sink.push(emoji.subarray(2));
  sink.push(Buffer.from('spinner 1\rspinner 2\rfinal\r\nno newline yet'));
  sink.flush();
  await logger.close();

  const msgs = readLines(path.join(dir, 'latest.log')).slice(1).map(l => l.msg);
  assert.deepEqual(msgs, ['✅ done', 'final', 'no newline yet']);
});

test('archives the previous latest.log on open and prunes old archives', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'latest.log'), '{"old":true}\n');
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(dir, `agent-daycare_2020-01-0${i + 1}_00-00-00.log`), '');
  }
  const logger = new Logger({ dir, keepArchives: 2 }).open();
  await logger.close();

  const names = fs.readdirSync(dir).sort();
  const archives = names.filter(n => n.startsWith('agent-daycare_'));
  assert.equal(archives.length, 2);
  assert.ok(!archives.includes('agent-daycare_2020-01-01_00-00-00.log'));
  assert.ok(!archives.includes('agent-daycare_2020-01-02_00-00-00.log'));
  assert.equal(readLines(path.join(dir, 'latest.log'))[0].msg, 'log opened');
});

test('rotates when latest.log exceeds maxBytes', async () => {
  const dir = tmpDir();
  const logger = new Logger({ dir, maxBytes: 300 }).open();
  for (let i = 0; i < 10; i++) logger.info('app', 'x'.repeat(50));
  await logger.close();

  const archives = fs.readdirSync(dir).filter(n => n.startsWith('agent-daycare_'));
  assert.ok(archives.length >= 1, 'expected at least one rotated file');
  const latest = readLines(path.join(dir, 'latest.log'));
  assert.ok(latest.some(l => l.msg === 'log rotated'));
});

test('reports a write failure once via onError and disables itself', async () => {
  const dir = tmpDir();
  let calls = 0;
  const logger = new Logger({ dir, onError: () => calls++ }).open();
  logger.stream.emit('error', new Error('disk full'));
  logger.stream.emit('error', new Error('disk full'));
  logger.info('app', 'ignored');
  assert.equal(calls, 1);
  assert.equal(logger.broken, true);
});
