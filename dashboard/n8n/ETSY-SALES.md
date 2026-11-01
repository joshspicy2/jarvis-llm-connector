# n8n: Etsy Sales (read-only)

`etsy-sales-workflow.json` serves `GET /webhook/jarvis/etsy-sales` for the dashboard. It performs no writes and never calls Etsy.

Flow: Webhook -> Notion getAll `Notion Etsy Orders` (`simple: false`, database `REPLACE_WITH_ETSY_ORDERS_DB_ID`, `alwaysOutputData`) -> Code `Build sales` -> Respond.
Schema: `docs/NOTION-SCHEMA.md` section 3b (proposed, unverified). Property names read: Order ID, Buyer First Name, Items Summary, Total, Currency, Order Date, Ship By, Status.

## Response

```json
{
  "generated_at": "2026-11-01T15:00:00.000Z",
  "currency": "USD",
  "totals": { "orders_7d": 0, "revenue_7d": 0, "orders_30d": 0, "revenue_30d": 0, "avg_order_30d": 0 },
  "by_status": { "New": 0, "Packed": 0, "Shipped": 0, "Delivered": 0, "Issue": 0 },
  "to_ship": [ { "order": "ETSY-1", "buyer_first_name": "Ana", "items": "2 x Moon candle", "ship_by": "2026-11-05", "overdue": false } ],
  "recent": [ { "order": "ETSY-1", "date": "2026-11-01", "total": 25, "status": "New" } ],
  "issues": 0
}
```

## Rules

- Windows: last 7 and last 30 calendar days in America/New_York, today included. A row counts when its `Order Date` instant is `>=` 00:00 on the first day and `<` 00:00 tomorrow (DST safe). Date-only values are midnight New York. Rows with no usable Order Date are not in the totals or `recent`.
- Revenue choice: sums `Total` of every row in the window, including Status `Issue`. Issues are not excluded; they are reported separately in `by_status.Issue` and `issues` (all-time count). `avg_order_30d` = revenue_30d / orders_30d (0 when none). Money is rounded to 2 decimals.
- `Total` is read as a number; if it is rich text or a title, digits are parsed (`$1,234.50`). Unusable or missing Total counts as 0 in revenue (order still counted) and `null` in `recent`.
- `currency`: the single uppercase code if every row with a Currency shares it, `MIXED` if they differ, `null` if none. With `MIXED`, revenue is a plain sum across currencies and is not meaningful; show it with a warning.
- `by_status`: all-time counts of the five known statuses; other or missing statuses are ignored.
- `to_ship`: Status New or Packed, soonest `ship_by` first (no ship_by last, ties by order), max 20. `overdue` is true when `ship_by` is before today in New York (due today is not overdue); false without a ship_by.
- `recent`: the 10 newest rows by Order Date (any status).
- Privacy: only buyer first name (first word, max 60), a short items summary, dates, totals and statuses are output. Never addresses, emails, tracking numbers, carrier, notes, approval ids or drafts.
- Empty input, alwaysOutputData placeholder items (no `id`) and missing properties never throw.

## Setup

Import the JSON, select the Notion credential on `Notion Etsy Orders` (none is stored), replace `REPLACE_WITH_ETSY_ORDERS_DB_ID` and the webhook `allowedOrigins` placeholder `https://REPLACE_WITH_DASHBOARD_ORIGIN` (never `*`). Unverified against live Notion. Not listed in `dashboard/n8n/README.md` yet.
