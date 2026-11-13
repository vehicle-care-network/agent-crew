/**
 * Sends a Scout run's screenshots and videos to Agent HQ, where they play inline instead of sitting in
 * a downloadable artifact.
 *
 * The run proves who it is with its GitHub Actions OIDC token (the job needs `id-token: write`), so no
 * HQ secret is stored here. HQ answers with one presigned upload URL per file, scoped to this run.
 *
 * Env: AGENT_HQ_URL, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, RUN_URL, SCOUT_AGENT_OUTCOME, SCOUT_OUT,
 * SCOUT_ONLY (flow titles re-run on HQ's request, one per line), and the runner's
 * ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN.
 * On success prints the HQ link and writes it to $GITHUB_OUTPUT as `url`.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { attachmentBytes, loadTests, scopeOf } from './results.mjs';
import { parseOnly } from './steps.mjs';

const out = process.env.SCOUT_OUT || 'scout-out';
const hq = (process.env.AGENT_HQ_URL || '').replace(/\/$/, '');
const { GITHUB_REPOSITORY: repo, PR_NUMBER, HEAD_SHA = '', RUN_URL = '', ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN } = process.env;
const pr = Number(PR_NUMBER);

function fail(message) {
  console.error(`[ScoutEvidence] ${message}`);
  process.exit(1);
}

// PR 0 is a run with no PR: a regression run on main (SCOUT_MODE=regression), which HQ files under the
// repo's health, or a run that belongs to the HQ mission that started it (MISSION_ID): a smoke test
// (SCOUT_MODE=smoke), or a regression run on a release branch. A coverage run (SCOUT_MODE=coverage) is a
// regression run that also wrote specs for core flows that had none; HQ opens a PR with them.
const coverage = process.env.SCOUT_MODE === 'coverage';
const regression = process.env.SCOUT_MODE === 'regression' || coverage;
const smokeMission = process.env.SCOUT_MODE === 'smoke' || regression ? process.env.MISSION_ID || '' : '';
if (!hq || !repo || (!pr && !regression && !smokeMission)) fail('AGENT_HQ_URL, GITHUB_REPOSITORY and PR_NUMBER (or MISSION_ID for a smoke test) are required');
// SCOUT_HQ_TOKEN is for local testing against `next dev` only (see agent-hq lib/github/oidc.ts).
if (!process.env.SCOUT_HQ_TOKEN && (!ACTIONS_ID_TOKEN_REQUEST_URL || !ACTIONS_ID_TOKEN_REQUEST_TOKEN)) {
  fail('No GitHub OIDC token available; the job needs `permissions: id-token: write`');
}

async function githubIdToken() {
  const res = await fetch(`${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=agent-hq`, {
    headers: { Authorization: `bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!res.ok) fail(`GitHub refused an OIDC token (${res.status})`);
  return (await res.json()).value;
}
const idToken = process.env.SCOUT_HQ_TOKEN || (await githubIdToken());
const auth = { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' };

/** Fails the step, first telling HQ the run broke so the mission doesn't sit in "testing" with no result. */
async function failAndTellHq(message) {
  if (!regression || smokeMission) {
    const body = { pr, ...(smokeMission ? { missionId: smokeMission } : {}), sha: HEAD_SHA, runUrl: RUN_URL, state: 'error' };
    await fetch(`${hq}/api/agents/qa`, { method: 'POST', headers: auth, body: JSON.stringify(body) }).catch(() => {});
  }
  fail(message);
}

const tests = loadTests(out);
// Nothing ran (the app or Playwright failed first).
if (!tests?.length) await failAndTellHq('No Playwright results to send');

// Type errors in the PR's own files (the workflow's "Check the build" step): the flows were skipped.
const buildErrorsPath = `${out}/build-errors.txt`;
const buildErrors = existsSync(buildErrorsPath) ? readFileSync(buildErrorsPath, 'utf8').split('\n').filter(Boolean).length : 0;

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

// Scout's structured bug reports (PROMPT.md step 7). Each names the flow it belongs to.
const bugsPath = `${out}/bugs.json`;
let bugs = [];
try {
  bugs = existsSync(bugsPath) ? JSON.parse(readFileSync(bugsPath, 'utf8')) : [];
  if (!Array.isArray(bugs)) bugs = [];
} catch {
  console.error('[ScoutEvidence] bugs.json is not valid JSON; falling back to steps derived from the flows');
}
const cleanBug = (b) => ({
  flow: String(b.flow ?? ''),
  title: String(b.title ?? '').slice(0, 160),
  severity: ['critical', 'major', 'minor'].includes(b.severity) ? b.severity : 'major',
  steps: (Array.isArray(b.steps) ? b.steps : []).slice(0, 15).map((x) => String(x).slice(0, 300)),
  expected: String(b.expected ?? '').slice(0, 500),
  actual: String(b.actual ?? '').slice(0, 500),
});
const sameFlow = (bug, title) => !!bug.flow && (bug.flow === title || title.endsWith(bug.flow) || bug.flow.endsWith(title));

