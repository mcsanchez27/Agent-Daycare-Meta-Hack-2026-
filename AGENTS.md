# Agent Daycare: notes for AI agents

## Read this first
- **Active version:** V1, a simple chat window for Antigravity, Claude and Codex. Ticket: **TM-47** in Notion Task Master.
- **Where work happens:** branch `tm-47/v1-simple-chat` until it merges into `master`. Before changing anything, run `git branch --show-current`. If you are not on the branch the ticket names, stop and tell Matt.
- **The old dashboard is gone.** Mascots, sound, roles, hooks, Sentry and Grok were removed in TM-47 Batch 1. The last dashboard version is the git tag `v0-dashboard`. Do not restore any of it unless a ticket asks for it.
- **Work in batches.** One batch at a time, commit with the TM ID and batch number (`TM-47 Batch 2: ...`), then stop and tell Matt what to test.

## How it works
- Each message to an agent is a **one-shot launch** of its CLI (stdin closed, or closed right after Codex's prompt):
  - Antigravity: `agy -p "<prompt>"`
  - Claude: `claude -p "<prompt>"`
  - Codex: `codex exec --skip-git-repo-check -` with the prompt written to stdin (so it never passes through `cmd.exe` when Codex is an npm `codex.cmd` shim)
- There is no memory between launches. The window adds the recent thread to each prompt (`buildPrompt` in `src/renderer/thread.js`: last 20 messages, at most 12,000 characters, app notes left out). `"msg":"launching"` in the log shows the full prompt.
- Replies are stdout only, shown as plain text. stderr is kept and its last lines are shown if the agent fails or says nothing. Send is off for an agent while it is answering.
- Agents talk to each other by **relay**: Matt sends a reply to another agent. No automatic agent-to-agent hops in V1.

## Known facts from the headless check (TM-47 Batch 0, Matt's PC)
- All three answer headless and none hang. Claude ~7s, Codex ~7s, Antigravity ~30s (show a "thinking" state).
- Claude and Antigravity refuse file writes in headless mode. **Codex writes files without asking**, so agents must run in a dedicated chat folder, never a real project.
- Codex on Matt's PC is an npm install (`codex.cmd`). If the configured path doesn't exist, `resolveExecutable` asks `where` (trying `codex.exe` and `codex`, `.exe` first). A `.cmd`/`.bat` shim is run through `cmd.exe` only if its path and every argument pass an allow-list (`launchCommand`); otherwise the launch is refused with a note in the chat.
- Codex prints its whole session plus MCP login errors to stderr. Show stdout as the reply; `CODEX_STDERR_NOISE` filters the rest.

## Logs
- `logs/latest.log` is the current run; older runs are `logs/agent-daycare_<date>_<time>.log` (10 kept, git-ignored).
- One JSON object per line: `ts`, `level`, `source` (`app`, `renderer`, or an agent id), `msg`, plus `run` and `stream` on agent lines. Colour codes are stripped and obvious secrets are `[REDACTED]`.
- Start with `grep '"level":"error"' logs/latest.log`. `"msg":"launching"` shows the exact command, arguments and folder; `"msg":"process exited"` with a non-zero `code` means the CLI failed.

## Settings
`config.json` (project root while developing, git-ignored) holds `workingDir` and `agents.<id>.{path,command}`. It is created with defaults on first run.

The default `workingDir` is the dedicated chat folder `~/AgentDaycare/chat` (created at start-up). A config still pointing at an old dashboard default (the home folder or `~/.gemini/antigravity/scratch/cli-companions`) is moved there and saved; the log says `"msg":"working folder moved to the chat folder"`. Any other folder is left alone.

## Layout
- `src/main.js`: Electron main process, window, IPC, logger setup
- `src/agent-runner.js`: launches the agent CLIs and streams their output
- `src/config.js`: user settings
- `src/logger.js`: the log writer
- `src/preload.js`: the `window.api` bridge between the UI and the main process
- `src/renderer/`: the chat window. `thread.js` is the shared thread as plain data (tested in `test/`), `app.js` draws it (textContent only, never innerHTML), `styles.css`, `index.html`. It streams each reply into a bubble and reports in plain English when an agent fails.

Run `npm test` after any change in `src/`.
