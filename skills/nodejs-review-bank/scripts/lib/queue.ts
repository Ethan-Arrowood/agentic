import { BANK_TARGET, CACHE, CQ_CI_MAX_AGE_MINUTES, CQ_CI_PER_TICK, DORMANT_HOURS, ENV, NAME, NC, OWNER, REFRESH_MAX_HOURS, REFRESH_MINUTES, REFRESH_RETRY_HOURS, REFRESH_RETRY_MAX_HOURS, RQ } from "./config.ts";
import { B, type Dt, EPOCH, P, RuntimeError, add, cut, dateOf, dict, dumps, exists, hours, iso, minutes, now, parseIso, pget, py, pyInt, sorted, splitlines, startsWithAny, strip, truthy, unpack, unset, weekday } from "./py.ts";
import { readCacheJson, readText, readTsv, run, sleep, writeAtomic, writeText } from "./util.ts";

import { ACTIVE, type Candidate, type Entry, LANES, LANE_OF_BUCKET, SKIP_PATHS, USER_DISPOSITIONS, actedHead, describeWait, entries, rank, wakeConditions } from "./entry.ts";
import { graphql, me } from "./github.ts";

// Team-routed queue via build-queue.sh. On INCOMPLETE, keep the old rows
// and add the new ones, so a partial run never shrinks the queue. The rows
// are kept even when the metadata fetch fails, and the tick goes on. The
// stamp is written only after both succeed. Every attempt is recorded in
// queue-attempt.json, so a failure backs off instead of retrying (and
// spending about 20 minutes of searches) on every tick.
export function refreshQueue(): string {
  const p = run(["zsh", P(RQ, "build-queue.sh")], { env: ENV });
  writeText(P(CACHE, "queue.log"), p.stderr);
  let rows = new Map<string, string>();
  for (const l of splitlines(p.stdout)) if (strip(l)) rows.set(l.split("\t")[0], l);
  let status: string;
  if (p.status !== 0) {
    const old = new Map(readTsv("queue.tsv").map((r) => [r[0], r.join("\t")] as const));
    for (const [k, v] of rows) old.set(k, v);
    rows = old;
    status = `INCOMPLETE (${splitlines(strip(p.stderr)).at(-1) ?? "?"}); kept previous rows`;
  } else {
    status = `${rows.size} PRs`;
  }
  writeAtomic(P(CACHE, "queue.tsv"), [...rows.values()].map((l) => `${l}\n`).join(""));
  let ok = p.status === 0;
  try {
    fetchMeta([...rows.keys()].map((n) => pyInt(n)));
  } catch (err) {
    if (!(err instanceof RuntimeError)) throw err;
    status = `${status}; candidate metadata FAILED (${cut(err.message, 0, 120)}), kept the previous metadata`;
    ok = false;
  }
  if (ok) writeText(P(CACHE, "queue.stamp"), iso(now()));
  const prev = readCacheJson<any>("queue-attempt.json");
  const attempt: any = { at: iso(now()), failures: ok ? 0 : pget(prev, "failures", 0) + 1 };
  if (!ok) attempt.error = status;
  writeAtomic(P(CACHE, "queue-attempt.json"), dumps(attempt));
  if (ok) return status;
  return `${status}; failed ${attempt.failures} time(s) in a row, ` +
    `next try after ${iso(refreshRetryAt(attempt)!)}`;
}

// When a failed refresh may be tried again: 2, 4, then 8 hours after
// the last attempt, by default. Null after a success.
export function refreshRetryAt(attempt: any): Dt | null {
  const f = pget(attempt, "failures", 0);
  if (!f || !pget(attempt, "at")) return null;
  const h = Math.min(REFRESH_RETRY_HOURS * 2 ** (f - 1), REFRESH_RETRY_MAX_HOURS);
  return add(parseIso(attempt.at)!, hours(h));
}

// How many new candidates plan could take, from the entries alone (the
// same count plan uses, so it needs no candidate data).
export function roomNow(target = BANK_TARGET): number {
  const es = entries();
  const active = es.filter((e) => ACTIVE.has(e.state) && e.state !== "stale" && e.lane !== "screen");
  const stale = es.filter((e) => e.state === "stale");
  return Math.max(0, target - active.length - stale.length);
}

