# Live Notion glance

The Preview tab's ticket card pulls real data from Notion when a chat message contains a Notion page link. No link (or no token) means the card says so — it never invents a ticket.

## Setup (once)

1. In Notion: Settings -> Connections -> Develop or manage integrations -> New integration. Copy the Internal Integration Secret.
2. Share each page (or parent database) you want glanced with that integration (page menu -> Connect to -> your integration). Unshared pages return an honest "could not pull" card.
3. Add to `.env.local` in this folder: `NOTION_API_KEY=<the secret>` (git-ignored; the token stays in the main process and is only sent to api.notion.com).
4. Restart the app (`npm start`).

## What shows

Title, Status and Priority (found by property type/name in the page's database), last-edited time, and the page's to-do checklist with done state. The ↗ button opens the real page in your browser.

TM-ids alone (e.g. "TM-59" with no link) still use the old saved-link card and are labelled "not live" — paste the page link for live data.

## GitHub workspace row

Unrelated but nearby: the Session sidecar's Workspace section shows `GitHub: owner/repo · branch` under Folder when the chat's folder is inside a GitHub repo (read-only `git` check in the main process). Not a repo, no row.
