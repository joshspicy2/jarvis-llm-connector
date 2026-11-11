# Two tracks: business and development

Jarvis work runs on two tracks so that running the business never collides with changing the system.
*(Interpretation: "business and personal development process" = **business operations** for High Tide Wash and
**development** of Jarvis itself. Tell me if "personal development" meant something else.)*

| | **Business track** (`track/business`) | **Development track** (`track/dev`) |
|---|---|---|
| Purpose | Run High Tide Wash: leads, estimates, client comms, content, daily brief | Build and maintain Jarvis: dashboard, n8n workflows, connectors, infra |
| Source of truth | Notion databases (live) | This repo (PRs) |
| Agents | Conductor, Router, Estimator, Support, Marketer, QA, Researcher, Shield/Ops | Conductor, Engineer, Builder, Developer, QA, Researcher, Shield/Ops |
| Output | Drafts in *Awaiting Approval* | Pull requests |
| Human gate | Makenzie approves client-facing items | Joshua merges and applies production changes |
| Repo content | agent prompts/rules, estimate and tone guidance docs | code, n8n JSON, docs |

Agent definitions live in `.claude/agents/` (one file each, usable as Claude Code subagents). Shared rules and
the per-agent roles are in `docs/AGENT-WORKFLOW.md`.

## Business flow (runtime, in n8n + Notion)
Inbound → **Router** (severity, owner) → **Conductor** → **Estimator / Support / Marketer** → **QA** → *Awaiting Approval*
→ human → send/book → Conductor updates Pipeline. **Shield/Ops** watches War Mode, budgets and errors throughout.

## Development flow (in this repo)
Idea or problem → **Engineer** (design note + ticket with acceptance criteria; **Researcher** if facts are needed)
→ **Builder** (n8n/Notion change as a file) or **Developer** (code) in a task worktree
→ **QA** (tests, diff review: PASS/FAIL) → PR → Joshua merges → **Shield/Ops** checks health after deploy.

## Git worktrees
```
repo/                       main checkout (stays on main)
../jarvis-worktrees/
  business/                 branch track/business  — business-process docs and agent rules
  dev/                      branch track/dev       — integration branch for development
  tasks/<track>-<name>/     short-lived branch <track>/<name> off its track
```
```
scripts/worktrees.sh init                       # create business + dev worktrees
scripts/worktrees.sh task dev dashboard-polish  # new task worktree + branch dev/dashboard-polish
scripts/worktrees.sh done dev dashboard-polish  # remove the worktree after the PR merges
scripts/worktrees.sh list
```
Rules: nobody commits to `main` directly; each task gets its own worktree so agents/sessions can work in
parallel without stepping on each other; a task branch merges into its track branch by PR, and tracks merge to `main`
when Joshua approves. Override the location with `JARVIS_WORKTREES=...`.

## Not set up yet (needs Joshua)
- Applying anything to production n8n/Notion, and creating these worktrees on his PC (run `init` there).
- Adding the new agent names to the Activity Log's Agent options in Notion.
