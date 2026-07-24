---
name: nodejs-review-queue
description: Review queue for nodejs/node PRs relevant to the user's subsystem teams. Node.js does not assign reviewers directly — the nodejs-github-bot posts a "Review requested:" comment @-mentioning the relevant @nodejs/<team>s and auto-applies subsystem labels from the "<subsystem>:" title prefix. This skill finds open PRs whose bot review-request mentions a team the user belongs to, then works through them one at a time in chat. It has two modes: a review queue (bot-requested PRs) and a cleanup sweep (wider net over networking-labeled PRs, ranked by author staleness, to triage abandoned/stalled PRs). READ-ONLY: it never posts to GitHub. Use when the user says "node review queue", "what node PRs should I review", wants to triage their nodejs/node review backlog, or wants to clean up stalled/abandoned networking PRs.
metadata:
  author: Ethan Arrowood
  tags: nodejs, github, code-review, pull-requests, networking, workflow
  version: 1.9.0
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - WebFetch
---
# Node.js Review Queue

Surface and triage open `nodejs/node` PRs that are relevant to the user, one at a time, in a single shared session. Built around how Node.js actually routes reviews — there are no direct reviewer assignments.

## Two modes

1. **Review queue** (default) — PRs where the `nodejs-github-bot` requested one of the user's teams. Deep, one-at-a-time review. This is the `## Procedure` below.
2. **Cleanup sweep** — a wider net over *all* open PRs carrying the user's networking subsystem labels, ranked by **author staleness**, to triage abandoned/stalled PRs. Batch-oriented. See `## Cleanup sweep (stale-triage mode)`.

Pick by intent: "what should I review" → mode 1; "help me clean up stalled networking PRs" / "clear the backlog" → mode 2. Both are **read-only** — the user applies every label / posts every comment themselves.

## Hard rules (do not violate)

1. **READ-ONLY. Never post anything to GitHub on the user's behalf — ever.** No reviews, no comments, no `gh pr review`, no approvals, no reactions. Not even with in-conversation approval. This skill *helps the user review*; the user does all posting themselves on GitHub. Output stays in chat.
2. **The user is never a direct reviewer.** Do not search `review-requested:`/`user-review-requested:` — Node.js doesn't assign individuals. Relevance comes from team mentions (below).

## How Node.js routes reviews (the mechanism)

The `nodejs-github-bot`:
- Posts a **`Review requested:`** comment listing each relevant team as a checkbox, e.g.
  ```
  Review requested:

  - [ ] @nodejs/http
  - [ ] @nodejs/http2
  - [ ] @nodejs/net
  ```
  An unchecked `- [ ]` means that team's review is still **outstanding**; `- [x]` means satisfied.
- Auto-applies **subsystem labels** derived from the `<subsystem>:` prefix in the PR title / commits (e.g. a `http2: …` title gets the `http2` label).

A PR is **relevant to the user** when that bot comment mentions a team the user is in. Note the mention set and the label set don't map 1:1 (a PR can mention `@nodejs/http` + `@nodejs/net` while carrying only an `http2` label), and the bot may mention teams the user is *not* in alongside ones they are — that's fine, it's still relevant via the matching team.

## The user's teams

The user (`Ethan-Arrowood`) belongs to these `nodejs` subsystem teams — this is the default tracked set:

```bash
MY_TEAMS=(net http quic dgram fs streams undici web-server-frameworks web-standards wintercg)
# Subsystem labels used as a secondary hint / pre-filter (not 1:1 with teams):
MY_LABELS=(net http https http2 quic dgram fs stream "web streams" web-standards fetch)
```

Re-verify membership anytime with:
```bash
gh api user/teams --paginate --jq '.[] | select(.organization.login=="nodejs") | .slug' | sort
```
(The user is also in non-code teams — `collaborators`, `moderation`, `package-maintenance` — excluded here.)

Most subsystems live in `nodejs/node`. The `undici` team's code is in `nodejs/undici`; query that repo separately if undici is in scope.

## Subsystem skip list

The user skips PRs whose substance is **inspector** or **diagnostics_channel**, even when the bot mentions one of their teams (e.g. an `inspector,http:` PR mentioning `@nodejs/http`). They don't know those areas well enough to defend a review.

