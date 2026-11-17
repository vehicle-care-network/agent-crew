#!/usr/bin/env node
/**
 * The `/crew` skill's helper: what the crew's GitHub setup action does, on your machine. Run from the
 * root of the repo the crew works in.
 *
 *   node .claude/skills/crew/crew.mjs prepare       lay the crew into .crew/ and render its briefs for this repo
 *   node .claude/skills/crew/crew.mjs open <file>   open a file (Nova's mock) in the default browser
 *   node .claude/skills/crew/crew.mjs guard         fail when an agent changed a file it must never touch
 *
 * `prepare` fetches the crew at a pinned version (CREW_REF, default `v1`, the tag every release moves to)
 * from CREW_REPO, copies its briefs and scripts into `.crew/`, keeps `.crew/` and `agent-out/` out of git
 * (through `.git/info/exclude`, so nothing in your repo changes), and fills the briefs in from
 * `.github/agents/crew.json` with the crew's own `render.mjs`. Nothing is installed and nothing leaves
 * this machine. Set CREW_DIR to a local checkout of the crew to use that instead of fetching.
 *
 * To use a fork or another version, change the two constants below or set the environment variables.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CREW_REPO = process.env.CREW_REPO || 'https://github.com/vehicle-care-network/agent-crew';
const CREW_REF = process.env.CREW_REF || 'v1';
/** What the setup action copies (action.yml in the crew repo). The briefs are rendered in place. */
const PARTS = ['scripts', 'briefs', 'scout', 'playwright.scout.config.ts'];
/** Kept out of `git add -A`: the crew itself and the agents' scratch folder. */
const EXCLUDED = ['.crew/', 'agent-out/'];
/** What no agent may change (every brief's rules), plus this skill. */
const OFF_LIMITS = [/^\.github\//, /^\.crew\//, /^\.claude\//, /(^|\/)\.env[^/]*$/];

const say = (text) => console.log(`[Crew] ${text}`);
function die(text) {
  console.error(`[Crew] ${text}`);
  process.exit(1);
}
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}
function git(...args) {
  const res = run('git', args);
  return res.status === 0 ? res.stdout.trim() : null;
}

function atRepoRoot() {
  const top = git('rev-parse', '--show-toplevel');
  if (!top) die('This is not a git repository. Run it from the root of the repo the crew works in.');
  if (resolve(top) !== resolve(process.cwd())) die(`Run it from the root of the repo (${top}).`);
}

function prepare() {
  atRepoRoot();
  if (!existsSync('.github/agents/crew.json')) {
    die('.github/agents/crew.json is missing on this branch. Set the crew up first (SETUP.md in the agent-crew repo), or switch to a branch that has it.');
  }

  let source = process.env.CREW_DIR ? resolve(process.env.CREW_DIR) : null;
  let from = source;
  let scratch = null;
  if (source) {
    if (!existsSync(join(source, 'briefs'))) die(`CREW_DIR (${source}) is not a copy of the crew: it has no briefs/ folder.`);
  } else {
    scratch = mkdtempSync(join(tmpdir(), 'agent-crew-'));
    const clone = run('git', ['clone', '--quiet', '--depth', '1', '--branch', CREW_REF, CREW_REPO, scratch]);
    if (clone.status === 0) {
      source = scratch;
      from = `${CREW_REPO}@${CREW_REF}`;
    } else {
      rmSync(scratch, { recursive: true, force: true });
      scratch = null;
      const reason = (clone.stderr || clone.error?.message || '').trim().split('\n').pop();
      // Offline, or GitHub is down: the copy from last time still works, as long as crew.json hasn't changed.
      if (!existsSync('.crew/briefs') || !existsSync('.crew/SOURCE')) die(`Couldn't fetch the crew (${CREW_REPO}@${CREW_REF}): ${reason}`);
      say(`Couldn't fetch the crew (${reason}). Using the copy already in .crew/ (${readFileSync('.crew/SOURCE', 'utf8').trim()}); changes to crew.json or the notes since then are not in its briefs.`);
    }
  }

  if (source) {
    rmSync('.crew', { recursive: true, force: true });
    mkdirSync('.crew');
    for (const part of PARTS) if (existsSync(join(source, part))) cpSync(join(source, part), join('.crew', part), { recursive: true });
    const version = existsSync(join(source, 'VERSION')) ? readFileSync(join(source, 'VERSION'), 'utf8').trim() : 'dev';
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    // The briefs are filled in from crew.json and the notes, exactly as a run on GitHub does it.
    const env = { ...process.env };
    delete env.GITHUB_OUTPUT;
    const render = run('node', ['.crew/scripts/setup/render.mjs'], { env, stdio: 'inherit' });
    if (render.status !== 0) {
      rmSync('.crew', { recursive: true, force: true });
      die('The briefs could not be rendered: fix what it says above in .github/agents/crew.json and run this again.');
    }
    writeFileSync('.crew/SOURCE', `crew ${version} from ${from}\n`);
  }

  // Tooling and scratch, not part of any change: keep them out of `git add -A` without touching .gitignore.
  const exclude = git('rev-parse', '--git-path', 'info/exclude');
  if (exclude) {
    const have = existsSync(exclude) ? readFileSync(exclude, 'utf8').split('\n') : [];
    const add = EXCLUDED.filter((line) => !have.includes(line));
    if (add.length) {
      mkdirSync(resolve(exclude, '..'), { recursive: true });
      appendFileSync(exclude, `${have.length && have.at(-1) !== '' ? '\n' : ''}${add.join('\n')}\n`);
    }
  }
  mkdirSync('agent-out', { recursive: true });
  say(`Ready: ${readFileSync('.crew/SOURCE', 'utf8').trim()}. Briefs are in .crew/briefs/, the agents' files go in agent-out/.`);
}

function open(file) {
  if (!file || !existsSync(file)) die(`No such file: ${file ?? '(none given)'}`);
  const url = pathToFileURL(resolve(file)).href;
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const res = run(command, args, { stdio: 'ignore' });
  say(res.status === 0 ? `Opened ${url}` : `Couldn't open a browser here. Open it yourself: ${url}`);
}

function guard() {
  atRepoRoot();
  const status = run('git', ['status', '--porcelain', '--untracked-files=all', '-z']);
  if (status.status !== 0) die('git status failed.');
  // Each entry is "XY path"; a rename is followed by its old path as a separate entry.
  const entries = status.stdout.split('\0').filter(Boolean);
  const changed = [];
  for (let i = 0; i < entries.length; i++) {
    changed.push(entries[i].slice(3));
    if (/^[RC]/.test(entries[i])) changed.push(entries[++i]);
  }
  const touched = changed.filter((path) => OFF_LIMITS.some((re) => re.test(path)));
  if (touched.length) {
    console.error(`[Crew] An agent changed files it must never touch:\n${touched.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
  say(`${changed.length} changed file${changed.length === 1 ? '' : 's'}, none off limits.`);
}

const [command, arg] = process.argv.slice(2);
if (command === 'prepare') prepare();
else if (command === 'open') open(arg);
else if (command === 'guard') guard();
else die('Usage: node .claude/skills/crew/crew.mjs prepare | open <file> | guard');
