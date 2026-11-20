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
  bank.py put <pr> <summary.md> [--head <sha>]   bank a verified summary (ready or needs-run)
  bank.py set <pr> key=value...           edit entry fields (state=done disposition=skipped)
  bank.py hold <pr> [--until ISO] [--until-reviews N] [note]   wait for others' reviews, a push, or a time
  bank.py unhold <pr>                     end a hold now
  bank.py slot status|acquire <slot|any> <pr> [owner]|release <slot> <pr>|release <slot> --force
  bank.py image prune                     remove free slots' out/ volumes for unused images

Env: NODE_REVIEW_BANK (bank dir), NODE_CLONE (default ~/dev/nodejs/node),
REPO, ME, BANK_TARGET (default 6), REFRESH_MINUTES (default 120),
LEASE_MINUTES (default 120), RQ_SCRIPTS and NC_SCRIPTS (sibling skills' scripts),
BANK_METADATA (lanes that get metadata.txt: cq, all, or off; default cq),
DEVC_IMAGE, IMAGE_CHECK_MINUTES (default 60), DEVC_HUB_URL (Docker Hub tag API URL).
"""
import base64, fcntl, json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request
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
CQ_CI_MAX_AGE = 30 * 60
CQ_CI_PER_TICK = 5
SLOT_OWNERLESS_GRACE = 60
DEVC_IMAGE = os.environ.get("DEVC_IMAGE", "docker.io/nodejs/devcontainer:nightly")
IMAGE_CHECK_MIN = int(os.environ.get("IMAGE_CHECK_MINUTES", "60"))
MOVE = "image-move"  # slot owner and PR while a slot moves to the new image

PRS, DOSSIER, CACHE, LOCKS, ARCHIVE = (BANK / d for d in ("prs", "dossier", "cache", "locks", "archive"))
for d in (PRS, DOSSIER, CACHE, LOCKS, ARCHIVE):
    d.mkdir(parents=True, exist_ok=True)

ENV = dict(os.environ, NODE_REVIEW_BANK=str(BANK), PATH=f"{HERE / 'bin'}:{os.environ['PATH']}")

LANES = ["rereview-asap", "rereview", "cq", "fresh", "fresh-checked", "skip"]
LANE_OF_BUCKET = {"RE-REVIEW-ASAP": "rereview-asap", "RE-REVIEW": "rereview", "CQ-CANDIDATE": "cq"}
STATES = ["presented", "ready", "needs-run", "stale", "preparing", "waiting", "done"]
ACTIVE = {"preparing", "needs-run", "ready", "stale"}
# Dispositions the user chose. A done entry with one of these is not prepared
# again for the head the action covered. Automatic ones (closed, draft) don't block.
USER_DISPOSITIONS = ("approved", "changes-requested", "commented", "labeled", "unlabeled", "skipped")
FIELDS = ["pr", "url", "title", "author", "lane", "state", "head", "pr_head", "acted_head", "created_at",
          "prepared_at", "presented_at", "updated_at", "my_teams", "rereview_from",
          "needs_run", "disposition", "disposition_at", "snooze_until", "lease", "note",
          "wait_since", "wait_for"]
SKIP_PATHS = re.compile(r"^(lib/inspector\.js|lib/internal/inspector/|src/inspector/|"
                        r"lib/diagnostics_channel\.js|lib/internal/diagnostics_channel|"
                        r"src/node_diagnostics_channel)")


def now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    """An aware datetime. A time without a zone is taken as UTC."""
    if not s or s == "-":
        return None
    dt = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


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
        # rmtree, not rmdir: a crash during acquire can leave a temp file.
        shutil.rmtree(self.path, ignore_errors=True)


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
    drop_inputs(e["pr"])


def drop_inputs(n):
    """Remove an entry's dossier and fetched ref."""
    shutil.rmtree(DOSSIER / str(n), ignore_errors=True)
    git("update-ref", "-d", f"refs/review-bank/{n}", check=False)


def read_tsv(name):
    p = CACHE / name
    if not p.exists():
        return []
    return [l.split("\t") for l in p.read_text().splitlines() if l.strip()]


def refresh_queue():
    """Team-routed queue via build-queue.sh. On INCOMPLETE, keep the old rows
    and add the new ones, so a partial run never shrinks the queue. The rows
    are kept even when the metadata fetch fails, and the tick goes on. The
    stamp is written only after both succeed, so the next tick retries."""
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
    write_atomic(CACHE / "queue.tsv", "".join(f"{l}\n" for l in rows.values()))
    try:
        fetch_meta([int(n) for n in rows])
    except RuntimeError as err:
        return f"{status}; candidate metadata FAILED ({str(err)[:120]}), kept the previous metadata"
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


def ci_at(r, head):
    """Whether a cached ci-status.sh result is for this head."""
    return bool(r and r.get("head") and head.startswith(r["head"]))


def landing_at(created, labels):
    """When nodejs-contribute's Landing wait ends: 48 hours after the PR
    opened, 72 when those hours touch a Saturday or Sunday (UTC), and none
    with fast-track. None when the open time is unknown."""
    t = parse_iso(created)
    if not t:
        return None
    if "fast-track" in labels:
        return t
    end = t + timedelta(hours=48)
    weekend = any((t.date() + timedelta(days=i)).weekday() >= 5 for i in range((end.date() - t.date()).days + 1))
    return t + timedelta(hours=72) if weekend else end


def refresh_cq_ci():
    """ci-status.sh for cq candidates whose cached result is missing, for
    another head, or older than CQ_CI_MAX_AGE, oldest result first, skipping
    candidates plan would skip anyway. plan reads the cache. A result is keyed
    by the head ci-status.sh reports, which can differ from the candidate's."""
    ci, ran, bank = read_ci(), 0, {e["pr"]: e for e in entries()}
    todo = []
    for c in ranked_candidates():
        e = bank.get(c["pr"])
        held = e and e["state"] == "waiting" and "ci" in wake_conditions(e)
        if c["lane"] != "cq" or (e and e["state"] != "done" and not held) or skip_reason(c, e):
            continue
        r = ci.get(c["pr"])
        if ci_at(r, c["head"]) and (now() - parse_iso(r["at"])).total_seconds() < CQ_CI_MAX_AGE:
            continue
        todo.append(c)
    todo.sort(key=lambda c: (ci.get(c["pr"]) or {}).get("at", ""))
    for c in todo[:CQ_CI_PER_TICK]:
        p = subprocess.run([str(NC / "ci-status.sh"), c["pr"]], env=ENV, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        line = (p.stdout.strip().splitlines() or ["no output"])[0]
        m = re.search(r"\[head ([0-9a-f]{7,40})\]", line)
        ci[c["pr"]] = {"head": m.group(1) if m else "", "line": line, "at": iso(now()),
                       "ok": "CI=SUCCESS" in line and "HEAD-MATCH" in line}
        ran += 1
    write_atomic(CACHE / "ci.json", json.dumps(ci))
    return f"{ran} cq candidate(s) checked" + (f", {len(todo) - ran} waiting" if len(todo) > ran else "")


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
        bucket, n, _, _, last, head, approvals, mergeable, updated = r[:9]
        if bucket in LANE_OF_BUCKET:
            out[n] = dict(pr=n, lane=LANE_OF_BUCKET[bucket], head=head, updated=updated,
                          rereview_from=r[3], note=f"approvals={approvals} {mergeable}",
                          created=r[9] if len(r) > 9 else None, labels=r[10].split(",") if len(r) > 10 else [])
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


def skip_reason(c, e):
    """Why plan won't prepare candidate c for its done entry e, apart from
    CI, or None. The cached candidate can be up to REFRESH_MINUTES old, so
    when the entry saw the PR later, its state and head win."""
    if not e or e["state"] != "done":
        return None
    epoch = datetime.fromtimestamp(0, timezone.utc)
    newer = (parse_iso(e.get("updated_at")) or epoch) > (parse_iso(c.get("updated")) or epoch)
    user = e["disposition"].startswith(USER_DISPOSITIONS)
    if newer and not user and e["disposition"] != "-":
        return f"{e['disposition'][:40]} since the candidate was cached"
    head = e["pr_head"] if newer and e.get("pr_head") not in (None, "-") else c["head"]
    # An action covers its head and its kind of work: an approval at a head
    # doesn't cover the commit-queue check for that head. A woken hold
    # (wait_since set) asked for the PR back, so it doesn't cover it either.
    woke = e.get("wait_since") not in (None, "-")
    if user and not woke and acted_head(e) == head and (e["lane"] == "cq") == (c["lane"] == "cq"):
        return f"you acted at this head ({e['disposition'][:40]})"
    return None


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
        why = skip_reason(c, e)
        if why:
            skipped.append((c, why))
            continue
        if c["lane"] == "cq":
            r = ci.get(c["pr"])
            if not ci_at(r, c["head"]) or not r["ok"]:
                why = r["line"] if ci_at(r, c["head"]) else "not checked at this head yet"
                skipped.append((c, f"CI not green at head: {why}"))
                continue
            land = landing_at(c.get("created"), c.get("labels") or [])
            if land and land > now():
                skipped.append((c, f"landing wait until {iso(land)}"))
                continue
        fresh.append(c)
    for c in (fresh if show_all else fresh[:room]):
        e = bank.get(c["pr"])
        lines.append(f"PREPARE {c['pr']} lane={c['lane']} updated={c['updated'][:10]}"
                     + (f"  {c.get('title', '')[:60]}" if c.get("title") else "")
                     + (f"  ({e['note']})" if e and e.get("note", "").startswith("woke:") else ""))
    if show_all:
        lines += [f"SKIP {c['pr']} lane={c['lane']} {why}" for c, why in skipped]
        lines += [f"WAIT {e['pr']} lane={e['lane']} {describe_wait(e)}"
                  for e in sorted(bank.values(), key=rank) if e["state"] == "waiting"]
    counts = ", ".join(f"{k} {l}" for l in LANES if (k := sum(c["lane"] == l for c in fresh)))
    return lines, counts or "none"


SYNC_FIELDS = (
    "number title state isDraft createdAt updatedAt closedAt headRefOid author{login} "
    "labels(first:50){nodes{name}} "
    "allReviews: reviews(last:50){nodes{author{login} submittedAt}} "
    "reviews(last:30,author:\"%s\"){nodes{state submittedAt commit{oid}}} "
    "comments(last:30){nodes{author{__typename login} createdAt body}} "
    "timelineItems(last:50,itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){nodes{__typename "
    "...on LabeledEvent{createdAt actor{login} label{name}} "
    "...on UnlabeledEvent{createdAt actor{login} label{name}}}}")
LANDED = re.compile(r"^\s*Landed in ([0-9a-f]{7,40})", re.M)


def sync(only=None):
    heads = {e["pr"]: e["head"] for e in entries() if e["state"] != "done" and (not only or e["pr"] in only)}
    nums = list(heads)
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
            if e["head"] != heads[n]:
                # Re-prefetched while the query ran: the snapshot predates it.
                log.append(f"  {n}: re-prepared during sync, skipped until the next one")
                continue
            log += sync_entry(e, data.get(n), rr)
    return log or ["sync: no changes"]


def sync_entry(e, d, rr):
    n = e["pr"]
    if not d:
        finish(e, "not-found")
        return [f"  {n}: not found on GitHub (deleted?)"]
    e["title"], e["updated_at"], e["pr_head"] = d["title"], d["updatedAt"], d["headRefOid"]
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
    if e["state"] == "waiting":
        # My own actions don't wake a hold; it waits on others and on time.
        why = wake_reasons(e, d)
        if why:
            wake(e, why)
            return [f"  {n}: {e['note']}"]
        save(e)
        return []
    acted = my_actions(d, parse_iso(e.get("created_at")) or now())
    labels = {l["name"] for l in d["labels"]["nodes"]}
    if acted:
        disp, when, reviewed = acted
        e["acted_head"] = reviewed or e.get("head")
        # An approval at the head leaves nothing to do until the PR can land.
        gates = landing_gates(d, n) if disp.startswith("approved") and reviewed == d["headRefOid"] else {}
        if gates:
            e["disposition"], e["disposition_at"] = disp, when
            hold(e, {"reviews": "1", "push": reviewed[:12], **gates}, when, "approved; waiting until it can land")
            return [f"  {n}: {disp}, waiting {describe_wait(e)}"]
        finish(e, disp, when)
        return [f"  {n}: {disp}"]
    # Exact label: commit-queue-squash, -rebase, and -failed don't enqueue.
    if e["lane"] == "cq" and "commit-queue" in labels:
        finish(e, "cq-labeled")
        return [f"  {n}: commit-queue added by someone else"]
    # The lane changes only for an entry still open. A finished entry keeps
    # the lane it was prepared in, which plan compares with the candidate's.
    if n in rr and rr[n][0] in LANE_OF_BUCKET:
        e["lane"] = LANE_OF_BUCKET[rr[n][0]]
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


def wake_conditions(e):
    """A waiting entry's wait_for as a dict: reviews (count), push (the head
    it waits to move from), landing (when the landing wait ends), ci, until."""
    return dict(t.partition("=")[::2] for t in (e.get("wait_for") or "-").split(",") if t and t != "-")


def describe_wait(e):
    w, parts = wake_conditions(e), []
    if "reviews" in w:
        parts.append(f"{w['reviews']} review(s) by others")
    if "push" in w:
        parts.append(f"a push past {w['push']}")
    if "landing" in w:
        parts.append(f"the landing wait ({w['landing']})")
    if "ci" in w:
        parts.append("green CI at the head")
    if "until" in w:
        parts.append(w["until"])
    return f"since {e.get('wait_since')}, wakes on " + (" or ".join(parts) or "unhold only")


def hold(e, conditions, since, note):
    """Move an entry to waiting and drop its inputs: on wake it is planned
    again, and others' reviews or a push make the old review stale anyway."""
    e["state"], e["wait_since"], e["note"], e["lease"] = "waiting", since, note, "-"
    e["wait_for"] = ",".join(f"{k}={v}" if v else k for k, v in conditions.items()) or "-"
    save(e)
    drop_inputs(e["pr"])


def wake(e, why):
    """End a hold. The entry is done, so plan puts the PR back in its lane."""
    e["state"], e["note"] = "done", "woke: " + "; ".join(why)
    save(e)


def landing_gates(d, n):
    """The landing gates still closed at the PR's head, as wake conditions:
    the landing wait, and green CI from the cq CI cache."""
    gates = {}
    at = landing_at(d.get("createdAt"), {l["name"] for l in d["labels"]["nodes"]})
    if at and at > now():
        gates["landing"] = iso(at)
    r = read_ci().get(n)
    if not (ci_at(r, d["headRefOid"]) and r["ok"]):
        gates["ci"] = ""
    return gates


def wake_reasons(e, d):
    """Which of a waiting entry's wake conditions have happened."""
    w, why, head = wake_conditions(e), [], d["headRefOid"]
    since = parse_iso(e.get("wait_since")) or now()
    if w.get("push") and not head.startswith(w["push"]):
        why.append(f"new push {head[:12]}")
    if "reviews" in w:
        # Distinct reviewers other than me and the author, any review state.
        who = {(r.get("author") or {}).get("login") for r in (d.get("allReviews") or {}).get("nodes", [])
               if (parse_iso(r.get("submittedAt")) or since) > since}
        who -= {me(), (d.get("author") or {}).get("login"), None}
        if len(who) >= int(w["reviews"] or 1):
            why.append(f"reviewed by {', '.join(sorted(who))}")
    if "landing" in w:
        # Recomputed each sync: a fast-track label can end it early.
        at = landing_at(d.get("createdAt"), {l["name"] for l in d["labels"]["nodes"]})
        if at and at <= now():
            why.append("landing wait over")
    if "ci" in w:
        r = read_ci().get(e["pr"])
        if ci_at(r, head) and r["ok"]:
            why.append(f"CI green at {head[:12]}")
    if w.get("until") and parse_iso(w["until"]) <= now():
        why.append(f"hold until {w['until']} passed")
    return why


def prefetch(n):
    """Everything a preparing agent needs, so it never calls gh itself. The
    new dossier and ref replace the old ones only after the fetched head
    matches GitHub's, so a failed prefetch leaves an earlier one intact."""
    n = str(int(n))
    pr = gh("pr", "view", n, "--repo", REPO, "--json",
            "number,title,body,author,baseRefName,headRefOid,reviewDecision,labels,mergeable,"
            "mergeStateStatus,files,commits,createdAt,updatedAt,isDraft,state")
    info = json.loads(pr)
    if info.get("state") != "OPEN" or info.get("isDraft"):
        # The cached candidate can be up to REFRESH_MINUTES old.
        die(f"{n} is {'a draft' if info.get('isDraft') else info.get('state', '?').lower()}; not preparing it", 4)

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
    gates = write_gates(n, new, info, head, tmp_ref)
    if METADATA == "all" or (METADATA == "cq" and lane == "cq"):
        # After the gh calls: git node metadata calls GitHub and Jenkins itself.
        (new / "metadata.txt").write_text(ncu_metadata(n))
    (new / "meta.json").write_text(json.dumps({
        "pr": n, "head": head, "ref": f"refs/review-bank/{n}", "lane": lane,
        "rereview_from": rf, "clone": str(CLONE), "fetched_at": iso(now())}, indent=1))
    # The diff, discussion, and CI were read after the fetch. A push in
    # between would mix two heads in one dossier.
    now_head = gh("pr", "view", n, "--repo", REPO, "--json", "headRefOid", "--jq", ".headRefOid").strip()
    if now_head != head:
        die(f"{n}: head moved to {now_head[:12]} while fetching; rerun")

    # Order: dossier into place, entry saved, then the ref, then the old
    # dossier removed. A failure part way leaves the old dossier beside the
    # new one, never a ref or entry that points at a missing dossier.
    with entry_lock(n):
        d = DOSSIER / n
        gone = d.with_name(f".{n}.old-{os.getpid()}")
        if d.exists():
            d.rename(gone)
        new.rename(d)
        e = load(n)
        if e and e.get("state") in ("done", "stale", "waiting") and e.get("body", "").strip():
            # Keep the earlier review for reference; the new one starts clean.
            ARCHIVE.joinpath(f"{n}-{e.get('head', '-')[:12]}.md").write_text(entry_path(n).read_text())
        if not e or e.get("state") in ("done", "stale", "waiting"):
            e = {"pr": n, "created_at": iso(now()), "disposition": "-",
                 "my_teams": (e or {}).get("my_teams")}
        e.update(url=f"https://github.com/{REPO}/pull/{n}", title=info["title"],
                 author=(info.get("author") or {}).get("login") or "ghost", state="preparing",
                 head=head, pr_head=head, updated_at=info["updatedAt"], lease=iso(now()), lane=lane,
                 my_teams=cand.get("my_teams") or e.get("my_teams"), rereview_from=rf)
        save(e)
        git("update-ref", f"refs/review-bank/{n}", tmp_ref)
        shutil.rmtree(gone, ignore_errors=True)
    print(f"{n}: dossier {d}\n  ref refs/review-bank/{n} = {head[:12]}, lane {lane}, state preparing")
    print("  " + ci.stdout.strip().splitlines()[0] if ci.stdout.strip() else "  ci: no output")
    print(f"  gates: {gates}")


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


METADATA = os.environ.get("BANK_METADATA", "cq")  # which lanes get metadata.txt: cq, all, or off
METADATA_TIMEOUT = 180
PASSING = {"SUCCESS", "SKIPPED", "NEUTRAL"}
GATES_QUERY = """query{repository(owner:"%s",name:"%s"){pullRequest(number:%s){
 reviewDecision
 commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){totalCount nodes{__typename
  ...on CheckRun{name status conclusion detailsUrl checkSuite{workflowRun{workflow{name}}}}
  ...on StatusContext{context state targetUrl}}}}}}}
 timelineItems(last:100,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_COMMIT]){totalCount nodes{__typename
  ...on HeadRefForcePushedEvent{createdAt actor{login} beforeCommit{oid} afterCommit{oid}}
  ...on PullRequestCommit{commit{oid committedDate messageHeadline checkSuites(first:1){nodes{createdAt}}}}}}
 reviewRequests(first:50){nodes{requestedReviewer{__typename ...on Team{slug} ...on User{login}}}}
 latestOpinionatedReviews(first:100){nodes{author{login} state submittedAt commit{oid} onBehalfOf(first:20){nodes{slug}}}}
}}}"""


def nodes(d, key):
    return ((d or {}).get(key) or {}).get("nodes") or []


def write_gates(n, new, info, head, ref):
    """gates.json (check runs and statuses on the head, reviews, code owners)
    and timeline.json (pushes) from one GraphQL query and the clone's
    CODEOWNERS. A failed query is recorded in both files and doesn't stop the
    prefetch. Returns a one-line summary."""
    at, err = iso(now()), None
    try:
        pr = graphql(GATES_QUERY % (OWNER, NAME, n)).get("pullRequest")
        if not pr:
            raise RuntimeError("pull request not found")
    except RuntimeError as e:
        pr, err = {}, str(e)

    commit = (nodes(pr, "commits") or [{}])[0].get("commit") or {}
    roll = commit.get("statusCheckRollup") or {}
    runs = []
    for c in nodes(roll, "contexts"):
        if c.get("__typename") == "CheckRun":
            wf = (((c.get("checkSuite") or {}).get("workflowRun") or {}).get("workflow") or {}).get("name")
            runs.append({"name": c.get("name"), "workflow": wf, "result": c.get("conclusion") or c.get("status"),
                         "url": c.get("detailsUrl")})
        else:  # a commit status, such as Jenkins
            runs.append({"name": c.get("context"), "workflow": None, "result": c.get("state"),
                         "url": c.get("targetUrl")})
    total = (roll.get("contexts") or {}).get("totalCount", 0)
    counts = {}
    for r in runs:
        counts[r["result"]] = counts.get(r["result"], 0) + 1
    not_passing = [r for r in runs if r["result"] not in PASSING]

    reviews = [{"author": (r.get("author") or {}).get("login") or "ghost", "state": r.get("state"),
                "commit": (r.get("commit") or {}).get("oid"), "at": r.get("submittedAt"),
                "on_behalf_of": [f"@{OWNER}/{t['slug']}" for t in nodes(r, "onBehalfOf")]}
               for r in nodes(pr, "latestOpinionatedReviews")]
    requested = []
    for r in nodes(pr, "reviewRequests"):
        who = r.get("requestedReviewer") or {}
        requested.append(f"@{OWNER}/{who['slug']}" if who.get("slug") else f"@{who.get('login')}")

    co = code_owners(info.get("baseRefName") or "main", ref, head, [f["path"] for f in info.get("files") or []])
    for o, v in co.get("owners", {}).items():
        v["status"] = "unknown: the query failed" if err else owner_status(o, reviews, requested)

    gates = {"head": head, "fetched_at": at, "error": err, "reviewDecision": pr.get("reviewDecision"),
             "checks": {"commit": commit.get("oid"), "state": roll.get("state"), "total": total,
                        "truncated": total > len(runs), "counts": counts, "not_passing": not_passing,
                        "all": [{k: r[k] for k in ("name", "workflow", "result")} for r in runs]},
             "reviews": reviews, "review_requests": requested, "codeowners": co}
    (new / "gates.json").write_text(json.dumps(gates, indent=1))

    events = []
    for t in nodes(pr, "timelineItems"):
        if t.get("__typename") == "HeadRefForcePushedEvent":
            events.append({"type": "force-push", "at": t.get("createdAt"),
                           "actor": (t.get("actor") or {}).get("login"),
                           "before": (t.get("beforeCommit") or {}).get("oid"),
                           "after": (t.get("afterCommit") or {}).get("oid")})
        elif t.get("__typename") == "PullRequestCommit":
            c = t.get("commit") or {}
            suites = nodes(c, "checkSuites")
            events.append({"type": "commit", "oid": c.get("oid"), "headline": c.get("messageHeadline"),
                           "committed_at": c.get("committedDate"),
                           "first_check_at": suites[0].get("createdAt") if suites else None})
    forced = [e for e in events if e["type"] == "force-push" and e["after"] == head]
    first = [e["first_check_at"] for e in events if e["type"] == "commit" and e["oid"] == head and e["first_check_at"]]
    pushed = ({"at": forced[-1]["at"], "source": "force-push event"} if forced else
              {"at": first[0], "source": "first check suite on the head (approximate)"} if first else
              {"at": None, "source": "unknown"})
    ttotal = (pr.get("timelineItems") or {}).get("totalCount", 0)
    (new / "timeline.json").write_text(json.dumps({
        "head": head, "fetched_at": at, "error": err, "head_pushed_at": pushed,
        "note": ("GitHub no longer reports commit push times. first_check_at is when the first check suite "
                 "for a commit was created, close to when it was pushed as the PR head; null means it was "
                 "pushed under a later commit or got no checks. committed_at is the committer date, which a "
                 "rebase resets. Events are oldest first, the last 100 only."),
        "total": ttotal, "truncated": ttotal > len(events), "events": events}, indent=1))

    if err:
        return f"query FAILED ({err[:120]}); see gates.json"
    unapproved = [o for o, v in co.get("owners", {}).items() if not v["status"].startswith("approved")]
    return (f"reviewDecision {pr.get('reviewDecision') or '-'}, checks {roll.get('state') or '-'} "
            f"({len(not_passing)} not passing), code owners without an approval: {' '.join(unapproved) or 'none'}")


def owner_status(owner, reviews, requested):
    """Whether a code owner has reviewed. A team counts only through a review
    made on its behalf, which GitHub records when the team was requested."""
    mine = [r for r in reviews if owner in r["on_behalf_of"] or owner == f"@{r['author']}"]
    ok = [r["author"] for r in mine if r["state"] == "APPROVED"]
    if ok:
        return f"approved by {', '.join(ok)}"
    if mine:
        return f"{mine[0]['state'].lower()} by {mine[0]['author']}"
    if owner in requested:
        return "requested, no review on its behalf yet"
    return "not requested, no review on its behalf (a member may have reviewed without the request)"


def code_owners(base, ref, head, paths):
    """The owners of each changed path, from .github/CODEOWNERS on the base
    branch (the one GitHub applies), else at the PR head. The last matching
    line wins, as on GitHub."""
    for src, label in ((f"refs/remotes/upstream/{base}", f"upstream/{base}"), (ref, f"PR head {head[:12]}")):
        text = git("show", f"{src}:.github/CODEOWNERS", check=False)
        if text:
            break
    else:
        return {"source": None, "error": "no .github/CODEOWNERS on the base branch or at the PR head"}
    rules = []
    for line in text.splitlines():
        parts = line.split("#", 1)[0].split()
        if parts:
            rules.append((codeowners_re(parts[0]), parts[1:]))
    owners, unowned = {}, []
    for p in paths:
        hit = next((o for rx, o in reversed(rules) if rx.fullmatch(p)), None)
        if hit is None:
            unowned.append(p)
        for o in hit or []:
            owners.setdefault(o, {"paths": []})["paths"].append(p)
    return {"source": f"{label}:.github/CODEOWNERS", "owners": owners, "unowned_paths": unowned,
            "files_maybe_truncated": len(paths) >= 100,
            "note": "pattern matching approximates GitHub's; check a surprising owner against the file"}


def codeowners_re(pat):
    """A CODEOWNERS pattern as a regex over repository paths. A leading or
    inner / anchors it to the root, * stays within a directory, ** crosses
    them, and a pattern ending in * matches only files directly under it (as
    GitHub documents). A match on a directory covers everything below it."""
    anchored = "/" in pat.rstrip("/")
    p, out, i = pat.strip("/"), "", 0
    while i < len(p):
        if p.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif p.startswith("**", i):
            out, i = out + ".*", i + 2
        else:
            out += {"*": "[^/]*", "?": "[^/]"}.get(p[i], re.escape(p[i]))
            i += 1
    return re.compile(("" if anchored else "(?:.*/)?") + out + ("" if p.endswith("*") else "(?:/.*)?"))


def ncu_metadata(n):
    """git node metadata (node-core-utils), read-only: approvals by name, the
    last Jenkins CI, failed GitHub Actions jobs, and the generated commit
    metadata. It calls GitHub with its own token, not gh, so it holds the gh
    shim's lock to stay serial with every gh call. The shim locks with
    zsystem flock, which is an fcntl lock, so this uses lockf, not Flock.
    Never raises: a failure is written to the file."""
    lock = Path(os.environ.get("GH_SHIM_LOCK") or LOCKS / "gh.lock")
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.lockf(fd, fcntl.LOCK_EX)
        try:
            p = subprocess.run(["git", "node", "metadata", n, "--owner", OWNER, "--repo", NAME],
                               cwd=CLONE if CLONE.is_dir() else None, env=ENV, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=METADATA_TIMEOUT)
            out, err, status = p.stdout, p.stderr, f"exit {p.returncode}"
        except subprocess.TimeoutExpired as e:
            dec = lambda b: b.decode(errors="replace") if isinstance(b, bytes) else (b or "")
            out, err, status = dec(e.stdout), dec(e.stderr), f"timed out after {METADATA_TIMEOUT}s"
        except OSError as e:
            out, err, status = "", str(e), "could not run"
        lock.with_name(lock.name + ".last").write_text(f"{time.time()}\n")  # the shim's GH_MIN_GAP
    finally:
        os.close(fd)
    # The report goes to stderr and the generated metadata to stdout, which
    # the report already repeats.
    text = err if out.strip() and out.strip() in err else err + out
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text).replace("\r\n", "\n").replace("\r", "\n")
    lines = [l for l in text.splitlines() if not re.match(r"\s*[\u2800-\u28ff]", l)]  # spinner frames
    return "\n".join(lines) + f"\n(git node metadata {status}, {iso(now())})\n"


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


# Image freshness. Slot builds start from the devcontainer image's prebuilt
# out/, so the image's age sets the cost of every first build. The tick pulls a
# newer nightly when no slot is held, then moves free slots to it one at a time
# (devc.sh down, then build). Both run in the background. Neither touches a held
# slot: a move holds its slot itself, as owner image-move.

def devc_info(path):
    """devc.sh image in a checkout, as a dict, or None when it fails."""
    try:
        p = subprocess.run([str(NC / "devc.sh"), "image"], cwd=path, env=ENV, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if p.returncode != 0:
        return None
    return dict(l.split("=", 1) for l in p.stdout.splitlines() if "=" in l)


def read_cache_json(name):
    try:
        return json.loads((CACHE / name).read_text())
    except (OSError, ValueError):
        return {}


def recent(t):
    """Whether ISO time t is under IMAGE_CHECK_MINUTES ago."""
    t = parse_iso(t) if t else None
    return bool(t) and (now() - t).total_seconds() < IMAGE_CHECK_MIN * 60


def parse_stamp(s):
    """The UTC time at the start of an engine or Docker Hub timestamp
    (2026-11-19 03:59:40.16 +0000 UTC, 2026-11-20T04:31:57.43Z)."""
    m = re.match(r"(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)", s or "")
    return parse_iso(f"{m[1]}T{m[2]}Z") if m else None


def hub_url():
    if os.environ.get("DEVC_HUB_URL"):
        return os.environ["DEVC_HUB_URL"]
    m = re.fullmatch(r"(?:docker\.io/)?([\w.-]+)/([\w.-]+):([\w.-]+)", DEVC_IMAGE)
    return f"https://hub.docker.com/v2/repositories/{m[1]}/{m[2]}/tags/{m[3]}" if m else None


def hub_info():
    """Docker Hub's view of the tag (its digests and last_updated), fetched at
    most every IMAGE_CHECK_MINUTES. A failed fetch keeps the last good result."""
    old = read_cache_json("image-hub.json")
    if recent(old.get("checked_at")):
        return old
    url = hub_url()
    if not url:
        return {"error": f"{DEVC_IMAGE} is not a Docker Hub tag"}
    info = {"checked_at": iso(now())}
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            d = json.load(r)
        info.update(digests=[d["digest"]] + [i["digest"] for i in d.get("images") or [] if i.get("digest")],
                    last_updated=d["last_updated"])
    except (OSError, ValueError, KeyError, TypeError) as err:
        info.update({k: old[k] for k in ("digests", "last_updated") if k in old}, error=str(err)[:120])
    write_atomic(CACHE / "image-hub.json", json.dumps(info))
    return info


def image_newer(local, hub):
    """Whether Docker Hub's tag is another image, pushed after the local one was
    built. Either the index digest or a per-platform one can be local."""
    mine = {d.rpartition("@")[2] for d in local.get("image_digests", "").split()}
    if not hub.get("digests") or mine & set(hub["digests"]):
        return False
    built, pushed = parse_stamp(local.get("image_created")), parse_stamp(hub.get("last_updated"))
    return bool(pushed) and (not built or pushed > built)


def running(name):
    """Whether a background worker holds Flock(name)."""
    lock = Flock(name)
    if lock.acquire(wait=False):
        lock.release()
        return False
    return True


def worker_lock(name):
    """Flock(name) for a worker, retried briefly: a tick probing it with
    running() holds it for a moment."""
    lock = Flock(name)
    for _ in range(20):
        if lock.acquire(wait=False):
            return lock
        time.sleep(0.5)
    return None


def spawn(args, log):
    """Start bank.py <args> detached from this process, logging to cache/<log>."""
    with open(CACHE / log, "w") as f:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), *args], env=ENV,
                         stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)


