# Conductor Daily Brief workflow

File: `conductor-workflow.json` (n8n). Not yet imported into a live n8n.

## What it does
- Runs weekdays at 07:00 America/New_York (Schedule Trigger), or on demand via
  `GET /webhook/jarvis/daily-brief`.
- Reads Pipeline (jobs not Paid), the 25 most recent Agent Activity Log rows,
  and System Flags (War Mode checkbox `Value`).
- A Code node builds a compact JSON summary; a Set node holds the system prompt;
  an HTTP Request calls the Anthropic Messages API (`claude-sonnet-5-5`).
- Brief is under 200 words: Needs You / What Moved / Watch.
- The brief is written as an Agent Activity Log row (Agent `Conductor`, Status
  `Done`, Task `Daily brief`, Output Notes = brief).
- Webhook path responds `{ "brief": "..." }`; the scheduled path just logs.

## War Mode
When War Mode is ON the brief leads with a War Mode notice (prompted, and
enforced again in the "Finalize brief" Code node).

## Safety
- The brief is internal. Nothing is sent to clients or anyone else.
- No credentials in the file; both credential ids are empty.

## Setup
1. Import the JSON into n8n.
2. Select a Notion credential on the four Notion nodes.
3. Select an Anthropic credential on "Anthropic Conductor".
4. Replace `https://REPLACE_WITH_DASHBOARD_ORIGIN` in the webhook options.
5. Confirm the workflow timezone is America/New_York, then activate.
