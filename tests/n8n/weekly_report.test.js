'use strict';
// Tests for the Build report Code node in weekly-report-workflow.json.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wf = require(path.join(__dirname, '..', '..', 'dashboard', 'n8n', 'weekly-report-workflow.json'));
const src = wf.nodes.find((n) => n.name === 'Build report').parameters.jsCode;

// Clock: 2026-11-01 15:00 UTC = 11:00 EST (DST ended 2026-11-01 06:00 UTC). Window: 10-26 00:00 EDT .. 11-02 00:00 EST.
const NOW = '2026-11-01T15:00:00.000Z';
const LO = '2026-10-26T04:00:00.000Z'; // 00:00 EDT
const HI = '2026-11-02T05:00:00.000Z'; // 00:00 EST

function run({ log = [], appr = [], pipe = [], now = NOW, missing = [] } = {}) {
  const RealDate = Date;
  const t0 = RealDate.parse(now);
  class FakeDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [t0])); }
    static now() { return t0; }
  }
  const data = { 'Notion Activity Log': log, 'Notion Approvals': appr, 'Notion Pipeline': pipe };
  const $ = (n) => {
    if (missing.includes(n)) throw new Error('not executed');
    const items = data[n].map((j) => ({ json: j }));
    return { all: () => items, first: () => items[0] };
  };
  const fn = new Function('$', 'Date', src);
  const out = fn($, FakeDate);
  return out[0].json.body;
}

const title = (s) => ({ type: 'title', title: [{ plain_text: s }] });
const rt = (s) => ({ type: 'rich_text', rich_text: [{ plain_text: s }] });
const sel = (s) => ({ type: 'select', select: s === null ? null : { name: s } });
const dt = (s) => ({ type: 'date', date: s ? { start: s } : null });
const logRow = (agent, status, ts, extra = {}) => ({ id: 'l' + Math.random(), created_time: '2020-01-01T00:00:00.000Z',
  properties: { Task: title('Route: Smith kitchen'), Agent: sel(agent), Status: sel(status), Timestamp: dt(ts), 'Output Notes': rt('secret note'), ...extra } });
const apr = (o = {}) => ({ id: 'a' + Math.random(), created_time: o.created ?? '2026-10-30T12:00:00.000Z', properties: {
  Title: title('Estimate: Jane Smith'), Agent: sel('Estimator'), Draft: rt('Dear Jane Smith, your total is $500'),
  'Related Job': rt('Smith job'), Status: sel(o.status ?? 'Awaiting Approval'), 'QA Result': sel(o.qa === undefined ? 'Pass' : o.qa),
  'Decided At': dt(o.decided ?? null) } });
const job = (status, created = '2026-10-30T12:00:00.000Z') => ({ id: 'j' + Math.random(), created_time: created,
  properties: { 'Job Name': title('Smith Interior'), Status: sel(status), Notes: rt('gate code 1234') } });

describe('Weekly report: shape and window', () => {
  test('workflow is read-only GET with placeholder origin', () => {
    const hooks = wf.nodes.filter((n) => n.type.endsWith('.webhook'));
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].parameters.httpMethod, 'GET');
    assert.equal(hooks[0].parameters.path, 'jarvis/weekly-report');
    assert.equal(hooks[0].parameters.options.allowedOrigins, 'https://REPLACE_WITH_DASHBOARD_ORIGIN');
    for (const n of wf.nodes.filter((n) => n.type.endsWith('.notion'))) {
      assert.equal(n.parameters.operation, 'getAll');
      assert.equal(n.parameters.simple, false);
    }
  });
  test('empty inputs give zeroed report with exact shape', () => {
    const r = run();
    assert.equal(r.week_start, '2026-10-26');
    assert.equal(r.week_end, '2026-11-01');
    assert.equal(r.generated_at, NOW);
    assert.deepEqual(Object.keys(r), ['week_start', 'week_end', 'runs_by_agent', 'approvals', 'qa', 'jobs', 'generated_at']);
    assert.deepEqual(r.approvals, { created: 0, approved: 0, rejected: 0, sent: 0, awaiting: 0 });
    assert.deepEqual(r.qa, { pass: 0, fail: 0, not_checked: 0 });
    assert.equal(r.jobs.flagged, 0);
    assert.deepEqual(r.jobs.by_status, { Booked: 0, 'In Progress': 0, 'Awaiting Invoice': 0, Paid: 0, Flagged: 0 });
    assert.equal(r.runs_by_agent.Router.runs, 0);
    assert.equal(Object.keys(r.runs_by_agent).length, 11);
  });
  test('placeholder empty items (alwaysOutputData) and non-executed nodes are tolerated', () => {
    const r = run({ log: [{}], appr: [{}], pipe: [{}], missing: [] });
    assert.equal(r.approvals.created, 0);
    const r2 = run({ missing: ['Notion Activity Log', 'Notion Approvals', 'Notion Pipeline'] });
    assert.equal(r2.qa.pass, 0);
  });
  test('window edges: lower bound inclusive, upper bound exclusive, across DST', () => {
    const r = run({ log: [
      logRow('Router', 'Done', '2026-10-26T03:59:59.000Z'), // just before
      logRow('Router', 'Done', LO),                          // in
      logRow('Router', 'Done', '2026-11-02T04:59:59.000Z'), // in (23:59:59 EST)
      logRow('Router', 'Done', HI),                          // out
    ] });
    assert.equal(r.runs_by_agent.Router.runs, 2);
  });
  test('date-only Timestamp is midnight New York', () => {
    const r = run({ log: [logRow('QA', 'Done', '2026-10-26'), logRow('QA', 'Done', '2026-10-25'), logRow('QA', 'Done', '2026-11-02')] });
    assert.equal(r.runs_by_agent.QA.runs, 1);
  });
  test('week start/end follow New York date not UTC (late evening ET is next day UTC)', () => {
    const r = run({ now: '2026-11-02T03:30:00.000Z' }); // 22:30 EST on 11-01
    assert.equal(r.week_end, '2026-11-01');
    const r2 = run({ now: '2026-07-04T02:00:00.000Z' }); // 22:00 EDT July 3
    assert.equal(r2.week_end, '2026-07-03');
    assert.equal(r2.week_start, '2026-06-27');
  });
});

