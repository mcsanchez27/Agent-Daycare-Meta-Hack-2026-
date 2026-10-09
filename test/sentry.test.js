const test = require('node:test');
const assert = require('node:assert/strict');
const sentry = require('../src/sentry.js');

test('getInitOptions returns null when SENTRY_DSN is unset or empty', () => {
  const originalDsn = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  assert.equal(sentry.getInitOptions(), null);

  process.env.SENTRY_DSN = '   ';
  assert.equal(sentry.getInitOptions(), null);

  if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn; else delete process.env.SENTRY_DSN;
});

test('getInitOptions returns options when SENTRY_DSN is set', () => {
  const originalDsn = process.env.SENTRY_DSN;
  process.env.SENTRY_DSN = 'https://abc@example.com/1';
  assert.deepEqual(sentry.getInitOptions(), {
    dsn: 'https://abc@example.com/1',
    tracesSampleRate: 1.0
  });

  process.env.SENTRY_DSN = ' https://def@example.com/2  ';
  assert.deepEqual(sentry.getInitOptions(), {
    dsn: 'https://def@example.com/2',
    tracesSampleRate: 1.0
  });

  if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn; else delete process.env.SENTRY_DSN;
});

test('initSentry calls init with options and returns true', () => {
  const originalDsn = process.env.SENTRY_DSN;
  process.env.SENTRY_DSN = 'https://test@example.com/3';

  let calledOptions = null;
  const mockSentry = {
    init: (opts) => { calledOptions = opts; }
  };

  assert.equal(sentry.initSentry(mockSentry), true);
  assert.deepEqual(calledOptions, { dsn: 'https://test@example.com/3', tracesSampleRate: 1.0 });

  if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn; else delete process.env.SENTRY_DSN;
});

test('initSentry returns false when SENTRY_DSN is not set', () => {
  const originalDsn = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;

  const mockSentry = {
    init: () => { assert.fail('init should not be called'); }
  };

  assert.equal(sentry.initSentry(mockSentry), false);
  if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn; else delete process.env.SENTRY_DSN;
});

test('initMain returns false when SENTRY_DSN is not set', () => {
  const originalDsn = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;

  assert.equal(sentry.initMain(), false);
  if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn; else delete process.env.SENTRY_DSN;
});

// For initMain testing we will mock process.versions.electron and the require module.

test('initMain returns false when not running in Electron', () => {
  const originalDsn = process.env.SENTRY_DSN;
  process.env.SENTRY_DSN = 'https://test@example.com/4';

  const originalElectron = process.versions.electron;
  delete process.versions.electron;

  assert.equal(sentry.initMain(), false);

  if (originalElectron !== undefined) process.versions.electron = originalElectron;
  if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn; else delete process.env.SENTRY_DSN;
});

test('initMain returns true when running in Electron and DSN is set', () => {
  const Module = require('node:module');
  const originalLoad = Module._load;

  let sentryInitCalled = false;

  Module._load = function(request, parent, isMain) {
    if (request === '@sentry/electron/main') {
      return {
        init: () => { sentryInitCalled = true; }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const originalDsn = process.env.SENTRY_DSN;
  process.env.SENTRY_DSN = 'https://test@example.com/5';

  const originalElectron = process.versions.electron;
  process.versions.electron = '30.0.0'; // mock electron

  assert.equal(sentry.initMain(), true);
  assert.equal(sentryInitCalled, true);

  if (originalElectron !== undefined) process.versions.electron = originalElectron; else delete process.versions.electron;
  if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn; else delete process.env.SENTRY_DSN;
  Module._load = originalLoad;
});
