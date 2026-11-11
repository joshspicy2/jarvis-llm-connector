# n8n: Approvals API (read-only)

`approvals-api-workflow.json` serves `GET /webhook/jarvis/approvals` for the dashboard's APPROVALS panel.

Flow: Webhook -> Notion getAll (Approvals DB `a807f4c25dfe4ce388626726b7d99f6d`, `simple: false`) -> Code -> Respond.
The Code node keeps rows whose Status is `Awaiting Approval`, oldest first, max 25, and returns
`[{id, title, agent, type, qa, related_job, created, preview}]`. `preview` is the first 160 characters of Draft with any
`[estimate-json]` block removed. `qa` is Pass, Fail or Not checked.

This endpoint is read-only. Approving or rejecting stays a human action in Notion.

Setup: import the JSON, select your Notion credential on the Notion node (none is stored in the file), set the Webhook
Allowed Origins to your dashboard origin (it is a placeholder, never `*`), activate. Not yet imported into a live n8n.