/**
 * How to reproduce a failed flow: Scout's own steps when it wrote them; otherwise built from what the
 * flow actually did (the recorded actions, in plain words), the check it was on when it failed, and the
 * exact error, so a failure is never left without. Runs without recorded steps fall back to the step
 * screenshots (each one a step that worked).
 */
function reproFor(t) {
  if (t.status === 'passed' || t.status === 'skipped') return null;
  const bug = bugs.find((b) => sameFlow(b, t.title));
  if (bug) return { source: 'scout', ...cleanBug(bug) };
  const steps = t.steps ?? [];
  const failedAt = steps.findIndex((s) => !s.ok);
  const upTo = failedAt >= 0 ? steps.slice(0, failedAt) : steps;
  const failing = failedAt >= 0 ? steps[failedAt] : null;
  const actions = upTo.filter((s) => s.kind === 'action' || s.kind === 'step').map((s) => s.text);
  const timedOut = t.status === 'timedOut';
  if (actions.length || failing) {
    const expected = failing?.kind === 'check' ? failing.text.replace(/^Check that /, '') : '';
    const where = failing ? (failing.kind === 'check' ? `Then look for this: ${failing.text.replace(/^Check that /, '')}` : `Then: ${failing.text}`) : 'Then watch the end of the video.';
    return {
      source: 'derived',
      title: '',
      severity: 'major',
      steps: [...actions.slice(0, 14), where].slice(0, 15),
      expected,
      actual: [timedOut ? `Time ran out (${t.seconds}s) ${failing ? `at: ${failing.text}` : 'before the flow finished'}.` : '', t.error || (failing?.error ?? '')].filter(Boolean).join(' ').slice(0, 500) || 'The flow failed without an assertion message; see the video and the run log.',
    };
  }
  return {
    source: 'derived',
    title: '',
    severity: 'major',
    steps: [...t.shots.map((a) => `Works: ${a.name}`), 'The next step fails (watch the end of the video)'],
    expected: '',
    actual: t.error || 'The flow failed without an assertion message; see the video and the run log.',
  };
}

/** The recorded steps as HQ stores them: what happened, in order, trimmed to what fits in the run document. */
const compactSteps = (t) =>
  (t.steps ?? []).slice(0, 40).map((s) => ({
    kind: s.kind,
    text: s.text,
    ok: s.ok,
    ms: s.ms,
    ...(s.depth ? { depth: s.depth } : {}),
    ...(s.error ? { error: String(s.error).slice(0, 400) } : {}),
    ...(s.unfinished ? { unfinished: true } : {}),
    ...(s.raw && s.raw !== s.text ? { raw: String(s.raw).slice(0, 160) } : {}),
  }));

// The flows HQ asked Scout to re-run (SCOUT_ONLY, one title per line): HQ folds these results into the
// previous run's, so the PR's verdict still covers every flow.
const only = parseOnly(process.env.SCOUT_ONLY);

// One folder per test; step screenshots in order, falling back to Playwright's final screenshot. A failed
// flow also gets Playwright's screenshot from the moment it failed, as its last step.
const files = [];
const manifestTests = tests.map((t, i) => {
  const dir = `${String(i + 1).padStart(2, '0')}-${slug(t.title)}-${t.project}`;
  const failed = t.status !== 'passed' && t.status !== 'skipped';
  const steps = t.shots.length
    ? [...t.shots, ...(failed && t.finalShot ? [{ ...t.finalShot, name: 'where it failed' }] : [])]
    : t.finalShot
      ? [{ ...t.finalShot, name: failed ? 'where it failed' : 'final state' }]
      : [];
  const shots = steps.map((a, j) => {
    const name = `${dir}/${j + 1}-${slug(a.name) || 'step'}.png`;
    files.push({ name, attachment: a, type: 'image/png' });
    return { name: a.name, file: name };
  });
  let video = null;
  if (t.video && existsSync(t.video.path)) {
    video = `${dir}/video.webm`;
    files.push({ name: video, attachment: t.video, type: 'video/webm' });
  }
  return {
    title: t.title,
    status: t.status,
    scope: scopeOf(t),
    // The spec it came from, relative to e2e/scout: what "Keep this flow" promotes.
    file: String(t.file || '').slice(0, 200),
    project: t.project,
    seconds: t.seconds,
    error: t.error,
    problems: t.problems,
    repro: reproFor(t),
    steps: compactSteps(t),
    shots,
    video,
  };
});

/**
 * The specs this run wrote, sent along with the evidence so HQ keeps them past the artifact's 30 days:
 * on a PR, Scout's own specs and seeds (`pr-<n>-*`, `_seed/`), which "Keep this flow" in HQ promotes into
 * the repo; on a coverage run, every file it added or changed under the committed suites and the flow
 * guidance, which HQ opens as a PR. Sources only: small text files, at most 60 of them.
 */
