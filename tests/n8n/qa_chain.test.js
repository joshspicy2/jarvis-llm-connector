'use strict';
// Verifies each drafter calls QA after creating the Approvals row, non-blocking, and still responds.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = (f) => require(path.join(__dirname, '..', '..', 'dashboard', 'n8n', f));
const DRAFTERS = { estimator: 'estimator-workflow.json', support: 'support-workflow.json', marketer: 'marketer-workflow.json' };

const next = (wf, name) => ((wf.connections[name] || {}).main || []).flat().map((c) => c.node);
function reachable(wf, from) {
  const seen = new Set([from]);
  const q = [from];
  while (q.length) for (const n of next(wf, q.shift())) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}

for (const [name, file] of Object.entries(DRAFTERS)) {
  describe(`${name} QA chain`, () => {
    const wf = load(file);
    const qa = wf.nodes.find((n) => n.name === 'Call QA');

    test('Call QA exists directly after Create Approval', () => {
      assert.ok(qa, 'Call QA node missing');
      assert.equal(qa.type, 'n8n-nodes-base.httpRequest');
      assert.deepEqual(next(wf, 'Create Approval'), ['Call QA']);
      assert.ok(reachable(wf, 'Create Approval').has('Call QA'));
    });

    test('posts approval_id to the QA webhook via the base placeholder', () => {
      assert.equal(qa.parameters.method, 'POST');
      assert.equal(qa.parameters.url, 'https://REPLACE_WITH_N8N_BASE/webhook/jarvis/qa');
      assert.match(qa.parameters.jsonBody, /approval_id/);
      assert.match(qa.parameters.jsonBody, /\$\('Create Approval'\)\.first\(\)\.json\.id/);
    });

    test('is non-blocking with a short timeout and no credentials', () => {
      assert.equal(qa.onError, 'continueRegularOutput');
      assert.ok(qa.parameters.options.timeout <= 15000);
      assert.equal(qa.credentials, undefined);
      assert.equal(qa.parameters.authentication === undefined || qa.parameters.authentication === 'none', true);
    });

    test('final Respond Drafted is still reached from Call QA', () => {
      const r = reachable(wf, 'Call QA');
      assert.ok(r.has('Respond Drafted'));
      assert.equal(wf.nodes.find((n) => n.name === 'Respond Drafted').type, 'n8n-nodes-base.respondToWebhook');
      assert.deepEqual(next(wf, 'Respond Drafted'), []);
    });

    test('QA node is not the only path and sets no Status', () => {
      assert.doesNotMatch(JSON.stringify(qa), /Status/);
      assert.equal(next(wf, 'Call QA').length, 1);
    });
  });
}
