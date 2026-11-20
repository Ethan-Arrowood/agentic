#!/usr/bin/env python3
"""nodejs-review-bank: a bank of prepared nodejs/node reviews on disk.

Deterministic parts of the skill. Every gh call goes through the bin/gh shim
(one gh call at a time across processes) and backs off on GitHub's secondary
rate limit. Read-only on GitHub: nothing here posts, labels, or reviews.

  bank.py tick [--refresh] [--target N]   refresh candidates, sync, prune, plan
  bank.py sync [PR...]                    re-read bank entries from GitHub, prune
  bank.py plan [--target N] [--all]       what to prepare next, in priority order (--all adds skips)
  bank.py list [--all]                    the bank, by priority
  bank.py show <pr>                       one entry
  bank.py present                         mark the top ready entry presented, show it
  bank.py prefetch <pr>                   fetch the PR's dossier and claim the entry
  bank.py put <pr> <summary.md>           bank a verified summary (ready or needs-run)
  bank.py set <pr> key=value...           edit entry fields (state=done disposition=skipped)
  bank.py slot status|acquire <slot|any> <pr> [owner]|release <slot> [--force]

Env: NODE_REVIEW_BANK (bank dir), NODE_CLONE (default ~/dev/nodejs/node),
REPO, ME, BANK_TARGET (default 6), REFRESH_MINUTES (default 120),
LEASE_MINUTES (default 120), RQ_SCRIPTS and NC_SCRIPTS (sibling skills' scripts).
"""
import base64, fcntl, json, os, re, shutil, subprocess, sys, tempfile, time
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
RETRY_SLEEP = float(os.environ.get("GH_RETRY_SLEEP", "60"))
CQ_CI_MAX_AGE = 30 * 60      # recheck a cq candidate's CI after this many seconds
CQ_CI_PER_TICK = 5           # at most this many ci-status.sh runs per tick
SLOT_OWNERLESS_GRACE = 60    # a slot lock dir with no owner record is reclaimed after this

PRS, DOSSIER, CACHE, LOCKS, ARCHIVE = (BANK / d for d in ("prs", "dossier", "cache", "locks", "archive"))
for d in (PRS, DOSSIER, CACHE, LOCKS, ARCHIVE):
    d.mkdir(parents=True, exist_ok=True)

ENV = dict(os.environ, NODE_REVIEW_BANK=str(BANK), PATH=f"{HERE / 'bin'}:{os.environ['PATH']}")

