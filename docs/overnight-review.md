# Agent Daycare Meta — overnight review

**Scope:** read-only review of `main` plus the focus/pet/kick work, with the Spark-demo and live-glance branches inspected where available. Seven focused reviewers covered hackathon fit, main-process bugs, renderer bugs, performance, security, demo readiness, and tests/reliability.

**No code was changed during this review.** The Electron app was not launched by the reviewers. Anything described as “verified” below means verified from source, tests, saved files, or git state—not watched running in the app.

## Bottom line

The project has a strong Indie-track story: several real agent engines in one local room, Spark included through Baseten, with handoffs, cross-chat asks, personas, kick-out, Focus editing, and the pet window. The biggest risk is not lack of features. It is demo reliability:

1. Three feature sets still live on separate draft branches and need one clean combined build.
2. Several live dependencies can fail independently: CLI login/path, Baseten credentials/model, network, and local file location.
3. A few small bugs can make a rehearsed demo beat look broken, especially around Preview/Edit file selection and pet messages sent while the agent is busy.
4. The default 300-second agent timeout is far too long for a 3-minute presentation if a process hangs.

The safest plan is to merge and rehearse one combined build, seed the demo state, keep only one or two live agent calls, and make every other beat work from files already on disk.

---

## Must-fix or must-verify before the demo

### 1. Produce one combined, tested demo build

`meta/spark-demo`, `meta/live-glance`, and `meta/focus-pet` are separate branches from `main`. The Spark narrative, live Notion/GitHub glance, and focus/pet/kick features therefore do not yet exist together in one tested build.

Morning order:

1. Run the full test suite on the real machine.
2. Merge one branch at a time.
3. Re-run tests after each merge, especially after any `app.js` conflict resolution.
4. Launch the combined build and rehearse the exact demo script twice.

Do not judge the demo from three separate branch checkouts.

### 2. Verify Spark from the real app folder, not from the review copy

The review copy intentionally excluded `.env.local`, so reviewers could not prove current Baseten reachability or model validity. On the real machine, confirm:

- `.env.local` exists in `M:\Projects\Matt\AgentDaycare-Hackathon`.
- One Spark message returns successfully.
- The visible model is the intended Muse Spark model.
- The reply is fast enough for the chosen demo beat.

If Spark is slow, use it for a short design brief only. Spark is currently chat/text oriented in this app; do not ask it to write files. Let Claude do the file work.

### 3. Same-morning CLI smoke test

Review evidence included an older saved chat showing a Claude OAuth-expiry failure. That may already be fixed, but it proves the failure mode is real.

Before recording or presenting, ask each engine used in the demo to answer a one-word `READY` prompt. Only include engines that pass that morning. A missing engine should be removed from the script rather than explained live.

### 4. Fix or avoid the Antigravity IDE-path failure

The IDE handler checks the exact configured Antigravity executable and does not use the runner’s PATH fallback:

- `src/main.js:183-192`
- compared with `src/agent-runner.js:174-183`

Review inspection found the configured path did not exist in the reviewed environment. Either point Settings at the real executable and test the button, or cut the IDE beat. Do not discover this during the presentation.

### 5. Seed the Preview/Edit file at the chat-folder root

The new Preview/Edit path has a real basename bug:

- `src/renderer/focus-pet.js:19-21` keeps only the basename of a previewed `.html` path.
- `src/chat-files.js:15-24` rejects names containing `/`.
- A file such as `design/index.html` can therefore preview while Edit targets a root `index.html`, fails, or opens the wrong file.

Until this is fixed, seed the demo page as `index.html` directly in the chat root. That makes Preview → Focus → Edit → Save dependable.

Best small code fix after the morning smoke test: track the chat-relative path safely instead of only the basename, while preserving the main process’s folder confinement.

### 6. Clear stale Preview/Edit state when switching previews or chats

`fpFile` in `src/renderer/focus-pet.js` is a single renderer global. It is not cleared reliably when a Notion glance replaces a file preview or when Matt switches chats. Edit/Save/IDE could use the current chat ID with a stale file name from elsewhere.

