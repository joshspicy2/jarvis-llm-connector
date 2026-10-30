# CLAUDE.md: Jarvis (High Tide Wash operations)

Jarvis is the agent-based operations system for High Tide Wash (family interior cleaning, North Central Florida).
Runtime is n8n + Notion + Anthropic API; this repo holds the n8n workflow JSON, the static dashboard, the
estimator logic, agent prompts (`.claude/agents/`), and docs. Joshua owns the system and merges; Makenzie approves
client-facing items.

## Principles (every agent and every change)
- Notion is the only source of truth. Never invent prices, rates, availability or client facts; if it is not in Notion, ask or hand off to Researcher.
- Nothing client-facing is sent without human approval. Drafts land in Approvals as *Awaiting Approval*; only a human moves Status off it.
- One job per agent. Needing something outside the job means handing off by name, not stretching.
- War Mode: System Flags row whose `Flag` contains "War", checkbox `Value`. Read by Conductor and Router before any interruption. ON = only FIRE items interrupt a human; everything else queues for the daily brief.
- Every run is logged to the Agent Activity Log (Agent, Task, Status, Timestamp, Output Notes).

## Hard rules
- Never commit credentials, API keys, tokens or n8n credential ids. Credentials live only in the n8n UI. Workflow JSON ships with empty credential placeholders.
- Notion/n8n placeholders stay as `REPLACE_WITH_*` (e.g. `https://REPLACE_WITH_DASHBOARD_ORIGIN`, `REPLACE_WITH_PAGES_DOMAIN`); never fill in real values.
- Webhook `allowedOrigins` is never `*`. Use a specific origin.
- Production n8n or Notion changes happen only with Joshua's approval. Do not apply anything to production yourself.
- Do not commit or push to `main`. Joshua merges PRs. Commit or push only when asked.
- Do not rename Notion properties or select options; the workflows depend on exact names.

## Before any PR (run from repo root; all verified working)
```
python3 scripts/validate_workflows.py            # all dashboard/n8n/*.json; exits 1 on failure
python3 scripts/test_validate_workflows.py       # validator unit tests (or: python3 -m unittest scripts.test_validate_workflows)
python3 -m unittest estimator.test_estimate      # estimator tests
node --test 'tests/n8n/*.test.js'                # n8n Code-node tests
node tests/dashboard/smoke.test.js               # dashboard smoke test; needs `playwright` + Chromium (npm i --no-save playwright)
```
These mirror `.github/workflows/ci.yml` (see `docs/CI.md`), which also runs a secret scan with `git grep` for
`sk-ant-`, `secret_`, `ntn_` patterns. Re-run it yourself on your diff.

## Conventions
- Each n8n workflow is importable JSON in `dashboard/n8n/<name>-workflow.json` with a sibling `<NAME>.md` describing it. Update both together; list new ones in `dashboard/n8n/README.md`.
- Notion nodes use `simple: false`, and Code nodes read `properties` by the names in `docs/NOTION-SCHEMA.md`.
- Dashboard is static, no build step (`dashboard/index.html`, `config.js`, `_headers` CSP). No tokens in `config.js`.
- Two tracks (`docs/WORKFLOW-TRACKS.md`): `business` (rules/docs) and `dev` (code, n8n JSON). Never commit directly to `main`. Branches are `track/<business|dev>`; task branches are `<track>/<name>`, one worktree each:
  `scripts/worktrees.sh init | task <track> <name> | done <track> <name> | list` (override location with `JARVIS_WORKTREES`).
- Agent definitions: one file per agent in `.claude/agents/`; keep the shared rules block identical across them.
- Commit messages end with the attribution lines the harness provides.

## Known gotchas
- Notion rich text caps near 2000 chars per block; put long drafts in the page body, not a property.
- Notion node `getAll` with `simple: false` returns raw pages with `properties` (typed objects: `title[]`, `rich_text[]`, `select.name`, `date.start`, `checkbox`). Simplified mode returns flat keys and breaks the Shape/Pick Code nodes (see `docs/reviews/pr2-qa-review.md`).
- n8n node parameters are unverified against a live instance and live Notion; no workflow has had a real execution. Expect to fix property names on first run (read it in n8n Executions).
- Clients and Invoices schemas are not verified; check Notion before relying on them.
- Do not run `pkill` (or `killall`) in a shell command; it can kill your own shell. Stop a process by PID you started.
- Dashboard CORS and Cloudflare Access: cross-origin calls are not protected by Access; see `dashboard/README.md` before enabling it.
- `__pycache__/` is gitignored; do not add it.

## Pointers
- `docs/AGENT-WORKFLOW.md`: ground rules, 11-agent roster, job flow, open questions.
- `docs/WORKFLOW-TRACKS.md`: tracks, worktrees. `docs/NOTION-SCHEMA.md`: databases and property names (incl. Approvals).
- `docs/RUNBOOK.md`: Joshua's setup/deploy/smoke tests. `docs/CI.md`: CI. `docs/design/`, `docs/reviews/`: design notes and QA reviews.
- `dashboard/README.md`, `dashboard/n8n/README.md`: endpoints, deploy, per-workflow docs.
