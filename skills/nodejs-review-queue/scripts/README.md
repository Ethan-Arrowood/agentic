# nodejs-review-queue tools

Bundled helpers for the skill. Invoke by absolute path from the skill base dir
(`/Users/ethan/.claude/skills/nodejs-review-queue/scripts/…`). Config via env:
`REPO` (default `nodejs/node`), `ME` (default `gh api user`). Team set lives in
`lib.sh` (`MY_TEAMS`).

Review-*specific* helpers. The build/CI/repro tools (`build-node.sh`,
`ci-status.sh`, `repro.sh`) moved to the **`nodejs-contribute`** skill — one
source of truth; reference them there.

| Tool | Purpose | Notes |
|------|---------|-------|
| `lib.sh` | Shared `gh_retry` (secondary-rate-limit backoff) + `REPO`/`ME`/`MY_TEAMS` | sourced by the others (own copy; `nodejs-contribute` has its own) |
| `build-queue.sh` | Step 1 team-mention queue → sorted PR numbers | serial+spaced+self-healing; safe to background; progress to stderr |
| `rereview.py [--all]` | Step 1b: classify PRs you've reviewed (RE-REVIEW-ASAP / RE-REVIEW / CQ-CANDIDATE / UNADDRESSED / CURRENT) | compares your last-review commit to head |

**Prereqs:** `gh` (authed), plus `nodejs-contribute` installed (for its shared
`ci-status.sh`/`build-node.sh`/`repro.sh`). Requires the permission allow-rules
in SKILL.md (Session start → permission setup). Read-only w.r.t. GitHub — none post.
