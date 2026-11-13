import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Playwright config for Scout, the QA agent. Lives in the crew and runs from a repo's root as
 * `npx playwright test -c .crew/playwright.scout.config.ts`, so every path here is resolved from the
 * current directory, not from this file. Scout runs the repo's code with `next dev` against Firebase
 * emulators on a `demo-` project, so nothing here can reach staging or production.
 *
 * Every test is recorded: video and a final screenshot always, plus the step screenshots the specs
 * attach through `evidence()`, and every action and check as a step (`scout/steps-reporter.cjs`).
 * `scripts/scout/report.mjs` reads `results.json` to build the PR comment, so pass/fail in that comment
 * comes from Playwright, not from the agent's own account of the run.
 */
const root = process.cwd();
const out = path.resolve(root, process.env.SCOUT_OUT || 'scout-out');
/** Where the crew is laid out (action.yml puts it in `.crew/`); the steps reporter lives there. */
const crew = path.resolve(root, process.env.CREW_DIR || '.crew');

/**
 * Never the production probes (`e2e/scout/probe/`, run against the live site by scout-probe.yml), and on
 * a PR, not the kept flows of areas the change doesn't touch (`SCOUT_IGNORE`, from scripts/scout/areas.mjs).
 */
const ignore = ['**/probe/**', ...(process.env.SCOUT_IGNORE || '').split(',').map((g) => g.trim()).filter(Boolean)];

export default defineConfig({
  testDir: path.resolve(root, 'e2e/scout'),
  testIgnore: ignore,
  timeout: 90 * 1000,
  expect: { timeout: 15 * 1000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: `${out}/results`,
  // The steps reporter writes what each flow did and checked (`steps.json`), which HQ's evidence shows
  // beside the screenshots and which stands in for repro steps when Scout wrote none.
  reporter: [['list'], ['json', { outputFile: `${out}/results.json` }], ['html', { outputFolder: `${out}/html`, open: 'never' }], [path.join(crew, 'scout/steps-reporter.cjs'), { outputFile: `${out}/steps.json` }]],
  use: {
    baseURL: process.env.SCOUT_BASE_URL || 'http://localhost:3000',
    video: 'on',
    screenshot: 'on',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
});
