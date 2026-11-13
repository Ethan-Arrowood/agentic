# nodejs-contribute tools

General nodejs/node build/test/CI helpers. Invoke them from wherever your
agent installed the skill. Config via env: `REPO` (default `nodejs/node`), `ME` (default `gh api user`).

| Tool | Purpose | Notes |
|------|---------|-------|
| `lib.sh` | Shared `REPO`/`ME`/`MY_TEAMS` + `gh_retry` (secondary-rate-limit backoff) | sourced by the others |
| `devc.sh <up\|build\|run\|sh\|status\|pull\|down>` | Build and test in the `nodejs/devcontainer:nightly` image, one container per checkout | the default; run from the checkout; background `build` |
| `build-node.sh` | Local fallback: reconfigure (ccache) + `ninja` on the host | run from the node repo root; background it; streams progress |
| `ci-status.sh <pr>` | Authoritative CI via `ncu-ci`, verified against current head | NO-RUN→request-ci, or SUCCESS/FAILURE/PENDING + HEAD-MATCH/STALE; lists failure types; UNKNOWN (exit 1) when `ncu-ci` fails; `--check` verifies setup |
| `repro.sh <pr> <test-path> [runs]` | Demonstrate a crash/fix: main baseline vs the PR rebased onto main, N runs each | needs a clean tree; builds both, returns to main, deletes only the `repro-<n>` branch it created; auto-builds addons for `test/node-api/`·`test/js-native-api/`·`test/addons/` tests |

**Prereqs:** `gh` (authed), `@node-core/utils` (`ncu-ci`), Podman or Docker with the
`nodejs/devcontainer:nightly` image (`devc.sh pull`), `ccache` for the local fallback only, and the node
repo checked out with `upstream` = `nodejs/node`. Read-only w.r.t. GitHub — none post.

The `nodejs-review-queue` skill also uses `ci-status.sh`/`devc.sh`/`repro.sh`
from here (it refers to this skill by name rather than duplicating them).
