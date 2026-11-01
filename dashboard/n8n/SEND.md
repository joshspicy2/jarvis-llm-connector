# n8n: Send step (safe by default, DRY_RUN)

`send-workflow.json` is the "send step" from the open question in `docs/NOTION-SCHEMA.md` (option b). It acts only on
Approvals rows a human has set to `Approved`, and **as shipped it cannot send anything**. Principle: nothing
client-facing is sent without human approval.

## Safe-by-default layers
1. The JSON ships with `"active": false`. Importing it does not start the schedule; Joshua activates it in n8n.
2. The `Recheck and decide` Code node ships with `const DRY_RUN = true`. While true, rows that pass every check are
   only logged as "would send". Nothing reaches the sender and **nothing is set to Sent**.
3. The `Send (DISABLED)` node is a NoOp with `disabled: true`, no credentials and no recipients. Its notes say Joshua
   must replace it with his real sender and enable it.
4. Success is explicit. `Confirm send result` marks an item confirmed only if `decision = send`, `dry_run = false` and
   the sender set `send_ok = true`. A disabled or silent sender passes items through without `send_ok`, so
   `Mark Sent` is never reached by accident.

## Flow
`Every 10 minutes` -> `Notion Approved rows` (Approvals DB, `simple: false`, filter `Status = Approved`, max 50) ->
`Select sendable` -> `Has candidates?` -> `Re-fetch page` -> `Recheck and decide` -> branches:
- `Needs reset?` -> `Reset to Awaiting Approval` (Status only).
- `Send?` -> `Send (DISABLED)` -> `Confirm send result` -> `Confirmed?` -> `Mark Sent` -> `Log Sent`.
- `Build outcome log` -> `Log to Agent Activity`. `Select sendable` also feeds `Build selection log` -> same log node.

### Select sendable (re-validates every row, never trusts the Notion filter)
A row is eligible only if all hold, else it is skipped and listed in the log:
- `Status` is exactly `Approved`.
- `QA Result` is not `Fail`, unless `Decided By` is set (a human accepted the Fail; schema rule 2).
- `Type` is in the whitelist `Estimate`, `Reply`, `Content` (the Type options in the schema).
- `Draft` is non-empty. Drafts that live only in the page body (long drafts) are skipped until the property has text.
- At most **5** rows per run (oldest decision first); the rest wait for the next run (10 minutes).

### Recheck and decide (immediately before sending)
The page is fetched again so the check sees current Notion state (schema rule 3). Per row:
- Rules above fail again (for example Status changed to Rejected or Sent): `skip`, nothing is changed.
- Last edited time is later than `Decided At` (plus a 5 minute grace), or Draft differs from the selected text:
  **do not send**; Status is set back to `Awaiting Approval` (schema rule 4) and the reset is logged.
  A date-only `Decided At` counts as the end of that day (UTC). Use a date with time for tighter protection.
- `Decided At` missing: `skip` (cannot prove no edit after approval). Humans should set it when approving.
- Otherwise: `would_send` while `DRY_RUN` is true, `send` when false.
Note the reset itself edits the page; that is fine because the row is back to Awaiting Approval.

### Logging
Every run that finds Approved rows writes to Agent Activity Log with `Agent = Conductor` (an existing option),
`Status = Done`, and counts plus titles in Output Notes (capped at 1900 chars). A run with no Approved rows still logs
the selection row. A confirmed send logs `Sent: <title>`. No new Agent option is needed.

## Writing to Notion
Only three writes exist: Status to `Awaiting Approval` (reset), Status to `Sent` (confirmed, live only), and Activity
Log rows. No property or select option is renamed or added.

## Setup
Import the JSON, select your Notion credential on each Notion node (none is stored in the file), leave it inactive.
Database ids are the same Approvals and Activity Log ids the other workflows use. Not yet run against live Notion;
expect to check property names on the first execution (Executions tab).

## Manual go-live checklist (Joshua)
1. Confirm the Approvals schema in Notion matches `docs/NOTION-SCHEMA.md` (Status, Type, Draft, QA Result,
   Decided By, Decided At).
2. Activate in n8n with `DRY_RUN = true` and let it run a day. Read the Activity Log "dry run" rows; they should list
   only rows a human approved.
3. Decide the approval policy: Makenzie approves every client-facing row (Reply, Estimate, Content) and sets
   `Decided By` and `Decided At` with a time. Joshua approves system changes only. Nobody approves a QA Fail without
   a reason in the page body.
4. Replace `Send (DISABLED)` with the real sender (email/SMS/post node with its credential set in the n8n UI, never in
   the repo). It must resolve the recipient from Notion (Related Job and the client), not guess, and must output the
   incoming fields plus `send_ok = true` on success only. Enable it.
5. Test with a self-addressed draft: create an Approvals row addressed to yourself, approve it as a human, set
   `DRY_RUN = false`, and confirm one message arrives, the row becomes Sent, and the log shows it. Also test an edit
   after approval (expect reset, no send) and a Rejected row (expect no send).
6. Only then leave `DRY_RUN = false` and keep the workflow active. To stop sending at any time, deactivate the
   workflow or set `DRY_RUN` back to `true`.
7. Run Shield/Ops audit for Sent rows without a prior Approved. Update `docs/NOTION-SCHEMA.md` open question 1.

## Limits
- War Mode is not read; the step only acts on rows a human approved, so it does not interrupt anyone.
- If the sender succeeds but `Mark Sent` fails, the row stays Approved and would be sent again on the next run.
  Keep the sender idempotent or watch the first live runs closely.
- Tests: `node --test 'tests/n8n/send_code.test.js'`.
