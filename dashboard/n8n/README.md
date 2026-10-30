# n8n: Jarvis dashboard API

`jarvis-dashboard-api.json` is an importable workflow with the seven webhooks the dashboard calls
(`/webhook/jarvis/...`). It contains **no credentials**.

## Setup (about 10 minutes)
1. n8n → Workflows → Import from file → this JSON.
2. On every Notion node, select your Notion credential (create it in n8n with a Notion integration
   that has been shared with the Jarvis databases). The credential lives only in n8n.
3. Replace the placeholder database IDs: **Estimate Rules**, **System Flags**, **Agent Activity Log**
   (Pipeline is prefilled). n8n needs the *database* ID, not the `collection://` ID.
4. Property names are matched loosely (title column = name; `Stage`/`Status`, `Town`, `Service`, `Price`/`Base`, `Unit`, `Notes`, `Agent`).
   War Mode update writes the checkbox named **`Enabled`** on the row whose title contains "War" — rename in the
   "Notion Update War" node if yours differs.
5. Activate the workflow. Test: `curl https://ops.hightidewash.net/webhook/jarvis/war-mode`.
6. Set the Webhook nodes' **Allowed Origins** from `*` to your Cloudflare Pages domain.

## Protecting the endpoints (do before real data goes in)
The page is public static code and the browser calls n8n directly, so a token in the page would be visible.
Pick one:
- **Cloudflare Access** in front of both the Pages site and ops.hightidewash.net/webhook/jarvis/* (recommended; free tier; no code).
- Caddy `basicauth` on `/webhook/jarvis/*` plus browser sign-in.

## Status
- Agent status is derived from the Activity Log (entry within 10 min = active, status containing "await" = waiting).
- `/jarvis/chat` is a stub until the Router agent is wired in.
- Untested against live Notion (no access from the cloud). Check the first execution in n8n and adjust property names.
