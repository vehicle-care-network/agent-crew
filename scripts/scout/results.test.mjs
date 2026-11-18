// node --test scripts/scout/results.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coversPr, markInPr, scopeOf } from './results.mjs';

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
