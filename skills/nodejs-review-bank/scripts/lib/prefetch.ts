import { type RunResult } from "./util.ts";

import { ARCHIVE, BANK_METADATA, CACHE, CLONE, DOSSIER, ENV, LOCKS, METADATA_TIMEOUT, NAME, NC, OWNER, REPO, RQ } from "./config.ts";
import { OSError, P, RuntimeError, TimeoutExpired, WS, cut, dict, dumps, exists, isOSError, iso, mtime, now, pct, pget, py, pyInt, pyStr, splitWs, splitlines, strip, truthy } from "./py.ts";
import { die, git, isDir, print, readText, removeTree, run, writeAtomic, writeText } from "./util.ts";

import fs from "node:fs";
import { type Entry, entryPath, finish, load, newEntry, save } from "./entry.ts";
import { gh, graphql } from "./github.ts";
import { entryLock, unlock, zshFlock } from "./lock.ts";
import { type Candidate, rankedCandidates } from "./queue.ts";
import { screen, screenBody, screenLine } from "./screen.ts";

// Finish the entry for a PR prefetch won't prepare, creating one if
// needed. Its updated_at comes from GitHub, so skipReason prefers it over
// an older cached candidate.
export function refused(n: string, info: any, disp: string): void {
  using lock = entryLock(n).enter();
  const e: Entry = load(n) ?? newEntry(n, {
    url: `https://github.com/${REPO}/pull/${n}`, lane: "fresh",
    head: info.headRefOid || "-", created_at: iso(now()), disposition: "-",
  });
  e.title = info.title || e.title || "-";
  e.author = pget(info.author || {}, "login") || e.author || "-";
  e.pr_head = info.headRefOid || e.pr_head || "-";
  e.updated_at = info.updatedAt || iso(now());
  finish(e, disp);
}

// Everything a preparing agent needs, so it never calls gh itself. The
// new dossier and ref replace the old ones only after the fetched head
// matches GitHub's, so a failed prefetch leaves an earlier one intact.
export function prefetch(n0: string): void {
  const n = String(pyInt(n0));
  const pr = gh("pr", "view", n, "--repo", REPO, "--json",
    "number,title,body,author,baseRefName,headRefOid,reviewDecision,labels,mergeable," +
    "mergeStateStatus,files,commits,createdAt,updatedAt,isDraft,state");
  const info = JSON.parse(pr);
  if (pget(info, "state") !== "OPEN" || pget(info, "isDraft")) {
    // The cached candidate can be up to REFRESH_MINUTES old, and longer
    // while the refresh is dormant. Record what GitHub said, so plan
    // stops offering the PR until the cache catches up.
    const disp = pget(info, "state") === "OPEN" ? "draft" : pget(info, "state", "?").toLowerCase();
    refused(n, info, disp);
    die(`${n} is ${disp === "draft" ? "a draft" : disp}; not preparing it`, 4);
  }

  fetchUpstream();
  const tmpRef = `refs/review-bank/tmp/${n}-${process.pid}`;
  git(["fetch", "-q", "--no-write-fetch-head", "upstream", `+pull/${n}/head:${tmpRef}`]);
  const head = strip(git(["rev-parse", tmpRef]));
  if (head !== info.headRefOid) {
    git(["update-ref", "-d", tmpRef], { check: false });
    die(`${n}: fetched ${head.slice(0, 12)} but GitHub says head is ${info.headRefOid.slice(0, 12)}; rerun`);
  }

  const old = load(n);
  const cand: Partial<Candidate> = new Map(rankedCandidates().map((c) => [c.pr, c] as const)).get(n) ?? {};
  const lane = cand.lane || (old || {}).lane || "fresh";
  const rf = cand.rereview_from || pget(old || {}, "rereview_from");
  if (rf && rf !== "-" && run(["git", "-C", CLONE, "cat-file", "-e", `${rf}^{commit}`],
    { stdout: "inherit", stderr: "ignore" }).status !== 0) {
    // A force-push can leave the reviewed commit unreachable from the PR.
    git(["fetch", "-q", "--no-write-fetch-head", "upstream", rf], { check: false });
  }

  const newDir = fs.mkdtempSync(P(DOSSIER, `.${n}.`));
  try {
    swapIn(n, newDir, tmpRef, pr, info, head, lane, rf, cand);
  } finally {
    removeTree(newDir);
    git(["update-ref", "-d", tmpRef], { check: false });
  }
}

