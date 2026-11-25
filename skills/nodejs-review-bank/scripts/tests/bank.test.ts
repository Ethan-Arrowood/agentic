// Offline tests for bank.py. Run from scripts/: node --test tests/
//
// A one-to-one port of test_bank.py. Each test gets a temporary bank, a fake
// gh on PATH (fake_gh.py), stub sibling scripts (devc.sh is fake_devc.py), a
// Docker Hub response read from a file, and, where needed, a temporary git
// clone with an upstream. Nothing here touches the network, a container
// engine, or the real bank.
//
// The tests are black-box: they run the CLI and check its output, exit status,
// and files. BANK_CMD swaps in another implementation, such as the TypeScript
// port: BANK_CMD="node bank.ts". Paths resolve from scripts/.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

type Obj = Record<string, any>;
type Env = Record<string, string | undefined>;
type Proc = { returncode: number; stdout: string; stderr: string };

const HERE = import.meta.dirname;
const SCRIPTS = path.dirname(HERE);
const BANK_CMD = (process.env.BANK_CMD ? process.env.BANK_CMD.split(/\s+/).filter(Boolean) : ["python3", "bank.py"])
  .map((a) => (isFile(path.resolve(SCRIPTS, a)) ? path.resolve(SCRIPTS, a) : a));
const RQ_REAL = realpath(path.resolve(SCRIPTS, "../../nodejs-review-queue/scripts"));
const NC_REAL = realpath(path.resolve(SCRIPTS, "../../nodejs-contribute/scripts"));
const FIELDS = ["pr", "url", "title", "author", "lane", "state", "head", "pr_head", "acted_head", "created_at",
  "prepared_at", "presented_at", "updated_at", "my_teams", "rereview_from",
  "needs_run", "disposition", "disposition_at", "snooze_until", "lease", "note",
  "wait_since", "wait_for", "screen"];
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// Python-compatible helpers.

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Like os.path.realpath: resolves what exists and keeps the rest.
function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realpath(parent), path.basename(p));
  }
}

