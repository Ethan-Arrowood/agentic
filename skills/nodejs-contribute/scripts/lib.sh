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
# "shared" if it's in the shared npm prefix (~/.npm-global, see
# rules/lang/node.md) but that isn't on PATH, "fnm" if it's installed under
# fnm's default Node, or nothing. The fallbacks cover shells that don't load
# the shell setup (fnm's hook and the shared prefix's PATH entry). Without a
# shared prefix, npm installs globals per Node version, so ncu-ci can also go
# missing after a Node upgrade.
NCU_SHARED_BIN="$HOME/.npm-global/bin/ncu-ci"
ncu_ci_source() {
  if command -v ncu-ci >/dev/null 2>&1; then
    echo path
  elif [ -x "$NCU_SHARED_BIN" ]; then
    echo shared
  elif command -v fnm >/dev/null 2>&1 &&
       fnm exec --using=default -- sh -c 'command -v ncu-ci' >/dev/null 2>&1; then
    echo fnm
  fi
}

# Where ncu reads its global config: $XDG_CONFIG_HOME/ncurc when that variable
# is set, otherwise ~/.ncurc (lib/config.js in @node-core/utils). An
# encrypted ncurc.gpg beside it also counts.
ncurc_path() {
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then echo "$XDG_CONFIG_HOME/ncurc"; else echo "$HOME/.ncurc"; fi
}
ncurc_exists() { local f; f=$(ncurc_path); [ -e "$f" ] || [ -e "$f.gpg" ]; }

# Setup steps, preferring my dotfiles' commands when they're installed:
# `dotfiles install` installs @node-core/utils from the mac-langs Npmfile, and
# `dotfiles ncu` sets up the config and its tokens.
if command -v dotfiles >/dev/null 2>&1; then
  NCU_INSTALL_HELP='Install @node-core/utils with `dotfiles install` (the mac-langs Npmfile lists it).
Then the user runs `dotfiles ncu` to set up the config and its tokens.'
else
  NCU_INSTALL_HELP='Install @node-core/utils (nodejs-contribute skill, One-time setup):
  fnm exec --using=default -- npm install --global @node-core/utils
or, without fnm: npm install --global @node-core/utils
ncu then needs a config with your GitHub username and token. The user sets
those: ncu-config set username <login>, then ncu-config set token <token>.'
fi

# Run ncu-ci, or fail with install steps (exit 127) when it can't be found.
# Usage: ncu_ci pr <job>
ncu_ci() {
  case "$(ncu_ci_source)" in
    path) ncu-ci "$@" ;;
    shared)
      if command -v node >/dev/null 2>&1; then "$NCU_SHARED_BIN" "$@"
      else fnm exec --using=default -- "$NCU_SHARED_BIN" "$@"; fi ;;
    fnm) fnm exec --using=default -- ncu-ci "$@" ;;
    *) printf 'ncu-ci not found.\n%s\n' "$NCU_INSTALL_HELP" >&2; return 127 ;;
  esac
}
