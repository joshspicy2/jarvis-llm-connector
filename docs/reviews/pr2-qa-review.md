# QA review: PR #2 (dashboard, n8n API workflow, agent docs, worktree script)

Reviewer: QA agent. Scope: committed files only. Verified by reading plus a Playwright run of dashboard/index.html
with the real `_headers` CSP applied and n8n endpoints mocked. Not run against live n8n or Notion.
Lines for the workflow JSON are file lines in dashboard/n8n/jarvis-dashboard-api.json.

Verdict: FAIL. Merge-blocking items are C1 and H1 to H3.

## Critical

### C1. Notion nodes return the simplified shape; every Code node reads raw `.properties` and gets nothing
- jarvis-dashboard-api.json:25, 96, 167, 238, 354, 425 (all `getAll` nodes; none sets `simple: false`). Consumers: the `props = p => p.properties || {}` helper in every Shape/Pick node, e.g. line 264.
- Wrong: In the n8n Notion node (v2.x) `Simplify` defaults to true. Items are `{id, name, url, property_<name>: value}` and have no `properties` object. The Code nodes use `props(p)` for Status, Scheduled Date, Base Rate, Minimum Charge, Active, Value and Timestamp, so they all read `{}`.
- Failure scenario:
  - Pipeline: every job lands in "Booked" as "(untitled)".
  - Rules: titles are empty, and the `Active !== false` filter passes everything.
  - War GET: `enabled` is always false.
  - War POST: the `/war/i` search over `titleOf` finds no row, so "Pick War Row" throws "No War Mode row found" and the toggle always fails and reverts.
  - Agents and Log: every agent shows idle, with log text blank or based on `created_time` only.
  - The dashboard shows a "live" badge while the data is wrong.
- Fix: set `"simple": false` on all six Notion getAll nodes. Alternatively rewrite the Code nodes for the simplified keys. Then run one real execution (the README admits none has been run).

## High

### H1. Unauthenticated write endpoints with wildcard CORS, and War Mode fails open
- jarvis-dashboard-api.json:10, 81, 152, 223, 339, 410, 481 (`allowedOrigins: "*"`); POST webhooks at ~L223 (War POST) and ~L481 (Chat). Logic in "Pick War Row" (`want = ...body.enabled === true`, line ~264).
- Wrong:
  - Anyone who can reach `ops.hightidewash.net` can POST to `/jarvis/war-mode` and `/jarvis/chat` and read all business data from the GETs. The only protection is an external step in the README that is not enforced anywhere.
  - CORS is not access control. A cross-site form or `text/plain` POST needs no preflight.
  - `want` is `=== true`, so a missing or unparseable body (`curl -X POST`, or `text/plain` where `body.enabled` is undefined) means `want = false` and silently turns War Mode OFF.
- Failure scenario: a third party, or a CSRF page visited by Joshua, clears the safety flag. Agents then interrupt humans during a FIRE-suppression window. The dashboard shows no sign of it until the next poll.
- Fix:
  - Add Header Auth or a shared-secret check in the Webhook node. The dashboard cannot hold a secret, so use Cloudflare Access service tokens or a Caddy gate, and reject unauthenticated requests before the Notion write.
  - Make the Origin check explicit in an IF node.
  - Require `typeof body.enabled === "boolean"` and return 400 otherwise.
  - Set `allowedOrigins` to the Pages domain in the committed JSON (not "*"), so a forgotten README step 6 is not a vulnerability.

### H2. Refresh vs War Mode toggle race (reproduced with Playwright)
- dashboard/index.html:186-200 (`refresh`, `state.pending`, click handler).
- Wrong: `refresh()` checks `state.pending` only after `await Promise.all(...)`. A GET issued before the click, or while the POST is in flight, resolves later with the old value. If `pending` is already false by then, `setWar(old)` runs.
- Reproduced:
  - A slow GET returning `false` was started.
  - The user clicked, and the POST (true) succeeded.
  - The log was `GET->false POST true GET->false`.
  - The label ended as "War Mode: off" while the server held true.
  - Other tabs and agents see ON; this operator sees OFF and may click again, which turns it OFF.
- Also: a double-click starts two concurrent POSTs. The first to finish sets `pending=false` while the second is in flight. Responses can land out of order. The failure path `setWar(!want)` can then restore the wrong value.
- Fix:
  - Keep a monotonically increasing `warSeq`. Record it at refresh start and ignore the war result if it changed or a toggle is in flight.
  - Disable the button while `pending`.
  - Set `pending=false` in a `finally`.
  - After a successful POST, trust the server's returned `enabled`.

### H3. The recommended Cloudflare Access protection cannot work with the page as written
- dashboard/index.html:141 (no `credentials`), dashboard/README.md last note, dashboard/n8n/README.md "Protecting the endpoints".
- Wrong:
  - The README says to put Access in front of `ops.hightidewash.net/webhook/jarvis/*`. The page is on a different origin (the Pages domain) and calls `fetch` without `credentials: "include"`. The server also sends `Access-Control-Allow-Origin: *`, which browsers refuse for credentialed requests.
  - Access answers with a 302 or 403 to the login page, with no CORS headers.
