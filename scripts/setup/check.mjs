/**
 * Checks that a repo is set up for the crew, before the first run finds out the slow way. Run it from
 * the root of the repo the crew will work in, from a copy of the crew:
 *
 *   node /path/to/agent-crew/scripts/setup/check.mjs            the files in this checkout
 *   node /path/to/agent-crew/scripts/setup/check.mjs --github   also the repo's secrets, labels and variables (needs `gh`)
 *   node /path/to/agent-crew/scripts/setup/check.mjs --sandbox  for a repo whose agents run in Vercel sandboxes an Agent HQ starts:
 *                                                               no caller workflows and no Claude secret are expected here
 *   node /path/to/agent-crew/scripts/setup/check.mjs --local    for a repo where the crew only runs on your machine (the /crew skill
 *                                                               in Claude Code): no caller workflows, and the skill must be installed
 *
 * It reads only; it changes nothing. Each line is ✓ (fine), ! (works, but read it) or ✗ (a run would fail).
 * Exits 1 when anything is ✗. SETUP.md in the crew repo says how to fix each one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { CONFIG, REQUIRED, lookupIn } from './required.mjs';

const github = process.argv.includes('--github');
/** The agents run in sandboxes Agent HQ starts, not on GitHub Actions: HQ holds the triggers and the Claude credential. */
const sandbox = process.argv.includes('--sandbox');
/** The crew runs only on a person's machine, through the /crew skill: nothing on GitHub Actions, no HQ. */
const local = process.argv.includes('--local');
if (sandbox && local) {
  console.error('Pick one of --sandbox and --local.');
  process.exit(2);
}
const WORKFLOWS = '.github/workflows';
/** The callers, by what they need. `hq` ones do nothing without Agent HQ. */
const CALLERS = {
  'agent-iris.yml': 'base',
  'agent-radar.yml': 'base',
  'scout-qa.yml': 'scout',
  'scout-probe.yml': 'probe',
  'agent-bolt.yml': 'hq',
  'agent-nova.yml': 'hq',
  'agent-patch.yml': 'hq',
  'agent-rocket.yml': 'hq',
};

let failed = 0;
let warned = 0;
const ok = (text) => console.log(`  ✓ ${text}`);
const warn = (text) => (warned++, console.log(`  ! ${text}`));
const bad = (text) => (failed++, console.log(`  ✗ ${text}`));
const section = (title) => console.log(`\n${title}`);
const read = (path) => readFileSync(path, 'utf8');
const todos = (path) => (existsSync(path) ? read(path).split('\n').filter((l) => l.includes('TODO')).length : 0);

function json(path) {
  try {
    return JSON.parse(read(path));
  } catch (error) {
    bad(`${path} is not valid JSON: ${error.message}`);
    return null;
  }
}

function noTodos(path, what) {
  const n = todos(path);
  if (n) warn(`${path} still has ${n} TODO line${n > 1 ? 's' : ''}: ${what}`);
  return !n;
}

// --- The repo's answers ---------------------------------------------------------------------------
section('The repo\'s answers (.github/agents/)');
let config = null;
if (!existsSync(CONFIG)) {
  bad(`${CONFIG} is missing: copy templates/base/.github/agents/crew.json from the crew and fill it in`);
} else if ((config = json(CONFIG))) {
  const missing = REQUIRED.filter((k) => lookupIn(config, k) === undefined);
  if (missing.length) bad(`${CONFIG} is missing: ${missing.join(', ')}`);
  else ok(`${CONFIG} has every key the crew needs`);
  if (String(config.product ?? '').includes('TODO')) bad(`${CONFIG} "product" is still the placeholder: say what the product is in one sentence`);
  const scripts = existsSync('package.json') ? (json('package.json')?.scripts ?? {}) : null;
  for (const [name, command] of Object.entries(config.commands ?? {})) {
    if (name.startsWith('$') || typeof command !== 'string') continue;
    const script = /^(?:npm|pnpm|yarn|bun) (?:run )?([\w:.-]+)$/.exec(command)?.[1];
    if (scripts && script && !['ci', 'install', 'test'].includes(script) && !(script in scripts)) {
      bad(`${CONFIG} commands.${name} is "${command}", but package.json has no "${script}" script`);
    } else if (scripts && command === 'npm test' && !('test' in scripts)) {
      bad(`${CONFIG} commands.test is "npm test", but package.json has no "test" script (use "true" when there are no tests yet)`);
    }
  }
  for (const path of [config.paths?.source].flat().filter((p) => typeof p === 'string')) {
    if (!existsSync(path)) warn(`${CONFIG} paths.source lists ${path}, which doesn't exist here`);
  }
}

