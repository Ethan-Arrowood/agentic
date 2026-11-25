// Candidates: the team queue, the re-review lane, cq CI, and the plan of what
// to prepare next.
import fs from "node:fs";
import path from "node:path";
import {
  BANK_TARGET, CACHE, CQ_CI_MAX_AGE_MINUTES, CQ_CI_PER_TICK, DORMANT_HOURS, ENV, NAME, NC, OWNER, REFRESH_MAX_HOURS,
  REFRESH_MINUTES, REFRESH_RETRY_HOURS, REFRESH_RETRY_MAX_HOURS, RQ,
} from "./config.ts";
import {
  ACTIVE, type Entry, LANE_OF_BUCKET, LANES, actedHead, entries, hasValue, isUserDisposition, rankKey,
} from "./entry.ts";
import { graphql, me } from "./github.ts";
import { describeWait, wakeConditions } from "./holds.ts";
import {
  CommandError, DAY, HOUR, MINUTE, clip, iso, lines, now, parseIso, readCacheJson, readText, readTsv, run, sleep, sortBy,
  writeAtomic, writeCacheJson, writeText,
} from "./util.ts";

// A candidate from the team queue or the re-review lane.
export type Candidate = {
  pr: string;
  lane: string;
  head: string;
  updated: string;
  title?: string;
  author?: string;
  my_teams?: string;
  rereview_from?: string;
  note?: string;
  created?: string | null;
  labels?: string[];
};

// cache/candidates.json: team queue PRs by number.
export type CandidateMeta = {
  title: string;
  draft: boolean;
  state: string;
  updated: string;
  head: string;
  author: string;
  paths: string[];
};

// cache/ci.json: the last ci-status.sh result per cq candidate. `head` is
// the head ci-status.sh reports, which can differ from the candidate's.
type CiResult = { head: string; line: string; at: string; ok: boolean };

// cache/queue-attempt.json: the last team queue refresh.
type QueueAttempt = { at: string; failures: number; error?: string };

// Team-routed queue via build-queue.sh. On INCOMPLETE, keep the old rows
// and add the new ones, so a partial run never shrinks the queue. The rows
// are kept even when the metadata fetch fails, and the tick goes on. The
// stamp is written only after both succeed. Every attempt is recorded in
// queue-attempt.json, so a failure backs off instead of retrying (and
// spending about 20 minutes of searches) on every tick.
export function refreshQueue(): string {
  const r = run(["zsh", path.join(RQ, "build-queue.sh")], { env: ENV });
  writeText(path.join(CACHE, "queue.log"), r.stderr);
  let rows = new Map<string, string>();
  for (const l of lines(r.stdout)) if (l.trim()) rows.set(l.split("\t")[0], l);
  let status: string;
  if (r.status !== 0) {
    const old = new Map(readTsv("queue.tsv").map((row) => [row[0], row.join("\t")]));
    for (const [k, v] of rows) old.set(k, v);
    rows = old;
    status = `INCOMPLETE (${lines(r.stderr.trim()).at(-1) ?? "?"}); kept previous rows`;
  } else {
    status = `${rows.size} PRs`;
  }
  writeAtomic(path.join(CACHE, "queue.tsv"), [...rows.values()].map((l) => `${l}\n`).join(""));
  let ok = r.status === 0;
  try {
    fetchMeta([...rows.keys()]);
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    status = `${status}; candidate metadata FAILED (${clip(err.message, 120)}), kept the previous metadata`;
    ok = false;
  }
  if (ok) writeText(path.join(CACHE, "queue.stamp"), iso(now()));
  const prev = readCacheJson<QueueAttempt>("queue-attempt.json");
  const attempt: QueueAttempt = { at: iso(now()), failures: ok ? 0 : (prev.failures ?? 0) + 1 };
  if (!ok) attempt.error = status;
  writeCacheJson("queue-attempt.json", attempt);
  if (ok) return status;
  return `${status}; failed ${attempt.failures} time(s) in a row, next try after ${iso(refreshRetryAt(attempt)!)}`;
}

// When a failed refresh may be tried again: 2, 4, then 8 hours after
// the last attempt, by default. Null after a success.
function refreshRetryAt(attempt: Partial<QueueAttempt>): number | null {
  const f = attempt.failures ?? 0;
  if (!f || !attempt.at) return null;
  const hours = Math.min(REFRESH_RETRY_HOURS * 2 ** (f - 1), REFRESH_RETRY_MAX_HOURS);
  return parseIso(attempt.at)! + hours * HOUR;
}

