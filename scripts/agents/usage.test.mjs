import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('./usage.mjs', import.meta.url).pathname;

// Runs usage.mjs on an execution file holding `init` and a result, without HQ, and returns its log line.
function usageLine(init, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  const file = join(dir, 'execution.json');
  const result = { type: 'result', total_cost_usd: 0.37, num_turns: 9, duration_ms: 1000, usage: {} };
  writeFileSync(file, JSON.stringify([{ type: 'system', subtype: 'init', model: 'claude-opus-5-5', apiKeySource: 'none', ...init }, result]));
  const { AGENT_HQ_URL, AGENT_RUN_EFFORT, ...rest } = process.env;
  return execFileSync('node', [script, file, 'bolt', 'build'], { env: { ...rest, ...env }, encoding: 'utf8' }).trim();
}

test('reports the effort the run exported', () => {
  assert.match(usageLine({}, { AGENT_RUN_EFFORT: 'high' }), /claude-opus-5-5, effort high, subscription/);
});

test("prefers the init message's effort when Claude reports one", () => {
  assert.match(usageLine({ effort: 'max' }, { AGENT_RUN_EFFORT: 'high' }), /effort max/);
});

test('leaves effort out when nothing sets it', () => {
  const line = usageLine({});
  assert.doesNotMatch(line, /effort/);
  assert.match(line, /claude-opus-5-5, subscription/);
});
