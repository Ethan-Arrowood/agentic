---
name: nodejs-review-queue
description: Review queue for nodejs/node PRs relevant to the user's subsystem teams. Node.js does not assign reviewers directly — the nodejs-github-bot posts a "Review requested:" comment @-mentioning the relevant @nodejs/<team>s and auto-applies subsystem labels from the "<subsystem>:" title prefix. This skill finds open PRs whose bot review-request mentions a team the user belongs to, then works through them one at a time in chat. It has two modes: a review queue (bot-requested PRs) and a cleanup sweep (wider net over networking-labeled PRs, ranked by author staleness, to triage abandoned/stalled PRs). READ-ONLY: it never posts to GitHub. Use when the user says "node review queue", "what node PRs should I review", wants to triage their nodejs/node review backlog, or wants to clean up stalled/abandoned networking PRs.
metadata:
  author: Ethan Arrowood
  tags: nodejs, github, code-review, pull-requests, networking, workflow
  version: 1.8.0
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

## Procedure

### 1. Build the queue

Primary signal — for each tracked team, find open PRs whose comments mention it (the bot's review request), excluding the user's own PRs and drafts:

```bash
REPO=nodejs/node
ME=$(gh api user --jq .login)
for team in "${MY_TEAMS[@]}"; do
  gh api -X GET search/issues \
    -f q="repo:$REPO is:pr is:open draft:false -author:$ME in:comments \"@nodejs/$team\"" \
    --jq '.items[].number'
done | sort -un
```

Then **confirm relevance and read the checkbox state per candidate** — keep only PRs whose `nodejs-github-bot` `Review requested:` comment actually lists one of `MY_TEAMS`, and capture whether the user's teams are still unchecked (`- [ ]` = review outstanding, the queue's priority):

```bash
gh api "repos/$REPO/issues/<n>/comments" \
  --jq '.[] | select(.user.login=="nodejs-github-bot") | .body' \
  | grep -E '^\s*- \[( |x)\] @nodejs/'
```
Match `- \[( |x)\] @nodejs/(\S+)`; intersect the team slugs with `MY_TEAMS`. Drop PRs where the intersection is empty (incidental human @-mentions, not a real team request).

Present the queue as a table: index, PR link, title, subsystem **labels**, **your teams requested** (flag which are still `[ ]` outstanding vs `[x]` done), author, size, and CI/branch status (next step). **Default ordering:** PRs with an outstanding (`[ ]`) team checkbox first, then by most recently updated. Offer to reorder, filter to a single subsystem, or jump to a PR.

> Scale note: high-volume teams (e.g. `net` ~dozens of open PRs) make a big union. Say how many were found and that the list is filtered/capped, rather than silently truncating. Offer to narrow to one subsystem.

### 2. Review one PR

```bash
gh pr view <n> --repo "$REPO" \
  --json title,body,author,baseRefName,reviewDecision,labels,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks <n> --repo "$REPO"
gh pr diff <n> --repo "$REPO"
```

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

Read the touched subsystem source for context. **Inspect the PR's actual code, not just the diff or stale local `main`:** `git fetch upstream pull/<n>/head:pr-<n>` then `git show pr-<n>:<path>` (non-destructive, PR-accurate line numbers). Note: `origin` is the user's fork; PR refs live on `upstream` (nodejs/node). Only checkout on a clean working tree, return to the original branch when done, and clean up the `pr-<n>` ref afterward.

**For complex feature PRs (new APIs/events, tricky lifecycle semantics), checkout + build locally and run scenarios — this is standard practice, not an extra.** The user wants to try edge cases against the real binary, and claimed failure modes (crashes, wire corruption, double emits) should be demonstrated, not just traced. Setup:

```bash
git checkout pr-<n>
./configure --ninja --node-builtin-modules-path "$(pwd)"   # documented in doc/contributing/building-node-with-ninja.md
ninja -C out/Release node    # run in background; slow only the first time
```

`--node-builtin-modules-path` makes the binary load `lib/*.js` from disk, so after one initial build, **PRs that only edit existing `lib/*.js` files need no rebuild** — checkout and run `out/Release/node` directly. A rebuild IS required for: any C++ change, AND any PR that **adds or removes a builtin module file** (e.g. a new `lib/net/promises.js`) — the builtin *manifest* is generated by `js2c` and compiled into the binary, so a new module won't be `require`-able until you rebuild, even though its JS is on disk. Symptom: `Cannot find module` / the module missing from `require('node:module').builtinModules`. Write runnable repro scripts for each claimed failure mode to `$PWD/.claude/tmp/pr-<n>/` so the user can execute them personally, and report observed output (or honestly report a repro that did NOT reproduce — that kills the finding).

