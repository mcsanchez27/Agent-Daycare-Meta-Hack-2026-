# 👾 Agent Daycare (Batcave Predecessor)

A multi-agent desktop command center and desk pet overlay designed for your second monitor. Features cute retro 16-bit pixel-art bot companions (**Antigravity**, **Claude Code**, **Codex**, and **Grok**) that visually reflect your CLI agents' live activity.

---

## 🌟 Key Features

* **Zero External Windows**: Each agent has an interactive terminal dialogue drawer embedded directly inside the same window. No scattered terminal windows cluttering your desktop!
* **The Attention Flow (`!`)**: When an agent pauses to ask for clarification, confirmation (`[y/N]`), or review:
  * The bot stands at attention!
  * A bouncing exclamation point (`!`) appears over its head.
  * An optional retro 8-bit chime alerts you.
  * Clicking the bot or its tab immediately focuses the input bar with quick-reply buttons (`[ y ]`, `[ n ]`, `[ Enter ]`, `[ Cancel ]`).
* **Designed for Second Monitors**: Resizable, maximizable, and remembers its screen coordinates.
* **Team Roles & Promotion**: Antigravity is designated as the **Team Lead** by default (with a golden crown!), but you can promote Grok, Claude, or Codex to Team Lead anytime via the **Roles** menu.
* **Team Radio**: A unified cross-agent activity feed showing when agents start, stop, alert, or pass messages.
* **Forwarding Handoff**: Forward output from one agent directly into another with a single click.

---

## 🚀 How to Launch

Simply double-click:
```text
Start-Mission-Control.bat
```
Or run from PowerShell / Command Prompt:
```powershell
cd C:\Users\Matth\.gemini\antigravity\scratch\cli-companions
npm start
```

---

## 📄 Logs (for debugging with an agent)

Every launch writes a fresh **`logs/latest.log`** in the project folder (older runs are kept alongside it with a date in the name). It records what each agent printed, when it was launched or stopped, when the `!` alert fired and why, and any crash or error inside the app itself. Colour codes are stripped and obvious API keys are masked.

Click **📄 Logs** in the top bar to open the folder. When something goes wrong, tell whichever agent you're working with to read `logs/latest.log` — see `AGENTS.md` for the format. Run `npm test` to check the logger.

---

## 🎮 Controls & Shortcuts

* **🔊 / 🔇 Sound**: Toggle retro 8-bit audio on and off in the top bar.
* **👑 Roles**: Swap or customize each agent's title and hierarchy.
* **⚡ Test Alert**: Click anytime to preview how the `!` attention alert looks and sounds!
* **▶ Start / ⏹ Stop**: Start or stop any individual agent's CLI session.
* **▶ Summon Team / 💤 All Sleep**: Awaken or rest the whole crew with one click.
