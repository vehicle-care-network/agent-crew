// node --test scripts/scout/pieces.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'pieces.sh');

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'pieces-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (root, path) => readFileSync(join(root, path), 'utf8');
const run = (root, cmd, snap, mode = 'pr', adjust = '', only = '') =>
  execFileSync('bash', [script, cmd, snap], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SCOUT_MODE: mode, SCOUT_ADJUST: adjust, SCOUT_ONLY: only },
  });

const laidOut = {
  'e2e/scout/core/layout.spec.ts': "page.locator('#step-5'); /5\\. Landing/",
  'e2e/scout/core/_seed/base.mjs': 'seed',
  '.github/scout/core-flows.md': '| flow | |',
  '.github/agents/crew.json': '{}',
  'scripts/scout/seed.mjs': 'seed',
};

test("a core spec the agent edits is put back before the recorded run, and the agent's own flows stay", () => {
  const root = repo(laidOut);
  const snap = join(mkdtempSync(join(tmpdir(), 'snap-')), 'pieces');
  try {
    run(root, 'snapshot', snap);
    write(root, 'e2e/scout/core/layout.spec.ts', "page.locator('#step-4'); /4\\. Landing/");
    rmSync(join(root, 'e2e/scout/core/_seed/base.mjs'));
    write(root, 'e2e/scout/core/extra.spec.ts', 'new');
    write(root, '.github/agents/crew.json', '{"scout":{}}');
    write(root, 'e2e/scout/pr-220-landing.spec.ts', 'mine');
    write(root, 'e2e/scout/features/setup/landing.spec.ts', 'kept flow, updated');
    const out = run(root, 'restore', snap).trim().split('\n').sort();
    assert.deepEqual(out, [
      '.github/agents/crew.json',
      'e2e/scout/core/_seed/base.mjs',
      'e2e/scout/core/extra.spec.ts (added)',
      'e2e/scout/core/layout.spec.ts',
    ]);
    assert.equal(read(root, 'e2e/scout/core/layout.spec.ts'), laidOut['e2e/scout/core/layout.spec.ts']);
    assert.equal(read(root, 'e2e/scout/core/_seed/base.mjs'), 'seed');
    assert.equal(read(root, '.github/agents/crew.json'), '{}');
    assert.equal(existsSync(join(root, 'e2e/scout/core/extra.spec.ts')), false);
    assert.equal(read(root, 'e2e/scout/pr-220-landing.spec.ts'), 'mine');
    assert.equal(read(root, 'e2e/scout/features/setup/landing.spec.ts'), 'kept flow, updated');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(snap), { recursive: true, force: true });
  }
});

test('nothing the agent left alone is reported', () => {
  const root = repo(laidOut);
  const snap = join(mkdtempSync(join(tmpdir(), 'snap-')), 'pieces');
  try {
    run(root, 'snapshot', snap);
    assert.equal(run(root, 'restore', snap), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(snap), { recursive: true, force: true });
  }
});

test('a coverage run keeps the core specs it adds and its core-flows.md, but not edits to existing specs', () => {
  const root = repo(laidOut);
  const snap = join(mkdtempSync(join(tmpdir(), 'snap-')), 'pieces');
  try {
    run(root, 'snapshot', snap, 'coverage');
    write(root, 'e2e/scout/core/booking.spec.ts', 'new core spec');
    write(root, 'e2e/scout/core/_seed/booking.mjs', 'its seed');
    write(root, '.github/scout/core-flows.md', '| flow | core/booking.spec.ts |');
    write(root, 'e2e/scout/core/layout.spec.ts', 'edited');
    write(root, '.github/scout/flows/setup.md', 'not the agent’s to add');
    const out = run(root, 'restore', snap, 'coverage').trim().split('\n').sort();
    assert.deepEqual(out, ['.github/scout/flows/setup.md (added)', 'e2e/scout/core/layout.spec.ts']);
    assert.equal(read(root, 'e2e/scout/core/booking.spec.ts'), 'new core spec');
    assert.equal(read(root, 'e2e/scout/core/_seed/booking.mjs'), 'its seed');
    assert.equal(read(root, '.github/scout/core-flows.md'), '| flow | core/booking.spec.ts |');
    assert.equal(read(root, 'e2e/scout/core/layout.spec.ts'), laidOut['e2e/scout/core/layout.spec.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(snap), { recursive: true, force: true });
  }
});

test('a run with ADJUSTMENTS keeps its rewrite of the core flow it names, but not edits elsewhere', () => {
  const root = repo({
    ...laidOut,
    'e2e/scout/core/layout.spec.ts': "test('shows the steps', () => { page.locator('#step-5'); });",
    'e2e/scout/core/_seed/layout.mjs': 'layout seed',
    'e2e/scout/core/booking.spec.ts': "test('books a slot', () => { page.locator('#slot'); });",
  });
  const snap = join(mkdtempSync(join(tmpdir(), 'snap-')), 'pieces');
  const adjust = 'layout: also check the Landing step shows the date';
  const only = 'Layout › shows the steps';
  try {
    run(root, 'snapshot', snap, 'pr', adjust, only);
    write(root, 'e2e/scout/core/layout.spec.ts', 'rewritten as asked');
    write(root, 'e2e/scout/core/_seed/layout.mjs', 'seed with a date');
    write(root, 'e2e/scout/core/booking.spec.ts', "test('books a slot', () => { page.locator('#old-slot'); });");
    write(root, 'e2e/scout/core/_seed/base.mjs', 'shared seed, edited');
    write(root, '.github/agents/crew.json', '{"scout":{}}');
    const out = run(root, 'restore', snap, 'pr', adjust, only).trim().split('\n').sort();
    assert.deepEqual(out, [
      '.github/agents/crew.json',
      'e2e/scout/core/_seed/base.mjs',
      'e2e/scout/core/booking.spec.ts',
    ]);
    assert.equal(read(root, 'e2e/scout/core/layout.spec.ts'), 'rewritten as asked');
    assert.equal(read(root, 'e2e/scout/core/_seed/layout.mjs'), 'seed with a date');
    assert.equal(read(root, 'e2e/scout/core/booking.spec.ts'), "test('books a slot', () => { page.locator('#slot'); });");
    assert.equal(read(root, 'e2e/scout/core/_seed/base.mjs'), 'seed');
    assert.equal(read(root, '.github/agents/crew.json'), '{}');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(snap), { recursive: true, force: true });
  }
});

test('the harness the run laid out is put back too', () => {
  const root = repo({ ...laidOut, 'e2e/scout/_support/scout.ts': "export const loginAs = '#email';" });
  const snap = join(mkdtempSync(join(tmpdir(), 'snap-')), 'pieces');
  try {
    run(root, 'snapshot', snap);
    write(root, 'e2e/scout/_support/scout.ts', "export const loginAs = '#user';");
    assert.equal(run(root, 'restore', snap).trim(), 'e2e/scout/_support/scout.ts');
    assert.equal(read(root, 'e2e/scout/_support/scout.ts'), "export const loginAs = '#email';");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(snap), { recursive: true, force: true });
  }
});
