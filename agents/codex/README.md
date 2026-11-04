# Codex

How this repo installs into [Codex](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## How each kind loads

Codex reads one global instruction file, `~/.codex/AGENTS.md`, then each `AGENTS.md` from the repo root down to the working directory. It doesn't look above a repo's root and ignores `paths:` frontmatter. So:

- **All rules** (`rules/*.md`, `rules/lang/*.md`, `rules/orgs/*.md`) are concatenated, with frontmatter stripped, into a generated `~/.codex/AGENTS.md`. Every rule loads in every session. Lang and org rules state their own scope.
- **Size:** Codex stops loading instructions past `project_doc_max_bytes` (default 32 KiB). The hook warns when the generated file is over that.
- **Machine-specific instructions:** `~/.codex/AGENTS.local.md` (untracked). The hook appends it to the generated file. Don't edit `~/.codex/AGENTS.md` directly.
- **`skills/*`:** each skill directory is symlinked into `~/.agents/skills/`, which Codex scans for user skills.

## Sync hook

[`sync.sh`](sync.sh) runs at `SessionStart`. It:

1. Fast-forwards this clone.
2. Rebuilds `~/.codex/AGENTS.md` if `~/.codex/` exists and the content changed. It refuses to replace an `AGENTS.md` it didn't generate (one without its marker comment on the first line).
3. Removes broken symlinks in `~/.agents/skills/` that point into this repo, then symlinks any new skill, if that directory exists and the target name is free.

`CODEX_HOME` overrides `~/.codex`, and `AGENTIC_AGENTS_SKILLS_DIR` overrides `~/.agents/skills`.

## Install

If `~/.codex/AGENTS.md` already exists, move its content to `~/.codex/AGENTS.local.md` and delete it. Then, from the clone's root:

```bash
mkdir -p ~/.agents/skills
```

```bash
agents/codex/sync.sh
```

The first run generates `~/.codex/AGENTS.md` and links the skills. Then register the hook in `~/.codex/hooks.json` so it runs every session (use the clone's absolute path):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "~/dev/ethan-arrowood/agentic/agents/codex/sync.sh" }
        ]
      }
    ]
  }
}
```

Codex runs a hook only after you review and trust it. Run `/hooks` in Codex once after registering it.

The skills' bundled scripts expect to live under `~/.claude/skills/<name>/scripts/`. Under Codex, invoke them from `~/.agents/skills/<name>/scripts/` instead.
