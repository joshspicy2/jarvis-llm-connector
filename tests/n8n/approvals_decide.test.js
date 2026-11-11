'use strict';
// Tests for the Code nodes and design of approvals-decide-workflow.json.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wf = require(path.join(__dirname, '..', '..', 'dashboard', 'n8n', 'approvals-decide-workflow.json'));
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

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const UUID = 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90';
const DB = 'a807f4c25dfe4ce388626726b7d99f6d';
const validate = (body) => run(code('Validate'), { input: [{ body }] })[0].json;
const ok = (o = {}) => ({ id: ID, decision: 'approve', decided_by: 'Makenzie', ...o });

describe('Validate', () => {
  test('accepts approve and reject, maps to Approved/Rejected', () => {
    const a = validate(ok());
    assert.equal(a.valid, true);
    assert.deepEqual([a.id, a.decision, a.decided_by, a.new_status], [ID, 'approve', 'Makenzie', 'Approved']);
    assert.equal(validate(ok({ decision: 'reject' })).new_status, 'Rejected');
  });
  test('accepts dashed uuid, lowercases, trims decided_by', () => {
    const r = validate(ok({ id: ` ${UUID.toUpperCase()} `, decided_by: '  Joshua ' }));
    assert.equal(r.valid, true);
    assert.equal(r.id, UUID);
    assert.equal(r.decided_by, 'Joshua');
  });
  test('rejects missing / non-object bodies', () => {
    for (const b of [undefined, null, 'x', 5, [], {}]) {
      const r = validate(b);
      assert.equal(r.valid, false);
      assert.equal(r.new_status, '');
      assert.equal(r.errors.length, 3);
    }
  });
  test('decision is a strict whitelist', () => {
    for (const d of ['Approve', 'APPROVE', 'approved', 'sent', 'approve ', '', null, 1, ['approve'], { a: 1 }, true]) {
      assert.equal(validate(ok({ decision: d })).valid, false, JSON.stringify(d));
    }
  });
  test('id must look like a Notion page id', () => {
    const bad = ['', 'abc', ID.slice(1), ID + '0', 'g'.repeat(32), UUID + 'x', ID + '/../x', `${ID}\n`.replace(/\n/, ' x'),
      'https://www.notion.so/' + ID, null, 12, {}, [ID]];
    for (const id of bad) assert.equal(validate(ok({ id })).valid, false, JSON.stringify(id));
  });
  test('decided_by length 1-60 and no control chars or angle brackets', () => {
    assert.equal(validate(ok({ decided_by: 'a'.repeat(60) })).valid, true);
    assert.equal(validate(ok({ decided_by: 'a'.repeat(61) })).valid, false);
    for (const d of ['', '   ', null, 5, ['x'], 'a\u0000b', 'a\nb', '<script>alert(1)</script>', 'a\u007fb']) {
      assert.equal(validate(ok({ decided_by: d })).valid, false, JSON.stringify(d));
    }
  });
  test('injection-ish strings never validate into output fields', () => {
    for (const s of ["x'; DROP TABLE--", '{{ $json }}', '={{ process.exit() }}', '${1+1}', '" } ; evil(); {"']) {
      const r = validate(ok({ id: s, decision: s }));
      assert.equal(r.valid, false);
      assert.equal(r.id, '');
      assert.equal(r.decision, '');
    }
    // text-like decided_by passes as plain data only; it is never evaluated.
    const r = validate(ok({ decided_by: "O'Brien; {{x}}" }));
    assert.equal(r.valid, true);
    assert.equal(r.decided_by, "O'Brien; {{x}}");
  });
  test('extra keys such as status are ignored and never forwarded', () => {
    const r = validate({ ...ok(), status: 'Sent', new_status: 'Sent' });
    assert.equal(r.new_status, 'Approved');
    assert.ok(!('status' in r));
  });
});

