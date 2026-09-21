#!/usr/bin/env node
// Discord-free / GUI-free Sentry smoke: inits via the shared helper with
// @sentry/node (declared alongside @sentry/electron), captures a unique exception,
// flushes, prints the event id. Requires SENTRY_DSN in the environment.
//
// Usage: SENTRY_DSN=... node scripts/sentry-smoke.js (or put it in .env)

require('../src/env').load();
const Sentry = require('@sentry/node');
const { initSentry } = require('../src/sentry');

async function main() {
  const ok = initSentry(Sentry);
  if (!ok) {
    console.error('SENTRY_DSN is not set; refusing to run smoke without a DSN.');
    process.exit(1);
  }

  const marker = `agent-daycare-sentry-smoke-${Date.now()}`;
  const eventId = Sentry.captureException(new Error(marker));
  const flushed = await Sentry.flush(10000);

  console.log(JSON.stringify({ marker, eventId, flushed }, null, 2));
  if (!eventId || !flushed) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
