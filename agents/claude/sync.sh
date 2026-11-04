#!/usr/bin/env bash
# Claude Code SessionStart hook: fast-forward this repo, link rules and skills
# into ~/.claude, and create missing ~/dev/<org>/CLAUDE.md imports for org rules.
# See agents/claude/README.md.

source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

pull_repo || finish claude

# Rules: global files and the lang directory, only where ~/.claude/rules exists.
if [ -d "$claude_dir/rules" ]; then
  prune_broken "$claude_dir/rules"
  for f in "$repo"/rules/*.md; do
    [ -e "$f" ] && link_missing "$f" "$claude_dir/rules"
  done
  [ -d "$repo/rules/lang" ] && link_missing "$repo/rules/lang" "$claude_dir/rules"
fi

link_skills "$claude_dir/skills"

# Org rules load through ~/dev/<org>/CLAUDE.md, which Claude Code reads for any
# session under that directory. Create it only where the org directory exists
# and has no CLAUDE.md yet. Never overwrite.
for f in "$repo"/rules/orgs/*.md; do
  [ -e "$f" ] || continue
  org="$(basename "$f" .md)"
  [ -d "$dev_dir/$org" ] || continue
  dest="$dev_dir/$org/CLAUDE.md"
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "@$f" > "$dest" &&
      note "Created $dest importing $f. To keep repos' own AGENTS.md loading under it, set Project instructions to claude-md-and-agents-md."
  fi
done

finish claude
