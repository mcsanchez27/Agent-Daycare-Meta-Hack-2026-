# Agent Daycare V2: group chats (design)

**Status:** approved by Matt in chat on 2026-10-22; spec awaiting his review.
**Branch:** `tm-53/v1.1` for now (PR #51). Ticket: **TM-54** "Agent Daycare V2 – Group chats" in Notion Task Master (https://app.notion.com/p/40263104ef7881d9a847db9cc5710ec5).

## What and why

V1 proved three agents can work in one room. V2 makes each chat a conversation with **one chosen agent** (vendor, then model), which Matt can grow into a **group chat** by adding agents, or by asking an agent to pull someone in. Threads move to a Slack-style side panel, and **@Name** replaces the agent picker and the "Send to X" buttons. There are also two quality-of-life fixes: spellcheck suggestions, and renaming chats.

**Done when**
- A new chat starts by picking a vendor and a model, and only that agent is in it.
- Matt can add a fresh agent, or an agent from another chat (bringing that chat's history), and agents can pull others in with @Name.
- Any main-chat message can open a thread in a side panel, and @ works there too.
- Right-clicking a misspelled word offers fixes. Chats can be renamed.
- Old chats still open and read correctly.

## Decisions (from Matt)

- **Adding an existing chat** means that chat's agent joins this chat and carries the other chat's history as background. The other chat is unchanged.
- **Who replies without an @:** the chat's first agent (its owner).
- **Same vendor twice:** allowed, in any mix (for example Claude Opus and Claude Sonnet in one chat).

## Chat members

A chat file gains `members`: `[{ id, vendor, model, name, memory? }]`. The first member is the owner.

- `vendor` is `antigravity`, `claude` or `codex`. `model` is a model id, or `null` for the CLI's default.
- `id` is `m1`, `m2`, … within the chat. Messages use it in `from` and `to`.
- `name` is unique within the chat (case-insensitive) and is what @ matches. By default it's the vendor's display name (`agents.<vendor>.name` in config). If that's taken, the model's short label (e.g. "Sonnet"); if that's also taken, the vendor name plus a number ("Claude 2"). Renaming a member is out of scope.
- `memory` (optional) is a snapshot taken when an agent is added from another chat: that chat's title and its most recent messages, at most 4,000 characters, newest kept. It's a snapshot, so the other chat is never loaded again.
- **Old chats:** a chat with no `members` gets one member per vendor that appears in its messages, with `id` set to the vendor id (`claude` and so on), so existing `from`/`to` values keep resolving. The owner is the vendor of the first agent message, or Claude if there is none. `model` is `null`.

## New chat flow

"+ New chat" opens a small chooser inside the chat area: three vendor buttons, then a model list. Picking a model creates the chat with that one member. Nothing is saved until the first message, as now.

- **Antigravity:** the output of `agy models` (id and label), fetched once at start-up, with a 10s limit. If it fails, only "Default" is offered.
- **Claude:** Default, Opus, Sonnet, Haiku (`--model` aliases).
- **Codex:** Default, or a text field for a model name. Codex has no list command.

## Talking: routing and @

- **Matt's message:** the first `@Name` in it that matches a member decides who answers. With no match, the owner answers (in a thread, the thread's default: see below). Typing `@` in the message box shows a pop-up of members (arrow keys or click to pick); the agent picker row is removed.
- **@ a vendor name that isn't in the chat** (Matt or an agent writing `@Codex` with no Codex member): a fresh member of that vendor joins with the default model, then answers.
- **An agent's finished reply** that @mentions another member (or an absent vendor, as above) hands off to it, in the same view (main chat or thread). A handoff note is drawn live as "Claude › Codex · Sent to Codex ›". This now also happens in the main chat, not only in threads.
- **Hop limit:** 3 handoffs in a row per view (the main chat, or each thread), counted since Matt last spoke in that view. The 4th is refused with a note. A stopped or timed-out reply never hands off.
- **Busy:** each member runs one reply at a time. Send is off only when the addressed member is busy. Different members, even of the same vendor and in different chats, run at the same time.
- "Send to X" buttons and the agent picker are removed. Old relay messages (`relayOf`) still display and still go into prompts as now.

## Adding agents

A "+ Add agent" button in the chat header, next to the member chips (one chip per member, in its vendor colour, showing name and model):

- **New agent:** vendor, then model, as in the new chat flow.
- **Agent from another chat:** a list of chats (title and date). Picking one shows its members; picking a member adds it here with its vendor, model and name (made unique), plus `memory`.

Joining posts an app note: "Codex (gpt-5) joined", or "Claude joined from 'Coffee plan'".

## Prompts

- **Header, one-on-one:** "You are <name> (<vendor>, model <model or default>), chatting one-on-one with Matt. To bring another agent in, write @Antigravity, @Claude or @Codex in your reply."
- **Header, group:** it lists the members by name, says everyone in the chat reads every message, and explains @Name.
- **Memory:** a member with `memory` gets "Background from your earlier chat '<title>':" plus the snapshot, before the recent conversation. It counts toward the same size limit (12,000 characters of history in total).
- History, threads and the size limits work as in V1.1. Thread messages are marked "(in a thread)" in main-chat prompts, and thread prompts see the main chat up to the thread's first message.

## Threads: side panel

Every main-chat message has a **Thread** button. It opens a panel on the right (about 40% of the width, with an × to close) showing the first message and the replies, with its own message box. The main chat stays visible and usable. The "talking…" / "N replies" summary row stays under the first message in the main chat, and clicking it opens the panel. Inside a thread, a message without an @ goes to the first message's author if that's an agent, otherwise to the chat's owner. This replaces Batch 3's full-view thread and its back bar.

## Runner

Runs are keyed by `runKey` = `<chatId>/<memberId>` instead of by vendor. The window asks for a run with `{ runKey, vendor, model, prompt }`. Output, status and done events carry `runKey`. Stop and timeout work per run. The model is passed as `agy --model <m>`, `claude --model <m>` or `codex exec -m <m>`, and no flag means the default. Vendor paths, timeouts and write access stay per vendor in `config.json`.

## Spellcheck

`main.js` listens for the window's `context-menu` event. On a misspelled word it shows up to 5 suggestions (picking one replaces the word), then "Add to dictionary". In text fields it also shows Cut, Copy and Paste. The language is Electron's default (en-US).

## Renaming chats

Double-click a chat in the list, or use its ✎ button, to edit the title inline. Enter saves, Esc cancels, and an empty title goes back to automatic. A renamed chat stores `titleSet: true` and stops taking its title from Matt's first message. `chats.js` keeps `titleSet` and `members`.

## Batches

1. **Spellcheck and rename.**
2. **Members, plus one-agent chats with the vendor/model chooser:** members in chat files, moving old chats over, the runner keyed by run, model flags, prompts per member.
3. **@ and group chat:** @ routing and the pop-up, Add agent (new, or from another chat with memory), absent vendors joining on @, handoffs in the main chat, member chips. The picker and Send-to buttons are removed.
4. **Thread side panel.**

Each batch: `npm test`, a check in the real app on Windows (driven over the debugging port with the real CLIs), commit `TM-54 Batch N: …`, push, then Matt's test list on the ticket.

## Testing

- `thread.js` (pure): member naming, @ matching with member names, absent-vendor detection, routing defaults (main and thread), hop counting per view, memory in prompts within the size limit, and moving old chats over.
- `chats.js`: `members` and `titleSet` round-trip.
- `agent-runner.js`: model flags per vendor, two runs of the same vendor at once, Stop and timeout per run.
- The renderer is checked in the real app per batch.

## Out of scope

Renaming members, removing members, more than one @ addressed at once (only the first counts), live memory (it's a snapshot), searching chats, and chat folders.