describe('Guard', () => {
  const v = { id: ID, decision: 'approve', decided_by: 'Makenzie', new_status: 'Approved' };
  const pg = (status, o = {}) => ({
    id: o.id ?? UUID,
    parent: o.parent === undefined ? { type: 'database_id', database_id: 'a807f4c2-5dfe-4ce3-8862-6726b7d99f6d' } : o.parent,
    properties: { Status: status === null ? { type: 'select', select: null } : { type: 'select', select: { name: status } } },
  });
  const guard = (page) => run(code('Guard'), { input: [page], refs: { Validate: [v] } })[0].json;

  test('allows only Awaiting Approval', () => {
    assert.deepEqual(guard(pg('Awaiting Approval')), { can_decide: true, error: '' });
  });
  test('every other status is blocked (no re-deciding, no Sent)', () => {
    for (const s of ['Approved', 'Rejected', 'Sent', null, 'awaiting approval', 'Awaiting Approval ', '']) {
      const r = guard(pg(s));
      assert.equal(r.can_decide, false, String(s));
      assert.match(r.error, /not Awaiting Approval/);
    }
  });
  test('missing page, id mismatch, wrong database are blocked', () => {
    assert.equal(guard({}).can_decide, false);
    assert.equal(guard({ object: 'error', message: 'nope' }).can_decide, false);
    assert.equal(guard(pg('Awaiting Approval', { id: 'f'.repeat(32) })).can_decide, false);
    assert.equal(guard(pg('Awaiting Approval', { parent: null })).can_decide, false);
    assert.equal(guard(pg('Awaiting Approval', { parent: { database_id: 'f'.repeat(32) } })).can_decide, false);
    assert.equal(guard({ id: ID, parent: { database_id: DB } }).can_decide, false); // no Status
  });
  test('hyphenless and dashed page ids both match', () => {
    assert.equal(guard(pg('Awaiting Approval', { id: ID })).can_decide, true);
  });
});

describe('Workflow design', () => {
  test('POST webhook at the contract path, specific origin placeholder, never *', () => {
    const w = node('Decide Webhook');
    assert.equal(w.type, 'n8n-nodes-base.webhook');
    assert.equal(w.typeVersion, 2);
    assert.equal(w.parameters.httpMethod, 'POST');
    assert.equal(w.parameters.path, 'jarvis/approvals/decide');
    assert.equal(w.parameters.responseMode, 'responseNode');
    assert.notEqual(w.parameters.options.allowedOrigins, '*');
    assert.equal(w.parameters.options.allowedOrigins, 'https://REPLACE_WITH_DASHBOARD_ORIGIN');
  });
  test('Notion nodes are v2.2, get uses simple:false, update only sets decision fields', () => {
    for (const n of wf.nodes.filter((x) => x.type.endsWith('.notion'))) assert.equal(n.typeVersion, 2.2);
    assert.equal(node('Notion Get Approval').parameters.simple, false);
    const keys = node('Notion Decide').parameters.propertiesUi.propertyValues.map((p) => p.key);
    assert.deepEqual(keys, ['Status|select', 'Decided By|select', 'Decided At|date']);
    const st = node('Notion Decide').parameters.propertiesUi.propertyValues[0].selectValue;
    assert.ok(!/Sent/.test(st) && st.includes('new_status'));
  });
  test('never sets Sent anywhere', () => {
    assert.ok(!JSON.stringify(wf.nodes.filter((n) => n.type.endsWith('.notion')).map((n) => n.parameters)).includes('"Sent"'));
  });
  test('wiring: invalid -> 400, guard fail -> 409, success -> update -> log -> respond', () => {
    const c = wf.connections;
    assert.equal(c['Input valid?'].main[1][0].node, 'Respond Bad Input');
    assert.equal(c['Can decide?'].main[0][0].node, 'Notion Decide');
    assert.equal(c['Can decide?'].main[1][0].node, 'Respond Conflict');
    assert.equal(c['Notion Decide'].main[0][0].node, 'Log to Agent Activity');
    assert.equal(c['Log to Agent Activity'].main[0][0].node, 'Respond Decided');
    assert.equal(node('Respond Bad Input').parameters.options.responseCode, 400);
    assert.equal(node('Respond Conflict').parameters.options.responseCode, 409);
    assert.match(node('Respond Decided').parameters.responseBody, /ok: true.*id:.*status:/);
  });
  test('log row uses an existing Agent option and no draft content', () => {
    const vals = node('Log to Agent Activity').parameters.propertiesUi.propertyValues;
    const get = (k) => vals.find((p) => p.key === k);
    assert.equal(get('Agent|select').selectValue, 'Conductor');
    assert.equal(get('Status|select').selectValue, 'Done');
    assert.equal(get('Task|title').title, 'Approval decided');
    assert.ok(!/draft/i.test(get('Output Notes|rich_text').text));
  });
  test('no credentials or secrets committed', () => {
    for (const n of wf.nodes.filter((x) => x.credentials)) {
      assert.equal(n.credentials.notionApi.id, '');
    }
    const s = JSON.stringify(wf);
    assert.ok(!/sk-ant-|secret_|ntn_/.test(s));
    assert.ok(!/"allowedOrigins":"\*"/.test(s));
  });
});
