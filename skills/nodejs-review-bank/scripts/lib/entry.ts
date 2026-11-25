import { DOSSIER, PRS } from "./config.ts";
import { EPOCH, type Key, P, dict, exists, iso, now, parseIso, partition, pget, py, splitlines, stem, strip, unset } from "./py.ts";
import { die, git, readText, removeTree, writeAtomic } from "./util.ts";

import fs from "node:fs";

// screen: PRs that failed the automation screen or were unclear. The user
// handles them by hand; they need no preparing agent, so they come first.
export const LANES = ["screen", "rereview-asap", "rereview", "cq", "fresh", "fresh-checked", "skip"];
export const LANE_OF_BUCKET: Record<string, string> = dict({ "RE-REVIEW-ASAP": "rereview-asap", "RE-REVIEW": "rereview", "CQ-CANDIDATE": "cq" });
export const STATES = ["presented", "ready", "needs-run", "stale", "preparing", "waiting", "done"];
export const ACTIVE = new Set(["preparing", "needs-run", "ready", "stale"]);
// Dispositions the user chose. A done entry with one of these is not prepared
// again for the head the action covered. Automatic ones (closed, draft) don't block.
export const USER_DISPOSITIONS = ["approved", "changes-requested", "commented", "labeled", "unlabeled", "skipped"];
export const FIELDS = ["pr", "url", "title", "author", "lane", "state", "head", "pr_head", "acted_head", "created_at",
  "prepared_at", "presented_at", "updated_at", "my_teams", "rereview_from",
  "needs_run", "disposition", "disposition_at", "snooze_until", "lease", "note",
  "wait_since", "wait_for", "screen"];
export const SKIP_PATHS = new RegExp("^(lib/inspector\\.js|lib/internal/inspector/|src/inspector/|" +
  "lib/diagnostics_channel\\.js|lib/internal/diagnostics_channel|" +
  "src/node_diagnostics_channel)");

// An entry: its front matter (FIELDS) and body. Loaded entries hold strings
// ("-" for unset); entries built in memory can hold null where Python held None.
export type Entry = { pr: string; body?: string; [field: string]: any };
// A candidate from the team queue or the re-review lane.
export type Candidate = {
  pr: string; lane: string; head: string; updated: string; title?: string; author?: string;
  my_teams?: string; rereview_from?: string; note?: string; created?: string | null; labels?: string[];
};
export type Conditions = Record<string, string>;

export function entryPath(n: string): string {
  return P(PRS, `${n}.md`);
}

export function load(n: string): Entry | null {
  const p = entryPath(n);
  if (!exists(p)) return null;
  const text = readText(p);
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)/.exec(text);
  if (!m) die(`${p} has no front matter`);
  const meta: Entry = dict();
  for (const line of splitlines(m[1])) {
    const [k, , v] = partition(line, ": ");
    meta[strip(k)] = strip(v);
  }
  meta.body = m[2];
  return meta;
}

export function save(e: Entry): void {
  const head = FIELDS.map((k) => `${k}: ${e[k] || "-"}`).join("\n");
  writeAtomic(entryPath(e.pr), `---\n${head}\n---\n${e.body ?? ""}`);
}

export function entries(): Entry[] {
  const out: Entry[] = [];
  for (const name of fs.readdirSync(PRS).filter((f) => f.endsWith(".md")).sort()) {
    const e = load(stem(name));
    if (e) out.push(e);
  }
  return out;
}

export function snoozed(e: Entry): boolean {
  return (parseIso(e.snooze_until) ?? now()).t > now().t;
}

export function rank(e: Entry): Key[] {
  const lane = LANES.includes(e.lane) ? LANES.indexOf(e.lane) : LANES.length;
  const upd = -(parseIso(e.updated_at) ?? EPOCH).t / 1000;
  return [snoozed(e), lane, upd];
}

// The head the user's action covered: the reviewed commit, else the head
// the entry was prepared against.
export function actedHead(e: Entry): string {
  return !unset(e.acted_head) ? e.acted_head : e.head;
}

// Move an entry to done, save it, then drop its dossier and fetched ref.
// Saving first means a crash in between leaves a done entry with leftovers,
// never an open entry without its inputs.
export function finish(e: Entry, disposition: string, when: string | null = null): void {
  e.state = "done";
  e.disposition = disposition;
  e.disposition_at = when || iso(now());
  e.lease = "-";
  if (unset(e.acted_head)) e.acted_head = e.head;
  save(e);
  dropInputs(e.pr);
}

// Remove an entry's dossier and fetched ref.
export function dropInputs(n: string): void {
  removeTree(P(DOSSIER, String(n)));
  git(["update-ref", "-d", `refs/review-bank/${n}`], { check: false });
}

// A waiting entry's wait_for as a dict: reviews (count), push (the head
// it waits to move from), landing (when the landing wait ends), ci, until,
// author (a comment by this login), and screen (a screen hold).
export function wakeConditions(e: Entry): Conditions {
  const w: Conditions = dict();
  for (const t of (e.wait_for || "-").split(",")) {
    if (t && t !== "-") {
      const [k, , v] = partition(t, "=");
      w[k] = v;
    }
  }
  return w;
}

export function describeWait(e: Entry): string {
  const w = wakeConditions(e), parts: string[] = [];
  if ("reviews" in w) parts.push(`${w.reviews} review(s) by others`);
  if ("push" in w) parts.push(`a push past ${w.push}`);
  if ("landing" in w) parts.push(`the landing wait (${w.landing})`);
  if ("ci" in w) parts.push("green CI at the head");
  if ("author" in w) parts.push(`a comment by @${w.author}`);
  if ("until" in w) parts.push(w.until + ("screen" in w ? " (then a close recommendation)" : ""));
  return `since ${py(pget(e, "wait_since"))}, wakes on ` + (parts.join(" or ") || "unhold only");
}
