#!/usr/bin/env node
// A port of bank.py to TypeScript, function for function. Node runs it as is
// (type stripping): no dependencies, no build. Functions keep bank.py's names
// in camelCase and its order, so the two files diff side by side. The helpers
// under "Python compatibility" reproduce the Python behavior the port relies on.
const DOC = `nodejs-review-bank: a bank of prepared nodejs/node reviews on disk.

Deterministic parts of the skill. Every gh call goes through the bin/gh shim
(one gh call at a time across processes) and backs off on GitHub's secondary
rate limit. Read-only on GitHub: nothing here posts, labels, or reviews.

  bank.py tick [--refresh] [--now] [--target N]   refresh candidates, sync, prune, plan
  bank.py sync [PR...]                    re-read bank entries from GitHub, prune
  bank.py plan [--target N] [--all]       what to prepare next, in priority order (--all adds skips)
  bank.py list [--all]                    the bank, by priority
  bank.py show <pr>                       one entry
  bank.py present                         mark the top ready entry presented, show it
  bank.py prefetch <pr>                   fetch the PR's dossier and claim the entry (or screen it)
  bank.py put <pr> <summary.md> [--head <sha>]   bank a verified summary (ready or needs-run)
  bank.py set <pr> key=value...           edit entry fields (state=done disposition=skipped)
  bank.py hold <pr> [--until ISO] [--until-reviews N] [--until-author] [note]
                                          wait for others' reviews, a push, a time, or an author comment
  bank.py hold <pr> --screen [--until ISO] [note]   wait for the author after an automation screen (48 h)
  bank.py defer <pr> <reason...>          not worth reviewing yet: wait for the author, a push, a review, or DEFER_DAYS
  bank.py unhold <pr>                     end a hold now
  bank.py slot status|acquire <slot|any> <pr> [owner]|release <slot> <pr>|release <slot> --force
  bank.py image prune                     remove free slots' out/ volumes for unused images

Env: NODE_REVIEW_BANK (bank dir), NODE_CLONE (default ~/dev/nodejs/node),
REPO, ME, BANK_TARGET (default 6), REFRESH_MINUTES (default 120),
LEASE_MINUTES (default 120), RQ_SCRIPTS and NC_SCRIPTS (sibling skills' scripts),
BANK_METADATA (lanes that get metadata.txt: cq, all, or off; default cq),
DEVC_IMAGE, IMAGE_CHECK_MINUTES (default 60), DEVC_HUB_URL (Docker Hub tag API URL),
SCREEN_HOURS (how long a screened PR waits for its author; default 48),
DEFER_DAYS (how long a deferred PR waits at most; default 7),
REFRESH_MAX_HOURS (refresh the team queue at least this often, even when
dormant; default 6), DORMANT_HOURS (no user activity for this long makes the
bank dormant; default 4), REFRESH_RETRY_HOURS and REFRESH_RETRY_MAX_HOURS
(backoff after failed refreshes: 2, 4, 8 hours by default),
TICK_BACKOFF_BASE_MINUTES (the loop's cadence; default 20) and
TICK_BACKOFF_MAX_MINUTES (cap on the no-change backoff; default 240, 0 turns
it off).
`;
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Python compatibility. Not in bank.py: the pieces of Python's behavior the
// port needs to print, parse, and store the same things.
// ---------------------------------------------------------------------------

// Python's exception types, where bank.py catches or reports them by type.
class RuntimeError extends Error {}
class ValueError extends Error {}
class OSError extends Error {}
class KeyError extends Error {}
class AttributeError extends Error {}
class TimeoutExpired extends Error {
  stdout = "";
  stderr = "";
}
for (const c of [RuntimeError, ValueError, OSError, KeyError, AttributeError, TimeoutExpired]) c.prototype.name = c.name;
// sys.exit: thrown, so finally blocks and `using` locks unwind as in Python.
class SystemExit {
  code: number;
  constructor(code: number) {
    this.code = code;
  }
}

// OSError: ours, or a Node system error (ENOENT and the like).
function isOSError(err: unknown): boolean {
  const e = err as { code?: unknown; errno?: unknown };
  return err instanceof OSError || (err instanceof Error && typeof e.code === "string" && typeof e.errno === "number");
}

// ValueError: ours, or a JSON.parse failure (json.loads raises ValueError).
function isValueError(err: unknown): boolean {
  return err instanceof ValueError || err instanceof SyntaxError;
}

// str(err). A KeyError prints its key in quotes, as Python does.
function pyStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Synchronous writes, so output is never lost on exit and keeps its order
// with the output of child processes that share the file.
function write(fd: number, s: string): void {
  const b = Buffer.from(s);
  for (let off = 0; off < b.length; ) {
    try {
      off += fs.writeSync(fd, b, off);
    } catch (err) {
      if ((err as { code?: string }).code !== "EAGAIN") throw err;
      sleep(0.01);
    }
  }
}

// print(s), or print(s, file=sys.stderr) with fd 2.
function print(s = "", fd = 1): void {
  write(fd, `${s}\n`);
}

// time.sleep: blocks the thread, like everything else here.
function sleep(seconds: number): void {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

// What str.isspace() and Python's \s count as whitespace.
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const RSTRIP_RE = new RegExp(`[${WS}]+$`);
const SPLIT_RE = new RegExp(`[${WS}]+`);

function strip(s: string): string {
  return s.replace(STRIP_RE, "");
}

function rstrip(s: string): string {
  return s.replace(RSTRIP_RE, "");
}

// str.split() with no separator.
function splitWs(s: string): string[] {
  return s.split(SPLIT_RE).filter(Boolean);
}

// str.splitlines(): every line boundary Python knows, no trailing empty line.
function splitlines(s: string): string[] {
  const out = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (out.at(-1) === "") out.pop();
  return out;
}

// Universal newlines: Python's text mode turns \r\n and \r into \n.
function nl(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

function partition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

function rpartition(s: string, sep: string): [string, string, string] {
  const i = s.lastIndexOf(sep);
  return i < 0 ? ["", "", s] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

// s[start:end], counted in code points as Python does, not UTF-16 units.
function cut(s: string, start: number, end?: number): string {
  if (!/[\uD800-\uDFFF]/.test(s)) return s.slice(start, end);
  return Array.from(s).slice(start, end).join("");
}

// f"{s:<n}": pad to n code points.
function ljust(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - Array.from(s).length));
}

function startsWithAny(s: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => s.startsWith(p));
}

// How an f-string shows a value: None, True, False.
function py(v: unknown): string {
  return v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v);
}

