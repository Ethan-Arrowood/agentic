import { printErr } from "./util.ts";

import { type RunResult } from "./util.ts";

import { BANK, CLONE, ENV, MOVE, NC, SLOT_OWNERLESS_GRACE } from "./config.ts";
import { P, TimeoutExpired, cut, dict, exists, isOSError, iso, item, now, nth, parseIso, partition, pget, py, sorted, splitlines, strip, truthy, unpack } from "./py.ts";
import { die, print, readCacheJson, readText, run, writeText } from "./util.ts";

import { Flock, SlotLock, running } from "./lock.ts";

export function slots(): string[][] {
  const conf = P(BANK, "slots.tsv");
  if (!exists(conf)) writeText(conf, `1\t${CLONE}\n2\t${CLONE}/.claude/worktrees/review-b\n`);
  // Every caller unpacks a row into (name, path), so a malformed row raises.
  return splitlines(readText(conf)).filter((l) => strip(l)).map((l) => unpack(l.split("\t"), 2));
}

// [usable, dirty lines, HEAD name]. Unusable when git status fails.
export function checkoutState(p: string): [boolean, string, string] {
  const st = run(["git", "-C", p, "status", "--porcelain"]);
  const at = strip(run(["git", "-C", p, "rev-parse", "--abbrev-ref", "HEAD"]).stdout);
  return [st.status === 0, strip(st.stdout), at];
}

// Image freshness. Slot builds start from the devcontainer image's prebuilt
// out/, so the image's age sets the cost of every first build. The tick pulls a
// newer nightly when no slot is held, then moves free slots to it one at a time
// (devc.sh down, then build). Both run in the background. Neither touches a held
// slot: a move holds its slot itself, as owner image-move.

// devc.sh image in a checkout, as a dict, or null when it fails.
export function devcInfo(p: string): Record<string, string> | null {
  let r: RunResult;
  try {
    r = run([P(NC, "devc.sh"), "image"], { cwd: p, env: ENV, timeout: 120 });
  } catch (err) {
    if (isOSError(err) || err instanceof TimeoutExpired) return null;
    throw err;
  }
  if (r.status !== 0) return null;
  const d: Record<string, string> = dict();
  for (const l of splitlines(r.stdout)) {
    if (l.includes("=")) {
      const [k, , v] = partition(l, "=");
      d[k] = v;
    }
  }
  return d;
}

// Free a slot still held for a move whose worker is gone.
export function reclaimMoves(): string[] {
  if (running("image-move")) return [];
  const out: string[] = [];
  using lock = new Flock("slots").enter();
  for (const [name] of slots()) {
    const h = new SlotLock(name).holder();
    if (truthy(h) && pget(h, "owner") === MOVE && (now().t - parseIso(h!.at)!.t) / 1000 > SLOT_OWNERLESS_GRACE) {
      new SlotLock(name).release();
      out.push(`slot ${name}: its move worker is gone; released`);
    }
  }
  return out;
}

export type SlotRow = [string, string, any];

// Commits on upstream/main, as last fetched, since commit, or ?.
export function behindMain(commit: string | null): string {
  if (!/^[0-9a-f]{7,40}$/.test(commit || "")) return "?";
  const p = run(["git", "-C", CLONE, "rev-list", "--count", `${commit}..refs/remotes/upstream/main`], { stderr: "ignore" });
  return p.status === 0 ? strip(p.stdout) : "?";
}

export function slotCmd(args: string[]): void {
  if (!args.length || args[0] === "status") {
    const hub = readCacheJson<any>("image-hub.json");
    if (pget(hub, "last_updated")) {
      print(`image: Docker Hub updated ${cut(hub.last_updated, 0, 16)} (checked ${py(pget(hub, "checked_at"))})`
        + (running("image-pull") ? ", pull running" : ""));
    }
    for (const [name, p] of slots()) {
      const lock = new SlotLock(name);
      const [h, since] = [lock.holder(), lock.ownerlessSince()];
      const held = (truthy(h) && pget(h, "owner") === MOVE ? `moving to image ${py(pget(h, "to"))} since ${py(item(h, "at"))}` :
        truthy(h) ? `held for #${py(item(h, "pr"))} by ${py(item(h, "owner"))} since ${py(item(h, "at"))}` :
        since ? `lock has no owner record since ${iso({ t: since, off: 0 })} (reclaimed after ${SLOT_OWNERLESS_GRACE}s)`
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
          printErr(`slot ${name}: ${!ok ? "git status failed" : "dirty"}, skipped`);
          continue;
        }
        if (new SlotLock(name).acquire({ pr, owner, at: iso(now()) })) {
          print(`${name}\t${p}`);
          const i = info.get(name) || {};
          if (pget(i, "outdated") === "yes") {
            printErr(`slot ${name}: its container is on image ${py(pget(i, "container_image"))}, older than the ` +
              `local ${py(pget(i, "image_id"))}; a tick moves it once it's free`);
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
      if (truthy(h) && pr !== null && item(h!, "pr") !== pr && !force) {
        die(`slot ${name} is held for #${py(h!.pr)} by ${py(item(h, "owner"))}, not #${pr}; not released`);
      }
      new SlotLock(name).release();
    }
    printErr(`slot ${name} released, at ${at}` + (at === "main" || at === "HEAD" ? "" : " (expected main)"));
    return;
  }
  die("usage: slot status | acquire <slot|any> <pr> [owner] | release <slot> <pr> | release <slot> --force");
}
