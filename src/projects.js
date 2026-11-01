const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROJECT_ID, seedMembers } = require('./renderer/projects');
const queues = new Map();

function projectName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\r\n\x00-\x1f]/.test(value)) throw new Error('Project name must be 1–80 characters on one line');
  return value.trim();
}
async function list(file) {
  let raw;
  try { raw = await fs.promises.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('projects.json must contain a project list');
  const ids = new Set(), names = new Set();
  return data.map(p => {
    if (!p || !PROJECT_ID.test(p.id) || ids.has(p.id)) throw new Error('Invalid or duplicate project ID');
    const name = projectName(p.name);
    if (names.has(name.toLowerCase())) throw new Error('Duplicate project name');
    ids.add(p.id); names.add(name.toLowerCase());
    return { id: p.id, name, members: seedMembers(p.members), createdAt: p.createdAt };
  });
}
function mutate(file, change) {
  const task = async () => {
    const projects = await list(file);
    const result = change(projects);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(projects, null, 2) + '\n', 'utf8');
    await fs.promises.rename(`${file}.tmp`, file);
    return result;
  };
  const next = (queues.get(file) || Promise.resolve()).catch(() => {}).then(task);
  queues.set(file, next);
  next.finally(() => { if (queues.get(file) === next) queues.delete(file); }).catch(() => {});
  return next;
}
function unique(projects, name, id) {
  if (projects.some(p => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw new Error('A project with that name already exists');
}
function create(file, { name, members }) {
  return mutate(file, projects => {
    name = projectName(name); unique(projects, name);
    const p = { id: randomUUID(), name, members: seedMembers(members), createdAt: new Date().toISOString() };
    projects.push(p); return p;
  });
}
function update(file, { id, name, members }) {
  return mutate(file, projects => {
    const p = projects.find(p => p.id === id);
    if (!p) throw new Error('Project not found');
    if (name !== undefined) { name = projectName(name); unique(projects, name, id); p.name = name; }
    if (members !== undefined) p.members = seedMembers(members);
    return p;
  });
}
function remove(file, { id }) {
  return mutate(file, projects => {
    const index = projects.findIndex(p => p.id === id);
    if (index < 0) throw new Error('Project not found');
    projects.splice(index, 1);
    return { id };
  });
}
module.exports = { list, create, update, remove };