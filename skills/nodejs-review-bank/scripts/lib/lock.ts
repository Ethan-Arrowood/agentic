// Locks: Flock for a lock held while this process runs, and SlotLock for a
// build slot held across processes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { LOCKS, SLOT_OWNERLESS_GRACE } from "./config.ts";
import { SECOND, isDir, isRecord, now, readText, removeTree, sleep, writeJson } from "./util.ts";

// Node has no file lock, so each held lock is a small zsh process that holds
// a zsystem flock (an fcntl lock, the same kind the bin/gh shim takes; on
// macOS it also excludes flock users). The helper's stdin and stdout are FIFOs:
//   - acquire blocks in a plain readSync on the helper's stdout until it
//     prints "locked" (got it) or exits without it (busy with -t 0, or failed).
//     A FIFO read end opened without O_NONBLOCK blocks, unlike Node's pipes.
//   - release closes the helper's stdin. It reads EOF, unlocks, and exits,
//     and the readSync that waits for its stdout to close returns then.
// The kernel drops the lock when the helper exits. The helper exits when this
// process dies (its stdin closes), so a crash can't leave a lock stuck. Node
// opens files close-on-exec, so no other child keeps a helper's stdin open.
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

// Lock `file`, waiting for it, or giving up at once when `wait` is false.
// Null when it is busy.
export function zshFlock(file: string, wait: boolean): Held | null {
  fs.closeSync(fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o644));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-lock-"));
  try {
    const fin = path.join(dir, "in"), fout = path.join(dir, "out");
    if (spawnSync("mkfifo", ["-m", "600", fin, fout]).status !== 0) throw new Error(`mkfifo failed in ${dir}`);
    const [inR, inW] = fifoEnds(fin), [outR, outW] = fifoEnds(fout);
    let child;
    try {
      child = spawn("zsh", ["-fc", LOCK_HELPER, "bank-lock", path.resolve(file), ...(wait ? [] : ["-t", "0"])],
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
      throw new Error(`could not run zsh to lock ${file}`);
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
    removeTree(dir);
  }
}

export function unlock(h: Held): void {
  fs.closeSync(h.stdin);
  const buf = Buffer.alloc(64);
  while (fs.readSync(h.stdout, buf, 0, buf.length, null));
  fs.closeSync(h.stdout);
}

// locks/<name>.lock, held until release() or the end of this process.
// `using lock = new Flock(name).enter()` holds it for a block.
export class Flock {
  path: string;
  held: Held | null = null;

  constructor(name: string) {
    this.path = path.join(LOCKS, `${name}.lock`);
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

export function entryLock(pr: string): Flock {
  return new Flock(`entry-${pr}`);
}

// Whether a background worker holds Flock(name).
export function running(name: string): boolean {
  const lock = new Flock(name);
  if (lock.acquire(false)) {
    lock.release();
    return false;
  }
  return true;
}

// Flock(name) for a worker, retried briefly: a tick probing it with
// running() holds it for a moment.
export function workerLock(name: string): Flock | null {
  const lock = new Flock(name);
  for (let i = 0; i < 20; i++) {
    if (lock.acquire(false)) return lock;
    sleep(0.5);
  }
  return null;
}

// Who holds a slot. A slot moving to a new image is held with pr and owner
// both MOVE, and records the images it moves from and to.
export type SlotOwner = { pr: string; owner: string; at: string; from?: string; to?: string };

// A slot is held across processes (acquire and release are separate
// commands), so it is a directory with an owner record, not a Flock. Callers
// hold Flock("slots") while they change one.
export class SlotLock {
  path: string;

  constructor(name: string) {
    this.path = path.join(LOCKS, `slot-${name}`);
  }

  // The owner record, or null when the slot is free or the record is
  // missing, unreadable, or empty.
  holder(): SlotOwner | null {
    let data: unknown;
    try {
      data = JSON.parse(readText(path.join(this.path, "owner.json")));
    } catch {
      return null;
    }
    return isRecord(data) && Object.keys(data).length ? (data as SlotOwner) : null;
  }

  // When a lock dir without an owner record was made (to the second), or null.
  ownerlessSince(): number | null {
    if (!isDir(this.path) || this.holder()) return null;
    return Math.floor(fs.statSync(this.path).mtimeMs / SECOND) * SECOND;
  }

  acquire(owner: SlotOwner): boolean {
    const since = this.ownerlessSince();
    if (since !== null && now() - since > SLOT_OWNERLESS_GRACE * SECOND) this.release();
    try {
      fs.mkdirSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    writeJson(path.join(this.path, "owner.json"), owner);
    return true;
  }

  release(): void {
    // The whole tree, not just the dir: a crash during acquire can leave a temp file.
    removeTree(this.path);
  }
}
