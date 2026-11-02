/**
 * Decides whether main is due for a Scout regression run, without any AI. Due when, since the last
 * regression run started:
 *   - any merged PR was labelled impact:critical, or
 *   - at least 10 PRs merged, or
 *   - at least 7 days passed and something merged.
 * Prints the decision and writes `due` and `reason` to $GITHUB_OUTPUT.
 *
 * Env: GH_TOKEN, GITHUB_REPOSITORY. Uses the `gh` CLI.
 */
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const repo = process.env.GITHUB_REPOSITORY;
const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const DAY = 24 * 60 * 60 * 1000;

const runs = gh(`repos/${repo}/actions/workflows/scout-qa.yml/runs?per_page=100`).workflow_runs ?? [];
const regressions = runs.filter((r) => r.display_title === 'Scout regression on main');
const active = regressions.find((r) => r.status !== 'completed');
const last = regressions[0];

function decide() {
  if (active) return { due: false, reason: `a regression run is already in progress (${active.html_url})` };
  if (!last) return { due: true, reason: 'no regression run yet' };
  const since = last.created_at;
  const merged = gh(`search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged merged:>${since}`)}&per_page=100`).items ?? [];
  const critical = merged.filter((pr) => pr.labels.some((l) => l.name === 'impact:critical'));
  const days = (Date.now() - Date.parse(since)) / DAY;
  if (critical.length)
    return { due: true, reason: `${critical.length} critical PR(s) merged since the last run: ${critical.map((p) => `#${p.number}`).join(', ')}` };
  if (merged.length >= 10) return { due: true, reason: `${merged.length} PRs merged since the last run` };
  if (days >= 7 && merged.length) return { due: true, reason: `${Math.floor(days)} days and ${merged.length} merged PR(s) since the last run` };
  return { due: false, reason: `${merged.length} PR(s) merged, none critical, ${days.toFixed(1)} days since the last run` };
}

const { due, reason } = decide();
console.log(`[RegressionDue] ${due ? 'Due' : 'Not due'}: ${reason}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\nreason=${reason.replace(/\n/g, ' ')}\n`);
