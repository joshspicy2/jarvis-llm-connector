'use strict';
// Tests for social-publisher-workflow.json: safe-by-default FB/IG publisher, Marketer image field, Send skip, chat hook.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dir = path.join(__dirname, '..', '..', 'dashboard', 'n8n');
const wf = require(path.join(dir, 'social-publisher-workflow.json'));
const marketer = require(path.join(dir, 'marketer-workflow.json'));
const send = require(path.join(dir, 'send-workflow.json'));
const chat = require(path.join(dir, 'jarvis-dashboard-api.json'));
const node = (w, n) => w.nodes.find((x) => x.name === n);
const code = (w, n) => node(w, n).parameters.jsCode;

function run(src, { input = [], refs = {} } = {}) {
  const fn = new Function('$input', '$', '$json', src);
  const wrap = (arr) => arr.map((j) => ({ json: j }));
  const $ = (n) => {
    if (!(n in refs)) throw new Error(`Node "${n}" not mocked`);
    const items = wrap(refs[n]);
    return { all: () => items, first: () => items[0], item: items[0] };
  };
  const items = wrap(input);
  return fn({ all: () => items, first: () => items[0] }, $, {}).map((i) => i.json);
}

const title = (s) => ({ type: 'title', title: [{ plain_text: s }] });
const rt = (s) => ({ type: 'rich_text', rich_text: [{ plain_text: s }] });
const sel = (s) => ({ type: 'select', select: { name: s } });
const row = (id, o = {}) => ({
  id,
  last_edited_time: o.edited ?? '2026-01-02T09:02:00.000Z',
  properties: {
    Title: title('Post ' + id),
    Type: sel(o.type ?? 'Content'),
    Status: sel(o.status ?? 'Approved'),
    'QA Result': sel(o.qa ?? 'Pass'),
    'Decided By': o.by === null ? { type: 'select', select: null } : sel(o.by ?? 'Makenzie'),
    'Decided At': { type: 'date', date: o.at === null ? null : { start: o.at ?? '2026-01-02T09:00:00.000Z' } },
    Draft: rt(o.draft ?? 'Channel: facebook\n\nHeadline: Hello\n\nBody:\nWe clean interiors in High Springs.\n\nHashtags: #HighSprings'),
  },
});
const select = (rows, dryRun = true) => {
  let s = code(wf, 'Select social posts');
  if (!dryRun) s = s.replace('const DRY_RUN = true;', 'const DRY_RUN = false;');
  return run(s, { input: rows });
};

describe('social publisher shipped state', () => {
  test('inactive, DRY_RUN true, Graph nodes disabled, no credential ids', () => {
    assert.equal(wf.active, false);
    assert.match(code(wf, 'Select social posts'), /const DRY_RUN = true;/);
    for (const n of ['Publish Facebook', 'Create Instagram media', 'Publish Instagram media']) assert.equal(node(wf, n).disabled, true, n);
    for (const n of wf.nodes) for (const c of Object.values(n.credentials || {})) assert.equal(c.id, '');
  });
});

