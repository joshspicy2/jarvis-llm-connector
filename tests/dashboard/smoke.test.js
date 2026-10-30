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
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
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
