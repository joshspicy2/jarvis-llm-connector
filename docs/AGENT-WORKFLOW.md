# Jarvis agent workflow

Status: **draft for Joshua's review.** The first eleven names come from Joshua; Scheduling, Finance, Analytics and Etsy were added later (definitions only). The role definitions, handoffs and
mapping to the existing agents are proposals marked *(proposed)*.

## Ground rules (from the project's principles)
1. **Notion is the only source of truth.** Agents read and write Notion; none invents rates, availability or facts.
2. **Nothing client-facing ships without human approval.** Every outbound draft lands as *Awaiting Approval*.
3. **One job per agent.** An agent that needs something outside its job hands off, it does not stretch.
4. **War Mode** (System Flags → `War Mode`, checkbox `Value`) is read by the Conductor and Router before any
   interruption. ON = only FIRE-level items interrupt a human; everything else queues for the daily brief.
5. **Every run is logged** to the Agent Activity Log (Agent, Task, Status, Timestamp, Output Notes). That log is what the dashboard shows.
6. Guardrails for agent runs: budget cap per run, pre/post tool hooks, human checkpoint before any irreversible step.

## Roster
| # | Agent | One job | Reads | Writes / hands off to | Human gate |
|---|---|---|---|---|---|
| 1 | **Conductor** | Owns the workflow: sequences handoffs, tracks job state, produces the daily brief (Needs You / What Moved / Watch, <200 words). Absorbs today's *Integrator*. | Pipeline, Activity Log, System Flags | Dispatches to any agent; writes Pipeline status + brief | Brief goes to Joshua/Makenzie |
| 2 | **Router** | Classify every inbound event as FIRE / IMPORTANT / ROUTINE / AWARENESS and pick the owner agent. | Inbound (email, forms, Stripe, calls), War Mode | Hands to Conductor with severity + owner | FIRE alerts a human |
| 3 | **Estimator** | Produce a priced estimate from intake + Estimate Rules. Today's *Estimate Agent*. | Estimate Rules, Clients | Draft estimate → Awaiting Approval | Makenzie approves before sending |
| 4 | **Marketer** | Draft social/ads/email content and campaigns. Today's *Content Agent* (Phase 2). | Pipeline (wins), Clients, brand notes | Drafts → Awaiting Approval | Approval before posting |
| 5 | **Builder** *(proposed)* | Build and maintain the automations: n8n workflows, Notion schema changes, integrations. | Specs from Conductor/Engineer | n8n workflows, DB schema | Joshua approves production changes |
| 6 | **Support** *(proposed)* | Handle client questions and follow-ups: draft replies, missed-follow-up nudges, payment reminders in the agreed tone. | Clients, Pipeline, Invoices | Draft replies → Awaiting Approval | Approval before sending |
| 7 | **QA** *(proposed)* | Check other agents' output before it reaches a human: estimate math vs. rules, no invented facts, tone, schema validity, workflow test runs. | Any draft or workflow, Estimate Rules | Pass / fail + notes on the item | Fail blocks the item |
| 8 | **Engineer** *(proposed)* | Own technical design and reliability: architecture, infra (Oracle VM, Caddy, n8n), debugging, cost control. Decides *how*. | Logs, infra state | Design notes, fix tickets for Builder/Developer | Joshua for infra changes |
| 9 | **Researcher** *(proposed)* | Gather outside information on demand: pricing comps, local market, vendors, tool options. Cites sources, never writes to business records. | Web, docs | Research brief to requester | none (read-only) |
| 10 | **Developer** *(proposed)* | Write and test code: dashboard, connectors (e.g. the LLM connector), scripts. Implements what Engineer designs. | Repo, tickets | PRs | Joshua merges |
| 11 | **Shield / Ops** | Guard the system: War Mode, budget caps, error/anomaly alerts, backups, permission and secret hygiene, kill switch. | Activity Log, flags, cost, infra health | Flags, alerts; can pause agents | Joshua for anything destructive |
| 12 | **Scheduling** | Propose job slots and reschedules from Pipeline data. Never books or sends. | Pipeline, Clients | Draft slot / reschedule -> Awaiting Approval; Conductor updates Pipeline after approval | Human approves before anything is booked or sent |
| 13 | **Finance** | Draft overdue / invoice-chase messages and cash summaries from Invoices and Pipeline status. Never sends or moves money. Invoices schema is unverified. | Invoices, Pipeline, Clients | Draft chase -> Awaiting Approval (Support sends after approval); cash summary to Conductor | Makenzie approves before sending |
| 14 | **Analytics** | Read-only weekly numbers from the Activity Log, Pipeline and Approvals. Writes nothing client-facing. | Activity Log, Pipeline, Approvals | Weekly summary to Conductor; anomalies to Shield/Ops | none (read-only, internal) |
| 15 | **Etsy** *(proposed)* | Record Etsy sales (TheLuminousFairy) and draft shipping confirmations and order updates for buyers. Never sends, never edits listings or prices. The Etsy Orders database is proposed and unverified. | Etsy Orders | Draft buyer message -> Awaiting Approval (Type `Reply` until an `Etsy Message` option exists); pricing/listing questions to Researcher, complaints to Support, weekly numbers to Analytics, cash to Finance | Human approves before anything reaches a buyer |

Builder vs. Engineer vs. Developer *(proposed split)*: **Engineer decides how, Builder assembles automations
(n8n/Notion), Developer writes code.** If you'd rather merge any of these, say so.

## Core job flow
```
Inbound ─▶ Router ─▶ Conductor ─┬─▶ Estimator ─┐
 (lead,        (severity+owner)  ├─▶ Support ───┤
  Stripe,                        ├─▶ Marketer ──┤──▶ QA ──▶ Awaiting Approval ──▶ Human ──▶ Sent/Booked
  email)                         ├─▶ Scheduling ┤
                                 ├─▶ Etsy ──────┤
                                 └─▶ Finance ───┘
                         ▲                                              │
                         └──────────── Conductor updates Pipeline ◀─────┘
Shield/Ops watches everything (War Mode, budgets, errors); Researcher is called on demand.
Analytics reads the Activity Log, Pipeline and Approvals weekly and reports to Conductor (read-only).
Engineer → Builder / Developer handle system changes via their own approval path (PR / n8n review).
```
Typical lead: Router tags it ROUTINE and hands to Conductor → Conductor asks Estimator → QA checks the math against
Estimate Rules → draft waits in Awaiting Approval → Makenzie approves → Support sends → Conductor moves the job to *Booked*.

## Open questions for Joshua
1. ~~**Scheduling, Finance and Analytics**~~ Resolved: added as their own agents, definitions only; no n8n
   workflows yet. Etsy was added later the same way (see `docs/NOTION-SCHEMA.md`, Etsy Orders, proposed). Stripe→Notion invoice matching is not part of Finance's definition; it needs a separate decision.
2. Confirm the Builder / Engineer / Developer split above.
3. The Agent Activity Log's `Agent` select only has the old six names. Add the new ones (including Scheduling, Finance, Analytics, Etsy) (or I'll map old→new in n8n, already done for the dashboard).
4. Which agents run first? Recommend: Router → Conductor → Estimator → QA, then Support, then Shield/Ops.
5. Model per agent (Sonnet for routine, Opus only for Engineer/Conductor judgment calls?).
