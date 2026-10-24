// A chat's agents (TM-54). Each chat holds its own members in
// thread.members: [{ id, vendor, model, name, memory? }]. The first member is
// the chat's own agent. Plain data, no DOM, so it runs in the window and in
// node --test.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatMembers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const VENDORS = ['antigravity', 'claude', 'codex'];
  const VENDOR_NAMES = { antigravity: 'Gemini', claude: 'Claude', codex: 'Codex' };
  // A member's part in a chat (TM-59), carried in its prompts. Matt's own
  // flow: design and brainstorm with Codex, UI/UX with Gemini, engineering
  // with Claude.
  const ROLES = {
    // Work passes between them as files in the chat's folder (TM-59 Batch 4).
    design: { label: 'Design', brief: "You lead design and brainstorming: shape the idea with Matt, push back on weak ideas, and write the brief to brief.md in this chat's folder (goal, users, features, what's out of scope). Then hand the screens to the UI/UX agent with @Name." },
    uiux: { label: 'UI/UX', brief: "You own the user interface and experience: design the screens from brief.md in Stitch (your StitchMCP tools). Save each screen's HTML from Stitch into this chat's folder under design/, with design/NOTES.md describing layout, colours and behaviour. Then hand it to the engineer with @Name, naming the files." },
    engineering: { label: 'Engineering', brief: "You build it: write the code in this chat's folder from brief.md and the files in design/, run it or test it, and say plainly what works and what doesn't. Keep your code, tests and any scratch files in this chat's folder. Files in design/ come from Stitch: read them as reference, never run or import them. Ask the UI/UX or design agent with @Name if something is unclear." }
  };
  // "New crew": one chat with all three, the designer first (it answers Matt
  // by default).
  const CREW = [{ vendor: 'codex', role: 'design' }, { vendor: 'antigravity', role: 'uiux' }, { vendor: 'claude', role: 'engineering' }];

  // Default names that were retired (TM-57: Antigravity is shown as Gemini,
  // the models its CLI runs).
  const RETIRED_NAMES = { antigravity: 'Antigravity' };

  // A new member for a chat that already has `members`. Its name is unique in
  // the chat (case-insensitive): the vendor's name, else the model's label,
  // else the vendor's name with a number ("Claude 2").
  function newMember(members, { vendor, model = null, memory = null, role = null }, { vendorNames = VENDOR_NAMES, modelLabel = null } = {}) {
    if (!VENDORS.includes(vendor)) throw new Error(`Unknown vendor: ${vendor}`);
    const next = 1 + Math.max(0, ...members.map(m => /^m(\d+)$/.exec(m.id)).filter(Boolean).map(r => Number(r[1])));
    const taken = new Set(members.map(m => m.name.toLowerCase()));
    const base = vendorNames[vendor] || VENDOR_NAMES[vendor];
    let name = [base, modelLabel].find(n => n && !taken.has(n.toLowerCase()));
    for (let k = 2; !name; k++) if (!taken.has(`${base} ${k}`.toLowerCase())) name = `${base} ${k}`;
    const member = { id: `m${next}`, vendor, model: model || null, name };
    if (memory) member.memory = memory;
    if (role && ROLES[role]) member.role = role;
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

  return { VENDORS, VENDOR_NAMES, ROLES, CREW, newMember, ensureMembers, renameRetired, memberById };
});
