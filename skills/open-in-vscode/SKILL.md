---
name: open-in-vscode
description: Open work in progress in VS Code for the user to review, on this machine or over Remote-SSH from the user's own machine. Use whenever you present work for review (a change, a worktree, a file or line you're pointing at), and when the user says "open it in VS Code", "remote vscode", "give me the code command", or asks to see a file, diff, or worktree from this session.
metadata:
  author: Ethan Arrowood
  tags: vscode, remote-ssh, editor, review, workflow
  version: 2.0.0
---

# Open in VS Code

When you have work for me to look at, open it in VS Code: the repo or worktree, plus the files that changed. I shouldn't have to work out worktree paths myself.

I often work from an interactive machine and run agent sessions on a remote one, connected with VS Code's Remote-SSH extension. Then `code` has to run on my machine, not this one.

## Where I am

Take the first of these that applies:

1. `VSCODE_IPC_HOOK_CLI` is set: this session runs in a VS Code terminal connected to my window. Run `code -r <paths>` yourself. It opens them in that window, local or remote.
2. I said in this conversation whether I'm local or remote, and for remote, the SSH host alias.
3. Your persistent memory, if you have one, says so for this machine. It's a best guess: name it when you open things so I can correct it.
4. Otherwise ask whether I'm on this machine or connected remotely, and for remote, the SSH host alias my machine uses for this one. Don't guess the alias from `hostname`; it's set on my side and usually differs.

When I answer or correct you, save it to your persistent memory if you have one, noted as this machine's setting.

## The command

Local: run it yourself.

```bash
code <paths>
```

Remote: give it to me to run on my machine. Don't run it yourself; it would open a window on this machine's display.

```bash
code --remote ssh-remote+<host> <paths>
```

- Paths are on this machine, written out in full. Don't use `~` or a relative path; for remote, my shell would resolve them on the wrong machine.
- Use the worktree you're working in, not the main clone.
- Put the repo or worktree root first, then the files. `code` takes several paths in one command.
- To point me at a line, use `-g <path>:<line>` in place of that path. Add `:<column>` when it matters.

## Changed files

When opening a repo or worktree, also open the files that changed: on the branch and uncommitted, but not deleted. From its root, with `<base>` the default branch of the canonical remote (such as `origin/main`, or `upstream/main` in a fork):

```bash
git diff --name-only --diff-filter=d "$(git merge-base HEAD <base>)"
git ls-files --others --exclude-standard
```

The first lists committed and uncommitted changes since the branch left `<base>`. The second lists untracked files. Make each path absolute.

- More than 10 files: list them and ask whether to open them all.
- No changes: open the root alone.
