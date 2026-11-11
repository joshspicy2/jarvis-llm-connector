'use strict';
// Tests for send-workflow.json: safe-by-default send step.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const file = path.join(__dirname, '..', '..', 'dashboard', 'n8n', 'send-workflow.json');
const wf = require(file);
const raw = fs.readFileSync(file, 'utf8');
const node = (n) => wf.nodes.find((x) => x.name === n);
const code = (n) => node(n).parameters.jsCode;

function run(src, { input = [], refs = {} } = {}) {
  const fn = new Function('$input', '$', '$json', src);
  const wrap = (arr) => arr.map((j) => ({ json: j }));
  const $ = (n) => {
    if (!(n in refs)) throw new Error(`Node "${n}" not mocked`);
    const items = wrap(refs[n]);
    return { all: () => items, first: () => items[0] };
  };
  const items = wrap(input);
  return fn({ all: () => items, first: () => items[0] }, $, {}).map((i) => i.json);
}

const title = (s) => ({ type: 'title', title: [{ plain_text: s }] });
const rt = (s) => ({ type: 'rich_text', rich_text: [{ plain_text: s }] });
const sel = (s) => ({ type: 'select', select: s === null ? null : { name: s } });
const dt = (s) => ({ type: 'date', date: s ? { start: s } : null });
const row = (id, o = {}) => ({
  id,
  created_time: o.created ?? '2026-01-01T00:00:00.000Z',
  last_edited_time: o.edited ?? '2026-01-02T10:00:00.000Z',
  properties: {
    Title: title(o.title ?? `Row ${id}`),
    Type: sel(o.type === undefined ? 'Reply' : o.type),
    Draft: rt(o.draft ?? 'Hi there'),
    Status: sel(o.status === undefined ? 'Approved' : o.status),
    'QA Result': sel(o.qa === undefined ? 'Pass' : o.qa),
    'Decided By': sel(o.by === undefined ? 'Makenzie' : o.by),
    'Decided At': dt(o.at === undefined ? '2026-01-02T10:00:00.000Z' : o.at),
  },
});
const select = (rows) => run(code('Select sendable'), { input: rows });
const cands = (out) => out.filter((j) => j.kind === 'candidate');
const decide = (selected, fetched, srcMod) =>
  run(srcMod ? srcMod(code('Recheck and decide')) : code('Recheck and decide'), {
    input: fetched,
    refs: { 'Select sendable': selected },
  });
const toSelected = (rows) => select(rows);

