# Jarvis — High Tide Ops dashboard

Static, no-build web app (`index.html` + `config.js`). Deploy the folder as-is to Cloudflare Pages, or open locally.

## Data
All data comes from n8n webhooks at `https://ops.hightidewash.net/webhook` (edit `config.js`). Each panel falls back to **clearly tagged sample data** if its endpoint fails, and the header badge shows live / partial / sample. No credentials are stored in this repo.

| Endpoint | Method | Response / body |
|---|---|---|
| `/jarvis/pipeline` | GET | `{stages:[{name, cards:[{title, sub}]}]}` (from Pipeline DB) |
| `/jarvis/agents` | GET | `[{name, status: active\|idle\|waiting\|error, detail}]` (the 11 agents in docs/AGENT-WORKFLOW.md; old names Estimate/Content/Integrator map to Estimator/Marketer/Conductor) |
| `/jarvis/estimate-rules` | GET | `[{service, category, base, unit, min, notes}]` (Estimate Rules DB) |
| `/jarvis/war-mode` | GET | `{enabled: bool}` (System Flags DB) |
| `/jarvis/war-mode` | POST | body `{enabled: bool}`; n8n writes the Notion System Flag so agents and dashboard share one source |
| `/jarvis/activity-log` | GET | `[{t, text}]` (Agent Activity Log DB, newest last) |
| `/jarvis/chat` | POST | body `{message}` → `{reply}` |

The browser calls these cross-origin, so enable CORS on the n8n Webhook nodes (allowed origin = the Pages domain), and protect the endpoints at the n8n/Caddy side. Do not put tokens in `config.js`.

## Notes
- Estimate Rules table is empty until the Notion DB has rows (shows an empty state).
- The wave background is a lightweight canvas stand-in; the planned React + Three.js scene can replace it.

## Deploy to Cloudflare Pages (needs your Cloudflare account)
1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → `joshspicy2/jarvis-llm-connector`.
2. Production branch `main` (after the PR merges). Framework preset: None. Build command: *(empty)*. Build output directory: `dashboard`.
3. `_headers` is applied automatically: strict CSP (only this origin and `https://ops.hightidewash.net` for data), no framing, no referrer.
   If you change the n8n hostname, update `connect-src` in `_headers` and `N8N_BASE` in `config.js`.
4. Protect it: Zero Trust → Access → Applications → add the Pages domain (and `ops.hightidewash.net/webhook/jarvis/*`) with an allow-list policy for your email(s).
   Then set the n8n Webhook nodes' Allowed Origins to the Pages domain.
**Important:** Access cannot protect cross-origin calls the way this page makes them. Serve the dashboard at `jarvis.hightidewash.net` (same site as `ops.hightidewash.net`), sign in to Access once, and set `credentials:"include"` plus a specific allowed origin (not `*`) on the n8n side before turning Access on. Until then, treat the endpoints as unprotected. The page is desktop-only (min width 1200px) by design.
