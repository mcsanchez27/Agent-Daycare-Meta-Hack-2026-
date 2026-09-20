# Notes for AI agents working in this repo

## Where the logs are

The app writes a flight-recorder log every time it runs:

- **`logs/latest.log`** — the most recent (or currently running) launch. Read this first.
- `logs/agent-daycare_<date>_<time>.log` — earlier launches, newest last. At most 10 are kept.

The folder is git-ignored. If `logs/` doesn't exist, the app hasn't been started since the logger was added.

## Format

One JSON object per line (JSONL). Every line has:

| field | meaning |
|---|---|
| `ts` | ISO-8601 timestamp |
| `level` | `debug`, `info`, `warn`, or `error` |
| `source` | `app` (Electron main process), `renderer` (the UI window), or an agent id: `antigravity`, `claude`, `codex`, `grok` |
| `msg` | the message; terminal colour codes are stripped and obvious secrets replaced with `[REDACTED]` |
| `run` | present on agent lines: increments each time that agent is (re)launched during this app session |
| `stream` | present on agent output lines: `stdout` or `stderr` |
| `stack` | present on `error` lines that came from a thrown `Error` |

Other fields (`exe`, `args`, `code`, `snippet`, `ipc`, ...) are attached where they help.

## How to use it when diagnosing a problem

1. Look at `error` and `warn` lines first: `grep '"level":"error"' logs/latest.log`
2. Lines with `source: "app"` or `"renderer"` are bugs **in this app**. Lines with an agent id are what that CLI agent printed — usually not this app's fault, but useful context.
3. `"msg":"launching"` lines show the exact executable, arguments and working directory used to start an agent. If an agent misbehaves, compare these to how it works when run by hand.
4. `"msg":"prompt detected, alerting user"` records every time the `!` alert fired and the `snippet` that triggered it — the place to look when the alert fires wrongly or not at all.
5. `"msg":"process exited"` with a non-zero `code` means the agent's process failed; the preceding `stderr` lines from the same `run` usually say why.

## Project layout

- `src/main.js` — Electron main process: window, IPC, logger setup, crash capture
- `src/agent-runner.js` — launches agent CLIs, streams their output, detects prompts
- `src/logger.js` — the log writer described above (unit tests in `test/`)
- `src/preload.js` — the bridge (`window.api`) between the UI and the main process
- `src/renderer/` — the UI: `app.js` (behaviour), `mascots.js` (pixel-art sprites), `audio.js`, `styles.css`, `index.html`

Run `npm test` after changing `src/logger.js`.
