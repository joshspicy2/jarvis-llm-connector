# n8n: Pipeline Move (write endpoint)

`pipeline-move-workflow.json` serves `POST /webhook/jarvis/pipeline/move` so the dashboard can move a job to another
Pipeline Status.

Request body (exactly these two fields, anything else is rejected):
```json
{ "id": "<Notion page id, 32 hex or dashed UUID>", "status": "Booked" }
```
`status` must be exactly one of the Pipeline Status select options in `docs/NOTION-SCHEMA.md`: `Booked`,
`In Progress`, `Awaiting Invoice`, `Paid`, `Flagged` (case-sensitive; no option is created or renamed).

Flow: Webhook -> Validate Move (strict whitelist) -> Notion get page (`simple: false`) -> Guard -> Notion update page
-> Log to Agent Activity Log -> Respond.

| Step | Behavior |
|---|---|
| Validate Move | Bad id or status, non-object body or extra field: `400 {error}` |
| Guard | `404` if the page cannot be read; `409` if the page is archived, its parent is not the Pipeline database, it has no `Status` select, or it is already in the requested status |
| Notion Update Status | Writes `Status|select` only. No other property is touched |
| Log Job Moved | Agent Activity Log row: Agent `Conductor`, Task `Job moved`, Status `Done`, Output Notes `Job <id> moved: <from> -> <to>`, Timestamp now. A logging failure does not block the response |
| Respond Moved | `200 {ok: true, id, from, to}` |

## Statuses
Moving to `Paid` or `Flagged` is allowed by the API. `Paid` is terminal for the dashboard UI: the UI should offer no
further moves from a Paid job. The API does not enforce this; a human can still change it in Notion. `Flagged` has no
Flag Reason written here; set that in Notion.

## Security
This is a write endpoint, like the war-mode POST. It must sit behind Cloudflare Access (see `dashboard/README.md`,
including the note that cross-origin browser calls are not protected by Access by themselves). Set the Webhook
Allowed Origins to your dashboard origin; it ships as the placeholder `https://REPLACE_WITH_DASHBOARD_ORIGIN` and is
never `*`. The Guard check on the Pipeline database id stops the endpoint from editing pages in any other database
the integration can reach.

## Setup
Import the JSON, select your Notion credential on the three Notion nodes (none is stored in the file), set Allowed
Origins, activate. Not yet imported into a live n8n; node parameters and property names are unverified against live
Notion, so check the first execution. The Pipeline and Agent Activity Log database ids are the ones used by
`jarvis-dashboard-api.json`; `Conductor` must exist as an Agent option in the Activity Log (it is on the "new" list
in the schema doc; adding the new options in Notion is still a Joshua TODO).
