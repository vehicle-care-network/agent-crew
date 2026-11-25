#!/usr/bin/env bash
# Scout in a sandbox: `.github/workflows/scout-qa.yml` as one script. See common.sh for the environment.
# PARAMS: { mode: pr|regression|smoke|coverage, pr_number, focus, plan, mission_id, scenario_id, sha,
# only, adjust }, as the workflow's `params`. HQ cloned the default branch: the repo's Scout pieces are
# taken from it (as the workflow takes them from the commit the run started on), then the commit under
# test is checked out and they are laid over it. The sandbox has Java, Playwright's Chromium and the
# Firebase emulators when HQ built its image; else they are installed here (about a minute and a half).
#
# Two things the workflow did that this doesn't: keep artifacts on GitHub (the evidence goes to HQ, and the
# specs Scout wrote on a PR or for a saved smoke test come back from HQ for the next run, `hq.mjs
# specs-pull`) and cache node_modules.
AGENT=scout
cd "$(dirname "$0")/../../.." && . .crew/scripts/run/common.sh
# Scout's own word to HQ is the evidence manifest (and `qa running|error`), never a `failed` report.
REPORTED=1

# ---- Read the request
SCOUT_MODE=$(param mode); SCOUT_MODE="${SCOUT_MODE:-pr}"
case "$SCOUT_MODE" in regression|smoke|coverage) ;; *) SCOUT_MODE=pr ;; esac
SCENARIO_ID=$(param scenario_id | tr -cd 'A-Za-z0-9_-')
FOCUS=$(param focus)
SCOUT_ONLY=$(param only | head -10)
SCOUT_ADJUST=$(param adjust | head -c 2000)
SCOUT_PLAN=$(param plan | head -c 2000)
# A check (step 1 of a new test in HQ): a smoke run whose point is Scout's read of how the app works today,
# written to scout-out/check.json beside the flows' pass/fail (PROMPT.md, "A check").
SCOUT_CHECK=$(param check); case "$SCOUT_CHECK" in 1|true|yes) SCOUT_CHECK=1 ;; *) SCOUT_CHECK="" ;; esac
[ "$SCOUT_MODE" = smoke ] || SCOUT_CHECK=""
SCOUT_OUT=scout-out
export SCOUT_MODE SCENARIO_ID SCOUT_ONLY SCOUT_ADJUST SCOUT_PLAN SCOUT_CHECK SCOUT_OUT
mkdir -p "$SCOUT_OUT"
default_head() { local b; b=$(gh api "repos/$GITHUB_REPOSITORY" --jq .default_branch); gh api "repos/$GITHUB_REPOSITORY/commits/$b" --jq .sha; }
if [ "$SCOUT_MODE" = smoke ] || [ "$SCOUT_MODE" = regression ] || [ "$SCOUT_MODE" = coverage ]; then
  # The commit HQ names (a production deploy's, a release branch's head), else the default branch's head.
  NUMBER=0; SHA=$(param sha | tr -cd 'a-f0-9'); [ -n "$SHA" ] || SHA=$(default_head)
  [ "$SCOUT_MODE" = smoke ] && [ -z "$FOCUS" ] && die "A smoke test needs the scenario in focus"
else
  NUMBER=$(param pr_number)
  [ -n "$NUMBER" ] || die "No PR number in the request"
  load_pr "$NUMBER"
  SHA=$(jq -r .head.sha pr.json)
fi
export PR_NUMBER="$NUMBER" HEAD_SHA="$SHA"
# Reports to HQ: a PR, a smoke test, or a release's regression run (a mission); main's health otherwise.
REPORTS_TO_HQ=false
if [ "$SCOUT_MODE" = pr ] || [ "$SCOUT_MODE" = smoke ] || { [ "$SCOUT_MODE" = regression ] && [ -n "$MISSION_ID" ]; }; then REPORTS_TO_HQ=true; fi
say "Mode $SCOUT_MODE${SCOUT_CHECK:+ (a check)}, PR #$NUMBER at ${SHA:0:7}, focus: ${FOCUS:-(none)}${SCOUT_ONLY:+, only: $(tr '\n' ';' <<<"$SCOUT_ONLY")}"

