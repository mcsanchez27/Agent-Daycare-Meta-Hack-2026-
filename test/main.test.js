const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// Intercept requires using Module._load
const originalLoad = Module._load;

const electronMock = {
  app: {
    isPackaged: false,
    getPath: (p) => `/mock/path/${p}`,
    getVersion: () => '1.0.0',
    whenReady: async () => {},
    on: () => {},
    quit: () => {}
  },
  BrowserWindow: class {
    constructor() {}
    loadFile() {}
    on() {}
    webContents = {
      on: () => {},
      send: () => {},
      setWindowOpenHandler: () => {},
      getURL: () => ''
    }
    static getAllWindows = () => []
  },
  ipcMain: {
    handlers: {},
    listeners: {},
    handle(channel, fn) { this.handlers[channel] = fn; },
    on(channel, fn) { this.listeners[channel] = fn; },
    emit(channel, ...args) { return this.listeners[channel](...args); },
    async invoke(channel, ...args) { return this.handlers[channel]({}, ...args); }
  },
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
  },
  shell: {
    openPath: async () => null
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: ['/mock/selected/path'] })
  },
  Menu: {
    template: null,
    buildFromTemplate(t) { this.template = t; return t; },
    setApplicationMenu() {}
  }
};

const agentRunnerMock = class {
  constructor() { this.started = false; }
  run() { this.started = true; return true; }
  stop() {}
  listModels() { return {}; }
  getConfigs() { return []; }
  applyConfig() {}
  shutdown() {}
};

const loggerMock = class {
  constructor() {}
  info() {}
  warn() {}
  error() {}
  exception() {}
  open() {}
  close() { return Promise.resolve(); }
  log() {}
};

const configMock = {
  load: () => ({ config: { some: 'config' }, created: false, error: null }),
  save: () => ({ some: 'config' })
};

const mocks = {
  'electron': electronMock,
  [path.resolve(__dirname, '../src/agent-runner')]: agentRunnerMock,
  [path.resolve(__dirname, '../src/logger')]: { Logger: loggerMock },
  [path.resolve(__dirname, '../src/config')]: configMock
};

Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return mocks['electron'];
  }

  if (request.startsWith('.')) {
    const resolvedPath = path.resolve(path.dirname(parent.filename), request);
    // Exact match for the mocked files (without extension)
    if (mocks[resolvedPath]) {
      return mocks[resolvedPath];
    }
    // Also try matching with .js extension since require() might resolve it
    if (mocks[resolvedPath.replace(/\.js$/, '')]) {
      return mocks[resolvedPath.replace(/\.js$/, '')];
    }
  }

  return originalLoad.call(this, request, parent, isMain);
};

test('main.js tests', async (t) => {
  // Clear any existing cache for main.js so it gets executed fresh
  const mainPath = require.resolve('../src/main');
  delete require.cache[mainPath];

  require('../src/main');

  await t.test('ipc handlers are registered', () => {
    assert.ok(electronMock.ipcMain.handlers['agent:run']);
    assert.ok(electronMock.ipcMain.handlers['config:get']);
    assert.ok(electronMock.ipcMain.handlers['brains:list']);
    assert.ok(electronMock.ipcMain.handlers['brains:get-central']);
    assert.ok(electronMock.ipcMain.handlers['brains:resolve']);
    assert.ok(electronMock.ipcMain.handlers['brains:save-central']);
    assert.ok(electronMock.ipcMain.handlers['brains:save-persona']);
    assert.ok(electronMock.ipcMain.handlers['brains:create-persona']);
    assert.ok(electronMock.ipcMain.handlers['skills:list']);
    assert.ok(electronMock.ipcMain.handlers['skills:save']);
    assert.ok(electronMock.ipcMain.handlers['skills:create']);
    assert.ok(electronMock.ipcMain.handlers['mcp:list']);
    assert.ok(electronMock.ipcMain.handlers['mcp:save']);
    // Dashboard-era channels are gone in V1
    for (const ch of ['hooks:status', 'hooks:install', 'agent:update-role', 'agent:forward', 'agent:start', 'agent:send-input']) {
      assert.equal(electronMock.ipcMain.handlers[ch], undefined, ch);
    }
  });

  await t.test('agent:run invokes AgentRunner.run', async () => {
    const result = await electronMock.ipcMain.invoke('agent:run', { runKey: 'c/m1', vendor: 'claude', model: null, prompt: 'hello' });
    assert.equal(result, true);
  });

  await t.test('config:pick-folder invokes dialog.showOpenDialog', async () => {
    const result = await electronMock.ipcMain.invoke('config:pick-folder', { current: '/some/path' });
    assert.equal(result, '/mock/selected/path');
  });

  // Restore Module._load
  Module._load = originalLoad;
});
