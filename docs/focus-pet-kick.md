# Focus, editor, Antigravity, pet, and agent kick-out

## Focus + in-Daycare editor
Preview tab: **Focus** widens the sidecar to most of the window (chat stays alongside). When Preview is showing a file from the chat's folder, **Edit** opens it in a plain text editor inside Daycare; **Save** writes it back to the same folder and reloads the preview. Only text types (html, md, txt, js, css, json, csv, xml, svg) under 512 KB, only inside that chat's folder — enforced in the main process (`src/chat-files.js`).

## Open in Antigravity
**IDE** opens the previewed file in Antigravity, using the antigravity executable path from config (Settings / config.json `agents.antigravity.path`). If it is not found, the preview title says why. Google Docs embedding is intentionally not built (needs Google sign-in/API); use ↗ for browser, or Edit here for chat-folder files.

## Take me with you (pet)
Header button **Take me with you** opens a small always-on-top pet window named for the chat's own agent and minimises Daycare. Type in the pet: the message lands in that chat as yours, the agent replies there, and the reply also appears in the pet. Close the pet window to end it; no state lives in the pet.

## Agent kick-out
In a group chat, an agent can remove another agent by putting `kick @Name` alone on its own line. The chat owner can never be kicked, prose ("we should kick @X") does nothing, and Matt brings anyone back with @Name. Matt's own × removal is unchanged.