const RISK = '.github/agents/risk-map.json';
if (!existsSync(RISK)) {
  bad(`${RISK} is missing: copy templates/base/.github/agents/risk-map.json (Radar, Iris and Scout all read it)`);
} else {
  const map = json(RISK);
  if (map && (!map.tiers || typeof map.tiers !== 'object')) bad(`${RISK} has no "tiers"`);
  else if (map) ok(`${RISK} has ${Object.values(map.tiers).reduce((n, t) => n + (t.rules?.length ?? 0), 0)} rules`);
}
for (const name of existsSync('.github/agents') ? readdirSync('.github/agents').filter((f) => f.endsWith('.notes.md')) : []) {
  noTodos(`.github/agents/${name}`, 'fill them in or delete the file');
}

// --- The callers ----------------------------------------------------------------------------------
section(sandbox ? 'Where the agents run: Vercel sandboxes, started by Agent HQ' : local ? 'Where the agents run: on your machine, when you type /crew' : 'The workflows that call the crew (.github/workflows/)');
const present = Object.keys(CALLERS).filter((name) => existsSync(`${WORKFLOWS}/${name}`));
const has = (kind) => present.some((name) => CALLERS[name] === kind);
if (sandbox) {
  // HQ starts what the callers would have (Iris and Radar on a PR, Scout on the label): a caller left here runs the agent a second time, on Actions.
  const doubled = present.filter((name) => CALLERS[name] !== 'probe');
  if (doubled.length) warn(`${doubled.join(', ')}: HQ starts these agents itself for a repo on sandboxes, so each would also run on GitHub Actions. Delete them`);
  else ok('No caller workflows for the agents: HQ starts each run in a sandbox');
} else if (local) {
  if (present.length) warn(`${present.join(', ')} ${present.length > 1 ? 'are' : 'is'} here, so the crew also runs on GitHub Actions: run this without --local to check that setup too`);
  else ok('No caller workflows: nothing runs on GitHub Actions, and a pull request is reviewed only when someone runs /crew');
} else if (!present.length) {
  bad('No caller workflows: copy templates/base/.github/workflows/ from the crew (or run this with --sandbox when an Agent HQ runs the agents in Vercel sandboxes, or --local when the crew only runs on your machine)');
}
// This repo's owner, from its origin remote: `secrets: inherit` only reaches a crew in the same organization.
const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout ?? '';
const owner = /github\.com[:/]([\w.-]+)\//.exec(origin)?.[1]?.toLowerCase() ?? '';
const inherits = [];
for (const name of present) {
  const yaml = read(`${WORKFLOWS}/${name}`);
  const uses = /uses:\s*([\w.-]+\/[\w.-]+)\/\.github\/workflows\/[\w.-]+@([\w./-]+)/.exec(yaml);
  if (!uses) {
    bad(`${name} doesn't call a crew workflow (no \`uses: <owner>/agent-crew/.github/workflows/…@<ref>\`)`);
    continue;
  }
  ok(`${name} calls ${uses[1]}@${uses[2]}`);
  if (!/^v\d/.test(uses[2])) warn(`${name} is pinned to "${uses[2]}", not a release tag: fine for trying a change, not for main`);
  if (name !== 'scout-probe.yml' && /^\s*secrets:\s*inherit\s*$/m.test(yaml) && uses[1].split('/')[0].toLowerCase() !== owner) inherits.push(name);
  if (!/id-token:\s*write/.test(yaml) && name !== 'agent-radar.yml') warn(`${name} lacks \`id-token: write\`: needed to report to Agent HQ`);
}
if (inherits.length) {
  bad(`${inherits.join(', ')}: \`secrets: inherit\` passes nothing to a crew in another organization, so every agent would fail at sign-in. Pass CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY by name (see the templates)`);
}
if (has('hq') && !github && !sandbox && !local) warn('Bolt, Nova, Patch and Rocket only run for an Agent HQ mission: without an HQ (variable AGENT_HQ_URL) their workflows sit idle');

