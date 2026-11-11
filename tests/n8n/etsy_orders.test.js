'use strict';
// Tests for the Code nodes and design of etsy-orders-workflow.json.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wf = require(path.join(__dirname, '..', '..', 'dashboard', 'n8n', 'etsy-orders-workflow.json'));
const node = (n) => wf.nodes.find((x) => x.name === n);
const code = (n) => node(n).parameters.jsCode;

function run(src, { input = [], refs = {}, env = {} } = {}) {
  const fn = new Function('$input', '$', '$env', src);
  const wrap = (arr) => arr.map((j) => ({ json: j }));
  const $ = (n) => {
    if (!(n in refs)) throw new Error(`Node "${n}" not mocked`);
    const items = wrap(refs[n]);
    return { all: () => items, first: () => items[0] };
  };
  const items = wrap(input);
  return fn({ all: () => items, first: () => items[0] }, $, env);
}

const goodOrder = (o = {}) => ({
  order_id: '123456789', order_number: '1234', buyer_first_name: 'Ana',
  items: [{ title: 'Moon candle', qty: 2, price: 12.5 }, { title: 'Star dish', qty: 1, price: 8 }],
  total: 33, currency: 'usd', order_date: '2026-11-01', ship_by: '2026-11-05', ...o,
});
const vOrder = (body) => run(code('Validate Order'), { input: [{ body }] })[0].json;
const vShip = (body) => run(code('Validate Shipped'), { input: [{ body }] })[0].json;
const goodShip = (o = {}) => ({ order_id: '123456789', tracking_number: '9400 1000 0000', carrier: 'USPS', shipped_at: '2026-11-03', ...o });

describe('Validate Order', () => {
  test('accepts a good order and normalises', () => {
    const r = vOrder(goodOrder());
    assert.equal(r.valid, true);
    assert.equal(r.currency, 'USD');
    assert.equal(r.items_summary, '2 x Moon candle; 1 x Star dish');
    assert.equal(r.ship_by, '2026-11-05');
  });
  test('numeric order_id accepted as string; ship_by optional', () => {
    const r = vOrder(goodOrder({ order_id: 123456789, ship_by: undefined }));
    assert.equal(r.valid, true);
    assert.equal(r.order_id, '123456789');
    assert.equal(r.ship_by, '');
  });
  test('rejects non-object bodies', () => {
    for (const b of [undefined, null, 'x', 5, []]) assert.equal(vOrder(b).valid, false);
  });
  test('rejects bad fields', () => {
    const bad = [
      { order_id: '' }, { order_id: 'a/b' }, { order_id: 'x'.repeat(41) }, { buyer_first_name: '' }, { buyer_first_name: 5 },
      { items: [] }, { items: 'x' }, { items: [{ title: '', qty: 1 }] }, { items: [{ title: 'a', qty: 0 }] },
      { items: [{ title: 'a', qty: 1.5 }] }, { items: [{ title: 'a', qty: '2' }] }, { items: [{ title: 'a', qty: 1, price: -1 }] },
      { items: Array(51).fill({ title: 'a', qty: 1 }) },
      { total: '33' }, { total: -1 }, { total: NaN }, { total: 1e7 }, { currency: 'US' }, { currency: 'DOLLARS' },
      { order_date: '' }, { order_date: 'tomorrow' }, { order_date: '2026-13-45' }, { ship_by: 'soon' }, { order_number: '<b>' },
    ];
    for (const o of bad) assert.equal(vOrder(goodOrder(o)).valid, false, JSON.stringify(o).slice(0, 80));
  });
  test('caps and strips control characters', () => {
    const r = vOrder(goodOrder({ buyer_first_name: 'A\u0000n\u0007a\nB' + 'x'.repeat(100), items: [{ title: 'T\u0001i\ttle', qty: 1 }] }));
    assert.equal(r.valid, true);
    assert.doesNotMatch(r.buyer_first_name, /[\u0000-\u001F]/);
    assert.ok(r.buyer_first_name.length <= 60);
    assert.equal(r.items[0].title, 'T i tle');
  });
  test('items_summary stays under the Notion 2000 limit', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ title: 'T'.repeat(190) + i, qty: 1 }));
    const r = vOrder(goodOrder({ items }));
    assert.equal(r.valid, true);
    assert.ok(r.items_summary.length <= 1900);
  });
});

