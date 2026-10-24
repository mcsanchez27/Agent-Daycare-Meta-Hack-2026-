# Agent Daycare: notes for AI agents

## Read this first
- **Active ticket:** TM-60 (Calm UI & Agent Builder) on `tm-60/calm-ui`. TM-59 (V4 crew flow) and TM-57 (V3.1) are merged; Matt's test cases for V3.1 and V4 collect on **TM-58**. **Active version:** V4 on `master`: one-agent and group chats (vendor and model per agent), crew flow, tool steps, vendor sessions, threads in side panel. Tickets TM-47, 53, 54, 55, 57, 59 are Done.
- **Where work happens:** `master` holds everything built so far. Each new ticket gets its own branch off `master` named `tm-<id>/<short-name>`, merged by PR when done. Before changing anything, run `git branch --show-current`. If you are not on the branch the ticket names, stop and tell Matt.
- **The old dashboard is gone.** Mascots, sound, roles, hooks, Sentry and Grok were removed in TM-47 Batch 1. The last dashboard version is the git tag `v0-dashboard`. Do not restore any of it unless a ticket asks for it.
- **Work in batches.** One batch at a time, commit with the TM ID and batch number (`TM-47 Batch 2: ...`), then stop and tell Matt what to test.

## Central Brain & Dynamic Persona Chips (TM-60 Batch 4)
- **Central Brain (`brains/central-brain.md`):** Institutional memory, Mountain Man Studios operating doctrine, workspace boundaries, and `@` / `#` cross-chat collaboration rules. Inherited automatically by *all* agents across all chats.
- **Persona Chips (`brains/<chip>.md`):** Specialized persona chips (Agent Smith, Morpheus, Grok Scout, Lead Architect, Fullstack Engineer, Stitch Prototyper) layered on top of the Central Brain.
- **Dynamic Pointer Resolution (Hot-Reloading):** On every turn, `api.resolveBrains({ personaFile })` reads the brain files directly from disk. Editing `central-brain.md` or any persona chip immediately updates all active and future agents without restarting the app.
- **Session Update Notices:** When resuming an existing vendor session (`--resume`), if brain files on disk were modified since the member's previous turn (`mtime > session.brainMtime`), a structured `[Notice: Central Brain or Persona Chip updated on disk: ...]` preamble is automatically injected.
- **Toolbelt Status:** The Session Sidecar Toolbelt tab displays a prominent Central Brain sync status (`🧠 Central Brain: ● Active across all agents · Synced`) and the member's attached Persona Chip.

## Sidecar Inspector, Webview Preview & Toolbelt (TM-60 Batch 3)
- **Inspector Tabs:** `[Session]`, `[Preview]`, and `[Toolbelt]` tabs in the right-side rail.
- **Expandable Rail:** `⤢` button toggles width between 320px and 55vw for reading tickets or inspecting previews without cramping the main chat.
- **Live Preview:** Webview embedded for testing local dev servers or HTML deliverables directly in-app.
- **Notion Card Glance:** Instant native Calm Obsidian glance for Notion tickets (e.g. TM-58), with checklist states and batch progress.

## Agent Builder, Brains & Grok (TM-60 Batch 2)
- **Grok:** xAI's Grok CLI (`grok`) is added as the 4th vendor (`grok -p --permission-mode acceptEdits --always-approve`), with session resume and Messages-API wire format streaming. Color is `#e2e8f0`.
- **Brain Presets (`brains/`):** Markdown files defining institutional memory, role directives, and boundaries (e.g. `lead-architect.md`, `uiux-prototyper.md`, `fullstack-engineer.md`, `agent-smith.md`, `morpheus.md`, `market-scout.md`). Loaded via `api.listBrains()`.
- **Saved Personas & Custom Builder:** The Chooser modal now includes:
  - **Saved Personas:** One-click summon for specialized teammates (Agent Smith, Morpheus, Grok Scout, Lead Architect, Fullstack Engineer, Stitch Prototyper).
  - **Agent Builder:** Form to forge a custom teammate: choose name, choose engine (Gemini, Claude, Codex, Grok), attach a preset brain or write custom instructions.
  - When a teammate runs, its brain directives are automatically injected into `buildPrompt` in `thread.js`.

