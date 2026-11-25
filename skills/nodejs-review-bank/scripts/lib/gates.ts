// The dossier's gates.json and timeline.json: checks, reviews, code owners,
// and when the head was pushed.
import path from "node:path";
import { NAME, OWNER } from "./config.ts";
import { graphql } from "./github.ts";
import { CommandError, clip, git, iso, lines, now, writeText } from "./util.ts";

const PASSING = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

function gatesQuery(pr: string): string {
  return `query{repository(owner:"${OWNER}",name:"${NAME}"){pullRequest(number:${pr}){
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
}

type Nodes<T> = { nodes?: T[] | null; totalCount?: number } | null;
type Login = { login?: string } | null;
type Oid = { oid?: string } | null;

// The gates query's pullRequest. Fields can be null, and all are missing
// when the query failed.
type GatesPr = {
  reviewDecision?: string | null;
  commits?: Nodes<{ commit?: { oid?: string; statusCheckRollup?: Rollup | null } | null }>;
  timelineItems?: Nodes<TimelineItem>;
  reviewRequests?: Nodes<{ requestedReviewer?: { slug?: string; login?: string } | null }>;
  latestOpinionatedReviews?: Nodes<ReviewNode>;
};
type Rollup = { state?: string | null; contexts?: Nodes<CheckContext> };
type CheckContext = {
  __typename: string;
  name?: string; status?: string; conclusion?: string | null; detailsUrl?: string;
  checkSuite?: { workflowRun?: { workflow?: { name?: string } | null } | null } | null;
  context?: string; state?: string; targetUrl?: string | null;
};
type TimelineItem = {
  __typename: string;
  createdAt?: string; actor?: Login; beforeCommit?: Oid; afterCommit?: Oid;
  commit?: { oid?: string; committedDate?: string; messageHeadline?: string; checkSuites?: Nodes<{ createdAt?: string }> } | null;
};
type ReviewNode = {
  author?: Login; state?: string; submittedAt?: string; commit?: Oid; onBehalfOf?: Nodes<{ slug: string }>;
};

type Review = { author: string; state: string | null; commit: string | null; at: string | null; on_behalf_of: string[] };
type CheckRun = { name: string | null; workflow: string | null; result: string | null; url: string | null };
type TimelineEvent =
  | { type: "force-push"; at: string | null; actor: string | null; before: string | null; after: string | null }
  | { type: "commit"; oid: string | null; headline: string | null; committed_at: string | null; first_check_at: string | null };

type Owner = { paths: string[]; status?: string };
type CodeOwners = {
  source: string | null;
  error?: string;
  owners?: Record<string, Owner>;
  unowned_paths?: string[];
  files_maybe_truncated?: boolean;
  note?: string;
};

function nodesOf<T>(conn: Nodes<T> | undefined): T[] {
  return conn?.nodes ?? [];
}

// gates.json (check runs and statuses on the head, reviews, code owners)
// and timeline.json (pushes) from one GraphQL query and the clone's
// CODEOWNERS. A failed query is recorded in both files and doesn't stop the
// prefetch. Returns a one-line summary.
export function writeGates(pr: string, dir: string, base: string, files: string[], head: string, ref: string): string {
  const at = iso(now());
  let q: GatesPr = {}, err: string | null = null;
  try {
    const found = graphql<{ pullRequest?: GatesPr | null } | null>(gatesQuery(pr))?.pullRequest;
    if (!found || Object.keys(found).length === 0) throw new CommandError("pull request not found");
    q = found;
  } catch (e) {
    if (!(e instanceof CommandError)) throw e;
    err = e.message;
  }

  const commit = nodesOf(q.commits)[0]?.commit ?? {};
  const roll = commit.statusCheckRollup ?? {};
  const runs: CheckRun[] = nodesOf(roll.contexts).map((c) => c.__typename === "CheckRun"
    ? {
      name: c.name ?? null, workflow: c.checkSuite?.workflowRun?.workflow?.name ?? null,
      result: c.conclusion || (c.status ?? null), url: c.detailsUrl ?? null,
    }
    // A commit status, such as Jenkins.
    : { name: c.context ?? null, workflow: null, result: c.state ?? null, url: c.targetUrl ?? null });
  const total = roll.contexts?.totalCount ?? 0;
  const counts: Record<string, number> = {};
  for (const r of runs) counts[String(r.result)] = (counts[String(r.result)] ?? 0) + 1;
  const notPassing = runs.filter((r) => !PASSING.has(r.result ?? ""));

  const reviews: Review[] = nodesOf(q.latestOpinionatedReviews).map((r) => ({
    author: r.author?.login || "ghost", state: r.state ?? null, commit: r.commit?.oid ?? null, at: r.submittedAt ?? null,
    on_behalf_of: nodesOf(r.onBehalfOf).map((t) => `@${OWNER}/${t.slug}`),
  }));
  const requested = nodesOf(q.reviewRequests).map(({ requestedReviewer: who }) =>
    who?.slug ? `@${OWNER}/${who.slug}` : `@${who?.login ?? "unknown"}`);

  const co = codeOwners(base, ref, head, files);
  for (const [owner, v] of Object.entries(co.owners ?? {})) {
    v.status = err ? "unknown: the query failed" : ownerStatus(owner, reviews, requested);
  }

  writeText(path.join(dir, "gates.json"), JSON.stringify({
    head, fetched_at: at, error: err, reviewDecision: q.reviewDecision ?? null,
    checks: {
      commit: commit.oid ?? null, state: roll.state ?? null, total, truncated: total > runs.length, counts,
      not_passing: notPassing, all: runs.map((r) => ({ name: r.name, workflow: r.workflow, result: r.result })),
    },
    reviews, review_requests: requested, codeowners: co,
  }, null, 1));

  const events: TimelineEvent[] = [];
  for (const t of nodesOf(q.timelineItems)) {
    if (t.__typename === "HeadRefForcePushedEvent") {
      events.push({
        type: "force-push", at: t.createdAt ?? null, actor: t.actor?.login ?? null,
        before: t.beforeCommit?.oid ?? null, after: t.afterCommit?.oid ?? null,
      });
    } else if (t.__typename === "PullRequestCommit") {
      const c = t.commit ?? {};
      const suites = nodesOf(c.checkSuites);
      events.push({
        type: "commit", oid: c.oid ?? null, headline: c.messageHeadline ?? null, committed_at: c.committedDate ?? null,
        first_check_at: suites.length ? suites[0].createdAt ?? null : null,
      });
    }
  }
  const forced = events.flatMap((e) => (e.type === "force-push" && e.after === head ? [e] : []));
  const firstCheck = events.flatMap((e) => (e.type === "commit" && e.oid === head && e.first_check_at ? [e.first_check_at] : []));
  const pushed = forced.length ? { at: forced.at(-1)!.at, source: "force-push event" }
    : firstCheck.length ? { at: firstCheck[0], source: "first check suite on the head (approximate)" }
    : { at: null, source: "unknown" };
  const timelineTotal = q.timelineItems?.totalCount ?? 0;
  writeText(path.join(dir, "timeline.json"), JSON.stringify({
    head, fetched_at: at, error: err, head_pushed_at: pushed,
    note: "GitHub no longer reports commit push times. first_check_at is when the first check suite " +
      "for a commit was created, close to when it was pushed as the PR head; null means it was " +
      "pushed under a later commit or got no checks. committed_at is the committer date, which a " +
      "rebase resets. Events are oldest first, the last 100 only.",
    total: timelineTotal, truncated: timelineTotal > events.length, events,
  }, null, 1));

  if (err) return `query FAILED (${clip(err, 120)}); see gates.json`;
  const unapproved = Object.entries(co.owners ?? {}).filter(([, v]) => !v.status!.startsWith("approved")).map(([o]) => o);
  return `reviewDecision ${q.reviewDecision || "-"}, checks ${roll.state || "-"} ` +
    `(${notPassing.length} not passing), code owners without an approval: ${unapproved.join(" ") || "none"}`;
}

// Whether a code owner has reviewed. A team counts only through a review
// made on its behalf, which GitHub records when the team was requested.
function ownerStatus(owner: string, reviews: Review[], requested: string[]): string {
  const mine = reviews.filter((r) => r.on_behalf_of.includes(owner) || owner === `@${r.author}`);
  const ok = mine.filter((r) => r.state === "APPROVED").map((r) => r.author);
  if (ok.length) return `approved by ${ok.join(", ")}`;
  if (mine.length) return `${String(mine[0].state).toLowerCase()} by ${mine[0].author}`;
  if (requested.includes(owner)) return "requested, no review on its behalf yet";
  return "not requested, no review on its behalf (a member may have reviewed without the request)";
}

// The owners of each changed path, from .github/CODEOWNERS on the base
// branch (the one GitHub applies), else at the PR head. The last matching
// line wins, as on GitHub.
function codeOwners(base: string, ref: string, head: string, paths: string[]): CodeOwners {
  let text = "", label = "";
  for (const [src, lbl] of [[`refs/remotes/upstream/${base}`, `upstream/${base}`], [ref, `PR head ${head.slice(0, 12)}`]]) {
    text = git(["show", `${src}:.github/CODEOWNERS`], { check: false });
    label = lbl;
    if (text) break;
  }
  if (!text) return { source: null, error: "no .github/CODEOWNERS on the base branch or at the PR head" };
  const rules: [RegExp, string[]][] = [];
  for (const line of lines(text)) {
    const [pattern, ...owners] = line.split("#", 1)[0].split(/\s+/).filter(Boolean);
    if (pattern) rules.push([codeownersRe(pattern), owners]);
  }
  const owners = new Map<string, Owner>(), unowned: string[] = [];
  for (const p of paths) {
    const hit = rules.findLast(([re]) => re.test(p));
    if (!hit) unowned.push(p);
    for (const o of hit?.[1] ?? []) {
      if (!owners.has(o)) owners.set(o, { paths: [] });
      owners.get(o)!.paths.push(p);
    }
  }
  return {
    source: `${label}:.github/CODEOWNERS`, owners: Object.fromEntries(owners), unowned_paths: unowned,
    files_maybe_truncated: paths.length >= 100,
    note: "pattern matching approximates GitHub's; check a surprising owner against the file",
  };
}

// A CODEOWNERS pattern as a regex over repository paths. A leading or
// inner / anchors it to the root, * stays within a directory, ** crosses
// them, and a pattern ending in * matches only files directly under it (as
// GitHub documents). A match on a directory covers everything below it.
function codeownersRe(pattern: string): RegExp {
  const anchored = pattern.replace(/\/+$/, "").includes("/");
  const p = pattern.replace(/^\/+|\/+$/g, "");
  let out = "";
  for (let i = 0; i < p.length; ) {
    if (p.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (p.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else {
      out += p[i] === "*" ? "[^/]*" : p[i] === "?" ? "[^/]" : p[i].replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^(?:${anchored ? "" : "(?:.*/)?"}${out}${p.endsWith("*") ? "" : "(?:/.*)?"})$`);
}
