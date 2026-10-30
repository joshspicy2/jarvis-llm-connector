# Dashboard chat (POST /jarvis/chat)

Workflow: `jarvis-dashboard-api.json` (the other 6 endpoints are unchanged).
Not imported into a live n8n; the flow below is unverified against real Notion/Anthropic.

## What it does
Staff (Joshua, Makenzie) ask a question; Jarvis answers from live ops status only.
It never sends anything to clients and never invents prices, facts or schedules.

## Request / response
- Request: `{ "message": "<non-empty string, max 2000 chars>" }`
- Bad input: HTTP 400 `{ "error": "..." }` (no Notion or LLM calls are made).
- Success: `{ "reply": "<text, truncated to 1500 chars>" }`
- LLM call fails: `{ "reply": "I could not reach the language model right now." }`

## Node flow
Chat POST -> Validate Chat -> Chat Valid? (false: Respond Chat Bad Request)
-> Notion Pipeline (chat) -> Notion Flags (chat) -> Notion Log (chat)
-> Build Chat Prompt (Code) -> Chat system prompt (Set) -> Anthropic Chat (HTTP)
-> Shape Chat Reply (Code) -> Respond Chat

Context given to the model (all limiting is done in Build Chat Prompt):
- Pipeline jobs whose Status is not Paid: name + status, capped at 30.
- War Mode flag (System Flags row "War Mode", checkbox Value).
- Last 10 Activity Log rows, newest first by Timestamp.
All Notion nodes use `simple: false` and run once. The staff message is passed as untrusted text.

## Setup
- Select the Notion credential on the 3 chat Notion nodes.
- Create an Anthropic credential and select it on `Anthropic Chat` (the placeholder is empty).
- Model `claude-sonnet-5-5`, `max_tokens` 500. `Anthropic Chat` uses continue-on-error so a failure yields the fallback reply.
- Replace `https://REPLACE_WITH_DASHBOARD_ORIGIN` on the webhook as for the other endpoints.