- Detect by title prefix (`inspector:`, `diagnostics_channel:`, combined prefixes like `inspector,http:`) and by touched paths (`lib/internal/inspector/`, `src/inspector/`, diagnostics_channel plumbing).
- In the queue table, mark these **"likely skip"** and sort them last; don't lead with them in a "most value" shortlist.
- Related calibration: the user only posts findings they can personally verify and defend. Prefer simple, directly demonstrable findings over deep multi-step traces — if a finding needs a long chain of reasoning to explain, present it as background context rather than a suggested review comment.

## Session start (do this FIRST, every session)

Get the local repo to a clean, current, **built** baseline before building the queue — the user runs edge cases against a real binary. **Environment setup, ccache, and building all live in the `nodejs-contribute` skill** (its *Repo baseline*, *One-time setup*, and *Building* sections) — don't duplicate them here; follow that skill, then:

1. **Pull to clean latest `main`** (`git fetch upstream main && git checkout main && git pull --ff-only upstream main`; if the tree is dirty, stop and ask).
2. If the pull brought commits (or the tree was never built), **start `nodejs-contribute`'s `build-node.sh` in the background** *before* the queue search, so the binary is ready by the time the user picks a PR to try locally.

**One-time setup — permission allow-rules (so build/CI/read commands stop re-prompting).** A skill can't grant tool-approval trust — that's the harness permission layer. Add allow-rules once to the node repo's `.claude/settings.local.json` (already `.gitignore`d; **read-merge-don't-replace**; syntax `Bash(<prefix>:*)`). Cover the `scripts/` dirs of **both** skills plus the common read/build tools:
```json
{ "permissions": { "allow": [
  "Bash(/Users/ethan/.claude/skills/nodejs-review-queue/scripts/*)",
  "Bash(/Users/ethan/.claude/skills/nodejs-contribute/scripts/*)",
  "Bash(zsh /Users/ethan/.claude/skills/*)", "Bash(./.claude/tmp/*)",
  "Bash(ninja:*)", "Bash(ncu-ci:*)",
  "Bash(git fetch:*)", "Bash(git checkout:*)", "Bash(git pull:*)", "Bash(git log:*)",
  "Bash(git show:*)", "Bash(git rev-parse:*)", "Bash(git branch:*)", "Bash(git status:*)", "Bash(git diff:*)",
  "Bash(gh pr view:*)", "Bash(gh pr checks:*)", "Bash(gh pr diff:*)", "Bash(gh pr list:*)", "Bash(gh run view:*)", "Bash(gh api:*)",
  "Bash(python3:*)", "Bash(grep:*)", "Bash(awk:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(jq:*)", "Bash(wc:*)", "Bash(comm:*)", "Bash(head:*)", "Bash(tail:*)"
] } }
```
- Run build/queue work through the skills' `scripts/*` (one command each) — sidesteps two matcher limits: env-var-prefixed commands (`CC="ccache cc" … ./configure`) and compound pipelines (`gh api … | python3 …`, which need *every* sub-command allowed).
- Deliberately **NOT** allow-listed (still prompt — correct): `git commit/push/reset/rebase`, `gh pr review/comment` (this skill never posts), `rm`, `mv`.
- Picked up live if the settings file existed at session start; else `/hooks` once or restart.

## GitHub rate-limit discipline (applies to EVERY `gh` loop in this skill)

⚠️ **Space out bursts of `gh` calls — learned the hard way.** Firing this skill's multi-item loops (the 10-team queue search in step 1, the per-label cleanup sweep in C1) back-to-back with no delay trips GitHub's **secondary rate limit** (HTTP 403 "You have exceeded a secondary rate limit"). This aborts most calls mid-loop and leaves a **partial** result set that silently looks complete.

