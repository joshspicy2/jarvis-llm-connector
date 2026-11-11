'use strict';
// Parity: n8n Estimator 'Calculate Estimate' Code node vs estimator/estimate.py,
// and QA workflow 'QA Checks' node vs everything the Estimator emits.
// The workflow JSON is read at test time; no workflow code is copied here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const load = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'dashboard/n8n', f), 'utf8'));
const code = (wf, name) => {
  const n = wf.nodes.find(x => x.name === name);
  assert.ok(n && n.parameters.jsCode, 'node not found: ' + name);
  return n.parameters.jsCode;
};
const EST = load('estimator-workflow.json');
const QA = load('qa-workflow.json');
const VALIDATE_JS = code(EST, 'Validate Request');
const CALC_JS = code(EST, 'Calculate Estimate');
const QA_JS = code(QA, 'QA Checks');
const CHUNK_JS = code(EST, 'Chunk Draft');

// ---- mocked n8n runtime -------------------------------------------------
function runNode(js, nodes, inputItems) {
  const $ = name => {
    if (!(name in nodes)) throw new Error('unmocked node reference: ' + name);
    const items = nodes[name];
    return { first: () => items[0], all: () => items, last: () => items[items.length - 1] };
  };
  const $input = { all: () => inputItems || [], first: () => (inputItems || [])[0] };
  return new Function('$', '$input', js)($, $input);
}

