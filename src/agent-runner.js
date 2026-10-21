const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

const execFileAsync = promisify(execFile);

// Windows will not spawn a .cmd/.bat shim (how npm installs codex, ...)
// without a shell. For those we go through cmd.exe with a fixed, fully
// quoted command line. The path must pass this allow-list first: no quotes,
// no cmd metacharacters (& | < > ^ % !), and so must every argument (plain
// words and flags only), so nothing can reach the shell. That is why Codex
// gets its prompt on stdin rather than as an argument.
// Everything else is run directly.
const SAFE_BATCH_PATH = /^[A-Za-z]:\\[A-Za-z0-9 _.\-\\()~@+,=]+\.(cmd|bat)$/i;
const SAFE_BATCH_ARG = /^[A-Za-z0-9_.=-]+$/;

// How to run exe with args: { file, args, options }, or null when it is a
// Windows batch shim that cannot be run safely with these arguments.
function launchCommand(exe, args, platform = process.platform, env = process.env) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    if (!SAFE_BATCH_PATH.test(exe) || !args.every(a => SAFE_BATCH_ARG.test(a))) return null;
    return {
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `""${exe}" ${args.join(' ')}"`],
      options: { windowsVerbatimArguments: true, windowsHide: true }
    };
  }
  return { file: exe, args, options: {} };
}

function versionCommand(exe, platform = process.platform, env = process.env) {
  return launchCommand(exe, ['--version'], platform, env);
}

// Finds the file to launch. The configured path wins if it exists. On Windows
// we otherwise ask `where`, trying the command as configured and without
// ".exe" (an npm install is codex.cmd, not codex.exe), and keep only files
// Windows can launch, .exe first. Elsewhere spawn searches PATH itself.
function resolveExecutable(agent, { platform = process.platform, exists = fs.existsSync, where = whereSync } = {}) {
  if (agent.path && exists(agent.path)) return agent.path;
  if (platform !== 'win32') return agent.command;
  const names = [...new Set([agent.command, agent.command.replace(/\.exe$/i, '')])];
  for (const name of names) {
    const hits = where(name).filter(f => /\.(exe|cmd|bat)$/i.test(f));
    const best = hits.find(f => /\.exe$/i.test(f)) || hits[0];
    if (best) return best;
  }
  return agent.command;
}

// Stops a child and everything it started. On Windows a plain kill stops only
// the top process, which for a .cmd shim is cmd.exe while Codex keeps going,
// so the whole tree goes through taskkill.
function killTree(child, platform = process.platform, run = execFile) {
  if (platform === 'win32' && child.pid) {
    run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill('SIGTERM');
  }
}

