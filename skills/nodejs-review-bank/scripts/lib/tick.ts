// The tick: the loop's unit of work, and its backoff when nothing changes.
import { TICK_BACKOFF_BASE_MINUTES, TICK_BACKOFF_MAX_MINUTES, TICK_GRACE_MINUTES } from "./config.ts";
import { listCmd } from "./commands.ts";
import { imageTick } from "./images.ts";
import { Flock } from "./lock.ts";
import { plan, queueDue, refreshCqCi, refreshQueue, refreshRereview } from "./queue.ts";
import { sync } from "./sync.ts";
import { BankError, MINUTE, clip, die, isSystemError, iso, now, parseIso, print, readCacheJson, writeCacheJson } from "./util.ts";

// cache/tick.json
type TickState = { quiet: number; next_due: string | null; last: string | null };

// The user ran a bank command: note it, and end any tick backoff.
export function markActive(): void {
  writeCacheJson("activity.json", { at: iso(now()) });
  const st = readCacheJson<TickState>("tick.json");
  if (st.quiet || st.next_due) writeCacheJson("tick.json", { quiet: 0, next_due: null, last: st.last ?? null });
}

// The one line a backed-off tick prints, or null when a real tick is due.
// Reads only the cache: no gh, no git.
export function tickBackedOff(): string | null {
  if (TICK_BACKOFF_MAX_MINUTES <= 0) return null;
  const st = readCacheJson<TickState>("tick.json");
  const due = st.next_due ? parseIso(st.next_due) : null;
  if (due === null || now() >= due) return null;
  return `tick ${iso(now())}: backed off after ${st.quiet ?? 0} quiet ticks in a row; ` +
    `next real tick at ${iso(due)} (tick --now, sync, present, prefetch, or put runs sooner)`;
}

// Count quiet ticks and set when the next real one is due: on the base
// cadence after the first quiet tick, then 2x, 4x, ... up to
// TICK_BACKOFF_MAX_MINUTES. Any change resets it. Returns a report line.
function recordTick(changed: boolean): string {
  let st: TickState;
  if (changed || TICK_BACKOFF_MAX_MINUTES <= 0) {
    st = { quiet: 0, next_due: null, last: iso(now()) };
  } else {
    const quiet = (readCacheJson<TickState>("tick.json").quiet ?? 0) + 1;
    const mins = Math.min(TICK_BACKOFF_BASE_MINUTES * 2 ** (quiet - 1), TICK_BACKOFF_MAX_MINUTES);
    const due = mins > TICK_BACKOFF_BASE_MINUTES ? iso(now() + (mins - TICK_GRACE_MINUTES) * MINUTE) : null;
    st = { quiet, next_due: due, last: iso(now()) };
  }
  writeCacheJson("tick.json", st);
  if (!st.quiet) return "tick: changes this tick; next tick on the normal cadence";
  if (!st.next_due) return `tick: quiet (${st.quiet} in a row); next tick on the normal cadence`;
  return `tick: quiet (${st.quiet} in a row); backing off, next real tick at ${st.next_due}`;
}

// One tick: refresh the candidates, sync, check cq CI and the image, then plan.
export async function tickCmd(target: number, refresh: boolean): Promise<void> {
  const lock = new Flock("tick");
  if (!lock.acquire(false)) die("another tick is running", 0);
  let changed = false;
  try {
    print(`tick ${iso(now())}`);
    const [due, why] = queueDue(refresh, target);
    print(`  team queue: ${due ? refreshQueue() : why}`);
    print(`  re-review lane: ${refreshRereview()}`);
    for (const l of sync()) {
      print(l.startsWith("  ") ? l : `  ${l}`);
      changed ||= l !== "sync: no changes" && l !== "sync: no open entries";
    }
    print(`  cq CI: ${refreshCqCi()}`);
    try {
      for (const l of await imageTick()) {
        print(`  image: ${l}`);
        // A pull or move started or running, or a slot released.
        changed ||= ["pulling", "pull running", "moving", "released"].some((w) => l.includes(w));
      }
    } catch (err) {
      // The image check is best effort: a failed command, file, or time
      // in a record doesn't stop the tick.
      if (!(err instanceof BankError || isSystemError(err))) throw err;
      print(`  image: check failed (${clip(err.message, 120)})`);
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
