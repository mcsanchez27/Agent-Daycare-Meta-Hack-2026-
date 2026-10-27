// Project rosters and chat scope are plain data, shared with the main process.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./members'));
  else root.ChatProjects = factory(root.ChatMembers);
})(typeof self !== 'undefined' ? self : this, function ({ CREW, newMember }) {
  const PROJECT_ID = /^[a-z0-9-]{1,64}$/;
  function seedMembers(roster) {
    if (!Array.isArray(roster) || !roster.length || roster.length > 20) throw new Error('Choose a roster of 1–20 agents');
    const members = [];
    for (const m of roster) {
      if (!m || typeof m !== 'object') throw new Error('Invalid roster member');
      const { vendor, model, name, role, brain, brainText, customInstructions, mcp, skills, persona } = m;
      if (name != null && (typeof name !== 'string' || !name.trim())) throw new Error('Invalid member name');
      members.push(newMember(members, { vendor, model, name, role, brain, brainText, customInstructions, mcp, skills, persona }));
    }
    return members;
  }
  function rosterFrom(selection, available) {
    if (selection && selection.kind === 'crew') return seedMembers(CREW);
    if (!selection || selection.kind !== 'teammates' || !Array.isArray(selection.ids) || !selection.ids.length) throw new Error('Choose a crew or teammates');
    const ids = [...new Set(selection.ids)];
    return seedMembers(ids.map(id => {
      const p = available.find(p => p.id === id);
      if (!p) throw new Error('A selected teammate is no longer available');
      return { vendor: p.vendor, model: p.model, name: p.name, role: p.role, brain: p.brainFile,
        brainText: p.brainText, customInstructions: p.customInstructions, mcp: p.mcp, skills: p.skills, persona: p.id };
    }));
  }
  function projectOf(chat, projects) { return projects.find(p => p.id === (chat && chat.projectId)) || null; }
  function scopedChats(chat, chats, projects) {
    const id = projectOf(chat, projects)?.id || null;
    return chats.filter(c => c.id !== chat?.id && (projectOf(c, projects)?.id || null) === id);
  }
  function projectGroups(chats, projects) {
    return [...projects.map(project => ({ project, chats: chats.filter(c => c.projectId === project.id) })),
      { project: null, chats: chats.filter(c => !projectOf(c, projects)) }];
  }
  return { PROJECT_ID, seedMembers, rosterFrom, projectOf, scopedChats, projectGroups };
});
