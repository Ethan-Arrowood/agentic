// Holds: a waiting entry and what wakes it.
import { SCREEN_HOURS } from "./config.ts";
import { type Entry, dropInputs, save } from "./entry.ts";
import { HOUR, iso, now, parseIso } from "./util.ts";

// A waiting entry's wake conditions, stored in wait_for as
// "reviews=1,push=<sha>,screen": reviews (a count of others' reviews), push
// (the head it waits to move from), landing (when the landing wait ends), ci
// (green CI at the head), until (a time), author (a comment by this login),
// and screen (a screen hold). A key can be present with no value.
export type WaitFor = {
  reviews?: string;
  push?: string;
  landing?: string;
  ci?: string;
  until?: string;
  author?: string;
  screen?: string;
};

export function wakeConditions(e: Entry): WaitFor {
  const w: Record<string, string> = {};
  for (const t of (e.wait_for || "-").split(",")) {
    if (t && t !== "-") {
      const i = t.indexOf("=");
      w[i < 0 ? t : t.slice(0, i)] = i < 0 ? "" : t.slice(i + 1);
    }
  }
  return w;
}

export function describeWait(e: Entry): string {
  const w = wakeConditions(e), parts: string[] = [];
  if (w.reviews !== undefined) parts.push(`${w.reviews} review(s) by others`);
  if (w.push !== undefined) parts.push(`a push past ${w.push}`);
  if (w.landing !== undefined) parts.push(`the landing wait (${w.landing})`);
  if (w.ci !== undefined) parts.push("green CI at the head");
  if (w.author !== undefined) parts.push(`a comment by @${w.author}`);
  if (w.until !== undefined) parts.push(w.until + (w.screen !== undefined ? " (then a close recommendation)" : ""));
  return `since ${e.wait_since}, wakes on ${parts.join(" or ") || "unhold only"}`;
}

// Wake conditions for a screened PR: the author comments or pushes, or
// SCREEN_HOURS pass.
export function screenConditions(e: Entry, author: string | null, head: string, since: string): WaitFor {
  const until = (parseIso(since) ?? now()) + SCREEN_HOURS * HOUR;
  return {
    author: author || e.author || "",
    push: head.slice(0, 12),
    until: iso(until),
    screen: "",
  };
}

// Move an entry to waiting and drop its inputs: on wake it is planned
// again, and others' reviews or a push make the old review stale anyway.
export function hold(e: Entry, conditions: WaitFor, since: string, note: string): void {
  Object.assign(e, { state: "waiting", wait_since: since, note, lease: "-" });
  e.wait_for = Object.entries(conditions).map(([k, v]) => (v ? `${k}=${v}` : k)).join(",") || "-";
  save(e);
  dropInputs(e.pr);
}

// End a hold. The entry is done, so plan puts the PR back in its lane.
export function wake(e: Entry, why: string[]): void {
  Object.assign(e, { state: "done", note: `woke: ${why.join("; ")}` });
  save(e);
}
