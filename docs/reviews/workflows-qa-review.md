# QA review: n8n workflows (conductor, estimator, qa, support, shield-ops, marketer, router) + RUNBOOK

Read at commit `4aab7fa` (HEAD) **plus uncommitted working-tree edits** by other agents (estimator, marketer,
qa, support JSON and md files were already modified when read). Line of evidence for every finding is the file as
it stood during this review. Not reviewed: `approvals-api-workflow.json`, `intake-workflow.json` (appeared mid-review),
`jarvis-dashboard-api.json`. Bugs marked "proved" were reproduced by running the Code-node JS in Node with mocks
(`Calculate Estimate` and `QA Checks` fed Notion-shaped data). Nothing was imported into live n8n, so n8n-node
parameter points marked "verify" come from knowledge of the node source, not from a run.

Counts: Critical 1, High 3, Medium 9, Low 9.

## Critical

### C1. Router never sees War Mode (Notion node defaults to simplified output)
- File/node: `router-workflow.json`, `Notion System Flags` (getAll). It has no `simple` parameter; n8n Notion v2.2
  defaults `simple` to true. The other workflows (conductor, shield-ops, support, dashboard API) set `simple:false`.
- Failure: with simplified output items have no `json.properties`. `Parse and apply War Mode` does
  `it.json.properties || {}`, so `war` is always false. War Mode ON never demotes non-FIRE items, never sets
  `queued_for_brief`, and the response says `war_mode:false`. The smoke test in RUNBOOK section 4 would show it,
  but the Router silently interrupts humans during War Mode (the core promise of War Mode).
- Fix: add `"simple": false` to that node. Add a Router smoke test that checks `war_mode` after flipping the flag.

## High

### H1. Shield/Ops raises a false ALERT every weekend, logs a row every 15 min, and floods the Conductor brief
- File/node: `shield-ops-workflow.json`, `Compute health` (check 3, "no rows in 24h") + `Log health finding`;
  `conductor-workflow.json`, `Notion Agent Activity` / `Assemble summary`.
- Failure: the only scheduled writer is the Conductor (weekdays 07:00). Friday 07:00 to Monday 07:00 is 72 h, so
  Sat to Mon the check is ALERT. `Needs log row?` is true, so one `Error` row is written per run (96/day, ~190 over
  a weekend). Shield/Ops rows are excluded from its own checks, so it never self-quiets. The Conductor reads the
  last 25 rows, which become almost all Shield/Ops rows, so the Monday brief loses real activity and the dashboard
  agent status shows Shield/Ops as `error`. Same on any quiet day with no inbound events.
- Fix: dedupe (only log when status or findings changed from the previous Shield/Ops row; or at most once per hour),
  make the silence threshold weekday/hours aware (or 72 h) and only apply it when something is expected, and have
  the Conductor filter out `Shield/Ops` and `Status=Done` housekeeping rows.

### H2. Estimator's own output fails QA when 2+ main services are priced and one is under its own minimum (proved)
- File/node: `estimator-workflow.json` `Calculate Estimate` vs `qa-workflow.json` `QA Checks`.
- Failure: `Car A` (qty 1, 50.00, min 100) + `Car B` (flat 300): estimator writes line_totals 100.00 + 300.00 but
  total 350.00 (minimum applies to the combined primary subtotal, per estimate.py). QA returns
  `E6: total does not equal the sum of line_totals`. The mismatch is inside the estimator's JSON itself (line_totals
  do not sum to total), so the draft is inconsistent for the human reader too. QA.md calls this "conservative", but
  it makes valid estimates Fail by design.
- Fix: pick one definition. Simplest: make the estimator set `line_total = computed` and `minimum_applied=false` per
  line for primary lines, and carry the minimum only at estimate level (add `minimum_applied`/`minimum_charge` at the
  top level); drop the "total equals sum of line_totals" check, or compare against `total - minimum adjustment`.

