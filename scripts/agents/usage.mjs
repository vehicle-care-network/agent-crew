/**
 * Sends one Claude run's cost and tokens to Agent HQ's Spend view. Reads claude-code-action's
 * execution file (its `execution_file` output). Never fails the job: usage is bookkeeping.
 *
 *   node .crew/scripts/agents/usage.mjs <execution_file> <agent> <task> [missionId] [pr]
 *
 * Env: AGENT_HQ_URL, ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN (the job needs `permissions: id-token: write`).
 */
import { existsSync, readFileSync } from 'node:fs';

const [file, agent, task, missionId, pr] = process.argv.slice(2);
const hq = (process.env.AGENT_HQ_URL || 'https://agent-hq-cyan.vercel.app').replace(/\/$/, '');

try {
  if (!file || !existsSync(file)) throw new Error(`No execution file at "${file}"; the agent step didn't run`);
  const messages = JSON.parse(readFileSync(file, 'utf8'));
  const result = [...messages].reverse().find((m) => m.type === 'result');
  if (!result) throw new Error('The execution file has no result message');
  const init = messages.find((m) => m.type === 'system' && m.subtype === 'init');
  const model = init?.model ?? 'unknown';
  // Who paid: `none` means Claude signed in with the subscription token (CLAUDE_CODE_OAUTH_TOKEN), so the
  // cost below is only the API-price equivalent; anything else is an API key.
  const billing = init?.apiKeySource === 'none' ? 'subscription' : init?.apiKeySource ? 'api' : undefined;
  const u = result.usage ?? {};
  const body = {
    agent,
    task,
    missionId: missionId || null,
    pr: Number(pr) || null,
    model,
    billing,
    // Whether this repo gave the run a subscription token (set by the workflow), to explain API use.
    hasSubscriptionToken: process.env.HAS_SUBSCRIPTION_TOKEN ? process.env.HAS_SUBSCRIPTION_TOKEN === 'true' : null,
    // Claude's own error when the run failed, e.g. "401 OAuth access token is invalid". HQ tracks sign-in health from it.
    error: result.is_error ? String(result.result || result.error || result.subtype || 'failed').slice(0, 500) : null,
    costUsd: result.total_cost_usd ?? 0,
    turns: result.num_turns ?? 0,
    durationMs: result.duration_ms ?? 0,
    tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
  };
  console.log(`[Usage] ${agent} ${task}: $${body.costUsd.toFixed(2)}, ${body.turns} turns, ${model}, ${billing ?? 'unknown billing'}${body.error ? `, failed: ${body.error}` : ''}`);

  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: token } = process.env;
  if (!url || !token) throw new Error('No GitHub OIDC token; the job needs `permissions: id-token: write`');
  const idRes = await fetch(`${url}&audience=agent-hq`, { headers: { Authorization: `bearer ${token}` } });
  if (!idRes.ok) throw new Error(`GitHub refused an OIDC token (${idRes.status})`);
  const res = await fetch(`${hq}/api/agents/usage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${(await idRes.json()).value}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HQ answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
} catch (error) {
  console.log(`::warning::Couldn't report usage to Agent HQ: ${error instanceof Error ? error.message : error}`);
}
