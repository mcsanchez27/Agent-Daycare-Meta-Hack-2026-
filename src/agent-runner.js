const { spawn, execSync } = require('child_process');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

// Built-in lightweight ANSI to styled HTML converter
function ansiToHtml(text) {
  if (!text) return '';
  
  // Strip OSC (Operating System Commands like title updates, colors) e.g. \x1b]0;...\x07
  let cleaned = text
    .replace(/\x1b\][0-9]+;[^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, ''); // cursor & private mode codes

  // Escape HTML characters
  let html = cleaned
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

  // Strip any remaining unhandled control sequences
  html = html.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

  return html;
}

class AgentRunner {
  constructor(mainWindow, logger, config = null) {
    this.mainWindow = mainWindow;
    this.log = logger;
    this.workingDir = null; // set by applyConfig
    this.processes = new Map();
    this.promptTimers = new Map();
    this.runCounts = new Map();
    this.scanErrorLogged = false;
    // Sessions reported by the agent's own hooks (see hook-server.js), keyed by session id.
    this.hookSessions = { antigravity: new Map(), claude: new Map(), codex: new Map(), grok: new Map() };

    // Default verified agent definitions on this PC
    this.agents = {
      antigravity: {
        id: 'antigravity',
        name: 'Antigravity',
        title: 'Team Lead & Orchestrator',
        role: 'lead',
        command: 'agy.exe',
        path: 'agy.exe',
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
        path: 'claude.exe',
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
        path: 'codex.exe',
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
        path: 'grok.exe',
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

    if (config) this.applyConfig(config);

    // Start background process scanner
    this.startProcessScanner();
  }

  // Applies user settings (see config.js): executable paths and working folder.
  applyConfig(config) {
    if (config.workingDir) this.workingDir = config.workingDir;
    for (const [id, cfg] of Object.entries(config.agents || {})) {
      const agent = this.agents[id];
      if (!agent || !cfg) continue;
      if (cfg.command) {
        agent.command = cfg.command;
        agent.processFilter = cfg.command;
      }
      if (cfg.path) agent.path = cfg.path;
    }
    this.log.info('app', 'config applied', { workingDir: this.workingDir, paths: Object.fromEntries(Object.values(this.agents).map(a => [a.id, a.path])) });
  }

  // Each agent launch gets a run number so log lines from a restart are distinguishable.
  currentRun(agentId) {
    return this.runCounts.get(agentId) || 0;
  }

  shutdown() {
    clearInterval(this.scanInterval);
    for (const timer of this.promptTimers.values()) clearTimeout(timer);
    this.promptTimers.clear();
    for (const agentId of [...this.processes.keys()]) this.stopAgent(agentId);
    this.log.info('app', 'agent runner shut down');
  }

  startProcessScanner() {
    this.scanInterval = setInterval(() => {
      this.checkExternalProcesses();
    }, 2500);
    setTimeout(() => this.checkExternalProcesses(), 500);
  }

  // Returns Map<lowercased image name, pid>. Windows only; tests replace this.
  listProcesses() {
    const output = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 3000 });
    const activeFilters = new Map();
    const regex = /^"([^"]+)","([^"]+)"/gm;
    let match;
    while ((match = regex.exec(output)) !== null) {
      activeFilters.set(match[1].toLowerCase(), match[2]);
    }
    return activeFilters;
  }

  checkExternalProcesses() {
    try {
      const activeFilters = this.listProcesses();

      let changed = false;

      Object.values(this.agents).forEach(agent => {
        const filter = (agent.processFilter || agent.command).toLowerCase();
        const foundPid = activeFilters.get(filter);

        const wasExternal = agent.externalPid !== null;
        const isExternal = !!foundPid && !this.processes.has(agent.id);

        const hasHookSessions = this.hookSessions[agent.id].size > 0;

        if (isExternal && agent.externalPid !== foundPid) {
          agent.externalPid = foundPid;
          if (!hasHookSessions && (agent.status === 'sleeping' || agent.status === 'idle')) {
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
          if (hasHookSessions && !foundPid) {
            // Terminal closed without a SessionEnd hook: forget its sessions.
            this.log.info(agent.id, 'process gone; clearing hook sessions', { sessions: this.hookSessions[agent.id].size });
            this.hookSessions[agent.id].clear();
          }
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

      if (this.expireHookSessions()) changed = true;

      if (changed) {
        this.broadcastAllStatus();
      }
    } catch (err) {
      if (!this.scanErrorLogged) {
        this.scanErrorLogged = true;
        this.log.warn('app', 'external process scan failed (will not retry logging)', { error: err.message });
      }
    }
  }

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
        } catch (err) {
          isInstalled = false;
          this.log.debug(agent.id, 'not found on PATH', { path: agent.path, error: err.message });
        }
      }

      if (isInstalled) {
        try {
          const vOut = execSync(`"${verifiedPath}" --version`, { encoding: 'utf8', timeout: 2500 }).trim();
          version = vOut.split('\n')[0].replace(/Usage of.*$/i, '').trim() || 'Installed';
        } catch (err) {
          version = 'Installed';
          this.log.debug(agent.id, '--version check failed', { path: verifiedPath, error: err.message });
        }
      }
      this.log.info(agent.id, 'scan result', { installed: isInstalled, version, path: verifiedPath });

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
        status: agent.status,
        hookSessions: this.hookSessions[agent.id].size
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

  // Start agent with precise argument formatting & shell: false
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

    const workingDir = this.workingDir || process.cwd();
    let args = [];
    const isPromptMode = !!(initialPrompt && initialPrompt.trim());

    if (isPromptMode) {
      const p = initialPrompt.trim();
      if (agentId === 'antigravity') {
        args = ['-p', p];
      } else if (agentId === 'claude') {
        args = ['-p', p];
      } else if (agentId === 'codex') {
        args = ['exec', '--skip-git-repo-check', p];
      } else if (agentId === 'grok') {
        args = ['-p', p, '--output-format', 'plain'];
      } else {
        args = [p];
      }
    }

    const run = this.currentRun(agentId) + 1;
    this.runCounts.set(agentId, run);

    this.emitOutput(agentId, `\x1b[36m> [Mission Control] Launching ${agent.name}...\x1b[0m\r\n\r\n`);
    this.log.info(agentId, 'launching', { run, exe, args, cwd: workingDir, promptMode: isPromptMode });

    let child;
    try {
      const spawnOptions = {
        cwd: workingDir,
        shell: false,
        env: { ...process.env, FORCE_COLOR: '1' }
      };

      if (isPromptMode) {
        // Closes stdin stream explicitly so Claude and Codex do not wait on stdin
        spawnOptions.stdio = ['ignore', 'pipe', 'pipe'];
      }

      child = spawn(exe, args, spawnOptions);
    } catch (err) {
      this.log.exception(agentId, err, { run, phase: 'spawn' });
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

    // StringDecoder keeps multi-byte characters intact when they straddle two chunks.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const stdoutSink = this.log.createLineSink(agentId, { run, stream: 'stdout' });
    const stderrSink = this.log.createLineSink(agentId, { run, stream: 'stderr', level: 'warn' });

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdoutSink.push(data);
        this.handleOutput(agentId, stdoutDecoder.write(data));
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderrSink.push(data);
        const rawText = stderrDecoder.write(data);

        // Filter out Codex's verbose startup banner & metadata from the UI
        if (agentId === 'codex') {
          const cleaned = rawText
            .split('\n')
            .filter(line => !/^(Reading additional input|OpenAI Codex|--------|workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|user$|tokens used|\d{1,3}(,\d{3})*$|codex$)/i.test(line.trim()))
            .join('\n');
          if (cleaned.trim()) {
            this.handleOutput(agentId, cleaned);
          }
        } else {
          this.handleOutput(agentId, rawText);
        }
      });
    }

    child.on('close', (code) => {
      // Clear any pending prompt timers for this agent so alert doesn't linger
      clearTimeout(this.promptTimers.get(agentId));
      this.promptTimers.delete(agentId);

      this.processes.delete(agentId);
      stdoutSink.flush();
      stderrSink.flush();
      this.log[code === 0 ? 'info' : 'warn'](agentId, 'process exited', { run, code });
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
      clearTimeout(this.promptTimers.get(agentId));
      this.promptTimers.delete(agentId);
      this.log.exception(agentId, err, { run, phase: 'process' });
      this.emitOutput(agentId, `\x1b[31m[Process error]: ${err.message}\x1b[0m\r\n`);
      agent.status = 'idle';
      this.broadcastStatus(agentId, 'idle');
    });

    return true;
  }

  stopAgent(agentId) {
    clearTimeout(this.promptTimers.get(agentId));
    this.promptTimers.delete(agentId);
    const child = this.processes.get(agentId);
    if (child) {
      this.log.info(agentId, 'stopping process', { run: this.currentRun(agentId), pid: child.pid });
      try {
        child.kill('SIGTERM');
      } catch (err) {
        this.log.warn(agentId, 'kill failed', { run: this.currentRun(agentId), error: err.message });
      }
      this.processes.delete(agentId);
    }
    const agent = this.agents[agentId];
    if (agent) {
      agent.status = agent.externalPid ? 'working' : 'sleeping';
      agent.unreadPrompt = null;
      this.broadcastStatus(agentId, agent.status);
    }
  }

  sendInput(agentId, input) {
    // Clear any active alert state on backend immediately
    clearTimeout(this.promptTimers.get(agentId));
    this.promptTimers.delete(agentId);

    const child = this.processes.get(agentId);
    const agent = this.agents[agentId];
    
    if (agent) {
      agent.unreadPrompt = null;
      agent.status = 'working';
      this.broadcastStatus(agentId, 'working');
    }

    // If active process with open writable stdin
    if (child && child.stdin && child.stdin.writable && !child.stdin.destroyed) {
      try {
        child.stdin.write(input + '\r\n');
        this.log.info(agentId, 'input sent to running process', { run: this.currentRun(agentId), input });
        this.emitOutput(agentId, `\x1b[36m> ${input}\x1b[0m\r\n`);
        return true;
      } catch (err) {
        this.log.warn(agentId, 'stdin write failed, relaunching instead', { run: this.currentRun(agentId), error: err.message });
      }
    }

    // Auto-launch with prompt
    if (agent) {
      this.log.info(agentId, 'no writable stdin; launching a new process for this input', { input });
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

    // Only detect prompt alerts if the process is currently active
    if (!this.processes.has(agentId)) return;

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
        this.log.info(agentId, 'prompt detected, alerting user', { run: this.currentRun(agentId), snippet: agent.unreadPrompt });
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

  // ---- Hook-reported activity -------------------------------------------
  //
  // Claude Code (and later others) POST their lifecycle events to HookServer,
  // which calls this. The agent's status is then computed from what its
  // sessions actually said rather than guessed from terminal text.

  static HOOK_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

  handleHookEvent(agentId, event) {
    const agent = this.agents[agentId];
    if (!agent) {
      this.log.warn('app', 'hook event for unknown agent', { agentId });
      return false;
    }

    const { name, sid, message } = AgentRunner.normalizeHookEvent(event);
    const sessions = this.hookSessions[agentId];
    const now = Date.now();

    let session = sessions.get(sid);
    const isNew = !session;
    if (isNew) {
      session = { id: sid, state: 'working', cwd: event.cwd || null, startedAt: now };
      sessions.set(sid, session);
    }
    session.updatedAt = now;
    session.lastEvent = name;
    if (event.cwd) session.cwd = event.cwd;

    const cwdLabel = session.cwd ? ` in ${session.cwd}` : '';
    let alert = null;

    switch (name) {
      case 'SessionStart':
        session.state = 'idle';
        this.emitOutput(agentId, `\x1b[36m[Hook] ${agent.name} session started${cwdLabel}\x1b[0m\r\n`);
        this.broadcastTeamMessage({ agentId, agentName: agent.name, type: 'start', text: `🔗 ${agent.name} session started${cwdLabel}` });
        break;
      case 'UserPromptSubmit':
        session.state = 'working';
        if (event.prompt) this.emitOutput(agentId, `\x1b[90m[Hook] prompt: ${String(event.prompt).slice(0, 200)}\x1b[0m\r\n`);
        break;
      case 'PreToolUse':
        session.state = 'working';
        session.lastTool = event.tool_name || null;
        break;
      case 'Notification':
        session.state = 'needs_input';
        session.prompt = event.message || event.title || 'needs your attention';
        session.notificationType = event.notification_type || null;
        alert = session;
        this.emitOutput(agentId, `\x1b[33m[Hook] ${agent.name} needs you: ${session.prompt}\x1b[0m\r\n`);
        break;
      case 'Stop':
        session.state = 'idle';
        this.emitOutput(agentId, `\x1b[32m[Hook] ${agent.name} finished its turn and is waiting for you\x1b[0m\r\n`);
        if (message) this.emitOutput(agentId, `\x1b[90m${message.slice(0, 400)}\x1b[0m\r\n`);
        this.broadcastTeamMessage({ agentId, agentName: agent.name, type: 'exit', text: `✅ ${agent.name} finished a turn${cwdLabel}` });
        break;
      case 'SessionEnd':
        sessions.delete(sid);
        this.emitOutput(agentId, `\x1b[90m[Hook] ${agent.name} session ended\x1b[0m\r\n`);
        this.broadcastTeamMessage({ agentId, agentName: agent.name, type: 'exit', text: `${agent.name} session ended${cwdLabel}` });
        break;
      default:
        this.log.debug(agentId, 'unhandled hook event', { event: name });
    }

    this.log.info(agentId, `hook: ${name}`, {
      session: sid,
      newSession: isNew,
      cwd: session.cwd,
      tool: event.tool_name,
      notificationType: event.notification_type,
      message: event.message
    });

    this.refreshHookStatus(agentId, alert);
    return true;
  }

  // Claude Code sends { hook_event_name, session_id, ... }. Codex's notify sends
  // { type: "agent-turn-complete", "turn-id", "thread-id"?, "last-assistant-message" }.
  static normalizeHookEvent(event) {
    if (event.hook_event_name) {
      return { name: event.hook_event_name, sid: String(event.session_id || 'unknown'), message: null };
    }
    if (event.type === 'agent-turn-complete') {
      return {
        name: 'Stop',
        sid: String(event['thread-id'] || event.thread_id || 'codex'),
        message: event['last-assistant-message'] || event.last_assistant_message || null
      };
    }
    return { name: event.type || 'unknown', sid: String(event.session_id || event['thread-id'] || 'unknown'), message: null };
  }

  // Recomputes an agent's status from its hook sessions and broadcasts it.
  refreshHookStatus(agentId, alertSession = null) {
    const agent = this.agents[agentId];
    const sessions = [...this.hookSessions[agentId].values()];
    let next;
    if (sessions.some(s => s.state === 'needs_input')) next = 'needs_input';
    else if (sessions.some(s => s.state === 'working')) next = 'working';
    else if (sessions.length) next = 'idle';
    else if (this.processes.has(agentId)) next = agent.status;   // our own spawned process decides
    else next = agent.externalPid ? 'working' : 'sleeping';

    agent.status = next;
    if (next === 'needs_input') {
      const waiting = alertSession || sessions.find(s => s.state === 'needs_input');
      agent.unreadPrompt = waiting.prompt;
    } else {
      agent.unreadPrompt = null;
    }

    this.broadcastStatus(agentId, next);

    if (alertSession) {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('agent:prompt', {
          agentId,
          agentName: agent.name,
          promptSnippet: alertSession.prompt
        });
      }
      this.broadcastTeamMessage({
        agentId,
        agentName: agent.name,
        type: 'alert',
        text: `🚨 ${agent.name} needs your input: "${alertSession.prompt}"`
      });
    }
  }

  // Drops sessions that haven't reported in a long time (terminal killed, hook
  // never fired). Returns true if anything changed.
  expireHookSessions() {
    const cutoff = Date.now() - AgentRunner.HOOK_SESSION_TTL_MS;
    let changed = false;
    for (const [agentId, sessions] of Object.entries(this.hookSessions)) {
      let dropped = 0;
      for (const [sid, session] of sessions) {
        if (session.updatedAt < cutoff) {
          sessions.delete(sid);
          dropped++;
        }
      }
      if (dropped) {
        this.log.info(agentId, 'expired stale hook sessions', { dropped });
        this.refreshHookStatus(agentId);
        changed = true;
      }
    }
    return changed;
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
        externalPid: agent?.externalPid,
        hookSessions: agent ? this.hookSessions[agent.id].size : 0
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
