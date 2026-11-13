#!/bin/zsh
# Shared config + helpers for nodejs-contribute scripts. Source this.
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

# Where ncu-ci (from @node-core/utils) runs from: "path" if it's on PATH,
# "fnm" if it's installed under fnm's default Node, or nothing. Agent shells
# often don't load fnm's shell hook, so a global install under fnm's default
# Node isn't on their PATH.
ncu_ci_source() {
  if command -v ncu-ci >/dev/null 2>&1; then
    echo path
  elif command -v fnm >/dev/null 2>&1 &&
       fnm exec --using=default -- sh -c 'command -v ncu-ci' >/dev/null 2>&1; then
    echo fnm
  fi
}

NCU_INSTALL_HELP='Install @node-core/utils (nodejs-contribute skill, One-time setup):
  fnm exec --using=default -- npm install --global @node-core/utils
or, without fnm: npm install --global @node-core/utils
ncu then needs ~/.ncurc with your GitHub username and a token. The user sets
those: ncu-config set username <login>, then ncu-config set token <token>.'

# Run ncu-ci, or fail with install steps (exit 127) when it can't be found.
# Usage: ncu_ci pr <job>
ncu_ci() {
  case "$(ncu_ci_source)" in
    path) ncu-ci "$@" ;;
    fnm) fnm exec --using=default -- ncu-ci "$@" ;;
    *) printf 'ncu-ci not found.\n%s\n' "$NCU_INSTALL_HELP" >&2; return 127 ;;
  esac
}
