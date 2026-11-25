// prefetch: everything a preparing agent needs, in dossier/<pr>/, so it
// never calls gh itself.
import fs from "node:fs";
import path from "node:path";
import {
  ARCHIVE, BANK_METADATA, CACHE, CLONE, DOSSIER, ENV, LOCKS, METADATA_TIMEOUT, NAME, NC, OWNER, REPO, RQ,
} from "./config.ts";
import { type Entry, entryPath, finish, load, newEntry, parsePr, save } from "./entry.ts";
import { writeGates } from "./gates.ts";
import { gh } from "./github.ts";
import { entryLock, unlock, zshFlock } from "./lock.ts";
import { type Candidate, rankedCandidates } from "./queue.ts";
import { type Discussion, type PrInfo, type Screen, screen, screenBody, screenLine } from "./screen.ts";
import {
  CommandError, DAY, MINUTE, die, git, isDir, isSystemError, iso, lines, now, print, readText, removeTree, run,
  stderrTail, writeAtomic, writeText,
} from "./util.ts";

const PR_FIELDS = "number,title,body,author,baseRefName,headRefOid,reviewDecision,labels,mergeable," +
  "mergeStateStatus,files,commits,createdAt,updatedAt,isDraft,state";

// Finish the entry for a PR prefetch won't prepare, creating one if
// needed. Its updated_at comes from GitHub, so skipReason prefers it over
// an older cached candidate.
function refused(pr: string, info: PrInfo, disposition: string): void {
  using lock = entryLock(pr).enter();
  const e = load(pr) ?? newEntry(pr, {
    url: `https://github.com/${REPO}/pull/${pr}`, lane: "fresh", head: info.headRefOid || "-",
    created_at: iso(now()), disposition: "-",
  });
  e.title = info.title || e.title || "-";
  e.author = info.author?.login || e.author || "-";
  e.pr_head = info.headRefOid || e.pr_head || "-";
  e.updated_at = info.updatedAt || iso(now());
  finish(e, disposition);
}

// The new dossier and ref replace the old ones only after the fetched head
// matches GitHub's, so a failed prefetch leaves an earlier one intact.
export function prefetch(prArg: string): void {
  const pr = parsePr(prArg);
  const prJson = gh("pr", "view", pr, "--repo", REPO, "--json", PR_FIELDS);
  const info: PrInfo = JSON.parse(prJson);
  if (info.state !== "OPEN" || info.isDraft) {
    // The cached candidate can be up to REFRESH_MINUTES old, and longer
    // while the refresh is dormant. Record what GitHub said, so plan
    // stops offering the PR until the cache catches up.
    const disposition = info.state === "OPEN" ? "draft" : (info.state ?? "?").toLowerCase();
    refused(pr, info, disposition);
    die(`${pr} is ${disposition === "draft" ? "a draft" : disposition}; not preparing it`, 4);
  }

  fetchUpstream();
  const tmpRef = `refs/review-bank/tmp/${pr}-${process.pid}`;
  git(["fetch", "-q", "--no-write-fetch-head", "upstream", `+pull/${pr}/head:${tmpRef}`]);
  const head = git(["rev-parse", tmpRef]).trim();
  if (head !== info.headRefOid) {
    git(["update-ref", "-d", tmpRef], { check: false });
    die(`${pr}: fetched ${head.slice(0, 12)} but GitHub says head is ${info.headRefOid.slice(0, 12)}; rerun`);
  }

  const old = load(pr);
  const cand = rankedCandidates().find((c) => c.pr === pr);
  const lane = cand?.lane || old?.lane || "fresh";
  const rereviewFrom = cand?.rereview_from || (old?.rereview_from ?? null);
  if (rereviewFrom && rereviewFrom !== "-" && run(["git", "-C", CLONE, "cat-file", "-e", `${rereviewFrom}^{commit}`],
    { stdout: "inherit", stderr: "ignore" }).status !== 0) {
    // A force-push can leave the reviewed commit unreachable from the PR.
    git(["fetch", "-q", "--no-write-fetch-head", "upstream", rereviewFrom], { check: false });
  }

  const newDir = fs.mkdtempSync(path.join(DOSSIER, `.${pr}.`));
  try {
    swapIn({ pr, newDir, tmpRef, prJson, info, head, lane, rereviewFrom, cand });
  } finally {
    removeTree(newDir);
    git(["update-ref", "-d", tmpRef], { check: false });
  }
}

