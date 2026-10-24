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

  // The saved persona a member was made from, by its brain file, or null.
  function personaIdOf(member) {
    const hit = member && member.brain ? Object.values(PERSONAS).find(p => p.brainFile === member.brain) : null;
    return hit ? hit.id : null;
  }

  // How an assignment reaches { vendor, persona }: 'engine', 'persona' or null.
  function applies(a, { vendor, persona = null }) {
    if (!a) return null;
    if (a.all === true || (a.engines || []).includes(vendor)) return 'engine';
    if (persona && (a.personas || []).includes(persona)) return 'persona';
    return null;
  }

  // skills: [{ file, title, text }]; assignments: { [file]: assignment }.
  function skillsFor(target, skills, assignments) {
    const out = { engine: [], persona: [] };
    for (const s of skills || []) {
      const how = applies((assignments || {})[s.file], target);
      if (how) out[how].push(s);
    }
    return out;
  }

  // The folder file's text: the Central Brain, then the skills, each as written.
  function folderText(central, skills) {
    const parts = ['<!-- Written by Agent Daycare before each launch. Edit the Central Brain and skills in Org Control, not here. -->'];
    if (central && central.trim()) parts.push(central.trim());
    for (const s of skills || []) parts.push(s.text.trim());
    return parts.join('\n\n') + '\n';
  }

  // "all agents", "Claude, Codex; Agent Smith" or "no one yet".
  function describeAssignment(a, vendorNames = VENDOR_NAMES) {
    if (!a) return 'no one yet';
    if (a.all === true) return 'all agents';
    const engines = (a.engines || []).map(v => vendorNames[v] || v);
    const personas = (a.personas || []).map(id => (PERSONAS[id] ? PERSONAS[id].name : id));
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

  return { FOLDER_FILES, folderFile, personaIdOf, applies, skillsFor, folderText, describeAssignment, textSig, mcpFor, claudeMcpConfig, parseCommandLine };
});
