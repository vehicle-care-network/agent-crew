import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Playwright config for Scout, the QA agent. Lives in the crew and runs from a repo's root as
 * `npx playwright test -c .crew/playwright.scout.config.ts`, so every path here is resolved from the
 * current directory, not from this file. Scout runs the repo's code with `next dev` against Firebase
 * emulators on a `demo-` project, so nothing here can reach staging or production.
 *
 * Every test is recorded: video and a final screenshot always, plus the step screenshots the specs
 * attach through `evidence()`. `scripts/scout/report.mjs` reads `results.json` to build the PR comment,
 * so pass/fail in that comment comes from Playwright, not from the agent's own account of the run.
 */
const root = process.cwd();
const out = path.resolve(root, process.env.SCOUT_OUT || 'scout-out');

export default defineConfig({
  testDir: path.resolve(root, 'e2e/scout'),
  timeout: 90 * 1000,
  expect: { timeout: 15 * 1000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: `${out}/results`,
  reporter: [['list'], ['json', { outputFile: `${out}/results.json` }], ['html', { outputFolder: `${out}/html`, open: 'never' }]],
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
