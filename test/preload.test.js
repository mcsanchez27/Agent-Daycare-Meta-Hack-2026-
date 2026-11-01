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

test('run invokes agent:run with the whole request', () => {
  invocations.length = 0;
  const req = { runKey: 'c1/m1', vendor: 'claude', model: 'opus', prompt: 'hello' };
  const res = global.api.run(req);
  assert.equal(res, 'result-agent:run');
  assert.deepEqual(invocations[0], { channel: 'agent:run', data: req });
});

test('stop invokes agent:stop with the run key', () => {
  invocations.length = 0;
  const res = global.api.stop('c1/m1');
  assert.equal(res, 'result-agent:stop');
  assert.deepEqual(invocations[0], { channel: 'agent:stop', data: { runKey: 'c1/m1' } });
});

test('listModels invokes agent:models', () => {
  invocations.length = 0;
  assert.equal(global.api.listModels(), 'result-agent:models');
  assert.equal(invocations[0].channel, 'agent:models');
});

test('getAgentConfigs invokes agent:get-configs', () => {
  invocations.length = 0;
  const res = global.api.getAgentConfigs();
  assert.equal(res, 'result-agent:get-configs');
  assert.deepEqual(invocations[0], { channel: 'agent:get-configs', data: undefined });
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

test('listBrains invokes brains:list', () => {
  invocations.length = 0;
  const res = global.api.listBrains();
  assert.equal(res, 'result-brains:list');
  assert.deepEqual(invocations[0], { channel: 'brains:list', data: undefined });
});

test('getCentralBrain invokes brains:get-central', () => {
  invocations.length = 0;
  const res = global.api.getCentralBrain();
  assert.equal(res, 'result-brains:get-central');
  assert.deepEqual(invocations[0], { channel: 'brains:get-central', data: undefined });
});

test('resolveBrains invokes brains:resolve with options', () => {
  invocations.length = 0;
  const res = global.api.resolveBrains({ personaFile: 'agent-smith.md' });
  assert.equal(res, 'result-brains:resolve');
  assert.deepEqual(invocations[0], { channel: 'brains:resolve', data: { personaFile: 'agent-smith.md' } });
});

test('saveCentralBrain invokes brains:save-central', () => {
  invocations.length = 0;
  const res = global.api.saveCentralBrain('new text');
  assert.equal(res, 'result-brains:save-central');
  assert.deepEqual(invocations[0], { channel: 'brains:save-central', data: { text: 'new text' } });
});

test('savePersonaBrain invokes brains:save-persona', () => {
  invocations.length = 0;
  const res = global.api.savePersonaBrain('agent-smith.md', 'new text');
  assert.equal(res, 'result-brains:save-persona');
  assert.deepEqual(invocations[0], { channel: 'brains:save-persona', data: { file: 'agent-smith.md', text: 'new text' } });
});

test('createPersonaBrain invokes brains:create-persona', () => {
  invocations.length = 0;
  const res = global.api.createPersonaBrain('Neo', 'directives');
  assert.equal(res, 'result-brains:create-persona');
  assert.deepEqual(invocations[0], { channel: 'brains:create-persona', data: { name: 'Neo', text: 'directives' } });
});

test('skills and mcp methods invoke corresponding channels', () => {
  invocations.length = 0;
  global.api.listSkills();
  global.api.saveSkill('audit.md', 'text');
  global.api.createSkill('Audit', 'text');
  global.api.listMcps();
  global.api.saveMcp({ name: 'custom' });
  assert.equal(invocations[0].channel, 'skills:list');
  assert.equal(invocations[1].channel, 'skills:save');
  assert.equal(invocations[2].channel, 'skills:create');
  assert.equal(invocations[3].channel, 'mcp:list');
  assert.equal(invocations[4].channel, 'mcp:save');
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

test('project bridge forwards only explicit project CRUD requests', () => {
  invocations.length = 0;
  global.api.listProjects();
  global.api.createProject({ name: 'Fight Bot', selection: { kind: 'crew' } });
  global.api.updateProject({ id: 'p1', name: 'Renamed' });
  global.api.removeProject('p1');
  assert.deepEqual(invocations, [
    { channel: 'projects:list', data: undefined },
    { channel: 'projects:create', data: { name: 'Fight Bot', selection: { kind: 'crew' } } },
    { channel: 'projects:update', data: { id: 'p1', name: 'Renamed' } },
    { channel: 'projects:remove', data: { id: 'p1' } }
  ]);
});

test('cleanup', () => {
  Module._load = originalLoad;
});