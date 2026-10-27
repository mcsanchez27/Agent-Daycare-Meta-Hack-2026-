# Agent Daycare: notes for AI agents

## CI (2026-10-27)
- `.github/workflows/ci.yml` runs `npm ci` and `npm test` with Node 20 on Windows and Ubuntu for pull requests and pushes to `master`. Electron's binary download is skipped for these headless tests.
- The September `codex-notify` EACCES test fix is already in history (`944848e`); the hook module and its tests were later removed in TM-47. Do not restore them to apply that old fix.

## Read this first
- **Active ticket:** TM-60 "Agent Daycare V5 – Org Control" on `tm-60/org-control`: Batch 1 (Matt's Calm UI with Antigravity, reviewed and merged by Claude as PR #54) is done; Batch 2 wires the skills library, Batch 3 the MCP directory, Batch 4 saved agents (see the TM-60 sections below). TM-59 (V4 crew flow) and TM-57 (V3.1) are merged; Matt's test cases for V3.1 and V4 collect on **TM-58**. **Active version:** V4 on `master`: one-agent and group chats (vendor and model per agent), crew flow, tool steps, vendor sessions, threads in side panel. Tickets TM-47, 53, 54, 55, 57, 59 are Done.
- **Where work happens:** `master` holds everything built so far. Each new ticket gets its own branch off `master` named `tm-<id>/<short-name>`, merged by PR when done. Before changing anything, run `git branch --show-current`. If you are not on the branch the ticket names, stop and tell Matt.
- **The old dashboard is gone.** Mascots, sound, roles, hooks, Sentry and Grok were removed in TM-47 Batch 1. The last dashboard version is the git tag `v0-dashboard`. Do not restore any of it unless a ticket asks for it.
- **Work in batches.** One batch at a time, commit with the TM ID and batch number (`TM-47 Batch 2: ...`), then stop and tell Matt what to test.
- **Many tools work here; one filter merges.** Codex, Gemini, Meta's Muse and Spark (hackathon) and Claude all write code in this repo. Whatever you are: work on your own branch (`tm-<id>/<short-name>` off `master`, or off `hackathon/meta-2026` for competition-only work), run `npm test` and keep it green, open a **draft PR** and stop; do not merge. Say in the PR what you ran and what you did not; "verified" means you watched it happen in the app or a test, not that the code looks right. Add a short section to this file for anything the next agent would need to know. Claude Code reviews every PR against the code, resolves conflicts between PRs and merges, in that order; Matt's hands-on pass is tracked on the TM-58 Notion ticket.

## Joins, preview buttons, MCP ticks, Gemini streaming (2026-10-25)
- An agent reply no longer pulls a vendor who is not already in the chat out of prose. `@Name` of someone already here still hands off. `@Name` alone on its own line, for a vendor who is not here, posts a note and waits for Matt to type it, unless his latest message in that view already asked for that vendor (`joinIntent` in `thread.js`). One-on-one prompts no longer list `@Claude` and the rest.
- The Preview tab's hardcoded TM-58 / TM-59 buttons are gone. Preview is an `.html` file or a localhost link from a message. The "Glance Ticket" button on a message is still a link-out card, not a live ticket.
- The Agent Builder offers MCP ticks only for Claude, the only engine that receives servers at launch. Gemini, Codex and Grok show a sentence instead. The Toolbelt for those three says Daycare does not pass servers, and how many that CLI already has.
- Gemini's `stream-json` `text_delta` is shown as it arrives (`agent_response` in `parseEvent`). The closing `result.response` is marked `full` and dropped once any fragment was shown, so the reply is not printed twice. This does not make the model faster. `--effort` and `--model` are still the CLI's own knobs; Daycare does not set an effort. A process that stays open (`--input-format stream-json`) would skip the per-message startup, and that is not built.

## Health sweep (2026-10-25, overnight, after Codex's review)
- **A reply answers the chat as it was when asked.** `ask()` passes `upTo: seenUpTo` to `buildPrompt`, so a message posted to someone else while the brain files were being read can't make `buildPrompt` throw and strand the member as "working". If building still fails, `finishReply` reports it instead of leaving `pending` set.
- **Stop before launch works:** `stopRun(runKey)` in `app.js` ends a reply that hasn't launched yet (`pending[key].launched` is false) and otherwise calls `api.stop`. Every Stop button goes through it.
- **Grok's prompt file is per run** (`.daycare-prompt-<run>.txt`, `promptFileName` in `agent-runner.js`), so two Grok members in one chat don't overwrite each other. A refused launch deletes Claude's MCP temp folder too.
- **Builder:** both Builders share `builderForm()` + `builderMember()`. A member keeps its own `skills` (like `mcp`), and `skillsFor({ own })` puts them in its prompt, so an agent not saved as a teammate still gets them. `saveTeammate` takes an unticked skill or server away again on re-save and uses `teammateId` in `org.js` (a 32-character name used to loop forever).
- **The prompt budget counts the header** (brains and skills) now, not only the history. The log scrubs strings inside arrays and objects (`scrub` in `logger.js`), so a key in `args` or an MCP `env` is `[REDACTED]`.
- **Gone:** `scanAgents`/`agent:scan`/`versionCommand` (never called), `utils/ansi.js` and the `raw`/`html` fields on `agent:output` (the window only ever used `text`).
- **Sidecar gauge** shows the fullest single agent's context (named), not every agent's tokens summed against one window. `renderToolbelt` reads org, skills, directory and CLI lists once per draw. `renderView` draws summary rows only under messages that have a thread. The CSP allows the Preview iframe to load `file:` and `http://localhost:*`; checked live 2026-10-25 over the DevTools port (`npx electron . --remote-debugging-port=9333`, then CDP `Runtime.evaluate`): an `.html` in the chat folder and a localhost page both rendered in the sandboxed iframe.
- **`run()` returns the run number** (false when refused); the window keeps it as `pending.run` and `pendingFor(runKey, run)` drops output, steps and the done event of a superseded launch of the same key, so a late exit can't end a newer reply.
- **A resumed session is kept when the agent used tools but said nothing** (`p.steps.length`); only a reply with no text and no steps counts as a failed resume and gets the fresh retry.
- **Persona deployment counts read every chat** (`renderOrgPersonas` loads the chats not opened yet this session), so "N active agents" is true across all chats, not only the opened ones.
- Deleted: `docs/superpowers/` (Oct 22 planning docs for group chats, long since built) and the stray `chat1/` folder (a test had run `chatFolder` with no `workingDir`; tests set one now).

## Custom instructions (Codex's PR #57, merged 2026-10-25 after the sweep)
- Both Builders have a **Custom instructions** textarea (in `builderForm`), saved as `member.customInstructions` and, on a saved teammate, `org.agents[].customInstructions` plus a `brainText` snapshot (`cleanOrg` keeps both). `mergeThreads` and the Teammates chooser carry them.
- `promptGuidance(member, { centralBrain, personaChip, personaSkills })` in `thread.js` composes the header: Central Brain, persona chip (live text, else the cached `brainText` when the member has a brain file), "Your custom instructions" (or legacy free-text `brainText` when there is no brain file), then each persona skill as "Assigned skill". Duplicate texts appear once. `ask()` now passes persona skills as `personaSkills` instead of appending them to the persona text.
- The resume signature (`brainSig`) covers that whole composed text; when it changes and nothing remains, the notice says "No additional directives remain. Discard the previous additional directives."
- Its test, `test/agent-instructions.test.js`, runs `saveTeammate` and the chooser's restore block out of `app.js` in a vm; it needs `teammates` and `teammateId` in its context.

## Model picker in the Builders (TM-60 Batch 5)
- Both Builders have a Model field (`modelField` in `app.js`) fed by the same `models` the chooser uses (Gemini from `agy models`, Claude's three, Grok's two), "Default" first; Codex has no list, so its model is typed and checked against `MODEL_TEXT`. It refills when the engine changes.
- The pick is saved on the teammate (`org.agents[].model`, checked in `cleanOrg` with `AgentRunner.MODEL_TEXT`) and passed as `model` / `modelLabel` when the teammate is summoned, so the chip reads "Name · haiku" and the launch carries `--model`.

## Saved teammates (TM-60 Batch 4)
- **A saved agent is a persona.** `teammates(org)` in `org.js` = the six built-in `PERSONAS` plus `org.agents` from the Builder (`{ id, name, vendor, role, brainFile, mcp: [ids], skills: [files] }`, cleaned in `cleanOrg`). A member made from one carries `persona: <id>` (`newMember`, kept by `mergeThreads`); `personaIdOf` prefers it over the brain file.
- **The Builder saves** (both the chooser's and Org Control's, "Save as a teammate" on by default): `saveTeammate(cfg)` adds the agent and turns its ticked skills and servers into assignments to it (`org.skills[file].personas`, `org.mcp[id].personas`), so the normal resolution gives them to every member made from it; the member is created with that persona id so it has them from its first turn. `removeTeammate` drops it and those assignment entries (Org Control → Agent Builder → Saved teammates).
- **"+ New chat → Teammates…"** (was "Saved Personas") lists built-ins and saved agents; the "Give to" rows list both as targets. Both Builders also have a Skills grid.

## MCP directory wired (TM-60 Batch 3)
- **The directory file moved:** `mcp-servers.json` now lives beside `config.json` (project root while developing, `userData` when packaged) and is git-ignored, because entries carry commands and may carry keys. Each entry is `{ id, name, description, command, args, env }` or `{ id, name, description, url, headers }`; `cleanServer` in `main.js` keeps only those fields. Handlers: `mcp:list`, `mcp:save`, `mcp:remove`, `mcp:cli-lists`.
- **Assignment** uses the same model as skills: `org.mcp[serverId] = { all, engines, personas }`, plus `member.mcp` (ids picked for that member in the Agent Builder). `mcpFor` in `org.js` resolves a member's servers.
- **Delivery, honestly:** only Claude takes servers per launch: `claudeMcpConfig(servers)` is written by `run()` to `mcp.json` in a fresh private temp folder (owner-only, exclusive create, outside the chat folder) and passed as `--mcp-config <path>` right after `--strict-mcp-config`; the folder is removed when the run ends, so no key sits on the command line, in the launch log or in the chat folder. Gemini, Codex and Grok keep their own global lists; `src/cli-mcp.js` reads them with `agy mcp list`, `codex mcp list`, `grok mcp list` (cached 60 s) so the directory shows which CLI has each server and the Toolbelt shows per member "(not in its CLI yet)". Adding to those CLIs is still done in the CLI. Codex's `-c mcp_servers.*` per-launch override was tried and did not take effect headless.
- **Org Control → MCP Directory:** add by name + command line (or https URL), import entries Gemini has (its list shows full command lines; keys are hidden on screen with `maskSecrets`), a "Give to" row per server, remove. The Agent Builder's capability grid now lists the directory's servers and saves picks as `member.mcp`. The old made-up `TOOLS` catalog and `member.tools` are gone.
- Checked live 2026-10-24: PDF given to Claude and Playwright to all → Claude's launch carried `--mcp-config` and it named both servers' tools.

## Skills library wired (TM-60 Batch 2)
- **TM-60 is now a real ticket** ("Agent Daycare V5 – Org Control"); the Calm UI branch merged as PR #54. Work continues on `tm-60/org-control`.
- Assignment targets are the four **engines** and the **saved personas** (`PERSONAS` in `members.js`); a member inherits what its engine and persona carry. Assignments live in `org.json` beside `config.json` (git-ignored): `{ skills: { "<file>.md": { all, engines: [vendor], personas: [persona id] } } }`, through `org:get` / `org:save` (`cleanOrg` in `main.js` keeps only known engines and sane ids).
- `src/renderer/org.js` (plain data, tested in `test/org.test.js`): `skillsFor({ vendor, persona }, skills, assignments)` → `{ engine, persona }`; `folderFile(vendor)` → `CLAUDE.md` / `AGENTS.md` (Codex) / `GEMINI.md`, none for Grok; `folderText(central, skills)`; `personaIdOf(member)` by brain file; `describeAssignment`.
- **Delivery:** in `ask()`, an engine's skills plus the Central Brain become the folder file for that CLI, passed as `files` to `api.run` and written into the chat folder before every launch (the runner writes only those three names). Codex and Gemini were checked to read `AGENTS.md` / `GEMINI.md` from the folder on their own; Claude reads `CLAUDE.md` (its launch keeps `project` settings). Persona skills are appended to the persona text in the prompt. Grok gets Central Brain and skills in its prompt header.
- **Resumed sessions catch up by signature:** whatever rides in the prompt header (persona text and persona skills; for Grok also the Central Brain and engine skills) is signed (`textSig` in `org.js`) and the signature saved on the member's session as `brainSig`. On resume, if the current text's signature differs (an edit, a new assignment, or a session from before the brains worked), the launch starts with "[Notice: your Central Brain, persona or skills changed. The current text: …]". The old `brainMtime` field is gone. Folder-file engines re-read their file at every launch, so file changes need no notice.
- **Org Control → Skills Library:** each skill has a "Give to" row (All agents, each engine, each persona). The Toolbelt tab shows "⚡ Skills: … (via CLAUDE.md)" per member.
- **Spike result for Batch 3:** Codex's `-c mcp_servers.*` per-launch overrides did not take effect headless, so only Claude gets MCP servers per launch (`--mcp-config`); Codex, Gemini and Grok are show-and-add through their own `mcp` commands.

## TM-60 review (2026-10-24, overnight)
- **Fixed:** `main.js` never required `fs`, so every brains/skills/MCP handler failed inside its `try` and returned nothing: no Central Brain or persona in any prompt, and an empty Org Control. `.org-control` had no `[hidden]` rule and covered the chat. `TOOLS` wasn't pulled into `app.js` (crash on the Toolbelt tab and Agent Builder). Five files had been saved in the wrong text encoding ("…" as "â€¦"). `ask()` set `pending` only after an await, so a quick double send could launch an agent twice. `window.open` and links now go to the system browser (`setWindowOpenHandler` + `will-navigate`), so a page an agent wrote never opens in a window that has `window.api`; the preview iframe lost `allow-same-origin` (the page runs as a stranger; its localStorage is off). A session that never saw the brains catches up on its next resume (`brainMtime` is 0 until a brain was really sent). `mergeThreads` keeps `brain`, `brainText` and `tools`.
- **Grok:** it launches through its npm `grok.cmd`, so the prompt goes in `.daycare-prompt.txt` in the chat folder (`--prompt-file`, deleted on exit) and every argument stays allow-list safe. Output is `--output-format streaming-messages-json`, the same shape as Claude's, read by the same parser. Models seen: grok-4.6, grok-4.5. **It needs `grok login --device-code` once on this PC**; until then every reply is "Not signed in". It runs with `--always-approve` and is not fenced in.
- **Decorative, not wired:** `mcp-servers.json` and the MCP Directory list servers and connect nothing (each CLI uses its own MCP settings: `claude mcp`, `codex mcp`, `agy mcp`). A member's `tools` is a label on the chip, not a capability. The Notion "glance" only links out (`NOTION_LINKS` in `app.js`); the window is not connected to Notion. Their badges now say "listed" / "declared" / "not live".
- `brains/` and `skills/` live in the repo, so editing them in Org Control changes tracked files.

## Organization Control Center (TM-60 Batch 5)
- **Dedicated Hub (`🏛️ Org Control`):** First-class view in the sidebar toggling the main workspace into the Mountain Man Studios Command Center.
- **Master Memory Editor:** Direct in-app markdown editor for `brains/central-brain.md` with instant "Save & Push to All Active Agents" disk hot-reloading.
- **Persona Chips & Deployment Inventory:** Live tracking of all persona chips on disk (`brains/*.md`), showing active deployment counts across chats (e.g. `Agent Smith: Active in 2 chats`), in-app direct editor, and inline "+ Forge New Persona Chip" creator.
- **MCP Directory:** Integration registry (`mcp-servers.json`) cataloging StitchMCP, Notion MCP, GitHub MCP, Playwright MCP, and CLI Terminal, with live tool manifests and "+ Add MCP Server" registration.
- **Skills Library:** Repository of operational playbooks (`skills/*.md`: Security Auditing, Stitch Prototyping, Headless Testing, Notion Sync, Market Scouting), direct editor, and "+ Add Skill" creator.
- **Agent Builder Studio Workbench:** Full fabrication bench embedded inside Org Control to forge teammates with engine, persona chip, toolbelt capabilities, and deploy directly into new mission chats or summon into the current team.

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

## Meta hackathon branch (from 2026-10-24)
- Matt entered Agent Daycare in the **Meta Global AI Developer Hackathon** (Meta + Cerebral Valley, virtual): kickoff Oct 26, submissions due **Nov 4, 9 PM ET**, judging to Nov 8, winners Nov 9. One track per project (Indie or Startup). Builds must use Meta's models and tools through the Meta Model API (Muse Spark, Muse Code, open-weights models); themes "Build for Your World" / "Push the Frontier"; Indie judging is creativity, technical ambition and whether it works.
- **Branch rule:** general work keeps going to `master` through `tm-<id>/…` branches as before. Anything specific to the competition lives on **`hackathon/meta-2026`**, which is merged *from* master regularly and never merged back without Matt saying so. Matt expects very little to be hackathon-only (updated 2026-10-25): a Meta engine, model entries and anything that helps other people use the app belong on `master` too, so default to a `tm-<id>/…` branch and PR to `master`, and keep the hackathon branch for things like submission text or a demo script. Claude Code merges `master` into the hackathon branch after each merge (it was level with `master` on 2026-10-25). Before changing anything, check which branch you are on and whether the change is general or hackathon-only.

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
- **Proven 2026-10-23:** a crew built the habit tracker (brief → 3 Stitch screens + notes → `index.html` with 39 passing headless-Chrome checks) in 14.8 minutes, 4 handoffs, no help.
- **Known limits (Batcave must solve these, not Daycare):** on Windows, Claude's commands aren't fenced (it wrote test files in a temp folder outside the chat folder; an outside write was tested and went through). agy's `--sandbox` blocks writes outside the folder (tested) but not reads: Gemini read `~/.gemini/antigravity-cli/mcp/`, which holds the Stitch API key. Anything an agent reads (guest messages, Stitch output, web pages) can steer what it runs. Real isolation needs a container or a separate Windows user.

## Live tool steps (TM-59 Batch 3)
- `parseEvent` turns tool calls into `steps` ("Reading note.txt", "Running npm test", "… (failed: not allowed)") via `describeTool`: Claude `tool_use` blocks, Codex `item.started` (command_execution, file_change, mcp_tool_call, web_search), agy `step_update` (ACTIVE, ERROR). The runner sends each as `agent:step` (`onAgentStep` in preload).
- **agy now runs with `--output-format stream-json`** (one event per line: `init` has the conversation id, `result` the reply and usage). The old one-envelope `json` parsing is still accepted.
- While an agent works, its bubble's meta shows the latest step and a list shows the last four. The finished reply keeps up to 50 as `steps` (folded "N steps" under the bubble). A reply that ends with no text says its last step in the "didn't reply" note.
- Codex's separate messages ("I'll check…", then the answer) get a blank line between them.
- **Known (found here):** headless agy auto-denies shell commands under `--mode accept-edits` unless `settings.json` has `permissions.allow` rules; Gemini can read and write files and use MCP (Stitch), not run commands.

## Roles and crews (TM-59 Batch 2)
- A member may have `role`: `design`, `uiux` or `engineering` (`ROLES` in `members.js`, each a label and a brief). `buildPrompt` lists group members as "Codex (Design)" and adds "Your role: <label>. <brief>". The chip shows the role; hovering shows the brief. `mergeThreads` and `rejoin` keep it.
- "+ New chat" → **Crew** (`createCrew` in `app.js`, `CREW` in `members.js`): Codex (Design, the owner, so it answers Matt by default), Gemini (UI/UX, told to use its StitchMCP tools) and Claude (Engineering), all on default models. The log says `"msg":"crew created"`.

## Removing an agent (TM-57 Batch 2)
- Every header chip except the chat's own agent has a ×. `removeMember` in `app.js` stops it if it's answering, sets `left: true` on the member (kept so its old messages keep their name), and posts "<name> left." The log says `"msg":"agent removed"`.
- A left member is hidden from the header and left out of prompts' member list (`buildPrompt`), but `findTarget` still matches its name: an @ from Matt or an agent (or replying in a thread it started) calls `rejoin`, which clears `left`, `sessions` and `usage` (fresh session) and posts "<name> joined again." The log says `"msg":"agent rejoined"`. `mergeThreads` keeps `left`.

## Debug menu (TM-57 Batch 1)
- The menu bar has File, Edit, View, Window and **Debug** (`setMenu` in `main.js`). Add debug items there.
- **Delete all chats…** asks first, stops every running agent, deletes every chat file (`chats.removeAll`, after queued saves finish), then reloads the window. Saves are refused while it runs (`chatsLocked`). The log says `"msg":"all chats deleted"` with a `count`.
- `config.load` writes newly added settings into an existing `config.json`, so they can be edited by hand.

## Chats (TM-53 Batch 2)
- Each chat is one file, `chats/<id>.json` (project root while developing, git-ignored; `userData/chats` when packaged), written through a temp file and a rename (`src/chats.js`). Chat ids are checked against `CHAT_ID` before they touch a path.
- The sidebar lists chats newest first, titled from Matt's first message (`chatTitle`). A new chat isn't saved until something is said in it. The most recent chat opens at start-up.
- Each chat member runs one process at a time. `pending[runKey]` (`<chatId>/<memberId>`) says where its reply lands, even if Matt has switched chats. Members of the same vendor, in one chat or several, run at the same time.
- Saves of one chat are queued in `chats.save` so they run in order (two at once used to share the temp file and could lose a message).
- An unreadable chat file is skipped and logged as `"msg":"chat file could not be read"`; the others still open.

## Chat members and models (TM-54)
- Each chat has its own agents in `chat.thread.members`: `[{ id, vendor, model, name, memory? }]`, the first being the chat's owner (`src/renderer/members.js`). New members get ids `m1`, `m2`, …; their name is the vendor's name, then the model's label, then "<vendor> 2". `addMessage` checks `from`/`to` against the member ids.
- **Old chats** (no `members`) are moved over by `ensureMembers` when opened: one member per vendor that appears, with the vendor id as member id, so old messages still resolve. Nothing is written until the next message.
- "+ New chat" shows a chooser: vendor, then model. Models come from `api.listModels()` (`agent:models`): Antigravity from `agy models` (10s limit, cached), Claude `opus`/`sonnet`/`haiku`, Codex typed (checked against `MODEL_TEXT`). The header shows each member as "name · model".
- **"+ Add agent"** in the header: a new agent (vendor, then model), or "From another chat…" (a chat, then one of its agents). That one joins with `memory: { title, name, text }`, a snapshot of the other chat's newest messages (`memorySnapshot`, ≤ 4,000 characters), which its prompts carry as "Background from your earlier chat …". Joining posts a note ("Codex (default model) joined").
- **Runner:** `api.run({ runKey, vendor, model, prompt })` and `api.stop(runKey)`; events `agent:output` and `agent:done` carry `runKey`. The model is passed as `agy --model`, `claude --model` or `codex exec -m`; a `null` model passes nothing. The launch log line has `runKey` and the full `args`.

## Threads and agent-to-agent (TM-53 Batch 3)
- A thread hangs off a main-chat message. Thread messages carry `threadOf` (that message's id); there are no threads inside threads. Matt opens one with the "Thread" button under any main-chat message, or the summary row; it opens in a **side panel** beside the main chat (TM-54 Batch 4), which closes with × or Esc and when switching chats. `app.js` has two views, `main` and `panel`, each with its own list, message box and @ dropdown; drawing and sending functions take the view.
- When an agent's finished reply contains `@Name` for another member already in the chat, `handOff` in `app.js` posts a handoff note (`handoff: {from, to}`, drawn as "Claude › Codex · Sent to Codex ›") and launches that agent **in the same view**. A vendor who is not in the chat is not joined from prose; see the 2026-10-25 joins note above.
- **Hop limit:** 3 handoffs in a row (`HOP_LIMIT`), counted per view (the main chat, or each thread) since Matt last spoke there (`hopsSinceMatt`); the 4th is refused with a note. A stopped or timed-out reply never hands off, so one Stop ends the chain. The log says `"msg":"handoff"` (with `hop`) and `"msg":"hop limit reached"`.
- In the main chat, a summary row under the thread's first message shows "Claude ⇄ Codex talking…" with Stop while it runs, then "N replies · who".
- Prompts: a thread prompt holds the main chat up to the thread's first message, then the thread, and ends "<agent> brought you in with this message:" for a handoff. Main-chat prompts include thread messages marked "(in a thread)", inside the same size limit.

## Background asks between chats (TM-54 Batch 5)
- `#<chat title>` (one space after `#` is allowed, since agents write markdown) asks another chat without anyone joining (`findChatMention` in `thread.js`; the longest matching title wins). Typing `#` opens a dropdown of the other chats. Agents' prompts list Matt's 15 newest other chat titles and explain `#`.
- `askChat` in `app.js`: posts an app note with `side: { chatId, chatTitle, asker, question, state, hop, runKey, answer | note }` in the asking chat, drawn as a "Claude ⇄ Codex solo · asking…" row (Stop, Open). It then posts a `from: 'guest'` message (`guest: { chatId, chatTitle, name }`) to the target chat's owner and runs it there. The answer streams into the row.
- `settleSide`: states `answered`, `stopped`, `busy`, `failed`. If an agent asked, it is run again with `buildPrompt(..., { answer })`, which ends "The chat '<title>' answered your question: … Finish your reply to Matt." When Matt asked, the answer only lands in the row.
- **Several asks at once (TM-57 Batch 3):** every `#chat` in a message is asked, once per chat, in order (`findChatMentions`); with more than one, each chat gets its own part of the text, from its `#` to the next (`splitChatAsks`). An agent's asks share `side.group` (the reply's id) and `side.groupSize`; `settleSide` relaunches the asker only when the whole group has settled, with all the answers (`buildPrompt(…, { answer: [...] })`).
- **No pull-ins while answering (TM-57 Batch 3):** a reply that answers another chat's background ask never hands off, so a guest question can't bring agents into the answering chat. Its own `#` asks still go out (chains).
- Answered asks go into later prompts as "(in the background) X asked the chat 'Y': … It answered: …". Chains are capped by `hop` (`HOP_LIMIT`). The log has `"msg":"background ask"` and `"msg":"background ask settled"`.

## Merging chats (TM-54 Batch 6)
- "⇆" on a chat in the list → pick a second chat → `mergeChats` makes a **new** chat "<A> + <B>" (`titleSet`) from `mergeThreads(a, b)` in `thread.js`. That holds both chats' members (each keeps its name unless it clashes, then "<name> 2"; fresh `m1`… ids) and both histories in time order, renumbered, with `from`/`to`/`relayOf`/`threadOf`/`handoff`/`side.asker` remapped. Both originals are untouched. A note says what it was merged from; the log says `"msg":"chats merged"`.

## Vendor sessions (TM-55 Batch 1)
- Each CLI now runs in JSON output mode and keeps its own session: Claude `--output-format stream-json --verbose` (+ `--resume <id>`), Codex `exec --json` (+ `exec resume … -c sandbox_mode=workspace-write <id> -`), Antigravity `--output-format json` (+ `--conversation <id>`). `parseEvent(vendor, line)` in `agent-runner.js` pulls out reply text, session id, usage (`inputTokens`, `outputTokens`, Claude's `contextWindow`) and Claude's plan use (`rate_limit_event`: 5-hour and 7-day). These ride on `agent:done`.
- A member keeps `sessions: { main | <threadRootId>: { id, lastId } }` and `usage` in the chat file. On resume, `buildPrompt(…, { since: lastId })` sends no header and only what others said since then. A failed resume (no reply, not stopped) drops the session, posts a note and asks once more, fresh. Session ids must match `SESSION_ID` before they reach a command line.
- **Meter (Batch 2):** each member chip shows its last reply's context use ("67k / 1M" with a fill bar for Claude; "51k tokens" for Codex and Antigravity, which don't report a window). The top of the sidebar (under the app name, TM-57 Batch 3) shows "Claude plan · 5h N% · 7d N%" from the latest Claude reply, kept in localStorage.
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
