/**
 * Rocket's landing loop: merges the crew's finished PRs, in order, into a release branch cut from the
 * default branch, running the repo's checks after each one. Deterministic; Rocket's agent only steps in
 * when a merge conflicts or the checks fail, and then calls `continue` or `drop`.
 *
 *   node .crew/scripts/rocket/land.mjs auto               # cut the branch, land every PR until a problem; status=done|needs-rocket
 *   node .crew/scripts/rocket/land.mjs status             # the state and the current problem (files, log)
 *   node .crew/scripts/rocket/land.mjs continue           # after a fix: commit it, re-check, carry on; prints DONE or NEEDS ROCKET
 *   node .crew/scripts/rocket/land.mjs drop "<reason>"    # leave the current PR out of this release, carry on
 *   node .crew/scripts/rocket/land.mjs finish             # drop whatever is still stuck, land the rest unattended, verify
 *
 * Env: ROCKET_VERSION, ROCKET_BRANCH, ROCKET_PRS (comma-separated, in landing order), GITHUB_REPOSITORY, GH_TOKEN.
 * For tests without GitHub: ROCKET_PRS_JSON (array of { pr, title, headRef, state, merged, sameRepo }) and
 * ROCKET_DEFAULT_BRANCH replace the API.
 *
 * State lives in agent-out/rocket.json:
 *   { version, branch, base, defaultBranch, prs: [{ pr, title, headRef, headSha, status, preSha, sha, reason, attempts }],
 *     problem: null | { kind: 'conflict'|'checks', pr, files?, log? } }
 * PR status: pending | current | landed | dropped | skipped.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const STATE = 'agent-out/rocket.json';
const IDENTITY = ['-c', 'user.name=Rocket (Agent HQ)', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
const CHECK_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const repo = process.env.GITHUB_REPOSITORY || '';
const [command, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(`[Rocket] ${message}`);
  process.exit(1);
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitTry = (...a) => spawnSync('git', a, { encoding: 'utf8' });
const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
const mergeHead = () => existsSync('.git/MERGE_HEAD');

function load() {
  if (!existsSync(STATE)) fail(`${STATE} is missing: run \`land.mjs auto\` first`);
  return JSON.parse(readFileSync(STATE, 'utf8'));
}
function save(state) {
  mkdirSync('agent-out', { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
}
function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
const current = (state) => state.prs.find((p) => p.status === 'current');

function crewCommands() {
  try {
    return JSON.parse(readFileSync('.github/agents/crew.json', 'utf8')).commands ?? {};
  } catch {
    return {};
  }
}

/** The repo's typecheck, lint and tests, in that order; stops at the first failure. */
function runChecks() {
  const commands = crewCommands();
  for (const name of ['typecheck', 'lint', 'test']) {
    const cmd = commands[name];
    if (!cmd || cmd === 'true') continue;
    console.log(`[Rocket] ${name}: ${cmd}`);
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status !== 0) {
      const why = r.error?.code === 'ETIMEDOUT' ? `timed out after ${CHECK_TIMEOUT_MS / 60000} minutes` : `exited ${r.status}`;
      const tail = out.split('\n').filter(Boolean).slice(-60).join('\n');
      return { ok: false, log: `${name} (${cmd}) ${why}:\n${tail}` };
    }
  }
  return { ok: true, log: '' };
}

/** What a PR looks like on GitHub (or in ROCKET_PRS_JSON for tests). */
function describe(number) {
  if (process.env.ROCKET_PRS_JSON) {
    const p = JSON.parse(process.env.ROCKET_PRS_JSON).find((x) => Number(x.pr) === number);
    if (!p) fail(`ROCKET_PRS_JSON has no PR #${number}`);
    return { title: p.title ?? `PR #${number}`, headRef: p.headRef, state: p.state ?? 'open', merged: !!p.merged, sameRepo: p.sameRepo !== false };
  }
  const p = gh(`repos/${repo}/pulls/${number}`);
  return { title: p.title, headRef: p.head.ref, state: p.state, merged: !!p.merged, sameRepo: p.head.repo?.full_name === repo };
}

function defaultBranch() {
  return process.env.ROCKET_DEFAULT_BRANCH || gh(`repos/${repo}`).default_branch;
}

function problemText(problem) {
  if (!problem) return 'no problem';
  if (problem.kind === 'conflict') return `conflicts in ${problem.files.join(', ')}`;
  return `the checks fail:\n${problem.log}`;
}