describe('Weekly report: agents', () => {
  test('counts runs and errors, aliases legacy names, strips " Agent"', () => {
    const t = '2026-10-29T10:00:00.000Z';
    const r = run({ log: [logRow('Estimator', 'Done', t), logRow('Estimate Agent', 'Error', t), logRow('Content', 'Done', t),
      logRow('Integrator', 'Error', t), logRow('Shield/Ops', 'Working', t)] });
    assert.deepEqual(r.runs_by_agent.Estimator, { runs: 2, errors: 1 });
    assert.deepEqual(r.runs_by_agent.Marketer, { runs: 1, errors: 0 });
    assert.deepEqual(r.runs_by_agent.Conductor, { runs: 1, errors: 1 });
    assert.deepEqual(r.runs_by_agent['Shield/Ops'], { runs: 1, errors: 0 });
  });
  test('unknown, missing and hostile agent names do not throw', () => {
    const t = '2026-10-29T10:00:00.000Z';
    const r = run({ log: [logRow('Mystery', 'Error', t), logRow(null, 'Done', t), logRow('__proto__', 'Done', t), logRow('constructor', 'Done', t)] });
    assert.deepEqual(r.runs_by_agent.Mystery, { runs: 1, errors: 1 });
    assert.equal(r.runs_by_agent.Unknown.runs, 2);
    assert.equal(r.runs_by_agent.constructor.runs, 1);
  });
  test('falls back to created_time when Timestamp missing; skips rows with no date', () => {
    const noTs = { id: 'x', created_time: '2026-10-30T10:00:00.000Z', properties: { Agent: sel('Router') } };
    const none = { id: 'y', properties: { Agent: sel('Router') } };
    const bare = { id: 'z' };
    const r = run({ log: [noTs, none, bare] });
    assert.equal(r.runs_by_agent.Router.runs, 1);
  });
});

describe('Weekly report: approvals, qa, jobs', () => {
  test('approvals counted by created and Decided At', () => {
    const r = run({ appr: [
      apr({ status: 'Awaiting Approval', qa: 'Pass' }),
      apr({ status: 'Awaiting Approval', qa: 'Fail' }),
      apr({ status: 'Approved', qa: null, decided: '2026-10-31T10:00:00.000Z' }),
      apr({ status: 'Rejected', qa: 'Not checked', decided: '2026-10-31T10:00:00.000Z' }),
      apr({ status: 'Sent', qa: 'Pass', decided: '2026-10-27T10:00:00.000Z' }),
      apr({ status: 'Sent', qa: 'Pass', decided: '2026-10-20T10:00:00.000Z', created: '2026-10-19T00:00:00.000Z' }), // old
      apr({ status: 'Approved', decided: null }), // approved, no Decided At: not counted as approved
    ] });
    assert.deepEqual(r.approvals, { created: 6, approved: 1, rejected: 1, sent: 1, awaiting: 2 });
    assert.deepEqual(r.qa, { pass: 3, fail: 1, not_checked: 2 });
  });
  test('Decided At in window counts even when created earlier; created edges', () => {
    const r = run({ appr: [
      apr({ status: 'Approved', created: '2026-09-01T00:00:00.000Z', decided: '2026-10-28T00:00:00.000Z' }),
      apr({ created: '2026-10-26T03:59:59.000Z' }),
      apr({ created: LO }),
      apr({ created: HI }),
    ] });
    assert.equal(r.approvals.created, 1);
    assert.equal(r.approvals.approved, 1);
  });
  test('missing properties on approvals and pipeline rows do not throw', () => {
    const r = run({ appr: [{ id: 'a', created_time: '2026-10-30T00:00:00.000Z' }, { id: 'b', created_time: '2026-10-30T00:00:00.000Z', properties: null }],
      pipe: [{ id: 'p', created_time: '2026-10-30T00:00:00.000Z' }, { id: 'q', created_time: '2026-10-30T00:00:00.000Z', properties: { Status: sel(null) } }] });
    assert.equal(r.approvals.created, 2);
    assert.equal(r.qa.not_checked, 2);
    assert.equal(r.jobs.by_status.Unknown, 2);
  });
  test('jobs by status, flagged, window, unknown status', () => {
    const r = run({ pipe: [job('Booked'), job('Booked'), job('Flagged'), job('Paid'), job('Weird Status'),
      job('Booked', '2026-10-01T00:00:00.000Z'), job('Flagged', HI)] });
    assert.equal(r.jobs.by_status.Booked, 2);
    assert.equal(r.jobs.by_status.Flagged, 1);
    assert.equal(r.jobs.flagged, 1);
    assert.equal(r.jobs.by_status['Weird Status'], 1);
    assert.equal(r.jobs.by_status['In Progress'], 0);
  });
});

describe('Weekly report: no client data leaks', () => {
  test('output contains no names, titles, draft or notes text', () => {
    const t = '2026-10-29T10:00:00.000Z';
    const out = JSON.stringify(run({ log: [logRow('Router', 'Done', t)], appr: [apr(), apr({ status: 'Sent', decided: t })], pipe: [job('Flagged')] }));
    for (const s of ['Smith', 'Jane', 'Dear', '$500', 'secret note', 'gate code', 'Route:', 'Interior']) assert.ok(!out.includes(s), s);
  });
});
