# Jarvis Support workflow

`support-workflow.json` drafts a reply to a client message. It never sends anything to the client.
Not imported into a live n8n; validate with `python3 scripts/validate_workflows.py dashboard/n8n/support-workflow.json`.

## Endpoint
`POST /webhook/jarvis/support` with JSON body:
```
{ "client_name": "Jane Doe", "message": "Can you confirm my cleaning?", "job_name": "optional Pipeline job name" }
```
`client_name` and `message` are required (string, non-empty); bad input returns HTTP 400 `{status:"error", errors:[...]}`.
Success returns `{status:"drafted", approval_id, needs_human, reason}`.

## Flow
1. Webhook, validate body.
2. If `job_name` is given, read the Pipeline (Notion getAll, `simple:false`) and match the job by name in a Code node.
3. `Support system prompt` Set node, then HTTP Request to Anthropic (`claude-sonnet-5-5`) returning `{reply, needs_human, reason}`.
4. Parse defensively; any failure becomes an empty reply with `needs_human: true`.
5. Create an Approvals row: Type Reply, Status Awaiting Approval, QA Result Not checked, Draft = reply.
6. Log to the Agent Activity Log (Agent `Support`), then respond.

## Setup
- Replace `REPLACE_WITH_APPROVALS_DATABASE_ID` and the webhook origin `https://REPLACE_WITH_DASHBOARD_ORIGIN`.
- Select the Notion and Anthropic credentials in n8n (left empty in the file).
- Add `Support` to the Agent Activity Log `Agent` select, and `Support` to the Approvals `Agent` select.

## Open question
Payment-escalation tone is not decided (Makenzie). The prompt stays polite and sets `needs_human` for payments, refunds, complaints and disputes.
War Mode: this flow does not alert or interrupt anyone; drafts wait in Approvals.
