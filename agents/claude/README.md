# Claude Code

How this repo installs into [Claude Code](https://code.claude.com/docs/en/memory).

## How each kind loads

- **`rules/*.md`:** symlinked into `~/.claude/rules/`. Loaded in every session, like a global `~/.claude/CLAUDE.md`.
- **`rules/lang/`:** the directory is symlinked into `~/.claude/rules/lang`. Each file's `paths:` frontmatter makes it load only once Claude reads or edits a matching file. For user-level rules the patterns match against the session's working directory.
- **`rules/orgs/<org>.md`:** not linked into `~/.claude/rules/`, because `paths:` can't match by org. Instead it's symlinked as `~/dev/<org>/AGENTS.md`. Claude Code loads every `AGENTS.md` in the directories above the session, so the org rule loads alongside each repo's own `AGENTS.md`.
  - **Required setting:** by default, any `CLAUDE.md` or `CLAUDE.local.md` in or above the working directory makes Claude Code skip every `AGENTS.md`, org rules included. Several repos have their own `CLAUDE.md`, so set **Project instructions** to `claude-md-and-agents-md`: run `/config`, or set `pluginConfigs` → `cc-plugin-agents-md@builtin` → `options.instructionFiles` in `~/.claude/settings.json`. The hook warns each session while it's unset.
  - Paths differ inside a devcontainer, so the org file isn't above the repo there. The container setup has to bring it in.
- **`skills/*`:** each skill directory is symlinked into `~/.claude/skills/`.
- **Machine-specific instructions:** `~/.claude/CLAUDE.md` (untracked). Don't repeat rule content there, or it loads twice.

## Sync hook

[`sync.sh`](sync.sh) runs at `SessionStart`. It:

1. Fast-forwards this clone.
2. Removes broken symlinks in `~/.claude/rules/` and `~/.claude/skills/` that point into this repo, left by deleted or renamed items.
3. Symlinks any new `rules/*.md`, `rules/lang`, or `skills/*` directory, but only if `~/.claude/rules/` or `~/.claude/skills/` already exists and the target name is free.
4. For each `rules/orgs/<org>.md` whose `~/dev/<org>/` exists, symlinks it as `~/dev/<org>/AGENTS.md` if that name is free. It first removes a `~/dev/<org>/CLAUDE.md` that is exactly the one-line import older versions of the hook wrote. Any other `CLAUDE.md` is left alone.
5. Warns if **Project instructions** isn't `claude-md-and-agents-md` (needs `jq`).

It never overwrites. `CLAUDE_CONFIG_DIR` overrides `~/.claude`, and `AGENTIC_DEV_DIR` overrides `~/dev`.

## Install

From the clone's root:

```bash
mkdir -p ~/.claude/skills ~/.claude/rules
```

```bash
agents/claude/sync.sh
```

The first run links everything, including the org `AGENTS.md` files. Then register the hook in `~/.claude/settings.json` so it runs every session (use the clone's absolute path):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "~/dev/ethan-arrowood/agentic/agents/claude/sync.sh", "timeout": 15 }
        ]
      }
    ]
  }
}
```

Finally, add the required setting to `~/.claude/settings.json` (see [How each kind loads](#how-each-kind-loads)):

```json
{
  "pluginConfigs": {
    "cc-plugin-agents-md@builtin": {
      "options": { "instructionFiles": "claude-md-and-agents-md" }
    }
  }
}
```

## Cloud sessions

Claude Code cloud sessions (claude.ai/code) start each session in a fresh container, so the install runs from the cloud environment's setup script instead of a hook. Add this as the environment's setup script (cloud environment menu, then Edit):

```bash
# Load Ethan's agentic rules and skills (github.com/Ethan-Arrowood/agentic).
d=/root/dev/ethan-arrowood/agentic
if [ ! -d "$d/.git" ]; then
  git clone -q --depth 1 https://github.com/Ethan-Arrowood/agentic "$d" || echo "agentic: clone failed"
fi
# Load AGENTS.md files even in repos that also have a CLAUDE.md.
s=/root/.claude/settings.json
mkdir -p /root/.claude/rules /root/.claude/skills
[ -s "$s" ] || echo '{}' > "$s"
jq '.pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles = "claude-md-and-agents-md"' "$s" > "$s.tmp" && mv "$s.tmp" "$s"
if [ -x "$d/agents/claude/sync.sh" ]; then
  "$d/agents/claude/sync.sh"
fi
```

Each container clones the latest `main`, so rule changes reach the next cloud session without a pull. A failed clone prints a note and the session starts without the rules. Repos are cloned to `/home/user/<repo>`, not `~/dev/<org>/<repo>`, so org rules don't load. *Cloud sessions* in [`git.md`](../../rules/git.md#cloud-sessions) covers how the rules change there.

To keep an independent snapshot of a skill instead of a link, copy it: `cp -R skills/nodejs-contribute ~/.claude/skills/`.
