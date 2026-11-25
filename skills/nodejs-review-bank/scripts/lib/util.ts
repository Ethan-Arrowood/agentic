// Errors, output, time, text, files, and running commands.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CACHE, CLONE } from "./config.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// A failure the CLI reports as "bank: <message>", exiting with `code`.
// Thrown, not exited on the spot, so finally blocks and `using` locks unwind.
export class BankError extends Error {
  code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.name = "BankError";
    this.code = code;
  }
}

// A command the bank runs (gh, git, or a sibling script) failed.
export class CommandError extends BankError {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export function die(message: string, code = 1): never {
  throw new BankError(message, code);
}

// A Node system error, such as ENOENT from fs or a command that can't start.
export function isSystemError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Synchronous writes, so output is never lost on exit and keeps its order
// with the output of child processes that share the file.
function writeAll(fd: number, s: string): void {
  const b = Buffer.from(s);
  for (let off = 0; off < b.length; ) {
    try {
      off += fs.writeSync(fd, b, off);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      sleep(0.01);
    }
  }
}

export function print(s = ""): void {
  writeAll(1, `${s}\n`);
}

export function printErr(s: string): void {
  writeAll(2, `${s}\n`);
}

// Blocks the thread, like everything else here.
export function sleep(seconds: number): void {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

// ---------------------------------------------------------------------------
// Time: epoch milliseconds, written as 2026-11-25T13:00:00Z
// ---------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// Now, to the whole second, so it round-trips through iso().
export function now(): number {
  return Math.floor(Date.now() / SECOND) * SECOND;
}

export function iso(t: number): string {
  return `${new Date(t).toISOString().slice(0, 19)}Z`;
}

// Date, then optionally a time (T or a space before it) and a zone. A time
// without a zone is UTC.
const ISO_TIME = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d)(?::(\d\d)(?::(\d\d)(?:[.,](\d+))?)?)?(Z|[+-]\d\d(?::?\d\d)?)?)?$/;

