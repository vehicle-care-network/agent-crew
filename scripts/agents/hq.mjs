/**
 * Talks to Agent HQ from an agent workflow. Authenticates with the job's GitHub OIDC token (the job
 * needs `permissions: id-token: write`), so this repo holds no HQ secret.
 *
 *   node .crew/scripts/agents/hq.mjs status <missionId> <agent> "<what I'm doing>"
 *   node .crew/scripts/agents/hq.mjs report <missionId> '<report json>'
 *   node .crew/scripts/agents/hq.mjs upload <missionId> <file>     # prints the stored pathname
 *   node .crew/scripts/agents/hq.mjs ideas-known                   # fingerprints HQ already has (JSON)
 *   node .crew/scripts/agents/hq.mjs ideas-post <file> <scope>     # sends Radar's ideas
 *   node .crew/scripts/agents/hq.mjs github-token                  # prints a token to push as the HQ App (Bolt, Patch)
 *   node .crew/scripts/agents/hq.mjs qa running|error              # Scout: the run started / broke before results (env PR_NUMBER, HEAD_SHA, RUN_URL)
 *   node .crew/scripts/agents/hq.mjs model <agent>                 # prints the model chosen for the agent in HQ (empty when none; never fails)
 *
 * Env: AGENT_HQ_URL (default https://agent-hq-cyan.vercel.app), ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const hq = (process.env.AGENT_HQ_URL || 'https://agent-hq-cyan.vercel.app').replace(/\/$/, '');
const [command, missionId, ...rest] = process.argv.slice(2);

function fail(message) {
  console.error(`[AgentHq] ${message}`);
  process.exit(1);
}

async function idToken() {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: token } = process.env;
  if (!url || !token) fail('No GitHub OIDC token available; the job needs `permissions: id-token: write`');
  const res = await fetch(`${url}&audience=agent-hq`, { headers: { Authorization: `bearer ${token}` } });
  if (!res.ok) fail(`GitHub refused an OIDC token (${res.status})`);
  return (await res.json()).value;
}

async function post(path, body) {
  const res = await fetch(`${hq}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await idToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`HQ answered ${res.status} for ${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

if (command === 'model') {
  // The model you picked for this agent in HQ (Spend › Models). Prints nothing when none is saved or HQ
  // can't be reached, so the workflow falls back to its repo variable and default. Never fails the job.
  const agent = missionId;
  let model = '';
  try {
    const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: token } = process.env;
    const oidc = await fetch(`${url}&audience=agent-hq`, { headers: { Authorization: `bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const res = await fetch(`${hq}/api/agents/config`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${(await oidc.json()).value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent }),
      signal: AbortSignal.timeout(15000),
    });
    const chosen = res.ok ? String((await res.json()).model || '') : '';
    if (/^claude-[a-z0-9-]+$/.test(chosen)) model = chosen;
  } catch {
    // fall through: no choice
  }
  console.error(`[AgentHq] Model from Agent HQ for ${agent}: ${model || 'none saved'}`);
  process.stdout.write(model);
  process.exit(0);
}
if (command === 'ideas-known') {
  console.log(JSON.stringify((await post('/api/agents/ideas', { action: 'known' })).fingerprints));
  process.exit(0);
}
if (command === 'github-token') {
  // Only agent-bolt.yml and agent-patch.yml on the default branch get one (HQ checks the OIDC job_workflow_ref).
  process.stdout.write((await post('/api/agents/github-token', {})).token);
  process.exit(0);
}
if (command === 'qa') {
  // Scout: `qa running` when the run starts, `qa error` when it ends without results. The outcome itself
  // goes with the evidence manifest (upload-evidence.mjs). Env: PR_NUMBER, HEAD_SHA, RUN_URL.
  const state = missionId;
  const pr = Number(process.env.PR_NUMBER);
  if (!pr) fail('qa needs PR_NUMBER');
  const res = await post('/api/agents/qa', { pr, sha: process.env.HEAD_SHA || '', runUrl: process.env.RUN_URL || '', state });
  console.log(`[AgentHq] Told HQ Scout is ${state} on #${pr} (mission ${res.mission})`);
  process.exit(0);
}
if (command === 'ideas-post') {
  const [file, scope] = [missionId, rest[0]];
  const ideas = JSON.parse(readFileSync(file, 'utf8'));
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const res = await post('/api/agents/ideas', { action: 'post', scope, runUrl, ideas });
  console.log(`[AgentHq] Sent ${ideas.length} ideas; ${res.added} new`);
  process.exit(0);
}

if (!missionId) fail('Usage: hq.mjs <status|report|upload> <missionId> ... | ideas-known | ideas-post <file> <scope> | github-token');

if (command === 'status') {
  const [agent, say] = rest;
  await post('/api/agents/report', { missionId, report: { agent, type: 'status', say: String(say ?? '').slice(0, 200) } });
} else if (command === 'report') {
  await post('/api/agents/report', { missionId, report: JSON.parse(rest[0]) });
  console.log('[AgentHq] Reported to HQ');
} else if (command === 'upload') {
  const file = rest[0];
  const { url, pathname, contentType } = await post('/api/agents/upload-url', { missionId, name: basename(file) });
  const res = await fetch(url, { method: 'PUT', body: readFileSync(file), headers: { 'content-type': contentType } });
  if (!res.ok) fail(`Upload of ${file} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  console.log(pathname);
} else {
  fail(`Unknown command ${command}`);
}