- This is **NOT** the primary hourly quota. `gh api rate_limit` will show `search` and `core` almost untouched — so don't diagnose it there, and **don't busy-poll `rate_limit` waiting for it to clear**: that endpoint's reset time is for the primary quota, not the secondary cooldown.
- The secondary limit is an anti-burst heuristic (too many requests too fast; `search/*` is the most sensitive — it also has a low 30/min primary cap). **Never fan these calls out concurrently or across parallel agents — keep them serial.**
- **Once tripped, the cooldown lasts *minutes*, not seconds** — and further calls during the cooldown extend it. A short (e.g. 45s) wait before resuming is not enough; that's why a naive retry keeps failing.
- **Therefore: every `gh` loop below must be serial, spaced (`sleep 10`), and self-healing.** Use a backoff helper so a 403 pauses and retries that one call instead of losing it:

```bash
# Serial + spaced + self-healing wrapper for any gh call that can hit the secondary limit.
gh_retry() {  # usage: gh_retry gh api ...   (any gh invocation)
  local attempt=0 err
  while :; do
    err=$("$@" 2>&1 >/tmp/gh_out.$$) && { cat /tmp/gh_out.$$; rm -f /tmp/gh_out.$$; return 0; }
    if printf '%s' "$err" | grep -qi 'secondary rate limit' && [ "$attempt" -lt 5 ]; then
      attempt=$((attempt+1)); sleep $((attempt*60)); continue   # back off 1,2,3,4,5 min
    fi
    printf '%s\n' "$err" >&2; rm -f /tmp/gh_out.$$; return 1
  done
}
```

If a whole session's first burst already tripped it, run the loop in the **background** (so the multi-minute waits don't block the chat) and pick up results when it finishes.

## Procedure

**Bundled tools — prefer these over ad-hoc commands.** This skill ships its *review-specific* `scripts/` (`build-queue.sh`, `rereview.py`); the *build/CI/repro* tools come from the **`nodejs-contribute`** skill (shared, one source of truth). Invoke by absolute path from each skill's base dir. The code blocks in the steps below are the *reference* for what each tool does — run the tool; drop to inline commands only when adapting.

| Step | Tool | Lives in |
|------|------|----------|
| 1 — team-mention queue | `build-queue.sh` (background it) | `nodejs-review-queue/scripts/` |
| 1b — re-review lane | `rereview.py [--all]` | `nodejs-review-queue/scripts/` |
| 2 — CI status | `ci-status.sh <pr>` | `nodejs-contribute/scripts/` |
| 2 — local build | `build-node.sh` (background it) | `nodejs-contribute/scripts/` |
| 2 — crash/fix repro | `repro.sh <pr> <test-path> [runs]` | `nodejs-contribute/scripts/` |

For local build, testing (incl. node-api addon builds), committing (DCO trailers), CI mechanics (`request-ci`/`ncu-ci`), and landing (`commit-queue`, squash-vs-rebase, "closed = landed"), **`nodejs-contribute` is the source of truth** — this skill references it rather than restating it.

### 1. Build the queue

Primary signal — for each tracked team, find open PRs whose comments mention it (the bot's review request), excluding the user's own PRs and drafts:

Serial, spaced, and self-healing (see **GitHub rate-limit discipline** above — `gh_retry` is defined there):

```bash
REPO=nodejs/node
ME=$(gh api user --jq .login)
for team in "${MY_TEAMS[@]}"; do
  gh_retry gh api -X GET search/issues \
    -f q="repo:$REPO is:pr is:open draft:false -author:$ME in:comments \"@nodejs/$team\"" \
    --jq '.items[].number'
  sleep 10   # REQUIRED spacing — search/* is the most secondary-limit-sensitive endpoint
done | grep -E '^[0-9]+$' | sort -un   # grep guards against stray non-numeric lines on error
```

Then **confirm relevance and read the checkbox state per candidate** — keep only PRs whose `nodejs-github-bot` `Review requested:` comment actually lists one of `MY_TEAMS`, and capture whether the user's teams are still unchecked (`- [ ]` = review outstanding, the queue's priority):

```bash
gh api "repos/$REPO/issues/<n>/comments" \
  --jq '.[] | select(.user.login=="nodejs-github-bot") | .body' \
  | grep -E '^\s*- \[( |x)\] @nodejs/'
```
Match `- \[( |x)\] @nodejs/(\S+)`; intersect the team slugs with `MY_TEAMS`. Drop PRs where the intersection is empty (incidental human @-mentions, not a real team request).

