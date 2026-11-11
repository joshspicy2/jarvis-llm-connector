'use strict';
// Smoke tests for dashboard/index.html. Run: node tests/dashboard/smoke.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = 8791;
const ROOT = path.resolve(__dirname, '../../dashboard');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const CORS = {
  // Credentialed fetches (Cloudflare Access cookie) need a specific origin, not '*'.
  'access-control-allow-origin': `http://127.0.0.1:${PORT}`,
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

let server, browser;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test.before(async () => {
  server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  browser = await chromium.launch();
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(r => server.close(r));
});

const FIX = {
  pipeline: { stages: [
    { name: 'Booked', cards: [{ title: 'A', sub: 's' }, { title: 'B', sub: 's' }] },
    { name: 'In Progress', cards: [{ title: 'C', sub: 's' }] },
    { name: 'Paid', cards: [] } ] },
  agents: ['Conductor', 'Router', 'Estimator'].map(name => ({ name, status: 'active', detail: 'live ' + name })),
  rules: [
    { service: 'Wash', category: 'Ext', base: 120, unit: 'sqft', min: 250, notes: 'n1' },
    { service: 'Gutter', category: 'Ext', base: 80.5, unit: 'ea', min: 99, notes: 'n2' } ],
  war: { enabled: false },
  log: [{ t: '10:00:00', text: 'hello live log' }, { t: '10:01:00', text: 'second' }],
};

// opts: fail(bool) | handlers overrides by name: fn(route, request) => Promise|undefined
async function setup(opts = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const posts = [];
  page.on('dialog', d => d.dismiss());
  await page.route('https://ops.hightidewash.net/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const u = new URL(req.url());
    const name = u.pathname.replace('/webhook/jarvis/', '');
    const json = body => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (req.method() === 'POST') posts.push({ name, body: req.postDataJSON() });
    if (opts.fail) return route.fulfill({ status: 500, headers: CORS, body: 'err' });
    if (opts.handlers && opts.handlers[name + ':' + req.method()]) return opts.handlers[name + ':' + req.method()](route, req, json, posts);
    const data = (opts.data || FIX);
    switch (name) {
      case 'pipeline': return json(data.pipeline);
      case 'agents': return json(data.agents);
      case 'estimate-rules': return json(data.rules);
      case 'war-mode': return req.method() === 'POST' ? json({ enabled: req.postDataJSON().enabled }) : json(data.war);
      case 'activity-log': return json(data.log);
      case 'chat': return json({ reply: 'pong' });
      case 'approvals': if (data.approvals) return json(data.approvals); break;
      case 'etsy-sales': if (data.etsy) return json(data.etsy); break;
      case 'weekly-report': if (data.report) return json(data.report); break;
    }
    return route.fulfill({ status: 404, headers: CORS, body: '' });
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  return { ctx, page, posts };
}
const settle = page => page.waitForFunction(() => document.getElementById('conn').textContent !== 'sample data' || false, null, { timeout: 8000 }).catch(() => {});

test('1. all endpoints failing -> sample fallback', async () => {
  const { ctx, page } = await setup({ fail: true });
  try {
    await page.waitForFunction(() => document.getElementById('conn').textContent.includes('unreachable'));
    assert.equal(await page.locator('.tag-sample:visible').count(), 4);
    assert.match(await page.textContent('#conn'), /sample/);
    assert.ok(await page.locator('#conn.sample').count());
    assert.equal(await page.textContent('#warLabel'), 'War Mode: unknown');
    assert.ok(await page.locator('#war').isDisabled());
  } finally { await ctx.close(); }
});

test('2. all OK -> live rendering', async () => {
  const { ctx, page } = await setup();
  try {
    await page.waitForFunction(() => document.getElementById('conn').classList.contains('live'));
    assert.match(await page.textContent('#conn'), /live/);
    assert.equal(await page.locator('#agents .agent').count(), 11);
    assert.equal(await page.locator('.tag-sample:visible').count(), 0);
    const counts = await page.locator('#pipeline .stage h3 span').allTextContents();
    assert.deepEqual(counts, ['2', '1', '0']);
    const rows = await page.locator('#rules tbody tr').allTextContents();
    assert.equal(rows.length, 2);
    assert.match(rows[0], /\$120/); assert.match(rows[0], /\$250/);
    assert.match(rows[1], /\$80\.5/);
    assert.match(await page.textContent('#log'), /hello live log/);
    assert.equal(await page.textContent('#warLabel'), 'War Mode: off');
    assert.ok(await page.locator('#war').isEnabled());
  } finally { await ctx.close(); }
});

test('3. XSS payloads are inert', async () => {
  const X = '<img src=x onerror=window.__x=1>';
  const data = {
    pipeline: { stages: [{ name: X, cards: [{ title: X, sub: X }] }] },
    agents: [{ name: 'Conductor', status: X, detail: X }, { name: X, status: 'active', detail: X }],
    rules: [{ service: X, category: X, base: X, unit: X, min: X, notes: X }],
    war: { enabled: false },
    log: [{ t: X, text: X }],
  };
  const { ctx, page } = await setup({ data });
  try {
    await page.waitForFunction(() => document.getElementById('conn').classList.contains('live'));
    await sleep(500);
    assert.equal(await page.evaluate(() => window.__x), undefined);
    assert.equal(await page.locator('#pipeline img, #rules img, #log img, #agents img, #nodes img').count(), 0);
  } finally { await ctx.close(); }
});

test('4. War Mode toggle on', async () => {
  const { ctx, page, posts } = await setup();
  try {
    await page.waitForFunction(() => !document.getElementById('war').disabled);
    await page.click('#war');
    await page.waitForFunction(() => document.getElementById('warLabel').textContent === 'War Mode: ON');
    assert.ok(await page.evaluate(() => document.body.classList.contains('war')));
    assert.deepEqual(posts.filter(p => p.name === 'war-mode').map(p => p.body), [{ enabled: true }]);
  } finally { await ctx.close(); }
});

test('5. POST failure reverts and logs', async () => {
  const handlers = { 'war-mode:POST': route => route.fulfill({ status: 500, headers: CORS, body: 'x' }) };
  const { ctx, page } = await setup({ handlers });
  try {
    await page.waitForFunction(() => !document.getElementById('war').disabled);
    await page.click('#war');
    await page.waitForFunction(() => /Could not save War Mode/.test(document.getElementById('chatlog').textContent));
    assert.equal(await page.textContent('#warLabel'), 'War Mode: off');
    assert.ok(!(await page.evaluate(() => document.body.classList.contains('war'))));
    assert.ok(await page.locator('#war').isEnabled());
  } finally { await ctx.close(); }
});

test('6. double-click sends one POST', async () => {
  const { ctx, page, posts } = await setup({ handlers: {
    'war-mode:POST': async (route, req, json) => { await sleep(500); return json({ enabled: true }); } } });
  try {
    await page.waitForFunction(() => !document.getElementById('war').disabled);
    await page.dblclick('#war', { force: true });
    await sleep(1200);
    assert.equal(posts.filter(p => p.name === 'war-mode').length, 1);
    assert.equal(await page.textContent('#warLabel'), 'War Mode: ON');
  } finally { await ctx.close(); }
});

test('7. refresh race does not flip label back', async () => {
  let gets = 0;
  const handlers = { 'war-mode:GET': async (route, req, json) => {
    gets++;
    if (gets === 1) return json({ enabled: false });
    await sleep(1500); return json({ enabled: false }); // stale slow response
  } };
  const { ctx, page } = await setup({ handlers });
  try {
    await page.waitForFunction(() => !document.getElementById('war').disabled);
    await page.evaluate(() => { window.__r = refresh(); }); // slow GET in flight
    await sleep(200);
    await page.click('#war');
    await page.waitForFunction(() => document.getElementById('warLabel').textContent === 'War Mode: ON');
    await page.evaluate(() => window.__r); // wait for slow refresh to finish
    await sleep(200);
    assert.equal(await page.textContent('#warLabel'), 'War Mode: ON');
    assert.ok(await page.evaluate(() => document.body.classList.contains('war')));
  } finally { await ctx.close(); }
});

test('8. chat reply and slow (7s) reply', async () => {
  const { ctx, page } = await setup({ handlers: {
    'chat:POST': async (route, req, json, posts) => {
      const m = posts[posts.length - 1].body.message;
      if (m === 'slow') await sleep(7000);
      return json({ reply: m === 'slow' ? 'late pong' : 'pong' });
    } } });
  try {
    await page.fill('#chatin', 'hi'); await page.press('#chatin', 'Enter');
    await page.waitForFunction(() => /Jarvis: pong/.test(document.getElementById('chatlog').textContent));
    await page.fill('#chatin', 'slow'); await page.press('#chatin', 'Enter');
    await page.waitForFunction(() => /Jarvis: late pong/.test(document.getElementById('chatlog').textContent), null, { timeout: 15000 });
    assert.ok(!/No reply received/.test(await page.textContent('#chatlog')));
  } finally { await ctx.close(); }
});

test('9. a11y attributes present; war aria-pressed tracks state', async () => {
  const { ctx, page } = await setup();
  try {
    await page.waitForFunction(() => document.getElementById('conn').classList.contains('live'));
    assert.equal(await page.getAttribute('#conn', 'role'), 'status');
    assert.equal(await page.getAttribute('#conn', 'aria-live'), 'polite');
    assert.equal(await page.getAttribute('#log', 'aria-live'), 'polite');
    assert.ok(await page.getAttribute('#chatin', 'aria-label'));
    assert.ok(await page.getAttribute('#chatform button', 'aria-label'));
    assert.equal(await page.getAttribute('#war', 'aria-pressed'), 'false');
    await page.click('#war');
    await page.waitForFunction(() => document.getElementById('war').getAttribute('aria-pressed') === 'true');
  } finally { await ctx.close(); }
});

test('10. unknown War Mode state has no aria-pressed', async () => {
  const { ctx, page } = await setup({ fail: true });
  try {
    await page.waitForFunction(() => document.getElementById('conn').textContent.includes('unreachable'));
    assert.equal(await page.getAttribute('#war', 'aria-pressed'), null);
  } finally { await ctx.close(); }
});

test('11. Tab reaches War Mode button with visible focus style', async () => {
  const { ctx, page } = await setup();
  try {
    await page.waitForFunction(() => !document.getElementById('war').disabled);
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement && document.activeElement.id === 'war');
    }
    assert.ok(reached, 'War button reachable by Tab');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('warLabel').textContent === 'War Mode: ON');
  } finally { await ctx.close(); }
});

