# 👾 Agent Daycare (Batcave Predecessor)

A multi-agent desktop command center and desk pet overlay designed for your second monitor. Features cute retro 16-bit pixel-art bot companions (**Antigravity**, **Claude Code**, **Codex**, and **Grok**) that visually reflect your CLI agents' live activity.

---

## Current scope and design status

**Documentation reconciled: 2026-09-21.** “2.5” is Matt's current iteration label; `package.json` still reports `1.0.0`. The older V1/V2 Notion titles describe project history and roadmap, not a verified release sequence.

**Compact HUD Sidecar and Full Size HUD are retained design variants.** They emerged during live iteration with Stitch: Matt liked Compact and asked Stitch to create another screen so it would not be lost. Neither variant supersedes the other. The reviewed main-branch UI still uses agent cards and a terminal drawer; this review did not verify the Stitch screens as integrated app modes.

The goal is a dependable second-monitor utility: clear activity, attention alerts, and usable agent interaction. Autonomous routing, shared agent memory, and colony/world views remain future work.

Design rationale and iteration notes: [Notion — V2.5](https://app.notion.com/p/3e263104ef7880e8ab33c51ff1775db8). Human acceptance checks: [V2.5 QA](https://app.notion.com/p/3e263104ef788107be8ad9584a933fe5).

## 🌟 Key Features

* **Embedded Output & Input**: Daycare can launch CLI processes and display output in a shared tabbed drawer. Input reaches an app-owned process when it has writable stdin; otherwise it may launch a new process. This is not a full terminal emulator or a control connection to externally opened terminals.
* **The Attention Flow (`!`)**: Claude hook notifications and prompt-pattern detection can trigger attention alerts; detection varies by agent and session:
  * The bot stands at attention!
  * A bouncing exclamation point (`!`) appears over its head.
  * An optional retro 8-bit chime alerts you.
  * Clicking the bot or its tab immediately focuses the input bar with quick-reply buttons (`[ y ]`, `[ n ]`, `[ Enter ]`, `[ Cancel ]`).
* **Designed for Second Monitors**: Resizable and maximizable; opens on a second display when available. Saved window-position restoration is not currently implemented.
* **Team Roles & Promotion**: Antigravity is the default **Team Lead** (with a golden crown). Roles select labels and the recipient of Team Radio input; they do not create an autonomous orchestrator.
* **Team Radio**: A unified cross-agent activity feed showing when agents start, stop, alert, or pass messages.
* **Forward (prototype)**: Currently sends a generic “Review recent output and proceed” instruction to a hardcoded recipient. It does not transfer the actual output or conversation context.

---

## 🚀 How to Launch

Simply double-click:
```text
Start-Mission-Control.bat
```
Or run from PowerShell / Command Prompt in this folder:
```powershell
npm install   # first time only
npm start
```

## ⚙️ Settings (project folder & agent paths)

Open **🔍 Scan Agents**. At the top, pick the **project folder** agents should work in (this is where anything you launch from the app runs — change it when you switch projects). If an agent shows **✕ Not Found**, use **Browse…** next to it to point at its executable, then **💾 Save Settings**. Everything is stored in `config.json` next to the app (created with sensible defaults on first run; git-ignored).

---

## 🪝 Connect your agents (recommended)

Daycare launches its own processes and also detects external Windows processes by executable name. For richer lifecycle signals, click **🔍 Scan Agents** and **Connect** for Claude Code or Codex; Daycare updates their settings with a backup. Compatible sessions that load those settings can then report hook events. Process detection alone does not establish a writable connection.

**Claude Code** (`~/.claude/settings.json`) reports supported lifecycle events:

| Claude does… | The bot… |
|---|---|
| starts a session / finishes a turn | sits ready (`READY FOR YOU`) |
| runs tools | works |
| sends a notification | stands at attention with the `!`; validate the notification and clearing behavior in your session |
| ends the session | goes back to sleep |

**Codex** (`~/.codex/config.toml`) can only say *"I finished a turn"*, so its bot sits **READY FOR YOU** with the last thing Codex said whenever it's waiting on you. Codex allows one notify command; if you already have one the app tells you instead of replacing it.

**External sessions remain controlled in their original terminal.** Respond to their approvals there. Typing in Daycare may start a separate session; it does not reply to an external terminal. Multiple hook sessions are aggregated into one card per agent type.

Restart any sessions that were already open so they pick up the hook. **Disconnect** removes it again. The listener only accepts connections from this PC (`127.0.0.1:48211`; set `AGENT_DAYCARE_HOOK_PORT` if that port is taken).

---

## 📄 Logs (for debugging with an agent)

Every launch writes a fresh **`logs/latest.log`** in the project folder (older runs are kept alongside it with a date in the name). It records what each agent printed, when it was launched or stopped, when the `!` alert fired and why, and any crash or error inside the app itself. Colour codes are stripped and obvious API keys are masked.

Click **📄 Logs** in the top bar to open the folder. When something goes wrong, tell whichever agent you're working with to read `logs/latest.log` — see `AGENTS.md` for the format. Run `npm test` to check the logger.

---


---

## 📡 Error reporting (Sentry)

Optional. Set `SENTRY_DSN` in your environment, or copy `.env.example` to a `.env` next to `package.json` (git-ignored; loaded automatically by `npm start` and the smoke script, with shell variables taking precedence). The main process initializes `@sentry/electron` for **errors + default tracing only** (no session replay, profiling, metrics, or logging). If the variable is unset, Sentry is skipped.

Smoke (no GUI): `SENTRY_DSN=... npm run sentry:smoke`

## 🎮 Controls & Shortcuts

* **🔊 / 🔇 Sound**: Toggle retro 8-bit audio on and off in the top bar.
* **👑 Roles**: Swap or customize each agent's title and hierarchy.
* **⚡ Test Alert**: Click anytime to preview how the `!` attention alert looks and sounds!
* **▶ Start / ⏹ Stop**: Start or stop any individual agent's CLI session.
* **▶ Summon Team (prototype)**: Changes displayed states to working; does not launch agents. Do not treat that display as evidence of running work.
* **💤 All Sleep**: Requests stops for app-owned processes. External terminals remain independent.

## Validation and contribution notes

Run `npm test`, then the linked Windows human QA checklist. Record the commit, OS, pass/fail/skip results, and actual observations. A passing unit suite or skipped browser test does not establish Windows UI or full-day workflow stability. This documentation reconciliation did not run the app or tests.

Jules changes include safer executable scanning, async scans/config/hook operations, shared ANSI formatting, and extra error tests. Review each remaining PR against current main: duplicate patches and tests written against earlier synchronous APIs may need adaptation. Preserve direct executable invocation when combining security and performance changes. The periodic process scanner still uses synchronous `tasklist` in the reviewed code; do not describe all I/O as non-blocking.
