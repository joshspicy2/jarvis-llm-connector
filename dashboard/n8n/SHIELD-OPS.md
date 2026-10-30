# Shield/Ops health check

`shield-ops-workflow.json` is a read-only monitor. It runs every 15 minutes
(Schedule Trigger) and on demand at `GET /jarvis/health` (Webhook, CORS limited
to `https://REPLACE_WITH_DASHBOARD_ORIGIN`). Not imported into a live n8n yet.

## Flow
Trigger -> Notion Agent Activity Log (newest 200) -> Notion System Flags ->
Code "Compute health" -> if not OK, write one Activity Log row -> respond
`{status, findings, war_mode}`.

## Checks (thresholds are defaults, tune in the Code node)
- Errors in the last hour per agent: 1-2 WARN, 3 or more ALERT.
- Agent whose latest row is Working/Thinking for over 30 min: WARN (over 2h: ALERT).
- No Activity Log rows in over 24h: ALERT (possible silent failure).
- War Mode state is reported only.

Shield/Ops's own rows are ignored by every check so it cannot hide silence
or alert on itself.

## Log row
Agent `Shield/Ops`; Status `Error` for ALERT, `Done` for WARN; details in
Output Notes. OK runs write nothing.

## Safety
It only recommends. It never changes War Mode, pauses an agent or messages
anyone; the only write is the log row. Joshua decides what to do.

## Setup
Attach a Notion credential to the three Notion nodes (ids are left empty).
Check the Activity Log sort option on first import.

## Not covered (future work)
- Cost and budget-cap tracking.
- Backups and restore tests.
- Secret rotation and expiry reminders.
- Infra uptime (n8n, dashboard, Notion API) and push alerts to a human.
