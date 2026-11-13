/**
 * The repo's test guidance by area: `.github/scout/flows/<area>.md`, one file per part of the product.
 * Each starts with a short front matter naming the paths that belong to the area; the rest is prose for
 * Scout (what matters, accounts, edge cases, what not to test) and a table of the flows kept for it.
 *
 *   ---
 *   title: Bookings
 *   paths:
 *     - app/bookings/**
 *     - lib/booking*
 *   ---
 *   Always test the cancel path ...
 *
 * Usage (from the repo root):
 *   node .crew/scripts/scout/areas.mjs < changed-files.txt   the areas a change touches, as JSON
 *   node .crew/scripts/scout/areas.mjs --all                  every area
 *
 * Output: { areas: [{ slug, title, paths, guidance, file }], ignore: ["e2e/scout/features/<slug>/**", …] }
 * `ignore` lists the feature folders of the areas the change does not touch, for Playwright's testIgnore,
 * so a PR runs the kept flows of its own areas and not the whole suite.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FLOWS_DIR = '.github/scout/flows';
const FEATURES_DIR = 'e2e/scout/features';

/** Every area file, parsed. Files without front matter are areas with no paths (matched only by name). */
export function loadAreas(root = process.cwd()) {
  const dir = join(root, FLOWS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseArea(f.slice(0, -3), readFileSync(join(dir, f), 'utf8')));
}

export function parseArea(slug, text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = m ? text.slice(m[0].length) : text;
  const front = m ? m[1] : '';
  const title = front.match(/^title:\s*(.+)$/m)?.[1]?.trim() || slug;
  const paths = [];
  const list = front.match(/^paths:\s*\n((?:\s+-\s*.+\n?)*)/m);
  if (list) for (const line of list[1].split('\n')) {
    const p = line.match(/^\s+-\s*(.+?)\s*$/)?.[1];
    if (p) paths.push(p.replace(/^["']|["']$/g, ''));
  }
  const inline = front.match(/^paths:\s*\[(.*)\]\s*$/m);
  if (inline) for (const p of inline[1].split(',')) if (p.trim()) paths.push(p.trim().replace(/^["']|["']$/g, ''));
  return { slug, title, paths, guidance: body.trim(), file: `${FLOWS_DIR}/${slug}.md` };
}

/** A minimal glob: `**` any depth, `*` within a segment, a bare directory prefix matches everything under it. */
export function globToRegExp(glob) {
  let g = glob.trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  const re = g
    .split('**')
    .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${re}$`);
}

/** The areas whose paths match any of the changed files. An area with no paths never matches by file. */
export function matchAreas(files, areas) {
  const list = files.map((f) => f.trim().replace(/^\.\//, '')).filter(Boolean);
  return areas.filter((a) => a.paths.some((p) => {
    const re = globToRegExp(p);
    return list.some((f) => re.test(f));
  }));
}

/** Playwright `testIgnore` globs for the kept flows of every area not in `keep`. */
export function ignoreFor(areas, keep) {
  const keepSlugs = new Set(keep.map((a) => a.slug));
  return areas.filter((a) => !keepSlugs.has(a.slug)).map((a) => `${FEATURES_DIR}/${a.slug}/**`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const all = process.argv.includes('--all');
  const areas = loadAreas();
  let matched = areas;
  if (!all) {
    let input = '';
    try {
      input = readFileSync(0, 'utf8');
    } catch {
      input = '';
    }
    matched = matchAreas(input.split('\n'), areas);
  }
  // Kept flows that belong to no area file (an area folder without a guidance file) run on every PR.
  const ignore = all ? [] : ignoreFor(areas, matched);
  process.stdout.write(JSON.stringify({ areas: matched, ignore }, null, 2));
}
