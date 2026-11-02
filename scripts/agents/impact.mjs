/**
 * Classifies a change by how much it can hurt, using `.github/agents/risk-map.json`.
 * Each file gets the highest tier any rule gives it (an admin page that moves money is critical);
 * the change gets the highest tier of its files.
 *
 *   node .crew/scripts/agents/impact.mjs app/api/checkout/route.ts app/admin/x/page.tsx
 *   gh pr diff 12 --name-only | node .crew/scripts/agents/impact.mjs -
 *
 * Prints { tier, reasons: [{ tier, rule, files }] }.
 */
import { readFileSync } from 'node:fs';

export const ORDER = ['low', 'normal', 'high', 'critical'];
// The map belongs to the repo the crew is working in (the current directory), not to the crew.
const map = JSON.parse(readFileSync('.github/agents/risk-map.json', 'utf8'));

function globToRegex(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001') // "**/": any number of folders, including none
    .replace(/\*\*/g, '\u0002') // "**": anything
    .replace(/\*/g, '[^/]*') // "*": within one folder
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp(`^${re}$`);
}

const rules = Object.entries(map.tiers).flatMap(([tier, { rules }]) =>
  rules.map((r) => ({
    tier,
    name: r.name,
    generic: !!r.generic,
    test: r.keyword ? (f) => new RegExp(`(${r.keyword})`, 'i').test(f) : (f) => r.glob.some((g) => globToRegex(g).test(f)),
  })),
);

// Broad "high" rules that admin-only and tooling paths should override: `app/api/admin/**` is also under
// `app/api/*/**`, but it's an admin route. Specific rules (money, auth, customer pages) are never overridden.
const GENERIC = new Set(['customer and shop APIs', 'shared code under customer pages']); // or `"generic": true` in the map
const rank = (r) => ORDER.indexOf(r.tier);

/** Tier for one file and the rule that set it. */
export function classifyFile(file) {
  const hits = rules.filter((r) => r.test(file));
  if (!hits.length) return { tier: map.default, rule: 'default' };
  const specific = hits.filter((h) => h.tier !== 'low' && !h.generic && !GENERIC.has(h.name));
  const low = hits.find((h) => h.tier === 'low');
  const chosen = specific.length
    ? specific.reduce((a, b) => (rank(b) > rank(a) ? b : a))
    : (low ?? hits.reduce((a, b) => (rank(b) > rank(a) ? b : a)));
  return { tier: chosen.tier, rule: chosen.name };
}

export function classify(files) {
  const byRule = new Map();
  let tier = files.length ? 'low' : map.default;
  for (const file of files) {
    const c = classifyFile(file);
    if (ORDER.indexOf(c.tier) > ORDER.indexOf(tier)) tier = c.tier;
    const key = `${c.tier}:${c.rule}`;
    byRule.set(key, [...(byRule.get(key) ?? []), file]);
  }
  const reasons = [...byRule.entries()]
    .map(([key, list]) => ({ tier: key.split(':')[0], rule: key.slice(key.indexOf(':') + 1), files: list.slice(0, 10) }))
    .sort((a, b) => ORDER.indexOf(b.tier) - ORDER.indexOf(a.tier));
  return { tier, reasons };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const files =
    args[0] === '-'
      ? readFileSync(0, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : args;
  console.log(JSON.stringify(classify(files)));
}
