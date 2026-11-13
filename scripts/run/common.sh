# shellcheck shell=bash
# Shared by `scripts/run/<agent>.sh`: one agent's whole run as a script, for a runner that is not GitHub
# Actions (Agent HQ's Vercel sandboxes). Each script sets AGENT, then sources this. HQ starts the sandbox
# with the repo cloned (see the crew README, "The same run off GitHub Actions"), the crew laid into
# `.crew/`, and these in the environment:
#
#   PARAMS                         JSON from HQ: the same object the workflow gets in `params`
#   GITHUB_REPOSITORY, GH_TOKEN    the repo and an App token for it, scoped to what this agent needs
#                                  (read; post reviews and comments; push, for Bolt, Patch and Rocket)
#   AGENT_HQ_URL                   HQ, plus ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN pointed at HQ's id-token
#                                  stand-in with the job token, so hq.mjs and usage.mjs work unchanged
#   RUN_URL                        where a person reads this run's log (the mission in HQ)
#   CLAUDE_CODE_OAUTH_TOKEN        or ANTHROPIC_API_KEY; HAS_SUBSCRIPTION_TOKEN for the Spend view
#   AGENT_MODEL_<AGENT>            optional default model (HQ's choice wins, as in the workflow)
#   DRY_RUN=1                      stop before Claude and before anything is pushed or posted
#
# Differences from the workflows: HQ asked for the run, so an event-driven skip only applies when PARAMS
# names the event (Iris on `pull_request`); Claude runs as `claude -p`; a push uses GH_TOKEN itself (it is
# the HQ App's token, so workflows run on the push, as with the token HQ mints for Actions runs).
set -euo pipefail

: "${AGENT:?AGENT must be set before sourcing common.sh}"
NAME="$(tr '[:lower:]' '[:upper:]' <<<"${AGENT:0:1}")${AGENT:1}"
say() { echo "[$NAME] $*"; }
warn() { echo "::warning::[$NAME] $*"; }
die() { echo "::error::[$NAME] $*"; exit 1; }

PARAMS="${PARAMS:-{\}}"
# One field of the request; empty when missing or null.
param() { jq -r --arg k "$1" '.[$k] // empty' <<<"$PARAMS"; }

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
export GITHUB_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"
export GITHUB_SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
RUN_URL="${RUN_URL:-the sandbox log on the mission in HQ}"
export RUN_URL
HQ_MJS=".crew/scripts/agents/hq.mjs"
MISSION_ID="$(param mission_id)"
export MISSION_ID
HEARTBEAT=""
REPORTED=""
CLAUDE_EXIT=0
# The identity the crew commits with: the HQ App's bot user, so runs on those pushes count as the App's.
GIT_AS=(-c "user.name=$NAME (Agent HQ)" -c "user.email=351332603+vcn-agent-hq[bot]@users.noreply.github.com")

# ---- HQ
hq_status() { [ -n "$MISSION_ID" ] && node "$HQ_MJS" status "$MISSION_ID" "$AGENT" "${1:-}" || true; }
# The run's final word to HQ. Marks the run as reported, so the exit trap sends no second "failed".
hq_report() { [ -n "$MISSION_ID" ] || { say "No mission: not reporting ${1:0:80}"; return 0; }; node "$HQ_MJS" report "$MISSION_ID" "$1"; REPORTED=1; }
# An empty status is a heartbeat: it keeps HQ from flagging a long run as stalled.
heartbeat_start() {
  [ -n "$MISSION_ID" ] || return 0
  hq_status "${1:-}"
  ( while sleep 600; do node "$HQ_MJS" status "$MISSION_ID" "$AGENT" "" || true; done ) &
  HEARTBEAT=$!
}
# Whatever fails, HQ hears about it (as the workflows' "Tell HQ it failed" step), and the heartbeat stops.
# A script sets FAIL_REASON before dying when it has something better than the generic line.
FAIL_REASON=""
finish() {
  local code=$?
  [ -n "$HEARTBEAT" ] && kill "$HEARTBEAT" 2>/dev/null || true
  if [ "$code" -ne 0 ] && [ -n "$MISSION_ID" ] && [ -z "$REPORTED" ]; then
    local reason="${FAIL_REASON:-The $NAME run failed in the sandbox. See $RUN_URL}"
    node "$HQ_MJS" report "$MISSION_ID" "$(jq -n --arg a "$AGENT" --arg e "${reason:0:400}" '{agent:$a,type:"failed",error:$e}')" || true
  fi
  exit "$code"
}
trap finish EXIT

