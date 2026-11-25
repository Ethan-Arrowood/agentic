// sync: read open entries back from GitHub. Records the user's actions,
// prunes landed, closed, and draft PRs, wakes holds, and marks stale reviews.
import { LEASE_MINUTES, NAME, OWNER } from "./config.ts";
import { type Entry, LANE_OF_BUCKET, entries, finish, load, save } from "./entry.ts";
import { graphql, me } from "./github.ts";
import { type WaitFor, describeWait, hold, screenConditions, wake, wakeConditions } from "./holds.ts";
import { entryLock } from "./lock.ts";
import { ciAt, landingAt, readCi } from "./queue.ts";
import { closeBody } from "./screen.ts";
import { MINUTE, iso, now, parseIso, readTsv } from "./util.ts";

type Login = { login: string } | null;

// One PR as the sync query returns it.
type SyncNode = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  createdAt?: string;
  updatedAt: string;
  closedAt: string | null;
  headRefOid: string;
  author: Login;
  labels: { nodes: { name: string }[] };
  allReviews?: { nodes: { author: Login; submittedAt: string | null }[] };
  reviews: { nodes: { state: string; submittedAt: string | null; commit: { oid: string } | null }[] };
  comments: { nodes: { author: Login; createdAt: string; body: string | null }[] };
  timelineItems: { nodes: { __typename: string; createdAt: string; actor: Login; label: { name: string } }[] };
};

// `reviews` are mine only.
function syncFields(login: string): string {
  return "number title state isDraft createdAt updatedAt closedAt headRefOid author{login} " +
    "labels(first:50){nodes{name}} " +
    "allReviews: reviews(last:50){nodes{author{login} submittedAt}} " +
    `reviews(last:30,author:"${login}"){nodes{state submittedAt commit{oid}}} ` +
    "comments(last:30){nodes{author{__typename login} createdAt body}} " +
    "timelineItems(last:50,itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){nodes{__typename " +
    "...on LabeledEvent{createdAt actor{login} label{name}} " +
    "...on UnlabeledEvent{createdAt actor{login} label{name}}}}";
}

// nodejs lands with commit-queue or git node land, so a landed PR shows as
// closed with a "Landed in <sha>" comment.
const LANDED = /^\s*Landed in ([0-9a-f]{7,40})/m;

// Sync the open entries, or only those in `only`. Returns report lines.
export function sync(only: Set<string> | null = null): string[] {
  const heads = new Map(entries().filter((e) => e.state !== "done" && (!only || only.has(e.pr))).map((e) => [e.pr, e.head]));
  const prs = [...heads.keys()];
  if (!prs.length) return ["sync: no open entries"];
  const rereview = new Map(readTsv("rereview.tsv").map((r) => [r[1], r]));
  const data = new Map<string, SyncNode>();
  for (let i = 0; i < prs.length; i += 20) {
    const fields = prs.slice(i, i + 20).map((n) => `p${n}: pullRequest(number:${n}){${syncFields(me())}}`).join(" ");
    const repo = graphql<Record<string, SyncNode | null>>(`query{repository(owner:"${OWNER}",name:"${NAME}"){${fields}}}`);
    for (const d of Object.values(repo)) if (d) data.set(String(d.number), d);
  }
  const log: string[] = [];
  for (const n of prs) {
    // Re-read under the entry's lock: a put, present, or set may have
    // changed it while the query above waited on GitHub.
    using lock = entryLock(n).enter();
    const e = load(n);
    if (!e || e.state === "done") continue;
    if (e.head !== heads.get(n)) {
      // Re-prefetched while the query ran: the snapshot predates it.
      log.push(`  ${n}: re-prepared during sync, skipped until the next one`);
      continue;
    }
    log.push(...syncEntry(e, data.get(n) ?? null, rereview));
  }
  return log.length ? log : ["sync: no changes"];
}

