#!/usr/bin/env bash
# The repo's Scout pieces as the run laid them out, kept from Scout's agent. The agent has the Edit tool and
# works in the same tree the recorded run uses, so an edit it makes to a core spec, the seed or the crew's
# config would otherwise decide the verdict (a PR whose committed spec was right failed, and Patch found
# nothing to fix). `snapshot` copies them before the agent starts; `restore` puts them back after it, and
# prints each file it put back or took out, one per line.
#
#   bash .crew/scripts/scout/pieces.sh snapshot <dir>
#   bash .crew/scripts/scout/pieces.sh restore <dir>     # env SCOUT_MODE, SCOUT_ADJUST
#
# A coverage run's job is to add core specs (and their seeds) and fill in `.github/scout/core-flows.md`:
# those stay. A run a person sent with ADJUSTMENTS is asked to rewrite the named flow's spec and seed, which
# may be a core one: its changes under e2e/scout/core/ stay too, or the adjustment would never reach the
# verdict. What the agent writes anywhere else under e2e/scout/ (its own flows, kept flows) is untouched;
# the harness (e2e/scout/_support) is laid out on purpose like the rest and goes back.
set -euo pipefail
PIECES=(e2e/scout/core e2e/scout/_support .github/scout scripts/scout .github/agents/crew.json)
cmd="${1:-}"; dir="${2:-}"
[ -n "$dir" ] || { echo "usage: pieces.sh snapshot|restore <dir>" >&2; exit 2; }

agent_may_keep() {
  if [ -n "${SCOUT_ADJUST:-}" ]; then case "$1" in e2e/scout/core/*) return 0 ;; esac; fi
  [ "${SCOUT_MODE:-}" = coverage ] || return 1
  case "$1" in
    .github/scout/core-flows.md) return 0 ;;
    e2e/scout/core/*) [ ! -e "$dir/$1" ] ;;
    *) return 1 ;;
  esac
}

case "$cmd" in
  snapshot)
    mkdir -p "$dir"
    for p in "${PIECES[@]}"; do
      [ -e "$p" ] || continue
      mkdir -p "$dir/$(dirname "$p")" && cp -R "$p" "$dir/$p"
    done
    ;;
  restore)
    [ -d "$dir" ] || { echo "No snapshot at $dir" >&2; exit 1; }
    for p in "${PIECES[@]}"; do
      # What was there: what the agent changed or removed goes back.
      if [ -e "$dir/$p" ]; then
        while IFS= read -r f; do
          if cmp -s "$dir/$f" "$f" || agent_may_keep "$f"; then continue; fi
          mkdir -p "$(dirname "$f")" && cp "$dir/$f" "$f" && echo "$f"
        done < <(cd "$dir" && find "$p" -type f)
      fi
      # What the agent added: taken out.
      if [ -e "$p" ]; then
        while IFS= read -r f; do
          if [ -e "$dir/$f" ] || agent_may_keep "$f"; then continue; fi
          rm -f "$f" && echo "$f (added)"
        done < <(find "$p" -type f)
      fi
    done
    ;;
  *) echo "usage: pieces.sh snapshot|restore <dir>" >&2; exit 2 ;;
esac