For the demo, always click Preview on the intended message immediately before Edit. For the code fix, clear the tracked file whenever a non-file preview opens or the current chat changes.

### 7. Do not type into the pet while its agent is still replying

The pet has a visible “message appears sent, then nothing happens” failure:

- `src/renderer/focus-pet.js:120-125` silently returns while the owner is pending.
- `src/renderer/pet.js:22-29` has already drawn the message as if it were sent.
- `src/main.js:214` also minimises the main window when the pet opens.

For the demo, send one short pet message only after the main chat is idle. The proper small fix is to queue the message or show “Agent is still replying—message not sent” in the pet. Silent loss should not ship beyond the prototype.

### 8. Treat the 300-second timeout as a demo hazard

`src/config.js:14` sets a 300-second default. The runner only stops a hung CLI/API call after that interval. On stage, that looks like a frozen app.

For the demo build, use a much shorter configured timeout if the existing settings support it, and rehearse the Stop button. Do not start a live call whose normal completion time has not been measured.

### 9. Make the kick beat rehearsed and narrow

Kick is locally deterministic once the exact line appears, but the live production of that line is not deterministic:

- `src/renderer/thread.js:416-422` accepts an exact `kick @Name` line.
- `src/renderer/focus-pet.js:44-59` acts immediately.
- There is no Matt confirmation.
- A matching line inside a fenced example or quoted explanation could also trigger removal.
- Late replies from an already-removed member are not consistently suppressed in `src/renderer/app.js`.

Use one rehearsed, short owner reply for the live beat, or show kick from a pre-seeded exchange and explain the rule. Do not invite an unscripted agent to “say something derailing” and hope the next reply contains exactly the right line.

The owner exemption is correct and should be stated in the demo.

### 10. Fix two visible or potentially blocking agent-launch issues

Two reviewer findings deserve a quick targeted check before they are trusted in the demo path:

- **Claude `.cmd` launch:** `src/agent-runner.js:20-21,158-168,490` may reject Claude’s argument set when Claude resolves through a `.cmd` shim, because the batch-argument allowlist is stricter than Claude’s real arguments. Test the actual configured/resolved Claude path on the demo machine. If it resolves to `.cmd`, fix and add a regression test before relying on it.
- **Spark model ID:** `MODEL_TEXT` in `src/agent-runner.js:25,311` forbids `/`, while the full Spark model ID in `src/providers/meta.js:5` contains one. Use the supported `spark` alias on camera unless this is fixed and tested. Do not paste the full model ID into a model field during the demo.

### 11. Fix the waiting-bubble mojibake

`src/renderer/styles.css:459,461` contains mojibake placeholder content instead of an ellipsis. Waiting bubbles can show garbage glyphs on camera. This is a tiny, high-visibility fix.

### 12. Harden startup against a malformed local environment file

`src/main.js:567-589` does not adequately guard the startup sequence around `loadLocalEnv()`. A non-ENOENT read failure from `src/env.js:27-29` can leave the app without a window and without a useful dialog.

This is not the first thing to fix for the demo if the real `.env.local` is known-good, but the app should show an error rather than silently fail to open.

---

## Other correctness findings

### Agent lifecycle and stop behaviour

- `src/agent-runner.js:608-628` removes a process entry immediately while `taskkill` is fire-and-forget at `src/agent-runner.js:189-195`. A slow or failed kill can leave an agent writing into the shared chat folder while the UI permits a replacement run.
- `src/agent-runner.js:601-604` relies on a later `close` event for cleanup after a child `error`. An error without close can leave timers, temp files, renderer state, and the run itself hanging until timeout.
- Kicked members can still complete late work or be relaunched through some background-ask paths because `member.left` is not checked consistently in `src/renderer/app.js`.
- `finishReply` can post a late reply and hand off even after the member was removed during that run.

These should be fixed together as one “removed/stopped agent cannot act again” pass, with tests.

### Persistence and settings

