import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { P, environ, pyFloat, pyInt, resolvePath, unpack } from "./py.ts";

// This file is scripts/lib/config.ts; HERE is scripts/ and THIS is bank.ts.
export const HERE = path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))));
export const THIS = path.join(HERE, "bank.ts");
export const RQ = resolvePath(process.env.RQ_SCRIPTS ?? P(HERE, "../../nodejs-review-queue/scripts"));
export const NC = resolvePath(process.env.NC_SCRIPTS ?? P(HERE, "../../nodejs-contribute/scripts"));
export const STATE_HOME = process.env.XDG_STATE_HOME || P(os.homedir(), ".local/state");
export const BANK = P(process.env.NODE_REVIEW_BANK || P(STATE_HOME, "nodejs-review-bank"));
export const CLONE = P(process.env.NODE_CLONE || P(os.homedir(), "dev/nodejs/node"));
export const REPO = process.env.REPO ?? "nodejs/node";
export const [OWNER, NAME] = unpack(REPO.split("/"), 2);
export const TARGET = pyInt(process.env.BANK_TARGET ?? "6");
export const REFRESH_MIN = pyInt(process.env.REFRESH_MINUTES ?? "120");
export const LEASE_MIN = pyInt(process.env.LEASE_MINUTES ?? "120");
export const RETRY_SLEEP = pyFloat(process.env.GH_RETRY_SLEEP ?? "60");
export const CQ_CI_MAX_AGE = 30 * 60;
export const CQ_CI_PER_TICK = 5;
export const SLOT_OWNERLESS_GRACE = 60;
export const DEVC_IMAGE = process.env.DEVC_IMAGE ?? "docker.io/nodejs/devcontainer:nightly";
export const IMAGE_CHECK_MIN = pyInt(process.env.IMAGE_CHECK_MINUTES ?? "60");
export const MOVE = "image-move"; // slot owner and PR while a slot moves to the new image
export const SCREEN_HOURS = pyInt(process.env.SCREEN_HOURS ?? "48");
export const DEFER_DAYS = pyFloat(process.env.DEFER_DAYS ?? "7");
export const REFRESH_MAX_HOURS = pyFloat(process.env.REFRESH_MAX_HOURS ?? "6");
export const DORMANT_HOURS = pyFloat(process.env.DORMANT_HOURS ?? "4");
export const REFRESH_RETRY_HOURS = pyFloat(process.env.REFRESH_RETRY_HOURS ?? "2");
export const REFRESH_RETRY_MAX_HOURS = pyFloat(process.env.REFRESH_RETRY_MAX_HOURS ?? "8");
export const TICK_BASE_MIN = pyFloat(process.env.TICK_BACKOFF_BASE_MINUTES ?? "20");
export const TICK_MAX_MIN = pyFloat(process.env.TICK_BACKOFF_MAX_MINUTES ?? "240");
export const TICK_GRACE_MIN = 2; // a cron firing a little early still counts as due

export const [PRS, DOSSIER, CACHE, LOCKS, ARCHIVE] = ["prs", "dossier", "cache", "locks", "archive"].map((d) => P(BANK, d));
for (const d of [PRS, DOSSIER, CACHE, LOCKS, ARCHIVE]) fs.mkdirSync(d, { recursive: true });

export const ENV: NodeJS.ProcessEnv = { ...process.env, NODE_REVIEW_BANK: BANK, PATH: `${P(HERE, "bin")}:${environ("PATH")}` };
