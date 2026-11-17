---
name: nodejs-review-bank
description: Continuously running companion to nodejs-review-queue that keeps a bank of prepared, verified nodejs/node reviews on disk, so the user can sit down and work through them one at a time. A loop of ticks refreshes the team queue and re-review lane, prunes landed or already-reviewed PRs, prepares new reviews with subagents in parallel build slots, and reads the user's dispositions back from GitHub. Never posts to GitHub. Use when the user wants a review bank, wants node reviews prepared in the background, or says they're ready to work through prepared node reviews.
metadata:
  author: Ethan Arrowood
  tags: nodejs, github, code-review, pull-requests, workflow, background
  version: 0.1.0
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Node.js review bank

Keep a bank of prepared `nodejs/node` reviews ready, so the user works through them one at a time instead of waiting for each to be prepared. The bank lives on disk and survives context resets and restarts.

This skill builds on two others, which must be installed alongside it:

- `nodejs-review-queue`: what to review, how to review it, the summary format, and every hard rule. This skill changes when reviews are prepared, not how.
- `nodejs-contribute`: building, running, CI status, and label policy.

## Hard rules

1. **All of `nodejs-review-queue`'s *Hard rules* apply.** Read-only on GitHub (never post, label, review, or react). The user writes all review text, following [Human Voice](https://ai-policy.dev/policies/human-voice/1.0.0). One PR action at a time. Full upstream URLs for every PR.
2. **Never bank an unverified finding as verified.** A subagent's draft is a lead, not a result. See [Verify](#4-verify).
3. **One agent per slot.** Only an agent holding a slot builds, checks out, or runs anything. See [Slots](#slots).
4. **`gh` stays serial across all agents.** Only `bank.py` calls `gh`, through `gh_retry` and a lock. Preparing agents read the dossier and never call `gh`. GitHub's secondary rate limit trips on concurrent calls (see `nodejs-review-queue`'s *GitHub rate limits*).
5. **CI status only from `ci-status.sh`** (in the dossier as `ci.txt`), never `gh pr checks`.

## Bank on disk

`scripts/bank.py` owns the bank. It lives at `$XDG_STATE_HOME/nodejs-review-bank/` (default `~/.local/state/nodejs-review-bank/`, `NODE_REVIEW_BANK` overrides). That is outside every checkout, so no `git clean` or worktree removal touches it, and both slots share it.

| Path | Contents |
|------|----------|
| `prs/<pr>.md` | One entry per PR: front matter, then the review summary |
| `dossier/<pr>/` | Prefetched GitHub data for preparing agents. Deleted when the entry is done. |
| `cache/` | Team queue, re-review lane, candidate metadata, org block lookups |
| `locks/` | Tick, `gh`, and slot locks |
| `archive/` | Earlier entries for a PR that came back after a new push |
| `slots.tsv` | Slot name and checkout path, one per line |

