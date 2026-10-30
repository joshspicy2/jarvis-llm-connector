# Shield/Ops health check

`shield-ops-workflow.json` is a read-only monitor. It runs every 15 minutes
(Schedule Trigger) and on demand at `GET /jarvis/health` (Webhook, CORS limited
to `https://REPLACE_WITH_DASHBOARD_ORIGIN`). Not imported into a live n8n yet.

## Flow
Trigger -> Notion Agent Activity Log (newest 100, sorted by the `Timestamp` property descending) -> Notion System Flags ->
Code "Compute health" -> if not OK, write one Activity Log row -> respond
`{status, findings, war_mode}`.

## Checks (thresholds are defaults, tune in the Code node)
- Errors in the last hour per agent: 1-2 WARN, 3 or more ALERT.
- Agent whose latest row is Working/Thinking for over 30 min: WARN (over 2h: ALERT).
- No Activity Log rows in over 72h: ALERT, evaluated only Mon-Fri 08:00-18:00 America/New_York (the Conductor is the only scheduled writer, Fri 07:00 to Mon 07:00 is 72h). Outside those hours this check never alerts.
- War Mode state is reported only.

Shield/Ops's own rows are ignored by every check so it cannot hide silence
or alert on itself.

## Log row
Agent `Shield/Ops`; Status `Error` for ALERT, `Done` for WARN; details in
Output Notes. OK runs write nothing. Dedupe: a row is written only when the status/findings signature (numbers ignored) differs from the most recent Shield/Ops row, or that row is 4h or older.

## Safety
It only recommends. It never changes War Mode, pauses an agent or messages
anyone; the only write is the log row. Joshua decides what to do.

## Setup
Attach a Notion credential to the three Notion nodes (ids are left empty).
The Activity Log fetch uses the Notion v2.2 sort option `{timestamp:false,key:"Timestamp|date",direction:"descending"}`; confirm it on first import. The Code node also re-sorts by timestamp deterministically and 100 rows are fetched, so the window is correct even if Notion ignores the sort.

## Not covered (future work)
- Cost and budget-cap tracking.
- Backups and restore tests.
- Secret rotation and expiry reminders.
- Infra uptime (n8n, dashboard, Notion API) and push alerts to a human.
