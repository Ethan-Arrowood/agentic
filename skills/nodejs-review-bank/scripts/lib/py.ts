import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Python compatibility. Not in bank.py: the pieces of Python's behavior the
// port needs to print, parse, and store the same things.
// ---------------------------------------------------------------------------

// Python's exception types, where bank.py catches or reports them by type.
export class RuntimeError extends Error {}
export class ValueError extends Error {}
export class OSError extends Error {}
export class KeyError extends Error {}
export class AttributeError extends Error {}
export class TimeoutExpired extends Error {
  stdout = "";
  stderr = "";
}
for (const c of [RuntimeError, ValueError, OSError, KeyError, AttributeError, TimeoutExpired]) c.prototype.name = c.name;
// sys.exit: thrown, so finally blocks and `using` locks unwind as in Python.
export class SystemExit {
  code: number;
  constructor(code: number) {
    this.code = code;
  }
}

// OSError: ours, or a Node system error (ENOENT and the like).
export function isOSError(err: unknown): boolean {
  const e = err as { code?: unknown; errno?: unknown };
  return err instanceof OSError || (err instanceof Error && typeof e.code === "string" && typeof e.errno === "number");
}

// ValueError: ours, or a JSON.parse failure (json.loads raises ValueError).
export function isValueError(err: unknown): boolean {
  return err instanceof ValueError || err instanceof SyntaxError;
}

// str(err). A KeyError prints its key in quotes, as Python does.
export function pyStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


// What str.isspace() and Python's \s count as whitespace.
export const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const STRIP_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
export const RSTRIP_RE = new RegExp(`[${WS}]+$`);
export const SPLIT_RE = new RegExp(`[${WS}]+`);

export function strip(s: string): string {
  return s.replace(STRIP_RE, "");
}

export function rstrip(s: string): string {
  return s.replace(RSTRIP_RE, "");
}

// str.split() with no separator.
export function splitWs(s: string): string[] {
  return s.split(SPLIT_RE).filter(Boolean);
}

// str.splitlines(): every line boundary Python knows, no trailing empty line.
export function splitlines(s: string): string[] {
  const out = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (out.at(-1) === "") out.pop();
  return out;
}

// Universal newlines: Python's text mode turns \r\n and \r into \n.
export function nl(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

export function partition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

export function rpartition(s: string, sep: string): [string, string, string] {
  const i = s.lastIndexOf(sep);
  return i < 0 ? ["", "", s] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

// s[start:end], counted in code points as Python does, not UTF-16 units.
export function cut(s: string, start: number, end?: number): string {
  if (!/[\uD800-\uDFFF]/.test(s)) return s.slice(start, end);
  return Array.from(s).slice(start, end).join("");
}

// f"{s:<n}": pad to n code points.
export function ljust(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - Array.from(s).length));
}

export function startsWithAny(s: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => s.startsWith(p));
}

// How an f-string shows a value: None, True, False.
export function py(v: unknown): string {
  return v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v);
}

