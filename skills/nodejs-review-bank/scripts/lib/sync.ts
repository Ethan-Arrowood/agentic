import { LEASE_MIN, NAME, OWNER, SCREEN_HOURS } from "./config.ts";
import { type Conditions, type Entry, LANE_OF_BUCKET, describeWait, dropInputs, entries, finish, load, save, wakeConditions } from "./entry.ts";
import { graphql, me } from "./github.ts";
import { entryLock } from "./lock.ts";
import { BOL, type Dt, WS, add, cmp, cut, hours, maxDt, pct, pget, pyInt, sorted, startsWithAny, truthy } from "./py.ts";
import { ciAt, landingAt, readCi } from "./queue.ts";
import { closeBody } from "./screen.ts";
import { iso, now, parseIso, readTsv } from "./util.ts";

export const SYNC_FIELDS = (
  "number title state isDraft createdAt updatedAt closedAt headRefOid author{login} " +
  "labels(first:50){nodes{name}} " +
  "allReviews: reviews(last:50){nodes{author{login} submittedAt}} " +
  'reviews(last:30,author:"%s"){nodes{state submittedAt commit{oid}}} ' +
  "comments(last:30){nodes{author{__typename login} createdAt body}} " +
  "timelineItems(last:50,itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){nodes{__typename " +
  "...on LabeledEvent{createdAt actor{login} label{name}} " +
  "...on UnlabeledEvent{createdAt actor{login} label{name}}}}");
export const LANDED = new RegExp(`${BOL}[${WS}]*Landed in ([0-9a-f]{7,40})`);

export function sync(only: Set<string> | null = null): string[] {
  const heads = new Map(entries().filter((e) => e.state !== "done" && (!only || only.has(e.pr)))
    .map((e) => [e.pr, e.head] as const));
  const nums = [...heads.keys()];
  if (!nums.length) return ["sync: no open entries"];
  const rr = new Map(readTsv("rereview.tsv").map((r) => [r[1], r] as const));
  const data = new Map<string, any>();
  for (let i = 0; i < nums.length; i += 20) {
    const fields = nums.slice(i, i + 20).map((n) => `p${n}: pullRequest(number:${n}){${pct(SYNC_FIELDS, me())}}`).join(" ");
    for (const d of Object.values<any>(graphql(`query{repository(owner:"${OWNER}",name:"${NAME}"){${fields}}}`))) {
      if (truthy(d)) data.set(String(d.number), d);
    }
  }
  const log: string[] = [];
  for (const n of nums) {
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
    log.push(...syncEntry(e, data.get(n), rr));
  }
  return log.length ? log : ["sync: no changes"];
}