def reclaim_moves():
    """Free a slot still held for a move whose worker is gone."""
    if running("image-move"):
        return []
    out = []
    with Flock("slots"):
        for name, _ in slots():
            h = SlotLock(name).holder()
            if h and h.get("owner") == MOVE and (now() - parse_iso(h["at"])).total_seconds() > SLOT_OWNERLESS_GRACE:
                SlotLock(name).release()
                out.append(f"slot {name}: its move worker is gone; released")
    return out


def image_tick():
    """Pull a newer nightly when no slot is held, then move one free slot that
    is on an older image. Returns report lines."""
    out = reclaim_moves()
    rows = [(name, path, SlotLock(name).holder()) for name, path in slots() if Path(path).exists()]
    info = {name: devc_info(path) for name, path, _ in rows}
    first = next(((name, path) for name, path, _ in rows if info[name]), None)
    if not first:
        return out + ["no slot checkout answered devc.sh image; skipped"]
    local = info[first[0]]
    if local.get("image_id", "missing") == "missing":
        return out + [f"{DEVC_IMAGE} not found (missing, or the engine is down); a pull needs the user (about 10 GB)"]
    hub = hub_info()
    line = f"local {local['image_id']} built {(local.get('image_created') or '?')[:16]}"
    if hub.get("last_updated"):
        line += f", Docker Hub updated {hub['last_updated'][:16]}"
    if hub.get("error"):
        line += f" (check failed: {hub['error'][:80]})"
    held = [f"slot {n} for #{h['pr']}" for n, _, h in rows if h]
    last = read_cache_json("image-pull.json")
    log = CACHE / "image-pull.log"
    if running("image-pull"):
        return out + [f"{line}; pull running since {last.get('started_at', '?')} (log {log})"]
    if not hub.get("digests"):
        out.append(f"{line}; not compared")
    elif not image_newer(local, hub):
        out.append(f"{line}; current")
    elif held:
        # No moves either: they would rebuild on an image the pull replaces.
        return out + [f"{line}; newer on Docker Hub, the pull and any moves wait until no slot is held "
                      f"({', '.join(held)})"]
    elif recent(last.get("started_at")):
        how = f"exited {last['rc']}" if "rc" in last else "did not finish"
        out.append(f"{line}; newer on Docker Hub, but the pull at {last['started_at']} {how}; "
                   f"retried {IMAGE_CHECK_MIN} minutes after it (log {log})")
    else:
        write_atomic(CACHE / "image-pull.json", json.dumps(
            {"started_at": iso(now()), "from": local["image_id"], "path": first[1]}))
        spawn(["image", "run-pull", first[1]], log.name)
        return out + [f"{line}; newer on Docker Hub, pulling in the background (about 2 minutes, log {log})"]
    return out + move_one(rows, info, local["image_id"])