Present the queue as a table: index, PR link, title, subsystem **labels**, **your teams requested** (flag which are still `[ ]` outstanding vs `[x]` done), author, size, and CI/branch status (next step). **Default ordering:** PRs with an outstanding (`[ ]`) team checkbox first, then by most recently updated. Offer to reorder, filter to a single subsystem, or jump to a PR.

> ⚠️ **Always link PR/issue refs as full upstream URLs — never bare `#NNNN`.** In the local clone the git `origin` remote is the user's fork (`Ethan-Arrowood/node`); the terminal auto-links bare `#NNNN` against `origin`, producing wrong fork links. Write `[#64663](https://github.com/nodejs/node/pull/64663)` for *every* reference, including parentheticals like "(backport of #64265)" and "fixes #38426".

> Scale note: high-volume teams (e.g. `net` ~dozens of open PRs) make a big union. Say how many were found and that the list is filtered/capped, rather than silently truncating. Offer to narrow to one subsystem.

### 1b. The re-review lane — ALWAYS run this alongside step 1 (do NOT just filter reviewed PRs out)

**A PR the user already reviewed is not "done" — if it changed since their review it's often the *highest*-priority item.** Never build the queue by subtracting everything they've reviewed; that silently drops author-pushed fixes to `CHANGES_REQUESTED` PRs (the single most time-sensitive case) and PRs that became land-ready. Build this lane every session.

Find open PRs the user has actually reviewed (this uses `reviewed-by:` — *finding your own past reviews*, which is **allowed**; it is NOT the prohibited `review-requested:`/`user-review-requested:` reviewer-assignment search):

```bash
gh api -X GET search/issues \
  -f q="repo:$REPO is:pr is:open draft:false reviewed-by:$ME -author:$ME" \
  --jq '.items[].number' | sort -un
```
This also catches PRs that **dropped out of the step-1 team search** (observed: a re-approved PR was missing from the team-mention union but present here) — so the two lanes are complementary, run both.

For each, pull `headRefOid`, `mergeable`, `labels`, and **all reviews with their `commit.oid`** (GraphQL `reviews(first:50){nodes{author{login} state commit{oid} submittedAt}}`), take the user's *latest* review, and classify by comparing their reviewed commit to the current head:
- **🔴 RE-REVIEW ASAP** — user's latest is `CHANGES_REQUESTED` **and head advanced** past their reviewed commit ⇒ author pushed a fix; surface at the very top, sorted by how recent the new push is. (This is the case the user explicitly wants prompted the moment it happens.)
- **🟠 RE-REVIEW** — user `APPROVED` **but head advanced** since ⇒ new commits their approval doesn't cover; approval may be stale/auto-dismissed.
- **✅ commit-queue candidate** — user `APPROVED` **on the current head**, total approvals ≥2 (or 1 if open >7d), `mergeable: MERGEABLE`, no `commit-queue` label yet ⇒ recommend **verify CI green via `ncu-ci`, then add `commit-queue`**. New approvals / a freshly-green CI landing here is directly actionable — that's the whole point of the lane.
- **⏸ unaddressed** — user `CHANGES_REQUESTED`, head unchanged ⇒ still waiting on author, no action.
- **· current/waiting** — approved, current, progressing normally; collapse these.

Use the buckets to *rank* (🔴 first, then 🟠, then ✅), but **present one PR's action at a time and stop** — never dump a batched table across the buckets (see *§3 Stop and wait*). A one-line count per bucket as a preface is fine ("3 re-review-asap, 2 commit-queue-ready"); then surface the single top action and wait. ⚠️ **`mergeable` is computed lazily by GitHub and often returns `UNKNOWN`** on the first query — re-query the specific PR if you need a definitive answer before recommending `commit-queue`. Before recommending `commit-queue`, always confirm CI is genuinely green on the current head via `ci-status.sh <pr>` (`nodejs-contribute`) — approvals alone are not enough.

### 2. Review one PR

