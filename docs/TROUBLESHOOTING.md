# Jarvis first-run troubleshooting

Read this when you run a workflow for the first time. **No workflow in this repo has had a real execution**: none
has been imported into a live n8n or run against live Notion or the Anthropic API. The repo only checks them with
`scripts/validate_workflows.py` and Node tests of the Code nodes. Everything marked *unverified* below is a
suspect, not a known bug. Setup steps are in `docs/RUNBOOK.md`; property names are in `docs/NOTION-SCHEMA.md`.

Method for every workflow: run it once in test mode, open n8n -> Executions, click the first red or empty node,
look at its input and output, fix, repeat. Never paste real keys or client data into a ticket or chat.

## 0. Quick triage

| Symptom | Most likely cause | Section |
|---|---|---|
| Notion node: "Could not find database" / 404 | Database not shared with the integration (Approvals is easy to forget) | 1 |
| Panel empty or `undefined`, no node error | Property name mismatch or wrong item shape | 2, 3 |
| Estimator/Support/Marketer: Notion 400 on `Create Approval` | Draft body or chunk shape | 4, 5, 6 |
| Conductor / Shield/Ops: sort error or unsorted log | Sort option form | 5 |
| Works in curl, blocked in browser | `allowedOrigins` | 7 |
| Router says `war_mode: true` unexpectedly | Flag unreadable or title not `War Mode` | 8 |
| Reply "I could not reach the language model" / `llm_failed` | Anthropic credential or request | 9 |

## 1. Credentials and sharing
- Every Notion node, and every `Create Approval` HTTP Request node, needs the Notion API credential picked
  (files ship with the placeholder `Select your Notion credential`). Every `Anthropic ...` HTTP Request node needs
  the Anthropic API credential (`Select your Anthropic credential`).
- Share each database with the Notion integration (page menu -> Connections): Pipeline, Estimate Rules,
  System Flags, Agent Activity Log, Approvals. A shared parent page also shares children; a database shared only
  by link does not.
- A 401 from `api.anthropic.com` or `api.notion.com` means the credential is empty, wrong type or revoked.
  Note the `Intake` HTTP nodes use no credential on purpose (they call your own webhooks).

## 2. Property-name mismatches (highest risk)
Code nodes read `properties` by the exact names in `docs/NOTION-SCHEMA.md`. Names, case and spaces matter for
`Scheduled Date`, `Active`, `Base Rate`, `Minimum Charge`, `Value`, `Timestamp`; `Status`, `Agent`, `Type`,
`Draft`, `QA Result`, `Related Job`, `Title` are what the Approvals writer and reader use. Select option text
(`Awaiting Approval`, `Not checked`, `Done`, `Error`, `Shield/Ops`, `Conductor`) is matched literally.
- Symptoms: an empty panel, a row that is skipped, a Notion write failing with "property does not exist" or
  "select option ... not found" (how a live Notion handles an unknown select option from these nodes is *unverified*).
- Check: open the failing Notion node's output, compare each key to the schema doc, then compare the schema doc
  to the live database. The Clients and Invoices schemas are unverified; no workflow should read them.
- The Activity Log `Agent` select must contain the new names (`Conductor`, `Estimator`, `Support`, `Marketer`,
  `QA`, `Shield/Ops`, ...). Until they are added in Notion, log writes with those names can fail
  (*unverified* exact behaviour; this is a known TODO in `docs/WORKFLOW-TRACKS.md`).
- Write keys use the form `"<Property Name>|<type>"` (for example `Output Notes|rich_text`). The n8n Notion node v2.2
  `propertiesUi` key convention is *unverified* against a live instance (see `dashboard/n8n/ROUTER.md`).
- Fix in the Notion node or Code node in n8n, then copy the corrected JSON back through a PR. Do not rename
  Notion properties to fit the code.

## 3. `simple: false` shape
Notion `getAll` nodes use `simple: false`, which returns raw pages: `properties.<Name>.title[]`, `rich_text[]`,
`select.name`, `date.start`, `checkbox`, `number`. The Shape/Pick Code nodes depend on this.
- If a node was flipped to `simple: true` (the UI default for new nodes), items become flat keys such as
  `Name` or `property_value` and every Shape node returns empty or `undefined`. Set `Simplify` off again.
- If you add a Notion node by hand, turn Simplify off.
- Pagination: `returnAll: true` is set on the getAll nodes; a database with many rows makes the execution slow
  and can hit the Notion rate limit (about 3 requests per second, `429`; see RUNBOOK section 6).
