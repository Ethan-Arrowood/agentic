import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild } from "node:child_process";
import { CACHE, DEVC_IMAGE, ENV, IMAGE_CHECK_MIN, MOVE, NC, THIS } from "./config.ts";
import { Flock, SlotLock, running, workerLock } from "./lock.ts";
import { type Dt, KeyError, OSError, P, STRERROR, ValueError, cut, dumps, isOSError, isValueError, item, pget, py, pyStr, repr, rpartition, splitWs, strip, truthy } from "./py.ts";
import { type SlotRow, checkoutState, devcInfo, reclaimMoves, slots } from "./slots.ts";
import { die, exists, iso, now, parseIso, print, readCacheJson, run, writeAtomic } from "./util.ts";

// Whether ISO time t is under IMAGE_CHECK_MINUTES ago.
export function recent(t: string | null | undefined): boolean {
  const d = t ? parseIso(t) : null;
  return Boolean(d) && (now().t - d!.t) / 1000 < IMAGE_CHECK_MIN * 60;
}

// The UTC time at the start of an engine or Docker Hub timestamp
// (2026-11-19 03:59:40.16 +0000 UTC, 2026-11-20T04:31:57.43Z).
export function parseStamp(s: string | null | undefined): Dt | null {
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)/.exec(s || "");
  return m ? parseIso(`${m[1]}T${m[2]}Z`) : null;
}

export function hubUrl(): string | null {
  if (process.env.DEVC_HUB_URL) return process.env.DEVC_HUB_URL;
  const w = "[\\p{L}\\p{N}_.-]+";
  const m = new RegExp(`^(?:docker\\.io/)?(${w})/(${w}):(${w})$`, "u").exec(DEVC_IMAGE);
  return m ? `https://hub.docker.com/v2/repositories/${m[1]}/${m[2]}/tags/${m[3]}` : null;
}

// urllib.request.urlopen(url, timeout=...).read(), with urllib's errors:
// a file: URL is read from disk, anything else goes through fetch.
export async function urlopen(url: string, timeout: number): Promise<string> {
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
export async function hubInfo(): Promise<any> {
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
export function imageNewer(local: Record<string, string>, hub: any): boolean {
  const mine = new Set(splitWs(pget(local, "image_digests", "")).map((d) => rpartition(d, "@")[2]));
  if (!truthy(hub.digests) || hub.digests.some((d: string) => mine.has(d))) return false;
  const [built, pushed] = [parseStamp(local.image_created), parseStamp(hub.last_updated)];
  return Boolean(pushed) && (!built || pushed!.t > built.t);
}

// Start bank.ts <args> detached from this process, logging to cache/<log>.
export function spawn(args: string[], log: string): void {
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

// Pull a newer nightly when no slot is held, then move one free slot that
// is on an older image. Returns report lines.
export async function imageTick(): Promise<string[]> {
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
export function moveOne(rows: SlotRow[], info: Map<string, Record<string, string> | null>, image: string): string[] {
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
export function runPull(p: string): void {
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
export function runMove(name: string): void {
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

export function imageCmd(args: string[]): void {
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