```bash
gh pr view <n> --repo "$REPO" \
  --json title,body,author,baseRefName,reviewDecision,labels,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks <n> --repo "$REPO"   # quick glance ONLY — do not conclude CI status from this (see below)
gh pr diff <n> --repo "$REPO"
```

**CI status: never conclude from `gh pr checks` — confirm via `ci-status.sh <pr>`** (`nodejs-contribute`; runs `ncu-ci`, verifies against the current head). GitHub's check list mixes stale nodes with the current Jenkins run and has caused a wrong "CI failing" call. Full CI mechanics (flake-vs-real classification, `request-ci`, auto-rebase) are in `nodejs-contribute`'s *CI on your PR* section.

**Read the existing discussion before reviewing — Node.js PRs are heavily commented and that context is essential.** Other collaborators, the author, and bots already raise/answer/resolve much of what you'd flag; on nodejs/node also watch for CI-result bot comments, `@nodejs/tsc` / collaborator objections, semver-major concerns, and blocking `Changes requested` reviews. Pull all three streams:

```bash
gh pr view <n> --repo "$REPO" --json reviews,comments \
  --jq '{reviews: [.reviews[]|{author:.author.login, state:.state, body:.body}], pr_comments: [.comments[]|{author:.author.login, body:.body}]}'
gh api "repos/$REPO/pulls/<n>/comments" \
  --jq '.[] | {author:.user.login, path:.path, line:.line, body:.body}'   # inline review comments
```

Factor it in: don't re-raise a point already made or resolved (verify claims, but credit them); note existing review states and any blocking objections; flag still-open threads relevant to your subsystem so the user can weigh in. If something's already been nailed, say so and move on. (Still read-only — surface and summarize; never post.)

Surface process state alongside the code (Node.js PRs gate on green CI and a clean rebase):
- **CI failing / pending** — name the failing job; Node CI (`node-test-pull-request`) is often the gate, plus lint/`needs-ci`.
- **Out of date with base** — `mergeStateStatus: BEHIND`.
- **Conflicts** — `mergeable: "CONFLICTING"`.

Read the touched subsystem source for context. **Inspect the PR's actual code, not just the diff or stale local `main`:** `git fetch upstream pull/<n>/head:pr-<n>` then `git show pr-<n>:<path>` (non-destructive, PR-accurate line numbers). PR refs live on `upstream`. Only checkout on a clean working tree, return to `main` when done, and clean up the `pr-<n>` ref.

**For complex PRs (new APIs/events, tricky lifecycle), build locally and *demonstrate* claimed failure modes (crashes, wire corruption, double emits) — don't just trace them.** Use `nodejs-contribute`'s **`repro.sh <pr> <test-path> [runs]`** (builds `main` vs the PR head, N runs each, auto-builds node-api addons) or `build-node.sh` + a manual scenario. Report observed output — including a repro that did **not** reproduce (that kills the finding). All build/rebuild rules (JS-only edits need no rebuild; C++ or a new builtin module → js2c rebuild), ccache, and baseline discipline (return to built `main` when done) live in **`nodejs-contribute`** — don't restate them.

Produce a structured summary in chat:
- **What it does** — one tight paragraph; note the subsystem(s) and which of your teams it falls under.
- **Assessment** — would-approve / would-request-changes / needs-discussion, with confidence — framed as *your* read, since you'll post it yourself.
- **Findings** — severity-tagged (🔴 blocker / 🟠 should-fix / 🟡 nit / 🟢 note) with `file:line` links. Node.js leans on correctness, no behavior/ABI regressions, semver implications, and test coverage — weight those.
- **Missing classification labels** — always check and surface these as findings; flagging a missing label is a legitimate review contribution:
  - `semver-major` (breaking change / behavior change from silent→throw), `semver-minor` (new public API), `notable-change` (CHANGELOG-worthy).
  - Backport labels for changes to APIs already shipped in an LTS/current line.
  - `fast-track` candidate for doc/test-only PRs.
  Subsystem labels (`net`, `http`, …) are auto-applied by the bot — do not flag those as missing.
