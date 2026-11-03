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
  local a=0 err out="/tmp/ghr.$$"
  while :; do
    err=$("$@" 2>&1 >"$out") && { cat "$out"; rm -f "$out"; return 0; }
    if printf '%s' "$err" | grep -qi 'secondary rate limit' && [ $a -lt 5 ]; then
      a=$((a+1)); echo "  (gh_retry backoff #$a, sleeping $((a*60))s)" >&2; sleep $((a*60)); continue
    fi
    printf '%s\n' "$err" >&2; rm -f "$out"; return 1
  done
}
