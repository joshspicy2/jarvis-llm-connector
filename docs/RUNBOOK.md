# Jarvis operator runbook (Joshua)

Scope: n8n on the Oracle Cloud Always Free ARM Ubuntu VM, behind Caddy at `ops.hightidewash.net`; Notion is the
source of truth; the dashboard is a static site (Cloudflare Pages planned); DNS is at Squarespace.
Never paste secrets into this repo, a chat, or a curl example. Credentials live only in the n8n UI.

Workflow files (all in `dashboard/n8n/`, each with a sibling `.md`; `dashboard/n8n/README.md` is the index):
`jarvis-dashboard-api.json` (7 webhooks, including `/jarvis/chat`), `approvals-api-workflow.json`
(`GET /jarvis/approvals`), `router-workflow.json`, `intake-workflow.json`, `conductor-workflow.json`,
`estimator-workflow.json`, `qa-workflow.json`, `support-workflow.json`, `shield-ops-workflow.json`,
`marketer-workflow.json`. `docs/NOTION-SCHEMA.md` defines the databases. Per-workflow detail: the `.md` files,
`docs/AGENT-WORKFLOW.md`. If something fails on the first run, read `docs/TROUBLESHOOTING.md`.

## 1. One-time setup (do in this order)

1. **Notion integration.** Notion -> Settings -> Connections -> Develop integrations -> new internal integration
   (read, update, insert content). Copy the token into n8n only (step 4), nowhere else.
2. **Share the databases** with that integration (page menu -> Connections -> add): Pipeline, Estimate Rules,
   System Flags, Agent Activity Log and **Approvals**. Approvals is mandatory: Estimator, Support and Marketer
   create rows in it, QA reads and updates it, and the Approvals API reads it. Skipping this gives "database not
   found" / 404 on `Create Approval` and `Notion Approvals`. Clients/Invoices are not used by any workflow
   (their schemas are unverified).
3. **Approvals database**: already created in Notion exactly as `docs/NOTION-SCHEMA.md` says (property names and
   select options must match, or the Notion nodes fail; do not rename them). Only a human moves Status off
   *Awaiting Approval*; agents never set Approved. Its ID (`a807f4c25dfe4ce388626726b7d99f6d`) is already in the
   workflows that use it (`Create Approval` Code node `Chunk Draft`, `Notion Approvals`); if you recreate the
   database, replace it everywhere.
4. **Create credentials in the n8n UI** (Credentials -> New). Names only; values are pasted in the UI and never
   written anywhere else:
   - **Notion API** (credential type `notionApi`): the integration token from step 1. Used by every Notion node
     and also by the `Create Approval` HTTP Request nodes (Estimator, Support, Marketer), which call
     `https://api.notion.com/v1/pages` with "predefined credential type" Notion API.
   - **Anthropic API** (credential type `anthropicApi`): your Anthropic key. Used by the HTTP Request nodes
     `Anthropic Router`, `Anthropic Conductor`, `Anthropic Support`, `Anthropic Marketer` and `Anthropic Chat`
     (dashboard API). The Estimator, QA, Intake, Approvals API and Shield/Ops workflows make no Anthropic call.
   No other credentials are needed. The Intake HTTP nodes call Router, Support and Estimator webhooks on your own
   n8n with no authentication, so keep those private to the instance.
5. **Import workflows in this order** (n8n -> Workflows -> Import from file). Activate each only after its checks:
   1. `jarvis-dashboard-api.json` (includes chat; needs Notion and Anthropic)
   2. `approvals-api-workflow.json` (Notion only)
   3. `router-workflow.json`
   4. `shield-ops-workflow.json` (War Mode / health)
   5. `conductor-workflow.json` (daily brief)
   6. `estimator-workflow.json`, then `qa-workflow.json`
   7. `support-workflow.json`, then `marketer-workflow.json`
   8. `intake-workflow.json` last: it calls Router, Support and Estimator over HTTP, so those must exist and be
      Active before you test it.
   This follows the rollout in `docs/AGENT-WORKFLOW.md` with the dashboard API first so you can see what happens.
   (This order is a recommendation, not something n8n enforces.)
