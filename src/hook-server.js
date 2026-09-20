// Tiny local HTTP listener that agent CLIs report into via their hook systems.
//
// Claude Code (and later Codex) can run a command whenever something happens:
// a session starts, a tool is about to run, it needs permission, it finishes a
// turn. We install `curl` commands that POST that event JSON here, so the
// mascots reflect what the agent actually said instead of what we guessed
// from its terminal text.
//
// Security: binds to 127.0.0.1 only, rejects anything with an Origin header
// (browsers always send one; curl never does) and any Host that isn't
// loopback, so a web page can't poke it via DNS rebinding.

const http = require('http');

const DEFAULT_PORT = 48211;
const MAX_BODY_BYTES = 64 * 1024;
const PATH_RE = /^\/agent-daycare\/hook\/([a-z0-9_-]+)\/?$/;

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

class HookServer {
  /**
   * @param {object} opts
   * @param {(agentId: string, event: object) => void} opts.onEvent
   * @param {object} opts.logger
   * @param {number} [opts.port]    0 picks a free port (tests); default 48211
   */
  constructor({ onEvent, logger, port = DEFAULT_PORT }) {
    this.onEvent = onEvent;
    this.log = logger;
    this.port = port;
    this.server = null;
  }

  get url() {
    const addr = this.server && this.server.address();
    return addr ? `http://127.0.0.1:${addr.port}` : null;
  }

  hookUrl(agentId) {
    return `${this.url}/agent-daycare/hook/${agentId}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', (err) => {
        this.log.error('app', 'hook listener failed to start', { port: this.port, error: err.message, code: err.code });
        reject(err);
      });
      this.server.listen(this.port, '127.0.0.1', () => {
        this.log.info('app', 'hook listener ready', { url: this.url });
        resolve(this.url);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  _handle(req, res) {
    const reject = (status, why) => {
      this.log.warn('app', 'hook request rejected', { status, why, method: req.method, url: req.url });
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(why);
    };

    if (req.headers.origin !== undefined) return reject(403, 'browser requests are not allowed');
    if (!isLoopbackHost(req.headers.host)) return reject(403, 'loopback only');

    // A GET on the root is a handy "is it running?" check.
    if (req.method === 'GET' && (req.url === '/' || req.url === '/agent-daycare')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, app: 'agent-daycare' }));
    }

    const match = PATH_RE.exec(req.url || '');
    if (!match) return reject(404, 'unknown path');
    if (req.method !== 'POST') return reject(405, 'POST only');
    const agentId = match[1];

    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooBig = true;
        reject(413, 'body too large');
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      let event = {};
      if (body.trim()) {
        try {
          event = JSON.parse(body);
        } catch (err) {
          return reject(400, 'body must be JSON');
        }
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return reject(400, 'body must be a JSON object');

      try {
        this.onEvent(agentId, event);
      } catch (err) {
        this.log.exception('app', err, { phase: 'hook onEvent', agentId });
      }
      res.writeHead(204);
      res.end();
    });
  }
}

module.exports = { HookServer, DEFAULT_PORT, isLoopbackHost };
