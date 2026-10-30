# Router workflow (n8n)

`router-workflow.json` classifies one inbound event and logs it. Nothing client-facing is sent.

Flow: `POST /jarvis/inbound` -> Notion System Flags (read War Mode) -> `Router system prompt`
(Set node) -> Anthropic Messages API -> parse + War Mode rule -> Notion Agent Activity Log -> JSON response.

## Setup
1. n8n: Workflows -> Import from File -> `router-workflow.json`.
2. Open each Notion node and pick your Notion credential (the file ships with an empty placeholder).
3. Open `Anthropic Router` and pick/create an Anthropic API credential (credential type `anthropicApi`).
   Keys live only in n8n, never in this repo.
4. In `Inbound Webhook` > Options, replace `https://REPLACE_WITH_PAGES_DOMAIN` with the real
   Pages origin. Do not use `*`.
5. Share the Notion integration with the System Flags and Agent Activity Log databases.
6. Activate, then call the production URL.

## Request / response
Body: `{source, from, subject, text}`. Response: `{severity, owner, reason, needs_human, summary,
queued_for_brief, war_mode}`.

## Behavior
- Model `claude-sonnet-5-5`, max_tokens 300, JSON-only reply.
- Parse failure -> IMPORTANT / Conductor / needs_human true.
- War Mode ON (System Flags row whose title contains "War", checkbox `Value`) and severity not FIRE
  -> needs_human false, queued_for_brief true. Only FIRE interrupts a human.

## Swapping the prompt
Edit the single `systemPrompt` field in the `Router system prompt` node (e.g. with the Opus design
in `docs/design/router-and-estimator.md` once it exists). Keep the JSON-only output contract.

## Unverified
Not test-imported into a live n8n; Notion `propertiesUi` keys follow n8n 2.2 conventions and should
be checked on first import.