- MCP save/remove performs an unserialised read-modify-write in `src/main.js:411-424`; concurrent saves can lose one server.
- `config.json`, `mcp-servers.json`, and `org.json` are written directly rather than through a temporary file plus rename. A crash mid-write can truncate user settings.
- `config:save` can update in-memory config before working-folder creation succeeds, leaving the current session inconsistent until restart.
- One corrupt `projects.json` can block all project operations because `src/projects.js:11-25` does not degrade like chats/config do.
- `deleteAllChats` can leave saves locked for the process lifetime if the reload path does not complete.
- A temporary Claude MCP configuration can leak if agent launch fails after the temp file is created but before its cleanup callback is installed.
- UTF-8 decoders in the runner are not always ended, so a split multi-byte character at the end of a reply can lose the final character or emoji.

### Renderer behaviour

- Clicking a sidecar tab can discard an open thread/panel context without warning.
- The Focus button toggles width but does not itself select Preview. It is normally clicked from Preview, so this is minor.
- `previewFromText` in `src/renderer/app.js:954-965` treats almost any `.html` substring as a chat-folder file, including remote URLs or prose. That can arm Edit for a bogus local name.
- `src/renderer/styles.css:1633-1634` uses undefined `--border` where the theme defines `--line`.
- `brains:save-persona` protects only with `path.basename`, so a crafted `central-brain.md` file name can overwrite the Central Brain through the persona path.
- Chat files are copied and saved without a total size/count cap in `src/chats.js`; one corrupt or hostile saved chat can bloat memory and disk.

---

## Security review

This is a local, personal prototype, and the agent model intentionally gives trusted CLIs substantial machine access. That does not make the findings irrelevant; it defines what must not be oversold.

### Strong controls already present

- `contextIsolation: true` and `nodeIntegration: false`.
- Preview iframe uses `sandbox="allow-scripts allow-forms"` without `allow-same-origin`, so previewed agent pages do not get the app bridge.
- Main-process external-link handling allowlists protocols and restricts local HTML opening.
- Renderer message rendering is generally text-based rather than raw HTML insertion.
- Chat-file editing rejects plain traversal, absolute paths, and non-text extensions at the lexical level.
- Model and session identifiers are gated before shell-adjacent use.
- The logger attempts secret-pattern redaction.

### Important gaps for after the demo

1. **The pet window receives the full preload bridge.** It only needs send/receive pet messages, but `src/main.js:209` and `src/preload.js:3` expose the same powerful bridge as the main window. Give the pet a minimal preload and add sender checks to IPC handlers.
2. **Agent children inherit the full process environment.** After `.env.local` is loaded, a spawned agent shell can read values such as the Baseten key. Scrub provider secrets from child environments that do not need them.
3. **Claude, Grok, and Antigravity run with broad approval modes.** Prompt injection from web pages, guest chats, or pasted content can become local command execution. The UI and submission text should describe these as trusted local agents, not sandboxed agents.
4. **Renderer-supplied MCP definitions need the same validation as saved MCP definitions.** A path in `src/agent-runner.js:330` accepts renderer-provided MCP data more directly than the main-process `cleanServer` flow.
5. **Chat-file confinement is lexical, not real-path based.** A junction or symlink planted inside a chat folder can be followed outside it. Resolve real paths before read/save if this editor becomes a durable feature.
6. **`BASETEN_BASE_URL` should be validated.** A changed local environment file could send the bearer key to the wrong host.
7. **Logs can contain prompt or MCP secret material that does not match known redaction shapes.** Avoid logging full launch arguments and IPC payloads.
8. **MCP secrets remain plaintext on disk.** Acceptable for Matt’s own machine during the hackathon; not safe to share the profile or project folder as a credential-free artefact.

Security does not need to block the Nov 4 demo on a personal machine. It should block any claim that agents are sandboxed or safe to run against untrusted instructions.

---

## Performance findings

None of these needs to delay the demo unless long replies visibly jank during rehearsal. They matter for longer chats and larger saved history.

### Highest-value quick wins

