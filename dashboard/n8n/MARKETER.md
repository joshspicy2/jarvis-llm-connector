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

## QA auto-chain
After `Create Approval` succeeds, the `Call QA` node (HTTP Request, POST `https://REPLACE_WITH_N8N_BASE/webhook/jarvis/qa`, body `{"approval_id": <new Approvals page id>}`, timeout 10 s, no credentials) asks the QA workflow to check the new row. It is non-blocking: `onError: continueRegularOutput`, so a QA failure, timeout or unreachable QA never blocks the response or changes the result; the flow continues to the activity log and `Respond Drafted`, whose body is unchanged (the QA reply is not used). QA writes only `QA Result` (never Status or Draft); Status stays *Awaiting Approval* for a human. If the QA call fails, the row stays `QA Result: Not checked` and you can run it by hand:

```
curl -X POST https://<n8n-host>/webhook/jarvis/qa -H 'content-type: application/json' -d '{"approval_id":"<approval_id>"}'
```
Set `REPLACE_WITH_N8N_BASE` to your n8n base URL in the n8n UI, as for Intake. The call is synchronous, so the response may take a few seconds longer while QA runs (capped by the timeout).

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