- Failure scenario: after Access is enabled as documented, every call fails and the page silently shows SAMPLE data with an "n8n unreachable" badge. The same-parent-domain advice is buried as a footnote.
- Fix: make same-site hosting the documented default (dashboard at `jarvis.hightidewash.net`, webhooks at `ops.hightidewash.net`), or use a Pages Function proxy. Add `credentials: "include"` and a specific, non-wildcard allowed origin plus `Allow-Credentials` on the n8n side.

## Medium

### M1. Sample fallback for War Mode shows "off" when the real state is unknown
- dashboard/index.html:149-152, 189-191, 130.
- Wrong: if `/war-mode` GET fails, `load` returns `SAMPLE.warMode = {enabled:false}` and `setWar(false)` runs. The red War styling is removed and the panel is not tagged SAMPLE (the war panel has no tag).
- Failure scenario: n8n or Notion has a blip during War Mode. The UI flips to calm "OPTIMAL", and the operator may click it, sending an ON/OFF write against an unknown state.
- Fix: on failure show "War Mode: unknown" and disable the button. Do not call `setWar`.

### M2. Chat timeout (6 s) is shorter than any realistic LLM reply, and the error text is false
- dashboard/index.html:139 and 210 with config.js:`TIMEOUT_MS: 6000`.
- Wrong: the shared `TIMEOUT_MS` is used for chat. When the Router/LLM takes longer than 6 s the request is aborted and the UI says "nothing was sent to the agents". n8n has already received and may be processing it. Reproduced with a mock that replies after 7 s.
- Failure scenario: the user retypes the message and it is processed twice. This is latent now because the stub replies instantly. It also affects War POST, which can be applied server-side after the UI has reverted.
- Fix: use a separate chat timeout (30 s or more). Word the error as "no reply received", and allow polling for a late reply.

### M3. Unbounded `returnAll` plus a 15 s poll of five webhooks
- jarvis-dashboard-api.json:25, 425, 354; config.js POLL_MS.
- Wrong:
  - Every 15 s the page triggers five n8n executions.
  - Each one fetches whole Notion databases.
  - The Activity Log (which only grows) is fully paged twice, once for `/activity-log` and once for `/agents`. Pipeline pulls every Paid job ever.
  - Notion allows about 3 requests per second per integration, and n8n stores an execution record per hit.
- Failure scenario: 429s and slow responses make 6 s timeouts flip panels to sample data. The n8n database grows without limit. Several open tabs multiply the load.
- Fix:
  - Add Notion filters and sorts (Log: last 100 by Timestamp descending; Pipeline: exclude old Paid).
  - Share one Log fetch for both endpoints, or cache.
  - Set `saveDataSuccessExecution: none` in the workflow settings.
  - Raise POLL_MS to 30-60 s.
  - Pause polling when the tab is hidden.

### M4. Role definitions grant tools that cannot do the job, and others more than the limits allow
- .claude/agents/conductor.md:4, router.md, estimator.md, support.md, qa.md, shield-ops.md (`tools:` lines).
- Wrong:
  - Conductor, Router, Estimator and Support have only Read/Grep/Glob. Their stated outputs (Pipeline status updates, Awaiting Approval drafts, Activity Log rows) all need Notion or n8n write access. The shared rule "Log each run to the Agent Activity Log" is impossible for them.
  - Listing `tools:` also removes inherited MCP tools.
  - In the other direction, QA ("you do not fix") and Shield/Ops hold Bash, which can edit files and run git. Builder ("never touch production") has Bash and Write.
- Failure scenario: an agent cannot complete its documented flow, or violates its limit without any control stopping it.
- Fix: add the specific Notion/n8n MCP tools per role, read-only where the job is read-only. Or state that humans or n8n do the writes. Treat "Limits" as prompt-only unless enforced with hooks.

### M5. Docs and code disagree on the agent list, endpoint contract and Integrator
- dashboard/README.md:11 vs dashboard/index.html:133 and jarvis-dashboard-api.json (Shape Agents code):
  - The README lists agents "Router, Estimate, Scheduling, Finance, Content, Integrator", but the code shows the 11 new names.
  - `/estimate-rules` is documented as `[{service, base, unit, notes}]`, but the code also returns `category` and `min` and renders them.
- dashboard/n8n/README.md:24 says "Integrator has no Agent option... shows idle". The code maps Integrator to Conductor, and Integrator is not on the dashboard.
- docs/AGENT-WORKFLOW.md "Open questions" #3 says old-to-new mapping is "already done", which contradicts the README statement above.
- Failure scenario: someone wires n8n or Notion to the README contract, or adds an "Integrator" option in Notion expecting a row, and gets silently different behaviour.
- Fix: update both READMEs to one table: 11 agents, aliases Estimate/Content/Integrator mapped as in code, and the rules payload `{service, category, base, unit, min, notes}`.