LANES = ["rereview-asap", "rereview", "cq", "fresh", "fresh-checked", "skip"]
LANE_OF_BUCKET = {"RE-REVIEW-ASAP": "rereview-asap", "RE-REVIEW": "rereview", "CQ-CANDIDATE": "cq"}
STATES = ["presented", "ready", "needs-run", "stale", "preparing", "done"]
ACTIVE = {"preparing", "needs-run", "ready", "stale"}
# Dispositions the user chose. A done entry with one of these is not prepared
# again for the head the action covered. Automatic ones (closed, draft) don't block.
USER_DISPOSITIONS = ("approved", "changes-requested", "commented", "labeled", "unlabeled", "skipped")
FIELDS = ["pr", "url", "title", "author", "lane", "state", "head", "pr_head", "acted_head", "created_at",
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


def write_atomic(path, text):
    """Replace path in one step, so a reader never sees a partial file."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


ME = os.environ.get("ME")


def me():
    global ME
    if not ME:
        ME = gh("api", "user", "--jq", ".login").strip()
    ENV["ME"] = ME
    return ME


def gh_run(*args):
    """One gh call through the serializing shim. Backs off 1 to 5 minutes on
    the secondary rate limit, like nodejs-review-queue's gh_retry, but keeps
    stdout on failure (gh api graphql prints the response and exits 1 when it
    has errors)."""
    for attempt in range(1, 7):
        p = subprocess.run(["gh", *args], env=ENV, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode == 0 or "secondary rate limit" not in p.stderr.lower() or attempt == 6:
            return p
        print(f"  (gh backoff #{attempt}, sleeping {attempt * RETRY_SLEEP:.0f}s)", file=sys.stderr)
        time.sleep(attempt * RETRY_SLEEP)


def gh(*args, check=True):
    p = gh_run(*args)
    if check and p.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}: {p.stderr.strip()[-300:]}")
    return p.stdout


def graphql(query):
    qf = CACHE / f"query-{os.getpid()}.graphql"
    qf.write_text(query)
    try:
        p = gh_run("api", "graphql", "-F", f"query=@{qf}")
    finally:
        qf.unlink(missing_ok=True)
    try:
        data = json.loads(p.stdout)
    except ValueError:
        raise RuntimeError(f"graphql: {p.stderr.strip()[-300:] or 'no response'}")
    # A deleted PR comes back as a null alias plus a NOT_FOUND error. Callers
    # treat a missing alias as not found.
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


# ---------------------------------------------------------------- locks

class Flock:
    """A lock held for the life of this process. The kernel drops it when the
    holder exits, so a crash can't leave it stuck."""

    def __init__(self, name):
        self.path = LOCKS / f"{name}.lock"
        self.fd = None

    def acquire(self, wait=True):
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except BlockingIOError:
            os.close(self.fd)
            self.fd = None
            return False
        return True

    def release(self):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()


def entry_lock(n):
    return Flock(f"entry-{n}")


class SlotLock:
    """A slot is held across processes (acquire and release are separate
    commands), so it is a directory with an owner record, not a Flock. Callers
    hold Flock("slots") while they change one."""

    def __init__(self, name):
        self.path = LOCKS / f"slot-{name}"

    def holder(self):
        try:
            return json.loads((self.path / "owner.json").read_text())
        except (OSError, ValueError):
            return None

    def ownerless_since(self):
        """mtime of a lock dir that has no owner record, or None."""
        if not self.path.is_dir() or self.holder():
            return None
        return datetime.fromtimestamp(self.path.stat().st_mtime, timezone.utc).replace(microsecond=0)

    def acquire(self, info):
        since = self.ownerless_since()
        if since and (now() - since).total_seconds() > SLOT_OWNERLESS_GRACE:
            self.release()
        try:
            self.path.mkdir()
        except FileExistsError:
            return False
        write_atomic(self.path / "owner.json", json.dumps(info))
        return True

    def release(self):
        (self.path / "owner.json").unlink(missing_ok=True)
        try:
            self.path.rmdir()
        except OSError:
            pass


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
    write_atomic(entry_path(e["pr"]), f"---\n{head}\n---\n{e.get('body', '')}")


def entries():
    out = []
    for p in sorted(PRS.glob("*.md")):
        e = load(p.stem)
        if e:
            out.append(e)
    return out


def snoozed(e):
    return (parse_iso(e.get("snooze_until")) or now()) > now()


def rank(e):
    lane = LANES.index(e["lane"]) if e.get("lane") in LANES else len(LANES)
    upd = -(parse_iso(e.get("updated_at")) or datetime.fromtimestamp(0, timezone.utc)).timestamp()
    return (snoozed(e), lane, upd)


def acted_head(e):
    """The head the user's action covered: the reviewed commit, else the head
    the entry was prepared against."""
    return e.get("acted_head") if e.get("acted_head") not in (None, "-") else e.get("head")


def finish(e, disposition, when=None):
    """Move an entry to done, save it, then drop its dossier and fetched ref.
    Saving first means a crash in between leaves a done entry with leftovers,
    never an open entry without its inputs."""
    e["state"] = "done"
    e["disposition"] = disposition
    e["disposition_at"] = when or iso(now())
    e["lease"] = "-"
    if e.get("acted_head") in (None, "-"):
        e["acted_head"] = e.get("head")
    save(e)
    shutil.rmtree(DOSSIER / str(e["pr"]), ignore_errors=True)
    git("update-ref", "-d", f"refs/review-bank/{e['pr']}", check=False)


# ---------------------------------------------------------------- candidates

def read_tsv(name):
    p = CACHE / name
    if not p.exists():
        return []
    return [l.split("\t") for l in p.read_text().splitlines() if l.strip()]


def refresh_queue():
    """Team-routed queue via build-queue.sh. On INCOMPLETE, keep the old rows
    and add the new ones, so a partial run never shrinks the queue. The stamp
    is written last, so a failed metadata fetch is retried on the next tick."""
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
    fetch_meta([int(n) for n in rows])
    write_atomic(CACHE / "queue.tsv", "".join(f"{l}\n" for l in rows.values()))
    if p.returncode == 0:
        (CACHE / "queue.stamp").write_text(iso(now()))
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
    write_atomic(CACHE / "candidates.json", json.dumps(meta))


def refresh_rereview():
    p = subprocess.run(["python3", str(RQ / "rereview.py"), "--tsv"], env=ENV, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        return "FAILED (" + (p.stderr.strip().splitlines() or ["?"])[-1][:120] + "); kept previous rows"
    write_atomic(CACHE / "rereview.tsv", p.stdout)
    return f"{len(p.stdout.splitlines())} reviewed PRs"


def read_ci():
    p = CACHE / "ci.json"
    return json.loads(p.read_text()) if p.exists() else {}


def refresh_cq_ci():
    """ci-status.sh for cq candidates whose cached result is missing, for an
    older head, or older than CQ_CI_MAX_AGE. plan reads the cache."""
    ci, ran = read_ci(), 0
    for c in ranked_candidates():
        if c["lane"] != "cq" or ran >= CQ_CI_PER_TICK:
            continue
        r = ci.get(c["pr"])
        if r and r["head"] == c["head"] and (now() - parse_iso(r["at"])).total_seconds() < CQ_CI_MAX_AGE:
            continue
        p = subprocess.run([str(NC / "ci-status.sh"), c["pr"]], env=ENV, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        line = (p.stdout.strip().splitlines() or ["no output"])[0]
        ci[c["pr"]] = {"head": c["head"], "ok": "CI=SUCCESS" in line and "HEAD-MATCH" in line,
                       "line": line, "at": iso(now())}
        ran += 1
    write_atomic(CACHE / "ci.json", json.dumps(ci))
    return f"{ran} cq candidate(s) checked"


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
    ci = read_ci()
    active = [e for e in bank.values() if e["state"] in ACTIVE - {"stale"}]
    lines = [f"PREPARE {e['pr']} lane={e['lane']} (stale: re-prepare)"
             for e in sorted(bank.values(), key=rank) if e["state"] == "stale"]
    room = max(0, target - len(active) - len(lines))
    fresh, skipped = [], []
    for c in ranked_candidates():
        e = bank.get(c["pr"])
        if e and e["state"] != "done":
            continue
        # An action covers its head and its kind of work: an approval at a
        # head doesn't cover the commit-queue check for that head.
        if (e and e["disposition"].startswith(USER_DISPOSITIONS) and acted_head(e) == c["head"]
                and (e["lane"] == "cq") == (c["lane"] == "cq")):
            skipped.append((c, f"you acted at this head ({e['disposition'][:40]})"))
            continue
        if c["lane"] == "cq":
            r = ci.get(c["pr"])
            if not r or r["head"] != c["head"] or not r["ok"]:
                why = r["line"] if r and r["head"] == c["head"] else "not checked at this head yet"
                skipped.append((c, f"CI not green at head: {why}"))
                continue
        fresh.append(c)
    for c in (fresh if show_all else fresh[:room]):
        lines.append(f"PREPARE {c['pr']} lane={c['lane']} updated={c['updated'][:10]}"
                     + (f"  {c.get('title', '')[:60]}" if c.get("title") else ""))
    if show_all:
        lines += [f"SKIP {c['pr']} lane={c['lane']} {why}" for c, why in skipped]
    return lines, len(fresh)


# ---------------------------------------------------------------- sync

SYNC_FIELDS = (
    "number title state isDraft updatedAt closedAt headRefOid author{login} "
    "labels(first:50){nodes{name}} "
    "reviews(last:30,author:\"%s\"){nodes{state submittedAt commit{oid}}} "
    "comments(last:30){nodes{author{__typename login} createdAt body}} "
    "timelineItems(last:50,itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){nodes{__typename "
    "...on LabeledEvent{createdAt actor{login} label{name}} "
    "...on UnlabeledEvent{createdAt actor{login} label{name}}}}")
LANDED = re.compile(r"^\s*Landed in ([0-9a-f]{7,40})", re.M)


def sync(only=None):
    nums = [e["pr"] for e in entries() if e["state"] != "done" and (not only or e["pr"] in only)]
    if not nums:
        return ["sync: no open entries"]
    rr = {r[1]: r for r in read_tsv("rereview.tsv")}
    data = {}
    for i in range(0, len(nums), 20):
        fields = " ".join(f"p{n}: pullRequest(number:{n}){{{SYNC_FIELDS % me()}}}" for n in nums[i:i + 20])
        data.update({str(d["number"]): d for d in graphql(
            f'query{{repository(owner:"{OWNER}",name:"{NAME}"){{{fields}}}}}').values() if d})
    log = []
    for n in nums:
        # Re-read under the entry's lock: a put, present, or set may have
        # changed it while the query above waited on GitHub.
        with entry_lock(n):
            e = load(n)
            if not e or e["state"] == "done":
                continue
            log += sync_entry(e, data.get(n), rr)
    return log or ["sync: no changes"]


def sync_entry(e, d, rr):
    n = e["pr"]
    if not d:
        finish(e, "not-found")
        return [f"  {n}: not found on GitHub (deleted?)"]
    e["title"], e["updated_at"], e["pr_head"] = d["title"], d["updatedAt"], d["headRefOid"]
    if n in rr and rr[n][0] in LANE_OF_BUCKET:
        e["lane"] = LANE_OF_BUCKET[rr[n][0]]
    author = (d.get("author") or {}).get("login")
    if author == me():
        finish(e, "mine")
        return [f"  {n}: authored by me, dropped"]
    if d["state"] in ("MERGED", "CLOSED"):
        # nodejs lands with commit-queue or git node land, so a landed PR
        # shows as closed with a "Landed in <sha>" comment.
        landed = [m.group(1) for c in d["comments"]["nodes"] if (m := LANDED.search(c.get("body") or ""))]
        disp = f"landed {landed[-1]}" if landed else d["state"].lower()
        finish(e, disp, d.get("closedAt"))
        return [f"  {n}: {disp}"]
    if d["isDraft"]:
        finish(e, "draft")
        return [f"  {n}: converted to draft"]
    acted = my_actions(d, parse_iso(e.get("created_at")) or now())
    labels = {l["name"] for l in d["labels"]["nodes"]}
    if acted:
        disp, when, reviewed = acted
        e["acted_head"] = reviewed or e.get("head")
        finish(e, disp, when)
        return [f"  {n}: {disp}"]
    if e["lane"] == "cq" and any(l.startswith("commit-queue") for l in labels):
        finish(e, "cq-labeled")
        return [f"  {n}: commit-queue added by someone else"]
    log = []
    if e["state"] in ("ready", "needs-run", "presented") and e["head"] != d["headRefOid"]:
        e["note"] = f"head moved from {e['head'][:12]} while {e['state']}"
        e["state"] = "stale"
        log.append(f"  {n}: stale, {e['note']}")
    elif e["state"] == "preparing" and (now() - (parse_iso(e.get("lease")) or now())).total_seconds() > LEASE_MIN * 60:
        e["state"] = "stale"
        e["note"] = "preparation abandoned (lease expired)"
        log.append(f"  {n}: {e['note']}")
    save(e)
    return log


def my_actions(d, since):
    """My reviews, label changes, and comments since `since`, as one
    disposition string, the time of the latest, and the commit of my latest
    review (or None)."""
    acts, reviewed = [], None
    for r in d["reviews"]["nodes"]:
        t = parse_iso(r["submittedAt"])
        if t and t > since:
            oid = (r.get("commit") or {}).get("oid")
            reviewed = oid or reviewed
            acts.append((t, f"{r['state'].lower().replace('_', '-')} @{(oid or '?')[:12]}"))
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
    return "; ".join(dict.fromkeys(a[1] for a in order)), iso(acts[-1][0]), reviewed


# ---------------------------------------------------------------- prefetch

def prefetch(n):
    """Everything a preparing agent needs, so it never calls gh itself. The
    new dossier and ref replace the old ones only after the fetched head
    matches GitHub's, so a failed prefetch leaves an earlier one intact."""
    n = str(int(n))
    pr = gh("pr", "view", n, "--repo", REPO, "--json",
            "number,title,body,author,baseRefName,headRefOid,reviewDecision,labels,mergeable,"
            "mergeStateStatus,files,commits,createdAt,updatedAt,isDraft,state")
    info = json.loads(pr)

    fetch_upstream()
    tmp_ref = f"refs/review-bank/tmp/{n}-{os.getpid()}"
    git("fetch", "-q", "--no-write-fetch-head", "upstream", f"+pull/{n}/head:{tmp_ref}")
    head = git("rev-parse", tmp_ref).strip()
    if head != info["headRefOid"]:
        git("update-ref", "-d", tmp_ref, check=False)
        die(f"{n}: fetched {head[:12]} but GitHub says head is {info['headRefOid'][:12]}; rerun")

    old = load(n)
    cand = {c["pr"]: c for c in ranked_candidates()}.get(n, {})
    lane = cand.get("lane") or (old or {}).get("lane") or "fresh"
    rf = cand.get("rereview_from") or (old or {}).get("rereview_from")
    if rf and rf != "-" and subprocess.run(
            ["git", "-C", str(CLONE), "cat-file", "-e", f"{rf}^{{commit}}"],
            stderr=subprocess.DEVNULL).returncode != 0:
        # A force-push can leave the reviewed commit unreachable from the PR.
        git("fetch", "-q", "--no-write-fetch-head", "upstream", rf, check=False)

    new = Path(tempfile.mkdtemp(dir=DOSSIER, prefix=f".{n}."))
    try:
        swap_in(n, new, tmp_ref, pr, info, head, lane, rf, cand)
    finally:
        shutil.rmtree(new, ignore_errors=True)
        git("update-ref", "-d", tmp_ref, check=False)


def swap_in(n, new, tmp_ref, pr, info, head, lane, rf, cand):
    (new / "pr.json").write_text(pr)
    (new / "diff.patch").write_text(gh("pr", "diff", n, "--repo", REPO))
    (new / "discussion.json").write_text(discussion(n))
    ci = subprocess.run([str(NC / "ci-status.sh"), n], env=ENV, text=True,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (new / "ci.txt").write_text(f"{ci.stdout}(ci-status.sh exit {ci.returncode}, {iso(now())})\n")
    (new / "release-lines.txt").write_text(active_lines())
    (new / "meta.json").write_text(json.dumps({
        "pr": n, "head": head, "ref": f"refs/review-bank/{n}", "lane": lane,
        "rereview_from": rf, "clone": str(CLONE), "fetched_at": iso(now())}, indent=1))

    with entry_lock(n):
        git("update-ref", f"refs/review-bank/{n}", tmp_ref)
        d = DOSSIER / n
        if d.exists():
            gone = d.with_name(f".{n}.old-{os.getpid()}")
            d.rename(gone)
            shutil.rmtree(gone, ignore_errors=True)
        new.rename(d)
        e = load(n)
        if e and e.get("state") in ("done", "stale") and e.get("body", "").strip():
            # Keep the earlier review for reference; the new one starts clean.
            ARCHIVE.joinpath(f"{n}-{e.get('head', '-')[:12]}.md").write_text(entry_path(n).read_text())
        if not e or e.get("state") in ("done", "stale"):
            e = {"pr": n, "created_at": iso(now()), "disposition": "-",
                 "my_teams": (e or {}).get("my_teams")}
        e.update(url=f"https://github.com/{REPO}/pull/{n}", title=info["title"],
                 author=info["author"]["login"], state="preparing", head=head, pr_head=head,
                 updated_at=info["updatedAt"], lease=iso(now()), lane=lane,
                 my_teams=cand.get("my_teams") or e.get("my_teams"), rereview_from=rf)
        save(e)
    print(f"{n}: dossier {d}\n  ref refs/review-bank/{n} = {head[:12]}, lane {lane}, state preparing")
    print("  " + ci.stdout.strip().splitlines()[0] if ci.stdout.strip() else "  ci: no output")


def discussion(n):
    """nodejs-review-queue's discussion.sh --json: comments, reviews, and
    inline threads, without hidden or blocked-user content."""
    p = subprocess.run(["zsh", str(RQ / "discussion.sh"), "--json", n], env=ENV, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(f"discussion.sh {n}: {p.stderr.strip()[-300:]}")
    d = json.loads(p.stdout)
    d["fetched_at"] = iso(now())
    d["rules"] = ("excluded items are not credited and don't count as already raised; "
                  "status resolved-context means hidden as outdated, duplicate, or resolved")
    return json.dumps(d, indent=1)


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
    write_atomic(p, f"active release lines on {today}: {' '.join(lines)}\n")
    return p.read_text()


# ---------------------------------------------------------------- slots

def slots():
    conf = BANK / "slots.tsv"
    if not conf.exists():
        conf.write_text(f"1\t{CLONE}\n2\t{CLONE}/.claude/worktrees/review-b\n")
    return [l.split("\t") for l in conf.read_text().splitlines() if l.strip()]


def checkout_state(path):
    """(usable, dirty lines, HEAD name). Unusable when git status fails."""
    st = subprocess.run(["git", "-C", path, "status", "--porcelain"], text=True,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    at = subprocess.run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"], text=True,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
    return st.returncode == 0, st.stdout.strip(), at


def slot_cmd(args):
    if not args or args[0] == "status":
        for name, path in slots():
            lock = SlotLock(name)
            h, since = lock.holder(), lock.ownerless_since()
            held = (f"held for #{h['pr']} by {h['owner']} since {h['at']}" if h else
                    f"lock has no owner record since {iso(since)} (reclaimed after {SLOT_OWNERLESS_GRACE}s)"
                    if since else "free")
            if not Path(path).exists():
                print(f"slot {name}: {path} MISSING ({held})")
                continue
            ok, dirty, at = checkout_state(path)
            flag = ", DIRTY" if dirty else "" if ok else ", GIT STATUS FAILED"
            print(f"slot {name}: {path} [{at}{flag}] {held}")
        return
    if args[0] == "acquire":
        want, pr = args[1], args[2]
        owner = args[3] if len(args) > 3 else "orchestrator"
        with Flock("slots"):
            if any(h and h["pr"] == pr for h in (SlotLock(s).holder() for s, _ in slots())):
                die(f"#{pr} already holds a slot; never run one PR in two slots (repro.sh uses a shared repro-{pr} branch)")
            for name, path in slots():
                if want not in ("any", name) or not Path(path).exists():
                    continue
                ok, dirty, _ = checkout_state(path)
                if not ok or dirty:
                    print(f"slot {name}: {'git status failed' if not ok else 'dirty'}, skipped", file=sys.stderr)
                    continue
                if SlotLock(name).acquire({"pr": pr, "owner": owner, "at": iso(now())}):
                    print(f"{name}\t{path}")
                    return
        die("no free slot", 3)
    if args[0] == "release":
        name, path = args[1], dict(slots()).get(args[1])
        if path is None:
            die(f"no slot {name}")
        ok, dirty, at = checkout_state(path)
        if (dirty or not ok) and "--force" not in args:
            die(f"slot {name} has changes; restore them (git checkout -- <file>) first:\n{dirty}" if ok else
                f"slot {name}: git status failed in {path}; check it, then release with --force")
        with Flock("slots"):
            SlotLock(name).release()
        print(f"slot {name} released, at {at}" + ("" if at in ("main", "HEAD") else " (expected main)"))
        return
    die("usage: slot status | acquire <slot|any> <pr> [owner] | release <slot> [--force]", 2)


# ---------------------------------------------------------------- output

def show(e, header_only=False):
    moved = "" if e.get("pr_head") in (None, "-", e.get("head")) else f", HEAD MOVED to {e['pr_head'][:12]}"
    print(f"#{e['pr']} [{e['lane']}] {e['state']}: {e['title']}\n  {e['url']}\n"
          f"  prepared against {e['head'][:12]} at {e.get('prepared_at', '-')}{moved}"
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
        snz = " (snoozed)" if snoozed(e) else ""
        extra = f" needs-run={e['needs_run']}" if e["state"] == "needs-run" else ""
        disp = f" -> {e['disposition']}" if e["state"] == "done" else ""
        print(f"  {e['state']:<9} {e['lane']:<13} https://github.com/{REPO}/pull/{e['pr']}{extra}{snz}{disp}  {e['title'][:60]}")


def put(n, summary, state=None):
    body = Path(summary).read_text()
    m = re.search(r"^#+ *Needs a run\s*\n(.*?)(?=^#|\Z)", body, re.S | re.M)
    pending = len(re.findall(r"^\s*- ", m.group(1), re.M)) if m else 0
    with entry_lock(n):
        e = load(n) or die(f"no entry for {n}; prefetch it first")
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


def present():
    with Flock("present"):
        es = entries()
        cur = [e for e in es if e["state"] == "presented"]
        if cur:
            die(f"#{cur[0]['pr']} is still presented; record its disposition first (sync, or set {cur[0]['pr']} state=done disposition=skipped)")
        awake = [e for e in es if not snoozed(e)]
        ready = sorted([e for e in awake if e["state"] == "ready"], key=rank) or \
            sorted([e for e in awake if e["state"] == "needs-run"], key=rank)
        if not ready:
            asleep = sum(e["state"] in ("ready", "needs-run") and snoozed(e) for e in es)
            die("nothing ready" + (f" ({asleep} snoozed)" if asleep else ""), 3)
        with entry_lock(ready[0]["pr"]):
            e = load(ready[0]["pr"])
            e["state"], e["presented_at"] = "presented", iso(now())
            rest = sum(x["state"] in ("ready", "needs-run") for x in es if x["pr"] != e["pr"])
            # Print first: if output fails, the entry isn't left claimed.
            show(e)
            print(f"\n({rest} more banked after this)")
            sys.stdout.flush()
            save(e)


def set_cmd(n, kvs):
    with entry_lock(n):
        e = load(n) or die(f"no entry for {n}")
        for kv in kvs:
            k, _, v = kv.partition("=")
            if k not in FIELDS or k == "pr":
                die(f"unknown field {k}")
            if k == "state" and v not in STATES:
                die(f"state must be one of {', '.join(STATES)}")
            if k == "lane" and v not in LANES:
                die(f"lane must be one of {', '.join(LANES)}")
            if k in ("snooze_until", "disposition_at", "created_at") and v != "-":
                try:
                    parse_iso(v)
                except ValueError:
                    die(f"{k} must be an ISO time such as {iso(now())}")
            e[k] = v
        if e["state"] == "done" and e.get("disposition_at") in (None, "-"):
            finish(e, e["disposition"])
        else:
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
        lock = Flock("tick")
        if not lock.acquire(wait=False):
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
            print(f"  cq CI: {refresh_cq_ci()}")
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
        present()
    elif cmd == "prefetch":
        prefetch(args[0])
    elif cmd == "put":
        st = args[args.index("--state") + 1] if "--state" in args else None
        put(args[0], args[1], st)
    elif cmd == "set":
        set_cmd(args[0], args[1:])
    elif cmd == "slot":
        slot_cmd(args)
    else:
        die(f"unknown command {cmd}", 2)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except RuntimeError as err:
        die(str(err))
