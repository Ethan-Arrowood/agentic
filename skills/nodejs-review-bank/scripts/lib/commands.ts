import { DEFER_DAYS, DOSSIER, REPO, TARGET } from "./config.ts";
import { type Conditions, type Entry, FIELDS, LANES, STATES, describeWait, entries, finish, load, rank, save, snoozed } from "./entry.ts";
import { Flock, entryLock } from "./lock.ts";
import { B, BOL, KeyError, P, ValueError, WS, add, cut, days, dict, isOSError, isValueError, item, ljust, partition, pget, py, pyInt, rstrip, sorted, splitWs, unset } from "./py.ts";
import { rankedCandidates } from "./queue.ts";
import { hold, screenConditions, wake } from "./sync.ts";
import { die, iso, now, parseIso, print, readCacheJson, readText } from "./util.ts";

export function show(e: Entry, headerOnly = false): void {
  const moved = [null, undefined, "-", e.head].includes(e.pr_head) ? "" : `, HEAD MOVED to ${e.pr_head.slice(0, 12)}`;
  print(`#${e.pr} [${py(e.lane)}] ${py(e.state)}: ${py(e.title)}\n  ${py(e.url)}\n` +
    `  prepared against ${e.head.slice(0, 12)} at ${py(pget(e, "prepared_at", "-"))}${moved}`
    + (!unset(e.my_teams) ? `\n  teams: ${e.my_teams}` : "")
    + (e.disposition !== "-" ? `\n  disposition: ${e.disposition} at ${py(item(e, "disposition_at"))}` : "")
    + (e.state === "waiting" ? `\n  waiting ${describeWait(e)}` : "")
    + (!unset(e.note) ? `\n  note: ${e.note}` : ""));
  if (!headerOnly) print(rstrip(e.body!));
}

