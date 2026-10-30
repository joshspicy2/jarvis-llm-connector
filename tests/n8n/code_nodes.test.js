'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wf = require(path.join(__dirname, '..', '..', 'dashboard', 'n8n', 'jarvis-dashboard-api.json'));

function code(name) {
  const n = wf.nodes.find((x) => x.name === name);
  assert.ok(n, `Code node not found: ${name}`);
  assert.ok(n.parameters && n.parameters.jsCode, `no jsCode on ${name}`);
  return n.parameters.jsCode;
}

// Run a node's jsCode with mocked n8n globals. refs maps node name -> json of its first item.
function run(name, items, refs = {}) {
  const fn = new Function('$input', '$', '$json', code(name));
  const $input = { all: () => items.map((json) => ({ json })), first: () => ({ json: items[0] }) };
  const $ = (node) => {
    if (!(node in refs)) throw new Error(`Node "${node}" not mocked`);
    return { first: () => ({ json: refs[node] }) };
  };
  const out = fn($input, $, items[0] || {});
  assert.ok(Array.isArray(out) && out.length === 1, 'returns exactly one item');
  return out[0].json;
}

// ---- Notion raw page helpers (simple:false) ----
const rt = (s) => ({ type: 'rich_text', rich_text: s ? [{ plain_text: s }] : [] });
const title = (s) => ({ type: 'title', title: [{ plain_text: s }] });
const sel = (s) => ({ type: 'select', select: s ? { name: s } : null });
const status = (s) => ({ type: 'status', status: { name: s } });
const num = (n) => ({ type: 'number', number: n });
const chk = (b) => ({ type: 'checkbox', checkbox: b });
const date = (d) => ({ type: 'date', date: d ? { start: d } : null });
let seq = 0;
const page = (properties, created_time = '2026-01-01T00:00:00.000Z') => ({
  object: 'page', id: `page-${++seq}`, created_time, properties,
});

describe('Shape Pipeline', () => {
  const job = (t, st, extra = {}) => page({ Name: title(t), Status: status(st), ...extra });

  test('groups into fixed ordered stages', () => {
    const body = run('Shape Pipeline', [
      job('A', 'Paid'), job('B', 'Booked'), job('C', 'Flagged'),
      job('D', 'In Progress'), job('E', 'Awaiting Invoice'), job('F', 'Booked'),
    ]).body;
    assert.deepEqual(body.stages.map((s) => s.name),
      ['Booked', 'In Progress', 'Awaiting Invoice', 'Flagged', 'Paid']);
    const by = Object.fromEntries(body.stages.map((s) => [s.name, s.cards.map((c) => c.title)]));
    assert.deepEqual(by, {
      Booked: ['B', 'F'], 'In Progress': ['D'], 'Awaiting Invoice': ['E'], Flagged: ['C'], Paid: ['A'],
    });
  });

  test('empty input still yields five empty stages', () => {
    const body = run('Shape Pipeline', []).body;
    assert.equal(body.stages.length, 5);
    assert.ok(body.stages.every((s) => s.cards.length === 0));
  });

  test('missing status defaults to Booked; unknown stage appended as its own group', () => {
    const body = run('Shape Pipeline', [
      page({ Name: title('NoStatus') }), job('Weird', 'Cancelled'),
    ]).body;
    assert.deepEqual(body.stages.find((s) => s.name === 'Booked').cards.map((c) => c.title), ['NoStatus']);
    const last = body.stages[body.stages.length - 1];
    assert.equal(last.name, 'Cancelled');
    assert.deepEqual(last.cards.map((c) => c.title), ['Weird']);
  });

  test('sub line joins job type and scheduled date; untitled fallback; skips items without id', () => {
    const body = run('Shape Pipeline', [
      { object: 'list' }, // no id -> ignored
      page({ Name: title(''), Status: status('Booked'), 'Job Type': sel('Install'), 'Scheduled Date': date('2026-02-03') }),
      job('OnlyDate', 'Booked', { 'Scheduled Date': date('2026-02-04') }),
    ]).body;
    const cards = body.stages[0].cards;
    assert.equal(cards.length, 2);
    assert.deepEqual(cards[0], { title: '(untitled)', sub: 'Install · 2026-02-03' });
    assert.deepEqual(cards[1], { title: 'OnlyDate', sub: '2026-02-04' });
  });

  test('Status as select type also works', () => {
    const body = run('Shape Pipeline', [page({ Name: title('S'), Status: sel('Paid') })]).body;
    assert.equal(body.stages.find((s) => s.name === 'Paid').cards.length, 1);
  });
});

