const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const AgentRunner = require('./agent-runner');

let mainWindow = null;
let agentRunner = null;

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

  agentRunner = new AgentRunner(mainWindow);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers
ipcMain.handle('agent:start', async (_, { agentId, initialPrompt }) => {
  return agentRunner.startAgent(agentId, initialPrompt);
});

ipcMain.handle('agent:stop', async (_, { agentId }) => {
  return agentRunner.stopAgent(agentId);
});

ipcMain.handle('agent:send-input', async (_, { agentId, input }) => {
  return agentRunner.sendInput(agentId, input);
});

ipcMain.handle('agent:get-configs', async () => {
  return agentRunner.getConfigs();
});

ipcMain.handle('agent:scan', async () => {
  return agentRunner.scanAgents();
});

ipcMain.handle('agent:update-role', async (_, { agentId, role, title }) => {
  return agentRunner.updateRole(agentId, role, title);
});

ipcMain.handle('agent:forward', async (_, { fromAgentId, toAgentId, text }) => {
  return agentRunner.forwardToAgent(fromAgentId, toAgentId, text);
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
