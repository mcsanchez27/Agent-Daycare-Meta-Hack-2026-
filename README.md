# Agent Daycare

One chat window for talking with **Gemini** (the `agy` CLI), **Claude**, **Codex** and **Grok** on your own PC, one at a time or as a crew. A prototype in the Batcave lineage.

**Status:** V4 on `master` (one-agent and group chats, crews, vendor sessions, threads, background asks between chats); V5 "Org Control" (Central Brain, persona chips, skills library, MCP directory, saved teammates) is landing in TM-60 batches. The old dashboard (mascots, hooks, roles) was removed in TM-47; its last version is the git tag `v0-dashboard`.

## Run it
1. Install the CLIs you want and make sure each is logged in: `agy`, `claude`, `codex`, `grok` (`grok login --device-code` once).
2. `npm install`
3. `npm start` (or double-click `Start-Agent-Daycare.bat` on Windows)

## Test
`npm test`

Notes for AI agents working in this repo are in [AGENTS.md](AGENTS.md).
