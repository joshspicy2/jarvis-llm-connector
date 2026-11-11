'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'dashboard', 'n8n');
const shield = require(path.join(dir, 'shield-ops-workflow.json'));
const cond = require(path.join(dir, 'conductor-workflow.json'));
const code = (wf, name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

const rt = (s) => ({ type: 'rich_text', rich_text: [{ plain_text: s }] });
const title = (s) => ({ type: 'title', title: [{ plain_text: s }] });
const sel = (s) => ({ type: 'select', select: { name: s } });
const row = (agent, status, iso, task = 'x', notes = '') => ({
  created_time: iso,
  properties: { Task: title(task), Agent: sel(agent), Status: sel(status), Timestamp: { type: 'date', date: { start: iso } }, 'Output Notes': rt(notes) },
});

function runCode(js, nodes, nowIso) {
  const RealDate = Date;
  const fixed = RealDate.parse(nowIso);
  class FakeDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  }
  const $ = (n) => {
    if (!(n in nodes)) throw new Error(`not mocked: ${n}`);
    const v = nodes[n];
    return { all: () => v.items.map((json) => ({ json })), first: () => ({ json: v.items[0] }), isExecuted: !!v.isExecuted };
  };
  const fn = new Function('$', '$json', 'Date', js);
  return fn($, nodes.__json || {}, FakeDate)[0].json;
}

// 2026-11-02 is a Monday. EST (UTC-5) in November.
const MON_NOON = '2026-11-02T17:00:00Z';   // 12:00 ET Monday
const SAT_NOON = '2026-10-31T16:00:00Z';   // Sat (EDT)
const MON_5AM = '2026-11-02T10:00:00Z';    // 05:00 ET Monday
const health = (acts, nowIso) =>
  runCode(code(shield, 'Compute health'), { 'Notion Activity Log': { items: acts }, 'Notion System Flags': { items: [] } }, nowIso);
const FRI_7 = '2026-10-30T11:00:00Z';

describe('Shield/Ops Compute health', () => {
  test('weekend and overnight: silence does not alert', () => {
    const old = [row('Conductor', 'Done', FRI_7)];
    assert.equal(health(old, SAT_NOON).status, 'OK');
    assert.equal(health(old, MON_5AM).status, 'OK');
    assert.equal(health(old, SAT_NOON).should_log, false);
  });
  test('weekday daytime with 72h+ silence alerts and logs', () => {
    const r = health([row('Conductor', 'Done', '2026-10-29T11:00:00Z')], MON_NOON);
    assert.equal(r.status, 'ALERT');
    assert.equal(r.should_log, true);
  });
  test('weekday daytime with recent activity is OK and never logged', () => {
    const r = health([row('Conductor', 'Done', '2026-11-02T12:00:00Z')], MON_NOON);
    assert.equal(r.status, 'OK');
    assert.equal(r.should_log, false);
  });
  test('dedupe: same signature suppressed, changed or 4h-old logged', () => {
    const errs = (n) => Array.from({ length: n }, (_, i) => row('Router', 'Error', `2026-11-02T16:${40 + i}:00Z`));
    const first = health(errs(1), MON_NOON);
    assert.equal(first.status, 'WARN');
    assert.equal(first.should_log, true);
    const mine = (iso, st, notes) => row('Shield/Ops', st, iso, 'Health check', notes);
    const same = health([...errs(1), mine('2026-11-02T16:50:00Z', 'Done', first.summary)], MON_NOON);
    assert.equal(same.should_log, false);
    const changed = health([...errs(3), mine('2026-11-02T16:50:00Z', 'Done', first.summary)], MON_NOON);
    assert.equal(changed.status, 'ALERT');
    assert.equal(changed.should_log, true);
    const stale = health([...errs(1), mine('2026-11-02T12:30:00Z', 'Done', first.summary)], MON_NOON);
    assert.equal(stale.should_log, true);
  });
});

describe('Conductor', () => {
  const nodes = (acts) => ({
    'Notion System Flags': { items: [] },
    'Notion Pipeline': { items: [] },
    'Notion Agent Activity': { items: acts },
    'Daily Brief Webhook': { items: [{}], isExecuted: false },
  });
  test('excludes Shield/Ops and Daily brief rows, keeps real activity', () => {
    const acts = [
      row('Shield/Ops', 'Error', '2026-11-02T12:00:00Z', 'Health check: ALERT'),
      row('Conductor', 'Done', '2026-11-02T11:00:00Z', 'Daily brief'),
      row('Router', 'Done', '2026-11-01T11:00:00Z', 'Routed lead'),
    ];
    const s = JSON.parse(runCode(code(cond, 'Assemble summary'), nodes(acts), MON_NOON).summary);
    assert.deepEqual(s.recent_agent_activity.map((a) => a.agent), ['Router']);
  });
  test('sorts newest first deterministically', () => {
    const acts = [row('A', 'Done', '2026-01-01T00:00:00Z'), row('B', 'Done', '2026-03-01T00:00:00Z')];
    const s = JSON.parse(runCode(code(cond, 'Assemble summary'), nodes(acts), MON_NOON).summary);
    assert.deepEqual(s.recent_agent_activity.map((a) => a.agent), ['B', 'A']);
  });
  test('fallback brief when Anthropic call failed', () => {
    const summary = JSON.stringify({ open_jobs: [{ job: 'Van 1', status: 'Flagged', flag: 'No access' }], recent_agent_activity: [{ agent: 'Router', task: 'Routed', status: 'Done' }] });
    const r = runCode(code(cond, 'Finalize brief'), { 'Assemble summary': { items: [{ warMode: false, summary, webhook: false }] }, __json: { error: { message: '529' } } }, MON_NOON);
    assert.match(r.brief, /Needs You: Van 1 \(No access\)/);
    assert.match(r.brief, /Router: Routed/);
  });
  test('Anthropic node has retry and continue-on-error', () => {
    const n = cond.nodes.find((x) => x.name === 'Anthropic Conductor');
    assert.equal(n.onError, 'continueRegularOutput');
    assert.equal(n.retryOnFail, true);
    assert.equal(n.maxTries, 3);
    assert.equal(n.waitBetweenTries, 2000);
  });
});
