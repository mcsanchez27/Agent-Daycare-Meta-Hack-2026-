const { app, BrowserWindow, ipcMain, screen, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const AgentRunner = require('./agent-runner');
const { Logger } = require('./logger');
const userConfig = require('./config');
const chats = require('./chats');
const cliMcp = require('./cli-mcp');
const { spellMenu } = require('./spellcheck');

let mainWindow = null;
let agentRunner = null;

// While developing (npm start) the log lives in the project folder so an agent
// working in this repo can find it at logs/latest.log. A packaged build can't
// write next to its own files, so it uses the OS log folder instead.
const logsDir = app.isPackaged
  ? app.getPath('logs')
  : path.join(__dirname, '..', 'logs');
const configFile = app.isPackaged
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(__dirname, '..', 'config.json');
// Saved chats live next to config.json while developing, like the logs.
const chatsDir = app.isPackaged
  ? path.join(app.getPath('userData'), 'chats')
  : path.join(__dirname, '..', 'chats');
let config = null; // loaded in whenReady, after the logger is open

const logger = new Logger({
  dir: logsDir,
  onError: (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:notice', { text: `Logging stopped: ${err.message}` });
    }
  }
});

// Anything that would otherwise crash silently in the main process goes to the log.
process.on('uncaughtException', (err) => {
  logger.exception('app', err, { phase: 'uncaughtException' });
  console.error(err);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.exception('app', err, { phase: 'unhandledRejection' });
});

