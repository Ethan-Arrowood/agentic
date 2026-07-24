# nodejs-review-queue tools

Bundled helpers for the skill. Invoke by absolute path from the skill base dir
(`/Users/ethan/.claude/skills/nodejs-review-queue/scripts/…`). Config via env:
`REPO` (default `nodejs/node`), `ME` (default `gh api user`). Team set lives in
`lib.sh` (`MY_TEAMS`).

| Tool | Purpose | Notes |
|------|---------|-------|
| `lib.sh` | Shared `gh_retry` (secondary-rate-limit backoff) + `REPO`/`ME`/`MY_TEAMS` | sourced by the others |
| `build-queue.sh` | Step 1 team-mention queue → sorted PR numbers | serial+spaced+self-healing; safe to background; progress to stderr |
| `rereview.py [--all]` | Step 1b: classify PRs you've reviewed (RE-REVIEW-ASAP / RE-REVIEW / CQ-CANDIDATE / UNADDRESSED / CURRENT) | compares your last-review commit to head |
| `ci-status.sh <pr>` | Authoritative CI via `ncu-ci`, verified against current head | prints NO-RUN→request-ci, or SUCCESS/FAILURE/PENDING + HEAD-MATCH/STALE; lists failure types |
| `build-node.sh` | Reconfigure (ccache) + `ninja` | run from node repo root; background it; streams progress |
| `repro.sh <pr> <test-path> [runs]` | Demonstrate a crash/failure: main baseline vs PR head, N runs each | builds both, returns to main, cleans up `pr-<n>`; auto-builds addons for `test/node-api/`·`test/js-native-api/`·`test/addons/` tests |

**Prereqs:** `gh` (authed), `@node-core/utils` (`ncu-ci`), `ccache`, and the
node repo checked out with `upstream` = `nodejs/node`. Requires the permission
allow-rules documented in SKILL.md (Session start → permission setup).

These encode the hard-won details (rate-limit backoff, CI head-matching,
ccache-before-configure, author-vs-head review comparison) so each session
doesn't re-derive them. Read-only w.r.t. GitHub — none of them post.
