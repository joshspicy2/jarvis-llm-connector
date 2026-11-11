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

## Resilience and safety
- `Anthropic Router`: retries 3x (2s apart), then `continueRegularOutput`; an empty/error response makes the
  parse node fall back to IMPORTANT / Conductor / needs_human true with `llm_failed: true`. The Activity Log
  row is still written, with Status `Error` when the LLM call failed (else `Done`).
- `Notion System Flags` uses `simple: false` (raw `properties`); the parse node reads the row titled exactly "War Mode".
- Prompt-injection hardening: subject is capped at 300 chars and text at 4000 (marked `[TRUNCATED]`); client
  content is sent inside `<<<CLIENT_DATA ... CLIENT_DATA>>>` and the system prompt says it is untrusted data.
- Keyword floor (deterministic, in the parse node): if subject/text matches injury, fire, gas, police, lawsuit,
  sue(d), attorney, lawyer, chargeback or refund, a ROUTINE/AWARENESS result is raised to IMPORTANT with
  needs_human true (`keyword_floor: true`). War Mode may still queue it (non-FIRE) for the brief.
- Tests: `node --test tests/n8n/router_code.test.js`.

## Swapping the prompt
Edit the single `systemPrompt` field in the `Router system prompt` node (e.g. with the Opus design
in `docs/design/router-and-estimator.md` once it exists). Keep the JSON-only output contract.

## Unverified
Not test-imported into a live n8n; Notion `propertiesUi` keys follow n8n 2.2 conventions and should
be checked on first import.

## War Mode default
If the System Flags read returns no row titled exactly "War Mode" (or fails), the Router treats War Mode as ON, per docs/design/router-and-estimator.md. FIRE items still interrupt.
