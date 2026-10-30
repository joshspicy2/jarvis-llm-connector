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
3. In `Create Approval`, replace `REPLACE_WITH_APPROVALS_DATABASE_ID` with the real database ID.
4. In `Estimate Webhook` > Options, replace `https://REPLACE_WITH_DASHBOARD_ORIGIN` (never `*`).
5. Activate, then call the production URL.

## Request / response
Body: `{job_name, items:[{service, quantity}], notes}`. `items` must be a non-empty array and each
`service` a non-empty string, otherwise HTTP 400 `{status:"error", error}`.
- `{status:"needs_info", missing:[...]}`: unpriced items; total is withheld. Logged to Activity Log.
- `{status:"drafted", estimate:{lines, subtotal, minimum_applied, minimum_charge, total, missing, warnings}}`:
  Approvals row created (Type Estimate, Status Awaiting Approval, QA Result Not checked).
Money values are strings such as `"123.45"`.

## Approvals Draft format
Draft = readable text for Makenzie, then a line `[estimate-json]`, then compact JSON in the section 2.5
schema of `docs/design/router-and-estimator.md` (`rule_id` = Notion page id of the rule used, per-line
`minimum_applied`, `needs_human: true`). QA parses the JSON after the marker. Notion rich-text items hold at
most 2000 chars and the node writes one item, so the readable part is truncated first; the JSON never is
(a very large estimate whose JSON alone exceeds ~1900 chars would need splitting into several rich-text chunks).
An Add-On with no main service is reported as missing.

## Rules (same as estimate.py)
Case-insensitive service match; only Active rules; Flat Rate ignores quantity; Interior/Exterior minimum
charge (highest one) applies to the main-service sum; Add-Ons are added after it; no guessing, so any
missing rate, quantity or rule leaves `total` null.

## Not verified
Not imported into a live n8n. The Code node was checked against `estimate.py` in Node on one sample only.
War Mode is not consulted: the workflow never pages or interrupts a human.
