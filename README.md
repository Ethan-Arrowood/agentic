# agentic

Agentic skills, rules, and hooks for my ([@Ethan-Arrowood](https://github.com/Ethan-Arrowood)) development workflows.

> 🌟 Human First and Upholding Community
>
> Before reading any further, please know that I believe in a human-first agentic development workflow. Open source community is built on personal connection. Adopting agentic tools should not impact human interaction in community spaces.
> 
> I've personally adopted the [Human Voice]() AI policy. By default (and particularly in any open governance project that accepts agentic assistance) all messages are coming directly from me. I may use AI to help understand and write code. I may use AI to help outline or draft a comment/message, but they are always handwritten by myslf
>
> In some projects where more agentic development procedures are accepted (such as HarperFast or random personal projects), I may have more agent-authored messages. At a minimum, they are always at least manually reviewed before posted.
>
> I'm not perfect, and these tools are evolving so rapidly. Sometimes I may make a mistake. I try really hard to configure my agentic tools appropriately. If you ever see something that doesn't seem right, please bring it to my attention. GitHub notifications are particularly swamped these days. I recommend emailing me at ethan@arrowood.dev or DM'ing me on [LinkedIn]() or [Bluesky]().

Each top-level directory except [`rules/`](#rules) and [`hooks/`](#hooks) is a self-contained skill: a `SKILL.md` with YAML frontmatter, plus any supporting files (usually a `scripts/` toolkit with its own README).

## Skills

| Skill | What it does |
|-------|--------------|
| [`nodejs-contribute`](nodejs-contribute/) | Build, test, commit, and land your own changes in a local [`nodejs/node`](https://github.com/nodejs/node) clone. ccache + RAM-aware `ninja` builds, configure-time feature gating (QUIC/DTLS), native-addon tests, DCO commit trailers, authoritative CI status via `ncu-ci`, and the landing/label policy. Ships the shared `build-node.sh`, `ci-status.sh`, and `repro.sh` tools. |
| [`nodejs-review-queue`](nodejs-review-queue/) | Surfaces and triages open `nodejs/node` PRs relevant to your subsystem teams, one at a time. Built around how Node.js actually routes reviews (team @-mentions from `nodejs-github-bot`, not individual assignment). Includes a re-review lane for PRs you already reviewed and a cleanup-sweep mode for stalled PRs. **Read-only:** it never posts to GitHub. **Requires `nodejs-contribute`** for its build/CI/repro tools. |

Both Node.js skills are tuned to my setup: they hardcode my GitHub login, nodejs team memberships, clone location (`~/dev/nodejs/node`), and the install path `~/.claude/skills/<name>/scripts/`. Adjust those before using them yourself.

## Rules

[`rules/`](rules/) holds rule files: instructions the agent loads automatically, not invoked like a skill. Dev environments should clone this repo and symlink the rules directory as needed. New or changed rules load at the start of the next session.

| Rule | What it covers | Loads |
|------|----------------|-------|
| [`git.md`](rules/git.md) | Scratch-file locations, session-start checks, worktree-first workflow, default commit trailer. | Every session |
| [`posting.md`](rules/posting.md) | Never post without explicit permission. Human Voice by default (outline, I write, agent proofreads), with exceptions set by narrower rules. First person and a footer per platform. | Every session |
| [`writing.md`](rules/writing.md) | Prose style for anything written: project style guide first, then brevity, no filler, short sentences, no em dashes, sparing semicolons, correctness. | Every session |
| [`markdown.md`](rules/markdown.md) | Markdown style defaults, links, and what not to add. Defers to a repo's lint config. | When a `.md`/`.mdx` file is read or written |
| [`lang/node.md`](rules/lang/node.md) | Node.js version resolution and use via fnm. | When a JS/TS file or `package.json` is read |
| [`orgs/nodejs.md`](rules/orgs/nodejs.md) | `nodejs` org: DCO trailers (built from the per-tool trailer in `git.md`), built binary vs fnm, defer to each repo's docs. | Repos under `~/dev/nodejs/` |

### Layout and how each kind loads

- **`rules/*.md`:** global. Linked into `~/.claude/rules/` and loaded in every session.
- **`rules/lang/*.md`:** one per language. Also linked into `~/.claude/rules/` (subdirectories are fine there), but each has `paths:` frontmatter so it loads only once the agent touches a matching file.
- **`rules/orgs/<org>.md`:** one per GitHub org. **Not** linked into `~/.claude/rules/`: `paths:` can't match by org, because user-level patterns are relative to the session's working directory. Instead, repos clone to `~/dev/<org>/<repo>`, and Claude Code loads every `CLAUDE.md` in the directories above the session. So `~/dev/<org>/CLAUDE.md` holds a single import line, e.g. `@~/dev/ethan-arrowood/skills/rules/orgs/nodejs.md`.
  - A `CLAUDE.md` above a repo stops Claude Code from reading that repo's own `AGENTS.md` (e.g. `nodejs/node` has one). Set **Project instructions** to `claude-md-and-agents-md` (via `/config`, or `pluginConfigs` → `cc-plugin-agents-md@builtin` in `~/.claude/settings.json`) so both load.
  - Paths differ inside a devcontainer, so the org file isn't above the repo there; the container setup has to bring it in.
- **Harper org rules** live in a private repo, using the same layout.

### How rules relate to CLAUDE.md and AGENTS.md

A rule in `~/.claude/rules/` is equivalent to a global `~/.claude/CLAUDE.md`: both load in full into every session on the machine. Rules win for source control because they are many files, can be symlinked individually, and support `paths:` frontmatter.

`AGENTS.md` is **repo-scoped**, not global. It's the cross-tool convention for a project's own instructions, committed at the repo root. Claude Code reads it only when the repo has no `CLAUDE.md`. There is no global `AGENTS.md`; each tool has its own global location (`~/.claude/`, `~/.codex/AGENTS.md`, …), so syncing to another agent means installing these files there too.

Where other instructions belong:

- **Machine-specific** → `~/.claude/CLAUDE.md` (untracked). Don't repeat rule content there, or it loads twice.
- **Work-specific (Harper)** → a rule file in a private repo, not this public one.
- **Procedures used only sometimes** (build/land workflows, review checklists) → a skill. Only its description stays in context until it's needed.
- **Things that must never happen** → a hook or permission rule. Rules are guidance, not enforcement.

### Conventions for rule files

Every always-loaded rule costs context in every session, and longer instruction sets are followed less reliably. To keep them in check:

- **One topic per file**, named for the topic (`git.md`, `markdown.md`). Splitting by topic also lets a machine install only the rules it needs (e.g. work rules only on a work machine).
- **Under 200 lines per file.** Past that, split it, move procedural detail into a skill, or keep it long deliberately and say why at the top of the file.
- **Write for the agent, not for people.** Rules load verbatim; notes about the file itself belong in this README.
- **Scope with `paths:` frontmatter when a rule only matters for some files.** Claude Code then loads it only once it reads or edits a matching file. For user-level rules the patterns match against the session's working directory. Other agents ignore this frontmatter.

  ```markdown
  ---
  paths:
    - "**/*.md"
  ---
  ```
- **No contradictions between rules.** Nothing gives one rule priority over another; when two conflict the agent may follow either. Write narrower rules as explicit exceptions ("In `nodejs/node`, instead of X, do Y").

## Hooks

[`hooks/`](hooks/) holds scripts that the harness runs. Unlike rules, hooks are enforced. Hook scripts live here, but each one is registered in `~/.claude/settings.json`, which is a single file that can't be symlinked per entry.

| Hook | Event | What it does |
|------|-------|--------------|
| [`sync.sh`](hooks/sync.sh) | `SessionStart` | Fast-forwards this clone (`git pull --ff-only`). It removes broken symlinks in `~/.claude/rules/` and `~/.claude/skills/` that point into this repo, left by deleted or renamed items. Then it symlinks any new `rules/*.md`, `rules/lang`, or skill directory into `~/.claude/rules/` and `~/.claude/skills/`, but only if that directory already exists and the target name is free. It is silent on a no-op and otherwise adds a short note to the session: what was pulled, a failed pull, uncommitted local changes, or links added or removed. It always exits 0. |

A rule pulled at session start loads in the next session, so updates reach a machine one session late. The hook only pulls; push from the machine where you edit.

## Install

Symlink so this repo stays the single source of truth (edit here, it's live everywhere):

```bash
mkdir -p ~/.claude/skills ~/.claude/rules
ln -s "$(pwd)/nodejs-contribute" ~/.claude/skills/nodejs-contribute
ln -s "$(pwd)/nodejs-review-queue" ~/.claude/skills/nodejs-review-queue
for f in "$(pwd)"/rules/*.md; do ln -s "$f" ~/.claude/rules/; done
ln -s "$(pwd)/rules/lang" ~/.claude/rules/lang
mkdir -p ~/dev/nodejs && echo "@$(pwd)/rules/orgs/nodejs.md" > ~/dev/nodejs/CLAUDE.md
```

Register the sync hook in `~/.claude/settings.json` (use the clone's absolute path):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "~/dev/ethan-arrowood/skills/hooks/sync.sh", "timeout": 15 }
        ]
      }
    ]
  }
}
```

Or copy a skill if you'd rather keep an independent snapshot (`cp -R nodejs-contribute ~/.claude/skills/`).

My [dotfiles](https://github.com/Ethan-Arrowood/dotfiles) do the linking with `repo Ethan-Arrowood/skills` (skills) and `rules Ethan-Arrowood/skills` (rules) lines in a Skillfile.

## Usage

Invoke a skill with `/<name>` (e.g. `/nodejs-review-queue`), or describe the task. Claude Code matches on each skill's `description`. Rules need no invocation.
