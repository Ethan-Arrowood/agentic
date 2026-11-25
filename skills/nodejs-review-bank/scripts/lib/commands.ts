// The user's commands: list, show, present, put, set, hold, defer, unhold.
import path from "node:path";
import { BANK_TARGET, DEFER_DAYS, DOSSIER, REPO } from "./config.ts";
import {
  type Entry, LANES, STATES, entries, finish, hasValue, isField, load, newEntry, parsePr, rankKey, save, snoozed,
} from "./entry.ts";
import { type WaitFor, describeWait, hold, screenConditions, wake } from "./holds.ts";
import { Flock, entryLock } from "./lock.ts";
import { type CandidateMeta, rankedCandidates } from "./queue.ts";
import { BankError, DAY, clip, die, iso, now, parseIso, print, readCacheJson, readText, sortBy, squash } from "./util.ts";

export function show(e: Entry, headerOnly = false): void {
  const moved = !hasValue(e.pr_head) || e.pr_head === e.head ? "" : `, HEAD MOVED to ${e.pr_head.slice(0, 12)}`;
  print(`#${e.pr} [${e.lane}] ${e.state}: ${e.title}\n  ${e.url}\n` +
    `  prepared against ${e.head.slice(0, 12)} at ${e.prepared_at}${moved}` +
    (hasValue(e.my_teams) ? `\n  teams: ${e.my_teams}` : "") +
    (e.disposition !== "-" ? `\n  disposition: ${e.disposition} at ${e.disposition_at}` : "") +
    (e.state === "waiting" ? `\n  waiting ${describeWait(e)}` : "") +
    (hasValue(e.note) ? `\n  note: ${e.note}` : ""));
  if (!headerOnly) print(e.body.trimEnd());
}

export function listCmd(showAll: boolean, target = BANK_TARGET): void {
  const stateOrder = (s: string) => (STATES.includes(s) ? STATES.indexOf(s) : 9);
  const es = sortBy(entries(), (e) => [stateOrder(e.state), ...rankKey(e)]);
  const counts = STATES.map((s) => [s, es.filter((e) => e.state === s).length] as const)
    .filter(([, k]) => k).map(([s, k]) => `${k} ${s}`).join(", ");
  print(`bank: ${counts || "empty"} (target ${target})`);
  for (const e of es) {
    if (e.state === "done" && !showAll) continue;
    const snz = snoozed(e) ? " (snoozed)" : "";
    const extra = e.state === "needs-run" ? ` needs-run=${e.needs_run}` :
      e.state === "waiting" ? ` (${describeWait(e)})` :
      e.lane === "screen" ? ` (screen ${e.screen || "-"})` : "";
    const disp = e.state === "done" ? ` -> ${e.disposition}` : "";
    print(`  ${e.state.padEnd(9)} ${e.lane.padEnd(13)} https://github.com/${REPO}/pull/${e.pr}${extra}${snz}${disp}` +
      `  ${clip(e.title, 60)}`);
  }
}

// The items under a "Needs a run" heading, up to the next heading. A
// "- None" item is no run: a run that can't be done goes under Open questions.
const NEEDS_RUN = /^#+ *Needs a run\s*\n([\s\S]*?)(?=^#|(?![\s\S]))/mu;
const RUN_ITEM = /^\s*- (?!none(?![\p{L}\p{N}_]))/gimu;

