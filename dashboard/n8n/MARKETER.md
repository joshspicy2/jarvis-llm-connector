# Marketer workflow (Phase 2)

File: `marketer-workflow.json`. Drafts social/email content for human approval. **Nothing is ever posted or sent.**

## Flow
Webhook `POST /jarvis/marketing` -> validate -> Set `Marketer system prompt` -> Anthropic
(`claude-sonnet-5-5`) -> parse defensively -> Approvals row -> Agent Activity Log -> `{status:'drafted'}`.

## Request body
`{ "channel": "facebook|tiktok|email", "topic": "string (max 300)", "notes": "optional string" }`
Bad input returns HTTP 400 `{status:'error', errors:[...]}`.

## Output
Approvals row: Agent Marketer, Type Content, Status Awaiting Approval, QA Result Not checked,
Draft = headline, body, hashtags, suggested timing and any `needs_human_reason`.
Unparseable model output still creates a row flagged "NEEDS HUMAN".

## Voice and guardrails
Friendly, local, trustworthy; High Springs, Fort White, Alachua, Gainesville, Lake City.
No invented claims, prices, testimonials, before/after results, client names or photos, or health/safety claims.

## Enabling (disabled by default)
The Webhook node ships with `disabled: true`. Once ops are stable:
1. Import into n8n and attach Notion and Anthropic credentials (placeholders are empty).
2. Replace `a807f4c25dfe4ce388626726b7d99f6d` and `REPLACE_WITH_DASHBOARD_ORIGIN`.
3. Open the Webhook node, turn off Disable, then activate the workflow.

## War Mode
Creating a draft does not interrupt anyone, so War Mode is not checked here; Approvals are reviewed in the normal queue.

Not imported into a live n8n.