type Fetched = {
  pr: string;
  newDir: string;
  tmpRef: string;
  prJson: string;
  info: PrInfo;
  head: string;
  lane: string;
  rereviewFrom: string | null;
  cand: Candidate | undefined;
};

// Build the dossier in newDir, then move it, the entry, and the ref into place.
function swapIn({ pr, newDir, tmpRef, prJson, info, head, lane, rereviewFrom, cand }: Fetched): void {
  writeText(path.join(newDir, "pr.json"), prJson);
  writeText(path.join(newDir, "diff.patch"), gh("pr", "diff", pr, "--repo", REPO));
  const disc = discussion(pr);
  writeText(path.join(newDir, "discussion.json"), JSON.stringify(disc, null, 1));
  let sc: Screen = screen(info, disc);
  if (sc.result !== "pass" && load(pr)?.note.includes("author responded")) {
    // Woken from a screen hold by the author: the user asked for this review.
    sc = { ...sc, result: "pass", why: `the author responded after the screen hold (${sc.result} before)` };
  }
  writeText(path.join(newDir, "screen.json"), JSON.stringify(sc, null, 1));
  const screened = sc.result !== "pass";
  let ci = "", gates = "";
  if (!screened) {
    // A screened PR gets no review, so skip the CI and gates calls.
    const r = run([path.join(NC, "ci-status.sh"), pr], { env: ENV, stderr: "stdout" });
    ci = r.stdout;
    writeText(path.join(newDir, "ci.txt"), `${r.stdout}(ci-status.sh exit ${r.status}, ${iso(now())})\n`);
    const files = (info.files ?? []).map((f) => f.path);
    gates = writeGates(pr, newDir, info.baseRefName || "main", files, head, tmpRef);
  }
  writeText(path.join(newDir, "release-lines.txt"), activeLines());
  if (!screened && (BANK_METADATA === "all" || (BANK_METADATA === "cq" && lane === "cq"))) {
    // After the gh calls: git node metadata calls GitHub and Jenkins itself.
    writeText(path.join(newDir, "metadata.txt"), ncuMetadata(pr));
  }
  if (lane === "screen" && !screened) lane = "fresh";
  writeText(path.join(newDir, "meta.json"), JSON.stringify({
    pr, head, ref: `refs/review-bank/${pr}`, lane, rereview_from: rereviewFrom, clone: CLONE, fetched_at: iso(now()),
  }, null, 1));
  // The diff, discussion, and CI were read after the fetch. A push in
  // between would mix two heads in one dossier.
  const nowHead = gh("pr", "view", pr, "--repo", REPO, "--json", "headRefOid", "--jq", ".headRefOid").trim();
  if (nowHead !== head) die(`${pr}: head moved to ${nowHead.slice(0, 12)} while fetching; rerun`);

  // Order: dossier into place, entry saved, then the ref, then the old
  // dossier removed. A failure part way leaves the old dossier beside the
  // new one, never a ref or entry that points at a missing dossier.
  const d = path.join(DOSSIER, pr);
  {
    using lock = entryLock(pr).enter();
    const gone = path.join(DOSSIER, `.${pr}.old-${process.pid}`);
    if (fs.existsSync(d)) fs.renameSync(d, gone);
    fs.renameSync(newDir, d);
    let e: Entry | null = load(pr);
    const restart = e === null || ["done", "stale", "waiting"].includes(e.state);
    if (e && restart && e.body.trim()) {
      // Keep the earlier review for reference; the new one starts clean.
      writeText(path.join(ARCHIVE, `${pr}-${e.head.slice(0, 12)}.md`), readText(entryPath(pr)));
    }
    if (restart) e = newEntry(pr, { created_at: iso(now()), disposition: "-", my_teams: e?.my_teams ?? "-" });
    Object.assign(e!, {
      url: `https://github.com/${REPO}/pull/${pr}`, title: info.title, author: info.author?.login || "ghost",
      state: "preparing", head, pr_head: head, updated_at: info.updatedAt, lease: iso(now()), lane,
      my_teams: cand?.my_teams || e!.my_teams, rereview_from: rereviewFrom ?? "-", screen: screenLine(sc),
    });
    if (screened) {
      // No preparing agent: the screen entry is ready for the user as is.
      Object.assign(e!, {
        state: "ready", lane: "screen", lease: "-", body: screenBody(pr, info, sc),
        prepared_at: iso(now()), needs_run: "0", note: `screen ${screenLine(sc)}`,
      });
    }
    save(e!);
    git(["update-ref", `refs/review-bank/${pr}`, tmpRef]);
    removeTree(gone);
  }
  if (screened) {
    print(`${pr}: dossier ${d}\n  ref refs/review-bank/${pr} = ${head.slice(0, 12)}, lane screen, state ready`);
    print(`  screen ${screenLine(sc)}: ${sc.why}. No preparing agent; present it to the user.`);
    return;
  }
  print(`${pr}: dossier ${d}\n  ref refs/review-bank/${pr} = ${head.slice(0, 12)}, lane ${lane}, state preparing`);
  print(`  screen ${screenLine(sc)}`);
  print(ci.trim() ? `  ${lines(ci.trim())[0]}` : "  ci: no output");
  print(`  gates: ${gates}`);
}

