#!/usr/bin/env python3
"""nodejs-review-bank: a bank of prepared nodejs/node reviews on disk.

Deterministic parts of the skill. Every gh call goes through gh-retry.sh
(backoff) and the bin/gh shim (one gh call at a time across processes).
Read-only on GitHub: nothing here posts, labels, or reviews.

  bank.py tick [--refresh] [--target N]   refresh candidates, sync, prune, plan
  bank.py sync [PR...]                    re-read bank entries from GitHub, prune
  bank.py plan [--target N] [--all]       what to prepare next, in priority order
  bank.py list [--all]                    the bank, by priority
  bank.py show <pr>                       one entry
  bank.py present                         mark the top ready entry presented, show it
  bank.py prefetch <pr>                   fetch the PR's dossier and claim the entry
  bank.py discussion <pr>                 comments, reviews, and threads minus hidden and blocked-user content
  bank.py put <pr> <summary.md>           bank a verified summary (ready or needs-run)
  bank.py set <pr> key=value...           edit entry fields (state=done disposition=skipped)
  bank.py slot status|acquire <slot|any> <pr> [owner]|release <slot> [--force]

Env: NODE_REVIEW_BANK (bank dir), NODE_CLONE (default ~/dev/nodejs/node),
REPO, ME, BANK_TARGET (default 6), REFRESH_MINUTES (default 120),
LEASE_MINUTES (default 120), RQ_SCRIPTS and NC_SCRIPTS (sibling skills' scripts).
"""
import base64, json, os, re, shutil, subprocess, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RQ = Path(os.environ.get("RQ_SCRIPTS", HERE / "../../nodejs-review-queue/scripts")).resolve()
NC = Path(os.environ.get("NC_SCRIPTS", HERE / "../../nodejs-contribute/scripts")).resolve()
STATE_HOME = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
BANK = Path(os.environ.get("NODE_REVIEW_BANK") or Path(STATE_HOME) / "nodejs-review-bank")
CLONE = Path(os.environ.get("NODE_CLONE") or os.path.expanduser("~/dev/nodejs/node"))
REPO = os.environ.get("REPO", "nodejs/node")
OWNER, NAME = REPO.split("/")
TARGET = int(os.environ.get("BANK_TARGET", "6"))
REFRESH_MIN = int(os.environ.get("REFRESH_MINUTES", "120"))
LEASE_MIN = int(os.environ.get("LEASE_MINUTES", "120"))

PRS, DOSSIER, CACHE, LOCKS, ARCHIVE = (BANK / d for d in ("prs", "dossier", "cache", "locks", "archive"))
for d in (PRS, DOSSIER, CACHE, LOCKS, ARCHIVE):
    d.mkdir(parents=True, exist_ok=True)

ENV = dict(os.environ, NODE_REVIEW_BANK=str(BANK), PATH=f"{HERE / 'bin'}:{os.environ['PATH']}")

LANES = ["rereview-asap", "rereview", "cq", "fresh", "fresh-checked", "skip"]
LANE_OF_BUCKET = {"RE-REVIEW-ASAP": "rereview-asap", "RE-REVIEW": "rereview", "CQ-CANDIDATE": "cq"}
STATES = ["presented", "ready", "needs-run", "stale", "preparing", "done"]
ACTIVE = {"preparing", "needs-run", "ready", "stale"}
# Dispositions the user chose. A done entry with one of these and an unchanged
# head is not prepared again. Automatic ones (closed, draft) don't block.
USER_DISPOSITIONS = ("approved", "changes-requested", "commented", "labeled", "unlabeled", "skipped")
FIELDS = ["pr", "url", "title", "author", "lane", "state", "head", "pr_head", "created_at",
          "prepared_at", "presented_at", "updated_at", "my_teams", "rereview_from",
          "needs_run", "disposition", "disposition_at", "snooze_until", "lease", "note"]
SKIP_PATHS = re.compile(r"^(lib/inspector\.js|lib/internal/inspector/|src/inspector/|"
                        r"lib/diagnostics_channel\.js|lib/internal/diagnostics_channel|"
                        r"src/node_diagnostics_channel)")


def now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    if not s or s == "-":
        return None
    return datetime.fromisoformat(s.strip().replace("Z", "+00:00"))


def die(msg, code=1):
    print(f"bank: {msg}", file=sys.stderr)
    sys.exit(code)


ME = os.environ.get("ME")


def me():
    global ME
    if not ME:
        ME = subprocess.run(["gh", "api", "user", "--jq", ".login"], env=ENV, text=True,
                            stdout=subprocess.PIPE, check=True).stdout.strip()
    ENV["ME"] = ME
    return ME


