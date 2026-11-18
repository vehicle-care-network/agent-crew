#!/usr/bin/env bash
# Radar in a sandbox: `.github/workflows/agent-radar.yml`'s jobs as one script. See common.sh for the
# environment. PARAMS: { mode: triage|study|audit|label|fake|diagnose, mission_id, task, report_url, scope, pr_number, fake_id, service, repair_id, agent, log }.
#   label    the impact label on a PR from .github/agents/risk-map.json (no AI, seconds); HQ sends it on
#            the repo's PR events once the repo's agents are off GitHub Actions
#   triage   the impact of a new HQ mission before it's built
#   study    a question asked in HQ: a written report and findings
#   audit    the weekly or monthly audit (`scope`): ideas to HQ's inbox; HQ's tick starts it on schedule
#   fake     a fake service for Scout's tests, drafted from how the code calls the real one (`service`,
#            with the owner's notes in `task`); goes to HQ's Fakes page as `fake_id`
#   diagnose why a run of the crew broke before it did its work (`agent`'s run, the end of its log in
#            `log`, what it was for in `task`): where the cause is and what to change, to HQ as
#            `repair_id`. Shep, HQ's mission manager, asks for it and sends the fix on from there
# (The daily "is main due for a regression run?" check lives in HQ itself for these repos: it reads HQ's
# own record of the last run, where the workflow read GitHub's run list.)
AGENT=radar
cd "$(dirname "$0")/../../.." && . .crew/scripts/run/common.sh

MODE=$(param mode); MODE="${MODE:-triage}"
case "$MODE" in label|triage|study|audit|fake|diagnose) ;; *) die "Unknown mode '$MODE'" ;; esac
mkdir -p radar-out
crew_render

if [ "$MODE" = label ]; then
  PR=$(param pr_number)
  [[ "$PR" =~ ^[0-9]+$ ]] || die "label needs pr_number"
  gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/files?per_page=100" --paginate --jq '.[].filename' > files.txt
  result=$(node .crew/scripts/agents/impact.mjs - < files.txt)
  tier=$(jq -r .tier <<<"$result")
  order="low normal high critical"
  rank() { local i=0 t; for t in $order; do [ "$t" = "$1" ] && echo $i; i=$((i+1)); done; }
  current=$(gh api "repos/$GITHUB_REPOSITORY/issues/$PR/labels" --jq '[.[].name | select(startswith("impact:"))][0] // "" | sub("impact:"; "")')
  # Radar only raises. Iris, who reads the code, sets the final tier and may lower it with a reason.
  if [ -n "$current" ] && [ "$(rank "$current")" -ge "$(rank "$tier")" ]; then say "Keeping impact:$current (computed $tier)"; exit 0; fi
  if dry_run; then say "DRY_RUN: would label #$PR impact:$tier"; exit 0; fi
  [ -n "$current" ] && gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$PR/labels/impact:$current" >/dev/null || true
  gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$PR/labels" -f "labels[]=impact:$tier" >/dev/null
  say "Labelled #$PR impact:$tier"; jq -r '.reasons[] | "  \(.tier): \(.rule) (\(.files | length) files)"' <<<"$result"
  exit 0
fi

MODEL=$(pick_model claude-sonnet-5-5)
RADAR_TASK=$(param task)
export RADAR_MODE="$MODE" RADAR_TASK

if [ "$MODE" = fake ]; then
  FAKE_ID=$(param fake_id)
  [ -n "$FAKE_ID" ] || die "fake needs fake_id"
  export RADAR_SERVICE="$(param service)"
  [ -n "$RADAR_SERVICE" ] || die "fake needs the service's name"
  # HQ shows the draft as running until it hears back, so a run that dies says so.
  FAKE_SENT=""
  fake_finish() {
    local code=$?
    if [ "$code" -ne 0 ] && [ -z "$FAKE_SENT" ] && ! dry_run; then node "$HQ_MJS" fake-fail "$FAKE_ID" "${FAIL_REASON:-The Radar run failed before it sent a draft. See $RUN_URL}" || true; fi
    (exit "$code"); finish
  }
  trap fake_finish EXIT
  PROMPT='Follow the brief in .crew/briefs/RADAR.md. RADAR_MODE: fake.
