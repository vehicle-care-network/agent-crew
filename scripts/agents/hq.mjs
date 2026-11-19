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
 *   node .crew/scripts/agents/hq.mjs qa running|error              # Scout: the run started / broke before results (env PR_NUMBER, HEAD_SHA, RUN_URL; MISSION_ID for a smoke test)
 *   node .crew/scripts/agents/hq.mjs model <agent>                 # prints the model chosen for the agent in HQ (empty when none; never fails)
 *   node .crew/scripts/agents/hq.mjs specs-pull                    # Scout in a sandbox: the specs HQ kept from this PR's previous run (env PR_NUMBER) or for this saved smoke test (env SCENARIO_ID), into e2e/scout; prints the count
 *   node .crew/scripts/agents/hq.mjs fakes-pull <dir>              # Scout: the repo's fake services from HQ's Fakes page, one <name>.json each; prints the count (never fails)
 *   node .crew/scripts/agents/hq.mjs fake-post <fakeId> <file>     # Radar: the fake it drafted from the code
 *   node .crew/scripts/agents/hq.mjs fake-fail <fakeId> "<why>"    # Radar: the draft didn't come out
 *   node .crew/scripts/agents/hq.mjs diagnosis-post <repairId> <file>   # Radar: why a run broke, and where the fix belongs
 *   node .crew/scripts/agents/hq.mjs diagnosis-fail <repairId> "<why>"  # Radar: no diagnosis came out
 *
 * Env: AGENT_HQ_URL (your HQ's address), ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN.
 *
 * Without AGENT_HQ_URL the crew runs on its own (Iris, Scout and Radar from the repo's own events): reads
 * answer "nothing", Scout's check-in is skipped, ideas are listed in the run's summary, and anything that
 * belongs to a mission fails with what to set, since a mission only exists in HQ.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const hq = (process.env.AGENT_HQ_URL || '').replace(/\/$/, '');
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

if (!hq) {
  // No Agent HQ: nothing to ask and nobody to tell.
  if (command === 'model') process.exit(0);
  if (command === 'ideas-known') {
    console.log('[]');
    process.exit(0);
  }
  if (command === 'specs-pull' || command === 'fakes-pull') {
    console.log(0);
    process.exit(0);
  }
  if (command === 'qa' && !process.env.MISSION_ID) {
    console.error('[AgentHq] No Agent HQ set (AGENT_HQ_URL); Scout reports on the PR only');
    process.exit(0);
  }
  if (command === 'ideas-post') {
    // The ideas would go to HQ's inbox; without one, list them where the person who started the run looks.
    const ideas = JSON.parse(readFileSync(missionId, 'utf8'));
    const lines = ideas.map((i) => `- **${i.title ?? 'Untitled'}**${i.why ? `: ${String(i.why).split('\n')[0]}` : ''}`);
    console.log(`[AgentHq] No Agent HQ set (AGENT_HQ_URL); ${ideas.length} idea(s) listed in the run's summary`);
    for (const line of lines) console.log(`  ${line}`);
    if (process.env.GITHUB_STEP_SUMMARY && lines.length) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Ideas from this run\n\n${lines.join('\n')}\n`);
    process.exit(0);
  }
  fail(
    `AGENT_HQ_URL is not set, and \`${command}\` belongs to an Agent HQ mission. Set the repository (or organization) variable ` +
      'AGENT_HQ_URL to your HQ\'s address: gh variable set AGENT_HQ_URL --body https://your-hq.example',
  );
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
if (command === 'fakes-pull') {
  // The fakes kept for this repo in HQ (its Fakes page), for start-env.sh to run. The repo's own
  // .github/scout/fakes/*.json are laid over them there. An HQ that can't be reached, or one from before
  // fakes existed, means no fakes from HQ: the run goes on with the repo's own.
  const dir = missionId || 'scout-out/fakes/hq';
  let written = 0;
  try {
    const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: token } = process.env;
    const oidc = await fetch(`${url}&audience=agent-hq`, { headers: { Authorization: `bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const res = await fetch(`${hq}/api/agents/fakes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${(await oidc.json()).value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pull' }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HQ answered ${res.status}`);
    mkdirSync(dir, { recursive: true });
    for (const fake of (await res.json()).fakes ?? []) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(String(fake?.name ?? ''))) continue;
      writeFileSync(`${dir}/${fake.name}.json`, JSON.stringify(fake, null, 2));
      written++;
    }
    console.error(`[AgentHq] ${written ? `${written} fake service(s) from HQ` : 'No fake services kept in HQ for this repo'}`);
  } catch (error) {
    console.error(`::warning::[AgentHq] Couldn't read the fake services from HQ (${error instanceof Error ? error.message : error}); using the repo's own only`);
  }
  console.log(written);
  process.exit(0);
}
if (command === 'fake-post' || command === 'fake-fail') {
  const id = missionId;
  if (!id) fail(`${command} needs the fake's id`);
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : process.env.RUN_URL || '';
  if (command === 'fake-post') {
    const definition = JSON.parse(readFileSync(rest[0], 'utf8'));
    await post('/api/agents/fakes', { action: 'draft', id, definition, runUrl });
    console.log(`[AgentHq] Sent the ${definition.name} fake to HQ: ${definition.routes?.length ?? 0} route(s)`);
  } else {
    await post('/api/agents/fakes', { action: 'failed', id, error: String(rest[0] ?? '').slice(0, 400), runUrl });
    console.log('[AgentHq] Told HQ the draft failed');
  }
  process.exit(0);
}
if (command === 'diagnosis-post' || command === 'diagnosis-fail') {
  const id = missionId;
  if (!id) fail(`${command} needs the repair's id`);
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : process.env.RUN_URL || '';
  if (command === 'diagnosis-post') {
    const diagnosis = JSON.parse(readFileSync(rest[0], 'utf8'));
    await post('/api/agents/repairs', { action: 'diagnosis', id, diagnosis, runUrl });
    console.log(`[AgentHq] Sent the diagnosis to HQ: ${diagnosis.where}, ${String(diagnosis.cause).slice(0, 120)}`);
  } else {
    await post('/api/agents/repairs', { action: 'failed', id, error: String(rest[0] ?? '').slice(0, 400), runUrl });
    console.log('[AgentHq] Told HQ no diagnosis came out');
  }
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
  // A smoke test on main has no PR: it reports to the HQ mission that started it (MISSION_ID).
  const state = missionId;
  const pr = Number(process.env.PR_NUMBER) || 0;
  const smoke = !pr && process.env.MISSION_ID;
  if (!pr && !smoke) fail('qa needs PR_NUMBER, or MISSION_ID for a smoke test');
  const res = await post('/api/agents/qa', { pr, ...(smoke ? { missionId: process.env.MISSION_ID } : {}), sha: process.env.HEAD_SHA || '', runUrl: process.env.RUN_URL || '', state });
  console.log(`[AgentHq] Told HQ Scout is ${state} on ${pr ? `#${pr}` : 'the smoke test'} (mission ${res.mission})`);
  process.exit(0);
}
if (command === 'ideas-post') {
  const [file, scope] = [missionId, rest[0]];
  const ideas = JSON.parse(readFileSync(file, 'utf8'));
  // On Actions the run's page; in a sandbox HQ hands the run's link in as RUN_URL.
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : process.env.RUN_URL || '';
  const res = await post('/api/agents/ideas', { action: 'post', scope, runUrl, ideas });
  console.log(`[AgentHq] Sent ${ideas.length} ideas; ${res.added} new`);
  process.exit(0);
}
if (command === 'specs-pull') {
  // Scout off GitHub Actions has no artifact from the previous run on this PR; HQ kept the spec sources
  // that run sent with its evidence (crew 1.7+). They go back where they were, under e2e/scout/.
  // A saved smoke test has no PR: HQ keeps its spec with the test (SCENARIO_ID).
  const pr = Number(process.env.PR_NUMBER) || 0;
  const scenarioId = pr ? '' : process.env.SCENARIO_ID || '';
  if (!pr && !scenarioId) fail('specs-pull needs PR_NUMBER, or SCENARIO_ID for a smoke test');
  const { specs = [], runId = '' } = await post('/api/agents/specs', pr ? { pr } : { scenarioId });
  let written = 0;
  for (const { path, url } of specs) {
    if (!/^e2e\/scout\/[\w./-]+$/.test(path) || path.includes('..')) continue;
    const res = await fetch(url);
    if (!res.ok) fail(`Download of ${path} failed (${res.status})`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    written++;
  }
  console.error(`[AgentHq] ${written ? `Reused ${written} spec file(s) from run ${runId}` : 'No specs kept from a previous run'}`);
  console.log(written);
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
