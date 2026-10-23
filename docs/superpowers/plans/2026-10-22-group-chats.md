# Agent Daycare V2: Group Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-agent chats picked by vendor and model, grown into group chats with @, plus a thread side panel, spellcheck suggestions and chat renaming.

**Architecture:** The pure modules (`src/renderer/thread.js`, the new `src/renderer/members.js`, and `src/spellcheck.js`) hold all the logic and are tested with `node --test`. `app.js` draws the window and calls them. The runner launches one process per run, keyed by `<chatId>/<memberId>`.

**Tech Stack:** Electron 45, plain JS (no build step), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-group-chats-design.md` (TM-54).

## Global Constraints

- Branch `tm-53/v1.1`. Commit as `TM-54 Batch N: <what>`, push, then stop and give Matt a test list on TM-54. One batch at a time.
- The renderer uses `textContent` only, never `innerHTML`.
- Members live in `chat.thread.members`: `[{ id, vendor, model, name, memory? }]`. The first member is the owner. New member ids are `m1`, `m2`, …; moved-over chats use the vendor id as the member id.
- Vendors: `antigravity`, `claude`, `codex`. Model flags: `agy --model <m>`, `claude --model <m>`, `codex exec -m <m>`. A `null` model means no flag.
- `HOP_LIMIT` = 3 per view (the main chat, or each thread), counted since Matt last spoke in that view.
- Memory snapshot ≤ 4,000 characters, newest kept. Prompt history ≤ 20 messages and 12,000 characters, memory included.
- Antigravity's model list comes from `agy models` (lines `id<TAB>label`), with a 10s limit; on failure only "Default" is offered. Claude: Default, `opus`, `sonnet`, `haiku`. Codex: Default, or typed text.
- A typed model must match `/^[A-Za-z0-9_.:-]{1,64}$/`, so it passes the `.cmd` argument allow-list.
- Run `npm test` after every change in `src/`. Check each batch in the real app over `--remote-debugging-port=9223` with the real CLIs before committing.

## Review Focus

- **Old chats** (no `members`, messages `from: 'claude'`, relay messages): open, read and continue without errors. → Task 3 test `moved-over chats keep their senders`.
- **@ names, case and punctuation:** `@sonnet,` matches the member "Sonnet"; `email@codex.com` matches nothing. → Task 7 test `routes by the first @member`.
- **Two members of one vendor running at once:** Stop on one leaves the other running. → Task 4 test `two runs of one vendor are separate`.
- **A big memory snapshot:** the prompt stays within 12,000 characters of history. → Task 7 test `memory counts toward the size limit`.
- **A typed Codex model with spaces or `&`:** refused before launch with a note, never passed to cmd.exe. → Task 5 test `typed models are checked`.

---

## Batch 1: Spellcheck and rename

### Task 1: Spellcheck suggestions

**Files:**
- Create: `src/spellcheck.js`
- Modify: `src/main.js` (in `createWindow`, after the `console-message` handler)
- Test: `test/spellcheck.test.js`

**Interfaces:**
- Produces: `spellMenu(params) -> Array<{ label?, role?, type?, action? }> | null`. `params` is Electron's `context-menu` params (`misspelledWord`, `dictionarySuggestions`, `isEditable`). `action` is `{ replace: word }` or `{ addWord: word }`; `main.js` turns actions into `click` handlers (`webContents.replaceMisspelling`, `session.addWordToSpellCheckerDictionary`).

- [ ] **Step 1: Write the failing tests** in `test/spellcheck.test.js`:
  - `suggestions come first, then Add to dictionary`: params `{ misspelledWord: 'teh', dictionarySuggestions: ['the','tea','ten','tech','tel','toe'], isEditable: true }` → the first 5 items have labels `the,tea,ten,tech,tel` with actions `{replace:…}`; then a separator; then `{ label: 'Add to dictionary', action: { addWord: 'teh' } }`; then a separator; then the roles `cut`, `copy`, `paste`.
  - `a misspelling with no suggestions says so`: `dictionarySuggestions: []` → the first item is `{ label: 'No suggestions', enabled: false }`.
  - `plain text gets Copy only`: `{ misspelledWord: '', isEditable: false, selectionText: 'x' }` → `[{ role: 'copy' }]`.
  - `nothing to offer returns null`: `{ misspelledWord: '', isEditable: false, selectionText: '' }` → `null`.
- [ ] **Step 2:** `npm test` → those tests fail (module missing).
- [ ] **Step 3:** Implement `spellMenu`. In `main.js`: `mainWindow.webContents.on('context-menu', (_, params) => { const t = spellMenu(params); if (t) Menu.buildFromTemplate(t.map(toItem)).popup(); })`, where `toItem` maps `action.replace` → `click: () => wc.replaceMisspelling(w)` and `action.addWord` → `click: () => wc.session.addWordToSpellCheckerDictionary(w)`.
- [ ] **Step 4:** `npm test` → all pass. In the real app, type "teh" and right-click → the menu shows "the".

### Task 2: Rename chats

**Files:**
- Modify: `src/chats.js` (`clean`), `src/renderer/app.js` (`renderChatList`, `post`), `src/renderer/styles.css`
- Test: `test/chats.test.js`

**Interfaces:**
- Produces: the chat field `titleSet: boolean` (saved). `post()` updates `chat.title` from `chatTitle()` only when `!chat.titleSet`.

- [ ] **Step 1: Write the failing test** `a renamed chat keeps its title and the flag`: save `{ id:'a', title:'Mine', titleSet:true, thread:{messages:[],nextId:1} }`, load it → `title === 'Mine'` and `titleSet === true`. A chat saved without the flag loads with `titleSet === false`.
- [ ] **Step 2:** `npm test` → fails.
- [ ] **Step 3:** `clean()` keeps `titleSet: chat.titleSet === true`, and also keeps `thread.members` when it's an array (needed by Task 3). In `renderChatList`, each item gets a `✎` button and a double-click handler that swap the title span for an `<input>`. Enter → set `title` (trimmed, ≤ 60 characters), `titleSet = true`, `persist`, re-render. Esc → re-render. An empty title → `titleSet = false`, `title = chatTitle(thread)`.
- [ ] **Step 4:** `npm test` → pass. In the real app, rename, restart → the name stays, and a new message doesn't overwrite it.
- [ ] **Step 5:** Commit `TM-54 Batch 1: spellcheck suggestions and chat renaming`, push, then log a test list on TM-54.

---

## Batch 2: One-agent chats

### Task 3: Members in the thread

**Files:**
- Create: `src/renderer/members.js` (UMD, like `thread.js`; loaded before `thread.js` in `index.html`)
- Modify: `src/renderer/thread.js`
- Test: `test/members.test.js`, `test/thread.test.js`

**Interfaces:**
- Produces (`members.js`): `VENDORS = ['antigravity','claude','codex']`; `newMember(members, { vendor, model }, { vendorNames, modelLabel }) -> member` (picks the next `mN` id and a unique name: vendor name, then `modelLabel`, then "`<vendor name> 2`", "… 3"); `ensureMembers(thread, vendorNames) -> thread` (moves an old chat over; does nothing if `members` exists); `memberById(thread, id)`.
- Produces (`thread.js`): `createThread(members = [])`. `addMessage` checks `from`/`to`/`relayOf`/`handoff` against `thread.members` ids instead of `AGENT_IDS`. `buildPrompt(thread, memberId, { threadOf, maxMessages, maxChars })` takes names from members. The header names the member's vendor and model (`model or "default"`); one-on-one wording when there's 1 member, group wording otherwise (spec §Prompts). `findMention(text, selfId, members)` matches member names. `hopsSinceMatt(thread, rootId)` is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `newMember names: vendor, then model, then number`: in a chat with Claude(sonnet), adding claude/opus → name "Opus"; adding claude/null → "Claude 2"; ids `m1`, `m2`, `m3`.
  - `moved-over chats keep their senders`: a thread with no `members`, messages from `claude` and `codex` plus a relay → after `ensureMembers`, members are `[{id:'claude',vendor:'claude',model:null,name:'Claude'}, {id:'codex',…}]` (owner = first agent sender), and `buildPrompt(t,'claude')` still works with the relay line.
  - `one-on-one header`: 1 member Claude/opus → the prompt starts `You are Claude (claude, model opus), chatting one-on-one with Matt.` and contains `@Antigravity, @Claude or @Codex`.
  - `group header lists members`: 2 members → it contains both names, and doesn't contain "one-on-one".
  - Update the existing `thread.test.js` tests to build threads with members (`createThread(threeMembers)`, where `threeMembers` uses the vendor ids as ids), so they keep their meaning.
- [ ] **Step 2:** `npm test` → the new tests fail.
- [ ] **Step 3:** Implement. `AGENT_IDS` stays exported as `VENDORS` for the runner and config.
- [ ] **Step 4:** `npm test` → all pass.

### Task 4: Runs keyed by run, with a model

**Files:**
- Modify: `src/agent-runner.js`, `src/main.js` (IPC), `src/preload.js`
- Test: `test/agent-runner.test.js`, `test/preload.test.js`

**Interfaces:**
- Produces: `runner.run({ runKey, vendor, model, prompt }) -> boolean`, `runner.stop(runKey, reason = 'user')`, and `_buildAgentArgs(vendor, prompt, model) -> { args, stdin }`. Events: `agent:output { runKey, stream, text }`, `agent:done { runKey, code, stopped, timedOut, timeoutSec }`. IPC: `agent:run`, `agent:stop { runKey }`. Preload: `api.run(req)`, `api.stop(runKey)`, `onAgentOutput`, `onAgentDone`. `agent:status` and `sendInput` are removed. `this.processes` is keyed by `runKey`; vendor settings stay in `this.agents`.

- [ ] **Step 1: Write the failing tests:**
  - `model flags per vendor`: `_buildAgentArgs('claude','hi','opus').args` = `['-p','--permission-mode','acceptEdits','--model','opus','hi']`; `('antigravity','hi','gemini-4-argon-high')` = `['--mode','accept-edits','--model','gemini-4-argon-high','-p','hi']`; `('codex','hi','gpt-5')` = `['exec','--skip-git-repo-check','--sandbox','workspace-write','-m','gpt-5','-']` with stdin `'hi'`. A `null` model adds no flag.
  - `two runs of one vendor are separate`: start two fake processes for the keys `a/m1` and `b/m1` (vendor claude, with `_spawnAgentProcess` stubbed as the existing timeout tests do); `stop('a/m1')` → only the first is killed, and `processes.has('b/m1')` stays true.
  - Rewrite the existing runner, timeout and Stop tests to use `run`/`stop`/`runKey`.
- [ ] **Step 2:** `npm test` → fails.
- [ ] **Step 3:** Implement. The Codex stderr filter is chosen by `vendor`. The log `source` is the vendor; `run` and `runKey` go on each line.
- [ ] **Step 4:** `npm test` → pass.

### Task 5: Model lists

**Files:**
- Modify: `src/agent-runner.js` (export `parseAgyModels`, add `listModels()`), `src/main.js` (`agent:models`), `src/preload.js` (`api.listModels()`)
- Test: `test/agent-runner.test.js`

**Interfaces:**
- Produces: `parseAgyModels(text) -> [{ id, label }]`; `runner.listModels() -> Promise<{ antigravity: [{id,label}], claude: [...], codex: [] }>`, cached after the first call. `MODEL_TEXT = /^[A-Za-z0-9_.:-]{1,64}$/` (exported).

- [ ] **Step 1: Write the failing tests:**
  - `agy model list is parsed`: `"Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\n"` → `[{ id:'gemini-4-argon-high', label:'Gemini 4 Argon (High)' }]`.
  - `typed models are checked`: `MODEL_TEXT` accepts `gpt-5.1-codex`, and rejects `gpt 5`, `a&b` and the empty string.
- [ ] **Step 2:** `npm test` → fails.
- [ ] **Step 3:** Implement. Claude's list is fixed: `[{id:'opus',label:'Opus'},{id:'sonnet',label:'Sonnet'},{id:'haiku',label:'Haiku'}]`. `run()` refuses a model that fails `MODEL_TEXT`, emitting a stderr note and returning false.
- [ ] **Step 4:** `npm test` → pass.

### Task 6: Window: one-agent chats

**Files:**
- Modify: `src/renderer/app.js`, `src/renderer/index.html` (add a `#chooser` section in `.chat`, and the `members.js` script), `src/renderer/styles.css`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: `pending` keyed by `runKey` (`<chatId>/<memberId>`), with `{ chatId, memberId, threadOf, text, stderr, started }`. The picker row lists the open chat's members. In Batch 3 it's replaced by @.

