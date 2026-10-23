// A chat's agents (TM-54). Each chat holds its own members in
// thread.members: [{ id, vendor, model, name, memory? }]. The first member is
// the chat's own agent. Plain data, no DOM, so it runs in the window and in
// node --test.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatMembers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const VENDORS = ['antigravity', 'claude', 'codex'];
  const VENDOR_NAMES = { antigravity: 'Antigravity', claude: 'Claude', codex: 'Codex' };

  // A new member for a chat that already has `members`. Its name is unique in
  // the chat (case-insensitive): the vendor's name, else the model's label,
  // else the vendor's name with a number ("Claude 2").
  function newMember(members, { vendor, model = null, memory = null }, { vendorNames = VENDOR_NAMES, modelLabel = null } = {}) {
    if (!VENDORS.includes(vendor)) throw new Error(`Unknown vendor: ${vendor}`);
    const next = 1 + Math.max(0, ...members.map(m => /^m(\d+)$/.exec(m.id)).filter(Boolean).map(r => Number(r[1])));
    const taken = new Set(members.map(m => m.name.toLowerCase()));
    const base = vendorNames[vendor] || VENDOR_NAMES[vendor];
    let name = [base, modelLabel].find(n => n && !taken.has(n.toLowerCase()));
    for (let k = 2; !name; k++) if (!taken.has(`${base} ${k}`.toLowerCase())) name = `${base} ${k}`;
    const member = { id: `m${next}`, vendor, model: model || null, name };
    if (memory) member.memory = memory;
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

  function memberById(thread, id) {
    return (thread.members || []).find(m => m.id === id) || null;
  }

  return { VENDORS, VENDOR_NAMES, newMember, ensureMembers, memberById };
});
