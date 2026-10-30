# Jarvis QA workflow (`qa-workflow.json`)

Deterministic QA for Approvals drafts. No LLM call. Not imported into a live n8n.

## Flow
Webhook POST `/jarvis/qa` body `{"approval_id": "<Notion page id>"}` (400 if missing/not an id)
-> Notion get Approvals page -> Notion getAll Estimate Rules (`simple:false`)
-> Code node checks -> update Approvals `QA Result` (Pass/Fail) -> Agent Activity Log row (Agent `QA`)
-> respond `{result, failures:[...], manual_checks:[...]}`.

QA never edits Draft and never changes Status. It does not interrupt a human, so War Mode is not read.

## Setup
- Set the Notion credential on each Notion node (left empty). Webhook origin: `https://REPLACE_WITH_DASHBOARD_ORIGIN`.
- Add `Agent = QA` as an option in the Activity Log Agent select.
- Draft of an Estimate must contain the Estimator JSON (section 2.5 of router-and-estimator.md): QA reads the JSON
  after the `[estimate-json]` marker (readable text may precede it), else parses the whole Draft as JSON. Rich-text chunks are joined.

## Estimate checks done in code
E1 shape, E2 rule exists and Active, E3 fields equal Notion, E5 computed/line_total/minimum_applied/2dp,
E6 subtotal/total, E8 add-on needs a main service, E9 draft vs needs_info, E10 duplicate Active rules,
E11 rule Notes present, E13 secret/card pattern scan, E14 needs_human true. Flat Rate quantity must be 1.

Minimum charge follows `estimator/estimate.py`: it applies to the Interior/Exterior subtotal using the
highest minimum among primary rules; Add-Ons are excluded. Total must also equal the sum of line_totals,
so a draft with several primary lines where each line applies its own minimum will Fail (conservative).

## Listed in `manual_checks` (human/LLM review)
E4 quantities vs intake, E7 services vs request, E12 invented assumptions, E13 internal rule-problem text,
plus E11 note conditions.

## Reply / Content checks
Non-empty, no placeholders (REPLACE_, TODO, TBD, [name], {{x}}), no `$` amounts or discount/guarantee wording,
no email/phone absent from the approval's Title/Related Job. Tone and facts go to `manual_checks`.

Pass means the deterministic checks passed; manual_checks still need a human.
