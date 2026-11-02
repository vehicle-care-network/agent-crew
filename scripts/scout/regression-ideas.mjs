/**
 * Turns a regression run's failures into ideas for Agent HQ's inbox: one per bug Scout wrote in
 * bugs.json, and one per failed flow it didn't cover, each with steps to reproduce. Prints a JSON array
 * for `.crew/scripts/agents/hq.mjs ideas-post`. Known issues stay deduplicated by fingerprint in HQ.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadTests } from './results.mjs';

const out = process.env.SCOUT_OUT || 'scout-out';
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const tests = loadTests(out) ?? [];
const failed = tests.filter((t) => t.status !== 'passed' && t.status !== 'skipped');
let bugs = [];
try {
  bugs = existsSync(`${out}/bugs.json`) ? JSON.parse(readFileSync(`${out}/bugs.json`, 'utf8')) : [];
} catch {
  bugs = [];
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
const impact = { critical: 'critical', major: 'high', minor: 'normal' };
const ideas = [];

for (const b of Array.isArray(bugs) ? bugs : []) {
  ideas.push({
    title: `Regression: ${String(b.title || b.flow).slice(0, 100)}`,
    category: 'bug',
    impact: impact[b.severity] ?? 'high',
    effort: 'M',
    confidence: 'high',
    why: `Scout's regression run on main found this. Expected: ${b.expected || 'see steps'}. Actual: ${b.actual || 'see steps'}.`,
    suggestion: `Steps to reproduce:\n${(b.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nEvidence: ${runUrl}`,
    evidence: [],
    fingerprint: `regression:${slug(b.flow || b.title)}`,
  });
}
for (const t of failed) {
  if (bugs.some?.((b) => b.flow && (t.title.endsWith(b.flow) || b.flow.endsWith(t.title)))) continue;
  ideas.push({
    title: `Regression: ${t.title}`.slice(0, 110),
    category: 'bug',
    impact: 'high',
    effort: 'M',
    confidence: 'medium',
    why: `This core flow failed on main in Scout's regression run: ${t.error || 'no assertion message'}.`,
    suggestion: `Steps that worked before the failure:\n${t.shots.map((a, i) => `${i + 1}. ${a.name}`).join('\n') || '(none recorded)'}\n\nWatch the run's video in Agent HQ (Missions → main health). Run: ${runUrl}`,
    evidence: [],
    fingerprint: `regression:${slug(t.title)}`,
  });
}
console.log(JSON.stringify(ideas.slice(0, 8)));
