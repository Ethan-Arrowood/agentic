// Image freshness. Slot builds start from the devcontainer image's prebuilt
// out/, so the image's age sets the cost of every first build. The tick pulls a
// newer nightly when no slot is held, then moves free slots to it one at a time
// (devc.sh down, then build). Both run in the background. Neither touches a held
// slot: a move holds its slot itself, as owner image-move.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BANK_SCRIPT, CACHE, DEVC_IMAGE, ENV, IMAGE_CHECK_MINUTES, MOVE, NC } from "./config.ts";
import { Flock, type SlotOwner, SlotLock, running, workerLock } from "./lock.ts";
import { type DevcInfo, checkoutState, devcInfo, reclaimMoves, slots } from "./slots.ts";
import {
  MINUTE, clip, die, iso, now, parseIso, print, readCacheJson, run, writeCacheJson,
} from "./util.ts";

// cache/image-hub.json: Docker Hub's view of the tag.
type HubInfo = { checked_at: string; digests: string[]; last_updated: string; error: string };
// cache/image-pull.json: the last pull. rc and finished_at once it ends.
type PullRecord = { started_at: string; from: string; path: string; rc: number; finished_at: string };
// cache/image-moves.json: the last move per slot.
type MoveRecord = { at: string; from: string | null; to: string | null; step: string; rc: number; finished_at: string };

type SlotRow = { name: string; path: string; holder: SlotOwner | null };

// Whether ISO time t is under IMAGE_CHECK_MINUTES ago.
function recent(t: string | undefined): boolean {
  const at = parseIso(t);
  return at !== null && now() - at < IMAGE_CHECK_MINUTES * MINUTE;
}

// The UTC time at the start of an engine or Docker Hub timestamp
// (2026-11-19 03:59:40.16 +0000 UTC, 2026-11-20T04:31:57.43Z).
function parseStamp(s: string | undefined): number | null {
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)/.exec(s ?? "");
  return m ? parseIso(`${m[1]}T${m[2]}Z`) : null;
}

function hubUrl(): string | null {
  if (process.env.DEVC_HUB_URL) return process.env.DEVC_HUB_URL;
  const m = /^(?:docker\.io\/)?([\w.-]+)\/([\w.-]+):([\w.-]+)$/.exec(DEVC_IMAGE);
  return m ? `https://hub.docker.com/v2/repositories/${m[1]}/${m[2]}/tags/${m[3]}` : null;
}

// The body of a URL: a file: URL is read from disk (the tests use one),
// anything else goes through fetch.
async function fetchText(url: string, timeoutSeconds: number): Promise<string> {
  const scheme = /^([a-z][\w+.-]*):/i.exec(url)?.[1].toLowerCase();
  if (scheme === "file") return fs.readFileSync(fileURLToPath(url), "utf8");
  if (scheme !== "http" && scheme !== "https") throw new Error(`unsupported URL ${url}`);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutSeconds * 1000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return await r.text();
  } catch (err) {
    const e = err as Error & { cause?: Error };
    throw new Error(e.name === "TimeoutError" ? "timed out" : e.cause?.message ?? e.message);
  }
}

// Docker Hub's view of the tag (its digests and last_updated), fetched at
// most every IMAGE_CHECK_MINUTES. A failed fetch keeps the last good result.
async function hubInfo(): Promise<Partial<HubInfo>> {
  const old = readCacheJson<HubInfo>("image-hub.json");
  if (recent(old.checked_at)) return old;
  const url = hubUrl();
  if (!url) return { error: `${DEVC_IMAGE} is not a Docker Hub tag` };
  const info: Partial<HubInfo> = { checked_at: iso(now()) };
  try {
    const d = JSON.parse(await fetchText(url, 30));
    if (typeof d !== "object" || d === null || !("digest" in d) || !("last_updated" in d)) {
      throw new Error("no digest or last_updated in Docker Hub's answer");
    }
    const images: { digest?: string }[] = Array.isArray(d.images) ? d.images : [];
    info.digests = [d.digest, ...images.flatMap((i) => (i.digest ? [i.digest] : []))];
    info.last_updated = d.last_updated;
  } catch (err) {
    if (old.digests !== undefined) info.digests = old.digests;
    if (old.last_updated !== undefined) info.last_updated = old.last_updated;
    info.error = clip(err instanceof Error ? err.message : String(err), 120);
  }
  writeCacheJson("image-hub.json", info);
  return info;
}