# Whatever stops this run before its evidence is sent, HQ hears that Scout broke, and the app is stopped.
EVIDENCE_SENT=""
scout_finish() {
  local code=$?
  if [ "$code" -ne 0 ] && [ -z "$EVIDENCE_SENT" ] && [ "$REPORTS_TO_HQ" = true ]; then node "$HQ_MJS" qa error || true; fi
  bash .crew/scripts/scout/stop-env.sh >/dev/null 2>&1 || true
  exit "$code"
}
trap scout_finish EXIT
# A full set of remote refs: the commit under test may sit on another branch than the one HQ cloned.
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'

# ---- The repo's Scout pieces, from the clone's head (the default branch), then the commit under test.
# Branches opened before Scout's data existed don't contain it, so main's crew.json, risk map, core flows,
# seed and core specs are laid over the PR's code. The harness is the exception: it must match the UI under
# test, so the PR's copy wins when it has one.
TOOLING=$(mktemp -d)
for p in .github/agents .github/scout scripts/scout e2e/scout/_support e2e/scout/core e2e/scout/features; do
  [ -e "$p" ] || continue
  mkdir -p "$TOOLING/$(dirname "$p")" && cp -R "$p" "$TOOLING/$p"
done
git fetch -q origin "$SHA" || git fetch -q origin
git checkout -q "$SHA"
mkdir -p .github/agents .github/scout scripts/scout e2e/scout
[ -d "$TOOLING/.github/agents" ] && cp -R "$TOOLING/.github/agents/." .github/agents/
[ -d "$TOOLING/.github/scout" ] && cp -R "$TOOLING/.github/scout/." .github/scout/
[ -d "$TOOLING/scripts/scout" ] && cp -R "$TOOLING/scripts/scout/." scripts/scout/
[ -d "$TOOLING/e2e/scout/core" ] && cp -R "$TOOLING/e2e/scout/core" e2e/scout/
# Kept feature flows: main's fill in what the PR doesn't have; the PR's own copies win.
if [ -d "$TOOLING/e2e/scout/features" ]; then mkdir -p e2e/scout/features; cp -Rn "$TOOLING/e2e/scout/features/." e2e/scout/features/; fi
if [ -f e2e/scout/_support/scout.ts ]; then say "Using this PR's harness (e2e/scout/_support)"; elif [ -d "$TOOLING/e2e/scout/_support" ]; then cp -R "$TOOLING/e2e/scout/_support" e2e/scout/; fi
rm -rf "$TOOLING"
# What the PR itself changes among those pieces is the PR's to say. A mission that corrects a core spec (the
# UI it drives moved), the seed, or the crew's config has to be tested with its correction: with main's
# copy laid over it, the flows it fixed failed run after run and nothing Patch pushed could change that.
# Only files the PR changes come back; every other core spec is still main's. A core spec a PR edits is
# not taken on trust: HQ flags each existing test the crew changed and holds the PR until a person looks.
# The list is read once, into a file, and only GitHub's status lines are kept: a failed or garbled lookup
# says so loudly instead of passing as "this PR changes nothing". It is applied again just before the
# recorded run, since Scout's agent has a shell and can leave one of these files as main's copy.
PR_SCOUT_FILES=""
use_pr_scout_files() {  # $1: "first" (say which copy each file is) or "again" (only say what had to be put back)
  local status f old
  [ -n "$PR_SCOUT_FILES" ] || return 0
  while IFS=$'\t' read -r status f old; do
    if [ "$status" = removed ]; then
      if [ -e "$f" ]; then rm -rf "$f"; [ "$1" = first ] && say "This PR removes $f: left out" || say "Put back this PR's removal of $f (it was there again)"; fi
      continue
    fi
    # A renamed file's old name is main's copy: it would run beside the PR's.
    if [ "$status" = renamed ] && [ -n "$old" ] && [ -e "$old" ] && ! git cat-file -e "$SHA:$old" 2>/dev/null; then rm -rf "$old"; say "This PR renames $old to $f: the old name left out"; fi
    if [ "$1" = first ]; then
      if git checkout -q "$SHA" -- "$f"; then say "Using this PR's $f"; else warn "Couldn't take this PR's $f; main's copy is used"; fi
    elif ! git diff --quiet "$SHA" -- "$f" 2>/dev/null || [ ! -e "$f" ]; then
      if git checkout -q "$SHA" -- "$f"; then say "Put back this PR's $f (it had changed during the run)"; else warn "Couldn't put back this PR's $f"; fi
    fi
  done < "$PR_SCOUT_FILES"
}
if [ "$SCOUT_MODE" = pr ]; then
  PR_SCOUT_FILES=$(mktemp)
  if gh api "repos/$GITHUB_REPOSITORY/pulls/$NUMBER/files?per_page=100" --paginate --jq '.[] | "\(.status)\t\(.filename)\t\(.previous_filename // "")"' > "$PR_SCOUT_FILES.all"; then
    grep -E $'^(added|modified|removed|renamed|copied|changed)\t(\.github/agents/crew\.json|\.github/scout/|scripts/scout/|e2e/scout/core/)' "$PR_SCOUT_FILES.all" > "$PR_SCOUT_FILES" || true
    if [ -s "$PR_SCOUT_FILES" ]; then use_pr_scout_files first; else say "This PR changes no Scout files: main's copies are used"; fi
  else
    warn "Couldn't read which Scout files this PR changes (gh api pulls/$NUMBER/files failed): main's copies of the core specs, seed and crew config are used, so a flow this PR corrects will fail as before"
    : > "$PR_SCOUT_FILES"
  fi
  rm -f "$PR_SCOUT_FILES.all"
