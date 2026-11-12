---
name: nodejs-contribute
description: Build, test, commit, and land your own changes in a local nodejs/node clone — builds and tests in the official nightly devcontainer (local ccache build as fallback), running tests (including node-api addon tests), DCO-signed commits, and driving a PR through CI to landing. Use when working on or finishing a nodejs/node PR or fix (building, testing, committing, pushing, or landing), NOT when reviewing others' PRs.
metadata:
  author: Ethan Arrowood
  tags: nodejs, github, contributing, build, testing, git, pull-requests
  version: 1.0.0
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - WebFetch
---

# Contributing to nodejs/node

Operational handbook for making changes to a local `nodejs/node` clone. This **distills** `BUILDING.md` and `doc/contributing/*` and captures the hard-won gotchas — always defer to those docs when they disagree; they're authoritative and they drift.

For **reviewing/triaging other people's** PRs (read-only), use the `nodejs-review-queue` skill instead. This skill is for **your own** changes (or a takeover you're finishing).

## Repo baseline (always true for this clone)

- Clone lives at `~/dev/nodejs/node`. Remotes: **`origin` = the user's fork** (`Ethan-Arrowood/node`), **`upstream` = `nodejs/node`**. PR refs live on `upstream`.
- Resting state is latest `main`: `git fetch upstream main && git checkout main && git pull --ff-only upstream main`. Reconfigure + rebuild after any pull that brings commits (see Building).
- ⚠️ **Fix branch tracking immediately after creating a work branch.** `git worktree add … -b <branch> upstream/main` sets the new branch to track **`upstream/main`**, not the fork. That is actively dangerous: any `git pull`, or VS Code's *Sync Changes* button, then merges `nodejs/node` main **into the PR branch**, producing a merge commit that nodejs rejects — and `git status` reports nonsense like *"Your branch and 'upstream/main' have diverged, and have 2 and 8 different commits"* (2 = your commits, 8 = upstream's since your base). After the first push, always:
  ```bash
  git push -u origin <branch>          # or, if already pushed:
  git branch --set-upstream-to=origin/<branch> <branch>
  ```
  Check with `git rev-parse --abbrev-ref <branch>@{upstream}` — it must print `origin/<branch>`. Only `main` should track `upstream/main`.
