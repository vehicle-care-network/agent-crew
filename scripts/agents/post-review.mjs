/**
 * Posts Iris's review on a PR from `agent-out/review.json`, written by the agent:
 *
 *   { "verdict": "approve" | "changes", "summary": "...", "comments": [{ "path": "...", "line": 42, "body": "..." }],
 *     "impact": { "tier": "critical" | "high" | "normal" | "low", "reasons": ["..."] } }
 *
 * Posted as a COMMENT review (Actions can't approve PRs here, and approving is a person's call anyway).
 * The verdict rides in a marker so HQ and later rounds can read it. Inline comments on lines outside the
 * diff are moved into the review body instead of failing the whole review.
 *
 * Env: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, ROUND. Prints the verdict and comment count as JSON.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { GITHUB_REPOSITORY: repo, PR_NUMBER: pr, ROUND = '0' } = process.env;
const review = JSON.parse(readFileSync('agent-out/review.json', 'utf8'));
const verdict = review.verdict === 'approve' ? 'approve' : 'changes';
const comments = Array.isArray(review.comments) ? review.comments.filter((c) => c.path && Number.isInteger(c.line) && c.body) : [];

const gh = (args, input) => execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

// Lines GitHub accepts inline comments on: added or context lines on the RIGHT side of the diff.
const files = JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}/files?per_page=100`]));
const commentable = new Map();
for (const f of files) {
  const lines = new Set();
  let line = 0;
  for (const row of (f.patch || '').split('\n')) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) line = Number(hunk[1]);
    else if (row.startsWith('-')) continue;
    else {
      lines.add(line);
      line++;
    }
  }
  commentable.set(f.filename, lines);
}
const inline = comments.filter((c) => commentable.get(c.path)?.has(c.line));
const loose = comments.filter((c) => !inline.includes(c));

const heading =
  verdict === 'approve' ? '**Iris: looks good.**' : `**Iris: changes needed** (${comments.length} comment${comments.length === 1 ? '' : 's'}).`;
const body = [
  `<!-- iris-verdict: ${verdict} round=${ROUND} -->`,
  heading,
  '',
  review.summary || '',
  loose.length ? `\n**Comments on lines outside the diff**\n${loose.map((c) => `- \`${c.path}:${c.line}\`: ${c.body}`).join('\n')}` : '',
  '\n<sub>Iris is an agent reviewer. Approving and landing stay with a person.</sub>',
].join('\n');

gh(
  ['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'],
  JSON.stringify({ event: 'COMMENT', body, comments: inline.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })) }),
);
// Iris owns the final impact tier: replace whatever impact label is there with hers.
const TIERS = ['critical', 'high', 'normal', 'low'];
const impact = TIERS.includes(review.impact?.tier)
  ? { tier: review.impact.tier, reasons: (review.impact.reasons || []).slice(0, 6).map(String) }
  : null;
if (impact) {
  const labels = JSON.parse(gh(['api', `repos/${repo}/issues/${pr}/labels`])).map((l) => l.name);
  for (const old of labels.filter((l) => l.startsWith('impact:') && l !== `impact:${impact.tier}`)) {
    gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${pr}/labels/${encodeURIComponent(old)}`]);
  }
  if (!labels.includes(`impact:${impact.tier}`))
    gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/labels`, '-f', `labels[]=impact:${impact.tier}`]);
}

console.log(JSON.stringify({ verdict, comments: comments.length, summary: String(review.summary || '').slice(0, 500), impact }));