fi

# ---- A repo with no app (`scout.app: false` in crew.json: a library, scripts, this crew itself). There is
# nothing to open in a browser, so Scout's verdict is the repo's own tests: one flow, passed or failed,
# with the first failing line. No agent, no emulators, no browser.
if [ "$(jq -r 'if .scout.app == false then "no" else "yes" end' .github/agents/crew.json 2>/dev/null)" = no ]; then
  if [ "$REPORTS_TO_HQ" != true ]; then say "This repo has no app for Scout to open (scout.app is false in crew.json). Nothing to run."; REPORTED=1; exit 0; fi
  [ "$SCOUT_MODE" = smoke ] && die "This repo has no app for Scout to open (scout.app is false in crew.json), so a smoke test has nothing to do."
  node "$HQ_MJS" qa running || warn "Couldn't tell HQ the run started"
  TEST_CMD=$(crew_cmd test)
  say "No app to open: running the repo's tests ($TEST_CMD)"
  started=$(date +%s)
  if (install_deps && bash -c "$TEST_CMD") > "$SCOUT_OUT/tests.log" 2>&1; then verdict=passed; else verdict=failed; fi
  cat "$SCOUT_OUT/tests.log"
  why=""
  if [ "$verdict" = failed ]; then why=$(grep -m1 -iE '^not ok|✖|\bFAIL|\bError\b|syntax error' "$SCOUT_OUT/tests.log" || tail -n 1 "$SCOUT_OUT/tests.log"); fi
  # The shape Playwright's JSON reporter writes, which is what the evidence step reads.
  jq -n --arg status "$verdict" --arg title "The repo's own tests pass ($TEST_CMD)" --arg why "${why:0:400}" --argjson ms "$(( ($(date +%s) - started) * 1000 ))" \
    '{suites: [{title: "", specs: [{file: "repo-tests", title: $title, tests: [{projectName: "tests", results: [{status: $status, duration: $ms, attachments: []} + (if $why == "" then {} else {error: {message: $why}} end)]}]}]}]}' > "$SCOUT_OUT/results.json"
  if dry_run; then say "DRY_RUN: not sending the result ($verdict)"; exit 0; fi
  if node .crew/scripts/scout/upload-evidence.mjs > "$SCOUT_OUT/evidence.txt" 2>&1; then EVIDENCE_SENT=1; cat "$SCOUT_OUT/evidence.txt"; else cat "$SCOUT_OUT/evidence.txt"; die "Scout's result never reached Agent HQ (the evidence step failed); send Scout again from the mission."; fi
  say "Done: the repo's tests $verdict."
  exit 0
