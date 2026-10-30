# Jarvis operator runbook (Joshua)

Scope: n8n on the Oracle Cloud Always Free ARM Ubuntu VM, behind Caddy at `ops.hightidewash.net`; Notion is the
source of truth; the dashboard is a static site (Cloudflare Pages planned); DNS is at Squarespace.
Never paste secrets into this repo, a chat, or a curl example. Credentials live only in the n8n UI.

Files this runbook depends on. Some are written by other agents and may not exist yet; check `ls` first.
- `dashboard/n8n/jarvis-dashboard-api.json` (dashboard API, 7 webhooks) and `router-workflow.json` (Router) exist.
- Planned, same folder: `conductor`, `estimator`, `qa`, `support`, `shield-ops`, `marketer` workflow JSONs
  (and their `.md` files). `docs/NOTION-SCHEMA.md` defines the Approvals database.
- Per-workflow detail: `dashboard/n8n/README.md`, `dashboard/n8n/ROUTER.md`, `docs/AGENT-WORKFLOW.md`.

## 1. One-time setup (do in this order)

1. **Notion integration.** Notion -> Settings -> Connections -> Develop integrations -> new internal integration
   (read, update, insert content). Copy the token into n8n only (step 4), nowhere else.
2. **Share the databases** with that integration (page menu -> Connections -> add): Pipeline, Estimate Rules,
   System Flags, Agent Activity Log, plus Clients/Invoices if the workflows use them.
3. **Create the Approvals database** (a proposal in the schema doc, not yet in Notion) exactly as `docs/NOTION-SCHEMA.md` says (property names and select options
   must match, or the Notion nodes fail). Only a human moves Status off *Awaiting Approval*; agents never set Approved.
   Share Approvals with the integration too.
4. **Create credentials in the n8n UI** (Credentials -> New): Notion API (the token from step 1) and Anthropic API
   (credential type `anthropicApi`, needed by Router and the agent workflows). Nothing goes in JSON files.
5. **Import workflows in this order** (n8n -> Workflows -> Import from file), activating each only after its checks:
   1. `jarvis-dashboard-api.json`
   2. `router-workflow.json`
   3. `shield-ops` (War Mode / budget / error watching)
   4. `conductor`
   5. `estimator`, then `qa`
   6. `support`, then `marketer`
   This follows the recommended rollout in `docs/AGENT-WORKFLOW.md` (Router, Conductor, Estimator, QA, Support,
   Shield/Ops) with the dashboard API first so you can see what happens.
6. **Pick the credential on every Notion and Anthropic node** in each imported workflow (files ship with empty
   placeholders).
7. **Replace placeholders.** Search each workflow for `REPLACE_WITH_`:
   `https://REPLACE_WITH_DASHBOARD_ORIGIN` (dashboard API, 7 Webhook nodes) and
   `https://REPLACE_WITH_PAGES_DOMAIN` (Router `Inbound Webhook`) -> your dashboard origin (planned
   `https://jarvis.hightidewash.net`). Never `*`. The Approvals database ID (`a807f4c25dfe4ce388626726b7d99f6d`) is already filled into the workflows that write Approvals; if you recreate the database, replace it everywhere.
   Quick check on your PC: `grep -rn REPLACE_WITH_ dashboard/n8n/` should show only repo copies; in n8n, open the
   Webhook nodes and confirm none still contain it.
8. **System Flags row.** A row whose `Flag` contains "War" must exist (checkbox `Value`). Create it, unchecked.
9. **Activate** each workflow (toggle top right) after its smoke test passes in test mode.
10. **Smoke tests** (no secrets needed; production URLs; add Access/basic-auth only if you enabled it):
```
curl -s https://ops.hightidewash.net/webhook/jarvis/war-mode
curl -s https://ops.hightidewash.net/webhook/jarvis/agents
curl -s https://ops.hightidewash.net/webhook/jarvis/pipeline
curl -s https://ops.hightidewash.net/webhook/jarvis/activity-log
curl -s -X POST https://ops.hightidewash.net/webhook/jarvis/inbound \
  -H 'Content-Type: application/json' \
  -d '{"source":"test","from":"test@example.com","subject":"Smoke test","text":"Routine question about a quote."}'
```
    Expected: war-mode returns `{"enabled":false}`; the inbound call returns
    `{severity, owner, reason, needs_human, summary, queued_for_brief, war_mode}`, and a new row appears in the
    Agent Activity Log. Do not test War Mode POST with real data until you know the current state (section 4).
    If a Notion node says "database not found", share that database with the integration. First live run of any
    workflow is untested against live Notion; read the first execution in n8n -> Executions and fix property names.

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
act on it. Steps: (1) hit that panel's endpoint with curl (section 1 step 10); (2) if it fails, open the matching
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
  interrupted. It does not stop drafts or approvals. If the flag is unreadable, agents behave as ON but still
  send FIRE (per `docs/design/router-and-estimator.md`).
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

- Workflows `conductor`, `estimator`, `qa`, `support`, `shield-ops`, `marketer` and `docs/NOTION-SCHEMA.md` are
  being written; this runbook assumes them and may name steps that need adjusting once they land.
- Nothing has been test-imported into a live n8n or run against live Notion. Property names and n8n node
  parameters may need fixing on the first execution.
- Dashboard endpoints are unprotected until Access (or Caddy basicauth), same-site domain, and credentialed CORS are set up.
- `/jarvis/chat` is a stub until the Router is wired to it.
- Activity Log `Agent` select only has the old six names; new agent names must be added in Notion (the dashboard maps old to new).
- Open decisions for Joshua (`docs/AGENT-WORKFLOW.md`): Scheduling/Finance ownership, Builder/Engineer/Developer split,
  model per agent, notification channel for IMPORTANT items when War Mode is off.
- No automatic workflow backups, alerting/monitoring, or automated War Mode flipping documented; budget caps per run are
  a guardrail in the design, not a verified implementation.
- Cloudflare Pages project and the `jarvis.hightidewash.net` DNS record are not created yet.
- The wave background is a canvas stand-in for the planned React + Three.js scene.
