# n8n: Jarvis dashboard API

`jarvis-dashboard-api.json` is an importable workflow with the seven webhooks the dashboard calls
(`/webhook/jarvis/...`). It contains **no credentials**.

## Setup (about 10 minutes)
1. n8n → Workflows → Import from file → this JSON.
2. On every Notion node, select your Notion credential (create it in n8n with a Notion integration
   that has been shared with the Jarvis databases). The credential lives only in n8n.
3. Database IDs and column names are already filled in from your live Notion schemas (Pipeline, Estimate Rules,
   System Flags, Agent Activity Log). If a Notion node says the database isn't found, share that database with your
   n8n Notion integration.
4. War Mode writes the `Value` checkbox on the System Flags row whose `Flag` contains "War". That row must exist.
5. Activate the workflow. Test: `curl https://ops.hightidewash.net/webhook/jarvis/war-mode`.
6. Replace `https://REPLACE_WITH_DASHBOARD_ORIGIN` in every Webhook node's **Allowed Origins** with your dashboard origin (committed as a placeholder on purpose, never `*`).

## Protecting the endpoints (do before real data goes in)
The page is public static code and the browser calls n8n directly, so a token in the page would be visible.
Pick one:
- **Cloudflare Access** in front of both the Pages site and ops.hightidewash.net/webhook/jarvis/* (recommended; free tier; no code).
- Caddy `basicauth` on `/webhook/jarvis/*` plus browser sign-in.

## Status
- Agent status comes from each agent's latest Activity Log row (Thinking/Working = active, Error = error, otherwise idle). Old log names map to the new ones (Estimate→Estimator, Content→Marketer, Integrator→Conductor).
- `/jarvis/chat` is a stub until the Router agent is wired in.
- Untested against live Notion (no access from the cloud). Check the first execution in n8n and adjust property names.