fi

crew_render
SCOUT_BASE_URL="http://localhost:$(scout_port)"
export SCOUT_BASE_URL

# ---- Size the run: how much testing this change deserves, and which areas it touches.
if [ "$SCOUT_MODE" = pr ]; then
  gh api "repos/$GITHUB_REPOSITORY/pulls/$NUMBER/files?per_page=100" --paginate --jq '.[].filename' > changed-files.txt
  # Kept with the run's output: the report counts a committed spec this PR changes as a test of the PR.
  cp changed-files.txt "$SCOUT_OUT/changed-files.txt"
  node .crew/scripts/scout/areas.mjs < changed-files.txt > "$SCOUT_OUT/areas.json"
else
  : > changed-files.txt
  node .crew/scripts/scout/areas.mjs --all > "$SCOUT_OUT/areas.json"
fi
SCOUT_AREAS=$(jq -r '[.areas[].slug] | join(",")' "$SCOUT_OUT/areas.json")
SCOUT_IGNORE=$(jq -r '.ignore | join(",")' "$SCOUT_OUT/areas.json")
export SCOUT_AREAS SCOUT_IGNORE
jq -r '.areas[] | "## \(.title) (\(.file))\n\n\(.guidance)\n"' "$SCOUT_OUT/areas.json" > "$SCOUT_OUT/guidance.md"
[ -s "$SCOUT_OUT/guidance.md" ] || rm -f "$SCOUT_OUT/guidance.md"
say "Areas: ${SCOUT_AREAS:-(none matched)}${SCOUT_PLAN:+; the mission has a test plan}"
impact_tier() { node .crew/scripts/agents/impact.mjs - < changed-files.txt | jq -r .tier; }
SCOUT_ONLY_GREP=""
if [ -n "$SCOUT_ONLY" ]; then
  case "$SCOUT_MODE" in regression|coverage) TIER=regression ;; smoke) TIER=smoke ;; *) TIER=$(impact_tier) ;; esac
  AGENT_RUNS=true; TURNS=40; BUDGET="only the flows named under FLOWS TO RE-RUN"
  [ -z "$SCOUT_ADJUST" ] || { TURNS=60; BUDGET="only the flows named under FLOWS TO RE-RUN, changed as ADJUSTMENTS asks"; }
  SCOUT_ONLY_GREP=$(node -e 'import("./.crew/scripts/scout/steps.mjs").then(m=>process.stdout.write(m.onlyGrep(m.parseOnly(process.env.SCOUT_ONLY))))')
elif [ "$SCOUT_MODE" = regression ] && [ -n "$MISSION_ID" ]; then
  # A release branch: the committed core and kept flows, run as they are. No agent.
  TIER=regression; AGENT_RUNS=false; TURNS=0; BUDGET="none: the committed flows only"
elif [ "$SCOUT_MODE" = regression ]; then
  TIER=regression; AGENT_RUNS=true; TURNS=150; BUDGET="every flow in .github/scout/core-flows.md"
elif [ "$SCOUT_MODE" = coverage ]; then
  TIER=regression; AGENT_RUNS=true; TURNS=150; BUDGET="a committed spec for every core flow that has none, written under e2e/scout/core/"
elif [ "$SCOUT_MODE" = smoke ]; then
  TIER=smoke; AGENT_RUNS=true; TURNS=60; BUDGET="the smoke-test scenario in SCOUT_FOCUS, and nothing else"
  [ -z "$SCOUT_CHECK" ] || BUDGET="the scenario in SCOUT_FOCUS, walked once as a check of how it works today, and nothing else"
else
  TIER=$(impact_tier); AGENT_RUNS=true
  case "$TIER" in
    low)      TURNS=30; BUDGET="none: smoke flows only"; [ -z "$FOCUS" ] && [ -z "$SCOUT_PLAN" ] && AGENT_RUNS=false ;;
    normal)   TURNS=45; BUDGET="1 to 2 flows" ;;
    high)     TURNS=70; BUDGET="2 to 3 flows" ;;
    critical) TURNS=100; BUDGET="up to 5 flows, including edge cases" ;;
  esac