export function swapIn(n: string, newDir: string, tmpRef: string, pr: string, info: any, head: string, lane: string,
  rf: string | null, cand: Partial<Candidate>): void {
  writeText(P(newDir, "pr.json"), pr);
  writeText(P(newDir, "diff.patch"), gh("pr", "diff", n, "--repo", REPO));
  const disc = discussion(n);
  writeText(P(newDir, "discussion.json"), disc);
  let sc = screen(info, JSON.parse(disc));
  if (sc.result !== "pass" && (pget(load(n) || {}, "note") || "").includes("author responded")) {
    // Woken from a screen hold by the author: the user asked for this review.
    sc = { ...sc, result: "pass", why: `the author responded after the screen hold (${sc.result} before)` };
  }
  writeText(P(newDir, "screen.json"), dumps(sc, 1));
  const screened = sc.result !== "pass";
  let ci: RunResult | null = null, gates: string | null = null;
  if (!screened) {
    // A screened PR gets no review, so skip the CI and gates calls.
    ci = run([P(NC, "ci-status.sh"), n], { env: ENV, stderr: "stdout" });
    writeText(P(newDir, "ci.txt"), `${ci.stdout}(ci-status.sh exit ${ci.status}, ${iso(now())})\n`);
    gates = writeGates(n, newDir, info, head, tmpRef);
  }
  writeText(P(newDir, "release-lines.txt"), activeLines());
  if (!screened && (BANK_METADATA === "all" || (BANK_METADATA === "cq" && lane === "cq"))) {
    // After the gh calls: git node metadata calls GitHub and Jenkins itself.
    writeText(P(newDir, "metadata.txt"), ncuMetadata(n));
  }
  if (lane === "screen" && !screened) lane = "fresh";
  writeText(P(newDir, "meta.json"), dumps({
    pr: n, head, ref: `refs/review-bank/${n}`, lane,
    rereview_from: rf ?? null, clone: CLONE, fetched_at: iso(now()),
  }, 1));
  // The diff, discussion, and CI were read after the fetch. A push in
  // between would mix two heads in one dossier.
  const nowHead = strip(gh("pr", "view", n, "--repo", REPO, "--json", "headRefOid", "--jq", ".headRefOid"));
  if (nowHead !== head) die(`${n}: head moved to ${nowHead.slice(0, 12)} while fetching; rerun`);

  // Order: dossier into place, entry saved, then the ref, then the old
  // dossier removed. A failure part way leaves the old dossier beside the
  // new one, never a ref or entry that points at a missing dossier.
  const d = P(DOSSIER, n);
  {
    using lock = entryLock(n).enter();
    const gone = P(DOSSIER, `.${n}.old-${process.pid}`);
    if (exists(d)) fs.renameSync(d, gone);
    fs.renameSync(newDir, d);
    let e = load(n);
    if (e && ["done", "stale", "waiting"].includes(e.state) && strip(e.body ?? "")) {
      // Keep the earlier review for reference; the new one starts clean.
      writeText(P(ARCHIVE, `${n}-${pget(e, "head", "-").slice(0, 12)}.md`), readText(entryPath(n)));
    }
    if (!e || ["done", "stale", "waiting"].includes(e.state)) {
      e = newEntry(n, { created_at: iso(now()), disposition: "-", my_teams: e?.my_teams ?? "-" });
    }
    Object.assign(e!, {
      url: `https://github.com/${REPO}/pull/${n}`, title: info.title,
      author: pget(info.author || {}, "login") || "ghost", state: "preparing",
      head, pr_head: head, updated_at: info.updatedAt, lease: iso(now()), lane,
      my_teams: cand.my_teams || e!.my_teams, rereview_from: rf,
      screen: screenLine(sc),
    });
    if (screened) {
      // No preparing agent: the screen entry is ready for the user as is.
      Object.assign(e!, {
        state: "ready", lane: "screen", lease: "-", body: screenBody(n, info, sc),
        prepared_at: iso(now()), needs_run: "0", note: `screen ${screenLine(sc)}`,
      });
    }
    save(e!);
    git(["update-ref", `refs/review-bank/${n}`, tmpRef]);
    removeTree(gone);
  }
  if (screened) {
    print(`${n}: dossier ${d}\n  ref refs/review-bank/${n} = ${head.slice(0, 12)}, lane screen, state ready`);
    print(`  screen ${screenLine(sc)}: ${sc.why}. No preparing agent; present it to the user.`);
    return;
  }
  print(`${n}: dossier ${d}\n  ref refs/review-bank/${n} = ${head.slice(0, 12)}, lane ${lane}, state preparing`);
  print(`  screen ${screenLine(sc)}`);
  print(strip(ci!.stdout) ? "  " + splitlines(strip(ci!.stdout))[0] : "  ci: no output");
  print(`  gates: ${gates}`);
}

