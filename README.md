# Agent Daycare Meta

One desktop window where AI agents from different providers work as a team — on your machine, on your own accounts. **Meta Spark** (via Baseten), **Claude**, **Codex**, **Grok**, and **Gemini** (`agy`) share one conversation, hand work to each other, and build real files in per-chat folders. Built for the Meta Global AI Developer Hackathon, starting from Agent Daycare.

## Why

Every frontier model is strong now; they're just isolated in separate tabs and terminals. Agent Daycare treats them as a crew: a designer's brief can hand off to an engineer, a stuck agent can get corrected (or removed) by a teammate, and the whole team keeps working in one place with shared context.

## What it does

- **Crews, not just chats** — one-on-one chats, group chats, and role crews (e.g. the Spark Crew: Spark leads with the brief, Claude builds). Agents bring each other in with `@Name`, start focused discussions with `@thread`, answer everyone at once with `@all`, and can remove a derailing teammate with `kick @Name` (reversible).
- **Real work, visible** — agents run on your own subscriptions (local CLIs) or API keys, write files into the chat's own folder, and stream step-by-step progress with a stall indicator. Vendor sessions resume; usage/context numbers come from the vendors themselves.
- **Preview, Focus, edit, escape** — Preview renders an agent's `.html` or a local dev server in the sidecar. **Focus** widens it; **Edit** opens the file in a plain-text editor inside the app; **IDE** opens it in Antigravity when a fix outgrows the app.
- **Take me with you** — a small always-on-top pet window carries the chat's agent into whatever you're doing elsewhere, with a "Back to Daycare" button to return.
- **Live glance** — paste a Notion page link and the Preview tab pulls the real ticket (title, status, priority, checklist) with your integration token (main process only, fixed host). The Session sidecar also shows the chat folder's GitHub repo and branch when it has one.
- **Org Control** — Central Brain (shared operating doctrine), saved persona chips and teammates, a skills library, and an MCP directory that reads what each of your CLIs actually has configured.

## Run it

1. Install the CLIs you want and make sure each is logged in: `agy`, `claude`, `codex`, `grok` (`grok login --device-code` once).
2. For Spark, create `.env.local` in this folder with `BASETEN_API_KEY`, `BASETEN_BASE_URL` and `META_SPARK_MODEL`. It is git-ignored; never commit it. Optional: `NOTION_API_KEY` for the live glance.
3. `npm install`
4. `npm start`

## Test

`npm test`

## Notes

- Security model: the Notion token never leaves the main process and is only sent to `api.notion.com`; file editing is confined to the chat's own folder; CLI agents are trusted local tools, fenced where the vendor supports it (details in `src/agent-runner.js`).
- Docs: [Spark crew demo](docs/demo-spark-crew.md), [live Notion glance](docs/notion-glance.md), [focus/pet/kick](docs/focus-pet-kick.md). Notes for AI agents working in this repo are in [AGENTS.md](AGENTS.md).
- Next up (post-hackathon): a built-in browser tab, OAuth-style account login instead of CLIs, per-chat personas editing, and persona-chip deletion.
