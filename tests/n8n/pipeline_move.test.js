'use strict';
// Tests for dashboard/n8n/pipeline-move-workflow.json (Code-node extraction).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wf = require(path.join(__dirname, '..', '..', 'dashboard', 'n8n', 'pipeline-move-workflow.json'));
const node = (n) => wf.nodes.find((x) => x.name === n);
const code = (n) => node(n).parameters.jsCode;

function run(src, { input = [], refs = {} } = {}) {
  const fn = new Function('$input', '$', src);
  const wrap = (arr) => arr.map((j) => ({ json: j }));
  const $ = (n) => {
    if (!(n in refs)) throw new Error(`Node "${n}" not mocked`);
    const items = wrap(refs[n]);
    return { all: () => items, first: () => items[0] };
  };
  const items = wrap(input);
  return fn({ all: () => items, first: () => items[0] }, $);
}

const PIPELINE = '6cc3d9aad6d14fa39377673274a4cc5f';
const ID = '0123456789abcdef0123456789abcdef';
const validate = (body) => run(code('Validate Move'), { input: [{ body }] })[0].json;
const page = (o = {}) => ({
  id: ID,
  parent: { type: 'database_id', database_id: o.db ?? '6cc3d9aa-d6d1-4fa3-9377-673274a4cc5f' },
  archived: false,
  properties: { Status: o.status === undefined ? { type: 'select', select: { name: 'Booked' } } : o.status },
  ...(o.extra || {}),
});
const guard = (p, status = 'In Progress') =>
  run(code('Guard'), { input: [p], refs: { 'Validate Move': [{ valid: true, id: ID, status }] } })[0].json;

describe('Pipeline Move: workflow shape', () => {
  test('single POST webhook, placeholder origin, never *', () => {
    const w = wf.nodes.filter((n) => n.type.endsWith('.webhook'));
    assert.equal(w.length, 1);
    assert.equal(w[0].parameters.httpMethod, 'POST');
    assert.equal(w[0].parameters.path, 'jarvis/pipeline/move');
    assert.equal(w[0].parameters.options.allowedOrigins, 'https://REPLACE_WITH_DASHBOARD_ORIGIN');
  });
  test('Notion get is simple:false; update writes Status|select only', () => {
    assert.equal(node('Notion Get Job').parameters.simple, false);
    const vals = node('Notion Update Status').parameters.propertiesUi.propertyValues;
    assert.deepEqual(vals.map((v) => v.key), ['Status|select']);
  });
  test('activity log uses Agent Conductor, Task "Job moved"', () => {
    const p = node('Log Job Moved').parameters;
    const v = Object.fromEntries(p.propertiesUi.propertyValues.map((x) => [x.key, x]));
    assert.equal(v['Agent|select'].selectValue, 'Conductor');
    assert.equal(v['Task|title'].title, 'Job moved');
    assert.match(v['Output Notes|rich_text'].text, /->/);
  });
  test('no credential ids', () => {
    for (const n of wf.nodes) if (n.credentials) for (const c of Object.values(n.credentials)) assert.equal(c.id, '');
  });
});

describe('Validate Move', () => {
  for (const s of ['Booked', 'In Progress', 'Awaiting Invoice', 'Paid', 'Flagged']) {
    test(`accepts ${s}`, () => assert.deepEqual(validate({ id: ID, status: s }), { valid: true, id: ID, status: s }));
  }
  test('accepts dashed uuid', () => {
    assert.equal(validate({ id: '01234567-89ab-cdef-0123-456789abcdef', status: 'Paid' }).valid, true);
  });
  test('rejects bad status values', () => {
    for (const s of ['booked', 'Done', ' Booked', 'Booked ', '', null, 5, ['Booked']]) {
      assert.equal(validate({ id: ID, status: s }).valid, false, JSON.stringify(s));
    }
  });
  test('rejects bad ids', () => {
    for (const id of ['', 'abc', ID + '0', 'g' + ID.slice(1), null, 12, ['x'], '../' + ID]) {
      assert.equal(validate({ id, status: 'Booked' }).valid, false, JSON.stringify(id));
    }
  });
  test('rejects missing/non-object body and extra fields', () => {
    for (const b of [undefined, null, 'x', [], {}, { id: ID }, { status: 'Booked' }, { id: ID, status: 'Booked', note: 'x' }]) {
      const r = validate(b);
      assert.equal(r.valid, false);
      assert.equal(typeof r.error, 'string');
    }
  });
});

describe('Guard', () => {
  test('accepts a Pipeline page and reports from/to', () => {
    assert.deepEqual(guard(page()), { ok: true, id: ID, from: 'Booked', to: 'In Progress' });
  });
  test('accepts undashed database id', () => {
    assert.equal(guard(page({ db: PIPELINE })).ok, true);
  });
  test('409 for a page in another database', () => {
    const g = guard(page({ db: 'a807f4c25dfe4ce388626726b7d99f6d' }));
    assert.equal(g.ok, false);
    assert.equal(g.code, 409);
  });
  test('409 for non-database parent', () => {
    const p = page();
    p.parent = { type: 'page_id', page_id: PIPELINE };
    assert.equal(guard(p).code, 409);
  });
  test('409 when Status is missing or not a select', () => {
    assert.equal(guard(page({ status: undefined, extra: {} })).ok, true);
    const p = page();
    delete p.properties.Status;
    assert.equal(guard(p).code, 409);
    assert.equal(guard(page({ status: { type: 'rich_text', rich_text: [] } })).code, 409);
  });
  test('409 for archived page and for no-op move', () => {
    assert.equal(guard(page({ extra: { archived: true } })).code, 409);
    assert.equal(guard(page(), 'Booked').code, 409);
  });
  test('404 when Notion get returned an error or nothing', () => {
    assert.equal(guard({ error: 'not found' }).code, 404);
    assert.equal(guard({}).code, 404);
  });
  test('empty current Status gives from ""', () => {
    assert.equal(guard(page({ status: { type: 'select', select: null } })).from, '');
  });
  test('409 on id mismatch', () => {
    const p = page();
    p.id = 'f'.repeat(32);
    assert.equal(guard(p).code, 409);
  });
});
