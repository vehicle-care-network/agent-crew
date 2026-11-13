#!/usr/bin/env bash
# Bolt in a sandbox: `.github/workflows/agent-bolt.yml` as one script. See common.sh for the environment.
# PARAMS: { mission_id, mode: mock|build, task, feedback, mock_url, branch }. HQ cloned `branch` when it
# is set (an existing PR branch to build on), else the default branch; a fresh mission gets a new
# `agent/<mission>` branch, which HQ opens as a PR once the push is reported.
AGENT=bolt
cd "$(dirname "$0")/../../.." && . .crew/scripts/run/common.sh

[ -n "$MISSION_ID" ] || die "No mission_id in the request"
BOLT_MODE=$(param mode); BOLT_MODE="${BOLT_MODE:-build}"
BOLT_BRANCH=$(param branch)
BOLT_TASK=$(param task)
BOLT_FEEDBACK=$(param feedback)
BOLT_MOCK_URL=$(param mock_url)
export BOLT_MODE BOLT_BRANCH BOLT_TASK BOLT_FEEDBACK BOLT_MOCK_URL

# ---- Read the request
if [ -n "$BOLT_BRANCH" ]; then
  [ "$BOLT_MODE" = build ] || die "branch only applies in build mode"
  [[ "$BOLT_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Bad branch '$BOLT_BRANCH'"
  gh api "repos/$GITHUB_REPOSITORY/branches/$BOLT_BRANCH" --jq .name >/dev/null || die "No branch $BOLT_BRANCH in $GITHUB_REPOSITORY"
  BRANCH="$BOLT_BRANCH"
  git fetch -q origin "$BOLT_BRANCH" && git checkout -q "$BOLT_BRANCH" && git reset -q --hard "origin/$BOLT_BRANCH"
  say "Building on the existing branch $BRANCH at $(git rev-parse --short HEAD)"
else
  BRANCH="agent/$MISSION_ID"
  say "A fresh branch $BRANCH from $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD)"
fi
unshallow

crew_render
[ "$BOLT_MODE" = build ] && install_deps
[ "$BOLT_MODE" = build ] && [ -z "$BOLT_BRANCH" ] && git checkout -q -b "$BRANCH"
mkdir -p agent-out
heartbeat_start ""
MODEL=$(pick_model claude-opus-5-5)

# ---- Bolt works
PROMPT=$(printf 'Follow the brief in .crew/briefs/BOLT.md.\nMISSION_ID: %s\nBOLT_MODE: %s\nBOLT_BRANCH: %s\nThe task, feedback and mock link are in the environment variables BOLT_TASK, BOLT_FEEDBACK and BOLT_MOCK_URL.\n' "$MISSION_ID" "$BOLT_MODE" "$BOLT_BRANCH")
if dry_run; then
  say "DRY_RUN: a canned change instead of running Claude"
  echo "Dry run $(date -u +%FT%TZ)" > DRY_RUN.txt
  jq -n '{title:"Dry run from the sandbox", summary:"Nothing was built."}' > agent-out/pr.json
else
  run_claude "$BOLT_MODE" "$PROMPT" "$MODEL" 200 Bash,Read,Write,Edit,Glob,Grep
fi

if [ "$BOLT_MODE" = mock ]; then
  # Mocks are Nova's now; an older HQ may still ask Bolt for one.
  test -s agent-out/mock.html || die "Bolt didn't write agent-out/mock.html"
  pathname=$(node "$HQ_MJS" upload "$MISSION_ID" agent-out/mock.html)
  notes=$(cat agent-out/notes.md 2>/dev/null || true)
  hq_report "$(jq -n --arg p "$pathname" --arg n "$notes" '{agent:"bolt",type:"mock",pathname:$p,notes:$n}')"
  say "Done."
  exit 0
fi

# ---- Push the branch and tell HQ
if [ -s agent-out/blocked.md ]; then FAIL_REASON=$(head -c 400 agent-out/blocked.md); die "Bolt is blocked: $FAIL_REASON"; fi
test -s agent-out/pr.json || die "Bolt didn't write agent-out/pr.json"
git add -A
git diff --cached --quiet && die "Bolt made no changes"
title=$(jq -r .title agent-out/pr.json)
git "${GIT_AS[@]}" commit -q -m "$title" -m "Agent HQ mission $MISSION_ID"
# A fresh mission branch is new on the remote; an existing PR branch gets a plain (never forced) push on
# top of what is there, so a commit someone made meanwhile is never lost.
push_branch "$BRANCH"
hq_report "$(jq -n --arg b "$BRANCH" --arg t "$title" --arg s "$(jq -r .summary agent-out/pr.json)" '{agent:"bolt",type:"built",branch:$b,title:$t,summary:$s}')"
say "Done."