1. **Batch streaming updates.** Every token can cross IPC and rewrite the whole pending bubble. The work grows roughly with the square of reply length. Coalesce output around every 50 ms and avoid accumulating an unused full response in the main process.
2. **Debounce chat persistence.** Posting a message rewrites the whole pretty-printed thread. Long chats therefore pay increasing cost per message.
3. **Stop parsing every chat at startup.** Chat listing reads and parses full threads only to obtain summaries. Persist a small index or summary sidecar.
4. **Cache per-ask disk reads.** Each ask can re-read brains, skills, MCP assignments, and org data. Cache until the corresponding save occurs.
5. **Remove synchronous launch stalls.** Temporary-file creation and executable resolution, including a possible `where` call, can block the main process during launch.
6. **Cap in-memory step growth and reduce the 1-second DOM rebuild.** Display and persistence are capped more tightly than the live in-memory list.
7. **Do not rebuild the entire chat list and all message DOM on every event.** This is the long-term renderer scaling issue.

The existing prompt cap of roughly 20 messages/12,000 characters plus history truncation is a sound bound. Log rotation is also bounded. The main scaling risks are chat persistence, startup parsing, and repeated DOM/IPC work.

---

## Tests and reliability

The unit coverage around thread routing, providers, timeout/stop semantics, chat files, and `findKick` is useful. The newest integration seams are the weak point:

- No DOM/integration test executes the `focus-pet.js` wrapping of `finishReply` and `previewFromText`.
- `test/kick.test.js` covers the pure finder, not stop-run + mark-left + system-post + owner guard together.
- Pet, file-editor, and IDE IPC channels have little or no direct assertion coverage.
- `AgentRunner.runApi` lacks the same level of coverage as the provider driver.
- `npm test` has no overall timeout, so a hung child process can hang the whole check.
- Sandbox test failures caused by temporary-directory permissions are environmental, but the full suite was not observed green during the overnight review. Confirm it in the real Windows shell before merging.

Highest-value test additions, in order:

1. A small integration-style test for the kick wrapper’s state changes.
2. IPC contract tests for `files:*`, `ide:open`, and `pet:*`.
3. A `.cmd` Claude argument regression test if that launch path is confirmed.
4. `runApi` stop/timeout/missing-key tests.
5. A test timeout in `package.json` or CI.

---

## Hackathon fit

Public page reviewed: Meta Global AI Developer Hackathon on Cerebral Valley.

The project maps best to the **Indie** criteria:

- **Creativity:** a local “daycare” where multiple named agents converse, hand off, ask other chats, get removed, and travel in a pet window.
- **Technical ambition:** CLI and API providers behind one run lifecycle, session resume, personas/brains, skills, MCP assignment, projects, and multiple windows.
- **Works:** conditional. Every additional live vendor, token, login, and network dependency weakens this criterion unless rehearsed and seeded.

Spark through Baseten is the Meta-model centre of the story. It should be visible early, but not asked to do file work it cannot do in the current integration. The strongest division of labour is:

- **Spark:** brief, critique, creative direction.
- **Claude:** write or modify the actual file.
- **Daycare:** show the artefact, let Matt edit it, and keep the same conversation going through the pet.

Do not claim Notion is live unless the merged live-glance branch, token, page sharing, and network have all passed that morning. The honest stub is safe as a brief aside; a failed live ticket is not.

---

## Recommended 3-minute demo

### Safest version: seeded artefact, one or two live calls

**0:00–0:35 — Set up the room**

Open a pre-made Spark Crew or Autonomous Crew chat. The chat folder already contains `brief.md` and a self-contained `index.html` at its root. Explain in one sentence: “These are separate agent engines sharing one room, one folder, and one conversation.”

**0:35–1:15 — Show Spark leading, Claude building**

Send one short, rehearsed prompt to Spark asking for a five-bullet improvement brief. Spark should hand off to Claude with `@Claude` alone on its own line if that flow has rehearsed reliably. Ask Claude for one small change to the existing page, not a full build from scratch.

If the combined Spark branch is not merged and rehearsed, show the completed Spark brief already in the seeded history and make only the Claude call live. Do not improvise a branch merge on stage.