- **Recommended actions (workflow labels & next steps)** — beyond *classification* labels, tell the user the concrete label/action that moves the PR forward, since applying it is a real (read-only-for-you) review contribution they can do in one click. Recommend by state — always **name the specific label**:
  - **CI hasn't run** (no `node-test-pull-request` Jenkins job; `needs-ci` present; `ncu-ci` finds no run) → recommend **add `request-ci`** to trigger a fresh CI run. This is the standard call whenever your `ncu-ci` check comes back "no run yet" — say it explicitly ("recommend: add `request-ci`"), don't just report that CI is absent.
  - **Stale red / out-of-date CI** → the fix depends on mergeability (CI auto-rebases via `REBASE_ONTO`; see `nodejs-contribute`): if **`mergeable: MERGEABLE`**, recommend **just add `request-ci`** — the CI job rebases onto `main` itself, so a manual author rebase is NOT needed. Only if **`mergeable: CONFLICTING`** (or CI shows a rebase `BUILD_FAILURE`) recommend **asking the author to rebase**, since the bot can't resolve conflicts. Never reflexively say "please rebase" on a mergeable PR.
  - **≥1 approval, a CI run exists, no outstanding comments** → recommend **add `author ready`** (remove it if that stops being true).
  - **doc/test-only or a clean regression fix** → recommend **`fast-track`** (needs two 👍 on the bot's fast-track comment; still needs approvals + green CI).
  - **All gates green (approvals + wait time + CI)** → note it's **land-ready** (`commit-queue`, or author may `git-node land`). (Ignore the GitHub merge-button showing `BLOCKED` / "commits must have verified signatures" — that's the merge-button/ruleset gate nodejs doesn't use for landing; commit-queue re-creates GitHub-signed commits. It is **not** a commit-queue gate, so don't check it or build tooling around it.)
  - **Author-abandoned / parked** → the `stalled`-vs-ping call from the cleanup-sweep etiquette fork (MEMBER/COLLABORATOR → ping; external + >6mo → `stalled`).
  You never apply these — surface the recommendation; the user clicks it on GitHub.
- **Draft review text (for the user to copy/paste)** — optional, only if asked. Provide it as a chat code block for the user to post manually. Do not post it.

### Landing & labels (reference for advising)

**The full landing + CI mechanics live in `nodejs-contribute`** (its *CI on your PR*, *Landing*, and *Semver & labels* sections): CI evaluation (`ci-status.sh`/`ncu-ci`, flake-vs-real, `test-internet`), `request-ci` (one-shot/consumed) + the `REBASE_ONTO` auto-rebase + the open question on re-runs, `commit-queue` + squash-vs-rebase, "closed = landed" (`mergedAt: null`), the `mergeStateStatus: BLOCKED`/signed-commit non-gate, and semver/experimental rules. Use `ci-status.sh <pr>` and point the user there; don't restate it here.

Review-advising quick recall (from `doc/contributing/collaborator-guide.md`):
- **Approvals:** two non-author collaborators; **one suffices once open >7 days.** 48h wait (72h weekend).
- **`author ready`:** ≥1 approval + a CI run + no outstanding comments. **`fast-track`:** doc/test-only or clean regression (two 👍 on the bot comment; still needs approvals + green CI).
- **Advising a CI action:** run `ci-status.sh <pr>` → NO-RUN, or stale on a `MERGEABLE` PR ⇒ recommend `request-ci` (CI self-rebases; only ask for a manual rebase when `CONFLICTING`); a real subsystem failure ⇒ that's a finding; unrelated flake/infra ⇒ note and move on.

**Abandoned / stalled PRs** (`doc/contributing/pull-requests.md` §Abandoned or stalled + `doc/contributing/collaborator-guide.md` §Closing):
- **Policy:** a PR inactive **>6 months** should get the **`stalled`** label. That triggers `comment-labeled.yml` → posts a 30-day-warning comment → `close-stalled.yml` auto-closes after 30 days if still inactive. Collaborators may also close anything "not relevant to the future of the project" (leave open a few days for discussion if unclear; PRs can always be reopened).
- **Measure inactivity by author activity, not `updatedAt`** — `updatedAt` is bumped by later collaborator comments, bot touches, and label changes, so a PR can look recently-active while the author has been silent for months. Check the last commit to the branch and the last author (non-bot, non-reviewer) comment:
  ```bash
  gh pr view <n> --repo nodejs/node --json createdAt,commits --jq '{created:.createdAt[:10], lastCommit:.commits[-1].committedDate[:10]}'
  gh api repos/nodejs/node/issues/<n>/comments --jq '[.[]|select(.user.login|test("bot")|not)]|last|"\(.user.login) @ \(.created_at[:10])"'
  ```
