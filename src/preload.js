const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Agent Process Control
  startAgent: (agentId, initialPrompt) => ipcRenderer.invoke('agent:start', { agentId, initialPrompt }),
  stopAgent: (agentId) => ipcRenderer.invoke('agent:stop', { agentId }),
  sendInput: (agentId, input) => ipcRenderer.invoke('agent:send-input', { agentId, input }),
  getAgentConfigs: () => ipcRenderer.invoke('agent:get-configs'),
  scanAgents: () => ipcRenderer.invoke('agent:scan'),
  updateAgentRole: (agentId, role, title) => ipcRenderer.invoke('agent:update-role', { agentId, role, title }),
  
  // Real-time Event Listeners
  onAgentOutput: (callback) => ipcRenderer.on('agent:output', (_, data) => callback(data)),
  onAgentStatus: (callback) => ipcRenderer.on('agent:status', (_, data) => callback(data)),
  onAgentPrompt: (callback) => ipcRenderer.on('agent:prompt', (_, data) => callback(data)),
  onTeamMessage: (callback) => ipcRenderer.on('agent:team-message', (_, data) => callback(data)),
  
  // Inter-Agent Messaging / Forwarding
  forwardToAgent: (fromAgentId, toAgentId, text) => ipcRenderer.invoke('agent:forward', { fromAgentId, toAgentId, text }),

  // Agent hooks (Claude Code -> local listener -> mascots)
  getHookStatus: () => ipcRenderer.invoke('hooks:status'),
  installHooks: (agentId) => ipcRenderer.invoke('hooks:install', { agentId }),
  uninstallHooks: (agentId) => ipcRenderer.invoke('hooks:uninstall', { agentId }),

  // Settings (executable paths, working folder)
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', { config }),
  pickFolder: (current) => ipcRenderer.invoke('config:pick-folder', { current }),
  pickFile: (current, title) => ipcRenderer.invoke('config:pick-file', { current, title }),

  // Logging (goes to logs/latest.log in the main process)
  log: (level, message, data) => ipcRenderer.send('log:write', { level, message, data }),
  openLogsFolder: () => ipcRenderer.invoke('logs:open-folder'),

  // Window Controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close')
});
