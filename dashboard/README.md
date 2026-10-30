# Jarvis — High Tide Ops dashboard

Static, no-build web app (`index.html` + `config.js`). Deploy the folder as-is to Cloudflare Pages, or open locally.

## Data
All data comes from n8n webhooks at `https://ops.hightidewash.net/webhook` (edit `config.js`). Each panel falls back to **clearly tagged sample data** if its endpoint fails, and the header badge shows live / partial / sample. No credentials are stored in this repo.

| Endpoint | Method | Response / body |
|---|---|---|
| `/jarvis/pipeline` | GET | `{stages:[{name, cards:[{title, sub}]}]}` (from Pipeline DB) |
| `/jarvis/agents` | GET | `[{name, status: active\|idle\|waiting\|error, detail}]` (Router, Estimate, Scheduling, Finance, Content, Integrator) |
| `/jarvis/estimate-rules` | GET | `[{service, base, unit, notes}]` (Estimate Rules DB) |
| `/jarvis/war-mode` | GET | `{enabled: bool}` (System Flags DB) |
| `/jarvis/war-mode` | POST | body `{enabled: bool}`; n8n writes the Notion System Flag so agents and dashboard share one source |
| `/jarvis/activity-log` | GET | `[{t, text}]` (Agent Activity Log DB, newest last) |
| `/jarvis/chat` | POST | body `{message}` → `{reply}` |

The browser calls these cross-origin, so enable CORS on the n8n Webhook nodes (allowed origin = the Pages domain), and protect the endpoints at the n8n/Caddy side. Do not put tokens in `config.js`.

## Notes
- Estimate Rules table is empty until the Notion DB has rows (shows an empty state).
- The wave background is a lightweight canvas stand-in; the planned React + Three.js scene can replace it.