function syncEntry(e: Entry, d: SyncNode | null, rereview: Map<string, string[]>): string[] {
  const n = e.pr;
  if (!d) {
    finish(e, "not-found");
    return [`  ${n}: not found on GitHub (deleted?)`];
  }
  Object.assign(e, { title: d.title, updated_at: d.updatedAt, pr_head: d.headRefOid });
  const author = d.author?.login ?? null;
  if (author === me()) {
    finish(e, "mine");
    return [`  ${n}: authored by me, dropped`];
  }
  if (d.state === "MERGED" || d.state === "CLOSED") {
    const landed = d.comments.nodes.flatMap((c) => LANDED.exec(c.body || "")?.[1] ?? []);
    const disp = landed.length ? `landed ${landed.at(-1)}` : d.state.toLowerCase();
    finish(e, disp, d.closedAt);
    return [`  ${n}: ${disp}`];
  }
  if (d.isDraft) {
    finish(e, "draft");
    return [`  ${n}: converted to draft`];
  }
  if (e.state === "waiting") {
    // My own actions don't wake a hold; it waits on others and on time.
    const why = wakeReasons(e, d);
    if (why.length && wakeConditions(e).screen !== undefined && !why.some((w) => w.startsWith("author responded"))) {
      // The author didn't respond in time: back to the user, with a
      // recommendation to close it, not into a lane for a review.
      Object.assign(e, {
        state: "ready", lane: "screen", body: closeBody(e), prepared_at: iso(now()),
        note: "screen: no author response; recommend closing per the moderation policy",
      });
      save(e);
      return [`  ${n}: ${e.note}`];
    }
    if (why.length) {
      wake(e, why);
      return [`  ${n}: ${e.note}`];
    }
    save(e);
    return [];
  }
  let since = parseIso(e.created_at) ?? now();
  if (e.lane === "screen") {
    // A close recommendation reuses the entry: only actions after it count.
    since = Math.max(since, parseIso(e.prepared_at) ?? since);
  }
  const acted = myActions(d, since);
  if (acted && e.lane === "screen" && !acted.disposition.startsWith("approved") &&
    !acted.disposition.startsWith("changes-requested")) {
    // The user handled a screened PR (a comment asking for the policy):
    // wait for the author. A review means they chose to review it after all.
    Object.assign(e, { disposition: acted.disposition, disposition_at: acted.at });
    hold(e, screenConditions(e, author, d.headRefOid, acted.at), acted.at, "screen: waiting for the author");
    return [`  ${n}: ${acted.disposition}, waiting ${describeWait(e)}`];
  }
  if (acted) {
    const { disposition, at, reviewed } = acted;
    e.acted_head = reviewed || e.head;
    // An approval at the head leaves nothing to do until the PR can land.
    const gates = disposition.startsWith("approved") && reviewed === d.headRefOid ? landingGates(d, n) : {};
    if (Object.keys(gates).length) {
      Object.assign(e, { disposition, disposition_at: at });
      hold(e, { reviews: "1", push: reviewed!.slice(0, 12), ...gates }, at, "approved; waiting until it can land");
      return [`  ${n}: ${disposition}, waiting ${describeWait(e)}`];
    }
    finish(e, disposition, at);
    return [`  ${n}: ${disposition}`];
  }
  // Exact label: commit-queue-squash, -rebase, and -failed don't enqueue.
  if (e.lane === "cq" && d.labels.nodes.some((l) => l.name === "commit-queue")) {
    finish(e, "cq-labeled");
    return [`  ${n}: commit-queue added by someone else`];
  }
  // The lane changes only for an entry still open. A finished entry keeps
  // the lane it was prepared in, which plan compares with the candidate's.
  const lane = LANE_OF_BUCKET.get(rereview.get(n)?.[0] ?? "");
  if (lane) e.lane = lane;
  const log: string[] = [];
  if (["ready", "needs-run", "presented"].includes(e.state) && e.head !== d.headRefOid) {
    e.note = `head moved from ${e.head.slice(0, 12)} while ${e.state}`;
    e.state = "stale";
    log.push(`  ${n}: stale, ${e.note}`);
  } else if (e.state === "preparing" && now() - (parseIso(e.lease) ?? now()) > LEASE_MINUTES * MINUTE) {
    e.state = "stale";
    e.note = "preparation abandoned (lease expired)";
    log.push(`  ${n}: ${e.note}`);
  }
  save(e);
  return log;
}

