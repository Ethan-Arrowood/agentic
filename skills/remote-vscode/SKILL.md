---
name: remote-vscode
description: Give the user a command that opens a file or folder from this machine in VS Code on their own machine, over Remote-SSH. Use when the user says "remote vscode", "remote VS Code", "open it in VS Code", "give me the code command", or asks for a command to view a file, diff, or worktree from this session. Also opens uncommitted changed files for review.
metadata:
  author: Ethan Arrowood
  tags: vscode, remote-ssh, editor, workflow
  version: 1.1.0
---

# Remote VS Code

I work from an interactive machine and run agent sessions on a remote one. VS Code's Remote-SSH extension opens the remote machine's files from the interactive machine. When I ask for this, I'm already connected, and this session runs on the remote machine.

## The command

Give me this to run on my interactive machine:

```bash
code --remote ssh-remote+<host> <absolute-path>
```

- `<host>` is the SSH host alias that my interactive machine uses for this machine. This machine can't see it. See [Finding the host](#finding-the-host).
- `<absolute-path>` is the path on this machine, file or folder. Write it out in full. Don't use `~` or a relative path; my local shell would resolve them on the wrong machine.
- For a file in a repo or worktree, give the path in the worktree you're working in, not the main clone.
- To point me at a line, use `-g <absolute-path>:<line>` in place of that path. Add `:<column>` when it matters.
- `code` takes several paths. Put them all in one command.
- Don't run `code` yourself unless `VSCODE_IPC_HOOK_CLI` is set (see [Changed files](#changed-files)). Otherwise it would open a window on this machine's display, not mine.

## Changed files

When the path is a repo or worktree with uncommitted changes, open the changed files too, so I can review them. From the repo root:

```bash
git diff --name-only --diff-filter=d HEAD
git ls-files --others --exclude-standard
```

The first lists staged and unstaged changes, without deleted files. The second lists untracked files. Make each path absolute, then put the repo root first and the files after it:

```bash
code --remote ssh-remote+<host> <repo-root> <changed-file> <changed-file> ...
```

- More than 10 files: list them and ask whether to open them all.
- If `VSCODE_IPC_HOOK_CLI` is set, this session runs in a VS Code terminal connected to my window. There, run `code -r <changed-file> ...` yourself instead of giving me a command. It opens the files in that window.

## Finding the host

Take the first of these that applies:

1. The alias I gave in this conversation.
2. An alias saved in your persistent memory, if you have one. It's a best guess: name it when you give the command so I can correct it.
3. Otherwise ask me for it. Don't guess from `hostname`; the alias is set on my side and usually differs.

When I give or correct an alias, save it to your persistent memory if you have one. Note that it's the Remote-SSH alias for this machine.
