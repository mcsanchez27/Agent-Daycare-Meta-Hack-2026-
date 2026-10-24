const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CHAT_ID } = require('./chats');
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

// A model name typed or picked for a chat member (TM-54). It goes on the
// command line, so it is held to plain characters (still safe for a .cmd shim).
const MODEL_TEXT = /^[A-Za-z0-9_.:-]{1,64}$/;

// A vendor session id goes on the command line (TM-55): plain ids only.
// No leading hyphen, so an id can never be read as a flag.
const SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/;
const sessionOk = (id) => typeof id === 'string' && SESSION_ID.test(id);
// agy prints its whole answer at the end; past this much, it's passed on as plain text.
const MAX_PENDING = 4 * 1024 * 1024;

// One line of a CLI's JSON output (TM-55) as what the app needs from it:
// { text?, sessionId?, usage?: { inputTokens, outputTokens, contextWindow? },
// plan? (Claude only: 5-hour and 7-day use) }, or null for anything else.
// One line saying what a tool call does (TM-59): "Reading note.txt",
// "Running npm test". Each CLI names its tools and arguments differently.
function describeTool(name, params = {}) {
  const p = params && typeof params === 'object' ? params : {};
  const short = (s, n = 70) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const file = p.file_path || p.path || p.Path || p.AbsolutePath || p.TargetFile || p.FilePath || p.notebook_path;
  const base = file ? String(file).split(/[\\/]/).pop() : null;
  const command = p.command || p.CommandLine;
  const n = String(name || 'a tool');
  if (command) {
    // Codex wraps commands as powershell.exe -Command '...'; show the inside.
    const inner = /-Command\s+'([\s\S]*)'\s*$/.exec(String(command));
    return `Running ${short(inner ? inner[1] : command)}`;
  }
  if (/^(read|view_file|read_file)/i.test(n)) return base ? `Reading ${base}` : 'Reading a file';
  if (/^(write|write_to_file|create)/i.test(n)) return base ? `Writing ${base}` : 'Writing a file';
  if (/edit|replace/i.test(n)) return base ? `Editing ${base}` : 'Editing a file';
  if (/glob|grep|search|find|list_dir/i.test(n)) return `Searching${p.pattern || p.query || p.Query ? ` for ${short(p.pattern || p.query || p.Query, 50)}` : ''}`;
  if (/web|fetch|url/i.test(n)) return `Looking up ${short(p.url || p.query || p.Url || 'the web', 60)}`;
  return `Using ${short(n, 50)}`;
}