def move_one(rows, info, image):
    """Hold one free slot whose container is on an older image as image-move,
    and move it in the background. One at a time, so other slots stay free."""
    moving = [(n, h) for n, _, h in rows if h and h.get("owner") == MOVE]
    if moving:
        n, h = moving[0]
        return [f"slot {n}: moving to {h.get('to', '?')} since {h['at']} (log {CACHE / f'image-move-{n}.log'})"]
    moves, out = read_cache_json("image-moves.json"), []
    for name, path, h in rows:
        i = info.get(name)
        if not i or i.get("outdated") != "yes":
            continue
        ok, dirty, at = checkout_state(path)
        last = moves.get(name) or {}
        why = (f"held for #{h['pr']}" if h else
               "git status failed" if not ok else
               "checkout has changes" if dirty else
               f"checkout is on {at}, not main" if at not in ("main", "HEAD") else
               "something runs in its container" if i.get("busy") != "no" else
               f"the move at {last['at']} failed at {last.get('step')}" if
               last.get("to") == image and last.get("rc") and recent(last.get("at")) else None)
        if not why:
            with Flock("slots"):
                got = SlotLock(name).acquire({"pr": MOVE, "owner": MOVE, "at": iso(now()),
                                              "from": i["container_image"], "to": image})
            if got:
                spawn(["image", "run-move", name], f"image-move-{name}.log")
                return out + [f"slot {name}: moving from {i['container_image']} to {image} in the background "
                              f"(devc.sh down, then build: about 3 to 5 minutes)"]
            why = "acquired meanwhile"
        out.append(f"slot {name}: on older image {i['container_image']}; the move waits ({why})")
    return out