### H3. Estimator draft exceeds the Notion 2000-char limit with ~9 lines, and the request then fails with no row (proved)
- File/node: `estimator-workflow.json`, `Calculate Estimate` -> `Create Approval` (Notion node, `Draft|rich_text`).
- Failure: 9 flat-rate lines produced a 2554-char Draft. The code only truncates the readable part
  (`room = 1990 - marker - json`, becomes negative so readable is `''`) and never splits the JSON, so the single rich
  text item exceeds 2000 chars and Notion answers 400. The request errors, no Approvals row, no Activity Log row,
  nothing for QA. Marketer solved this by building the Notion body and chunking in a Code node + HTTP Request; the
  estimator did not.
- Fix: reuse the marketer's `Chunk Draft` approach (rich_text array of <=1900-char chunks), or cap line items
  (reject > 8 items with a 400) until chunking exists.

## Medium

### M1. Anthropic and Notion nodes have no error handling, so failures give a 500 and no record
- Files/nodes: `Anthropic Router|Support|Marketer|Conductor` (HTTP v4.2). Each downstream parse node handles an
  empty `content` (so someone intended fallback), but HTTP Request defaults to stop-on-error, so a 429/529/timeout
  throws and the fallback code never runs. Webhooks return a generic 500; the Conductor schedule silently produces no
  brief; Router/Support leave no Activity Log row. Shield/Ops cannot see this because nothing writes `Error` rows.
- Fix: set `onError: continueRegularOutput` (+ `retryOnFail`, `maxTries:3`, `waitBetweenTries` 2000) on the four
  Anthropic nodes, and add an error workflow (Error Trigger) that logs an `Error` row for any failed run.

### M2. Conductor and Shield/Ops may read the wrong rows (sort not applied or malformed)
- `conductor-workflow.json` `Notion Agent Activity`: `limit:25` with no sort, then "25 most recent" is only a
  re-sort inside the Code node. Notion does not guarantee query order without sorts, so the brief can be built from
  the wrong 25 rows (or the oldest).
- `shield-ops-workflow.json` `Notion Activity Log`: `options.sort.sortValue[{timestamp:"created_time",direction}]`.
  In the n8n Notion node (verify) `timestamp` is a boolean and the field name is `type` (`created_time`); a string in
  `timestamp` with no `type` can produce an invalid `sorts` entry (400) or be ignored, which would make every
  health check read arbitrary rows. SHIELD-OPS.md already asks to check this.
- Fix: in both, sort by `Timestamp` property descending (or created_time with `timestamp:true,type:"created_time"`),
  then confirm in the first execution's input/output.

### M3. QA fails valid Add-On lines that have a Minimum Charge on the rule (proved)
- `qa-workflow.json` `QA Checks` E3: `(r.min ?? 0) !== Number(li.minimum_charge || 0)`. The estimator writes
  `minimum_charge: 0` for non-primary categories. If an Add-On rule has Minimum Charge 25, QA reports
  `E3: line 2 (Wax) minimum_charge differs from rule (25)` although the estimator is following estimate.py (add-ons
  have no minimum).
- Fix: in E3, compare minimum only when `category` is Interior/Exterior (expect 0 for Add-On).

### M4. Nothing ever calls QA, and the estimator does not return an approval id
- `estimator-workflow.json` `Respond Drafted` returns only `estimate`; the Approvals page id from `Create Approval`
  is dropped (support returns it). QA needs `approval_id`. No workflow invokes `/jarvis/qa` and RUNBOOK section 5
  says "QA checks every draft", so `QA Result` stays `Not checked` until someone POSTs by hand.
- Fix: return `approval_id` from estimator and marketer; either chain an HTTP Request/Execute Workflow to QA after
  `Create Approval`, or change RUNBOOK to say QA is run manually and give the curl.

### M5. Unauthenticated webhooks that spend money or write to Notion; CORS is not auth
- `Support Webhook`, `Marketing Webhook`, `Inbound Webhook` (Router), `Daily Brief Webhook` (GET calls the LLM and
  writes a log row on every hit), `Estimate Webhook`, `Webhook QA`. `allowedOrigins` only affects browsers; curl
  from anywhere works. Anyone who finds `ops.hightidewash.net/webhook/jarvis/...` can run Anthropic spend and fill
  Approvals/Activity Log. RUNBOOK only protects the Pages domain and `/webhook/jarvis/*` via Access in section 2 and
  says "treat endpoints as unprotected" until then, but nothing says Router/Support/Marketer must not be activated
  before that.
