#!/usr/bin/env node
// The bank: usage, argument parsing, and dispatch. The work is in lib/.
// Node runs it as is (type stripping): no dependencies, no build.
import { deferCmd, holdCmd, listCmd, present, put, setCmd, show, unholdCmd } from "./lib/commands.ts";
import { BANK_TARGET, ensureBankDirs } from "./lib/config.ts";
import { load } from "./lib/entry.ts";
import { me } from "./lib/github.ts";
import { imageCmd } from "./lib/images.ts";
import { prefetch } from "./lib/prefetch.ts";
import { plan } from "./lib/queue.ts";
import { slotCmd } from "./lib/slots.ts";
import { sync } from "./lib/sync.ts";
import { markActive, tickBackedOff, tickCmd } from "./lib/tick.ts";
import { BankError, die, print, printErr } from "./lib/util.ts";

const DOC = `nodejs-review-bank: a bank of prepared nodejs/node reviews on disk.

Deterministic parts of the skill. Every gh call goes through the bin/gh shim
(one gh call at a time across processes) and backs off on GitHub's secondary
rate limit. Read-only on GitHub: nothing here posts, labels, or reviews.

  bank.ts tick [--refresh] [--now] [--target N]   refresh candidates, sync, prune, plan
  bank.ts sync [PR...]                    re-read bank entries from GitHub, prune
  bank.ts plan [--target N] [--all]       what to prepare next, in priority order (--all adds skips)
  bank.ts list [--all]                    the bank, by priority
  bank.ts show <pr>                       one entry
  bank.ts present                         mark the top ready entry presented, show it
  bank.ts prefetch <pr>                   fetch the PR's dossier and claim the entry (or screen it)
  bank.ts put <pr> <summary.md> [--head <sha>]   bank a verified summary (ready or needs-run)
  bank.ts set <pr> key=value...           edit entry fields (state=done disposition=skipped)
  bank.ts hold <pr> [--until ISO] [--until-reviews N] [--until-author] [note]
                                          wait for others' reviews, a push, a time, or an author comment
  bank.ts hold <pr> --screen [--until ISO] [note]   wait for the author after an automation screen (48 h)
  bank.ts defer <pr> <reason...>          not worth reviewing yet: wait for the author, a push, a review, or DEFER_DAYS
  bank.ts unhold <pr>                     end a hold now
  bank.ts slot status|acquire <slot|any> <pr> [owner]|release <slot> <pr>|release <slot> --force
  bank.ts image prune                     remove free slots' out/ volumes for unused images

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

// The argument at i. A missing one exits 1, as it always has.
function arg(args: string[], i: number, usage: string): string {
  return args[i] ?? die(`usage: ${usage}`);
}

// The value after flag, or null when the flag is absent.
function option(args: string[], flag: string, usage: string): string | null {
  const i = args.indexOf(flag);
  return i < 0 ? null : arg(args, i + 1, usage);
}

function target(args: string[], cmd: string): number {
  const v = option(args, "--target", `${cmd} --target N`);
  if (v === null) return BANK_TARGET;
  if (!/^[+-]?\d+$/.test(v.trim())) die(`--target must be a whole number, not ${v}`);
  return Number(v);
}

async function main(argv: string[]): Promise<void> {
  ensureBankDirs();
  if (!argv.length) {
    print(DOC);
    return;
  }
  const [cmd, ...args] = argv;
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
  switch (cmd) {
    case "tick":
      await tickCmd(target(args, "tick"), args.includes("--refresh"));
      break;
    case "sync":
      print(sync(args.length ? new Set(args) : null).join("\n"));
      break;
    case "plan": {
      const [lines, counts] = plan(target(args, "plan"), args.includes("--all"));
      print(`plan: eligible candidates by lane: ${counts}`);
      print(lines.join("\n") || "plan: bank is full");
      break;
    }
    case "list":
      listCmd(args.includes("--all"));
      break;
    case "show": {
      const pr = arg(args, 0, "show <pr>");
      show(load(pr) ?? die(`no entry for ${pr}`));
      break;
    }
    case "present":
      present();
      break;
    case "prefetch":
      prefetch(arg(args, 0, "prefetch <pr>"));
      break;
    case "put": {
      const usage = "put <pr> <summary.md> [--head <sha>]";
      const head = option(args, "--head", usage);
      put(arg(args, 0, usage), arg(args, 1, usage), head);
      break;
    }
    case "set":
      setCmd(arg(args, 0, "set <pr> key=value..."), args.slice(1));
      break;
    case "hold":
      holdCmd(arg(args, 0, "hold <pr> [--until ISO] [--until-reviews N] [--until-author] [note]"), args.slice(1));
      break;
    case "defer":
      if (!args.length) die("usage: defer <pr> <reason...>", 2);
      deferCmd(args[0], args.slice(1));
      break;
    case "unhold":
      unholdCmd(arg(args, 0, "unhold <pr>"));
      break;
    case "slot":
      slotCmd(args);
      break;
    case "image":
      imageCmd(args);
      break;
    default:
      die(`unknown command ${cmd}`, 2);
  }
}

// A BankError ends the run with its message and exit code; anything else is
// a bug, so it prints its stack and exits 1.
let code = 0;
try {
  await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof BankError) {
    printErr(`bank: ${err.message}`);
    code = err.code;
  } else {
    printErr(err instanceof Error && err.stack ? err.stack : String(err));
    code = 1;
  }
}
process.exit(code);
