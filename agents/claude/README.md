# Claude Code

How this repo installs into [Claude Code](https://code.claude.com/docs/en/memory).

## How each kind loads

- **`rules/*.md`:** symlinked into `~/.claude/rules/`. Loaded in every session, like a global `~/.claude/CLAUDE.md`.
- **`rules/lang/`:** the directory is symlinked into `~/.claude/rules/lang`. Each file's `paths:` frontmatter makes it load only once Claude reads or edits a matching file. For user-level rules the patterns match against the session's working directory.
- **`rules/orgs/<org>.md`:** not linked into `~/.claude/rules/`, because `paths:` can't match by org. Claude Code loads every `CLAUDE.md` in the directories above the session, so `~/dev/<org>/CLAUDE.md` holds a single import line, such as `@~/dev/ethan-arrowood/agentic/rules/orgs/nodejs.md`.
  - A `CLAUDE.md` above a repo stops Claude Code from reading that repo's own `AGENTS.md` (`nodejs/node` has one). Set **Project instructions** to `claude-md-and-agents-md` so both load: run `/config`, or set `pluginConfigs` → `cc-plugin-agents-md@builtin` → `options.instructionFiles` in `~/.claude/settings.json`.
  - Paths differ inside a devcontainer, so the org file isn't above the repo there. The container setup has to bring it in.
- **`skills/*`:** each skill directory is symlinked into `~/.claude/skills/`.
- **Machine-specific instructions:** `~/.claude/CLAUDE.md` (untracked). Don't repeat rule content there, or it loads twice.

## Sync hook

[`sync.sh`](sync.sh) runs at `SessionStart`. It:

1. Fast-forwards this clone.
2. Removes broken symlinks in `~/.claude/rules/` and `~/.claude/skills/` that point into this repo, left by deleted or renamed items.
3. Symlinks any new `rules/*.md`, `rules/lang`, or `skills/*` directory, but only if `~/.claude/rules/` or `~/.claude/skills/` already exists and the target name is free.
4. For each `rules/orgs/<org>.md` whose `~/dev/<org>/` exists, creates `~/dev/<org>/CLAUDE.md` with the import line if that file is missing.

It never overwrites. `CLAUDE_CONFIG_DIR` overrides `~/.claude`, and `AGENTIC_DEV_DIR` overrides `~/dev`.

## Install

From the clone's root:

```bash
mkdir -p ~/.claude/skills ~/.claude/rules
```

```bash
agents/claude/sync.sh
```

The first run links everything and creates the org files. Then register the hook in `~/.claude/settings.json` so it runs every session (use the clone's absolute path):

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

Finally, set **Project instructions** to `claude-md-and-agents-md` (see above).

To keep an independent snapshot of a skill instead of a link, copy it: `cp -R skills/nodejs-contribute ~/.claude/skills/`.