// An ISO time, or null for an empty or unset ("-") field.
export function parseIso(s: string | null | undefined): number | null {
  if (!s || s === "-") return null;
  const m = ISO_TIME.exec(s.trim());
  if (!m) throw new BankError(`not an ISO time: '${s.trim()}'`);
  const [y, mo, d, h = 0, mi = 0, sec = 0] = m.slice(1, 7).map((x) => Number(x ?? 0));
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, sec);
  // setUTC* rolls over out-of-range values; a valid time comes back as given.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi || date.getUTCSeconds() !== sec) {
    throw new BankError(`not an ISO time: '${s.trim()}'`);
  }
  let t = date.getTime() + (m[7] ? Number(`0.${m[7]}`) * SECOND : 0);
  const zone = m[8];
  if (zone && zone !== "Z") {
    const [zh, zm = "0"] = [zone.slice(1, 3), zone.slice(3).replace(":", "")];
    if (Number(zh) > 23 || Number(zm) > 59) throw new BankError(`not an ISO time: '${s.trim()}'`);
    t -= (zone[0] === "-" ? -1 : 1) * (Number(zh) * HOUR + Number(zm) * MINUTE);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// \r\n and \r as \n, as every reader here expects.
function toLF(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

// The lines of s, without a trailing empty one.
export function lines(s: string): string[] {
  const out = s.split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
}

// s split at the first sep: [s, ""] when it has none.
export function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

// Runs of whitespace as one space, trimmed.
export function squash(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

// The first n characters of s, counting an emoji as one, so a cut never
// splits a surrogate pair.
export function clip(s: string, n: number): string {
  return s.length <= n ? s : Array.from(s).slice(0, n).join("");
}

// Sort by a key computed once per item; keys compare element by element.
// The sort is stable.
export function sortBy<T>(items: Iterable<T>, key: (x: T) => (number | string)[]): T[] {
  const keyed = Array.from(items, (x) => ({ x, k: key(x) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < Math.min(a.k.length, b.k.length); i++) {
      if (a.k[i] < b.k[i]) return -1;
      if (a.k[i] > b.k[i]) return 1;
    }
    return a.k.length - b.k.length;
  });
  return keyed.map(({ x }) => x);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function readText(p: string): string {
  return toLF(fs.readFileSync(p, "utf8"));
}

export function writeText(p: string, s: string): void {
  fs.writeFileSync(p, s);
}

// Replace p in one step, so a reader never sees a partial file.
export function writeAtomic(p: string, text: string): void {
  let fd = -1, tmp = "";
  for (let i = 0; fd < 0; i++) {
    tmp = path.join(path.dirname(p), `.${path.basename(p)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      fd = fs.openSync(tmp, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || i > 100) throw err;
    }
  }
  try {
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

export function writeJson(p: string, value: unknown): void {
  writeAtomic(p, JSON.stringify(value));
}

// Remove a file or directory tree. Errors are ignored: it's cleanup.
export function removeTree(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // Nothing more to do.
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// cache/<name> as an object, or {} when it is missing or not a JSON object.
export function readCacheJson<T extends object>(name: string): Partial<T> {
  try {
    const data: unknown = JSON.parse(readText(path.join(CACHE, name)));
    return isRecord(data) ? (data as Partial<T>) : {};
  } catch {
    return {};
  }
}

export function writeCacheJson(name: string, value: unknown): void {
  writeJson(path.join(CACHE, name), value);
}

// The non-blank rows of cache/<name>, split on tabs.
export function readTsv(name: string): string[][] {
  const p = path.join(CACHE, name);
  if (!fs.existsSync(p)) return [];
  return lines(readText(p)).filter((l) => l.trim()).map((l) => l.split("\t"));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type RunResult = { status: number; stdout: string; stderr: string; timedOut: boolean };
type Stream = "pipe" | "inherit" | "ignore";
type RunOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: Stream;
  stderr?: Stream | "stdout"; // "stdout" merges stderr into stdout
  timeout?: number; // seconds
};

// Run a command to completion. stdin is inherited. Output is text with \n
// line ends. A command killed by a signal has a negative status. A command
// that can't start throws the spawn error; a timeout kills it.
export function run(cmd: string[], opts: RunOptions = {}): RunResult {
  const stdio: (Stream | number)[] = ["inherit", opts.stdout ?? "pipe", opts.stderr === "stdout" ? "pipe" : opts.stderr ?? "pipe"];
  // Merged output goes through one unlinked temp file, so the two streams
  // interleave as written.
  let merged = -1;
  if (opts.stderr === "stdout") {
    const tmp = path.join(os.tmpdir(), `bank-out-${process.pid}-${randomBytes(6).toString("hex")}`);
    merged = fs.openSync(tmp, "w+", 0o600);
    fs.unlinkSync(tmp);
    stdio[1] = stdio[2] = merged;
  }
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), {
      env: opts.env, cwd: opts.cwd, stdio, maxBuffer: 2 ** 30, killSignal: "SIGKILL",
      timeout: opts.timeout === undefined ? undefined : opts.timeout * 1000,
    });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (r.error && !timedOut) throw r.error;
    let stdout = r.stdout ? toLF(r.stdout.toString()) : "";
    const stderr = r.stderr ? toLF(r.stderr.toString()) : "";
    if (merged >= 0) {
      const buf = Buffer.alloc(fs.fstatSync(merged).size);
      fs.readSync(merged, buf, 0, buf.length, 0);
      stdout = toLF(buf.toString());
    }
    const signal = r.signal ? os.constants.signals[r.signal] : 0;
    return { status: r.status ?? -signal, stdout, stderr, timedOut };
  } finally {
    if (merged >= 0) fs.closeSync(merged);
  }
}

// The last n characters of a command's stderr, for an error message.
export function stderrTail(r: RunResult, n = 300): string {
  return r.stderr.trim().slice(-n);
}

// git in the node clone. Throws CommandError on failure unless check is false.
export function git(args: string[], { check = true } = {}): string {
  const r = run(["git", "-C", CLONE, ...args]);
  if (check && r.status !== 0) throw new CommandError(`git ${args.slice(0, 3).join(" ")}: ${stderrTail(r)}`);
  return r.stdout;
}
