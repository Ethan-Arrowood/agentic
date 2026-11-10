# nodejs-review-queue tools

Review-specific helpers for the skill. Invoke them from the skill's directory, such as `~/.claude/skills/nodejs-review-queue/scripts/` for Claude Code or `~/.agents/skills/nodejs-review-queue/scripts/` for Codex. Config via env: `REPO` (default `nodejs/node`) and `ME` (default `gh api user`). The tracked team set is `MY_TEAMS` in `lib.sh`.

The build, CI, and repro tools (`build-node.sh`, `ci-status.sh`, `repro.sh`) live in the `nodejs-contribute` skill.

| Tool | Purpose | Notes |
|------|---------|-------|
| `lib.sh` | `REPO`, `ME`, `MY_TEAMS`, `gh_retry` (secondary-rate-limit backoff), `search_prs` (paginated PR search) | Sourced by the others. `nodejs-contribute` has its own copy. |
| `build-queue.sh` | Step 1: PRs whose bot review request lists one of your teams. Prints `<number>\t<unchecked teams>\t<checked teams>`. | Serial, spaced, and self-healing. Safe to background. Progress goes to stderr. Exits 1 with `INCOMPLETE:` if any call failed. |
| `rereview.py [--all]` | Step 1b: sorts PRs you've reviewed into RE-REVIEW-ASAP, RE-REVIEW, CQ-CANDIDATE, UNADDRESSED, or CURRENT. | Compares your latest decisive review's commit to the PR head. |

**Prereqs:** `gh` (authenticated) and `zsh`, plus the `nodejs-contribute` skill for its shared tools. None of these scripts post to GitHub.
