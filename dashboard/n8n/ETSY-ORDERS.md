# Jarvis Etsy Orders workflow

`etsy-orders-workflow.json` records Etsy sales (TheLuminousFairy) in Notion and drafts a shipping confirmation for the buyer.
It never messages the buyer and never calls Etsy. No Etsy credentials exist, and none are in this repo.
Not imported into a live n8n; validate with `python3 scripts/validate_workflows.py dashboard/n8n/etsy-orders-workflow.json`.

## Endpoints (two entry points, one workflow)

### A. New sale: `POST /webhook/jarvis/etsy/order`
```
{ "order_id": "123456789", "order_number": "1234", "buyer_first_name": "Ana",
  "items": [{ "title": "Moon candle", "qty": 2, "price": 12.5 }],
  "total": 25, "currency": "USD", "order_date": "2026-11-01", "ship_by": "2026-11-05" }
```
Flow: Validate Order (strict types and caps, control characters stripped), find existing row in Etsy Orders by `Order ID`, skip if it exists, create the row with `Status = New`, log to the Agent Activity Log, respond.
Responses: `200 {ok:true, duplicate:false, order_id}`, `200 {ok:true, duplicate:true, order_id}` (nothing written), `400 {ok:false, errors}`; a missing or wrong `X-Jarvis-Secret` gets a `403` from n8n before the workflow runs.

### B. Shipped: `POST /webhook/jarvis/etsy/shipped`
```
{ "order_id": "123456789", "tracking_number": "9400 1000 0000 0000", "carrier": "USPS", "shipped_at": "2026-11-03" }
```
Flow: Validate Shipped, find the order row (404 if none), `Guard` (status must be New or Packed; a Shipped order is never re-shipped, 409), update the row (`Status = Shipped`, `Tracking Number`, `Carrier`, `Shipped At`), `Build Draft` (Code node), `Chunk Draft`, `Create Approval` (Approvals row, Status `Awaiting Approval`, QA Result `Not checked`, Type `Reply`, Agent `Etsy`), `Link Approval ID` writes the Approvals page id to the order row's `Approval ID`, non-blocking `Call QA`, log to Agent Activity Log, respond `{ok:true, approval_id}`.
Other responses: `400`, `403` (bad secret, from n8n), `404 {ok:false, error:"order not found"}`, `409 {ok:false, error}`.
Note the row is marked Shipped before the draft exists, as specified. If a later node fails, the order stays Shipped with no draft: check n8n Executions and create the draft by hand.

## Draft content
Built by the `Build Draft` Code node only from the order row (buyer first name, items summary) and the carrier and tracking number just received. Plain, short, friendly. It states no delivery date, no address, no price and no promise beyond "message us and we will help". Chunking into rich_text items of <=1900 chars is the same as `support-workflow.json`.

## Etsy messaging stays a human step
Nothing here sends to the buyer. A human reviews the draft in Approvals (only a human moves Status off *Awaiting Approval*), then sends it in Etsy by hand. A later "send via Etsy" step would need Joshua's Etsy API keys entered in the n8n UI and is NOT built.

## Security
- Webhook `allowedOrigins` is the placeholder `https://REPLACE_WITH_DASHBOARD_ORIGIN` (never `*`). That only governs browsers; Etsy, Zapier or an email-forward caller is not a browser and ignores it.
- Both webhook nodes use n8n's built-in Header Auth (`authentication: headerAuth`, credential type `httpHeaderAuth`, header name `X-Jarvis-Secret`). n8n rejects a request with a missing or wrong header with 403 before any node runs, so nothing is written to Notion. No Code node reads `$env` (production n8n blocks `$env` in Code nodes and we do not unblock it). The secret lives only in the n8n credential, set in the n8n UI; the workflow JSON ships an empty credential placeholder. The caller sends the same value in the `X-Jarvis-Secret` header.
- These two paths are called by an external, non-browser caller, so they need a Cloudflare Access bypass policy (documented here, not applied). Header Auth is then the only gate; use a long random secret.
- Credentials are empty placeholders; pick the Notion credential in the n8n UI.

## Setup
- Create the Etsy Orders database (proposal in `docs/NOTION-SCHEMA.md`) and replace `REPLACE_WITH_ETSY_ORDERS_DB_ID` in the three Etsy Orders nodes (`Notion Find Order`, `Notion Find Order B`, `Create Order Row`).
- Properties used, exactly: Order ID (title), Order Number, Buyer First Name, Items Summary, Total (number), Currency, Order Date (date), Ship By (date), Status (select New/Packed/Shipped/Delivered/Issue), Tracking Number, Carrier, Shipped At (date), Approval ID. Order Number, Buyer First Name, Items Summary, Currency, Tracking Number, Carrier and Approval ID are written as rich text; if the schema makes any of them another type, change the matching key in the node. Unverified against live Notion.
- Add `Etsy` to the Agent select in both the Agent Activity Log and Approvals. Until then the log and Approvals writes fail. The shipping draft uses the existing Approvals Type `Reply`.
- Replace `REPLACE_WITH_N8N_BASE` (Call QA) and the webhook origin.
- In n8n, create a credential of type Header Auth named e.g. `Jarvis Etsy Secret`: Name `X-Jarvis-Secret`, Value a long random string (set in the n8n UI only, never in this repo). Select it on both webhook nodes (`Etsy Order Webhook`, `Etsy Shipped Webhook`).
- Add an Access bypass policy for `/webhook/jarvis/etsy/order` and `/webhook/jarvis/etsy/shipped` for the external caller (not applied by this change).

War Mode: this flow does not alert or interrupt anyone; drafts wait in Approvals.
