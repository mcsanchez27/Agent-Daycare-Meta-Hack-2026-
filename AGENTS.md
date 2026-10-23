# Agent Daycare: notes for AI agents

## Read this first
- **Active version:** V1, a simple chat window for Antigravity, Claude and Codex. Tickets in Notion Task Master: **TM-47** (V1, validated on Windows) and **TM-53** (V1.1: timeouts, access, chat list, agent threads).
- **Where work happens:** one branch, `tm-53/v1.1` (draft PR #51 into `master`). It contains all of TM-47; `tm-47/v1-simple-chat` and its PR #50 are retired. Before changing anything, run `git branch --show-current`. If you are not on `tm-53/v1.1`, stop and tell Matt.
- **The old dashboard is gone.** Mascots, sound, roles, hooks, Sentry and Grok were removed in TM-47 Batch 1. The last dashboard version is the git tag `v0-dashboard`. Do not restore any of it unless a ticket asks for it.
- **Work in batches.** One batch at a time, commit with the TM ID and batch number (`TM-47 Batch 2: ...`), then stop and tell Matt what to test.

## How it works
- Each message to an agent is a **one-shot launch** of its CLI (stdin closed, or closed right after Codex's prompt):
  - Antigravity: `agy --mode accept-edits -p "<prompt>"` (`-p` takes the next word as the prompt, so flags go before it)
  - Claude: `claude -p --permission-mode acceptEdits "<prompt>"`
  - Codex: `codex exec --skip-git-repo-check --sandbox workspace-write -` with the prompt written to stdin (so it never passes through `cmd.exe` when Codex is an npm `codex.cmd` shim)
- There is no memory between launches. The window adds the recent thread to each prompt (`buildPrompt` in `src/renderer/thread.js`: last 20 messages, at most 12,000 characters, app notes left out). `"msg":"launching"` in the log shows the full prompt.
- Replies are stdout only, shown as plain text. stderr is kept and its last lines are shown if the agent fails or says nothing. Send is off for an agent while it is answering.
- Agents talk to each other by **relay**: each finished reply has "Send to <agent>" buttons. The relayed message is Matt's, with `relayOf` set; its prompt ends "Matt passed you this reply from <agent>. Respond to it:" and the text goes in once.
- Agents also bring each other in with **@Name** (TM-53 Batch 3, see Threads below).
- **Stop** sits under a reply while it streams. It kills the process tree (`killTree`: `taskkill /T /F` on Windows, so a `codex.cmd` shim's Codex dies too) and `agent:done` comes back with `stopped: true`. Any partial reply is kept and marked "stopped".

## Access, timeout, names (TM-53)
- **Equal access (Matt's decision):** every agent may write inside the working folder without asking. Antigravity uses `--mode accept-edits`; Claude uses `acceptEdits`; Codex uses the `workspace-write` sandbox. Nothing grants system-wide access.
- **Timeout:** `agents.<id>.timeoutSec` in `config.json` (default 300, kept between 10 and 3600). Past it, the runner stops the agent like Stop (`stopAgent(id, 'timeout')`), and `agent:done` carries `timedOut: true`. The log line is `"msg":"timed out, stopping"`.
- **Names:** `agents.<id>.name` in `config.json` renames an agent everywhere: picker, bubbles, relay buttons and prompts. Later handoff markers must read the name from the same place, never a hard-coded one.
- `config.load` writes newly added settings into an existing `config.json`, so they can be edited by hand.

## Chats (TM-53 Batch 2)
- Each chat is one file, `chats/<id>.json` (project root while developing, git-ignored; `userData/chats` when packaged), written through a temp file and a rename (`src/chats.js`). Chat ids are checked against `CHAT_ID` before they touch a path.
- The sidebar lists chats newest first, titled from Matt's first message (`chatTitle`). A new chat isn't saved until something is said in it. The most recent chat opens at start-up.
- Each agent runs one process at a time, whichever chat asked. `pending[agentId].chatId` says where its reply lands, even if Matt has switched chats. Send to that agent is off everywhere until it finishes.
- An unreadable chat file is skipped and logged as `"msg":"chat file could not be read"`; the others still open.

## Threads and agent-to-agent (TM-53 Batch 3)
- A thread hangs off a main-chat message. Thread messages carry `threadOf` (that message's id); there are no threads inside threads. Matt opens one with "Reply in thread" or the summary row, and "← Back to chat" closes it. The one message box posts into whichever view is open.
- When an agent's finished reply contains `@Name` for another agent (current names, `findMention` in `thread.js`), `handOff` in `app.js` posts a handoff note (`handoff: {from, to}`, drawn as "Claude › Codex · Sent to Codex ›") and launches that agent in the thread. A reply in the main chat starts a thread under itself.
- **Hop limit:** 3 handoffs in a row (`HOP_LIMIT`), counted since Matt last spoke in the thread (`hopsSinceMatt`); the 4th is refused with a note. A stopped or timed-out reply never hands off, so one Stop ends the chain. The log says `"msg":"handoff"` (with `hop`) and `"msg":"hop limit reached"`.
- In the main chat, a summary row under the thread's first message shows "Claude ⇄ Codex talking…" with Stop while it runs, then "N replies · who".
- Prompts: a thread prompt holds the main chat up to the thread's first message, then the thread, and ends "<agent> brought you in with this message:" for a handoff. Main-chat prompts include thread messages marked "(in a thread)", inside the same size limit.

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
- `src/chats.js`: saved chats, one JSON file each
- `src/logger.js`: the log writer
- `src/preload.js`: the `window.api` bridge between the UI and the main process
- `src/renderer/`: the chat window. `thread.js` is the shared thread as plain data (tested in `test/`), `app.js` draws it (textContent only, never innerHTML), `styles.css`, `index.html`. It streams each reply into a bubble and reports in plain English when an agent fails.

Run `npm test` after any change in `src/`.
