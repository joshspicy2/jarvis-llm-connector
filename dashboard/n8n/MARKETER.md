# Marketer workflow (Phase 2)

File: `marketer-workflow.json`. Drafts social/email content for human approval. **Nothing is ever posted or sent.**

## Flow
Webhook `POST /jarvis/marketing` -> validate -> Set `Marketer system prompt` -> Anthropic
(`claude-sonnet-5-5`) -> parse defensively -> Approvals row -> Agent Activity Log -> `{status:'drafted', approval_id}`.

## Request body
`{ "channel": "facebook|tiktok|email", "topic": "string (max 300)", "notes": "optional string" }`
Bad input returns HTTP 400 `{status:'error', errors:[...]}`.

## Output
Approvals row: Agent Marketer, Type Content, Status Awaiting Approval, QA Result Not checked,
Draft = headline, body, hashtags, suggested timing and any `needs_human_reason`. Not truncated: the `Chunk Draft` Code node splits it into rich_text items of <=1900 chars (Notion's per-item limit is 2000) and `Create Approval` is an HTTP Request to the Notion API `POST /v1/pages` (empty `notionApi` credential), since the Notion node writes only one item.
Unparseable model output still creates a row flagged "NEEDS HUMAN".

## Running QA (not chained automatically)
No workflow calls QA for you. After a draft is created, run it by hand with the `approval_id` from the response:

```
curl -X POST https://<n8n-host>/webhook/jarvis/qa -H 'content-type: application/json' -d '{"approval_id":"<approval_id>"}'
```
(POST `/jarvis/qa`). Until then the Approvals row stays `QA Result: Not checked`.

## Anthropic failures
The Anthropic node uses `onError: continueRegularOutput` with 3 tries, 2000 ms apart. If it still fails or returns nothing usable, `Parse draft` sets a `needs_human` reason and `has_draft` false: no Approvals row is written, an Agent Activity Log row with Status `Error` is, and the caller gets HTTP 502 `{status:'error', needs_human:true, reason}`. A parsed draft with a body is written as usual.

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
