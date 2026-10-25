// A chat's agents (TM-54). Each chat holds its own members in
// thread.members: [{ id, vendor, model, name, memory? }]. The first member is
// the chat's own agent. Plain data, no DOM, so it runs in the window and in
// node --test.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatMembers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const VENDORS = ['antigravity', 'claude', 'codex', 'grok'];
  const VENDOR_NAMES = { antigravity: 'Gemini', claude: 'Claude', codex: 'Codex', grok: 'Grok' };
  // A member's part in a chat (TM-59), carried in its prompts. Matt's own
  // flow: design and brainstorm with Codex, UI/UX with Gemini, engineering
  // with Claude, security with Smith, ops with Morpheus, and market scouting with Grok.
  const ROLES = {
    // Work passes between them as files in the chat's folder (TM-59 Batch 4).
    design: { label: 'Design', brief: "You lead design and brainstorming: shape the idea with Matt, push back on weak ideas, and write the brief to brief.md in this chat's folder (goal, users, features, what's out of scope). Then hand the screens to the UI/UX agent with @Name." },
    uiux: { label: 'UI/UX', brief: "You own the user interface and experience: design the screens from brief.md in Stitch (your StitchMCP tools). Save each screen's HTML from Stitch into this chat's folder under design/, with design/NOTES.md describing layout, colours and behaviour. Then hand it to the engineer with @Name, naming the files." },
    engineering: { label: 'Engineering', brief: "You build it: write the code in this chat's folder from brief.md and the files in design/, run it or test it, and say plainly what works and what doesn't. Keep your code, tests and any scratch files in this chat's folder. Files in design/ come from Stitch: read them as reference, never run or import them. Ask the UI/UX or design agent with @Name if something is unclear." },
    security: { label: 'Security', brief: "You are the security inquisitor and pen-tester (Agent Smith): inspect code, dependencies, and network boundaries for vulnerabilities, injection risks, and unauthorized access. Demand rigorous verification." },
    operations: { label: 'Operations', brief: "You are the operations and community manager (Morpheus): maintain high-signal coordination, evaluate player/user delight, and challenge weak ideas with disciplined strategic thinking." },
    market: { label: 'Market', brief: "You are the market and sentiment scout: track industry trends, user requests, and competitor developments, providing structured opportunity digests." }
  };
  // "New crew": one chat with all three, the designer first (it answers Matt
  // by default).
  const CREW = [{ vendor: 'codex', role: 'design' }, { vendor: 'antigravity', role: 'uiux' }, { vendor: 'claude', role: 'engineering' }];

  // Saved Agent Personas (TM-60 Batch 2): preconfigured agent brains & roles.
  const PERSONAS = {
    smith: { id: 'smith', name: 'Agent Smith', vendor: 'antigravity', role: 'security', brainFile: 'agent-smith.md', color: '#10b981' },
    morpheus: { id: 'morpheus', name: 'Morpheus', vendor: 'claude', role: 'operations', brainFile: 'morpheus.md', color: '#8b5cf6' },
    scout: { id: 'scout', name: 'Grok Scout', vendor: 'grok', role: 'market', brainFile: 'market-scout.md', color: '#94a3b8' },
    architect: { id: 'architect', name: 'Lead Architect', vendor: 'codex', role: 'design', brainFile: 'lead-architect.md', color: '#38bdf8' },
    engineer: { id: 'engineer', name: 'Claude Engineer', vendor: 'claude', role: 'engineering', brainFile: 'fullstack-engineer.md', color: '#2563eb' },
    uiux: { id: 'uiux', name: 'Stitch Prototyper', vendor: 'antigravity', role: 'uiux', brainFile: 'uiux-prototyper.md', color: '#ec4899' }
  };

  // Default names that were retired (TM-57: Antigravity is shown as Gemini,
  // the models its CLI runs).
  const RETIRED_NAMES = { antigravity: 'Antigravity' };

  // A new member for a chat that already has `members`. Its name is unique in
  // the chat (case-insensitive): the vendor's name, else the model's label,
  // else the vendor's name with a number ("Claude 2").
  // mcp (TM-60 Batch 3): ids of MCP servers picked for this member in the Builder.
  // skills: skill files ticked for it in the Builder, so an agent that was not
  // saved as a teammate still gets them (they ride in its prompt).
  // persona (TM-60 Batch 4): the id of the teammate (built-in persona or saved agent) this member was made from.
  function newMember(members, { vendor, model = null, memory = null, role = null, name = null, brain = null, brainText = null, customInstructions = null, mcp = null, skills = null, persona = null }, { vendorNames = VENDOR_NAMES, modelLabel = null } = {}) {
    if (!VENDORS.includes(vendor)) throw new Error(`Unknown vendor: ${vendor}`);
    const next = 1 + Math.max(0, ...members.map(m => /^m(\d+)$/.exec(m.id)).filter(Boolean).map(r => Number(r[1])));
    const taken = new Set(members.map(m => m.name.toLowerCase()));
    const base = vendorNames[vendor] || VENDOR_NAMES[vendor];
    let chosenName = [name, base, modelLabel].find(n => n && !taken.has(n.toLowerCase()));
    for (let k = 2; !chosenName; k++) if (!taken.has(`${name || base} ${k}`.toLowerCase())) chosenName = `${name || base} ${k}`;
    const member = { id: `m${next}`, vendor, model: model || null, name: chosenName };
    if (memory) member.memory = memory;
    if (role && ROLES[role]) member.role = role;
    if (brain) member.brain = brain;
    if (brainText) member.brainText = brainText;
    if (typeof customInstructions === 'string' && customInstructions) member.customInstructions = customInstructions;
    if (Array.isArray(mcp) && mcp.length) member.mcp = mcp.filter(id => typeof id === 'string');
    if (Array.isArray(skills) && skills.length) member.skills = skills.filter(f => typeof f === 'string');
    if (typeof persona === 'string' && persona) member.persona = persona;
    return member;
  }

  // Chats saved before TM-54 have no members: every vendor that appears in
  // them becomes one, with the vendor id as its member id so old messages
  // keep pointing at the right agent. The owner is the first agent that
  // replied (Claude if none did).
  function ensureMembers(thread, vendorNames = VENDOR_NAMES) {
    if (Array.isArray(thread.members)) return thread;
    const seen = [];
    const note = (v) => { if (VENDORS.includes(v) && !seen.includes(v)) seen.push(v); };
    const firstReply = thread.messages.find(m => VENDORS.includes(m.from));
    note(firstReply ? firstReply.from : 'claude');
    for (const m of thread.messages) {
      [m.from, m.to, m.relayOf, m.handoff && m.handoff.from, m.handoff && m.handoff.to].forEach(note);
    }
    thread.members = seen.map(v => ({ id: v, vendor: v, model: null, name: vendorNames[v] || VENDOR_NAMES[v] }));
    return thread;
  }

  // Members still called by a retired default name ("Antigravity",
  // "Antigravity 2") take the vendor's current name, unless it is taken in
  // the chat. Nothing is written until the chat is next saved.
  function renameRetired(thread, vendorNames = VENDOR_NAMES) {
    const members = thread.members || [];
    for (const m of members) {
      const old = RETIRED_NAMES[m.vendor];
      const r = old && new RegExp(`^${old}( \\d+)?$`).exec(m.name);
      if (!r) continue;
      const name = (vendorNames[m.vendor] || VENDOR_NAMES[m.vendor]) + (r[1] || '');
      if (!members.some(o => o.name.toLowerCase() === name.toLowerCase())) m.name = name;
    }
    return thread;
  }

  function memberById(thread, id) {
    return (thread.members || []).find(m => m.id === id) || null;
  }

  return { VENDORS, VENDOR_NAMES, ROLES, CREW, PERSONAS, newMember, ensureMembers, renameRetired, memberById };
});
