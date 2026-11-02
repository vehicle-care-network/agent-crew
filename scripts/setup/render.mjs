/**
 * Renders the crew's briefs for one repo. Run from the repo root after the crew is laid into `.crew/`.
 *
 * Reads `.github/agents/crew.json` (the repo's answers: product, commands, paths, Scout settings) and
 * fills `{{key.path}}` placeholders in every file under `.crew/briefs/` and `.crew/scout/PROMPT.md`.
 * `{{notes:NAME}}` becomes the contents of `.github/agents/NAME.notes.md` when that file exists (the
 * repo's own additions to a brief), otherwise nothing. Unknown placeholders fail the run: a brief with a
 * hole in it would send an agent off guessing.
 *
 * Also writes the GitHub Actions outputs the workflows need (node version, Scout port and base URL).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const CONFIG = '.github/agents/crew.json';
if (!existsSync(CONFIG)) {
  console.error(`[CrewSetup] ${CONFIG} is missing. Every repo the crew works in needs one; see the agent-crew README.`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));

const REQUIRED = ['product', 'commands.install', 'commands.format', 'commands.lint', 'commands.typecheck', 'commands.test', 'paths.source', 'paths.models', 'paths.tests', 'scout.port', 'scout.readyPath'];
const missing = REQUIRED.filter((k) => lookup(k) === undefined);
if (missing.length) {
  console.error(`[CrewSetup] ${CONFIG} is missing: ${missing.join(', ')}`);
  process.exit(1);
}

function lookup(path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), config);
}

function render(file) {
  const src = readFileSync(file, 'utf8');
  const unknown = [];
  const out = src.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (whole, key) => {
    if (key.startsWith('notes:')) {
      const path = `.github/agents/${key.slice(6)}.notes.md`;
      return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    }
    const v = lookup(key);
    if (v === undefined) {
      unknown.push(key);
      return whole;
    }
    return Array.isArray(v) ? v.map(String).join(', ') : String(v);
  });
  if (unknown.length) {
    console.error(`[CrewSetup] ${file} uses keys ${CONFIG} does not define: ${unknown.join(', ')}`);
    process.exit(1);
  }
  writeFileSync(file, out);
}

for (const name of readdirSync('.crew/briefs')) if (name.endsWith('.md')) render(`.crew/briefs/${name}`);
render('.crew/scout/PROMPT.md');

const node = existsSync('.nvmrc') ? readFileSync('.nvmrc', 'utf8').trim() : String(config.node ?? '22');
const port = Number(config.scout.port);
const outputs = { node, scout_port: String(port), scout_base_url: `http://localhost:${port}` };
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
console.log(`[CrewSetup] Rendered the briefs for ${config.product.split(',')[0]}; node ${node}, Scout on ${outputs.scout_base_url}`);
