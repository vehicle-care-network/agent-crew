/**
 * What each flow did, in plain words, from `steps.json` (written by `scout/steps-reporter.cjs`). Shared
 * by `results.mjs` (one row per test gets its steps), `upload-evidence.mjs` (HQ's evidence shows them, and
 * a failed flow with no steps from Scout gets its repro from them) and the workflow (`--grep` for
 * re-running named flows).
 *
 * Playwright names a step after the call that made it, e.g. `Click getByRole('button', { name: 'Save' })`
 * or `Expect "toBeVisible" getByText('Saved')`. `humanStep` turns that into "Click the “Save” button" and
 * "Check that “Saved” is visible": what a person would do and look for, so a reviewer can follow the flow by
 * hand without reading the spec.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** `{ tests: { [key]: { status, steps } } }`, or an empty index when the reporter wrote nothing. */
export function loadSteps(out) {
  const file = `${out}/steps.json`;
  if (!existsSync(file)) return { tests: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed.tests === 'object' ? parsed : { tests: {} };
  } catch {
    return { tests: {} };
  }
}

/** The reporter's key for a results.json row: project, spec file name, titles. */
export function stepKey(row) {
  return `${row.project || ''}|${path.basename(row.file || '')}|${row.title}`;
}

/** The steps for one results.json row, humanised, in order. `[]` when the reporter has none for it. */
export function stepsFor(row, index) {
  const entry = index?.tests?.[stepKey(row)];
  return (entry?.steps ?? []).map(humanStep).filter(Boolean);
}

/* ---------- Words ---------- */

const quote = (s) => `“${String(s).replace(/^["']|["']$/g, '')}”`;

