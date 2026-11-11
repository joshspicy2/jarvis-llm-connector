# Intake (Conductor) workflow (n8n)

`intake-workflow.json` turns one inbound item into a draft by chaining the other workflows over HTTP.
Nothing is sent to anyone; drafts land in Approvals as Awaiting Approval via Support/Estimator.

## Call chain
`POST /jarvis/intake` -> Validate -> `POST {BASE}/webhook/jarvis/inbound` (Router) -> Decide -> Switch:
- Support: `POST /jarvis/support` `{client_name, message: text, job_name}`. If `client_name` is
  missing, `from` is used.
- Estimator with `items[]` in the body: `POST /jarvis/estimate` `{job_name, items, notes: text}`.
- Estimator without items: no call; returns `needs_intake` plus the note to ask the client for details.
- Marketer: no call; `routed_only`.
- Any other owner (Conductor, Shield/Ops, Researcher), `needs_human` true, severity FIRE, or an
  unparseable Router reply: no downstream call; `held_for_human`.
Every path writes an Activity Log row (Agent Conductor, Status Done, Output Notes = reason + routing).

## Request / response
Body: `{source, from, subject, text, client_name?, job_name?, items?}`. `source`, `from`, `text`
are required; bad input returns 400 `{error, details}`.
Response: `{routing, downstream_status, approval_created?, approval_id?, note?, downstream?}`.

## Failure behavior
If the Router or a downstream call fails (error, timeout 60 s, non-2xx), the workflow logs
Status Error (Agent Conductor) and returns HTTP 502 `{error, stage}`. Nothing is retried.

## War Mode
Handled by the Router: with War Mode on and severity not FIRE, `needs_human` becomes false and the
item is queued for the brief. Intake still produces drafts (no alerts); FIRE is held for a human.

## Setup
1. Import the file; pick your Notion credential on the two log nodes.
2. Replace `https://REPLACE_WITH_N8N_BASE` in the three HTTP nodes with this n8n's base URL.
3. Replace `https://REPLACE_WITH_DASHBOARD_ORIGIN` in the webhook options (never `*`).
4. Activate Router, Support and Estimator workflows first. Add `Conductor` to the Activity Log
   `Agent` select.

## Unverified
Not imported into a live n8n; passes `scripts/validate_workflows.py` only. The Router and
Estimator/Support webhooks are called without credentials, so keep them private to the instance.