describe('Shape Rules', () => {
  const rule = (svc, extra = {}) => page({ Service: title(svc), ...extra });

  test('Active filter: only explicit false is excluded', () => {
    const rows = run('Shape Rules', [
      rule('On', { Active: chk(true) }),
      rule('Off', { Active: chk(false) }),
      rule('NoFlag'),
    ]).body;
    assert.deepEqual(rows.map((r) => r.service), ['On', 'NoFlag']);
  });

  test('numbers stay numeric, missing numbers become empty string, zero preserved', () => {
    const rows = run('Shape Rules', [
      rule('Full', { Active: chk(true), 'Base Rate': num(125.5), 'Minimum Charge': num(0), Category: sel('Plumbing'), Unit: sel('hour'), Notes: rt('n') }),
      rule('Bare', { Active: chk(true) }),
    ]).body;
    assert.deepEqual(rows[0], { service: 'Full', category: 'Plumbing', base: 125.5, unit: 'hour', min: 0, notes: 'n' });
    assert.deepEqual(rows[1], { service: 'Bare', category: '', base: '', unit: '', min: '', notes: '' });
  });

  test('category and min mapping', () => {
    const [r] = run('Shape Rules', [rule('X', { Category: sel('Electrical'), 'Minimum Charge': num(75) })]).body;
    assert.equal(r.category, 'Electrical');
    assert.equal(r.min, 75);
  });

  test('items without id ignored', () => {
    assert.deepEqual(run('Shape Rules', [{ foo: 1 }]).body, []);
  });
});

describe('Shape War (GET)', () => {
  const flag = (t, v) => page({ Flag: title(t), Value: chk(v) });

  test('true when War Mode row Value is checked', () => {
    assert.equal(run('Shape War', [flag('War Mode', true)]).body.enabled, true);
  });
  test('false when unchecked', () => {
    assert.equal(run('Shape War', [flag('War Mode', false)]).body.enabled, false);
  });
  test('false when no rows', () => {
    assert.equal(run('Shape War', []).body.enabled, false);
  });
  test('Warranty row must not count as War Mode', () => {
    assert.equal(run('Shape War', [flag('Warranty', true)]).body.enabled, false);
  });
  test('only the exactly titled row counts among others', () => {
    assert.equal(run('Shape War', [flag('Warranty', true), flag('War Mode', false), flag('Other', true)]).body.enabled, false);
    assert.equal(run('Shape War', [flag('Warranty', false), flag('War Mode', true)]).body.enabled, true);
    assert.equal(run('Shape War', [flag('War Mode Extra', true)]).body.enabled, false);
  });
});

describe('Pick War Row', () => {
  const rows = [page({ Flag: title('Warranty'), Value: chk(false) }), page({ Flag: title('War Mode'), Value: chk(false) })];
  const ref = (body) => ({ 'War POST': { body } });

  test('picks the War Mode row id and passes boolean through', () => {
    for (const enabled of [true, false]) {
      const out = run('Pick War Row', rows, ref({ enabled }));
      assert.deepEqual(out, { pageId: rows[1].id, enabled });
    }
  });
  test('rejects non-boolean body.enabled', () => {
    for (const bad of ['true', 1, 0, null, undefined]) {
      assert.throws(() => run('Pick War Row', rows, ref({ enabled: bad })), /Bad request/);
    }
  });
  test('rejects missing body', () => {
    assert.throws(() => run('Pick War Row', rows, ref(undefined)), /Bad request/);
  });
  test('throws when no War Mode row (Warranty alone is not enough)', () => {
    assert.throws(() => run('Pick War Row', [rows[0]], ref({ enabled: true })), /No War Mode row/);
    assert.throws(() => run('Pick War Row', [], ref({ enabled: true })), /No War Mode row/);
  });
});