function whereSync(name) {
  try {
    return String(execFileSync('where', [name], { encoding: 'utf8', timeout: 2500, windowsHide: true }))
      .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

const { parseAnsi } = require('./utils/ansi.js');
const { stripAnsi } = require('./logger');
const { DEFAULT_TIMEOUT_SEC } = require('./config');

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
      if (cfg.name) agent.name = cfg.name;
      if (cfg.command) agent.command = cfg.command;
      if (cfg.path) agent.path = cfg.path;
      if (Number.isFinite(cfg.timeoutSec)) agent.timeoutSec = cfg.timeoutSec;
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
  // (stdin closed), so there is no memory between launches; the chat window
  // puts recent history into the prompt (see renderer/thread.js buildPrompt).
  startAgent(agentId, prompt = '') {
    const agent = this.agents[agentId];
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    const p = String(prompt || '').trim();
    if (!p) throw new Error('A prompt is required');

    if (this.processes.has(agentId)) this.stopAgent(agentId);

    const exe = this._getExecutable(agent);
    const workingDir = this.workingDir || process.cwd();
    const { args, stdin } = this._buildAgentArgs(agentId, p);

    const run = this.currentRun(agentId) + 1;
    this.runCounts.set(agentId, run);
    this.log.info(agentId, 'launching', { run, exe, args, stdin, cwd: workingDir });

    const cmd = launchCommand(exe, args);
    if (!cmd) {
      this.log.warn(agentId, 'refused to launch batch file with unsafe path or arguments', { run, exe });
      this.emitOutput(agentId, `[Can't launch ${agent.name}]: ${exe} is a .cmd/.bat file in a folder name Windows' command shell could misread. Point ${agent.name}'s path in config.json at a plain folder.\r\n`, 'stderr');
      return false;
    }

    const child = this._spawnAgentProcess(agentId, agent, cmd, workingDir, run, stdin);
    if (!child) return false;

    this.processes.set(agentId, child);
    // Timeout (TM-53): a reply that takes too long is stopped like Stop.
    const timeoutSec = agent.timeoutSec || DEFAULT_TIMEOUT_SEC;
    child.timeoutSec = timeoutSec;
    child.timer = setTimeout(() => {
      if (this.processes.get(agentId) !== child) return;
      this.log.warn(agentId, 'timed out, stopping', { run, timeoutSec });
      this.stopAgent(agentId, 'timeout');
    }, timeoutSec * 1000);
    agent.status = 'working';
    this.broadcastStatus(agentId);
    this._attachProcessStreams(agentId, agent, child, run);
    return true;
  }

  _getExecutable(agent) {
    return resolveExecutable(agent);
  }

  // args, plus the text to write to stdin (null = stdin closed). Codex reads
  // its prompt from stdin ("-") so the prompt never passes through cmd.exe
  // when Codex is an npm codex.cmd shim.
  // Access (TM-53): every agent may write inside the working folder without
  // asking. Claude: acceptEdits. Codex: the workspace-write sandbox.
  // Antigravity: --mode accept-edits.
  _buildAgentArgs(agentId, p) {
    if (agentId === 'codex') return { args: ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-'], stdin: p };
    if (agentId === 'claude') return { args: ['-p', '--permission-mode', 'acceptEdits', p], stdin: null };
    return { args: ['--mode', 'accept-edits', '-p', p], stdin: null }; // antigravity (agy): -p takes the next word as the prompt, so it goes last
  }

  _spawnAgentProcess(agentId, agent, cmd, workingDir, run, stdin = null) {
    try {
      const child = spawn(cmd.file, cmd.args, {
        ...cmd.options,
        cwd: workingDir,
        shell: false,
        // No FORCE_COLOR: replies are shown as plain text in chat bubbles.
        env: process.env,
        // stdin is closed (or closed right after the prompt is written) so the
        // CLIs never sit waiting for input
        stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe']
      });
      if (stdin != null && child.stdin) {
        child.stdin.on('error', (err) => this.log.warn(agentId, 'could not write prompt to stdin', { run, error: err.message }));
        child.stdin.end(stdin);
      }
      return child;
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
      clearTimeout(child.timer);
      if (this.processes.get(agentId) === child) this.processes.delete(agentId);
      stdoutSink.flush();
      stderrSink.flush();
      this.log[code === 0 ? 'info' : 'warn'](agentId, 'process exited', { run, code });
      agent.status = 'idle';
      this.broadcastStatus(agentId);
      this._send('agent:done', {
        agentId, run, code,
        stopped: child.stopReason === 'user',
        timedOut: child.stopReason === 'timeout',
        timeoutSec: child.timeoutSec
      });
    });

    child.on('error', (err) => {
      this.log.exception(agentId, err, { run, phase: 'process' });
      this.emitOutput(agentId, `\x1b[31m[Process error]: ${err.message}\x1b[0m\r\n`, 'stderr');
      agent.status = 'idle';
      this.broadcastStatus(agentId);
    });
  }

  // reason: 'user' (Stop button, a new launch, quitting) or 'timeout'.
  stopAgent(agentId, reason = 'user') {
    const child = this.processes.get(agentId);
    if (child) {
      this.log.info(agentId, 'stopping process', { run: this.currentRun(agentId), pid: child.pid, reason });
      child.stopReason = reason;
      clearTimeout(child.timer);
      try {
        killTree(child);
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
    // text: colour and cursor codes removed, for the chat bubbles.
    this._send('agent:output', { agentId, stream, run: this.currentRun(agentId), raw: rawText, text: stripAnsi(rawText), html: parseAnsi(rawText) });
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
AgentRunner.launchCommand = launchCommand;
AgentRunner.resolveExecutable = resolveExecutable;
AgentRunner.killTree = killTree;

module.exports = AgentRunner;
