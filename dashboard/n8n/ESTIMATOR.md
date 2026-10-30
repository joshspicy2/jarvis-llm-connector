# Estimator workflow (n8n)

`estimator-workflow.json` turns a request into a DRAFT estimate for Makenzie to approve. Nothing is sent
to a client, and no LLM is involved: pricing is pure arithmetic over Notion Estimate Rules.

Flow: `POST /jarvis/estimate` -> validate body -> Notion Estimate Rules (getAll, simple off) ->
`Calculate Estimate` (Code node, port of `estimator/estimate.py`) -> if anything is missing, log and
respond `needs_info`; otherwise create an Approvals row, log, respond `drafted`.

## Setup
1. n8n: Workflows -> Import from File -> `estimator-workflow.json`.
2. Pick your Notion credential on each Notion node (shipped empty). Share the integration with the
   Estimate Rules, Agent Activity Log and Approvals databases.
3. In `Create Approval`, replace `a807f4c25dfe4ce388626726b7d99f6d` with the real database ID.
4. In `Estimate Webhook` > Options, replace `https://REPLACE_WITH_DASHBOARD_ORIGIN` (never `*`).
5. Activate, then call the production URL.

## Request / response
Body: `{job_name, items:[{service, quantity}], notes}`. `items` must be a non-empty array and each
`service` a non-empty string, otherwise HTTP 400 `{status:"error", error}`.
- `{status:"needs_info", missing:[...]}`: unpriced items; total is withheld. Logged to Activity Log.
- `{status:"drafted", approval_id, estimate:{lines, subtotal, minimum_applied, minimum_charge, total, missing, warnings}}`:
  Approvals row created (Type Estimate, Status Awaiting Approval, QA Result Not checked).
Money values are strings such as `"123.45"`. `approval_id` is the Notion page id of the new Approvals row.

## Running QA (not chained automatically)
No workflow calls QA for you. After a draft is created, run it by hand with the `approval_id` from the response:

```
curl -X POST https://<n8n-host>/webhook/jarvis/qa -H 'content-type: application/json' -d '{"approval_id":"<approval_id>"}'
```
(POST `/jarvis/qa`). Until then the Approvals row stays `QA Result: Not checked`.

## Approvals Draft format
Draft = readable text for Makenzie, then a line `[estimate-json]`, then compact JSON in the section 2.5
schema of `docs/design/router-and-estimator.md` (`rule_id` = Notion page id of the rule used, per-line
`minimum_applied` (always false; the minimum is estimate-level), `needs_human: true`). QA parses the JSON after the marker. Notion rich-text items hold at
most 2000 chars, so the `Chunk Draft` Code node splits the whole Draft (nothing truncated, `[estimate-json]` block included)
into several rich_text items of <=1900 chars. The Notion node v2.2 `propertiesUi` rich_text takes a single string and could
not be shown to emit multiple items, so `Create Approval` is an HTTP Request to `POST https://api.notion.com/v1/pages`
(Notion-Version 2022-06-28, `notionApi` credential left empty). QA joins the chunks' `plain_text`.
An Add-On with no main service is reported as missing.

## Rules (same as estimate.py)
Case-insensitive service match; only Active rules; Flat Rate ignores quantity; Interior/Exterior minimum
charge (highest one) applies once to the combined main-service subtotal (one model, shared with QA): every line's
`line_total` equals its `computed` amount, and `minimum_applied`, `minimum_charge` and `minimum_adjustment` are recorded at estimate level in the JSON
(`total` = sum of line_totals + adjustment); Add-Ons are added after it; no guessing, so any
missing rate, quantity or rule leaves `total` null.

## Not verified
Not imported into a live n8n. The Code node was checked against `estimate.py` in Node on one sample only.
War Mode is not consulted: the workflow never pages or interrupts a human.
