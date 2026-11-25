import { listCmd } from "./commands.ts";
import { CACHE, TARGET, TICK_BASE_MIN, TICK_GRACE_MIN, TICK_MAX_MIN } from "./config.ts";
import { imageTick } from "./images.ts";
import { Flock } from "./lock.ts";
import { P, RuntimeError, add, cut, dumps, isOSError, isValueError, minutes, nth, pget, py, pyInt, pyStr } from "./py.ts";
import { plan, queueDue, refreshCqCi, refreshQueue, refreshRereview } from "./queue.ts";
import { sync } from "./sync.ts";
import { die, iso, now, parseIso, print, readCacheJson, writeAtomic } from "./util.ts";

// The user ran a bank command: note it, and end any tick backoff.
export function markActive(): void {
  writeAtomic(P(CACHE, "activity.json"), dumps({ at: iso(now()) }));
  const st = readCacheJson("tick.json");
  if (pget(st, "quiet") || pget(st, "next_due")) {
    writeAtomic(P(CACHE, "tick.json"), dumps({ quiet: 0, next_due: null, last: pget(st, "last") }));
  }
}

// The one line a backed-off tick prints, or null when a real tick is due.
// Reads only the cache: no gh, no git.
export function tickBackedOff(): string | null {
  if (TICK_MAX_MIN <= 0) return null;
  const st = readCacheJson("tick.json");
  const due = pget(st, "next_due") ? parseIso(st.next_due) : null;
  if (!due || now().t >= due.t) return null;
  return `tick ${iso(now())}: backed off after ${py(pget(st, "quiet", 0))} quiet ticks in a row; ` +
    `next real tick at ${iso(due)} (tick --now, sync, present, prefetch, or put runs sooner)`;
}

// Count quiet ticks and set when the next real one is due: on the base
// cadence after the first quiet tick, then 2x, 4x, ... up to
// TICK_BACKOFF_MAX_MINUTES. Any change resets it. Returns a report line.
export function recordTick(changed: boolean): string {
  let st: { quiet: number; next_due: string | null; last: string };
  if (changed || TICK_MAX_MIN <= 0) {
    st = { quiet: 0, next_due: null, last: iso(now()) };
  } else {
    const q = pget(readCacheJson("tick.json"), "quiet", 0) + 1;
    const mins = Math.min(TICK_BASE_MIN * 2 ** (q - 1), TICK_MAX_MIN);
    const due = mins > TICK_BASE_MIN ? add(now(), minutes(mins - TICK_GRACE_MIN)) : null;
    st = { quiet: q, next_due: due ? iso(due) : null, last: iso(now()) };
  }
  writeAtomic(P(CACHE, "tick.json"), dumps(st));
  if (!st.quiet) return "tick: changes this tick; next tick on the normal cadence";
  if (!st.next_due) return `tick: quiet (${st.quiet} in a row); next tick on the normal cadence`;
  return `tick: quiet (${st.quiet} in a row); backing off, next real tick at ${st.next_due}`;
}

// One tick: refresh the candidates, sync, check cq CI and the image, then plan.
export async function tickCmd(args: string[]): Promise<void> {
  const target = args.includes("--target") ? pyInt(nth(args, args.indexOf("--target") + 1)) : TARGET;
  const lock = new Flock("tick");
  if (!lock.acquire(false)) die("another tick is running", 0);
  let changed = false;
  try {
    print(`tick ${iso(now())}`);
    const [due, why] = queueDue(args.includes("--refresh"), target);
    print(`  team queue: ${due ? refreshQueue() : why}`);
    print(`  re-review lane: ${refreshRereview()}`);
    for (const l of sync()) {
      print(l.startsWith("  ") ? l : `  ${l}`);
      changed ||= !["sync: no changes", "sync: no open entries"].includes(l);
    }
    print(`  cq CI: ${refreshCqCi()}`);
    try {
      for (const l of await imageTick()) {
        print(`  image: ${l}`);
        // A pull or move started or running, or a slot released.
        changed ||= ["pulling", "pull running", "moving", "released"].some((w) => l.includes(w));
      }
    } catch (err) {
      if (!(err instanceof RuntimeError || isOSError(err) || isValueError(err))) throw err;
      print(`  image: check failed (${cut(pyStr(err), 0, 120)})`);
    }
  } finally {
    lock.release();
  }
  const [lines, counts] = plan(target);
  changed ||= lines.some((l) => l.startsWith("PREPARE"));
  listCmd(false, target);
  print(`plan: eligible candidates by lane: ${counts}`);
  print(lines.join("\n") || "plan: bank is full");
  print(recordTick(changed));
}