/** Lands pending PRs one by one. Returns 'done' or 'needs-rocket' (state saved, problem recorded). `unattended`: drop instead of stopping. */
function loop(state, unattended = false) {
  for (const p of state.prs) {
    if (p.status !== 'pending') continue;
    p.status = 'current';
    p.attempts = p.attempts ?? 0;
    const fetched = gitTry('fetch', '-q', 'origin', p.headRef);
    if (fetched.status !== 0) {
      p.status = 'dropped';
      p.reason = `The branch ${p.headRef} couldn't be fetched: ${fetched.stderr.trim().split('\n').pop()}`;
      console.log(`[Rocket] #${p.pr}: ${p.reason}`);
      save(state);
      continue;
    }
    p.headSha = git('rev-parse', 'FETCH_HEAD');
    p.preSha = git('rev-parse', 'HEAD');
    save(state);
    console.log(`[Rocket] Landing #${p.pr} (${p.headRef} at ${p.headSha.slice(0, 7)}) onto ${git('rev-parse', '--short', 'HEAD')}`);
    const merged = gitTry(...IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', `Land #${p.pr}: ${p.title}`, '-m', `Agent HQ release ${state.version}`, 'FETCH_HEAD');
    if (merged.status !== 0) {
      if (mergeHead()) {
        const files = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        state.problem = { kind: 'conflict', pr: p.pr, files };
        if (unattended) {
          drop(state, `Rocket couldn't resolve conflicts in ${files.join(', ')} and left it out of this release`);
          continue;
        }
        save(state);
        console.log(`[Rocket] #${p.pr} conflicts with the release branch in:\n  ${files.join('\n  ')}`);
        return 'needs-rocket';
      }
      gitTry('merge', '--abort');
      gitTry('reset', '--hard', p.preSha);
      p.status = 'dropped';
      p.reason = `git couldn't merge ${p.headRef}: ${merged.stderr.trim().split('\n').pop()}`;
      console.log(`[Rocket] #${p.pr}: ${p.reason}`);
      save(state);
      continue;
    }
    const result = check(state, p, unattended);
    if (result === 'needs-rocket') return result;
  }
  state.problem = null;
  save(state);
  return 'done';
}

/** Runs the checks for the current PR; lands it or records the problem. */
function check(state, p, unattended = false) {
  const r = runChecks();
  if (r.ok) {
    p.status = 'landed';
    p.sha = git('rev-parse', 'HEAD');
    state.problem = null;
    save(state);
    console.log(`[Rocket] Landed #${p.pr} as ${p.sha.slice(0, 7)}`);
    return 'landed';
  }
  state.problem = { kind: 'checks', pr: p.pr, log: r.log };
  if (unattended) {
    drop(state, `Rocket couldn't make the checks pass after merging it and left it out of this release (${r.log.split('\n')[0]})`);
    return 'dropped';
  }
  save(state);
  console.log(`[Rocket] The checks fail after merging #${p.pr}:\n${r.log}`);
  return 'needs-rocket';
}

/** Leaves the current PR out: aborts its merge or resets to before it, and records why. */
function drop(state, reason) {
  const p = current(state);
  if (!p) fail('No PR is being landed right now; nothing to drop');
  if (mergeHead()) gitTry('merge', '--abort');
  if (p.preSha) git('reset', '--hard', p.preSha);
  p.status = 'dropped';
  p.reason = reason;
  state.problem = null;
  save(state);
  console.log(`[Rocket] Dropped #${p.pr}: ${reason}`);
}

const MARKER = /^(<<<<<<< |>>>>>>> )/m;
/** Files that still carry conflict markers, among those that conflicted. */
function markersLeft(files) {
  return files.filter((f) => existsSync(f) && MARKER.test(readFileSync(f, 'utf8')));
}

function report(state, result) {
  if (result === 'done') {
    console.log('DONE');
    return;
  }
  const pr = state.problem?.pr;
  console.log(`NEEDS ROCKET: ${state.problem?.kind} on #${pr}\n${problemText(state.problem)}`);
}

if (command === 'auto') {
  const version = process.env.ROCKET_VERSION;
  const branch = process.env.ROCKET_BRANCH;
  const numbers = (process.env.ROCKET_PRS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!version || !branch || !numbers.length) fail('ROCKET_VERSION, ROCKET_BRANCH and ROCKET_PRS are required');
  if (!numbers.every((n) => /^\d+$/.test(n))) fail(`ROCKET_PRS must be PR numbers: ${numbers.join(',')}`);
  const base = defaultBranch();
  git('fetch', '-q', 'origin', base);
  git('checkout', '-q', '-B', branch, `origin/${base}`);
  const state = { version, branch, base: git('rev-parse', 'HEAD'), defaultBranch: base, prs: [], problem: null };
  for (const n of numbers) {
    const number = Number(n);
    const d = describe(number);
    const p = { pr: number, title: d.title, headRef: d.headRef, headSha: '', status: 'pending', attempts: 0 };
    if (d.merged) Object.assign(p, { status: 'skipped', reason: 'already merged' });
    else if (d.state !== 'open') Object.assign(p, { status: 'skipped', reason: 'closed' });
    else if (!d.sameRepo) Object.assign(p, { status: 'skipped', reason: 'from a fork' });
    if (p.status === 'skipped') console.log(`[Rocket] Skipping #${number}: ${p.reason}`);
    state.prs.push(p);
  }
  save(state);
  console.log(`[Rocket] ${branch} cut from ${base} at ${state.base.slice(0, 7)}; landing ${state.prs.filter((p) => p.status === 'pending').length} PR(s)`);
  const result = loop(state);
  output('status', result);
  report(state, result);
} else if (command === 'status') {
  const state = load();
  console.log(`Release ${state.version} on ${state.branch} (cut from ${state.defaultBranch} at ${state.base.slice(0, 7)})`);
  for (const p of state.prs) console.log(`  #${p.pr} ${p.status.padEnd(7)} ${p.title}${p.sha ? ` → ${p.sha.slice(0, 7)}` : ''}${p.reason ? ` (${p.reason})` : ''}${p.attempts ? ` attempts ${p.attempts}` : ''}`);
  const p = current(state);
  if (p) console.log(`\nCurrent: #${p.pr} (${p.headRef} at ${p.headSha.slice(0, 7)}); the release branch before it was ${p.preSha.slice(0, 7)}`);
  console.log(`Problem: ${problemText(state.problem)}`);
} else if (command === 'continue') {
  const state = load();
  const p = current(state);
  if (!p) {
    report(state, loop(state));
    process.exit(0);
  }
  if (mergeHead()) {
    const unmerged = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    const left = markersLeft([...new Set([...(state.problem?.files ?? []), ...unmerged])]);
    if (left.length) {
      console.log(`[Rocket] Conflict markers are still in:\n  ${left.join('\n  ')}\nResolve them, then run continue again.`);
      report(state, 'needs-rocket');
      process.exit(0);
    }
    git('add', '-A');
    git(...IDENTITY, 'commit', '-q', '--no-edit');
    console.log(`[Rocket] Committed the resolved merge of #${p.pr}`);
  } else if (git('status', '--porcelain')) {
    git('add', '-A');
    git(...IDENTITY, 'commit', '-q', '-m', `Fix the integration of #${p.pr} for ${state.version}`, '-m', `Agent HQ release ${state.version}`);
    console.log(`[Rocket] Committed the integration fix for #${p.pr}`);
  }
  const result = check(state, p);
  if (result === 'needs-rocket') {
    p.attempts = (p.attempts ?? 0) + 1;
    save(state);
    if (p.attempts >= MAX_ATTEMPTS) console.log(`[Rocket] ${p.attempts} attempts on #${p.pr} and the checks still fail. Drop it: node .crew/scripts/rocket/land.mjs drop "<reason>"`);
    report(state, result);
    process.exit(0);
  }
  report(state, loop(state));
} else if (command === 'drop') {
  const reason = (args[0] ?? '').trim();
  if (!reason) fail('drop needs a reason the person will read');
  const state = load();
  drop(state, reason.slice(0, 300));
  report(state, loop(state));
} else if (command === 'finish') {
  const state = load();
  const p = current(state);
  if (p) {
    const why = state.problem?.kind === 'conflict' ? `conflicts in ${state.problem.files.join(', ')}` : 'the failing checks';
    drop(state, `Rocket couldn't resolve ${why} and left it out of this release`);
  }
  const result = loop(state, true);
  if (result !== 'done') fail('The unattended loop did not finish');
  if (mergeHead()) fail('A merge is still in progress');
  const changed = git('diff', '--name-only', state.base, 'HEAD').split('\n').filter(Boolean);
  const left = markersLeft(changed);
  if (left.length) fail(`Conflict markers are left in: ${left.join(', ')}`);
  const landed = state.prs.filter((x) => x.status === 'landed');
  const dropped = state.prs.filter((x) => x.status === 'dropped');
  const skipped = state.prs.filter((x) => x.status === 'skipped');
  console.log(`[Rocket] ${state.version}: landed ${landed.map((x) => `#${x.pr}`).join(', ') || 'nothing'}; dropped ${dropped.map((x) => `#${x.pr}`).join(', ') || 'nothing'}; skipped ${skipped.map((x) => `#${x.pr}`).join(', ') || 'nothing'}`);
  output('status', 'done');
  output('sha', git('rev-parse', 'HEAD'));
  output('landed', String(landed.length));
} else {
  fail('Usage: land.mjs auto | status | continue | drop "<reason>" | finish');
}
