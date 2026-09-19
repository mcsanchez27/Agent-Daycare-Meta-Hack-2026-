const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Built-in lightweight ANSI to styled HTML converter
function ansiToHtml(text) {
  if (!text) return '';
  
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const colorMap = {
    '30': '#4a4a4a',
    '31': '#ff5555',
    '32': '#50fa7b',
    '33': '#f1fa8c',
    '34': '#bd93f9',
    '35': '#ff79c6',
    '36': '#8be9fd',
    '37': '#f8f8f2',
    '90': '#6272a4',
    '91': '#ff6e6e',
    '92': '#69ff94',
    '93': '#ffffa5',
    '94': '#d6acff',
    '95': '#ff92df',
    '96': '#a4ffff',
    '97': '#ffffff'
  };

  html = html.replace(/\x1b\[([0-9;]+)m/g, (match, codes) => {
    const codeList = codes.split(';');
    let styles = [];
    
    for (const code of codeList) {
      if (code === '0') {
        return '</span>';
      } else if (code === '1') {
        styles.push('font-weight: bold;');
      } else if (code === '2') {
        styles.push('opacity: 0.7;');
      } else if (code === '4') {
        styles.push('text-decoration: underline;');
      } else if (colorMap[code]) {
        styles.push(`color: ${colorMap[code]};`);
      }
    }
    
    return `<span style="${styles.join(' ')}">`;
  });

  html = html.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

  return html;
}

class AgentRunner {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.processes = new Map();
    this.promptTimers = new Map();
    this.externalProcesses = new Map();

    // Default verified agent definitions on this PC
    this.agents = {
      antigravity: {
        id: 'antigravity',
        name: 'Antigravity',
        title: 'Team Lead & Orchestrator',
        role: 'lead',
        command: 'agy.exe',
        path: 'C:\\Users\\Matth\\AppData\\Local\\agy\\bin\\agy.exe',
        processFilter: 'agy.exe',
        color: '#7b2cbf',
        accent: '#9d4edd',
        theme: 'indigo',
        status: 'sleeping',
        installed: true,
        version: '1.2.6',
        externalPid: null,
        unreadPrompt: null
      },
      claude: {
        id: 'claude',
        name: 'Claude Code',
        title: 'Code Architect & Builder',
        role: 'architect',
        command: 'claude.exe',
        path: 'C:\\Users\\Matth\\.local\\bin\\claude.exe',
        processFilter: 'claude.exe',
        color: '#e76f51',
        accent: '#f4a261',
        theme: 'orange',
        status: 'sleeping',
        installed: true,
        version: '2.1.276',
        externalPid: null,
        unreadPrompt: null
      },
      codex: {
        id: 'codex',
        name: 'Codex',
        title: 'QA & Logic Engineer',
        role: 'tester',
        command: 'codex.exe',
        path: 'C:\\Users\\Matth\\AppData\\Local\\OpenAI\\Codex\\bin\\eab8377aebac6c07\\codex.exe',
        processFilter: 'codex.exe',
        color: '#2a9d8f',
        accent: '#52b788',
        theme: 'teal',
        status: 'sleeping',
        installed: true,
        version: '0.155.0',
        externalPid: null,
        unreadPrompt: null
      },
      grok: {
        id: 'grok',
        name: 'Grok',
        title: 'Sentry & Code Reviewer',
        role: 'reviewer',
        command: 'grok.exe',
        path: 'C:\\Users\\Matth\\.grok\\bin\\grok.exe',
        processFilter: 'grok.exe',
        color: '#212529',
        accent: '#00f5d4',
        theme: 'cyber',
        status: 'sleeping',
        installed: true,
        version: '1.0.34',
        externalPid: null,
        unreadPrompt: null
      }
    };

    // Start background process scanner
    this.startProcessScanner();
  }

  // Auto-scan system for running agent processes in external terminals
  startProcessScanner() {
    this.scanInterval = setInterval(() => {
      this.checkExternalProcesses();
    }, 2500);
    // Initial check immediately
    setTimeout(() => this.checkExternalProcesses(), 500);
  }

  checkExternalProcesses() {
    try {
      // Use tasklist /FO CSV /NH to get running processes quickly
      const output = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 3000 });
      const lines = output.split('\n');

      const activeFilters = new Map();
      lines.forEach(line => {
        if (!line.trim()) return;
        const parts = line.split('","').map(p => p.replace(/^"|"$/g, ''));
        if (parts.length >= 2) {
          const procName = parts[0].toLowerCase();
          const pid = parts[1];
          activeFilters.set(procName, pid);
        }
      });

      let changed = false;

      Object.values(this.agents).forEach(agent => {
        const filter = (agent.processFilter || agent.command).toLowerCase();
        const foundPid = activeFilters.get(filter);

        const wasExternal = agent.externalPid !== null;
        const isExternal = !!foundPid && !this.processes.has(agent.id);

        if (isExternal && agent.externalPid !== foundPid) {
          agent.externalPid = foundPid;
          if (agent.status === 'sleeping' || agent.status === 'idle') {
            agent.status = 'working';
          }
          changed = true;
          this.broadcastTeamMessage({
            agentId: agent.id,
            agentName: agent.name,
            type: 'start',
            text: `🔗 Linked to active terminal session: ${agent.name} (PID: ${foundPid})`
          });
        } else if (!isExternal && wasExternal) {
          agent.externalPid = null;
          if (!this.processes.has(agent.id)) {
            agent.status = 'sleeping';
          }
          changed = true;
          this.broadcastTeamMessage({
            agentId: agent.id,
            agentName: agent.name,
            type: 'exit',
            text: `Terminal session for ${agent.name} was closed.`
          });
        }
      });

      if (changed) {
        this.broadcastAllStatus();
      }
    } catch (_) {
      // Ignore background scan transient errors
    }
  }

  // Scan and verify agent installations on machine
  scanAgents() {
    const results = [];
    Object.values(this.agents).forEach(agent => {
      let isInstalled = false;
      let version = 'Unknown';
      let verifiedPath = agent.path;

      if (fs.existsSync(agent.path)) {
        isInstalled = true;
      } else {
        try {
          execSync(`where ${agent.command}`, { stdio: 'pipe' });
          isInstalled = true;
          verifiedPath = agent.command;
        } catch (_) {
          isInstalled = false;
        }
      }

      if (isInstalled) {
        try {
          const vOut = execSync(`"${verifiedPath}" --version`, { encoding: 'utf8', timeout: 2500 }).trim();
          version = vOut.split('\n')[0].replace(/Usage of.*$/i, '').trim() || 'Installed';
        } catch (_) {
          version = 'Installed';
        }
      }

      agent.installed = isInstalled;
      agent.version = version;
      agent.path = verifiedPath;

      results.push({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        title: agent.title,
        installed: isInstalled,
        version: version,
        path: verifiedPath,
        externalPid: agent.externalPid,
        status: agent.status
      });
    });

    return results;
  }

  getConfigs() {
    return Object.values(this.agents);
  }

  updateRole(agentId, role, title) {
    if (this.agents[agentId]) {
      if (role === 'lead') {
        for (const agent of Object.values(this.agents)) {
          if (agent.role === 'lead' && agent.id !== agentId) {
            agent.role = 'architect';
            agent.title = 'Code Architect & Builder';
            this.broadcastStatus(agent.id, agent.status);
          }
        }
      }
      this.agents[agentId].role = role;
      if (title) this.agents[agentId].title = title;
      this.broadcastStatus(agentId, this.agents[agentId].status);
      return this.agents[agentId];
    }
    return null;
  }

  // Start agent with optional prompt
  startAgent(agentId, initialPrompt = '') {
    const agent = this.agents[agentId];
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (this.processes.has(agentId)) {
      this.stopAgent(agentId);
    }

    let exe = agent.path;
    if (!fs.existsSync(exe)) {
      exe = agent.command;
    }

    const workingDir = 'C:\\Users\\Matth\\.gemini\\antigravity\\scratch';
    let args = [];

    // Format prompt arguments depending on agent
    if (initialPrompt && initialPrompt.trim()) {
      const p = initialPrompt.trim();
      if (agentId === 'antigravity') {
        args = ['-p', p];
      } else if (agentId === 'claude') {
        args = ['-p', p];
      } else if (agentId === 'codex') {
        args = [p];
      } else if (agentId === 'grok') {
        args = [p];
      } else {
        args = [p];
      }
    }

    this.emitOutput(agentId, `\x1b[36m> Launching ${agent.name} (${exe} ${args.join(' ')})...\x1b[0m\r\n\r\n`);

    let child;
    try {
      child = spawn(exe, args, {
        cwd: workingDir,
        shell: true,
        env: { ...process.env, FORCE_COLOR: '1' }
      });
    } catch (err) {
      this.emitOutput(agentId, `\x1b[31m[Error launching ${agent.name}]: ${err.message}\x1b[0m\r\n`);
      return false;
    }

    this.processes.set(agentId, child);
    agent.status = 'working';
    agent.unreadPrompt = null;
    this.broadcastStatus(agentId, 'working');

    this.broadcastTeamMessage({
      agentId,
      agentName: agent.name,
      type: 'start',
      text: `${agent.name} started working on: "${initialPrompt || 'Interactive Session'}"`
    });

    child.stdout.on('data', (data) => {
      const rawText = data.toString('utf8');
      this.handleOutput(agentId, rawText);
    });

    child.stderr.on('data', (data) => {
      const rawText = data.toString('utf8');
      this.handleOutput(agentId, rawText);
    });

    child.on('close', (code) => {
      this.processes.delete(agentId);
      agent.status = agent.externalPid ? 'working' : 'sleeping';
      agent.unreadPrompt = null;
      this.broadcastStatus(agentId, agent.status);
      this.emitOutput(agentId, `\r\n\x1b[90m[Process finished with code ${code}]\x1b[0m\r\n`);
      
      this.broadcastTeamMessage({
        agentId,
        agentName: agent.name,
        type: 'exit',
        text: `${agent.name} finished task (exit code: ${code}).`
      });
    });

    child.on('error', (err) => {
      this.emitOutput(agentId, `\x1b[31m[Process error]: ${err.message}\x1b[0m\r\n`);
      agent.status = 'idle';
      this.broadcastStatus(agentId, 'idle');
    });

    return true;
  }

  stopAgent(agentId) {
    const child = this.processes.get(agentId);
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      this.processes.delete(agentId);
    }
    const agent = this.agents[agentId];
    if (agent) {
      agent.status = agent.externalPid ? 'working' : 'sleeping';
      agent.unreadPrompt = null;
      this.broadcastStatus(agentId, agent.status);
    }
  }

  // Key upgrade: sendInput now auto-launches if not already running!
  sendInput(agentId, input) {
    const child = this.processes.get(agentId);
    const agent = this.agents[agentId];
    
    // If active embedded session, pipe to stdin
    if (child && child.stdin && child.stdin.writable) {
      child.stdin.write(input + '\r\n');
      this.emitOutput(agentId, `\x1b[36m> ${input}\x1b[0m\r\n`);
      
      if (agent) {
        agent.status = 'working';
        agent.unreadPrompt = null;
        this.broadcastStatus(agentId, 'working');
      }
      return true;
    }

    // If not running, AUTO-LAUNCH with the prompt!
    if (agent) {
      this.emitOutput(agentId, `\x1b[32m[Summoning ${agent.name} to execute your prompt...]\x1b[0m\r\n`);
      return this.startAgent(agentId, input);
    }

    return false;
  }

  handleOutput(agentId, rawText) {
    this.emitOutput(agentId, rawText);
    this.detectPrompt(agentId, rawText);
  }

  detectPrompt(agentId, rawText) {
    const agent = this.agents[agentId];
    if (!agent) return;

    const promptPatterns = [
      /\?\s+[\w\s]{3,}\??/i,
      /\[y\/n\]|\(y\/n\)|\[yes\/no\]/i,
      /approval required|approve change/i,
      /select an option|choose one/i,
      /enter prompt|type your/i,
      />\s*$/,
      /waiting for input/i
    ];

    const hasPromptCue = promptPatterns.some(pattern => pattern.test(rawText));

    if (hasPromptCue) {
      clearTimeout(this.promptTimers.get(agentId));
      const timer = setTimeout(() => {
        agent.status = 'needs_input';
        agent.unreadPrompt = rawText.trim().slice(-120);
        this.broadcastStatus(agentId, 'needs_input');
        
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('agent:prompt', {
            agentId,
            agentName: agent.name,
            promptSnippet: agent.unreadPrompt
          });
        }

        this.broadcastTeamMessage({
          agentId,
          agentName: agent.name,
          type: 'alert',
          text: `🚨 ${agent.name} needs your input: "${agent.unreadPrompt}"`
        });
      }, 300);

      this.promptTimers.set(agentId, timer);
    }
  }

  forwardToAgent(fromAgentId, toAgentId, text) {
    const fromAgent = this.agents[fromAgentId];
    const toAgent = this.agents[toAgentId];
    if (!fromAgent || !toAgent) return false;

    const success = this.sendInput(toAgentId, text);

    this.broadcastTeamMessage({
      agentId: fromAgentId,
      agentName: fromAgent.name,
      type: 'forward',
      text: `🔄 ${fromAgent.name} forwarded context to ${toAgent.name}: "${text.slice(0, 80)}..."`
    });

    return success;
  }

  emitOutput(agentId, rawText) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const html = ansiToHtml(rawText);
      this.mainWindow.webContents.send('agent:output', { agentId, raw: rawText, html });
    }
  }

  broadcastStatus(agentId, status) {
    const agent = this.agents[agentId];
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('agent:status', { 
        agentId, 
        status, 
        role: agent?.role, 
        title: agent?.title,
        externalPid: agent?.externalPid
      });
    }
  }

  broadcastAllStatus() {
    Object.values(this.agents).forEach(agent => {
      this.broadcastStatus(agent.id, agent.status);
    });
  }

  broadcastTeamMessage(messageObj) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('agent:team-message', {
        ...messageObj,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  }
}

module.exports = AgentRunner;
