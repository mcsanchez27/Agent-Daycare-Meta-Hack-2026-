const test = require('node:test');
const assert = require('node:assert/strict');
const { notionPageId, extractTicket, getTicket } = require('../src/notion');

const ID = '12345678-1234-1234-1234-1234567890ab';

test('notionPageId pulls the page id out of a Notion URL', () => {
  assert.equal(notionPageId(`https://www.notion.so/Costume-Design-${ID.replace(/-/g, '')}`), ID);
  assert.equal(notionPageId(ID), ID);
  assert.equal(notionPageId('TM-59'), null);
  assert.equal(notionPageId('no id here'), null);
});

test('extractTicket reads title, status, priority and checklist', () => {
  const page = {
    url: 'https://www.notion.so/x',
    last_edited_time: '2026-11-02T10:00:00.000Z',
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Costume Design' }] },
      Status: { type: 'status', status: { name: 'In progress' } },
      Priority: { type: 'select', select: { name: 'High' } }
    }
  };
  const blocks = [
    { type: 'to_do', to_do: { rich_text: [{ plain_text: 'Fit test' }], checked: true } },
    { type: 'to_do', to_do: { rich_text: [{ plain_text: 'Photos' }], checked: false } },
    { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'note' }] } }
  ];
  const t = extractTicket(page, blocks);
  assert.equal(t.title, 'Costume Design');
  assert.equal(t.status, 'In progress');
  assert.equal(t.priority, 'High');
  assert.deepEqual(t.tasks, [{ text: 'Fit test', done: true }, { text: 'Photos', done: false }]);
});

test('getTicket without a token reports not connected and never fetches', async () => {
  let called = false;
  const out = await getTicket(ID, { env: {}, fetchImpl: async () => { called = true; } });
  assert.deepEqual(out, { connected: false });
  assert.equal(called, false);
});

test('getTicket fetches the page and its blocks with the token', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push([url, opts.headers.Authorization]);
    const body = url.includes('/blocks/')
      ? { results: [{ type: 'to_do', to_do: { rich_text: [{ plain_text: 'Do it' }], checked: false } }] }
      : { url: 'https://www.notion.so/x', properties: { Name: { type: 'title', title: [{ plain_text: 'T' }] } } };
    return { ok: true, status: 200, json: async () => body };
  };
  const out = await getTicket(`https://www.notion.so/T-${ID.replace(/-/g, '')}`, { env: { NOTION_API_KEY: 'secret_x' }, fetchImpl });
  assert.equal(out.connected, true);
  assert.equal(out.ticket.title, 'T');
  assert.deepEqual(out.ticket.tasks, [{ text: 'Do it', done: false }]);
  assert.ok(seen.every(([, auth]) => auth === 'Bearer secret_x'));
  assert.ok(seen[0][0].includes(`/v1/pages/${ID}`));
});