// nodejs-review-queue's discussion.sh --json: comments, reviews, and
// inline threads, without hidden or blocked-user content.
export function discussion(n: string): string {
  const p = run(["zsh", P(RQ, "discussion.sh"), "--json", n], { env: ENV });
  if (p.status !== 0) throw new RuntimeError(`discussion.sh ${n}: ${cut(strip(p.stderr), -300)}`);
  const d = JSON.parse(p.stdout);
  d.fetched_at = iso(now());
  d.rules = "excluded items are not credited and don't count as already raised; " +
    "status resolved-context means hidden as outdated, duplicate, or resolved";
  return dumps(d, 1);
}

export const PASSING = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
export const GATES_QUERY = `query{repository(owner:"%s",name:"%s"){pullRequest(number:%s){
 reviewDecision
 commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){totalCount nodes{__typename
  ...on CheckRun{name status conclusion detailsUrl checkSuite{workflowRun{workflow{name}}}}
  ...on StatusContext{context state targetUrl}}}}}}}
 timelineItems(last:100,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_COMMIT]){totalCount nodes{__typename
  ...on HeadRefForcePushedEvent{createdAt actor{login} beforeCommit{oid} afterCommit{oid}}
  ...on PullRequestCommit{commit{oid committedDate messageHeadline checkSuites(first:1){nodes{createdAt}}}}}}
 reviewRequests(first:50){nodes{requestedReviewer{__typename ...on Team{slug} ...on User{login}}}}
 latestOpinionatedReviews(first:100){nodes{author{login} state submittedAt commit{oid} onBehalfOf(first:20){nodes{slug}}}}
}}}`;

export function nodes(d: any, key: string): any[] {
  return ((d || {})[key] || {}).nodes || [];
}

