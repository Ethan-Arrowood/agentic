#!/usr/bin/env bash
# SessionStart hook: fast-forward this repo and link any new rules or skills.
#
# Register in ~/.claude/settings.json (see README "Hooks"). Stdout is added to
# the session's context, so it stays silent unless something changed or failed.
# Never exits non-zero: a sync problem must not block a session.

set -u

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export GIT_TERMINAL_PROMPT=0

msg=()
note() { msg+=("$1"); }

finish() {
  if [ "${#msg[@]}" -gt 0 ]; then
    echo "[agent-config sync: $repo]"
    printf -- '- %s\n' "${msg[@]}"
  fi
  exit 0
}

git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || finish

branch="$(git -C "$repo" symbolic-ref --quiet --short HEAD)" || {
  note "Skipped pull: detached HEAD."
  finish
}

if ! git -C "$repo" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  note "Skipped pull: branch '$branch' has no upstream."
else
  before="$(git -C "$repo" rev-parse HEAD)"
  if ! out="$(git -C "$repo" pull --ff-only --quiet 2>&1)"; then
    note "Pull failed on '$branch' (local commits or conflicting uncommitted changes?): ${out//$'\n'/ }"
  else
    after="$(git -C "$repo" rev-parse HEAD)"
    if [ "$before" != "$after" ]; then
      changed="$(git -C "$repo" diff --name-only "$before" "$after" -- rules hooks '*/SKILL.md' | paste -sd ' ' -)"
      note "Pulled $(git -C "$repo" rev-list --count "$before..$after") commit(s). Changed: ${changed:-none in rules/skills/hooks}. Rule changes take effect next session."
    fi
  fi
fi

if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]; then
  note "Uncommitted changes in $repo; commit and push them to sync other machines."
fi

# Remove broken symlinks that point into this repo (deleted or renamed items).
# Links to anything else are left alone.
prune_broken() { # $1 = install dir
  local l target
  for l in "$1"/* "$1"/.[!.]*; do
    [ -L "$l" ] && [ ! -e "$l" ] || continue
    target="$(readlink "$l")"
    case "$target" in
      "$repo"/*) rm "$l" && note "Removed broken link $l" ;;
    esac
  done
}

[ -d "$claude_dir/rules" ] && prune_broken "$claude_dir/rules"
[ -d "$claude_dir/skills" ] && prune_broken "$claude_dir/skills"

# Link new items only where an install already exists. Never overwrite.
link_missing() { # $1 = source, $2 = destination dir
  local dest
  dest="$2/$(basename "$1")"
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    ln -s "$1" "$dest" && note "Linked $dest"
  fi
}

if [ -d "$claude_dir/rules" ]; then
  for f in "$repo"/rules/*.md; do
    [ -e "$f" ] && link_missing "$f" "$claude_dir/rules"
  done
  [ -d "$repo/rules/lang" ] && link_missing "$repo/rules/lang" "$claude_dir/rules"
fi

if [ -d "$claude_dir/skills" ]; then
  for d in "$repo"/*/; do
    d="${d%/}"
    [ -f "$d/SKILL.md" ] && link_missing "$d" "$claude_dir/skills"
  done
fi

finish