describe('Select social posts', () => {
  test('dry run: logs would_publish, never publish', () => {
    const out = select([row('a')]);
    assert.equal(out[0].kind, 'summary');
    assert.match(out[0].notes, /DRY RUN/);
    assert.equal(out[1].action, 'would_publish');
    assert.equal(out[1].channel, 'facebook');
    assert.match(out[1].message, /Hello\n\nWe clean interiors in High Springs\.\n\n#HighSprings/);
  });
  test('live mode publishes', () => assert.equal(select([row('a')], false)[1].action, 'publish'));
  test('skips unapproved, non-Content, QA fail, no Decided At, edited after approval, NEEDS HUMAN', () => {
    const out = select([
      row('1', { status: 'Awaiting Approval' }),
      row('2', { type: 'Reply' }),
      row('3', { qa: 'Fail', by: null }),
      row('4', { at: null }),
      row('5', { edited: '2026-01-02T12:00:00.000Z' }),
      row('6', { draft: 'Channel: facebook\n\nBody:\nx\n\nNEEDS HUMAN: missing fact' }),
    ]);
    assert.equal(out.length, 1);
    for (const r of ['QA Fail', 'Decided At', 'edited after', 'NEEDS HUMAN']) assert.match(out[0].notes, new RegExp(r));
    assert.match(out[0].notes, /status is not Approved/);
  });
  test('instagram needs image; with image it is picked', () => {
    const base = 'Channel: instagram\n\nBody:\nHi\n\n';
    assert.match(select([row('1', { draft: base })])[0].notes, /needs an Image/);
    const ok = select([row('2', { draft: base + 'Image: https://example.com/a.jpg' })]);
    assert.equal(ok[1].channel, 'instagram');
    assert.equal(ok[1].image_url, 'https://example.com/a.jpg');
  });
  test('ignores non-social Content and caps at 3', () => {
    const out = select([row('x', { draft: 'Channel: email\n\nBody:\nhi' }), ...['a', 'b', 'c', 'd'].map((i) => row(i))]);
    assert.equal(out.filter((o) => o.kind === 'post').length, 3);
  });
});

describe('Confirm publish result', () => {
  const src = { id: 'page1', title: 'T', channel: 'facebook' };
  const conf = (j, s = src, extra = {}) => run(code(wf, 'Confirm publish result'), { input: [j], refs: { 'Build Graph requests': [s], ...extra } })[0];
  test('new Graph id confirms', () => assert.equal(conf({ id: '123_456' }).confirmed, true));
  test('disabled pass-through (same item) does not confirm', () => assert.equal(conf({ ...src, kind: 'post' }).confirmed, false));
  test('error or empty does not confirm', () => {
    assert.equal(conf({ error: { message: 'bad' } }).confirmed, false);
    assert.equal(conf({}).confirmed, false);
  });
  test('instagram: create-only response is not a publish', () => {
    const ig = { id: 'page1', title: 'T', channel: 'instagram' };
    assert.equal(conf({ id: 'c1' }, ig, { 'Create Instagram media': [{ id: 'c1' }] }).confirmed, false);
    assert.equal(conf({ id: 'm9' }, ig, { 'Create Instagram media': [{ id: 'c1' }] }).confirmed, true);
  });
});

describe('Build Graph requests', () => {
  test('facebook text vs photo, instagram two-step, token never in code', () => {
    const src = code(wf, 'Build Graph requests');
    const [t, p, i] = run(src, {
      input: [
        { channel: 'facebook', message: 'm', image_url: '' },
        { channel: 'facebook', message: 'm', image_url: 'https://x/y.jpg' },
        { channel: 'instagram', message: 'm', image_url: 'https://x/y.jpg' },
      ],
    });
    assert.match(t.fb_url, /\/feed$/);
    assert.match(p.fb_url, /\/photos$/);
    assert.match(i.ig_create_url, /\/media$/);
    assert.match(i.ig_publish_url, /\/media_publish$/);
    assert.doesNotMatch(src, /access_token|EAA/);
  });
});

describe('related workflow changes', () => {
  test('Marketer accepts instagram and image_url, rejects http image', () => {
    const s = code(marketer, 'Validate request');
    const go = (body) => new Function('$input', s)({ first: () => ({ json: { body } }) })[0].json;
    assert.equal(go({ channel: 'instagram', topic: 't', image_url: 'https://x/y.jpg' }).valid, true);
    assert.equal(go({ channel: 'instagram', topic: 't', image_url: 'http://x/y.jpg' }).valid, false);
    assert.equal(go({ channel: 'facebook', topic: 't' }).valid, true);
  });
  test('Send skips social drafts', () => {
    const s = code(send, 'Select sendable');
    const r = {
      id: 'x', created_time: '2026-01-01', last_edited_time: '2026-01-01',
      properties: { Title: title('t'), Type: sel('Content'), Status: sel('Approved'), 'QA Result': sel('Pass'), Draft: rt('Channel: instagram\n\nBody:\nhi') },
    };
    const out = run(s, { input: [r] });
    assert.equal(out.filter((o) => o.kind === 'candidate').length, 0);
  });
  test('chat routes /post commands to the marketer webhook', () => {
    const cond = node(chat, 'Social draft command?').parameters.conditions.conditions[0].leftValue;
    const re = new Function('return ' + cond.replace(/^=\{\{\s*/, '').replace(/\.test\(\$json\.message\)\s*\}\}$/, ''))();
    assert.ok(re.test('/post facebook spring special') && re.test('/draft instagram hello'));
    assert.ok(!re.test('/post tiktok x') && !re.test('how are posts going'));
    assert.deepEqual(chat.connections['Chat Valid?'].main[0].map((c) => c.node), ['Social draft command?']);
    assert.deepEqual(chat.connections['Social draft command?'].main[1].map((c) => c.node), ['Notion Pipeline (chat)']);
  });
});
