'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wf = require(path.join(__dirname, '..', '..', 'dashboard', 'n8n', 'router-workflow.json'));
const node = (n) => wf.nodes.find((x) => x.name === n);
const jsCode = node('Parse and apply War Mode').parameters.jsCode;

const title = (s) => ({ type: 'title', title: [{ plain_text: s }] });
const chk = (b) => ({ type: 'checkbox', checkbox: b });
const flagRow = (name, v) => ({ properties: { Name: title(name), Value: chk(v) } });

function run(llm, { flags = [flagRow('War Mode', false)], body = {} } = {}) {
  const fn = new Function('$input', '$', '$json', jsCode);
  const refs = {
    'Notion System Flags': flags.map((json) => ({ json })),
    'Inbound Webhook': [{ json: { body } }],
  };
  const $ = (n) => {
    if (!(n in refs)) throw new Error(`Node "${n}" not mocked`);
    return { all: () => refs[n], first: () => refs[n][0] };
  };
  const out = fn({}, $, llm);
  assert.equal(out.length, 1);
  return out[0].json.routing;
}
const reply = (o) => ({ content: [{ text: JSON.stringify(o) }] });
const ok = (severity, extra = {}) => reply({ severity, owner: 'Support', reason: 'r', needs_human: true, summary: 's', ...extra });

describe('Router parse node', () => {
  test('missing War Mode row is treated as ON (design: unreadable flag = ON)', () => {
    const r = run(ok('IMPORTANT'), { flags: [] });
    assert.equal(r.war_mode, true);
  });
  test('flags node uses simple:false', () => {
    assert.equal(node('Notion System Flags').parameters.simple, false);
  });
  test('raw-properties flag parsing: War Mode ON, other rows ignored', () => {
    const r = run(ok('IMPORTANT'), { flags: [flagRow('Quiet Hours', true), flagRow('War Mode', true)] });
    assert.equal(r.war_mode, true);
    const r2 = run(ok('IMPORTANT'), { flags: [flagRow('War Mode', false), flagRow('Other', true)] });
    assert.equal(r2.war_mode, false);
  });
  test('War Mode ON demotes non-FIRE, keeps FIRE', () => {
    const flags = [flagRow('War Mode', true)];
    const a = run(ok('IMPORTANT'), { flags });
    assert.equal(a.needs_human, false);
    assert.equal(a.queued_for_brief, true);
    const f = run(ok('FIRE'), { flags });
    assert.equal(f.needs_human, true);
    assert.equal(f.queued_for_brief, false);
  });
  test('fallback on LLM failure (error body / empty)', () => {
    for (const bad of [{ error: { message: 'boom' } }, {}, { content: [] }]) {
      const r = run(bad);
      assert.equal(r.severity, 'IMPORTANT');
      assert.equal(r.owner, 'Conductor');
      assert.equal(r.needs_human, true);
      assert.equal(r.llm_failed, true);
    }
  });
  test('unparseable output falls back without llm_failed', () => {
    const r = run({ content: [{ text: 'not json' }] });
    assert.equal(r.severity, 'IMPORTANT');
    assert.equal(r.llm_failed, false);
  });
  test('activity log status is Error on failure', () => {
    const v = node('Log to Agent Activity').parameters.propertiesUi.propertyValues.find((p) => p.key === 'Status|select').selectValue;
    assert.match(v, /llm_failed \? 'Error' : 'Done'/);
  });
  test('keyword floor raises ROUTINE/AWARENESS to IMPORTANT', () => {
    for (const w of ['injury', 'Fire', 'gas', 'police', 'lawsuit', 'attorney', 'chargeback', 'refund']) {
      const r = run(ok('AWARENESS', { needs_human: false }), { body: { subject: 'hi', text: `about the ${w} thing` } });
      assert.equal(r.severity, 'IMPORTANT', w);
      assert.equal(r.needs_human, true, w);
      assert.equal(r.keyword_floor, true, w);
    }
  });
  test('keyword floor does not fire on substrings or benign text', () => {
    const r = run(ok('ROUTINE'), { body: { subject: 'Regarding', text: 'gasket and campfire-free, please book' } });
    assert.equal(r.severity, 'ROUTINE');
    assert.equal(r.keyword_floor, false);
  });
  test('keyword floor never lowers FIRE', () => {
    assert.equal(run(ok('FIRE'), { body: { text: 'refund' } }).severity, 'FIRE');
  });
});
