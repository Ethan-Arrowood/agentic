# Git and working directory

These practices apply to any agent. Tool-specific values are in [Per-tool settings](#per-tool-settings) at the end.

## Working directory

Repos are cloned to `~/dev/<org>/<repo>`, where `<org>` is the GitHub owner. Look there first for a related repo.

Operate within the relative working directory. Keep worktrees, temporary files, and other scratch state in the tool's own directory under it, written here as `<agent-dir>`:

- Worktrees: `<agent-dir>/worktrees/<name>`
- Temporary files: `<agent-dir>/tmp/`

Git must ignore these paths, so they never appear in `git status` or get committed by accident. If `git check-ignore -q <agent-dir>/tmp` fails, they aren't ignored yet. Add `<agent-dir>/tmp/` and `<agent-dir>/worktrees/` to `.git/info/exclude`, which works like `.gitignore` but applies only to this clone and is never committed. Don't edit the project's `.gitignore` for this.

## Session start

1. Read `AGENTS.md`, `CONTRIBUTING.md`, and `README.md` from the project root if they exist. They may also be under `.github/`. Use them for project conventions, contribution guidelines, and context.

Then, if the session will change code (skip for question-only sessions):

2. Check `git status`. If there are uncommitted changes, **stop and ask** whether to stash, commit, or keep working on the current branch. Do not switch branches automatically.
3. If already inside a linked worktree (`git rev-parse --git-dir` differs from `--git-common-dir`), stay on its branch. Don't check out the default branch there.
4. If on a branch other than the default, say so and ask before switching away from it.
5. Otherwise update the default branch from the canonical remote: `upstream` if it exists (fork setups), otherwise `origin`.
   ```bash
   remote=$(git remote | grep -qx upstream && echo upstream || echo origin)
   default=$(git symbolic-ref --short "refs/remotes/$remote/HEAD" | cut -d/ -f2-)
   git checkout "$default" && git pull --ff-only "$remote" "$default"
   ```
   If `refs/remotes/$remote/HEAD` is missing, run `git remote set-head "$remote" --auto` once. Never let the pull create a merge commit.

## Worktrees by default

Default to git worktrees for all development work. Create a plain branch only when asked.

Branch from an explicit, freshly fetched base, never from whatever happens to be checked out:

```bash
git fetch "$remote" "$default"
git worktree add "$PWD/<agent-dir>/worktrees/<name>" -b <name> "$remote/$default"
git worktree remove "$PWD/<agent-dir>/worktrees/<name>"   # once merged
```

- Don't nest: if the session is already in a worktree (one the tool created, or from an earlier step), work there.
- A branch created from `$remote/$default` tracks it. Before the first push, push with `-u` to the remote you'll open the PR from, so `git pull` never merges the base into the branch.

## Commit trailers

Credit the agent with a `Co-Authored-By` trailer. `<model>` is the human-readable name of the model actually running. Use the tool's own trailer from [Per-tool settings](#per-tool-settings). For a tool not listed there, use the trailer it documents. If it documents none, use `Co-Authored-By: <model>` with no email.

Org rules may replace this with a project convention, such as a DCO sign-off.

## Per-tool settings

### Claude Code

- `<agent-dir>` is `.claude`. Claude Code's built-in worktree feature uses `.claude/worktrees/` too, so worktrees you create with `git worktree add` and worktrees Claude Code creates end up in the same folder.
- Commit trailer, with `<model>` such as "Claude Opus N.N":
  ```text
  Co-Authored-By: <model> <noreply@anthropic.com>
  ```

#### Cloud sessions

A Claude Code cloud session (claude.ai/code, where `CLAUDE_CODE_REMOTE=true`) starts in a fresh container with the repo already cloned and a branch assigned for the work. The container is deleted when the session ends. In a cloud session, these replace the matching rules above:

- **Working directory:** repos are at `/home/user/<repo>`, not `~/dev/<org>/<repo>`. Org rules don't load.
- **Session start:** do step 1 only. Work on the assigned branch. Don't check out or pull the default branch, and don't ask before working on the assigned branch.
- **Worktrees:** don't create them. Work on the assigned branch in the existing clone.
- **Pushing:** unpushed work is lost with the container, so push commits to the assigned branch before you finish. The [Posting](posting.md#permission) rules allow this without asking.

### Codex

- `<agent-dir>` is `.codex`.
- Commit trailer: the general default above, with `<model>` such as "GPT-N Codex".
