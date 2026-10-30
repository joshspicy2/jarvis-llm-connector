# Jarvis

Jarvis is the AI operations system for **High Tide Wash**, a family interior cleaning business. Notion is the single
source of truth. Agents draft; humans decide: **nothing client-facing is sent without human approval.**

> Repo name note: an earlier plan (a Python MCP server exposing Gemini and ChatGPT) was meant to live here, but that
> code is not in this repo (see `git log` and the tree).

## Status and limits
- Nothing is deployed. The n8n workflows have not yet been imported or run against live n8n or Notion.
- The dashboard works locally and falls back to clearly tagged sample data when endpoints are unreachable.
- Operator steps (import, credentials, hosting): `docs/RUNBOOK.md`. Never put secrets in this repo.

## Repo map
- `dashboard/` : static, no-build ops dashboard (`index.html`, `config.js`, `_headers`); see `dashboard/README.md`.
- `dashboard/n8n/` : importable n8n workflows (no credentials), each with a `.md` setup note (`README.md` covers the API one):
  - `jarvis-dashboard-api.json` : the seven `/webhook/jarvis/...` endpoints the dashboard calls, backed by Notion.
  - `router-workflow.json` : classifies inbound events (FIRE / IMPORTANT / ROUTINE / AWARENESS) and names an owner.
  - `estimator-workflow.json` : turns a request into a DRAFT estimate for approval.
  - `conductor-workflow.json` : daily brief (Needs You / What Moved / Watch).
  - `marketer-workflow.json` : drafts social/email content; never posts.
  - `support-workflow.json` : drafts client replies; never sends.
  - `qa-workflow.json` : deterministic checks on drafts, no LLM call.
  - `shield-ops-workflow.json` : read-only health check every 15 minutes.
- `estimator/` : pure-stdlib Python estimate calculator driven by Estimate Rules rows, with tests.
- `scripts/` : `validate_workflows.py` (n8n JSON checks), its tests, and `worktrees.sh` (track worktrees).
- `tests/` : `dashboard/smoke.test.js` (Playwright) and `n8n/code_nodes.test.js` (n8n Code-node tests).
- `docs/` : design and process docs (below), plus `design/` and `reviews/`.
- `.claude/agents/` : one definition file per agent (11).
- `.github/workflows/ci.yml` : CI running the checks below.

## How the pieces fit
```
 Dashboard (static) --HTTPS--> n8n webhooks --> Notion (source of truth)
                                    ^                |
   inbound events --> Router --> Conductor --> Estimator / Marketer / Support
                                    |                |
                                   QA  <-- drafts ---+--> "Awaiting Approval" --> human
                          Shield/Ops watches flags, errors, cost
```
Every run is logged to the Agent Activity Log, which the dashboard displays. War Mode (a Notion System Flag) limits
interruptions to FIRE-level items.

## Quickstart
Run the dashboard locally (from the repo root):
```
cd dashboard && python3 -m http.server 8000
# open http://localhost:8000
```
With no reachable n8n, panels show tagged sample data (the header badge shows live / partial / sample).

Run all checks (needs Python 3 and Node 22; the dashboard smoke test also needs the `playwright` npm package with a
Chromium browser, and a free port 8791):
```
python3 scripts/validate_workflows.py
python3 -I scripts/test_validate_workflows.py
python3 -m unittest estimator.test_estimate
node --test 'tests/n8n/*.test.js'
node tests/dashboard/smoke.test.js
```

## Agent roster
Details, handoffs and human gates: `docs/AGENT-WORKFLOW.md` (draft; several roles are marked proposed).
- **Conductor** : sequences handoffs, tracks job state, writes the daily brief.
- **Router** : classifies each inbound event and picks the owner agent.
- **Estimator** : builds a priced estimate from intake and Estimate Rules.
- **Marketer** : drafts social, ad and email content (Phase 2).
- **Builder** : assembles n8n workflows, Notion schema changes, integrations.
- **Support** : drafts client replies, follow-up nudges and payment reminders.
- **QA** : checks other agents' output before it reaches a human.
- **Engineer** : technical design, infra and reliability; decides how.
- **Researcher** : read-only outside research, with sources.
- **Developer** : writes and tests code (dashboard, connectors, scripts).
- **Shield/Ops** : War Mode, budget caps, alerts, backups, secret hygiene, kill switch.

## Docs
- `docs/AGENT-WORKFLOW.md` : ground rules, roster, handoffs.
- `docs/NOTION-SCHEMA.md` : Notion data model and the proposed Approvals database.
- `docs/RUNBOOK.md` : operator runbook (n8n, Caddy, hosting).
- `docs/WORKFLOW-TRACKS.md` : business track vs. development track.
- `docs/CI.md` : the CI workflow.
- `docs/design/router-and-estimator.md` : Router and Estimator design.
- `docs/reviews/pr2-qa-review.md` : QA review of PR #2.