def run_pull(path):
    """Background worker: devc.sh pull, with the result in cache/image-pull.json."""
    lock = worker_lock("image-pull")
    if not lock:
        die("another pull is running", 0)
    print(f"=== devc.sh pull in {path} @ {iso(now())}", flush=True)
    rc = subprocess.run([str(NC / "devc.sh"), "pull"], cwd=path, env=ENV).returncode
    rec = read_cache_json("image-pull.json")
    rec.update(rc=rc, finished_at=iso(now()))
    write_atomic(CACHE / "image-pull.json", json.dumps(rec))
    print(f"=== exit {rc} @ {iso(now())}")


def run_move(name):
    """Background worker: down and build in a slot held as image-move, then
    release it. Checks again that nothing runs in the container first."""
    path = dict(slots()).get(name)
    lock = worker_lock("image-move")
    h = SlotLock(name).holder()
    rec = {"at": iso(now()), "from": (h or {}).get("from"), "to": (h or {}).get("to")}
    try:
        if not h or h.get("owner") != MOVE:
            print(f"slot {name} is not held for a move; nothing to do")
            return
        i = devc_info(path) if lock and path else None
        if not i or i.get("outdated") != "yes" or i.get("busy") != "no":
            rec.update(step="check", rc=0 if i and i.get("outdated") == "no" else 1)
            print(f"not moving slot {name}: " + ("no longer outdated" if rec["rc"] == 0 else
                  "another move is running" if not lock else "devc.sh image failed, or something runs in it"))
        else:
            for step in ("down", "build"):
                print(f"=== devc.sh {step} in {path} @ {iso(now())}", flush=True)
                rec.update(step=step, rc=subprocess.run([str(NC / "devc.sh"), step], cwd=path, env=ENV).returncode)
                if rec["rc"]:
                    break
        moves = read_cache_json("image-moves.json")
        moves[name] = dict(rec, finished_at=iso(now()))
        write_atomic(CACHE / "image-moves.json", json.dumps(moves))
        print(f"=== slot {name}: {rec.get('step')} exit {rec.get('rc')} @ {iso(now())}")
    finally:
        with Flock("slots"):
            if (SlotLock(name).holder() or {}).get("owner") == MOVE:
                SlotLock(name).release()