- **Two separate automations, don't confuse them:** `stale.yml` auto-marks stale after **210 days** of no activity and auto-closes at **240** — but it keys off `updatedAt`, so any recent comment resets its clock and it won't fire. To move an author-abandoned PR along, use the **manual `stalled` label** (the >6-month rule), don't wait for the 210-day bot.
- **Etiquette before flagging:** the guide says check whether the contributor intends to continue before taking over/closing. Unanswered collaborator change-requests from months ago already satisfy that courtesy. If the underlying fix has value, note that it can be taken over **with author credit** (preserve name/email or use an `Author:` commit tag) — minus any unrelated changes.
- **Signals a PR is dead/low-effort:** author silent past multiple collaborator requests, unrelated changes bundled in (e.g. a stray `_http_outgoing.js` edit in a Windows-module fix), no tests where required, AI-generated boilerplate. Surface these; the user applies `stalled` (this skill never posts).

### 3. Stop and wait

After the summary, **stop.** Advance only when the user says so ("next", a PR number, a subsystem filter). The user drives cadence — and does all the actual reviewing/posting on GitHub.

**ALWAYS one PR action at a time — never batch.** This is a hard cadence rule and applies to *every* lane: new reviews (step 2), re-review-lane items (step 1b), and workflow-label recommendations (`commit-queue`/`request-ci`/`author ready`). Even when several PRs are land-ready or need the same action, surface the single highest-priority one, give its concrete action, then wait. A brief count-preface is allowed ("2 more commit-queue-ready after this"), but do not enumerate their actions until asked. Batched action tables make the user lose their place.

### 4. Track the session, verify against GitHub

Keep a running ledger of the queue: for each PR, what you helped review and the disposition the user landed on. Since this skill never posts, the user submits every review themselves on GitHub — so the ledger's disposition **must** be read back from GitHub, never assumed from the chat. Reconcile each PR against the user's actual submitted review state.

> A disposition is **never final** — it's a snapshot. The **re-review lane (1b)** is how you re-open it next session: any reviewed PR whose head advanced, gained approvals, or went CI-green is pulled back into the actionable queue. Run 1b every session so nothing the user reviewed silently stalls or silently becomes land-ready.

Reconcile each PR against the user's actual submitted review state:

```bash
REPO=nodejs/node
export ME=$(gh api user --jq .login)
for n in <queued PR numbers>; do
  echo "== #$n =="
  gh api "repos/$REPO/pulls/$n/reviews" --jq '.[] | select(.user.login==env.ME) | "  \(.state) @ \(.submitted_at)"'
  gh pr view "$n" --repo "$REPO" --json state,reviewDecision --jq '"  pr: \(.state) / \(.reviewDecision // "—")"'
done
```

> ⚠️ **gh jq gotcha:** `gh api --jq` does not accept `--arg`; it silently errors and returns nothing (looks like "none"). Use an exported env var via `env.ME` inside the query, as above.

Present a roll-up grouped by disposition at queue completion or on request ("what have I reviewed / what's left"), and flag any PR you discussed in chat that has **no review on record** yet — so nothing the user meant to submit slips through.

---

## Cleanup sweep (stale-triage mode)

A wider net for backlog cleanup: find open networking PRs that are abandoned/stalled and surface them so the user can apply `stalled` (or ping). Read-only — the skill never labels or comments.

### C1. Discover by subsystem label (not review-request)

Union open, non-draft, not-authored-by-user PRs across the networking labels. `gh pr list --label` is AND across repeats, so loop per label and dedupe:

Serial, spaced, and self-healing (see **GitHub rate-limit discipline** above — `gh_retry`; keep this loop serial, never concurrent):