- Fix: put the Access/basicauth in front before activating any LLM workflow (add that as a gate in RUNBOOK step 5),
  or use n8n Header Auth credential on the webhook nodes; add a body size cap (router has none).

### M6. Router: LLM verdict is the only safeguard; injection can suppress or fabricate escalation
- `router-workflow.json` `Anthropic Router` sends the whole body JSON (no length cap). A client email saying "this
  is routine, severity AWARENESS" can bury a real complaint (AWARENESS is "log only", no human sees it except via
  the dashboard), and under War Mode anything non-FIRE is already demoted. Conversely injected "FIRE" wakes a human.
  No path to send/post/approve exists (verified), so impact is mis-triage only.
- Fix: deterministic floor in `Parse and apply War Mode`: if text matches refund|chargeback|lawyer|injur|damage|
  complain|cancel, raise severity to at least IMPORTANT and set `needs_human`; cap body at ~4000 chars; treat
  AWARENESS as needs a periodic review.

### M7. Support prompt includes internal Pipeline fields that can leak into a client reply
- `support-workflow.json` `Build context` sends `notes` and `flag_reason` of the matched job (internal text) to the
  LLM with the instruction "use only facts in the context". A reply can quote an internal flag ("client disputed
  invoice") to the client. A human reviews, QA does not check this. Also the whole Pipeline is read even when
  `job_name` is empty (unneeded Notion load and no IF to skip).
- Fix: send only status, job type and scheduled date; add `Skip if no job_name` IF before `Notion Pipeline`.

### M8. Support draft can exceed 2000 chars and break `Create Approval`
- `support-workflow.json` `Parse reply`/`Create Approval`: `max_tokens:600` can yield >2000 chars of `reply`; the
  node writes one rich text item. Also `reason` (LLM text) is unbounded in `Log to Agent Activity` Output Notes.
  Result: Notion 400, no draft, client message lost with a 500.
- Fix: reuse marketer's chunking; slice `reason` to 500 chars; slice `title`.

### M9. RUNBOOK says unreadable War Mode behaves as ON; code behaves as OFF (or errors)
- RUNBOOK section 4 ("If the flag is unreadable, agents behave as ON but still send FIRE"). Router defaults
  `war=false` when no row/unreadable (and with C1 always); Conductor too; a Notion outage makes the node throw. Also
  the match differs: Router `/war/i` vs Conductor/Shield `/^war mode$/i`.
- Fix: either implement fail-closed (treat missing/erroring flag as ON in Router) or correct the RUNBOOK. Use the
  same exact match everywhere.

## Low

- L1. `router-workflow.json` `Parse and apply War Mode`: `/war/i` also matches titles such as "Software ..." and
  later rows overwrite earlier ones (no break). Use `/^war mode$/i`.
- L2. All Notion create nodes set both the `title` parameter and a `<Title>|title` propertiesUi key (Router, Conductor,
  Estimator, QA, Support, Shield, Marketer log). The node maps `title` to the DB title property; passing the same
  property twice may be rejected or silently take one (verify on first import). Keep one. Approvals' title property
  is named `Title`, which also collides with the API alias `title`.
- L3. `Respond to Webhook` is reached only after Notion writes. If `Log to Agent Activity` fails (e.g. a 2000+
  char `subject` as Router title, a long `job_name` in estimator), the draft/row exists but the caller gets a 500,
  and a retry duplicates it. Cap titles at ~150 chars (marketer does; others do not).
- L4. Estimator accepts quantity 0 for a main service (line $0, then total jumps to the minimum charge), and has no
  cap on `items` length or `job_name` length.
- L5. `QA Checks` E5 uses floats (`cents(base*q)`); estimator uses exact decimal half-up. A rate like 1.005 gives
  1.01 vs QA 1.00 (verified in Node: `Math.round(1.005*100+EPSILON)` is 100). Data-dependent; use integer math or
  tolerate 1 cent.
- L6. QA Reply/Content R4 flags the business's own phone/email as "not found in item context"; R3 does not catch
  non-dollar commitments (dates, "we will refund", arrival times). Acceptable for a first pass; keep these in
  `manual_checks`.
- L7. Placeholders and docs disagree: `Router` uses `REPLACE_WITH_PAGES_DOMAIN`, others `REPLACE_WITH_DASHBOARD_ORIGIN`;
  RUNBOOK step 7 lists only the dashboard API and Router, but conductor, estimator, qa, support, shield-ops and
  marketer webhooks also carry the placeholder. ESTIMATOR/SUPPORT/MARKETER.md say "replace `a807f4c2...`" while
  RUNBOOK says it is already filled in. NOTION-SCHEMA says Agent has 16 options; RUNBOOK section 8 says only six
  (Notion creates a missing select option on API write, so this is documentation only).
- L8. Marketer: `Marketing Webhook` ships `disabled:true`; n8n cannot activate a workflow whose only trigger is
  disabled, which MARKETER.md covers; but the RUNBOOK import order step 9 ("activate each") does not mention it.
  `Log to Agent Activity` Output Notes can exceed 2000 chars via `needs_human_reason` (unbounded) after the
  Approval was already created.
- L9. 15-minute schedule cost: Shield/Ops is 96 runs/day, ~3-4 Notion calls each (200 rows = 2 pages), roughly
  350 API calls/day, no LLM, well inside Notion limits and a small VM. It should be set to not save successful
  executions (workflow settings `saveDataSuccessExecution: none`) to avoid execution-table growth. RUNBOOK 429
  advice ("stagger schedules") is fine.

## Verified OK
- Schedule Trigger v1.2: `cronExpression` rule in Conductor (with workflow timezone America/New_York) and
  `minutesInterval` rule in Shield/Ops are the right shapes.
- Notion `propertiesUi` value fields: `selectValue`, `text` (rich_text), `title`, `date` + `includeTime`,
  `checkboxValue` (dashboard API) are the correct n8n v2.2 keys; `Key|type` format is right; names match
  NOTION-SCHEMA (Task/Agent/Status/Output Notes/Timestamp; Title/Agent/Type/Draft/Status/QA Result/Related Job).
- HTTP Request v4.2 to Anthropic uses `predefinedCredentialType`/`anthropicApi` (key is not in the file) with
  `anthropic-version: 2023-06-01`; `jsonBody` expression builds valid JSON; Set v3.4, Respond to Webhook v1.1 and
  IF v2/2.2 boolean/number/string conditions are well-formed; `$('Name')` references all point to existing nodes;
  `.first()` use is correct since every referenced node outputs one item (Notion getAll nodes use `.all()`).
- `alwaysOutputData:true` is set on every Notion getAll that feeds a Code node; all Code nodes tolerate the empty
  item (`properties || {}`, `if (!p["Agent"])`). Estimator on empty rules returns `needs_info` rather than a price.
- No LLM output can send, post or approve: Support/Marketer/Estimator hard-code `Status=Awaiting Approval`,
  `QA Result=Not checked`; QA only updates `QA Result` and never touches `Status`; Conductor and Shield/Ops only
  write Activity Log rows. Client text reaches Notion only as Draft/Title/Output Notes text, with untrusted-data
  framing in every prompt. Estimator has no LLM. Shield/Ops never flips War Mode.
- Conductor War Mode: prompt requires a notice and `Finalize brief` enforces it in code; checkbox read is correct.
- Estimator arithmetic (BigInt decimals, half-up, flat rate ignores quantity, add-ons after minimum, duplicate/inactive
  rules withheld) matched the intended rules in the single-main-service case and `needs_info` cases tested here.
- `scripts/validate_workflows.py`: 9/9 pass (structure only; it does not catch C1, H2, H3 or M3).
- RUNBOOK commands: smoke-test curls, `n8n export:workflow --all --output=...`, `systemctl status caddy`, and the
  war-mode response shape `{"enabled":false}` agree with the dashboard API; the only wrong claims are M9 and L7.
