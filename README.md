# skills

Personal [Claude Code](https://claude.com/claude-code) skills by [@Ethan-Arrowood](https://github.com/Ethan-Arrowood).

Each top-level directory is a self-contained skill (a `SKILL.md` with YAML frontmatter, plus any supporting files). Drop one into `~/.claude/skills/` — or symlink it — and Claude Code will pick it up.

## Skills

| Skill | What it does |
|-------|--------------|
| [`nodejs-review-queue`](nodejs-review-queue/) | Surfaces and triages open [`nodejs/node`](https://github.com/nodejs/node) PRs relevant to your subsystem teams, one at a time. Built around how Node.js actually routes reviews (team @-mentions from `nodejs-github-bot`, not individual assignment). **Read-only** — it helps you review; it never posts to GitHub. Includes checkout-and-build workflow, CI-flake vs. stale diagnosis, landing/label policy, and stalled-PR triage. |

## Install

Symlink a skill into your Claude Code skills directory (single source of truth — edit here, it's live everywhere):

```bash
ln -s "$(pwd)/nodejs-review-queue" ~/.claude/skills/nodejs-review-queue
```

Or copy it if you'd rather keep an independent snapshot:

```bash
cp -R nodejs-review-queue ~/.claude/skills/
```

Invoke with `/nodejs-review-queue` in Claude Code, or just ask for a Node.js review queue.
