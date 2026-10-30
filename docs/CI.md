# CI

Workflow: `.github/workflows/ci.yml` (name `CI`). Runs on every pull request and on
pushes to `main`. Permissions are `contents: read`; a newer run on the same ref
cancels the older one.

Single job on `ubuntu-latest` (Node 22, Python 3.12), steps in order:

1. `python3 scripts/validate_workflows.py`
2. `python3 -I scripts/test_validate_workflows.py`
3. `python3 -m unittest estimator.test_estimate`
4. `node --test 'tests/n8n/*.test.js'`
5. Dashboard smoke test: installs `playwright@1.63.0` (matches the version used
   locally) with `--no-save`, installs Chromium, runs `tests/dashboard/smoke.test.js`.
6. Agent definition checks: `python3 scripts/check_agents.py` (11 files in `.claude/agents/`: frontmatter, identical shared rules block, Agent Activity Log and Approvals mentions) plus `python3 -I scripts/test_check_agents.py`.
7. Secret scan: `git grep` fails the job on `sk-ant-` + 20 chars, `secret_` + 20 chars or
   `ntn_` + 20 chars in tracked files (excluding the fixtures in
   `scripts/test_validate_workflows.py`).

Run locally: execute the commands above from the repo root. Bump the Playwright
version in the workflow when the local one changes.
