#!/usr/bin/env bash
# The recorded run: every Scout spec, once, against the app as it stands. The verdict HQ and the PR comment
# show comes from this run, so it must be about the app's code and never about whether the app was up.
#
# `next dev` can stop answering in the middle of a run (it restarts itself when memory runs short, and
# Scout's agent has a shell). A flow that then fails with "connection refused" on its first page says
# nothing about the code, and reported as a failed flow it sends someone to fix a bug that isn't there.
# So the app is checked before the run, and started again when it is down. Flows that still failed only
# because the app wasn't answering are run once more on an app that is. If it happens twice, the run is
# reported as broken (not as failed flows): the reason goes to $SCOUT_OUT/broke.txt, the results are set
# aside as results.unreachable.json, and this exits 1.
#
# Before the flows, the seeds run again (seed.sh), so the run starts from the data the specs were written
# against and not from what Scout's agent left behind.
#
# Env: SCOUT_OUT, SCOUT_BASE_URL, SCOUT_ONLY_GREP (only the flows HQ asked to re-run), CREW_DIR,
# PR_NUMBER and SCOUT_REUSED (for seed.sh).
# Usage: .crew/scripts/scout/record.sh      (from the repo root, after start-env.sh)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${SCOUT_OUT:-scout-out}"
cfg() { node -e 'const c=require(process.cwd()+"/.github/agents/crew.json").scout||{};const v=c[process.argv[1]];process.stdout.write(v==null?"":String(v))' "$1"; }
BASE="${SCOUT_BASE_URL:-http://localhost:${SCOUT_APP_PORT:-$(cfg port)}}"
READY="${BASE}$(cfg readyPath)"
CONFIG="${CREW_DIR:-.crew}/playwright.scout.config.ts"
export SCOUT_BASE_URL="$BASE"
rm -f "$OUT/broke.txt" "$OUT/results.unreachable.json"

answers() { curl -s -o /dev/null --max-time 10 "$READY"; }

# Leaves the app answering, or returns 1. $1 says when it was found down, for the log.
ensure_app() {
  answers && return 0
  echo "[Scout] The app isn't answering at $BASE ($1). Last lines of $OUT/next-dev.log:"
  tail -30 "$OUT/next-dev.log" 2>/dev/null || true
  # A dev server restarting itself is back within seconds; starting a second one beside it would take its port.
  for _ in $(seq 1 20); do
    sleep 3
    if answers; then echo "[Scout] The app is answering again on its own"; return 0; fi
  done
  echo "[Scout] Starting the app again"
  bash "$HERE/start-app.sh"
}

broke() {
  echo "$1" > "$OUT/broke.txt"
  [ -f "$OUT/results.json" ] && mv "$OUT/results.json" "$OUT/results.unreachable.json"
  echo "::error::[Scout] $1"
  exit 1
}

run_flows() {
  rm -f "$OUT/results.json"
  if [ -n "${SCOUT_ONLY_GREP:-}" ]; then
    echo "Re-running only: $SCOUT_ONLY_GREP"
    npx playwright test -c "$CONFIG" --grep "$SCOUT_ONLY_GREP" || true
  else
    npx playwright test -c "$CONFIG" || true
  fi
}

# The titles of the flows that failed only because the app wasn't answering, one per line.
unreachable() { SCOUT_OUT="$OUT" node "$HERE/unreachable.mjs"; }

ensure_app "before the recorded run" || broke "The app under test wasn't answering at $BASE before the flows ran, and couldn't be started again. Nothing was tested; see next-dev.log in the run's log."
# Scout's agent has run the specs, and a flow that saves has changed the data the others read: the recorded
# run starts from the seeded data again. Once: the re-run below is of flows that never reached their page.
echo "[Scout] Seeding again for the recorded run"
bash "$HERE/seed.sh" || echo "::warning::[Scout] A seed failed before the recorded run; flows that read its data may fail for that"
run_flows
down=$(unreachable)
if [ -n "$down" ]; then
  echo "[Scout] $(wc -l <<<"$down" | tr -d ' ') flow(s) failed only because the app wasn't answering; running the flows again:"
  sed 's/^/  - /' <<<"$down"
  ensure_app "during the recorded run" || broke "The app under test stopped answering at $BASE during the flows, and couldn't be started again. Nothing was tested; see next-dev.log in the run's log."
  run_flows
  down=$(unreachable)
  if [ -n "$down" ]; then
    ensure_app "during the second recorded run" || true
    broke "The app under test stopped answering at $BASE during the flows, twice (\"$(head -1 <<<"$down")\" couldn't open its first page). That is Scout's environment going down, not a failed flow; see next-dev.log in the run's log."
  fi
fi
exit 0