def gh(*args, check=True):
    """One gh call through gh_retry and the serializing shim."""
    p = subprocess.run([str(HERE / "gh-retry.sh"), *args], env=ENV, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}: {p.stderr.strip()[-300:]}")
    return p.stdout


def graphql(query):
    qf = CACHE / f"query-{os.getpid()}.graphql"
    qf.write_text(query)
    try:
        data = json.loads(gh("api", "graphql", "-F", f"query=@{qf}"))
    finally:
        qf.unlink(missing_ok=True)
    # A deleted PR comes back as a null alias plus a NOT_FOUND error.
    errs = [e for e in data.get("errors") or [] if e.get("type") != "NOT_FOUND"]
    if errs or not data.get("data"):
        raise RuntimeError(f"graphql: {(errs or [{}])[0].get('message')}")
    return data["data"]["repository"]


def git(*args, check=True):
    p = subprocess.run(["git", "-C", str(CLONE), *args], text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:3])}: {p.stderr.strip()[-300:]}")
    return p.stdout


# ---------------------------------------------------------------- entries

def entry_path(n):
    return PRS / f"{n}.md"


def load(n):
    p = entry_path(n)
    if not p.exists():
        return None
    text = p.read_text()
    m = re.match(r"---\n(.*?)\n---\n?(.*)", text, re.S)
    if not m:
        die(f"{p} has no front matter")
    meta = {}
    for line in m.group(1).splitlines():
        k, _, v = line.partition(": ")
        meta[k.strip()] = v.strip()
    meta["body"] = m.group(2)
    return meta


def save(e):
    head = "\n".join(f"{k}: {e.get(k) or '-'}" for k in FIELDS)
    tmp = entry_path(e["pr"]).with_suffix(".tmp")
    tmp.write_text(f"---\n{head}\n---\n{e.get('body', '')}")
    tmp.replace(entry_path(e["pr"]))


def entries():
    out = []
    for p in sorted(PRS.glob("*.md")):
        e = load(p.stem)
        if e:
            out.append(e)
    return out


def rank(e):
    snoozed = (parse_iso(e.get("snooze_until")) or now()) > now()
    lane = LANES.index(e["lane"]) if e.get("lane") in LANES else len(LANES)
    upd = -(parse_iso(e.get("updated_at")) or datetime.fromtimestamp(0, timezone.utc)).timestamp()
    return (snoozed, lane, upd)


def finish(e, disposition, when=None):
    """Move an entry to done and drop its dossier and fetched ref."""
    e["state"] = "done"
    e["disposition"] = disposition
    e["disposition_at"] = when or iso(now())
    e["lease"] = "-"
    shutil.rmtree(DOSSIER / str(e["pr"]), ignore_errors=True)
    git("update-ref", "-d", f"refs/review-bank/{e['pr']}", check=False)


# ---------------------------------------------------------------- locks

class Lock:
    """mkdir lock. A holder whose pid is gone, or past max_age, is replaced."""

    def __init__(self, name, max_age=None):
        self.path = LOCKS / name
        self.max_age = max_age

    def holder(self):
        try:
            return json.loads((self.path / "owner.json").read_text())
        except (OSError, ValueError):
            return None

    def acquire(self, info, wait=False):
        while True:
            try:
                self.path.mkdir()
                (self.path / "owner.json").write_text(json.dumps(info))
                return True
            except FileExistsError:
                h = self.holder() or {}
                pid = h.get("pid")
                dead = pid and not pid_alive(pid)
                old = self.max_age and (now() - (parse_iso(h.get("at")) or now())).total_seconds() > self.max_age
                if dead or old:
                    self.release()
                    continue
                if not wait:
                    return False
                time.sleep(2)

    def release(self):
        (self.path / "owner.json").unlink(missing_ok=True)
        try:
            self.path.rmdir()
        except OSError:
            pass


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


# ---------------------------------------------------------------- candidates

def read_tsv(name):
    p = CACHE / name
    if not p.exists():
        return []
    return [l.split("\t") for l in p.read_text().splitlines() if l.strip()]