// The latest sign the user is around: a sync, present, prefetch, put,
// set, hold, or unhold they ran, or an action of theirs that a sync read
// back from GitHub.
export function lastActivity(): Dt | null {
  const times: any[] = [pget(readCacheJson<any>("activity.json"), "at")];
  times.push(...entries().filter((e) => startsWithAny(pget(e, "disposition", "-"), USER_DISPOSITIONS))
    .map((e) => pget(e, "disposition_at")));
  const ts = times.filter((t) => t && t !== "-").map((t) => parseIso(t));
  let best: Dt | null = null;
  for (const t of ts) if (t && (!best || t.t > best.t)) best = t;
  return best;
}

// Why fresh candidates aren't needed now, or null.
export function dormant(target = BANK_TARGET): string | null {
  if (roomNow(target) === 0) return "bank full";
  const last = lastActivity();
  if (!last) return "no recorded activity";
  if (now().t - last.t > hours(DORMANT_HOURS)) return `no activity since ${iso(last)}`;
  return null;
}

// Whether this tick refreshes the team queue, and the line to print
// when it doesn't. A failed refresh backs off first. A missing stamp
// refreshes. A stale stamp refreshes unless the bank is dormant, and every
// REFRESH_MAX_HOURS regardless.
export function queueDue(force: boolean, target = BANK_TARGET): [boolean, string | null] {
  if (force) return [true, null];
  const attempt = readCacheJson<any>("queue-attempt.json");
  const retry = refreshRetryAt(attempt);
  if (retry && now().t < retry.t) {
    return [false, `last refresh failed ${py(attempt.failures)} time(s) in a row ` +
      `(${cut(pget(attempt, "error") || "?", 0, 160)}); next try after ${iso(retry)} ` +
      "(tick --refresh forces one)"];
  }
  const stampPath = P(CACHE, "queue.stamp");
  const stamp = exists(stampPath) ? parseIso(readText(stampPath)) : null;
  if (!stamp) return [true, null];
  const age = now().t - stamp.t;
  if (age <= minutes(REFRESH_MINUTES)) return [false, `cached from ${iso(stamp)} (REFRESH_MINUTES=${REFRESH_MINUTES})`];
  if (age > hours(REFRESH_MAX_HOURS)) return [true, null];
  const why = dormant(target);
  if (why) {
    const by = add(stamp, hours(REFRESH_MAX_HOURS));
    return [false, `cached from ${iso(stamp)}; dormant (${why}), refreshing by ${iso(by)}`];
  }
  return [true, null];
}

// Title, author, draft, state, head, updatedAt, and paths for ranking.
export function fetchMeta(nums: number[]): void {
  const meta: Record<string, any> = dict();
  for (let i = 0; i < nums.length; i += 40) {
    const fields = nums.slice(i, i + 40).map((n) =>
      `p${n}: pullRequest(number:${n}){number title isDraft state updatedAt headRefOid ` +
      "author{login} files(first:100){nodes{path}}}").join(" ");
    const repo = graphql<any>(`query{repository(owner:"${OWNER}",name:"${NAME}"){${fields}}}`);
    for (const d of Object.values<any>(repo)) {
      if (truthy(d)) {
        meta[String(d.number)] = {
          title: d.title, draft: d.isDraft, state: d.state,
          updated: d.updatedAt, head: d.headRefOid,
          author: pget(d.author || {}, "login", "ghost"),
          paths: d.files.nodes.map((f: any) => f.path),
        };
      }
    }
    sleep(2);
  }
  writeAtomic(P(CACHE, "candidates.json"), dumps(meta));
}

export function refreshRereview(): string {
  const p = run(["python3", P(RQ, "rereview.py"), "--tsv"], { env: ENV });
  if (p.status !== 0) return `FAILED (${cut(splitlines(strip(p.stderr)).at(-1) ?? "?", 0, 120)}); kept previous rows`;
  writeAtomic(P(CACHE, "rereview.tsv"), p.stdout);
  return `${splitlines(p.stdout).length} reviewed PRs`;
}

export function readCi(): any {
  const p = P(CACHE, "ci.json");
  return exists(p) ? JSON.parse(readText(p)) : {};
}

// Whether a cached ci-status.sh result is for this head.
export function ciAt(r: any, head: string): boolean {
  return Boolean(truthy(r) && pget(r, "head") && head.startsWith(r.head));
}