6. **Pick the credential on every Notion node, every Anthropic node and every `Create Approval` node** in each
   imported workflow (files ship with empty placeholders: `Select your Notion credential` /
   `Select your Anthropic credential`).
7. **Replace placeholders.** Search each workflow for `REPLACE_WITH_`:
   - `https://REPLACE_WITH_DASHBOARD_ORIGIN`: the Webhook node's Allowed Origins in every workflow except Router
     (dashboard API 7 nodes, approvals-api, intake, conductor, estimator, qa, support, shield-ops, marketer).
   - `https://REPLACE_WITH_PAGES_DOMAIN`: Router `Inbound Webhook` only.
   - `https://REPLACE_WITH_N8N_BASE`: the three HTTP nodes in `intake-workflow.json` (`Call Router`,
     `Call Support`, `Call Estimator`); set it to this n8n's base URL, no trailing slash
     (planned `https://ops.hightidewash.net`).
   Use your dashboard origin (planned `https://jarvis.hightidewash.net`), never `*`. Quick check on your PC:
   `grep -rn REPLACE_WITH_ dashboard/n8n/` should show only repo copies; in n8n, open the Webhook and HTTP nodes
   and confirm none still contain it. Do not commit the filled-in values back to the repo.
8. **System Flags row.** A row whose `Flag` contains "War" must exist (checkbox `Value`). Create it, unchecked.
   Name it exactly `War Mode`: Router, Conductor and Shield/Ops match the title `War Mode` exactly
   (case-insensitive), and the dashboard toggle matches any title containing "War".
9. **Add `Conductor` and the other new agent names** to the Activity Log `Agent` select in Notion
   (`docs/NOTION-SCHEMA.md` lists them). Intake and Conductor write rows with Agent `Conductor`.
10. **Activate** each workflow (toggle top right) after its smoke test passes in test mode.
11. **Smoke tests** (see the sequence below).

### Smoke-test sequence

Run in order; stop at the first failure and read the execution in n8n -> Executions (and
`docs/TROUBLESHOOTING.md`). `N8N` is `https://ops.hightidewash.net`; add Access/basic-auth only if you enabled it.
Browser-origin checks (CORS) cannot be tested from curl; see the last step. Money and IDs below are placeholders.
```
N8N=https://ops.hightidewash.net

# 1. Read-only dashboard endpoints (Notion shared, workflow active)
curl -s $N8N/webhook/jarvis/war-mode          # expect {"enabled":false}
curl -s $N8N/webhook/jarvis/pipeline
curl -s $N8N/webhook/jarvis/estimate-rules
curl -s $N8N/webhook/jarvis/activity-log
curl -s $N8N/webhook/jarvis/agents
curl -s $N8N/webhook/jarvis/approvals         # expect [] until a draft exists

# 2. Chat (Anthropic credential). Expect {"reply":"..."}; on LLM failure the reply is
#    "I could not reach the language model right now."
curl -s -X POST $N8N/webhook/jarvis/chat -H 'Content-Type: application/json' \
  -d '{"message":"What is in the pipeline right now?"}'

# 3. Router (adds an Activity Log row)
curl -s -X POST $N8N/webhook/jarvis/inbound -H 'Content-Type: application/json' \
  -d '{"source":"test","from":"test@example.com","subject":"Smoke test","text":"Routine question about a quote."}'

# 4. Estimator: needs rules in Estimate Rules; replace REPLACE_WITH_SERVICE_NAME with a service that has an Active rule.
#    Expect {"status":"drafted","approval_id":...} or {"status":"needs_info","missing":[...]}.
curl -s -X POST $N8N/webhook/jarvis/estimate -H 'Content-Type: application/json' \
  -d '{"job_name":"REPLACE_WITH_TEST_JOB","items":[{"service":"REPLACE_WITH_SERVICE_NAME","quantity":1}],"notes":"smoke test"}'

# 5. QA on that draft (QA is not chained; run by hand with the approval_id from step 4)
curl -s -X POST $N8N/webhook/jarvis/qa -H 'Content-Type: application/json' \
  -d '{"approval_id":"REPLACE_WITH_APPROVAL_ID"}'

# 6. Support and Marketer drafts (Anthropic credential). Expect {"status":"drafted","approval_id":...}
curl -s -X POST $N8N/webhook/jarvis/support -H 'Content-Type: application/json' \
  -d '{"client_name":"Test Client","message":"Can you confirm my cleaning?","job_name":"REPLACE_WITH_TEST_JOB"}'
curl -s -X POST $N8N/webhook/jarvis/marketing -H 'Content-Type: application/json' \
  -d '{"channel":"facebook","topic":"Smoke test post","notes":"do not publish"}'

# 7. Approvals API now shows the drafts (status Awaiting Approval only, oldest first)
curl -s $N8N/webhook/jarvis/approvals

# 8. Intake end to end (calls Router, then Support or Estimator over HTTP; needs REPLACE_WITH_N8N_BASE filled in)
curl -s -X POST $N8N/webhook/jarvis/intake -H 'Content-Type: application/json' \
  -d '{"source":"test","from":"test@example.com","subject":"Smoke test","text":"Routine question about a quote.","client_name":"Test Client"}'

# 9. Conductor daily brief and Shield/Ops health (GET webhooks; both also run on a schedule)
curl -s $N8N/webhook/jarvis/daily-brief
curl -s $N8N/webhook/jarvis/health
```
Expected checks after the calls: new rows in the Agent Activity Log; steps 4, 6 and 8 create Approvals rows with
Status *Awaiting Approval* and QA Result *Not checked*; step 5 changes QA Result to Pass or Fail. Delete or reject
the test rows in Notion afterwards. Do not test War Mode POST with real data until you know the current state
(section 4). Chat, Router, Support, Marketer, Conductor (daily brief) and Intake (it calls the Router, and Support
when routed there) spend Anthropic tokens; Estimator and QA do not call the LLM.

