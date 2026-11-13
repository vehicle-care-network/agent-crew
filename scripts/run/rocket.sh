#!/usr/bin/env bash
# Rocket in a sandbox: `.github/workflows/agent-rocket.yml` as one script. See common.sh for the
# environment. PARAMS: { mission_id, version, branch, prs: "133,134" (landing order) }. HQ cloned the
# default branch; land.mjs cuts the release branch from it, merges the PRs and runs the checks; Rocket's
# agent only steps in for a conflict or a failing check. The branch is pushed with the App's token.
AGENT=rocket
cd "$(dirname "$0")/../../.." && . .crew/scripts/run/common.sh

[ -n "$MISSION_ID" ] || die "No mission_id in the request"
ROCKET_VERSION=$(param version)
ROCKET_BRANCH=$(param branch)
ROCKET_PRS=$(param prs)
export ROCKET_VERSION ROCKET_BRANCH ROCKET_PRS
[[ "$ROCKET_VERSION" =~ ^v[0-9][0-9.]*$ ]] || die "Bad version '$ROCKET_VERSION' (expected v2026.11.05 or v2026.11.05.2)"
[[ "$ROCKET_BRANCH" =~ ^release/[A-Za-z0-9._/-]+$ ]] || die "Bad branch '$ROCKET_BRANCH' (expected release/...)"
[[ "$ROCKET_PRS" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "Bad prs '$ROCKET_PRS' (expected PR numbers, comma-separated)"
say "Release $ROCKET_VERSION on $ROCKET_BRANCH: PRs $ROCKET_PRS"

# land.mjs merges PR branches: it needs the whole history and every branch fetchable.
unshallow
git fetch -q origin
crew_render
install_deps
mkdir -p agent-out
heartbeat_start ""

# ---- Land the PRs: the deterministic part. Stops at the first conflict or failing check.
GITHUB_OUTPUT=agent-out/land.out; : > "$GITHUB_OUTPUT"; export GITHUB_OUTPUT
node .crew/scripts/rocket/land.mjs auto
STATUS=$(grep '^status=' "$GITHUB_OUTPUT" | tail -1 | cut -d= -f2-)
say "Landing: ${STATUS:-?}"

if [ "$STATUS" = needs-rocket ]; then
  MODEL=$(pick_model claude-opus-5-5)
  PROMPT=$(printf 'Follow the brief in .crew/briefs/ROCKET.md.\nMISSION_ID: %s\nVERSION: %s\nBRANCH: %s\n' "$MISSION_ID" "$ROCKET_VERSION" "$ROCKET_BRANCH")
  # The landing still has to finish and reach HQ when the agent gives up or dies.
  if dry_run; then say "DRY_RUN: Rocket's agent would resolve the stop here"; else run_claude land "$PROMPT" "$MODEL" 200 Bash,Read,Write,Edit,Glob,Grep; fi
fi

# ---- Finish: whatever is still stuck is left out with the reason, the rest lands unattended.
node .crew/scripts/rocket/land.mjs finish
unset GITHUB_OUTPUT

# ---- Push the release branch (and the repo's staging branch, when crew.json names one)
if [ -s agent-out/lesson.md ]; then
  printf '\n%s\n' "$(cat agent-out/lesson.md)" >> .github/agents/LESSONS.md
  git add .github/agents/LESSONS.md
  git "${GIT_AS[@]}" commit -q -m "Add Rocket's lesson from $ROCKET_VERSION" -m "Agent HQ mission $MISSION_ID"
fi
rm -rf agent-out/lesson.md
push_branch "$ROCKET_BRANCH" force
STAGING=$(jq -r '.release.stagingBranch // empty' .github/agents/crew.json)
[ -z "$STAGING" ] || push_branch "$STAGING" force
SHA=$(git rev-parse HEAD)

# ---- Tell HQ what landed
report=$(jq -c --arg sha "$SHA" --arg staging "$STAGING" --arg summary "$(head -c 1500 agent-out/summary.md 2>/dev/null || true)" '{
  agent: "rocket", type: "landed",
  version: .version, branch: .branch, sha: $sha, base: .base,
  landed: [.prs[] | select(.status == "landed") | { pr, title, sha }],
  dropped: [.prs[] | select(.status == "dropped") | { pr, reason }],
  skipped: [.prs[] | select(.status == "skipped") | { pr, reason }],
  staging: (if $staging == "" then null else $staging end),
  notes: (.notes // []),
  summary: $summary
}' agent-out/rocket.json)
if dry_run; then say "DRY_RUN: would report $report"; exit 0; fi
hq_report "$report"
say "Done."
