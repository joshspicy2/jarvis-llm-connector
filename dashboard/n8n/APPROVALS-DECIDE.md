# n8n: Approvals Decide (human action path)

`approvals-decide-workflow.json` serves `POST /webhook/jarvis/approvals/decide`. It is the only place an Approvals row's
Status leaves `Awaiting Approval` (see `docs/NOTION-SCHEMA.md`, Approvals state machine).

## SECURITY: put this behind auth before real use

**This endpoint MUST sit behind Cloudflare Access or a same-site auth before real use.** An unauthenticated POST lets
anyone approve or reject a client-facing draft, which defeats the human-approval principle. Webhook CORS
(`allowedOrigins`) is not authentication: it only constrains browsers, and `curl` ignores it. Cross-origin calls are not
protected by Access (see `dashboard/README.md`), so front it with a same-site route or Access service policy.

`decided_by` is **self-reported** until auth exists. Treat it as a label, not proof of identity. Once auth is in place,
derive it from the authenticated identity server-side and ignore the body value.

## Contract

Request JSON body: `{ "id": "<Notion page id>", "decision": "approve" | "reject", "decided_by": "<1-60 chars>" }`

Responses:
| Code | Body | When |
|---|---|---|
| 200 | `{ "ok": true, "id": "<id>", "status": "Approved" \| "Rejected" }` | decided |
| 400 | `{ "ok": false, "error": "Invalid input", "details": [..] }` | validation failed |
| 409 | `{ "ok": false, "error": "<reason>" }` | page missing, not an Approvals row, or Status is not exactly `Awaiting Approval` |

## Flow

Webhook -> Validate (Code) -> Input valid? -> Notion get page (`simple: false`) -> Guard (Code) -> Can decide? ->
Notion update -> Log to Agent Activity -> Respond.

- **Validate**: `id` must be a 32-hex or dashed UUID Notion page id (normalized to lowercase); `decision` must be exactly
  `approve` or `reject` (case-sensitive); `decided_by` trimmed, 1-60 chars, no control characters or `<` `>`.
- **Guard**: the page must exist, its parent must be the Approvals database, and `Status` must be exactly
  `Awaiting Approval`. Anything else (Approved, Rejected, Sent, blank) returns 409. So no re-deciding and no path to
  `Sent`.
- **Notion Decide**: sets `Status` (Approved or Rejected), `Decided By`, `Decided At` (now). Nothing else is touched.
- **Log**: Agent Activity Log row, `Agent = Conductor`, `Task = Approval decided`, `Status = Done`, Output Notes
  `id=<id> decision=<decision>`. No draft content is logged.

## Known limits

- `Decided By` is a Notion select (options Makenzie, Joshua). A new `decided_by` value creates a new option on write;
  restrict values once auth exists.
- The get and update are not atomic; two simultaneous decisions could both pass the Guard. Acceptable at this volume.
- The Notion node parameters are unverified against a live instance. Not yet imported into a live n8n.

Setup: import the JSON, select your Notion credential on the three Notion nodes (none is stored in the file), set the
Webhook Allowed Origins to your dashboard origin (placeholder, never `*`), put the route behind auth, activate.
