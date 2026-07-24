#!/bin/zsh
# Step 1 — team-mention queue. Open PRs whose bot review-request mentions one
# of the user's teams. Serial + spaced + self-healing (secondary-rate-limit safe).
# Prints sorted unique PR numbers to stdout. Safe to background.
set -e
DIR="${0:A:h}"; source "$DIR/lib.sh"
for t in "${MY_TEAMS[@]}"; do
  echo "== @nodejs/$t @ $(date +%H:%M:%S) ==" >&2
  gh_retry gh api -X GET search/issues \
    -f q="repo:$REPO is:pr is:open draft:false -author:$ME in:comments \"@nodejs/$t\"" \
    --jq '.items[].number'
  sleep 10   # search/* is the most secondary-limit-sensitive endpoint
done | grep -E '^[0-9]+$' | sort -un
