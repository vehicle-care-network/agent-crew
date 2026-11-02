/**
 * Builds Scout's PR comment and posts it, updating the previous Scout comment in place.
 *
 * Pass/fail comes from Playwright's `results.json`, never from the agent: Scout's own notes
 * (`summary.md`) are shown beside the results, not instead of them.
 *
 *   node .crew/scripts/scout/report.mjs --status running   # "Scout is testing" placeholder
 *   node .crew/scripts/scout/report.mjs                    # final report
 *   node .crew/scripts/scout/report.mjs --dry-run          # print the markdown instead of posting
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, RUN_URL, SCOUT_OUT (default scout-out),
 * SCOUT_AGENT_OUTCOME, HQ_EVIDENCE_URL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isCore, loadTests } from './results.mjs';

const MARKER = '<!-- scout-qa -->';
const out = process.env.SCOUT_OUT || 'scout-out';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const running = args.includes('--status') && args[args.indexOf('--status') + 1] === 'running';
const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA = '', RUN_URL = '' } = process.env;
/** `steps.scout.outcome` from the workflow: 'failure' when the agent step itself failed (e.g. no API key). */
const agentFailed = process.env.SCOUT_AGENT_OUTCOME === 'failure';
/** Link to this run in Agent HQ, set when `upload-evidence.mjs` succeeded. */
const HQ_EVIDENCE_URL = process.env.HQ_EVIDENCE_URL || '';
/** Impact tier from Radar's risk map; `low` PRs get the smoke flows only, by design, with no agent. */
const TIER = process.env.SCOUT_TIER || '';

/** Type errors in the PR's own files (the workflow's "Check the build" step). They come before everything else. */
function buildSection() {
  const path = `${out}/build-errors.txt`;
  if (!existsSync(path)) return '';
  const errors = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  return [
    `**Build fails: ${errors.length} type error${errors.length === 1 ? '' : 's'} in files this PR changed.** Vercel can't deploy it, so Scout skipped testing the flows; only the smoke flows ran. Fix these first:`,
    '```',
    errors.slice(0, 30).join('\n').slice(0, 6000),
    '```',
    '',
  ].join('\n');
}

function finalBody() {
  const build = buildSection();
  if (build) return `${build}\n${baseBody()}`;
  return baseBody();
}

function baseBody() {
  const tests = loadTests(out);
  if (!tests) {
    return `### Scout couldn't produce results\nNo Playwright results were written, so the app or the test run failed before any flow ran. See the [run log](${RUN_URL}).`;
  }
  const passed = tests.filter((t) => t.status === 'passed').length;
  const failed = tests.filter((t) => t.status === 'failed' || t.status === 'timedOut');
  const prTests = tests.filter((t) => !isCore(t));
  const counts = failed.length ? `**${failed.length} of ${tests.length} flows failed**` : `**All ${tests.length} flows passed**`;
  // Core smoke flows passing says the app starts, not that this PR works. Never let them stand in for
  // PR coverage: say plainly when the agent failed or wrote no PR-specific flows.
  const smokeOnlyByDesign = TIER === 'low' && prTests.length === 0 && !agentFailed;
  const headline = smokeOnlyByDesign
    ? `${counts} · smoke only, by design: this PR only changes docs, tests or tooling (impact: low)`
    : agentFailed
      ? `**Scout's agent didn't run, so nothing specific to this PR was tested.** Only the core smoke flows ran. See the [run log](${RUN_URL}).\n\n${counts.replace(/\*\*/g, '')} (core only)`
      : prTests.length === 0
        ? `**No flows specific to this PR were tested.** Only the core smoke flows ran; Scout's notes should say why.\n\n${counts.replace(/\*\*/g, '')} (core only)`
        : counts;

  const icon = (s) => (s === 'passed' ? '✅' : s === 'skipped' ? '⏭️' : '❌');
  const rows = tests
    .map((t) => {
      const where = isCore(t) ? 'core' : 'this PR';
      const notes = [t.error && `\`${t.error.slice(0, 140)}\``, t.problems.length && `${t.problems.length} console/server error(s)`]
        .filter(Boolean)
        .join('<br>');
      return `| ${icon(t.status)} | ${t.title}${t.project === 'mobile' ? ' (mobile)' : ''} | ${where} | ${t.shots.length} | ${t.seconds}s | ${notes || ''} |`;
    })
    .join('\n');

  const problemDetails = tests
    .filter((t) => t.problems.length)
    .map((t) => `**${t.title}**\n\`\`\`\n${t.problems.slice(0, 6).join('\n').slice(0, 1500)}\n\`\`\``)
    .join('\n');

  const summaryPath = `${out}/summary.md`;
  const notes = existsSync(summaryPath)
    ? readFileSync(summaryPath, 'utf8').trim()
    : "_Scout didn't write notes for this run. Results above come straight from Playwright._";

  return [
    smokeOnlyByDesign || agentFailed || prTests.length === 0 ? headline : `${headline} · ${passed} passed`,
    '',
    '| | Flow | Scope | Shots | Time | Notes |',
    '|---|---|---|---|---|---|',
    rows,
    '',
    "### Scout's notes",
    notes,
    problemDetails && `\n<details><summary>Console and server errors seen during the run</summary>\n\n${problemDetails}\n</details>`,
    '',
    HQ_EVIDENCE_URL
      ? `**Evidence:** [▶ Watch the screenshots and video for every flow in Agent HQ](${HQ_EVIDENCE_URL}). The raw files and the Playwright report are also in the [run's artifacts](${RUN_URL}#artifacts).`
      : `**Evidence:** step screenshots, a video of every flow, and the full Playwright report are in the [run's artifacts](${RUN_URL}#artifacts) (\`scout-evidence\`).`,
  ].join('\n');
}

const header = `${MARKER}\n## Scout QA${HEAD_SHA ? ` · \`${HEAD_SHA.slice(0, 7)}\`` : ''}\n`;
const footer =
  "\n\n<sub>Scout ran this PR's code on Firebase emulators with seeded demo data (project `demo-scout`). " +
  'No staging or production data was read or written. Comment `/scout` to re-run, or `/scout <what to focus on>`.</sub>';
const body = header + (running ? `Scout is testing this PR now. [Watch the run](${RUN_URL}).` : finalBody()) + footer;

if (dryRun) {
  console.log(body);
  process.exit(0);
}

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !PR_NUMBER) {
  console.error('[ScoutReport] GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required (or pass --dry-run).');
  process.exit(1);
}

const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;
const headers = { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

const comments = await (await fetch(`${api}/issues/${PR_NUMBER}/comments?per_page=100`, { headers })).json();
const existing = Array.isArray(comments) ? comments.find((c) => c.body?.startsWith(MARKER)) : undefined;
const res = await fetch(existing ? `${api}/issues/comments/${existing.id}` : `${api}/issues/${PR_NUMBER}/comments`, {
  method: existing ? 'PATCH' : 'POST',
  headers,
  body: JSON.stringify({ body }),
});
if (!res.ok) {
  console.error(`[ScoutReport] GitHub API returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
console.log(`[ScoutReport] ${existing ? 'Updated' : 'Posted'} the Scout comment on PR #${PR_NUMBER}`);
