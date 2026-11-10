#!/bin/zsh
# Step 1: team-mention queue. Open PRs whose nodejs-github-bot "Review requested:"
# comment lists one of MY_TEAMS. Serial, spaced, and self-healing (safe against
# the secondary rate limit). Safe to background; progress goes to stderr.
#
# Output (stdout), one line per relevant PR, tab-separated:
#   <number>  <my teams still unchecked, comma-separated or ->  <my teams checked or ->
#
# Exits 1 (after printing what it has) if any search or comment fetch failed,
# so a partial queue never looks complete.
DIR="${0:A:h}"; source "$DIR/lib.sh"
failed=()

# 1. Candidates: PRs whose comments mention any tracked team.
candidates=()
for t in "${MY_TEAMS[@]}"; do
  echo "== search @nodejs/$t @ $(date +%H:%M:%S) ==" >&2
  if out=$(search_prs "in:comments \"@nodejs/$t\""); then
    candidates+=(${(f)out})
  else
    failed+=("search:$t")
  fi
  sleep 10   # search/* is the most secondary-limit-sensitive endpoint
done
candidates=(${(un)candidates})
echo "== ${#candidates} candidates; confirming bot review requests ==" >&2

# 2. Confirm: keep PRs where the bot's checkbox list includes one of MY_TEAMS.
for n in "${candidates[@]}"; do
  [[ "$n" == <-> ]] || continue
  if ! body=$(gh_retry gh api --paginate "repos/$REPO/issues/$n/comments" \
      --jq '.[] | select(.user.login=="nodejs-github-bot") | .body'); then
    failed+=("comments:$n"); continue
  fi
  todo=() checked=()
  for line in ${(f)body}; do
    if [[ "$line" =~ '^[[:space:]]*- \[( |x)\] @nodejs/([^[:space:]]+)' ]]; then
      team=$match[2]
      (( ${MY_TEAMS[(Ie)$team]} )) || continue
      if [[ "$match[1]" == " " ]]; then todo+=("$team"); else checked+=("$team"); fi
    fi
  done
  (( ${#todo} + ${#checked} )) || continue
  print -r -- "$n	${${(j:,:)${(@u)todo}}:--}	${${(j:,:)${(@u)checked}}:--}"
  sleep 1
done

if (( ${#failed} )); then
  echo "INCOMPLETE: failed calls: ${failed[*]}" >&2
  exit 1
fi