export function syncEntry(e: Entry, d: any, rr: Map<string, string[]>): string[] {
  const n = e.pr;
  if (!truthy(d)) {
    finish(e, "not-found");
    return [`  ${n}: not found on GitHub (deleted?)`];
  }
  [e.title, e.updated_at, e.pr_head] = [d.title, d.updatedAt, d.headRefOid];
  const author = pget(d.author || {}, "login");
  if (author === me()) {
    finish(e, "mine");
    return [`  ${n}: authored by me, dropped`];
  }
  if (d.state === "MERGED" || d.state === "CLOSED") {
    // nodejs lands with commit-queue or git node land, so a landed PR
    // shows as closed with a "Landed in <sha>" comment.
    const landed = d.comments.nodes.map((c: any) => LANDED.exec(c.body || "")).filter(Boolean).map((m: RegExpExecArray) => m[1]);
    const disp = landed.length ? `landed ${landed.at(-1)}` : d.state.toLowerCase();
    finish(e, disp, pget(d, "closedAt"));
    return [`  ${n}: ${disp}`];
  }
  if (d.isDraft) {
    finish(e, "draft");
    return [`  ${n}: converted to draft`];
  }
  if (e.state === "waiting") {
    // My own actions don't wake a hold; it waits on others and on time.
    const why = wakeReasons(e, d);
    if (why.length && "screen" in wakeConditions(e) && !why.some((w) => w.startsWith("author responded"))) {
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
    since = maxDt(since, parseIso(e.prepared_at) ?? since);
  }
  const acted = myActions(d, since);
  const labels = new Set<string>(d.labels.nodes.map((l: any) => l.name));
  if (acted && e.lane === "screen" && !startsWithAny(acted[0], ["approved", "changes-requested"])) {
    // The user handled a screened PR (a comment asking for the policy):
    // wait for the author. A review means they chose to review it after all.
    const [disp, when] = acted;
    [e.disposition, e.disposition_at] = [disp, when];
    hold(e, screenConditions(e, author, d.headRefOid, when), when, "screen: waiting for the author");
    return [`  ${n}: ${disp}, waiting ${describeWait(e)}`];
  }
  if (acted) {
    const [disp, when, reviewed] = acted;
    e.acted_head = reviewed || e.head;
    // An approval at the head leaves nothing to do until the PR can land.
    const gates = disp.startsWith("approved") && reviewed === d.headRefOid ? landingGates(d, n) : {};
    if (truthy(gates)) {
      [e.disposition, e.disposition_at] = [disp, when];
      hold(e, { reviews: "1", push: reviewed!.slice(0, 12), ...gates }, when, "approved; waiting until it can land");
      return [`  ${n}: ${disp}, waiting ${describeWait(e)}`];
    }
    finish(e, disp, when);
    return [`  ${n}: ${disp}`];
  }
  // Exact label: commit-queue-squash, -rebase, and -failed don't enqueue.
  if (e.lane === "cq" && labels.has("commit-queue")) {
    finish(e, "cq-labeled");
    return [`  ${n}: commit-queue added by someone else`];
  }
  // The lane changes only for an entry still open. A finished entry keeps
  // the lane it was prepared in, which plan compares with the candidate's.
  if (rr.has(n) && Object.hasOwn(LANE_OF_BUCKET, rr.get(n)![0])) e.lane = LANE_OF_BUCKET[rr.get(n)![0]];
  const log: string[] = [];
  if (["ready", "needs-run", "presented"].includes(e.state) && e.head !== d.headRefOid) {
    e.note = `head moved from ${e.head.slice(0, 12)} while ${e.state}`;
    e.state = "stale";
    log.push(`  ${n}: stale, ${e.note}`);
  } else if (e.state === "preparing" && (now().t - (parseIso(e.lease) ?? now()).t) / 1000 > LEASE_MIN * 60) {
    e.state = "stale";
    e.note = "preparation abandoned (lease expired)";
    log.push(`  ${n}: ${e.note}`);
  }
  save(e);
  return log;
}

// My reviews, label changes, and comments since `since`, as one
// disposition string, the time of the latest, and the commit of my latest
// review (or null).
export function myActions(d: any, since: Dt): [string, string, string | null] | null {
  const acts: [Dt, string][] = [];
  let reviewed: string | null = null;
  for (const r of d.reviews.nodes) {
    const t = parseIso(r.submittedAt);
    if (t && t.t > since.t) {
      const oid = pget(r.commit || {}, "oid");
      reviewed = oid || reviewed;
      acts.push([t, `${r.state.toLowerCase().replaceAll("_", "-")} @${cut(oid || "?", 0, 12)}`]);
    }
  }
  for (const ev of d.timelineItems.nodes) {
    if (pget(ev.actor || {}, "login") === me() && parseIso(ev.createdAt)!.t > since.t) {
      const verb = ev.__typename === "LabeledEvent" ? "labeled" : "unlabeled";
      acts.push([parseIso(ev.createdAt)!, `${verb} ${ev.label.name}`]);
    }
  }
  for (const c of d.comments.nodes) {
    if (pget(c.author || {}, "login") === me() && parseIso(c.createdAt)!.t > since.t) {
      acts.push([parseIso(c.createdAt)!, "commented"]);
    }
  }
  if (!acts.length) return null;
  acts.sort((a, b) => a[0].t - b[0].t || cmp(a[1], b[1]));
  // Lead with the review, if any: "approved @<sha>; labeled request-ci".
  const order = sorted(acts, (a) => !a[1].includes(" @"));
  return [[...new Set(order.map((a) => a[1]))].join("; "), iso(acts.at(-1)![0]), reviewed];
}

// Wake conditions for a screened PR: the author comments or pushes, or
// SCREEN_HOURS pass.
export function screenConditions(e: Entry, author: string | null, head: string | null, since: string): Conditions {
  const until = add(parseIso(since) ?? now(), hours(SCREEN_HOURS));
  return {
    author: author || pget(e, "author") || "", push: (head || pget(e, "pr_head") || e.head).slice(0, 12),
    until: iso(until), screen: "",
  };
}

// Move an entry to waiting and drop its inputs: on wake it is planned
// again, and others' reviews or a push make the old review stale anyway.
export function hold(e: Entry, conditions: Conditions, since: string, note: string): void {
  [e.state, e.wait_since, e.note, e.lease] = ["waiting", since, note, "-"];
  e.wait_for = Object.entries(conditions).map(([k, v]) => (v ? `${k}=${v}` : k)).join(",") || "-";
  save(e);
  dropInputs(e.pr);
}

// End a hold. The entry is done, so plan puts the PR back in its lane.
export function wake(e: Entry, why: string[]): void {
  [e.state, e.note] = ["done", "woke: " + why.join("; ")];
  save(e);
}

// The landing gates still closed at the PR's head, as wake conditions:
// the landing wait, and green CI from the cq CI cache.
export function landingGates(d: any, n: string): Conditions {
  const gates: Conditions = {};
  const at = landingAt(pget(d, "createdAt"), d.labels.nodes.map((l: any) => l.name));
  if (at && at.t > now().t) gates.landing = iso(at);
  const r = pget(readCi(), n);
  if (!(ciAt(r, d.headRefOid) && truthy(r.ok))) gates.ci = "";
  return gates;
}

// Which of a waiting entry's wake conditions have happened.
export function wakeReasons(e: Entry, d: any): string[] {
  const w = wakeConditions(e), why: string[] = [], head: string = d.headRefOid;
  const since = parseIso(e.wait_since) ?? now();
  if (w.push && !head.startsWith(w.push)) why.push(("screen" in w ? "author responded: " : "") + `new push ${head.slice(0, 12)}`);
  if (w.author && (pget(d.comments || {}, "nodes", []) as any[]).some((c) => pget(c.author || {}, "login") === w.author
      && (parseIso(pget(c, "createdAt")) ?? since).t > since.t)) {
    // "author responded" marks a screen hold's wake: prefetch then skips the screen.
    why.push("screen" in w ? `author responded: comment by @${w.author}` : `comment by the author @${w.author}`);
  }
  if ("reviews" in w) {
    // Distinct reviewers other than me and the author, any review state.
    const who = new Set((pget(d.allReviews || {}, "nodes", []) as any[])
      .filter((r) => (parseIso(pget(r, "submittedAt")) ?? since).t > since.t)
      .map((r) => pget(r.author || {}, "login")));
    for (const x of [me(), pget(d.author || {}, "login"), null]) who.delete(x);
    if (who.size >= pyInt(w.reviews || 1)) why.push(`reviewed by ${sorted(who).join(", ")}`);
  }
  if ("landing" in w) {
    // Recomputed each sync: a fast-track label can end it early.
    const at = landingAt(pget(d, "createdAt"), d.labels.nodes.map((l: any) => l.name));
    if (at && at.t <= now().t) why.push("landing wait over");
  }
  if ("ci" in w) {
    const r = pget(readCi(), e.pr);
    if (ciAt(r, head) && truthy(r.ok)) why.push(`CI green at ${head.slice(0, 12)}`);
  }
  if (w.until && parseIso(w.until)!.t <= now().t) why.push(`hold until ${w.until} passed`);
  return why;
}