// My reviews, label changes, and comments after `since`: one disposition
// string, the time of the latest, and the commit of my latest review (or null).
function myActions(d: SyncNode, since: number): { disposition: string; at: string; reviewed: string | null } | null {
  const acts: { at: number; what: string }[] = [];
  let reviewed: string | null = null;
  for (const r of d.reviews.nodes) {
    const t = parseIso(r.submittedAt);
    if (t !== null && t > since) {
      const oid = r.commit?.oid ?? null;
      reviewed = oid || reviewed;
      acts.push({ at: t, what: `${r.state.toLowerCase().replaceAll("_", "-")} @${(oid || "?").slice(0, 12)}` });
    }
  }
  for (const ev of d.timelineItems.nodes) {
    const t = parseIso(ev.createdAt);
    if (ev.actor?.login === me() && t !== null && t > since) {
      acts.push({ at: t, what: `${ev.__typename === "LabeledEvent" ? "labeled" : "unlabeled"} ${ev.label.name}` });
    }
  }
  for (const c of d.comments.nodes) {
    const t = parseIso(c.createdAt);
    if (c.author?.login === me() && t !== null && t > since) acts.push({ at: t, what: "commented" });
  }
  if (!acts.length) return null;
  acts.sort((a, b) => a.at - b.at || (a.what < b.what ? -1 : a.what > b.what ? 1 : 0));
  // Lead with the review, if any: "approved @<sha>; labeled request-ci".
  const isReview = (a: { what: string }) => a.what.includes(" @");
  const order = [...acts.filter(isReview), ...acts.filter((a) => !isReview(a))];
  return { disposition: [...new Set(order.map((a) => a.what))].join("; "), at: iso(acts.at(-1)!.at), reviewed };
}

// The landing gates still closed at the PR's head, as wake conditions:
// the landing wait, and green CI from the cq CI cache.
function landingGates(d: SyncNode, pr: string): WaitFor {
  const gates: WaitFor = {};
  const at = landingAt(d.createdAt, d.labels.nodes.map((l) => l.name));
  if (at !== null && at > now()) gates.landing = iso(at);
  const r = readCi()[pr];
  if (!(ciAt(r, d.headRefOid) && r.ok)) gates.ci = "";
  return gates;
}

// Which of a waiting entry's wake conditions have happened.
function wakeReasons(e: Entry, d: SyncNode): string[] {
  const w = wakeConditions(e), why: string[] = [], head = d.headRefOid;
  const screen = w.screen !== undefined;
  const since = parseIso(e.wait_since) ?? now();
  if (w.push && !head.startsWith(w.push)) why.push(`${screen ? "author responded: " : ""}new push ${head.slice(0, 12)}`);
  const byAuthor = (c: SyncNode["comments"]["nodes"][number]) =>
    c.author?.login === w.author && (parseIso(c.createdAt) ?? since) > since;
  if (w.author && (d.comments?.nodes ?? []).some(byAuthor)) {
    // "author responded" marks a screen hold's wake: prefetch then skips the screen.
    why.push(screen ? `author responded: comment by @${w.author}` : `comment by the author @${w.author}`);
  }
  if (w.reviews !== undefined) {
    // Distinct reviewers other than me and the author, any review state.
    const who = new Set((d.allReviews?.nodes ?? [])
      .filter((r) => (parseIso(r.submittedAt) ?? since) > since)
      .map((r) => r.author?.login ?? null));
    for (const x of [me(), d.author?.login ?? null, null]) who.delete(x);
    if (who.size >= Number(w.reviews || 1)) why.push(`reviewed by ${[...who].sort().join(", ")}`);
  }
  if (w.landing !== undefined) {
    // Recomputed each sync: a fast-track label can end it early.
    const at = landingAt(d.createdAt, d.labels.nodes.map((l) => l.name));
    if (at !== null && at <= now()) why.push("landing wait over");
  }
  if (w.ci !== undefined) {
    const r = readCi()[e.pr];
    if (ciAt(r, head) && r.ok) why.push(`CI green at ${head.slice(0, 12)}`);
  }
  if (w.until && parseIso(w.until)! <= now()) why.push(`hold until ${w.until} passed`);
  return why;
}
