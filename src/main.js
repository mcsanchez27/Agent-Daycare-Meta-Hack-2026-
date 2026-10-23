const { app, BrowserWindow, ipcMain, screen, shell, dialog, Menu } = require('electron');
const path = require('path');
const AgentRunner = require('./agent-runner');
const { Logger } = require('./logger');
const userConfig = require('./config');
const chats = require('./chats');
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

// Saved chats (TM-53 Batch 2)
handle('chats:list', async () => {
  const r = await chats.list(chatsDir);
  for (const p of r.problems) logger.warn('app', 'chat file could not be read', { dir: chatsDir, ...p });
  return r;
});
handle('chats:load', ({ id }) => chats.load(chatsDir, id));
handle('chats:save', ({ chat }) => chats.save(chatsDir, chat));

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