function createWindow() {
  const displays = screen.getAllDisplays();
  
  // Choose second display if available, otherwise primary
  const targetDisplay = displays.length > 1 ? displays[1] : displays[0];
  const { x, y, width, height } = targetDisplay.bounds;

  mainWindow = new BrowserWindow({
    width: Math.min(1280, Math.floor(width * 0.85)),
    height: Math.min(820, Math.floor(height * 0.85)),
    x: x + 50,
    y: y + 50,
    minWidth: 850,
    minHeight: 600,
    backgroundColor: '#0f111a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // One runner for the life of the app; re-point it if the window is recreated (macOS).
  if (!agentRunner) {
    agentRunner = new AgentRunner(mainWindow, logger, config);
  } else {
    agentRunner.mainWindow = mainWindow;
  }

  // Capture warnings/errors the renderer prints to its DevTools console.
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // Electron 35+ moves these onto the event object; support both shapes.
    const lvl = typeof level === 'number' ? level : event.level;
    const msg = typeof message === 'string' ? message : event.message;
    const ln = typeof line === 'number' ? line : event.lineNumber;
    const src = typeof sourceId === 'string' ? sourceId : event.sourceId;
    const isNumeric = typeof lvl === 'number';
    const isWarn = isNumeric ? lvl === 2 : lvl === 'warning';
    const isError = isNumeric ? lvl === 3 : lvl === 'error';
    if (isError) logger.error('renderer', msg, { file: src, line: ln });
    else if (isWarn) logger.warn('renderer', msg, { file: src, line: ln });
  });

  // Right-click: spelling fixes, Add to dictionary, Cut/Copy/Paste.
  mainWindow.webContents.on('context-menu', (_, params) => {
    const template = spellMenu(params);
    if (!template) return;
    const wc = mainWindow.webContents;
    Menu.buildFromTemplate(template.map(({ action, ...item }) => {
      if (action && action.replace) item.click = () => wc.replaceMisspelling(action.replace);
      if (action && action.addWord) item.click = () => wc.session.addWordToSpellCheckerDictionary(action.addWord);
      return item;
    })).popup({ window: mainWindow });
  });

  mainWindow.webContents.on('render-process-gone', (_, details) => {
    logger.error('renderer', 'renderer process gone', { reason: details.reason, exitCode: details.exitCode });
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links and window.open from the page (the preview's ↗, Notion links) go to
  // the system browser, never to a new window that carries this app's bridge
  // (TM-60 review): a page an agent wrote must not get window.api.
  // Only http(s) links, or .html files inside the agents' working folder,
  // ever open; any other scheme (ms-settings:, file: to an .exe) is dropped.
  const openOutside = (url) => {
    let u;
    try { u = new URL(url); } catch (_) { return logger.warn('app', 'blocked link', { url }); }
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return shell.openExternal(url).catch((err) => logger.warn('app', 'could not open link', { url, error: err.message }));
    }
    if (u.protocol === 'file:') {
      const file = path.resolve(decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
      const root = config ? path.resolve(config.workingDir) + path.sep : null;
      if (root && file.startsWith(root) && /\.html?$/i.test(file)) return shell.openPath(file);
    }
    logger.warn('app', 'blocked link', { url });
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    openOutside(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  logger.info('app', 'window created', { display: targetDisplay.id, bounds: targetDisplay.bounds });
}

// IPC handlers: any error inside a handler is logged before it reaches the renderer.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return await fn(payload || {});
    } catch (err) {
      logger.exception('app', err, { ipc: channel, payload });
      throw err;
    }
  });
}

// One run per chat member (TM-54): { runKey, vendor, model, prompt }.
handle('agent:run', (req) => agentRunner.run(req));
handle('agent:stop', ({ runKey }) => agentRunner.stop(runKey));
handle('agent:models', () => agentRunner.listModels());
handle('agent:get-configs', () => agentRunner.getConfigs());
handle('agent:scan', () => agentRunner.scanAgents());

// Renderer-side logging (window.onerror, unhandled promise rejections, explicit calls)
ipcMain.on('log:write', (_, { level, message, data } = {}) => {
  logger.log(['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info', 'renderer', String(message), data);
});

// User settings (executable paths, working folder)
handle('config:get', () => ({ file: configFile, config }));

handle('config:save', async ({ config: incoming }) => {
  config = await userConfig.save(configFile, incoming);
  await userConfig.ensureWorkingDir(config.workingDir);
  agentRunner.applyConfig(config);
  logger.info('app', 'config saved', { file: configFile });
  return { file: configFile, config };
});

handle('config:pick-folder', async ({ current }) => {
  const r = await dialog.showOpenDialog(mainWindow, { title: 'Choose the folder agents work in', defaultPath: current || undefined, properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

handle('config:pick-file', async ({ current, title }) => {
  const r = await dialog.showOpenDialog(mainWindow, { title: title || 'Choose the agent executable', defaultPath: current || undefined, properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

const brainsDir = path.join(__dirname, '..', 'brains');
handle('brains:list', async () => {
  try {
    const files = await fs.promises.readdir(brainsDir);
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'central-brain.md');
    const list = await Promise.all(mdFiles.map(async (file) => {
      const text = await fs.promises.readFile(path.join(brainsDir, file), 'utf8');
      const titleMatch = /^#\s*(.+)$/m.exec(text);
      return { file, title: titleMatch ? titleMatch[1] : file, text };
    }));
    return list;
  } catch (_) {
    return [];
  }
});

handle('brains:get-central', async () => {
  try {
    const centralFile = path.join(brainsDir, 'central-brain.md');
    const stat = await fs.promises.stat(centralFile);
    const text = await fs.promises.readFile(centralFile, 'utf8');
    return { file: 'central-brain.md', text, mtime: stat.mtimeMs };
  } catch (_) {
    return null;
  }
});

handle('brains:resolve', async ({ personaFile } = {}) => {
  let central = null;
  let persona = null;
  try {
    const centralFile = path.join(brainsDir, 'central-brain.md');
    const stat = await fs.promises.stat(centralFile);
    const text = await fs.promises.readFile(centralFile, 'utf8');
    central = { file: 'central-brain.md', text, mtime: stat.mtimeMs };
  } catch (_) {}

  if (personaFile) {
    try {
      const clean = path.basename(personaFile);
      const personaPath = path.join(brainsDir, clean);
      const stat = await fs.promises.stat(personaPath);
      const text = await fs.promises.readFile(personaPath, 'utf8');
      persona = { file: clean, text, mtime: stat.mtimeMs };
    } catch (_) {}
  }

  return { central, persona };
});

handle('brains:save-central', async ({ text }) => {
  const centralFile = path.join(brainsDir, 'central-brain.md');
  await fs.promises.writeFile(centralFile, text, 'utf8');
  const stat = await fs.promises.stat(centralFile);
  logger.info('app', 'central brain updated', { mtime: stat.mtimeMs });
  return { file: 'central-brain.md', text, mtime: stat.mtimeMs };
});

handle('brains:save-persona', async ({ file, text }) => {
  const clean = path.basename(file);
  if (!clean.endsWith('.md')) throw new Error('Persona file must be a .md file');
  const personaFile = path.join(brainsDir, clean);
  await fs.promises.writeFile(personaFile, text, 'utf8');
  const stat = await fs.promises.stat(personaFile);
  logger.info('app', 'persona chip updated', { file: clean, mtime: stat.mtimeMs });
  return { file: clean, text, mtime: stat.mtimeMs };
});

handle('brains:create-persona', async ({ name, text }) => {
  let slug = (name || 'custom-persona').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) slug = 'custom-persona';
  let fileName = `${slug}.md`;
  let counter = 1;
  while (await fs.promises.access(path.join(brainsDir, fileName)).then(() => true).catch(() => false)) {
    fileName = `${slug}-${++counter}.md`;
  }
  const fullPath = path.join(brainsDir, fileName);
  const initialText = text || `# Role: ${name}\n\nCustom directives for ${name}.`;
  await fs.promises.writeFile(fullPath, initialText, 'utf8');
  const stat = await fs.promises.stat(fullPath);
  logger.info('app', 'persona chip created', { file: fileName, mtime: stat.mtimeMs });
  return { file: fileName, text: initialText, mtime: stat.mtimeMs };
});

const skillsDir = path.join(__dirname, '..', 'skills');
handle('skills:list', async () => {
  try {
    if (!await fs.promises.access(skillsDir).then(() => true).catch(() => false)) return [];
    const files = await fs.promises.readdir(skillsDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    const list = await Promise.all(mdFiles.map(async (file) => {
      const text = await fs.promises.readFile(path.join(skillsDir, file), 'utf8');
      const titleMatch = /^#\s*(.+)$/m.exec(text);
      return { file, title: titleMatch ? titleMatch[1] : file, text };
    }));
    return list;
  } catch (_) {
    return [];
  }
});

handle('skills:save', async ({ file, text }) => {
  const clean = path.basename(file);
  if (!clean.endsWith('.md')) throw new Error('Skill file must be a .md file');
  const skillFile = path.join(skillsDir, clean);
  await fs.promises.mkdir(skillsDir, { recursive: true });
  await fs.promises.writeFile(skillFile, text, 'utf8');
  return { file: clean, text };
});

handle('skills:create', async ({ name, text }) => {
  let slug = (name || 'custom-skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) slug = 'custom-skill';
  let fileName = `${slug}.md`;
  let counter = 1;
  await fs.promises.mkdir(skillsDir, { recursive: true });
  while (await fs.promises.access(path.join(skillsDir, fileName)).then(() => true).catch(() => false)) {
    fileName = `${slug}-${++counter}.md`;
  }
  const fullPath = path.join(skillsDir, fileName);
  const initialText = text || `# ${name}\n\nSkill playbook and directives.`;
  await fs.promises.writeFile(fullPath, initialText, 'utf8');
  return { file: fileName, text: initialText };
});

// The MCP directory (TM-60 Batch 3): the servers Daycare knows, beside
// config.json and git-ignored, since entries may carry commands and keys.
// Each is { id, name, description, command, args, env } or { ..., url, headers }.
const mcpFile = path.join(path.dirname(configFile), 'mcp-servers.json');
const SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
function cleanServer(s) {
  if (!s || typeof s !== 'object') return null;
  const name = str(s.name, 60);
  const id = str(s.id, 40).toLowerCase() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!name || !SERVER_ID.test(id)) return null;
  const out = { id, name, description: str(s.description, 300) };
  const url = str(s.url, 500);
  if (/^https?:\/\//.test(url)) {
    out.url = url;
    const headers = {};
    for (const [k, v] of Object.entries(s.headers && typeof s.headers === 'object' ? s.headers : {})) if (/^[\w-]{1,60}$/.test(k) && typeof v === 'string') headers[k] = v.slice(0, 500);
    if (Object.keys(headers).length) out.headers = headers;
  } else {
    out.command = str(s.command, 300);
    if (!out.command) return null;
    out.args = (Array.isArray(s.args) ? s.args : []).filter(a => typeof a === 'string').slice(0, 40).map(a => a.slice(0, 500));
    const env = {};
    for (const [k, v] of Object.entries(s.env && typeof s.env === 'object' ? s.env : {})) if (/^[A-Z0-9_]{1,60}$/.test(k) && typeof v === 'string') env[k] = v.slice(0, 500);
    if (Object.keys(env).length) out.env = env;
  }
  return out;
}
async function readServers() {
  try {
    const list = JSON.parse(await fs.promises.readFile(mcpFile, 'utf8'));
    return (Array.isArray(list) ? list : []).map(cleanServer).filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('app', 'mcp-servers.json could not be read', { file: mcpFile, error: err.message });
    return [];
  }
}
async function writeServers(list) {
  // Owner-only where the OS honours it (macOS, Linux); on Windows the file
  // sits in Matt's own profile under its normal per-user access, like
  // config.json. Keys would be safer in the OS keychain: a Batcave job.
  await fs.promises.writeFile(mcpFile, JSON.stringify(list, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return list;
}
handle('mcp:list', () => readServers());
handle('mcp:save', async ({ server }) => {
  const clean = cleanServer(server);
  if (!clean) throw new Error('A server needs a name and a command or an http(s) URL');
  const list = (await readServers()).filter(s => s.id !== clean.id);
  list.push(clean);
  logger.info('app', 'mcp server saved', { id: clean.id });
  return writeServers(list);
});
handle('mcp:remove', async ({ id }) => {
  const list = (await readServers()).filter(s => s.id !== id);
  logger.info('app', 'mcp server removed', { id });
  return writeServers(list);
});
// What Gemini, Codex and Grok already have, from their own `mcp list`;
// cached briefly since each call runs three CLIs.
let cliMcpCache = null;
handle('mcp:cli-lists', async ({ fresh = false } = {}) => {
  if (!fresh && cliMcpCache && Date.now() - cliMcpCache.at < 60000) return cliMcpCache.lists;
  const lists = await cliMcp.readCliMcpLists();
  cliMcpCache = { at: Date.now(), lists };
  return lists;
});

// Org Control assignments (TM-60 Batch 2): which skills each engine and
// saved persona gets. Beside config.json, git-ignored; created on first save.
const orgFile = path.join(path.dirname(configFile), 'org.json');
const SKILL_FILE = /^[\w.-]+\.md$/;
const PERSONA_ID = /^[a-z0-9-]{1,32}$/;
function cleanAssignment(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    all: a.all === true,
    engines: (Array.isArray(a.engines) ? a.engines : []).filter(v => userConfig.AGENT_IDS.includes(v)),
    personas: (Array.isArray(a.personas) ? a.personas : []).filter(p => typeof p === 'string' && PERSONA_ID.test(p))
  };
}
// skills are keyed by file, MCP servers (Batch 3) by server id.
function cleanOrg(org) {
  const clean = { skills: {}, mcp: {} };
  for (const [file, a] of Object.entries((org && org.skills) || {})) {
    const c = SKILL_FILE.test(file) && cleanAssignment(a);
    if (c) clean.skills[file] = c;
  }
  for (const [id, a] of Object.entries((org && org.mcp) || {})) {
    const c = SERVER_ID.test(id) && cleanAssignment(a);
    if (c) clean.mcp[id] = c;
  }
  // Saved teammates from the Agent Builder (Batch 4).
  clean.agents = [];
  for (const a of Array.isArray(org && org.agents) ? org.agents : []) {
    if (!a || typeof a !== 'object') continue;
    const id = str(a.id, 32).toLowerCase();
    const name = str(a.name, 40);
    if (!PERSONA_ID.test(id) || !name || !userConfig.AGENT_IDS.includes(a.vendor)) continue;
    const brainFile = str(a.brainFile, 80);
    const model = str(a.model, 64);
    clean.agents.push({
      id, name, vendor: a.vendor, model: AgentRunner.MODEL_TEXT.test(model) ? model : null, role: str(a.role, 20),
      brainFile: SKILL_FILE.test(brainFile) ? brainFile : '',
      mcp: (Array.isArray(a.mcp) ? a.mcp : []).filter(x => typeof x === 'string' && SERVER_ID.test(x)),
      skills: (Array.isArray(a.skills) ? a.skills : []).filter(x => typeof x === 'string' && SKILL_FILE.test(x))
    });
  }
  return clean;
}
handle('org:get', async () => {
  try {
    return cleanOrg(JSON.parse(await fs.promises.readFile(orgFile, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('app', 'org.json could not be read', { file: orgFile, error: err.message });
    return { skills: {}, mcp: {}, agents: [] };
  }
});
handle('org:save', async ({ org }) => {
  const clean = cleanOrg(org);
  await fs.promises.writeFile(orgFile, JSON.stringify(clean, null, 2) + '\n');
  logger.info('app', 'org assignments saved', { skills: Object.keys(clean.skills).length });
  return clean;
});

// Saved chats (TM-53 Batch 2)
handle('chats:list', async () => {
  const r = await chats.list(chatsDir);
  for (const p of r.problems) logger.warn('app', 'chat file could not be read', { dir: chatsDir, ...p });
  return r;
});
handle('chats:load', ({ id }) => chats.load(chatsDir, id));
// While "Delete all chats" runs, saves from the old window are dropped, so a
// reply finishing mid-delete can't bring a chat back.
let chatsLocked = false;
handle('chats:save', ({ chat }) => (chatsLocked ? null : chats.save(chatsDir, chat)));

// Debug menu (TM-57). Add items here as they earn a place.
async function deleteAllChats() {
  const { chats: list } = await chats.list(chatsDir);
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Delete all', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete all ${list.length} chats?`,
    detail: `This deletes every chat file in ${chatsDir}, and stops any agent that is answering. It can't be undone.`
  });
  if (response !== 0) return;
  chatsLocked = true;
  try {
    if (agentRunner) agentRunner.shutdown();
    const count = await chats.removeAll(chatsDir);
    logger.info('app', 'all chats deleted', { dir: chatsDir, count });
  } catch (err) {
    logger.exception('app', err, { action: 'delete all chats' });
    dialog.showErrorBox('Delete all chats', `Not every chat could be deleted: ${err.message}`);
  }
  mainWindow.webContents.once('did-finish-load', () => { chatsLocked = false; });
  mainWindow.webContents.reload();
}

function setMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Debug', submenu: [{ label: 'Delete all chats…', click: () => deleteAllChats() }] }
  ]));
}

handle('logs:open-folder', async () => {
  const result = await shell.openPath(logsDir);
  if (result) logger.warn('app', 'could not open logs folder', { error: result });
  return { path: logsDir, error: result || null };
});

app.whenReady().then(async () => {
  logger.open();
  const loaded = await userConfig.load(configFile);
  config = loaded.config;
  if (loaded.error) logger.warn('app', 'config problem', { file: configFile, error: loaded.error });
  else logger.info('app', loaded.created ? 'config created with defaults' : 'config loaded', { file: configFile });
  if (loaded.migratedFrom) logger.info('app', 'working folder moved to the chat folder', { from: loaded.migratedFrom, to: config.workingDir });
  try {
    await userConfig.ensureWorkingDir(config.workingDir);
  } catch (err) {
    logger.warn('app', 'could not create working folder', { dir: config.workingDir, error: err.message });
  }
  logger.info('app', 'starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    packaged: app.isPackaged
  });

  setMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Stop child processes and flush the log before the process exits.
let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  if (agentRunner) agentRunner.shutdown();
  logger.info('app', 'quitting');
  logger.close().finally(() => app.quit());
});
