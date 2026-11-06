/**
 * Reads Playwright's `results.json` into one row per test. Shared by `report.mjs` (the PR comment) and
 * `upload-evidence.mjs` (Agent HQ), so both describe a run the same way.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadSteps, stepsFor } from './steps.mjs';

/**
 * Loads every test in run order, or null when Playwright wrote no results. Each row also carries its
 * `steps` (what the flow did and checked, from `steps.json`; `[]` for runs without the reporter).
 */
export function loadTests(out) {
  const resultsPath = `${out}/results.json`;
  if (!existsSync(resultsPath)) return null;
  const index = loadSteps(out);
  return JSON.parse(readFileSync(resultsPath, 'utf8'))
    .suites.flatMap((s) => collectTests(s))
    .map((row) => ({ ...row, steps: stepsFor(row, index) }));
}

/** Reads an attachment's bytes whether Playwright wrote it to disk or inlined it as base64. */
export function attachmentBytes(attachment) {
  return attachment.body ? Buffer.from(attachment.body, 'base64') : readFileSync(attachment.path);
}

export const isCore = (test) => /(^|\/)core\//.test(test.file);

function collectTests(suite, path = []) {
  const here = suite.title && !suite.title.endsWith('.ts') ? [...path, suite.title] : path;
  const rows = (suite.specs || []).flatMap((spec) =>
    spec.tests.map((t) => {
      const result = t.results[t.results.length - 1] || {};
      const attachments = result.attachments || [];
      const consoleNote = attachments.find((a) => a.name === 'scout-console');
      const consoleText = consoleNote ? attachmentBytes(consoleNote).toString() : '';
      return {
        file: spec.file,
        title: [...here, spec.title].join(' › '),
        project: t.projectName,
        status: result.status || 'skipped',
        seconds: Math.round((result.duration || 0) / 1000),
        // Step screenshots attached with evidence(), in order; `screenshot` is Playwright's own final one.
        shots: attachments.filter((a) => a.contentType === 'image/png' && a.name !== 'screenshot'),
        finalShot: attachments.find((a) => a.name === 'screenshot' && a.contentType === 'image/png') || null,
        video: attachments.find((a) => a.name === 'video' && a.path) || null,
        // One entry per problem; a single console error can span several lines.
        problems: consoleText ? consoleText.split(/\n(?=console: |page error: |HTTP \d)/).filter(Boolean) : [],
        error: result.error?.message?.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0] || '',
      };
    }),
  );
  return rows.concat((suite.suites || []).flatMap((s) => collectTests(s, here)));
}
