// Live Notion ticket glance (main process only). The token comes from
// .env.local via process.env and never leaves this process: it is not
// logged, not returned, and only ever sent to api.notion.com, a fixed
// host, with a validated page id — no caller-chosen URL is fetched.
const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

function loadNotionToken(env = process.env) {
  return env.NOTION_API_KEY || env.NOTION_TOKEN || null;
}

// A Notion page id (32 hex, dashes optional) inside a URL or bare, else null.
function notionPageId(ref) {
  const hit = /[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.exec(String(ref || ''));
  if (!hit) return null;
  const hex = hit[0].replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const plain = (rich) => (Array.isArray(rich) ? rich.map(r => r.plain_text || (r.text && r.text.content) || '').join('') : '');

// A database page (or plain page) plus its blocks as glance fields. Property
// names vary per database, so title/status/priority are found by type and
// by name, and anything missing is simply absent from the card.
function extractTicket(page, blocks = []) {
  const props = (page && page.properties) || {};
  let title = '';
  let status = null;
  let priority = null;
  for (const [name, p] of Object.entries(props)) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'title' && !title) title = plain(p.title);
    if ((p.type === 'status' || p.type === 'select') && /status|state/i.test(name) && !status) {
      const v = p.status || p.select;
      if (v && v.name) status = v.name;
    }
    if (p.type === 'select' && /priority/i.test(name) && !priority) {
      if (p.select && p.select.name) priority = p.select.name;
    }
  }
  if (!title && page && page.child_page && page.child_page.title) title = page.child_page.title;
  const tasks = (blocks || [])
    .filter(b => b && b.type === 'to_do' && b.to_do)
    .map(b => ({ text: plain(b.to_do.rich_text), done: Boolean(b.to_do.checked) }))
    .filter(t => t.text);
  return {
    id: page && page.id ? page.id : null,
    title: title || 'Untitled Notion page',
    status,
    priority,
    url: (page && page.url) || null,
    edited: (page && page.last_edited_time) || null,
    tasks
  };
}

async function fetchJson(fetchImpl, token, pathName) {
  const res = await fetchImpl(`${API}${pathName}`, {
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const err = new Error(`Notion API HTTP ${res.status} for ${pathName.split('/')[1]}`);
    err.code = 'NOTION_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// { connected: false } when no token is configured (the glance says so
// honestly); otherwise the live ticket. Throws on a bad ref or API error.
async function getTicket(ref, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const token = loadNotionToken(env);
  if (!token) return { connected: false };
  const id = notionPageId(ref);
  if (!id) {
    const err = new Error('No Notion page id in that reference');
    err.code = 'NOTION_BAD_REF';
    throw err;
  }
  const page = await fetchJson(fetchImpl, token, `/pages/${id}`);
  let blocks = [];
  try {
    const out = await fetchJson(fetchImpl, token, `/blocks/${id}/children?page_size=50`);
    blocks = out.results || [];
  } catch (_) { /* a page we can title but not read still glances */ }
  return { connected: true, ticket: extractTicket(page, blocks) };
}

module.exports = { loadNotionToken, notionPageId, extractTicket, getTicket };