// When nodejs-contribute's Landing wait ends: 48 hours after the PR
// opened, 72 when those hours touch a Saturday or Sunday (UTC), and none
// with fast-track. Null when the open time is unknown.
export function landingAt(created: string | null | undefined, labels: Iterable<string>): Dt | null {
  const t = parseIso(created);
  if (!t) return null;
  if ([...labels].includes("fast-track")) return t;
  const end = add(t, hours(48));
  let weekend = false;
  for (let i = 0; i < dateOf(end) - dateOf(t) + 1; i++) if (weekday(dateOf(t) + i) >= 5) weekend = true;
  return weekend ? add(t, hours(72)) : end;
}

// ci-status.sh for cq candidates whose cached result is missing, for
// another head, or older than (CQ_CI_MAX_AGE_MINUTES * 60), oldest result first, skipping
// candidates plan would skip anyway. plan reads the cache. A result is keyed
// by the head ci-status.sh reports, which can differ from the candidate's.
export function refreshCqCi(): string {
  const ci = readCi(), bank = new Map(entries().map((e) => [e.pr, e] as const));
  let ran = 0;
  let todo: Candidate[] = [];
  for (const c of rankedCandidates()) {
    const e = bank.get(c.pr) ?? null;
    const held = e && e.state === "waiting" && "ci" in wakeConditions(e);
    if (c.lane !== "cq" || (e && e.state !== "done" && !held) || skipReason(c, e)) continue;
    const r = pget(ci, c.pr);
    if (ciAt(r, c.head) && (now().t - parseIso(r.at)!.t) / 1000 < (CQ_CI_MAX_AGE_MINUTES * 60)) continue;
    todo.push(c);
  }
  todo = sorted(todo, (c) => pget(pget(ci, c.pr) || {}, "at", ""));
  for (const c of todo.slice(0, CQ_CI_PER_TICK)) {
    const p = run([P(NC, "ci-status.sh"), c.pr], { env: ENV, stderr: "stdout" });
    const line = splitlines(strip(p.stdout))[0] ?? "no output";
    const m = /\[head ([0-9a-f]{7,40})\]/.exec(line);
    ci[c.pr] = { head: m ? m[1] : "", line, at: iso(now()), ok: line.includes("CI=SUCCESS") && line.includes("HEAD-MATCH") };
    ran += 1;
  }
  writeAtomic(P(CACHE, "ci.json"), dumps(ci));
  return `${ran} cq candidate(s) checked` + (todo.length > ran ? `, ${todo.length - ran} waiting` : "");
}

export const SKIP_PREFIX = new RegExp(`${B}(inspector|diagnostics_channel)${B}`, "u");

export function isSkip(title: string, paths: string[]): boolean {
  const prefix = title.includes(":") ? title.split(":", 1)[0] : "";
  if (SKIP_PREFIX.test(prefix)) return true;
  const code = paths.filter((p) => !startsWithAny(p, ["test/", "doc/"]));
  return code.length > 0 && code.every((p) => SKIP_PATHS.test(p));
}

// All candidates with their lane, newest update first within a lane.
export function rankedCandidates(): Candidate[] {
  const metaPath = P(CACHE, "candidates.json");
  const meta = exists(metaPath) ? JSON.parse(readText(metaPath)) : {};
  const rr = new Map(readTsv("rereview.tsv").map((r) => [r[1], r] as const));
  const out = new Map<string, Candidate>();
  for (const r of rr.values()) {
    const [bucket, n, , , , head, approvals, mergeable, updated] = unpack(r.slice(0, 9), 9);
    if (Object.hasOwn(LANE_OF_BUCKET, bucket)) {
      out.set(n, {
        pr: n, lane: LANE_OF_BUCKET[bucket], head, updated,
        rereview_from: r[3], note: `approvals=${approvals} ${mergeable}`,
        created: r.length > 9 ? r[9] : null, labels: r.length > 10 ? r[10].split(",") : [],
      });
    }
  }
  for (const r of readTsv("queue.tsv")) {
    const [n, todo, done] = [r[0], r[1], r.length > 2 ? r[2] : "-"];
    const m = pget(meta, n);
    if (out.has(n) || !truthy(m) || m.draft || m.state !== "OPEN" || m.author === me()) continue;
    if (rr.has(n)) {
      // Reviewed before: the re-review lane owns it, unless my only
      // reviews were comments on an older head.
      const [bucket, last] = [rr.get(n)![0], rr.get(n)![4]];
      if (bucket !== "NONE" || last === m.head) continue;
    }
    const lane = isSkip(m.title, m.paths) ? "skip" : todo !== "-" ? "fresh" : "fresh-checked";
    const teams = [...todo.split(",").filter((t) => t !== "-").map((t) => `${t} (unchecked)`),
      ...done.split(",").filter((t) => t !== "-").map((t) => `${t} (checked)`)].join(", ");
    out.set(n, { pr: n, lane, head: m.head, updated: m.updated, title: m.title, author: m.author, my_teams: teams });
  }
  return sorted(out.values(), (c) => [LANES.indexOf(c.lane), -parseIso(c.updated)!.t / 1000]);
}

