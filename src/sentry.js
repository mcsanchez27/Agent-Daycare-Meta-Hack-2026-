// Sentry init shared by the Electron main process and the Discord-/GUI-free
// smoke script. Errors + default tracing only — no Replay, Profiler, Metrics,
// or logging integrations.

/**
 * Options used for both @sentry/electron/main and @sentry/node smoke runs.
 * @returns {{ dsn: string, tracesSampleRate: number } | null}
 */
function getInitOptions() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || !String(dsn).trim()) {
    return null;
  }
  return {
    dsn: String(dsn).trim(),
    // Enable default performance tracing (errors always on). Keep simple —
    // no Replay / Profiler / Metrics / enableLogs.
    tracesSampleRate: 1.0
  };
}

/**
 * Initialize Sentry with a caller-supplied SDK module (electron/main or node).
 * Skips silently when SENTRY_DSN is unset.
 * @param {{ init: Function }} Sentry
 * @returns {boolean} true if init ran
 */
function initSentry(Sentry) {
  const options = getInitOptions();
  if (!options) {
    return false;
  }
  Sentry.init(options);
  return true;
}

/**
 * Main-process init. Call as early as possible in src/main.js.
 * Loads @sentry/electron/main only when a DSN is present.
 * @returns {boolean}
 */
function initMain() {
  if (!getInitOptions()) {
    return false;
  }
  // Node tests / smoke scripts are not Electron — never load the Electron SDK there
  // (even if SENTRY_DSN is set in the environment).
  if (!process.versions.electron) {
    return false;
  }
  // Required inside so plain-node requires never load the Electron SDK.
  const Sentry = require('@sentry/electron/main');
  return initSentry(Sentry);
}

module.exports = { getInitOptions, initSentry, initMain };
