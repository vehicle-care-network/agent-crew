/**
 * Playwright reporter that writes what every Scout flow did, step by step, to `<SCOUT_OUT>/steps.json`:
 * each browser action (`pw:api`), each check (`expect`), each evidence screenshot (`test.attach`) and each
 * `test.step`, in order, with whether it passed, how long it took, and the error when it failed. Fixture
 * and hook plumbing is left out. A step still running when the flow ended (a timeout) is kept and marked
 * `unfinished`: that is the step Scout was waiting on.
 *
 * `scripts/scout/steps.mjs` reads the file, so HQ's evidence and the PR comment can say what Scout did
 * and what it was checking for from the run itself, not from the agent's account of it. Specs need no
 * change: Playwright names these steps on its own.
 *
 * CommonJS on purpose: Playwright loads reporters by path from the repo under test, whatever that repo's
 * module type is.
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const KEEP = new Set(['pw:api', 'expect', 'test.attach', 'test.step']);
const MAX_STEPS = 200;

const clean = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');

/** The first useful lines of a step's error: the message, and Playwright's Expected/Received/Timeout lines. */
function errorText(error) {
  const lines = clean(error?.message).split('\n').map((l) => l.trim());
  const first = lines.find(Boolean) || 'failed';
  const details = lines.filter((l) => /^(Expected|Received|Timeout|Locator|Error)\b/.test(l) && l !== first).slice(0, 5);
  return [first, ...details].join('\n').slice(0, 600);
}

class ScoutStepsReporter {
  constructor(options = {}) {
    this.outputFile = options.outputFile || path.join(process.env.SCOUT_OUT || 'scout-out', 'steps.json');
    /** test key -> { status, steps } */
    this.tests = new Map();
    /** TestStep -> its row, while the step is running */
    this.open = new Map();
  }

  /** Same key `scripts/scout/steps.mjs` builds from results.json: project, spec file name, titles. */
  key(test) {
    const [, project, file, ...titles] = test.titlePath();
    return `${project}|${path.basename(file || '')}|${titles.join(' › ')}`;
  }

  rows(test) {
    const k = this.key(test);
    if (!this.tests.has(k)) this.tests.set(k, { status: 'unknown', steps: [] });
    return this.tests.get(k);
  }

  /** Steps inside hooks and fixtures (launch the browser, close the context) are not the flow. */
  plumbing(step) {
    for (let s = step; s; s = s.parent) if (s.category === 'hook' || s.category === 'fixture') return true;
    return false;
  }

  depth(step) {
    let d = 0;
    for (let s = step.parent; s; s = s.parent) if (s.category === 'test.step') d++;
    return d;
  }

  onTestBegin(test) {
    // A retry starts over.
    this.tests.set(this.key(test), { status: 'unknown', steps: [] });
  }

  onStepBegin(test, result, step) {
    if (!KEEP.has(step.category) || this.plumbing(step)) return;
    const t = this.rows(test);
    if (t.steps.length >= MAX_STEPS) return;
    const row = { category: step.category, title: clean(step.title).slice(0, 300), depth: this.depth(step), ok: null, ms: 0 };
    t.steps.push(row);
    this.open.set(step, row);
  }

  onStepEnd(test, result, step) {
    const row = this.open.get(step);
    if (!row) return;
    this.open.delete(step);
    row.ms = Math.round(step.duration || 0);
    row.ok = !step.error;
    if (step.error) row.error = errorText(step.error);
  }

  onTestEnd(test, result) {
    const t = this.rows(test);
    t.status = result.status;
    // Whatever was still running when the flow ended is where it stopped (a timeout, most often).
    for (const [step, row] of this.open) {
      if (!t.steps.includes(row)) continue;
      this.open.delete(step);
      row.ok = false;
      row.unfinished = true;
      row.ms = Math.max(0, Date.now() - new Date(step.startTime).getTime());
      if (result.error && !row.error) row.error = errorText(result.error);
    }
  }

  onEnd() {
    mkdirSync(path.dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, JSON.stringify({ version: 1, tests: Object.fromEntries(this.tests) }, null, 1));
  }

  printsToStdio() {
    return false;
  }
}

module.exports = ScoutStepsReporter;
