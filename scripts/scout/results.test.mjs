// node --test scripts/scout/results.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coversPr, markInPr, scopeOf, unreachable } from './results.mjs';

const rows = [{ file: 'core/pending-orders.spec.ts' }, { file: 'core/smoke.spec.ts' }, { file: 'pr-12-dates.spec.ts' }, { file: 'features/orders/edit.spec.ts' }];

test('a core spec the PR changes covers the PR; other core specs do not', () => {
  const marked = markInPr(rows, ['src/lib/utils.ts', 'e2e/scout/core/pending-orders.spec.ts', '']);
  assert.deepEqual(marked.map(coversPr), [true, false, true, true]);
  // Where the flow lives is unchanged: it is still a core flow, kept in the committed suite.
  assert.deepEqual(marked.map(scopeOf), ['core', 'core', 'pr', 'feature']);
});

test('matches the spec wherever the repo keeps its Scout folder, and only on whole path parts', () => {
  assert.equal(markInPr(rows, ['apps/web/tests/scout/core/smoke.spec.ts'])[1].inPr, true);
  assert.equal(markInPr(rows, ['core/smoke.spec.ts'])[1].inPr, true);
  assert.equal(markInPr(rows, ['e2e/scout/hardcore/smoke.spec.ts.bak', 'e2e/scout/xcore/smoke.spec.ts'])[1].inPr, undefined);
});

test('with no file list (a run on main), nothing is marked', () => {
  assert.deepEqual(markInPr(rows, []), rows);
  assert.deepEqual(rows.map(coversPr), [false, false, true, true]);
});

test('a flow that failed because the app was not answering is unreachable, not a failed flow', () => {
  const refused = { title: 'Shop appointments › history shows past appointments', status: 'failed', error: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login?return_to=%2Fadmin' };
  const dropped = { title: 'Queue', status: 'failed', error: 'Error: page.goto: net::ERR_EMPTY_RESPONSE at http://localhost:3000/' };
  const real = { title: 'Prices', status: 'failed', error: 'Error: expect(locator).toBeVisible() failed' };
  const timedOut = { title: 'Invoices', status: 'timedOut', error: 'Test timeout of 90000ms exceeded.' };
  const passed = { title: 'Smoke', status: 'passed', error: '' };
  assert.deepEqual(unreachable([refused, dropped, real, timedOut, passed], 'http://localhost:3000').map((r) => r.title), [refused.title, dropped.title]);
});

test('only the app under test counts: another host or port refusing is the flow\'s own failure', () => {
  const other = { title: 'Webhook', status: 'failed', error: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4600/hook' };
  const longerPort = { title: 'Other app', status: 'failed', error: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:30001/' };
  const outside = { title: 'Docs link', status: 'failed', error: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/' };
  assert.deepEqual(unreachable([other, longerPort, outside], 'http://localhost:3000/'), []);
  // With no base URL known, any local address is taken as the app.
  assert.deepEqual(unreachable([other, outside]).map((r) => r.title), ['Webhook']);
});
