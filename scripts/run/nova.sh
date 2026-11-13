#!/usr/bin/env bash
# Nova in a sandbox: `.github/workflows/agent-nova.yml` as one script. See common.sh for the environment.
# PARAMS: { mission_id, task, feedback, mock_url, pr_number }. A redesign of an open PR starts from that
# PR's branch (HQ cloned it); everything else from the default branch. The mock goes to HQ, never to git.
AGENT=nova
cd "$(dirname "$0")/../../.." && . .crew/scripts/run/common.sh

[ -n "$MISSION_ID" ] || die "No mission_id in the request"
NOVA_PR_NUMBER=$(param pr_number)
NOVA_TASK=$(param task)
NOVA_FEEDBACK=$(param feedback)
NOVA_MOCK_URL=$(param mock_url)
export NOVA_PR_NUMBER NOVA_TASK NOVA_FEEDBACK NOVA_MOCK_URL

# ---- Read the request
if [ -n "$NOVA_PR_NUMBER" ]; then
  load_pr "$NOVA_PR_NUMBER"
  [ "$(jq -r .state pr.json)" = open ] || die "PR #$NOVA_PR_NUMBER is not open"
  ref=$(jq -r .head.ref pr.json)
  rm -f pr.json
  checkout_branch "$ref"
  say "Redesigning PR #$NOVA_PR_NUMBER on $ref"
else
  say "A new design on $(git rev-parse --abbrev-ref HEAD)"
fi

crew_render
# She reads the real components and styles (and their config), not a running app.
install_deps
mkdir -p agent-out
heartbeat_start ""
MODEL=$(pick_model claude-opus-5-5)

# ---- Nova designs
PROMPT=$(printf 'Follow the brief in .crew/briefs/NOVA.md.\nMISSION_ID: %s\nNOVA_PR_NUMBER: %s\nThe task, feedback and mock link are in the environment variables NOVA_TASK, NOVA_FEEDBACK and NOVA_MOCK_URL.\n' "$MISSION_ID" "$NOVA_PR_NUMBER")
if dry_run; then
  say "DRY_RUN: a canned mock instead of running Claude"
  echo '<!doctype html><title>Dry run</title><h1>Dry run from the sandbox</h1>' > agent-out/mock.html
  echo "Dry run: nothing was designed." > agent-out/notes.md
else
  run_claude mock "$PROMPT" "$MODEL" 60 Bash,Read,Write,Edit,Glob,Grep
fi

# ---- Send the mock to HQ
if [ -s agent-out/blocked.md ]; then FAIL_REASON=$(head -c 400 agent-out/blocked.md); die "Nova is blocked: $FAIL_REASON"; fi
# Nothing to draw (a bug fix, a backend change): HQ sends the mission on to Bolt instead of stopping it.
if [ -s agent-out/no-design.md ] && [ ! -s agent-out/mock.html ]; then
  reason=$(head -c 500 agent-out/no-design.md | tr '\n' ' ')
  say "Nothing to design. $reason"
  hq_report "$(jq -n --arg r "$reason" '{agent:"nova",type:"noDesign",reason:$r}')"
  exit 0
fi
test -s agent-out/mock.html || die "Nova didn't write agent-out/mock.html"
if dry_run; then say "DRY_RUN: would upload agent-out/mock.html ($(wc -c < agent-out/mock.html) bytes)"; exit 0; fi
pathname=$(node "$HQ_MJS" upload "$MISSION_ID" agent-out/mock.html)
notes=$(head -c 2000 agent-out/notes.md 2>/dev/null || true)
hq_report "$(jq -n --arg p "$pathname" --arg n "$notes" '{agent:"nova",type:"mock",pathname:$p,notes:$n}')"
say "Done."