test('12. reduced motion stops CSS animations', async () => {
  const { ctx, page } = await setup();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.waitForFunction(() => document.getElementById('conn').classList.contains('live'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.spin')).animationName), 'none');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.orb')).animationName), 'none');
  } finally { await ctx.close(); }
});

test('13. Enter in chat input sends a POST', async () => {
  const { ctx, page, posts } = await setup();
  try {
    await page.focus('#chatin');
    await page.keyboard.type('status');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Jarvis: pong/.test(document.getElementById('chatlog').textContent));
    assert.deepEqual(posts.filter(p => p.name === 'chat').map(p => p.body.message), ['status']);
  } finally { await ctx.close(); }
});

// ---- extended UI: decide, board, report, phone layout ----
const APR = [
  { id: 'p1', title: 'Estimate A', agent: 'Estimator', type: 'Estimate', qa: 'Pass', related_job: '', created: '', preview: 'x' },
  { id: 'p2', title: 'Reply B', agent: 'Support', type: 'Reply', qa: 'Not checked', related_job: '', created: '', preview: 'y' } ];
const BOARD = { stages: [
  { name: 'Booked', cards: [{ id: 'j1', title: 'Job One', sub: 's' }, { id: 'j2', title: 'Job Two', sub: 's' }] },
  { name: 'In Progress', cards: [] }, { name: 'Paid', cards: [] } ] };
