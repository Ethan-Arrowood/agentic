// Settings from the environment, the bank's layout on disk, and fixed limits.
// Most constants take the name of the env var that sets them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envInt(name: string, fallback: string): number {
  const v = env(name, fallback).trim();
  if (!/^[+-]?\d+$/.test(v)) throw new Error(`${name} must be a whole number, not '${v}'`);
  return Number(v);
}

function envNumber(name: string, fallback: string): number {
  const v = env(name, fallback).trim();
  const n = Number(v);
  if (v === "" || Number.isNaN(n)) throw new Error(`${name} must be a number, not '${v}'`);
  return n;
}

// A path as given, without a trailing slash, doubled slashes, or "." parts.
function cleanPath(p: string): string {
  return path.normalize(p).replace(/(.)\/+$/, "$1");
}

// Symlinks resolved, when the path exists.
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// This file is scripts/lib/config.ts.
const SCRIPTS = path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))));
export const BANK_SCRIPT = path.join(SCRIPTS, "bank.ts");
// The sibling skills' scripts: nodejs-review-queue and nodejs-contribute.
export const RQ = realPath(env("RQ_SCRIPTS", path.join(SCRIPTS, "../../nodejs-review-queue/scripts")));
export const NC = realPath(env("NC_SCRIPTS", path.join(SCRIPTS, "../../nodejs-contribute/scripts")));

const STATE_HOME = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state");
export const BANK = cleanPath(process.env.NODE_REVIEW_BANK || path.join(STATE_HOME, "nodejs-review-bank"));
export const CLONE = cleanPath(process.env.NODE_CLONE || path.join(os.homedir(), "dev/nodejs/node"));
export const PRS = path.join(BANK, "prs");
export const DOSSIER = path.join(BANK, "dossier");
export const CACHE = path.join(BANK, "cache");
export const LOCKS = path.join(BANK, "locks");
export const ARCHIVE = path.join(BANK, "archive");

export function ensureBankDirs(): void {
  for (const d of [PRS, DOSSIER, CACHE, LOCKS, ARCHIVE]) fs.mkdirSync(d, { recursive: true });
}

export const REPO = env("REPO", "nodejs/node");
const repoParts = REPO.split("/");
if (repoParts.length !== 2) throw new Error(`REPO must be OWNER/NAME, not '${REPO}'`);
export const [OWNER, NAME] = repoParts;

export const BANK_TARGET = envInt("BANK_TARGET", "6");
export const REFRESH_MINUTES = envInt("REFRESH_MINUTES", "120");
export const REFRESH_MAX_HOURS = envNumber("REFRESH_MAX_HOURS", "6");
export const REFRESH_RETRY_HOURS = envNumber("REFRESH_RETRY_HOURS", "2");
export const REFRESH_RETRY_MAX_HOURS = envNumber("REFRESH_RETRY_MAX_HOURS", "8");
export const DORMANT_HOURS = envNumber("DORMANT_HOURS", "4");
export const LEASE_MINUTES = envInt("LEASE_MINUTES", "120");
export const GH_RETRY_SLEEP = envNumber("GH_RETRY_SLEEP", "60"); // seconds
export const SCREEN_HOURS = envInt("SCREEN_HOURS", "48");
export const DEFER_DAYS = envNumber("DEFER_DAYS", "7");
export const TICK_BACKOFF_BASE_MINUTES = envNumber("TICK_BACKOFF_BASE_MINUTES", "20");
export const TICK_BACKOFF_MAX_MINUTES = envNumber("TICK_BACKOFF_MAX_MINUTES", "240");
export const TICK_GRACE_MINUTES = 2; // a cron firing a little early still counts as due
// Which lanes get metadata.txt from git node metadata: cq, all, or off.
export const BANK_METADATA = env("BANK_METADATA", "cq");
export const METADATA_TIMEOUT = 180; // seconds

export const CQ_CI_MAX_AGE_MINUTES = 30;
export const CQ_CI_PER_TICK = 5;

export const DEVC_IMAGE = env("DEVC_IMAGE", "docker.io/nodejs/devcontainer:nightly");
export const IMAGE_CHECK_MINUTES = envInt("IMAGE_CHECK_MINUTES", "60");
export const SLOT_OWNERLESS_GRACE = 60; // seconds
export const MOVE = "image-move"; // slot owner and PR while a slot moves to the new image

// The environment for every command the bank runs: the gh shim in bin/ comes
// first on PATH, so their gh calls are serial too.
export const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_REVIEW_BANK: BANK,
  PATH: [path.join(SCRIPTS, "bin"), process.env.PATH].filter(Boolean).join(":"),
};