/** `getByRole('button', { name: 'Save' })` → `the “Save” button`; the last locator in a chain wins. */
export function describeLocator(loc) {
  if (!loc) return '';
  let s = loc.trim();
  const filters = [...s.matchAll(/\.filter\(\{\s*hasText:\s*(['"`])(.*?)\1\s*\}\)/g)].map((m) => m[2]);
  s = s.replace(/\.(first|last)\(\)/g, '').replace(/\.nth\(\d+\)/g, '').replace(/\.filter\([^)]*\)/g, '');
  const calls = [...s.matchAll(/(getByRole|getByText|getByLabel|getByPlaceholder|getByTestId|getByTitle|getByAltText|locator|frameLocator)\((.*?)\)(?=\.|$)/g)];
  const last = calls[calls.length - 1];
  let out = '';
  if (last) {
    const [, fn, args] = last;
    const first = args.match(/^\s*(['"`])(.*?)\1/)?.[2] ?? args.match(/^\s*\/(.*?)\/[a-z]*/)?.[1] ?? '';
    const name = args.match(/name:\s*(?:(['"`])(.*?)\1|\/(.*?)\/[a-z]*)/);
    const named = name ? (name[2] ?? name[3]) : '';
    switch (fn) {
      case 'getByRole':
        out = named ? `the ${quote(named)} ${first}` : `the ${first}`;
        break;
      case 'getByText':
        out = quote(first);
        break;
      case 'getByLabel':
      case 'getByPlaceholder':
        out = `the ${quote(first)} field`;
        break;
      case 'getByTestId':
        out = `the ${first} element`;
        break;
      case 'getByTitle':
      case 'getByAltText':
        out = quote(first);
        break;
      default:
        out = `\`${first || args.trim()}\``;
    }
  } else out = `\`${s}\``;
  if (filters.length) out += ` with ${filters.map(quote).join(' and ')}`;
  return out.slice(0, 120);
}

const CHECKS = {
  toBeVisible: 'is visible',
  toBeHidden: 'is hidden',
  toBeAttached: 'is on the page',
  toBeInViewport: 'is on screen',
  toBeEnabled: 'is enabled',
  toBeDisabled: 'is disabled',
  toBeChecked: 'is ticked',
  toBeEditable: 'is editable',
  toBeEmpty: 'is empty',
  toBeFocused: 'has focus',
  toHaveText: 'shows the expected text',
  toContainText: 'contains the expected text',
  toHaveValue: 'has the expected value',
  toHaveValues: 'has the expected values',
  toHaveCount: 'has the expected number of items',
  toHaveAttribute: 'has the expected attribute',
  toHaveClass: 'has the expected class',
  toHaveCSS: 'has the expected style',
  toHaveId: 'has the expected id',
  toHaveAccessibleName: 'has the expected name',
  toHaveURL: 'the page is at the expected address',
  toHaveTitle: 'the page has the expected title',
  toHaveScreenshot: 'looks as before',
  toBeOK: 'the response is OK',
};
const PAGE_LEVEL = new Set(['toHaveURL', 'toHaveTitle', 'toBeOK']);

function negate(phrase) {
  return phrase.replace(/^is /, 'is not ').replace(/^has /, 'does not have ').replace(/^shows /, 'does not show ').replace(/^contains /, 'does not contain ').replace(/^the page is /, 'the page is not ').replace(/^the page has /, 'the page does not have ');
}

/**
 * One recorded step as `{ kind, text, ok, ms, error?, unfinished?, depth, raw }`, or null for steps a
 * person needn't see (the screenshot call behind each evidence attachment). Kinds: `action` (the browser
 * did something), `check` (an assertion), `proof` (an evidence screenshot), `step` (a named test.step).
 */
export function humanStep(s) {
  const title = String(s.title ?? '');
  const base = { ok: s.ok !== false, ms: s.ms ?? 0, depth: s.depth ?? 0, raw: title.slice(0, 200) };
  if (s.error) base.error = String(s.error).slice(0, 600);
  if (s.unfinished) base.unfinished = true;
  let m;
  switch (s.category) {
    case 'test.attach': {
      const name = title.match(/^Attach "(.*)"$/)?.[1] ?? title;
      if (name === 'scout-console' || name === 'screenshot' || name === 'video' || name === 'trace') return null;
      return { ...base, kind: 'proof', text: `Screenshot: ${name}`.slice(0, 160) };
    }
    case 'test.step':
      return { ...base, kind: 'step', text: title.slice(0, 160) };
    case 'expect': {
      m = title.match(/^Expect "((?:not[. ])?)(\w+)"(?:\s+(.*))?$/);
      if (!m) return { ...base, kind: 'check', text: `Check: ${title}`.slice(0, 160) };
      const [, not, matcher, loc] = m;
      let phrase = CHECKS[matcher] ?? (matcher.startsWith('toHave') ? `has the expected ${matcher.slice(6).replace(/([A-Z])/g, ' $1').toLowerCase().trim()}` : matcher.replace(/([A-Z])/g, ' $1').toLowerCase());
      if (not) phrase = negate(phrase);
      const subject = PAGE_LEVEL.has(matcher) || !loc ? '' : `${describeLocator(loc)} `;
      return { ...base, kind: 'check', text: `Check that ${subject}${phrase}`.slice(0, 160) };
    }
    case 'pw:api': {
      if (/^Screenshot/.test(title)) return null;
      if ((m = title.match(/^Navigate to "(.*)"$/))) return { ...base, kind: 'action', text: `Open ${m[1]}`.slice(0, 160) };
      if ((m = title.match(/^(Click|Double click|Hover|Focus|Tap|Check|Uncheck|Clear|Blur|Scroll into view if needed|Drag to)\s+(.*)$/))) {
        const verb = m[1] === 'Check' ? 'Tick' : m[1] === 'Uncheck' ? 'Untick' : m[1] === 'Scroll into view if needed' ? 'Scroll to' : m[1];
        return { ...base, kind: 'action', text: `${verb} ${describeLocator(m[2])}`.slice(0, 160) };
      }
      if ((m = title.match(/^(Fill|Type|Press|Select option|Set input files|Select text)\s+"(.*?)"\s+(.*)$/))) {
        const [, verb, value, loc] = m;
        const text = verb === 'Press' ? `Press ${value} in ${describeLocator(loc)}` : verb === 'Select option' ? `Choose ${quote(value)} in ${describeLocator(loc)}` : verb === 'Set input files' ? `Attach ${quote(value)} to ${describeLocator(loc)}` : `Type ${quote(value)} in ${describeLocator(loc)}`;
        return { ...base, kind: 'action', text: text.slice(0, 160) };
      }
      if ((m = title.match(/^(Select option|Set input files)\s+(.*)$/))) return { ...base, kind: 'action', text: `${m[1] === 'Select option' ? 'Choose an option in' : 'Attach a file to'} ${describeLocator(m[2])}`.slice(0, 160) };
      if ((m = title.match(/^Wait for (?:URL|url) "(.*)"$/))) return { ...base, kind: 'action', text: `Wait for the page to reach ${m[1]}`.slice(0, 160) };
      if ((m = title.match(/^Wait for (.*)$/))) return { ...base, kind: 'action', text: `Wait for ${/^(load state|timeout|event|function|selector|response|request)/.test(m[1]) ? m[1] : describeLocator(m[1])}`.slice(0, 160) };
      if (/^Reload$/.test(title)) return { ...base, kind: 'action', text: 'Reload the page' };
      if (/^Go back$/.test(title)) return { ...base, kind: 'action', text: 'Go back' };
      if (/^(Evaluate|Set content|Set viewport size|Bring to front|Add init script|Route|Unroute|Emulate media|Set extra HTTP headers|Add cookies|Clear cookies|Storage state)/.test(title)) return null;
      return { ...base, kind: 'action', text: title.slice(0, 160) };
    }
    default:
      return null;
  }
}

/* ---------- Re-running named flows ---------- */

/** Flow titles from `SCOUT_ONLY` (one per line), as HQ sends them: `Describe › test` or just the test title. */
export function parseOnly(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * A Playwright `--grep` pattern that matches exactly these flows. Playwright greps the full title
 * ("project file describe test", space-separated), so the ` › ` the report uses between titles becomes a
 * gap, and each title is anchored to the end so "Reschedule" doesn't also match "Reschedule twice".
 */
export function onlyGrep(titles) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const one = (t) => `${t.split(' › ').map(escape).join('.*')}(?: @mobile)?$`;
  return titles.length ? titles.map(one).join('|') : '';
}