// Why plan won't prepare candidate c for its done entry e, apart from
// CI, or null. The cached candidate can be up to REFRESH_MINUTES old, so
// when the entry saw the PR later, its state and head win.
export function skipReason(c: Candidate, e: Entry | null): string | null {
  if (!e || e.state !== "done") return null;
  const newer = (parseIso(e.updated_at) ?? EPOCH).t > (parseIso(c.updated) ?? EPOCH).t;
  const user = startsWithAny(e.disposition, USER_DISPOSITIONS);
  if (newer && !user && e.disposition !== "-") return `${cut(e.disposition, 0, 40)} since the candidate was cached`;
  const head = newer && !unset(e.pr_head) ? e.pr_head : c.head;
  // An action covers its head and its kind of work: an approval at a head
  // doesn't cover the commit-queue check for that head. A woken hold
  // (wait_since set) asked for the PR back, so it doesn't cover it either.
  const woke = !unset(e.wait_since);
  if (user && !woke && actedHead(e) === head && (e.lane === "cq") === (c.lane === "cq")) {
    return `you acted at this head (${cut(e.disposition, 0, 40)})`;
  }
  return null;
}

export function plan(target = BANK_TARGET, showAll = false): [string[], string] {
  const bank = new Map(entries().map((e) => [e.pr, e] as const));
  const ci = readCi();
  // Screen entries need no preparation, so they don't use the bank's room.
  const active = [...bank.values()].filter((e) => ACTIVE.has(e.state) && e.state !== "stale" && e.lane !== "screen");
  const lines = sorted(bank.values(), rank).filter((e) => e.state === "stale")
    .map((e) => `PREPARE ${e.pr} lane=${e.lane} (stale: re-prepare)`);
  const room = Math.max(0, target - active.length - lines.length);
  const fresh: Candidate[] = [], skipped: [Candidate, string][] = [];
  for (const c of rankedCandidates()) {
    const e = bank.get(c.pr) ?? null;
    if (e && e.state !== "done") continue;
    let why = skipReason(c, e);
    if (why) {
      skipped.push([c, why]);
      continue;
    }
    if (c.lane === "cq") {
      const r = pget(ci, c.pr);
      if (!ciAt(r, c.head) || !truthy(r.ok)) {
        why = ciAt(r, c.head) ? py(r.line) : "not checked at this head yet";
        skipped.push([c, `CI not green at head: ${why}`]);
        continue;
      }
      const land = landingAt(c.created, c.labels ?? []);
      if (land && land.t > now().t) {
        skipped.push([c, `landing wait until ${iso(land)}`]);
        continue;
      }
    }
    fresh.push(c);
  }
  for (const c of showAll ? fresh : fresh.slice(0, room)) {
    const e = bank.get(c.pr);
    lines.push(`PREPARE ${c.pr} lane=${c.lane} updated=${c.updated.slice(0, 10)}`
      + (c.title ? `  ${cut(c.title, 0, 60)}` : "")
      + (e && pget(e, "note", "").startsWith("woke:") ? `  (${e.note})` : ""));
  }
  if (showAll) {
    lines.push(...skipped.map(([c, why]) => `SKIP ${c.pr} lane=${c.lane} ${why}`));
    lines.push(...sorted(bank.values(), rank).filter((e) => e.state === "waiting")
      .map((e) => `WAIT ${e.pr} lane=${e.lane} ${describeWait(e)}` + (!unset(e.note) ? `  (${e.note})` : "")));
    lines.push(...sorted(bank.values(), rank)
      .filter((e) => e.lane === "screen" && (e.state === "ready" || e.state === "presented"))
      .map((e) => `SCREEN ${e.pr} ${e.state} ${e.screen || "-"}  ${cut(e.title, 0, 60)}`));
  }
  const counts = LANES.map((l) => [fresh.filter((c) => c.lane === l).length, l] as const)
    .filter(([k]) => k).map(([k, l]) => `${k} ${l}`).join(", ");
  return [lines, counts || "none"];
}