# ---- The crew and the repo
# Renders the briefs for this repo (the setup action's second step). Prints the node version it would pick.
crew_render() {
  [ -f .crew/scripts/setup/render.mjs ] || die ".crew/ is missing; the runner lays the crew in before starting this"
  node .crew/scripts/setup/render.mjs
}
crew_cmd() { jq -r --arg k "$1" '.commands[$k] // empty' .github/agents/crew.json; }
install_deps() { say "Installing dependencies"; bash -c "$(crew_cmd install)"; }
scout_port() { jq -r '.scout.port' .github/agents/crew.json; }
# A full history: merges, `git log` and land.mjs need it; a clone HQ made may be shallow.
unshallow() { if [ "$(git rev-parse --is-shallow-repository)" = true ]; then git fetch -q --unshallow || git fetch -q; fi; }
# The PR, as `gh api` returns it, into pr.json; refuses forks (no secrets go near fork code).
load_pr() {
  local n="$1"
  [[ "$n" =~ ^[0-9]+$ ]] || die "Bad pr_number '$n'"
  gh api "repos/$GITHUB_REPOSITORY/pulls/$n" > pr.json
  [ "$(jq -r .head.repo.full_name pr.json)" = "$GITHUB_REPOSITORY" ] || die "$NAME only works on branches in this repository, not forks"
}

# ---- Claude
# The model you picked for this agent in HQ, else the default handed in, else the crew's default.
pick_model() {
  local var="AGENT_MODEL_$(tr '[:lower:]' '[:upper:]' <<<"$AGENT")" chosen
  chosen=$(node "$HQ_MJS" model "$AGENT" 2>/dev/null || true)
  echo "${chosen:-${!var:-$1}}"
}
# Runs Claude as claude-code-action would: `claude -p` with the brief, the model, a turn cap and the
# allowed tools; keeps its stream as the execution file usage.mjs reads, and reports the cost to HQ.
#   run_claude <task-for-spend> <prompt> <model> <max-turns> <allowed-tools> [more claude args...]
# Never fails the script; CLAUDE_EXIT holds the exit code for the caller to judge.
run_claude() {
  local task="$1" prompt="$2" model="$3" turns="$4" tools="$5"
  shift 5
  mkdir -p agent-out
  say "Claude: $model, up to $turns turns"
  set +e
  claude -p "$prompt" --model "$model" --max-turns "$turns" --allowedTools "$tools" --output-format stream-json --verbose "$@" > agent-out/claude.ndjson
  CLAUDE_EXIT=$?
  set -e
  # claude-code-action's execution file is a JSON array of the same messages; usage.mjs reads that shape.
  jq -s '.' agent-out/claude.ndjson > agent-out/execution.json 2>/dev/null || echo '[]' > agent-out/execution.json
  node .crew/scripts/agents/usage.mjs agent-out/execution.json "$AGENT" "$task" "$MISSION_ID" "${PR_NUMBER:-}" || true
  [ "$CLAUDE_EXIT" -eq 0 ] || warn "Claude exited $CLAUDE_EXIT"
  return 0
}
dry_run() { [ "${DRY_RUN:-}" = "1" ]; }

# ---- Git
# Commits what the agent changed as the App's bot user and pushes it to `branch` (plain, never forced,
# unless told to). GH_TOKEN is the App's token, so the repo's workflows run on the push.
push_branch() {
  local branch="$1" force="${2:-}"
  local remote="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
  if dry_run; then say "DRY_RUN: would push $(git rev-parse --short HEAD) to $branch${force:+ (forced)}"; return 0; fi
  if [ -n "$force" ]; then git push -q -f "$remote" "HEAD:refs/heads/$branch"; else git push -q "$remote" "HEAD:refs/heads/$branch"; fi
  say "Pushed $(git rev-parse --short HEAD) to $branch"
}