export function listCmd(showAll: boolean, target = TARGET): void {
  const es = sorted(entries(), (e) => [STATES.includes(e.state) ? STATES.indexOf(e.state) : 9, rank(e)]);
  const counts = STATES.map((s) => [s, es.filter((e) => e.state === s).length] as const);
  print("bank: " + (counts.filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ") || "empty") + ` (target ${target})`);
  for (const e of es) {
    if (e.state === "done" && !showAll) continue;
    const snz = snoozed(e) ? " (snoozed)" : "";
    const extra = e.state === "needs-run" ? ` needs-run=${e.needs_run}` :
      e.state === "waiting" ? ` (${describeWait(e)})` :
      e.lane === "screen" ? ` (screen ${e.screen || "-"})` : "";
    const disp = e.state === "done" ? ` -> ${e.disposition}` : "";
    print(`  ${ljust(e.state, 9)} ${ljust(e.lane, 13)} https://github.com/${REPO}/pull/${e.pr}${extra}${snz}${disp}  ${cut(e.title, 0, 60)}`);
  }
}

// Bank a verified summary. `head` is the head the draft was prepared
// against (the prefetch line the agent was given); without it, the
// dossier's meta.json. A draft for another head, or for an entry that is no
// longer being prepared, is refused, so a late agent can't revive a done
// entry, take over a newer preparation, or demote a presented one.
export function put(n: string, summary: string, head: string | null = null): void {
  const body = readText(summary);
  const m = new RegExp(`${BOL}#+ *Needs a run[${WS}]*\\n([\\s\\S]*?)(?=${BOL}#|(?![\\s\\S]))`, "u").exec(body);
  // A "- None" item is no run: a run that can't be done goes under Open questions.
  const pending = m ? [...m[1].matchAll(new RegExp(`${BOL}[${WS}]*- (?!none${B})`, "giu"))].length : 0;
  let e: Entry;
  {
    using lock = entryLock(n).enter();
    e = load(n) ?? die(`no entry for ${n}; prefetch it first`);
    if (!["preparing", "needs-run"].includes(e.state)) die(`#${n} is ${e.state}, not preparing or needs-run; not banked`, 5);
    if (!head) {
      try {
        head = item(JSON.parse(readText(P(DOSSIER, String(n), "meta.json"))), "head");
      } catch (err) {
        if (!(isOSError(err) || isValueError(err) || err instanceof KeyError)) throw err;
        die(`#${n}: no dossier meta.json to check the head against; pass --head <sha>`, 5);
      }
    }
    if (Array.from(head!).length < 7 || !e.head.startsWith(head!)) {
      die(`#${n}: the draft is for ${cut(head!, 0, 12)}, but the entry is now prepared against ` +
        `${e.head.slice(0, 12)}; not banked (prepare it again)`, 5);
    }
    e.body = body;
    e.needs_run = String(pending);
    e.prepared_at = iso(now());
    e.lease = "-";
    e.note = "-";
    e.state = pending ? "needs-run" : "ready";
    if (!unset(e.pr_head) && e.pr_head !== e.head) {
      e.state = "stale";
      e.note = `head moved to ${e.pr_head.slice(0, 12)} during preparation`;
    }
    save(e);
  }
  show(e, true);
}

export function present(): void {
  using presentLock = new Flock("present").enter();
  const es = entries();
  const cur = es.filter((e) => e.state === "presented");
  if (cur.length) die(`#${cur[0].pr} is still presented; record its disposition first (sync, or set ${cur[0].pr} state=done disposition=skipped)`);
  const awake = es.filter((e) => !snoozed(e));
  let ready = sorted(awake.filter((e) => e.state === "ready"), rank);
  if (!ready.length) ready = sorted(awake.filter((e) => e.state === "needs-run"), rank);
  if (!ready.length) {
    const asleep = es.filter((e) => (e.state === "ready" || e.state === "needs-run") && snoozed(e)).length;
    die("nothing ready" + (asleep ? ` (${asleep} snoozed)` : ""), 3);
  }
  using lock = entryLock(ready[0].pr).enter();
  const e = load(ready[0].pr)!;
  // A sync or set may have changed it while this waited for the lock.
  if (!(e.state === "ready" || e.state === "needs-run") || snoozed(e)) {
    die(`#${e.pr} changed to ${e.state} while presenting; run present again`, 6);
  }
  [e.state, e.presented_at] = ["presented", iso(now())];
  const rest = es.filter((x) => x.pr !== e.pr && (x.state === "ready" || x.state === "needs-run")).length;
  // Print first: if output fails, the entry isn't left claimed.
  show(e);
  print(`\n(${rest} more banked after this)`);
  save(e);
}

export function setCmd(n: string, kvs: string[]): void {
  let e: Entry;
  {
    using lock = entryLock(n).enter();
    e = load(n) ?? die(`no entry for ${n}`);
    for (const kv of kvs) {
      const [k, , v] = partition(kv, "=");
      if (!FIELDS.includes(k) || k === "pr") die(`unknown field ${k}`);
      if (k === "state" && !STATES.includes(v)) die(`state must be one of ${STATES.join(", ")}`);
      if (k === "lane" && !LANES.includes(v)) die(`lane must be one of ${LANES.join(", ")}`);
      if (["snooze_until", "disposition_at", "created_at"].includes(k) && v !== "-") {
        try {
          parseIso(v);
        } catch (err) {
          if (!(err instanceof ValueError)) throw err;
          die(`${k} must be an ISO time such as ${iso(now())}`);
        }
      }
      e[k] = v;
    }
    if (e.state === "done") {
      // Always through finish, so the dossier and ref are cleaned up.
      finish(e, e.disposition, !unset(e.disposition_at) ? e.disposition_at : null);
    } else {
      save(e);
    }
  }
  show(e, true);
}

// The entry for a hold, or a new one from the candidate when the bank
// has none yet. Not saved.
export function heldEntry(n: string): Entry {
  const e = load(n);
  if (e) return e;
  const c = new Map(rankedCandidates().map((c) => [c.pr, c] as const)).get(n) ??
    die(`#${n} is neither in the bank nor a candidate; nothing to hold`);
  return dict({
    pr: n, url: `https://github.com/${REPO}/pull/${n}`, title: c.title || "-",
    author: c.author || "-", lane: c.lane, head: c.head, pr_head: c.head,
    created_at: iso(now()), updated_at: c.updated, my_teams: c.my_teams ?? null,
    rereview_from: c.rereview_from ?? null, disposition: "-",
  });
}

// The PR author's login from the entry, else the candidate metadata, or null.
export function authorOf(e: Entry): string | null {
  if (![null, undefined, "-", "", "ghost"].includes(e.author)) return e.author;
  const meta = pget(readCacheJson("candidates.json"), String(e.pr)) || {};
  return ![null, undefined, "ghost"].includes(pget(meta, "author")) ? meta.author : null;
}

// Hold a PR until others review it, it gets a push, --until passes, or
// (with --until-author) its author comments. Works for a candidate with no
// entry yet. No GitHub call: the push condition uses the latest head the
// bank has seen.
export function holdCmd(n0: string, args0: string[]): void {
  const n = String(pyInt(n0)), args = [...args0], note: string[] = [];
  let until: string | null = null, reviews = "1", scr = false, byAuthor = false;
  while (args.length) {
    const a = args.shift()!;
    if (a === "--screen") {
      scr = true;
      continue;
    }
    if (a === "--until-author") {
      byAuthor = true;
      continue;
    }
    if ((a === "--until" || a === "--until-reviews") && !args.length) die(`${a} needs a value`, 2);
    if (a === "--until") {
      try {
        until = iso(parseIso(args.shift())!);
      } catch (err) {
        if (!(err instanceof ValueError || err instanceof TypeError)) throw err;
        die(`--until must be an ISO time such as ${iso(now())}`, 2);
      }
    } else if (a === "--until-reviews") {
      reviews = args.shift()!;
      if (!/^[0-9]+$/.test(reviews)) die("--until-reviews must be a count, 0 for none", 2);
    } else {
      note.push(a);
    }
  }
  let e: Entry;
  {
    using lock = entryLock(n).enter();
    e = heldEntry(n);
    const head: string = !unset(e.pr_head) ? e.pr_head : e.head;
    if (scr) {
      // After a comment asking the author to follow the AI policy.
      const w = screenConditions(e, pget(e, "author"), head, iso(now()));
      if (until) w.until = until;
      hold(e, w, iso(now()), "screen: waiting for the author" + (note.length ? `: ${note.join(" ")}` : ""));
      show(e, true);
      return;
    }
    const w: Conditions = pyInt(reviews) ? { reviews } : {};
    w.push = head.slice(0, 12);
    if (byAuthor) w.author = authorOf(e) || die(`#${n}: the author is unknown; prefetch it first`, 2);
    if (until) w.until = until;
    hold(e, w, iso(now()), "held" + (note.length ? `: ${note.join(" ")}` : ""));
  }
  show(e, true);
}

// Hold a PR that isn't worth reviewing yet: someone else's request to the
// author is open, a linked PR may supersede it, or the author said more is
// coming. It wakes when the author comments, the head moves, someone else
// reviews, or DEFER_DAYS pass. Prints one DEFER line for the orchestrator to
// relay.
export function deferCmd(n0: string, args: string[]): void {
  const n = String(pyInt(n0)), reason = splitWs(args.join(" ")).join(" ");
  if (!reason) die("usage: defer <pr> <reason...> (quote or link the comment it waits on)", 2);
  {
    using lock = entryLock(n).enter();
    const e = heldEntry(n);
    const head: string = !unset(e.pr_head) ? e.pr_head : e.head;
    const w: Conditions = { reviews: "1", push: head.slice(0, 12) };
    w.author = authorOf(e) || die(`#${n}: the author is unknown; prefetch it first`, 2);
    w.until = iso(add(now(), days(DEFER_DAYS)));
    hold(e, w, iso(now()), `defer: ${reason}`);
  }
  print(`DEFER #${n}: ${reason}`);
}

export function unholdCmd(n: string): void {
  let e: Entry;
  {
    using lock = entryLock(n).enter();
    e = load(n) ?? die(`no entry for ${n}`);
    if (e.state !== "waiting") die(`#${n} is ${e.state}, not waiting`);
    wake(e, ["unheld by hand"]);
  }
  show(e, true);
}
