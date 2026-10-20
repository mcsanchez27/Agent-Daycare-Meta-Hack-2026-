const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

const execFileAsync = promisify(execFile);

// Windows will not spawn a .cmd/.bat shim (how npm installs codex, ...)
// without a shell, so `--version` on one fails with EINVAL and the scan can
// only say "Installed". For those we go through cmd.exe with a fixed, fully
// quoted command line. The path must pass this allow-list first: no quotes,
// no cmd metacharacters (& | < > ^ % !), so nothing in it can reach the shell.
// Everything else is run directly.
// NOTE (TM-47 Batch 3): startAgent does not yet handle .cmd shims, so an
// npm-installed Codex (codex.cmd) cannot be launched until that is added.
const SAFE_BATCH_PATH = /^[A-Za-z]:\\[A-Za-z0-9 _.\-\\()~@+,=]+\.(cmd|bat)$/i;

function versionCommand(exe, platform = process.platform, env = process.env) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    if (!SAFE_BATCH_PATH.test(exe)) return null;
    return {
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `""${exe}" --version"`],
      options: { windowsVerbatimArguments: true, windowsHide: true }
    };
  }
  return { file: exe, args: ['--version'], options: {} };
}

const { parseAnsi } = require('./utils/ansi.js');

// Lines Codex prints to stderr that are not part of its answer: its banner,
// session metadata, token counts and MCP login noise.
const CODEX_STDERR_NOISE = /^(Reading additional input|OpenAI Codex|--------|workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|user$|tokens used|\d{1,3}(,\d{3})*$|codex$|\S*Z (ERROR|WARN) )/i;

class AgentRunner {
  constructor(mainWindow, logger, config = null) {
    this.mainWindow = mainWindow;
    this.log = logger;
    this.workingDir = null; // set by applyConfig
    this.processes = new Map();
    this.runCounts = new Map();

    // The three V1 agents. status is 'idle' or 'working'.
    this.agents = {
      antigravity: { id: 'antigravity', name: 'Antigravity', command: 'agy.exe', path: 'agy.exe', color: '#9d4edd', status: 'idle', installed: true, version: 'Unknown' },
      claude: { id: 'claude', name: 'Claude', command: 'claude.exe', path: 'claude.exe', color: '#e76f51', status: 'idle', installed: true, version: 'Unknown' },
      codex: { id: 'codex', name: 'Codex', command: 'codex.exe', path: 'codex.exe', color: '#2a9d8f', status: 'idle', installed: true, version: 'Unknown' }
    };

    if (config) this.applyConfig(config);
  }

  // Applies user settings (see config.js): executable paths and working folder.
  applyConfig(config) {
    if (config.workingDir) this.workingDir = config.workingDir;
    for (const [id, cfg] of Object.entries(config.agents || {})) {
      const agent = this.agents[id];
      if (!agent || !cfg) continue;
      if (cfg.command) agent.command = cfg.command;
      if (cfg.path) agent.path = cfg.path;
    }
    this.log.info('app', 'config applied', { workingDir: this.workingDir, paths: Object.fromEntries(Object.values(this.agents).map(a => [a.id, a.path])) });
  }

  // Each agent launch gets a run number so log lines from a restart are distinguishable.
  currentRun(agentId) {
    return this.runCounts.get(agentId) || 0;
  }

  shutdown() {
    for (const agentId of [...this.processes.keys()]) this.stopAgent(agentId);
    this.log.info('app', 'agent runner shut down');
  }

  async scanAgents() {
    return Promise.all(Object.values(this.agents).map(async agent => {
      let isInstalled = false;
      let version = 'Unknown';
      let verifiedPath = agent.path;
      // The file the version check actually runs: the configured path, or the
      // first hit `where` reports (which may be a .cmd shim, see versionCommand).
      let versionTarget = agent.path;

      if (fs.existsSync(agent.path)) {
        isInstalled = true;
      } else {
        try {
          const { stdout } = await execFileAsync('where', [agent.command], { encoding: 'utf8', timeout: 2500 });
          isInstalled = true;
          verifiedPath = agent.command;
          versionTarget = String(stdout).split(/\r?\n/)[0].trim() || agent.command;
        } catch (err) {
          this.log.debug(agent.id, 'not found on PATH', { path: agent.path, error: err.message });
        }
      }

      if (isInstalled) {
        const cmd = versionCommand(versionTarget);
        if (!cmd) {
          version = 'Installed';
          this.log.debug(agent.id, '--version skipped: batch file path contains shell metacharacters', { path: versionTarget });
        } else {
          try {
            const { stdout } = await execFileAsync(cmd.file, cmd.args, { ...cmd.options, encoding: 'utf8', timeout: 2500 });
            version = stdout.trim().split('\n')[0].replace(/Usage of.*$/i, '').trim() || 'Installed';
          } catch (err) {
            version = 'Installed';
            this.log.debug(agent.id, '--version check failed', { path: versionTarget, error: err.message });
          }
        }
      }
      this.log.info(agent.id, 'scan result', { installed: isInstalled, version, path: verifiedPath });

      agent.installed = isInstalled;
      agent.version = version;
      agent.path = verifiedPath;

      return { id: agent.id, name: agent.name, installed: isInstalled, version, path: verifiedPath, status: agent.status };
    }));
  }