// ---- fixtures -----------------------------------------------------------
const rt = s => [{ plain_text: s }];
let idCounter = 0;
const uuid = () => {
  idCounter++;
  const h = idCounter.toString(16).padStart(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
function notionRule(r) {
  return {
    id: r.id || (r.id = uuid()),
    properties: {
      Service: { title: rt(r.service) },
      Category: { select: r.category === null ? null : { name: r.category } },
      'Base Rate': { number: r.base_rate },
      Unit: { select: r.unit === null ? null : { name: r.unit } },
      'Minimum Charge': { number: r.minimum_charge },
      Active: { checkbox: r.active },
      Notes: { rich_text: r.notes ? rt(r.notes) : [] },
    },
  };
}
const pyRule = r => ({ service: r.service, category: r.category, base_rate: r.base_rate,
  unit: r.unit, minimum_charge: r.minimum_charge, active: r.active, notes: r.notes || '' });

function runJs(rules, body) {
  const validated = runNode(VALIDATE_JS, { 'Estimate Webhook': [{ json: { body } }] });
  const v = validated[0].json;
  if (!v.valid) return { invalid: v.error };
  const out = runNode(CALC_JS, { 'Validate Request': validated },
    rules.map(r => ({ json: notionRule(r) })));
  return { v, out: out[0].json };
}

const PY = `
import json, sys
sys.path.insert(0, sys.argv[1])
from estimator.estimate import calculate_estimate
cases = json.load(sys.stdin)
print(json.dumps([calculate_estimate(c["rules"], c["items"]) for c in cases]))
`;
function runPy(cases) {
  const r = spawnSync('python3', ['-I', '-c', PY, ROOT], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// ---- compare ------------------------------------------------------------
const ADDON_ONLY_MSG = 'Add-On requested with no main Interior/Exterior service.';
// Intentional JS extension (not in estimate.py): add-on-only => extra missing entry, total null.
function expected(py) {
  const addonOnly = py.lines.length > 0 && py.minimum_charge === null && py.missing.length === 0 && py.__addonOnly;
  return addonOnly;
}
// Cosmetic: python repr() vs JSON.stringify in messages ('x' vs "x", True vs true, None vs null).
const norm = m => m.replace(/"/g, "'").replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
function compare(label, rules, pyRes, js, addonOnly) {
  const e = js.out.estimate;
  const ctx = label + '\nPY=' + JSON.stringify(pyRes) + '\nJS=' + JSON.stringify(e);
  assert.deepEqual(e.lines.map(l => [l.service, l.unit, l.quantity, l.rate, l.amount]),
    pyRes.lines.map(l => [l.service, l.unit, l.quantity, l.rate, l.amount]), 'lines ' + ctx);
  assert.equal(e.subtotal, pyRes.subtotal, 'subtotal ' + ctx);
  assert.equal(e.minimum_applied, pyRes.minimum_applied, 'minimum_applied ' + ctx);
  assert.equal(e.minimum_charge, pyRes.minimum_charge, 'minimum_charge ' + ctx);
  assert.deepEqual(e.warnings.map(norm), pyRes.warnings.map(norm), 'warnings ' + ctx);
  if (addonOnly) {
    assert.deepEqual(e.missing.map(norm), pyRes.missing.concat([ADDON_ONLY_MSG]).map(norm), 'missing(addon-only) ' + ctx);
    assert.equal(e.total, null, 'total(addon-only) ' + ctx);
  } else {
    assert.deepEqual(e.missing.map(norm), pyRes.missing.map(norm), 'missing ' + ctx);
    assert.equal(e.total, pyRes.total, 'total ' + ctx);
  }
}
const isAddonOnly = (rules, pyRes) => {
  if (!pyRes.lines.length || pyRes.missing.length) return false; // only the sole-extra-message case matters for total
  const byKey = new Map(rules.filter(r => r.active).map(r => [r.service.trim().toLowerCase(), r]));
  const cats = pyRes.lines.map(l => (byKey.get(l.service.trim().toLowerCase()) || {}).category);
  return cats.every(c => c === 'Add-On');
};
// addon-only with other missing items: JS still appends the message, python doesn't.
function addonOnlyAny(rules, pyRes) {
  if (!pyRes.lines.length) return false;
  const byKey = new Map(rules.filter(r => r.active).map(r => [r.service.trim().toLowerCase(), r]));
  const cats = pyRes.lines.map(l => (byKey.get(l.service.trim().toLowerCase()) || {}).category);
  return cats.every(c => c === 'Add-On') && Number(pyRes.subtotal) > 0;
}

// ---- seeded generator ---------------------------------------------------
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SERVICES = [
  ['Interior Painting', 'Interior', 'Per Sqft'], ['Exterior Painting', 'Exterior', 'Per Sqft'],
  ['Room Repaint', 'Interior', 'Per Room'], ['Cabinet Refinish', 'Interior', 'Flat Rate'],
  ['Deck Staining', 'Exterior', 'Per Hour'], ['Trim Work', 'Add-On', 'Per Hour'],
  ['Drywall Repair', 'Add-On', 'Flat Rate'], ['Power Wash', 'Add-On', 'Per Sqft'],
  ['Ceiling Paint', 'Add-On', 'Per Room'],
];
const RATES = [0.5, 0.75, 1.25, 1.5, 2, 2.35, 3.33, 7.5, 12.5, 45, 65.99, 120, 0, 0.01, 99.99];
const MINS = [null, null, 0, 100, 250, 300.5, 500, 1000];
const QTYS = [1, 2, 3, 10, 12.5, 100, 250, 0.005, 0.015, 1.005, 2.675, 33.335, 10.125, 0.1, 0.333, 1500.5, 0, '12', '7.5', 4.005, 1e-7];
const BAD_QTY = [undefined, null, null, -1, 'abc', '', true, {}, [], 'NaN'];

function genCase(rand, i) {
  const pick = a => a[Math.floor(rand() * a.length)];
  const rules = [];
  for (const [service, category, unit] of SERVICES) {
    if (rand() < 0.2) continue; // absent
    const r = {
      service: rand() < 0.1 ? '  ' + service.toUpperCase() + ' ' : service,
      category, unit,
      base_rate: rand() < 0.08 ? null : pick(RATES),
      minimum_charge: pick(MINS),
      active: rand() > 0.15,
      notes: rand() < 0.2 ? 'Applies to ' + service + ' only' : '',
    };
    if (rand() < 0.04) r.unit = null;
    rules.push(r);
    if (rand() < 0.1) rules.push({ ...r, base_rate: pick(RATES), active: rand() < 0.6 }); // dup / inactive twin
  }
  const n = 1 + Math.floor(rand() * 5);
  const items = [];
  for (let k = 0; k < n; k++) {
    let service = rand() < 0.1 ? 'Unknown Service ' + k : pick(SERVICES)[0];
    if (rand() < 0.15) service = service.toLowerCase().replace(' ', '   ');
    const it = { service };
    const q = rand() < 0.15 ? pick(BAD_QTY) : pick(QTYS);
    if (q !== undefined) it.quantity = q;
    items.push(it);
  }
  return { rules, body: { job_name: 'Job ' + i, notes: rand() < 0.3 ? 'n' + i : '', items } };
}

function collect(seed, count) {
  const rand = rng(seed);
  return Array.from({ length: count }, (_, i) => genCase(rand, i));
}

// ---- tests --------------------------------------------------------------
test('Estimator JS matches estimate.py on 250 seeded random cases', () => {
  const cases = collect(20240601, 250);
  const jsRes = cases.map(c => runJs(c.rules, c.body));
  const valid = cases.map((c, i) => ({ c, j: jsRes[i] })).filter(x => !x.j.invalid);
  assert.ok(valid.length > 200);
  const pyRes = runPy(valid.map(x => ({ rules: x.c.rules.map(pyRule), items: x.j.v.items })));
  valid.forEach((x, i) => compare('seed case ' + JSON.stringify({ rules: x.c.rules, items: x.j.v.items }),
    x.c.rules, pyRes[i], x.j, addonOnlyAny(x.c.rules, pyRes[i])));
  // coverage sanity
  const flags = pyRes.reduce((a, r) => { a.min += r.minimum_applied; a.miss += r.missing.length > 0; a.ok += r.total !== null; a.warn += r.warnings.length > 0; return a; }, { min: 0, miss: 0, ok: 0, warn: 0 });
  assert.ok(flags.min > 5 && flags.miss > 20 && flags.ok > 20 && flags.warn > 5, JSON.stringify(flags));
});

const R = (service, category, unit, base_rate, minimum_charge = null, active = true, notes = '') =>
  ({ service, category, unit, base_rate, minimum_charge, active, notes });
const EDGE = [
  ['minimum applied', [R('Int', 'Interior', 'Per Sqft', 1, 500)], [{ service: 'Int', quantity: 100 }]],
  ['minimum not applied (equal)', [R('Int', 'Interior', 'Per Sqft', 5, 500)], [{ service: 'Int', quantity: 100 }]],
  ['half-up .005 line', [R('Int', 'Interior', 'Per Sqft', 1.01, null)], [{ service: 'Int', quantity: 0.5 }]],
  ['half-up .015 qty', [R('Int', 'Interior', 'Per Sqft', 1, null)], [{ service: 'Int', quantity: 1.015 }]],
  ['half-up 2.675', [R('Int', 'Interior', 'Per Sqft', 1, null)], [{ service: 'Int', quantity: 2.675 }]],
  ['flat rate ignores qty', [R('F', 'Exterior', 'Flat Rate', 99.5, 50)], [{ service: 'F', quantity: 7 }]],
  ['flat rate no qty', [R('F', 'Exterior', 'Flat Rate', 99.5, 50)], [{ service: 'F' }]],
  ['addon excluded from minimum', [R('Int', 'Interior', 'Flat Rate', 10, 100), R('Ad', 'Add-On', 'Flat Rate', 25, 999)], [{ service: 'Int' }, { service: 'Ad' }]],
  ['highest minimum wins', [R('A', 'Interior', 'Flat Rate', 10, 100), R('B', 'Exterior', 'Flat Rate', 10, 300)], [{ service: 'A' }, { service: 'B' }]],
  ['addon only', [R('Ad', 'Add-On', 'Flat Rate', 25)], [{ service: 'Ad' }]],
  ['null rate', [R('Int', 'Interior', 'Per Sqft', null, 100)], [{ service: 'Int', quantity: 5 }]],
  ['inactive only', [R('Int', 'Interior', 'Per Sqft', 2, 100, false)], [{ service: 'Int', quantity: 5 }]],
  ['duplicate active', [R('Int', 'Interior', 'Per Sqft', 2), R('int', 'Interior', 'Per Sqft', 3)], [{ service: 'Int', quantity: 5 }]],
  ['missing qty', [R('Int', 'Interior', 'Per Room', 2)], [{ service: 'Int' }, { service: 'Nope', quantity: 1 }]],
  ['zero rate and qty', [R('Int', 'Interior', 'Per Hour', 0, null)], [{ service: 'Int', quantity: 0 }]],
  ['string qty', [R('Int', 'Interior', 'Per Hour', 3.5)], [{ service: 'Int', quantity: '2.50' }]],
  ['negative qty', [R('Int', 'Interior', 'Per Hour', 3.5)], [{ service: 'Int', quantity: -2 }]],
  ['unit case/space', [R('Int', 'Interior', ' per sqft ', 3.5)], [{ service: 'Int', quantity: 2 }]],
  ['unknown category', [R('Int', 'Weird', 'Per Sqft', 3.5)], [{ service: 'Int', quantity: 2 }]],
  ['null category', [R('Int', null, 'Per Sqft', 3.5)], [{ service: 'Int', quantity: 2 }]],
  ['huge qty', [R('Int', 'Interior', 'Per Sqft', 99.99)], [{ service: 'Int', quantity: 123456789.123 }]],
  ['same service twice', [R('Int', 'Interior', 'Per Sqft', 2, 50)], [{ service: 'Int', quantity: 3 }, { service: 'int', quantity: 4 }]],
  ['minimum on addon ignored', [R('Ad', 'Add-On', 'Per Hour', 2, 500), R('Int', 'Interior', 'Per Hour', 2, null)], [{ service: 'Ad', quantity: 1 }, { service: 'Int', quantity: 1 }]],
];
test('hand-written edge cases match estimate.py', () => {
  const js = EDGE.map(([, rules, items]) => runJs(rules, { job_name: 'E', items }));
  const valid = EDGE.map((e, i) => i).filter(i => !js[i].invalid);
  const py = runPy(valid.map(i => ({ rules: EDGE[i][1].map(pyRule), items: js[i].v.items })));
  valid.forEach((i, k) => compare('edge "' + EDGE[i][0] + '"', EDGE[i][1], py[k], js[i], addonOnlyAny(EDGE[i][1], py[k])));
});

test('Validate Request rejects bad bodies', () => {
  for (const body of [null, [], {}, { items: [] }, { items: [{}] }, { items: [{ service: '  ' }] }, { items: ['x'] }])
    assert.ok(runJs([], body).invalid, JSON.stringify(body));
});

test('INTENTIONAL JS-only rule: add-on only request is flagged missing with null total', () => {
  const r = runJs([R('Ad', 'Add-On', 'Flat Rate', 25)], { items: [{ service: 'Ad' }] });
  assert.equal(r.out.estimate.total, null);
  assert.ok(r.out.missing.includes(ADDON_ONLY_MSG));
});

// ---- QA parity ----------------------------------------------------------
// Estimator output -> what Create Approval writes to Notion (Chunk Draft node), as Notion returns it (plain_text).
function approvalDraft(j) {
  const body = runNode(CHUNK_JS, { 'Validate Request': [{ json: j.v }], 'Calculate Estimate': [{ json: j.out }] })[0].json.notionBody;
  const items = body.properties.Draft.rich_text;
  items.forEach(t => assert.ok(t.text.content.length <= 2000, 'rich_text item over 2000 chars'));
  return items.map(t => ({ plain_text: t.text.content }));
}
function runQA(rules, draft, type = 'Estimate', approvalId = 'abcd1234-0000-0000-0000-000000000001') {
  const approval = { id: approvalId, properties: {
    Type: { select: { name: type } }, Draft: { rich_text: typeof draft === 'string' ? rt(draft) : draft },
    Title: { title: rt('Estimate: Job') }, 'Related Job': { rich_text: rt('Job') } } };
  const out = runNode(QA_JS, { 'Notion Get Approval': [{ json: approval }],
    'Notion Estimate Rules': rules.map(r => ({ json: notionRule(r) })) });
  return out[0].json;
}
// Rules must keep the SAME ids that the Estimator saw; notionRule memoizes r.id.

test('QA Checks PASSes every drafted/needs_info Estimator output over 250 seeded cases', () => {
  const cases = collect(777, 250);
  let draftCount = 0, needsCount = 0;
  for (const c of cases) {
    const j = runJs(c.rules, c.body);
    if (j.invalid) continue;
    const qa = runQA(c.rules, approvalDraft(j));
    j.out.estimate.total === null ? needsCount++ : draftCount++;
    const other = qa.failures;
    assert.deepEqual(other, [], JSON.stringify({ failures: qa.failures, rules: c.rules, items: j.v.items, draft: j.out.draft }));
  }
  assert.ok(draftCount > 20 && needsCount > 20, `${draftCount}/${needsCount}`);
});

test('QA Checks PASSes every hand-written edge case draft', () => {
  EDGE.forEach(([name, rules, items]) => {
    const j = runJs(rules, { job_name: 'E', items });
    if (j.invalid) return;
    const qa = runQA(rules, approvalDraft(j));
    const other = qa.failures;
    assert.deepEqual(other, [], name + ' ' + JSON.stringify({ f: qa.failures, d: j.out.draft }));
  });
});

test('QA Checks PASSes a draft whose JSON is long (chunked into several rich_text items)', () => {
  const rules = Array.from({ length: 4 }, (_, i) => R('Service number ' + i, i % 3 === 0 ? 'Add-On' : 'Interior', 'Per Sqft', 1.25 + i, i % 3 === 0 ? null : 10, true, 'note ' + i));
  rules.push(R('Main', 'Exterior', 'Flat Rate', 400));
  const items = rules.map(r => ({ service: r.service, quantity: 37.5 }));
  const j = runJs(rules, { job_name: 'Long', items, notes: 'x'.repeat(1500) });
  assert.ok(approvalDraft(j).length >= 2, 'expected chunked draft');
  assert.equal(runQA(rules, approvalDraft(j)).result, 'Pass', JSON.stringify(runQA(rules, approvalDraft(j)).failures));
});

// ---- tamper tests -------------------------------------------------------
const BASE_RULES = () => [
  R('Interior Painting', 'Interior', 'Per Sqft', 2.5, 500, true, 'Two coats'),
  R('Trim Work', 'Add-On', 'Per Hour', 40),
];
function baseDraft(rules) {
  const j = runJs(rules, { job_name: 'T', items: [{ service: 'Interior Painting', quantity: 1000 }, { service: 'Trim Work', quantity: 3 }] });
  const d = j.out.draft;
  const i = d.indexOf('[estimate-json]');
  return { head: d.slice(0, i + '[estimate-json]'.length), json: JSON.parse(d.slice(i + '[estimate-json]'.length)) };
}
test('untampered baseline passes', () => {
  const rules = BASE_RULES(); const b = baseDraft(rules);
  assert.equal(b.json.total, 2620);
  assert.equal(runQA(rules, b.head + '\n' + JSON.stringify(b.json)).result, 'Pass');
});
const TAMPERS = {
  'total changed': d => { d.total = 2000; },
  'total off by a cent': d => { d.total += 0.01; },
  'subtotal changed': d => { d.subtotal = 1; },
  'line_total changed': d => { d.line_items[0].line_total = 1; },
  'computed changed': d => { d.line_items[0].computed = 2499.99; },
  'base_rate changed': d => { d.line_items[0].base_rate = 2.4; },
  'unit changed': d => { d.line_items[0].unit = 'Per Room'; },
  'category changed': d => { d.line_items[0].category = 'Add-On'; },
  'service renamed': d => { d.line_items[0].service = 'Other'; },
  'fake rule_id': d => { d.line_items[0].rule_id = 'deadbeef-0000-0000-0000-000000000000'; },
  'quantity negative': d => { d.line_items[0].quantity = -1; },
  'quantity as string': d => { d.line_items[0].quantity = '1000'; },
  'minimum_charge wrong': d => { d.line_items[0].minimum_charge = 1; },
  'minimum_applied flipped': d => { d.line_items[0].minimum_applied = true; },
  'needs_human false': d => { d.needs_human = false; },
  'rule_notes dropped': d => { d.rule_notes = []; },
  'bad status': d => { d.status = 'sent'; },
  'draft with missing_fields': d => { d.missing_fields = ['x']; },
  'needs_info with total': d => { d.status = 'needs_info'; d.missing_fields = ['x']; },
  'line_items removed field': d => { delete d.line_items[1].quantity; },
  'unrounded value': d => { d.line_items[1].computed = 120.004; },
  'secret leaked': d => { d.assumptions = ['api key sk-abcdefghij123456']; },
  'addon w/o main': d => { d.line_items = [d.line_items[1]]; d.subtotal = 120; d.total = 120; },
};
for (const [name, fn] of Object.entries(TAMPERS)) {
  test('tamper FAILS: ' + name, () => {
    const rules = BASE_RULES(); const b = baseDraft(rules);
    const d = JSON.parse(JSON.stringify(b.json)); fn(d);
    const qa = runQA(rules, b.head + '\n' + JSON.stringify(d));
    assert.equal(qa.result, 'Fail', 'expected Fail; failures=' + JSON.stringify(qa.failures));
  });
}
test('tamper FAILS: rule deactivated after drafting', () => {
  const rules = BASE_RULES(); const b = baseDraft(rules); rules[0].active = false;
  assert.equal(runQA(rules, b.head + JSON.stringify(b.json)).result, 'Fail');
});
test('tamper FAILS: rule rate changed after drafting', () => {
  const rules = BASE_RULES(); const b = baseDraft(rules); rules[0].base_rate = 3;
  assert.equal(runQA(rules, b.head + JSON.stringify(b.json)).result, 'Fail');
});
test('tamper FAILS: duplicate active rule appears after drafting', () => {
  const rules = BASE_RULES(); const b = baseDraft(rules); rules.push(R('interior painting', 'Interior', 'Per Sqft', 9));
  assert.equal(runQA(rules, b.head + JSON.stringify(b.json)).result, 'Fail');
});
test('tamper FAILS: empty draft, garbage draft, bad type', () => {
  const rules = BASE_RULES();
  assert.equal(runQA(rules, '').result, 'Fail');
  assert.equal(runQA(rules, 'not json at all').result, 'Fail');
  assert.equal(runQA(rules, '{}', 'Bogus').result, 'Fail');
});

// ---- formerly divergent behaviours (fixed: one minimum-charge model, Estimator and QA agree) ----
// Minimum applies once to the combined Interior/Exterior subtotal (estimate.py); line_total == computed per line.
test('QA passes Estimator draft for Add-On rule that has a Minimum Charge (Add-On expects 0)', () => {
  const rules = [R('Int', 'Interior', 'Flat Rate', 10, 100), R('Ad', 'Add-On', 'Flat Rate', 25, 999)];
  const j = runJs(rules, { job_name: 'E', items: [{ service: 'Int' }, { service: 'Ad' }] });
  const qa = runQA(rules, approvalDraft(j));
  assert.equal(qa.result, 'Pass', JSON.stringify(qa.failures));
});
test('QA passes Estimator needs_info draft for add-on-only request', () => {
  const rules = [R('Ad', 'Add-On', 'Flat Rate', 25)];
  const j = runJs(rules, { job_name: 'E', items: [{ service: 'Ad' }] });
  assert.equal(j.out.estimate.total, null);
  const qa = runQA(rules, approvalDraft(j));
  assert.equal(qa.result, 'Pass', JSON.stringify(qa.failures));
});
test('QA passes estimate with two primary lines with different minimums (minimum at estimate level)', () => {
  const rules = [R('A', 'Interior', 'Flat Rate', 10, 100), R('B', 'Exterior', 'Flat Rate', 10, 300)];
  const j = runJs(rules, { job_name: 'E', items: [{ service: 'A' }, { service: 'B' }] });
  assert.equal(j.out.estimate.total, '300.00'); // matches estimate.py
  const d = JSON.parse(j.out.draft.slice(j.out.draft.indexOf('[estimate-json]') + '[estimate-json]'.length));
  assert.deepEqual(d.line_items.map(l => l.line_total), [10, 10]);
  assert.equal(d.minimum_applied, true);
  assert.equal(d.minimum_adjustment, 280);
  const qa = runQA(rules, approvalDraft(j));
  assert.equal(qa.result, 'Pass', JSON.stringify(qa.failures));
});
test('review H2: Car A (50, min 100) + Car B (flat 300) is consistent and passes QA', () => {
  const rules = [R('Car A', 'Interior', 'Per Sqft', 50, 100), R('Car B', 'Exterior', 'Flat Rate', 300)];
  const j = runJs(rules, { job_name: 'E', items: [{ service: 'Car A', quantity: 1 }, { service: 'Car B' }] });
  assert.equal(j.out.estimate.total, '350.00');
  const qa = runQA(rules, approvalDraft(j));
  assert.equal(qa.result, 'Pass', JSON.stringify(qa.failures));
});
test('QA fails an estimate whose total ignores the estimate-level minimum', () => {
  const rules = [R('Int', 'Interior', 'Flat Rate', 10, 100)];
  const j = runJs(rules, { job_name: 'E', items: [{ service: 'Int' }] });
  const i = j.out.draft.indexOf('[estimate-json]') + '[estimate-json]'.length;
  const d = JSON.parse(j.out.draft.slice(i)); d.total = 10; d.minimum_applied = false; d.minimum_adjustment = 0;
  assert.equal(runQA(rules, j.out.draft.slice(0, i) + JSON.stringify(d)).result, 'Fail');
});
test('large request: chunked draft round-trips exactly and QA passes', () => {
  const rules = Array.from({ length: 30 }, (_, i) => R('Service number ' + i, i % 5 === 0 ? 'Add-On' : 'Interior', 'Per Sqft', 1.25 + i, i % 5 === 0 ? null : 10, true, 'note ' + i));
  const items = rules.map(r => ({ service: r.service, quantity: 37.5 }));
  const j = runJs(rules, { job_name: 'Big \u{1F600} job', items, notes: 'y'.repeat(900) });
  const chunks = approvalDraft(j);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.map(c => c.plain_text).join(''), j.out.draft);
  const qa = runQA(rules, chunks);
  assert.deepEqual(qa.failures, []);
});
// QA money math is integer cents, half-up, identical to estimate.py/Decimal: 45 x 1.005 = 45.225 -> 45.23.
test('QA passes a half-cent tie line (45.00 x 1.005 = 45.23)', () => {
  const rules = [R('Room', 'Interior', 'Per Room', 45)];
  const j = runJs(rules, { job_name: 'E', items: [{ service: 'Room', quantity: 1.005 }] });
  assert.equal(j.out.estimate.lines[0].amount, '45.23');
  const qa = runQA(rules, approvalDraft(j));
  assert.equal(qa.result, 'Pass', JSON.stringify(qa.failures));
});