- `Notion Get Approval` (QA) fetches one page by id; its output shape (page object vs. wrapped) is *unverified*.

## 4. Notion 2000-character limit
A Notion rich_text item holds at most 2000 characters; a longer item gets HTTP 400.
- Drafts (Estimator, Support, Marketer) go through the `Chunk Draft` Code node, which splits Draft into
  rich_text items of at most 1900 characters; `Create Approval` is an HTTP Request to `POST /v1/pages`.
  QA joins the chunks' `plain_text`. `Related Job` and `Title` are sliced.
- Still at risk: free text in Activity Log `Output Notes` (reason fields, routing JSON) goes in one item with the Notion node, so an unusually long value can fail the
  log write, and (because Respond comes after the write) the caller sees an error. Slicing was recommended in
  `docs/reviews/workflows-qa-review.md` (L3 and others); check the current Code node before assuming it is fixed.
- Rule of thumb: if a Notion write returns 400 with "should be ... 2000 or less", find the field and chunk or slice it.

## 5. Unverified: sort option and chunk HTTP body
These two are written from n8n conventions and docs, not from a live run.
- **Sort option form `Timestamp|date`.** `Notion Agent Activity` (Conductor) and `Notion Activity Log` (Shield/Ops) set
  `sort.sortValue[0] = {timestamp: false, key: "Timestamp|date", direction: "descending"}`. If n8n rejects it or
  ignores it, the newest rows are not first. Both Code nodes re-sort by timestamp in code and fetch 100 rows,
  so briefs and health stay correct, but confirm on first import. If the sort option errors, remove it and rely on
  the Code node. The dashboard `Activity Log` endpoint and Chat do their own ordering in Code (check the
  output order the first time).
- **Chunk HTTP body.** `Create Approval` sends `JSON.stringify($json.notionBody)` to
  `https://api.notion.com/v1/pages` with headers `Notion-Version: 2022-06-28` and `content-type: application/json`,
  using the Notion API credential via "predefined credential type". Unverified points: that n8n applies the
  `notionApi` credential to a raw HTTP request, that the JSON body mode accepts the stringified expression
  without double-encoding (symptom: Notion says the body is not valid JSON or `parent` is missing), and that the
  property names and select options in `notionBody` match the Approvals database exactly. Open the node
  input/output in the first execution; the Code node (`Chunk Draft`) output `notionBody` should be a plain object.
- A successful write returns the new page; `approval_id` in the response is that page id.

## 6. Webhook responses and Code nodes
- Webhooks are registered in test mode at `/webhook-test/...` and only in production (`/webhook/...`) after the
  workflow is Active. A 404 on a production URL almost always means the workflow is not Active.
- After editing a webhook path or method in n8n you must toggle Active off and on.
- Code nodes use `$('Node Name').first()` references; renaming a node breaks the reference silently.
- `Respond to Webhook` is reached only after the preceding Notion writes. If a Notion log write fails, the
  caller waits for the n8n timeout instead of getting a clean response.

## 7. CORS and `allowedOrigins`
- Every Webhook node has `allowedOrigins` set to a placeholder: `https://REPLACE_WITH_DASHBOARD_ORIGIN`
  (Router: `https://REPLACE_WITH_PAGES_DOMAIN`). Until you replace it, the browser blocks the call while curl
  works. Never use `*`.
- The value must match the page origin exactly: scheme + host (+ port), no path, no trailing slash. The page
  at `https://jarvis.hightidewash.net` needs that exact string.
- `allowedOrigins` controls the CORS response header only. It does not stop curl or other servers from calling
  the endpoint; that protection is Cloudflare Access or Caddy basicauth (RUNBOOK section 2).
- Cloudflare Access does not protect cross-origin calls; use the same-site domain and credentialed requests
  (`dashboard/README.md`). Preflight (`OPTIONS`) handling for credentialed POSTs from the dashboard is
  *unverified* against a live n8n.
- The dashboard CSP (`dashboard/_headers`) limits `connect-src` to its own origin and `https://ops.hightidewash.net`; a
  different n8n hostname needs `_headers` and `config.js` changes.
- `Intake` calls other workflows server-to-server, so CORS does not apply to those hops; the placeholder
  `https://REPLACE_WITH_N8N_BASE` must be set or the Intake calls fail with a connection error (502 `{stage}`).

