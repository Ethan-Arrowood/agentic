# nodejs-contribute tools

General nodejs/node build/test/CI helpers. Invoke them from the skill
directory (`~/.claude/skills/nodejs-contribute/scripts/…`). Config via
env: `REPO` (default `nodejs/node`), `ME` (default `gh api user`).

| Tool | Purpose | Notes |
|------|---------|-------|
| `lib.sh` | Shared `REPO`/`ME`/`MY_TEAMS` + `gh_retry` (secondary-rate-limit backoff) | sourced by the others |
| `build-node.sh` | Reconfigure (ccache) + `ninja` | run from the node repo root; background it; streams progress |
| `ci-status.sh <pr>` | Authoritative CI via `ncu-ci`, verified against current head | NO-RUN→request-ci, or SUCCESS/FAILURE/PENDING + HEAD-MATCH/STALE; lists failure types |
| `repro.sh <pr> <test-path> [runs]` | Demonstrate a crash/fix: main baseline vs PR head, N runs each | builds both, returns to main, cleans up `pr-<n>`; auto-builds addons for `test/node-api/`·`test/js-native-api/`·`test/addons/` tests |

**Prereqs:** `gh` (authed), `@node-core/utils` (`ncu-ci`), `ccache`, and the node
repo checked out with `upstream` = `nodejs/node`. Read-only w.r.t. GitHub — none post.

The `nodejs-review-queue` skill also uses `ci-status.sh`/`build-node.sh`/`repro.sh`
from here (it references them by absolute path rather than duplicating them).