function parseEvent(vendor, line) {
  let j;
  try { j = JSON.parse(line); } catch (_) { return null; }
  if (!j || typeof j !== 'object') return null;
  if (vendor === 'claude' || vendor === 'grok') {
    if (j.type === 'system' && j.subtype === 'init') return sessionOk(j.session_id) ? { sessionId: j.session_id } : null;
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      const text = j.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
      const steps = j.message.content.filter(c => c.type === 'tool_use').map(c => describeTool(c.name, c.input));
      if (!text && !steps.length) return null;
      return { ...(text ? { text } : {}), ...(steps.length ? { steps } : {}) };
    }
    if (j.type === 'result') {
      const u = j.usage || {};
      const windows = Object.values(j.modelUsage || {}).map(m => m.contextWindow).filter(Boolean);
      const usage = { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0 };
      if (windows.length) usage.contextWindow = Math.max(...windows);
      return sessionOk(j.session_id) ? { sessionId: j.session_id, usage } : { usage };
    }
    if (j.type === 'rate_limit_event' && j.rate_limit_info) {
      const w = j.rate_limit_info.unifiedWindows || {};
      const win = (x) => (x ? { used: x.utilization, resetsAt: x.resetsAt } : null);
      return { plan: { status: j.rate_limit_info.status, fiveHour: win(w.five_hour), sevenDay: win(w.seven_day) } };
    }
    return null;
  }
  if (vendor === 'codex') {
    if (j.type === 'thread.started') return sessionOk(j.thread_id) ? { sessionId: j.thread_id } : null;
    if (j.type === 'item.completed' && j.item && j.item.type === 'agent_message' && j.item.text) return { text: j.item.text };
    if (j.type === 'item.started' && j.item) {
      const it = j.item;
      if (it.type === 'command_execution') return { steps: [describeTool('command', { command: it.command })] };
      if (it.type === 'file_change') {
        const files = (Array.isArray(it.changes) ? it.changes : []).map(c => String(c.path || '').split(/[\\/]/).pop()).filter(Boolean);
        return { steps: [files.length ? `Editing ${files.join(', ')}` : 'Editing files'] };
      }
      if (it.type === 'mcp_tool_call') return { steps: [`Using ${[it.server, it.tool].filter(Boolean).join(' ') || 'a tool'}`] };
      if (it.type === 'web_search') return { steps: [`Searching the web${it.query ? ` for ${String(it.query).slice(0, 50)}` : ''}`] };
    }
    if (j.type === 'turn.completed' && j.usage) return { usage: { inputTokens: j.usage.input_tokens || 0, outputTokens: j.usage.output_tokens || 0 } };
    return null;
  }
  // agy --output-format stream-json (TM-59): init, step_update, result.
  if (j.event === 'init' && j.conversation_id) return sessionOk(j.conversation_id) ? { sessionId: j.conversation_id } : null;
  if (j.event === 'step_update' && j.step_update && j.step_update.step_type === 'tool') {
    const s = j.step_update;
    const what = describeTool(s.tool_name || (s.tool_info && s.tool_info.name), s.tool_info && s.tool_info.parameters);
    if (s.state === 'ACTIVE') return { steps: [what] };
    if (s.state === 'ERROR') return { steps: [`${what} (failed${/denied permission/i.test(JSON.stringify(s.tool_info && s.tool_info.error || '')) ? ': not allowed' : ''})`] };
    return null;
  }
  if (j.event === 'result' && j.result) j = j.result;
  if (j.conversation_id || j.response) {
    const out = {};
    if (sessionOk(j.conversation_id)) out.sessionId = j.conversation_id;
    if (typeof j.response === 'string' && j.response) out.text = j.response;
    if (j.usage) out.usage = { inputTokens: j.usage.input_tokens || 0, outputTokens: j.usage.output_tokens || 0 };
    return out;
  }
  return null;
}

const CLAUDE_MODELS = [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }];
// What `grok models` listed on 2026-10-24 (it answers even when signed out).
const GROK_MODELS = [{ id: 'grok-4.6', label: 'grok-4.6' }, { id: 'grok-4.5', label: 'grok-4.5' }];
// grok's prompt goes in this file in the chat folder (see _buildAgentArgs).
const PROMPT_FILE = '.daycare-prompt.txt';
// The Central Brain and skills reach Claude, Codex and Gemini as the file each
// reads from its folder on its own (TM-60 Batch 2). Only these names are written.
const FOLDER_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

