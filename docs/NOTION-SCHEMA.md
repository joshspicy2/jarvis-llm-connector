# Notion Data Model (Jarvis)

Notion is the only source of truth (see `AGENT-WORKFLOW.md`). This doc lists what exists, what reads/writes it,
and designs the one missing database, **Approvals**. No credentials or private values here. Database IDs live in
the n8n workflow JSON (`dashboard/n8n/*.json`), not repeated here.

Verification: Pipeline, Estimate Rules, System Flags and Agent Activity Log were verified from the live
workspace. **Clients and Invoices exist but their schemas are NOT verified here**; check before relying on them.
n8n workflows are untested against live Notion (see `dashboard/n8n/README.md`), so property names below are the
ones the workflows use, and a rename in Notion breaks them.

## 1. Existing databases

Legend: R = reads, W = writes. "Planned" = per `AGENT-WORKFLOW.md`, no workflow yet. "Dashboard API" =
`dashboard/n8n/jarvis-dashboard-api.json`; "Router" = `dashboard/n8n/router-workflow.json`.

### Pipeline
| Property | Type | Values / notes |
|---|---|---|
| Job Name | title | |
| Status | select | Booked, In Progress, Awaiting Invoice, Paid, Flagged |
| Job Type | select | Interior Cleaning, Exterior Wash |
| Assigned To | select | Makenzie, Joshua, Both |
| Scheduled Date | date | |
| Notes | rich text | |
| Flag Reason | rich text | |
| Client | relation | to Clients |
| Invoice | relation | to Invoices |

Used by: Dashboard API reads `Status`, `Scheduled Date`, `Job Type` (matched by `/^status$/i`, `/^job type$/i`,
exact `Scheduled Date`). Planned: Conductor R/W (moves to Booked), Support R, Marketer R (wins), Shield/Ops R/W (Flagged).

### Estimate Rules
| Property | Type | Values / notes |
|---|---|---|
| Service | title | |
| Category | select | Interior, Exterior, Add-On |
| Base Rate | number (dollar) | |
| Unit | select | Per Sqft, Per Room, Flat Rate, Per Hour |
| Minimum Charge | number | |
| Active | checkbox | only Active rows may price an estimate |
| Notes | rich text | |

Used by: Dashboard API R (`Active`, `Base Rate`, `Minimum Charge`, `/^category$/i`, `/^unit$/i`, `/^notes$/i`).
Planned: Estimator R, QA R (recomputes independently). Nobody writes it except a human.

### System Flags
| Property | Type | Notes |
|---|---|---|
| Flag | title | e.g. "War Mode" (matched `/^war mode$/i` in Dashboard API, `/war/i` in Router) |
| Value | checkbox | checked = ON |
| Notes | rich text | |

Used by: Router R (War Mode demotes non-FIRE to queued brief). Dashboard API R and W (`Value|checkbox` update
from the war-mode POST). Planned: Conductor R, Shield/Ops R.

### Agent Activity Log
| Property | Type | Values / notes |
|---|---|---|
| Task | title | Router writes `Route: <subject>` |
| Agent | select | 16 options, see below |
| Status | select | Idle, Thinking, Working, Done, Error |
| Timestamp | date | with time |
| Output Notes | rich text | Router writes the routing JSON |

Agent options. Legacy: Router, Estimate Agent, Scheduling Agent, Finance Agent, Content Agent, Analytics Agent.
New: Conductor, Estimator, Marketer, Builder, Support, QA, Engineer, Researcher, Developer, Shield/Ops.
The Dashboard API aliases legacy names (Estimate to Estimator, Content to Marketer, Integrator to Conductor) and
strips a trailing " Agent". Adding the new names in Notion is still a Joshua TODO (`WORKFLOW-TRACKS.md`).

Used by: Router W (create, `Agent = Router`, `Status = Done`). Dashboard API R (`Timestamp`, `/^agent$/i`,
`/^status$/i`, `/^output notes$/i`). Planned: every agent W (one row per task).

### Clients, Invoices (unverified)
Exist; Pipeline relates to both. Estimator and Support are planned readers of Clients; Support and Shield/Ops of
Invoices (Stripe to Notion matching). Properties unknown, so no n8n workflow should reference them until verified.

## 2. Exact property strings used by n8n

n8n Notion node `propertiesUi` keys are `"<Property Name>|<type>"`. The only writes today:

| Workflow node | Database | Keys |
|---|---|---|
| Log to Agent Activity (Router) | Agent Activity Log | `Task|title`, `Agent|select`, `Status|select`, `Output Notes|rich_text`, `Timestamp|date` |
| Notion Update War (Dashboard API) | System Flags | `Value|checkbox` |

Read-side names: `Scheduled Date`, `Active`, `Base Rate`, `Minimum Charge`, `Value`, `Timestamp` (exact, case
and spaces matter); `Status`, `Job Type`, `Category`, `Unit`, `Notes`, `Agent`, `Output Notes` (case-insensitive).
Select option text (Done, Router, Shield/Ops, etc.) is also matched literally, so renaming options breaks things.

## 3. Proposed: Approvals database

Why: every agent "lands drafts in Awaiting Approval" but no database holds them. Approvals is that queue.

