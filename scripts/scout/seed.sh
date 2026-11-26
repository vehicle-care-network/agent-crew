#!/usr/bin/env bash
# The data Scout's flows were written against: the kept flows' seeds (core and features), this PR's own
# (`pr-<n>-*`), and, when the specs came back from the previous run, the seeds that came with them.
# Seeds are idempotent: each puts its documents back as the spec expects them, so running them again undoes
# what a flow saved. scout.sh runs this once the emulators are up; record.sh runs it again just before the
# recorded run, so that run starts from this data and not from what Scout's agent left behind (a flow
# that saves changes the document the read-only flows then open).
#
# Within each folder, seeds run in order of their name without `.mjs`, so `pr-1-a.mjs` runs before
# `pr-1-a-move.mjs` (plain file-name order puts `-` before `.`, and the move seed would then fail on an
# empty emulator, or, over data already there, succeed and have its change overwritten by `pr-1-a.mjs`).
# Every seed runs even if one fails; the ones that failed run once more after all the others (a seed may
# need one in another folder), and the script exits 1, naming them, only if one fails again.
#
# Env: PR_NUMBER (0 or unset outside a PR), SCOUT_REUSED (true when the specs came from the previous run).
# Usage: .crew/scripts/scout/seed.sh      (from the repo root, after start-env.sh)
set -euo pipefail

PR="${PR_NUMBER:-0}"
set -a; . ./.env.local; set +a
# The .mjs files in folder $1, sorted by name without `.mjs`.
in_order() {
  local f
  for f in "$1"/*.mjs; do [ -f "$f" ] || continue; printf '%s\n' "${f%.mjs}"; done | LC_ALL=C sort | sed 's/$/.mjs/'
}
seeds=()
for dir in e2e/scout/core/_seed e2e/scout/features/_seed; do
  while IFS= read -r f; do seeds+=("$f"); done < <(in_order "$dir")
done
# This PR's own seeds run whether its specs came back from HQ or were committed on its branch.
while IFS= read -r f; do
  case "$(basename "$f")" in
    "pr-$PR-"*) seeds+=("$f") ;;
    *) [ "${SCOUT_REUSED:-}" != true ] || seeds+=("$f") ;;
  esac
done < <(in_order e2e/scout/_seed)

failed=()
for f in ${seeds[@]+"${seeds[@]}"}; do
  echo "[Scout] Seeding $f"; node "$f" || failed+=("$f")
done
[ ${#failed[@]} -gt 0 ] || exit 0
echo "[Scout] ${#failed[@]} seed(s) failed; running them again after the others"
still=()
for f in "${failed[@]}"; do
  echo "[Scout] Seeding $f (again)"; node "$f" || still+=("$f")
done
[ ${#still[@]} -gt 0 ] || exit 0
echo "[Scout] These seeds failed twice: ${still[*]}"
exit 1