// `agy models` prints a header, then one "id<TAB>label" line per model.
function parseAgyModels(text) {
  return String(text).split(/\r?\n/).map(l => l.split('\t')).filter(p => p.length === 2 && MODEL_TEXT.test(p[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
}

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

    // The three vendors' CLIs. Chats pick their agents (members) from these.
    this.agents = {
      antigravity: { id: 'antigravity', name: 'Gemini', command: 'agy.exe', path: 'agy.exe', color: '#9d4edd', installed: true, version: 'Unknown' },
      claude: { id: 'claude', name: 'Claude', command: 'claude.exe', path: 'claude.exe', color: '#e76f51', installed: true, version: 'Unknown' },
      codex: { id: 'codex', name: 'Codex', command: 'codex.exe', path: 'codex.exe', color: '#2a9d8f', installed: true, version: 'Unknown' },
      grok: { id: 'grok', name: 'Grok', command: 'grok.cmd', path: 'grok.cmd', color: '#e2e8f0', installed: true, version: 'Unknown' }
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
  currentRun(vendor) {
    return this.runCounts.get(vendor) || 0;
  }

  shutdown() {
    for (const runKey of [...this.processes.keys()]) this.stop(runKey);
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

      return { id: agent.id, name: agent.name, installed: isInstalled, version, path: verifiedPath };
    }));
  }

  getConfigs() {
    return Object.values(this.agents);
  }

  // The models a new chat member can pick, per vendor (TM-54). Antigravity
  // lists its own (`agy models`); Claude takes these aliases; Codex has no
  // list, so its model is typed. Asked once, then cached.
  listModels() {
    if (!this._models) {
      this._models = this._agyModelsText()
        .then(parseAgyModels)
        .catch((err) => {
          this.log.warn('antigravity', 'could not list models', { error: err.message });
          return [];
        })
        .then(antigravity => ({ antigravity, claude: CLAUDE_MODELS, codex: [], grok: GROK_MODELS }));
    }
    return this._models;
  }

  async _agyModelsText() {
    const cmd = launchCommand(this._getExecutable(this.agents.antigravity), ['models']);
    if (!cmd) throw new Error('agy path is not safe to run');
    const { stdout } = await execFileAsync(cmd.file, cmd.args, { ...cmd.options, encoding: 'utf8', timeout: 10000, windowsHide: true });
    return stdout;
  }

  // Launches one chat member's reply. Each message is a fresh one-shot process
  // (stdin closed), so there is no memory between launches; the chat window
  // puts recent history into the prompt (see renderer/thread.js buildPrompt).
  // runKey (`<chatId>/<memberId>`, TM-54) names the run: events carry it, and
  // Stop and the timeout act on it alone, so two members of one vendor can
  // answer at once. model is the vendor's model id, or null for its default.
  run({ runKey, vendor, model = null, sessionId = null, prompt = '', files = null, mcp = null }) {
    const agent = this.agents[vendor];
    if (!agent) throw new Error(`Agent ${vendor} not found`);
    const p = String(prompt || '').trim();
    if (!p) throw new Error('A prompt is required');

    const run = this.currentRun(vendor) + 1;
    this.runCounts.set(vendor, run);
    const ctx = { runKey, vendor, run };
    if (model !== null && !MODEL_TEXT.test(model)) {
      this.log.warn(vendor, 'refused model name', { run, runKey, model });
      this.emitOutput(ctx, `[Can't launch ${agent.name}]: "${model}" isn't a model name it can take (letters, digits, . _ : - only).\r\n`, 'stderr');
      return false;
    }
    if (sessionId !== null && !SESSION_ID.test(sessionId)) {
      this.log.warn(vendor, 'refused session id', { run, runKey, sessionId });
      this.emitOutput(ctx, `[Can't launch ${agent.name}]: its saved session id "${sessionId}" isn't one it can resume.\r\n`, 'stderr');
      return false;
    }

    if (this.processes.has(runKey)) this.stop(runKey);

    const exe = this._getExecutable(agent);
    const workingDir = this.chatFolder(runKey);
    let mcpPath = null;
    if (vendor === 'claude' && mcp && mcp.mcpServers && Object.keys(mcp.mcpServers).length) {
      mcpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daycare-mcp-')), 'mcp.json');
      fs.writeFileSync(mcpPath, JSON.stringify(mcp), { mode: 0o600, flag: 'wx' });
    }
    const { args, stdin, promptFile = null } = this._buildAgentArgs(vendor, p, model, sessionId, mcpPath);
    if (promptFile !== null) fs.writeFileSync(path.join(workingDir, PROMPT_FILE), promptFile);
    for (const [name, text] of Object.entries(files || {})) {
      if (FOLDER_FILES.includes(name) && typeof text === 'string') fs.writeFileSync(path.join(workingDir, name), text);
      else this.log.warn(vendor, 'refused folder file', { run, runKey, name });
    }
    this.log.info(vendor, 'launching', { run, runKey, exe, args, stdin, promptFile, cwd: workingDir });

    const cmd = launchCommand(exe, args);
    if (!cmd) {
      this.log.warn(vendor, 'refused to launch batch file with unsafe path or arguments', { run, exe });
      this.emitOutput(ctx, `[Can't launch ${agent.name}]: ${exe} is a .cmd/.bat file in a folder name Windows' command shell could misread. Point ${agent.name}'s path in config.json at a plain folder.\r\n`, 'stderr');
      return false;
    }

    const child = this._spawnAgentProcess(vendor, agent, cmd, workingDir, ctx, stdin);
    if (!child) return false;
    Object.assign(child, ctx);
    if (promptFile !== null) child.promptPath = path.join(workingDir, PROMPT_FILE);
    if (mcpPath) child.mcpPath = mcpPath;

    this.processes.set(runKey, child);
    // Timeout (TM-53): a reply that takes too long is stopped like Stop.
    const timeoutSec = agent.timeoutSec || DEFAULT_TIMEOUT_SEC;
    child.timeoutSec = timeoutSec;
    child.timer = setTimeout(() => {
      if (this.processes.get(runKey) !== child) return;
      this.log.warn(vendor, 'timed out, stopping', { run, runKey, timeoutSec });
      this.stop(runKey, 'timeout');
    }, timeoutSec * 1000);
    this._attachProcessStreams(child);
    return true;
  }

  // Each chat works in a folder of its own inside the working folder (TM-59),
  // named by its id, so a crew owns its project files. Created on first use.
  chatFolder(runKey) {
    const base = this.workingDir || process.cwd();
    const chatId = String(runKey || '').split('/')[0];
    if (!CHAT_ID.test(chatId)) return base;
    const dir = path.join(base, chatId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _getExecutable(agent) {
    return resolveExecutable(agent);
  }

  // args, plus the text to write to stdin (null = stdin closed). Codex reads
  // its prompt from stdin ("-") so the prompt never passes through cmd.exe
  // when Codex is an npm codex.cmd shim.
  // Access (TM-53): every agent may write inside the working folder without
  // asking, and run commands (TM-59). Claude: acceptEdits plus Bash and
  // PowerShell; on Windows its commands start in the chat folder but aren't
  // fenced in (no Claude sandbox there). Codex: the workspace-write sandbox.
  // Antigravity: --mode accept-edits, with --sandbox (blocks writes outside
  // the folder, tested) and --dangerously-skip-permissions (headless agy
  // otherwise denies every command).
  // A model (TM-54) adds the vendor's model
  // flag; null leaves the CLI on its default.
  // Output (TM-55): each CLI's JSON, read by parseEvent, so the reply's
  // session can be resumed. sessionId resumes that session; codex's resume
  // takes no --sandbox, so the same setting goes in as -c.
  // mcpPath (TM-60 Batch 3): a per-launch file holding Claude's MCP servers
  // ({ mcpServers }), written by run() in a private temp folder and deleted
  // when the run ends, so no key sits on the command line, in the log or
  // in the chat folder. Only Claude takes servers per launch.
  _buildAgentArgs(vendor, p, model = null, sessionId = null, mcpPath = null) {
    const m = model ? ['-m', model] : [];
    const mcpArgs = vendor === 'claude' && mcpPath ? ['--mcp-config', mcpPath] : [];
    if (vendor === 'codex' && sessionId) return { args: ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', ...m, sessionId, '-'], stdin: p };
    if (vendor === 'codex') return { args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...m, '-'], stdin: p };
    const flag = model ? ['--model', model] : [];
    // Lean Claude (TM-59): Matt's own plugins, hooks and MCP servers stay out
    // (about 66k tokens a launch down to 37k). Its login is unaffected.
    if (vendor === 'claude') return { args: ['-p', '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '--strict-mcp-config', ...mcpArgs, '--allowedTools', 'Bash,PowerShell', '--output-format', 'stream-json', '--verbose', ...flag, ...(sessionId ? ['--resume', sessionId] : []), p], stdin: null };
    // grok (TM-60): one turn from a prompt file in the chat folder (see run):
    // its npm shim goes through cmd.exe, which a prompt on the command line
    // would not survive. Output is Claude-shaped streaming JSON. Tools are
    // auto-approved like the others; it isn't fenced in.
    if (vendor === 'grok') return { args: ['--output-format', 'streaming-messages-json', '--permission-mode', 'acceptEdits', '--always-approve', ...m, ...(sessionId ? ['--resume', sessionId] : []), '--prompt-file', PROMPT_FILE], stdin: null, promptFile: p };
    // antigravity (agy): -p takes the next word as the prompt, so it goes last
    return { args: ['--mode', 'accept-edits', '--sandbox', '--dangerously-skip-permissions', '--output-format', 'stream-json', ...flag, ...(sessionId ? ['--conversation', sessionId] : []), '-p', p], stdin: null };
  }

  _spawnAgentProcess(vendor, agent, cmd, workingDir, ctx, stdin = null) {
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
        child.stdin.on('error', (err) => this.log.warn(vendor, 'could not write prompt to stdin', { run: ctx.run, error: err.message }));
        child.stdin.end(stdin);
      }
      return child;
    } catch (err) {
      this.log.exception(vendor, err, { run: ctx.run, phase: 'spawn' });
      this.emitOutput(ctx, `\x1b[31m[Error launching ${agent.name}]: ${err.message}\x1b[0m\r\n`);
      return null;
    }
  }

  // child carries its run: { runKey, vendor, run }.
  _attachProcessStreams(child) {
    const { runKey, vendor, run } = child;
    // StringDecoder keeps multi-byte characters intact when they straddle two chunks.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const stdoutSink = this.log.createLineSink(vendor, { run, runKey, stream: 'stdout' });
    const stderrSink = this.log.createLineSink(vendor, { run, runKey, stream: 'stderr', level: 'warn' });

    // stdout is JSON, one event per line (TM-55): the reply text goes to the
    // window as it comes; the session id and usage ride along on agent:done.
    // Tool calls go to the window as steps (TM-59). agy runs as stream-json,
    // one event per line like the others; a leftover that isn't JSON at the
    // end is shown as text.
    child.meta = {};
    let pendingLine = '';
    const take = (line) => {
      const ev = parseEvent(vendor, line);
      if (!ev) return false;
      // Each CLI sends its messages whole ("I'll check…", tools, then the
      // answer), so they get a blank line between them.
      if (ev.text) this.emitOutput(child, (child.saidSomething ? '\n\n' : '') + ev.text);
      if (ev.text) child.saidSomething = true;
      if (ev.steps) for (const step of ev.steps) this._send('agent:step', { runKey, vendor, run, step });
      if (ev.sessionId) child.meta.sessionId = ev.sessionId;
      if (ev.usage) child.meta.usage = { ...child.meta.usage, ...ev.usage };
      if (ev.plan) child.meta.plan = ev.plan;
      return true;
    };
    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdoutSink.push(data);
        const lines = (pendingLine + stdoutDecoder.write(data)).split('\n');
        pendingLine = lines.pop();
        lines.forEach(take);
        if (pendingLine.length > MAX_PENDING) {
          this.log.warn(vendor, 'output too large to read as JSON, shown as text', { run, runKey, bytes: pendingLine.length });
          this.emitOutput(child, pendingLine);
          pendingLine = '';
        }
      });
      child.stdout.on('end', () => {
        if (pendingLine.trim() && !take(pendingLine.trim())) this.emitOutput(child, pendingLine);
        pendingLine = '';
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderrSink.push(data);
        const rawText = stderrDecoder.write(data);
        if (vendor === 'codex') {
          // Codex echoes its whole session to stderr; keep only real content.
          const cleaned = rawText.split('\n').filter(line => !CODEX_STDERR_NOISE.test(line.trim())).join('\n');
          if (cleaned.trim()) this.emitOutput(child, cleaned, 'stderr');
        } else {
          this.emitOutput(child, rawText, 'stderr');
        }
      });
    }

    child.on('close', (code) => {
      clearTimeout(child.timer);
      if (child.promptPath) fs.unlink(child.promptPath, () => {});
      if (child.mcpPath) fs.rm(path.dirname(child.mcpPath), { recursive: true, force: true }, () => {});
      if (this.processes.get(runKey) === child) this.processes.delete(runKey);
      stdoutSink.flush();
      stderrSink.flush();
      this.log[code === 0 ? 'info' : 'warn'](vendor, 'process exited', { run, runKey, code });
      this._send('agent:done', {
        runKey, vendor, run, code,
        stopped: child.stopReason === 'user',
        timedOut: child.stopReason === 'timeout',
        timeoutSec: child.timeoutSec,
        ...child.meta
      });
    });

    child.on('error', (err) => {
      this.log.exception(vendor, err, { run, runKey, phase: 'process' });
      this.emitOutput(child, `\x1b[31m[Process error]: ${err.message}\x1b[0m\r\n`, 'stderr');
    });
  }

  // reason: 'user' (Stop button, a new launch, quitting) or 'timeout'.
  stop(runKey, reason = 'user') {
    const child = this.processes.get(runKey);
    if (!child) return;
    this.log.info(child.vendor, 'stopping process', { run: child.run, runKey, pid: child.pid, reason });
    child.stopReason = reason;
    clearTimeout(child.timer);
    try {
      killTree(child);
    } catch (err) {
      this.log.warn(child.vendor, 'kill failed', { run: child.run, runKey, error: err.message });
    }
    this.processes.delete(runKey);
  }

  // ctx: { runKey, vendor, run } (a running child carries these).
  emitOutput({ runKey, vendor, run }, rawText, stream = 'stdout') {
    // text: colour and cursor codes removed, for the chat bubbles.
    this._send('agent:output', { runKey, vendor, stream, run, raw: rawText, text: stripAnsi(rawText), html: parseAnsi(rawText) });
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
AgentRunner.MODEL_TEXT = MODEL_TEXT;
AgentRunner.parseAgyModels = parseAgyModels;
AgentRunner.parseEvent = parseEvent;

module.exports = AgentRunner;
