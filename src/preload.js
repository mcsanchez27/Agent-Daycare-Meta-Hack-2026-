const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Agents: each reply is a one-shot launch of a chat member's CLI, named by
  // its runKey (`<chatId>/<memberId>`).
  run: (req) => ipcRenderer.invoke('agent:run', req),
  stop: (runKey) => ipcRenderer.invoke('agent:stop', { runKey }),
  listModels: () => ipcRenderer.invoke('agent:models'),
  getAgentConfigs: () => ipcRenderer.invoke('agent:get-configs'),

  // Events from the main process
  onAgentOutput: (callback) => ipcRenderer.on('agent:output', (_, data) => callback(data)),
  onAgentDone: (callback) => ipcRenderer.on('agent:done', (_, data) => callback(data)),
  onAgentStep: (callback) => ipcRenderer.on('agent:step', (_, data) => callback(data)),
  onNotice: (callback) => ipcRenderer.on('app:notice', (_, data) => callback(data)),

  // Settings (executable paths, working folder)
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', { config }),
  pickFolder: (current) => ipcRenderer.invoke('config:pick-folder', { current }),
  pickFile: (current, title) => ipcRenderer.invoke('config:pick-file', { current, title }),

  // Project containers and saved rosters.
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (req) => ipcRenderer.invoke('projects:create', req),
  updateProject: (req) => ipcRenderer.invoke('projects:update', req),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', { id }),

  // Saved chats, one file each (TM-53 Batch 2)
  listChats: () => ipcRenderer.invoke('chats:list'),
  loadChat: (id) => ipcRenderer.invoke('chats:load', { id }),
  saveChat: (chat) => ipcRenderer.invoke('chats:save', { chat }),

  // Preset Brains & Central Brain (TM-60 Batch 2, 4, 5)
  listBrains: () => ipcRenderer.invoke('brains:list'),
  getCentralBrain: () => ipcRenderer.invoke('brains:get-central'),
  resolveBrains: (opts) => ipcRenderer.invoke('brains:resolve', opts),
  saveCentralBrain: (text) => ipcRenderer.invoke('brains:save-central', { text }),
  savePersonaBrain: (file, text) => ipcRenderer.invoke('brains:save-persona', { file, text }),
  createPersonaBrain: (name, text) => ipcRenderer.invoke('brains:create-persona', { name, text }),

  // Skills Library (TM-60 Batch 5)
  listSkills: () => ipcRenderer.invoke('skills:list'),
  saveSkill: (file, text) => ipcRenderer.invoke('skills:save', { file, text }),
  createSkill: (name, text) => ipcRenderer.invoke('skills:create', { name, text }),

  // MCP Directory (TM-60 Batch 5)
  listMcps: () => ipcRenderer.invoke('mcp:list'),
  saveMcp: (server) => ipcRenderer.invoke('mcp:save', { server }),
  removeMcp: (id) => ipcRenderer.invoke('mcp:remove', { id }),
  listCliMcps: (fresh = false) => ipcRenderer.invoke('mcp:cli-lists', { fresh }),

  // Org Control assignments: which skills each engine and persona gets (TM-60 Batch 2)
  getOrg: () => ipcRenderer.invoke('org:get'),
  saveOrg: (org) => ipcRenderer.invoke('org:save', { org }),

  // Logging (goes to logs/latest.log in the main process)
  log: (level, message, data) => ipcRenderer.send('log:write', { level, message, data }),
  openLogsFolder: () => ipcRenderer.invoke('logs:open-folder')
});