def behind_main(commit):
    """Commits on upstream/main, as last fetched, since commit, or ?."""
    if not re.fullmatch(r"[0-9a-f]{7,40}", commit or ""):
        return "?"
    p = subprocess.run(["git", "-C", str(CLONE), "rev-list", "--count", f"{commit}..refs/remotes/upstream/main"],
                       text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return p.stdout.strip() if p.returncode == 0 else "?"


def image_cmd(args):
    if args[:1] == ["prune"]:
        # Only free slots, and devc.sh prune keeps the volumes of the local
        # image and of the slot's container. Other checkouts' volumes never match.
        for name, path in slots():
            h = SlotLock(name).holder()
            if h or not Path(path).exists():
                print(f"slot {name}: {'held for #' + h['pr'] if h else 'missing'}, skipped")
                continue
            p = subprocess.run([str(NC / "devc.sh"), "prune"], cwd=path, env=ENV, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            print(f"slot {name}: " + (p.stdout.strip() or "nothing to remove").replace("\n", "\n  "))
        return
    if args[:1] == ["run-pull"] and len(args) == 2:
        return run_pull(args[1])
    if args[:1] == ["run-move"] and len(args) == 2:
        return run_move(args[1])
    die("usage: image prune", 2)


def slot_cmd(args):
    if not args or args[0] == "status":
        hub = read_cache_json("image-hub.json")
        if hub.get("last_updated"):
            print(f"image: Docker Hub updated {hub['last_updated'][:16]} (checked {hub.get('checked_at')})"
                  + (", pull running" if running("image-pull") else ""))
        for name, path in slots():
            lock = SlotLock(name)
            h, since = lock.holder(), lock.ownerless_since()
            held = (f"moving to image {h.get('to')} since {h['at']}" if h and h.get("owner") == MOVE else
                    f"held for #{h['pr']} by {h['owner']} since {h['at']}" if h else
                    f"lock has no owner record since {iso(since)} (reclaimed after {SLOT_OWNERLESS_GRACE}s)"
                    if since else "free")
            if not Path(path).exists():
                print(f"slot {name}: {path} MISSING ({held})")
                continue
            ok, dirty, at = checkout_state(path)
            flag = ", DIRTY" if dirty else "" if ok else ", GIT STATUS FAILED"
            print(f"slot {name}: {path} [{at}{flag}] {held}")
            i = devc_info(path)
            if not i:
                print("  image: devc.sh image failed")
            elif i.get("container_state") == "none":
                print(f"  image: no container (local image {i.get('image_id')})")
            else:
                print(f"  image: {i.get('container_image')} built from {i.get('image_commit', '-')[:12]} "
                      f"({behind_main(i.get('image_commit'))} commits behind upstream/main)"
                      + (f", OUTDATED: local image is {i.get('image_id')}" if i.get("outdated") == "yes" else ""))
        return
    if args[0] == "acquire":
        want, pr = args[1], args[2]
        owner = args[3] if len(args) > 3 else "orchestrator"
        reclaim_moves()
        # Prefer a slot whose container is on the local image.
        info = {n: devc_info(p) for n, p in slots()
                if want in ("any", n) and Path(p).exists() and not SlotLock(n).holder()}
        order = sorted(slots(), key=lambda s: (info.get(s[0]) or {}).get("outdated") == "yes")
        with Flock("slots"):
            if any(h and h["pr"] == pr for h in (SlotLock(s).holder() for s, _ in slots())):
                die(f"#{pr} already holds a slot; never run one PR in two slots (repro.sh uses a shared repro-{pr} branch)")
            for name, path in order:
                if want not in ("any", name) or not Path(path).exists():
                    continue
                ok, dirty, _ = checkout_state(path)
                if not ok or dirty:
                    print(f"slot {name}: {'git status failed' if not ok else 'dirty'}, skipped", file=sys.stderr)
                    continue
                if SlotLock(name).acquire({"pr": pr, "owner": owner, "at": iso(now())}):
                    print(f"{name}\t{path}")
                    i = info.get(name) or {}
                    if i.get("outdated") == "yes":
                        print(f"slot {name}: its container is on image {i.get('container_image')}, older than the "
                              f"local {i.get('image_id')}; a tick moves it once it's free", file=sys.stderr)
                    return
        die("no free slot", 3)
    if args[0] == "release":
        force = "--force" in args
        rest = [a for a in args[1:] if a != "--force"]
        name, pr = rest[0], (rest[1] if len(rest) > 1 else None)
        path = dict(slots()).get(name)
        if path is None:
            die(f"no slot {name}")
        if pr is None and not force:
            die(f"usage: slot release {name} <pr> (the PR it was acquired for), or --force")
        ok, dirty, at = checkout_state(path)
        if (dirty or not ok) and not force:
            die(f"slot {name} has changes; restore them (git checkout -- <file>) first:\n{dirty}" if ok else
                f"slot {name}: git status failed in {path}; check it, then release with --force")
        with Flock("slots"):
            h = SlotLock(name).holder()
            # A repeated release (after a context reset, say) must not free a
            # slot another agent has since acquired.
            if h and pr is not None and h["pr"] != pr and not force:
                die(f"slot {name} is held for #{h['pr']} by {h['owner']}, not #{pr}; not released")
            SlotLock(name).release()
        print(f"slot {name} released, at {at}" + ("" if at in ("main", "HEAD") else " (expected main)"))
        return
    die("usage: slot status | acquire <slot|any> <pr> [owner] | release <slot> <pr> | release <slot> --force", 2)


def show(e, header_only=False):
    moved = "" if e.get("pr_head") in (None, "-", e.get("head")) else f", HEAD MOVED to {e['pr_head'][:12]}"
    print(f"#{e['pr']} [{e['lane']}] {e['state']}: {e['title']}\n  {e['url']}\n"
          f"  prepared against {e['head'][:12]} at {e.get('prepared_at', '-')}{moved}"
          + (f"\n  teams: {e['my_teams']}" if e.get("my_teams") not in (None, "-") else "")
          + (f"\n  disposition: {e['disposition']} at {e['disposition_at']}" if e["disposition"] != "-" else "")
          + (f"\n  waiting {describe_wait(e)}" if e["state"] == "waiting" else "")
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
        extra = f" needs-run={e['needs_run']}" if e["state"] == "needs-run" else \
            f" ({describe_wait(e)})" if e["state"] == "waiting" else ""
        disp = f" -> {e['disposition']}" if e["state"] == "done" else ""
        print(f"  {e['state']:<9} {e['lane']:<13} https://github.com/{REPO}/pull/{e['pr']}{extra}{snz}{disp}  {e['title'][:60]}")


def put(n, summary, head=None):
    """Bank a verified summary. `head` is the head the draft was prepared
    against (the prefetch line the agent was given); without it, the
    dossier's meta.json. A draft for another head, or for an entry that is no
    longer being prepared, is refused, so a late agent can't revive a done
    entry, take over a newer preparation, or demote a presented one."""
    body = Path(summary).read_text()
    m = re.search(r"^#+ *Needs a run\s*\n(.*?)(?=^#|\Z)", body, re.S | re.M)
    pending = len(re.findall(r"^\s*- ", m.group(1), re.M)) if m else 0
    with entry_lock(n):
        e = load(n) or die(f"no entry for {n}; prefetch it first")
        if e["state"] not in ("preparing", "needs-run"):
            die(f"#{n} is {e['state']}, not preparing or needs-run; not banked", 5)
        if not head:
            try:
                head = json.loads((DOSSIER / str(n) / "meta.json").read_text())["head"]
            except (OSError, ValueError, KeyError):
                die(f"#{n}: no dossier meta.json to check the head against; pass --head <sha>", 5)
        if len(head) < 7 or not e["head"].startswith(head):
            die(f"#{n}: the draft is for {head[:12]}, but the entry is now prepared against "
                f"{e['head'][:12]}; not banked (prepare it again)", 5)
        e["body"] = body
        e["needs_run"] = str(pending)
        e["prepared_at"] = iso(now())
        e["lease"] = "-"
        e["note"] = "-"
        e["state"] = "needs-run" if pending else "ready"
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
            # A sync or set may have changed it while this waited for the lock.
            if e["state"] not in ("ready", "needs-run") or snoozed(e):
                die(f"#{e['pr']} changed to {e['state']} while presenting; run present again", 6)
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
        if e["state"] == "done":
            # Always through finish, so the dossier and ref are cleaned up.
            finish(e, e["disposition"], e.get("disposition_at") if e.get("disposition_at") not in (None, "-") else None)
        else:
            save(e)
    show(e, header_only=True)


def hold_cmd(n, args):
    """Hold a PR until others review it, it gets a push, or --until passes.
    Works for a candidate with no entry yet. No GitHub call: the push
    condition uses the latest head the bank has seen."""
    n, until, reviews, note = str(int(n)), None, "1", []
    while args:
        a = args.pop(0)
        if a in ("--until", "--until-reviews") and not args:
            die(f"{a} needs a value", 2)
        if a == "--until":
            try:
                until = iso(parse_iso(args.pop(0)))
            except (ValueError, TypeError):
                die(f"--until must be an ISO time such as {iso(now())}", 2)
        elif a == "--until-reviews":
            reviews = args.pop(0)
            if not reviews.isdigit():
                die("--until-reviews must be a count, 0 for none", 2)
        else:
            note.append(a)
    with entry_lock(n):
        e = load(n)
        if not e:
            c = {c["pr"]: c for c in ranked_candidates()}.get(n) or \
                die(f"#{n} is neither in the bank nor a candidate; nothing to hold")
            e = {"pr": n, "url": f"https://github.com/{REPO}/pull/{n}", "title": c.get("title") or "-",
                 "author": c.get("author") or "-", "lane": c["lane"], "head": c["head"], "pr_head": c["head"],
                 "created_at": iso(now()), "updated_at": c["updated"], "my_teams": c.get("my_teams"),
                 "rereview_from": c.get("rereview_from"), "disposition": "-"}
        head = e["pr_head"] if e.get("pr_head") not in (None, "-") else e["head"]
        w = {"reviews": reviews} if int(reviews) else {}
        w["push"] = head[:12]
        if until:
            w["until"] = until
        hold(e, w, iso(now()), "held" + (f": {' '.join(note)}" if note else ""))
    show(e, header_only=True)


def unhold_cmd(n):
    with entry_lock(n):
        e = load(n) or die(f"no entry for {n}")
        if e["state"] != "waiting":
            die(f"#{n} is {e['state']}, not waiting")
        wake(e, ["unheld by hand"])
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
            try:
                for l in image_tick():
                    print(f"  image: {l}")
            except (RuntimeError, OSError, ValueError) as err:
                print(f"  image: check failed ({str(err)[:120]})")
        finally:
            lock.release()
        target = int(args[args.index("--target") + 1]) if "--target" in args else TARGET
        lines, counts = plan(target)
        list_cmd(False, target)
        print(f"plan: eligible candidates by lane: {counts}")
        print("\n".join(lines) or "plan: bank is full")
    elif cmd == "sync":
        print("\n".join(sync(set(args) or None)))
    elif cmd == "plan":
        target = int(args[args.index("--target") + 1]) if "--target" in args else TARGET
        lines, counts = plan(target, "--all" in args)
        print(f"plan: eligible candidates by lane: {counts}")
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
        hd = args[args.index("--head") + 1] if "--head" in args else None
        put(args[0], args[1], hd)
    elif cmd == "set":
        set_cmd(args[0], args[1:])
    elif cmd == "hold":
        hold_cmd(args[0], args[1:])
    elif cmd == "unhold":
        unhold_cmd(args[0])
    elif cmd == "slot":
        slot_cmd(args)
    elif cmd == "image":
        image_cmd(args)
    else:
        die(f"unknown command {cmd}", 2)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except RuntimeError as err:
        die(str(err))