- **Keep `origin/main` current.** A stale fork main (it drifted 2281 commits once) is what makes GitHub's "Update branch" button offer bogus conflicts and tempt a merge commit. `git push origin main` whenever main is fast-forwarded.
- **Don't chase the tip when rebasing.** nodejs/node lands ~1 commit per 30 min, so any base is hours-old immediately; that is fine. Jenkins `node-test-pull-request` rebases onto current `origin/main` itself (`REBASE_ONTO`) before building. Rebase when the PR is genuinely `CONFLICTING`/far behind, not to match `upstream/main` exactly. Verify with `git merge-tree --write-tree upstream/main HEAD` rather than by comparing SHAs.
- **Commit trailers (DCO) — NOT `Co-Authored-By`.** Every commit ends with:
  ```
  Assisted-by: <model>
  Signed-off-by: Ethan Arrowood <ethan@arrowood.dev>
  ```
  (`<model>` is the human-readable name of the model running, with the agent's usual attribution email if it has one.) nodejs requires the DCO `Signed-off-by` and uses `Assisted-by` for AI assistance. This overrides the global `Co-Authored-By` default.
- **Don't keep workflow notes in an untracked agent instruction file in the clone.** It won't travel across machines. This skill is the portable source of truth.

## One-time setup (per machine)

- **Container engine:** Podman (preferred) or Docker, with a VM large enough to compile (6 CPUs and 12 GiB works).
- **Devcontainer image:** `scripts/devc.sh pull` (about 10 GB, so ask first).
- **`@node-core/utils`** (`ncu-ci` + `git-node`) and `gh` on the host, for CI status and landing: `npm i -g @node-core/utils`. It reads `~/.ncurc` for the GitHub token.

Only for the [local fallback build](#local-build-fallback-scriptsbuild-nodesh):

- **ccache** — the review/dev loop rebuilds C++ and switches branches constantly; ~2,000 of Node's ~3,300 targets are V8/deps identical across branches. Check `which ccache`; if missing (macOS): `brew install ccache`, add `export CC="ccache cc"` / `export CXX="ccache c++"` to `~/.zshrc`, and `ccache -M 25G` (V8 objects are large; the 5GB default thrashes). Linux: `apt install ccache mold` + `CC="ccache gcc"`/`CXX="ccache g++"`/`LDFLAGS="-fuse-ld=mold"`.
  - ⚠️ **gyp bakes the compiler command into the ninja graph at `./configure` time** — `CC`/`CXX` must be set *before* configure, and agent shells may not source `~/.zshrc`, so **export them inline** on the configure command.

## Building in the devcontainer (default): `scripts/devc.sh`

Build and test inside the official `nodejs/devcontainer:nightly` image through `scripts/devc.sh`. Use the [local build](#local-build-fallback-scriptsbuild-nodesh) only when the user asks, or the engine or image is unavailable.

```bash
scripts/devc.sh build              # configure if needed, then ninja node (background it)
QUIC=1 scripts/devc.sh build       # only when QUIC is in scope (see below)
scripts/devc.sh run out/Release/node test/parallel/test-foo.js
scripts/devc.sh run python3 tools/test.py --mode=release parallel/test-foo
scripts/devc.sh status             # image age, container, built binary, old volumes
scripts/devc.sh pull               # newer nightly image, about 10 GB: ask first
```

- Run it from the checkout (the main clone or a worktree). Each checkout gets its own container.
- **In the container:** configure, build, tests, lint, and anything that runs `out/Release/node` (a Linux binary). **On the host:** editing, `git`, `gh`, `ncu-ci`.
- **Don't run `./configure` or `ninja` by hand in the container.** `devc.sh build` matches the image's flags and interpreter, which keeps its prebuilt cache valid. Anything else can rebuild all of V8. `RECONFIGURE=1` forces a configure.
- **To try a PR, use `repro.sh` in the main clone.** Never `git checkout` an old PR head: one a few weeks behind `main` rebuilds all of V8. If it happens anyway, ask before recreating the `out/` volume (`devc.sh down`, remove the volume `devc.sh status` lists, `devc.sh build`).
- **A crash may be a `DCHECK` that CI never sees.** The image builds with `--debug-node`, which turns `DCHECK`s on, and CI's Release build compiles them out. Check `main` in the same container before blaming a PR (`repro.sh` does), and say when a finding depends on a `DCHECK`.
- A new container takes about 4 minutes to set up and build, so reuse the main clone's for reviews. Suggest `devc.sh pull` when `status` shows an image over a week old. A pull doesn't touch existing containers: a checkout moves to the new image after `devc.sh down`, then `build`. Never remove containers or volumes without asking.

## Configure-time feature gating (both build paths)

⚠️ **Experimental subsystems are gated at CONFIGURE time, not just by a runtime flag.** `configure_quic()`/`configure_dtls()` in `configure.py` set `node_use_quic`/`node_use_dtls`, and without the configure flag the module is **compiled out entirely**:
- `import 'node:quic'` throws `ERR_UNKNOWN_BUILTIN_MODULE` — with nothing pointing at the build as the cause,
- `process.features.quic` is `false` and `process.versions.ngtcp2` is empty,
- every `test-quic-*` test silently **skips** via `hasQuic`, so a green test run proves nothing.

**Set `QUIC=1` only when QUIC is in scope:** a `quic:` PR or task, or changes to `lib/quic.js`, `lib/internal/quic/`, `src/quic/`, `deps/ngtcp2/`, or `test/parallel/test-quic-*`. `devc.sh build`, `repro.sh`, and `build-node.sh` leave it off otherwise. Every build prints a `features:` line so you can see what actually landed in the binary. `DTLS=1` adds `--experimental-dtls` (needed for `src/dtls` / `node:dtls` work, e.g. reviewing PRs that touch the shared `src/crypto` TLS/DTLS/QUIC code). Both flags still need their **runtime** flag too — `node --experimental-quic …`.

**`--node-builtin-modules-path` makes the binary load `lib/*.js` from disk.** Both build paths set it. So after one build:
- **Editing an existing `lib/*.js`** → no rebuild; just run `out/Release/node`.
- **Rebuild REQUIRED for:** any C++ change, AND **adding/removing a builtin module file** (e.g. a new `lib/net/promises.js`) — the builtin manifest is generated by `js2c` and compiled in, so a new module isn't `require`-able until you rebuild. Reconfigure first so the new file is picked up. Symptom if you forget: `Cannot find module` / missing from `require('node:module').builtinModules`. `devc.sh build` reconfigures when the `lib/**/*.js` list changes.

## Local build (fallback): `scripts/build-node.sh`

Use only when the user asks for a host build, or the devcontainer is unavailable.

```bash
CC="ccache cc" CXX="ccache c++" ./configure --ninja --node-builtin-modules-path "$(pwd)"   # add --experimental-quic only for QUIC work
ninja -C out/Release node
```
Run it in the **background**, stream output directly (never pipe through `tail` — it hides progress). Reconfigure after every pull that adds/removes files or changes gyp gating; an incremental `ninja` against a stale graph fails with confusing errors.

### 💾 Disk hygiene — a build is ~25 GB, and every worktree gets its own

**Check `df -h` before starting a build in a new worktree.** A Release build is **~25 GB** and each worktree has a separate `out/`, so three review worktrees will fill a disk. The out-of-space failure is misleading — the build dies deep in V8 with `libtool: error writing file 'libv8_base_without_compiler.a'` (that one archive is 4.7 GB) and says nothing about disk.

**Release vs Debug — Release is the dev default, not a "production" build.** `./configure` targets it, `tools/test.py --mode=release` is how tests run, and CI's gating `node-test-pull-request` builds it. Debug is a *diagnostic* build: unoptimized, with `CHECK`/`DCHECK` and V8 debug assertions live. It is **bigger** than Release (~27 GB vs ~25 GB; binary 286 MB vs 134 MB) and makes test runs far slower, so it is never the cheaper daily driver.

**Build Debug only when you actually need C++-level debugging** — chasing a crash or memory bug where debug assertions would fire, or stepping in a debugger — and **delete it when done**:
```bash
CC="ccache cc" CXX="ccache c++" ./configure --ninja --debug   # add --experimental-quic only for QUIC work
ninja -C out/Debug node
# ... debug ...
rm -rf out/Debug
```

Rules:
- **Remove a review worktree as soon as its review is done** — `git worktree remove --force <path>` then `git branch -D <branch>`. Re-fetching a PR ref later is cheap; 25 GB is not. Keep only worktrees with active work.
- **`out/Release/obj.target` is stale make-generator output and is safe to delete** (~11 GB). Ninja builds into `out/Release/obj/`; nothing in the ninja graph produces or consumes `obj.target`. Its only textual mention is a `-DMODULESDIR=` string constant in `openssl.ninja` pointing at a path that doesn't even exist. It is **not** recreated by a `--ninja` build — only by a `./configure` without `--ninja`. Confirm first: `find out/Release/obj.target -type f -newermt "<recent date>" | wc -l` should be `0` while the same check on `out/Release/obj` is large.
- **Don't trim ccache** (~9 GB, 25 GB cap). It lives outside `out/` (`~/Library/Caches/ccache` on macOS) and is exactly what makes deleting an `out/` cheap — rebuilds come back at ~45-65% cache hits instead of recompiling.

### 🧠 Memory — cap the job count or the machine swaps

Ninja defaults to `ncpu + 2`. A V8 translation unit peaks at roughly **0.5-2 GB**, so on a 16-18 GB machine that default drives the box deep into swap and makes everything else unusable — the build gets *slower*, because paging isn't compiling.

`build-node.sh` therefore computes a RAM-aware job count — `min(ncpu, RAM_GB / 3)` — and prints what it chose:
```
-j6 (ncpu=12, ram=18G, ninja default would be 14)
```
Measured on a 12-core / 18 GB machine, same build: `-j14` → 28 compilers, 4.9 GB RSS, 37% free, swap nearly exhausted. `-j6` → 12 compilers, 2.9 GB RSS, 45% free. Roughly half the memory, and no slower in wall-clock because it stops thrashing.

Overrides: `JOBS=N` for an explicit count; `NICE=1` additionally wraps ninja in `taskpolicy -b` (macOS background QoS — throttles CPU *and* I/O, maximum interactivity, noticeably slower build).

## Testing

With the devcontainer, prefix each command below with `devc.sh run` (the local fallback runs them as written).

- Run a test: `python3 tools/test.py --mode=release parallel/test-foo` (or a path). Run a single file directly: `out/Release/node test/parallel/test-foo.js`.
- **Native-addon tests need their addon compiled first** — `out/Release/node test/node-api/foo/test.js` alone fails with `Cannot find module`. Build the matching target:
  - `test/node-api/**` → `make build-node-api-tests`
  - `test/js-native-api/**` → `make build-js-native-api-tests`
  - `test/addons/**` → `make build-addons`
- **Demonstrate claimed failure modes, don't just trace them** — `scripts/repro.sh <pr> <test-path> [runs]` builds `main` then the PR's commits rebased onto `main` (as CI does; `REBASE=0` for the head as-is), runs the test N times on each, and reports pass/crash/fail (it auto-builds the right addon target for node-api/addons tests). Honestly report a repro that does NOT reproduce — that kills the finding.
- **Lint:** the bundled eslint, NOT `npx` (npx pulls a fresh eslint missing Node's bundled plugins). If `tools/eslint/node_modules` is incomplete (`Cannot find module '@babel/plugin-syntax-import-defer'`), run `npm install` in `tools/eslint` once. Then:
  ```bash
  out/Release/node tools/eslint/node_modules/eslint/bin/eslint.js --config eslint.config.mjs <files>
  ```
  (or `make lint-js` for everything). Lint is a CI gate — check changed files before pushing.

## Committing

- Subsystem-prefix the summary (`net: …`, `http: …`); follow `doc/contributing/pull-requests.md` commit-message guidelines.
- **Trailers: `Assisted-by:` + `Signed-off-by:` (DCO), never `Co-Authored-By`** — see Repo baseline.
- Commits authored as the user (repo git config). Pushing a rebase/amend to your PR branch on `origin` needs `--force-with-lease`; adding a commit on top is a plain push.

## CI on your PR — `scripts/ci-status.sh <pr>`

- **Never conclude CI status from `gh pr checks`** — it mixes stale check-runs from different Jenkins runs. The gate is Jenkins `node-test-pull-request`. `ci-status.sh <pr>` runs `ncu-ci` and verifies the result is against the **current head** (SUCCESS/FAILURE/PENDING + HEAD-MATCH/STALE; NO-RUN → recommend `request-ci`).
- Classify a real FAILURE: is it in the PR's own subsystem, or unrelated infra/flake? Rebase `BUILD_FAILURE` ("could not apply …"), `test-repl-user-error-handler`, `test-internet` ENODATA on a net/dns PR, etc. are usually not the diff.
- **`test-internet`** is a path-filtered (`lib/net.js`/`lib/dns.js`/`internal/dns/**`/`test/internet/**`), real-world-network workflow, frequently red from live-DNS drift, and is **not** the commit-queue gate.
- **`request-ci` triggers CI; it does not run on its own.** `auto-start-ci.yml` (every 5 min) picks up `request-ci`-labeled + approved PRs, starts Jenkins, and **removes the label** (one-shot, consumed). The Jenkins job rebases onto `origin/main` (`REBASE_ONTO`) before building — so a fresh run tests against current main **without a manual rebase**; only rebase manually when `mergeable: CONFLICTING`.
  - ⏳ **Open question (unconfirmed):** PRs sometimes show multiple CI runs over days with one `request-ci` cycle and no new commits — leading hypothesis is collaborators clicking Jenkins "Rebuild"/"Resume", i.e. not automatic. Confirm over time; don't assume auto-rerun.

## Landing (`doc/contributing/collaborator-guide.md` is authoritative)

- **Approvals:** two non-author collaborator approvals; **one suffices once open >7 days.** Allow 48h (72h over a weekend) for input.
- **`commit-queue`** label lands automatically (`git node land --autorebase`); the author may also `git-node land`. Requires **pre-existing green CI** (it does not start CI) → so `request-ci` → green → `commit-queue`.
  - Multi-commit PRs need a policy label or the queue fails them (default `--oneCommitMax` only lands single-commit PRs): **`commit-queue-squash`** (collapse all into one — the common case; norm is one-commit-per-logical-change) or **`commit-queue-rebase`** (keep the commits — only when each is self-contained and passes tests on its own).
- **"Closed" = landed.** A PR landed via commit-queue/`git node land` shows as **closed with `mergedAt: null`** and a "Landed in <commit>" comment (commits are cherry-picked/rebased onto main, not merged via the button). Don't read `mergedAt: null` as "didn't land."
- **`mergeStateStatus: BLOCKED`** is normal for almost every nodejs PR (it reflects the merge-button/signed-commit ruleset nodejs doesn't use for landing — commit-queue re-signs). Not a commit-queue blocker; don't gate on it or build tooling around it.
- `commit-queue-failed` from a past attempt is often stale (e.g. CI that was red due to an unrelated main breakage since fixed) — re-check current state before assuming a real problem.

## Semver & labels

- No `semver-patch` label exists — **patch is the unlabeled default.** `semver-major` (breaking / silent→throw behavior change), `semver-minor` (new public API). `notable-change` for CHANGELOG-worthy.
- **Experimental surface** (Stability 1) → behavior changes are fine as **patch**, no `semver-major` (e.g. experimental quic/zlib-Zstd/iterable-streams).
- Add backport labels for changes to APIs already shipped in an LTS/current line.

## Bundled tools (`scripts/`)

Paths are relative to this skill's directory. The `nodejs-review-queue` skill uses these too.

- `lib.sh` — shared config (`REPO`/`ME`/`MY_TEAMS`) + `gh_retry` (GitHub secondary-rate-limit backoff).
- `devc.sh <up|build|run|sh|status|pull|down>`: the default build and test environment: the nightly devcontainer, one container per checkout (run from the checkout; background `build`). Env toggles: `QUIC=1` (off by default), `DTLS=1`, `JOBS=N`, `RECONFIGURE=1`, `DEVC_ENGINE`, `DEVC_IMAGE`. See [Building in the devcontainer](#building-in-the-devcontainer-default-scriptsdevcsh).
- `build-node.sh`: local fallback, ccache reconfigure + `ninja` on the host (run from repo root; background it). Env toggles: `QUIC=1` (off by default), `DTLS=1`, `JOBS=N` (default `min(ncpu, RAM_GB/3)`), `NICE=1` (macOS background QoS). Prints the resolved configure args, the chosen `-j`, and a `features:` line on success.
- `ci-status.sh <pr>` — authoritative CI via `ncu-ci`, verified against current head.
- `repro.sh <pr> <test-path> [runs]` — main-vs-PR failure/fix demonstration with the PR rebased onto main (`REBASE=0` for the head as-is); builds and runs in the devcontainer (`LOCAL=1` for the host); auto-builds native addons for node-api/addons tests; returns to `main` and cleans up.

Run build and CI work through these scripts, one command each. They set the environment themselves, so they work regardless of `~/.zshrc`, and a single command is easier for an agent's permission rules to allow than an env-prefixed or piped one.
