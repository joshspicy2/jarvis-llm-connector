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
  after the `[estimate-json]` marker (readable text may precede it), else parses the whole Draft as JSON. Rich-text chunks are joined: the Estimator, Support and Marketer workflows write Draft as several rich_text items of <=1900 chars and QA concatenates every item's `plain_text` before parsing (Notion Get Approval uses `simple:false`).

## Invocation
Nothing chains to this workflow; the Estimator, Support and Marketer return `approval_id` and you POST it to `/jarvis/qa` (curl above in each workflow's doc):
`curl -X POST https://<n8n-host>/webhook/jarvis/qa -H 'content-type: application/json' -d '{"approval_id":"<id>"}'`

## Estimate checks done in code
E1 shape, E2 rule exists and Active, E3 fields equal Notion, E5 computed/line_total/minimum_applied/2dp,
E6 subtotal/total/estimate-level minimum, E8 add-on needs a main service, E9 draft vs needs_info, E10 duplicate Active rules,
E11 rule Notes present, E13 secret/card pattern scan, E14 needs_human true. Flat Rate quantity must be 1.

Minimum charge follows `estimator/estimate.py`: it applies once to the combined Interior/Exterior subtotal using the
highest minimum among primary rules; Add-Ons are excluded. Each line's `line_total` must equal its `computed`
(per-line `minimum_applied` false); `total` must equal sum(line_totals) plus the estimate-level `minimum_adjustment`,
and `minimum_applied`, `minimum_charge`, `minimum_adjustment` are checked at estimate level (E6).
E3 compares `minimum_charge` to the rule only for Interior/Exterior lines; Add-On lines expect 0 whatever the rule says.
E8 (Add-On without a main service) is raised only for `draft`; a `needs_info` draft for an add-on-only request passes.
All money math is integer cents with half-up rounding (BigInt decimal), identical to the Estimator and estimate.py
(45 x 1.005 = 45.23 in both).

## Listed in `manual_checks` (human/LLM review)
E4 quantities vs intake, E7 services vs request, E12 invented assumptions, E13 internal rule-problem text,
plus E11 note conditions.

## Reply / Content checks
Non-empty, no placeholders (REPLACE_, TODO, TBD, [name], {{x}}), no `$` amounts or discount/guarantee wording,
no email/phone absent from the approval's Title/Related Job. Tone and facts go to `manual_checks`.

Pass means the deterministic checks passed; manual_checks still need a human.