function repr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// Python truthiness: empty lists, dicts, and strings are false.
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Set || v instanceof Map) return v.size > 0;
  if (v !== null && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

// unset(v): v in (None, "-").
function unset(v: unknown): boolean {
  return v === null || v === undefined || v === "-";
}

// dict.get(k, default): the default only when the key is missing.
function pget(o: any, k: string, d: any = null): any {
  return o !== null && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : d;
}

// d[k] on parsed JSON: KeyError when missing, TypeError on a non-dict.
function item(o: any, k: string): any {
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new TypeError(`${py(o)} is not a dict`);
  if (!Object.hasOwn(o, k)) throw new KeyError(repr(k));
  return o[k];
}

// args[i]: IndexError when it is missing.
function nth(xs: string[], i: number): string {
  if (i >= xs.length) throw new Error("IndexError: list index out of range");
  return xs[i];
}

// a, b = xs: ValueError unless xs has exactly n items.
function unpack<T>(xs: T[], n: number): T[] {
  if (xs.length !== n) {
    throw new ValueError(xs.length < n ? `not enough values to unpack (expected ${n}, got ${xs.length})`
      : `too many values to unpack (expected ${n})`);
  }
  return xs;
}

// A dict without Object.prototype, so any key is safe.
function dict<T = any>(o: object = {}): Record<string, T> {
  return Object.assign(Object.create(null), o);
}

// int(s) and float(s), with Python's accepted forms and its ValueError.
function pyInt(s: string | number): number {
  if (typeof s === "number") return Math.trunc(s);
  const m = new RegExp(`^[${WS}]*([+-]?\\d+(?:_\\d+)*)[${WS}]*$`).exec(s);
  if (!m) throw new ValueError(`invalid literal for int() with base 10: ${repr(s)}`);
  return Number(m[1].replaceAll("_", ""));
}

function pyFloat(s: string): number {
  const t = strip(s).replace(/(?<=\d)_(?=\d)/g, "");
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return Number(t);
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (m) return m[2].toLowerCase() === "nan" ? NaN : m[1] === "-" ? -Infinity : Infinity;
  throw new ValueError(`could not convert string to float: ${repr(s)}`);
}

// f"{x:.0f}": rounds half to even.
function fmt0(x: number): string {
  const f = Math.floor(x), d = x - f;
  return String(d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1);
}

// GATES_QUERY % (a, b, c): fill each %s in turn.
function pct(s: string, ...args: string[]): string {
  let i = 0;
  return s.replace(/%s/g, () => args[i++]);
}

// Regex pieces for Python's semantics. \w and \b are Unicode-aware in
// Python (use with the u flag). In MULTILINE mode ^ and $ match only at \n,
// and . never matches \n alone, where JS also stops at \r, \u2028, \u2029.
const W = "[\\p{L}\\p{N}_]";
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const BOL = "(?:(?<![\\s\\S])|(?<=\\n))";
const EOL = "(?=\\n|(?![\\s\\S]))";
const DOT = "[^\\n]";

// json.dumps: ", " and ": " separators (or one item per line with indent),
// and ensure_ascii, so files match what bank.py writes.
function jsonStr(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function dumps(v: any, indent?: number, level = 0): string {
  if (v === null || v === undefined) return "null";
  if (v === true || v === false) return String(v);
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : String(v);
  if (typeof v === "string") return jsonStr(v);
  const nlIn = indent === undefined ? "" : `\n${" ".repeat(indent * (level + 1))}`;
  const nlOut = indent === undefined ? "" : `\n${" ".repeat(indent * level)}`;
  const sep = indent === undefined ? ", " : ",";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[${v.map((x) => nlIn + dumps(x, indent, level + 1)).join(sep)}${nlOut}]`;
  }
  const ks = Object.keys(v);
  if (!ks.length) return "{}";
  return `{${ks.map((k) => `${nlIn}${jsonStr(k)}: ${dumps(v[k], indent, level + 1)}`).join(sep)}${nlOut}}`;
}

// Sorting: Python's stable sort on tuple keys, each key computed once.
type Key = number | string | boolean | null | Key[];

function cmp(a: Key, b: Key): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  const x = typeof a === "boolean" ? Number(a) : a, y = typeof b === "boolean" ? Number(b) : b;
  return (x as any) < (y as any) ? -1 : (x as any) > (y as any) ? 1 : 0;
}

function sorted<T>(xs: Iterable<T>, key: (x: T) => Key = (x) => x as Key): T[] {
  const dec = Array.from(xs, (x) => ({ x, k: key(x) }));
  dec.sort((a, b) => cmp(a.k, b.k));
  return dec.map((d) => d.x);
}

// An aware datetime: t is epoch milliseconds (microseconds in the fraction)
// and off the UTC offset in milliseconds. iso() prints the wall clock at
// off, like strftime on a datetime in that zone.
type Dt = { t: number; off: number };
const EPOCH: Dt = { t: 0, off: 0 };
const add = (d: Dt, ms: number): Dt => ({ t: d.t + ms, off: d.off });
// timedelta(hours=..., minutes=..., days=...), to the microsecond.
const hours = (x: number): number => Math.round(x * 3600e6) / 1000;
const minutes = (x: number): number => Math.round(x * 60e6) / 1000;
const days = (x: number): number => Math.round(x * 86400e6) / 1000;
// max(a, b) keeps the first of equal times.
const maxDt = (a: Dt, b: Dt): Dt => (b.t > a.t ? b : a);
// datetime.fromtimestamp(s, timezone.utc).replace(microsecond=0)
const fromTimestamp = (s: number): Dt => ({ t: Math.floor(s) * 1000, off: 0 });
// .date() as a day number, and .weekday() (Monday is 0) of one.
const dateOf = (d: Dt): number => Math.floor((d.t + d.off) / 86400000);
const weekday = (day: number): number => (((day + 3) % 7) + 7) % 7;

function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, 0);
  return dt.getTime();
}

function daysIn(y: number, mo: number): number {
  return new Date(utcMs(y, mo + 1, 0)).getUTCDate();
}

// datetime.fromisoformat (Python 3.11+): extended or basic dates, ISO week
// dates, any one-character separator, HH[:MM[:SS[.f]]], and a +HH[:MM[:SS]]
// offset. Null when Python would raise.
function fromIsoFormat(s: string): Dt | null {
  let m: RegExpExecArray | null, y: number, mo = 1, d = 1, len: number;
  if ((m = /^(\d{4})-W(\d\d)(?:-(\d))?/.exec(s)) || (m = /^(\d{4})W(\d\d)(\d)?/.exec(s))) {
    y = +m[1];
    const w = +m[2], wd = m[3] ? +m[3] : 1, jan4 = utcMs(y, 1, 4);
    const dec28 = utcMs(y, 12, 28), maxW = 1 + Math.floor((dateOf({ t: dec28, off: 0 }) - (dateOf({ t: jan4, off: 0 }) - weekday(dateOf({ t: jan4, off: 0 })))) / 7);
    if (y < 1 || w < 1 || w > maxW || wd < 1 || wd > 7) return null;
    const day = dateOf({ t: jan4, off: 0 }) - weekday(dateOf({ t: jan4, off: 0 })) + (w - 1) * 7 + wd - 1;
    const date = new Date(day * 86400000);
    [y, mo, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    len = m[0].length;
  } else if ((m = /^(\d{4})-(\d\d)-(\d\d)/.exec(s)) || (m = /^(\d{4})(\d\d)(\d\d)/.exec(s))) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
    len = m[0].length;
  } else {
    return null;
  }
  let t = utcMs(y, mo, d), off = 0;
  if (s.length > len) {
    const tm = /^(\d\d)(?::?(\d\d)(?::?(\d\d)(?:[.,](\d+))?)?)?(?:([+-])(\d\d)(?::?(\d\d)(?::?(\d\d)(?:\.(\d+))?)?)?)?$/.exec(s.slice(len + 1));
    if (!tm) return null;
    const h = +tm[1], mi = +(tm[2] ?? 0), sec = +(tm[3] ?? 0), us = tm[4] ? +tm[4].slice(0, 6).padEnd(6, "0") : 0;
    if (h > 24 || mi > 59 || sec > 59 || (h === 24 && (mi || sec || us))) return null;
    t += ((h * 60 + mi) * 60 + sec) * 1000 + us / 1000;
    if (tm[5]) {
      const oh = +tm[6], om = +(tm[7] ?? 0), os_ = +(tm[8] ?? 0), ous = tm[9] ? +tm[9].slice(0, 6).padEnd(6, "0") : 0;
      if (oh > 23 || om > 59 || os_ > 59) return null;
      off = (tm[5] === "-" ? -1 : 1) * (((oh * 60 + om) * 60 + os_) * 1000 + ous / 1000);
    }
  }
  return { t: t - off, off };
}

// Paths as pathlib prints them: joined with /, without "." parts, doubled
// or trailing slashes. ".." stays, as in pathlib.
function P(...parts: string[]): string {
  let s = "";
  for (const p of parts) s = p.startsWith("/") ? p : s ? `${s}/${p}` : p;
  const lead = s.startsWith("//") && !s.startsWith("///") ? "//" : s.startsWith("/") ? "/" : "";
  return lead + s.split("/").filter((x) => x && x !== ".").join("/") || (lead || ".");
}

// Path.resolve(): symlinks resolved as far as the path exists.
function resolvePath(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.resolve(p);
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

// Path.stem
function stem(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

function readText(p: string): string {
  return nl(fs.readFileSync(p, "utf8"));
}

function writeText(p: string, s: string): void {
  fs.writeFileSync(p, s);
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// shutil.rmtree(p, ignore_errors=True)
function rmtree(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore_errors
  }
}

function mtime(p: string): number {
  return fs.statSync(p).mtimeMs / 1000;
}

function environ(k: string): string {
  const v = process.env[k];
  if (v === undefined) throw new KeyError(repr(k));
  return v;
}

const STRERROR: Record<string, string> = {
  ENOENT: "No such file or directory", EACCES: "Permission denied", ENOTDIR: "Not a directory",
  ENOEXEC: "Exec format error", E2BIG: "Argument list too long",
};

// subprocess.run. stdin is inherited, as in Python. Output is text with
// universal newlines. stderr "stdout" merges the two (stderr=STDOUT) through
// one unlinked temp file, so they interleave as written. A command that can't
// start raises OSError; a timeout kills it and raises TimeoutExpired.
type Proc = { returncode: number; stdout: string; stderr: string };
type Stream = "pipe" | "inherit" | "devnull";
type RunOpts = { env?: NodeJS.ProcessEnv; cwd?: string; stdout?: Stream; stderr?: Stream | "stdout"; timeout?: number };

function run(cmd: string[], o: RunOpts = {}): Proc {
  const map = (s: Stream) => (s === "devnull" ? "ignore" : s);
  const stdio: any[] = ["inherit", map(o.stdout ?? "pipe"), o.stderr === "stdout" ? "pipe" : map(o.stderr ?? "pipe")];
  let merged = -1;
  if (o.stderr === "stdout") {
    const tmp = P(os.tmpdir(), `bank-out-${process.pid}-${randomBytes(6).toString("hex")}`);
    merged = fs.openSync(tmp, "w+", 0o600);
    fs.unlinkSync(tmp);
    stdio[1] = stdio[2] = merged;
  }
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), {
      env: o.env, cwd: o.cwd, stdio, maxBuffer: 2 ** 30, killSignal: "SIGKILL",
      timeout: o.timeout === undefined ? undefined : o.timeout * 1000,
    });
    let stdout = r.stdout ? nl(r.stdout.toString()) : "";
    const stderr = r.stderr ? nl(r.stderr.toString()) : "";
    if (merged >= 0) {
      const buf = Buffer.alloc(fs.fstatSync(merged).size);
      fs.readSync(merged, buf, 0, buf.length, 0);
      stdout = nl(buf.toString());
    }
    const err = r.error as (Error & { code?: string; errno?: number }) | undefined;
    if (err?.code === "ETIMEDOUT") {
      const t = new TimeoutExpired(`Command '${cmd.join(" ")}' timed out after ${o.timeout} seconds`);
      t.stdout = stdout;
      t.stderr = stderr;
      throw t;
    }
    if (err) {
      throw new OSError(`[Errno ${Math.abs(err.errno ?? 0)}] ${STRERROR[err.code ?? ""] ?? err.code}: ${repr(cmd[0])}`);
    }
    return { returncode: r.status ?? -(os.constants.signals[r.signal as keyof typeof os.constants.signals] ?? 0), stdout, stderr };
  } finally {
    if (merged >= 0) fs.closeSync(merged);
  }
}

// ---------------------------------------------------------------------------
// bank.py
// ---------------------------------------------------------------------------

const THIS = fs.realpathSync(fileURLToPath(import.meta.url));
const HERE = path.dirname(THIS);
const RQ = resolvePath(process.env.RQ_SCRIPTS ?? P(HERE, "../../nodejs-review-queue/scripts"));
const NC = resolvePath(process.env.NC_SCRIPTS ?? P(HERE, "../../nodejs-contribute/scripts"));
const STATE_HOME = process.env.XDG_STATE_HOME || P(os.homedir(), ".local/state");
const BANK = P(process.env.NODE_REVIEW_BANK || P(STATE_HOME, "nodejs-review-bank"));
const CLONE = P(process.env.NODE_CLONE || P(os.homedir(), "dev/nodejs/node"));
const REPO = process.env.REPO ?? "nodejs/node";
const [OWNER, NAME] = unpack(REPO.split("/"), 2);
const TARGET = pyInt(process.env.BANK_TARGET ?? "6");
const REFRESH_MIN = pyInt(process.env.REFRESH_MINUTES ?? "120");
const LEASE_MIN = pyInt(process.env.LEASE_MINUTES ?? "120");
const RETRY_SLEEP = pyFloat(process.env.GH_RETRY_SLEEP ?? "60");
const CQ_CI_MAX_AGE = 30 * 60;
const CQ_CI_PER_TICK = 5;
const SLOT_OWNERLESS_GRACE = 60;
const DEVC_IMAGE = process.env.DEVC_IMAGE ?? "docker.io/nodejs/devcontainer:nightly";
const IMAGE_CHECK_MIN = pyInt(process.env.IMAGE_CHECK_MINUTES ?? "60");
const MOVE = "image-move"; // slot owner and PR while a slot moves to the new image
const SCREEN_HOURS = pyInt(process.env.SCREEN_HOURS ?? "48");
const DEFER_DAYS = pyFloat(process.env.DEFER_DAYS ?? "7");
const REFRESH_MAX_HOURS = pyFloat(process.env.REFRESH_MAX_HOURS ?? "6");
const DORMANT_HOURS = pyFloat(process.env.DORMANT_HOURS ?? "4");
const REFRESH_RETRY_HOURS = pyFloat(process.env.REFRESH_RETRY_HOURS ?? "2");
const REFRESH_RETRY_MAX_HOURS = pyFloat(process.env.REFRESH_RETRY_MAX_HOURS ?? "8");
const TICK_BASE_MIN = pyFloat(process.env.TICK_BACKOFF_BASE_MINUTES ?? "20");
const TICK_MAX_MIN = pyFloat(process.env.TICK_BACKOFF_MAX_MINUTES ?? "240");
const TICK_GRACE_MIN = 2; // a cron firing a little early still counts as due

const [PRS, DOSSIER, CACHE, LOCKS, ARCHIVE] = ["prs", "dossier", "cache", "locks", "archive"].map((d) => P(BANK, d));
for (const d of [PRS, DOSSIER, CACHE, LOCKS, ARCHIVE]) fs.mkdirSync(d, { recursive: true });

const ENV: NodeJS.ProcessEnv = { ...process.env, NODE_REVIEW_BANK: BANK, PATH: `${P(HERE, "bin")}:${environ("PATH")}` };

// screen: PRs that failed the automation screen or were unclear. The user
// handles them by hand; they need no preparing agent, so they come first.
const LANES = ["screen", "rereview-asap", "rereview", "cq", "fresh", "fresh-checked", "skip"];
const LANE_OF_BUCKET: Record<string, string> = dict({ "RE-REVIEW-ASAP": "rereview-asap", "RE-REVIEW": "rereview", "CQ-CANDIDATE": "cq" });
const STATES = ["presented", "ready", "needs-run", "stale", "preparing", "waiting", "done"];
const ACTIVE = new Set(["preparing", "needs-run", "ready", "stale"]);
// Dispositions the user chose. A done entry with one of these is not prepared
// again for the head the action covered. Automatic ones (closed, draft) don't block.
const USER_DISPOSITIONS = ["approved", "changes-requested", "commented", "labeled", "unlabeled", "skipped"];
const FIELDS = ["pr", "url", "title", "author", "lane", "state", "head", "pr_head", "acted_head", "created_at",
  "prepared_at", "presented_at", "updated_at", "my_teams", "rereview_from",
  "needs_run", "disposition", "disposition_at", "snooze_until", "lease", "note",
  "wait_since", "wait_for", "screen"];
const SKIP_PATHS = new RegExp("^(lib/inspector\\.js|lib/internal/inspector/|src/inspector/|" +
  "lib/diagnostics_channel\\.js|lib/internal/diagnostics_channel|" +
  "src/node_diagnostics_channel)");

// An entry: its front matter (FIELDS) and body. Loaded entries hold strings
// ("-" for unset); entries built in memory can hold null where Python held None.
type Entry = { pr: string; body?: string; [field: string]: any };
// A candidate from the team queue or the re-review lane.
type Candidate = {
  pr: string; lane: string; head: string; updated: string; title?: string; author?: string;
  my_teams?: string; rereview_from?: string; note?: string; created?: string | null; labels?: string[];
};
type Conditions = Record<string, string>;

function now(): Dt {
  return { t: Math.floor(Date.now() / 1000) * 1000, off: 0 };
}

function iso(dt: Dt): string {
  if (!dt) throw new AttributeError("'NoneType' object has no attribute 'strftime'");
  const d = new Date(Math.floor(dt.t + dt.off));
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
}

// An aware datetime. A time without a zone is taken as UTC.
function parseIso(s: string | null | undefined): Dt | null {
  if (!s || s === "-") return null;
  const t = strip(s).replaceAll("Z", "+00:00");
  const dt = fromIsoFormat(t);
  if (!dt) throw new ValueError(`Invalid isoformat string: ${repr(t)}`);
  return dt;
}

function die(msg: string, code = 1): never {
  print(`bank: ${msg}`, 2);
  throw new SystemExit(code);
}

// Replace path in one step, so a reader never sees a partial file.
function writeAtomic(p: string, text: string): void {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789_";
  let fd = -1, tmp = "";
  for (let i = 0; fd < 0; i++) {
    tmp = P(path.dirname(p), `.${path.basename(p)}.${Array.from(randomBytes(8), (b) => chars[b % chars.length]).join("")}.tmp`);
    try {
      fd = fs.openSync(tmp, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST" || i > 100) throw err;
    }
  }
  try {
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

let ME = process.env.ME;

function me(): string {
  if (!ME) ME = strip(gh("api", "user", "--jq", ".login"));
  ENV.ME = ME;
  return ME;
}

// One gh call through the serializing shim. Backs off 1 to 5 minutes on
// the secondary rate limit, like nodejs-review-queue's gh_retry, but keeps
// stdout on failure (gh api graphql prints the response and exits 1 when it
// has errors).
function ghRun(...args: string[]): Proc {
  for (let attempt = 1; ; attempt++) {
    const p = run(["gh", ...args], { env: ENV });
    if (p.returncode === 0 || !p.stderr.toLowerCase().includes("secondary rate limit") || attempt === 6) return p;
    print(`  (gh backoff #${attempt}, sleeping ${fmt0(attempt * RETRY_SLEEP)}s)`, 2);
    sleep(attempt * RETRY_SLEEP);
  }
}

function gh(...args: string[]): string {
  const p = ghRun(...args);
  if (p.returncode !== 0) throw new RuntimeError(`gh ${args.slice(0, 3).join(" ")}: ${cut(strip(p.stderr), -300)}`);
  return p.stdout;
}

function graphql(query: string): any {
  const qf = P(CACHE, `query-${process.pid}.graphql`);
  writeText(qf, query);
  let p: Proc;
  try {
    p = ghRun("api", "graphql", "-F", `query=@${qf}`);
  } finally {
    fs.rmSync(qf, { force: true });
  }
  let data: any;
  try {
    data = JSON.parse(p.stdout);
  } catch {
    throw new RuntimeError(`graphql: ${cut(strip(p.stderr), -300) || "no response"}`);
  }
  // A deleted PR comes back as a null alias plus a NOT_FOUND error. Callers
  // treat a missing alias as not found.
  const errs = (data.errors || []).filter((e: any) => pget(e, "type") !== "NOT_FOUND");
  if (errs.length || !truthy(data.data)) {
    // A rate limit or server error has no "errors" list, only a
    // top-level message (or nothing but stderr).
    const why = (errs.length ? pget(errs[0], "message") : pget(data, "message")) || cut(strip(p.stderr), -200)
      || `exit ${p.returncode}, no data`;
    throw new RuntimeError(`graphql: ${why}`);
  }
  return data.data.repository;
}

function git(args: string[], { check = true } = {}): string {
  const p = run(["git", "-C", CLONE, ...args]);
  if (check && p.returncode !== 0) throw new RuntimeError(`git ${args.slice(0, 3).join(" ")}: ${cut(strip(p.stderr), -300)}`);
  return p.stdout;
}

// Locks. Python holds an fcntl lock on an open file. Node has no file lock,
// so each held lock is a small zsh process that holds a zsystem flock (an
// fcntl lock, the same kind the bin/gh shim takes; on macOS it also excludes
// bank.py's flock). The helper's stdin and stdout are FIFOs:
//   - acquire blocks in a plain readSync on the helper's stdout until it
//     prints "locked" (got it) or exits without it (busy with -t 0, or failed).
//     A FIFO read end opened without O_NONBLOCK blocks, unlike Node's pipes.
//   - release closes the helper's stdin. It reads EOF, unlocks, and exits,
//     and the readSync that waits for its stdout to close returns then.
// The kernel drops the lock when the helper exits. The helper exits when this
// process dies (its stdin closes), so a crash can't leave a lock stuck, as with
// Python's fcntl locks. Node opens files close-on-exec, so no other child
// keeps a helper's stdin open.
const LOCK_HELPER = [
  "zmodload zsh/system || exit 1",
  'zsystem flock "${@:2}" -f fd "$1" || exit 1',
  "print locked",
  "read -r _",
  "zsystem flock -u $fd",
].join("\n");

type Held = { stdin: number; stdout: number };

// Both ends of a FIFO without blocking on open: a non-blocking reader lets
// the writer open, and the writer lets a second, blocking reader open.
function fifoEnds(p: string): [number, number] {
  const { O_RDONLY, O_WRONLY, O_NONBLOCK } = fs.constants;
  const probe = fs.openSync(p, O_RDONLY | O_NONBLOCK);
  const w = fs.openSync(p, O_WRONLY);
  const r = fs.openSync(p, O_RDONLY);
  fs.closeSync(probe);
  return [r, w];
}

function zshFlock(file: string, wait: boolean): Held | null {
  fs.closeSync(fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o644));
  const dir = fs.mkdtempSync(P(os.tmpdir(), "bank-lock-"));
  try {
    const fin = P(dir, "in"), fout = P(dir, "out");
    if (spawnSync("mkfifo", ["-m", "600", fin, fout]).status !== 0) throw new OSError(`mkfifo failed in ${dir}`);
    const [inR, inW] = fifoEnds(fin), [outR, outW] = fifoEnds(fout);
    let child;
    try {
      child = spawnChild("zsh", ["-fc", LOCK_HELPER, "bank-lock", path.resolve(file), ...(wait ? [] : ["-t", "0"])],
        { stdio: [inR, outW, "ignore"] });
    } finally {
      fs.closeSync(inR);
      fs.closeSync(outW);
    }
    child.on("error", () => {});
    child.unref();
    if (!child.pid) {
      fs.closeSync(inW);
      fs.closeSync(outR);
      throw new OSError(`could not run zsh to lock ${file}`);
    }
    const buf = Buffer.alloc(64);
    let got = "";
    for (let k; !got.includes("\n") && (k = fs.readSync(outR, buf, 0, buf.length, null)); ) got += buf.toString("utf8", 0, k);
    if (got !== "locked\n") {
      fs.closeSync(inW);
      fs.closeSync(outR);
      return null;
    }
    return { stdin: inW, stdout: outR };
  } finally {
    rmtree(dir);
  }
}

function unlock(h: Held): void {
  fs.closeSync(h.stdin);
  const buf = Buffer.alloc(64);
  while (fs.readSync(h.stdout, buf, 0, buf.length, null));
  fs.closeSync(h.stdout);
}

// A lock held for the life of this process. The kernel drops it when the
// holder exits, so a crash can't leave it stuck. `using lock = x.enter()`
// is Python's `with`.
class Flock {
  path: string;
  held: Held | null = null;

  constructor(name: string) {
    this.path = P(LOCKS, `${name}.lock`);
  }

  acquire(wait = true): boolean {
    this.held = zshFlock(this.path, wait);
    return this.held !== null;
  }

  release(): void {
    if (this.held) {
      unlock(this.held);
      this.held = null;
    }
  }

  enter(): this {
    this.acquire();
    return this;
  }

  [Symbol.dispose](): void {
    this.release();
  }
}

function entryLock(n: string): Flock {
  return new Flock(`entry-${n}`);
}

// A slot is held across processes (acquire and release are separate
// commands), so it is a directory with an owner record, not a Flock. Callers
// hold Flock("slots") while they change one.
class SlotLock {
  path: string;

  constructor(name: string) {
    this.path = P(LOCKS, `slot-${name}`);
  }

  holder(): any {
    try {
      return JSON.parse(readText(P(this.path, "owner.json")));
    } catch (err) {
      if (isOSError(err) || isValueError(err)) return null;
      throw err;
    }
  }

  // mtime of a lock dir that has no owner record, or null.
  ownerlessSince(): Dt | null {
    if (!isDir(this.path) || truthy(this.holder())) return null;
    return fromTimestamp(mtime(this.path));
  }

  acquire(info: object): boolean {
    const since = this.ownerlessSince();
    if (since && (now().t - since.t) / 1000 > SLOT_OWNERLESS_GRACE) this.release();
    try {
      fs.mkdirSync(this.path);
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") return false;
      throw err;
    }
    writeAtomic(P(this.path, "owner.json"), dumps(info));
    return true;
  }

  release(): void {
    // rmtree, not rmdir: a crash during acquire can leave a temp file.
    rmtree(this.path);
  }
}

function entryPath(n: string): string {
  return P(PRS, `${n}.md`);
}

function load(n: string): Entry | null {
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

function save(e: Entry): void {
  const head = FIELDS.map((k) => `${k}: ${e[k] || "-"}`).join("\n");
  writeAtomic(entryPath(e.pr), `---\n${head}\n---\n${e.body ?? ""}`);
}

function entries(): Entry[] {
  const out: Entry[] = [];
  for (const name of fs.readdirSync(PRS).filter((f) => f.endsWith(".md")).sort()) {
    const e = load(stem(name));
    if (e) out.push(e);
  }
  return out;
}

function snoozed(e: Entry): boolean {
  return (parseIso(e.snooze_until) ?? now()).t > now().t;
}

function rank(e: Entry): Key[] {
  const lane = LANES.includes(e.lane) ? LANES.indexOf(e.lane) : LANES.length;
  const upd = -(parseIso(e.updated_at) ?? EPOCH).t / 1000;
  return [snoozed(e), lane, upd];
}

// The head the user's action covered: the reviewed commit, else the head
// the entry was prepared against.
function actedHead(e: Entry): string {
  return !unset(e.acted_head) ? e.acted_head : e.head;
}

// Move an entry to done, save it, then drop its dossier and fetched ref.
// Saving first means a crash in between leaves a done entry with leftovers,
// never an open entry without its inputs.
function finish(e: Entry, disposition: string, when: string | null = null): void {
  e.state = "done";
  e.disposition = disposition;
  e.disposition_at = when || iso(now());
  e.lease = "-";
  if (unset(e.acted_head)) e.acted_head = e.head;
  save(e);
  dropInputs(e.pr);
}

// Remove an entry's dossier and fetched ref.
function dropInputs(n: string): void {
  rmtree(P(DOSSIER, String(n)));
  git(["update-ref", "-d", `refs/review-bank/${n}`], { check: false });
}

function readTsv(name: string): string[][] {
  const p = P(CACHE, name);
  if (!exists(p)) return [];
  return splitlines(readText(p)).filter((l) => strip(l)).map((l) => l.split("\t"));
}

// Team-routed queue via build-queue.sh. On INCOMPLETE, keep the old rows
// and add the new ones, so a partial run never shrinks the queue. The rows
// are kept even when the metadata fetch fails, and the tick goes on. The
// stamp is written only after both succeed. Every attempt is recorded in
// queue-attempt.json, so a failure backs off instead of retrying (and
// spending about 20 minutes of searches) on every tick.
function refreshQueue(): string {
  const p = run(["zsh", P(RQ, "build-queue.sh")], { env: ENV });
  writeText(P(CACHE, "queue.log"), p.stderr);
  let rows = new Map<string, string>();
  for (const l of splitlines(p.stdout)) if (strip(l)) rows.set(l.split("\t")[0], l);
  let status: string;
  if (p.returncode !== 0) {
    const old = new Map(readTsv("queue.tsv").map((r) => [r[0], r.join("\t")] as const));
    for (const [k, v] of rows) old.set(k, v);
    rows = old;
    status = `INCOMPLETE (${splitlines(strip(p.stderr)).at(-1) ?? "?"}); kept previous rows`;
  } else {
    status = `${rows.size} PRs`;
  }
  writeAtomic(P(CACHE, "queue.tsv"), [...rows.values()].map((l) => `${l}\n`).join(""));
  let ok = p.returncode === 0;
  try {
    fetchMeta([...rows.keys()].map((n) => pyInt(n)));
  } catch (err) {
    if (!(err instanceof RuntimeError)) throw err;
    status = `${status}; candidate metadata FAILED (${cut(err.message, 0, 120)}), kept the previous metadata`;
    ok = false;
  }
  if (ok) writeText(P(CACHE, "queue.stamp"), iso(now()));
  const prev = readCacheJson("queue-attempt.json");
  const attempt: any = { at: iso(now()), failures: ok ? 0 : pget(prev, "failures", 0) + 1 };
  if (!ok) attempt.error = status;
  writeAtomic(P(CACHE, "queue-attempt.json"), dumps(attempt));
  if (ok) return status;
  return `${status}; failed ${attempt.failures} time(s) in a row, ` +
    `next try after ${iso(refreshRetryAt(attempt)!)}`;
}

// When a failed refresh may be tried again: 2, 4, then 8 hours after
// the last attempt, by default. Null after a success.
function refreshRetryAt(attempt: any): Dt | null {
  const f = pget(attempt, "failures", 0);
  if (!f || !pget(attempt, "at")) return null;
  const h = Math.min(REFRESH_RETRY_HOURS * 2 ** (f - 1), REFRESH_RETRY_MAX_HOURS);
  return add(parseIso(attempt.at)!, hours(h));
}

// How many new candidates plan could take, from the entries alone (the
// same count plan uses, so it needs no candidate data).
function roomNow(target = TARGET): number {
  const es = entries();
  const active = es.filter((e) => ACTIVE.has(e.state) && e.state !== "stale" && e.lane !== "screen");
  const stale = es.filter((e) => e.state === "stale");
  return Math.max(0, target - active.length - stale.length);
}

// The latest sign the user is around: a sync, present, prefetch, put,
// set, hold, or unhold they ran, or an action of theirs that a sync read
// back from GitHub.
function lastActivity(): Dt | null {
  const times: any[] = [pget(readCacheJson("activity.json"), "at")];
  times.push(...entries().filter((e) => startsWithAny(pget(e, "disposition", "-"), USER_DISPOSITIONS))
    .map((e) => pget(e, "disposition_at")));
  const ts = times.filter((t) => t && t !== "-").map((t) => parseIso(t));
  let best: Dt | null = null;
  for (const t of ts) if (t && (!best || t.t > best.t)) best = t;
  return best;
}

// Why fresh candidates aren't needed now, or null.
function dormant(target = TARGET): string | null {
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
function queueDue(force: boolean, target = TARGET): [boolean, string | null] {
  if (force) return [true, null];
  const attempt = readCacheJson("queue-attempt.json");
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
  if (age <= minutes(REFRESH_MIN)) return [false, `cached from ${iso(stamp)} (REFRESH_MINUTES=${REFRESH_MIN})`];
  if (age > hours(REFRESH_MAX_HOURS)) return [true, null];
  const why = dormant(target);
  if (why) {
    const by = add(stamp, hours(REFRESH_MAX_HOURS));
    return [false, `cached from ${iso(stamp)}; dormant (${why}), refreshing by ${iso(by)}`];
  }
  return [true, null];
}

// The user ran a bank command: note it, and end any tick backoff.
function markActive(): void {
  writeAtomic(P(CACHE, "activity.json"), dumps({ at: iso(now()) }));
  const st = readCacheJson("tick.json");
  if (pget(st, "quiet") || pget(st, "next_due")) {
    writeAtomic(P(CACHE, "tick.json"), dumps({ quiet: 0, next_due: null, last: pget(st, "last") }));
  }
}

// The one line a backed-off tick prints, or null when a real tick is due.
// Reads only the cache: no gh, no git.
function tickBackedOff(): string | null {
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
function recordTick(changed: boolean): string {
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

// Title, author, draft, state, head, updatedAt, and paths for ranking.
function fetchMeta(nums: number[]): void {
  const meta: Record<string, any> = dict();
  for (let i = 0; i < nums.length; i += 40) {
    const fields = nums.slice(i, i + 40).map((n) =>
      `p${n}: pullRequest(number:${n}){number title isDraft state updatedAt headRefOid ` +
      "author{login} files(first:100){nodes{path}}}").join(" ");
    const repo = graphql(`query{repository(owner:"${OWNER}",name:"${NAME}"){${fields}}}`);
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

function refreshRereview(): string {
  const p = run(["python3", P(RQ, "rereview.py"), "--tsv"], { env: ENV });
  if (p.returncode !== 0) return `FAILED (${cut(splitlines(strip(p.stderr)).at(-1) ?? "?", 0, 120)}); kept previous rows`;
  writeAtomic(P(CACHE, "rereview.tsv"), p.stdout);
  return `${splitlines(p.stdout).length} reviewed PRs`;
}

function readCi(): any {
  const p = P(CACHE, "ci.json");
  return exists(p) ? JSON.parse(readText(p)) : {};
}

// Whether a cached ci-status.sh result is for this head.
function ciAt(r: any, head: string): boolean {
  return Boolean(truthy(r) && pget(r, "head") && head.startsWith(r.head));
}

// When nodejs-contribute's Landing wait ends: 48 hours after the PR
// opened, 72 when those hours touch a Saturday or Sunday (UTC), and none
// with fast-track. Null when the open time is unknown.
function landingAt(created: string | null | undefined, labels: Iterable<string>): Dt | null {
  const t = parseIso(created);
  if (!t) return null;
  if ([...labels].includes("fast-track")) return t;
  const end = add(t, hours(48));
  let weekend = false;
  for (let i = 0; i < dateOf(end) - dateOf(t) + 1; i++) if (weekday(dateOf(t) + i) >= 5) weekend = true;
  return weekend ? add(t, hours(72)) : end;
}

// ci-status.sh for cq candidates whose cached result is missing, for
// another head, or older than CQ_CI_MAX_AGE, oldest result first, skipping
// candidates plan would skip anyway. plan reads the cache. A result is keyed
// by the head ci-status.sh reports, which can differ from the candidate's.
function refreshCqCi(): string {
  const ci = readCi(), bank = new Map(entries().map((e) => [e.pr, e] as const));
  let ran = 0;
  let todo: Candidate[] = [];
  for (const c of rankedCandidates()) {
    const e = bank.get(c.pr) ?? null;
    const held = e && e.state === "waiting" && "ci" in wakeConditions(e);
    if (c.lane !== "cq" || (e && e.state !== "done" && !held) || skipReason(c, e)) continue;
    const r = pget(ci, c.pr);
    if (ciAt(r, c.head) && (now().t - parseIso(r.at)!.t) / 1000 < CQ_CI_MAX_AGE) continue;
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

const SKIP_PREFIX = new RegExp(`${B}(inspector|diagnostics_channel)${B}`, "u");

function isSkip(title: string, paths: string[]): boolean {
  const prefix = title.includes(":") ? title.split(":", 1)[0] : "";
  if (SKIP_PREFIX.test(prefix)) return true;
  const code = paths.filter((p) => !startsWithAny(p, ["test/", "doc/"]));
  return code.length > 0 && code.every((p) => SKIP_PATHS.test(p));
}

// All candidates with their lane, newest update first within a lane.
function rankedCandidates(): Candidate[] {
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
function skipReason(c: Candidate, e: Entry | null): string | null {
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

function plan(target = TARGET, showAll = false): [string[], string] {
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

const SYNC_FIELDS = (
  "number title state isDraft createdAt updatedAt closedAt headRefOid author{login} " +
  "labels(first:50){nodes{name}} " +
  "allReviews: reviews(last:50){nodes{author{login} submittedAt}} " +
  'reviews(last:30,author:"%s"){nodes{state submittedAt commit{oid}}} ' +
  "comments(last:30){nodes{author{__typename login} createdAt body}} " +
  "timelineItems(last:50,itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){nodes{__typename " +
  "...on LabeledEvent{createdAt actor{login} label{name}} " +
  "...on UnlabeledEvent{createdAt actor{login} label{name}}}}");
const LANDED = new RegExp(`${BOL}[${WS}]*Landed in ([0-9a-f]{7,40})`);

function sync(only: Set<string> | null = null): string[] {
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

function syncEntry(e: Entry, d: any, rr: Map<string, string[]>): string[] {
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
function myActions(d: any, since: Dt): [string, string, string | null] | null {
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

// A waiting entry's wait_for as a dict: reviews (count), push (the head
// it waits to move from), landing (when the landing wait ends), ci, until,
// author (a comment by this login), and screen (a screen hold).
function wakeConditions(e: Entry): Conditions {
  const w: Conditions = dict();
  for (const t of (e.wait_for || "-").split(",")) {
    if (t && t !== "-") {
      const [k, , v] = partition(t, "=");
      w[k] = v;
    }
  }
  return w;
}

function describeWait(e: Entry): string {
  const w = wakeConditions(e), parts: string[] = [];
  if ("reviews" in w) parts.push(`${w.reviews} review(s) by others`);
  if ("push" in w) parts.push(`a push past ${w.push}`);
  if ("landing" in w) parts.push(`the landing wait (${w.landing})`);
  if ("ci" in w) parts.push("green CI at the head");
  if ("author" in w) parts.push(`a comment by @${w.author}`);
  if ("until" in w) parts.push(w.until + ("screen" in w ? " (then a close recommendation)" : ""));
  return `since ${py(pget(e, "wait_since"))}, wakes on ` + (parts.join(" or ") || "unhold only");
}

// Wake conditions for a screened PR: the author comments or pushes, or
// SCREEN_HOURS pass.
function screenConditions(e: Entry, author: string | null, head: string | null, since: string): Conditions {
  const until = add(parseIso(since) ?? now(), hours(SCREEN_HOURS));
  return {
    author: author || pget(e, "author") || "", push: (head || pget(e, "pr_head") || e.head).slice(0, 12),
    until: iso(until), screen: "",
  };
}

// Move an entry to waiting and drop its inputs: on wake it is planned
// again, and others' reviews or a push make the old review stale anyway.
function hold(e: Entry, conditions: Conditions, since: string, note: string): void {
  [e.state, e.wait_since, e.note, e.lease] = ["waiting", since, note, "-"];
  e.wait_for = Object.entries(conditions).map(([k, v]) => (v ? `${k}=${v}` : k)).join(",") || "-";
  save(e);
  dropInputs(e.pr);
}

// End a hold. The entry is done, so plan puts the PR back in its lane.
function wake(e: Entry, why: string[]): void {
  [e.state, e.note] = ["done", "woke: " + why.join("; ")];
  save(e);
}

// The landing gates still closed at the PR's head, as wake conditions:
// the landing wait, and green CI from the cq CI cache.
function landingGates(d: any, n: string): Conditions {
  const gates: Conditions = {};
  const at = landingAt(pget(d, "createdAt"), d.labels.nodes.map((l: any) => l.name));
  if (at && at.t > now().t) gates.landing = iso(at);
  const r = pget(readCi(), n);
  if (!(ciAt(r, d.headRefOid) && truthy(r.ok))) gates.ci = "";
  return gates;
}

// Which of a waiting entry's wake conditions have happened.
function wakeReasons(e: Entry, d: any): string[] {
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

// Finish the entry for a PR prefetch won't prepare, creating one if
// needed. Its updated_at comes from GitHub, so skipReason prefers it over
// an older cached candidate.
function refused(n: string, info: any, disp: string): void {
  using lock = entryLock(n).enter();
  const e: Entry = load(n) ?? dict({
    pr: n, url: `https://github.com/${REPO}/pull/${n}`, lane: "fresh",
    head: info.headRefOid || "-", created_at: iso(now()), disposition: "-",
  });
  e.title = info.title || e.title || "-";
  e.author = pget(info.author || {}, "login") || e.author || "-";
  e.pr_head = info.headRefOid || e.pr_head || "-";
  e.updated_at = info.updatedAt || iso(now());
  finish(e, disp);
}

// Everything a preparing agent needs, so it never calls gh itself. The
// new dossier and ref replace the old ones only after the fetched head
// matches GitHub's, so a failed prefetch leaves an earlier one intact.
function prefetch(n0: string): void {
  const n = String(pyInt(n0));
  const pr = gh("pr", "view", n, "--repo", REPO, "--json",
    "number,title,body,author,baseRefName,headRefOid,reviewDecision,labels,mergeable," +
    "mergeStateStatus,files,commits,createdAt,updatedAt,isDraft,state");
  const info = JSON.parse(pr);
  if (pget(info, "state") !== "OPEN" || pget(info, "isDraft")) {
    // The cached candidate can be up to REFRESH_MINUTES old, and longer
    // while the refresh is dormant. Record what GitHub said, so plan
    // stops offering the PR until the cache catches up.
    const disp = pget(info, "state") === "OPEN" ? "draft" : pget(info, "state", "?").toLowerCase();
    refused(n, info, disp);
    die(`${n} is ${disp === "draft" ? "a draft" : disp}; not preparing it`, 4);
  }

  fetchUpstream();
  const tmpRef = `refs/review-bank/tmp/${n}-${process.pid}`;
  git(["fetch", "-q", "--no-write-fetch-head", "upstream", `+pull/${n}/head:${tmpRef}`]);
  const head = strip(git(["rev-parse", tmpRef]));
  if (head !== info.headRefOid) {
    git(["update-ref", "-d", tmpRef], { check: false });
    die(`${n}: fetched ${head.slice(0, 12)} but GitHub says head is ${info.headRefOid.slice(0, 12)}; rerun`);
  }

  const old = load(n);
  const cand: Partial<Candidate> = new Map(rankedCandidates().map((c) => [c.pr, c] as const)).get(n) ?? {};
  const lane = cand.lane || (old || {}).lane || "fresh";
  const rf = cand.rereview_from || pget(old || {}, "rereview_from");
  if (rf && rf !== "-" && run(["git", "-C", CLONE, "cat-file", "-e", `${rf}^{commit}`],
    { stdout: "inherit", stderr: "devnull" }).returncode !== 0) {
    // A force-push can leave the reviewed commit unreachable from the PR.
    git(["fetch", "-q", "--no-write-fetch-head", "upstream", rf], { check: false });
  }

  const newDir = fs.mkdtempSync(P(DOSSIER, `.${n}.`));
  try {
    swapIn(n, newDir, tmpRef, pr, info, head, lane, rf, cand);
  } finally {
    rmtree(newDir);
    git(["update-ref", "-d", tmpRef], { check: false });
  }
}

function swapIn(n: string, newDir: string, tmpRef: string, pr: string, info: any, head: string, lane: string,
  rf: string | null, cand: Partial<Candidate>): void {
  writeText(P(newDir, "pr.json"), pr);
  writeText(P(newDir, "diff.patch"), gh("pr", "diff", n, "--repo", REPO));
  const disc = discussion(n);
  writeText(P(newDir, "discussion.json"), disc);
  let sc = screen(info, JSON.parse(disc));
  if (sc.result !== "pass" && (pget(load(n) || {}, "note") || "").includes("author responded")) {
    // Woken from a screen hold by the author: the user asked for this review.
    sc = { ...sc, result: "pass", why: `the author responded after the screen hold (${sc.result} before)` };
  }
  writeText(P(newDir, "screen.json"), dumps(sc, 1));
  const screened = sc.result !== "pass";
  let ci: Proc | null = null, gates: string | null = null;
  if (!screened) {
    // A screened PR gets no review, so skip the CI and gates calls.
    ci = run([P(NC, "ci-status.sh"), n], { env: ENV, stderr: "stdout" });
    writeText(P(newDir, "ci.txt"), `${ci.stdout}(ci-status.sh exit ${ci.returncode}, ${iso(now())})\n`);
    gates = writeGates(n, newDir, info, head, tmpRef);
  }
  writeText(P(newDir, "release-lines.txt"), activeLines());
  if (!screened && (METADATA === "all" || (METADATA === "cq" && lane === "cq"))) {
    // After the gh calls: git node metadata calls GitHub and Jenkins itself.
    writeText(P(newDir, "metadata.txt"), ncuMetadata(n));
  }
  if (lane === "screen" && !screened) lane = "fresh";
  writeText(P(newDir, "meta.json"), dumps({
    pr: n, head, ref: `refs/review-bank/${n}`, lane,
    rereview_from: rf ?? null, clone: CLONE, fetched_at: iso(now()),
  }, 1));
  // The diff, discussion, and CI were read after the fetch. A push in
  // between would mix two heads in one dossier.
  const nowHead = strip(gh("pr", "view", n, "--repo", REPO, "--json", "headRefOid", "--jq", ".headRefOid"));
  if (nowHead !== head) die(`${n}: head moved to ${nowHead.slice(0, 12)} while fetching; rerun`);

  // Order: dossier into place, entry saved, then the ref, then the old
  // dossier removed. A failure part way leaves the old dossier beside the
  // new one, never a ref or entry that points at a missing dossier.
  const d = P(DOSSIER, n);
  {
    using lock = entryLock(n).enter();
    const gone = P(DOSSIER, `.${n}.old-${process.pid}`);
    if (exists(d)) fs.renameSync(d, gone);
    fs.renameSync(newDir, d);
    let e = load(n);
    if (e && ["done", "stale", "waiting"].includes(e.state) && strip(e.body ?? "")) {
      // Keep the earlier review for reference; the new one starts clean.
      writeText(P(ARCHIVE, `${n}-${pget(e, "head", "-").slice(0, 12)}.md`), readText(entryPath(n)));
    }
    if (!e || ["done", "stale", "waiting"].includes(e.state)) {
      e = dict({ pr: n, created_at: iso(now()), disposition: "-", my_teams: pget(e || {}, "my_teams") });
    }
    Object.assign(e!, {
      url: `https://github.com/${REPO}/pull/${n}`, title: info.title,
      author: pget(info.author || {}, "login") || "ghost", state: "preparing",
      head, pr_head: head, updated_at: info.updatedAt, lease: iso(now()), lane,
      my_teams: cand.my_teams || e!.my_teams, rereview_from: rf,
      screen: screenLine(sc),
    });
    if (screened) {
      // No preparing agent: the screen entry is ready for the user as is.
      Object.assign(e!, {
        state: "ready", lane: "screen", lease: "-", body: screenBody(n, info, sc),
        prepared_at: iso(now()), needs_run: "0", note: `screen ${screenLine(sc)}`,
      });
    }
    save(e!);
    git(["update-ref", `refs/review-bank/${n}`, tmpRef]);
    rmtree(gone);
  }
  if (screened) {
    print(`${n}: dossier ${d}\n  ref refs/review-bank/${n} = ${head.slice(0, 12)}, lane screen, state ready`);
    print(`  screen ${screenLine(sc)}: ${sc.why}. No preparing agent; present it to the user.`);
    return;
  }
  print(`${n}: dossier ${d}\n  ref refs/review-bank/${n} = ${head.slice(0, 12)}, lane ${lane}, state preparing`);
  print(`  screen ${screenLine(sc)}`);
  print(strip(ci!.stdout) ? "  " + splitlines(strip(ci!.stdout))[0] : "  ci: no output");
  print(`  gates: ${gates}`);
}

// nodejs-review-queue's discussion.sh --json: comments, reviews, and
// inline threads, without hidden or blocked-user content.
function discussion(n: string): string {
  const p = run(["zsh", P(RQ, "discussion.sh"), "--json", n], { env: ENV });
  if (p.returncode !== 0) throw new RuntimeError(`discussion.sh ${n}: ${cut(strip(p.stderr), -300)}`);
  const d = JSON.parse(p.stdout);
  d.fetched_at = iso(now());
  d.rules = "excluded items are not credited and don't count as already raised; " +
    "status resolved-context means hidden as outdated, duplicate, or resolved";
  return dumps(d, 1);
}

// The automation screen. Node's AI policy (doc/contributing/ai-guidelines.md)
// allows AI help, but automated tooling must not open pull requests without
// approval, and a contributor who used AI should disclose it. Collaborators are
// trusted and skip the screen. For everyone else, the agentscan label and the
// bot's AgentScan caution are heuristics that trigger the check. Detection is
// deliberately simple: anything short of a clear pass is unclear, and the user
// decides.
const AI_WORDS = `(?:${B}AI${B}|${B}LLMs?${B}|claude|copilot|codex|chatgpt|${B}GPT|gemini|cursor|` +
  "coding agents?|language models?|agentic)";
const AI_TRAILER = new RegExp(`${BOL}(?:assisted-by|generated-by|(?:co-authored-by|made-with):${DOT}*${AI_WORDS})${DOT}*${EOL}`, "giu");
const DISCLOSURE = new RegExp(
  `AI[- ]disclosure|AI[- ]assist|${AI_WORDS}[- ](?:assisted|generated|written|helped)|` +
  `(?:used|using|with the help of|generated (?:with|by)|written (?:with|by)|assisted by)[${WS}]+(?:an?[${WS}]+|the[${WS}]+)?${AI_WORDS}|` +
  `${AI_WORDS}[${WS}]+(?:was|were)[${WS}]+used`, "iu");
const MODERATION = "https://github.com/nodejs/admin/blob/main/Moderation-Policy.md";
const AI_POLICY = "https://github.com/nodejs/node/blob/HEAD/doc/contributing/ai-guidelines.md";
// README.md sections whose members are collaborators. Emeriti and triagers aren't.
const COLLABORATOR_SECTIONS = ["#### TSC voting members", "#### TSC regular members", "### Collaborators"];
const COLLABORATORS_HOURS = 24;

// Logins (lowercase) of current collaborators, from README.md on
// upstream/main, cached for a day. Empty if the README can't be read, so
// the screen then applies to everyone.
function collaborators(): Set<string> {
  const p = P(CACHE, "collaborators.json");
  try {
    if (Date.now() / 1000 - mtime(p) < COLLABORATORS_HOURS * 3600) return new Set(JSON.parse(readText(p)));
  } catch (err) {
    if (!(isOSError(err) || isValueError(err))) throw err;
  }
  let readme: string;
  try {
    readme = git(["show", "upstream/main:README.md"]);
  } catch (err) {
    if (!(err instanceof RuntimeError)) throw err;
    return new Set();
  }
  const logins = new Set<string>();
  let section: boolean | null = null;
  for (const line of splitlines(readme)) {
    if (line.startsWith("#")) {
      section = COLLABORATOR_SECTIONS.includes(strip(line));
      continue;
    }
    const m = section && /^\* \[([^\]]+)\]/.exec(line);
    if (m) logins.add(m[1].toLowerCase());
  }
  if (logins.size) writeAtomic(p, dumps(sorted(logins)));
  return logins;
}

function snippet(m: RegExpExecArray | null, text: string, width = 100): string | null {
  if (!m) return null;
  // Python counts code points.
  const cps = Array.from(text), start = Array.from(text.slice(0, m.index)).length, end = start + Array.from(m[0]).length;
  const [a, b] = [Math.max(0, start - 30), Math.min(cps.length, end + 50)];
  return cut(splitWs(cps.slice(a, b).join("")).join(" "), 0, width);
}

type Signals = {
  agentscan_labels: string[]; agentscan_caution: boolean; first_contribution: boolean;
  author_association: string | null; ai_trailers: string[]; disclosure: string | null;
};
type Screen = { result: string; why: string; signals: Signals | null };

// Screen a PR before any review work. Returns: result (pass, unclear, or
// fail), why, and the signals found.
function screen(info: any, disc: any): Screen {
  const body: string = info.body || "";
  const author = pget(info.author || {}, "login");
  if (author && collaborators().has(author.toLowerCase())) return { result: "pass", why: "skipped: collaborator", signals: null };
  const labels: string[] = (info.labels || []).map((l: any) => l.name);
  const flagged = labels.filter((l) => l.startsWith("agentscan:"));
  const comments: any[] = disc.comments || [];
  const bot = comments.filter((c) => (c.author || "").startsWith("github-actions"));
  const caution = bot.some((c) => (c.body || "").includes("AgentScan"));
  const first = bot.some((c) => (c.body || "").includes("first contribution"));
  const hit = [...comments, ...(disc.reviews || [])].find((c) => pget(c, "author") === author);
  const assoc = hit ? pget(hit, "association") : null;
  const messages = (info.commits || []).map((c: any) => c.messageBody || "").join("\n");
  const trailers = sorted(new Set([...messages.matchAll(AI_TRAILER)].map((t) => splitWs(t[0]).join(" "))));
  const told = snippet(DISCLOSURE.exec(body), body);
  const disclosed = Boolean(trailers.length || told);
  const sig: Signals = {
    agentscan_labels: flagged, agentscan_caution: caution, first_contribution: first,
    author_association: assoc, ai_trailers: trailers, disclosure: told,
  };
  if (!(flagged.length || caution)) {
    const why = "not flagged by AgentScan" + (disclosed ? "; AI use disclosed" : "");
    return { result: "pass", why, signals: sig };
  }
  if (!disclosed) return { result: "fail", why: "flagged by AgentScan, with no AI disclosure", signals: sig };
  // Flagged and disclosed: the flag suggests automated opening, which the
  // policy forbids without approval, so a disclosure alone doesn't settle it.
  return { result: "unclear", why: "flagged by AgentScan; AI use disclosed", signals: sig };
}

// The signals on one line, for list, plan, and the entry's screen field.
function screenLine(sc: Screen): string {
  const s = sc.signals;
  if (!s) return `${sc.result}: ${sc.why}`;
  const parts = [...s.agentscan_labels];
  if (s.agentscan_caution) parts.push("AgentScan caution");
  if (s.first_contribution) parts.push("first contribution");
  parts.push(s.disclosure || s.ai_trailers.length ? "disclosed" : "no disclosure");
  return `${sc.result}: ` + parts.join(", ");
}

// A screen entry's body: the signals, the policy, and an outline for the
// user's comment. An outline, not a comment: the user writes it.
function screenBody(n: string, info: any, sc: Screen): string {
  const s = sc.signals!, author = pget(info.author || {}, "login") || "ghost";
  const found = (v: string | null) => (v ? `found: "${v}"` : "none found");
  const lines = [`## [#${n}](https://github.com/${REPO}/pull/${n}) ${py(info.title)} (automation screen)`, "",
    "### Screen", "",
    `Result: **${sc.result}**, ${sc.why}. No review was prepared.`, "",
    `- Author: @${author}, association ${s.author_association || "unknown (no comment by them)"}`
    + (s.first_contribution ? ", first contribution (github-actions welcome comment)" : ""),
    `- AgentScan: label ${s.agentscan_labels.join(", ") || "none"}; caution in the github-actions ` +
    `comment: ${s.agentscan_caution ? "yes" : "no"}`,
    `- AI disclosure in the PR body: ${found(s.disclosure)}`,
    `- AI trailers in the commits: ${s.ai_trailers.join(", ") || "none"}`, "",
    "Read the PR body and commits yourself before deciding: the screen is pattern matching.", "",
    "### Policy", "",
    `[AI use policy](${AI_POLICY}):`, "",
    "- Pull requests must not be opened by automated tooling without approval in advance.",
    "- A contributor who used AI should disclose it, and must understand, test, and verify what they submit.",
    "- AI-generated pull requests the contributor hasn't understood, tested, and verified are subject " +
    "to closure without further review.",
    `- Messages generated entirely by AI may be removed under the [moderation policy](${MODERATION}).`, "",
    "### Outline for your comment", "",
    "- Point to the github-actions welcome comment (the AgentScan caution) and the AI use policy.",
    "- Ask them to confirm they follow the contribution policies.",
    "- Name what's missing: " + (!(s.disclosure || s.ai_trailers.length) ? "the AI disclosure, and confirmation that a person opened the PR and " +
    "will handle review." :
      "confirmation that a person, not automated tooling, opened the PR and will handle review."),
    "- Say you'll review once they respond.", "",
    "### Next", "",
    `After you comment, \`sync\` holds it for ${SCREEN_HOURS} hours. A comment or push by @${author} wakes it ` +
    "for a real review. With no response, it comes back with a recommendation to close it per the " +
    "moderation policy."];
  return lines.join("\n") + "\n";
}

// A screen entry whose author didn't respond in time.
function closeBody(e: Entry): string {
  return [
    `## [#${e.pr}](${e.url}) ${e.title} (automation screen: no response)`, "",
    "### Screen", "",
    `No comment or push by @${py(pget(e, "author", "the author"))} in ${SCREEN_HOURS} hours since ` +
    `${py(pget(e, "wait_since"))}. Screen at prefetch: ${pget(e, "screen") || "-"}.`, "",
    `Recommend closing it per the [AI use policy](${AI_POLICY}) (AI-generated pull requests that weren't ` +
    'verified "will be subject to closure without additional review") and the ' +
    `[moderation policy](${MODERATION}).`, "",
    "### Outline for your closing comment", "",
    "- Refer to your earlier comment and that there was no response.",
    "- Say they can reopen it, or open a new PR, once they can follow the contribution policies.", ""].join("\n");
}

const METADATA = process.env.BANK_METADATA ?? "cq"; // which lanes get metadata.txt: cq, all, or off
const METADATA_TIMEOUT = 180;
const PASSING = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const GATES_QUERY = `query{repository(owner:"%s",name:"%s"){pullRequest(number:%s){
 reviewDecision
 commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){totalCount nodes{__typename
  ...on CheckRun{name status conclusion detailsUrl checkSuite{workflowRun{workflow{name}}}}
  ...on StatusContext{context state targetUrl}}}}}}}
 timelineItems(last:100,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_COMMIT]){totalCount nodes{__typename
  ...on HeadRefForcePushedEvent{createdAt actor{login} beforeCommit{oid} afterCommit{oid}}
  ...on PullRequestCommit{commit{oid committedDate messageHeadline checkSuites(first:1){nodes{createdAt}}}}}}
 reviewRequests(first:50){nodes{requestedReviewer{__typename ...on Team{slug} ...on User{login}}}}
 latestOpinionatedReviews(first:100){nodes{author{login} state submittedAt commit{oid} onBehalfOf(first:20){nodes{slug}}}}
}}}`;

function nodes(d: any, key: string): any[] {
  return ((d || {})[key] || {}).nodes || [];
}

// gates.json (check runs and statuses on the head, reviews, code owners)
// and timeline.json (pushes) from one GraphQL query and the clone's
// CODEOWNERS. A failed query is recorded in both files and doesn't stop the
// prefetch. Returns a one-line summary.
function writeGates(n: string, newDir: string, info: any, head: string, ref: string): string {
  const at = iso(now());
  let pr: any, err: string | null = null;
  try {
    pr = graphql(pct(GATES_QUERY, OWNER, NAME, n)).pullRequest;
    if (!truthy(pr)) throw new RuntimeError("pull request not found");
  } catch (e) {
    if (!(e instanceof RuntimeError)) throw e;
    [pr, err] = [{}, e.message];
  }

  const commit = (nodes(pr, "commits")[0] ?? {}).commit || {};
  const roll = commit.statusCheckRollup || {};
  const runs: any[] = [];
  for (const c of nodes(roll, "contexts")) {
    if (c.__typename === "CheckRun") {
      const wf = pget(((c.checkSuite || {}).workflowRun || {}).workflow || {}, "name");
      runs.push({ name: pget(c, "name"), workflow: wf, result: c.conclusion || pget(c, "status"), url: pget(c, "detailsUrl") });
    } else { // a commit status, such as Jenkins
      runs.push({ name: pget(c, "context"), workflow: null, result: pget(c, "state"), url: pget(c, "targetUrl") });
    }
  }
  const total = pget(roll.contexts || {}, "totalCount", 0);
  const counts: Record<string, number> = dict();
  for (const r of runs) counts[String(r.result)] = (counts[String(r.result)] ?? 0) + 1;
  const notPassing = runs.filter((r) => !PASSING.has(r.result));

  const reviews = nodes(pr, "latestOpinionatedReviews").map((r) => ({
    author: pget(r.author || {}, "login") || "ghost", state: pget(r, "state"),
    commit: pget(r.commit || {}, "oid"), at: pget(r, "submittedAt"),
    on_behalf_of: nodes(r, "onBehalfOf").map((t) => `@${OWNER}/${t.slug}`),
  }));
  const requested: string[] = [];
  for (const r of nodes(pr, "reviewRequests")) {
    const who = r.requestedReviewer || {};
    requested.push(who.slug ? `@${OWNER}/${who.slug}` : `@${py(pget(who, "login"))}`);
  }

  const co = codeOwners(info.baseRefName || "main", ref, head, (info.files || []).map((f: any) => f.path));
  for (const [o, v] of Object.entries<any>(pget(co, "owners", {}))) {
    v.status = err ? "unknown: the query failed" : ownerStatus(o, reviews, requested);
  }

  const gates = {
    head, fetched_at: at, error: err, reviewDecision: pget(pr, "reviewDecision"),
    checks: {
      commit: pget(commit, "oid"), state: pget(roll, "state"), total,
      truncated: total > runs.length, counts, not_passing: notPassing,
      all: runs.map((r) => ({ name: r.name, workflow: r.workflow, result: r.result })),
    },
    reviews, review_requests: requested, codeowners: co,
  };
  writeText(P(newDir, "gates.json"), dumps(gates, 1));

  const events: any[] = [];
  for (const t of nodes(pr, "timelineItems")) {
    if (t.__typename === "HeadRefForcePushedEvent") {
      events.push({
        type: "force-push", at: pget(t, "createdAt"),
        actor: pget(t.actor || {}, "login"),
        before: pget(t.beforeCommit || {}, "oid"),
        after: pget(t.afterCommit || {}, "oid"),
      });
    } else if (t.__typename === "PullRequestCommit") {
      const c = t.commit || {};
      const suites = nodes(c, "checkSuites");
      events.push({
        type: "commit", oid: pget(c, "oid"), headline: pget(c, "messageHeadline"),
        committed_at: pget(c, "committedDate"),
        first_check_at: suites.length ? pget(suites[0], "createdAt") : null,
      });
    }
  }
  const forced = events.filter((e) => e.type === "force-push" && e.after === head);
  const first = events.filter((e) => e.type === "commit" && e.oid === head && e.first_check_at).map((e) => e.first_check_at);
  const pushed = forced.length ? { at: forced.at(-1).at, source: "force-push event" }
    : first.length ? { at: first[0], source: "first check suite on the head (approximate)" }
    : { at: null, source: "unknown" };
  const ttotal = pget(pr.timelineItems || {}, "totalCount", 0);
  writeText(P(newDir, "timeline.json"), dumps({
    head, fetched_at: at, error: err, head_pushed_at: pushed,
    note: "GitHub no longer reports commit push times. first_check_at is when the first check suite " +
      "for a commit was created, close to when it was pushed as the PR head; null means it was " +
      "pushed under a later commit or got no checks. committed_at is the committer date, which a " +
      "rebase resets. Events are oldest first, the last 100 only.",
    total: ttotal, truncated: ttotal > events.length, events,
  }, 1));

  if (err) return `query FAILED (${cut(err, 0, 120)}); see gates.json`;
  const unapproved = Object.entries<any>(pget(co, "owners", {})).filter(([, v]) => !v.status.startsWith("approved")).map(([o]) => o);
  return `reviewDecision ${pr.reviewDecision || "-"}, checks ${roll.state || "-"} ` +
    `(${notPassing.length} not passing), code owners without an approval: ${unapproved.join(" ") || "none"}`;
}

// Whether a code owner has reviewed. A team counts only through a review
// made on its behalf, which GitHub records when the team was requested.
function ownerStatus(owner: string, reviews: any[], requested: string[]): string {
  const mine = reviews.filter((r) => r.on_behalf_of.includes(owner) || owner === `@${r.author}`);
  const ok = mine.filter((r) => r.state === "APPROVED").map((r) => r.author);
  if (ok.length) return `approved by ${ok.join(", ")}`;
  if (mine.length) return `${mine[0].state.toLowerCase()} by ${mine[0].author}`;
  if (requested.includes(owner)) return "requested, no review on its behalf yet";
  return "not requested, no review on its behalf (a member may have reviewed without the request)";
}

// The owners of each changed path, from .github/CODEOWNERS on the base
// branch (the one GitHub applies), else at the PR head. The last matching
// line wins, as on GitHub.
function codeOwners(base: string, ref: string, head: string, paths: string[]): any {
  let text = "", label = "";
  for (const [src, lbl] of [[`refs/remotes/upstream/${base}`, `upstream/${base}`], [ref, `PR head ${head.slice(0, 12)}`]]) {
    text = git(["show", `${src}:.github/CODEOWNERS`], { check: false });
    label = lbl;
    if (text) break;
  }
  if (!text) return { source: null, error: "no .github/CODEOWNERS on the base branch or at the PR head" };
  const rules: [RegExp, string[]][] = [];
  for (const line of splitlines(text)) {
    const parts = splitWs(line.split("#", 1)[0]);
    if (parts.length) rules.push([codeownersRe(parts[0]), parts.slice(1)]);
  }
  const owners: Record<string, { paths: string[]; status?: string }> = dict(), unowned: string[] = [];
  for (const p of paths) {
    const hit = [...rules].reverse().find(([rx]) => rx.test(p))?.[1] ?? null;
    if (hit === null) unowned.push(p);
    for (const o of hit || []) (owners[o] ??= { paths: [] }).paths.push(p);
  }
  return {
    source: `${label}:.github/CODEOWNERS`, owners, unowned_paths: unowned,
    files_maybe_truncated: paths.length >= 100,
    note: "pattern matching approximates GitHub's; check a surprising owner against the file",
  };
}

// A CODEOWNERS pattern as a regex over repository paths. A leading or
// inner / anchors it to the root, * stays within a directory, ** crosses
// them, and a pattern ending in * matches only files directly under it (as
// GitHub documents). A match on a directory covers everything below it.
function codeownersRe(pat: string): RegExp {
  const anchored = pat.replace(/\/+$/, "").includes("/");
  const p = pat.replace(/^\/+|\/+$/g, "");
  let out = "";
  for (let i = 0; i < p.length; ) {
    if (p.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (p.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else {
      out += ({ "*": "[^/]*", "?": "[^/]" } as Record<string, string>)[p[i]] ?? p[i].replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
      i += 1;
    }
  }
  // Python's fullmatch: anchored at both ends.
  return new RegExp(`^(?:${anchored ? "" : "(?:.*/)?"}${out}${p.endsWith("*") ? "" : "(?:/.*)?"})$`);
}

// git node metadata (node-core-utils), read-only: approvals by name, the
// last Jenkins CI, failed GitHub Actions jobs, and the generated commit
// metadata. It calls GitHub with its own token, not gh, so it holds the gh
// shim's lock to stay serial with every gh call. The shim locks with
// zsystem flock, an fcntl lock, the same kind every lock here takes.
// Never raises: a failure is written to the file.
function ncuMetadata(n: string): string {
  const lock = P(process.env.GH_SHIM_LOCK || P(LOCKS, "gh.lock"));
  const held = zshFlock(lock, true);
  if (!held) throw new OSError(`could not lock ${lock}`);
  let out: string, err: string, status: string;
  try {
    try {
      const p = run(["git", "node", "metadata", n, "--owner", OWNER, "--repo", NAME],
        { cwd: isDir(CLONE) ? CLONE : undefined, env: ENV, timeout: METADATA_TIMEOUT });
      [out, err, status] = [p.stdout, p.stderr, `exit ${p.returncode}`];
    } catch (e) {
      if (e instanceof TimeoutExpired) [out, err, status] = [e.stdout, e.stderr, `timed out after ${METADATA_TIMEOUT}s`];
      else if (isOSError(e)) [out, err, status] = ["", pyStr(e), "could not run"];
      else throw e;
    }
    writeText(`${lock}.last`, `${(performance.timeOrigin + performance.now()) / 1000}\n`); // the shim's GH_MIN_GAP
  } finally {
    unlock(held);
  }
  // The report goes to stderr and the generated metadata to stdout, which
  // the report already repeats.
  let text = strip(out) && err.includes(strip(out)) ? err : err + out;
  text = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = splitlines(text).filter((l) => !new RegExp(`^[${WS}]*[\\u2800-\\u28ff]`).test(l)); // spinner frames
  return lines.join("\n") + `\n(git node metadata ${status}, ${iso(now())})\n`;
}

// main and the staging branches, at most every 30 minutes.
function fetchUpstream(): void {
  const stamp = P(CACHE, "fetch.stamp");
  if (exists(stamp) && Date.now() / 1000 - mtime(stamp) < 1800) return;
  git(["fetch", "-q", "--no-write-fetch-head", "upstream", "+refs/heads/main:refs/remotes/upstream/main",
    "+refs/heads/v*-staging:refs/remotes/upstream/v*-staging"]);
  writeText(stamp, iso(now()));
}

// Active release lines (nodejs-contribute, Release-line labels), cached a day.
function activeLines(): string {
  const p = P(CACHE, "release-lines.txt");
  if (exists(p) && Date.now() / 1000 - mtime(p) < 86400) return readText(p);
  const sched = JSON.parse(Buffer.from(
    gh("api", "repos/nodejs/Release/contents/schedule.json", "--jq", ".content"), "base64").toString("utf8"));
  const today = iso(now()).slice(0, 10);
  const lines = Object.entries<any>(sched).filter(([, v]) => pget(v, "start", "9") <= today && today <= pget(v, "end", "0")).map(([k]) => k);
  writeAtomic(p, `active release lines on ${today}: ${lines.join(" ")}\n`);
  return readText(p);
}

function slots(): string[][] {
  const conf = P(BANK, "slots.tsv");
  if (!exists(conf)) writeText(conf, `1\t${CLONE}\n2\t${CLONE}/.claude/worktrees/review-b\n`);
  // Every caller unpacks a row into (name, path), so a malformed row raises.
  return splitlines(readText(conf)).filter((l) => strip(l)).map((l) => unpack(l.split("\t"), 2));
}

// [usable, dirty lines, HEAD name]. Unusable when git status fails.
function checkoutState(p: string): [boolean, string, string] {
  const st = run(["git", "-C", p, "status", "--porcelain"]);
  const at = strip(run(["git", "-C", p, "rev-parse", "--abbrev-ref", "HEAD"]).stdout);
  return [st.returncode === 0, strip(st.stdout), at];
}

// Image freshness. Slot builds start from the devcontainer image's prebuilt
// out/, so the image's age sets the cost of every first build. The tick pulls a
// newer nightly when no slot is held, then moves free slots to it one at a time
// (devc.sh down, then build). Both run in the background. Neither touches a held
// slot: a move holds its slot itself, as owner image-move.

// devc.sh image in a checkout, as a dict, or null when it fails.
function devcInfo(p: string): Record<string, string> | null {
  let r: Proc;
  try {
    r = run([P(NC, "devc.sh"), "image"], { cwd: p, env: ENV, timeout: 120 });
  } catch (err) {
    if (isOSError(err) || err instanceof TimeoutExpired) return null;
    throw err;
  }
  if (r.returncode !== 0) return null;
  const d: Record<string, string> = dict();
  for (const l of splitlines(r.stdout)) {
    if (l.includes("=")) {
      const [k, , v] = partition(l, "=");
      d[k] = v;
    }
  }
  return d;
}

function readCacheJson(name: string): any {
  try {
    return JSON.parse(readText(P(CACHE, name)));
  } catch (err) {
    if (isOSError(err) || isValueError(err)) return {};
    throw err;
  }
}

// Whether ISO time t is under IMAGE_CHECK_MINUTES ago.
function recent(t: string | null | undefined): boolean {
  const d = t ? parseIso(t) : null;
  return Boolean(d) && (now().t - d!.t) / 1000 < IMAGE_CHECK_MIN * 60;
}

// The UTC time at the start of an engine or Docker Hub timestamp
// (2026-11-19 03:59:40.16 +0000 UTC, 2026-11-20T04:31:57.43Z).
function parseStamp(s: string | null | undefined): Dt | null {
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)/.exec(s || "");
  return m ? parseIso(`${m[1]}T${m[2]}Z`) : null;
}

function hubUrl(): string | null {
  if (process.env.DEVC_HUB_URL) return process.env.DEVC_HUB_URL;
  const w = "[\\p{L}\\p{N}_.-]+";
  const m = new RegExp(`^(?:docker\\.io/)?(${w})/(${w}):(${w})$`, "u").exec(DEVC_IMAGE);
  return m ? `https://hub.docker.com/v2/repositories/${m[1]}/${m[2]}/tags/${m[3]}` : null;
}

// urllib.request.urlopen(url, timeout=...).read(), with urllib's errors:
// a file: URL is read from disk, anything else goes through fetch.
async function urlopen(url: string, timeout: number): Promise<string> {
  const scheme = /^([a-zA-Z][\w+.-]*):/.exec(url)?.[1].toLowerCase();
  if (scheme === "file") {
    const p = fileURLToPath(url);
    try {
      return fs.readFileSync(p, "utf8");
    } catch (err) {
      const e = err as { code?: string; errno?: number };
      throw new OSError(`<urlopen error [Errno ${Math.abs(e.errno ?? 0)}] ${STRERROR[e.code ?? ""] ?? e.code}: ${repr(p)}>`);
    }
  }
  if (scheme !== "http" && scheme !== "https") throw new ValueError(`unknown url type: ${repr(url)}`);
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(timeout * 1000) });
  } catch (err) {
    const e = err as Error & { cause?: Error };
    throw new OSError(e.name === "TimeoutError" ? "<urlopen error timed out>" : `<urlopen error ${e.cause?.message ?? e.message}>`);
  }
  if (!r.ok) throw new OSError(`HTTP Error ${r.status}: ${r.statusText}`);
  try {
    return await r.text();
  } catch (err) {
    throw new OSError((err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message);
  }
}

// Docker Hub's view of the tag (its digests and last_updated), fetched at
// most every IMAGE_CHECK_MINUTES. A failed fetch keeps the last good result.
async function hubInfo(): Promise<any> {
  const old = readCacheJson("image-hub.json");
  if (recent(pget(old, "checked_at"))) return old;
  const url = hubUrl();
  if (!url) return { error: `${DEVC_IMAGE} is not a Docker Hub tag` };
  const info: any = { checked_at: iso(now()) };
  try {
    const d = JSON.parse(await urlopen(url, 30));
    Object.assign(info, {
      digests: [item(d, "digest"), ...(d.images || []).filter((i: any) => i.digest).map((i: any) => i.digest)],
      last_updated: item(d, "last_updated"),
    });
  } catch (err) {
    if (!(isOSError(err) || isValueError(err) || err instanceof KeyError || err instanceof TypeError)) throw err;
    for (const k of ["digests", "last_updated"]) if (Object.hasOwn(old, k)) info[k] = old[k];
    info.error = cut(pyStr(err), 0, 120);
  }
  writeAtomic(P(CACHE, "image-hub.json"), dumps(info));
  return info;
}

// Whether Docker Hub's tag is another image, pushed after the local one was
// built. Either the index digest or a per-platform one can be local.
function imageNewer(local: Record<string, string>, hub: any): boolean {
  const mine = new Set(splitWs(pget(local, "image_digests", "")).map((d) => rpartition(d, "@")[2]));
  if (!truthy(hub.digests) || hub.digests.some((d: string) => mine.has(d))) return false;
  const [built, pushed] = [parseStamp(local.image_created), parseStamp(hub.last_updated)];
  return Boolean(pushed) && (!built || pushed!.t > built.t);
}

// Whether a background worker holds Flock(name).
function running(name: string): boolean {
  const lock = new Flock(name);
  if (lock.acquire(false)) {
    lock.release();
    return false;
  }
  return true;
}

// Flock(name) for a worker, retried briefly: a tick probing it with
// running() holds it for a moment.
function workerLock(name: string): Flock | null {
  const lock = new Flock(name);
  for (let i = 0; i < 20; i++) {
    if (lock.acquire(false)) return lock;
    sleep(0.5);
  }
  return null;
}

// Start bank.ts <args> detached from this process, logging to cache/<log>.
function spawn(args: string[], log: string): void {
  const fd = fs.openSync(P(CACHE, log), "w");
  try {
    const child = spawnChild(process.execPath, [...process.execArgv, THIS, ...args],
      { env: ENV, stdio: ["ignore", fd, fd], detached: true });
    child.on("error", () => {});
    if (!child.pid) throw new OSError(`could not start ${process.execPath}`);
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

// Free a slot still held for a move whose worker is gone.
function reclaimMoves(): string[] {
  if (running("image-move")) return [];
  const out: string[] = [];
  using lock = new Flock("slots").enter();
  for (const [name] of slots()) {
    const h = new SlotLock(name).holder();
    if (truthy(h) && pget(h, "owner") === MOVE && (now().t - parseIso(h.at)!.t) / 1000 > SLOT_OWNERLESS_GRACE) {
      new SlotLock(name).release();
      out.push(`slot ${name}: its move worker is gone; released`);
    }
  }
  return out;
}

type SlotRow = [string, string, any];

// Pull a newer nightly when no slot is held, then move one free slot that
// is on an older image. Returns report lines.
async function imageTick(): Promise<string[]> {
  const out = reclaimMoves();
  const rows: SlotRow[] = slots().filter(([, p]) => exists(p)).map(([name, p]) => [name, p, new SlotLock(name).holder()]);
  const info = new Map(rows.map(([name, p]) => [name, devcInfo(p)] as const));
  const first = rows.find(([name]) => truthy(info.get(name)));
  if (!first) return [...out, "no slot checkout answered devc.sh image; skipped"];
  const local = info.get(first[0])!;
  if (pget(local, "image_id", "missing") === "missing") {
    return [...out, `${DEVC_IMAGE} not found (missing, or the engine is down); a pull needs the user (about 10 GB)`];
  }
  const hub = await hubInfo();
  let line = `local ${local.image_id} built ${cut(local.image_created || "?", 0, 16)}`;
  if (pget(hub, "last_updated")) line += `, Docker Hub updated ${cut(hub.last_updated, 0, 16)}`;
  if (pget(hub, "error")) line += ` (check failed: ${cut(hub.error, 0, 80)})`;
  const held = rows.filter(([, , h]) => truthy(h)).map(([n, , h]) => `slot ${n} for #${py(item(h, "pr"))}`);
  const last = readCacheJson("image-pull.json");
  const log = P(CACHE, "image-pull.log");
  if (running("image-pull")) return [...out, `${line}; pull running since ${py(pget(last, "started_at", "?"))} (log ${log})`];
  if (!truthy(pget(hub, "digests"))) {
    out.push(`${line}; not compared`);
  } else if (!imageNewer(local, hub)) {
    out.push(`${line}; current`);
  } else if (held.length) {
    // No moves either: they would rebuild on an image the pull replaces.
    return [...out, `${line}; newer on Docker Hub, the pull and any moves wait until no slot is held ` +
      `(${held.join(", ")})`];
  } else if (recent(pget(last, "started_at"))) {
    const how = Object.hasOwn(last, "rc") ? `exited ${py(last.rc)}` : "did not finish";
    out.push(`${line}; newer on Docker Hub, but the pull at ${last.started_at} ${how}; ` +
      `retried ${IMAGE_CHECK_MIN} minutes after it (log ${log})`);
  } else {
    writeAtomic(P(CACHE, "image-pull.json"), dumps(
      { started_at: iso(now()), from: local.image_id, path: first[1] }));
    spawn(["image", "run-pull", first[1]], path.basename(log));
    return [...out, `${line}; newer on Docker Hub, pulling in the background (about 2 minutes, log ${log})`];
  }
  return [...out, ...moveOne(rows, info, local.image_id)];
}

// Hold one free slot whose container is on an older image as image-move,
// and move it in the background. One at a time, so other slots stay free.
function moveOne(rows: SlotRow[], info: Map<string, Record<string, string> | null>, image: string): string[] {
  const moving = rows.filter(([, , h]) => truthy(h) && pget(h, "owner") === MOVE);
  if (moving.length) {
    const [n, , h] = moving[0];
    return [`slot ${n}: moving to ${py(pget(h, "to", "?"))} since ${py(item(h, "at"))} (log ${P(CACHE, `image-move-${n}.log`)})`];
  }
  const moves = readCacheJson("image-moves.json"), out: string[] = [];
  for (const [name, p, h] of rows) {
    const i = info.get(name);
    if (!truthy(i) || i!.outdated !== "yes") continue;
    const [ok, dirty, at] = checkoutState(p);
    const last = pget(moves, name) || {};
    let why = (truthy(h) ? `held for #${py(item(h, "pr"))}` :
      !ok ? "git status failed" :
      dirty ? "checkout has changes" :
      !(at === "main" || at === "HEAD") ? `checkout is on ${at}, not main` :
      pget(i, "busy") !== "no" ? "something runs in its container" :
      pget(last, "to") === image && pget(last, "rc") && recent(pget(last, "at")) ?
        `the move at ${py(item(last, "at"))} failed at ${py(pget(last, "step"))}` : null);
    if (!why) {
      let got: boolean;
      {
        using lock = new Flock("slots").enter();
        got = new SlotLock(name).acquire({ pr: MOVE, owner: MOVE, at: iso(now()), from: item(i, "container_image"), to: image });
      }
      if (got) {
        spawn(["image", "run-move", name], `image-move-${name}.log`);
        return [...out, `slot ${name}: moving from ${i!.container_image} to ${image} in the background ` +
          "(devc.sh down, then build: about 3 to 5 minutes)"];
      }
      why = "acquired meanwhile";
    }
    out.push(`slot ${name}: on older image ${item(i, "container_image")}; the move waits (${why})`);
  }
  return out;
}

// Background worker: devc.sh pull, with the result in cache/image-pull.json.
function runPull(p: string): void {
  const lock = workerLock("image-pull");
  if (!lock) die("another pull is running", 0);
  print(`=== devc.sh pull in ${p} @ ${iso(now())}`);
  const rc = run([P(NC, "devc.sh"), "pull"], { cwd: p, env: ENV, stdout: "inherit", stderr: "inherit" }).returncode;
  const rec = readCacheJson("image-pull.json");
  Object.assign(rec, { rc, finished_at: iso(now()) });
  writeAtomic(P(CACHE, "image-pull.json"), dumps(rec));
  print(`=== exit ${rc} @ ${iso(now())}`);
}

// Background worker: down and build in a slot held as image-move, then
// release it. Checks again that nothing runs in the container first.
function runMove(name: string): void {
  const p = new Map(slots().map(([n, q]) => [n, q] as const)).get(name);
  const lock = workerLock("image-move");
  const h = new SlotLock(name).holder();
  const rec: any = { at: iso(now()), from: pget(truthy(h) ? h : {}, "from"), to: pget(truthy(h) ? h : {}, "to") };
  try {
    if (!truthy(h) || pget(h, "owner") !== MOVE) {
      print(`slot ${name} is not held for a move; nothing to do`);
      return;
    }
    const i = lock && p ? devcInfo(p) : null;
    if (!truthy(i) || i!.outdated !== "yes" || i!.busy !== "no") {
      Object.assign(rec, { step: "check", rc: truthy(i) && i!.outdated === "no" ? 0 : 1 });
      print(`not moving slot ${name}: ` + (rec.rc === 0 ? "no longer outdated" :
        !lock ? "another move is running" : "devc.sh image failed, or something runs in it"));
    } else {
      for (const step of ["down", "build"]) {
        print(`=== devc.sh ${step} in ${p} @ ${iso(now())}`);
        Object.assign(rec, { step, rc: run([P(NC, "devc.sh"), step], { cwd: p, env: ENV, stdout: "inherit", stderr: "inherit" }).returncode });
        if (rec.rc) break;
      }
    }
    const moves = readCacheJson("image-moves.json");
    moves[name] = { ...rec, finished_at: iso(now()) };
    writeAtomic(P(CACHE, "image-moves.json"), dumps(moves));
    print(`=== slot ${name}: ${py(pget(rec, "step"))} exit ${py(pget(rec, "rc"))} @ ${iso(now())}`);
  } finally {
    using slotsLock = new Flock("slots").enter();
    if (pget(new SlotLock(name).holder() || {}, "owner") === MOVE) new SlotLock(name).release();
  }
}

// Commits on upstream/main, as last fetched, since commit, or ?.
function behindMain(commit: string | null): string {
  if (!/^[0-9a-f]{7,40}$/.test(commit || "")) return "?";
  const p = run(["git", "-C", CLONE, "rev-list", "--count", `${commit}..refs/remotes/upstream/main`], { stderr: "devnull" });
  return p.returncode === 0 ? strip(p.stdout) : "?";
}

function imageCmd(args: string[]): void {
  if (args[0] === "prune") {
    // Only free slots, and devc.sh prune keeps the volumes of the local
    // image and of the slot's container. Other checkouts' volumes never match.
    for (const [name, p] of slots()) {
      const h = new SlotLock(name).holder();
      if (truthy(h) || !exists(p)) {
        print(`slot ${name}: ${truthy(h) ? "held for #" + item(h, "pr") : "missing"}, skipped`);
        continue;
      }
      const r = run([P(NC, "devc.sh"), "prune"], { cwd: p, env: ENV, stderr: "stdout" });
      print(`slot ${name}: ` + (strip(r.stdout) || "nothing to remove").replaceAll("\n", "\n  "));
    }
    return;
  }
  if (args[0] === "run-pull" && args.length === 2) return runPull(args[1]);
  if (args[0] === "run-move" && args.length === 2) return runMove(args[1]);
  die("usage: image prune", 2);
}

function slotCmd(args: string[]): void {
  if (!args.length || args[0] === "status") {
    const hub = readCacheJson("image-hub.json");
    if (pget(hub, "last_updated")) {
      print(`image: Docker Hub updated ${cut(hub.last_updated, 0, 16)} (checked ${py(pget(hub, "checked_at"))})`
        + (running("image-pull") ? ", pull running" : ""));
    }
    for (const [name, p] of slots()) {
      const lock = new SlotLock(name);
      const [h, since] = [lock.holder(), lock.ownerlessSince()];
      const held = (truthy(h) && pget(h, "owner") === MOVE ? `moving to image ${py(pget(h, "to"))} since ${py(item(h, "at"))}` :
        truthy(h) ? `held for #${py(item(h, "pr"))} by ${py(item(h, "owner"))} since ${py(item(h, "at"))}` :
        since ? `lock has no owner record since ${iso(since)} (reclaimed after ${SLOT_OWNERLESS_GRACE}s)`
        : "free");
      if (!exists(p)) {
        print(`slot ${name}: ${p} MISSING (${held})`);
        continue;
      }
      const [ok, dirty, at] = checkoutState(p);
      const flag = dirty ? ", DIRTY" : ok ? "" : ", GIT STATUS FAILED";
      print(`slot ${name}: ${p} [${at}${flag}] ${held}`);
      const i = devcInfo(p);
      if (!truthy(i)) {
        print("  image: devc.sh image failed");
      } else if (pget(i, "container_state") === "none") {
        print(`  image: no container (local image ${py(pget(i, "image_id"))})`);
      } else {
        print(`  image: ${py(pget(i, "container_image"))} built from ${cut(pget(i, "image_commit", "-"), 0, 12)} ` +
          `(${behindMain(pget(i, "image_commit"))} commits behind upstream/main)`
          + (pget(i, "outdated") === "yes" ? `, OUTDATED: local image is ${py(pget(i, "image_id"))}` : ""));
      }
    }
    return;
  }
  if (args[0] === "acquire") {
    const [want, pr] = [nth(args, 1), nth(args, 2)];
    const owner = args.length > 3 ? args[3] : "orchestrator";
    reclaimMoves();
    // Prefer a slot whose container is on the local image.
    const info = new Map(slots().filter(([n, p]) => (want === "any" || want === n) && exists(p) && !truthy(new SlotLock(n).holder()))
      .map(([n, p]) => [n, devcInfo(p)] as const));
    const order = sorted(slots(), (s) => pget(info.get(s[0]) || {}, "outdated") === "yes");
    {
      using lock = new Flock("slots").enter();
      if (slots().some(([s]) => {
        const h = new SlotLock(s).holder();
        return truthy(h) && item(h, "pr") === pr;
      })) {
        die(`#${pr} already holds a slot; never run one PR in two slots (repro.sh uses a shared repro-${pr} branch)`);
      }
      for (const [name, p] of order) {
        if (!(want === "any" || want === name) || !exists(p)) continue;
        const [ok, dirty] = checkoutState(p);
        if (!ok || dirty) {
          print(`slot ${name}: ${!ok ? "git status failed" : "dirty"}, skipped`, 2);
          continue;
        }
        if (new SlotLock(name).acquire({ pr, owner, at: iso(now()) })) {
          print(`${name}\t${p}`);
          const i = info.get(name) || {};
          if (pget(i, "outdated") === "yes") {
            print(`slot ${name}: its container is on image ${py(pget(i, "container_image"))}, older than the ` +
              `local ${py(pget(i, "image_id"))}; a tick moves it once it's free`, 2);
          }
          return;
        }
      }
    }
    die("no free slot", 3);
  }
  if (args[0] === "release") {
    const force = args.includes("--force");
    const rest = args.slice(1).filter((a) => a !== "--force");
    const [name, pr] = [nth(rest, 0), rest.length > 1 ? rest[1] : null];
    const p = new Map(slots().map(([n, q]) => [n, q] as const)).get(name);
    if (p === undefined) die(`no slot ${name}`);
    if (pr === null && !force) die(`usage: slot release ${name} <pr> (the PR it was acquired for), or --force`);
    const [ok, dirty, at] = checkoutState(p);
    if ((dirty || !ok) && !force) {
      die(ok ? `slot ${name} has changes; restore them (git checkout -- <file>) first:\n${dirty}` :
        `slot ${name}: git status failed in ${p}; check it, then release with --force`);
    }
    {
      using lock = new Flock("slots").enter();
      const h = new SlotLock(name).holder();
      // A repeated release (after a context reset, say) must not free a
      // slot another agent has since acquired.
      if (truthy(h) && pr !== null && item(h, "pr") !== pr && !force) {
        die(`slot ${name} is held for #${py(h.pr)} by ${py(item(h, "owner"))}, not #${pr}; not released`);
      }
      new SlotLock(name).release();
    }
    print(`slot ${name} released, at ${at}` + (at === "main" || at === "HEAD" ? "" : " (expected main)"));
    return;
  }
  die("usage: slot status | acquire <slot|any> <pr> [owner] | release <slot> <pr> | release <slot> --force", 2);
}

function show(e: Entry, headerOnly = false): void {
  const moved = [null, undefined, "-", e.head].includes(e.pr_head) ? "" : `, HEAD MOVED to ${e.pr_head.slice(0, 12)}`;
  print(`#${e.pr} [${py(e.lane)}] ${py(e.state)}: ${py(e.title)}\n  ${py(e.url)}\n` +
    `  prepared against ${e.head.slice(0, 12)} at ${py(pget(e, "prepared_at", "-"))}${moved}`
    + (!unset(e.my_teams) ? `\n  teams: ${e.my_teams}` : "")
    + (e.disposition !== "-" ? `\n  disposition: ${e.disposition} at ${py(item(e, "disposition_at"))}` : "")
    + (e.state === "waiting" ? `\n  waiting ${describeWait(e)}` : "")
    + (!unset(e.note) ? `\n  note: ${e.note}` : ""));
  if (!headerOnly) print(rstrip(e.body!));
}

function listCmd(showAll: boolean, target = TARGET): void {
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
function put(n: string, summary: string, head: string | null = null): void {
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

function present(): void {
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

function setCmd(n: string, kvs: string[]): void {
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
function heldEntry(n: string): Entry {
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
function authorOf(e: Entry): string | null {
  if (![null, undefined, "-", "", "ghost"].includes(e.author)) return e.author;
  const meta = pget(readCacheJson("candidates.json"), String(e.pr)) || {};
  return ![null, undefined, "ghost"].includes(pget(meta, "author")) ? meta.author : null;
}

// Hold a PR until others review it, it gets a push, --until passes, or
// (with --until-author) its author comments. Works for a candidate with no
// entry yet. No GitHub call: the push condition uses the latest head the
// bank has seen.
function holdCmd(n0: string, args0: string[]): void {
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
function deferCmd(n0: string, args: string[]): void {
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

function unholdCmd(n: string): void {
  let e: Entry;
  {
    using lock = entryLock(n).enter();
    e = load(n) ?? die(`no entry for ${n}`);
    if (e.state !== "waiting") die(`#${n} is ${e.state}, not waiting`);
    wake(e, ["unheld by hand"]);
  }
  show(e, true);
}

async function main(argv: string[]): Promise<void> {
  if (!argv.length) {
    print(DOC);
    return;
  }
  const [cmd, args] = [argv[0], argv.slice(1)];
  if (cmd === "tick" && !args.some((a) => ["--now", "--force", "--refresh"].includes(a))) {
    // Before me() and the lock: a backed-off tick makes no gh call.
    const line = tickBackedOff();
    if (line) {
      print(line);
      return;
    }
  }
  if (["tick", "sync", "plan", "prefetch"].includes(cmd)) me();
  if (["sync", "present", "prefetch", "put", "set", "hold", "unhold"].includes(cmd)) markActive();
  if (cmd === "tick") {
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
  } else if (cmd === "sync") {
    print(sync(args.length ? new Set(args) : null).join("\n"));
  } else if (cmd === "plan") {
    const target = args.includes("--target") ? pyInt(nth(args, args.indexOf("--target") + 1)) : TARGET;
    const [lines, counts] = plan(target, args.includes("--all"));
    print(`plan: eligible candidates by lane: ${counts}`);
    print(lines.join("\n") || "plan: bank is full");
  } else if (cmd === "list") {
    listCmd(args.includes("--all"));
  } else if (cmd === "show") {
    show(load(nth(args, 0)) ?? die(`no entry for ${args[0]}`));
  } else if (cmd === "present") {
    present();
  } else if (cmd === "prefetch") {
    prefetch(nth(args, 0));
  } else if (cmd === "put") {
    const hd = args.includes("--head") ? nth(args, args.indexOf("--head") + 1) : null;
    put(nth(args, 0), nth(args, 1), hd);
  } else if (cmd === "set") {
    setCmd(nth(args, 0), args.slice(1));
  } else if (cmd === "hold") {
    holdCmd(nth(args, 0), args.slice(1));
  } else if (cmd === "defer") {
    if (!args.length) die("usage: defer <pr> <reason...>", 2);
    deferCmd(args[0], args.slice(1));
  } else if (cmd === "unhold") {
    unholdCmd(nth(args, 0));
  } else if (cmd === "slot") {
    slotCmd(args);
  } else if (cmd === "image") {
    imageCmd(args);
  } else {
    die(`unknown command ${cmd}`, 2);
  }
}

// if __name__ == "__main__": a RuntimeError ends the run with its message;
// anything else prints its stack and exits 1, like a Python traceback.
let code = 0;
try {
  await main(process.argv.slice(2));
} catch (err) {
  let e = err;
  if (e instanceof RuntimeError) {
    try {
      die(e.message);
    } catch (x) {
      e = x;
    }
  }
  if (e instanceof SystemExit) {
    code = e.code;
  } else {
    print((e as Error)?.stack ?? String(e), 2);
    code = 1;
  }
}
process.exit(code);
