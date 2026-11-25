import fs from "node:fs";
import { CACHE, ENV, RETRY_SLEEP } from "./config.ts";
import { P, RuntimeError, cut, fmt0, pget, strip, truthy } from "./py.ts";
import { type Proc, print, run, sleep, writeText } from "./util.ts";

export let ME = process.env.ME;

export function me(): string {
  if (!ME) ME = strip(gh("api", "user", "--jq", ".login"));
  ENV.ME = ME;
  return ME;
}

// One gh call through the serializing shim. Backs off 1 to 5 minutes on
// the secondary rate limit, like nodejs-review-queue's gh_retry, but keeps
// stdout on failure (gh api graphql prints the response and exits 1 when it
// has errors).
export function ghRun(...args: string[]): Proc {
  for (let attempt = 1; ; attempt++) {
    const p = run(["gh", ...args], { env: ENV });
    if (p.returncode === 0 || !p.stderr.toLowerCase().includes("secondary rate limit") || attempt === 6) return p;
    print(`  (gh backoff #${attempt}, sleeping ${fmt0(attempt * RETRY_SLEEP)}s)`, 2);
    sleep(attempt * RETRY_SLEEP);
  }
}

export function gh(...args: string[]): string {
  const p = ghRun(...args);
  if (p.returncode !== 0) throw new RuntimeError(`gh ${args.slice(0, 3).join(" ")}: ${cut(strip(p.stderr), -300)}`);
  return p.stdout;
}

export function graphql(query: string): any {
  const qf = P(CACHE, `query-${process.pid}.graphql`);
  writeText(qf, query);
  let p: Proc;
  try {
    p = ghRun("api", "graphql", "-F", `query=@${qf}`);
  } finally {
    fs.rmSync(qf, { force: true });
  }
  let data: any;
  try {
    data = JSON.parse(p.stdout);
  } catch {
    throw new RuntimeError(`graphql: ${cut(strip(p.stderr), -300) || "no response"}`);
  }
  // A deleted PR comes back as a null alias plus a NOT_FOUND error. Callers
  // treat a missing alias as not found.
  const errs = (data.errors || []).filter((e: any) => pget(e, "type") !== "NOT_FOUND");
  if (errs.length || !truthy(data.data)) {
    // A rate limit or server error has no "errors" list, only a
    // top-level message (or nothing but stderr).
    const why = (errs.length ? pget(errs[0], "message") : pget(data, "message")) || cut(strip(p.stderr), -200)
      || `exit ${p.returncode}, no data`;
    throw new RuntimeError(`graphql: ${why}`);
  }
  return data.data.repository;
}