function specFiles() {
  const list = [];
  const add = (path) => {
    if (list.length >= 60 || !existsSync(path) || !/\.(ts|mjs|md)$/.test(path)) return;
    const size = statSync(path).size;
    if (size > 0 && size <= 96 * 1024) list.push({ path, name: `specs/${path}` });
  };
  if (coverage) {
    let changed = '';
    try {
      changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'e2e/scout/core', 'e2e/scout/features', '.github/scout'], { encoding: 'utf8' });
    } catch {
      changed = '';
    }
    for (const line of changed.split('\n')) {
      const path = line.slice(3).trim().replace(/^"|"$/g, '');
      if (path) add(path);
    }
  } else if (pr && existsSync('e2e/scout')) {
    for (const f of readdirSync('e2e/scout')) if (f.startsWith(`pr-${pr}-`)) add(`e2e/scout/${f}`);
    if (existsSync('e2e/scout/_seed')) for (const f of readdirSync('e2e/scout/_seed')) add(`e2e/scout/_seed/${f}`);
  }
  return list;
}
const specs = specFiles();
for (const s of specs) files.push({ name: s.name, attachment: { path: s.path }, type: 'text/plain' });

const urlRes = await fetch(`${hq}/api/evidence/upload-urls`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ repo, pr, files: files.map((f) => f.name) }),
});
if (!urlRes.ok) await failAndTellHq(`HQ refused upload URLs (${urlRes.status}): ${(await urlRes.text()).slice(0, 300)}`);
const { urls } = await urlRes.json();
const byName = new Map(urls.map((u) => [u.name, u]));

// Upload a few at a time; videos are the large ones. Vercel Blob reads the type from `x-content-type`;
// without it Blob guesses from the extension, and a `.ts` spec is guessed as video/mp2t and refused.
// A spec that still fails to upload is left out of the manifest: losing it must not lose Scout's verdict.
let next = 0;
const specNames = new Set(specs.map((s) => s.name));
const lostSpecs = new Set();
async function worker() {
  while (next < files.length) {
    const f = files[next++];
    const res = await fetch(byName.get(f.name).url, { method: 'PUT', body: attachmentBytes(f.attachment), headers: { 'content-type': f.type, 'x-content-type': f.type } });
    if (res.ok) continue;
    const why = `Upload of ${f.name} failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
    if (!specNames.has(f.name)) await failAndTellHq(why);
    lostSpecs.add(f.name);
    console.log(`::warning::[ScoutEvidence] ${why}. HQ won't have this spec, so "Keep this flow" can't use it.`);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
const sentSpecs = specs.filter((s) => !lostSpecs.has(s.name));

const summaryPath = `${out}/summary.md`;
const manifest = {
  repo,
  pr,
  ...(smokeMission ? { missionId: smokeMission } : {}),
  sha: HEAD_SHA,
  runUrl: RUN_URL,
  summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '',
  // Bugs Scout found that no failing flow covers (spotted while exploring), shown at the top of the run.
  bugs: bugs
    .filter((b) => !tests.some((t) => sameFlow(b, t.title) && t.status !== 'passed'))
    .slice(0, 10)
    .map(cleanBug),
  agentRan: process.env.SCOUT_AGENT_OUTCOME !== 'failure',
  // HQ decides the PR's QA result from these, the same way report.mjs words the comment.
  buildErrors,
  tier: process.env.SCOUT_TIER || '',
  ...(only.length ? { only } : {}),
  ...(coverage ? { coverage: true } : {}),
  // What this run was asked to do beyond the diff, so the viewer can show it next to the flows.
  ...(process.env.SCOUT_PLAN ? { plan: String(process.env.SCOUT_PLAN).slice(0, 2000) } : {}),
  ...(process.env.SCOUT_AREAS ? { areas: String(process.env.SCOUT_AREAS).split(',').filter(Boolean).slice(0, 20) } : {}),
  specs: sentSpecs.map((s) => ({ path: s.path, pathname: byName.get(s.name).pathname })),
  tests: manifestTests.map((t) => ({
    ...t,
    shots: t.shots.map((s) => ({ name: s.name, pathname: byName.get(s.file).pathname })),
    video: t.video ? byName.get(t.video).pathname : null,
  })),
};
const manRes = await fetch(`${hq}/api/evidence/manifest`, { method: 'POST', headers: auth, body: JSON.stringify(manifest) });
if (!manRes.ok) await failAndTellHq(`HQ refused the manifest (${manRes.status}): ${(await manRes.text()).slice(0, 300)}`);
const { mission } = await manRes.json();

const link = regression && !smokeMission ? `${hq}/#health` : `${hq}/#evidence=${encodeURIComponent(mission)}`;
console.log(`[ScoutEvidence] Sent ${files.length} files for ${tests.length} flows${sentSpecs.length ? ` and ${sentSpecs.length} spec file${sentSpecs.length === 1 ? '' : 's'}` : ''}${only.length ? ` (re-ran ${only.length}; HQ keeps the rest from the previous run)` : ''}: ${link}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${link}\n`);