### M6. `worktrees.sh` resolves its default location from the current worktree, not the main checkout
- scripts/worktrees.sh:7-8.
- Wrong: `git rev-parse --show-toplevel` returns the root of the worktree you are in. `WT` defaults to `$ROOT/../jarvis-worktrees`.
- Failure scenario: run `scripts/worktrees.sh task dev x` from inside a task worktree such as `../jarvis-worktrees/tasks/dev-foo`. `WT` becomes `.../tasks/jarvis-worktrees`, so "run init first" fires or a second stray tree is created. `list` and `done` then miss the existing worktrees.
- Fix: derive the main root with `git rev-parse --path-format=absolute --git-common-dir` (strip `/.git`) or `git worktree list --porcelain | head -1`.

## Low

- **L1. Script init failure and validation (scripts/worktrees.sh:9, 16, 19-21).** `BASE=main` is never verified, so on a clone without a local `main` the first `git worktree add` aborts under `set -e` after the earlier iteration. `<track>` is not restricted to business|dev, so `task foo bar` fails only at the `-d` check or creates odd branch names. `done` does not offer branch deletion although the docs promise "kept until merged". Fix: `git rev-parse --verify "$BASE"`, add a `case "$t" in business|dev)` guard.
- **L2. Log times use `hour12:false` with en-US (Shape Log code).** At midnight this renders `24:05:00`. Only time-of-day is shown, with no date. The panel keeps newest-last but never scrolls to the bottom (index.html:173), so the newest entries sit below the fold. Fix: `hourCycle:"h23"`, include the date, set `scrollTop` after render or send newest first.
- **L3. Render robustness (index.html:186-193).** `w.enabled` throws if the war-mode response is `null`. `d.stages.map` throws if `stages` is not an array. Any render exception aborts `refresh` before `markSample()`, so the badge stays stale. n8n often returns a bare array or an empty body on a single or empty result. Fix: validate the shape in `load()` and fall back per panel. `$`+esc(undefined) shows a bare "$" for a missing `base`.
- **L4. Agent `waiting` state is unreachable.** The status map in Shape Agents emits only active, error and idle, while the UI and README describe `waiting`. The Estimator "Awaiting Approval" state therefore never shows. Fix: map the Log status values that mean waiting, or drop it from the docs.
- **L5. Pick War Row regex `/war/i` over the title (Pick War Row, Shape War).** It also matches a flag such as "Warranty" or "Warehouse". The first match wins, and the match is non-deterministic. Fix: match `^war mode$`.
- **L6. Layout is desktop only.** `html,body{min-width:1200px;overflow:hidden}` (index.html:11) makes the page unusable on a phone: Makenzie cannot toggle War Mode from her phone, and nothing scrolls. This is by design per the commit history, but the README does not say so.
- **L7. Webhook `webhookId` values are not UUIDs (e.g. `jarvis-pipelineget`).** n8n accepts them when `path` is set, so this is not a blocker. It is worth regenerating UUIDs on export. The empty credential `id: ""` imports fine but shows "Select your Notion credential", as documented.
- **L8. Respond to Webhook returns no explicit status or headers on failure.** If a Notion node errors, n8n returns a generic 500. The dashboard handles that by showing sample data, with no detail for the operator. Consider an Error Trigger or `continueErrorOutput` plus a 502 JSON body.

## Verified OK
- XSS: all server strings in innerHTML pass through `esc()`, and quotes are escaped. A Playwright run with `<img onerror>` and `<script>` in the pipeline and rules payloads executed nothing (`window.__x`, `__y` undefined). Log and chat use `textContent`. The only unescaped interpolation is the constant `AGENT_ORDER`.
- CSP vs page behaviour: with the exact `_headers` CSP applied there were no console or CSP violations. Inline script and style, inline `style=` attributes, the canvas, the data: URI and fetches to `https://ops.hightidewash.net` all work. `form-action 'none'` is harmless because submit is `preventDefault`ed. `_headers` syntax is valid for Cloudflare Pages. `frame-ancestors` and `X-Frame-Options` agree.
- No secrets in config.js, the workflow JSON or the docs. Credentials are blank placeholders. Notion database IDs are identifiers, not secrets.
- Webhook v2 plus Respond to Webhook v1.1 wiring: all seven chains are complete and connected. `responseMode: responseNode` pairs with Respond nodes. `JSON.stringify` response bodies are valid. GET and POST on the same `jarvis/war-mode` path is allowed. `scripts/validate_workflows.py` passes the file (it warns only on `*` origins).
- Notion update node: `propertiesUi.propertyValues` with `Value|checkbox` / `checkboxValue` is the correct v2.2 form. The `$("Pick War Row")` and `$('War POST')` references resolve to existing nodes.
- Timeout and revert path: a failed War POST reverts the UI. The abort controller and timer are cleaned up in `finally`.
- Endpoint paths and methods in config.js match the workflow paths and methods exactly (7 of 7).
- Agent names: the 11 names in AGENT-WORKFLOW.md match the `.claude/agents/*.md` frontmatter names, `AGENT_ORDER` in index.html, and the `names` list in Shape Agents. Tracks listed in WORKFLOW-TRACKS.md match each agent's "Tracks you work on" line.
- worktrees.sh: syntax is fine, the executable bit is set, and `task`/`done` paths match the layout in WORKFLOW-TRACKS.md. `set -u` and `shift || true` are handled correctly.