```bash
REPO=nodejs/node; ME=$(gh api user --jq .login); : > /tmp/net-prs.txt
for L in net http https http2 quic dgram tls dns stream; do
  gh_retry gh pr list --repo "$REPO" --state open --label "$L" --limit 100 \
    --json number,title,createdAt,author,isDraft,labels \
    --jq ".[] | select(.author.login != \"$ME\") | select(.isDraft==false) | [.number, .createdAt[:10], .author.login, ([.labels[].name]|join(\",\"))] | @tsv"
  sleep 10   # REQUIRED spacing — see rate-limit discipline
done | sort -u > /tmp/net-prs.txt
awk -F'\t' '!seen[$1]++' /tmp/net-prs.txt | wc -l   # unique count
```

### C2. Rank by AUTHOR staleness — never `updatedAt`

⚠️ **`updatedAt` is worthless for staleness here.** A mass bot/label sweep (observed: everything bumped to a single date like `2026-04-28`) and routine collaborator/bot comments keep `updatedAt` recent on PRs whose author vanished years ago. **The GitHub `updated:<date>` search filter has the same flaw — don't use it.** Rank by `createdAt` (oldest first) and confirm staleness with the **last commit date** (`.commits[-1].committedDate`), which reflects real author engagement:

```bash
for n in $(awk -F'\t' '!seen[$1]++{print $2"\t"$1}' /tmp/net-prs.txt | sort | head -30 | cut -f2); do
  gh pr view "$n" --repo "$REPO" --json number,createdAt,commits,labels,mergeable \
    --jq '"#\(.number) created:\(.createdAt[:10]) lastCommit:\(.commits[-1].committedDate[:10]) stalled:\(([.labels[].name]|index("stalled"))!=null) conflict:\(.mergeable=="CONFLICTING")"'
  gh api "repos/$REPO/pulls/$n" --jq '"   assoc:\(.author_association)"'   # authorAssociation is REST-only, NOT a gh pr view field
done
```

Stalled = last commit >6 months ago. Also capture: already-`stalled`-labeled (skip — automation owns it), `CONFLICTING`, and `author_association`.

### C3. Split by author association — the etiquette fork

This is the key triage judgment:
- **`CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR` / `NONE`** → external author, almost certainly abandoned. Age alone satisfies the "check if they intend to continue" courtesy. **Clean `stalled` target.**
- **`MEMBER` / `COLLABORATOR`** → a core collaborator who may have *parked* the work intentionally (e.g. a `semver-major` awaiting a window, or a `review wanted` PR). **Do not treat as abandoned** — surface separately and suggest a light "still pursuing this?" ping, not an auto-`stalled`.

Present two tables: 🧹 clean stalled targets (oldest first, with the `stalled`-label recommendation) and 🤝 collaborator-parked (ping/leave). Never fold them together.

### C4. State ledger — track triage across sessions

A sweep spans many sessions; don't re-surface PRs the user already handled. Maintain `~/.claude/nodejs-review-queue/state.json` (outside the skill repo — it's personal runtime state, not skill content):

```json
{ "swept": { "63965": { "disposition": "stalled|pinged|kept|reviewed", "headSha": "<sha>", "at": "<iso>" } } }
```

On each sweep, load it and **omit** PRs already dispositioned — unless the head sha changed (author pushed → revived, re-surface as `🔁 REVIVED`). Dispositions are the user's reported action; since the skill never posts, reconcile against GitHub where possible (is the `stalled` label actually present now?). Create the dir on first run: `mkdir -p ~/.claude/nodejs-review-queue`.

### C5. Badges (shared with review mode)

Encode priority as badges so it reads regardless of position: `🔴 PATCH`, `🔁 REVIVED (+N)`, `⚠️ CI`, `⏳ <N>y stale`, `🤝 collaborator`, `🏷️ already-stalled`, `⚔️ CONFLICTING`.

### C6. Scale honestly

The full networking set is large (100+ PRs). Don't silently cap — say how many were found, how many you triaged this pass, and offer to continue the sweep in batches (e.g. oldest 30 at a time). Log what was deferred.
