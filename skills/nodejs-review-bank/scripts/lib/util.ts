import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CACHE, CLONE } from "./config.ts";
import { AttributeError, type Dt, OSError, P, RuntimeError, STRERROR, SystemExit, TimeoutExpired, ValueError, cut, fromIsoFormat, isOSError, isValueError, nl, repr, splitlines, strip } from "./py.ts";

// Synchronous writes, so output is never lost on exit and keeps its order
// with the output of child processes that share the file.
export function write(fd: number, s: string): void {
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
export function print(s = "", fd = 1): void {
  write(fd, `${s}\n`);
}

// time.sleep: blocks the thread, like everything else here.
export function sleep(seconds: number): void {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

export function readText(p: string): string {
  return nl(fs.readFileSync(p, "utf8"));
}

export function writeText(p: string, s: string): void {
  fs.writeFileSync(p, s);
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// shutil.rmtree(p, ignore_errors=True)
export function rmtree(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore_errors
  }
}

export function mtime(p: string): number {
  return fs.statSync(p).mtimeMs / 1000;
}

// subprocess.run. stdin is inherited, as in Python. Output is text with
// universal newlines. stderr "stdout" merges the two (stderr=STDOUT) through
// one unlinked temp file, so they interleave as written. A command that can't
// start raises OSError; a timeout kills it and raises TimeoutExpired.
export type Proc = { returncode: number; stdout: string; stderr: string };
export type Stream = "pipe" | "inherit" | "devnull";
export type RunOpts = { env?: NodeJS.ProcessEnv; cwd?: string; stdout?: Stream; stderr?: Stream | "stdout"; timeout?: number };

export function run(cmd: string[], o: RunOpts = {}): Proc {
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

export function now(): Dt {
  return { t: Math.floor(Date.now() / 1000) * 1000, off: 0 };
}

export function iso(dt: Dt): string {
  if (!dt) throw new AttributeError("'NoneType' object has no attribute 'strftime'");
  const d = new Date(Math.floor(dt.t + dt.off));
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
}

// An aware datetime. A time without a zone is taken as UTC.
export function parseIso(s: string | null | undefined): Dt | null {
  if (!s || s === "-") return null;
  const t = strip(s).replaceAll("Z", "+00:00");
  const dt = fromIsoFormat(t);
  if (!dt) throw new ValueError(`Invalid isoformat string: ${repr(t)}`);
  return dt;
}

export function die(msg: string, code = 1): never {
  print(`bank: ${msg}`, 2);
  throw new SystemExit(code);
}

// Replace path in one step, so a reader never sees a partial file.
export function writeAtomic(p: string, text: string): void {
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

export function git(args: string[], { check = true } = {}): string {
  const p = run(["git", "-C", CLONE, ...args]);
  if (check && p.returncode !== 0) throw new RuntimeError(`git ${args.slice(0, 3).join(" ")}: ${cut(strip(p.stderr), -300)}`);
  return p.stdout;
}

export function readTsv(name: string): string[][] {
  const p = P(CACHE, name);
  if (!exists(p)) return [];
  return splitlines(readText(p)).filter((l) => strip(l)).map((l) => l.split("\t"));
}

export function readCacheJson(name: string): any {
  try {
    return JSON.parse(readText(P(CACHE, name)));
  } catch (err) {
    if (isOSError(err) || isValueError(err)) return {};
    throw err;
  }
}