// How many new candidates plan could take, from the entries alone (the
// same count plan uses, so it needs no candidate data).
function roomNow(target: number): number {
  const es = entries();
  const active = es.filter((e) => ACTIVE.has(e.state) && e.state !== "stale" && e.lane !== "screen");
  const stale = es.filter((e) => e.state === "stale");
  return Math.max(0, target - active.length - stale.length);
}

// The latest sign the user is around: a sync, present, prefetch, put,
// set, hold, or unhold they ran, or an action of theirs that a sync read
// back from GitHub.
function lastActivity(): number | null {
  const times = [readCacheJson<{ at: string }>("activity.json").at];
  times.push(...entries().filter((e) => isUserDisposition(e.disposition)).map((e) => e.disposition_at));
  const parsed = times.map((t) => parseIso(t)).filter((t) => t !== null);
  return parsed.length ? Math.max(...parsed) : null;
}

// Why fresh candidates aren't needed now, or null.
function dormant(target: number): string | null {
  if (roomNow(target) === 0) return "bank full";
  const last = lastActivity();
  if (last === null) return "no recorded activity";
  if (now() - last > DORMANT_HOURS * HOUR) return `no activity since ${iso(last)}`;
  return null;
}

// Whether this tick refreshes the team queue, and the line to print
// when it doesn't. A failed refresh backs off first. A missing stamp
// refreshes. A stale stamp refreshes unless the bank is dormant, and every
// REFRESH_MAX_HOURS regardless.
export function queueDue(force: boolean, target = BANK_TARGET): [boolean, string | null] {
  if (force) return [true, null];
  const attempt = readCacheJson<QueueAttempt>("queue-attempt.json");
  const retry = refreshRetryAt(attempt);
  if (retry !== null && now() < retry) {
    return [false, `last refresh failed ${attempt.failures} time(s) in a row ` +
      `(${clip(attempt.error || "?", 160)}); next try after ${iso(retry)} (tick --refresh forces one)`];
  }
  const stampPath = path.join(CACHE, "queue.stamp");
  const stamp = fs.existsSync(stampPath) ? parseIso(readText(stampPath)) : null;
  if (stamp === null) return [true, null];
  const age = now() - stamp;
  if (age <= REFRESH_MINUTES * MINUTE) return [false, `cached from ${iso(stamp)} (REFRESH_MINUTES=${REFRESH_MINUTES})`];
  if (age > REFRESH_MAX_HOURS * HOUR) return [true, null];
  const why = dormant(target);
  if (why) {
    const by = stamp + REFRESH_MAX_HOURS * HOUR;
    return [false, `cached from ${iso(stamp)}; dormant (${why}), refreshing by ${iso(by)}`];
  }
  return [true, null];
}

type MetaNode = {
  number: number;
  title: string;
  isDraft: boolean;
  state: string;
  updatedAt: string;
  headRefOid: string;
  author: { login: string } | null;
  files: { nodes: { path: string }[] };
};

// Title, author, draft, state, head, updatedAt, and paths for ranking.
function fetchMeta(prs: string[]): void {
  const meta: Record<string, CandidateMeta> = {};
  for (let i = 0; i < prs.length; i += 40) {
    const fields = prs.slice(i, i + 40).map((n) =>
      `p${n}: pullRequest(number:${n}){number title isDraft state updatedAt headRefOid ` +
      "author{login} files(first:100){nodes{path}}}").join(" ");
    const repo = graphql<Record<string, MetaNode | null>>(`query{repository(owner:"${OWNER}",name:"${NAME}"){${fields}}}`);
    for (const d of Object.values(repo)) {
      if (!d) continue;
      meta[String(d.number)] = {
        title: d.title, draft: d.isDraft, state: d.state, updated: d.updatedAt, head: d.headRefOid,
        author: d.author?.login ?? "ghost", paths: d.files.nodes.map((f) => f.path),
      };
    }
    sleep(2);
  }
  writeCacheJson("candidates.json", meta);
}

export function refreshRereview(): string {
  const r = run(["python3", path.join(RQ, "rereview.py"), "--tsv"], { env: ENV });
  if (r.status !== 0) return `FAILED (${clip(lines(r.stderr.trim()).at(-1) ?? "?", 120)}); kept previous rows`;
  writeAtomic(path.join(CACHE, "rereview.tsv"), r.stdout);
  return `${lines(r.stdout).length} reviewed PRs`;
}

export function readCi(): Partial<Record<string, CiResult>> {
  return readCacheJson<Record<string, CiResult>>("ci.json");
}

// Whether a cached ci-status.sh result is for this head.
export function ciAt(r: CiResult | undefined, head: string): r is CiResult {
  return Boolean(r?.head) && head.startsWith(r!.head);
}

