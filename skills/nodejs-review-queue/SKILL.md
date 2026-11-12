---
name: nodejs-review-queue
description: Read-only review queue for nodejs/node PRs that the nodejs-github-bot routed to the user's subsystem teams, worked one PR at a time in chat, plus a re-review lane for PRs the user already reviewed and a cleanup sweep for stalled networking PRs. Never posts to GitHub. Use when the user says "node review queue", asks what node PRs to review, wants to triage their nodejs/node review backlog, or wants to clean up stalled or abandoned networking PRs.
metadata:
  author: Ethan Arrowood
  tags: nodejs, github, code-review, pull-requests, networking, workflow
  version: 2.0.0
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - WebFetch
---

# Node.js review queue

Surface and triage open `nodejs/node` PRs relevant to the user, one at a time, in one shared session. Node.js has no direct reviewer assignments, so this skill follows how the project actually routes reviews.

## Two modes

1. **Review queue** (default): PRs where `nodejs-github-bot` requested one of the user's teams. Deep, one PR at a time. See [Procedure](#procedure).
2. **Cleanup sweep**: every open PR with a networking subsystem label, ranked by author staleness, to triage abandoned or stalled PRs. See [Cleanup sweep](#cleanup-sweep).

Pick by intent. "What should I review" means mode 1. "Help me clean up stalled networking PRs" or "clear the backlog" means mode 2. Both are read-only: the user applies every label and posts every comment.

## Hard rules

1. **Read-only. Never post anything to GitHub.** No reviews, comments, `gh pr review`, approvals, labels, or reactions, even with in-conversation approval. Output stays in chat.
2. **The user is never a direct reviewer.** Don't search `review-requested:` or `user-review-requested:`. Relevance comes from team mentions.
3. **The user writes all review text.** They follow the [Human Voice](https://ai-policy.dev/policies/human-voice/1.0.0) policy. Give findings and outlines, never finished comment prose to paste.
4. **One PR action at a time.** See [Stop and wait](#3-stop-and-wait).
5. **Link every PR or issue as a full upstream URL**, never a bare `#NNNN`. The local clone's `origin` is the user's fork (`Ethan-Arrowood/node`), so bare refs auto-link to the wrong repo. Write `[#64663](https://github.com/nodejs/node/pull/64663)`, including in parentheticals like "fixes #38426".

## How Node.js routes reviews

`nodejs-github-bot` does two things:

- Posts a `Review requested:` comment with a checkbox per relevant team. An unchecked `- [ ]` means that team's review is outstanding. `- [x]` means it's satisfied.
  ```text
  Review requested:

  - [ ] @nodejs/http
  - [ ] @nodejs/http2
  - [ ] @nodejs/net
  ```
- Applies subsystem labels from the `<subsystem>:` prefix in the PR title and commits (a `http2: …` title gets the `http2` label).

A PR is relevant when the bot comment lists a team the user is in. Mentions and labels don't map 1:1. A PR can mention `@nodejs/http` and `@nodejs/net` but carry only `http2`. The bot may also list teams the user isn't in alongside ones they are.

## The user's teams

The user (`Ethan-Arrowood`) is in these code teams: `net http quic dgram fs streams undici web-server-frameworks web-standards wintercg`. The canonical list is `MY_TEAMS` in [scripts/lib.sh](scripts/lib.sh). Re-verify with:

```bash
gh api user/teams --paginate --jq '.[] | select(.organization.login=="nodejs") | .slug' | sort
```

The user is also in `collaborators`, `moderation`, and `package-maintenance`, which this skill ignores. The `undici` team's code is in `nodejs/undici`. Query that repo separately (`REPO=nodejs/undici`) if undici is in scope.

## Subsystem skip list

The user skips PRs whose substance is **inspector** or **diagnostics_channel**, even when the bot lists one of their teams (for example an `inspector,http:` PR that mentions `@nodejs/http`). They don't know those areas well enough to defend a review.

- Detect by title prefix (`inspector:`, `diagnostics_channel:`, or combined prefixes like `inspector,http:`) and by touched paths (`lib/internal/inspector/`, `src/inspector/`, diagnostics_channel plumbing).
- Mark these "likely skip" in the queue table and sort them last.

The user only posts findings they can verify and defend themselves. Prefer simple, directly demonstrable findings. If a finding needs a long chain of reasoning, present it as background context, not as a suggested review point.

## Session start

The local clone is `~/dev/nodejs/node`. Environment setup and building live in the `nodejs-contribute` skill (its *Repo baseline*, *One-time setup*, and *Building in the devcontainer* sections). Build and run in the devcontainer, not on the host. Follow that skill, then:

1. Run `git status`. If the tree is dirty, stop and ask whether to stash, commit, or keep going.
2. If on a branch other than `main`, say so and ask before switching.
3. Otherwise update `main`: `git fetch upstream main && git checkout main && git pull --ff-only upstream main`.
4. Run the `nodejs-contribute` skill's `scripts/devc.sh status`. If the image is over a week old, ask the user whether to `devc.sh pull` it (about 10 GB). Then start `devc.sh build` in the background before building the queue (with `QUIC=1` only when the session is QUIC work, as `nodejs-contribute` defines it), so the binary is ready when the user picks a PR to try. On an up-to-date tree it's a no-op.

## GitHub rate limits

Bursts of `gh` calls trip GitHub's **secondary rate limit** (HTTP 403 "You have exceeded a secondary rate limit"). It aborts calls mid-loop and leaves a partial result that looks complete.

- It isn't the hourly quota. `gh api rate_limit` shows `search` and `core` almost untouched, so don't diagnose it there or poll it waiting for a reset.
- `search/*` is the most sensitive endpoint, with a 30/minute primary cap as well. Keep every `gh` loop serial. Never fan calls out concurrently or across parallel agents.
- Once tripped, the cooldown lasts minutes, and calls during the cooldown extend it.
- Use `gh_retry` from [scripts/lib.sh](scripts/lib.sh) for any loop, with `sleep 10` between search calls. It backs off 1 to 5 minutes and retries the same call. The bundled scripts already do this.

If a session's first burst already tripped the limit, run the loop in the background so the waits don't block the chat.

## Procedure

Prefer the bundled tools over ad-hoc commands. Paths below are relative to the skill that owns the tool. This skill's tools are in its own `scripts/` directory. The others come from the `nodejs-contribute` skill, which must be installed alongside this one.

| Step | Tool | Skill |
|------|------|----------|
| 1: team-mention queue | `scripts/build-queue.sh` (background it) | this one |
| 1b: re-review lane | `scripts/rereview.py [--all]` | this one |
| 2: CI status | `scripts/ci-status.sh <pr>` | `nodejs-contribute` |
| 2: build and run | `scripts/devc.sh build` (background it), `scripts/devc.sh run <cmd>` | `nodejs-contribute` |
| 2: crash or fix repro | `scripts/repro.sh <pr> <test-path> [runs]` | `nodejs-contribute` |

`nodejs-contribute` is the source of truth for building, testing (including node-api addons), CI mechanics (`request-ci`, `ncu-ci`), and landing (`commit-queue`, squash vs. rebase, "closed = landed"). Reference it rather than restating it.

### 1. Build the queue

Run `scripts/build-queue.sh` in the background. It searches each team's mentions in open, non-draft PRs not authored by the user, then reads each candidate's bot comment and keeps only PRs whose checkbox list includes one of the user's teams. Each output line is `<number>\t<unchecked teams>\t<checked teams>`. Mentions by humans, with no matching bot checkbox, are dropped.

If it exits 1 with `INCOMPLETE:`, the queue is partial. Say which calls failed and offer to rerun.

Present the queue as a table: index, PR link, title, subsystem labels, the user's teams (unchecked vs. checked), author, size, and CI or branch status. Order PRs with an unchecked team first, then by most recently updated. Offer to reorder, filter to one subsystem, or jump to a PR.

High-volume teams such as `net` make a large union. Say how many PRs were found and whether the table is filtered or capped. Offer to narrow to one subsystem.

### 1b. Re-review lane

Run this every session alongside step 1. Don't build the queue by subtracting PRs the user already reviewed. A reviewed PR that changed since the review is often the highest-priority item: an author's fix to a changes-requested PR, or a PR that became land-ready.

`scripts/rereview.py` finds open PRs the user reviewed (`reviewed-by:`, which finds the user's own past reviews and isn't the prohibited assignment search). It compares the commit of the user's latest decisive review to the current head. It also catches PRs that dropped out of the step 1 search, so run both.

- 🔴 **RE-REVIEW-ASAP**: user requested changes and the head advanced, so the author pushed a fix. Surface these first, newest push first.
- 🟠 **RE-REVIEW**: user approved but the head advanced. The approval doesn't cover the new commits and may be stale.
- ✅ **CQ-CANDIDATE**: user approved the current head, approvals meet the bar (2, or 1 if open over 7 days), mergeable, no `commit-queue` label. Confirm CI is green on the current head with `nodejs-contribute`'s `scripts/ci-status.sh <pr>`, then recommend adding `commit-queue`. Approvals alone aren't enough.
- ⏸ **UNADDRESSED**: user requested changes and the head hasn't moved. Waiting on the author.
- · **CURRENT**: everything else. Collapsed unless `--all`.

GitHub computes `mergeable` lazily and often returns `UNKNOWN` on the first query. The script flags those rows. Re-query the PR before recommending `commit-queue`.

Rank by bucket, but present one PR's action at a time. A one-line count per bucket is fine ("3 re-review ASAP, 2 commit-queue ready"). Then surface the top action and wait.

### 2. Review one PR

```bash
gh pr view <n> --repo nodejs/node \
  --json title,body,author,baseRefName,reviewDecision,labels,mergeable,mergeStateStatus
gh pr diff <n> --repo nodejs/node
```

**CI status:** never conclude it from `gh pr checks`. GitHub's check list mixes stale nodes with the current Jenkins run and has caused a wrong "CI failing" call. Use `nodejs-contribute`'s `scripts/ci-status.sh <pr>`, which runs `ncu-ci` against the current head.

**Read the existing discussion first.** Node.js PRs are heavily commented, and collaborators, the author, and bots have often raised and resolved what you'd flag. Watch for CI bot comments, `@nodejs/tsc` or collaborator objections, semver-major concerns, and blocking change requests. Pull all three streams:

```bash
gh pr view <n> --repo nodejs/node --json reviews,comments \
  --jq '{reviews: [.reviews[]|{author:.author.login, state:.state, body:.body}], pr_comments: [.comments[]|{author:.author.login, body:.body}]}'
gh api --paginate "repos/nodejs/node/pulls/<n>/comments" \
  --jq '.[] | {author:.user.login, path:.path, line:.line, body:.body}'
```

Don't re-raise a point already made or resolved. Verify such claims, credit them, and move on. Note existing review states and blocking objections. Flag open threads in the user's subsystems so they can weigh in.

Surface process state with the code:

- **CI failing or pending:** name the failing job. `node-test-pull-request` is usually the gate, plus lint and `needs-ci`.
- **Out of date with base:** `mergeStateStatus: BEHIND`.
- **Conflicts:** `mergeable: CONFLICTING`.

**Read the PR's code, not just the diff or stale local `main`.** Run `git fetch upstream pull/<n>/head:pr-<n>`, then `git show pr-<n>:<path>`. This doesn't touch the working tree and gives PR-accurate line numbers. Delete the `pr-<n>` ref when done.

**For complex PRs (new APIs or events, tricky lifecycle), build and demonstrate claimed failure modes** such as crashes, wire corruption, or double emits. Don't only trace them. Use `nodejs-contribute`'s `scripts/repro.sh <pr> <test-path> [runs]` (`QUIC=1` for a QUIC PR), which builds `main` and the PR rebased onto `main` and runs each N times, or `devc.sh build` plus a manual scenario through `devc.sh run`. Report the observed output, including a repro that did not reproduce (that kills the finding).

Give a structured summary in chat:

- **What it does:** one short paragraph. Name the subsystems and which of the user's teams they fall under.
- **Assessment:** would approve, would request changes, or needs discussion, with confidence. Frame it as a read for the user to form their own view.
- **Findings:** tagged 🔴 blocker, 🟠 should fix, 🟡 nit, or 🟢 note, with `file:line` links. Weight correctness, behavior and ABI regressions, semver implications, and test coverage.
- **Missing classification labels:** always check. Flagging a missing label is a real review contribution.
  - `semver-major` (breaking change, including silent behavior becoming a throw), `semver-minor` (new public API), `notable-change` (CHANGELOG-worthy).
  - Backport labels for changes to APIs already in an LTS or Current line.
  - `fast-track` for doc-only or test-only PRs.
  - The bot applies subsystem labels (`net`, `http`, …), so don't flag those.
- **Recommended actions:** name the specific workflow label or next step for the PR's state. The user applies it.
  - **No CI run** (no `node-test-pull-request` job, `needs-ci` present, `ncu-ci` finds no run): recommend adding `request-ci`.
  - **Stale or out-of-date CI:** if `mergeable: MERGEABLE`, recommend adding `request-ci`. The CI job rebases onto `main` itself (`REBASE_ONTO`), so don't ask the author to rebase. Only if `mergeable: CONFLICTING`, or CI shows a rebase `BUILD_FAILURE`, recommend asking the author to rebase.
  - **At least 1 approval, a CI run, no outstanding comments:** recommend adding `author ready`, and removing it if that stops being true.
  - **Doc-only, test-only, or a clean regression fix:** recommend `fast-track`. It needs two 👍 on the bot's fast-track comment, plus approvals and green CI.
  - **All gates met (approvals, wait time, CI):** note it's land-ready via `commit-queue`. Ignore a `BLOCKED` merge button or "commits must have verified signatures". That's a GitHub ruleset gate Node.js doesn't use for landing, not a `commit-queue` gate.
  - **Abandoned or parked by the author:** use the [author association split](#c3-split-by-author-association).
- **Review outline (only if asked):** short notes the user writes their review from: the points to raise, each with its `file:line`, evidence, and any suggested code. No finished prose. Once the user writes their text, proofread it per their writing rules: fix mechanical and factual errors, and list anything else as a suggestion.

### Review policy quick reference

From `doc/contributing/collaborator-guide.md`. Full CI and landing mechanics are in `nodejs-contribute`.

- **Approvals:** two non-author collaborators, or one once the PR has been open over 7 days. Wait 48 hours (72 over a weekend).
- **`author ready`:** at least 1 approval, a CI run, and no outstanding comments.
- **`fast-track`:** doc-only, test-only, or a clean regression fix. Two 👍 on the bot comment, plus approvals and green CI.
- **CI action:** run `ci-status.sh <pr>`. No run, or stale on a `MERGEABLE` PR, means recommend `request-ci`. A real failure in the PR's subsystem is a finding. An unrelated flake or infra failure gets a note.

**Abandoned or stalled PRs** (`doc/contributing/pull-requests.md` "Abandoned or stalled pull requests", and the "Closing issues and pull requests" section of `collaborator-guide.md`):

- **Policy:** a PR inactive over 6 months should get the `stalled` label. That triggers `comment-labeled.yml`, which posts a 30-day warning, and `close-stalled.yml` closes it after 30 days if still inactive. Collaborators may also close anything not relevant to the project's future. Leave it open a few days for discussion if unclear. PRs can be reopened.
- **Measure inactivity by author activity, not `updatedAt`.** Collaborator comments, bot touches, and label changes bump `updatedAt`. Check the last commit and the last non-bot comment:
  ```bash
  gh pr view <n> --repo nodejs/node --json createdAt,commits --jq '{created:.createdAt[:10], lastCommit:.commits[-1].committedDate[:10]}'
  gh api --paginate repos/nodejs/node/issues/<n>/comments --jq '.[]|select(.user.login|test("bot")|not)|"\(.user.login) @ \(.created_at[:10])"' | tail -1
  ```
- **Two different automations:** `stale.yml` marks stale after 210 days of no activity and closes at 240. It keys off `updatedAt`, so any recent comment resets it. To move an author-abandoned PR along, use the manual `stalled` label.
- **Etiquette:** check whether the contributor intends to continue before taking over or closing. Unanswered collaborator change requests from months ago already satisfy that. If the fix has value, note that someone can take it over with author credit (preserve name and email, or use an `Author:` commit tag), minus unrelated changes.
- **Signs a PR is dead or low-effort:** author silent through several collaborator requests, unrelated changes bundled in, missing required tests, AI-generated boilerplate. Surface these. The user applies `stalled`.

### 3. Stop and wait

After the summary, stop. Advance only when the user says so ("next", a PR number, a subsystem filter). The user drives the pace and does all reviewing and posting on GitHub.

This applies to every lane: new reviews, re-review items, and workflow-label recommendations. When several PRs need the same action, surface the highest-priority one, give its action, and wait. A count is fine ("2 more commit-queue ready after this"), but don't list their actions until asked. Batched action tables make the user lose their place.

### 4. Track the session against GitHub

Keep a running ledger: for each PR, what you helped review and the disposition the user chose. The user submits every review, so read each disposition back from GitHub. Never assume it from the chat.

```bash
export ME=$(gh api user --jq .login)
for n in <queued PR numbers>; do
  echo "== $n =="
  gh api --paginate "repos/nodejs/node/pulls/$n/reviews" --jq '.[] | select(.user.login==env.ME) | "  \(.state) @ \(.submitted_at)"'
  gh pr view "$n" --repo nodejs/node --json state,reviewDecision --jq '"  pr: \(.state) / \(.reviewDecision // "none")"'
done
```

`gh api --jq` doesn't accept `--arg`. It errors silently and prints nothing, which looks like "no reviews". Use an exported env var through `env.ME`, as above.

At queue completion or on request ("what have I reviewed, what's left"), give a roll-up grouped by disposition. Flag any PR discussed in chat that has no review on record, so nothing the user meant to submit slips through. A disposition is a snapshot: the re-review lane reopens it next session if the head advanced, approvals changed, or CI went green.

## Cleanup sweep

A wider net for backlog cleanup: find open networking PRs that are abandoned or stalled, so the user can apply `stalled` or ping the author. Read-only.

### C1. Discover by subsystem label

Union open, non-draft PRs not authored by the user across the networking labels: `net http https http2 quic dgram tls dns stream`. `gh pr list --label` ANDs repeated labels, so loop per label and dedupe. Keep it serial and spaced:

```bash
source <this-skill-dir>/scripts/lib.sh
LIST=$(mktemp)
for L in net http https http2 quic dgram tls dns stream; do
  gh_retry gh pr list --repo "$REPO" --state open --label "$L" --limit 1000 \
    --json number,title,createdAt,author,isDraft,labels \
    --jq ".[] | select(.author.login != \"$ME\") | select(.isDraft==false) | [.number, .createdAt[:10], .author.login, ([.labels[].name]|join(\",\"))] | @tsv" \
    || echo "INCOMPLETE: label $L failed" >&2
  sleep 10
done | sort -u > "$LIST"
awk -F'\t' '!seen[$1]++' "$LIST" | wc -l
```

### C2. Rank by author staleness, never `updatedAt`

`updatedAt` is useless here. Mass bot or label sweeps (once bumping everything to `2026-04-28`) and routine comments keep it recent on PRs whose author left years ago. The `updated:<date>` search filter has the same flaw. Rank by `createdAt`, oldest first, and confirm with the last commit date:

```bash
for n in $(awk -F'\t' '!seen[$1]++{print $2"\t"$1}' "$LIST" | sort | head -30 | cut -f2); do
  gh_retry gh pr view "$n" --repo "$REPO" --json number,createdAt,commits,labels,mergeable \
    --jq '"\(.number) created:\(.createdAt[:10]) lastCommit:\(.commits[-1].committedDate[:10]) stalled:\(([.labels[].name]|index("stalled"))!=null) conflict:\(.mergeable=="CONFLICTING")"'
  gh_retry gh api "repos/$REPO/pulls/$n" --jq '"   assoc:\(.author_association)"'   # REST only; not a gh pr view field
  sleep 2
done
```

Stalled means the last commit is over 6 months old. Also capture: already labeled `stalled` (skip; automation owns it), `CONFLICTING`, and `author_association`.

### C3. Split by author association

This is the key judgment:

- **`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`:** external author, almost certainly gone. Age alone satisfies the "check whether they intend to continue" courtesy. A clean `stalled` target.
- **`MEMBER` or `COLLABORATOR`:** a core contributor who may have parked the work on purpose (a `semver-major` waiting for a release window, or a `review wanted` PR). Don't treat it as abandoned. Suggest a light "still pursuing this?" ping instead.

Present two tables: 🧹 clean `stalled` targets (oldest first) and 🤝 collaborator-parked (ping or leave). Never merge them.

### C4. State ledger across sessions

A sweep spans many sessions, so don't re-surface PRs the user already handled. Keep a JSON ledger outside the skill directory, at `${XDG_STATE_HOME:-$HOME/.local/state}/nodejs-review-queue/state.json`:

```json
{ "swept": { "63965": { "disposition": "stalled|pinged|kept|reviewed", "headSha": "<sha>", "at": "<iso>" } } }
```

On each sweep, load it and omit PRs that already have a disposition, unless the head SHA changed (the author pushed, so re-surface it as `🔁 REVIVED`). Dispositions are what the user reports doing. Reconcile against GitHub where possible, such as checking the `stalled` label is now present. Create the directory on first run.

### C5. Badges

Badges show priority regardless of position: `🔴 PATCH`, `🔁 REVIVED (+N)`, `⚠️ CI`, `⏳ <N>y stale`, `🤝 collaborator`, `🏷️ already-stalled`, `⚔️ CONFLICTING`.

### C6. Report scale

The full networking set is 100+ PRs. Say how many were found and how many you triaged this pass, and offer to continue in batches (for example the oldest 30 at a time). Log what was deferred.