describe('Shape Log', () => {
  const entry = (t, ts, agent, notes) => page({
    Task: title(t), Agent: sel(agent), 'Output Notes': rt(notes), ...(ts ? { Timestamp: date(ts) } : {}),
  });

  test('sorted oldest to newest and text joined with ": "', () => {
    const rows = run('Shape Log', [
      entry('late', '2026-03-01T15:00:00.000Z', 'Router', 'n2'),
      entry('early', '2026-03-01T14:00:00.000Z', 'Builder', ''),
    ]).body;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].text, 'Builder: early');
    assert.equal(rows[1].text, 'Router: late: n2');
    // 14:00Z / 15:00Z on 2026-03-01 (EST, UTC-5, before DST) => 09:00:00 / 10:00:00
    assert.match(rows[0].t, /^09:00:00$/);
    assert.match(rows[1].t, /^10:00:00$/);
  });

  test('falls back to created_time when Timestamp missing', () => {
    const rows = run('Shape Log', [
      page({ Task: title('b') }, '2026-03-01T16:00:00.000Z'),
      page({ Task: title('a') }, '2026-03-01T12:00:00.000Z'),
    ]).body;
    assert.deepEqual(rows.map((r) => r.text), ['a', 'b']);
  });

  test('limits to the most recent 25', () => {
    const items = [];
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.UTC(2026, 2, 1, 0, i, 0)).toISOString();
      items.push(entry(`e${i}`, d, 'QA', ''));
    }
    items.reverse(); // input order shuffled
    const rows = run('Shape Log', items).body;
    assert.equal(rows.length, 25);
    assert.equal(rows[0].text, 'QA: e15');
    assert.equal(rows[24].text, 'QA: e39');
  });
});

describe('Shape Agents', () => {
  const ev = (agent, st, t, ts) => page({
    Task: title(t), Agent: sel(agent), Status: status(st), ...(ts ? { Timestamp: date(ts) } : {}),
  });
  const NAMES = ['Conductor', 'Router', 'Estimator', 'Marketer', 'Builder', 'Support', 'QA', 'Engineer', 'Researcher', 'Developer', 'Shield/Ops'];
  const agents = (items) => Object.fromEntries(run('Shape Agents', items).body.map((a) => [a.name, a]));

  test('always returns all 11 agents in order, idle with no activity', () => {
    const body = run('Shape Agents', []).body;
    assert.deepEqual(body.map((a) => a.name), NAMES);
    assert.ok(body.every((a) => a.status === 'idle' && a.detail === 'no activity yet'));
  });

  test('legacy names map: Estimate->Estimator, Content->Marketer, Integrator->Conductor', () => {
    const a = agents([ev('Estimate', 'Working', 'est', '2026-01-01'), ev('Content', 'Thinking', 'cont', '2026-01-01'), ev('Integrator', 'Error', 'integ', '2026-01-01')]);
    assert.equal(a.Estimator.detail, 'est');
    assert.equal(a.Marketer.detail, 'cont');
    assert.equal(a.Conductor.detail, 'integ');
    assert.equal(a.Router.detail, 'no activity yet');
  });

  test('" Agent" suffix stripped', () => {
    assert.equal(agents([ev('Router Agent', 'Working', 'r', '2026-01-01')]).Router.detail, 'r');
  });

  test('status mapping', () => {
    const a = agents([
      ev('Router', 'Thinking', 'x', '2026-01-01'), ev('Builder', 'Working', 'x', '2026-01-01'),
      ev('QA', 'Error', 'x', '2026-01-01'), ev('Support', 'Done', 'x', '2026-01-01'),
      ev('Engineer', 'Idle', 'x', '2026-01-01'), ev('Developer', 'Mystery', 'x', '2026-01-01'),
    ]);
    assert.equal(a.Router.status, 'active');
    assert.equal(a.Builder.status, 'active');
    assert.equal(a.QA.status, 'error');
    assert.equal(a.Support.status, 'idle');
    assert.equal(a.Engineer.status, 'idle');
    assert.equal(a.Developer.status, 'idle');
  });

  test('latest event per agent wins regardless of input order', () => {
    const a = agents([
      ev('Router', 'Working', 'newer', '2026-02-01T00:00:00Z'),
      ev('Router', 'Error', 'older', '2026-01-01T00:00:00Z'),
    ]);
    assert.equal(a.Router.detail, 'newer');
    assert.equal(a.Router.status, 'active');
  });

  test('legacy and modern names for the same agent compete on recency', () => {
    const a = agents([
      ev('Estimate', 'Error', 'old legacy', '2026-01-01T00:00:00Z'),
      ev('Estimator', 'Working', 'new', '2026-02-01T00:00:00Z'),
    ]);
    assert.equal(a.Estimator.detail, 'new');
    assert.equal(a.Estimator.status, 'active');
  });

  test('rows with no agent are ignored', () => {
    const body = run('Shape Agents', [page({ Task: title('orphan'), Status: status('Working') })]).body;
    assert.ok(body.every((a) => a.detail === 'no activity yet'));
  });
});
