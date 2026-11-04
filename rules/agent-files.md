# Agent instruction files

Applies whenever you create, edit, or recommend files that configure or instruct coding agents: project instructions, org-level instructions, and the docs and scripts that install them.

## AGENTS.md first

- Put agent instructions in `AGENTS.md`. It's the cross-tool convention, so every agent that supports it reads the same file.
- Don't create an agent-specific instruction file (`CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`, and similar) when `AGENTS.md` can do the job.
- Use an agent-specific file only when a tool requires it, such as a setting or feature that only reads from that path. Keep it minimal: point it at `AGENTS.md` (an import or a symlink) instead of duplicating content, and say in a comment or the commit why it's needed.
- In a repo that already has an agent-specific instruction file, follow the repo's convention. Suggest moving the content to `AGENTS.md`, but don't migrate it unasked.

## Agnostic by default

- Write instructions that make sense to any agent. Keep tool-specific values (paths, commands, trailers, settings) in a clearly labeled per-tool section, like *Per-tool settings* in the Git rules.
- Prefer formats and locations shared across tools over a single tool's: `AGENTS.md`, `SKILL.md` skills, plain scripts over tool-specific plugin formats.
- When a tool-specific mechanism is unavoidable, isolate it (its own file, directory, or section) so other agents can ignore it.
