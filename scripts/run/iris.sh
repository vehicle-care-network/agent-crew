#!/usr/bin/env bash
# Iris in a sandbox: the same review as `.github/workflows/agent-iris.yml`, as one script, for a runner
# that is not GitHub Actions (Agent HQ's Vercel sandboxes). HQ starts the sandbox on the PR's branch, lays
# the crew into `.crew/`, and runs this with:
#
#   PARAMS                         JSON from HQ: { pr_number, mission_id, round, instructions }
#   GITHUB_REPOSITORY, GH_TOKEN    the repo and a token that can read it and post the review
#   AGENT_HQ_URL                   HQ, plus ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN pointed at HQ's id-token
#                                  stand-in with the job token, so hq.mjs and usage.mjs work unchanged
#   CLAUDE_CODE_OAUTH_TOKEN        or ANTHROPIC_API_KEY; HAS_SUBSCRIPTION_TOKEN for the Spend view
#   AGENT_MODEL_IRIS               optional default model (HQ's choice wins, as in the workflow)
#   DRY_RUN=1                      stop before Claude and GitHub: a canned review, nothing posted
#
# Differences from the workflow: HQ asked for this review, so the pull_request-event skips (already
# reviewed, crew-only PR, no files of the PR changed) don't apply; Claude runs as `claude -p`.
set -euo pipefail

say() { echo "[Iris] $*"; }

PARAMS="${PARAMS:-{\}}"
PR_NUMBER=$(jq -r '.pr_number // empty' <<<"$PARAMS")
[ -n "$PR_NUMBER" ] || { echo "::error::No PR number in the request"; exit 1; }
MISSION_ID=$(jq -r '.mission_id // empty' <<<"$PARAMS")
ROUND=$(jq -r '.round // empty' <<<"$PARAMS")
INSTRUCTIONS=$(jq -r '.instructions // empty' <<<"$PARAMS")
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
export PR_NUMBER MISSION_ID INSTRUCTIONS GITHUB_REPOSITORY GH_TOKEN
RUN_URL="${RUN_URL:-the sandbox log on the mission in HQ}"
HEARTBEAT=""

# Whatever fails, HQ hears about it (as the workflow's "Tell HQ it failed" step), and the heartbeat stops.
finish() {
  local code=$?
  [ -n "$HEARTBEAT" ] && kill "$HEARTBEAT" 2>/dev/null || true
  if [ "$code" -ne 0 ] && [ -n "$MISSION_ID" ]; then
    node .crew/scripts/agents/hq.mjs report "$MISSION_ID" "$(jq -n --arg e "The Iris run failed in the sandbox. See $RUN_URL" '{agent:"iris",type:"failed",error:$e}')" || true
  fi
  exit "$code"
}
trap finish EXIT

# ---- Resolve the PR
gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" > pr.json
if [ "$(jq -r .head.repo.full_name pr.json)" != "$GITHUB_REPOSITORY" ]; then
  echo "::error::Iris only reviews branches in this repository, not forks."
  exit 1
fi
HEAD_SHA=$(jq -r .head.sha pr.json)
say "PR #$PR_NUMBER at $HEAD_SHA"

# ---- What's new since the last review
gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/reviews" \
  --jq '.[] | select((.body // "") | contains("<!-- iris-verdict:")) | .commit_id' > iris-reviews.txt || true
SINCE=$(tail -n 1 iris-reviews.txt 2>/dev/null || true)
ROUND="${ROUND:-$(wc -l < iris-reviews.txt | tr -d ' ')}"
# since is empty after a force-push that dropped the reviewed commit: then she reviews it all.
if [ -n "$SINCE" ] && { [ "$SINCE" = "$HEAD_SHA" ] || ! gh api "repos/$GITHUB_REPOSITORY/compare/$SINCE...$HEAD_SHA" --jq '.files[].filename' > /dev/null 2>&1; }; then
  SINCE=""
fi
rm -f iris-reviews.txt
export ROUND

# ---- The checkout: HQ cloned the PR's branch; make sure the head commit is what we review.
git fetch -q origin "$HEAD_SHA" 2>/dev/null || git fetch -q origin
git checkout -q "$HEAD_SHA"

# ---- The crew: laid into .crew/ by the runner; render the briefs for this repo.
[ -f .crew/scripts/setup/render.mjs ] || { echo "::error::.crew/ is missing; the runner lays the crew in before starting this"; exit 1; }
node .crew/scripts/setup/render.mjs

# ---- Check in with HQ, and keep checking in so HQ knows the run is alive.
if [ -n "$MISSION_ID" ]; then
  node .crew/scripts/agents/hq.mjs status "$MISSION_ID" iris "Reading the PR."
  ( while sleep 600; do node .crew/scripts/agents/hq.mjs status "$MISSION_ID" iris "" || true; done ) &
  HEARTBEAT=$!
fi

# ---- Pick the model (set in Agent HQ), else the default handed in, else the crew's default.
MODEL=$(node .crew/scripts/agents/hq.mjs model iris 2>/dev/null || true)
MODEL="${MODEL:-${AGENT_MODEL_IRIS:-claude-opus-5-5}}"
say "Model: $MODEL"

# ---- Iris reviews
mkdir -p agent-out
PROMPT=$(printf 'Follow the brief in .crew/briefs/IRIS.md.\nPR_NUMBER: %s\nROUND: %s\nSINCE: %s\nMISSION_ID: %s\nINSTRUCTIONS: %s\n' "$PR_NUMBER" "$ROUND" "$SINCE" "$MISSION_ID" "$INSTRUCTIONS")
if [ "${DRY_RUN:-}" = "1" ]; then
  say "DRY_RUN: writing a canned review instead of running Claude"
  jq -n '{verdict:"approve", summary:"Dry run from the sandbox: nothing was reviewed.", comments:[], impact:{tier:"low", reasons:["dry run"]}}' > agent-out/review.json
else
  set +e
  claude -p "$PROMPT" --model "$MODEL" --max-turns 120 --allowedTools Bash,Read,Glob,Grep,Write --output-format stream-json --verbose > agent-out/claude.ndjson
  CLAUDE_EXIT=$?
  set -e
  # claude-code-action's execution file is a JSON array of the same messages; usage.mjs reads that shape.
  jq -s '.' agent-out/claude.ndjson > agent-out/execution.json 2>/dev/null || echo '[]' > agent-out/execution.json
  node .crew/scripts/agents/usage.mjs agent-out/execution.json iris review "$MISSION_ID" "$PR_NUMBER" || true
  [ "$CLAUDE_EXIT" -eq 0 ] || say "Claude exited $CLAUDE_EXIT"
fi

# ---- Post the review
test -s agent-out/review.json || { echo "::error::Iris didn't write agent-out/review.json"; exit 1; }
if [ "${DRY_RUN:-}" = "1" ]; then
  say "DRY_RUN: would post this review on #$PR_NUMBER:"
  cat agent-out/review.json
  RESULT=$(jq -c '{verdict, comments: (.comments | length), summary, impact}' agent-out/review.json)
else
  RESULT=$(node .crew/scripts/agents/post-review.mjs)
fi
say "Posted: $RESULT"

# ---- Tell HQ the verdict
if [ -n "$MISSION_ID" ]; then
  node .crew/scripts/agents/hq.mjs report "$MISSION_ID" "$(jq -c '{agent:"iris",type:"review",verdict,comments,summary,impact}' <<<"$RESULT")"
fi
say "Done."
