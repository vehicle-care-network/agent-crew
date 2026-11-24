#!/usr/bin/env bash
# Starts the app under test (`next dev` on the port crew.json names), waits until it answers and warms the
# pages most flows start from. start-env.sh runs it once the emulators are up and seeded; record.sh runs it
# again when the app has stopped answering mid-run (the dev server died, or was stopped), and Scout's agent
# may too. An app this script started earlier is stopped first, so the port is free.
#
# Needs the .env.local start-env.sh wrote. The app never sees the run's credentials, whoever calls this.
#
# Usage: .crew/scripts/scout/start-app.sh      (from the repo root, after start-env.sh)
set -euo pipefail

OUT="${SCOUT_OUT:-scout-out}"
cfg() { node -e 'const c=require(process.cwd()+"/.github/agents/crew.json").scout||{};const v=c[process.argv[1]];process.stdout.write(v==null?"":Array.isArray(v)?v.join(" "):typeof v==="object"?Object.entries(v).map(([k,x])=>k+"="+x).join("\n"):String(v))' "$1"; }
APP_PORT="${SCOUT_APP_PORT:-$(cfg port)}"
READY_PATH="$(cfg readyPath)"
mkdir -p "$OUT"

if ! grep -q '^# scout-env' .env.local 2>/dev/null; then
  echo "[ScoutEnv] No .env.local written by Scout here; run start-env.sh first." >&2
  exit 1
fi

if [ -f "$OUT/next-dev.pid" ]; then
  old=$(cat "$OUT/next-dev.pid")
  if kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null; then
    echo "[ScoutEnv] Stopped the app that was running (pid $old)"
    for _ in $(seq 1 10); do kill -0 "$old" 2>/dev/null || break; sleep 1; done
  fi
  rm -f "$OUT/next-dev.pid"
  # The log of the run that ended is kept: it says why the app stopped answering.
  [ -f "$OUT/next-dev.log" ] && mv "$OUT/next-dev.log" "$OUT/next-dev.$(date +%s).log"
fi

set -a; . ./.env.local; set +a
# Job control gives the server its own process group, so stop-env.sh can stop the whole tree.
set -m
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL \
  npx next dev -p "$APP_PORT" > "$OUT/next-dev.log" 2>&1 &
echo $! > "$OUT/next-dev.pid"

for _ in $(seq 1 240); do
  if curl -s -o /dev/null "http://localhost:${APP_PORT}${READY_PATH}"; then
    echo "[ScoutEnv] Next dev server is up"
    # The first request to a route compiles it; warm the pages most flows start from so tests don't time out on that.
    for p in $(cfg warm); do curl -s -o /dev/null "http://localhost:${APP_PORT}${p}" || true; done
    exit 0
  fi
  sleep 1
done
echo "[ScoutEnv] Next dev server did not come up in 240s. Last lines of $OUT/next-dev.log:" >&2
tail -40 "$OUT/next-dev.log" >&2
exit 1
