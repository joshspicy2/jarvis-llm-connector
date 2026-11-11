'use strict';
// Tests for the Build sales Code node in etsy-sales-workflow.json.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wf = require(path.join(__dirname, '..', '..', 'dashboard', 'n8n', 'etsy-sales-workflow.json'));
const src = wf.nodes.find((n) => n.name === 'Build sales').parameters.jsCode;

// 2026-11-01 15:00 UTC = 11:00 EST (DST ended that day). 7d window starts 10-26 00:00 EDT, 30d starts 10-03 00:00 EDT.
const NOW = '2026-11-01T15:00:00.000Z';

function run(rows, { now = NOW, throws = false } = {}) {
  const RealDate = Date;
  const t0 = RealDate.parse(now);
  class FakeDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [t0])); }
    static now() { return t0; }
  }
  const $ = (n) => {
    if (throws) throw new Error('not executed');
    assert.equal(n, 'Notion Etsy Orders');
    const items = rows.map((j) => ({ json: j }));
    return { all: () => items, first: () => items[0] };
  };
  return new Function('$', 'Date', src)($, FakeDate)[0].json.body;
}

const title = (s) => ({ type: 'title', title: [{ plain_text: s }] });
const rt = (s) => ({ type: 'rich_text', rich_text: [{ plain_text: s }] });
const sel = (s) => ({ type: 'select', select: s === null ? null : { name: s } });
const dt = (s) => ({ type: 'date', date: s ? { start: s } : null });
const num = (n) => ({ type: 'number', number: n });
let seq = 0;
const row = (o = {}) => {
  const properties = {
    'Order ID': title(o.id ?? 'ETSY-' + (++seq)),
    'Buyer First Name': rt(o.buyer ?? 'Ana'),
    'Items Summary': rt(o.items ?? '1 x Moon candle'),
    Total: o.total === undefined ? num(10) : o.total,
    Currency: rt(o.cur ?? 'USD'),
    'Order Date': dt(o.od === undefined ? '2026-10-30' : o.od),
    'Ship By': dt(o.sb === undefined ? '2026-11-05' : o.sb),
    Status: sel(o.status ?? 'New'),
    'Tracking Number': rt('9400 SECRET TRACK'), Carrier: rt('USPS'), Notes: rt('123 Main St secret@example.com'),
    'Approval ID': rt('appr-xyz'),
  };
  for (const k of o.drop || []) delete properties[k];
  return { id: 'p' + (++seq), created_time: '2020-01-01T00:00:00.000Z', properties };
};

describe('Etsy sales: workflow and shape', () => {
  test('read-only GET, placeholder origin, placeholder db, no credential ids', () => {
    const hooks = wf.nodes.filter((n) => n.type.endsWith('.webhook'));
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].parameters.httpMethod, 'GET');
    assert.equal(hooks[0].parameters.path, 'jarvis/etsy-sales');
    assert.equal(hooks[0].parameters.options.allowedOrigins, 'https://REPLACE_WITH_DASHBOARD_ORIGIN');
    const nt = wf.nodes.filter((n) => n.type.endsWith('.notion'));
    assert.equal(nt.length, 1);
    assert.equal(nt[0].parameters.operation, 'getAll');
    assert.equal(nt[0].parameters.simple, false);
    assert.equal(nt[0].alwaysOutputData, true);
    assert.equal(nt[0].parameters.databaseId.value, 'REPLACE_WITH_ETSY_ORDERS_DB_ID');
    assert.equal(nt[0].credentials.notionApi.id, '');
  });
  test('empty input gives zeroed exact shape', () => {
    const r = run([]);
    assert.deepEqual(Object.keys(r), ['generated_at', 'currency', 'totals', 'by_status', 'to_ship', 'recent', 'issues']);
    assert.equal(r.generated_at, NOW);
    assert.equal(r.currency, null);
    assert.deepEqual(r.totals, { orders_7d: 0, revenue_7d: 0, orders_30d: 0, revenue_30d: 0, avg_order_30d: 0 });
    assert.deepEqual(r.by_status, { New: 0, Packed: 0, Shipped: 0, Delivered: 0, Issue: 0 });
    assert.deepEqual(r.to_ship, []);
    assert.deepEqual(r.recent, []);
    assert.equal(r.issues, 0);
  });
  test('node not executed and placeholder items do not throw', () => {
    assert.equal(run([], { throws: true }).totals.orders_30d, 0);
    const r = run([{}, { json: {} }, { id: 'x' }]);
    assert.equal(r.totals.orders_30d, 0);
  });
});

