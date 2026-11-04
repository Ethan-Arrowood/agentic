#!/usr/bin/env bash
# Claude Code SessionStart hook: fast-forward this repo, link rules and skills
# into ~/.claude, and link org rules as ~/dev/<org>/AGENTS.md.
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

# Org rules: ~/dev/<org>/AGENTS.md symlinks, which Claude Code reads for any
# session under that directory. Migrate the CLAUDE.md imports older versions of
# this hook wrote, then link.
for f in "$repo"/rules/orgs/*.md; do
  [ -e "$f" ] || continue
  old="$dev_dir/$(basename "$f" .md)/CLAUDE.md"
  if [ -f "$old" ] && [ ! -L "$old" ] && [ "$(cat "$old")" = "@$f" ]; then
    rm "$old" && note "Removed $old (replaced by AGENTS.md)."
  fi
done
link_org_agents_md

# Without claude-md-and-agents-md, any CLAUDE.md in or above a repo makes
# Claude Code skip every AGENTS.md, including the org rules.
settings="$claude_dir/settings.json"
if command -v jq >/dev/null 2>&1 && [ -f "$settings" ]; then
  mode="$(jq -r '.pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles // empty' "$settings" 2>/dev/null)"
  [ "$mode" = "claude-md-and-agents-md" ] ||
    note "Project instructions isn't claude-md-and-agents-md in $settings, so repos with a CLAUDE.md skip AGENTS.md files, including org rules. See agents/claude/README.md."
fi

finish claude