// When nodejs-contribute's Landing wait ends: 48 hours after the PR
// opened, 72 when those hours touch a Saturday or Sunday (UTC), and none
// with fast-track. Null when the open time is unknown.
export function landingAt(created: string | null | undefined, labels: string[]): number | null {
  const t = parseIso(created);
  if (t === null) return null;
  if (labels.includes("fast-track")) return t;
  const end = t + 48 * HOUR;
  for (let day = Math.floor(t / DAY); day <= Math.floor(end / DAY); day++) {
    const weekday = new Date(day * DAY).getUTCDay();
    if (weekday === 0 || weekday === 6) return t + 72 * HOUR;
  }
  return end;
}

// ci-status.sh for cq candidates whose cached result is missing, for
// another head, or older than CQ_CI_MAX_AGE_MINUTES, oldest result first,
// skipping candidates plan would skip anyway. plan reads the cache.
export function refreshCqCi(): string {
  const ci = readCi(), bank = new Map(entries().map((e) => [e.pr, e]));
  let todo: Candidate[] = [];
  for (const c of rankedCandidates()) {
    const e = bank.get(c.pr) ?? null;
    const held = e?.state === "waiting" && wakeConditions(e).ci !== undefined;
    if (c.lane !== "cq" || (e && e.state !== "done" && !held) || skipReason(c, e)) continue;
    const r = ci[c.pr];
    if (ciAt(r, c.head) && now() - (parseIso(r.at) ?? 0) < CQ_CI_MAX_AGE_MINUTES * MINUTE) continue;
    todo.push(c);
  }
  todo = sortBy(todo, (c) => [ci[c.pr]?.at ?? ""]);
  const checks = todo.slice(0, CQ_CI_PER_TICK);
  for (const c of checks) {
    const r = run([path.join(NC, "ci-status.sh"), c.pr], { env: ENV, stderr: "stdout" });
    const line = lines(r.stdout.trim())[0] ?? "no output";
    const head = /\[head ([0-9a-f]{7,40})\]/.exec(line)?.[1] ?? "";
    ci[c.pr] = { head, line, at: iso(now()), ok: line.includes("CI=SUCCESS") && line.includes("HEAD-MATCH") };
  }
  writeCacheJson("ci.json", ci);
  const waiting = todo.length - checks.length;
  return `${checks.length} cq candidate(s) checked${waiting > 0 ? `, ${waiting} waiting` : ""}`;
}

// Inspector and diagnostics_channel PRs: by title prefix, or when every
// changed file outside test/ and doc/ is theirs.
const SKIP_PREFIX = /(?<![\p{L}\p{N}_])(?:inspector|diagnostics_channel)(?![\p{L}\p{N}_])/u;
const SKIP_PATHS = new RegExp("^(lib/inspector\\.js|lib/internal/inspector/|src/inspector/|" +
  "lib/diagnostics_channel\\.js|lib/internal/diagnostics_channel|src/node_diagnostics_channel)");

function isSkip(title: string, paths: string[]): boolean {
  const prefix = title.includes(":") ? title.split(":", 1)[0] : "";
  if (SKIP_PREFIX.test(prefix)) return true;
  const code = paths.filter((p) => !p.startsWith("test/") && !p.startsWith("doc/"));
  return code.length > 0 && code.every((p) => SKIP_PATHS.test(p));
}

// All candidates with their lane, newest update first within a lane.
export function rankedCandidates(): Candidate[] {
  const meta = readCacheJson<Record<string, CandidateMeta>>("candidates.json");
  // rereview.py --tsv: bucket, PR, my last review's state and commit, the
  // head I last reviewed, head, approvals, mergeable, updated, and
  // optionally created and labels.
  const rereview = new Map(readTsv("rereview.tsv").map((r) => [r[1], r]));
  const out = new Map<string, Candidate>();
  for (const r of rereview.values()) {
    if (r.length < 9) throw new Error(`cache/rereview.tsv: a row has ${r.length} columns, not 9 or more`);
    const [bucket, n, , rereviewFrom, , head, approvals, mergeable, updated, created, labels] = r;
    const lane = LANE_OF_BUCKET.get(bucket);
    if (lane) {
      out.set(n, {
        pr: n, lane, head, updated, rereview_from: rereviewFrom, note: `approvals=${approvals} ${mergeable}`,
        created: created ?? null, labels: labels?.split(",") ?? [],
      });
    }
  }
  for (const [n, todo, done = "-"] of readTsv("queue.tsv")) {
    const m = meta[n];
    if (out.has(n) || !m || m.draft || m.state !== "OPEN" || m.author === me()) continue;
    const rr = rereview.get(n);
    if (rr) {
      // Reviewed before: the re-review lane owns it, unless my only
      // reviews were comments on an older head.
      const [bucket, , , , lastReviewed] = rr;
      if (bucket !== "NONE" || lastReviewed === m.head) continue;
    }
    const lane = isSkip(m.title, m.paths) ? "skip" : todo !== "-" ? "fresh" : "fresh-checked";
    const teams = [...todo.split(",").filter((t) => t !== "-").map((t) => `${t} (unchecked)`),
      ...done.split(",").filter((t) => t !== "-").map((t) => `${t} (checked)`)].join(", ");
    out.set(n, { pr: n, lane, head: m.head, updated: m.updated, title: m.title, author: m.author, my_teams: teams });
  }
  return sortBy(out.values(), (c) => [LANES.indexOf(c.lane), -(parseIso(c.updated) ?? 0)]);
}

