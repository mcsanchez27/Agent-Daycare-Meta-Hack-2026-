# Agent Daycare Meta

One chat window for talking with **Muse Spark**, **Gemini** (the `agy` CLI), **Claude**, **Codex** and **Grok** on your own PC, one at a time or as a crew. Built for the Meta Global AI Developer Hackathon, starting from Agent Daycare.

**Status:** one-agent and group chats, crews, projects, vendor sessions, threads, background asks between chats, Org Control (Central Brain, persona chips, skills library, MCP directory, saved teammates) and the Spark engine.

## Run it
1. Install the CLIs you want and make sure each is logged in: `agy`, `claude`, `codex`, `grok` (`grok login --device-code` once).
2. For Spark, create `.env.local` in this folder with `BASETEN_API_KEY`, `BASETEN_BASE_URL` and `META_SPARK_MODEL`. It is git-ignored; never commit it.
3. `npm install`
4. `npm start`

## Test
`npm test`

Notes for AI agents working in this repo are in [AGENTS.md](AGENTS.md).
