const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnsi } = require('../src/utils/ansi.js');

test('colours become spans and HTML is escaped', () => {
  const html = parseAnsi('\x1b[1;32mok\x1b[0m <b>&');
  assert.equal(html, '<span style="font-weight: bold; color: #50fa7b;">ok</span> &lt;b&gt;&amp;');
});

test('private and non-SGR control sequences are stripped completely', () => {
  const raw = '\x1b[>4;2m\x1b[?25l\x1b[=c\x1b[2Ktext\x1b]0;title\x07\x1b[38;2;1;2;3m';
  const html = parseAnsi(raw);
  assert.ok(!html.includes('\x1b'), `escape survived: ${JSON.stringify(html)}`);
  assert.ok(html.includes('text'));
});

test('no ESC[ survives, so the renderer never re-parses already-escaped HTML', () => {
  assert.equal(parseAnsi('\x1b[>4;2mif (a < b) {\x1b[0m'), 'if (a &lt; b) {</span>');
  for (const raw of ['partial \x1b[', 'partial \x1b[31', 'x\x1b[m']) {
    const html = parseAnsi(raw);
    assert.ok(!html.includes('\x1b['), JSON.stringify({ raw, html }));
  }
});