def refresh_queue():
    """Team-routed queue via build-queue.sh. On INCOMPLETE, keep the old rows
    and add the new ones, so a partial run never shrinks the queue."""
    out = CACHE / "queue.tsv"
    p = subprocess.run(["zsh", str(RQ / "build-queue.sh")], env=ENV, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (CACHE / "queue.log").write_text(p.stderr)
    rows = {l.split("\t")[0]: l for l in p.stdout.splitlines() if l.strip()}
    if p.returncode != 0:
        old = {r[0]: "\t".join(r) for r in read_tsv("queue.tsv")}
        old.update(rows)
        rows = old
        status = "INCOMPLETE (" + (p.stderr.strip().splitlines() or ["?"])[-1] + "); kept previous rows"
    else:
        status = f"{len(rows)} PRs"
        (CACHE / "queue.stamp").write_text(iso(now()))
    out.write_text("".join(f"{l}\n" for l in rows.values()))
    fetch_meta([int(n) for n in rows])
    return status


def fetch_meta(nums):
    """Title, author, draft, state, head, updatedAt, and paths for ranking."""
    meta = {}
    for i in range(0, len(nums), 40):
        fields = " ".join(
            f"p{n}: pullRequest(number:{n}){{number title isDraft state updatedAt headRefOid "
            f"author{{login}} files(first:100){{nodes{{path}}}}}}" for n in nums[i:i + 40])
        repo = graphql(f'query{{repository(owner:"{OWNER}",name:"{NAME}"){{{fields}}}}}')
        for d in repo.values():
            if d:
                meta[str(d["number"])] = {
                    "title": d["title"], "draft": d["isDraft"], "state": d["state"],
                    "updated": d["updatedAt"], "head": d["headRefOid"],
                    "author": (d.get("author") or {}).get("login", "ghost"),
                    "paths": [f["path"] for f in d["files"]["nodes"]]}
        time.sleep(2)
    (CACHE / "candidates.json").write_text(json.dumps(meta))


def refresh_rereview():
    p = subprocess.run(["python3", str(RQ / "rereview.py"), "--tsv"], env=ENV, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        return "FAILED (" + (p.stderr.strip().splitlines() or ["?"])[-1][:120] + "); kept previous rows"
    (CACHE / "rereview.tsv").write_text(p.stdout)
    return f"{len(p.stdout.splitlines())} reviewed PRs"


def is_skip(title, paths):
    prefix = title.split(":", 1)[0] if ":" in title else ""
    if re.search(r"\b(inspector|diagnostics_channel)\b", prefix):
        return True
    code = [p for p in paths if not p.startswith(("test/", "doc/"))]
    return bool(code) and all(SKIP_PATHS.match(p) for p in code)


def ranked_candidates():
    """All candidates as dicts with lane, newest update first within a lane."""
    meta = json.loads((CACHE / "candidates.json").read_text()) if (CACHE / "candidates.json").exists() else {}
    rr = {r[1]: r for r in read_tsv("rereview.tsv")}
    out = {}
    for r in rr.values():
        bucket, n, _, _, last, head, approvals, mergeable, updated = r
        if bucket in LANE_OF_BUCKET:
            out[n] = dict(pr=n, lane=LANE_OF_BUCKET[bucket], head=head, updated=updated,
                          rereview_from=r[3], note=f"approvals={approvals} {mergeable}")
    for r in read_tsv("queue.tsv"):
        n, todo, done = r[0], r[1], r[2] if len(r) > 2 else "-"
        m = meta.get(n)
        if n in out or not m or m["draft"] or m["state"] != "OPEN" or m["author"] == me():
            continue
        if n in rr:
            # Reviewed before: the re-review lane owns it, unless my only
            # reviews were comments on an older head.
            bucket, last = rr[n][0], rr[n][4]
            if bucket != "NONE" or last == m["head"]:
                continue
        lane = "skip" if is_skip(m["title"], m["paths"]) else ("fresh" if todo != "-" else "fresh-checked")
        teams = ", ".join([f"{t} (unchecked)" for t in todo.split(",") if t != "-"] +
                          [f"{t} (checked)" for t in done.split(",") if t != "-"])
        out[n] = dict(pr=n, lane=lane, head=m["head"], updated=m["updated"], title=m["title"],
                      author=m["author"], my_teams=teams)
    return sorted(out.values(), key=lambda c: (LANES.index(c["lane"]), -parse_iso(c["updated"]).timestamp()))


def plan(target=TARGET, show_all=False):
    bank = {e["pr"]: e for e in entries()}
    active = [e for e in bank.values() if e["state"] in ACTIVE - {"stale"}]
    lines = [f"PREPARE {e['pr']} lane={e['lane']} (stale: re-prepare)"
             for e in sorted(bank.values(), key=rank) if e["state"] == "stale"]
    room = max(0, target - len(active) - len(lines))
    fresh = []
    for c in ranked_candidates():
        e = bank.get(c["pr"])
        if e and e["state"] != "done":
            continue
        if e and e["disposition"].startswith(USER_DISPOSITIONS) and e.get("pr_head") == c["head"]:
            continue
        fresh.append(c)
    for c in (fresh if show_all else fresh[:room]):
        lines.append(f"PREPARE {c['pr']} lane={c['lane']} updated={c['updated'][:10]}"
                     + (f"  {c.get('title', '')[:60]}" if c.get("title") else ""))
    return lines, len(fresh)


# ---------------------------------------------------------------- sync

SYNC_FIELDS = (
    "number title state isDraft updatedAt headRefOid author{login} "
    "labels(first:50){nodes{name}} "
    "reviews(last:30,author:\"%s\"){nodes{state submittedAt commit{oid}}} "
    "comments(last:30){nodes{author{__typename login} createdAt}} "
    "timelineItems(last:50,itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){nodes{__typename "
    "...on LabeledEvent{createdAt actor{login} label{name}} "
    "...on UnlabeledEvent{createdAt actor{login} label{name}}}}")


def sync(only=None):
    bank = [e for e in entries() if e["state"] != "done" and (not only or e["pr"] in only)]
    if not bank:
        return ["sync: no open entries"]
    rr = {r[1]: r for r in read_tsv("rereview.tsv")}
    data = {}
    nums = [e["pr"] for e in bank]
    for i in range(0, len(nums), 20):
        fields = " ".join(f"p{n}: pullRequest(number:{n}){{{SYNC_FIELDS % me()}}}" for n in nums[i:i + 20])
        data.update({str(d["number"]): d for d in graphql(
            f'query{{repository(owner:"{OWNER}",name:"{NAME}"){{{fields}}}}}').values() if d})
    log = []
    for e in bank:
        d = data.get(e["pr"])
        if not d:
            log.append(f"  {e['pr']}: not found on GitHub")
            continue
        n = e["pr"]
        e["title"], e["updated_at"], e["pr_head"] = d["title"], d["updatedAt"], d["headRefOid"]
        if n in rr and rr[n][0] in LANE_OF_BUCKET:
            e["lane"] = LANE_OF_BUCKET[rr[n][0]]
        author = (d.get("author") or {}).get("login")
        if author == me():
            finish(e, "mine"); log.append(f"  {n}: authored by me, dropped")
        elif d["state"] == "MERGED":
            finish(e, "merged"); log.append(f"  {n}: merged")
        elif d["state"] == "CLOSED":
            # nodejs lands with commit-queue, so a landed PR shows as closed.
            finish(e, "closed"); log.append(f"  {n}: closed (usually landed)")
        elif d["isDraft"]:
            finish(e, "draft"); log.append(f"  {n}: converted to draft")
        else:
            acted = my_actions(d, parse_iso(e.get("created_at")) or now())
            labels = {l["name"] for l in d["labels"]["nodes"]}
            if acted:
                finish(e, acted[0], acted[1]); log.append(f"  {n}: {acted[0]}")
            elif e["lane"] == "cq" and any(l.startswith("commit-queue") for l in labels):
                finish(e, "cq-labeled"); log.append(f"  {n}: commit-queue added by someone else")
            elif e["state"] in ("ready", "needs-run", "presented") and e["head"] != d["headRefOid"]:
                e["note"] = f"head moved from {e['head'][:12]} while {e['state']}"
                e["state"] = "stale"; log.append(f"  {n}: stale, {e['note']}")
            elif e["state"] == "preparing" and (now() - (parse_iso(e.get("lease")) or now())).total_seconds() > LEASE_MIN * 60:
                e["state"] = "stale"; e["note"] = "preparation abandoned (lease expired)"
                log.append(f"  {n}: {e['note']}")
        save(e)
    return log or ["sync: no changes"]


def my_actions(d, since):
    """My reviews, label changes, and comments since `since`, as one
    disposition string and the time of the latest, or None."""
    acts = []
    for r in d["reviews"]["nodes"]:
        t = parse_iso(r["submittedAt"])
        if t and t > since:
            acts.append((t, f"{r['state'].lower().replace('_', '-')} @{((r.get('commit') or {}).get('oid') or '?')[:12]}"))
    for ev in d["timelineItems"]["nodes"]:
        if (ev.get("actor") or {}).get("login") == me() and parse_iso(ev["createdAt"]) > since:
            verb = "labeled" if ev["__typename"] == "LabeledEvent" else "unlabeled"
            acts.append((parse_iso(ev["createdAt"]), f"{verb} {ev['label']['name']}"))
    for c in d["comments"]["nodes"]:
        if (c.get("author") or {}).get("login") == me() and parse_iso(c["createdAt"]) > since:
            acts.append((parse_iso(c["createdAt"]), "commented"))
    if not acts:
        return None
    acts.sort()
    # Lead with the review, if any: "approved @<sha>; labeled request-ci".
    order = sorted(acts, key=lambda a: " @" not in a[1])
    return "; ".join(dict.fromkeys(a[1] for a in order)), iso(acts[-1][0])


# ---------------------------------------------------------------- prefetch

def prefetch(n):
    """Everything a preparing agent needs, so it never calls gh itself."""
    n = str(int(n))
    d = DOSSIER / n
    d.mkdir(exist_ok=True)
    pr = gh("pr", "view", n, "--repo", REPO, "--json",
            "number,title,body,author,baseRefName,headRefOid,reviewDecision,labels,mergeable,"
            "mergeStateStatus,files,commits,createdAt,updatedAt,isDraft,state")
    (d / "pr.json").write_text(pr)
    info = json.loads(pr)
    (d / "diff.patch").write_text(gh("pr", "diff", n, "--repo", REPO))
    # Discussion only through the filter, never raw (`gh pr view --json
    # comments,reviews` and REST lack the minimized fields).
    (d / "discussion.json").write_text(json.dumps(discussion(n), indent=1))
    ci = subprocess.run([str(NC / "ci-status.sh"), n], env=ENV, text=True,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (d / "ci.txt").write_text(f"{ci.stdout}(ci-status.sh exit {ci.returncode}, {iso(now())})\n")
    (d / "release-lines.txt").write_text(active_lines())

    fetch_upstream()
    git("fetch", "-q", "--no-write-fetch-head", "upstream", f"+pull/{n}/head:refs/review-bank/{n}")
    head = git("rev-parse", f"refs/review-bank/{n}").strip()
    if head != info["headRefOid"]:
        die(f"{n}: fetched {head[:12]} but GitHub says head is {info['headRefOid'][:12]}; rerun")

    e = load(n) or {"pr": n, "created_at": iso(now()), "disposition": "-"}
    if e.get("state") == "done":
        ARCHIVE.joinpath(f"{n}-{e.get('head', '-')[:12]}.md").write_text(entry_path(n).read_text())
        e = {"pr": n, "created_at": iso(now()), "disposition": "-"}
    cand = {c["pr"]: c for c in ranked_candidates()}.get(n, {})
    e.update(url=f"https://github.com/{REPO}/pull/{n}", title=info["title"],
             author=info["author"]["login"], state="preparing", head=head, pr_head=head,
             updated_at=info["updatedAt"], lease=iso(now()),
             lane=cand.get("lane") or e.get("lane") or "fresh",
             my_teams=cand.get("my_teams") or e.get("my_teams"),
             rereview_from=cand.get("rereview_from") or e.get("rereview_from"))
    rf = e.get("rereview_from")
    if rf and rf != "-" and subprocess.run(
            ["git", "-C", str(CLONE), "cat-file", "-e", f"{rf}^{{commit}}"],
            stderr=subprocess.DEVNULL).returncode != 0:
        # A force-push can leave the reviewed commit unreachable from the PR.
        git("fetch", "-q", "--no-write-fetch-head", "upstream", rf, check=False)
    (d / "meta.json").write_text(json.dumps({
        "pr": n, "head": head, "ref": f"refs/review-bank/{n}", "lane": e["lane"],
        "rereview_from": rf, "clone": str(CLONE), "fetched_at": iso(now())}, indent=1))
    save(e)
    print(f"{n}: dossier {d}\n  ref refs/review-bank/{n} = {head[:12]}, lane {e['lane']}, state preparing")
    print("  " + ci.stdout.strip().splitlines()[0] if ci.stdout.strip() else "  ci: no output")


# Hidden comments: GitHub's minimize reasons, normalized to lowercase with
# dashes. DROP content is excluded entirely (not credited, not treated as
# already raised). CONTEXT content stays, marked as resolved context.
DROP_REASONS = {"spam", "abuse", "low-quality", "off-topic"}
CONTEXT_REASONS = {"outdated", "duplicate", "resolved"}
DISCUSSION_PAGE = {
    "comments": "comments(first:100%s){pageInfo{hasNextPage endCursor} nodes{author{__typename login} "
                "authorAssociation createdAt isMinimized minimizedReason body}}",
    "reviews": "reviews(first:100%s){pageInfo{hasNextPage endCursor} nodes{author{__typename login} "
               "authorAssociation state submittedAt commit{oid} isMinimized minimizedReason body}}",
    "reviewThreads": "reviewThreads(first:50%s){pageInfo{hasNextPage endCursor} nodes{isResolved "
                     "isOutdated path line comments(first:100){totalCount nodes{author{__typename login} "
                     "authorAssociation createdAt isMinimized minimizedReason body}}}}",
}


def blocked(login):
    """True if the nodejs org blocks login, False if not, None if unknown.
    Needs org moderation rights (the user has them). Cached for a week."""
    p = CACHE / "blocks.json"
    cache = json.loads(p.read_text()) if p.exists() else {}
    hit = cache.get(login)
    if hit and time.time() - hit["at"] < 7 * 86400:
        return hit["blocked"]
    r = subprocess.run([str(HERE / "gh-retry.sh"), "api", "-i", f"orgs/nodejs/blocks/{login}"],
                       env=ENV, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    status = re.search(r"HTTP(?:/[\d.]+)? (\d{3})", r.stdout + r.stderr)
    code = status.group(1) if status else "?"
    result = True if code == "204" else False if code == "404" else None
    if result is not None:
        cache[login] = {"blocked": result, "at": time.time()}
        p.write_text(json.dumps(cache))
    return result


def discussion(n):
    """The PR's comments, reviews, and inline threads, with hidden and
    blocked-user content filtered out. Excluded items keep no body."""
    raw = {}
    for conn, frag in DISCUSSION_PAGE.items():
        nodes, after = [], ""
        while True:
            q = (f'query{{repository(owner:"{OWNER}",name:"{NAME}"){{pullRequest(number:{n})'
                 f'{{{frag % after}}}}}}}')
            page = graphql(q)["pullRequest"][conn]
            nodes += page["nodes"]
            if not page["pageInfo"]["hasNextPage"]:
                break
            after = f',after:"{page["pageInfo"]["endCursor"]}"'
        raw[conn] = nodes
    every = raw["comments"] + raw["reviews"] + [c for t in raw["reviewThreads"] for c in t["comments"]["nodes"]]
    # Bots (GraphQL drops their [bot] suffix) can't be org-blocked users.
    authors = {c["author"]["login"] for c in every
               if c.get("author") and c["author"].get("__typename") != "Bot"}
    blocks = {a: blocked(a) for a in sorted(authors) if a != "nodejs-github-bot"}
    out = {"pr": int(n), "fetched_at": iso(now()), "comments": [], "reviews": [], "threads": [],
           "excluded": [], "block_check_unknown": sorted(a for a, b in blocks.items() if b is None),
           "rules": "excluded items are not credited and don't count as already raised; "
                    "status resolved-context means hidden as outdated, duplicate, or resolved"}

    def keep(kind, c, where=""):
        login = (c.get("author") or {}).get("login") or "ghost"
        reason = (c.get("minimizedReason") or "").lower().replace("_", "-")
        if blocks.get(login):
            out["excluded"].append({"kind": kind, "author": login, "why": "org-blocked user", "where": where})
            return None
        if c.get("isMinimized") and reason not in CONTEXT_REASONS:
            out["excluded"].append({"kind": kind, "author": login, "why": f"hidden as {reason or 'unknown'}", "where": where})
            return None
        item = {"author": login, "association": c.get("authorAssociation"),
                "at": c.get("createdAt") or c.get("submittedAt"),
                "status": "resolved-context" if c.get("isMinimized") else "active", "body": c.get("body", "")}
        if kind == "review":
            item.update(state=c["state"], commit=((c.get("commit") or {}).get("oid") or "")[:12])
        return item

    for c in raw["comments"]:
        if (i := keep("comment", c)):
            out["comments"].append(i)
    for r in raw["reviews"]:
        if (i := keep("review", r)) and (i["body"].strip() or i["state"] != "COMMENTED"):
            out["reviews"].append(i)
    for t in raw["reviewThreads"]:
        where = f"{t['path']}:{t.get('line') or '?'}"
        kept = [i for c in t["comments"]["nodes"] if (i := keep("inline", c, where))]
        if kept:
            out["threads"].append({"path": t["path"], "line": t.get("line"), "resolved": t["isResolved"],
                                   "outdated": t["isOutdated"], "comments": kept,
                                   "truncated": t["comments"]["totalCount"] > len(t["comments"]["nodes"])})
    return out


def fetch_upstream():
    """main and the staging branches, at most every 30 minutes."""
    stamp = CACHE / "fetch.stamp"
    if stamp.exists() and time.time() - stamp.stat().st_mtime < 1800:
        return
    git("fetch", "-q", "--no-write-fetch-head", "upstream", "+refs/heads/main:refs/remotes/upstream/main",
        "+refs/heads/v*-staging:refs/remotes/upstream/v*-staging")
    stamp.write_text(iso(now()))


def active_lines():
    """Active release lines (nodejs-contribute, Release-line labels), cached a day."""
    p = CACHE / "release-lines.txt"
    if p.exists() and time.time() - p.stat().st_mtime < 86400:
        return p.read_text()
    sched = json.loads(base64.b64decode(
        gh("api", "repos/nodejs/Release/contents/schedule.json", "--jq", ".content")))
    today = now().strftime("%Y-%m-%d")
    lines = [k for k, v in sched.items() if v.get("start", "9") <= today <= v.get("end", "0")]
    p.write_text(f"active release lines on {today}: {' '.join(lines)}\n")
    return p.read_text()


# ---------------------------------------------------------------- slots

def slots():
    conf = BANK / "slots.tsv"
    if not conf.exists():
        conf.write_text(f"1\t{CLONE}\n2\t{CLONE}/.claude/worktrees/review-b\n")
    return [l.split("\t") for l in conf.read_text().splitlines() if l.strip()]


def slot_cmd(args):
    if not args or args[0] == "status":
        for name, path in slots():
            h = Lock(f"slot-{name}").holder()
            held = f"held for #{h['pr']} by {h['owner']} since {h['at']}" if h else "free"
            p = Path(path)
            if not p.exists():
                print(f"slot {name}: {path} MISSING ({held})")
                continue
            dirty = subprocess.run(["git", "-C", path, "status", "--porcelain"], text=True,
                                   stdout=subprocess.PIPE).stdout.strip()
            at = subprocess.run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"], text=True,
                                stdout=subprocess.PIPE).stdout.strip()
            print(f"slot {name}: {path} [{at}{', DIRTY' if dirty else ''}] {held}")
        return
    if args[0] == "acquire":
        want, pr = args[1], args[2]
        owner = args[3] if len(args) > 3 else "orchestrator"
        for name, path in slots():
            if want not in ("any", name) or not Path(path).exists():
                continue
            busy = [h for h in (Lock(f"slot-{s}").holder() for s, _ in slots()) if h and h["pr"] == pr]
            if busy:
                die(f"#{pr} already holds a slot; never run one PR in two slots (repro.sh uses a shared repro-{pr} branch)")
            if subprocess.run(["git", "-C", path, "status", "--porcelain"], text=True,
                              stdout=subprocess.PIPE).stdout.strip():
                print(f"slot {name}: dirty, skipped", file=sys.stderr)
                continue
            if Lock(f"slot-{name}").acquire({"pr": pr, "owner": owner, "at": iso(now())}):
                print(f"{name}\t{path}")
                return
        die("no free slot", 3)
    if args[0] == "release":
        name, path = args[1], dict(slots()).get(args[1])
        if path is None:
            die(f"no slot {name}")
        dirty = subprocess.run(["git", "-C", path, "status", "--porcelain"], text=True,
                               stdout=subprocess.PIPE).stdout.strip()
        if dirty and "--force" not in args:
            die(f"slot {name} has changes; restore them (git checkout -- <file>) first:\n{dirty}")
        Lock(f"slot-{name}").release()
        at = subprocess.run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"], text=True,
                            stdout=subprocess.PIPE).stdout.strip()
        print(f"slot {name} released, at {at}" + ("" if at in ("main", "HEAD") else " (expected main)"))
        return
    die("usage: slot status | acquire <slot|any> <pr> [owner] | release <slot> [--force]", 2)


# ---------------------------------------------------------------- output

def show(e, header_only=False):
    moved = "" if e.get("pr_head") in (None, "-", e.get("head")) else f", HEAD MOVED to {e['pr_head'][:12]}"
    print(f"#{e['pr']} [{e['lane']}] {e['state']}: {e['title']}\n  {e['url']}\n"
          f"  prepared against {e['head'][:12]} at {e['prepared_at']}{moved}"
          + (f"\n  teams: {e['my_teams']}" if e.get("my_teams") not in (None, "-") else "")
          + (f"\n  disposition: {e['disposition']} at {e['disposition_at']}" if e["disposition"] != "-" else "")
          + (f"\n  note: {e['note']}" if e.get("note") not in (None, "-") else ""))
    if not header_only:
        print(e["body"].rstrip())


def list_cmd(show_all, target=TARGET):
    es = sorted(entries(), key=lambda e: (STATES.index(e["state"]) if e["state"] in STATES else 9, rank(e)))
    counts = {s: sum(e["state"] == s for e in es) for s in STATES}
    print("bank: " + (", ".join(f"{v} {k}" for k, v in counts.items() if v) or "empty") + f" (target {target})")
    for e in es:
        if e["state"] == "done" and not show_all:
            continue
        snz = " (snoozed)" if rank(e)[0] else ""
        extra = f" needs-run={e['needs_run']}" if e["state"] == "needs-run" else ""
        disp = f" -> {e['disposition']}" if e["state"] == "done" else ""
        print(f"  {e['state']:<9} {e['lane']:<13} https://github.com/{REPO}/pull/{e['pr']}{extra}{snz}{disp}  {e['title'][:60]}")


def put(n, summary, state=None):
    e = load(n) or die(f"no entry for {n}; prefetch it first")
    body = Path(summary).read_text()
    m = re.search(r"^#+ *Needs a run\s*\n(.*?)(?=^#|\Z)", body, re.S | re.M)
    pending = len(re.findall(r"^\s*- ", m.group(1), re.M)) if m else 0
    e["body"] = body
    e["needs_run"] = str(pending)
    e["prepared_at"] = iso(now())
    e["lease"] = "-"
    e["note"] = "-"
    e["state"] = state or ("needs-run" if pending else "ready")
    if e.get("pr_head") not in (None, "-") and e["pr_head"] != e["head"]:
        e["state"] = "stale"
        e["note"] = f"head moved to {e['pr_head'][:12]} during preparation"
    save(e)
    show(e, header_only=True)


def main(argv):
    if not argv:
        print(__doc__)
        return
    cmd, args = argv[0], argv[1:]
    if cmd in ("tick", "sync", "plan", "prefetch"):
        me()
    if cmd == "tick":
        lock = Lock("tick")
        if not lock.acquire({"pid": os.getpid(), "at": iso(now())}):
            die("another tick is running", 0)
        try:
            print(f"tick {iso(now())}")
            stamp = parse_iso((CACHE / "queue.stamp").read_text()) if (CACHE / "queue.stamp").exists() else None
            if "--refresh" in args or not stamp or now() - stamp > timedelta(minutes=REFRESH_MIN):
                print(f"  team queue: {refresh_queue()}")
            else:
                print(f"  team queue: cached from {iso(stamp)} (REFRESH_MINUTES={REFRESH_MIN})")
            print(f"  re-review lane: {refresh_rereview()}")
            for l in sync():
                print(l if l.startswith("  ") else f"  {l}")
        finally:
            lock.release()
        target = int(args[args.index("--target") + 1]) if "--target" in args else TARGET
        lines, total = plan(target)
        list_cmd(False, target)
        print(f"plan: {total} eligible candidates")
        print("\n".join(lines) or "plan: bank is full")
    elif cmd == "sync":
        print("\n".join(sync(set(args) or None)))
    elif cmd == "plan":
        target = int(args[args.index("--target") + 1]) if "--target" in args else TARGET
        lines, total = plan(target, "--all" in args)
        print(f"plan: {total} eligible candidates")
        print("\n".join(lines) or "plan: bank is full")
    elif cmd == "list":
        list_cmd("--all" in args)
    elif cmd == "show":
        show(load(args[0]) or die(f"no entry for {args[0]}"))
    elif cmd == "present":
        es = entries()
        cur = [e for e in es if e["state"] == "presented"]
        if cur:
            die(f"#{cur[0]['pr']} is still presented; record its disposition first (sync, or set {cur[0]['pr']} state=done disposition=skipped)")
        ready = sorted([e for e in es if e["state"] == "ready"], key=rank) or \
            sorted([e for e in es if e["state"] == "needs-run"], key=rank)
        if not ready:
            die("nothing ready", 3)
        e = ready[0]
        e["state"], e["presented_at"] = "presented", iso(now())
        save(e)
        rest = sum(x["state"] in ("ready", "needs-run") for x in es if x is not e)
        show(e)
        print(f"\n({rest} more banked after this)")
    elif cmd == "discussion":
        me()
        print(json.dumps(discussion(str(int(args[0]))), indent=1))
    elif cmd == "prefetch":
        prefetch(args[0])
    elif cmd == "put":
        st = args[args.index("--state") + 1] if "--state" in args else None
        put(args[0], args[1], st)
    elif cmd == "set":
        e = load(args[0]) or die(f"no entry for {args[0]}")
        for kv in args[1:]:
            k, _, v = kv.partition("=")
            if k not in FIELDS or k == "pr":
                die(f"unknown field {k}")
            e[k] = v
        if e["state"] == "done" and e.get("disposition_at") in (None, "-"):
            finish(e, e["disposition"])
        save(e)
        show(e, header_only=True)
    elif cmd == "slot":
        slot_cmd(args)
    else:
        die(f"unknown command {cmd}", 2)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except RuntimeError as err:
        die(str(err))