// Why plan won't prepare candidate c for its done entry e, apart from
// CI, or null. The cached candidate can be up to REFRESH_MINUTES old, so
// when the entry saw the PR later, its state and head win.
export function skipReason(c: Candidate, e: Entry | null): string | null {
  if (!e || e.state !== "done") return null;
  const newer = (parseIso(e.updated_at) ?? 0) > (parseIso(c.updated) ?? 0);
  const user = isUserDisposition(e.disposition);
  if (newer && !user && e.disposition !== "-") return `${clip(e.disposition, 40)} since the candidate was cached`;
  const head = newer && hasValue(e.pr_head) ? e.pr_head : c.head;
  // An action covers its head and its kind of work: an approval at a head
  // doesn't cover the commit-queue check for that head. A woken hold
  // (wait_since set) asked for the PR back, so it doesn't cover it either.
  const woke = hasValue(e.wait_since);
  if (user && !woke && actedHead(e) === head && (e.lane === "cq") === (c.lane === "cq")) {
    return `you acted at this head (${clip(e.disposition, 40)})`;
  }
  return null;
}

// The PREPARE lines (with --all, SKIP, WAIT, and SCREEN lines too), and the
// count of eligible candidates per lane.
export function plan(target = BANK_TARGET, showAll = false): [string[], string] {
  const bank = new Map(entries().map((e) => [e.pr, e]));
  const byRank = sortBy(bank.values(), rankKey);
  const ci = readCi();
  // Screen entries need no preparation, so they don't use the bank's room.
  const active = [...bank.values()].filter((e) => ACTIVE.has(e.state) && e.state !== "stale" && e.lane !== "screen");
  const lines = byRank.filter((e) => e.state === "stale").map((e) => `PREPARE ${e.pr} lane=${e.lane} (stale: re-prepare)`);
  const room = Math.max(0, target - active.length - lines.length);
  const fresh: Candidate[] = [], skipped: [Candidate, string][] = [];
  for (const c of rankedCandidates()) {
    const e = bank.get(c.pr) ?? null;
    if (e && e.state !== "done") continue;
    const why = skipReason(c, e);
    if (why) {
      skipped.push([c, why]);
      continue;
    }
    if (c.lane === "cq") {
      const r = ci[c.pr];
      if (!ciAt(r, c.head) || !r.ok) {
        skipped.push([c, `CI not green at head: ${ciAt(r, c.head) ? r.line : "not checked at this head yet"}`]);
        continue;
      }
      const land = landingAt(c.created, c.labels ?? []);
      if (land !== null && land > now()) {
        skipped.push([c, `landing wait until ${iso(land)}`]);
        continue;
      }
    }
    fresh.push(c);
  }
  for (const c of showAll ? fresh : fresh.slice(0, room)) {
    const note = bank.get(c.pr)?.note ?? "";
    lines.push(`PREPARE ${c.pr} lane=${c.lane} updated=${c.updated.slice(0, 10)}` +
      (c.title ? `  ${clip(c.title, 60)}` : "") + (note.startsWith("woke:") ? `  (${note})` : ""));
  }
  if (showAll) {
    lines.push(...skipped.map(([c, why]) => `SKIP ${c.pr} lane=${c.lane} ${why}`));
    lines.push(...byRank.filter((e) => e.state === "waiting")
      .map((e) => `WAIT ${e.pr} lane=${e.lane} ${describeWait(e)}${hasValue(e.note) ? `  (${e.note})` : ""}`));
    lines.push(...byRank.filter((e) => e.lane === "screen" && (e.state === "ready" || e.state === "presented"))
      .map((e) => `SCREEN ${e.pr} ${e.state} ${e.screen || "-"}  ${clip(e.title, 60)}`));
  }
  const counts = LANES.map((l) => [fresh.filter((c) => c.lane === l).length, l] as const)
    .filter(([k]) => k).map(([k, l]) => `${k} ${l}`).join(", ");
  return [lines, counts || "none"];
}