12. **Browser origin check.** CORS is only exercised by the real dashboard. Open it from the Pages origin and confirm the
    header badge says `live`; a blocked request in the browser console while curl works means the Allowed Origins
    value does not exactly match the page origin (scheme, host, no trailing slash).

    If a Notion node says "database not found", share that database with the integration. No workflow has had a real
    execution; read the first execution of each in n8n -> Executions and fix property names.

## 2. Deploying the dashboard (Cloudflare Pages)

Full steps are in `dashboard/README.md`. Short version:
1. Cloudflare -> Workers & Pages -> Create -> Pages -> Connect to Git -> `joshspicy2/jarvis-llm-connector`.
2. Production branch `main`, framework None, build command empty, build output directory `dashboard`.
3. `_headers` applies a strict CSP: only this origin and `https://ops.hightidewash.net` for data. If the n8n
   hostname changes, update `connect-src` in `dashboard/_headers` and `N8N_BASE` in `dashboard/config.js`.
4. **Same-site domain (important).** Cloudflare Access cannot protect the cross-origin calls the page makes.
   Serve the dashboard at `jarvis.hightidewash.net` (same site as `ops.hightidewash.net`). DNS is at Squarespace,
   so add the custom domain in Pages, then add the CNAME record Pages tells you to in Squarespace DNS.
5. Then, in this order: put Access (Zero Trust -> Access -> Applications) in front of the Pages domain and
   `ops.hightidewash.net/webhook/jarvis/*` with an email allow-list; sign in once in the browser; set the n8n
   Webhook allowed origin to the exact Pages origin and `credentials: "include"`; verify the dashboard shows
   `live`. Until all of that is done, treat the endpoints as unprotected and put no real client data behind them.
   Alternative: Caddy `basicauth` on `/webhook/jarvis/*`.
6. The page is desktop-only (min width 1200px) by design.

## 3. Daily operations: reading the dashboard

Header badge:
| Badge | Meaning | Do |
|---|---|---|
| `live · n8n` | All panels loaded from n8n | Nothing |
| `partial · some sample data` | At least one endpoint failed | Look for panels tagged SAMPLE; check that workflow |
| `sample data (n8n unreachable)` | Every endpoint failed | Go to section 6, "n8n down" |