| Property | Type | Notes |
|---|---|---|
| Title | title | short label, e.g. "Estimate: <client/job>" |
| Agent | select | author; same names as Activity Log new set |
| Type | select | Estimate, Reply, Content |
| Draft | rich text | full text to send/post; Notion caps rich text near 2000 chars per block, so long drafts go in the page body |
| Status | select | Awaiting Approval, Approved, Rejected, Sent |
| Related Job | rich text | Pipeline job name or page URL for now; becomes a relation to Pipeline later |
| QA Result | select | Pass, Fail, Not checked |
| Created | created time | automatic |
| Decided By | select | Makenzie, Joshua (optional) |
| Decided At | date | optional, set when Status leaves Awaiting Approval |

Who reads/writes:
| Agent | Access |
|---|---|
| Estimator, Support, Marketer, Builder, Engineer, Developer | W create only, with `Status = Awaiting Approval`, `QA Result = Not checked` |
| QA | R drafts; W `QA Result` only. **Never touches `Status`.** |
| Conductor | R (queue health, moving the job to Booked after Sent) |
| Router, Researcher, Shield/Ops | Shield/Ops R (audit: anything Sent without Approved); others none |
| Human (Makenzie client comms, Joshua system changes) | W `Status`, `Decided By`, `Decided At` |

### State machine
```
create (agent) -> Awaiting Approval --human--> Approved --send step--> Sent
                                     \--human--> Rejected   (terminal; agent may create a new revised row)
```
Rules:
1. Only a human moves Status off Awaiting Approval. Agents (including QA) may not set Approved or Rejected.
2. QA sets `QA Result` (Pass/Fail) on Awaiting Approval rows. Fail does not block the human, but the view shows it
   and a Fail row should not be approved without a reason in the page body.
3. Approved to Sent happens only after the content actually went out. Recommend a human or a send step sets it, and
   it must check `Status = Approved` immediately before sending.
4. Sent and Rejected are terminal. Edits to Draft after Approved must reset Status to Awaiting Approval.
5. Log each transition and each draft creation in Agent Activity Log.

### DDL
Run in Notion (create database under the Jarvis workspace page). Dialect: TITLE, SELECT('a':color,...), RICH_TEXT,
CREATED_TIME, DATE, CHECKBOX.

```sql
CREATE TABLE ("Title" TITLE,
  "Agent" SELECT('Conductor':blue,'Estimator':green,'Marketer':purple,'Builder':orange,'Support':yellow,'QA':red,'Engineer':gray,'Researcher':brown,'Developer':pink,'Shield/Ops':default),
  "Type" SELECT('Estimate':green,'Reply':blue,'Content':purple),
  "Draft" RICH_TEXT,
  "Status" SELECT('Awaiting Approval':yellow,'Approved':green,'Rejected':red,'Sent':blue),
  "Related Job" RICH_TEXT,
  "QA Result" SELECT('Pass':green,'Fail':red,'Not checked':gray),
  "Created" CREATED_TIME,
  "Decided By" SELECT('Makenzie':pink,'Joshua':blue),
  "Decided At" DATE)
```
**Created 2026-10-30** under the Jarvis hub page by this exact statement (it ran without dialect errors). Database ID `a807f4c25dfe4ce388626726b7d99f6d`, data source `collection://225d1768-7fc0-4d50-8b88-cd973cce7dec`. Still to do by hand: the views below, and sharing it with the n8n integration.
After creating: share the database with the n8n Notion integration and record its ID in the workflow JSON.

### Pages and views
- **Needs Approval** (default): filter `Status = Awaiting Approval`, sort `Created` ascending, show Title, Agent,
  Type, QA Result, Related Job. Pin to the Jarvis home page; this is Makenzie's daily queue.
- **Ready to Send**: `Status = Approved`, sorted by `Decided At`.
- **QA Failed**: `Status = Awaiting Approval` and `QA Result = Fail`.
- **History**: `Status` is Sent or Rejected, grouped by Type, newest first.
- **By Agent**: board grouped by `Status` for Joshua's review of agent quality.
- Template page per Type (Estimate: line items, assumptions, total; Reply: recipient, channel; Content: channel,
  timing) so Draft bodies stay consistent.
- Optional later: dashboard gets a `GET jarvis/approvals` endpoint (count of Awaiting Approval) alongside the
  existing ones.

## 4. Open questions
1. **How does an Approved item get sent?** Nothing sends automatically today. Options: (a) Makenzie sends by hand and
   flips to Sent; (b) an n8n workflow triggered on Status = Approved sends email/SMS/post and sets Sent. (b) needs a
   mail/SMS credential and a Joshua decision; until then Sent is manual.
2. Who notifies Makenzie that something is waiting (email, SMS, Notion notification)?
3. Does Approved need Notion-side enforcement that agents cannot edit Status? Notion has no per-property permission,
   so this is policy plus the Shield/Ops audit check, unless the n8n integration is split into read/create-only and
   a separate human-only path.
4. Switch Related Job to a relation to Pipeline now or later? A relation is better but needs Pipeline shared with
   the same integration; a rename of Job Name would not break a relation.
5. Estimate rows: should the structured result (line items, totals) live in Draft text or the page body? QA recomputes
   from Notion, so the Estimator must record which Estimate Rules rows it used.
6. Clients and Invoices schemas: verify and add sections here.
7. Do Rejected rows need a Reject Reason property? Probably yes; deferred to keep the first version small.
8. Legacy Activity Log options (Estimate Agent etc.): keep for history or migrate?
