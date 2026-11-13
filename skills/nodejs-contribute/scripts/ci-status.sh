#!/bin/zsh
# CI status for a PR via ncu-ci (the authoritative Jenkins gate), verified
# against the CURRENT head. Never trusts `gh pr checks` alone.
# Usage: ci-status.sh <pr-number>
#        ci-status.sh --check    verify ncu-ci and ~/.ncurc are set up
DIR="${0:A:h}"; source "$DIR/lib.sh"
n="$1"; [ -z "$n" ] && { echo "usage: ci-status.sh <pr> | --check" >&2; exit 2; }

if [ "$n" = "--check" ]; then
  src=$(ncu_ci_source)
  case "$src" in
    path) echo "ncu-ci: $(command -v ncu-ci) ($(ncu-ci --version 2>/dev/null))" ;;
    fnm) echo "ncu-ci: under fnm's default Node, $(fnm exec --using=default -- node --version) ($(fnm exec --using=default -- ncu-ci --version 2>/dev/null))" ;;
    *) printf 'ncu-ci: not found\n%s\n' "$NCU_INSTALL_HELP" >&2 ;;
  esac
  # Only check that the config exists. It holds a token, so don't print it.
  if [ -f "$HOME/.ncurc" ]; then echo "~/.ncurc: present"; else echo "~/.ncurc: missing (ncu-config set username/token)" >&2; fi
  [ -n "$src" ] && [ -f "$HOME/.ncurc" ]
  exit $?
fi

head=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq '.headRefOid')
prjob=$(gh pr checks "$n" --repo "$REPO" 2>/dev/null \
        | grep -Eo 'node-test-pull-request/[0-9]+' | grep -Eo '[0-9]+' | head -1)

if [ -z "$prjob" ]; then
  echo "#$n: NO-RUN — no node-test-pull-request job. RECOMMEND: add \`request-ci\`  [head ${head:0:12}]"
  exit 0
fi

out=$(ncu_ci pr "$prjob" 2>&1); rc=$?
out=$(print -r -- "$out" | grep -vE 'npm warn|deprecated')
result=$(print -r -- "$out" | awk '/^Result/{print $2; exit}')
# A missing ncu-ci or a failed lookup used to print an empty result that read
# as "STALE". Report it as an error instead.
if [ $rc -ne 0 ] || [ -z "$result" ]; then
  echo "#$n: CI=UNKNOWN  job=$prjob  (ncu-ci failed, exit $rc)" >&2
  print -r -- "$out" | tail -6 | sed 's/^/    /' >&2
  exit 1
fi
cicommit=$(print -r -- "$out" | grep -oE '\[[0-9a-f]{12}' | head -1 | tr -d '[')
if [ "${head:0:12}" = "$cicommit" ]; then match="HEAD-MATCH"; else match="STALE (ran $cicommit != head ${head:0:12})"; fi
echo "#$n: CI=$result  job=$prjob  $match"
if [ "$result" = "FAILURE" ]; then
  echo "  failure detail (classify: is it the PR's subsystem, or unrelated flake/rebase?):"
  print -r -- "$out" | grep -iE '^Type|^Reason|not ok [0-9]|CRASHED' | grep -ivE 'querying|download' | sed 's/^/    /' | head -14
fi