Panels: Pipeline (jobs by stage, from the Pipeline DB), Estimate Rules (empty until the Notion DB has rows),
Agents, Activity Log (newest last), War Mode toggle (`War Mode: unknown` means the flag could not be read and the
toggle is disabled).

Agent states: **active** = latest Activity Log row is Thinking/Working; **idle** = anything else recent;
**waiting** = blocked on input (for example Estimator needs pricing inputs); **error** = latest row is Error,
open that run in n8n -> Executions.

A **SAMPLE** tag (dashed amber) on a panel means that panel is showing fake demo data, not your business. Never
act on it. Steps: (1) hit that panel's endpoint with curl (smoke-test sequence in section 1); (2) if it fails, open the matching
workflow in n8n, confirm it is Active and check the last execution error; (3) common causes: workflow
inactive, Notion DB not shared with the integration, property name changed in Notion, CORS/Access origin
mismatch (browser console shows a blocked request while curl works). The Activity Log note
"Could not save War Mode (n8n unreachable) - reverted" means the toggle did not save.

Daily rhythm: read the Conductor's daily brief (Needs You / What Moved / Watch); clear *Awaiting Approval*;
check Agents for `error`; glance at the badge.

## 4. War Mode

- **What it does:** a Notion flag (System Flags row containing "War", checkbox `Value`). The Router and Conductor
  read it on every event. ON: only FIRE-severity items interrupt a human; everything else is queued for the
  daily brief (`needs_human` false, `queued_for_brief` true). It never changes severity, only who gets
  interrupted. It does not stop drafts or approvals. Unreadable flag: the design
  (`docs/design/router-and-estimator.md`) says treat as ON but still send FIRE. In the current JSON only the Router
  does this (missing War Mode row => ON). Conductor and Shield/Ops default to OFF when the row is missing, and a
  failed Notion read stops the node (see `docs/TROUBLESHOOTING.md`). Treat these defaults as unverified until run.
- **Who flips it:** Joshua (dashboard toggle or the Notion checkbox directly). Shield/Ops may recommend it;
  treat any automatic flipping as not yet built unless its workflow `.md` says otherwise.
- **Flip:** click the toggle on the dashboard (it POSTs `{enabled}` to `/jarvis/war-mode`; n8n writes Notion).
- **Verify the Notion flag** (do not trust the toggle alone): open System Flags in Notion, confirm the War row's
  `Value` matches, then:
```
curl -s https://ops.hightidewash.net/webhook/jarvis/war-mode
```
  Both must agree. Optionally POST a routine test to `/jarvis/inbound` and check `war_mode` and `queued_for_brief`
  in the response. If the toggle and Notion disagree, Notion wins; fix Notion by hand and reload.

## 5. Approval flow

1. Estimator, Support and Marketer write drafts as *Awaiting Approval* items (Approvals database per
   `docs/NOTION-SCHEMA.md`), never sending anything themselves. Drafts also appear in the Activity Log.
2. **QA** checks every draft (estimate math recomputed from Estimate Rules, no invented facts, tone, schema) and
   sets `QA Result` Pass/Fail. Per `docs/NOTION-SCHEMA.md` a Fail does not technically block you, but do not approve
   a Fail row without a written reason in the page body; fix source data or re-run the agent instead.
3. **Makenzie approves** client-facing estimates, replies and content (per `docs/AGENT-WORKFLOW.md`). Joshua
   approves production changes (n8n/Notion/infra) and merges PRs.
4. After approval a human sends/posts (or the Support workflow does, only if its `.md` says so), and the
   Conductor moves the job in Pipeline.
5. Rule of thumb: if you did not see it in Awaiting Approval, it was not approved. Anything client-facing found
   outside that queue is an incident (section 6).

## 6. Incident checklist

**n8n down** (badge `sample data (n8n unreachable)`):
1. SSH to the VM (Oracle Cloud console if SSH fails). Check Caddy and n8n are running (`systemctl status caddy`;
   n8n via however you run it, for example `docker ps`). Restart the one that is down.