const live = (extra = {}) => ({ ...FIX, ...extra });
const liveConn = page => page.waitForFunction(() => document.getElementById('conn').classList.contains('live'));
const aprReady = page => page.waitForSelector('#approvals .apr');

test('14. decide: two-step confirm, name remembered, removal only after ok', async () => {
  const { ctx, page, posts } = await setup({ data: live({ approvals: APR }),
    handlers: { 'approvals/decide:POST': async (route, req, json) => { await sleep(300); return json({ ok: true, id: 'p1', status: 'Approved' }); } } });
  try {
    await liveConn(page); await aprReady(page);
    assert.match(await page.textContent('#approvals'), /Estimate A/);
    await page.fill('#decidedBy', 'Makenzie');
    await page.click('#approvals .apr:nth-child(1) [data-act="ask"][data-d="approve"]');
    assert.equal(posts.filter(p => p.name === 'approvals/decide').length, 0, 'first click must not POST');
    assert.match(await page.textContent('#approvals .apr:nth-child(1)'), /Approve this item as Makenzie\?/);
    await page.click('#approvals [data-act="cancel"]');
    assert.equal(posts.filter(p => p.name === 'approvals/decide').length, 0);
    await page.click('#approvals .apr:nth-child(1) [data-act="ask"][data-d="approve"]');
    await page.click('#approvals [data-act="confirm"]');
    assert.ok(await page.locator('#approvals .apr:nth-child(1) button[data-act="ask"]').first().isDisabled(), 'disabled while pending');
    assert.equal(await page.locator('#approvals .apr').count(), 2, 'not removed before ok');
    await page.waitForFunction(() => document.querySelectorAll('#approvals .apr').length === 1);
    assert.deepEqual(posts.filter(p => p.name === 'approvals/decide').map(p => p.body), [{ id: 'p1', decision: 'approve', decided_by: 'Makenzie' }]);
    assert.equal(await page.textContent('#aprCount'), '1');
    await page.reload(); await aprReady(page);
    assert.equal(await page.inputValue('#decidedBy'), 'Makenzie');
  } finally { await ctx.close(); }
});