export function repr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// Python truthiness: empty lists, dicts, and strings are false.
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Set || v instanceof Map) return v.size > 0;
  if (v !== null && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

// unset(v): v in (None, "-").
export function unset(v: unknown): boolean {
  return v === null || v === undefined || v === "-";
}

// dict.get(k, default): the default only when the key is missing.
export function pget(o: any, k: string, d: any = null): any {
  return o !== null && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : d;
}

// d[k] on parsed JSON: KeyError when missing, TypeError on a non-dict.
export function item(o: any, k: string): any {
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new TypeError(`${py(o)} is not a dict`);
  if (!Object.hasOwn(o, k)) throw new KeyError(repr(k));
  return o[k];
}

// args[i]: IndexError when it is missing.
export function nth(xs: string[], i: number): string {
  if (i >= xs.length) throw new Error("IndexError: list index out of range");
  return xs[i];
}

// a, b = xs: ValueError unless xs has exactly n items.
export function unpack<T>(xs: T[], n: number): T[] {
  if (xs.length !== n) {
    throw new ValueError(xs.length < n ? `not enough values to unpack (expected ${n}, got ${xs.length})`
      : `too many values to unpack (expected ${n})`);
  }
  return xs;
}

// A dict without Object.prototype, so any key is safe.
export function dict<T = any>(o: object = {}): Record<string, T> {
  return Object.assign(Object.create(null), o);
}

// int(s) and float(s), with Python's accepted forms and its ValueError.
export function pyInt(s: string | number): number {
  if (typeof s === "number") return Math.trunc(s);
  const m = new RegExp(`^[${WS}]*([+-]?\\d+(?:_\\d+)*)[${WS}]*$`).exec(s);
  if (!m) throw new ValueError(`invalid literal for int() with base 10: ${repr(s)}`);
  return Number(m[1].replaceAll("_", ""));
}

export function pyFloat(s: string): number {
  const t = strip(s).replace(/(?<=\d)_(?=\d)/g, "");
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return Number(t);
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (m) return m[2].toLowerCase() === "nan" ? NaN : m[1] === "-" ? -Infinity : Infinity;
  throw new ValueError(`could not convert string to float: ${repr(s)}`);
}

// f"{x:.0f}": rounds half to even.
export function fmt0(x: number): string {
  const f = Math.floor(x), d = x - f;
  return String(d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1);
}

// GATES_QUERY % (a, b, c): fill each %s in turn.
export function pct(s: string, ...args: string[]): string {
  let i = 0;
  return s.replace(/%s/g, () => args[i++]);
}

// Regex pieces for Python's semantics. \w and \b are Unicode-aware in
// Python (use with the u flag). In MULTILINE mode ^ and $ match only at \n,
// and . never matches \n alone, where JS also stops at \r, \u2028, \u2029.
export const W = "[\\p{L}\\p{N}_]";
export const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
export const BOL = "(?:(?<![\\s\\S])|(?<=\\n))";
export const EOL = "(?=\\n|(?![\\s\\S]))";
export const DOT = "[^\\n]";

// json.dumps: ", " and ": " separators (or one item per line with indent),
// and ensure_ascii, so files written by the earlier bank.py read the same.
export function jsonStr(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function dumps(v: any, indent?: number, level = 0): string {
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
export type Key = number | string | boolean | null | Key[];

export function cmp(a: Key, b: Key): number {
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

export function sorted<T>(xs: Iterable<T>, key: (x: T) => Key = (x) => x as Key): T[] {
  const dec = Array.from(xs, (x) => ({ x, k: key(x) }));
  dec.sort((a, b) => cmp(a.k, b.k));
  return dec.map((d) => d.x);
}

// An aware datetime: t is epoch milliseconds (microseconds in the fraction)
// and off the UTC offset in milliseconds. iso() prints the wall clock at
// off, like strftime on a datetime in that zone.
export type Dt = { t: number; off: number };
export const EPOCH: Dt = { t: 0, off: 0 };
export const add = (d: Dt, ms: number): Dt => ({ t: d.t + ms, off: d.off });
// timedelta(hours=..., minutes=..., days=...), to the microsecond.
export const hours = (x: number): number => Math.round(x * 3600e6) / 1000;
export const minutes = (x: number): number => Math.round(x * 60e6) / 1000;
export const days = (x: number): number => Math.round(x * 86400e6) / 1000;
// max(a, b) keeps the first of equal times.
export const maxDt = (a: Dt, b: Dt): Dt => (b.t > a.t ? b : a);
// datetime.fromtimestamp(s, timezone.utc).replace(microsecond=0)
export const fromTimestamp = (s: number): Dt => ({ t: Math.floor(s) * 1000, off: 0 });
// .date() as a day number, and .weekday() (Monday is 0) of one.
export const dateOf = (d: Dt): number => Math.floor((d.t + d.off) / 86400000);
export const weekday = (day: number): number => (((day + 3) % 7) + 7) % 7;

export function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, 0);
  return dt.getTime();
}

export function daysIn(y: number, mo: number): number {
  return new Date(utcMs(y, mo + 1, 0)).getUTCDate();
}

// datetime.fromisoformat (Python 3.11+): extended or basic dates, ISO week
// dates, any one-character separator, HH[:MM[:SS[.f]]], and a +HH[:MM[:SS]]
// offset. Null when Python would raise.
export function fromIsoFormat(s: string): Dt | null {
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
export function P(...parts: string[]): string {
  let s = "";
  for (const p of parts) s = p.startsWith("/") ? p : s ? `${s}/${p}` : p;
  const lead = s.startsWith("//") && !s.startsWith("///") ? "//" : s.startsWith("/") ? "/" : "";
  return lead + s.split("/").filter((x) => x && x !== ".").join("/") || (lead || ".");
}

// Path.resolve(): symlinks resolved as far as the path exists.
export function resolvePath(p: string): string {
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
export function stem(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

export function environ(k: string): string {
  const v = process.env[k];
  if (v === undefined) throw new KeyError(repr(k));
  return v;
}

export const STRERROR: Record<string, string> = {
  ENOENT: "No such file or directory", EACCES: "Permission denied", ENOTDIR: "Not a directory",
  ENOEXEC: "Exec format error", E2BIG: "Argument list too long",
};
