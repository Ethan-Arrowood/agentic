#!/usr/bin/env bash
# Shared helpers for the per-agent sync hooks in agents/<agent>/sync.sh. Source it.
#
# Hooks print to stdout, which the agent adds to the session's context, so they
# stay silent unless something changed or failed. Never exit non-zero: a sync
# problem must not block a session.

set -u

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
dev_dir="${AGENTIC_DEV_DIR:-$HOME/dev}"
export GIT_TERMINAL_PROMPT=0

msg=()
note() { msg+=("$1"); }

finish() { # $1 = agent name
  if [ "${#msg[@]}" -gt 0 ]; then
    echo "[agentic sync ($1): $repo]"
    printf -- '- %s\n' "${msg[@]}"
  fi
  exit 0
}

# Fast-forward the clone and note what changed. Returns 1 if this isn't a git
# checkout, so the caller can finish early.
pull_repo() {
  local branch before after out changed
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 1

  if ! branch="$(git -C "$repo" symbolic-ref --quiet --short HEAD)"; then
    note "Skipped pull: detached HEAD."
  elif ! git -C "$repo" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    note "Skipped pull: branch '$branch' has no upstream."
  else
    before="$(git -C "$repo" rev-parse HEAD)"
    if ! out="$(git -C "$repo" pull --ff-only --quiet 2>&1)"; then
      note "Pull failed on '$branch' (local commits or conflicting uncommitted changes?): ${out//$'\n'/ }"
    else
      after="$(git -C "$repo" rev-parse HEAD)"
      if [ "$before" != "$after" ]; then
        changed="$(git -C "$repo" diff --name-only "$before" "$after" -- rules skills agents | paste -sd ' ' -)"
        note "Pulled $(git -C "$repo" rev-list --count "$before..$after") commit(s). Changed: ${changed:-none in rules/skills/agents}. Rule changes take effect next session."
      fi
    fi
  fi

  if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]; then
    note "Uncommitted changes in $repo; commit and push them to sync other machines."
  fi
}

# Remove broken symlinks in $1 that point into this repo (deleted or renamed
# items). Links to anything else are left alone.
prune_broken() {
  local l target
  [ -d "$1" ] || return 0
  for l in "$1"/* "$1"/.[!.]*; do
    [ -L "$l" ] && [ ! -e "$l" ] || continue
    target="$(readlink "$l")"
    case "$target" in
      "$repo"/*) rm "$l" && note "Removed broken link $l" ;;
    esac
  done
}

# Symlink $1 into directory $2 unless the name is taken. Never overwrite.
link_missing() {
  local dest
  dest="$2/$(basename "$1")"
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    ln -s "$1" "$dest" && note "Linked $dest"
  fi
}

# Link every skill directory (one with a SKILL.md) into $1, if $1 exists.
link_skills() {
  local d
  [ -d "$1" ] || return 0
  prune_broken "$1"
  for d in "$repo"/skills/*/; do
    d="${d%/}"
    [ -f "$d/SKILL.md" ] && link_missing "$d" "$1"
  done
}

# Symlink each rules/orgs/<org>.md as ~/dev/<org>/AGENTS.md, where the org
# directory exists and the name is free. Never overwrite.
link_org_agents_md() {
  local f dir dest
  for f in "$repo"/rules/orgs/*.md; do
    [ -e "$f" ] || continue
    dir="$dev_dir/$(basename "$f" .md)"
    [ -d "$dir" ] || continue
    dest="$dir/AGENTS.md"
    if [ -L "$dest" ] && [ ! -e "$dest" ]; then
      case "$(readlink "$dest")" in "$repo"/*) rm "$dest" ;; esac
    fi
    if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
      ln -s "$f" "$dest" && note "Linked $dest"
    fi
  done
}

# Print a rule file without its YAML frontmatter.
strip_frontmatter() {
  awk 'NR == 1 && $0 == "---" { fm = 1; next } fm && $0 == "---" { fm = 0; next } !fm' "$1"
}
