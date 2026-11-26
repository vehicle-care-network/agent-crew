// node --test scripts/scout/seed.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'seed.sh');

// A seed that "creates" its document by writing a file, and one that "updates" a document another seed
// creates by failing when that file isn't there yet.
const creates = (doc) => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(doc)}, '');`;
const updates = (doc) =>
  `import { existsSync } from 'node:fs'; if (!existsSync(${JSON.stringify(doc)})) { console.error('5 NOT_FOUND'); process.exit(1); }`;

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'seed-'));
  writeFileSync(join(root, '.env.local'), '');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const run = (root, env = {}) =>
  spawnSync('bash', [script], {
    cwd: root,
    encoding: 'utf8',
    // C collation, as on the failed run: '-' sorts before '.', so the move seed runs first.
    env: { ...process.env, LC_ALL: 'C', PR_NUMBER: '294', SCOUT_REUSED: '', ...env },
  });

test("a seed that updates another seed's document passes even when it sorts first", () => {
  const root = repo({
    'e2e/scout/_seed/pr-294-timeline-move.mjs': updates('tl_open_mid'),
    'e2e/scout/_seed/pr-294-timeline.mjs': creates('tl_open_mid'),
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(
      r.stdout.indexOf('pr-294-timeline-move.mjs\n') < r.stdout.indexOf('pr-294-timeline.mjs\n'),
      'runs in file-name order first',
    );
    assert.match(r.stdout, /Seeding e2e\/scout\/_seed\/pr-294-timeline-move\.mjs \(again\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a seed that fails twice fails the run, is named, and the others still run', () => {
  const root = repo({
    'e2e/scout/core/_seed/broken.mjs': 'process.exit(1);',
    'e2e/scout/core/_seed/ok.mjs': creates('ok'),
    'e2e/scout/_seed/pr-294-flow.mjs': creates('flow'),
  });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /failed twice: e2e\/scout\/core\/_seed\/broken\.mjs$/m);
    assert.ok(existsSync(join(root, 'ok')) && existsSync(join(root, 'flow')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all seeds passing runs each once; another PR's seeds run only when reused", () => {
  const root = repo({
    'e2e/scout/_seed/pr-294-flow.mjs': creates('flow'),
    'e2e/scout/_seed/pr-7-other.mjs': creates('other'),
  });
  try {
    let r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /again/);
    assert.ok(!existsSync(join(root, 'other')));
    r = run(root, { SCOUT_REUSED: 'true' });
    assert.equal(r.status, 0);
    assert.ok(existsSync(join(root, 'other')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no seeds at all is fine', () => {
  const root = repo({});
  try {
    assert.equal(run(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