## 8. War Mode flag unreadable
- Design: an unreadable or missing flag is treated as ON (only FIRE interrupts a human).
- What the JSON does today (read from the Code nodes; *unverified* at runtime):
  - Router (`Parse and apply War Mode`): starts `war = true`; sets it from the System Flags row whose title is
    exactly `War Mode` (case-insensitive), checkbox `Value`. A missing row or wrong title leaves it ON. A hard
    failure of the `Notion System Flags` node (no output) is not caught by the Code node; the node has
    `alwaysOutputData`, which should let the loop run with no items, so the result would be ON (*unverified*).
  - Conductor and Shield/Ops: start `war = false`. A missing row reads as OFF there, which disagrees with the design
    (noted in `docs/reviews/workflows-qa-review.md` M9). Shield/Ops only reports the flag.
  - Dashboard `GET /jarvis/war-mode`: the badge shows `War Mode: unknown` and the toggle is disabled when the read fails.
- Consequences: if everything seems to be queued for the daily brief (`queued_for_brief: true`, `needs_human: false`
  on non-FIRE items), check the System Flags row before assuming War Mode is really on: row titled exactly
  `War Mode`, checkbox property named `Value`, database shared with the integration.
- Verify with `GET /webhook/jarvis/war-mode` and with a routine `POST /webhook/jarvis/inbound` (look at
  `war_mode`).

## 9. Anthropic node retry and `onError` behaviour
All Anthropic calls are HTTP Request nodes to `https://api.anthropic.com/v1/messages`
(header `anthropic-version: 2023-06-01`, model `claude-sonnet-5-5`), using the Anthropic API credential.
- Router, Conductor, Support, Marketer: `retryOnFail` true, `maxTries` 3, `waitBetweenTries` 2000 ms, then
  `onError: continueRegularOutput`. After the last failure the node outputs the error body (no `content[0].text`)
  and the next Code node falls back:
  - Router: IMPORTANT / Conductor / `needs_human: true`, `llm_failed: true`, Activity Log Status `Error`.
  - Conductor: writes a plain non-LLM brief.
  - Support/Marketer: no Approvals row, Activity Log row with Status `Error`, HTTP 502 `{status:'error', needs_human:true, reason}`.
- Chat (`Anthropic Chat`): `onError: continueRegularOutput` but **no retry** configured; a failure returns
  `{"reply":"I could not reach the language model right now."}`.
- Intake does not retry: a failed Router or downstream call logs Status `Error` and returns 502 `{error, stage}`.
- A 4xx from Anthropic (401 bad key, 400 invalid request, model name not available to your key) is retried 3 times
  and then swallowed into the fallback, so the workflow looks "fine" but always falls back. Read the Anthropic
  node output in the execution to see the real error body.
- Whether the Anthropic credential's header injection works with "predefined credential type" on the HTTP node is
  *unverified*. Token usage/spend is not capped by these workflows.
- Model replies are parsed defensively (code-fence stripping, JSON extraction). A reply that is valid prose but not
  JSON is treated as unparseable, with the fallbacks above.

## 10. Intake chain
- Order: Router, Support and Estimator must be Active before Intake runs. `Call Router` etc. have `continueErrorOutput`
  routing to `Log Conductor Error` / `Respond 502`.
- `Decide` reads `severity`, `owner`, `needs_human` and `reason` directly from the Router's HTTP response body
  (the flat object `{severity, owner, ...}`). If the Router returns a different shape, or an unusable one, the item is
  held as `held_for_human` with no downstream call (*unverified*; check `Decide` input on the first run).
- Estimator items without `items[]` return `needs_intake` with no downstream call. This is expected, not a failure.
- `Conductor` must exist in the Activity Log `Agent` select.

## 11. Dashboard panels
- APPROVALS panel: endpoint `GET /jarvis/approvals` (read-only). Only rows with Status exactly `Awaiting Approval`
  show. A SAMPLE tag means the call failed (see RUNBOOK section 3).
- Chat: `POST /jarvis/chat` body `{"message": "..."}` (max 2000 chars; 400 on empty).

## 12. When to stop and escalate
- Anything that sends or could send client-facing content without a human: disable the workflow
  (RUNBOOK section 7) and tell Joshua. Drafts are only supposed to land as *Awaiting Approval*.
- Anything that looks like a leaked key: RUNBOOK section 6, rotate first.
- Do not edit production workflows without Joshua's approval; fix in the repo through a PR when a property name or
  node setting turns out wrong.
