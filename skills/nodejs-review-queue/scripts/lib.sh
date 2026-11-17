#!/bin/zsh
# Shared config + helpers for nodejs-review-queue scripts. Source this.
#   REPO / ME can be overridden via env; MY_TEAMS is the tracked set.
REPO="${REPO:-nodejs/node}"
ME="${ME:-$(gh api user --jq .login)}"
MY_TEAMS=(net http quic dgram fs streams undici web-server-frameworks web-standards wintercg)

# Serial + self-healing wrapper for any gh call that can trip GitHub's
# secondary rate limit. Backs off 1..5 min and retries the SAME call.
# Usage: gh_retry gh api ...
gh_retry() {
  local a=0 err out
  out=$(mktemp "${TMPDIR:-/tmp}/ghr.XXXXXX") || return 1
  while :; do
    err=$("$@" 2>&1 >"$out") && { cat "$out"; rm -f "$out"; return 0; }
    if printf '%s' "$err" | grep -qi 'secondary rate limit' && [ $a -lt 5 ]; then
      a=$((a+1)); echo "  (gh_retry backoff #$a, sleeping $((a*60))s)" >&2; sleep $((a*60)); continue
    fi
    printf '%s\n' "$err" >&2; rm -f "$out"; return 1
  done
}

# All open, non-draft PR numbers (not authored by $ME) matching a search
# qualifier string. Fetches one page of 100 at a time with a pause between
# pages. `gh api --paginate` fetches pages back to back, so a large result set
# (`@nodejs/http` has 400+) trips the secondary rate limit, and gh_retry then
# restarts the whole search. The search API returns at most 10 pages.
# Usage: search_prs 'in:comments "@nodejs/net"'
search_prs() {
  local page=1 out
  while :; do
    out=$(gh_retry gh api -X GET search/issues \
      -f q="repo:$REPO is:pr is:open draft:false -author:$ME $1" \
      -f per_page=100 -f page=$page --jq '.items[].number') || return 1
    [ -n "$out" ] && print -r -- "$out"
    (( ${#${(f)out}} < 100 || page >= 10 )) && return 0
    page=$((page+1)); sleep "${SEARCH_SLEEP:-30}"
  done
}
