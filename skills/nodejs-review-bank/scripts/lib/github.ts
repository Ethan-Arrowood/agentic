// GitHub, through the gh shim in bin/. Read-only: nothing here posts.
import fs from "node:fs";
import path from "node:path";
import { CACHE, ENV, GH_RETRY_SLEEP } from "./config.ts";
import { CommandError, type RunResult, printErr, run, sleep, stderrTail, writeText } from "./util.ts";

let login = process.env.ME;

// The user's GitHub login: ME, else asked of gh once. Child commands get it as ME.
export function me(): string {
  if (!login) login = gh("api", "user", "--jq", ".login").trim();
  ENV.ME = login;
  return login;
}

// One gh call through the serializing shim. Backs off 1 to 5 minutes on
// the secondary rate limit, like nodejs-review-queue's gh_retry, but keeps
// stdout on failure (gh api graphql prints the response and exits 1 when it
// has errors).
function ghRun(...args: string[]): RunResult {
  for (let attempt = 1; ; attempt++) {
    const r = run(["gh", ...args], { env: ENV });
    if (r.status === 0 || !r.stderr.toLowerCase().includes("secondary rate limit") || attempt === 6) return r;
    printErr(`  (gh backoff #${attempt}, sleeping ${Math.round(attempt * GH_RETRY_SLEEP)}s)`);
    sleep(attempt * GH_RETRY_SLEEP);
  }
}

// gh's stdout. Throws CommandError when it fails.
export function gh(...args: string[]): string {
  const r = ghRun(...args);
  if (r.status !== 0) throw new CommandError(`gh ${args.slice(0, 3).join(" ")}: ${stderrTail(r)}`);
  return r.stdout;
}

type GraphqlResponse = {
  data?: { repository?: unknown } | null;
  errors?: ({ type?: string; message?: string } | null)[];
  message?: string; // a rate limit or server error
};

// A GraphQL query's data.repository. The caller gives its shape. A deleted PR
// comes back as a null alias plus a NOT_FOUND error, so callers treat a
// missing or null alias as not found.
export function graphql<T>(query: string): T {
  const qf = path.join(CACHE, `query-${process.pid}.graphql`);
  writeText(qf, query);
  let r: RunResult;
  try {
    r = ghRun("api", "graphql", "-F", `query=@${qf}`);
  } finally {
    fs.rmSync(qf, { force: true });
  }
  let res: GraphqlResponse | null;
  try {
    res = JSON.parse(r.stdout);
  } catch {
    throw new CommandError(`graphql: ${stderrTail(r) || "no response"}`);
  }
  const errors = (res?.errors ?? []).filter((e) => e?.type !== "NOT_FOUND");
  const data = res?.data;
  if (errors.length || !data || Object.keys(data).length === 0) {
    // A rate limit or server error has no "errors" list, only a top-level
    // message (or nothing but stderr).
    const why = (errors.length ? errors[0]?.message : res?.message) || stderrTail(r, 200) || `exit ${r.status}, no data`;
    throw new CommandError(`graphql: ${why}`);
  }
  return data.repository as T;
}