**1:15–1:50 — Focus and edit inside Daycare**

Open Preview, click **Focus**, show the page, click **Edit**, change one visible word or colour value, **Save**, and show the reloaded preview. Keep the file at the chat root until the basename bug is fixed.

**1:50–2:25 — Show agent social rules**

Use a rehearsed kick exchange or a seeded system note demonstrating that an agent was removed for derailing and Matt brought it back with `@Name`. State the guardrail: “The chat owner can never be kicked.”

Only attempt a fully live kick if the exact exchange has worked in rehearsal at least twice.

**2:25–3:00 — Take me with you**

Click **Take me with you**. Daycare minimises and the pet opens. Send one short message that was not already answered in the main window. Wait for one concise reply. Close on: “The conversation leaves the IDE with me, but the chat and files stay in Daycare.”

### What to cut first if rehearsal runs long

1. Live Notion.
2. Fully live kick.
3. IDE launch.
4. A second live vendor call.
5. Any full-page build from scratch.

### Fallbacks to seed before presenting

- Finished crew chat with `brief.md` and working `index.html` at the chat root.
- Second saved chat containing a completed Spark brief, so Claude can still build if Baseten fails.
- Screenshots or a short screen recording of Spark streaming and the pet replying.
- A local file preview rather than a localhost dev-server preview.
- Browser/native-app links closed or hidden unless they are part of the script.

### Same-morning checklist

- [ ] Full `npm test` passes on the demo machine.
- [ ] Combined branch launches with `npm start`.
- [ ] Every engine used on camera answers `READY`.
- [ ] One Spark call succeeds end to end.
- [ ] Antigravity path is correct, or the IDE beat is cut.
- [ ] Demo `index.html` is at the chat-folder root.
- [ ] Timeout and Stop behaviour have been rehearsed.
- [ ] Pet message is sent only while the owner is idle.
- [ ] The exact demo has been run twice with a timer.
- [ ] A recording/screenshot fallback is open or one click away.

---

## Suggested fix order for the morning

Keep this deliberately small:

1. **Test and merge:** full suite, then combine PRs one at a time with tests between merges.
2. **Mojibake:** fix `styles.css:459,461`.
3. **Preview/Edit:** fix basename + stale state, or formally seed at root and defer the code fix.
4. **Pet:** queue or visibly reject messages while busy.
5. **Demo configuration:** verify Spark alias, CLI paths/logins, IDE path, timeout, and seeded chats.
6. **Kick safety:** at minimum, ignore matching lines inside fenced code blocks; consider Matt confirmation after Nov 4.
7. **Lifecycle:** make stop/error cleanup send completion exactly once and prevent orphaned writers.
8. **Then rehearse.** Stop adding features once the combined build passes the script twice.

## After Nov 4 backlog

- Minimal pet preload and IPC sender checks.
- Scrub provider secrets from agent child environments.
- Atomic writes for config/MCP/org/projects.
- Serialise MCP read-modify-write operations.
- Real-path confinement for chat-file editing.
- Validate `BASETEN_BASE_URL` and Antigravity executable resolution consistently.
- Batch streaming IPC and renderer paints.
- Persist chat summaries instead of parsing every full thread at startup.
- Cache brains/skills/MCP lookups per ask.
- Integration tests for focus-pet, pet IPC, editor IPC, and API-run lifecycle.
- Confirmation or audit trail for agent-initiated removal.
- Better progress and elapsed-time UI for long runs.
- Keychain storage for MCP/provider secrets.

## Unverified gaps

- Full test suite was not observed green in the sandbox; temporary-directory permissions and long-running spawned-process tests interfered.
- Electron was not launched during this review.
- Current Baseten reachability, latency, and model validity were not tested from the real app folder.
- Live vendor CLI login state was not tested.
- Whether the three draft branches merge cleanly together and pass the combined suite remains untested.
- Packaged-build behaviour, including writable paths for brains/skills/config, was not reviewed in depth.
- CSS performance was pattern-scanned rather than fully audited.
- Hackathon fine print beyond the public event page was not reviewed.