test('15. decide failure keeps card and shows error; empty name blocked', async () => {
  const { ctx, page, posts } = await setup({ data: live({ approvals: APR }),
    handlers: { 'approvals/decide:POST': route => route.fulfill({ status: 500, headers: CORS, body: 'x' }) } });
  try {
    await liveConn(page); await aprReady(page);
    await page.click('#approvals .apr:nth-child(2) [data-act="ask"][data-d="reject"]');
    assert.match(await page.textContent('#approvals'), /Enter your name/);
    assert.equal(posts.filter(p => p.name === 'approvals/decide').length, 0);
    await page.fill('#decidedBy', 'Joshua');
    await page.click('#approvals .apr:nth-child(2) [data-act="ask"][data-d="reject"]');
    await page.click('#approvals [data-act="confirm"]');
    await page.waitForSelector('#approvals .aprerr');
    assert.equal(await page.locator('#approvals .apr').count(), 2);
    assert.match(await page.textContent('.aprerr'), /Could not reject/);
  } finally { await ctx.close(); }
});

test('16. decide never works on sample data', async () => {
  const { ctx, page, posts } = await setup({ fail: true });
  try {
    await page.waitForFunction(() => document.getElementById('conn').textContent.includes('unreachable'));
    assert.ok(await page.locator('#aprSample').isVisible());
    assert.match(await page.textContent('#approvals'), /sample data: cannot decide/);
    assert.ok(await page.locator('#approvals [data-act="ask"]').first().isDisabled());
    assert.equal(posts.filter(p => p.name === 'approvals/decide').length, 0);
  } finally { await ctx.close(); }
});