// gates.json (check runs and statuses on the head, reviews, code owners)
// and timeline.json (pushes) from one GraphQL query and the clone's
// CODEOWNERS. A failed query is recorded in both files and doesn't stop the
// prefetch. Returns a one-line summary.
export function writeGates(n: string, newDir: string, info: any, head: string, ref: string): string {
  const at = iso(now());
  let pr: any, err: string | null = null;
  try {
    pr = graphql<any>(pct(GATES_QUERY, OWNER, NAME, n)).pullRequest;
    if (!truthy(pr)) throw new RuntimeError("pull request not found");
  } catch (e) {
    if (!(e instanceof RuntimeError)) throw e;
    [pr, err] = [{}, e.message];
  }

  const commit = (nodes(pr, "commits")[0] ?? {}).commit || {};
  const roll = commit.statusCheckRollup || {};
  const runs: any[] = [];
  for (const c of nodes(roll, "contexts")) {
    if (c.__typename === "CheckRun") {
      const wf = pget(((c.checkSuite || {}).workflowRun || {}).workflow || {}, "name");
      runs.push({ name: pget(c, "name"), workflow: wf, result: c.conclusion || pget(c, "status"), url: pget(c, "detailsUrl") });
    } else { // a commit status, such as Jenkins
      runs.push({ name: pget(c, "context"), workflow: null, result: pget(c, "state"), url: pget(c, "targetUrl") });
    }
  }
  const total = pget(roll.contexts || {}, "totalCount", 0);
  const counts: Record<string, number> = dict();
  for (const r of runs) counts[String(r.result)] = (counts[String(r.result)] ?? 0) + 1;
  const notPassing = runs.filter((r) => !PASSING.has(r.result));

  const reviews = nodes(pr, "latestOpinionatedReviews").map((r) => ({
    author: pget(r.author || {}, "login") || "ghost", state: pget(r, "state"),
    commit: pget(r.commit || {}, "oid"), at: pget(r, "submittedAt"),
    on_behalf_of: nodes(r, "onBehalfOf").map((t) => `@${OWNER}/${t.slug}`),
  }));
  const requested: string[] = [];
  for (const r of nodes(pr, "reviewRequests")) {
    const who = r.requestedReviewer || {};
    requested.push(who.slug ? `@${OWNER}/${who.slug}` : `@${py(pget(who, "login"))}`);
  }

  const co = codeOwners(info.baseRefName || "main", ref, head, (info.files || []).map((f: any) => f.path));
  for (const [o, v] of Object.entries<any>(pget(co, "owners", {}))) {
    v.status = err ? "unknown: the query failed" : ownerStatus(o, reviews, requested);
  }

  const gates = {
    head, fetched_at: at, error: err, reviewDecision: pget(pr, "reviewDecision"),
    checks: {
      commit: pget(commit, "oid"), state: pget(roll, "state"), total,
      truncated: total > runs.length, counts, not_passing: notPassing,
      all: runs.map((r) => ({ name: r.name, workflow: r.workflow, result: r.result })),
    },
    reviews, review_requests: requested, codeowners: co,
  };
  writeText(P(newDir, "gates.json"), dumps(gates, 1));

  const events: any[] = [];
  for (const t of nodes(pr, "timelineItems")) {
    if (t.__typename === "HeadRefForcePushedEvent") {
      events.push({
        type: "force-push", at: pget(t, "createdAt"),
        actor: pget(t.actor || {}, "login"),
        before: pget(t.beforeCommit || {}, "oid"),
        after: pget(t.afterCommit || {}, "oid"),
      });
    } else if (t.__typename === "PullRequestCommit") {
      const c = t.commit || {};
      const suites = nodes(c, "checkSuites");
      events.push({
        type: "commit", oid: pget(c, "oid"), headline: pget(c, "messageHeadline"),
        committed_at: pget(c, "committedDate"),
        first_check_at: suites.length ? pget(suites[0], "createdAt") : null,
      });
    }
  }
  const forced = events.filter((e) => e.type === "force-push" && e.after === head);
  const first = events.filter((e) => e.type === "commit" && e.oid === head && e.first_check_at).map((e) => e.first_check_at);
  const pushed = forced.length ? { at: forced.at(-1).at, source: "force-push event" }
    : first.length ? { at: first[0], source: "first check suite on the head (approximate)" }
    : { at: null, source: "unknown" };
  const ttotal = pget(pr.timelineItems || {}, "totalCount", 0);
  writeText(P(newDir, "timeline.json"), dumps({
    head, fetched_at: at, error: err, head_pushed_at: pushed,
    note: "GitHub no longer reports commit push times. first_check_at is when the first check suite " +
      "for a commit was created, close to when it was pushed as the PR head; null means it was " +
      "pushed under a later commit or got no checks. committed_at is the committer date, which a " +
      "rebase resets. Events are oldest first, the last 100 only.",
    total: ttotal, truncated: ttotal > events.length, events,
  }, 1));

  if (err) return `query FAILED (${cut(err, 0, 120)}); see gates.json`;
  const unapproved = Object.entries<any>(pget(co, "owners", {})).filter(([, v]) => !v.status.startsWith("approved")).map(([o]) => o);
  return `reviewDecision ${pr.reviewDecision || "-"}, checks ${roll.state || "-"} ` +
    `(${notPassing.length} not passing), code owners without an approval: ${unapproved.join(" ") || "none"}`;
}

// Whether a code owner has reviewed. A team counts only through a review
// made on its behalf, which GitHub records when the team was requested.
export function ownerStatus(owner: string, reviews: any[], requested: string[]): string {
  const mine = reviews.filter((r) => r.on_behalf_of.includes(owner) || owner === `@${r.author}`);
  const ok = mine.filter((r) => r.state === "APPROVED").map((r) => r.author);
  if (ok.length) return `approved by ${ok.join(", ")}`;
  if (mine.length) return `${mine[0].state.toLowerCase()} by ${mine[0].author}`;
  if (requested.includes(owner)) return "requested, no review on its behalf yet";
  return "not requested, no review on its behalf (a member may have reviewed without the request)";
}

// The owners of each changed path, from .github/CODEOWNERS on the base
// branch (the one GitHub applies), else at the PR head. The last matching
// line wins, as on GitHub.
export function codeOwners(base: string, ref: string, head: string, paths: string[]): any {
  let text = "", label = "";
  for (const [src, lbl] of [[`refs/remotes/upstream/${base}`, `upstream/${base}`], [ref, `PR head ${head.slice(0, 12)}`]]) {
    text = git(["show", `${src}:.github/CODEOWNERS`], { check: false });
    label = lbl;
    if (text) break;
  }
  if (!text) return { source: null, error: "no .github/CODEOWNERS on the base branch or at the PR head" };
  const rules: [RegExp, string[]][] = [];
  for (const line of splitlines(text)) {
    const parts = splitWs(line.split("#", 1)[0]);
    if (parts.length) rules.push([codeownersRe(parts[0]), parts.slice(1)]);
  }
  const owners: Record<string, { paths: string[]; status?: string }> = dict(), unowned: string[] = [];
  for (const p of paths) {
    const hit = [...rules].reverse().find(([rx]) => rx.test(p))?.[1] ?? null;
    if (hit === null) unowned.push(p);
    for (const o of hit || []) (owners[o] ??= { paths: [] }).paths.push(p);
  }
  return {
    source: `${label}:.github/CODEOWNERS`, owners, unowned_paths: unowned,
    files_maybe_truncated: paths.length >= 100,
    note: "pattern matching approximates GitHub's; check a surprising owner against the file",
  };
}