The service is in the environment variable RADAR_SERVICE; what the owner added, if anything, is in RADAR_TASK.'
  if dry_run; then
    jq -n --arg n "$(tr '[:upper:]' '[:lower:]' <<<"$RADAR_SERVICE" | tr -c 'a-z0-9\n' '-')" '{name:$n,routes:[]}' > radar-out/fake.json
  else
    run_claude fake "$PROMPT" "$MODEL" 120 Bash,Read,Glob,Grep,Write,WebFetch
  fi
  test -s radar-out/fake.json || { FAIL_REASON="Radar didn't write a definition (radar-out/fake.json). See $RUN_URL"; die "$FAIL_REASON"; }
  if ! node .crew/scripts/scout/fakes.mjs check radar-out/fake.json 2> radar-out/fake-problems.txt; then
    cat radar-out/fake-problems.txt
    FAIL_REASON="Radar's definition can't run: $(tr '\n' ' ' < radar-out/fake-problems.txt | head -c 300)"
    die "$FAIL_REASON"
  fi
  cat radar-out/fake-problems.txt
  if dry_run; then say "DRY_RUN: would send the $(jq -r .name radar-out/fake.json) fake"; exit 0; fi
  node "$HQ_MJS" fake-post "$FAKE_ID" radar-out/fake.json
  FAKE_SENT=1
  say "Done."
  exit 0
fi

if [ "$MODE" = diagnose ]; then
  REPAIR_ID=$(param repair_id)
  [ -n "$REPAIR_ID" ] || die "diagnose needs repair_id"
  export RADAR_FAILED_AGENT="$(param agent)"
  param log > radar-out/run.log
  [ -s radar-out/run.log ] || die "diagnose needs the failed run's log"
  # HQ waits on the diagnosis, so a run that dies says so.
  DIAGNOSIS_SENT=""
  diagnose_finish() {
    local code=$?
    if [ "$code" -ne 0 ] && [ -z "$DIAGNOSIS_SENT" ] && ! dry_run; then node "$HQ_MJS" diagnosis-fail "$REPAIR_ID" "${FAIL_REASON:-The Radar run failed before it sent a diagnosis. See $RUN_URL}" || true; fi
    (exit "$code"); finish
  }
  trap diagnose_finish EXIT
  PROMPT='Follow the brief in .crew/briefs/RADAR.md. RADAR_MODE: diagnose.
The end of the failed run is in radar-out/run.log. Whose run it was is in the environment variable RADAR_FAILED_AGENT; what it was for is in RADAR_TASK.'
  if dry_run; then
    jq -n '{where:"retry",cause:"DRY_RUN",evidence:[],fix:""}' > radar-out/diagnosis.json
  else
    run_claude diagnose "$PROMPT" "$MODEL" 80 Bash,Read,Glob,Grep,Write,WebFetch
  fi
  test -s radar-out/diagnosis.json || { FAIL_REASON="Radar didn't write a diagnosis (radar-out/diagnosis.json). See $RUN_URL"; die "$FAIL_REASON"; }
  jq -e '(.where | IN("repo","crew","hq","person","retry")) and (.cause | type == "string" and length > 0)' radar-out/diagnosis.json >/dev/null \
    || { FAIL_REASON="Radar's diagnosis names no cause, or a place other than repo, crew, hq, person or retry"; die "$FAIL_REASON"; }
  if dry_run; then say "DRY_RUN: would send the diagnosis ($(jq -r .where radar-out/diagnosis.json))"; exit 0; fi
  node "$HQ_MJS" diagnosis-post "$REPAIR_ID" radar-out/diagnosis.json
  DIAGNOSIS_SENT=1
  say "Done."
  exit 0