// --- Scout ----------------------------------------------------------------------------------------
// On sandboxes there is no scout-qa.yml to go by: Scout is set up when its files are here.
// A repo with no app to open (`scout.app: false`): Scout's verdict is the repo's own tests, so none of its pieces are needed.
const noApp = config?.scout?.app === false;
if (noApp) {
  section('Scout');
  ok('No app to open (scout.app is false): Scout runs the repo\'s tests (commands.test) and reports that');
}
const scout = !noApp && (has('scout') || (sandbox && (existsSync('.github/scout') || existsSync('e2e/scout'))));
if (scout) {
  section('Scout (browser tests on a Next.js app with Firebase emulators)');
  const pkg = existsSync('package.json') ? json('package.json') : null;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (!pkg) bad('No package.json: Scout starts the app with `npx next dev`');
  else {
    for (const [dep, why] of [['next', 'Scout starts the app with `npx next dev`'], ['@playwright/test', 'Scout\'s specs are Playwright tests'], ['firebase-admin', 'the seed writes to the Firestore and Auth emulators with it']]) {
      if (dep in deps) ok(`${dep} is a dependency`);
      else bad(`${dep} is not in package.json: ${why}`);
    }
  }
  for (const [path, what] of [
    ['.github/scout/core-flows.md', 'the journeys that must not break'],
    ['scripts/scout/seed.mjs', 'the base seed'],
    ['scripts/scout/fixtures.mjs', 'the guarded seeding helpers'],
    ['e2e/scout/_support/scout.ts', 'the Playwright harness and sign-in helper'],
  ]) {
    if (!existsSync(path)) bad(`${path} is missing (${what}): copy it from templates/scout/`);
    else if (noTodos(path, 'make it match this app')) ok(`${path}`);
  }
  const core = existsSync('e2e/scout/core') ? readdirSync('e2e/scout/core').filter((f) => f.endsWith('.spec.ts')) : [];
  if (core.length) ok(`${core.length} committed core spec${core.length > 1 ? 's' : ''} in e2e/scout/core/`);
  else bad('No specs in e2e/scout/core/: copy templates/scout/e2e/scout/core/smoke.spec.ts');
  if (existsSync('.env.local') && !read('.env.local').startsWith('# scout-env')) {
    warn('.env.local exists here: fine on your machine (Scout refuses to overwrite it locally), and CI has none');
  }
}

// --- The production probe -------------------------------------------------------------------------
if (has('probe') && !noApp) {
  section('Production probe');
  if (config?.probe?.url) ok(`Probes ${config.probe.url}`);
  else bad(`${CONFIG} has no "probe": { "url": "https://…" }`);
  const probes = existsSync('e2e/scout/probe') ? readdirSync('e2e/scout/probe').filter((f) => f.endsWith('.spec.ts')) : [];
  if (probes.length) ok(`${probes.length} probe spec${probes.length > 1 ? 's' : ''} in e2e/scout/probe/`);
  else bad('No specs in e2e/scout/probe/: copy templates/probe/e2e/scout/probe/up.spec.ts');
}

// --- The local skill -------------------------------------------------------------------------------
const SKILL = '.claude/skills/crew';
if (local && !existsSync(SKILL)) {
  section('The /crew skill (Nova, Bolt, Iris and Patch on your machine, in Claude Code)');
  bad(`${SKILL}/ is missing, and it is the only way the crew runs here: copy templates/local/ from the crew`);
}
if (existsSync(SKILL)) {
  section('The /crew skill (Nova, Bolt, Iris and Patch on your machine, in Claude Code)');
  if (!existsSync(`${SKILL}/SKILL.md`)) {
    bad(`${SKILL}/SKILL.md is missing: copy templates/local/ from the crew`);
  } else {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(read(`${SKILL}/SKILL.md`))?.[1] ?? '';
    if (/^name:\s*crew\s*$/m.test(front) && /^description:\s*\S/m.test(front)) ok(`${SKILL}/SKILL.md: type /crew and what to build, in Claude Code`);
    else bad(`${SKILL}/SKILL.md has no frontmatter with \`name: crew\` and a \`description\`: Claude Code won't offer it as /crew. Copy it again from templates/local/`);
  }
  if (!existsSync(`${SKILL}/crew.mjs`)) bad(`${SKILL}/crew.mjs is missing (it fetches the crew's briefs for the skill): copy templates/local/ from the crew`);
  else if (spawnSync(process.execPath, ['--check', `${SKILL}/crew.mjs`]).status === 0) ok(`${SKILL}/crew.mjs`);
  else bad(`${SKILL}/crew.mjs doesn't parse: copy it again from templates/local/`);
  if (spawnSync('git', ['check-ignore', '-q', `${SKILL}/SKILL.md`]).status === 0) warn(`${SKILL}/ is ignored by git here: the skill works on this machine, but isn't shared with the repo`);
  if (!config) warn('The skill renders the briefs from crew.json: fix it above first');
  if (!origin.trim()) warn('No `origin` remote: the skill ends with a local branch instead of a pull request');
  for (const [tool, why] of [['claude', 'the skill runs in Claude Code (https://claude.com/claude-code)'], ['gh', 'the skill opens the pull request with it']]) {
    if (spawnSync(tool, ['--version'], { stdio: 'ignore' }).status !== 0) warn(`\`${tool}\` isn't installed on this machine: ${why}`);
  }
}

