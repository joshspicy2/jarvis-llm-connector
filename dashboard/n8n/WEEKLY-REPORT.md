# n8n: Weekly Report (read-only)

`weekly-report-workflow.json` serves `GET /webhook/jarvis/weekly-report`. It performs no writes anywhere.

Flow: Webhook -> three parallel Notion getAll nodes (Agent Activity Log `5b18e20e5aba4be787a1eaedf2217da3`,
Approvals `a807f4c25dfe4ce388626726b7d99f6d`, Pipeline `6cc3d9aad6d14fa39377673274a4cc5f`; all `simple: false`) -> Merge
(only waits for all three) -> Code `Build report` (reads each Notion node by name) -> Respond.

## Response

```json
{
  "week_start": "2026-10-26", "week_end": "2026-11-01",
  "runs_by_agent": { "Router": { "runs": 0, "errors": 0 } },
  "approvals": { "created": 0, "approved": 0, "rejected": 0, "sent": 0, "awaiting": 0 },
  "qa": { "pass": 0, "fail": 0, "not_checked": 0 },
  "jobs": { "by_status": { "Booked": 0, "In Progress": 0, "Awaiting Invoice": 0, "Paid": 0, "Flagged": 0 }, "flagged": 0 },
  "generated_at": "2026-11-01T15:00:00.000Z"
}
```

## Rules

- Window: the last 7 calendar days in America/New_York, today included. `week_end` is today, `week_start` is today minus 6,
  both ISO dates. Rows count when their instant is `>=` 00:00 on `week_start` and `<` 00:00 the day after `week_end` (DST safe).
  A date-only value is treated as midnight New York.
- `runs_by_agent`: Activity Log rows by `Timestamp` (falls back to `created_time`). `errors` = Status `Error`. The 11 known
  agents are always present; legacy names are aliased (Estimate to Estimator, Content to Marketer, Integrator to Conductor,
  trailing " Agent" stripped); other names appear under their own key; a missing Agent is `Unknown`.
- `approvals.created`: rows created in the window. `awaiting` and the `qa` counts are taken from those same created-in-window
  rows (a missing QA Result counts as `not_checked`). `approved`, `rejected`, `sent`: rows currently in that Status whose
  `Decided At` is in the window (no Decided At, not counted).
- `jobs`: Pipeline rows created in the window, counted by Status (unknown or missing Status keys through as given or `Unknown`).
  `flagged` equals `by_status.Flagged`.
- Missing properties never throw; a row with no usable date is skipped.
- Privacy: only counts and agent/status names are output. No titles, client names, Related Job, Draft or Output Notes.

## Setup

Import the JSON, select your Notion credential on the three Notion nodes (none is stored), replace the Webhook Allowed
Origins placeholder with the dashboard origin (never `*`), activate. Not yet imported into a live n8n; expect to fix
property names on first run. Tests: `node --test tests/n8n/weekly_report.test.js`.
