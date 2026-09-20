// Flight recorder for Agent Daycare.
//
// Writes one JSON object per line ("JSONL") to logs/latest.log. Every launch of
// the app starts a fresh latest.log; the previous one is renamed with its date
// and kept in the same folder. The file is meant to be read by an AI agent (or
// a human) when diagnosing a problem, so every line carries the same fields:
//
//   ts     ISO timestamp
//   level  debug | info | warn | error
//   source who produced it: "app", "renderer", or an agent id like "claude"
//   run    the agent's run number within this launch (when relevant)
//   msg    the message, with ANSI colour codes stripped and secrets redacted
//   ...    any extra fields the caller attached
//
// Writes are asynchronous (a single append stream) so a chatty agent never
// blocks the Electron main process.

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const LEVELS = ['debug', 'info', 'warn', 'error'];

// Terminal control sequences: OSC (title/colour), CSI (colours, cursor), charset selects.
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Z0-9]/g;

// Obvious secret shapes. Each pattern has exactly one capture group (possibly
// empty) for the prefix that is safe to keep.
const SECRET_PATTERNS = [
  /()sk-ant-[A-Za-z0-9_-]{10,}/g,
  /()sk-[A-Za-z0-9_-]{20,}/g,
  /()xai-[A-Za-z0-9_-]{10,}/g,
  /()gh[pousr]_[A-Za-z0-9]{20,}/g,
  /()AKIA[0-9A-Z]{16}/g,
  /(Bearer\s+)[A-Za-z0-9._-]{16,}/gi,
  /((?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?)[^\s"']{8,}/gi
];

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '$1[REDACTED]');
  }
  return out;
}

function fileStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

class Logger {
  /**
   * @param {object} opts
   * @param {string} opts.dir           folder to write into (created if missing)
   * @param {number} [opts.maxBytes]    rotate latest.log once it grows past this
   * @param {number} [opts.keepArchives] how many old logs to keep in the folder
   * @param {function} [opts.onError]   called once if the log file can't be written
   */
  constructor({ dir, maxBytes = 20 * 1024 * 1024, keepArchives = 10, onError = null }) {
    this.dir = dir;
    this.latestPath = path.join(dir, 'latest.log');
    this.maxBytes = maxBytes;
    this.keepArchives = keepArchives;
    this.onError = onError;
    this.stream = null;
    this.bytes = 0;
    this.broken = false;
    this.minLevel = 0;
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true });
    this._archiveLatest();
    this._openStream();
    this.info('app', 'log opened', { path: this.latestPath });
    return this;
  }

  setMinLevel(level) {
    const idx = LEVELS.indexOf(level);
    if (idx >= 0) this.minLevel = idx;
  }

  _archiveLatest() {
    let stat;
    try {
      stat = fs.statSync(this.latestPath);
    } catch (_) {
      return; // no previous log
    }
    const archived = this._archiveName(stat.mtime);
    try {
      fs.renameSync(this.latestPath, archived);
    } catch (err) {
      this._fail(err);
      return;
    }
    this._pruneArchives();
  }

  _pruneArchives() {
    let names;
    try {
      names = fs.readdirSync(this.dir).filter(n => /^agent-daycare_.*\.log$/.test(n)).sort();
    } catch (_) {
      return;
    }
    const excess = names.length - this.keepArchives;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(this.dir, names[i])); } catch (_) {}
    }
  }

  _openStream() {
    this.bytes = 0;
    let fd;
    try {
      fd = fs.openSync(this.latestPath, 'a');
    } catch (err) {
      this._fail(err);
      return;
    }
    this.stream = fs.createWriteStream(this.latestPath, { fd });
    this.stream.on('error', (err) => this._fail(err));
  }

  _archiveName(date) {
    const base = path.join(this.dir, `agent-daycare_${fileStamp(date)}`);
    let candidate = `${base}.log`;
    for (let n = 1; fs.existsSync(candidate); n++) candidate = `${base}-${n}.log`;
    return candidate;
  }

  _fail(err) {
    if (this.broken) return;
    this.broken = true;
    console.error('[logger] disabled after write failure:', err && err.message);
    if (this.onError) {
      try { this.onError(err); } catch (_) {}
    }
  }

  _rotate() {
    // The old stream keeps flushing into the renamed file, which is what we want.
    const old = this.stream;
    this.stream = null;
    old.end();
    const archived = this._archiveName(new Date());
    try {
      fs.renameSync(this.latestPath, archived);
    } catch (err) {
      this._fail(err);
    }
    this._pruneArchives();
    this._openStream();
    this.info('app', 'log rotated', { previous: archived });
  }

  log(level, source, msg, extra) {
    if (this.broken || !this.stream) return;
    if (LEVELS.indexOf(level) < this.minLevel) return;
    const entry = { ts: new Date().toISOString(), level, source };
    if (extra && extra.run !== undefined) entry.run = extra.run;
    entry.msg = redact(stripAnsi(msg));
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (k === 'run' || v === undefined) continue;
        entry[k] = typeof v === 'string' ? redact(stripAnsi(v)) : v;
      }
    }
    const line = JSON.stringify(entry) + '\n';
    this.bytes += Buffer.byteLength(line);
    this.stream.write(line);
    if (this.bytes > this.maxBytes) this._rotate();
  }

  debug(source, msg, extra) { this.log('debug', source, msg, extra); }
  info(source, msg, extra) { this.log('info', source, msg, extra); }
  warn(source, msg, extra) { this.log('warn', source, msg, extra); }
  error(source, msg, extra) { this.log('error', source, msg, extra); }

  /**
   * Log an Error object with its stack.
   */
  exception(source, err, extra) {
    const e = err || {};
    this.error(source, e.message || String(err), {
      ...extra,
      name: e.name,
      stack: e.stack
    });
  }

  /**
   * Turns a raw byte stream (an agent's stdout/stderr) into one log line per
   * text line. Handles UTF-8 characters split across chunks, "\r\n" endings,
   * and "\r"-only progress spinners (only the final overwrite of a line is kept).
   */
  createLineSink(source, extra = {}) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const emit = (line) => {
      const text = stripAnsi(line.replace(/\r$/, '').split('\r').pop()).trimEnd();
      if (text.trim()) this.log(extra.level || 'info', source, text, extra);
    };
    return {
      push: (chunk) => {
        pending += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
        let idx;
        while ((idx = pending.indexOf('\n')) !== -1) {
          emit(pending.slice(0, idx));
          pending = pending.slice(idx + 1);
        }
      },
      flush: () => {
        pending += decoder.end();
        if (pending) emit(pending);
        pending = '';
      }
    };
  }

  close() {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      const s = this.stream;
      this.stream = null;
      s.end(resolve);
    });
  }
}

module.exports = { Logger, stripAnsi, redact, LEVELS };