2. `curl -sI https://ops.hightidewash.net` to test TLS/Caddy; read Caddy and n8n logs.
3. Check disk space and memory on the VM (free tier is small). Confirm workflows are still Active after restart.
4. Nothing is lost while down, but inbound events during the outage were not routed; re-check email/forms/Stripe
   manually for that window. Sending is human-gated, so no client harm from the outage itself.

**Notion 429s** (rate limit, about 3 requests/second): executions show `429` / `rate_limited`.
1. Turn off the noisiest triggers (dashboard auto-refresh is the likely load: close extra open dashboard tabs).
2. Retry on fail with a wait on the Notion nodes; stagger schedules; re-run failed executions after a few minutes.
3. If it repeats, note which workflow loops (Shield/Ops or Conductor) and disable it (section 7).

**A bad draft nearly sent:**
1. Do not send. Reject the item in Approvals and note why.
2. Disable the producing workflow (section 7) if the cause is systematic; otherwise fix the source data in Notion.
3. Find the cause in the execution (wrong rule, invented fact, missed QA). Record it in the Activity Log or a
   Notion note and add a QA check if it was missable. If anything did go out, contact the client yourself.

**Suspected secret leak** (token in a repo, chat, screenshot, log):
1. Rotate first, investigate second. Notion: regenerate the integration token. Anthropic: revoke/create a new key
   in the Anthropic console. Also rotate Cloudflare or Stripe credentials if they were involved.
2. Update the credential in the n8n UI only; confirm the workflows run.
3. Remove the secret from where it leaked; if it was committed, treat history as compromised (rotation is the fix,
   deleting the commit is not).
4. Check Notion integration activity and Anthropic usage for unexpected use. Log it.

## 7. Rollback

- **Back up before changing anything:** n8n -> workflow -> menu -> Download, or on the VM export with the n8n CLI
  (`n8n export:workflow --all --output=...`; credentials are not part of the safe export, never commit them). Keep
  the dated JSON files outside the repo or in a reviewed PR only after confirming no secrets are inside.
- **Stop a workflow now:** n8n -> toggle Active off. Disabling Router/Conductor stops inbound processing; the
  dashboard falls back to SAMPLE tags for panels it feeds.
- **Restore a workflow:** import the last known good JSON (this repo's version or your backup) over the broken
  one, re-pick credentials, re-check `REPLACE_WITH_*`, activate, re-run smoke tests.
- **Repo/dashboard change:** `git revert <commit>` (or revert the PR on GitHub) and merge; Pages redeploys from
  `main`. In Cloudflare Pages you can also roll back to a previous deployment from the Deployments tab.
- **Notion data:** page history (page menu -> Version history) restores edited pages; deleted items are in Trash.

## 8. Not yet built / known gaps

- The workflow JSONs and `docs/NOTION-SCHEMA.md` now exist in the repo, but none has been imported into a live n8n.
- Nothing has been test-imported into a live n8n or run against live Notion. Property names and n8n node
  parameters may need fixing on the first execution.
- Dashboard endpoints are unprotected until Access (or Caddy basicauth), same-site domain, and credentialed CORS are set up.
- `/jarvis/chat` is wired to Anthropic (`claude-sonnet-5-5`) in `jarvis-dashboard-api.json` but unverified against a live n8n; the Router is not part of it.
- QA is not chained to the draft-creating workflows; run `/jarvis/qa` by hand with the `approval_id`.
- Intake needs `REPLACE_WITH_N8N_BASE` filled in and sends unauthenticated calls to your own webhooks.
- Activity Log `Agent` select only has the old six names; new agent names must be added in Notion (the dashboard maps old to new).
- Open decisions for Joshua (`docs/AGENT-WORKFLOW.md`): Scheduling/Finance ownership, Builder/Engineer/Developer split,
  model per agent, notification channel for IMPORTANT items when War Mode is off.
- No automatic workflow backups, alerting/monitoring, or automated War Mode flipping documented; budget caps per run are
  a guardrail in the design, not a verified implementation.
- Cloudflare Pages project and the `jarvis.hightidewash.net` DNS record are not created yet.
- The wave background is a canvas stand-in for the planned React + Three.js scene.
