#!/usr/bin/env bash
# Patch in a sandbox: `.github/workflows/agent-patch.yml` as one script. See common.sh for the environment.
# PARAMS: { mission_id, pr_number, reason: review|qa|build|conflicts|request, instructions, round }.
# HQ cloned the PR's branch; Patch fixes on it and pushes with the App's token.
AGENT=patch
cd "$(dirname "$0")/../../.." && . .crew/scripts/run/common.sh

PR_NUMBER=$(param pr_number)
[ -n "$PR_NUMBER" ] || die "No PR number in the request"
PATCH_REASON=$(param reason); PATCH_REASON="${PATCH_REASON:-review}"
INSTRUCTIONS=$(param instructions)
export PR_NUMBER PATCH_REASON INSTRUCTIONS

# ---- Find the PR's branch
case "$PATCH_REASON" in review|qa|build|conflicts|request) ;; *) die "Unknown reason '$PATCH_REASON'" ;; esac
load_pr "$PR_NUMBER"
BRANCH=$(jq -r .head.ref pr.json)
BASE=$(jq -r .base.ref pr.json)
# On its own, Patch only touches the crew's agent/* branches. A request you sent from HQ, including
# resolving conflicts, may target a developer's branch in this repo (never a fork).
if [ "$PATCH_REASON" != request ] && [ "$PATCH_REASON" != conflicts ]; then
  case "$BRANCH" in agent/*) ;; *) die "Patch only fixes agent/* branches, not $BRANCH" ;; esac
fi
say "PR #$PR_NUMBER on $BRANCH (base $BASE), reason $PATCH_REASON"
git fetch -q origin "$BRANCH" && git checkout -q "$BRANCH" && git reset -q --hard "origin/$BRANCH"
unshallow
mkdir -p agent-out

# ---- Merge conflicts: merge the base branch in without committing, before the crew is set up, so a branch
# that predates the crew's config gets it from the base. Clean parts are staged; conflicted files keep
# their markers for Patch to resolve (listed in agent-out/conflicts.txt).
if [ "$PATCH_REASON" = conflicts ]; then
  git fetch -q origin "$BASE"
  git "${GIT_AS[@]}" merge --no-ff --no-commit "origin/$BASE" || true
  git diff --name-only --diff-filter=U > agent-out/conflicts.txt
  say "Conflicted files:"; cat agent-out/conflicts.txt
  if [ ! -s agent-out/conflicts.txt ] && [ ! -f .git/MERGE_HEAD ]; then say "origin/$BASE is already merged in; nothing to resolve"; fi
fi

crew_render
install_deps
heartbeat_start ""
MODEL=$(pick_model claude-opus-5-5)

# ---- Patch fixes
PROMPT=$(printf 'Follow the brief in .crew/briefs/PATCH.md.\nPR_NUMBER: %s\nPATCH_REASON: %s\nINSTRUCTIONS: %s\nMISSION_ID: %s\n' "$PR_NUMBER" "$PATCH_REASON" "$INSTRUCTIONS" "$MISSION_ID")
if dry_run; then
  say "DRY_RUN: a canned change instead of running Claude"
  echo "Dry run $(date -u +%FT%TZ)" > DRY_RUN.txt
  echo "Dry run: nothing was fixed." > agent-out/summary.md
else
  run_claude "$PATCH_REASON" "$PROMPT" "$MODEL" 150 Bash,Read,Write,Edit,Glob,Grep
fi

# ---- Push the fixes and tell HQ
# Patch's lesson from this failure joins the crew's lessons, so Bolt doesn't make it again.
if [ -s agent-out/lesson.md ]; then printf '\n%s\n' "$(cat agent-out/lesson.md)" >> .github/agents/LESSONS.md; fi
rm -rf agent-out/lesson.md
git add -A
# A merge with no file changes is still a commit worth pushing (it records the base as merged).
if [ ! -f .git/MERGE_HEAD ]; then git diff --cached --quiet && die "Patch made no changes"; fi
left=$(git diff --cached --name-only -z | xargs -0 -r grep -l -E '^(<<<<<<<|>>>>>>>) ' 2>/dev/null || true)
[ -z "$left" ] || die "Conflict markers are still in: $left"
case "$PATCH_REASON" in
  qa) msg='Address QA failures' ;;
  build) msg='Fix the build' ;;
  conflicts) msg="Merge $BASE and resolve conflicts" ;;
  request) msg='Make the requested change' ;;
  *) msg='Address review feedback' ;;
esac
git "${GIT_AS[@]}" commit -q -m "$msg" -m "Agent HQ mission $MISSION_ID"
push_branch "$BRANCH"
hq_report "$(jq -n --arg s "$(head -c 1500 agent-out/summary.md 2>/dev/null || true)" '{agent:"patch",type:"fixed",summary:$s}')"
say "Done."