**Baseline discipline:** the repo's resting state is **latest `main`** — not the user's feature branches. When finished with a PR (review posted or skipped), return to `main` and `git pull upstream main`. After any pull that brings in commits, **re-run `./configure --ninja --node-builtin-modules-path "$(pwd)"` before `ninja`** — a pull can add/remove source files or change gyp gating (e.g. the OpenSSL/BoringSSL backend split), and an incremental `ninja` against a stale build graph fails with confusing errors like undeclared `ENGINE_*` symbols. Reconfigure regenerates the graph; then `ninja -C out/Release node`. Run long builds in the background with output streamed directly (never piped through `tail` — it buffers and hides all progress).

Produce a structured summary in chat:
- **What it does** — one tight paragraph; note the subsystem(s) and which of your teams it falls under.
- **Assessment** — would-approve / would-request-changes / needs-discussion, with confidence — framed as *your* read, since you'll post it yourself.
- **Findings** — severity-tagged (🔴 blocker / 🟠 should-fix / 🟡 nit / 🟢 note) with `file:line` links. Node.js leans on correctness, no behavior/ABI regressions, semver implications, and test coverage — weight those.
- **Missing labels** — always check and surface these as findings; flagging a missing label is a legitimate review contribution:
  - `semver-major` (breaking change / behavior change from silent→throw), `semver-minor` (new public API), `notable-change` (CHANGELOG-worthy).
  - Backport labels for changes to APIs already shipped in an LTS/current line.
  - `fast-track` candidate for doc/test-only PRs.
  Subsystem labels (`net`, `http`, …) are auto-applied by the bot — do not flag those as missing.
- **Draft review text (for the user to copy/paste)** — optional, only if asked. Provide it as a chat code block for the user to post manually. Do not post it.

### Landing & labels (reference for advising)

Grounded in `doc/contributing/collaborator-guide.md` — verify against that file, it's authoritative:

- **Approvals:** two non-author collaborator approvals normally; **one is enough once the PR has been open >7 days.**
- **Wait time:** allow 48h for collaborator input before landing (72h over a weekend). `fast-track` label shortens this for doc/test-only or regression fixes — needs two upvotes on the bot's fast-track comment, still needs the normal approvals + green CI.
- **`author ready` label:** apply when a PR has ≥1 approval, a CI run, and no outstanding comments (signals ready-pending-wait-time). Remove when no longer true.
- **Landing:** `commit-queue` label for automated landing, or `git-node land` manually. Authors may land their own PRs once gates pass.

**CI flake vs. real failure — how to tell and what to do:**
- First check whether the failing run is **stale** (compare the failing run's `head_sha` and `created_at` against the PR's current head and last-commit date — a red run from weeks ago on an unchanged head is stale, not "consistently flaky").
- Check whether failures are **in the PR's own subsystem** or in unrelated infra (crypto/build/`test-internet` failures on a pure-JS net PR ⇒ almost certainly infra/transient, not the diff). Use `gh run view --job <id> --log-failed` to inspect.
- Remedies: GitHub Actions → "Re-run all jobs"; Jenkins → "Resume Build" on `node-test-pull-request` (not `node-test-commit`); **>7 days elapsed → press "Retry" for a fresh run** (Windows/ARM binaries are only kept 7 days); after new commits → add `request-ci` to trigger a fresh `node-test-pull-request`.
- A long-open PR with a single stale red run usually just needs: **rebase onto latest `main` + `request-ci`**, not a flake fight.

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

### 4. Track the session, verify against GitHub

Keep a running ledger of the queue: for each PR, what you helped review and the disposition the user landed on. Since this skill never posts, the user submits every review themselves on GitHub — so the ledger's disposition **must** be read back from GitHub, never assumed from the chat. Reconcile each PR against the user's actual submitted review state:

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

```bash
REPO=nodejs/node; ME=$(gh api user --jq .login); : > /tmp/net-prs.txt
for L in net http https http2 quic dgram tls dns stream; do
  gh pr list --repo "$REPO" --state open --label "$L" --limit 100 \
    --json number,title,createdAt,author,isDraft,labels \
    --jq ".[] | select(.author.login != \"$ME\") | select(.isDraft==false) | [.number, .createdAt[:10], .author.login, ([.labels[].name]|join(\",\"))] | @tsv" 2>/dev/null
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
