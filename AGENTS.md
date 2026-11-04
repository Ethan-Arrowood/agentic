# agentic

My personal repo of agent rules, skills, and per-agent install tooling. See `README.md` for the layout.

## Posting exception

This is an exception to the Human Voice default in the Posting rules. It's my personal repo and I don't expect other contributors, so you may write commit messages and PR descriptions here yourself. Use the exception footer. [Permission](rules/posting.md#permission) still applies: never commit, push, or open a PR without my go-ahead.

## Working here

- Rules in `rules/` are agent-agnostic. Tool-specific install logic belongs in `agents/<agent>/`, following the agent files rule.
- When adding, renaming, or moving a rule, skill, or agent, update the matching tables and sections in `README.md` and the agent READMEs.
- Test `agents/*/sync.sh` changes against scratch directories, never your real config. Use the overrides: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `AGENTIC_DEV_DIR`, `AGENTIC_AGENTS_SKILLS_DIR`.
- Hooks must stay silent on a no-op, never overwrite files they didn't create, and always exit 0.
