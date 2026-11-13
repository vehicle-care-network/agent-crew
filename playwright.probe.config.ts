import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Playwright config for the production probe: the repo's `e2e/scout/probe/*.spec.ts`, run against the
 * live site on a schedule by `.github/workflows/scout-probe.yml`. No emulators, no seeding, no agent:
 * the specs are the repo's own, read-only checks that the service and what it depends on are up.
 * `PROBE_BASE_URL` is the site (crew.json `probe.url`, or the workflow input). Results go to
 * `probe-out/results.json`, which `scripts/scout/probe-report.mjs` sends to Agent HQ.
 */
const root = process.cwd();
const out = path.resolve(root, process.env.PROBE_OUT || 'probe-out');

export default defineConfig({
  testDir: path.resolve(root, 'e2e/scout/probe'),
  timeout: 45 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false,
  workers: 1,
  // One retry: a probe that fails twice in a row is the site, not the network.
  retries: 1,
  outputDir: `${out}/results`,
  reporter: [['list'], ['json', { outputFile: `${out}/results.json` }]],
  use: {
    baseURL: process.env.PROBE_BASE_URL || 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: false,
  },
  projects: [{ name: 'probe', use: { ...devices['Desktop Chrome'] } }],
});