fi

if [ "$MODE" = triage ]; then
  [ -n "$MISSION_ID" ] || die "triage needs mission_id"
  PROMPT='Follow the brief in .crew/briefs/RADAR.md. RADAR_MODE: triage.
The task is in the environment variable RADAR_TASK.'
  if dry_run; then jq -n '{tier:"low",reasons:["dry run"]}' > radar-out/impact.json; else run_claude triage "$PROMPT" "$MODEL" 40 Bash,Read,Glob,Grep,Write; fi
  test -s radar-out/impact.json || die "Radar didn't write radar-out/impact.json"
  hq_report "$(jq -c '{agent:"radar",type:"impact",tier,reasons}' radar-out/impact.json)"
  say "Done."
  exit 0
fi

if [ "$MODE" = study ]; then
  [ -n "$MISSION_ID" ] || die "study needs mission_id"
  export RADAR_REPORT_URL="$(param report_url)"
  # Radar may run the repo's own checks (typecheck, lint, a script) when they answer the question.
  install_deps
  heartbeat_start "Reading the question and the code"
  PROMPT=$(printf 'Follow the brief in .crew/briefs/RADAR.md. RADAR_MODE: study.\nMISSION_ID: %s\nThe question is in the environment variable RADAR_TASK; a report to read first, when there is one, is linked in RADAR_REPORT_URL.\n' "$MISSION_ID")
  if dry_run; then printf '# Dry run\n\nNothing was studied.\n' > radar-out/report.md; echo '[]' > radar-out/findings.json; else run_claude study "$PROMPT" "$MODEL" 150 Bash,Read,Glob,Grep,Write,WebFetch; fi
  test -s radar-out/report.md || die "Radar didn't write radar-out/report.md"
  test -s radar-out/findings.json || echo '[]' > radar-out/findings.json
  jq -e 'type == "array"' radar-out/findings.json >/dev/null || die "radar-out/findings.json is not a list"
  if dry_run; then say "DRY_RUN: would upload the report and $(jq length radar-out/findings.json) findings"; exit 0; fi
  pathname=$(node "$HQ_MJS" upload "$MISSION_ID" radar-out/report.md)
  # The summary HQ shows on the mission: the first paragraph that isn't a heading.
  summary=$(awk 'BEGIN { RS=""; ORS="" } !/^#/ { print; exit }' radar-out/report.md | tr '\n' ' ' | head -c 600)
  jq -n --arg p "$pathname" --arg s "$summary" --slurpfile f radar-out/findings.json '{agent:"radar",type:"findings",pathname:$p,summary:$s,findings:$f[0]}' > radar-out/report.json
  say "Sending $(jq length radar-out/findings.json) findings"
  hq_report "$(cat radar-out/report.json)"
  say "Done."
  exit 0
fi

# ---- audit
SCOPE=$(param scope); SCOPE="${SCOPE:-weekly}"
case "$SCOPE" in weekly|monthly) ;; *) SCOPE=weekly ;; esac
export RADAR_SCOPE="$SCOPE"
install_deps
node .crew/scripts/agents/dep-facts.mjs > radar-out/facts.json
node "$HQ_MJS" ideas-known > radar-out/known.json
jq '{majors: (.majors | length), vulnerabilities: (.vulnerabilities | length)}' radar-out/facts.json
PROMPT="Follow the brief in .crew/briefs/RADAR.md. RADAR_MODE: audit. RADAR_SCOPE: $SCOPE."
if dry_run; then echo '[]' > radar-out/ideas.json; else run_claude audit "$PROMPT" "$MODEL" 150 Bash,Read,Glob,Grep,Write,WebFetch; fi
test -s radar-out/ideas.json || echo '[]' > radar-out/ideas.json
if dry_run; then say "DRY_RUN: would send $(jq length radar-out/ideas.json) ideas"; exit 0; fi
node "$HQ_MJS" ideas-post radar-out/ideas.json "$SCOPE"
say "Done."