describe('Dedupe', () => {
  const dedupe = (rows) => run(code('Dedupe'), { refs: { 'Validate Order': [{ order_id: '123' }], 'Notion Find Order': rows } })[0].json;
  const row = (id) => ({ id: 'p1', properties: { 'Order ID': { title: [{ plain_text: id }] } } });
  test('empty result (alwaysOutputData placeholder) means not existing', () => {
    assert.equal(dedupe([{}]).exists, false);
  });
  test('matching Order ID exists; non-matching does not', () => {
    assert.equal(dedupe([row('123')]).exists, true);
    assert.equal(dedupe([row('1234')]).exists, false);
  });
  test('branches: duplicate responds without creating a row', () => {
    const c = wf.connections;
    const [yes, no] = c['Already exists?'].main.map((a) => a[0].node);
    assert.equal(yes, 'Respond Duplicate');
    assert.equal(no, 'Create Order Row');
    assert.ok(!c['Respond Duplicate']);
  });
});

describe('Pick Order and Guard', () => {
  const pick = (rows) => run(code('Pick Order'), { refs: { 'Validate Shipped': [goodShip()], 'Notion Find Order B': rows } })[0].json;
  const mk = (status) => ({ id: 'page1', properties: {
    'Order ID': { title: [{ plain_text: '123456789' }] },
    'Buyer First Name': { rich_text: [{ plain_text: 'Ana' }] },
    'Items Summary': { rich_text: [{ plain_text: '2 x Moon candle' }] },
    'Order Number': { rich_text: [{ plain_text: '1234' }] },
    'Status': { select: { name: status } } } });
  const guard = (j) => run(code('Guard'), { input: [j] })[0].json;
  test('no row means found false (404 path)', () => {
    assert.equal(pick([{}]).found, false);
  });
  test('finds row and reads names from properties', () => {
    const r = pick([mk('New')]);
    assert.deepEqual([r.found, r.page_id, r.buyer_first_name, r.status], [true, 'page1', 'Ana', 'New']);
  });
  test('guard allows New and Packed only', () => {
    assert.equal(guard(pick([mk('New')])).allowed, true);
    assert.equal(guard(pick([mk('Packed')])).allowed, true);
    for (const s of ['Shipped', 'Delivered', 'Issue', '']) assert.equal(guard(pick([mk(s)])).allowed, false, s);
    assert.match(guard(pick([mk('Shipped')])).guard_reason, /already Shipped/);
  });
  test('Validate Shipped rejects bad input, defaults shipped_at', () => {
    for (const o of [{ order_id: '' }, { tracking_number: 'x' }, { carrier: '' }, { shipped_at: 'nope' }, { tracking_number: '<script>' }])
      assert.equal(vShip(goodShip(o)).valid, false, JSON.stringify(o));
    const r = vShip(goodShip({ shipped_at: undefined }));
    assert.equal(r.valid, true);
    assert.match(r.shipped_at, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Draft', () => {
  const row = { order_id: '123456789', order_number: '1234', page_id: 'page1', buyer_first_name: 'Ana', items_summary: '2 x Moon candle; 1 x Star dish', carrier: 'USPS', tracking_number: '9400 1000 0000' };
  const draft = (r = row) => run(code('Build Draft'), { refs: { Guard: [r] } })[0].json;
  test('uses only row data', () => {
    const d = draft();
    for (const s of ['Hi Ana,', '2 x Moon candle; 1 x Star dish', 'USPS', '9400 1000 0000', 'TheLuminousFairy']) assert.ok(d.draft.includes(s), s);
    assert.equal(d.title, 'Shipping confirmation: 1234');
  });
  test('no invented delivery dates, prices, addresses or promises', () => {
    const t = draft().draft;
    assert.doesNotMatch(t, /\b(arrive[sd]?|delivery|deliver(ed)?|days?|business|by (mon|tue|wed|thu|fri|sat|sun)|estimated|guarantee|refund|free)\b/i);
    assert.doesNotMatch(t, /\d{4}-\d{2}-\d{2}|\$|USD/);
    assert.doesNotMatch(t, /\b(street|st\.|avenue|road|apt|suite|zip|address)\b|\b\d{5}\b/i);
  });
  test('missing carrier or tracking is omitted, not invented', () => {
    const t = draft({ ...row, carrier: '', tracking_number: '', buyer_first_name: '' }).draft;
    assert.match(t, /^Hi there,/);
    assert.doesNotMatch(t, /Tracking number|shipped with /);
  });
  test('chunking: round-trips and each item <= 1900', () => {
    const long = 'x'.repeat(5000);
    const body = run(code('Chunk Draft'), { refs: { 'Build Draft': [{ title: 'T', draft: long, order_id: '1' }] } })[0].json.notionBody;
    const items = body.properties.Draft.rich_text;
    assert.ok(items.length >= 3);
    assert.ok(items.every((i) => i.text.content.length <= 1900));
    assert.equal(items.map((i) => i.text.content).join(''), long);
  });
  test('approval row is Awaiting Approval / Not checked, agent Etsy', () => {
    const p = run(code('Chunk Draft'), { refs: { 'Build Draft': [{ title: 'T', draft: 'hi', order_id: '1' }] } })[0].json.notionBody.properties;
    assert.equal(p.Status.select.name, 'Awaiting Approval');
    assert.equal(p['QA Result'].select.name, 'Not checked');
    assert.equal(p.Agent.select.name, 'Etsy');
  });
});

describe('Webhook auth (n8n Header Auth)', () => {
  const hooks = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  test('both webhooks use headerAuth with an empty httpHeaderAuth credential placeholder', () => {
    assert.equal(hooks.length, 2);
    for (const h of hooks) {
      assert.equal(h.parameters.authentication, 'headerAuth');
      assert.deepEqual(Object.keys(h.credentials), ['httpHeaderAuth']);
      assert.equal(h.credentials.httpHeaderAuth.id, '');
    }
  });
  test('webhooks feed validation directly (no custom secret check node left)', () => {
    assert.equal(wf.connections['Etsy Order Webhook'].main[0][0].node, 'Validate Order');
    assert.equal(wf.connections['Etsy Shipped Webhook'].main[0][0].node, 'Validate Shipped');
    assert.ok(!wf.nodes.some((n) => /Check Secret|Authorized|Unauthorized/.test(n.name)));
  });
  test('no Code node references $env, and no secret env name or value is in the workflow', () => {
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) assert.doesNotMatch(n.parameters.jsCode, /\$env/);
    assert.doesNotMatch(JSON.stringify(wf), /JARVIS_INTAKE_SECRET|x-jarvis-secret/i);
  });
  test('every connection target exists', () => {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(from));
      for (const out of c.main) for (const t of out) assert.ok(names.has(t.node), t.node);
    }
  });
});