fi
rm -f changed-files.txt
export SCOUT_TIER="$TIER" SCOUT_ONLY_GREP
say "Impact $TIER: agent=$AGENT_RUNS, budget $BUDGET, max $TURNS turns"

# ---- Say it started: the PR comment, and HQ (which learns the result from the evidence, not the comment)
if [ "$SCOUT_MODE" = pr ] && ! dry_run; then node .crew/scripts/scout/report.mjs --status running || warn "Couldn't post the 'testing' comment"; fi
if [ "$REPORTS_TO_HQ" = true ]; then node "$HQ_MJS" qa running || warn "Couldn't tell HQ the run started"; fi

# ---- The toolchain: dependencies, Java for the emulators, Playwright's Chromium (all cached in HQ's image)
install_deps
# A branch from before the repo had @playwright/test (or a repo without it) still gets Scout's runner.
if [ ! -d node_modules/@playwright/test ]; then
  say "Adding @playwright/test (this branch's package.json has none)"
  npm i --no-save --no-audit --no-fund @playwright/test@latest >/dev/null
fi
if ! command -v java >/dev/null 2>&1; then
  say "Installing Java for the Firebase emulators"
  sudo apt-get update -qq >/dev/null 2>&1 || true
  sudo apt-get install -y -qq openjdk-21-jre-headless >/dev/null 2>&1 || die "Couldn't install Java (the emulators need it)"
fi

# Vercel won't deploy a PR that doesn't type-check, so there's nothing worth testing in a browser yet.
BUILD_OK=true
if [ "$SCOUT_MODE" = pr ]; then
  gh pr diff "$NUMBER" -R "$GITHUB_REPOSITORY" --name-only | grep -E '\.tsx?$' > changed.txt || true
  bash -c "$(crew_cmd typecheck)" > tsc.txt 2>&1 || true
  grep -F -f changed.txt tsc.txt | grep -E '^[^ ].*\([0-9]+,[0-9]+\): error TS' > build-errors.txt || true
  if [ -s build-errors.txt ]; then
    say "$(wc -l < build-errors.txt) type errors in files this PR changed"
    cp build-errors.txt "$SCOUT_OUT/build-errors.txt"
    BUILD_OK=false
  fi
  rm -f changed.txt tsc.txt build-errors.txt
fi

say "Installing Playwright's Chromium"
chromium_install() { npx playwright install --with-deps chromium >"$SCOUT_OUT/playwright-install.log" 2>&1; }
if ! chromium_install; then
  # A Playwright release only has browsers for the systems that existed when it came out, so the repo's
  # pinned one can be older than this runner's OS ("Playwright does not support chromium on ..."). The
  # current release is tried in its place, for this run only: the repo's package.json is not touched.
  tail -5 "$SCOUT_OUT/playwright-install.log"
  warn "Playwright $(npx playwright --version 2>/dev/null | tr -cd '0-9.') (this repo's) couldn't install Chromium on this runner; trying the current Playwright for this run"
  npm i --no-save --no-audit --no-fund @playwright/test@latest >/dev/null || die "Couldn't install Chromium, nor a newer Playwright to try"
  chromium_install || { tail -20 "$SCOUT_OUT/playwright-install.log"; die "Couldn't install Chromium, with this repo's Playwright or with $(npx playwright --version 2>/dev/null)"; }
  say "Using $(npx playwright --version) for this run"
fi

# ---- Re-runs start from the specs Scout already wrote (kept by HQ), instead of from scratch: a PR's from
# its previous run, a saved smoke test's from the run that last passed. Without them a smoke test is written
# again from its steps on every run, and two runs of the same commit can disagree.
REUSED=false
if { [ "$SCOUT_MODE" = pr ] || { [ "$SCOUT_MODE" = smoke ] && [ -n "$SCENARIO_ID" ]; }; } && ! dry_run; then
  if node "$HQ_MJS" specs-pull > "$SCOUT_OUT/specs-pull.txt" 2>&1 && [ "$(cat "$SCOUT_OUT/specs-pull.txt" | tail -1)" != "0" ]; then REUSED=true; fi
  say "Specs from the previous run: $(tail -1 "$SCOUT_OUT/specs-pull.txt") ($( [ "$REUSED" = true ] && echo reused || echo none))"