test('17. board toggle and Move select, with revert on failure', async () => {
  let fail = false;
  const { ctx, page, posts } = await setup({ data: live({ pipeline: BOARD }),
    handlers: { 'pipeline/move:POST': async (route, req, json) => {
      if (fail) return route.fulfill({ status: 500, headers: CORS, body: 'x' });
      const b = req.postDataJSON(); return json({ ok: true, id: b.id, from: 'Booked', to: b.status }); } } });
  try {
    await liveConn(page);
    assert.equal(await page.locator('#pipeline .bcol').count(), 0, 'default is list');
    await page.click('#viewBoard');
    assert.equal(await page.getAttribute('#viewBoard', 'aria-pressed'), 'true');
    assert.deepEqual(await page.locator('#pipeline .bcol h3').allTextContents(), ['Booked2', 'In Progress0', 'Awaiting Invoice0', 'Paid0', 'Flagged0']);
    await page.selectOption('#pipeline select[data-id="j1"]', 'In Progress');
    await page.waitForFunction(() => /Moved Job One/.test(document.getElementById('boardMsg').textContent));
    assert.deepEqual(posts.filter(p => p.name === 'pipeline/move').map(p => p.body), [{ id: 'j1', status: 'In Progress' }]);
    assert.equal(await page.locator('.bcol[data-stage="In Progress"] .bcard').count(), 1);
    fail = true;
    await page.selectOption('#pipeline select[data-id="j2"]', 'Paid');
    await page.waitForFunction(() => /Could not move Job Two/.test(document.getElementById('boardMsg').textContent));
    assert.equal(await page.locator('.bcol[data-stage="Booked"] .bcard').count(), 1, 'reverted');
    assert.equal(await page.locator('.bcol[data-stage="Paid"] .bcard').count(), 0);
    await page.click('#viewList');
    assert.equal(await page.locator('#pipeline .stage').count() > 0, true);
  } finally { await ctx.close(); }
});

test('18. board drag and drop moves a card', async () => {
  const { ctx, page, posts } = await setup({ data: live({ pipeline: BOARD }),
    handlers: { 'pipeline/move:POST': (route, req, json) => json({ ok: true, id: 'j1', from: 'Booked', to: 'Paid' }) } });
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await liveConn(page); await page.click('#viewBoard');
    await page.dragAndDrop('.bcard[data-id="j1"] b', '.bcol[data-stage="Paid"]');
    await page.waitForFunction(() => /Moved Job One/.test(document.getElementById('boardMsg').textContent));
    assert.deepEqual(posts.filter(p => p.name === 'pipeline/move').map(p => p.body), [{ id: 'j1', status: 'Paid' }]);
  } finally { await ctx.close(); }
});

test('19. board is read-only on sample data', async () => {
  const { ctx, page, posts } = await setup({ fail: true });
  try {
    await page.waitForFunction(() => document.getElementById('conn').textContent.includes('unreachable'));
    await page.click('#viewBoard');
    assert.match(await page.textContent('#pipeline'), /sample data: cannot move jobs/);
    assert.ok(await page.locator('#pipeline select').first().isDisabled());
    assert.equal(await page.locator('#pipeline [draggable="true"]').count(), 0);
    assert.equal(posts.filter(p => p.name === 'pipeline/move').length, 0);
  } finally { await ctx.close(); }
});

test('20. report panel renders sample when unreachable, live when available', async () => {
  const a = await setup({ fail: true });
  try {
    await a.page.waitForFunction(() => document.getElementById('conn').textContent.includes('unreachable'));
    assert.ok(await a.page.locator('#reportView').isHidden());
    await a.page.click('#reportBtn');
    assert.ok(await a.page.locator('#reportView').isVisible());
    assert.ok(await a.page.locator('#repSample').isVisible());
    assert.match(await a.page.textContent('#reportView'), /Conductor/);
    assert.ok(await a.page.locator('#reportView .rbar').count() > 5);
  } finally { await a.ctx.close(); }
  const report = { week_start: '2026-02-02', week_end: '2026-02-08', runs_by_agent: { Router: { runs: 5, errors: 1 } },
    approvals: { created: 3, approved: 2, rejected: 0, sent: 1, awaiting: 1 }, qa: { pass: 2, fail: 0, not_checked: 1 },
    jobs: { by_status: { Booked: 2 }, flagged: 0 }, generated_at: '2026-02-08T10:00:00Z' };
  const b = await setup({ data: live({ report }) });
  try {
    await liveConn(b.page); await b.page.click('#reportBtn');
    await b.page.waitForFunction(() => /2026-02-02/.test(document.getElementById('reportView').textContent));
    assert.equal(await b.page.locator('#repSample').count(), 0);
    assert.match(await b.page.textContent('#reportView'), /Router/);
  } finally { await b.ctx.close(); }
});