describe('Workflow safety', () => {
  const str = JSON.stringify(wf);
  test('no credentials, no secrets', () => {
    for (const n of wf.nodes) for (const c of Object.values(n.credentials || {})) assert.equal(c.id, '');
    assert.doesNotMatch(str, /sk-ant-|secret_[A-Za-z0-9]{10,}|ntn_/);
    assert.ok(!/etsy.*(api[_ ]?key|keystring|oauth)/i.test(str));
  });
  test('webhooks use placeholder origin, never *', () => {
    const hooks = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
    assert.equal(hooks.length, 2);
    for (const h of hooks) assert.equal(h.parameters.options.allowedOrigins, 'https://REPLACE_WITH_DASHBOARD_ORIGIN');
    assert.ok(!str.includes('"*"'));
  });
  test('never calls Etsy or messages the buyer; only Notion and QA are called', () => {
    const urls = wf.nodes.filter((n) => n.parameters.url).map((n) => n.parameters.url);
    assert.deepEqual(urls.sort(), ['https://REPLACE_WITH_N8N_BASE/webhook/jarvis/qa', 'https://api.notion.com/v1/pages']);
    assert.ok(!/etsy\.com|openapi\.etsy/i.test(str));
    assert.ok(!wf.nodes.some((n) => /emailSend|gmail|slack|twilio/i.test(n.type)));
  });
  test('Call QA is non-blocking; Etsy DB id is a placeholder', () => {
    assert.equal(node('Call QA').onError, 'continueRegularOutput');
    for (const n of ['Notion Find Order', 'Notion Find Order B', 'Create Order Row'])
      assert.equal(node(n).parameters.databaseId.value, 'REPLACE_WITH_ETSY_ORDERS_DB_ID');
  });
  test('new orders are created with Status New', () => {
    const v = node('Create Order Row').parameters.propertiesUi.propertyValues.find((p) => p.key === 'Status|select');
    assert.equal(v.selectValue, 'New');
  });
});