## Calm UI & Session Sidecar (TM-60 Batch 1)
- **Calm Obsidian Palette:** Dark obsidian base (`#131314`), surface panel (`#1e1f20`), hairline border dividers (`#282a2e`), royal blue (`#2563eb`) for Matt. Floating capsule prompt composer with quick-send button.
- **Session Sidecar:** Right rail displays live context window token gauges, active models list with vendor dots and roles, Claude rate limit plan meters, and active workspace folder. Threads dock inside the sidecar column when open.
- **Centered Chooser Modal:** Modern card dialog with backdrop blur for vendor, model, crew, persona, and builder selection.

## How it works
- Each message to an agent is a **one-shot launch** of its CLI (stdin closed, or closed right after Codex's prompt):
  - Antigravity: `agy --mode accept-edits -p "<prompt>"` (`-p` takes the next word as the prompt, so flags go before it)
  - Claude: `claude -p --permission-mode acceptEdits --setting-sources project,local --strict-mcp-config "<prompt>"` (TM-59: Matt's user plugins, hooks and MCP servers stay out; a fresh launch reads ~37k tokens instead of ~66k)
  - Codex: `codex exec --skip-git-repo-check --sandbox workspace-write -` with the prompt written to stdin (so it never passes through `cmd.exe` when Codex is an npm `codex.cmd` shim)
- There is no memory between launches. The window adds the recent thread to each prompt (`buildPrompt` in `src/renderer/thread.js`: last 20 messages, at most 12,000 characters, app notes left out). `"msg":"launching"` in the log shows the full prompt.
- Replies are stdout only, shown as plain text. stderr is kept and its last lines are shown if the agent fails or says nothing. Send is off for a chat member while it is answering.
- **Who answers** (TM-54 Batch 3, `routeMessage` in `thread.js`): the first `@Name` in Matt's message, else (in a thread) the agent who wrote the thread's first message, else the chat's own agent. Typing `@` opens a dropdown of the three vendors; one already in the chat is reached by name, one that isn't joins on its default model. Agents bring each other in the same way (`findTarget`).
- The TM-47 relay ("Send to <agent>" buttons) is gone; old relay messages (`relayOf`) still display and go into prompts as "[passed on X's reply]".
- **Stop** sits under a reply while it streams. It kills the process tree (`killTree`: `taskkill /T /F` on Windows, so a `codex.cmd` shim's Codex dies too) and `agent:done` comes back with `stopped: true`. Any partial reply is kept and marked "stopped".

## Access, timeout, names (TM-53)
- **Equal access (Matt's decision):** every agent may write inside the working folder without asking. Antigravity uses `--mode accept-edits`; Claude uses `acceptEdits`; Codex uses the `workspace-write` sandbox. Nothing grants system-wide access.
- **Timeout:** `agents.<id>.timeoutSec` in `config.json` (default 300, kept between 10 and 3600). Past it, the runner stops the agent like Stop (`stopAgent(id, 'timeout')`), and `agent:done` carries `timedOut: true`. The log line is `"msg":"timed out, stopping"`.
- **Names:** `agents.<vendor>.name` in `config.json` is the vendor's display name, the default name for new chat members (TM-54). Each chat member has its own `name`, used everywhere for that member: header chips, bubbles, @, handoff markers and prompts.
- **Gemini (TM-57 Batch 1):** the `antigravity` vendor is shown as "Gemini" (the models the `agy` CLI runs). The vendor id stays `antigravity` in code, config keys and chat files. A `config.json` name still "Antigravity" becomes "Gemini" on load (`RETIRED_NAMES` in `config.js`), and saved members named "Antigravity" or "Antigravity N" are renamed when a chat opens (`renameRetired` in `members.js`). Old message text is not rewritten.

## Crew run and command access (TM-59 Batch 4)
- **Commands:** Claude gets `--allowedTools Bash,PowerShell`; agy gets `--sandbox --dangerously-skip-permissions`; Codex keeps its `workspace-write` sandbox. Matt approved this for the crew flow on 2026-10-23.
- A chat with roles allows 6 handoffs in a row before Matt (`hopLimit` in `thread.js`; others 3). `config.json` timeouts were raised to 900s on Matt's PC.
- Role briefs hand work over as files: `brief.md` (design), `design/*.html` + `design/NOTES.md` from Stitch (UI/UX), then the code (engineering, told to keep everything in the chat folder and never run files from `design/`). Group prompts say to @ only when another agent must act.
- Every CLI's separate messages get a blank line between them.
- **Proven 2026-10-23:** a crew built the habit tracker (brief â†’ 3 Stitch screens + notes â†’ `index.html` with 39 passing headless-Chrome checks) in 14.8 minutes, 4 handoffs, no help.
- **Known limits (Batcave must solve these, not Daycare):** on Windows, Claude's commands aren't fenced (it wrote test files in a temp folder outside the chat folder; an outside write was tested and went through). agy's `--sandbox` blocks writes outside the folder (tested) but not reads: Gemini read `~/.gemini/antigravity-cli/mcp/`, which holds the Stitch API key. Anything an agent reads (guest messages, Stitch output, web pages) can steer what it runs. Real isolation needs a container or a separate Windows user.

## Live tool steps (TM-59 Batch 3)
- `parseEvent` turns tool calls into `steps` ("Reading note.txt", "Running npm test", "â€¦ (failed: not allowed)") via `describeTool`: Claude `tool_use` blocks, Codex `item.started` (command_execution, file_change, mcp_tool_call, web_search), agy `step_update` (ACTIVE, ERROR). The runner sends each as `agent:step` (`onAgentStep` in preload).
- **agy now runs with `--output-format stream-json`** (one event per line: `init` has the conversation id, `result` the reply and usage). The old one-envelope `json` parsing is still accepted.
- While an agent works, its bubble's meta shows the latest step and a list shows the last four. The finished reply keeps up to 50 as `steps` (folded "N steps" under the bubble). A reply that ends with no text says its last step in the "didn't reply" note.
- Codex's separate messages ("I'll checkâ€¦", then the answer) get a blank line between them.
- **Known (found here):** headless agy auto-denies shell commands under `--mode accept-edits` unless `settings.json` has `permissions.allow` rules; Gemini can read and write files and use MCP (Stitch), not run commands.

## Roles and crews (TM-59 Batch 2)
- A member may have `role`: `design`, `uiux` or `engineering` (`ROLES` in `members.js`, each a label and a brief). `buildPrompt` lists group members as "Codex (Design)" and adds "Your role: <label>. <brief>". The chip shows the role; hovering shows the brief. `mergeThreads` and `rejoin` keep it.
- "+ New chat" â†’ **Crew** (`createCrew` in `app.js`, `CREW` in `members.js`): Codex (Design, the owner, so it answers Matt by default), Gemini (UI/UX, told to use its StitchMCP tools) and Claude (Engineering), all on default models. The log says `"msg":"crew created"`.

## Removing an agent (TM-57 Batch 2)
- Every header chip except the chat's own agent has a Ã—. `removeMember` in `app.js` stops it if it's answering, sets `left: true` on the member (kept so its old messages keep their name), and posts "<name> left." The log says `"msg":"agent removed"`.
- A left member is hidden from the header and left out of prompts' member list (`buildPrompt`), but `findTarget` still matches its name: an @ from Matt or an agent (or replying in a thread it started) calls `rejoin`, which clears `left`, `sessions` and `usage` (fresh session) and posts "<name> joined again." The log says `"msg":"agent rejoined"`. `mergeThreads` keeps `left`.

## Debug menu (TM-57 Batch 1)
- The menu bar has File, Edit, View, Window and **Debug** (`setMenu` in `main.js`). Add debug items there.
- **Delete all chatsâ€¦** asks first, stops every running agent, deletes every chat file (`chats.removeAll`, after queued saves finish), then reloads the window. Saves are refused while it runs (`chatsLocked`). The log says `"msg":"all chats deleted"` with a `count`.
- `config.load` writes newly added settings into an existing `config.json`, so they can be edited by hand.

## Chats (TM-53 Batch 2)
- Each chat is one file, `chats/<id>.json` (project root while developing, git-ignored; `userData/chats` when packaged), written through a temp file and a rename (`src/chats.js`). Chat ids are checked against `CHAT_ID` before they touch a path.
- The sidebar lists chats newest first, titled from Matt's first message (`chatTitle`). A new chat isn't saved until something is said in it. The most recent chat opens at start-up.
- Each chat member runs one process at a time. `pending[runKey]` (`<chatId>/<memberId>`) says where its reply lands, even if Matt has switched chats. Members of the same vendor, in one chat or several, run at the same time.
- Saves of one chat are queued in `chats.save` so they run in order (two at once used to share the temp file and could lose a message).
- An unreadable chat file is skipped and logged as `"msg":"chat file could not be read"`; the others still open.

## Chat members and models (TM-54)
- Each chat has its own agents in `chat.thread.members`: `[{ id, vendor, model, name, memory? }]`, the first being the chat's owner (`src/renderer/members.js`). New members get ids `m1`, `m2`, â€¦; their name is the vendor's name, then the model's label, then "<vendor> 2". `addMessage` checks `from`/`to` against the member ids.
- **Old chats** (no `members`) are moved over by `ensureMembers` when opened: one member per vendor that appears, with the vendor id as member id, so old messages still resolve. Nothing is written until the next message.
- "+ New chat" shows a chooser: vendor, then model. Models come from `api.listModels()` (`agent:models`): Antigravity from `agy models` (10s limit, cached), Claude `opus`/`sonnet`/`haiku`, Codex typed (checked against `MODEL_TEXT`). The header shows each member as "name Â· model".
- **"+ Add agent"** in the header: a new agent (vendor, then model), or "From another chatâ€¦" (a chat, then one of its agents). That one joins with `memory: { title, name, text }`, a snapshot of the other chat's newest messages (`memorySnapshot`, â‰¤ 4,000 characters), which its prompts carry as "Background from your earlier chat â€¦". Joining posts a note ("Codex (default model) joined").
- **Runner:** `api.run({ runKey, vendor, model, prompt })` and `api.stop(runKey)`; events `agent:output` and `agent:done` carry `runKey`. The model is passed as `agy --model`, `claude --model` or `codex exec -m`; a `null` model passes nothing. The launch log line has `runKey` and the full `args`.

## Threads and agent-to-agent (TM-53 Batch 3)
- A thread hangs off a main-chat message. Thread messages carry `threadOf` (that message's id); there are no threads inside threads. Matt opens one with the "Thread" button under any main-chat message, or the summary row; it opens in a **side panel** beside the main chat (TM-54 Batch 4), which closes with Ã— or Esc and when switching chats. `app.js` has two views, `main` and `panel`, each with its own list, message box and @ dropdown; drawing and sending functions take the view.
- When an agent's finished reply contains `@Name` for another member, or for a vendor not in the chat (which then joins), `handOff` in `app.js` posts a handoff note (`handoff: {from, to}`, drawn as "Claude â€º Codex Â· Sent to Codex â€º") and launches that agent **in the same view**: the main chat or the thread the reply is in (TM-54 Batch 3; before that, main-chat handoffs opened a thread).
- **Hop limit:** 3 handoffs in a row (`HOP_LIMIT`), counted per view (the main chat, or each thread) since Matt last spoke there (`hopsSinceMatt`); the 4th is refused with a note. A stopped or timed-out reply never hands off, so one Stop ends the chain. The log says `"msg":"handoff"` (with `hop`) and `"msg":"hop limit reached"`.
- In the main chat, a summary row under the thread's first message shows "Claude â‡„ Codex talkingâ€¦" with Stop while it runs, then "N replies Â· who".
- Prompts: a thread prompt holds the main chat up to the thread's first message, then the thread, and ends "<agent> brought you in with this message:" for a handoff. Main-chat prompts include thread messages marked "(in a thread)", inside the same size limit.

## Background asks between chats (TM-54 Batch 5)
- `#<chat title>` (one space after `#` is allowed, since agents write markdown) asks another chat without anyone joining (`findChatMention` in `thread.js`; the longest matching title wins). Typing `#` opens a dropdown of the other chats. Agents' prompts list Matt's 15 newest other chat titles and explain `#`.
- `askChat` in `app.js`: posts an app note with `side: { chatId, chatTitle, asker, question, state, hop, runKey, answer | note }` in the asking chat, drawn as a "Claude â‡„ Codex solo Â· askingâ€¦" row (Stop, Open). It then posts a `from: 'guest'` message (`guest: { chatId, chatTitle, name }`) to the target chat's owner and runs it there. The answer streams into the row.
- `settleSide`: states `answered`, `stopped`, `busy`, `failed`. If an agent asked, it is run again with `buildPrompt(..., { answer })`, which ends "The chat '<title>' answered your question: â€¦ Finish your reply to Matt." When Matt asked, the answer only lands in the row.
- **Several asks at once (TM-57 Batch 3):** every `#chat` in a message is asked, once per chat, in order (`findChatMentions`); with more than one, each chat gets its own part of the text, from its `#` to the next (`splitChatAsks`). An agent's asks share `side.group` (the reply's id) and `side.groupSize`; `settleSide` relaunches the asker only when the whole group has settled, with all the answers (`buildPrompt(â€¦, { answer: [...] })`).
- **No pull-ins while answering (TM-57 Batch 3):** a reply that answers another chat's background ask never hands off, so a guest question can't bring agents into the answering chat. Its own `#` asks still go out (chains).
- Answered asks go into later prompts as "(in the background) X asked the chat 'Y': â€¦ It answered: â€¦". Chains are capped by `hop` (`HOP_LIMIT`). The log has `"msg":"background ask"` and `"msg":"background ask settled"`.

## Merging chats (TM-54 Batch 6)
- "â‡†" on a chat in the list â†’ pick a second chat â†’ `mergeChats` makes a **new** chat "<A> + <B>" (`titleSet`) from `mergeThreads(a, b)` in `thread.js`. That holds both chats' members (each keeps its name unless it clashes, then "<name> 2"; fresh `m1`â€¦ ids) and both histories in time order, renumbered, with `from`/`to`/`relayOf`/`threadOf`/`handoff`/`side.asker` remapped. Both originals are untouched. A note says what it was merged from; the log says `"msg":"chats merged"`.

## Vendor sessions (TM-55 Batch 1)
- Each CLI now runs in JSON output mode and keeps its own session: Claude `--output-format stream-json --verbose` (+ `--resume <id>`), Codex `exec --json` (+ `exec resume â€¦ -c sandbox_mode=workspace-write <id> -`), Antigravity `--output-format json` (+ `--conversation <id>`). `parseEvent(vendor, line)` in `agent-runner.js` pulls out reply text, session id, usage (`inputTokens`, `outputTokens`, Claude's `contextWindow`) and Claude's plan use (`rate_limit_event`: 5-hour and 7-day). These ride on `agent:done`.
- A member keeps `sessions: { main | <threadRootId>: { id, lastId } }` and `usage` in the chat file. On resume, `buildPrompt(â€¦, { since: lastId })` sends no header and only what others said since then. A failed resume (no reply, not stopped) drops the session, posts a note and asks once more, fresh. Session ids must match `SESSION_ID` before they reach a command line.
- **Meter (Batch 2):** each member chip shows its last reply's context use ("67k / 1M" with a fill bar for Claude; "51k tokens" for Codex and Antigravity, which don't report a window). The top of the sidebar (under the app name, TM-57 Batch 3) shows "Claude plan Â· 5h N% Â· 7d N%" from the latest Claude reply, kept in localStorage.
- The "one-shot launch, history rebuilt each time" text above still describes a member's first message, and any member without a session.

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

**A folder per chat (TM-59 Batch 1):** each chat's agents run in `<workingDir>/<chat id>` (`chatFolder` in `agent-runner.js`, from the runKey; a bad id falls back to `workingDir`), created on first use. The header shows it. Vendor sessions made in the old shared folder still resumed in testing.

## Layout
- `src/main.js`: Electron main process, window, IPC, logger setup
- `src/agent-runner.js`: launches the agent CLIs and streams their output
- `src/config.js`: user settings
- `src/chats.js`: saved chats, one JSON file each (keeps `titleSet` and `thread.members`)
- `src/spellcheck.js`: the right-click menu (spelling fixes, Add to dictionary, Cut/Copy/Paste)
- `src/logger.js`: the log writer
- `src/preload.js`: the `window.api` bridge between the UI and the main process
- `src/renderer/`: the chat window. `members.js` is a chat's agents and `thread.js` the shared thread, both plain data (tested in `test/`), `app.js` draws it (textContent only, never innerHTML), `styles.css`, `index.html`. It streams each reply into a bubble and reports in plain English when an agent fails.

Run `npm test` after any change in `src/`.
