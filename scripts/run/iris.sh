#!/usr/bin/env bash
# Iris in a sandbox: the same review as `.github/workflows/agent-iris.yml`, as one script. See common.sh
# for the environment HQ gives it. PARAMS: { pr_number, mission_id, round, instructions, event, action }.
# `event: pull_request` (with `action`) is HQ passing on the repo's own PR event, in a repo whose agents
# are off GitHub Actions: then the workflow's skips apply (already reviewed, new commits that don't touch
# the PR's files, a crew-only PR, an agent/* branch HQ sends her to anyway).
AGENT=iris
cd "$(dirname "$0")/../../.." && . .crew/scripts/run/common.sh

PR_NUMBER=$(param pr_number)
[ -n "$PR_NUMBER" ] || die "No PR number in the request"
ROUND=$(param round)
INSTRUCTIONS=$(param instructions)
EVENT=$(param event)
ACTION=$(param action)
export PR_NUMBER INSTRUCTIONS

# ---- Resolve the PR
load_pr "$PR_NUMBER"
HEAD_SHA=$(jq -r .head.sha pr.json)
HEAD_REF=$(jq -r .head.ref pr.json)
say "PR #$PR_NUMBER ($HEAD_REF) at ${HEAD_SHA:0:7}"
if [ "$EVENT" = pull_request ]; then
  # The caller workflow's own `if`: drafts wait, and Bolt's branches get Iris from HQ's planner, not from here.
  [ "$(jq -r .draft pr.json)" = true ] && { say "A draft: no review until it's marked ready."; exit 0; }
  case "$HEAD_REF" in agent/*) say "An agent/* branch: HQ sends Iris to those itself."; exit 0 ;; esac
fi

# ---- What's new since the last review
gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/reviews" \
  --jq '.[] | select((.body // "") | contains("<!-- iris-verdict:")) | .commit_id' > iris-reviews.txt || true
SINCE=$(tail -n 1 iris-reviews.txt 2>/dev/null || true)
ROUND="${ROUND:-$(wc -l < iris-reviews.txt | tr -d ' ')}"
ON_PUSH=false; [ "$EVENT" = pull_request ] && [ "$ACTION" = synchronize ] && ON_PUSH=true
SKIP=""
if [ -n "$SINCE" ] && [ "$SINCE" != "$HEAD_SHA" ] && gh api "repos/$GITHUB_REPOSITORY/compare/$SINCE...$HEAD_SHA" --jq '.files[].filename' > new-files.txt 2>/dev/null; then
  if [ "$ON_PUSH" = true ]; then
    gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/files" --jq '.[].filename' | sort -u > pr-files.txt
    [ -z "$(sort -u new-files.txt | comm -12 - pr-files.txt)" ] && SKIP="The new commits don't change this PR's files; nothing new to review."
  fi
elif [ "$SINCE" = "$HEAD_SHA" ] && [ "$ON_PUSH" = true ]; then
  SKIP="Iris already reviewed ${HEAD_SHA:0:7}."
else
  # since is empty after a force-push that dropped the reviewed commit: then she reviews it all.
  SINCE=""
fi
if [ "$EVENT" = pull_request ] && [ -z "$SKIP" ]; then
  # PRs that only change the crew's own setup get no automatic review: HQ marks them ready to land.
  gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/files" --jq '.[].filename' > all-files.txt
  others=$(grep -vE '^(\.github/|scripts/agents/|scripts/scout/|e2e/scout/_support/)' all-files.txt || true)
  [ -s all-files.txt ] && [ -z "$others" ] && SKIP="Only the crew's own setup changed; no automatic review."
fi
rm -f iris-reviews.txt new-files.txt pr-files.txt all-files.txt
if [ -n "$SKIP" ]; then say "$SKIP"; exit 0; fi
export ROUND

# ---- The checkout: HQ cloned the PR's branch; make sure the head commit is what we review.
git fetch -q origin "$HEAD_SHA" || git fetch -q origin
git checkout -q "$HEAD_SHA"

crew_render
heartbeat_start "Reading the PR."
MODEL=$(pick_model claude-opus-5-5)

# ---- Iris reviews
PROMPT=$(printf 'Follow the brief in .crew/briefs/IRIS.md.\nPR_NUMBER: %s\nROUND: %s\nSINCE: %s\nMISSION_ID: %s\nINSTRUCTIONS: %s\n' "$PR_NUMBER" "$ROUND" "$SINCE" "$MISSION_ID" "$INSTRUCTIONS")
if dry_run; then
  say "DRY_RUN: writing a canned review instead of running Claude"
  mkdir -p agent-out
  jq -n '{verdict:"approve", summary:"Dry run from the sandbox: nothing was reviewed.", comments:[], impact:{tier:"low", reasons:["dry run"]}}' > agent-out/review.json
else
  run_claude review "$PROMPT" "$MODEL" 120 Bash,Read,Glob,Grep,Write
fi

# ---- Post the review
test -s agent-out/review.json || die "Iris didn't write agent-out/review.json"
if dry_run; then
  say "DRY_RUN: would post this review on #$PR_NUMBER:"; cat agent-out/review.json
  RESULT=$(jq -c '{verdict, comments: (.comments | length), summary, impact}' agent-out/review.json)
else
  RESULT=$(node .crew/scripts/agents/post-review.mjs)
fi
say "Posted: $RESULT"

# ---- Tell HQ the verdict
hq_report "$(jq -c '{agent:"iris",type:"review",verdict,comments,summary,impact}' <<<"$RESULT")"
say "Done."
