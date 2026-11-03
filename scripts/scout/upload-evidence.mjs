/**
 * Sends a Scout run's screenshots and videos to Agent HQ, where they play inline instead of sitting in
 * a downloadable artifact.
 *
 * The run proves who it is with its GitHub Actions OIDC token (the job needs `id-token: write`), so no
 * HQ secret is stored here. HQ answers with one presigned upload URL per file, scoped to this run.
 *
 * Env: AGENT_HQ_URL, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, RUN_URL, SCOUT_AGENT_OUTCOME, SCOUT_OUT,
 * and the runner's ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN.
 * On success prints the HQ link and writes it to $GITHUB_OUTPUT as `url`.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { attachmentBytes, isCore, loadTests } from './results.mjs';

const out = process.env.SCOUT_OUT || 'scout-out';
const hq = (process.env.AGENT_HQ_URL || '').replace(/\/$/, '');
const { GITHUB_REPOSITORY: repo, PR_NUMBER, HEAD_SHA = '', RUN_URL = '', ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN } = process.env;
const pr = Number(PR_NUMBER);

function fail(message) {
  console.error(`[ScoutEvidence] ${message}`);
  process.exit(1);
}

// PR 0 is a regression run on main (SCOUT_MODE=regression); HQ files it under the repo's health.
const regression = process.env.SCOUT_MODE === 'regression';
if (!hq || !repo || (!pr && !regression)) fail('AGENT_HQ_URL, GITHUB_REPOSITORY and PR_NUMBER are required');
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

const tests = loadTests(out);
if (!tests?.length) {
  // Nothing ran (the app or Playwright failed first). Tell HQ so the mission doesn't sit in "testing".
  if (!regression) {
    await fetch(`${hq}/api/agents/qa`, { method: 'POST', headers: auth, body: JSON.stringify({ pr, sha: HEAD_SHA, runUrl: RUN_URL, state: 'error' }) }).catch(() => {});
  }
  fail('No Playwright results to send');
}

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
 * How to reproduce a failed flow: Scout's own steps when it wrote them; otherwise built from the flow's
 * step screenshots (each one a step that worked) and the exact error, so a failure is never left without.
 */
function reproFor(t) {
  if (t.status === 'passed' || t.status === 'skipped') return null;
  const bug = bugs.find((b) => sameFlow(b, t.title));
  if (bug) return { source: 'scout', ...cleanBug(bug) };
  return {
    source: 'derived',
    title: '',
    severity: 'major',
    steps: [...t.shots.map((a) => `Works: ${a.name}`), 'The next step fails (watch the end of the video)'],
    expected: '',
    actual: t.error || 'The flow failed without an assertion message; see the video and the run log.',
  };
}

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
    scope: isCore(t) ? 'core' : 'pr',
    project: t.project,
    seconds: t.seconds,
    error: t.error,
    problems: t.problems,
    repro: reproFor(t),
    shots,
    video,
  };
});

const urlRes = await fetch(`${hq}/api/evidence/upload-urls`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ repo, pr, files: files.map((f) => f.name) }),
});
if (!urlRes.ok) fail(`HQ refused upload URLs (${urlRes.status}): ${(await urlRes.text()).slice(0, 300)}`);
const { urls } = await urlRes.json();
const byName = new Map(urls.map((u) => [u.name, u]));

// Upload a few at a time; videos are the large ones.
let next = 0;
async function worker() {
  while (next < files.length) {
    const f = files[next++];
    const res = await fetch(byName.get(f.name).url, { method: 'PUT', body: attachmentBytes(f.attachment), headers: { 'content-type': f.type } });
    if (!res.ok) fail(`Upload of ${f.name} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

const summaryPath = `${out}/summary.md`;
const manifest = {
  repo,
  pr,
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
  tests: manifestTests.map((t) => ({
    ...t,
    shots: t.shots.map((s) => ({ name: s.name, pathname: byName.get(s.file).pathname })),
    video: t.video ? byName.get(t.video).pathname : null,
  })),
};
const manRes = await fetch(`${hq}/api/evidence/manifest`, { method: 'POST', headers: auth, body: JSON.stringify(manifest) });
if (!manRes.ok) fail(`HQ refused the manifest (${manRes.status}): ${(await manRes.text()).slice(0, 300)}`);
const { mission } = await manRes.json();

const link = regression ? `${hq}/#health` : `${hq}/#evidence=${encodeURIComponent(mission)}`;
console.log(`[ScoutEvidence] Sent ${files.length} files for ${tests.length} flows: ${link}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${link}\n`);
