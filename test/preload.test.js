const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Intercept requires using Module._load before requiring preload
const originalLoad = Module._load;

// Mock electron
const invocations = [];
const sends = [];
const eventListeners = {};

const electronMock = {
  contextBridge: {
    exposeInMainWorld: (key, api) => {
      global.exposedKey = key;
      global.api = api;
    }
  },
  ipcRenderer: {
    invoke: (channel, data) => {
      invocations.push({ channel, data });
      return `result-${channel}`;
    },
    send: (channel, data) => {
      sends.push({ channel, data });
    },
    on: (channel, callback) => {
      eventListeners[channel] = callback;
    }
  }
};

Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return electronMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Require the preload script to execute the mock exposure
require('../src/preload.js');

test('preload exposes api object in the main world', () => {
  assert.equal(global.exposedKey, 'api');
  assert.ok(global.api);
});

test('startAgent invokes agent:start', () => {
  invocations.length = 0;
  const res = global.api.startAgent('claude', 'hello');
  assert.equal(res, 'result-agent:start');
  assert.deepEqual(invocations[0], { channel: 'agent:start', data: { agentId: 'claude', initialPrompt: 'hello' } });
});

test('stopAgent invokes agent:stop', () => {
  invocations.length = 0;
  const res = global.api.stopAgent('claude');
  assert.equal(res, 'result-agent:stop');
  assert.deepEqual(invocations[0], { channel: 'agent:stop', data: { agentId: 'claude' } });
});

test('sendInput invokes agent:send-input', () => {
  invocations.length = 0;
  const res = global.api.sendInput('claude', 'input text');
  assert.equal(res, 'result-agent:send-input');
  assert.deepEqual(invocations[0], { channel: 'agent:send-input', data: { agentId: 'claude', input: 'input text' } });
});

test('getAgentConfigs invokes agent:get-configs', () => {
  invocations.length = 0;
  const res = global.api.getAgentConfigs();
  assert.equal(res, 'result-agent:get-configs');
  assert.deepEqual(invocations[0], { channel: 'agent:get-configs', data: undefined });
});

test('scanAgents invokes agent:scan', () => {
  invocations.length = 0;
  const res = global.api.scanAgents();
  assert.equal(res, 'result-agent:scan');
  assert.deepEqual(invocations[0], { channel: 'agent:scan', data: undefined });
});

test('getConfig invokes config:get', () => {
  invocations.length = 0;
  const res = global.api.getConfig();
  assert.equal(res, 'result-config:get');
  assert.deepEqual(invocations[0], { channel: 'config:get', data: undefined });
});

test('saveConfig invokes config:save', () => {
  invocations.length = 0;
  const res = global.api.saveConfig({ test: 'config' });
  assert.equal(res, 'result-config:save');
  assert.deepEqual(invocations[0], { channel: 'config:save', data: { config: { test: 'config' } } });
});

test('pickFolder invokes config:pick-folder', () => {
  invocations.length = 0;
  const res = global.api.pickFolder('/current/path');
  assert.equal(res, 'result-config:pick-folder');
  assert.deepEqual(invocations[0], { channel: 'config:pick-folder', data: { current: '/current/path' } });
});

test('pickFile invokes config:pick-file', () => {
  invocations.length = 0;
  const res = global.api.pickFile('/current/path', 'Title');
  assert.equal(res, 'result-config:pick-file');
  assert.deepEqual(invocations[0], { channel: 'config:pick-file', data: { current: '/current/path', title: 'Title' } });
});

test('openLogsFolder invokes logs:open-folder', () => {
  invocations.length = 0;
  const res = global.api.openLogsFolder();
  assert.equal(res, 'result-logs:open-folder');
  assert.deepEqual(invocations[0], { channel: 'logs:open-folder', data: undefined });
});

// IPC Sends
test('log sends log:write', () => {
  sends.length = 0;
  global.api.log('info', 'msg', { extra: 'data' });
  assert.deepEqual(sends[0], { channel: 'log:write', data: { level: 'info', message: 'msg', data: { extra: 'data' } } });
});

test('onAgentOutput registers listener and passes data', () => {
  let cbData = null;
  global.api.onAgentOutput((data) => { cbData = data; });
  assert.ok(eventListeners['agent:output']);

  // Simulate the event from main process
  eventListeners['agent:output']({}, 'output-data');
  assert.equal(cbData, 'output-data');
});

test('onAgentStatus registers listener and passes data', () => {
  let cbData = null;
  global.api.onAgentStatus((data) => { cbData = data; });
  assert.ok(eventListeners['agent:status']);

  // Simulate the event from main process
  eventListeners['agent:status']({}, 'status-data');
  assert.equal(cbData, 'status-data');
});

test('cleanup', () => {
  Module._load = originalLoad;
});
