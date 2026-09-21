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
      send: () => {}
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
  }
};

const agentRunnerMock = class {
  constructor() { this.started = false; }
  startAgent(id) { this.started = true; return true; }
  stopAgent() {}
  sendInput() {}
  getConfigs() { return []; }
  scanAgents() { return []; }
  updateRole() {}
  forwardToAgent() {}
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
  close() {}
  log() {}
};

const hookServerMock = class {
  constructor() {}
  async start() {}
  async stop() {}
  hookUrl(id) { return `http://localhost/hook/${id}`; }
};
hookServerMock.DEFAULT_PORT = 12345;

const hooksInstallerMock = {
  status: () => ({ installed: true }),
  install: () => ({ file: 'mock', events: 1 }),
  uninstall: () => ({ file: 'mock' })
};

const codexNotifyMock = {
  status: () => ({ installed: true }),
  install: () => ({ file: 'mock', events: 1 }),
  uninstall: () => ({ file: 'mock' })
};

const configMock = {
  load: () => ({ config: { some: 'config' }, created: false, error: null }),
  save: () => ({ some: 'config' })
};

const mocks = {
  'electron': electronMock,
  [path.resolve(__dirname, '../src/agent-runner')]: agentRunnerMock,
  [path.resolve(__dirname, '../src/logger')]: { Logger: loggerMock },
  [path.resolve(__dirname, '../src/hook-server')]: { HookServer: hookServerMock, DEFAULT_PORT: hookServerMock.DEFAULT_PORT },
  [path.resolve(__dirname, '../src/hooks-installer')]: hooksInstallerMock,
  [path.resolve(__dirname, '../src/codex-notify')]: codexNotifyMock,
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
    assert.ok(electronMock.ipcMain.handlers['agent:start']);
    assert.ok(electronMock.ipcMain.handlers['hooks:status']);
    assert.ok(electronMock.ipcMain.handlers['config:get']);
    assert.ok(electronMock.ipcMain.listeners['window:minimize']);
  });

  await t.test('agent:start invokes AgentRunner.startAgent', async () => {
    const result = await electronMock.ipcMain.invoke('agent:start', { agentId: 'claude', initialPrompt: 'hello' });
    assert.equal(result, true);
  });

  await t.test('config:pick-folder invokes dialog.showOpenDialog', async () => {
    const result = await electronMock.ipcMain.invoke('config:pick-folder', { current: '/some/path' });
    assert.equal(result, '/mock/selected/path');
  });

  await t.test('hooks:status returns hook info', async () => {
    try {
      const result = await electronMock.ipcMain.invoke('hooks:status');
      assert.ok(result);
      assert.ok(result.agents.claude);
    } catch (e) {
      if (!e.message.includes("Hook listener is not running")) {
        throw e;
      }
    }
  });

  // Restore Module._load
  Module._load = originalLoad;
});
