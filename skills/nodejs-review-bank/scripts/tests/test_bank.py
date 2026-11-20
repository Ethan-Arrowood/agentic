"""Offline tests for bank.py. Run from scripts/: python3 -m unittest discover -s tests

Each test gets a temporary bank, a fake gh on PATH (fake_gh.py), stub
sibling scripts, and, where needed, a temporary git clone with an upstream.
Nothing here touches the network or the real bank.
"""
import json, os, shutil, subprocess, sys, tempfile, time, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
BANK_PY = SCRIPTS / "bank.py"
RQ_REAL = (SCRIPTS / "../../nodejs-review-queue/scripts").resolve()
FIELDS = ["pr", "url", "title", "author", "lane", "state", "head", "pr_head", "acted_head", "created_at",
          "prepared_at", "presented_at", "updated_at", "my_teams", "rereview_from",
          "needs_run", "disposition", "disposition_at", "snooze_until", "lease", "note"]
A, B, C = "a" * 40, "b" * 40, "c" * 40


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def ago(**kw):
    return iso(datetime.now(timezone.utc) - timedelta(**kw))


def pr_node(n, head, state="OPEN", reviews=(), comments=(), labels=(), closed_at=None, draft=False, author="someone"):
    return {"number": n, "title": f"PR {n}", "state": state, "isDraft": draft, "updatedAt": ago(minutes=1),
            "closedAt": closed_at, "headRefOid": head, "author": {"login": author},
            "labels": {"nodes": [{"name": l} for l in labels]},
            "reviews": {"nodes": list(reviews)}, "comments": {"nodes": list(comments)},
            "timelineItems": {"nodes": []}}


class BankTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="bank-test-"))
        self.bank = self.tmp / "bank"
        self.fake = self.tmp / "fake"
        self.fake.mkdir()
        fakebin = self.tmp / "bin"
        fakebin.mkdir()
        shutil.copy(HERE / "fake_gh.py", fakebin / "gh")
        (fakebin / "gh").chmod(0o755)
        # Sibling skills: real lib.sh and discussion.sh, stubbed queue scripts.
        self.rq = self.tmp / "rq"
        self.rq.mkdir()
        for f in ("lib.sh", "discussion.sh"):
            (self.rq / f).symlink_to(RQ_REAL / f)
        self.queue_out, self.rereview_out = self.tmp / "queue.out", self.tmp / "rereview.out"
        self.queue_out.write_text("")
        self.rereview_out.write_text("")
        (self.rq / "build-queue.sh").write_text(f'#!/bin/zsh\ncat "{self.queue_out}"\nexit ${{QUEUE_RC:-0}}\n')
        (self.rq / "rereview.py").write_text(f'import sys\nsys.stdout.write(open("{self.rereview_out}").read())\n')
        self.nc = self.tmp / "nc"
        self.nc.mkdir()
        (self.nc / "ci-status.sh").write_text(
            '#!/bin/zsh\necho "#$1: ${FAKE_CI:-CI=SUCCESS  job=1  HEAD-MATCH}"\n')
        for p in (self.rq / "build-queue.sh", self.nc / "ci-status.sh"):
            p.chmod(0o755)
        self.env = dict(os.environ, NODE_REVIEW_BANK=str(self.bank), FAKE_GH_DIR=str(self.fake),
                        PATH=f"{fakebin}:{os.environ['PATH']}", ME="me", GH_MIN_GAP="0",
                        GH_RETRY_SLEEP="0", RQ_SCRIPTS=str(self.rq), NC_SCRIPTS=str(self.nc),
                        NODE_CLONE=str(self.tmp / "clone"), REFRESH_MINUTES="100000")
        for k in ("TERMINFO", "BANK_TARGET"):
            self.env.pop(k, None)
        self.rules([])

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ------------------------------------------------------------ helpers

    def rules(self, rules):
        (self.fake / "rules.json").write_text(json.dumps(rules))

    def calls(self):
        p = self.fake / "calls.log"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def run_bank(self, *args, check=True, timeout=60, env=None):
        p = subprocess.run([sys.executable, str(BANK_PY), *args], env=env or self.env, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if check and p.returncode != 0:
            self.fail(f"bank.py {' '.join(args)} exited {p.returncode}\n{p.stdout}\n{p.stderr}")
        return p

    def write_entry(self, pr, body="", **fields):
        e = {"pr": str(pr), "url": f"https://github.com/nodejs/node/pull/{pr}", "title": f"PR {pr}",
             "author": "someone", "lane": "fresh", "state": "ready", "head": A, "pr_head": A,
             "created_at": ago(hours=1), "disposition": "-", "needs_run": "0"}
        e.update(fields)
        (self.bank / "prs").mkdir(parents=True, exist_ok=True)
        head = "\n".join(f"{k}: {e.get(k) or '-'}" for k in FIELDS)
        (self.bank / "prs" / f"{pr}.md").write_text(f"---\n{head}\n---\n{body}")

    def entry(self, pr):
        text = (self.bank / "prs" / f"{pr}.md").read_text()
        front, _, body = text[4:].partition("\n---\n")
        meta = dict(l.split(": ", 1) for l in front.splitlines() if ": " in l)
        meta["body"] = body
        return meta

    def cache(self, name, text):
        (self.bank / "cache").mkdir(parents=True, exist_ok=True)
        (self.bank / "cache" / name).write_text(text)

    def sync_rule(self, *nodes, **extra):
        data = {f"p{n['number']}": n for n in nodes}
        rule = {"match": ["graphql", "headRefOid", "timelineItems"], "stdout": {"data": {"repository": data}}}
        rule.update(extra)
        return rule

    # ------------------------------------------------------------ sync

    def test_sync_does_not_clobber_a_concurrent_put(self):
        self.write_entry(5, state="preparing", lease=ago(minutes=5))
        gate = self.tmp / "gate"
        self.rules([self.sync_rule(pr_node(5, A), wait_file=str(gate))])
        sync = subprocess.Popen([sys.executable, str(BANK_PY), "sync"], env=self.env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(200):
            if Path(str(gate) + ".reached").exists():
                break
            time.sleep(0.1)
        summary = self.tmp / "summary.md"
        summary.write_text("## Summary\nverified\n")
        self.run_bank("put", "5", str(summary))
        gate.write_text("")
        out, err = sync.communicate(timeout=60)
        self.assertEqual(sync.returncode, 0, err)
        e = self.entry(5)
        self.assertEqual(e["state"], "ready")
        self.assertIn("verified", e["body"])

    def test_sync_finishes_a_pr_github_cannot_find(self):
        self.write_entry(5, state="ready")
        self.rules([{"match": ["graphql", "headRefOid"], "rc": 1, "stderr": "gh: Could not resolve to a PullRequest",
                     "stdout": {"data": {"repository": {"p5": None}},
                                "errors": [{"type": "NOT_FOUND", "path": ["repository", "p5"],
                                            "message": "Could not resolve to a PullRequest with the number of 5."}]}}])
        self.run_bank("sync")
        e = self.entry(5)
        self.assertEqual(e["state"], "done")
        self.assertEqual(e["disposition"], "not-found")

    def test_sync_records_landed_commit_and_close_time(self):
        self.write_entry(5, state="presented", lane="cq")
        closed = ago(minutes=30)
        self.rules([self.sync_rule(pr_node(5, A, state="CLOSED", closed_at=closed, comments=[
            {"author": {"__typename": "User", "login": "me"}, "createdAt": closed, "body": "Landed in 42800b60d33f"}]))])
        self.run_bank("sync")
        e = self.entry(5)
        self.assertEqual(e["disposition"], "landed 42800b60d33f")
        self.assertEqual(e["disposition_at"], closed)

    def test_an_action_on_an_old_head_lets_the_new_head_be_planned(self):
        self.write_entry(5, state="presented", lane="rereview", head=A, pr_head=A, created_at=ago(hours=2))
        self.rules([self.sync_rule(pr_node(5, B, reviews=[
            {"state": "APPROVED", "submittedAt": ago(minutes=10), "commit": {"oid": A}}]))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["state"], "done")
        self.cache("rereview.tsv", f"RE-REVIEW\t5\tAPPROVED\t{A}\t{A}\t{B}\t1\tMERGEABLE\t{ago(minutes=1)}\n")
        out = self.run_bank("plan").stdout
        self.assertIn("PREPARE 5 lane=rereview", out)

    # ------------------------------------------------------------ plan

    def test_an_approval_does_not_keep_a_pr_out_of_the_cq_lane(self):
        self.write_entry(5, state="done", lane="rereview", head=A, pr_head=A, acted_head=A,
                         disposition=f"approved @{A[:12]}", disposition_at=ago(minutes=10))
        self.cache("rereview.tsv", f"CQ-CANDIDATE\t5\tAPPROVED\t{A}\t{A}\t{A}\t2\tMERGEABLE\t{ago(minutes=1)}\n")
        self.cache("ci.json", json.dumps({"5": {"head": A, "ok": True, "line": "CI=SUCCESS HEAD-MATCH", "at": ago(minutes=1)}}))
        out = self.run_bank("plan").stdout
        self.assertIn("PREPARE 5 lane=cq", out)

    def test_a_cq_candidate_waits_for_green_ci_at_its_head(self):
        self.cache("rereview.tsv", f"CQ-CANDIDATE\t5\tAPPROVED\t{A}\t{A}\t{A}\t2\tMERGEABLE\t{ago(minutes=1)}\n")
        self.cache("ci.json", json.dumps({"5": {"head": A, "ok": False, "line": "CI=NO-RUN", "at": ago(minutes=1)}}))
        out = self.run_bank("plan", "--all").stdout
        self.assertNotIn("PREPARE 5", out)
        self.assertRegex(out, r"SKIP 5 lane=cq .*CI")

    def test_the_same_lane_and_head_is_not_planned_twice(self):
        self.write_entry(5, state="done", lane="rereview-asap", head=A, pr_head=A, acted_head=A,
                         disposition=f"commented @{A[:12]}", disposition_at=ago(minutes=10))
        self.cache("rereview.tsv", f"RE-REVIEW-ASAP\t5\tCHANGES_REQUESTED\t{C}\t{C}\t{A}\t0\tMERGEABLE\t{ago(minutes=1)}\n")
        self.assertNotIn("PREPARE 5", self.run_bank("plan").stdout)

    # ------------------------------------------------------------ tick

    def test_queue_stamp_waits_for_candidate_metadata(self):
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([{"match": ["graphql", "files(first:100)"], "rc": 1, "stderr": "boom"}])
        p = self.run_bank("tick", "--refresh", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse((self.bank / "cache" / "queue.stamp").exists())

    def test_an_ownerless_tick_lock_does_not_block_ticks(self):
        (self.bank / "locks" / "tick").mkdir(parents=True)
        (self.bank / "locks" / "tick.lock").write_text("")
        self.cache("queue.stamp", ago(minutes=1))
        out = self.run_bank("tick").stdout
        self.assertNotIn("another tick is running", out)
        self.assertIn("plan:", out)

    def test_an_ownerless_gh_lock_does_not_hang_gh(self):
        (self.bank / "locks" / "gh").mkdir(parents=True)
        self.write_entry(5, state="ready")
        self.rules([self.sync_rule(pr_node(5, A))])
        try:
            self.run_bank("sync", timeout=20)
        except subprocess.TimeoutExpired:
            self.fail("gh hung on a lock directory with no owner")

    # ------------------------------------------------------------ set / present

    def test_set_rejects_bad_values(self):
        self.write_entry(5)
        for kv in ("snooze_until=tomorrow", "state=bogus", "lane=nowhere"):
            p = self.run_bank("set", "5", kv, check=False)
            self.assertNotEqual(p.returncode, 0, kv)
        self.assertEqual(self.entry(5)["snooze_until"], "-")
        self.assertEqual(self.entry(5)["state"], "ready")

    def test_present_skips_a_snoozed_entry(self):
        self.write_entry(5, snooze_until=iso(datetime.now(timezone.utc) + timedelta(hours=2)))
        p = self.run_bank("present", check=False)
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
        self.assertEqual(self.entry(5)["state"], "ready")

    # ------------------------------------------------------------ prefetch

    def make_clone(self, pr_head_commit_msg="pr"):
        """A clone whose upstream has main and refs/pull/5/head. Returns the PR head sha."""
        up = self.tmp / "upstream.git"
        work = self.tmp / "work"
        g = lambda *a, cwd=None: subprocess.run(["git", *a], cwd=cwd, check=True, text=True,
                                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
        g("init", "-q", "--bare", str(up))
        g("init", "-q", "-b", "main", str(work))
        for k, v in (("user.email", "t@example.com"), ("user.name", "t")):
            g("config", k, v, cwd=work)
        (work / "f").write_text("main\n")
        g("add", "f", cwd=work)
        g("commit", "-qm", "main", cwd=work)
        g("push", "-q", str(up), "main", cwd=work)
        (work / "f").write_text("pr\n")
        g("commit", "-qam", pr_head_commit_msg, cwd=work)
        head = g("rev-parse", "HEAD", cwd=work)
        g("push", "-q", str(up), "HEAD:refs/pull/5/head", cwd=work)
        g("clone", "-q", "-o", "upstream", str(up), str(self.tmp / "clone"))
        return head

    def prefetch_rules(self, head):
        disc = {"data": {"repository": {"pullRequest": {
            k: {"totalCount": 0, "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []}
            for k in ("reviews", "comments", "reviewThreads")}}}}
        pr = {"number": 5, "title": "PR 5", "body": "", "author": {"login": "someone"}, "baseRefName": "main",
              "headRefOid": head, "reviewDecision": "", "labels": [], "mergeable": "MERGEABLE",
              "mergeStateStatus": "BLOCKED", "files": [], "commits": [], "createdAt": ago(days=3),
              "updatedAt": ago(minutes=5), "isDraft": False, "state": "OPEN"}
        return [{"match": ["pr", "view", "5"], "stdout": pr},
                {"match": ["pr", "diff", "5"], "stdout": "diff --git a/f b/f\n"},
                {"match": ["graphql", "reviewThreads"], "stdout": disc}]

    def test_prefetch_writes_the_dossier_and_ref(self):
        head = self.make_clone()
        self.cache("release-lines.txt", "active release lines: v22 v24 v26\n")
        self.rules(self.prefetch_rules(head))
        self.run_bank("prefetch", "5")
        d = self.bank / "dossier" / "5"
        disc = json.loads((d / "discussion.json").read_text())
        for k in ("reviews", "comments", "threads", "excluded", "block_check"):
            self.assertIn(k, disc)
        ref = subprocess.run(["git", "-C", str(self.tmp / "clone"), "rev-parse", "refs/review-bank/5"],
                             text=True, stdout=subprocess.PIPE).stdout.strip()
        self.assertEqual(ref, head)
        self.assertEqual(self.entry(5)["state"], "preparing")

    def test_prefetch_keeps_the_old_dossier_when_the_head_mismatches(self):
        head = self.make_clone()
        clone = self.tmp / "clone"
        subprocess.run(["git", "-C", str(clone), "update-ref", "refs/review-bank/5", "upstream/main"], check=True)
        old_ref = subprocess.run(["git", "-C", str(clone), "rev-parse", "refs/review-bank/5"],
                                 text=True, stdout=subprocess.PIPE).stdout.strip()
        d = self.bank / "dossier" / "5"
        d.mkdir(parents=True)
        (d / "pr.json").write_text("OLD")
        self.cache("release-lines.txt", "active release lines: v22 v24 v26\n")
        self.rules(self.prefetch_rules(C))  # GitHub claims a head the fetch won't produce
        p = self.run_bank("prefetch", "5", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual((d / "pr.json").read_text(), "OLD")
        ref = subprocess.run(["git", "-C", str(clone), "rev-parse", "refs/review-bank/5"],
                             text=True, stdout=subprocess.PIPE).stdout.strip()
        self.assertEqual(ref, old_ref)

    # ------------------------------------------------------------ slots

    def make_slots(self, *names):
        rows = []
        for name in names:
            p = self.tmp / f"slot{name}"
            subprocess.run(["git", "init", "-q", "-b", "main", str(p)], check=True)
            rows.append(f"{name}\t{p}")
        self.bank.mkdir(parents=True, exist_ok=True)
        (self.bank / "slots.tsv").write_text("\n".join(rows) + "\n")

    def test_an_ownerless_slot_lock_is_reclaimed(self):
        self.make_slots("1")
        lock = self.bank / "locks" / "slot-1"
        lock.mkdir(parents=True)
        old = time.time() - 3600
        os.utime(lock, (old, old))
        out = self.run_bank("slot", "acquire", "any", "5").stdout
        self.assertTrue(out.startswith("1\t"), out)

    def test_a_slot_whose_git_status_fails_is_not_handed_out(self):
        self.bank.mkdir(parents=True, exist_ok=True)
        notrepo = self.tmp / "notrepo"
        notrepo.mkdir()
        (self.bank / "slots.tsv").write_text(f"1\t{notrepo}\n")
        p = self.run_bank("slot", "acquire", "any", "5", check=False)
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main()
