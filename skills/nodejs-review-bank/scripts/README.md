# nodejs-review-bank tools

Invoke them from wherever your agent installed the skill. They find the sibling skills' scripts through their own resolved path, so install all three skills from the same clone, or set `RQ_SCRIPTS` and `NC_SCRIPTS`.

| Tool | Purpose | Notes |
|------|---------|-------|
| `bank.py` | The bank: `tick`, `sync`, `plan`, `list`, `show`, `present`, `prefetch`, `put`, `set`, `hold`, `unhold`, `slot`, `image prune` | Run with no arguments for usage. Python 3 standard library only. Backs off on the secondary rate limit like `gh_retry`. |
| `bin/gh` | `gh` shim: one `gh` call at a time across processes, at least `GH_MIN_GAP` (1) seconds apart. The lock is a `flock`, so a crashed caller can't leave it held. `bank.py` holds the same lock while it runs `git node metadata`. | `bank.py` puts `bin/` first on `PATH` for everything it runs, including `build-queue.sh`, `rereview.py`, `discussion.sh`, and `ci-status.sh` |
| `tests/` | Offline tests: a fake `gh` (`fake_gh.py`), a stub `git-node`, a fake `devc.sh` (`fake_devc.py`), a fake container engine for `devc.sh` itself (`fake_engine.py`), a Docker Hub answer from a file, a temporary bank, and stub sibling scripts | `cd scripts && python3 -m unittest discover -s tests`. No network or container engine, and the real bank is never touched. |

Env: `NODE_REVIEW_BANK` (bank directory, default `$XDG_STATE_HOME/nodejs-review-bank`), `NODE_CLONE` (default `~/dev/nodejs/node`), `REPO`, `ME`, `BANK_TARGET` (6), `REFRESH_MINUTES` (120), `LEASE_MINUTES` (120), `SEARCH_SLEEP` (passed through to `build-queue.sh`), `GH_RETRY_SLEEP` (backoff unit in seconds, default 60), `BANK_METADATA` (lanes whose dossier gets `metadata.txt` from `git node metadata`: `cq` (default), `all`, or `off`), `DEVC_IMAGE` (shared with `devc.sh`), `IMAGE_CHECK_MINUTES` (60: how often to ask Docker Hub, and to retry a failed pull or move), `DEVC_HUB_URL` (the Docker Hub tag API URL, derived from `DEVC_IMAGE`).

`bank.py` writes only to the bank directory and to `refs/review-bank/*` in the node clone, apart from the image work in free slots: `devc.sh pull`, `down`, `build`, and, with `image prune`, `prune`. None of these tools post to GitHub.

**Prereqs:** the `nodejs-review-queue` and `nodejs-contribute` skills, `gh` (authenticated), `git node` from node-core-utils with `~/.ncurc` credentials (for `metadata.txt`), `zsh`, `python3`, and `git` 2.29 or later (`fetch --no-write-fetch-head`).