// Bank a verified summary. `head` is the head the draft was prepared
// against (the prefetch line the agent was given); without it, the
// dossier's meta.json. A draft for another head, or for an entry that is no
// longer being prepared, is refused, so a late agent can't revive a done
// entry, take over a newer preparation, or demote a presented one.
export function put(pr: string, summary: string, head: string | null = null): void {
  const body = readText(summary);
  const section = NEEDS_RUN.exec(body);
  const pending = section ? [...section[1].matchAll(RUN_ITEM)].length : 0;
  let e: Entry;
  {
    using lock = entryLock(pr).enter();
    e = load(pr) ?? die(`no entry for ${pr}; prefetch it first`);
    if (!["preparing", "needs-run"].includes(e.state)) die(`#${pr} is ${e.state}, not preparing or needs-run; not banked`, 5);
    if (!head) head = dossierHead(pr) ?? die(`#${pr}: no dossier meta.json to check the head against; pass --head <sha>`, 5);
    if (head.length < 7 || !e.head.startsWith(head)) {
      die(`#${pr}: the draft is for ${head.slice(0, 12)}, but the entry is now prepared against ` +
        `${e.head.slice(0, 12)}; not banked (prepare it again)`, 5);
    }
    Object.assign(e, {
      body, needs_run: String(pending), prepared_at: iso(now()), lease: "-", note: "-",
      state: pending ? "needs-run" : "ready",
    });
    if (hasValue(e.pr_head) && e.pr_head !== e.head) {
      e.state = "stale";
      e.note = `head moved to ${e.pr_head.slice(0, 12)} during preparation`;
    }
    save(e);
  }
  show(e, true);
}

// The head in the dossier's meta.json, or null.
function dossierHead(pr: string): string | null {
  try {
    const head: unknown = JSON.parse(readText(path.join(DOSSIER, pr, "meta.json"))).head;
    return typeof head === "string" ? head : null;
  } catch {
    return null;
  }
}

export function present(): void {
  using presentLock = new Flock("present").enter();
  const es = entries();
  const cur = es.find((e) => e.state === "presented");
  if (cur) die(`#${cur.pr} is still presented; record its disposition first (sync, or set ${cur.pr} state=done disposition=skipped)`);
  const awake = es.filter((e) => !snoozed(e));
  let ready = sortBy(awake.filter((e) => e.state === "ready"), rankKey);
  if (!ready.length) ready = sortBy(awake.filter((e) => e.state === "needs-run"), rankKey);
  if (!ready.length) {
    const asleep = es.filter((e) => (e.state === "ready" || e.state === "needs-run") && snoozed(e)).length;
    die(`nothing ready${asleep ? ` (${asleep} snoozed)` : ""}`, 3);
  }
  using lock = entryLock(ready[0].pr).enter();
  const e = load(ready[0].pr)!;
  // A sync or set may have changed it while this waited for the lock.
  if (!(e.state === "ready" || e.state === "needs-run") || snoozed(e)) {
    die(`#${e.pr} changed to ${e.state} while presenting; run present again`, 6);
  }
  Object.assign(e, { state: "presented", presented_at: iso(now()) });
  const rest = es.filter((x) => x.pr !== e.pr && (x.state === "ready" || x.state === "needs-run")).length;
  // Print first: if output fails, the entry isn't left claimed.
  show(e);
  print(`\n(${rest} more banked after this)`);
  save(e);
}

const TIME_FIELDS = ["snooze_until", "disposition_at", "created_at"];

export function setCmd(pr: string, assignments: string[]): void {
  let e: Entry;
  {
    using lock = entryLock(pr).enter();
    e = load(pr) ?? die(`no entry for ${pr}`);
    for (const kv of assignments) {
      const i = kv.indexOf("=");
      const [k, v] = i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
      if (!isField(k) || k === "pr") die(`unknown field ${k}`);
      if (k === "state" && !STATES.includes(v)) die(`state must be one of ${STATES.join(", ")}`);
      if (k === "lane" && !LANES.includes(v)) die(`lane must be one of ${LANES.join(", ")}`);
      if (TIME_FIELDS.includes(k) && v !== "-" && !isIsoTime(v)) die(`${k} must be an ISO time such as ${iso(now())}`);
      e[k] = v;
    }
    if (e.state === "done") {
      // Always through finish, so the dossier and ref are cleaned up.
      finish(e, e.disposition, hasValue(e.disposition_at) ? e.disposition_at : null);
    } else {
      save(e);
    }
  }
  show(e, true);
}

// Whether s parses as an ISO time (or is empty).
function isIsoTime(s: string): boolean {
  try {
    parseIso(s);
    return true;
  } catch (err) {
    if (err instanceof BankError) return false;
    throw err;
  }
}