// Whether Docker Hub's tag is another image, pushed after the local one was
// built. Either the index digest or a per-platform one can be local.
function imageNewer(local: DevcInfo, hub: Partial<HubInfo>): boolean {
  const mine = new Set((local.image_digests ?? "").split(/\s+/).filter(Boolean).map((d) => d.slice(d.lastIndexOf("@") + 1)));
  if (!hub.digests?.length || hub.digests.some((d) => mine.has(d))) return false;
  const built = parseStamp(local.image_created), pushed = parseStamp(hub.last_updated);
  return pushed !== null && (built === null || pushed > built);
}

// Start bank.ts <args> detached from this process, logging to cache/<log>.
function startWorker(args: string[], log: string): void {
  const fd = fs.openSync(path.join(CACHE, log), "w");
  try {
    const child = spawn(process.execPath, [...process.execArgv, BANK_SCRIPT, ...args],
      { env: ENV, stdio: ["ignore", fd, fd], detached: true });
    child.on("error", () => {});
    if (!child.pid) throw new Error(`could not start ${process.execPath}`);
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

// Pull a newer nightly when no slot is held, then move one free slot that
// is on an older image. Returns report lines.
export async function imageTick(): Promise<string[]> {
  const out = reclaimMoves();
  const rows: SlotRow[] = slots().filter(([, p]) => fs.existsSync(p))
    .map(([name, p]) => ({ name, path: p, holder: new SlotLock(name).holder() }));
  const info = new Map(rows.map((r) => [r.name, devcInfo(r.path)]));
  const first = rows.find((r) => info.get(r.name));
  if (!first) return [...out, "no slot checkout answered devc.sh image; skipped"];
  const local = info.get(first.name)!;
  if ((local.image_id ?? "missing") === "missing") {
    return [...out, `${DEVC_IMAGE} not found (missing, or the engine is down); a pull needs the user (about 10 GB)`];
  }
  const hub = await hubInfo();
  let line = `local ${local.image_id} built ${clip(local.image_created || "?", 16)}`;
  if (hub.last_updated) line += `, Docker Hub updated ${clip(hub.last_updated, 16)}`;
  if (hub.error) line += ` (check failed: ${clip(hub.error, 80)})`;
  const held = rows.filter((r) => r.holder).map((r) => `slot ${r.name} for #${r.holder!.pr}`);
  const last = readCacheJson<PullRecord>("image-pull.json");
  const log = path.join(CACHE, "image-pull.log");
  if (running("image-pull")) return [...out, `${line}; pull running since ${last.started_at ?? "?"} (log ${log})`];
  if (!hub.digests?.length) {
    out.push(`${line}; not compared`);
  } else if (!imageNewer(local, hub)) {
    out.push(`${line}; current`);
  } else if (held.length) {
    // No moves either: they would rebuild on an image the pull replaces.
    return [...out, `${line}; newer on Docker Hub, the pull and any moves wait until no slot is held ` +
      `(${held.join(", ")})`];
  } else if (recent(last.started_at)) {
    const how = last.rc !== undefined ? `exited ${last.rc}` : "did not finish";
    out.push(`${line}; newer on Docker Hub, but the pull at ${last.started_at} ${how}; ` +
      `retried ${IMAGE_CHECK_MINUTES} minutes after it (log ${log})`);
  } else {
    writeCacheJson("image-pull.json", { started_at: iso(now()), from: local.image_id, path: first.path });
    startWorker(["image", "run-pull", first.path], path.basename(log));
    return [...out, `${line}; newer on Docker Hub, pulling in the background (about 2 minutes, log ${log})`];
  }
  return [...out, ...moveOne(rows, info, local.image_id!)];
}

// Hold one free slot whose container is on an older image as image-move,
// and move it in the background. One at a time, so other slots stay free.
function moveOne(rows: SlotRow[], info: Map<string, DevcInfo | null>, image: string): string[] {
  const moving = rows.find((r) => r.holder?.owner === MOVE);
  if (moving) {
    const h = moving.holder!;
    return [`slot ${moving.name}: moving to ${h.to ?? "?"} since ${h.at} (log ${path.join(CACHE, `image-move-${moving.name}.log`)})`];
  }
  const moves = readCacheJson<Record<string, Partial<MoveRecord>>>("image-moves.json"), out: string[] = [];
  for (const { name, path: p, holder: h } of rows) {
    const i = info.get(name);
    if (!i || i.outdated !== "yes") continue;
    const { ok, dirty, branch } = checkoutState(p);
    const last = moves[name] ?? {};
    let why = h ? `held for #${h.pr}` :
      !ok ? "git status failed" :
      dirty ? "checkout has changes" :
      !(branch === "main" || branch === "HEAD") ? `checkout is on ${branch}, not main` :
      i.busy !== "no" ? "something runs in its container" :
      last.to === image && last.rc && recent(last.at) ? `the move at ${last.at} failed at ${last.step}` : null;
    if (!why) {
      let got: boolean;
      {
        using lock = new Flock("slots").enter();
        got = new SlotLock(name).acquire({ pr: MOVE, owner: MOVE, at: iso(now()), from: i.container_image, to: image });
      }
      if (got) {
        startWorker(["image", "run-move", name], `image-move-${name}.log`);
        return [...out, `slot ${name}: moving from ${i.container_image} to ${image} in the background ` +
          "(devc.sh down, then build: about 3 to 5 minutes)"];
      }
      why = "acquired meanwhile";
    }
    out.push(`slot ${name}: on older image ${i.container_image}; the move waits (${why})`);
  }
  return out;
}

// Background worker: devc.sh pull, with the result in cache/image-pull.json.
function runPull(p: string): void {
  const lock = workerLock("image-pull");
  if (!lock) die("another pull is running", 0);
  print(`=== devc.sh pull in ${p} @ ${iso(now())}`);
  const rc = run([path.join(NC, "devc.sh"), "pull"], { cwd: p, env: ENV, stdout: "inherit", stderr: "inherit" }).status;
  writeCacheJson("image-pull.json", { ...readCacheJson<PullRecord>("image-pull.json"), rc, finished_at: iso(now()) });
  print(`=== exit ${rc} @ ${iso(now())}`);
}

// Background worker: down and build in a slot held as image-move, then
// release it. Checks again that nothing runs in the container first.
function runMove(name: string): void {
  const p = new Map(slots()).get(name);
  const lock = workerLock("image-move");
  const h = new SlotLock(name).holder();
  const rec: Partial<MoveRecord> = { at: iso(now()), from: h?.from ?? null, to: h?.to ?? null };
  try {
    if (h?.owner !== MOVE) {
      print(`slot ${name} is not held for a move; nothing to do`);
      return;
    }
    const i = lock && p ? devcInfo(p) : null;
    if (!i || i.outdated !== "yes" || i.busy !== "no") {
      Object.assign(rec, { step: "check", rc: i?.outdated === "no" ? 0 : 1 });
      print(`not moving slot ${name}: ` + (rec.rc === 0 ? "no longer outdated" :
        !lock ? "another move is running" : "devc.sh image failed, or something runs in it"));
    } else {
      for (const step of ["down", "build"]) {
        print(`=== devc.sh ${step} in ${p} @ ${iso(now())}`);
        const rc = run([path.join(NC, "devc.sh"), step], { cwd: p, env: ENV, stdout: "inherit", stderr: "inherit" }).status;
        Object.assign(rec, { step, rc });
        if (rc) break;
      }
    }
    const moves = readCacheJson<Record<string, Partial<MoveRecord>>>("image-moves.json");
    moves[name] = { ...rec, finished_at: iso(now()) };
    writeCacheJson("image-moves.json", moves);
    print(`=== slot ${name}: ${rec.step} exit ${rec.rc} @ ${iso(now())}`);
  } finally {
    using slotsLock = new Flock("slots").enter();
    if (new SlotLock(name).holder()?.owner === MOVE) new SlotLock(name).release();
  }
}

export function imageCmd(args: string[]): void {
  if (args[0] === "prune") {
    // Only free slots, and devc.sh prune keeps the volumes of the local
    // image and of the slot's container. Other checkouts' volumes never match.
    for (const [name, p] of slots()) {
      const h = new SlotLock(name).holder();
      if (h || !fs.existsSync(p)) {
        print(`slot ${name}: ${h ? `held for #${h.pr}` : "missing"}, skipped`);
        continue;
      }
      const r = run([path.join(NC, "devc.sh"), "prune"], { cwd: p, env: ENV, stderr: "stdout" });
      print(`slot ${name}: ${(r.stdout.trim() || "nothing to remove").replaceAll("\n", "\n  ")}`);
    }
    return;
  }
  if (args[0] === "run-pull" && args.length === 2) return runPull(args[1]);
  if (args[0] === "run-move" && args.length === 2) return runMove(args[1]);
  die("usage: image prune", 2);
}