// Python's text mode turns \r\n and \r into \n.
function pyText(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

function readText(p: string): string {
  return pyText(fs.readFileSync(p, "utf8"));
}

function writeText(p: string, s: string): void {
  fs.writeFileSync(p, s);
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function splitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// str.split() with no separator.
function pySplit(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function partition(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

function pyReplace(s: string, old: string, repl: string): string {
  return s.split(old).join(repl);
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

function assertIn(needle: string, hay: string | string[] | Obj, msg?: string): void {
  const ok = typeof hay === "string" || Array.isArray(hay) ? hay.includes(needle) : needle in hay;
  assert.ok(ok, msg ?? `${JSON.stringify(needle)} not found in ${JSON.stringify(hay)}`);
}

function assertNotIn(needle: string, hay: string | string[], msg?: string): void {
  assert.ok(!hay.includes(needle), msg ?? `${JSON.stringify(needle)} unexpectedly found in ${JSON.stringify(hay)}`);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 19) + "Z";
}

function ago({ days = 0, hours = 0, minutes = 0 }: { days?: number; hours?: number; minutes?: number }): string {
  return iso(new Date(Date.now() - days * DAY - hours * HOUR - minutes * MINUTE));
}

// datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ") as UTC milliseconds.
function parseIsoZ(s: string): number {
  assert.match(s, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, `time data ${JSON.stringify(s)} does not match format`);
  return Date.parse(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function returncode(status: number | null, signal: NodeJS.Signals | null): number {
  return status ?? -(signal ? os.constants.signals[signal] : 1);
}

class TimeoutExpired extends Error {}

// subprocess.run with check=True; returns stripped stdout.
function run(cmd: string, args: string[], opts: { cwd?: string; check?: boolean } = {}): string {
  const p = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (p.error) throw p.error;
  if ((opts.check ?? true) && p.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${returncode(p.status, p.signal)}\n${p.stderr}`);
  }
  return pyText(p.stdout).trim();
}

function git(args: string[], cwd?: string): string {
  return run("git", args, { cwd });
}

function runSync(cmd: string, args: string[], opts: { env: Env; cwd?: string; timeout: number }): Proc {
  const p = spawnSync(cmd, args, {
    env: opts.env, cwd: opts.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout * 1000, killSignal: "SIGKILL", maxBuffer: 1 << 30,
  });
  if (p.error && (p.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new TimeoutExpired(`${cmd} ${args.join(" ")} timed out after ${opts.timeout} seconds`);
  }
  if (p.error) throw p.error;
  return { returncode: returncode(p.status, p.signal), stdout: pyText(p.stdout), stderr: pyText(p.stderr) };
}

// subprocess.Popen with pipes: the child runs while the test goes on.
class Popen {
  child: ChildProcess;
  stdout = "";
  stderr = "";
  done: Promise<number>;

  constructor(cmd: string, args: string[], env: Env) {
    this.child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf8").on("data", (d: string) => { this.stdout += d; });
    this.child.stderr!.setEncoding("utf8").on("data", (d: string) => { this.stderr += d; });
    this.done = new Promise((resolve, reject) => {
      this.child.on("error", reject);
      this.child.on("close", (status, signal) => resolve(returncode(status, signal)));
    });
  }

  async communicate(timeout: number): Promise<Proc> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        reject(new TimeoutExpired(`timed out after ${timeout} seconds`));
      }, timeout * 1000);
    });
    try {
      const rc = await Promise.race([this.done, expired]);
      return { returncode: rc, stdout: pyText(this.stdout), stderr: pyText(this.stderr) };
    } finally {
      clearTimeout(timer);
    }
  }
}

// Holds an exclusive flock on `file` in a zsh child until release() closes its
// stdin. On macOS this blocks bank.py's fcntl.flock as Python's own lock would.
async function holdFlock(file: string): Promise<{ release: () => Promise<void> }> {
  fs.closeSync(fs.openSync(file, "a"));
  const child = spawn("zsh", ["-c", 'zmodload zsh/system; zsystem flock -f fd "$1" && print locked && read', "zsh", file],
    { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      if (out.includes("locked\n")) resolve();
    });
    child.on("error", reject);
    child.on("close", (code) => reject(new Error(`the lock holder exited ${code} before locking ${file}`)));
  });
  return {
    release: async () => {
      child.stdin!.end();
      await exited;
    },
  };
}

async function subTests<T>(cases: T[], label: (c: T) => string, fn: (c: T) => void | Promise<void>): Promise<void> {
  const failures: string[] = [];
  for (const c of cases) {
    try {
      await fn(c);
    } catch (e) {
      failures.push(`[${label(c)}] ${(e as Error)?.stack ?? e}`);
    }
  }
  if (failures.length) assert.fail(failures.join("\n\n"));
}

function prNode(n: number, head: string, { state = "OPEN", reviews = [] as Obj[], comments = [] as Obj[],
  labels = [] as string[], closed_at = null as string | null, draft = false, author = "someone" } = {}): Obj {
  return {
    number: n, title: `PR ${n}`, state, isDraft: draft, updatedAt: ago({ minutes: 1 }),
    closedAt: closed_at, headRefOid: head, author: { login: author },
    labels: { nodes: labels.map((l) => ({ name: l })) },
    reviews: { nodes: [...reviews] }, comments: { nodes: [...comments] },
    timelineItems: { nodes: [] },
  };
}

const WELCOME = "Welcome to Node.js, and thank you for your first contribution!\n\n> [!CAUTION]\n"
  + "> AgentScan found account activity patterns that may be consistent with automation.";

const README = "# Node.js\n\n### TSC (Technical Steering Committee)\n\n#### TSC voting members\n\n"
  + "* [TSC-Voting](https://example.com/tsc-voting) -\n  **T**\n\n#### TSC emeriti members\n\n"
  + "* [tsc-emeritus](https://example.com/tsc-emeritus) -\n  **E**\n\n### Collaborators\n\n"
  + "* [Collab-Active](https://example.com/collab-active) -\n  **C**\n\n### Collaborator emeriti\n\n"
  + "* [collab-emeritus](https://example.com/collab-emeritus) -\n  **E**\n\n### Triagers\n\n"
  + "* [someone](https://example.com/someone) -\n  **S**\n";

const FLAGGED = { labels: ["stream", "agentscan:automated-account"] };

class BankTest {
  tmp: string;
  bank: string;
  fake: string;
  rq: string;
  nc: string;
  queueOut: string;
  rereviewOut: string;
  hub: string;
  env: Env;
  children: Popen[] = [];

  constructor() {
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bank-test-"));
    this.bank = path.join(this.tmp, "bank");
    this.fake = path.join(this.tmp, "fake");
    fs.mkdirSync(this.fake);
    const fakebin = path.join(this.tmp, "bin");
    fs.mkdirSync(fakebin);
    fs.copyFileSync(path.join(HERE, "fake_gh.py"), path.join(fakebin, "gh"));
    fs.chmodSync(path.join(fakebin, "gh"), 0o755);
    // `git node` runs git-node from PATH: log the call and whether the gh shim's lock is held,
    // and print FAKE_NCU_OUT to stderr like ncu's report.
    writeText(path.join(fakebin, "git-node"),
      `#!/bin/zsh\nzmodload zsh/system\nprint -r -- "$*" >> "${this.fake}/git-node.log"\n`
      + 'zsystem flock -t 0 "$NODE_REVIEW_BANK/locks/gh.lock" 2>/dev/null && l=free || l=held\n'
      + `print -r -- "gh lock $l" >> "${this.fake}/git-node.log"\n`
      + 'print -rn -- "${FAKE_NCU_OUT:-}" >&2\nexit ${FAKE_NCU_RC:-0}\n');
    fs.chmodSync(path.join(fakebin, "git-node"), 0o755);
    // Sibling skills: real lib.sh and discussion.sh, stubbed queue scripts.
    this.rq = path.join(this.tmp, "rq");
    fs.mkdirSync(this.rq);
    for (const f of ["lib.sh", "discussion.sh"]) fs.symlinkSync(path.join(RQ_REAL, f), path.join(this.rq, f));
    this.queueOut = path.join(this.tmp, "queue.out");
    this.rereviewOut = path.join(this.tmp, "rereview.out");
    writeText(this.queueOut, "");
    writeText(this.rereviewOut, "");
    writeText(path.join(this.rq, "build-queue.sh"), `#!/bin/zsh\ncat "${this.queueOut}"\nexit $` + "{QUEUE_RC:-0}\n");
    writeText(path.join(this.rq, "rereview.py"), `import sys\nsys.stdout.write(open("${this.rereviewOut}").read())\n`);
    this.nc = path.join(this.tmp, "nc");
    fs.mkdirSync(this.nc);
    writeText(path.join(this.nc, "ci-status.sh"),
      '#!/bin/zsh\necho "#$1: ${FAKE_CI:-CI=SUCCESS  job=1  HEAD-MATCH}  [head ${FAKE_CI_HEAD:-aaaaaaaaaaaa}]"\n');
    fs.copyFileSync(path.join(HERE, "fake_devc.py"), path.join(this.nc, "devc.sh"));
    for (const p of [path.join(this.rq, "build-queue.sh"), path.join(this.nc, "ci-status.sh"), path.join(this.nc, "devc.sh")]) {
      fs.chmodSync(p, 0o755);
    }
    this.hub = path.join(this.tmp, "hub.json");
    this.env = {
      ...process.env, NODE_REVIEW_BANK: this.bank, FAKE_GH_DIR: this.fake,
      FAKE_DEVC_DIR: this.fake, DEVC_HUB_URL: pathToFileURL(this.hub).href,
      PATH: `${fakebin}:${process.env.PATH}`, ME: "me", GH_MIN_GAP: "0",
      GH_RETRY_SLEEP: "0", RQ_SCRIPTS: this.rq, NC_SCRIPTS: this.nc,
      NODE_CLONE: path.join(this.tmp, "clone"), REFRESH_MINUTES: "100000",
      // Off by default here: most tests run several ticks in a row.
      TICK_BACKOFF_MAX_MINUTES: "0",
    };
    // NODE_TEST_CONTEXT is set by node --test, not by the user; keep it from the CLI.
    for (const k of ["TERMINFO", "BANK_TARGET", "DEVC_IMAGE", "IMAGE_CHECK_MINUTES", "NODE_TEST_CONTEXT"]) delete this.env[k];
    this.rules([]);
  }

  cleanup(): void {
    for (const p of this.children) {
      if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
    }
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }

  rules(rules: Obj[]): void {
    writeText(path.join(this.fake, "rules.json"), JSON.stringify(rules));
  }

  calls(): any[] {
    const p = path.join(this.fake, "calls.log");
    return exists(p) ? splitlines(readText(p)).map((l) => JSON.parse(l)) : [];
  }

  runBank(args: string[], { check = true, timeout = 60, env }: { check?: boolean; timeout?: number; env?: Env } = {}): Proc {
    const p = runSync(BANK_CMD[0], [...BANK_CMD.slice(1), ...args], { env: env ?? this.env, timeout });
    if (check && p.returncode !== 0) {
      assert.fail(`bank.py ${args.join(" ")} exited ${p.returncode}\n${p.stdout}\n${p.stderr}`);
    }
    return p;
  }

  popenBank(args: string[]): Popen {
    const p = new Popen(BANK_CMD[0], [...BANK_CMD.slice(1), ...args], this.env);
    this.children.push(p);
    return p;
  }

  writeEntry(pr: number, fields: Obj = {}, body = ""): void {
    const e: Obj = {
      pr: String(pr), url: `https://github.com/nodejs/node/pull/${pr}`, title: `PR ${pr}`,
      author: "someone", lane: "fresh", state: "ready", head: A, pr_head: A,
      created_at: ago({ hours: 1 }), disposition: "-", needs_run: "0", ...fields,
    };
    fs.mkdirSync(path.join(this.bank, "prs"), { recursive: true });
    const head = FIELDS.map((k) => `${k}: ${e[k] || "-"}`).join("\n");
    writeText(path.join(this.bank, "prs", `${pr}.md`), `---\n${head}\n---\n${body}`);
  }

  entry(pr: number): Record<string, string> {
    const text = readText(path.join(this.bank, "prs", `${pr}.md`));
    const [front, body] = partition(text.slice(4), "\n---\n");
    const meta: Record<string, string> = {};
    for (const l of splitlines(front)) {
      if (l.includes(": ")) {
        const [k, v] = partition(l, ": ");
        meta[k] = v;
      }
    }
    meta.body = body;
    return meta;
  }

  cache(name: string, text: string): void {
    fs.mkdirSync(path.join(this.bank, "cache"), { recursive: true });
    writeText(path.join(this.bank, "cache", name), text);
  }

  syncRule(...nodes: Obj[]): Obj {
    const data = Object.fromEntries(nodes.map((n) => [`p${n.number}`, n]));
    return { match: ["graphql", "headRefOid", "timelineItems"], stdout: { data: { repository: data } } };
  }

  /** A clone whose upstream has main and refs/pull/5/head. Returns the PR head sha. */
  makeClone({ prHeadCommitMsg = "pr", readme = null as string | null } = {}): string {
    const up = path.join(this.tmp, "upstream.git");
    const work = path.join(this.tmp, "work");
    git(["init", "-q", "--bare", up]);
    git(["init", "-q", "-b", "main", work]);
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"]]) git(["config", k, v], work);
    writeText(path.join(work, "f"), "main\n");
    git(["add", "f"], work);
    if (readme !== null) {
      writeText(path.join(work, "README.md"), readme);
      git(["add", "README.md"], work);
    }
    git(["commit", "-qm", "main"], work);
    git(["push", "-q", up, "main"], work);
    writeText(path.join(work, "f"), "pr\n");
    git(["commit", "-qam", prHeadCommitMsg], work);
    const head = git(["rev-parse", "HEAD"], work);
    git(["push", "-q", up, "HEAD:refs/pull/5/head"], work);
    git(["clone", "-q", "-o", "upstream", up, path.join(this.tmp, "clone")]);
    return head;
  }

  prefetchRules(head: string): Obj[] {
    const disc = { data: { repository: { pullRequest: Object.fromEntries(["reviews", "comments", "reviewThreads"].map((k) =>
      [k, { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }])) } } };
    const pr = {
      number: 5, title: "PR 5", body: "", author: { login: "someone" }, baseRefName: "main",
      headRefOid: head, reviewDecision: "", labels: [], mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED", files: [], commits: [], createdAt: ago({ days: 3 }),
      updatedAt: ago({ minutes: 5 }), isDraft: false, state: "OPEN",
    };
    return [{ match: ["pr", "view", "5", "--jq"], stdout: head + "\n" },
      { match: ["pr", "view", "5"], stdout: pr },
      { match: ["pr", "diff", "5"], stdout: "diff --git a/f b/f\n" },
      { match: ["graphql", "reviewThreads"], stdout: disc }];
  }

  /** Commit .github/CODEOWNERS to upstream main, which prefetch fetches. */
  addCodeowners(text: string): void {
    const work = path.join(this.tmp, "work");
    git(["checkout", "-q", "main"], work);
    fs.mkdirSync(path.join(work, ".github"), { recursive: true });
    writeText(path.join(work, ".github", "CODEOWNERS"), text);
    git(["add", ".github"], work);
    git(["commit", "-qm", "owners"], work);
    git(["push", "-q", path.join(this.tmp, "upstream.git"), "main"], work);
  }

  gatesRule(head: string, { reviews = [] as Obj[], requests = [] as Obj[], contexts = [] as Obj[], timeline = [] as Obj[] } = {}): Obj {
    const pr = {
      reviewDecision: "REVIEW_REQUIRED",
      commits: { nodes: [{ commit: { oid: head, statusCheckRollup: {
        state: "FAILURE", contexts: { totalCount: contexts.length, nodes: [...contexts] } } } }] },
      timelineItems: { totalCount: timeline.length, nodes: [...timeline] },
      reviewRequests: { nodes: [...requests] },
      latestOpinionatedReviews: { nodes: [...reviews] },
    };
    return { match: ["graphql", "statusCheckRollup"], stdout: { data: { repository: { pullRequest: pr } } } };
  }

  prefetchGates({ lane = "cq", gates = null as Obj | null, env = undefined as Env | undefined } = {}): [string, string, string] {
    const head = this.makeClone();
    this.addCodeowners("# owners\n/lib/internal/http2/* @nodejs/http2 @nodejs/net\n"
      + "/lib/net.js @nodejs/net\n*.gyp @nodejs/gyp\n/doc/ @nodejs/docs\n");
    this.cache("release-lines.txt", "active release lines: v22 v24 v26\n");
    if (lane === "cq") this.cache("rereview.tsv", this.rereviewRow(5, { head }));
    const rules = this.prefetchRules(head);
    rules[1].stdout.files = ["lib/internal/http2/core.js", "lib/internal/http2/sub/x.js", "lib/net.js", "tools/a.gyp",
      "doc/api/net.md", "src/pipe_wrap.cc"].map((p) => ({ path: p }));
    if (gates === null) {
      gates = this.gatesRule(head, {
        reviews: [
          { author: { login: "alice" }, state: "APPROVED", submittedAt: ago({ hours: 1 }),
            commit: { oid: head }, onBehalfOf: { nodes: [{ slug: "net" }] } }],
        requests: [{ requestedReviewer: { __typename: "Team", slug: "http2" } }],
        contexts: [
          { __typename: "CheckRun", name: "lint-js", status: "COMPLETED", conclusion: "FAILURE",
            detailsUrl: "https://example.test/1",
            checkSuite: { workflowRun: { workflow: { name: "Linters" } } } },
          { __typename: "CheckRun", name: "test-linux", status: "COMPLETED",
            conclusion: "SUCCESS", detailsUrl: "u", checkSuite: null },
          { __typename: "StatusContext", context: "node-test-pull-request", state: "PENDING",
            targetUrl: "https://ci.example.test/2" }],
        timeline: [
          { __typename: "PullRequestCommit", commit: {
            oid: A, committedDate: ago({ days: 2 }), messageHeadline: "old",
            checkSuites: { nodes: [{ createdAt: ago({ days: 2 }) }] } } },
          { __typename: "HeadRefForcePushedEvent", createdAt: ago({ hours: 3 }),
            actor: { login: "someone" }, beforeCommit: { oid: A }, afterCommit: { oid: head } },
          { __typename: "PullRequestCommit", commit: {
            oid: head, committedDate: ago({ hours: 4 }), messageHeadline: "pr",
            checkSuites: { nodes: [{ createdAt: ago({ hours: 3 }) }] } } }],
      });
    }
    this.rules([gates, ...rules]);
    const out = this.runBank(["prefetch", "5"], { env }).stdout;
    return [head, path.join(this.bank, "dossier", "5"), out];
  }

  makeSlots(...names: string[]): void {
    const rows: string[] = [];
    for (const name of names) {
      const p = path.join(this.tmp, `slot${name}`);
      git(["init", "-q", "-b", "main", p]);
      rows.push(`${name}\t${p}`);
    }
    fs.mkdirSync(this.bank, { recursive: true });
    writeText(path.join(this.bank, "slots.tsv"), rows.join("\n") + "\n");
  }

  rereviewRow(n: number, { bucket = "CQ-CANDIDATE", head = A, updated = null as string | null } = {}): string {
    return `${bucket}\t${n}\tAPPROVED\t${head}\t${head}\t${head}\t2\tMERGEABLE\t${updated || ago({ minutes: 1 })}\n`;
  }

  candidateCache(n: number, { head = A, updated = null as string | null, state = "OPEN" } = {}): void {
    this.cache("queue.tsv", `${n}\thttp\t-\n`);
    this.cache("candidates.json", JSON.stringify({ [String(n)]: {
      title: `PR ${n}`, draft: false, state, updated: updated || ago({ hours: 1 }),
      head, author: "someone", paths: ["lib/net.js"] } }));
  }

  runDiscussion(nodes: Obj[], env?: Env): Obj {
    const disc = { data: { repository: { pullRequest: {
      reviews: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      reviewThreads: { totalCount: 1, nodes: [{
        isResolved: false, isOutdated: false, path: "lib/net.js", line: 1,
        comments: { nodes } }] } } } } };
    this.rules([{ match: ["graphql", "reviewThreads"], stdout: disc }]);
    const p = runSync("zsh", [path.join(RQ_REAL, "discussion.sh"), "--json", "5"], { env: env ?? this.env, timeout: 60 });
    assert.equal(p.returncode, 0, p.stderr);
    return JSON.parse(p.stdout);
  }

  comment(login: string, assoc: string): Obj {
    return { author: { login }, authorAssociation: assoc, createdAt: ago({ minutes: 5 }),
      isMinimized: false, minimizedReason: null, body: "hi" };
  }

  async waitFor(cond: () => boolean, what: string, timeout = 20): Promise<void> {
    for (let i = 0; i < Math.trunc(timeout * 10); i++) {
      if (cond()) return;
      await sleep(100);
    }
    assert.fail(`timed out waiting for ${what}`);
  }

  /** fake_devc.py state. slots maps a slot name (from makeSlots) to its fields. */
  devcState({ image = null as Obj | null, slots = null as Obj | null, ...extra }: Obj = {}): void {
    const img = { image_id: "1".repeat(12), image_digests: "docker.io/nodejs/devcontainer@sha256:old",
      image_created: "2026-11-19 03:59:40.160578228 +0000 UTC", ...(image || {}) };
    const st = { image: img, slots: Object.fromEntries(Object.entries(slots || {}).map(([n, f]) =>
      [realpath(path.join(this.tmp, `slot${n}`)), f])), ...extra };
    writeText(path.join(this.fake, "state.json"), JSON.stringify(st));
  }

  hubSays({ digest = "sha256:new", arch = "sha256:new-arm64", updated = "2026-11-20T04:31:57.438312Z" } = {}): void {
    writeText(this.hub, JSON.stringify({ name: "nightly", digest, last_updated: updated,
      images: [{ architecture: "arm64", digest: arch }] }));
  }

  devcCalls(cmd: string | null = null): [string, string][] {
    const p = path.join(this.fake, "calls.log");
    const calls: any[] = exists(p) ? splitlines(readText(p)).map((l) => JSON.parse(l)) : [];
    return calls.map((c) => {
      if (!Array.isArray(c) || c.length !== 2) throw new Error(`cannot unpack ${JSON.stringify(c)} into (checkout, command)`);
      return c as [string, string];
    }).filter(([, k]) => cmd === null || cmd === k).map(([c, k]) => [path.basename(c), k]);
  }

  /** The real devc.sh against fake_engine.py, in a scratch checkout. */
  runDevc(cmd: string, state: Obj, check = true): [Proc, Record<string, string>] {
    const co = path.join(this.tmp, "node");
    if (!exists(co)) {
      git(["init", "-q", co]);
      writeText(path.join(co, "node.gyp"), "");
    }
    writeText(path.join(this.fake, "state.json"), JSON.stringify(state));
    const p = runSync("bash", [path.join(NC_REAL, "devc.sh"), cmd], {
      cwd: co, timeout: 60,
      env: { ...this.env, DEVC_ENGINE: path.join(HERE, "fake_engine.py"), FAKE_ENGINE_DIR: this.fake },
    });
    if (check) assert.equal(p.returncode, 0, p.stderr);
    return [p, Object.fromEntries(splitlines(p.stdout).filter((l) => l.includes("=")).map((l) => partition(l, "=")))];
  }

  /** A sync node with reviews by others ([login, minutes ago]) and an open time. */
  reviewedNode(n: number, head: string, { others = [] as [string, number][], created = null as string | null,
    labels = [] as string[] } = {}): Obj {
    const node = prNode(n, head, { labels });
    node.createdAt = created || ago({ days: 10 });
    node.allReviews = { nodes: others.map(([who, m]) => ({ author: { login: who }, submittedAt: ago({ minutes: m }) })) };
    return node;
  }

  deferUntil(e: Record<string, string>): [Record<string, string>, number] {
    const w = Object.fromEntries(e.wait_for.split(",").map((t) => partition(t, "=")));
    return [w, parseIsoZ(w.until) - parseIsoZ(e.wait_since)];
  }

  /** Prefetch PR 5 with this body, labels, commit messages, PR comments, and author. */
  prefetchScreen({ body = "", labels = [] as string[], messages = [] as string[],
    comments = [] as [string, string, string][], author = "someone" } = {}): [string, string, Obj] {
    const head = this.makeClone({ readme: README });
    this.cache("release-lines.txt", "active release lines: v22 v24 v26\n");
    const rules = this.prefetchRules(head);
    const pr = rules[1].stdout;
    pr.body = body;
    pr.labels = labels.map((l) => ({ name: l }));
    pr.author = { login: author };
    pr.commits = messages.map((m) => ({ oid: head, messageHeadline: "x", messageBody: m }));
    const disc = rules[3].stdout.data.repository.pullRequest.comments;
    disc.nodes = comments.map(([who, assoc, text]) => ({ author: { login: who }, authorAssociation: assoc,
      createdAt: ago({ hours: 2 }), isMinimized: false, minimizedReason: null, body: text }));
    disc.totalCount = comments.length;
    this.rules(rules);
    const out = this.runBank(["prefetch", "5"]).stdout;
    return [head, out, JSON.parse(readText(path.join(this.bank, "dossier", "5", "screen.json")))];
  }

  /** A screen entry for PR 5 by `bot-ish`, then my comment on it. */
  screenHold(): Obj {
    this.writeEntry(5, { state: "ready", lane: "screen", author: "bot-ish", prepared_at: ago({ hours: 1 }),
      created_at: ago({ hours: 1 }), screen: "fail: agentscan:automated-account" });
    const mine = { author: { login: "me" }, createdAt: ago({ minutes: 30 }), body: "please see the AI policy" };
    const node = prNode(5, A, { author: "bot-ish", comments: [mine] });
    this.rules([this.syncRule(node)]);
    this.runBank(["sync"]);
    return mine;
  }

  queueRule(nums: number[], { rc = 0, stderr = "" } = {}): Obj {
    const data = Object.fromEntries(nums.map((n) => [`p${n}`, {
      number: n, title: `PR ${n}`, isDraft: false, state: "OPEN",
      updatedAt: ago({ minutes: 1 }), headRefOid: A, author: { login: "someone" },
      files: { nodes: [{ path: "lib/net.js" }] } }]));
    return { match: ["graphql", "files(first:100)"], rc, stderr,
      stdout: rc === 0 ? { data: { repository: data } } : "" };
  }

  fillBank(n = 6): void {
    for (let i = 0; i < n; i++) this.writeEntry(100 + i, { state: "ready" });
  }

  backoffEnv(): Env {
    return { ...this.env, TICK_BACKOFF_MAX_MINUTES: "240" };
  }

  quietTick(env: Env, ...args: string[]): string {
    this.cache("queue.stamp", ago({ minutes: 1 }));
    return this.runBank(["tick", ...args], { env }).stdout;
  }

  tickState(): Obj {
    return JSON.parse(readText(path.join(this.bank, "cache", "tick.json")));
  }
}

const gitOut = (args: string[]): string => run("git", args, { check: false });

describe("bank", { concurrency: 1 }, () => {
  let b: BankTest;
  beforeEach(() => { b = new BankTest(); });
  afterEach(() => { b.cleanup(); });

  test("sync does not clobber a concurrent put", async () => {
    b.writeEntry(5, { state: "preparing", lease: ago({ minutes: 5 }) });
    const gate = path.join(b.tmp, "gate");
    b.rules([{ ...b.syncRule(prNode(5, A)), wait_file: gate }]);
    const sync = b.popenBank(["sync"]);
    for (let i = 0; i < 200; i++) {
      if (exists(gate + ".reached")) break;
      await sleep(100);
    }
    const summary = path.join(b.tmp, "summary.md");
    writeText(summary, "## Summary\nverified\n");
    b.runBank(["put", "5", summary, "--head", A]);
    writeText(gate, "");
    const p = await sync.communicate(60);
    assert.equal(p.returncode, 0, p.stderr);
    const e = b.entry(5);
    assert.equal(e.state, "ready");
    assertIn("verified", e.body);
  });

  test("sync finishes a pr github cannot find", () => {
    b.writeEntry(5, { state: "ready" });
    b.rules([{ match: ["graphql", "headRefOid"], rc: 1, stderr: "gh: Could not resolve to a PullRequest",
      stdout: { data: { repository: { p5: null } },
        errors: [{ type: "NOT_FOUND", path: ["repository", "p5"],
          message: "Could not resolve to a PullRequest with the number of 5." }] } }]);
    b.runBank(["sync"]);
    const e = b.entry(5);
    assert.equal(e.state, "done");
    assert.equal(e.disposition, "not-found");
  });

  test("sync records landed commit and close time", () => {
    b.writeEntry(5, { state: "presented", lane: "cq" });
    const closed = ago({ minutes: 30 });
    b.rules([b.syncRule(prNode(5, A, { state: "CLOSED", closed_at: closed, comments: [
      { author: { __typename: "User", login: "me" }, createdAt: closed, body: "Landed in 42800b60d33f" }] }))]);
    b.runBank(["sync"]);
    const e = b.entry(5);
    assert.equal(e.disposition, "landed 42800b60d33f");
    assert.equal(e.disposition_at, closed);
  });

  test("an action on an old head lets the new head be planned", () => {
    b.writeEntry(5, { state: "presented", lane: "rereview", head: A, pr_head: A, created_at: ago({ hours: 2 }) });
    b.rules([b.syncRule(prNode(5, B, { reviews: [
      { state: "APPROVED", submittedAt: ago({ minutes: 10 }), commit: { oid: A } }] }))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).state, "done");
    b.cache("rereview.tsv", `RE-REVIEW\t5\tAPPROVED\t${A}\t${A}\t${B}\t1\tMERGEABLE\t${ago({ minutes: 1 })}\n`);
    const out = b.runBank(["plan"]).stdout;
    assertIn("PREPARE 5 lane=rereview", out);
  });

  test("an approval does not keep a pr out of the cq lane", () => {
    b.writeEntry(5, { state: "done", lane: "rereview", head: A, pr_head: A, acted_head: A,
      disposition: `approved @${A.slice(0, 12)}`, disposition_at: ago({ minutes: 10 }) });
    b.cache("rereview.tsv", `CQ-CANDIDATE\t5\tAPPROVED\t${A}\t${A}\t${A}\t2\tMERGEABLE\t${ago({ minutes: 1 })}\n`);
    b.cache("ci.json", JSON.stringify({ 5: { head: A, ok: true, line: "CI=SUCCESS HEAD-MATCH", at: ago({ minutes: 1 }) } }));
    const out = b.runBank(["plan"]).stdout;
    assertIn("PREPARE 5 lane=cq", out);
  });

  test("a cq candidate waits for green ci at its head", () => {
    b.cache("rereview.tsv", `CQ-CANDIDATE\t5\tAPPROVED\t${A}\t${A}\t${A}\t2\tMERGEABLE\t${ago({ minutes: 1 })}\n`);
    b.cache("ci.json", JSON.stringify({ 5: { head: A, ok: false, line: "CI=NO-RUN", at: ago({ minutes: 1 }) } }));
    const out = b.runBank(["plan", "--all"]).stdout;
    assertNotIn("PREPARE 5", out);
    assert.match(out, /SKIP 5 lane=cq .*CI/);
  });

  test("the same lane and head is not planned twice", () => {
    b.writeEntry(5, { state: "done", lane: "rereview-asap", head: A, pr_head: A, acted_head: A,
      disposition: `commented @${A.slice(0, 12)}`, disposition_at: ago({ minutes: 10 }) });
    b.cache("rereview.tsv", `RE-REVIEW-ASAP\t5\tCHANGES_REQUESTED\t${C}\t${C}\t${A}\t0\tMERGEABLE\t${ago({ minutes: 1 })}\n`);
    assertNotIn("PREPARE 5", b.runBank(["plan"]).stdout);
  });

  test("a metadata failure keeps the queue and finishes the tick", () => {
    writeText(b.queueOut, "5\thttp\t-\n");
    b.rules([{ match: ["graphql", "files(first:100)"], rc: 1, stderr: "boom" }]);
    const out = b.runBank(["tick", "--refresh"]).stdout;
    assertIn("metadata FAILED", out);
    assertIn("plan:", out);
    assert.ok(!exists(path.join(b.bank, "cache", "queue.stamp")));
    assertIn("5\thttp", readText(path.join(b.bank, "cache", "queue.tsv")));
  });

  test("an ownerless tick lock does not block ticks", () => {
    fs.mkdirSync(path.join(b.bank, "locks", "tick"), { recursive: true });
    writeText(path.join(b.bank, "locks", "tick.lock"), "");
    b.cache("queue.stamp", ago({ minutes: 1 }));
    const out = b.runBank(["tick"]).stdout;
    assertNotIn("another tick is running", out);
    assertIn("plan:", out);
  });

  test("an ownerless gh lock does not hang gh", () => {
    fs.mkdirSync(path.join(b.bank, "locks", "gh"), { recursive: true });
    b.writeEntry(5, { state: "ready" });
    b.rules([b.syncRule(prNode(5, A))]);
    try {
      b.runBank(["sync"], { timeout: 20 });
    } catch (e) {
      if (e instanceof TimeoutExpired) assert.fail("gh hung on a lock directory with no owner");
      throw e;
    }
  });

  test("set rejects bad values", () => {
    b.writeEntry(5);
    for (const kv of ["snooze_until=tomorrow", "state=bogus", "lane=nowhere"]) {
      const p = b.runBank(["set", "5", kv], { check: false });
      assert.notEqual(p.returncode, 0, kv);
    }
    assert.equal(b.entry(5).snooze_until, "-");
    assert.equal(b.entry(5).state, "ready");
  });

  test("present skips a snoozed entry", () => {
    b.writeEntry(5, { snooze_until: iso(new Date(Date.now() + 2 * HOUR)) });
    const p = b.runBank(["present"], { check: false });
    assert.equal(p.returncode, 3, p.stdout + p.stderr);
    assert.equal(b.entry(5).state, "ready");
  });

  test("prefetch writes the dossier and ref", () => {
    const head = b.makeClone();
    b.cache("release-lines.txt", "active release lines: v22 v24 v26\n");
    b.rules(b.prefetchRules(head));
    b.runBank(["prefetch", "5"]);
    const d = path.join(b.bank, "dossier", "5");
    const disc = JSON.parse(readText(path.join(d, "discussion.json")));
    for (const k of ["reviews", "comments", "threads", "excluded", "block_check"]) assertIn(k, disc);
    const ref = gitOut(["-C", path.join(b.tmp, "clone"), "rev-parse", "refs/review-bank/5"]);
    assert.equal(ref, head);
    assert.equal(b.entry(5).state, "preparing");
  });

  test("prefetch keeps the old dossier when the head mismatches", () => {
    b.makeClone();
    const clone = path.join(b.tmp, "clone");
    git(["-C", clone, "update-ref", "refs/review-bank/5", "upstream/main"]);
    const oldRef = gitOut(["-C", clone, "rev-parse", "refs/review-bank/5"]);
    const d = path.join(b.bank, "dossier", "5");
    fs.mkdirSync(d, { recursive: true });
    writeText(path.join(d, "pr.json"), "OLD");
    b.cache("release-lines.txt", "active release lines: v22 v24 v26\n");
    b.rules(b.prefetchRules(C)); // GitHub claims a head the fetch won't produce
    const p = b.runBank(["prefetch", "5"], { check: false });
    assert.notEqual(p.returncode, 0);
    assert.equal(readText(path.join(d, "pr.json")), "OLD");
    const ref = gitOut(["-C", clone, "rev-parse", "refs/review-bank/5"]);
    assert.equal(ref, oldRef);
  });

  test("prefetch writes gates timeline and code owners", () => {
    const [, d, out] = b.prefetchGates();
    assertIn("code owners without an approval: @nodejs/http2", out);
    const g = JSON.parse(readText(path.join(d, "gates.json")));
    assert.equal(g.reviewDecision, "REVIEW_REQUIRED");
    assert.deepEqual(g.checks.not_passing.map((r: Obj) => r.name), ["lint-js", "node-test-pull-request"]);
    assert.equal(g.checks.not_passing[0].workflow, "Linters");
    const co = g.codeowners;
    assert.equal(co.source, "upstream/main:.github/CODEOWNERS");
    const owners = co.owners;
    assert.deepEqual(owners["@nodejs/http2"].paths, ["lib/internal/http2/core.js"]);
    assert.deepEqual(owners["@nodejs/net"].paths, ["lib/internal/http2/core.js", "lib/net.js"]);
    assert.deepEqual(owners["@nodejs/gyp"].paths, ["tools/a.gyp"]);
    assert.deepEqual(owners["@nodejs/docs"].paths, ["doc/api/net.md"]);
    assert.deepEqual(co.unowned_paths, ["lib/internal/http2/sub/x.js", "src/pipe_wrap.cc"]);
    assert.ok(owners["@nodejs/net"].status.startsWith("approved by alice"));
    assert.ok(owners["@nodejs/http2"].status.startsWith("requested"));
    assert.ok(owners["@nodejs/docs"].status.startsWith("not requested"));
    const t = JSON.parse(readText(path.join(d, "timeline.json")));
    assert.equal(t.head_pushed_at.source, "force-push event");
    assert.deepEqual(t.events.map((e: Obj) => e.type), ["commit", "force-push", "commit"]);
  });

  test("prefetch writes ncu metadata for cq entries only", () => {
    const env = { ...b.env, FAKE_NCU_RC: "1", FAKE_NCU_OUT:
      "\x1b[36m⠋\x1b[39m Loading data for nodejs/node/pull/5\n"
      + "   ✔  Approvals: 2\n   ✖  1 GitHub CI job(s) failed:\n" };
    const [, d] = b.prefetchGates({ env });
    const text = readText(path.join(d, "metadata.txt"));
    assertIn("Approvals: 2", text);
    assertIn("(git node metadata exit 1,", text);
    assertNotIn("\x1b", text);
    assertNotIn("Loading data", text);
    const log = splitlines(readText(path.join(b.fake, "git-node.log")));
    assert.deepEqual(pySplit(log[0]).slice(0, 2), ["metadata", "5"]);
    assert.equal(log[1], "gh lock held");
  });

  test("prefetch skips ncu metadata outside the cq lane", () => {
    const [, d] = b.prefetchGates({ lane: "fresh" });
    assert.ok(!exists(path.join(d, "metadata.txt")));
    assert.ok(!exists(path.join(b.fake, "git-node.log")));
  });

  test("a failed gates query does not stop the prefetch", () => {
    const [, d, out] = b.prefetchGates({ gates: { match: ["graphql", "statusCheckRollup"], rc: 1, stderr: "boom" } });
    assertIn("gates: query FAILED", out);
    assert.equal(b.entry(5).state, "preparing");
    assert.ok(truthy(JSON.parse(readText(path.join(d, "gates.json"))).error));
    assert.ok(truthy(JSON.parse(readText(path.join(d, "timeline.json"))).error));
    assert.ok(exists(path.join(d, "metadata.txt")));
  });

  test("an ownerless slot lock is reclaimed", () => {
    b.makeSlots("1");
    const lock = path.join(b.bank, "locks", "slot-1");
    fs.mkdirSync(lock, { recursive: true });
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(lock, old, old);
    const out = b.runBank(["slot", "acquire", "any", "5"]).stdout;
    assert.ok(out.startsWith("1\t"), out);
  });

  test("a slot whose git status fails is not handed out", () => {
    fs.mkdirSync(b.bank, { recursive: true });
    const notrepo = path.join(b.tmp, "notrepo");
    fs.mkdirSync(notrepo);
    writeText(path.join(b.bank, "slots.tsv"), `1\t${notrepo}\n`);
    const p = b.runBank(["slot", "acquire", "any", "5"], { check: false });
    assert.equal(p.returncode, 3, p.stdout + p.stderr);
  });

  test("an approval recorded by sync still reaches the cq lane", () => {
    // The same tick's rereview.tsv already says CQ-CANDIDATE when sync
    // records the approval.
    b.writeEntry(5, { state: "presented", lane: "rereview", head: A, pr_head: A, created_at: ago({ hours: 2 }) });
    b.cache("rereview.tsv", b.rereviewRow(5));
    b.cache("ci.json", JSON.stringify({ 5: { head: A.slice(0, 12), ok: true, line: "CI=SUCCESS HEAD-MATCH", at: ago({ minutes: 1 }) } }));
    b.rules([b.syncRule(prNode(5, A, { reviews: [
      { state: "APPROVED", submittedAt: ago({ minutes: 10 }), commit: { oid: A } }] }))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).state, "done");
    assertIn("PREPARE 5 lane=cq", b.runBank(["plan"]).stdout);
  });

  test("put refuses a draft for another head", () => {
    b.writeEntry(5, { state: "preparing", head: B, pr_head: B, lease: ago({ minutes: 1 }) });
    const summary = path.join(b.tmp, "s.md");
    writeText(summary, "## late draft\n");
    const p = b.runBank(["put", "5", summary, "--head", A], { check: false });
    assert.equal(p.returncode, 5, p.stdout + p.stderr);
    assert.equal(b.entry(5).state, "preparing");
    assertNotIn("late draft", b.entry(5).body);
  });

  test("put refuses an entry that is no longer being prepared", () => {
    const summary = path.join(b.tmp, "s.md");
    writeText(summary, "## late draft\n");
    for (const state of ["done", "presented"]) {
      b.writeEntry(5, { state, head: A, pr_head: A });
      const p = b.runBank(["put", "5", summary, "--head", A], { check: false });
      assert.equal(p.returncode, 5, state);
      assert.equal(b.entry(5).state, state);
    }
  });

  test("put counts needs a run and takes no state override", () => {
    b.writeEntry(5, { state: "preparing", head: A, pr_head: A, lease: ago({ minutes: 1 }) });
    const summary = path.join(b.tmp, "s.md");
    writeText(summary, "## Summary\n### Needs a run\n- test/parallel/test-foo.js: fails on main\n");
    b.runBank(["put", "5", summary, "--head", A, "--state", "ready"]);
    const e = b.entry(5);
    assert.equal(e.state, "needs-run");
    assert.equal(e.needs_run, "1");
  });

  test("plan counts eligible candidates per lane", () => {
    b.candidateCache(6);
    b.cache("rereview.tsv", b.rereviewRow(5, { bucket: "RE-REVIEW" }));
    const out = b.runBank(["plan"]).stdout;
    assertIn("plan: eligible candidates by lane: 1 rereview, 1 fresh", out);
    b.writeEntry(5, { state: "ready" });
    b.writeEntry(6, { state: "ready" });
    assertIn("plan: eligible candidates by lane: none", b.runBank(["plan"]).stdout);
  });

  test("a pr closed since the queue was cached is not planned", () => {
    b.candidateCache(5);
    b.writeEntry(5, { state: "done", lane: "fresh", disposition: "landed 42800b60d33f",
      disposition_at: ago({ minutes: 5 }), updated_at: ago({ minutes: 5 }) });
    const out = b.runBank(["plan", "--all"]).stdout;
    assertNotIn("PREPARE 5", out);
    assertIn("SKIP 5", out);
  });

  test("an action newer than the queue cache is honored", () => {
    b.candidateCache(5, { head: A });
    b.writeEntry(5, { state: "done", lane: "fresh", head: B, pr_head: B, acted_head: B,
      disposition: `approved @${B.slice(0, 12)}`, disposition_at: ago({ minutes: 5 }), updated_at: ago({ minutes: 5 }) });
    assertNotIn("PREPARE 5", b.runBank(["plan"]).stdout);
  });

  test("prefetch refuses a closed pr", () => {
    const head = b.makeClone();
    b.cache("release-lines.txt", "active release lines: v22 v24 v26\n");
    const rules = b.prefetchRules(head);
    for (const r of rules) {
      if (JSON.stringify(r.match) === JSON.stringify(["pr", "view", "5"])) r.stdout.state = "CLOSED";
    }
    b.rules(rules);
    const p = b.runBank(["prefetch", "5"], { check: false });
    assert.equal(p.returncode, 4, p.stdout + p.stderr);
    assert.ok(!exists(path.join(b.bank, "dossier", "5")));
    const e = b.entry(5);
    assert.deepEqual([e.state, e.disposition], ["done", "closed"]);
  });

  test("plan stops offering a pr prefetch found closed", () => {
    // The cached queue still lists the PR, as it does while the refresh
    // is dormant. A woken hold made it plannable again.
    const head = b.makeClone();
    b.cache("release-lines.txt", "active release lines: v22 v24 v26\n");
    b.candidateCache(5, { head: A, updated: ago({ hours: 3 }) });
    b.writeEntry(5, { state: "done", lane: "fresh", head: A, pr_head: A, acted_head: A,
      disposition: `approved @${A.slice(0, 12)}`, wait_since: ago({ hours: 2 }),
      updated_at: ago({ hours: 3 }) });
    assertIn("PREPARE 5", b.runBank(["plan"]).stdout);
    const rules = b.prefetchRules(head);
    for (const r of rules) {
      if (JSON.stringify(r.match) === JSON.stringify(["pr", "view", "5"])) {
        r.stdout.state = "MERGED";
        r.stdout.updatedAt = ago({ minutes: 1 });
      }
    }
    b.rules(rules);
    assert.equal(b.runBank(["prefetch", "5"], { check: false }).returncode, 4);
    assert.equal(b.entry(5).disposition, "merged");
    assertNotIn("PREPARE 5", b.runBank(["plan"]).stdout);
  });

  test("a commit queue failed label does not finish a cq entry", () => {
    b.writeEntry(5, { state: "ready", lane: "cq" });
    b.rules([b.syncRule(prNode(5, A, { labels: ["commit-queue-failed", "commit-queue-squash"] }))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).state, "ready");
  });

  test("cq ci checks the oldest result first", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => b.rereviewRow(n, { updated: ago({ minutes: n }) })).join("");
    writeText(b.rereviewOut, rows);
    b.cache("queue.stamp", ago({ minutes: 1 }));
    const stale = Object.fromEntries([1, 2, 3, 4, 5].map((n) =>
      [String(n), { head: A.slice(0, 12), ok: false, line: "CI=NO-RUN", at: ago({ hours: 2 }) }]));
    b.cache("ci.json", JSON.stringify(stale));
    b.runBank(["tick"]);
    const ci = JSON.parse(readText(path.join(b.bank, "cache", "ci.json")));
    assertIn("6", ci, "the never-checked candidate waited behind higher-ranked ones");
  });

  test("ci is keyed by the head ci status reports", () => {
    writeText(b.rereviewOut, b.rereviewRow(5));
    b.cache("queue.stamp", ago({ minutes: 1 }));
    const env = { ...b.env, FAKE_CI_HEAD: "b".repeat(12) };
    const out = b.runBank(["tick"], { env }).stdout;
    assertNotIn("PREPARE 5", out);
  });

  test("prefetch aborts when the head moves during the fetch", () => {
    const head = b.makeClone();
    const clone = path.join(b.tmp, "clone");
    git(["-C", clone, "update-ref", "refs/review-bank/5", "upstream/main"]);
    const oldRef = gitOut(["-C", clone, "rev-parse", "refs/review-bank/5"]);
    const d = path.join(b.bank, "dossier", "5");
    fs.mkdirSync(d, { recursive: true });
    writeText(path.join(d, "pr.json"), "OLD");
    b.cache("release-lines.txt", "active release lines: v22 v24 v26\n");
    const rules = b.prefetchRules(head);
    rules[0].stdout = C + "\n"; // a push landed after the fetch
    b.rules(rules);
    const p = b.runBank(["prefetch", "5"], { check: false });
    assert.notEqual(p.returncode, 0);
    assert.equal(readText(path.join(d, "pr.json")), "OLD");
    const ref = gitOut(["-C", clone, "rev-parse", "refs/review-bank/5"]);
    assert.equal(ref, oldRef);
    assert.ok(!exists(path.join(b.bank, "prs", "5.md")));
  });

  test("present rechecks the entry after waiting for its lock", async () => {
    b.writeEntry(5, { state: "ready" });
    fs.mkdirSync(path.join(b.bank, "locks"), { recursive: true });
    const lock = await holdFlock(path.join(b.bank, "locks", "entry-5.lock"));
    let pres: Popen;
    try {
      pres = b.popenBank(["present"]);
      await sleep(1500);
      b.writeEntry(5, { state: "done", disposition: "skipped", disposition_at: ago({ minutes: 0 }) });
    } finally {
      await lock.release();
    }
    const p = await pres.communicate(30);
    assert.notEqual(p.returncode, 0);
    assert.equal(b.entry(5).state, "done");
  });

  test("a snooze time without a zone does not crash", () => {
    b.writeEntry(5);
    b.runBank(["set", "5", "snooze_until=2099-12-01T12:00:00"]);
    assertIn("(snoozed)", b.runBank(["list"]).stdout);
    assert.equal(b.runBank(["present"], { check: false }).returncode, 3);
  });

  test("slot release checks the pr and removes leftovers", () => {
    b.makeSlots("1");
    b.runBank(["slot", "acquire", "1", "6"]);
    const p = b.runBank(["slot", "release", "1", "5"], { check: false });
    assert.notEqual(p.returncode, 0);
    assert.ok(exists(path.join(b.bank, "locks", "slot-1", "owner.json")));
    b.runBank(["slot", "release", "1", "6"]);
    assert.ok(!exists(path.join(b.bank, "locks", "slot-1")));
    const lock = path.join(b.bank, "locks", "slot-1");
    fs.mkdirSync(lock);
    writeText(path.join(lock, ".owner.json.x.tmp"), "");
    b.runBank(["slot", "release", "1", "--force"]);
    assert.ok(!exists(lock));
  });

  test("set done cleans up the dossier", () => {
    b.writeEntry(5, { state: "ready" });
    const d = path.join(b.bank, "dossier", "5");
    fs.mkdirSync(d, { recursive: true });
    writeText(path.join(d, "pr.json"), "{}");
    b.runBank(["set", "5", "state=done", "disposition=skipped", `disposition_at=${ago({ minutes: 1 })}`]);
    assert.ok(!exists(d));
  });

  test("sync skips an entry reprepared during the query", async () => {
    b.writeEntry(5, { state: "preparing", head: A, pr_head: A, lease: ago({ minutes: 5 }) });
    const gate = path.join(b.tmp, "gate");
    b.rules([{ ...b.syncRule(prNode(5, A)), wait_file: gate }]);
    const sync = b.popenBank(["sync"]);
    for (let i = 0; i < 200; i++) {
      if (exists(gate + ".reached")) break;
      await sleep(100);
    }
    b.writeEntry(5, { state: "preparing", head: B, pr_head: B, lease: ago({ minutes: 0 }) });
    writeText(gate, "");
    await sync.communicate(60);
    assert.equal(b.entry(5).pr_head, B);
  });

  test("tick pulls a newer image when no slot is held", async () => {
    b.makeSlots("1", "2");
    b.devcState({ slots: { 1: { container_image: "1".repeat(12) }, 2: { container_image: "1".repeat(12) } } });
    b.hubSays();
    b.cache("queue.stamp", ago({ minutes: 1 }));
    let out = b.runBank(["tick"]).stdout;
    assertIn("pulling in the background", out);
    await b.waitFor(() => "rc" in JSON.parse(readText(path.join(b.bank, "cache", "image-pull.json"))), "the pull");
    assert.deepEqual(b.devcCalls("pull"), [["slot1", "pull"]]);
    // The Docker Hub answer is cached, and a pull isn't retried within the hour.
    fs.unlinkSync(b.hub);
    out = b.runBank(["tick"]).stdout;
    assertNotIn("check failed", out);
    assertIn("the pull at", out);
    assert.equal(b.devcCalls("pull").length, 1);
  });

  test("the pull waits while a slot is held", () => {
    b.makeSlots("1", "2");
    b.devcState();
    b.hubSays();
    b.cache("queue.stamp", ago({ minutes: 1 }));
    b.runBank(["slot", "acquire", "1", "5"]);
    const out = b.runBank(["tick"]).stdout;
    assertIn("the pull and any moves wait until no slot is held (slot 1 for #5)", out);
    assert.ok(!exists(path.join(b.bank, "cache", "image-pull.json")));
    assert.deepEqual(b.devcCalls("pull"), []);
  });

  test("an image matching a platform digest is current", () => {
    b.makeSlots("1");
    b.devcState({ image: { image_digests: "docker.io/nodejs/devcontainer@sha256:new-arm64 x@sha256:other" } });
    b.hubSays();
    b.cache("queue.stamp", ago({ minutes: 1 }));
    const out = b.runBank(["tick"]).stdout;
    assertIn("; current", out);
    assert.deepEqual(b.devcCalls("pull"), []);
  });

  test("tick moves a free outdated slot and never a held one", async () => {
    b.makeSlots("1", "2");
    const gate = path.join(b.tmp, "gate");
    const old = { container_image: "0".repeat(12) };
    b.devcState({ image: { image_digests: "x@sha256:new" }, slots: { 1: { ...old }, 2: { ...old } },
      wait: { build: gate } });
    b.hubSays();
    b.cache("queue.stamp", ago({ minutes: 1 }));
    b.runBank(["slot", "acquire", "1", "5"]);
    const out = b.runBank(["tick"]).stdout;
    assertIn("slot 2: moving from 000000000000 to 111111111111", out);
    await b.waitFor(() => exists(gate + ".reached"), "the build");
    // The moving slot is held: no agent gets it, and status says why.
    assert.equal(b.runBank(["slot", "acquire", "any", "6"], { check: false }).returncode, 3);
    assertIn("moving to image 111111111111", b.runBank(["slot", "status"]).stdout);
    assertIn("slot 2: moving to 111111111111", b.runBank(["tick"]).stdout);
    writeText(gate, "");
    await b.waitFor(() => !exists(path.join(b.bank, "locks", "slot-2")), "the slot release");
    assert.deepEqual([...b.devcCalls("down"), ...b.devcCalls("build")], [["slot2", "down"], ["slot2", "build"]]);
    assert.equal(JSON.parse(readText(path.join(b.bank, "cache", "image-moves.json")))["2"].rc, 0);
    assert.ok(exists(path.join(b.bank, "locks", "slot-1", "owner.json")));
  });

  test("a busy dirty or branched slot is not moved", () => {
    b.makeSlots("1", "2", "3");
    const old = { container_image: "0".repeat(12) };
    b.devcState({ image: { image_digests: "x@sha256:new" },
      slots: { 1: { ...old, busy: "yes" }, 2: { ...old }, 3: { ...old } } });
    writeText(path.join(b.tmp, "slot2", "untracked"), "x");
    for (const args of [["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"],
      ["checkout", "-q", "-b", "mine"]]) {
      git(["-C", path.join(b.tmp, "slot3"), ...args]);
    }
    b.hubSays();
    b.cache("queue.stamp", ago({ minutes: 1 }));
    const out = b.runBank(["tick"]).stdout;
    assertIn("slot 1: on older image 000000000000; the move waits (something runs", out);
    assertIn("slot 2: on older image 000000000000; the move waits (checkout has changes)", out);
    assertIn("slot 3: on older image 000000000000; the move waits (checkout is on mine", out);
    assert.deepEqual(b.devcCalls("down"), []);
  });

  test("a failed move releases the slot and is not retried at once", async () => {
    b.makeSlots("1");
    b.devcState({ image: { image_digests: "x@sha256:new" }, slots: { 1: { container_image: "0".repeat(12) } },
      rc: { build: 1 } });
    b.hubSays();
    b.cache("queue.stamp", ago({ minutes: 1 }));
    b.runBank(["tick"]);
    await b.waitFor(() => exists(path.join(b.bank, "cache", "image-moves.json")), "the move");
    await b.waitFor(() => !exists(path.join(b.bank, "locks", "slot-1")), "the slot release");
    const out = b.runBank(["tick"]).stdout;
    assertIn("the move waits (the move at", out);
    assert.equal(b.devcCalls("build").length, 1);
  });

  test("a move whose worker is gone is reclaimed", () => {
    b.makeSlots("1");
    const lock = path.join(b.bank, "locks", "slot-1");
    fs.mkdirSync(lock, { recursive: true });
    writeText(path.join(lock, "owner.json"), JSON.stringify({ pr: "image-move", owner: "image-move", at: ago({ minutes: 5 }) }));
    const out = b.runBank(["slot", "acquire", "any", "5"]).stdout;
    assert.ok(out.startsWith("1\t"), out);
  });

  test("acquire prefers a slot on the local image", () => {
    b.makeSlots("1", "2");
    b.devcState({ slots: { 1: { container_image: "0".repeat(12) }, 2: { container_image: "1".repeat(12) } } });
    assert.ok(b.runBank(["slot", "acquire", "any", "5"]).stdout.startsWith("2\t"));
    const p = b.runBank(["slot", "acquire", "any", "6"]);
    assert.ok(p.stdout.startsWith("1\t"), p.stdout);
    assertIn("older than the local 111111111111", p.stderr);
  });

  test("slot status shows the image commit and how far behind main", () => {
    b.makeClone();
    const clone = path.join(b.tmp, "clone");
    const first = git(["-C", clone, "rev-list", "--max-parents=0", "upstream/main"]);
    const work = path.join(b.tmp, "work");
    for (const msg of ["two", "three"]) git(["-C", work, "commit", "-q", "--allow-empty", "-m", msg]);
    git(["-C", work, "push", "-q", path.join(b.tmp, "upstream.git"), "HEAD:main"]);
    git(["-C", clone, "fetch", "-q", "upstream"]);
    b.makeSlots("1");
    b.devcState({ slots: { 1: { container_image: "0".repeat(12), image_commit: first } } });
    const out = b.runBank(["slot", "status"]).stdout;
    // pr, two, three are on upstream/main after the image's commit.
    assertIn(`image: 000000000000 built from ${first.slice(0, 12)} (3 commits behind upstream/main), `
      + "OUTDATED: local image is 111111111111", out);
  });

  test("image prune runs only in free slots", () => {
    b.makeSlots("1", "2");
    b.devcState();
    b.runBank(["slot", "acquire", "1", "5"]);
    const out = b.runBank(["image", "prune"]).stdout;
    assertIn("slot 1: held for #5, skipped", out);
    assert.deepEqual(b.devcCalls("prune"), [["slot2", "prune"]]);
  });

  test("devc image and prune touch only this checkouts stale volumes", () => {
    const key = b.runDevc("image", {})[1].key;
    const cur = "1".repeat(12), ctr = "2".repeat(12), old = "3".repeat(12);
    const vols = [`node-devc-out-${key}-${cur}`, `node-devc-out-${key}-${ctr}`, `node-devc-out-${key}-${old}`,
      `node-devc-out-${key}-x-123-${old}`, `node-devc-out-http-foo-1-${old}`, "node-devc-ccache"];
    const state: Obj = {
      image: { id: cur + "abcd", digests: ["r@sha256:a", "r@sha256:b"],
        created: "2026-11-19 03:59:40.1 +0000 UTC" },
      containers: { [`node-devc-${key}`]: { state: "running", image: ctr + "ef", commit: "c".repeat(40) } },
      ps: "      1 Ss   sleep infinity\n     14 Z    [git] <defunct>\n    597 Rs   ps -eo pid=,stat=,args=",
      volumes: vols,
    };
    const info = b.runDevc("image", state)[1];
    assert.equal(info.image_id, cur);
    assert.equal(info.image_digests, "r@sha256:a r@sha256:b");
    assert.equal(info.container_image, ctr);
    assert.equal(info.image_commit, "c".repeat(40));
    assert.deepEqual([info.outdated, info.busy], ["yes", "no"]);
    assert.equal(info.stale_volumes, `node-devc-out-${key}-${old}`);
    state.ps += "\n    600 S    bash -lc ninja";
    assert.equal(b.runDevc("image", state)[1].busy, "yes");
    b.runDevc("prune", state);
    const left = JSON.parse(readText(path.join(b.fake, "state.json"))).volumes;
    assert.deepEqual(left, vols.filter((v) => v !== `node-devc-out-${key}-${old}`));
  });

  test("devc prune refuses without the image", () => {
    const key = b.runDevc("image", {})[1].key;
    const vols = [`node-devc-out-${key}-${"3".repeat(12)}`];
    const [p] = b.runDevc("prune", { volumes: vols }, false);
    assert.notEqual(p.returncode, 0);
    assert.deepEqual(JSON.parse(readText(path.join(b.fake, "state.json"))).volumes, vols);
  });

  test("discussion reports a failed block lookup as unknown", () => {
    const out = b.runDiscussion([b.comment("drive-by", "NONE")]);
    assert.equal(out.block_check, "unknown");
  });

  test("discussion does not probe members in threads", () => {
    b.runDiscussion([b.comment("collaborator", "MEMBER")]);
    assert.deepEqual(b.calls().filter((c: string[]) => c.some((a) => a.includes("blocks/"))), []);
  });

  test("discussion reads the repo from REPO", () => {
    b.runDiscussion([], { ...b.env, REPO: "someorg/somerepo" });
    const q = b.calls().filter((c: string[]) => c.includes("graphql"))[0];
    assertIn("o=someorg", q);
    assertIn("r=somerepo", q);
  });

  test("hold keeps a candidate with no entry out of the plan", () => {
    b.cache("rereview.tsv", b.rereviewRow(5));
    b.cache("ci.json", JSON.stringify({ 5: { head: A.slice(0, 12), ok: true, line: "CI=SUCCESS HEAD-MATCH", at: ago({ minutes: 1 }) } }));
    assertIn("PREPARE 5 lane=cq", b.runBank(["plan"]).stdout);
    b.runBank(["hold", "5", "--until-reviews", "2", "more", "http", "reviews"]);
    const e = b.entry(5);
    assert.equal(e.state, "waiting");
    assert.equal(e.lane, "cq");
    assert.equal(e.note, "held: more http reviews");
    assert.equal(e.wait_for, `reviews=2,push=${A.slice(0, 12)}`);
    const out = b.runBank(["plan", "--all"]).stdout;
    assertNotIn("PREPARE 5", out);
    assert.match(out, /WAIT 5 lane=cq since .*2 review\(s\) by others/);
  });

  test("hold refuses a pr the bank does not know", () => {
    const p = b.runBank(["hold", "5"], { check: false });
    assert.notEqual(p.returncode, 0);
    assert.ok(!exists(path.join(b.bank, "prs", "5.md")));
  });

  test("reviews by others wake a hold and the pr is planned again", () => {
    // Skipped in the cq lane at this head, then held: the wake brings it back.
    b.writeEntry(5, { state: "done", lane: "cq", acted_head: A, disposition: "skipped",
      disposition_at: ago({ hours: 2 }) });
    b.runBank(["hold", "5", "--until-reviews", "2"]);
    const since = b.entry(5).wait_since;
    b.rules([b.syncRule(b.reviewedNode(5, A, { others: [["http-a", -1], ["me", -1], ["someone", -1]] }))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).state, "waiting", "me and the author don't count");
    b.rules([b.syncRule(b.reviewedNode(5, A, { others: [["http-a", -1], ["http-b", -1], ["old", 600]] }))]);
    b.runBank(["sync"]);
    const e = b.entry(5);
    assert.equal(e.state, "done");
    assert.equal(e.note, "woke: reviewed by http-a, http-b");
    assert.equal(e.wait_since, since);
    b.cache("rereview.tsv", b.rereviewRow(5));
    b.cache("ci.json", JSON.stringify({ 5: { head: A.slice(0, 12), ok: true, line: "CI=SUCCESS HEAD-MATCH", at: ago({ minutes: 1 }) } }));
    const out = b.runBank(["plan"]).stdout;
    assertIn("PREPARE 5 lane=cq", out);
    assertIn("(woke: reviewed by http-a, http-b)", out);
  });

  test("a push or the until time wakes a hold", () => {
    b.writeEntry(5, { state: "ready" });
    b.runBank(["hold", "5"]);
    b.rules([b.syncRule(b.reviewedNode(5, B))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).note, `woke: new push ${B.slice(0, 12)}`);
    b.writeEntry(6, { state: "ready" });
    b.runBank(["hold", "6", "--until-reviews", "0", "--until", "2026-01-02T03:04:05"]);
    assert.equal(b.entry(6).wait_for, `push=${A.slice(0, 12)},until=2026-01-02T03:04:05Z`);
    b.rules([b.syncRule(b.reviewedNode(6, A, { others: [["http-a", -1]] }))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(6).state, "done");
    assert.equal(b.entry(6).note, "woke: hold until 2026-01-02T03:04:05Z passed");
  });

  test("hold drops the dossier and unhold wakes it", () => {
    b.writeEntry(5, { state: "ready" });
    const d = path.join(b.bank, "dossier", "5");
    fs.mkdirSync(d, { recursive: true });
    b.runBank(["hold", "5", "--until", "2099-01-01T00:00:00Z"]);
    assert.ok(!exists(d));
    assertIn("waiting", b.runBank(["list"]).stdout);
    assert.equal(b.runBank(["present"], { check: false }).returncode, 3);
    b.runBank(["unhold", "5"]);
    assert.equal(b.entry(5).state, "done");
    assert.equal(b.entry(5).note, "woke: unheld by hand");
    assert.notEqual(b.runBank(["unhold", "5"], { check: false }).returncode, 0);
  });

  test("hold until author wakes on an author comment", () => {
    b.writeEntry(5, { state: "ready", author: "writer" });
    b.runBank(["hold", "5", "--until-author", "--until-reviews", "0"]);
    let e = b.entry(5);
    assert.equal(e.wait_for, `push=${A.slice(0, 12)},author=writer`);
    assertIn("a comment by @writer", b.runBank(["list"]).stdout);
    const other = { author: { login: "bystander" }, createdAt: ago({ minutes: -1 }), body: "+1" };
    const old = { author: { login: "writer" }, createdAt: ago({ hours: 1 }), body: "earlier" };
    b.rules([b.syncRule(prNode(5, A, { author: "writer", comments: [old, other] }))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).state, "waiting", "only a new comment by the author wakes it");
    const theirs = { author: { login: "writer" }, createdAt: ago({ minutes: -1 }), body: "benchmarks below" };
    b.rules([b.syncRule(prNode(5, A, { author: "writer", comments: [old, other, theirs] }))]);
    b.runBank(["sync"]);
    e = b.entry(5);
    assert.equal(e.state, "done");
    // Not "author responded": that marks a screen hold, whose wake skips the screen at prefetch.
    assert.equal(e.note, "woke: comment by the author @writer");
  });

  test("hold until author refuses an unknown author", () => {
    b.cache("rereview.tsv", b.rereviewRow(5, { bucket: "RE-REVIEW" }));
    const p = b.runBank(["hold", "5", "--until-author"], { check: false });
    assert.equal(p.returncode, 2, p.stdout + p.stderr);
    assert.ok(!exists(path.join(b.bank, "prs", "5.md")));
  });

  test("defer holds on the author a push a review or seven days", () => {
    b.writeEntry(5, { state: "preparing", author: "writer", lease: ago({ minutes: 5 }) });
    const d = path.join(b.bank, "dossier", "5");
    fs.mkdirSync(d, { recursive: true });
    const reason = "mcollina asked for a benchmark (https://github.com/nodejs/node/pull/5#issuecomment-1), no reply";
    const out = b.runBank(["defer", "5", ...pySplit(reason)]).stdout;
    assert.equal(splitlines(out.trim()).at(-1), `DEFER #5: ${reason}`);
    const e = b.entry(5);
    assert.equal(e.state, "waiting");
    assert.equal(e.note, `defer: ${reason}`);
    const [w, span] = b.deferUntil(e);
    assert.deepEqual([w.reviews, w.push, w.author], ["1", A.slice(0, 12), "writer"]);
    assert.equal(span, 7 * DAY);
    assert.ok(!exists(d));
    assertIn(`(defer: ${reason})`, b.runBank(["plan", "--all"]).stdout);
    // A review by someone else wakes it.
    b.rules([b.syncRule(b.reviewedNode(5, A, { others: [["lpinca", -1]] }))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).note, "woke: reviewed by lpinca");
    // A push wakes it.
    b.runBank(["defer", "5", "author", "said", "more", "commits", "are", "coming"]);
    b.rules([b.syncRule(b.reviewedNode(5, B))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).note, `woke: new push ${B.slice(0, 12)}`);
    // unhold reverses it.
    b.writeEntry(5, { state: "ready", author: "writer" });
    b.runBank(["defer", "5", "waiting", "on", "a", "rebase"]);
    b.runBank(["unhold", "5"]);
    assert.equal(b.entry(5).note, "woke: unheld by hand");
  });

  test("defer falls back to DEFER_DAYS", () => {
    b.writeEntry(5, { state: "ready", author: "writer" });
    b.runBank(["defer", "5", "linked", "PR", "may", "supersede", "it"], { env: { ...b.env, DEFER_DAYS: "2" } });
    let e = b.entry(5);
    const [w, span] = b.deferUntil(e);
    assert.equal(span, 2 * DAY);
    b.rules([b.syncRule(b.reviewedNode(5, A))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).state, "waiting", "no author comment, push, or review yet");
    // Pretend the 2 days passed with nothing else: the time wakes it.
    e.wait_for = pyReplace(e.wait_for, w.until, ago({ minutes: 1 }));
    const { body: _body, pr: _pr, ...fields } = e;
    b.writeEntry(5, fields);
    b.runBank(["sync"]);
    e = b.entry(5);
    assert.equal(e.state, "done");
    assert.match(e.note, /^woke: hold until \S+Z passed$/);
  });

  test("defer needs a reason", () => {
    b.writeEntry(5, { state: "ready", author: "writer" });
    const p = b.runBank(["defer", "5"], { check: false });
    assert.equal(p.returncode, 2, p.stdout + p.stderr);
    assert.equal(b.entry(5).state, "ready");
  });

  test("deferred entries do not use the banks room", () => {
    b.candidateCache(9);
    b.writeEntry(5, { state: "needs-run", author: "writer", needs_run: "1" });
    const out = b.runBank(["plan", "--target", "1"]).stdout;
    assertNotIn("PREPARE 9", out);
    b.runBank(["defer", "5", "the", "author", "must", "rebase", "before", "the", "repro", "can", "run"]);
    assert.equal(b.entry(5).state, "waiting");
    assertIn("PREPARE 9", b.runBank(["plan", "--target", "1"]).stdout);
  });

  test("a run that cannot be done is an open question not needs run", () => {
    b.writeEntry(5, { state: "preparing", head: A, pr_head: A, lease: ago({ minutes: 1 }) });
    const summary = path.join(b.tmp, "s.md");
    writeText(summary, "## Summary\n### Needs a run\n- None.\n"
      + "### Open questions\n- Is it faster on arm64? Needs hardware the slots lack.\n");
    b.runBank(["put", "5", summary, "--head", A]);
    const e = b.entry(5);
    assert.deepEqual([e.state, e.needs_run], ["ready", "0"]);
  });

  test("an approval before the landing wait ends waits", () => {
    b.writeEntry(5, { state: "presented", lane: "rereview", created_at: ago({ hours: 2 }) });
    const node = b.reviewedNode(5, A, { created: ago({ hours: 1 }) });
    node.reviews.nodes = [{ state: "APPROVED", submittedAt: ago({ minutes: 10 }), commit: { oid: A } }];
    b.cache("ci.json", JSON.stringify({ 5: { head: A.slice(0, 12), ok: true, line: "CI=SUCCESS HEAD-MATCH", at: ago({ minutes: 1 }) } }));
    b.rules([b.syncRule(node)]);
    b.runBank(["sync"]);
    const e = b.entry(5);
    assert.equal(e.state, "waiting");
    assert.ok(e.disposition.startsWith("approved"));
    assert.match(e.wait_for, new RegExp(`^reviews=1,push=${A.slice(0, 12)},landing=\\S+Z$`));
    b.cache("rereview.tsv", b.rereviewRow(5));
    assertNotIn("PREPARE 5", b.runBank(["plan"]).stdout);
    // The landing wait ends (fast-track here): the hold wakes into the cq lane.
    node.labels.nodes = [{ name: "fast-track" }];
    b.rules([b.syncRule(node)]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).note, "woke: landing wait over");
    assertIn("PREPARE 5 lane=cq", b.runBank(["plan"]).stdout);
  });

  test("an approval with red ci waits for green ci", () => {
    b.writeEntry(5, { state: "presented", lane: "rereview", created_at: ago({ hours: 2 }) });
    const node = b.reviewedNode(5, A);
    node.reviews.nodes = [{ state: "APPROVED", submittedAt: ago({ minutes: 10 }), commit: { oid: A } }];
    b.rules([b.syncRule(node)]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).wait_for, `reviews=1,push=${A.slice(0, 12)},ci`);
    // A tick checks CI for the held cq candidate, and the next sync wakes it.
    writeText(b.rereviewOut, b.rereviewRow(5));
    b.cache("queue.stamp", ago({ minutes: 1 }));
    b.runBank(["tick"]);
    assert.equal(b.entry(5).state, "waiting");
    b.runBank(["sync"]);
    assert.equal(b.entry(5).note, `woke: CI green at ${A.slice(0, 12)}`);
  });

  test("a cq candidate waits for the landing wait", () => {
    const green = JSON.stringify({ 5: { head: A.slice(0, 12), ok: true, line: "CI=SUCCESS HEAD-MATCH", at: ago({ minutes: 1 }) } });
    b.cache("ci.json", green);
    b.cache("rereview.tsv", b.rereviewRow(5).replace(/\n+$/, "") + `\t${ago({ hours: 10 })}\t-\n`);
    assert.match(b.runBank(["plan", "--all"]).stdout, /SKIP 5 lane=cq landing wait until/);
    b.cache("rereview.tsv", b.rereviewRow(5).replace(/\n+$/, "") + `\t${ago({ hours: 10 })}\tfast-track,http\n`);
    assertIn("PREPARE 5 lane=cq", b.runBank(["plan"]).stdout);
  });

  test("the landing wait is 72 hours over a weekend", () => {
    // Opened next week, so every landing time is still in the future.
    const green = JSON.stringify({ 5: { head: A.slice(0, 12), ok: true, line: "CI=SUCCESS HEAD-MATCH", at: ago({ minutes: 1 }) } });
    b.cache("ci.json", green);
    const noon = new Date();
    noon.setUTCHours(12, 0, 0, 0);
    const weekday = (noon.getUTCDay() + 6) % 7; // Monday is 0, as in Python
    const monday = noon.getTime() + (7 - weekday) * DAY;
    const day = (n: number): string => iso(new Date(monday + n * DAY));
    for (const [opened, landing] of [[0, 2], [3, 6], [6, 9]]) { // Mon to Wed, Thu to Sun, Sun to Wed
      const row = b.rereviewRow(5).replace(/\n+$/, "") + `\t${day(opened)}\thttp\n`;
      b.cache("rereview.tsv", row);
      assertIn(`SKIP 5 lane=cq landing wait until ${day(landing)}`, b.runBank(["plan", "--all"]).stdout);
    }
    // fast-track has no wait: it can land once it's open.
    b.cache("rereview.tsv", b.rereviewRow(5).replace(/\n+$/, "") + `\t${day(3)}\tfast-track\n`);
    assertIn(`SKIP 5 lane=cq landing wait until ${day(3)}`, b.runBank(["plan", "--all"]).stdout);
  });

  // The automation screen.

  test("screen passes a pr with no automation signals", () => {
    const [, out, sc] = b.prefetchScreen({ body: "Fixes a bug." });
    assert.equal(sc.result, "pass");
    assert.equal(b.entry(5).state, "preparing");
    assertIn("gates:", out);
  });

  test("screen skips collaborators even when flagged", async () => {
    await subTests(["Collab-Active", "tsc-voting"], (login) => `login=${login}`, (login) => {
      for (const p of ["clone", "work", "upstream.git"]) fs.rmSync(path.join(b.tmp, p), { recursive: true, force: true });
      fs.rmSync(path.join(b.bank, "dossier"), { recursive: true, force: true });
      fs.rmSync(path.join(b.bank, "prs", "5.md"), { force: true });
      const [, , sc] = b.prefetchScreen({ body: "No disclosure.", author: login, ...FLAGGED });
      assert.deepEqual([sc.result, sc.why], ["pass", "skipped: collaborator"]);
      assert.equal(b.entry(5).lane, "fresh");
      assert.equal(b.entry(5).screen, "pass: skipped: collaborator");
    });
  });

  test("screen does not trust emeriti or triagers", () => {
    const cachedPath = path.join(b.bank, "cache", "collaborators.json");
    const cached = exists(cachedPath) ? JSON.parse(readText(cachedPath)) : null;
    assert.equal(cached, null);
    const [, , sc] = b.prefetchScreen({ body: "No disclosure.", author: "someone", ...FLAGGED });
    assert.equal(sc.result, "fail");
    const logins = JSON.parse(readText(cachedPath));
    assert.deepEqual(logins, ["collab-active", "tsc-voting"]);
  });

  test("screen passes an unflagged pr that discloses ai use", () => {
    const [, , sc] = b.prefetchScreen({
      body: "AI disclosure: Claude Code was used to write the change.",
      labels: ["http"], messages: ["fix\n\nAssisted-by: a closed-source coding agent\nSigned-off-by: x"] });
    assert.equal(sc.result, "pass", JSON.stringify(sc));
    assert.deepEqual(sc.signals.ai_trailers, ["Assisted-by: a closed-source coding agent"]);
    const e = b.entry(5);
    assert.deepEqual([e.state, e.lane], ["preparing", "fresh"]);
    assert.equal(e.screen, "pass: disclosed");
  });

  test("screen fails a flagged pr with no disclosure and needs no agent", () => {
    const [, out, sc] = b.prefetchScreen({
      body: "This fixes duplicate bytes in Utf8Stream.", comments: [["github-actions", "CONTRIBUTOR", WELCOME]],
      ...FLAGGED });
    assert.equal(sc.result, "fail");
    assert.ok(truthy(sc.signals.agentscan_caution));
    assert.ok(truthy(sc.signals.first_contribution));
    const e = b.entry(5);
    assert.deepEqual([e.state, e.lane], ["ready", "screen"]);
    assertIn("No preparing agent", out);
    assertIn("### Outline for your comment", e.body);
    // No CI or gates calls for a screened PR.
    assert.ok(!b.calls().some((c: string[]) => c.join(" ").includes("statusCheckRollup")));
    assert.ok(!exists(path.join(b.bank, "dossier", "5", "ci.txt")));
    assertIn("(screen fail: agentscan:automated-account, AgentScan caution, first contribution, "
      + "no disclosure)", b.runBank(["list"]).stdout);
    assertIn("SCREEN 5 ready fail:", b.runBank(["plan", "--all"]).stdout);
    const shown = b.runBank(["present"]).stdout;
    assertIn("(automation screen)", shown);
  });

  test("screen is unclear when a flagged pr discloses ai use", () => {
    const [, , sc] = b.prefetchScreen({ body: "This change was generated with Copilot.", ...FLAGGED });
    assert.equal(sc.result, "unclear");
    assert.equal(sc.why, "flagged by AgentScan; AI use disclosed");
    assert.equal(b.entry(5).lane, "screen");
  });

  test("screen entries do not use the banks room", () => {
    b.writeEntry(1, { state: "ready", lane: "screen" });
    b.cache("candidates.json", JSON.stringify({ 9: { title: "t", draft: false, state: "OPEN",
      updated: ago({ minutes: 1 }), head: A, author: "x", paths: ["lib/net.js"] } }));
    b.cache("queue.tsv", "9\tnet\t-\n");
    assertIn("PREPARE 9", b.runBank(["plan", "--target", "1"]).stdout);
  });

  test("a comment on a screen entry waits 48 hours for the author", () => {
    b.screenHold();
    const e = b.entry(5);
    assert.equal(e.state, "waiting");
    const w = Object.fromEntries(e.wait_for.split(",").map((t) => partition(t, "=")));
    assert.equal(w.author, "bot-ish");
    assert.equal(w.push, A.slice(0, 12));
    assertIn("screen", w);
    assert.equal(parseIsoZ(w.until) - parseIsoZ(e.wait_since), 48 * HOUR);
  });

  test("an author comment wakes a screen hold for a real review", () => {
    const mine = b.screenHold();
    const theirs = { author: { login: "bot-ish" }, createdAt: ago({ minutes: 1 }), body: "I wrote and tested it." };
    b.rules([b.syncRule(prNode(5, A, { author: "bot-ish", comments: [mine, theirs] }))]);
    b.runBank(["sync"]);
    const e = b.entry(5);
    assert.equal(e.state, "done");
    assert.equal(e.note, "woke: author responded: comment by @bot-ish");
    // The next prefetch skips the screen: the user asked for this review.
    const [, , sc] = b.prefetchScreen({ body: "No disclosure.", labels: ["agentscan:automated-account"] });
    assert.equal(sc.result, "pass");
    assert.deepEqual([b.entry(5).state, b.entry(5).lane], ["preparing", "fresh"]);
  });

  test("an author push wakes a screen hold", () => {
    const mine = b.screenHold();
    b.rules([b.syncRule(prNode(5, B, { author: "bot-ish", comments: [mine] }))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).note, `woke: author responded: new push ${B.slice(0, 12)}`);
  });

  test("no author response brings back a close recommendation", () => {
    const mine = b.screenHold();
    let e = b.entry(5);
    // Pretend the 48 hours passed.
    e.wait_for = pyReplace(e.wait_for, e.wait_for.split("until=")[1].split(",")[0], ago({ minutes: 1 }));
    const { body: _body, pr: _pr, ...fields } = e;
    b.writeEntry(5, fields);
    b.rules([b.syncRule(prNode(5, A, { author: "bot-ish", comments: [mine] }))]);
    b.runBank(["sync"]);
    e = b.entry(5);
    assert.deepEqual([e.state, e.lane], ["ready", "screen"]);
    assert.equal(e.note, "screen: no author response; recommend closing per the moderation policy");
    assertIn("Recommend closing it", e.body);
    // My earlier comment doesn't start another hold.
    b.rules([b.syncRule(prNode(5, A, { author: "bot-ish", comments: [mine] }))]);
    b.runBank(["sync"]);
    assert.equal(b.entry(5).state, "ready");
  });

  test("hold screen sets the author and 48 hours", () => {
    b.writeEntry(5, { state: "done", lane: "fresh", author: "bot-ish", disposition: "commented" });
    b.runBank(["hold", "5", "--screen", "asked", "for", "attestation"]);
    const e = b.entry(5);
    assert.equal(e.note, "screen: waiting for the author: asked for attestation");
    assertIn("author=bot-ish", e.wait_for);
    assertIn("screen", e.wait_for);
    assertIn("a comment by @bot-ish", b.runBank(["list"]).stdout);
  });

  // Backoff: dormant queue refreshes, failed refreshes, and quiet ticks.

  test("a full bank skips a stale queue refresh", () => {
    const env = { ...b.env, REFRESH_MINUTES: "120" };
    b.fillBank();
    b.cache("queue.stamp", ago({ hours: 3 }));
    writeText(b.queueOut, "5\thttp\t-\n");
    b.rules([b.queueRule([5]), b.syncRule(...[0, 1, 2, 3, 4, 5].map((i) => prNode(100 + i, A)))]);
    const out = b.runBank(["tick"], { env }).stdout;
    assertIn("dormant (bank full)", out);
    assertNotIn("files(first:100)", JSON.stringify(b.calls()));
    const queueTsv = path.join(b.bank, "cache", "queue.tsv");
    assertNotIn("5\thttp", exists(queueTsv) ? readText(queueTsv) : "");
  });

  test("no recent activity skips a stale queue refresh", () => {
    const env = { ...b.env, REFRESH_MINUTES: "120" };
    b.cache("queue.stamp", ago({ hours: 3 }));
    b.cache("activity.json", JSON.stringify({ at: ago({ hours: 5 }) }));
    writeText(b.queueOut, "5\thttp\t-\n");
    b.rules([b.queueRule([5])]);
    const out = b.runBank(["tick"], { env }).stdout;
    assertIn("dormant (no activity since", out);
    assertNotIn("files(first:100)", JSON.stringify(b.calls()));
  });

  test("recent activity and room refresh a stale queue", () => {
    const env = { ...b.env, REFRESH_MINUTES: "120" };
    b.cache("queue.stamp", ago({ hours: 3 }));
    b.cache("activity.json", JSON.stringify({ at: ago({ minutes: 30 }) }));
    writeText(b.queueOut, "5\thttp\t-\n");
    b.rules([b.queueRule([5])]);
    const out = b.runBank(["tick"], { env }).stdout;
    assertIn("team queue: 1 PRs", out);
  });

  test("a dormant bank still refreshes every six hours", () => {
    const env = { ...b.env, REFRESH_MINUTES: "120" };
    b.fillBank();
    b.cache("queue.stamp", ago({ hours: 7 }));
    writeText(b.queueOut, "5\thttp\t-\n");
    b.rules([b.queueRule([5]), b.syncRule(...[0, 1, 2, 3, 4, 5].map((i) => prNode(100 + i, A)))]);
    const out = b.runBank(["tick"], { env }).stdout;
    assertIn("team queue: 1 PRs", out);
    const stamp = readText(path.join(b.bank, "cache", "queue.stamp"));
    assert.ok(stamp > ago({ minutes: 5 }), `${JSON.stringify(stamp)} not greater than five minutes ago`);
  });

  test("a failed refresh backs off two four then eight hours", () => {
    writeText(b.queueOut, "5\thttp\t-\n");
    b.rules([{ match: ["graphql", "files(first:100)"], rc: 1, stderr: "HTTP 502: Bad Gateway", stdout: "" }]);
    let out = b.runBank(["tick"]).stdout;
    assert.match(out, /team queue: .*metadata FAILED.*HTTP 502.*failed 1 time\(s\) in a row, next try after/);
    const attempt = JSON.parse(readText(path.join(b.bank, "cache", "queue-attempt.json")));
    assert.equal(attempt.failures, 1);
    // The next tick doesn't retry, and says why.
    const calls = b.calls().length;
    out = b.runBank(["tick"]).stdout;
    assert.match(out, /team queue: last refresh failed 1 time\(s\) in a row \(.*HTTP 502.*\); next try after/);
    assert.equal(b.calls().slice(calls).filter((c) => JSON.stringify(c).includes("files(first:100)")).length, 0);
    // Each failure doubles the wait, capped at 8 hours.
    for (const [failures, hours] of [[1, 2], [2, 4], [3, 8], [5, 8]]) {
      let at = Date.now() - hours * HOUR + 5 * MINUTE;
      b.cache("queue-attempt.json", JSON.stringify({ at: iso(new Date(at)), failures, error: "x" }));
      assertIn("last refresh failed", b.runBank(["tick"]).stdout, `(${failures}, ${hours})`);
      at -= 10 * MINUTE;
      b.cache("queue-attempt.json", JSON.stringify({ at: iso(new Date(at)), failures, error: "x" }));
      assertNotIn("last refresh failed", b.runBank(["tick"]).stdout, `(${failures}, ${hours})`);
    }
  });

  test("a successful refresh clears the failure count", () => {
    b.cache("queue-attempt.json", JSON.stringify({ at: ago({ hours: 9 }), failures: 3, error: "x" }));
    writeText(b.queueOut, "5\thttp\t-\n");
    b.rules([b.queueRule([5])]);
    b.runBank(["tick"]);
    const attempt = JSON.parse(readText(path.join(b.bank, "cache", "queue-attempt.json")));
    assert.equal(attempt.failures, 0);
  });

  test("refresh forces a refresh during failure backoff", () => {
    b.cache("queue-attempt.json", JSON.stringify({ at: ago({ minutes: 5 }), failures: 1, error: "x" }));
    writeText(b.queueOut, "5\thttp\t-\n");
    b.rules([b.queueRule([5])]);
    assertIn("team queue: 1 PRs", b.runBank(["tick", "--refresh"]).stdout);
  });

  test("graphql keeps the message of a failure without an errors list", () => {
    writeText(b.queueOut, "5\thttp\t-\n");
    b.rules([{ match: ["graphql", "files(first:100)"], rc: 1, stdout: {
      message: "You have exceeded a secondary rate limit.", documentation_url: "x" } }]);
    const out = b.runBank(["tick", "--refresh"]).stdout;
    assertIn("secondary rate limit", out);
  });

  test("quiet ticks back off doubling up to four hours", () => {
    const env = b.backoffEnv();
    let out = b.quietTick(env);
    assertIn("tick: quiet (1 in a row); next tick on the normal cadence", out);
    assert.equal(b.tickState().next_due, null);
    const expect: Record<number, number> = { 2: 40, 3: 80, 4: 160, 5: 240, 6: 240 };
    for (let q = 2; q < 7; q++) {
      const st = b.tickState();
      st.next_due = null; // pretend the wait passed
      b.cache("tick.json", JSON.stringify(st));
      out = b.quietTick(env);
      assertIn(`tick: quiet (${q} in a row); backing off, next real tick at`, out);
      const due = new Date(b.tickState().next_due).getTime();
      const minutes = (due - Date.now()) / MINUTE;
      assert.ok(Math.abs(minutes - (expect[q] - 2)) <= 1.5, `${minutes} != ${expect[q] - 2} within 1.5 delta: ${q}`);
    }
  });

  test("a backed off tick makes no gh call and says when", () => {
    const env = { ...b.backoffEnv() };
    delete env.ME; // me() would call gh api user
    b.cache("tick.json", JSON.stringify({ quiet: 3, next_due: ago({ minutes: -60 }) }));
    const out = b.runBank(["tick"], { env }).stdout;
    assert.match(out, /^tick .*: backed off after 3 quiet ticks in a row; next real tick at /);
    assert.equal(splitlines(out.trim()).length, 1);
    assert.deepEqual(b.calls(), []);
  });

  test("tick now bypasses the backoff", () => {
    const env = b.backoffEnv();
    b.cache("tick.json", JSON.stringify({ quiet: 3, next_due: ago({ minutes: -60 }) }));
    const out = b.quietTick(env, "--now");
    assertIn("plan:", out);
    assert.equal(b.tickState().quiet, 4);
  });

  test("a change resets the tick backoff", () => {
    const env = b.backoffEnv();
    b.cache("tick.json", JSON.stringify({ quiet: 4, next_due: null }));
    b.writeEntry(5, { state: "ready" });
    b.rules([b.syncRule(prNode(5, A, { state: "CLOSED", closed_at: ago({ minutes: 1 }) }))]);
    const out = b.quietTick(env);
    assertIn("tick: changes this tick", out);
    assert.deepEqual(b.tickState(), { quiet: 0, next_due: null, last: b.tickState().last });
  });

  test("a prepare line counts as a change", () => {
    const env = b.backoffEnv();
    b.cache("tick.json", JSON.stringify({ quiet: 2, next_due: null }));
    writeText(b.rereviewOut, `RE-REVIEW\t5\tAPPROVED\t${A}\t${A}\t${B}\t1\tMERGEABLE\t${ago({ minutes: 1 })}\n`);
    const out = b.quietTick(env);
    assertIn("PREPARE 5", out);
    assert.equal(b.tickState().quiet, 0);
  });

  test("user commands reset the tick backoff and count as activity", async () => {
    const env = b.backoffEnv();
    const cmds = [["sync"], ["present"], ["put", "5", "x", "--head", A], ["prefetch", "5"]];
    await subTests(cmds, (cmd) => `cmd=${cmd[0]}`, (cmd) => {
      b.cache("tick.json", JSON.stringify({ quiet: 4, next_due: ago({ minutes: -60 }) }));
      fs.rmSync(path.join(b.bank, "cache", "activity.json"), { force: true });
      b.runBank(cmd, { env, check: false });
      assert.equal(b.tickState().quiet, 0, String(cmd));
      assert.equal(b.tickState().next_due, null, String(cmd));
      assertIn("at", JSON.parse(readText(path.join(b.bank, "cache", "activity.json"))));
    });
  });
});