// --- GitHub: secrets, labels, variables -----------------------------------------------------------
if (github) {
  section('On GitHub');
  const gh = (...args) => {
    const res = spawnSync('gh', args, { encoding: 'utf8' });
    return res.status === 0 ? res.stdout : null;
  };
  const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')?.trim();
  if (!repo) {
    warn('Couldn\'t read the repo with `gh` (not installed, not signed in, or no GitHub remote): skipped');
  } else {
    const secrets = gh('api', `repos/${repo}/actions/secrets`, '--jq', '.secrets[].name');
    const orgSecrets = gh('api', `repos/${repo}/actions/organization-secrets`, '--jq', '.secrets[].name') ?? '';
    if (sandbox) ok('No Claude secret needed on the repo: a sandbox run uses the credential your Agent HQ holds');
    else if (local) ok('No Claude secret needed on the repo: the /crew skill uses your Claude Code sign-in');
    else if (secrets === null) warn(`Couldn't list ${repo}'s secrets (needs admin on the repo): check CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is set`);
    else if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)$/m.test(`${secrets}\n${orgSecrets}`)) ok('A Claude credential is set (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)');
    else bad('No Claude credential: run `claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN` (or set ANTHROPIC_API_KEY)');
    if (scout) {
      const labels = gh('api', '--paginate', `repos/${repo}/labels?per_page=100`, '--jq', '.[].name') ?? '';
      if (/^scout$/m.test(labels)) ok('The `scout` label exists');
      else bad('No `scout` label: gh label create scout --description "Scout tests this PR on every push" --color 5319e7');
    }
    const variables = gh('api', `repos/${repo}/actions/variables`, '--jq', '.variables[].name') ?? '';
    const orgVariables = gh('api', `repos/${repo}/actions/organization-variables`, '--jq', '.variables[].name') ?? '';
    const hqSet = /^AGENT_HQ_URL$/m.test(`${variables}\n${orgVariables}`);
    if (sandbox) ok('No AGENT_HQ_URL needed: HQ gives each sandbox run its own address');
    else if (local) ok('No AGENT_HQ_URL needed: the /crew skill works without an Agent HQ');
    else if (hqSet) ok('AGENT_HQ_URL is set: runs report to your Agent HQ');
    else if (has('hq')) bad('AGENT_HQ_URL is not set, and this repo has the HQ agents\' workflows: gh variable set AGENT_HQ_URL --body https://your-hq.example');
    else ok('No AGENT_HQ_URL: the crew runs on its own and reports on the PR');
  }
}

if (sandbox) {
  console.log('\nIn your Agent HQ (this script can\'t see it):');
  console.log('  · its GitHub App is installed on this repo');
  console.log('  · the repo is on HQ\'s list of repos, and set to "Vercel sandboxes, every agent" under Setup → Runners');
}

console.log(
  failed
    ? `\n${failed} to fix${warned ? `, ${warned} to read` : ''}. SETUP.md in the crew repo covers each one.`
    : `\nReady${warned ? `, with ${warned} to read` : ''}.${github || local ? '' : ' Run again with --github to check the secrets and labels too.'}`,
);
process.exit(failed ? 1 : 0);