describe('Etsy sales: windows', () => {
  test('7d edges: 10-26 in, 10-25 out, today in, tomorrow out', () => {
    const r = run([row({ od: '2026-10-26', total: num(1) }), row({ od: '2026-10-25', total: num(2) }),
      row({ od: '2026-11-01', total: num(4) }), row({ od: '2026-11-02', total: num(8) })]);
    assert.equal(r.totals.orders_7d, 2);
    assert.equal(r.totals.revenue_7d, 5);
    assert.equal(r.totals.orders_30d, 3);
    assert.equal(r.totals.revenue_30d, 7);
  });
  test('30d edges: 10-03 in, 10-02 out; avg', () => {
    const r = run([row({ od: '2026-10-03', total: num(10) }), row({ od: '2026-10-02', total: num(99) }), row({ od: '2026-10-20', total: num(5) })]);
    assert.equal(r.totals.orders_30d, 2);
    assert.equal(r.totals.revenue_30d, 15);
    assert.equal(r.totals.avg_order_30d, 7.5);
  });
  test('DST: datetimes around 00:00 on 2026-11-01 and the 10-26 boundary', () => {
    // 10-26 00:00 EDT = 04:00Z; 11-02 00:00 EST = 05:00Z
    const r = run([
      row({ od: '2026-10-26T03:59:59.000Z' }), row({ od: '2026-10-26T04:00:00.000Z' }),
      row({ od: '2026-11-02T04:59:59.000Z' }), row({ od: '2026-11-02T05:00:00.000Z' }),
    ]);
    assert.equal(r.totals.orders_7d, 2);
  });
  test('DST day: 2026-11-01 is 25h and still one day; 10-26 is 7 days back', () => {
    const r = run([row({ od: '2026-11-01T04:00:00.000Z' }), row({ od: '2026-11-01T03:59:00.000Z' })]); // 00:00 EDT vs 23:59 EDT on 10-31
    assert.equal(r.totals.orders_7d, 2);
    const r2 = run([row({ od: '2026-11-01' })], { now: '2026-11-02T04:30:00.000Z' }); // 23:30 EST? no: 23:30 EDT is 03:30Z; 04:30Z = 23:30 EST 11-01
    assert.equal(r2.totals.orders_7d, 1);
  });
  test('missing or bad Order Date is skipped from totals and recent', () => {
    const r = run([row({ od: null }), row({ od: 'garbage' }), row({ drop: ['Order Date'] })]);
    assert.equal(r.totals.orders_30d, 0);
    assert.deepEqual(r.recent, []);
  });
  test('Issue rows are counted in revenue and reported separately', () => {
    const r = run([row({ status: 'Issue', total: num(20) }), row({ status: 'Shipped', total: num(5) })]);
    assert.equal(r.totals.revenue_7d, 25);
    assert.equal(r.issues, 1);
    assert.equal(r.by_status.Issue, 1);
  });
});

describe('Etsy sales: totals parsing and currency', () => {
  test('Total as rich text, title, string with symbols; missing counts as 0', () => {
    const r = run([row({ total: rt('$1,234.50') }), row({ total: title('10') }), row({ total: rt('n/a') }), row({ drop: ['Total'] }), row({ total: num(0.1) }), row({ total: num(0.2) })]);
    assert.equal(r.totals.orders_7d, 6);
    assert.equal(r.totals.revenue_7d, 1244.8);
    const rec = r.recent.map((x) => x.total);
    assert.ok(rec.includes(null));
  });
  test('single currency, case-insensitive; MIXED; none', () => {
    assert.equal(run([row({ cur: 'usd' }), row({ cur: 'USD' }), row({ cur: '' })]).currency, 'USD');
    assert.equal(run([row({ cur: 'USD' }), row({ cur: 'CAD' })]).currency, 'MIXED');
    assert.equal(run([row({ drop: ['Currency'] })]).currency, null);
  });
});

