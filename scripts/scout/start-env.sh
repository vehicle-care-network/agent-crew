#!/usr/bin/env bash
# Boots a repo's app the way Scout tests it: the checked-out code under `next dev`, wired to Firebase
# emulators on a demo-* project, with the repo's base seed loaded. Nothing it starts can reach staging or
# production: demo-* projects exist only inside the emulator, the apps use the emulator whenever the
# emulator hosts are set, and no third-party keys are provided, so those integrations fail closed.
#
# Repo settings come from .github/agents/crew.json, key "scout":
#   port        the port the app must run on (some apps hard-code their own origin)
#   readyPath   a path that answers once `next dev` is up (e.g. "/login" or "/")
#   warm        paths to request once so their first compile doesn't eat a test's timeout
#   env         extra env vars the app needs, dummy values only
#   firebaseRules  true when the repo has firestore.rules the emulator should load
#   blockHosts  hostnames to blackhole on CI (endpoints that need no key must still be unreachable)
# The repo provides scripts/scout/seed.mjs (base seed) and scripts/scout/fixtures.mjs (guarded helpers).
#
# Usage: .crew/scripts/scout/start-env.sh      (from the repo root)
# Locally, pick free ports so Scout runs beside your own dev emulators:
#   SCOUT_APP_PORT=3100 SCOUT_FS_PORT=18080 SCOUT_AUTH_PORT=19099 .crew/scripts/scout/start-env.sh
# Stop everything with .crew/scripts/scout/stop-env.sh.
set -euo pipefail

OUT="${SCOUT_OUT:-scout-out}"
PROJECT="${SCOUT_PROJECT:-demo-scout}"
cfg() { node -e 'const c=require(process.cwd()+"/.github/agents/crew.json").scout||{};const v=c[process.argv[1]];process.stdout.write(v==null?"":Array.isArray(v)?v.join(" "):typeof v==="object"?Object.entries(v).map(([k,x])=>k+"="+x).join("\n"):String(v))' "$1"; }
APP_PORT="${SCOUT_APP_PORT:-$(cfg port)}"
FS_PORT="${SCOUT_FS_PORT:-8080}"
AUTH_PORT="${SCOUT_AUTH_PORT:-9099}"
READY_PATH="$(cfg readyPath)"
mkdir -p "$OUT"

if [ -f .env.local ] && ! grep -q '^# scout-env' .env.local; then
  echo "[ScoutEnv] .env.local already exists and was not written by Scout; refusing to overwrite it." >&2
  exit 1
fi

{
  cat <<EOF
# scout-env: written by the crew's start-env.sh. Dummy values only; points everything at emulators.
NEXT_PUBLIC_FIREBASE_API_KEY=scout-dummy-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${PROJECT}.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=${PROJECT}
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=${PROJECT}.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=000000000000
NEXT_PUBLIC_FIREBASE_APP_ID=1:000000000000:web:scout
FIRESTORE_EMULATOR_HOST=localhost:${FS_PORT}
FIREBASE_AUTH_EMULATOR_HOST=localhost:${AUTH_PORT}
NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=localhost:${FS_PORT}
NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=localhost:${AUTH_PORT}
NEXT_TELEMETRY_DISABLED=1
EOF
  # The repo's own variables; APP_PORT is substituted so origins follow the chosen port.
  cfg env | sed "s/\${APP_PORT}/${APP_PORT}/g"
} > .env.local

if [ "$(cfg firebaseRules)" = true ]; then
  # Gitignored, but the emulator needs it to start. The emulator does not enforce indexes.
  [ -f firestore.indexes.json ] || echo '{ "indexes": [], "fieldOverrides": [] }' > firestore.indexes.json
  firestore='"firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" },'
else
  firestore=''
fi
# Scout's own emulator config, so the repo's firebase.json (if any) and its ports are left alone.
cat > firebase.scout.json <<EOF
{
  ${firestore}
  "emulators": {
    "singleProjectMode": true,
    "ui": { "enabled": false },
    "firestore": { "port": ${FS_PORT} },
    "auth": { "port": ${AUTH_PORT} }
  }
}
EOF

wait_for() { # url, label, log, seconds
  for _ in $(seq 1 "$4"); do
    if curl -s -o /dev/null "$1"; then echo "[ScoutEnv] $2 is up"; return 0; fi
    sleep 1
  done
  echo "[ScoutEnv] $2 did not come up in $4s. Last lines of $3:" >&2
  tail -40 "$3" >&2
  exit 1
}

hosts="$(cfg blockHosts)"
if [ -n "${CI:-}" ] && [ -n "$hosts" ]; then
  # The block is runner-wide (/etc/hosts), so it would also cut off Scout's own reporting: the evidence
  # manifest is how HQ learns the verdict, and a blocked HQ leaves the mission "Scout is testing" forever.
  # Never block HQ's host, whatever crew.json says.
  hq_host="$(node -e 'process.stdout.write(new URL(process.env.AGENT_HQ_URL || "https://agent-hq-cyan.vercel.app").hostname)')"
  keep=""
  for h in $hosts; do
    case "$h" in
      "$hq_host"|agent-hq-cyan.vercel.app|vcntools.ai|www.vcntools.ai)
        echo "::warning::[ScoutEnv] Not blocking $h: it is Agent HQ, and Scout reports there. Remove it from scout.blockHosts in crew.json." ;;
      *) keep="$keep $h" ;;
    esac
  done
  if [ -n "${keep# }" ]; then
    echo "[ScoutEnv] Blocking on this runner:${keep}"
    for h in $keep; do echo "0.0.0.0 $h"; done | sudo tee -a /etc/hosts >/dev/null
  fi
fi

# firebase-tools 15 needs Java 21+. With an older JDK locally, override: SCOUT_FIREBASE="npx --yes firebase-tools@13.35.1"
FIREBASE="${SCOUT_FIREBASE:-npx --yes firebase-tools@15}"
# Job control gives each background server its own process group, so stop-env.sh can stop the whole tree.
set -m
$FIREBASE emulators:start --only firestore,auth --project "$PROJECT" --config firebase.scout.json \
  > "$OUT/emulators.log" 2>&1 &
echo $! > "$OUT/emulators.pid"
wait_for "http://localhost:${FS_PORT}" "Firestore emulator" "$OUT/emulators.log" 120
wait_for "http://localhost:${AUTH_PORT}" "Auth emulator" "$OUT/emulators.log" 60

set -a; . ./.env.local; set +a
node scripts/scout/seed.mjs

npx next dev -p "$APP_PORT" > "$OUT/next-dev.log" 2>&1 &
echo $! > "$OUT/next-dev.pid"
wait_for "http://localhost:${APP_PORT}${READY_PATH}" "Next dev server" "$OUT/next-dev.log" 240
# The first request to a route compiles it; warm the pages most flows start from so tests don't time out on that.
for p in $(cfg warm); do curl -s -o /dev/null "http://localhost:${APP_PORT}${p}" || true; done
echo "[ScoutEnv] Ready at http://localhost:${APP_PORT} (project $PROJECT)"
