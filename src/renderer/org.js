// Org Control assignments (TM-60 Batch 2): which skills each engine (vendor)
// and saved persona gets, and how they reach an agent. Plain data, no DOM,
// so it runs in the window and in node --test.
//
// An assignment is { all, engines: [vendor], personas: [persona id] }. A
// skill given to an engine goes into the chat folder as the file that CLI
// reads on its own (CLAUDE.md, AGENTS.md for Codex, GEMINI.md); a skill
// given to a persona rides in that member's prompt, since two members of
// one engine share the folder but not the persona. Grok has no such file,
// so everything stays in its prompt.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./members'));
  else root.ChatOrg = factory(root.ChatMembers);
})(typeof self !== 'undefined' ? self : this, function ({ PERSONAS, VENDOR_NAMES }) {
  const FOLDER_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md', antigravity: 'GEMINI.md' };

  function folderFile(vendor) {
    return FOLDER_FILES[vendor] || null;
  }

  // The teammate (built-in persona or saved agent) a member was made from:
  // its `persona` id when it has one (TM-60 Batch 4), else by brain file.
  function personaIdOf(member) {
    if (member && member.persona) return member.persona;
    const hit = member && member.brain ? Object.values(PERSONAS).find(p => p.brainFile === member.brain) : null;
    return hit ? hit.id : null;
  }

  // Everyone that can be summoned or given things: the built-in personas,
  // then the agents Matt saved from the Builder (org.agents). A saved agent
  // is { id, name, vendor, role, brainFile, mcp: [ids], skills: [files] }.
  function teammates(org) {
    const builtIn = Object.values(PERSONAS).map(p => ({ id: p.id, name: p.name, vendor: p.vendor, role: p.role, brainFile: p.brainFile, color: p.color, builtIn: true }));
    const saved = ((org && org.agents) || []).filter(a => !builtIn.some(b => b.id === a.id)).map(a => ({ ...a, builtIn: false }));
    return [...builtIn, ...saved];
  }

  // How an assignment reaches { vendor, persona }: 'engine', 'persona' or null.
  function applies(a, { vendor, persona = null }) {
    if (!a) return null;
    if (a.all === true || (a.engines || []).includes(vendor)) return 'engine';
    if (persona && (a.personas || []).includes(persona)) return 'persona';
    return null;
  }

  // skills: [{ file, title, text }]; assignments: { [file]: assignment }.
  // target.own: skill files picked for this member itself (Builder); they
  // ride in its prompt like a persona's, since the folder file is shared.
  function skillsFor(target, skills, assignments) {
    const out = { engine: [], persona: [] };
    const own = new Set(target.own || []);
    for (const s of skills || []) {
      const how = applies((assignments || {})[s.file], target) || (own.has(s.file) ? 'persona' : null);
      if (how) out[how].push(s);
    }
    return out;
  }

  // The id a saved teammate gets from its name: a slug, numbered when another
  // teammate already holds it. Never longer than 32 characters, so a long
  // name still gets a fresh number rather than the same slug again.
  const TEAMMATE_ID_MAX = 32;
  function teammateId(name, taken) {
    const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, TEAMMATE_ID_MAX) || 'teammate';
    let id = base;
    for (let k = 2; taken.includes(id); k++) id = `${base.slice(0, TEAMMATE_ID_MAX - String(k).length - 1)}-${k}`;
    return id;
  }

  // The folder file's text: the Central Brain, then the skills, each as written.
  function folderText(central, skills) {
    const parts = ['<!-- Written by Agent Daycare before each launch. Edit the Central Brain and skills in Org Control, not here. -->'];
    if (central && central.trim()) parts.push(central.trim());
    for (const s of skills || []) parts.push(s.text.trim());
    return parts.join('\n\n') + '\n';
  }

  // "all agents", "Claude, Codex; Agent Smith" or "no one yet".
  function describeAssignment(a, vendorNames = VENDOR_NAMES, team = null) {
    if (!a) return 'no one yet';
    if (a.all === true) return 'all agents';
    const engines = (a.engines || []).map(v => vendorNames[v] || v);
    const names = Object.fromEntries((team || Object.values(PERSONAS)).map(t => [t.id, t.name]));
    const personas = (a.personas || []).map(id => names[id] || id);
    const text = [engines.join(', '), personas.join(', ')].filter(Boolean).join('; ');
    return text || 'no one yet';
  }

  // MCP servers (TM-60 Batch 3). servers: [{ id, name, command, args, env, url }]
  // from the directory; assignments like skills; own: ids picked for this
  // member in the Builder. Returns the servers this member gets.
  function mcpFor(target, servers, assignments) {
    const own = new Set(target.own || []);
    return (servers || []).filter(s => own.has(s.id) || applies((assignments || {})[s.id], target));
  }

  // Claude's --mcp-config JSON for these servers: stdio by command, or http by url.
  function claudeMcpConfig(servers) {
    const mcpServers = {};
    for (const s of servers || []) {
      if (s.url) mcpServers[s.id] = { type: 'http', url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
      else if (s.command) mcpServers[s.id] = { command: s.command, args: s.args || [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) };
    }
    return { mcpServers };
  }

  // "npx -y some-server --flag \"two words\"" -> { command, args }, quotes honoured.
  function parseCommandLine(text) {
    const parts = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (let m; (m = re.exec(String(text || '')));) parts.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    return { command: parts[0] || '', args: parts.slice(1) };
  }

  // A short signature of a text, so a resumed session can tell whether the
  // brain text it was given has changed since. Not a security hash.
  function textSig(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return `${text.length}:${h.toString(16)}`;
  }

  return { FOLDER_FILES, folderFile, personaIdOf, teammates, teammateId, applies, skillsFor, folderText, describeAssignment, textSig, mcpFor, claudeMcpConfig, parseCommandLine };
});