  getConfigs() {
    return Object.values(this.agents);
  }

  // Launches one agent with one prompt. Each message is a fresh one-shot process
  // (stdin closed), so there is no memory between launches; Batch 2 adds the
  // shared transcript to the prompt for that.
  startAgent(agentId, prompt = '') {
    const agent = this.agents[agentId];
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    const p = String(prompt || '').trim();
    if (!p) throw new Error('A prompt is required');

    if (this.processes.has(agentId)) this.stopAgent(agentId);

    const exe = this._getExecutable(agent);
    const workingDir = this.workingDir || process.cwd();
    const args = this._buildAgentArgs(agentId, p);

    const run = this.currentRun(agentId) + 1;
    this.runCounts.set(agentId, run);
    this.log.info(agentId, 'launching', { run, exe, args, cwd: workingDir });

    const child = this._spawnAgentProcess(agentId, agent, exe, args, workingDir, run);
    if (!child) return false;

    this.processes.set(agentId, child);
    agent.status = 'working';
    this.broadcastStatus(agentId);
    this._attachProcessStreams(agentId, agent, child, run);
    return true;
  }

  _getExecutable(agent) {
    return fs.existsSync(agent.path) ? agent.path : agent.command;
  }

  _buildAgentArgs(agentId, p) {
    if (agentId === 'codex') return ['exec', '--skip-git-repo-check', p];
    return ['-p', p]; // antigravity (agy) and claude
  }

  _spawnAgentProcess(agentId, agent, exe, args, workingDir, run) {
    try {
      return spawn(exe, args, {
        cwd: workingDir,
        shell: false,
        env: { ...process.env, FORCE_COLOR: '1' },
        // stdin closed so the CLIs never sit waiting for input
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      this.log.exception(agentId, err, { run, phase: 'spawn' });
      this.emitOutput(agentId, `\x1b[31m[Error launching ${agent.name}]: ${err.message}\x1b[0m\r\n`);
      return null;
    }
  }

  _attachProcessStreams(agentId, agent, child, run) {
    // StringDecoder keeps multi-byte characters intact when they straddle two chunks.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const stdoutSink = this.log.createLineSink(agentId, { run, stream: 'stdout' });
    const stderrSink = this.log.createLineSink(agentId, { run, stream: 'stderr', level: 'warn' });

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdoutSink.push(data);
        this.emitOutput(agentId, stdoutDecoder.write(data));
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderrSink.push(data);
        const rawText = stderrDecoder.write(data);
        if (agentId === 'codex') {
          // Codex echoes its whole session to stderr; keep only real content.
          const cleaned = rawText.split('\n').filter(line => !CODEX_STDERR_NOISE.test(line.trim())).join('\n');
          if (cleaned.trim()) this.emitOutput(agentId, cleaned, 'stderr');
        } else {
          this.emitOutput(agentId, rawText, 'stderr');
        }
      });
    }

    child.on('close', (code) => {
      if (this.processes.get(agentId) === child) this.processes.delete(agentId);
      stdoutSink.flush();
      stderrSink.flush();
      this.log[code === 0 ? 'info' : 'warn'](agentId, 'process exited', { run, code });
      agent.status = 'idle';
      this.broadcastStatus(agentId);
      this._send('agent:done', { agentId, run, code });
    });

    child.on('error', (err) => {
      this.log.exception(agentId, err, { run, phase: 'process' });
      this.emitOutput(agentId, `\x1b[31m[Process error]: ${err.message}\x1b[0m\r\n`, 'stderr');
      agent.status = 'idle';
      this.broadcastStatus(agentId);
    });
  }

  stopAgent(agentId) {
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
      agent.status = 'idle';
      this.broadcastStatus(agentId);
    }
  }

  // Sends a message to an agent. In V1 every message is a new one-shot launch.
  sendInput(agentId, input) {
    if (!this.agents[agentId]) return false;
    return this.startAgent(agentId, input);
  }

  emitOutput(agentId, rawText, stream = 'stdout') {
    this._send('agent:output', { agentId, stream, raw: rawText, html: parseAnsi(rawText) });
  }

  broadcastStatus(agentId) {
    const agent = this.agents[agentId];
    this._send('agent:status', { agentId, status: agent ? agent.status : 'idle' });
  }

  _send(channel, payload) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }
}

AgentRunner.versionCommand = versionCommand;

module.exports = AgentRunner;