describe('structure and safety', () => {
  test('schedule trigger every 10 minutes is the only trigger', () => {
    const t = wf.nodes.filter((n) => /Trigger$/.test(n.type));
    assert.equal(t.length, 1);
    assert.equal(t[0].type, 'n8n-nodes-base.scheduleTrigger');
    assert.equal(t[0].parameters.rule.interval[0].minutesInterval, 10);
    assert.ok(!wf.nodes.some((n) => n.type.endsWith('.webhook')));
  });
  test('workflow ships inactive', () => assert.equal(wf.active, false));
  test('Send (DISABLED) is a disabled NoOp with a replace-me note', () => {
    const n = node('Send (DISABLED)');
    assert.equal(n.disabled, true);
    assert.equal(n.type, 'n8n-nodes-base.noOp');
    assert.match(n.notes, /Joshua must replace/);
    assert.ok(!n.credentials);
    assert.deepEqual(n.parameters, {});
  });
  test('no real email/SMS/HTTP send nodes and no credentials ids anywhere', () => {
    for (const n of wf.nodes) {
      assert.doesNotMatch(n.type, /emailSend|gmail|twilio|httpRequest|slack|sendGrid|smtp/i, n.name);
      for (const c of Object.values(n.credentials || {})) {
        assert.equal(c.id, '');
        assert.match(c.name, /^Select your .* credential$/);
      }
    }
    assert.doesNotMatch(raw, /sk-ant-|secret_|ntn_|Bearer /);
  });
  test('Notion reads use simple:false and filter Status = Approved', () => {
    const g = node('Notion Approved rows').parameters;
    assert.equal(g.simple, false);
    assert.equal(g.operation, 'getAll');
    assert.deepEqual(g.filters.conditions[0], { key: 'Status|select', condition: 'equals', selectValue: 'Approved' });
    assert.equal(node('Re-fetch page').parameters.simple, false);
  });
  test('only Sent write is behind Send? -> Send -> Confirm -> Confirmed?', () => {
    const sentWriters = wf.nodes.filter((n) => JSON.stringify(n.parameters).includes('"selectValue":"Sent"'));
    assert.deepEqual(sentWriters.map((n) => n.name), ['Mark Sent']);
    const into = (name) => Object.entries(wf.connections).filter(([, c]) => c.main.flat().some((x) => x.node === name)).map(([k]) => k);
    assert.deepEqual(into('Mark Sent'), ['Confirmed?']);
    assert.deepEqual(into('Confirmed?'), ['Confirm send result']);
    assert.deepEqual(into('Confirm send result'), ['Send (DISABLED)']);
    assert.deepEqual(into('Send (DISABLED)'), ['Send?']);
  });
  test('activity log uses existing Agent option and only Done/Error statuses', () => {
    const p = node('Log to Agent Activity').parameters.propertiesUi.propertyValues;
    assert.equal(p.find((x) => x.key === 'Agent|select').selectValue, 'Conductor');
    assert.equal(node('Log Sent').parameters.propertiesUi.propertyValues.find((x) => x.key === 'Agent|select').selectValue, 'Conductor');
  });
  test('DRY_RUN defaults to true', () => {
    assert.match(code('Recheck and decide'), /^const DRY_RUN = true;$/m);
    assert.equal(node('Recheck and decide').parameters.jsCode.includes('DRY_RUN = false'), false);
  });
});

describe('Select sendable', () => {
  test('selects a valid Approved row', () => {
    const out = select([row('a')]);
    assert.equal(cands(out).length, 1);
    assert.equal(cands(out)[0].id, 'a');
  });
  test('skips non-Approved statuses (nothing selected when Status is not Approved)', () => {
    for (const s of ['Awaiting Approval', 'Rejected', 'Sent', 'approved', null]) {
      const out = select([row('x', { status: s })]);
      assert.equal(cands(out).length, 0, String(s));
      assert.equal(out[0].summary.skipped.length, 1);
    }
  });
  test('QA Fail skipped unless Decided By present', () => {
    assert.equal(cands(select([row('a', { qa: 'Fail', by: null })])).length, 0);
    assert.equal(cands(select([row('a', { qa: 'Fail', by: 'Makenzie' })])).length, 1);
    assert.equal(cands(select([row('a', { qa: 'Not checked', by: null })])).length, 1);
  });
  test('Type whitelist', () => {
    for (const t of ['Estimate', 'Reply', 'Content']) assert.equal(cands(select([row('a', { type: t })])).length, 1);
    for (const t of ['Invoice', 'Other', null]) assert.equal(cands(select([row('a', { type: t })])).length, 0);
  });
  test('empty or whitespace Draft skipped', () => {
    assert.equal(cands(select([row('a', { draft: '' })])).length, 0);
    assert.equal(cands(select([row('a', { draft: '   ' })])).length, 0);
  });
  test('cap of 5 per run, oldest decision first', () => {
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push(row('r' + i, { at: `2026-01-02T10:0${7 - i}:00.000Z` }));
    const out = select(rows);
    assert.equal(cands(out).length, 5);
    assert.deepEqual(cands(out).map((c) => c.id), ['r7', 'r6', 'r5', 'r4', 'r3']);
    assert.equal(out[0].summary.deferred, 3);
  });
  test('empty input yields only a summary', () => {
    const out = run(code('Select sendable'), { input: [{}] });
    assert.equal(cands(out).length, 0);
    assert.equal(out[0].summary.seen, 0);
  });
});