Entry front matter: `pr`, `url`, `title`, `author`, `lane`, `state`, `head` (SHA prepared against), `pr_head` (latest seen), `created_at`, `prepared_at`, `presented_at`, `my_teams`, `rereview_from` (commit of the user's last decisive review), `needs_run` (count), `disposition`, `disposition_at`, `snooze_until`, `lease`, `note`. Edit fields only through `bank.py set`.

**States:**

| State | Meaning |
|-------|---------|
| `preparing` | Dossier fetched, an agent is preparing it. Lapses to `stale` after `LEASE_MINUTES` (120). |
| `needs-run` | Verified read-only, but some items wait for a slot run |
| `ready` | Verified and complete |
| `presented` | Shown to the user, waiting on their action. At most one at a time. |
| `stale` | The head moved after preparation. Re-prepared first on the next tick. |
| `done` | The user acted, or the PR closed, merged, became a draft, or got `commit-queue` |

**Lanes**, in priority order: `rereview-asap`, `rereview`, `cq`, `fresh` (one of the user's teams unchecked), `fresh-checked`, `skip` (the *Subsystem skip list*: inspector and diagnostics_channel). The first three are `rereview.py`'s RE-REVIEW-ASAP, RE-REVIEW, and CQ-CANDIDATE buckets. Within a lane, the most recently updated PR comes first.

`bank.py list` prints the bank by priority. `bank.py show <pr>` prints one entry.

## The tick

A tick is idempotent. Run it on a loop (see [Per-tool settings](#per-tool-settings)); missing one costs nothing.

### 1. Refresh, sync, and plan

```bash
scripts/bank.py tick
```

It takes a lock, so overlapping ticks exit early. Then it:

- Reruns `nodejs-review-queue`'s `build-queue.sh` when the cached team queue is over `REFRESH_MINUTES` (120) old, or with `--refresh`. On 2026-11-17 that took 15 minutes (432 candidates, 99 relevant). On `INCOMPLETE`, it keeps the previous rows and adds the new ones.
- Reruns `rereview.py --tsv` every tick (one search and a few GraphQL calls).
- Syncs every open entry in one GraphQL batch: drops PRs that merged, closed, or became drafts, and PRs by the user. In nodejs, closed usually means landed (`nodejs-contribute`, *Landing*). Marks an entry `stale` when its head moved since preparation. Reads back the user's reviews, label changes, and comments since the entry was created, records them as the `disposition`, and marks the entry `done`. A `cq` entry is also done once anyone adds `commit-queue`.
- Prints the bank and `PREPARE <pr> lane=<lane>` lines: stale entries first, then new candidates in priority order, up to `BANK_TARGET` (6) active entries. A candidate is skipped while its entry is open, or when the user already reviewed its current head or chose a disposition for it.

### 2. Prepare each planned PR

For each `PREPARE` line, while agents are free:

1. `scripts/bank.py prefetch <pr>`: writes `dossier/<pr>/` and fetches the PR head to `refs/review-bank/<pr>` in `~/dev/nodejs/node` (without touching any working tree or `FETCH_HEAD`). It also fetches `upstream/main` and the `upstream/v*-staging` branches, at most every 30 minutes. The entry moves to `preparing`.
2. Decide whether it needs a slot. Most PRs don't: start read-only, and let verification ask for runs. Give a slot up front only when the claim to check is a crash or a behavior change.
3. Start a preparing agent with the [brief](#preparing-agent-brief).

A `cq` entry needs no agent. Check the gates from the dossier yourself: approvals in `pr.json`, `ci.txt` showing `SUCCESS` and `HEAD-MATCH`, `mergeable`, and the commit count for `commit-queue-squash` (see `nodejs-contribute`, *Landing*). Then `put` it.

### 3. Collect drafts

A preparing agent writes `dossier/<pr>/draft.md` and reports. Verify it before banking.

### 4. Verify

The orchestrator verifies every draft. Check, don't trust:

- **Each finding:** open the cited line at the PR head (`git show refs/review-bank/<pr>:<path>`) and confirm the code says what the finding claims. A finding that depends on behavior is verified by running it in a slot, or moves to *Needs a run*. A finding you can't confirm moves to *Unverified*, with the reason.
- **Process facts** (CI, approvals, labels, mergeable, conflicts): take them from `pr.json` and `ci.txt`, not from the draft.
- **Discussion:** check that "already raised" points come from `discussion.json`, not from excluded content (see [Reading the discussion](#reading-the-discussion)).
- **Label advice:** apply `nodejs-contribute`'s *Release-line labels*. Releasers add most `dont-land-on-vN.x` labels themselves, so recommend one only where that section says a reviewer's label is needed.
- **Stale guidance:** the skills in this repo are the source of truth. A draft can cite outdated rules (an installed copy of a skill can lag a merged change). Correct it.

Then bank it: `scripts/bank.py put <pr> <summary.md>`. The state becomes `needs-run` if the summary's *Needs a run* section lists items, otherwise `ready`. If the head moved during preparation, `put` marks it `stale` instead.

When a slot frees up, run the oldest `needs-run` entry's items, move the results into *Findings* or *Unverified*, and `put` it again.

### Summary format

`nodejs-review-queue`'s step 2 structured summary (*What it does*, *Assessment*, *Findings*, *Missing classification labels*, *Recommended actions*), plus three sections:

```markdown
### Verification
- 🟠 lib/net.js:1412 null deref: confirmed at the head, and the repro fails on main and passes on the PR (slot 2, 20 runs).

### Needs a run
- test/parallel/test-net-foo.js: expect a failure on main and a pass on the PR. Kind: new-test.

### Unverified
- Possible double `close` emit: the draft traced it, but the code path at lib/net.js:900 returns first. Not raised.
```

Every finding under *Findings* carries how it was verified. For a re-review lane entry, *What it does* covers the change since `rereview_from` and whether the user's earlier points were addressed.

## Preparing agent brief

Give each preparing agent this, filled in:

```text
Prepare a read-only review of https://github.com/nodejs/node/pull/<pr> (lane <lane>).
Follow the nodejs-review-queue skill's step 2 and its summary format.
Inputs: <bank>/dossier/<pr>/ (pr.json, diff.patch, discussion.json, ci.txt, release-lines.txt, meta.json).
Code: git -C ~/dev/nodejs/node show|diff|log|merge-tree using refs/review-bank/<pr> and upstream/main.
<For a re-review: the user's last decisive review was at <rereview_from>. Focus on what changed since.>
Slot: <none | <slot path>, held for you; build and run only there>.
Rules: never call gh or post anything. Without a slot, never check out, build, or run node.
Read discussion only from discussion.json. Cite file:line for every claim.
List anything that needs a build or run under "Needs a run", with the command and expected result.
Write the summary to <bank>/dossier/<pr>/draft.md and report.
```

## Reading the discussion

`bank.py prefetch` writes `discussion.json` through `bank.py discussion <pr>`, which reads comments, reviews, and inline threads through GraphQL. `gh pr view --json comments,reviews` and the REST endpoints lack the minimized fields, so never read discussion from them. The filter:

- Content hidden as spam, abuse, low-quality, or off-topic is dropped entirely: don't credit it, and don't treat its points as already raised.
- Content hidden as outdated, duplicate, or resolved stays with `status: resolved-context`.
- Content by a user the `nodejs` org blocks is dropped. The check (`gh api -i orgs/nodejs/blocks/<login>`: 204 blocked, 404 not) needs org moderation rights. Results are cached for a week. Logins it couldn't check are listed in `block_check_unknown`.

A finding first raised by excluded content can still be raised, on its own verified evidence.

## Slots

A slot is a checkout with its own devcontainer. Defaults in `slots.tsv`:

| Slot | Checkout |
|------|----------|
| `1` | `~/dev/nodejs/node` (rests on `main`) |
| `2` | `~/dev/nodejs/node/.claude/worktrees/review-b` (detached at `main`) |

```bash
scripts/bank.py slot status
scripts/bank.py slot acquire any <pr> <agent>   # prints the slot name and path; skips checkouts with changes; exit 3 if none free
scripts/bank.py slot release <slot>             # refuses while the checkout has changes
```

Rules:

- Acquire before the agent starts, release after it reports. Never give one slot to two agents, or one PR two slots (`repro.sh` uses a `repro-<pr>` branch in the shared repository).
- An agent works only in its slot's checkout, through `nodejs-contribute`'s `devc.sh` and `repro.sh`.
- `repro.sh` leaves the PR's build in `out/`. Run `devc.sh build` in the slot before anything that needs `main`'s binary.
- Claude Code blocks `rm -rf` on variable paths. Clean up with literal paths.

Run recipes, from the slot's checkout:

- **Crash or fix:** `repro.sh <pr> <test-path> [runs]`.
- **A test the PR adds:** `repro.sh` reports `MODULE_NOT_FOUND` on main, because the file isn't there. To show it fails on main, copy it into the slot's ignored `.claude/tmp/`, fix its relative requires, and run it against main's `lib/`:
  ```bash
  git show refs/review-bank/<pr>:test/parallel/test-foo.js | sed "s#require('\.\./#require('../../test/#g" > .claude/tmp/test-foo.js
  <nodejs-contribute>/scripts/devc.sh run out/Release/node .claude/tmp/test-foo.js
  ```
- **A PR that only changes existing `lib/*.js` files:** no rebuild needed, since the binary loads `lib/` from disk. Write the PR's version into the file in place, run, then restore. Never `git apply`: it replaces the file, and the container's bind mount then fails with "Cannot load externalized builtin". If `main` changed the file since the PR's merge base, merge first:
  ```bash
  git show "$(git merge-base main refs/review-bank/<pr>)":lib/foo.js > .claude/tmp/base.js
  git show refs/review-bank/<pr>:lib/foo.js > .claude/tmp/pr.js
  git merge-file -p lib/foo.js .claude/tmp/base.js .claude/tmp/pr.js > .claude/tmp/patched.js
  cat .claude/tmp/patched.js > lib/foo.js
  # run the test, then restore:
  git checkout -- lib/foo.js
  ```
  A conflict from `git merge-file` means the PR needs `repro.sh` instead. New `lib/` files need a rebuild (`nodejs-contribute`, *Configure-time feature gating*).

## Presentation mode

When the user says they're ready ("next review", "show me the bank"):

1. Run `bank.py sync`, then `bank.py present`. It marks the top `ready` entry (or `needs-run` if none are ready) as presented and prints it. Present the summary, with the PR's full URL.
2. Stop and wait, exactly as `nodejs-review-queue`'s *Stop and wait*. Outlines and proofreading follow that skill's step 2.
3. When the user says they're done with it, run `bank.py sync <pr>`. If it finds their action, the entry is done. Report the recorded disposition and present the next one.
4. If GitHub shows no action yet, say so and ask: they may not have submitted, or chose to skip. Record their answer: `bank.py set <pr> state=done disposition=skipped`, or `bank.py set <pr> state=ready snooze_until=<ISO time>` for later.

The loop keeps running meanwhile. While an entry is presented, a tick reports in one line at most, and never presents.

On request, give the session roll-up from `bank.py list --all`, grouped by disposition, as in `nodejs-review-queue`'s step 4.

## Per-tool settings

### Claude Code

- **Loop:** start it with the `loop` skill, for example `/loop 20m run one nodejs-review-bank tick`, or with no interval to let the session pace itself.
- **Tick:** run `~/.claude/skills/nodejs-review-bank/scripts/bank.py tick` with Bash in the background. A team queue refresh takes several minutes.
- **Preparing agents:** spawn them with the Agent tool in the background, at most two holding slots and two read-only at a time. Release a slot when its agent reports, whatever the outcome.
- **After a context reset or restart:** run `bank.py list` and `bank.py slot status`. Entries left `preparing` by a lost agent lapse to `stale` on their own. A slot held by a lost agent needs `bank.py slot release <slot>` once you've checked its checkout.
- **Permissions:** see *Permissions for the Node.js skills* in this repo's `agents/claude/README.md`.
