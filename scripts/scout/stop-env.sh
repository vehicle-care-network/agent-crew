#!/usr/bin/env bash
# Stops what .crew/scripts/scout/start-env.sh started and removes the files it wrote.
OUT="${SCOUT_OUT:-scout-out}"
for name in next-dev emulators; do
  if [ -f "$OUT/$name.pid" ]; then
    pid=$(cat "$OUT/$name.pid")
    # start-env.sh runs each server in its own process group (set -m), so this stops npx, node and java together.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    rm -f "$OUT/$name.pid"
  fi
done
grep -q '^# scout-env' .env.local 2>/dev/null && rm -f .env.local
rm -f firebase.scout.json
echo "[ScoutEnv] Stopped"