test('21. phone 390px: no horizontal scroll, tap targets, War Mode and chat reachable', async () => {
  const { ctx, page } = await setup({ data: live({ approvals: APR, pipeline: BOARD }) });
  try {
    await page.setViewportSize({ width: 390, height: 800 });
    await liveConn(page); await aprReady(page);
    for (const view of ['list', 'board']) {
      if (view === 'board') await page.click('#viewBoard');
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth, ov: getComputedStyle(document.body).overflow }));
      assert.ok(m.sw <= m.cw && m.bw <= m.cw, view + ' horizontal overflow ' + JSON.stringify(m));
    }
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).overflowY), 'hidden');
    for (const sel of ['#war', '#reportBtn', '#chatform button', '#chatin', '#viewBoard', '#decidedBy', '#approvals [data-act="ask"]', '#pipeline select']) {
      const h = (await page.locator(sel).first().boundingBox()).height;
      assert.ok(h >= 39.5, sel + ' height ' + h);
    }
    await page.locator('#war').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#war').isVisible());
    await page.click('#war');
    await page.waitForFunction(() => document.getElementById('warLabel').textContent === 'War Mode: ON');
    await page.fill('#chatin', 'hi'); await page.click('#chatform button');
    await page.waitForFunction(() => /Jarvis: pong/.test(document.getElementById('chatlog').textContent));
    await page.click('#reportBtn');
    const m2 = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert.ok(m2, 'report overflows at 390');
  } finally { await ctx.close(); }
});

test('22. desktop layouts unchanged at 1366x768 and 1920x1080', async () => {
  const { ctx, page } = await setup();
  try {
    await liveConn(page);
    for (const [w, h] of [[1366, 768], [1920, 1080]]) {
      await page.setViewportSize({ width: w, height: h });
      const m = await page.evaluate(() => ({
        bodyOverflow: getComputedStyle(document.body).overflow, minW: getComputedStyle(document.body).minWidth,
        cols: getComputedStyle(document.querySelector('.main')).gridTemplateColumns.split(' ').length,
        sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight,
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        war: document.querySelector('.p-war').getBoundingClientRect().left, pipe: document.querySelector('.p-pipeline').getBoundingClientRect().left,
        reactor: document.getElementById('reactor').getBoundingClientRect().left }));
      assert.equal(m.bodyOverflow, 'hidden'); assert.equal(m.minW, '1200px'); assert.equal(m.cols, 3);
      assert.ok(m.sh <= m.ch && m.sw <= m.cw, `${w}x${h} page scrolls`);
      assert.ok(m.pipe < m.reactor && m.reactor < m.war, `${w}x${h} three-column order`);
    }
  } finally { await ctx.close(); }
});

// ---- Etsy sales view ----
const ETSY = { generated_at: '2026-11-01T09:00:00Z', currency: 'USD',
  totals: { orders_7d: 4, revenue_7d: 123.4, orders_30d: 15, revenue_30d: 1234.5, avg_order_30d: 82.3 },
  by_status: { New: 2, Packed: 1, Shipped: 3, Delivered: 8, Issue: 1 },
  to_ship: [ { order: 'E-1', buyer_first_name: 'Ona', items: '1 x Thing', ship_by: '2026-11-05', overdue: false },
             { order: 'E-2', buyer_first_name: 'Pia', items: '2 x Other', ship_by: '2026-10-28', overdue: true } ],
  recent: [ { order: 'E-2', date: '2026-10-30', total: 45.5, status: 'New' }, { order: 'E-1', date: '2026-10-31', total: 20, status: 'Packed' } ],
  issues: 1 };