- [ ] **Step 1:** "+ New chat" shows the chooser (3 vendor buttons → that vendor's models + "Default", plus a text field for Codex checked with `MODEL_TEXT`). Picking one creates the chat with `createThread([newMember([], …)])` and opens it. `openChat` calls `ensureMembers` on load. Sending goes to the picked member: `api.run({ runKey, vendor, model, prompt })`. Stop and "Send to" use member ids and names. The "busy" note names the member and its chat.
- [ ] **Step 2:** `npm test` → pass. In the real app: a new Claude/sonnet chat → Claude answers, and the launch log shows `--model sonnet`. An old chat opens and continues with its three members. Two Claude chats answer at the same time.
- [ ] **Step 3:** Commit `TM-54 Batch 2: one-agent chats with vendor and model`, push, then a test list on TM-54.

---

## Batch 3: @ and group chat

### Task 7: Routing, joining and memory (pure)

**Files:**
- Modify: `src/renderer/thread.js`, `src/renderer/members.js`
- Test: `test/thread.test.js`, `test/members.test.js`

**Interfaces:**
- Produces: `findMention(text, selfId, members, vendorNames) -> { memberId } | { vendor } | null` (a member name first; an absent vendor's name gives `{ vendor }`); `routeMessage(thread, text, threadOf) -> { memberId } | { vendor }` (the first @, otherwise the thread root's author if it's an agent, otherwise the owner); `memorySnapshot(thread, title, maxChars = 4000) -> string`; `newMember(..., { memory })` stores memory. `buildPrompt` puts `Background from your earlier chat '<title>':\n<memory>` before the history, and counts it toward `maxChars`. `addMessage` allows `handoff` without `threadOf` (handoffs in the main chat).

- [ ] **Step 1: Write the failing tests:**
  - `routes by the first @member`: members Claude, Sonnet → `routeMessage(t,'hey @sonnet, thoughts?',null)` → `{memberId:'m2'}`; `'email@codex.com'` → the owner; `'@Codex look'` with no Codex member → `{vendor:'codex'}`.
  - `thread default is the root's author`: root from m2 → a plain message in the thread → `m2`; root from Matt → the owner.
  - `memory counts toward the size limit`: a member with a 4,000-character memory and 20 × 1,000-character messages → the history section plus memory ≤ 12,000 characters, and the newest message is kept.
  - `snapshot keeps the newest`: 50 messages → the snapshot ends with the last message and is ≤ 4,000 characters.
- [ ] **Step 2:** `npm test` → fails. **Step 3:** Implement. **Step 4:** `npm test` → pass.

### Task 8: Window: @, Add agent, handoffs in the main chat

**Files:**
- Modify: `src/renderer/app.js`, `src/renderer/index.html` (a member chips bar with "+ Add agent" in `.top`; a `#mention-popup` above the message box), `src/renderer/styles.css`

- [ ] **Step 1:** Remove the picker row and the "Send to" buttons. `send()` uses `routeMessage`; `{vendor}` → `newMember` with a null model, a "joined" note, then the run. Typing `@` opens a dropdown of the **three vendors** (Matt, 2026-10-22: keep it to our 3; picking or typing one reaches that vendor's member if it's in the chat, else a fresh one joins on the default model), filtered by the typed prefix; arrows, Enter or Tab insert `@Name `, Esc closes. Members with other names are reached by typing their name. "+ Add agent" → "New agent" (the chooser from Task 6) or "From another chat" (chat list → its members → `newMember` with `memory: memorySnapshot(otherThread, otherTitle)`; the other chat is loaded with `api.loadChat`). `handOff` uses `findMention(…members…)` in the main chat or a thread, joins absent vendors, and counts hops per view.
- [ ] **Step 2:** `npm test` → pass. In the real app: @ a member; @Codex in a Claude-only chat adds Codex; add an agent from another chat → its prompt contains "Background from your earlier chat"; the hop limit holds in the main chat.
- [ ] **Step 3:** Commit `TM-54 Batch 3: @ mentions and group chats`, push, then a test list on TM-54.

---

## Batch 4: Thread side panel

### Task 9: Side panel

**Files:**
- Modify: `src/renderer/index.html` (an `<aside class="thread-panel" id="thread-panel" hidden>` after `.chat`, with a header and ×, a `#panel-thread` list and its own `<form id="panel-composer">`; remove `#thread-bar`), `src/renderer/app.js`, `src/renderer/styles.css`

- [ ] **Step 1:** Rendering takes a target: the main view always draws into `#thread` (main messages only); the panel draws the root plus the thread into `#panel-thread`. `showThread(rootId)` opens the panel instead of swapping views. Every main message gets a **Thread** button; the summary row opens the panel. The panel's message box routes with `routeMessage(thread, text, rootId)` and supports the @ popup. `post`, the pending rows and `renderSummary` update whichever views show the message. The panel is 40% of the width and closes with ×. Switching chats closes it.
- [ ] **Step 2:** `npm test` → pass. In the real app: a handoff streams in the panel while the main chat stays usable; Stop on the summary row ends the chain.
- [ ] **Step 3:** Update `AGENTS.md` (members, runs per run key, @, the panel). Commit `TM-54 Batch 4: thread side panel`, push, then a test list on TM-54.
