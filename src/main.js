const { app, BrowserWindow, ipcMain, screen, shell, dialog } = require('electron');
const path = require('path');
const AgentRunner = require('./agent-runner');
const { Logger } = require('./logger');
const { HookServer, DEFAULT_PORT } = require('./hook-server');
const hooksInstaller = require('./hooks-installer');
const codexNotify = require('./codex-notify');
const userConfig = require('./config');

// Which agents can report in, and how their hook gets installed.
const HOOK_INSTALLERS = { claude: hooksInstaller, codex: codexNotify };

let mainWindow = null;
let agentRunner = null;
let hookServer = null;
let hookServerError = null;

// While developing (npm start) the log lives in the project folder so an agent
// working in this repo can find it at logs/latest.log. A packaged build can't
// write next to its own files, so it uses the OS log folder instead.
const logsDir = app.isPackaged
  ? app.getPath('logs')
  : path.join(__dirname, '..', 'logs');
const configFile = app.isPackaged
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(__dirname, '..', 'config.json');
let config = null; // loaded in whenReady, after the logger is open

const logger = new Logger({
  dir: logsDir,
  onError: (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:team-message', {
        agentId: null,
        agentName: 'System',
        type: 'alert',
        text: `⚠️ Logging stopped: ${err.message}`,
        timestamp: new Date().toLocaleTimeString()
      });
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
    frame: false,
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

handle('agent:start', ({ agentId, initialPrompt }) => agentRunner.startAgent(agentId, initialPrompt));
handle('agent:stop', ({ agentId }) => agentRunner.stopAgent(agentId));
handle('agent:send-input', ({ agentId, input }) => agentRunner.sendInput(agentId, input));
handle('agent:get-configs', () => agentRunner.getConfigs());
handle('agent:scan', () => agentRunner.scanAgents());
handle('agent:update-role', ({ agentId, role, title }) => agentRunner.updateRole(agentId, role, title));
handle('agent:forward', ({ fromAgentId, toAgentId, text }) => agentRunner.forwardToAgent(fromAgentId, toAgentId, text));

// Renderer-side logging (window.onerror, unhandled promise rejections, explicit calls)
ipcMain.on('log:write', (_, { level, message, data } = {}) => {
  logger.log(['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info', 'renderer', String(message), data);
});

// Agent hooks (Claude Code reports its activity to the local HookServer)
function hookInfo() {
  const listening = !!(hookServer && hookServer.url);
  const info = { listening, url: hookServer && hookServer.url, error: hookServerError, agents: {} };
  for (const [agentId, installer] of Object.entries(HOOK_INSTALLERS)) {
    info.agents[agentId] = { ...installer.status(), hookUrl: listening ? hookServer.hookUrl(agentId) : null };
  }
  return info;
}

function installerFor(agentId) {
  const installer = HOOK_INSTALLERS[agentId];
  if (!installer) throw new Error(`Hooks are not supported for ${agentId} yet`);
  return installer;
}

handle('hooks:status', () => hookInfo());

handle('hooks:install', ({ agentId }) => {
  const installer = installerFor(agentId);
  if (!hookServer || !hookServer.url) throw new Error(`Hook listener is not running${hookServerError ? `: ${hookServerError}` : ''}`);
  const result = installer.install({ hookUrl: hookServer.hookUrl(agentId) });
  logger.info(agentId, 'installed hooks', { file: result.file, events: result.events });
  return hookInfo();
});

handle('hooks:uninstall', ({ agentId }) => {
  const result = installerFor(agentId).uninstall();
  logger.info(agentId, 'removed hooks', { file: result.file });
  return hookInfo();
});

// User settings (executable paths, working folder)
handle('config:get', () => ({ file: configFile, config }));

handle('config:save', ({ config: incoming }) => {
  config = userConfig.save(configFile, incoming);
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

handle('logs:open-folder', async () => {
  const result = await shell.openPath(logsDir);
  if (result) logger.warn('app', 'could not open logs folder', { error: result });
  return { path: logsDir, error: result || null };
});

// Window controls
ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

app.whenReady().then(() => {
  logger.open();
  const loaded = userConfig.load(configFile);
  config = loaded.config;
  if (loaded.error) logger.warn('app', 'config problem', { file: configFile, error: loaded.error });
  else logger.info('app', loaded.created ? 'config created with defaults' : 'config loaded', { file: configFile });
  logger.info('app', 'starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    packaged: app.isPackaged
  });

  createWindow();

  const port = Number(process.env.AGENT_DAYCARE_HOOK_PORT) || DEFAULT_PORT;
  hookServer = new HookServer({
    port,
    logger,
    onEvent: (agentId, event) => agentRunner.handleHookEvent(agentId, event)
  });
  hookServer.start().catch((err) => {
    hookServerError = err.code === 'EADDRINUSE'
      ? `port ${port} is already in use (set AGENT_DAYCARE_HOOK_PORT to change it)`
      : err.message;
    hookServer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:team-message', {
        agentId: null, agentName: 'System', type: 'alert',
        text: `⚠️ Agent hooks are offline: ${hookServerError}`,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  });

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
  const stopHooks = hookServer ? hookServer.stop() : Promise.resolve();
  stopHooks.then(() => logger.close()).finally(() => app.quit());
});
