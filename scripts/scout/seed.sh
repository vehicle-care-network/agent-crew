#!/usr/bin/env bash
# The data Scout's flows were written against: the kept flows' seeds (core and features), this PR's own
# (`pr-<n>-*`), and, when the specs came back from the previous run, the seeds that came with them.
# Seeds are idempotent: each puts its documents back as the spec expects them, so running them again undoes
# what a flow saved. scout.sh runs this once the emulators are up; record.sh runs it again just before the
# recorded run, so that run starts from this data and not from what Scout's agent left behind (a flow
# that saves changes the document the read-only flows then open).
#
# Env: PR_NUMBER (0 or unset outside a PR), SCOUT_REUSED (true when the specs came from the previous run).
# Usage: .crew/scripts/scout/seed.sh      (from the repo root, after start-env.sh)
set -euo pipefail

PR="${PR_NUMBER:-0}"
set -a; . ./.env.local; set +a
for f in e2e/scout/core/_seed/*.mjs e2e/scout/features/_seed/*.mjs; do
  [ -f "$f" ] || continue
  echo "[Scout] Seeding $f"; node "$f"
done
# This PR's own seeds run whether its specs came back from HQ or were committed on its branch.
for f in e2e/scout/_seed/*.mjs; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in
    "pr-$PR-"*) echo "[Scout] Seeding $f"; node "$f" ;;
    *) [ "${SCOUT_REUSED:-}" != true ] || { echo "[Scout] Seeding $f"; node "$f"; } ;;
  esac
done
