// Build slots: node checkouts that preparing agents take turns in, listed in
// slots.tsv as <name>\t<path>.
import fs from "node:fs";
import path from "node:path";
import { BANK, CLONE, ENV, MOVE, NC, SLOT_OWNERLESS_GRACE } from "./config.ts";
import { Flock, SlotLock, running } from "./lock.ts";
import {
  SECOND, clip, die, iso, lines, now, parseIso, print, printErr, readCacheJson, readText, run, sortBy, splitOnce, writeText,
} from "./util.ts";

export type Slot = [name: string, path: string];

export function slots(): Slot[] {
  const conf = path.join(BANK, "slots.tsv");
  if (!fs.existsSync(conf)) writeText(conf, `1\t${CLONE}\n2\t${CLONE}/.claude/worktrees/review-b\n`);
  return lines(readText(conf)).filter((l) => l.trim()).map((l) => {
    const cols = l.split("\t");
    if (cols.length !== 2) throw new Error(`${conf}: expected <name>\\t<path>, not '${l}'`);
    return [cols[0], cols[1]];
  });
}

// Whether git status works in a checkout, its uncommitted changes, and the
// name of its HEAD.
export function checkoutState(p: string): { ok: boolean; dirty: string; branch: string } {
  const st = run(["git", "-C", p, "status", "--porcelain"]);
  const branch = run(["git", "-C", p, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  return { ok: st.status === 0, dirty: st.stdout.trim(), branch };
}

// `devc.sh image` in a checkout: the local image and the slot container.
export type DevcInfo = {
  image_id?: string;
  image_created?: string;
  image_digests?: string;
  image_commit?: string;
  container_state?: string;
  container_image?: string;
  outdated?: string;
  busy?: string;
};

// devc.sh image in a checkout, or null when it fails or says nothing.
export function devcInfo(p: string): DevcInfo | null {
  let r;
  try {
    r = run([path.join(NC, "devc.sh"), "image"], { cwd: p, env: ENV, timeout: 120 });
  } catch {
    return null; // devc.sh could not start
  }
  if (r.status !== 0) return null;
  const info = Object.fromEntries(lines(r.stdout).filter((l) => l.includes("=")).map((l) => splitOnce(l, "=")));
  return Object.keys(info).length ? info : null;
}

// Free a slot still held for a move whose worker is gone.
export function reclaimMoves(): string[] {
  if (running("image-move")) return [];
  const out: string[] = [];
  using lock = new Flock("slots").enter();
  for (const [name] of slots()) {
    const h = new SlotLock(name).holder();
    if (h?.owner === MOVE && now() - (parseIso(h.at) ?? 0) > SLOT_OWNERLESS_GRACE * SECOND) {
      new SlotLock(name).release();
      out.push(`slot ${name}: its move worker is gone; released`);
    }
  }
  return out;
}

// Commits on upstream/main, as last fetched, since commit, or ?.
function behindMain(commit: string | undefined): string {
  if (!/^[0-9a-f]{7,40}$/.test(commit ?? "")) return "?";
  const r = run(["git", "-C", CLONE, "rev-list", "--count", `${commit}..refs/remotes/upstream/main`], { stderr: "ignore" });
  return r.status === 0 ? r.stdout.trim() : "?";
}

export function slotCmd(args: string[]): void {
  if (!args.length || args[0] === "status") return slotStatus();
  if (args[0] === "acquire") return slotAcquire(args);
  if (args[0] === "release") return slotRelease(args);
  die("usage: slot status | acquire <slot|any> <pr> [owner] | release <slot> <pr> | release <slot> --force", 2);
}

function slotStatus(): void {
  const hub = readCacheJson<{ last_updated: string; checked_at: string }>("image-hub.json");
  if (hub.last_updated) {
    print(`image: Docker Hub updated ${clip(hub.last_updated, 16)} (checked ${hub.checked_at ?? "?"})` +
      (running("image-pull") ? ", pull running" : ""));
  }
  for (const [name, p] of slots()) {
    const lock = new SlotLock(name);
    const h = lock.holder(), since = lock.ownerlessSince();
    const held = h?.owner === MOVE ? `moving to image ${h.to ?? "?"} since ${h.at}` :
      h ? `held for #${h.pr} by ${h.owner} since ${h.at}` :
      since !== null ? `lock has no owner record since ${iso(since)} (reclaimed after ${SLOT_OWNERLESS_GRACE}s)` :
      "free";
    if (!fs.existsSync(p)) {
      print(`slot ${name}: ${p} MISSING (${held})`);
      continue;
    }
    const { ok, dirty, branch } = checkoutState(p);
    const flag = dirty ? ", DIRTY" : ok ? "" : ", GIT STATUS FAILED";
    print(`slot ${name}: ${p} [${branch}${flag}] ${held}`);
    const i = devcInfo(p);
    if (!i) {
      print("  image: devc.sh image failed");
    } else if (i.container_state === "none") {
      print(`  image: no container (local image ${i.image_id ?? "?"})`);
    } else {
      print(`  image: ${i.container_image ?? "?"} built from ${(i.image_commit ?? "-").slice(0, 12)} ` +
        `(${behindMain(i.image_commit)} commits behind upstream/main)` +
        (i.outdated === "yes" ? `, OUTDATED: local image is ${i.image_id ?? "?"}` : ""));
    }
  }
}

function slotAcquire(args: string[]): void {
  const usage = "usage: slot acquire <slot|any> <pr> [owner]";
  const want = args[1] ?? die(usage), pr = args[2] ?? die(usage), owner = args[3] ?? "orchestrator";
  const wanted = (name: string) => want === "any" || want === name;
  reclaimMoves();
  // Prefer a slot whose container is on the local image.
  const info = new Map(slots().filter(([n, p]) => wanted(n) && fs.existsSync(p) && !new SlotLock(n).holder())
    .map(([n, p]) => [n, devcInfo(p)]));
  const order = sortBy(slots(), ([n]) => [info.get(n)?.outdated === "yes" ? 1 : 0]);
  {
    using lock = new Flock("slots").enter();
    if (slots().some(([s]) => new SlotLock(s).holder()?.pr === pr)) {
      die(`#${pr} already holds a slot; never run one PR in two slots (repro.sh uses a shared repro-${pr} branch)`);
    }
    for (const [name, p] of order) {
      if (!wanted(name) || !fs.existsSync(p)) continue;
      const { ok, dirty } = checkoutState(p);
      if (!ok || dirty) {
        printErr(`slot ${name}: ${!ok ? "git status failed" : "dirty"}, skipped`);
        continue;
      }
      if (new SlotLock(name).acquire({ pr, owner, at: iso(now()) })) {
        print(`${name}\t${p}`);
        const i = info.get(name);
        if (i?.outdated === "yes") {
          printErr(`slot ${name}: its container is on image ${i.container_image ?? "?"}, older than the ` +
            `local ${i.image_id ?? "?"}; a tick moves it once it's free`);
        }
        return;
      }
    }
  }
  die("no free slot", 3);
}

function slotRelease(args: string[]): void {
  const force = args.includes("--force");
  const rest = args.slice(1).filter((a) => a !== "--force");
  const name = rest[0] ?? die("usage: slot release <slot> <pr> | release <slot> --force");
  const pr = rest[1] ?? null;
  const p = new Map(slots()).get(name) ?? die(`no slot ${name}`);
  if (pr === null && !force) die(`usage: slot release ${name} <pr> (the PR it was acquired for), or --force`);
  const { ok, dirty, branch } = checkoutState(p);
  if ((dirty || !ok) && !force) {
    die(ok ? `slot ${name} has changes; restore them (git checkout -- <file>) first:\n${dirty}` :
      `slot ${name}: git status failed in ${p}; check it, then release with --force`);
  }
  {
    using lock = new Flock("slots").enter();
    const h = new SlotLock(name).holder();
    // A repeated release (after a context reset, say) must not free a
    // slot another agent has since acquired.
    if (h && pr !== null && h.pr !== pr && !force) {
      die(`slot ${name} is held for #${h.pr} by ${h.owner}, not #${pr}; not released`);
    }
    new SlotLock(name).release();
  }
  print(`slot ${name} released, at ${branch}${branch === "main" || branch === "HEAD" ? "" : " (expected main)"}`);
}