describe('Etsy sales: to_ship', () => {
  test('only New/Packed, soonest first, no ship_by last, overdue logic', () => {
    const r = run([
      row({ id: 'C', status: 'New', sb: '2026-11-05' }),
      row({ id: 'A', status: 'Packed', sb: '2026-10-30' }),
      row({ id: 'D', status: 'New', sb: null }),
      row({ id: 'B', status: 'New', sb: '2026-11-01' }),
      row({ id: 'S', status: 'Shipped', sb: '2026-10-01' }),
      row({ id: 'I', status: 'Issue', sb: '2026-10-01' }),
    ]);
    assert.deepEqual(r.to_ship.map((x) => x.order), ['A', 'B', 'C', 'D']);
    assert.deepEqual(r.to_ship.map((x) => x.overdue), [true, false, false, false]); // due today is not overdue
    assert.deepEqual(Object.keys(r.to_ship[0]), ['order', 'buyer_first_name', 'items', 'ship_by', 'overdue']);
    assert.equal(r.to_ship[3].ship_by, null);
  });
  test('ship_by datetime converts to New York day', () => {
    const r = run([row({ id: 'X', sb: '2026-11-01T03:00:00.000Z' })]); // 10-31 23:00 EDT
    assert.equal(r.to_ship[0].ship_by, '2026-10-31');
    assert.equal(r.to_ship[0].overdue, true);
  });
  test('cap of 20, ties by order id', () => {
    const rows = []; for (let i = 0; i < 25; i++) rows.push(row({ id: 'O' + String(30 - i).padStart(2, '0'), sb: '2026-11-03' }));
    const r = run(rows);
    assert.equal(r.to_ship.length, 20);
    assert.equal(r.to_ship[0].order, 'O06');
  });
});

describe('Etsy sales: recent', () => {
  test('last 10 by Order Date desc, any status, even outside 30d', () => {
    const rows = []; for (let i = 1; i <= 12; i++) rows.push(row({ id: 'R' + i, od: '2026-08-' + String(i).padStart(2, '0'), status: i % 2 ? 'Delivered' : 'Shipped' }));
    const r = run(rows);
    assert.equal(r.recent.length, 10);
    assert.equal(r.recent[0].order, 'R12');
    assert.equal(r.recent[9].order, 'R3');
    assert.deepEqual(Object.keys(r.recent[0]), ['order', 'date', 'total', 'status']);
    assert.equal(r.recent[0].date, '2026-08-12');
  });
});

describe('Etsy sales: by_status and robustness', () => {
  test('counts statuses, ignores unknown/missing; __proto__ safe', () => {
    const r = run([row({ status: 'New' }), row({ status: 'Packed' }), row({ status: 'Shipped' }), row({ status: 'Delivered' }), row({ status: 'Issue' }),
      row({ status: 'Bogus' }), row({ status: '__proto__' }), row({ drop: ['Status'] })]);
    assert.deepEqual(r.by_status, { New: 1, Packed: 1, Shipped: 1, Delivered: 1, Issue: 1 });
  });
  test('rows with every property missing do not throw', () => {
    const bare = { id: 'bare', properties: {} };
    const noProps = { id: 'np' };
    const r = run([bare, noProps, { id: 'q', properties: { Status: { type: 'select', select: null }, Total: null, 'Order Date': { date: null } } }]);
    assert.equal(r.totals.orders_30d, 0);
  });
  test('buyer first name only, items trimmed to 200', () => {
    const r = run([row({ buyer: 'Ana Maria Lopez', items: 'x'.repeat(500) })]);
    assert.equal(r.to_ship[0].buyer_first_name, 'Ana');
    assert.equal(r.to_ship[0].items.length, 200);
  });
});

describe('Etsy sales: no PII leakage', () => {
  test('output never contains tracking, carrier, notes, address, email, approval id', () => {
    const r = run([row({ status: 'Packed' }), row({ status: 'Shipped' }), row({ status: 'Issue' })]);
    const s = JSON.stringify(r);
    for (const bad of ['SECRET TRACK', 'USPS', '123 Main', 'example.com', 'appr-xyz', 'Tracking', 'Carrier', 'Notes', 'Approval'])
      assert.ok(!s.includes(bad), bad);
  });
});
