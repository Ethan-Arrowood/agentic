// Bank entries: prs/<pr>.md, front matter then the prepared review.
import fs from "node:fs";
import path from "node:path";
import { DOSSIER, PRS } from "./config.ts";
import { die, git, iso, lines, now, parseIso, readText, removeTree, splitOnce, writeAtomic } from "./util.ts";

// screen: PRs that failed the automation screen or were unclear. The user
// handles them by hand; they need no preparing agent, so they come first.
export const LANES: readonly string[] = ["screen", "rereview-asap", "rereview", "cq", "fresh", "fresh-checked", "skip"];
// The re-review lane's buckets (rereview.py --tsv) that make a candidate.
export const LANE_OF_BUCKET = new Map([["RE-REVIEW-ASAP", "rereview-asap"], ["RE-REVIEW", "rereview"], ["CQ-CANDIDATE", "cq"]]);
export const STATES: readonly string[] = ["presented", "ready", "needs-run", "stale", "preparing", "waiting", "done"];
export const ACTIVE = new Set(["preparing", "needs-run", "ready", "stale"]);
// Dispositions the user chose. A done entry with one of these is not prepared
// again for the head the action covered. Automatic ones (closed, draft) don't block.
const USER_DISPOSITIONS = ["approved", "changes-requested", "commented", "labeled", "unlabeled", "skipped"];

// The front matter, in file order.
export const FIELDS = ["pr", "url", "title", "author", "lane", "state", "head", "pr_head", "acted_head", "created_at",
  "prepared_at", "presented_at", "updated_at", "my_teams", "rereview_from",
  "needs_run", "disposition", "disposition_at", "snooze_until", "lease", "note",
  "wait_since", "wait_for", "screen"] as const;
export type Field = (typeof FIELDS)[number];

// Every field is a string, "-" when unset. The body is the prepared review.
export type Entry = Record<Field, string> & { body: string };

export function isField(k: string): k is Field {
  return (FIELDS as readonly string[]).includes(k);
}

// Whether a field holds a value: not "-" (and not missing).
export function hasValue(v: string | null | undefined): v is string {
  return v !== null && v !== undefined && v !== "-";
}

export function isUserDisposition(disposition: string): boolean {
  return USER_DISPOSITIONS.some((d) => disposition.startsWith(d));
}

// A new entry: every field unset but those given.
export function newEntry(pr: string, fields: Partial<Entry> = {}): Entry {
  const e = Object.fromEntries(FIELDS.map((k) => [k, "-"])) as Record<Field, string>;
  return { ...e, body: "", ...fields, pr };
}

// A PR number from the command line, without leading zeros.
export function parsePr(s: string): string {
  if (!/^\d+$/.test(s.trim())) die(`not a PR number: ${s}`);
  return String(Number(s.trim()));
}

export function entryPath(pr: string): string {
  return path.join(PRS, `${pr}.md`);
}

export function load(pr: string): Entry | null {
  const p = entryPath(pr);
  if (!fs.existsSync(p)) return null;
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)/.exec(readText(p));
  if (!m) die(`${p} has no front matter`);
  const e = newEntry(pr);
  for (const line of lines(m[1])) {
    const [k, v] = splitOnce(line, ": ");
    if (isField(k.trim())) e[k.trim() as Field] = v.trim();
  }
  e.body = m[2];
  return e;
}

export function save(e: Entry): void {
  const head = FIELDS.map((k) => `${k}: ${e[k] || "-"}`).join("\n");
  writeAtomic(entryPath(e.pr), `---\n${head}\n---\n${e.body}`);
}

// Every entry, by PR number as text.
export function entries(): Entry[] {
  const names = fs.readdirSync(PRS).filter((f) => f.endsWith(".md")).sort();
  return names.map((f) => load(f.slice(0, -3))).filter((e) => e !== null);
}

export function snoozed(e: Entry): boolean {
  const until = parseIso(e.snooze_until);
  return until !== null && until > now();
}

// Priority order: awake first, then by lane, then the latest update first.
export function rankKey(e: Entry): number[] {
  const lane = LANES.includes(e.lane) ? LANES.indexOf(e.lane) : LANES.length;
  return [snoozed(e) ? 1 : 0, lane, -(parseIso(e.updated_at) ?? 0)];
}

// The head the user's action covered: the reviewed commit, else the head
// the entry was prepared against.
export function actedHead(e: Entry): string {
  return hasValue(e.acted_head) ? e.acted_head : e.head;
}

// Move an entry to done, save it, then drop its dossier and fetched ref.
// Saving first means a crash in between leaves a done entry with leftovers,
// never an open entry without its inputs.
export function finish(e: Entry, disposition: string, when: string | null = null): void {
  e.state = "done";
  e.disposition = disposition;
  e.disposition_at = when || iso(now());
  e.lease = "-";
  if (!hasValue(e.acted_head)) e.acted_head = e.head;
  save(e);
  dropInputs(e.pr);
}

// Remove an entry's dossier and fetched ref.
export function dropInputs(pr: string): void {
  removeTree(path.join(DOSSIER, pr));
  git(["update-ref", "-d", `refs/review-bank/${pr}`], { check: false });
}
