/**
 * Gathers the dependency facts Radar reasons about, so the agent reads data instead of guessing:
 *   - majors: packages whose latest release is a new major version (minor and patch updates are ignored);
 *   - vulnerabilities: npm audit advisories rated high or critical only;
 *   - usage: for every dependency, which files import it and what they import from it.
 *
 *   node scripts/agents/dep-facts.mjs > radar-out/facts.json
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = { ...pkg.dependencies, ...pkg.devDependencies };
const isDev = (name) => !!pkg.devDependencies?.[name];

// npm exits non-zero when something is outdated or vulnerable; the JSON is still on stdout.
function npmJson(args) {
  try {
    return JSON.parse(execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }) || '{}');
  } catch (error) {
    return JSON.parse(error.stdout || '{}');
  }
}

const major = (v) =>
  Number(
    String(v ?? '')
      .replace(/^[^\d]*/, '')
      .split('.')[0],
  );

const outdated = npmJson(['outdated', '--json']);
const majors = Object.entries(outdated)
  .filter(([name, o]) => declared[name] && o.current && o.latest && major(o.latest) > major(o.current))
  .map(([name, o]) => ({ name, current: o.current, latest: o.latest, dev: isDev(name) }));

const audit = npmJson(['audit', '--json']);
const vulnerabilities = Object.values(audit.vulnerabilities ?? {})
  .filter((v) => v.severity === 'high' || v.severity === 'critical')
  .map((v) => ({
    name: v.name,
    severity: v.severity,
    direct: !!declared[v.name],
    advisories: (v.via ?? []).filter((x) => typeof x === 'object').map((x) => ({ title: x.title, url: x.url, range: x.range })),
    fixAvailable:
      v.fixAvailable === true
        ? 'yes'
        : v.fixAvailable
          ? `via ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (major)' : ''}`
          : 'no',
  }));

// Who imports what. Config files count too (postcss.config.js, jest.config.js), since tooling is used there.
const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.startsWith('node_modules/'));
// Static imports, side-effect imports (`import 'server-only'`), re-exports, require() and import().
const IMPORT = /(?:import\s+([\s\S]*?)\s+from\s+|import\s+|export\s+[\s\S]*?\s+from\s+|require\(\s*|import\(\s*)['"]([^'"./][^'"]*)['"]/g;
const usage = Object.fromEntries(Object.keys(declared).map((name) => [name, { files: [], names: new Set() }]));

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[2];
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const u = usage[name];
    if (!u) continue;
    if (!u.files.includes(file)) u.files.push(file);
    const clause = m[1] ?? '';
    for (const n of clause
      .replace(/[{}\n]/g, ',')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0])
      .filter(Boolean))
      u.names.add(n);
    if (spec !== name) u.names.add(spec.slice(name.length));
  }
}

const usageOut = Object.fromEntries(
  Object.entries(usage).map(([name, u]) => [
    name,
    { fileCount: u.files.length, files: u.files.slice(0, 15), imports: [...u.names].slice(0, 25), dev: isDev(name) },
  ]),
);

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), majors, vulnerabilities, usage: usageOut }, null, 1));
