# agentic

Agentic skills, rules, and hooks for my ([@Ethan-Arrowood](https://github.com/Ethan-Arrowood)) development workflows.

> 🌟 Human First and Upholding Community
>
> Before reading any further, please know that I believe in a human-first agentic development workflow. Open source community is built on personal connection. Adopting agentic tools should not impact human interaction in community spaces.
> 
> I've personally adopted the [Human Voice](https://ai-policy.dev/policies/human-voice/1.0.0) AI policy. By default (and particularly in any open governance project that accepts agentic assistance) all messages are coming directly from me. I may use AI to help understand and write code. I may use AI to help outline or draft a comment/message, but they are always handwritten by myself.
>
> In some projects where more agentic development procedures are accepted (such as HarperFast or random personal projects), I may have more agent-authored messages. At a minimum, they are always at least manually reviewed before being posted.
>
> I'm not perfect, and these tools are evolving so rapidly. Sometimes I may make a mistake. I try really hard to configure my agentic tools appropriately. If you ever see something that doesn't seem right, please bring it to my attention. GitHub notifications are particularly swamped these days. I recommend emailing me at ethan@arrowood.dev or DM'ing me on [LinkedIn](https://www.linkedin.com/in/ethan-arrowood/) or [Bluesky](https://bsky.app/profile/arrowood.dev).

## Skills

Each directory in [`skills/`](skills/) is a self-contained skill: a `SKILL.md` with YAML frontmatter, plus any supporting files (usually a `scripts/` toolkit with its own README).

| Skill | What it does |
|-------|--------------|
| [`nodejs-contribute`](skills/nodejs-contribute/) | Build, test, commit, and land your own changes in a local [`nodejs/node`](https://github.com/nodejs/node) clone. ccache + RAM-aware `ninja` builds, configure-time feature gating (QUIC/DTLS), native-addon tests, DCO commit trailers, authoritative CI status via `ncu-ci`, and the landing/label policy. Ships the shared `build-node.sh`, `ci-status.sh`, and `repro.sh` tools. |
| [`nodejs-review-queue`](skills/nodejs-review-queue/) | Surfaces and triages open `nodejs/node` PRs relevant to your subsystem teams, one at a time. Built around how Node.js actually routes reviews (team @-mentions from `nodejs-github-bot`, not individual assignment). Includes a re-review lane for PRs you already reviewed and a cleanup-sweep mode for stalled PRs. **Read-only:** it never posts to GitHub. **Requires `nodejs-contribute`** for its build/CI/repro tools. |

Both Node.js skills are tuned to my setup: they hardcode my GitHub login, nodejs team memberships, and clone location (`~/dev/nodejs/node`). Adjust those before using them yourself. They work in any agent that reads `SKILL.md` skills. Claude Code permission rules for them are in [`agents/claude/README.md`](agents/claude/README.md#permissions-for-the-nodejs-skills).

## Rules

[`rules/`](rules/) holds rule files: instructions the agent loads automatically, not invoked like a skill. They are written for any agent. Each agent's tooling in [`agents/`](#agents) installs them the way that agent expects.

| Rule | What it covers | Scope |
|------|----------------|-------|
| [`git.md`](rules/git.md) | Repo layout, scratch-file locations, session-start checks, worktree-first workflow, default commit trailer, Claude Code cloud session exceptions. | Every session |
| [`posting.md`](rules/posting.md) | Never post without explicit permission, or a pre-approval I give for the current task. Human Voice by default (outline, I write, agent proofreads), with exceptions set by narrower rules. First person and a footer per platform. | Every session |
| [`writing.md`](rules/writing.md) | Prose style for anything written: project style guide first, then brevity, no filler, short sentences, no em dashes, sparing semicolons, correctness. | Every session |
| [`agent-files.md`](rules/agent-files.md) | Prefer `AGENTS.md` over agent-specific instruction files, and keep agent setup tool-agnostic. | Agent config work |
| [`markdown.md`](rules/markdown.md) | Markdown style defaults, links, and what not to add. Defers to a repo's lint config. | Markdown files |
| [`lang/node.md`](rules/lang/node.md) | Node.js version resolution and use via fnm. | JS/TS code and `package.json` projects |
| [`orgs/nodejs.md`](rules/orgs/nodejs.md) | `nodejs` org: DCO trailers (built from the per-tool trailer in `git.md`), built binary vs fnm, defer to each repo's docs. | Repos under `~/dev/nodejs/` |

### Layout

- **`rules/*.md`:** global rules.
- **`rules/lang/<language>.md`:** one per language.
- **`rules/orgs/<org>.md`:** one per GitHub org. Repos clone to `~/dev/<org>/<repo>` on every machine, so an agent can tell which org a session is in from its path.
- **Harper org rules** live in a private repo, using the same layout.

How much of this an agent loads, and when, depends on the agent. Some can load a rule only for matching files or only under an org directory. Others load everything. So every lang and org rule states its scope in its first line, and works correctly even when loaded in every session.

Where other instructions belong:

- **Machine-specific:** the agent's own untracked file. See each agent's README in [`agents/`](#agents). Don't repeat rule content there, or it loads twice.
- **Work-specific (Harper):** a rule file in a private repo, not this public one.
- **Procedures used only sometimes** (build/land workflows, review checklists): a skill. Only its description stays in context until it's needed.
- **Things that must never happen:** a hook or permission rule. Rules are guidance, not enforcement.

### Conventions for rule files

Every always-loaded rule costs context in every session, and longer instruction sets are followed less reliably. To keep them in check:

- **One topic per file**, named for the topic (`git.md`, `markdown.md`). Splitting by topic also lets a machine install only the rules it needs (e.g. work rules only on a work machine).
- **Under 200 lines per file.** Past that, split it, move procedural detail into a skill, or keep it long deliberately and say why at the top of the file.
- **Write for the agent, not for people.** Rules load verbatim; notes about the file itself belong in this README.
- **Agent-neutral content.** Put tool-specific values in a per-tool section, like *Per-tool settings* in [`git.md`](rules/git.md).
- **Lang and org rules state their scope in the first line** ("Applies to repos in the `nodejs` GitHub org"). A rule may also carry `paths:` frontmatter to narrow loading in agents that support it. Tooling for agents that don't strips it.
- **No contradictions between rules.** Nothing gives one rule priority over another; when two conflict the agent may follow either. Write narrower rules as explicit exceptions ("In `nodejs/node`, instead of X, do Y").

## Agents

[`agents/`](agents/) holds one directory per agent, with the tooling that installs and syncs the rules and skills the way that agent expects. Each has a `sync.sh` meant to run as the agent's session-start hook, sharing helpers from [`agents/lib.sh`](agents/lib.sh), and a README with install steps.

| Agent | Rules go to | Skills go to | Org rules |
|-------|-------------|--------------|-----------|
| [Claude Code](agents/claude/) | Symlinks in `~/.claude/rules/` | Symlinks in `~/.claude/skills/` | `~/dev/<org>/AGENTS.md` symlinks, loaded only under that org |
| [Codex](agents/codex/) | One generated `~/.codex/AGENTS.md` | Symlinks in `~/.agents/skills/` | Included in the generated file, loaded everywhere |

Every hook fast-forwards this clone (`git pull --ff-only`), only installs into directories that already exist, never overwrites anything it didn't create, stays silent on a no-op, and always exits 0. A rule pulled at session start loads in the next session, so updates reach a machine one session late. The hooks only pull; push from the machine where you edit.

To add an agent, create `agents/<agent>/sync.sh` and a README covering where that agent reads global instructions and skills.

My [dotfiles](https://github.com/Ethan-Arrowood/dotfiles) do the install with `repo Ethan-Arrowood/agentic` (skills), `rules Ethan-Arrowood/agentic` (rules), and `hook <agent> Ethan-Arrowood/agentic#agents/<agent>/sync.sh SessionStart` (hooks) lines in a Skillfile.

## Usage

Invoke a skill by name (in Claude Code, `/<name>`, e.g. `/nodejs-review-queue`), or describe the task. Agents match on each skill's `description`. Rules need no invocation.