// nodejs-review-queue's discussion.sh --json: comments, reviews, and
// inline threads, without hidden or blocked-user content.
function discussion(pr: string): Discussion {
  const r = run(["zsh", path.join(RQ, "discussion.sh"), "--json", pr], { env: ENV });
  if (r.status !== 0) throw new CommandError(`discussion.sh ${pr}: ${stderrTail(r)}`);
  const d: Discussion = JSON.parse(r.stdout);
  d.fetched_at = iso(now());
  d.rules = "excluded items are not credited and don't count as already raised; " +
    "status resolved-context means hidden as outdated, duplicate, or resolved";
  return d;
}

// git node metadata (node-core-utils), read-only: approvals by name, the
// last Jenkins CI, failed GitHub Actions jobs, and the generated commit
// metadata. It calls GitHub with its own token, not gh, so it holds the gh
// shim's lock to stay serial with every gh call. The shim locks with
// zsystem flock, an fcntl lock, the same kind every lock here takes.
// Never throws for the command itself: a failure is written to the file.
function ncuMetadata(pr: string): string {
  const lockFile = path.normalize(process.env.GH_SHIM_LOCK || path.join(LOCKS, "gh.lock"));
  const held = zshFlock(lockFile, true);
  if (!held) throw new Error(`could not lock ${lockFile}`);
  let out = "", err = "", status: string;
  try {
    try {
      const r = run(["git", "node", "metadata", pr, "--owner", OWNER, "--repo", NAME],
        { cwd: isDir(CLONE) ? CLONE : undefined, env: ENV, timeout: METADATA_TIMEOUT });
      [out, err] = [r.stdout, r.stderr];
      status = r.timedOut ? `timed out after ${METADATA_TIMEOUT}s` : `exit ${r.status}`;
    } catch (e) {
      if (!isSystemError(e)) throw e;
      [err, status] = [e.message, "could not run"];
    }
    // The shim's GH_MIN_GAP counts from this.
    writeText(`${lockFile}.last`, `${(performance.timeOrigin + performance.now()) / 1000}\n`);
  } finally {
    unlock(held);
  }
  // The report goes to stderr and the generated metadata to stdout, which
  // the report already repeats.
  let text = out.trim() && err.includes(out.trim()) ? err : err + out;
  text = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
  const kept = lines(text).filter((l) => !/^\s*[⠀-⣿]/.test(l)); // spinner frames
  return `${kept.join("\n")}\n(git node metadata ${status}, ${iso(now())})\n`;
}

// main and the staging branches, at most every 30 minutes.
function fetchUpstream(): void {
  const stamp = path.join(CACHE, "fetch.stamp");
  if (fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < 30 * MINUTE) return;
  git(["fetch", "-q", "--no-write-fetch-head", "upstream", "+refs/heads/main:refs/remotes/upstream/main",
    "+refs/heads/v*-staging:refs/remotes/upstream/v*-staging"]);
  writeText(stamp, iso(now()));
}

// Active release lines (nodejs-contribute, Release-line labels), cached a day.
function activeLines(): string {
  const p = path.join(CACHE, "release-lines.txt");
  if (fs.existsSync(p) && Date.now() - fs.statSync(p).mtimeMs < DAY) return readText(p);
  const content = gh("api", "repos/nodejs/Release/contents/schedule.json", "--jq", ".content");
  const schedule: Record<string, { start?: string; end?: string }> = JSON.parse(Buffer.from(content, "base64").toString("utf8"));
  const today = iso(now()).slice(0, 10);
  const active = Object.entries(schedule)
    .filter(([, v]) => (v.start ?? "9") <= today && today <= (v.end ?? "0")).map(([k]) => k);
  writeAtomic(p, `active release lines on ${today}: ${active.join(" ")}\n`);
  return readText(p);
}