fi

# Another PR's flows that were committed with it (pr-<n>-* specs, helpers and seeds, Scout's scratch names)
# run on no PR but their own: their seed never runs here, and one spec that can't load ends the whole
# Playwright run with no results. Outside a PR (NUMBER is 0) none of them run.
for f in e2e/scout/pr-* e2e/scout/_seed/pr-*; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in "pr-$NUMBER-"*) ;; *) say "Leaving out $f (another PR's flow)"; rm -rf "$f" ;; esac
done

# The repo's fake services from HQ, while the run still has its credentials; start-env.sh runs them.
dry_run || node "$HQ_MJS" fakes-pull "$SCOUT_OUT/fakes/hq" >/dev/null

# ---- Start the app on emulators. The app under test never sees the run's credentials.
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL \
  bash .crew/scripts/scout/start-env.sh
# The committed flows' own data, and the data the reused specs' seed scripts create.
# Every seed runs even if one fails, and the function returns non-zero if any did: a caller with `||` sees
# the failure (set -e is off inside it there), and the first load below still ends the run on it.
load_seeds() (
  set -a; . ./.env.local; set +a
  rc=0
  for f in e2e/scout/core/_seed/*.mjs e2e/scout/features/_seed/*.mjs; do [ -f "$f" ] || continue; say "Seeding $f"; node "$f" || rc=1; done
  # This PR's own seeds run whether its specs came back from HQ or were committed on its branch.
  for f in e2e/scout/_seed/*.mjs; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in "pr-$NUMBER-"*) node "$f" || rc=1 ;; *) [ "$REUSED" != true ] || node "$f" || rc=1 ;; esac
  done
  exit "$rc"
)
load_seeds

# Puts the emulators back to the seeded state: Auth and Firestore emptied, then the base seed and the seeds
# above. Scout's agent runs its flows against these emulators, so a flow that creates something (an Auth
# account, say) would otherwise meet it already there in the recorded run, and fail there only.
reseed() {
  (
    set -a; . ./.env.local; set +a
    project="$NEXT_PUBLIC_FIREBASE_PROJECT_ID"
    curl -fsS -o /dev/null -X DELETE "http://$FIREBASE_AUTH_EMULATOR_HOST/emulator/v1/projects/$project/accounts" &&
      curl -fsS -o /dev/null -X DELETE "http://$FIRESTORE_EMULATOR_HOST/emulator/v1/projects/$project/databases/(default)/documents" &&
      node scripts/scout/seed.mjs
  ) || { warn "Couldn't put the emulators back to the seeded state; the recorded run starts from what the agent left"; return 0; }
  load_seeds || warn "A seed failed while putting the emulators back; the recorded run goes on with what loaded"
}

# ---- Scout explores, seeds and writes specs
SCOUT_AGENT_OUTCOME=skipped
if [ "$AGENT_RUNS" = true ] && [ "$BUILD_OK" = true ]; then
  MODEL=$(pick_model claude-sonnet-5-5)
  PROMPT=$(cat <<EOF
Follow the brief in .crew/scout/PROMPT.md.
SCOUT_MODE: $SCOUT_MODE
PR_NUMBER: $NUMBER
SCOUT_BASE_URL: $SCOUT_BASE_URL
SCOUT_FOCUS: ${FOCUS:-(none)}
CHECK: $( [ -n "$SCOUT_CHECK" ] && echo 'yes: write your read of how it works today to scout-out/check.json' || echo no)
TEST PLAN: ${SCOUT_PLAN:-(none)}
AREAS: ${SCOUT_AREAS:-(none matched)}
GUIDANCE FILE: $( [ -n "$SCOUT_AREAS" ] && echo scout-out/guidance.md || echo '(none)')
IMPACT: $TIER
FLOW BUDGET: $BUDGET
SPECS FROM THE PREVIOUS RUN: $( [ "$REUSED" = true ] && echo 'yes, under e2e/scout' || echo none)
FLOWS TO RE-RUN: ${SCOUT_ONLY:-(none: a full run)}
PLAYWRIGHT GREP FOR THEM: ${SCOUT_ONLY_GREP:-(none)}
ADJUSTMENTS: ${SCOUT_ADJUST:-(none)}
EOF
)
  if dry_run; then
    say "DRY_RUN: skipping Scout's agent"
  else
    export SCOUT_FOCUS="$FOCUS" SCOUT_BUDGET="$BUDGET" SCOUT_REUSED="$REUSED"
    case "$SCOUT_MODE" in regression) TASK=regression ;; coverage) TASK=coverage ;; smoke) TASK=smoke ;; *) TASK=qa ;; esac
    run_claude "$TASK" "$PROMPT" "$MODEL" "$TURNS" "Bash,Read,Write,Edit,Glob,Grep,mcp__playwright" --mcp-config .crew/scout/mcp.json
    SCOUT_AGENT_OUTCOME=$( [ "$CLAUDE_EXIT" -eq 0 ] && echo success || echo failure)
  fi
fi
export SCOUT_AGENT_OUTCOME

# ---- Run every Scout spec for the record: the verdict comes from this run, not the agent's own runs.
# record.sh keeps the app up for it: a flow that failed only because the app wasn't answering is run again,
# and a run where it kept going down is a broken run (HQ hears `qa error`), never a list of failed flows.
use_pr_scout_files again
# Every spec starts from what its seed describes, not from what the agent's own runs left behind.
if [ "$SCOUT_AGENT_OUTCOME" != skipped ]; then say "Putting the emulators back to the seeded state for the recorded run"; reseed; fi
if ! bash .crew/scripts/scout/record.sh; then
  if [ "$SCOUT_MODE" = pr ] && ! dry_run; then node .crew/scripts/scout/report.mjs || warn "Couldn't post the report on the PR"; fi
  die "$(cat "$SCOUT_OUT/broke.txt" 2>/dev/null || echo "Scout's recorded run broke before it had results")"
fi

# ---- Evidence to HQ (screenshots, videos, the specs), then the PR comment
HQ_OK=true
if dry_run; then
  say "DRY_RUN: not sending evidence; results in $SCOUT_OUT"
else
  if node .crew/scripts/scout/upload-evidence.mjs > "$SCOUT_OUT/evidence.txt" 2>&1; then EVIDENCE_SENT=1; else HQ_OK=false; fi
  cat "$SCOUT_OUT/evidence.txt"
  HQ_EVIDENCE_URL=$(grep -oE 'https?://[^ ]+#(evidence=[^ ]+|health)' "$SCOUT_OUT/evidence.txt" | tail -1 || true)
  export HQ_EVIDENCE_URL
  if { [ "$SCOUT_MODE" = regression ] || [ "$SCOUT_MODE" = coverage ]; } && [ -z "$MISSION_ID" ]; then
    node .crew/scripts/scout/regression-ideas.mjs > "$SCOUT_OUT/regression-ideas.json" && node "$HQ_MJS" ideas-post "$SCOUT_OUT/regression-ideas.json" regression || warn "Couldn't send the regression failures to Ideas"
  fi
  if [ "$SCOUT_MODE" = pr ]; then node .crew/scripts/scout/report.mjs || warn "Couldn't post the report on the PR"; fi
fi

# What the app asked of each fake service, in the log: a fake that is up but was never called is the usual
# reason a flow that needs one fails.
SCOUT_OUT="$SCOUT_OUT" node .crew/scripts/scout/fakes.mjs summary || true
bash .crew/scripts/scout/stop-env.sh

# The agent step never stops the report; fail the run afterwards so a broken agent shows as a failure.
if [ "$SCOUT_AGENT_OUTCOME" = failure ]; then die "Scout's agent failed, so this was only smoke-tested. Check the Claude credential and the sandbox log."; fi
# HQ learns the verdict from the evidence manifest. If that didn't get through, say so instead of a clean exit.
if [ "$HQ_OK" = false ] && [ "$REPORTS_TO_HQ" = true ]; then die "Scout's result never reached Agent HQ (the evidence step failed); send Scout again from the mission."; fi
say "Done."