describe('Recheck and decide', () => {
  const sel1 = toSelected([row('a')]);
  test('unedited approved row is only would_send under default DRY_RUN', () => {
    const out = decide(sel1, [row('a')]);
    assert.equal(out[0].decision, 'would_send');
    assert.equal(out[0].dry_run, true);
    assert.ok(!out.some((o) => o.decision === 'send'));
  });
  test('with DRY_RUN false an unedited approved row becomes send', () => {
    const out = decide(sel1, [row('a')], (s) => s.replace('const DRY_RUN = true;', 'const DRY_RUN = false;'));
    assert.equal(out[0].decision, 'send');
    assert.equal(out[0].dry_run, false);
  });
  test('Status changed after selection is skipped, never reset or sent', () => {
    for (const s of ['Rejected', 'Sent', 'Awaiting Approval']) {
      const out = decide(sel1, [row('a', { status: s })], (c) => c.replace('const DRY_RUN = true;', 'const DRY_RUN = false;'));
      assert.equal(out[0].decision, 'skip', s);
    }
  });
  test('edited after Decided At is reset, not sent (even with DRY_RUN false)', () => {
    const edited = row('a', { edited: '2026-01-02T11:00:00.000Z' });
    for (const mod of [undefined, (c) => c.replace('const DRY_RUN = true;', 'const DRY_RUN = false;')]) {
      const out = decide(sel1, [edited], mod);
      assert.equal(out[0].decision, 'reset');
    }
  });
  test('edit within the 5 minute grace is not an edit', () => {
    assert.equal(decide(sel1, [row('a', { edited: '2026-01-02T10:04:00.000Z' })])[0].decision, 'would_send');
  });
  test('Draft text changed since selection is reset', () => {
    assert.equal(decide(sel1, [row('a', { draft: 'Changed' })])[0].decision, 'reset');
  });
  test('missing Decided At cannot be verified so is skipped', () => {
    const s = toSelected([row('a', { at: null })]);
    assert.equal(decide(s, [row('a', { at: null })])[0].decision, 'skip');
  });
  test('date-only Decided At counts to end of that day', () => {
    const s = toSelected([row('a', { at: '2026-01-02' })]);
    assert.equal(decide(s, [row('a', { at: '2026-01-02' })])[0].decision, 'would_send');
  });
  test('rows not selected earlier are ignored', () => {
    assert.equal(decide(sel1, [row('zzz')]).length, 0);
  });
});

describe('Confirm, logging', () => {
  test('only send_ok === true with live decision is confirmed', () => {
    const base = { id: 'a', title: 't' };
    const out = run(code('Confirm send result'), { input: [
      { ...base, decision: 'send', dry_run: false },
      { ...base, decision: 'send', dry_run: false, send_ok: true },
      { ...base, decision: 'send', dry_run: false, send_ok: 'true' },
      { ...base, decision: 'would_send', dry_run: true, send_ok: true },
      { ...base, decision: 'send', dry_run: true, send_ok: true },
    ] });
    assert.deepEqual(out.map((o) => o.confirmed), [false, true, false, false, false]);
  });
  test('outcome log reports dry run and counts', () => {
    const [l] = run(code('Build outcome log'), { input: [
      { id: 'a', title: 'A', decision: 'would_send', dry_run: true },
      { id: 'b', title: 'B', decision: 'reset', dry_run: true, reason: 'edited' },
    ] });
    assert.match(l.notes, /DRY_RUN=true/);
    assert.match(l.notes, /would_send=1/);
    assert.match(l.notes, /reset=1/);
    assert.equal(l.status, 'Done');
    assert.ok(l.notes.length <= 1900);
  });
  test('selection log summarises skipped rows', () => {
    const summary = select([row('a'), row('b', { status: 'Rejected' })])[0];
    const [l] = run(code('Build selection log'), { refs: { 'Select sendable': [summary] } });
    assert.match(l.notes, /seen=2 eligible=1 picked=1/);
    assert.match(l.notes, /skipped=1/);
  });
});
