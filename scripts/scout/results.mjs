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
  const changedPath = `${out}/changed-files.txt`;
  const changed = existsSync(changedPath) ? readFileSync(changedPath, 'utf8').split('\n') : [];
  const rows = JSON.parse(readFileSync(resultsPath, 'utf8'))
    .suites.flatMap((s) => collectTests(s))
    .map((row) => ({ ...row, steps: stepsFor(row, index) }));
  return markInPr(rows, changed);
}

/**
 * Marks the rows whose spec the pull request itself adds or edits (`inPr`). `changed` is the PR's file
 * list, as repo paths; a row's `file` is relative to the Scout test folder, wherever the repo keeps it,
 * so a changed path matches when it ends with that file.
 */
export function markInPr(rows, changed) {
  const paths = changed.map((p) => p.trim()).filter(Boolean);
  if (!paths.length) return rows;
  return rows.map((row) => {
    const file = String(row.file || '');
    return file && paths.some((p) => p === file || p.endsWith(`/${file}`)) ? { ...row, inPr: true } : row;
  });
}

/** Reads an attachment's bytes whether Playwright wrote it to disk or inlined it as base64. */
export function attachmentBytes(attachment) {
  return attachment.body ? Buffer.from(attachment.body, 'base64') : readFileSync(attachment.path);
}

export const isCore = (test) => /(^|\/)core\//.test(test.file);
/** A flow kept with the product (`e2e/scout/features/<area>/`), promoted from a PR run in Agent HQ. */
export const isFeature = (test) => /(^|\/)features\//.test(test.file);
/** Where a flow comes from: the committed core suite, a kept feature flow, or this run's own spec. */
export const scopeOf = (test) => (isCore(test) ? 'core' : isFeature(test) ? 'feature' : 'pr');
/**
 * Whether a flow speaks to this pull request: Scout's own for the run, a kept flow of an area it touches,
 * or a committed core spec the PR itself adds or edits. A PR that repairs a core flow is tested by that
 * flow, so the flow's folder alone doesn't make it "core only".
 */
export const coversPr = (test) => !isCore(test) || test.inPr === true;

/** Chromium's errors for a page that couldn't be opened because nothing was listening, or the server went away. */
const NO_ANSWER = /net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED) at (\S+)/;

/**
 * The flows that failed only because the app under test wasn't answering: a navigation to the app's own
 * address (`baseUrl`; any local address when it isn't known) that was refused or dropped. Such a failure
 * is the environment going down, not the code: record.sh runs these again on an app that is up, and
 * never reports one as a failed flow.
 */
export function unreachable(rows, baseUrl = '') {
  let origin = '';
  try {
    origin = baseUrl ? new URL(baseUrl).origin : '';
  } catch {
    origin = '';
  }
  return rows.filter((row) => {
    if (row.status === 'passed' || row.status === 'skipped') return false;
    const url = NO_ANSWER.exec(row.error || '')?.[2];
    if (!url) return false;
    if (origin) return url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`);
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|\?|$)/.test(url);
  });
}

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