// The entry for a hold, or a new one from the candidate when the bank
// has none yet. Not saved.
function heldEntry(pr: string): Entry {
  const e = load(pr);
  if (e) return e;
  const c = rankedCandidates().find((x) => x.pr === pr) ??
    die(`#${pr} is neither in the bank nor a candidate; nothing to hold`);
  return newEntry(pr, {
    url: `https://github.com/${REPO}/pull/${pr}`, title: c.title || "-", author: c.author || "-", lane: c.lane,
    head: c.head, pr_head: c.head, created_at: iso(now()), updated_at: c.updated, my_teams: c.my_teams ?? "-",
    rereview_from: c.rereview_from ?? "-", disposition: "-",
  });
}

// The PR author's login from the entry, else the candidate metadata, or null.
function authorOf(e: Entry): string | null {
  if (!["-", "", "ghost"].includes(e.author)) return e.author;
  const author = readCacheJson<Record<string, CandidateMeta>>("candidates.json")[e.pr]?.author;
  return author !== undefined && author !== null && author !== "ghost" ? author : null;
}

// The latest head the bank has seen.
function latestHead(e: Entry): string {
  return hasValue(e.pr_head) ? e.pr_head : e.head;
}

// Hold a PR until others review it, it gets a push, --until passes, or
// (with --until-author) its author comments. Works for a candidate with no
// entry yet. No GitHub call: the push condition uses the latest head the
// bank has seen.
export function holdCmd(prArg: string, args: string[]): void {
  const pr = parsePr(prArg), note: string[] = [];
  let until: string | null = null, reviews = "1", screen = false, byAuthor = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--screen") {
      screen = true;
    } else if (a === "--until-author") {
      byAuthor = true;
    } else if (a === "--until" || a === "--until-reviews") {
      if (i + 1 >= args.length) die(`${a} needs a value`, 2);
      const v = args[++i];
      if (a === "--until") {
        const t = isIsoTime(v) ? parseIso(v) : null;
        if (t === null) die(`--until must be an ISO time such as ${iso(now())}`, 2);
        until = iso(t);
      } else {
        if (!/^[0-9]+$/.test(v)) die("--until-reviews must be a count, 0 for none", 2);
        reviews = v;
      }
    } else {
      note.push(a);
    }
  }
  const noted = note.length ? `: ${note.join(" ")}` : "";
  let e: Entry;
  {
    using lock = entryLock(pr).enter();
    e = heldEntry(pr);
    let w: WaitFor;
    if (screen) {
      // After a comment asking the author to follow the AI policy.
      w = screenConditions(e, e.author, latestHead(e), iso(now()));
    } else {
      w = Number(reviews) ? { reviews } : {};
      w.push = latestHead(e).slice(0, 12);
      if (byAuthor) w.author = authorOf(e) || die(`#${pr}: the author is unknown; prefetch it first`, 2);
    }
    if (until) w.until = until;
    hold(e, w, iso(now()), (screen ? "screen: waiting for the author" : "held") + noted);
  }
  show(e, true);
}

// Hold a PR that isn't worth reviewing yet: someone else's request to the
// author is open, a linked PR may supersede it, or the author said more is
// coming. It wakes when the author comments, the head moves, someone else
// reviews, or DEFER_DAYS pass. Prints one DEFER line for the orchestrator to
// relay.
export function deferCmd(prArg: string, args: string[]): void {
  const pr = parsePr(prArg), reason = squash(args.join(" "));
  if (!reason) die("usage: defer <pr> <reason...> (quote or link the comment it waits on)", 2);
  {
    using lock = entryLock(pr).enter();
    const e = heldEntry(pr);
    const w: WaitFor = { reviews: "1", push: latestHead(e).slice(0, 12) };
    w.author = authorOf(e) || die(`#${pr}: the author is unknown; prefetch it first`, 2);
    w.until = iso(now() + DEFER_DAYS * DAY);
    hold(e, w, iso(now()), `defer: ${reason}`);
  }
  print(`DEFER #${pr}: ${reason}`);
}

export function unholdCmd(pr: string): void {
  let e: Entry;
  {
    using lock = entryLock(pr).enter();
    e = load(pr) ?? die(`no entry for ${pr}`);
    if (e.state !== "waiting") die(`#${pr} is ${e.state}, not waiting`);
    wake(e, ["unheld by hand"]);
  }
  show(e, true);
}
