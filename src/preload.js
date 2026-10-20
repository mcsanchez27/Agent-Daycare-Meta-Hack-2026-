const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Agents (each message is a one-shot launch of that agent's CLI)
  startAgent: (agentId, prompt) => ipcRenderer.invoke('agent:start', { agentId, initialPrompt: prompt }),
  stopAgent: (agentId) => ipcRenderer.invoke('agent:stop', { agentId }),
  sendInput: (agentId, input) => ipcRenderer.invoke('agent:send-input', { agentId, input }),
  getAgentConfigs: () => ipcRenderer.invoke('agent:get-configs'),
  scanAgents: () => ipcRenderer.invoke('agent:scan'),

  // Events from the main process
  onAgentOutput: (callback) => ipcRenderer.on('agent:output', (_, data) => callback(data)),
  onAgentStatus: (callback) => ipcRenderer.on('agent:status', (_, data) => callback(data)),
  onAgentDone: (callback) => ipcRenderer.on('agent:done', (_, data) => callback(data)),
  onNotice: (callback) => ipcRenderer.on('app:notice', (_, data) => callback(data)),

  // Settings (executable paths, working folder)
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', { config }),
  pickFolder: (current) => ipcRenderer.invoke('config:pick-folder', { current }),
  pickFile: (current, title) => ipcRenderer.invoke('config:pick-file', { current, title }),

  // Logging (goes to logs/latest.log in the main process)
  log: (level, message, data) => ipcRenderer.send('log:write', { level, message, data }),
  openLogsFolder: () => ipcRenderer.invoke('logs:open-folder')
});