test('23. sales view: sample mode is tagged, toggles back, read-only', async () => {
  const { ctx, page, posts } = await setup({ fail: true });
  try {
    await page.waitForFunction(() => document.getElementById('conn').textContent.includes('unreachable'));
    assert.ok(await page.locator('#salesView').isHidden());
    await page.click('#salesBtn');
    assert.ok(await page.locator('#salesView').isVisible());
    assert.ok(await page.locator('.main').isHidden());
    assert.equal(await page.getAttribute('#salesBtn', 'aria-pressed'), 'true');
    await page.waitForSelector('#salesSample');
    assert.ok(await page.locator('#salesSample').isVisible());
    assert.match(await page.textContent('#salesView'), /TheLuminousFairy/);
    assert.ok(await page.locator('#salesView .ship li').count() > 0);
    assert.ok(await page.locator('#salesView .ship li.over .pill.bad').count() > 0);
    assert.match(await page.textContent('#etsyStat'), /sample/);
    await page.click('#reportBtn');   // switching views is exclusive
    assert.ok(await page.locator('#salesView').isHidden() && await page.locator('#reportView').isVisible());
    await page.click('#salesBtn');
    await page.click('#salesBtn');
    assert.ok(await page.locator('#salesView').isHidden() && await page.locator('.main').isVisible());
    assert.equal(posts.length, 0);
  } finally { await ctx.close(); }
});

test('24. sales view: live data, overdue highlight, MIXED currency, polling only while open', async () => {
  let hits = 0;
  const { ctx, page } = await setup({ data: live({ etsy: ETSY }),
    handlers: { 'etsy-sales:GET': (route, req, json) => { hits++; return json(globalThis.__etsy || ETSY); } } });
  try {
    await liveConn(page);
    await page.waitForFunction(() => document.getElementById('etsyCnt').textContent.trim() === '2');
    const h0 = hits;
    await page.evaluate(() => refresh()); await sleep(300);
    assert.equal(hits, h0, 'no sales poll while hidden');
    await page.click('#salesBtn');
    await page.waitForSelector('#salesView .tile');
    assert.equal(await page.locator('#salesSample').count(), 0);
    const txt = await page.textContent('#salesView');
    assert.match(txt, /\$1,234\.50/); assert.match(txt, /\$123\.40/); assert.match(txt, /\$82\.30/);
    assert.equal(await page.locator('#salesView .sst').count(), 5);
    assert.ok(await page.locator('#salesView .sst.bad').count() === 1);
    const first = page.locator('#salesView .ship li').first();
    assert.match(await first.textContent(), /E-2/); assert.match(await first.textContent(), /Overdue/);
    assert.ok(await first.evaluate(el => el.classList.contains('over') && getComputedStyle(el).borderLeftWidth === '4px'));
    assert.equal(await page.locator('#salesView .ship li').nth(1).locator('.pill.bad').count(), 0);
    assert.equal(await page.locator('#salesView tbody tr').count(), 2);
    const h1 = hits; await page.evaluate(() => refresh()); await page.waitForFunction(n => true, 0); await sleep(400);
    assert.ok(hits > h1, 'polled while open');
    // MIXED
    const mixed = { ...ETSY, currency: 'MIXED' };
    await page.route('https://ops.hightidewash.net/webhook/jarvis/etsy-sales', r => r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(mixed) }));
    await page.evaluate(() => refreshSales());
    await page.waitForFunction(() => /Mixed currencies/.test(document.getElementById('salesView').textContent));
    const t2 = await page.textContent('#salesView');
    assert.match(t2, /1234\.50/); assert.ok(!/\$/.test(t2));
  } finally { await ctx.close(); }
});

test('25. sales view at 390px: no horizontal scroll; desktop unchanged with view closed', async () => {
  const { ctx, page } = await setup({ data: live({ etsy: ETSY }) });
  try {
    await page.setViewportSize({ width: 390, height: 800 });
    await liveConn(page);
    await page.click('#salesBtn'); await page.waitForSelector('#salesView .tile');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'sales overflows at 390');
    assert.ok((await page.locator('#salesBtn').boundingBox()).height >= 39.5);
    await page.click('#salesBtn');
    await page.setViewportSize({ width: 1920, height: 1080 });
    const m = await page.evaluate(() => ({ cols: getComputedStyle(document.querySelector('.main')).gridTemplateColumns.split(' ').length,
      sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.equal(m.cols, 3); assert.ok(m.sh <= m.ch && m.sw <= m.cw);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.click('#salesBtn');
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight), 'sales view page-scrolls on desktop');
  } finally { await ctx.close(); }
});