// A CODEOWNERS pattern as a regex over repository paths. A leading or
// inner / anchors it to the root, * stays within a directory, ** crosses
// them, and a pattern ending in * matches only files directly under it (as
// GitHub documents). A match on a directory covers everything below it.
export function codeownersRe(pat: string): RegExp {
  const anchored = pat.replace(/\/+$/, "").includes("/");
  const p = pat.replace(/^\/+|\/+$/g, "");
  let out = "";
  for (let i = 0; i < p.length; ) {
    if (p.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (p.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else {
      out += ({ "*": "[^/]*", "?": "[^/]" } as Record<string, string>)[p[i]] ?? p[i].replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
      i += 1;
    }
  }
  // Python's fullmatch: anchored at both ends.
  return new RegExp(`^(?:${anchored ? "" : "(?:.*/)?"}${out}${p.endsWith("*") ? "" : "(?:/.*)?"})$`);
}

// git node metadata (node-core-utils), read-only: approvals by name, the
// last Jenkins CI, failed GitHub Actions jobs, and the generated commit
// metadata. It calls GitHub with its own token, not gh, so it holds the gh
// shim's lock to stay serial with every gh call. The shim locks with
// zsystem flock, an fcntl lock, the same kind every lock here takes.
// Never raises: a failure is written to the file.
export function ncuMetadata(n: string): string {
  const lock = P(process.env.GH_SHIM_LOCK || P(LOCKS, "gh.lock"));
  const held = zshFlock(lock, true);
  if (!held) throw new OSError(`could not lock ${lock}`);
  let out: string, err: string, status: string;
  try {
    try {
      const p = run(["git", "node", "metadata", n, "--owner", OWNER, "--repo", NAME],
        { cwd: isDir(CLONE) ? CLONE : undefined, env: ENV, timeout: METADATA_TIMEOUT });
      [out, err, status] = [p.stdout, p.stderr, p.timedOut ? `timed out after ${METADATA_TIMEOUT}s` : `exit ${p.status}`];
    } catch (e) {
      if (e instanceof TimeoutExpired) [out, err, status] = [e.stdout, e.stderr, `timed out after ${METADATA_TIMEOUT}s`];
      else if (isOSError(e)) [out, err, status] = ["", pyStr(e), "could not run"];
      else throw e;
    }
    writeText(`${lock}.last`, `${(performance.timeOrigin + performance.now()) / 1000}\n`); // the shim's GH_MIN_GAP
  } finally {
    unlock(held);
  }
  // The report goes to stderr and the generated metadata to stdout, which
  // the report already repeats.
  let text = strip(out) && err.includes(strip(out)) ? err : err + out;
  text = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = splitlines(text).filter((l) => !new RegExp(`^[${WS}]*[\\u2800-\\u28ff]`).test(l)); // spinner frames
  return lines.join("\n") + `\n(git node metadata ${status}, ${iso(now())})\n`;
}

// main and the staging branches, at most every 30 minutes.
export function fetchUpstream(): void {
  const stamp = P(CACHE, "fetch.stamp");
  if (exists(stamp) && Date.now() / 1000 - mtime(stamp) < 1800) return;
  git(["fetch", "-q", "--no-write-fetch-head", "upstream", "+refs/heads/main:refs/remotes/upstream/main",
    "+refs/heads/v*-staging:refs/remotes/upstream/v*-staging"]);
  writeText(stamp, iso(now()));
}

// Active release lines (nodejs-contribute, Release-line labels), cached a day.
export function activeLines(): string {
  const p = P(CACHE, "release-lines.txt");
  if (exists(p) && Date.now() / 1000 - mtime(p) < 86400) return readText(p);
  const sched = JSON.parse(Buffer.from(
    gh("api", "repos/nodejs/Release/contents/schedule.json", "--jq", ".content"), "base64").toString("utf8"));
  const today = iso(now()).slice(0, 10);
  const lines = Object.entries<any>(sched).filter(([, v]) => pget(v, "start", "9") <= today && today <= pget(v, "end", "0")).map(([k]) => k);
  writeAtomic(p, `active release lines on ${today}: ${lines.join(" ")}\n`);
  return readText(p);
}
