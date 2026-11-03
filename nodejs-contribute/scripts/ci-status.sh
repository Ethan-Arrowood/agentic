#!/bin/zsh
# CI status for a PR via ncu-ci (the authoritative Jenkins gate), verified
# against the CURRENT head. Never trusts `gh pr checks` alone.
# Usage: ci-status.sh <pr-number>
DIR="${0:A:h}"; source "$DIR/lib.sh"
n="$1"; [ -z "$n" ] && { echo "usage: ci-status.sh <pr>" >&2; exit 2; }

head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq '.headRefOid')
prjob=$(gh pr checks "$n" --repo "$REPO" 2>/dev/null \
        | grep -Eo 'node-test-pull-request/[0-9]+' | grep -Eo '[0-9]+' | head -1)

if [ -z "$prjob" ]; then
  echo "#$n: NO-RUN — no node-test-pull-request job. RECOMMEND: add \`request-ci\`  [head ${head:0:12}]"
  exit 0
fi

out=$(ncu-ci pr "$prjob" 2>&1 | grep -vE 'npm warn|deprecated')
result=$(echo "$out" | awk '/^Result/{print $2; exit}')
cicommit=$(echo "$out" | grep -oE '\[[0-9a-f]{12}' | head -1 | tr -d '[')
if [ "${head:0:12}" = "$cicommit" ]; then match="HEAD-MATCH"; else match="STALE (ran $cicommit != head ${head:0:12})"; fi
echo "#$n: CI=$result  job=$prjob  $match"
if [ "$result" = "FAILURE" ]; then
  echo "  failure detail (classify: is it the PR's subsystem, or unrelated flake/rebase?):"
  echo "$out" | grep -iE '^Type|^Reason|not ok [0-9]|CRASHED' | grep -ivE 'querying|download' | sed 's/^/    /' | head -14
fi
