/**
 * Sends a production probe's result to Agent HQ (`POST /api/agents/probe`), authenticated with the job's
 * GitHub OIDC token. Reads Playwright's `probe-out/results.json`; with none (the probe never ran), reports
 * the run as broken so HQ shows that rather than a stale "up".
 *
 * Env: GITHUB_REPOSITORY, PROBE_BASE_URL, RUN_URL, GITHUB_SHA, AGENT_HQ_URL, ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN.
 * Exits 1 when any probe failed, so the run shows red.
 */
import { existsSync, readFileSync } from 'node:fs';

const out = process.env.PROBE_OUT || 'probe-out';
const hq = (process.env.AGENT_HQ_URL || 'https://agent-hq-cyan.vercel.app').replace(/\/$/, '');
const repo = process.env.GITHUB_REPOSITORY;

function fail(message) {
  console.error(`[Probe] ${message}`);
  process.exit(1);
}

async function idToken() {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: token } = process.env;
  if (!url || !token) fail('No GitHub OIDC token available; the job needs `permissions: id-token: write`');
  const res = await fetch(`${url}&audience=agent-hq`, { headers: { Authorization: `bearer ${token}` } });
  if (!res.ok) fail(`GitHub refused an OIDC token (${res.status})`);
  return (await res.json()).value;
}

function collect(suite, path = []) {
  const here = suite.title && !suite.title.endsWith('.ts') ? [...path, suite.title] : path;
  const rows = (suite.specs || []).flatMap((spec) =>
    spec.tests.map((t) => {
      const result = t.results[t.results.length - 1] || {};
      return {
        title: [...here, spec.title].join(' › ').slice(0, 200),
        status: result.status || 'skipped',
        seconds: Math.round((result.duration || 0) / 1000),
        attempts: t.results.length,
        error: (result.error?.message || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 300),
      };
    }),
  );
  return rows.concat((suite.suites || []).flatMap((s) => collect(s, here)));
}

const resultsPath = `${out}/results.json`;
const tests = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')).suites.flatMap((s) => collect(s)) : null;
const passed = tests ? tests.filter((t) => t.status === 'passed').length : 0;
const failed = tests ? tests.filter((t) => t.status !== 'passed' && t.status !== 'skipped').length : 0;

const report = {
  repo,
  baseUrl: process.env.PROBE_BASE_URL || '',
  sha: process.env.GITHUB_SHA || '',
  runUrl: process.env.RUN_URL || '',
  state: tests === null ? 'error' : failed ? 'down' : 'up',
  passed,
  failed,
  total: tests ? tests.length : 0,
  tests: (tests ?? []).slice(0, 40),
};

const res = await fetch(`${hq}/api/agents/probe`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${await idToken()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(report),
});
const text = await res.text();
if (!res.ok) fail(`HQ answered ${res.status}: ${text.slice(0, 300)}`);
console.log(`[Probe] ${report.state}: ${passed} of ${report.total} probes passed on ${report.baseUrl}; told HQ`);
if (tests === null) fail('The probe produced no results (see the steps above)');
if (failed) {
  for (const t of tests.filter((t) => t.status !== 'passed' && t.status !== 'skipped')) console.error(`  ✗ ${t.title}: ${t.error}`);
  process.exit(1);
}
