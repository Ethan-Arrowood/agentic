"""Offline tests for bank.py. Run from scripts/: python3 -m unittest discover -s tests

Each test gets a temporary bank, a fake gh on PATH (fake_gh.py), stub
sibling scripts (devc.sh is fake_devc.py), a Docker Hub response read from a
file, and, where needed, a temporary git clone with an upstream. Nothing here
touches the network, a container engine, or the real bank.
"""
import fcntl, json, os, shutil, subprocess, sys, tempfile, time, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
BANK_PY = SCRIPTS / "bank.py"
RQ_REAL = (SCRIPTS / "../../nodejs-review-queue/scripts").resolve()
NC_REAL = (SCRIPTS / "../../nodejs-contribute/scripts").resolve()
FIELDS = ["pr", "url", "title", "author", "lane", "state", "head", "pr_head", "acted_head", "created_at",
          "prepared_at", "presented_at", "updated_at", "my_teams", "rereview_from",
          "needs_run", "disposition", "disposition_at", "snooze_until", "lease", "note",
          "wait_since", "wait_for", "screen"]
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
        # `git node` runs git-node from PATH: log the call and whether the gh shim's lock is held,
        # and print FAKE_NCU_OUT to stderr like ncu's report.
        (fakebin / "git-node").write_text(
            f'#!/bin/zsh\nzmodload zsh/system\nprint -r -- "$*" >> "{self.fake}/git-node.log"\n'
            'zsystem flock -t 0 "$NODE_REVIEW_BANK/locks/gh.lock" 2>/dev/null && l=free || l=held\n'
            f'print -r -- "gh lock $l" >> "{self.fake}/git-node.log"\n'
            'print -rn -- "${FAKE_NCU_OUT:-}" >&2\nexit ${FAKE_NCU_RC:-0}\n')
        (fakebin / "git-node").chmod(0o755)
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
            '#!/bin/zsh\necho "#$1: ${FAKE_CI:-CI=SUCCESS  job=1  HEAD-MATCH}  [head ${FAKE_CI_HEAD:-aaaaaaaaaaaa}]"\n')
        shutil.copy(HERE / "fake_devc.py", self.nc / "devc.sh")
        for p in (self.rq / "build-queue.sh", self.nc / "ci-status.sh", self.nc / "devc.sh"):
            p.chmod(0o755)
        self.hub = self.tmp / "hub.json"
        self.env = dict(os.environ, NODE_REVIEW_BANK=str(self.bank), FAKE_GH_DIR=str(self.fake),
                        FAKE_DEVC_DIR=str(self.fake), DEVC_HUB_URL=self.hub.as_uri(),
                        PATH=f"{fakebin}:{os.environ['PATH']}", ME="me", GH_MIN_GAP="0",
                        GH_RETRY_SLEEP="0", RQ_SCRIPTS=str(self.rq), NC_SCRIPTS=str(self.nc),
                        NODE_CLONE=str(self.tmp / "clone"), REFRESH_MINUTES="100000",
                        # Off by default here: most tests run several ticks in a row.
                        TICK_BACKOFF_MAX_MINUTES="0")
        for k in ("TERMINFO", "BANK_TARGET", "DEVC_IMAGE", "IMAGE_CHECK_MINUTES"):
            self.env.pop(k, None)
        self.rules([])

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


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
        self.run_bank("put", "5", str(summary), "--head", A)
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


    def test_a_metadata_failure_keeps_the_queue_and_finishes_the_tick(self):
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([{"match": ["graphql", "files(first:100)"], "rc": 1, "stderr": "boom"}])
        out = self.run_bank("tick", "--refresh").stdout
        self.assertIn("metadata FAILED", out)
        self.assertIn("plan:", out)
        self.assertFalse((self.bank / "cache" / "queue.stamp").exists())
        self.assertIn("5\thttp", (self.bank / "cache" / "queue.tsv").read_text())

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


    def make_clone(self, pr_head_commit_msg="pr", readme=None):
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
        if readme is not None:
            (work / "README.md").write_text(readme)
            g("add", "README.md", cwd=work)
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
        return [{"match": ["pr", "view", "5", "--jq"], "stdout": head + "\n"},
                {"match": ["pr", "view", "5"], "stdout": pr},
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


    def add_codeowners(self, text):
        """Commit .github/CODEOWNERS to upstream main, which prefetch fetches."""
        work = self.tmp / "work"
        g = lambda *a: subprocess.run(["git", *a], cwd=work, check=True, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE)
        g("checkout", "-q", "main")
        (work / ".github").mkdir(exist_ok=True)
        (work / ".github" / "CODEOWNERS").write_text(text)
        g("add", ".github")
        g("commit", "-qm", "owners")
        g("push", "-q", str(self.tmp / "upstream.git"), "main")

    def gates_rule(self, head, reviews=(), requests=(), contexts=(), timeline=()):
        pr = {"reviewDecision": "REVIEW_REQUIRED",
              "commits": {"nodes": [{"commit": {"oid": head, "statusCheckRollup": {
                  "state": "FAILURE", "contexts": {"totalCount": len(contexts), "nodes": list(contexts)}}}}]},
              "timelineItems": {"totalCount": len(timeline), "nodes": list(timeline)},
              "reviewRequests": {"nodes": list(requests)},
              "latestOpinionatedReviews": {"nodes": list(reviews)}}
        return {"match": ["graphql", "statusCheckRollup"], "stdout": {"data": {"repository": {"pullRequest": pr}}}}

    def prefetch_gates(self, lane="cq", gates=None, env=None):
        head = self.make_clone()
        self.add_codeowners("# owners\n/lib/internal/http2/* @nodejs/http2 @nodejs/net\n"
                            "/lib/net.js @nodejs/net\n*.gyp @nodejs/gyp\n/doc/ @nodejs/docs\n")
        self.cache("release-lines.txt", "active release lines: v22 v24 v26\n")
        if lane == "cq":
            self.cache("rereview.tsv", self.rereview_row(5, head=head))
        rules = self.prefetch_rules(head)
        rules[1]["stdout"]["files"] = [{"path": p} for p in (
            "lib/internal/http2/core.js", "lib/internal/http2/sub/x.js", "lib/net.js", "tools/a.gyp",
            "doc/api/net.md", "src/pipe_wrap.cc")]
        if gates is None:
            gates = self.gates_rule(head, reviews=[
                {"author": {"login": "alice"}, "state": "APPROVED", "submittedAt": ago(hours=1),
                 "commit": {"oid": head}, "onBehalfOf": {"nodes": [{"slug": "net"}]}}],
                requests=[{"requestedReviewer": {"__typename": "Team", "slug": "http2"}}],
                contexts=[{"__typename": "CheckRun", "name": "lint-js", "status": "COMPLETED", "conclusion": "FAILURE",
                           "detailsUrl": "https://example.test/1",
                           "checkSuite": {"workflowRun": {"workflow": {"name": "Linters"}}}},
                          {"__typename": "CheckRun", "name": "test-linux", "status": "COMPLETED",
                           "conclusion": "SUCCESS", "detailsUrl": "u", "checkSuite": None},
                          {"__typename": "StatusContext", "context": "node-test-pull-request", "state": "PENDING",
                           "targetUrl": "https://ci.example.test/2"}],
                timeline=[{"__typename": "PullRequestCommit", "commit": {
                              "oid": A, "committedDate": ago(days=2), "messageHeadline": "old",
                              "checkSuites": {"nodes": [{"createdAt": ago(days=2)}]}}},
                          {"__typename": "HeadRefForcePushedEvent", "createdAt": ago(hours=3),
                           "actor": {"login": "someone"}, "beforeCommit": {"oid": A}, "afterCommit": {"oid": head}},
                          {"__typename": "PullRequestCommit", "commit": {
                              "oid": head, "committedDate": ago(hours=4), "messageHeadline": "pr",
                              "checkSuites": {"nodes": [{"createdAt": ago(hours=3)}]}}}])
        self.rules([gates] + rules)
        out = self.run_bank("prefetch", "5", env=env).stdout
        return head, self.bank / "dossier" / "5", out

    def test_prefetch_writes_gates_timeline_and_code_owners(self):
        head, d, out = self.prefetch_gates()
        self.assertIn("code owners without an approval: @nodejs/http2", out)
        g = json.loads((d / "gates.json").read_text())
        self.assertEqual(g["reviewDecision"], "REVIEW_REQUIRED")
        self.assertEqual([r["name"] for r in g["checks"]["not_passing"]], ["lint-js", "node-test-pull-request"])
        self.assertEqual(g["checks"]["not_passing"][0]["workflow"], "Linters")
        co = g["codeowners"]
        self.assertEqual(co["source"], "upstream/main:.github/CODEOWNERS")
        owners = co["owners"]
        self.assertEqual(owners["@nodejs/http2"]["paths"], ["lib/internal/http2/core.js"])
        self.assertEqual(owners["@nodejs/net"]["paths"], ["lib/internal/http2/core.js", "lib/net.js"])
        self.assertEqual(owners["@nodejs/gyp"]["paths"], ["tools/a.gyp"])
        self.assertEqual(owners["@nodejs/docs"]["paths"], ["doc/api/net.md"])
        self.assertEqual(co["unowned_paths"], ["lib/internal/http2/sub/x.js", "src/pipe_wrap.cc"])
        self.assertTrue(owners["@nodejs/net"]["status"].startswith("approved by alice"))
        self.assertTrue(owners["@nodejs/http2"]["status"].startswith("requested"))
        self.assertTrue(owners["@nodejs/docs"]["status"].startswith("not requested"))
        t = json.loads((d / "timeline.json").read_text())
        self.assertEqual(t["head_pushed_at"]["source"], "force-push event")
        self.assertEqual([e["type"] for e in t["events"]], ["commit", "force-push", "commit"])

    def test_prefetch_writes_ncu_metadata_for_cq_entries_only(self):
        env = dict(self.env, FAKE_NCU_RC="1", FAKE_NCU_OUT=(
            "\x1b[36m⠋\x1b[39m Loading data for nodejs/node/pull/5\n"
            "   ✔  Approvals: 2\n   ✖  1 GitHub CI job(s) failed:\n"))
        _, d, _ = self.prefetch_gates(env=env)
        text = (d / "metadata.txt").read_text()
        self.assertIn("Approvals: 2", text)
        self.assertIn("(git node metadata exit 1,", text)
        self.assertNotIn("\x1b", text)
        self.assertNotIn("Loading data", text)
        log = (self.fake / "git-node.log").read_text().splitlines()
        self.assertEqual(log[0].split()[:2], ["metadata", "5"])
        self.assertEqual(log[1], "gh lock held")

    def test_prefetch_skips_ncu_metadata_outside_the_cq_lane(self):
        _, d, _ = self.prefetch_gates(lane="fresh")
        self.assertFalse((d / "metadata.txt").exists())
        self.assertFalse((self.fake / "git-node.log").exists())

    def test_a_failed_gates_query_does_not_stop_the_prefetch(self):
        _, d, out = self.prefetch_gates(gates={"match": ["graphql", "statusCheckRollup"], "rc": 1, "stderr": "boom"})
        self.assertIn("gates: query FAILED", out)
        self.assertEqual(self.entry(5)["state"], "preparing")
        self.assertTrue(json.loads((d / "gates.json").read_text())["error"])
        self.assertTrue(json.loads((d / "timeline.json").read_text())["error"])
        self.assertTrue((d / "metadata.txt").exists())

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


    def rereview_row(self, n, bucket="CQ-CANDIDATE", head=A, updated=None):
        return f"{bucket}\t{n}\tAPPROVED\t{head}\t{head}\t{head}\t2\tMERGEABLE\t{updated or ago(minutes=1)}\n"

    def test_an_approval_recorded_by_sync_still_reaches_the_cq_lane(self):
        # The same tick's rereview.tsv already says CQ-CANDIDATE when sync
        # records the approval.
        self.write_entry(5, state="presented", lane="rereview", head=A, pr_head=A, created_at=ago(hours=2))
        self.cache("rereview.tsv", self.rereview_row(5))
        self.cache("ci.json", json.dumps({"5": {"head": A[:12], "ok": True, "line": "CI=SUCCESS HEAD-MATCH", "at": ago(minutes=1)}}))
        self.rules([self.sync_rule(pr_node(5, A, reviews=[
            {"state": "APPROVED", "submittedAt": ago(minutes=10), "commit": {"oid": A}}]))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["state"], "done")
        self.assertIn("PREPARE 5 lane=cq", self.run_bank("plan").stdout)

    def test_put_refuses_a_draft_for_another_head(self):
        self.write_entry(5, state="preparing", head=B, pr_head=B, lease=ago(minutes=1))
        summary = self.tmp / "s.md"
        summary.write_text("## late draft\n")
        p = self.run_bank("put", "5", str(summary), "--head", A, check=False)
        self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
        self.assertEqual(self.entry(5)["state"], "preparing")
        self.assertNotIn("late draft", self.entry(5)["body"])

    def test_put_refuses_an_entry_that_is_no_longer_being_prepared(self):
        summary = self.tmp / "s.md"
        summary.write_text("## late draft\n")
        for state in ("done", "presented"):
            self.write_entry(5, state=state, head=A, pr_head=A)
            p = self.run_bank("put", "5", str(summary), "--head", A, check=False)
            self.assertEqual(p.returncode, 5, state)
            self.assertEqual(self.entry(5)["state"], state)

    def test_put_counts_needs_a_run_and_takes_no_state_override(self):
        self.write_entry(5, state="preparing", head=A, pr_head=A, lease=ago(minutes=1))
        summary = self.tmp / "s.md"
        summary.write_text("## Summary\n### Needs a run\n- test/parallel/test-foo.js: fails on main\n")
        self.run_bank("put", "5", str(summary), "--head", A, "--state", "ready")
        e = self.entry(5)
        self.assertEqual(e["state"], "needs-run")
        self.assertEqual(e["needs_run"], "1")

    def test_plan_counts_eligible_candidates_per_lane(self):
        self.candidate_cache(6)
        self.cache("rereview.tsv", self.rereview_row(5, bucket="RE-REVIEW"))
        out = self.run_bank("plan").stdout
        self.assertIn("plan: eligible candidates by lane: 1 rereview, 1 fresh", out)
        self.write_entry(5, state="ready")
        self.write_entry(6, state="ready")
        self.assertIn("plan: eligible candidates by lane: none", self.run_bank("plan").stdout)

    def candidate_cache(self, n, head=A, updated=None, state="OPEN"):
        self.cache("queue.tsv", f"{n}\thttp\t-\n")
        self.cache("candidates.json", json.dumps({str(n): {
            "title": f"PR {n}", "draft": False, "state": state, "updated": updated or ago(hours=1),
            "head": head, "author": "someone", "paths": ["lib/net.js"]}}))

    def test_a_pr_closed_since_the_queue_was_cached_is_not_planned(self):
        self.candidate_cache(5)
        self.write_entry(5, state="done", lane="fresh", disposition="landed 42800b60d33f",
                         disposition_at=ago(minutes=5), updated_at=ago(minutes=5))
        out = self.run_bank("plan", "--all").stdout
        self.assertNotIn("PREPARE 5", out)
        self.assertIn("SKIP 5", out)

    def test_an_action_newer_than_the_queue_cache_is_honored(self):
        self.candidate_cache(5, head=A)
        self.write_entry(5, state="done", lane="fresh", head=B, pr_head=B, acted_head=B,
                         disposition=f"approved @{B[:12]}", disposition_at=ago(minutes=5), updated_at=ago(minutes=5))
        self.assertNotIn("PREPARE 5", self.run_bank("plan").stdout)

    def test_prefetch_refuses_a_closed_pr(self):
        head = self.make_clone()
        self.cache("release-lines.txt", "active release lines: v22 v24 v26\n")
        rules = self.prefetch_rules(head)
        for r in rules:
            if r["match"] == ["pr", "view", "5"]:
                r["stdout"]["state"] = "CLOSED"
        self.rules(rules)
        p = self.run_bank("prefetch", "5", check=False)
        self.assertEqual(p.returncode, 4, p.stdout + p.stderr)
        self.assertFalse((self.bank / "dossier" / "5").exists())
        e = self.entry(5)
        self.assertEqual((e["state"], e["disposition"]), ("done", "closed"))

    def test_plan_stops_offering_a_pr_prefetch_found_closed(self):
        # The cached queue still lists the PR, as it does while the refresh
        # is dormant. A woken hold made it plannable again.
        head = self.make_clone()
        self.cache("release-lines.txt", "active release lines: v22 v24 v26\n")
        self.candidate_cache(5, head=A, updated=ago(hours=3))
        self.write_entry(5, state="done", lane="fresh", head=A, pr_head=A, acted_head=A,
                         disposition=f"approved @{A[:12]}", wait_since=ago(hours=2),
                         updated_at=ago(hours=3))
        self.assertIn("PREPARE 5", self.run_bank("plan").stdout)
        rules = self.prefetch_rules(head)
        for r in rules:
            if r["match"] == ["pr", "view", "5"]:
                r["stdout"]["state"] = "MERGED"
                r["stdout"]["updatedAt"] = ago(minutes=1)
        self.rules(rules)
        self.assertEqual(self.run_bank("prefetch", "5", check=False).returncode, 4)
        self.assertEqual(self.entry(5)["disposition"], "merged")
        self.assertNotIn("PREPARE 5", self.run_bank("plan").stdout)

    def test_a_commit_queue_failed_label_does_not_finish_a_cq_entry(self):
        self.write_entry(5, state="ready", lane="cq")
        self.rules([self.sync_rule(pr_node(5, A, labels=["commit-queue-failed", "commit-queue-squash"]))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["state"], "ready")

    def test_cq_ci_checks_the_oldest_result_first(self):
        rows = "".join(self.rereview_row(n, updated=ago(minutes=n)) for n in range(1, 7))
        self.rereview_out.write_text(rows)
        self.cache("queue.stamp", ago(minutes=1))
        stale = {str(n): {"head": A[:12], "ok": False, "line": "CI=NO-RUN", "at": ago(hours=2)} for n in range(1, 6)}
        self.cache("ci.json", json.dumps(stale))
        self.run_bank("tick")
        ci = json.loads((self.bank / "cache" / "ci.json").read_text())
        self.assertIn("6", ci, "the never-checked candidate waited behind higher-ranked ones")

    def test_ci_is_keyed_by_the_head_ci_status_reports(self):
        self.rereview_out.write_text(self.rereview_row(5))
        self.cache("queue.stamp", ago(minutes=1))
        env = dict(self.env, FAKE_CI_HEAD="b" * 12)
        out = self.run_bank("tick", env=env).stdout
        self.assertNotIn("PREPARE 5", out)

    def test_prefetch_aborts_when_the_head_moves_during_the_fetch(self):
        head = self.make_clone()
        clone = self.tmp / "clone"
        subprocess.run(["git", "-C", str(clone), "update-ref", "refs/review-bank/5", "upstream/main"], check=True)
        old_ref = subprocess.run(["git", "-C", str(clone), "rev-parse", "refs/review-bank/5"],
                                 text=True, stdout=subprocess.PIPE).stdout.strip()
        d = self.bank / "dossier" / "5"
        d.mkdir(parents=True)
        (d / "pr.json").write_text("OLD")
        self.cache("release-lines.txt", "active release lines: v22 v24 v26\n")
        rules = self.prefetch_rules(head)
        rules[0]["stdout"] = C + "\n"  # a push landed after the fetch
        self.rules(rules)
        p = self.run_bank("prefetch", "5", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual((d / "pr.json").read_text(), "OLD")
        ref = subprocess.run(["git", "-C", str(clone), "rev-parse", "refs/review-bank/5"],
                             text=True, stdout=subprocess.PIPE).stdout.strip()
        self.assertEqual(ref, old_ref)
        self.assertFalse((self.bank / "prs" / "5.md").exists())

    def test_present_rechecks_the_entry_after_waiting_for_its_lock(self):
        self.write_entry(5, state="ready")
        (self.bank / "locks").mkdir(parents=True, exist_ok=True)
        fd = os.open(self.bank / "locks" / "entry-5.lock", os.O_CREAT | os.O_RDWR)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            pres = subprocess.Popen([sys.executable, str(BANK_PY), "present"], env=self.env, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            time.sleep(1.5)
            self.write_entry(5, state="done", disposition="skipped", disposition_at=ago(minutes=0))
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        pres.communicate(timeout=30)
        self.assertNotEqual(pres.returncode, 0)
        self.assertEqual(self.entry(5)["state"], "done")

    def test_a_snooze_time_without_a_zone_does_not_crash(self):
        self.write_entry(5)
        self.run_bank("set", "5", "snooze_until=2099-12-01T12:00:00")
        self.assertIn("(snoozed)", self.run_bank("list").stdout)
        self.assertEqual(self.run_bank("present", check=False).returncode, 3)

    def test_slot_release_checks_the_pr_and_removes_leftovers(self):
        self.make_slots("1")
        self.run_bank("slot", "acquire", "1", "6")
        p = self.run_bank("slot", "release", "1", "5", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertTrue((self.bank / "locks" / "slot-1" / "owner.json").exists())
        self.run_bank("slot", "release", "1", "6")
        self.assertFalse((self.bank / "locks" / "slot-1").exists())
        lock = self.bank / "locks" / "slot-1"
        lock.mkdir()
        (lock / ".owner.json.x.tmp").write_text("")
        self.run_bank("slot", "release", "1", "--force")
        self.assertFalse(lock.exists())

    def test_set_done_cleans_up_the_dossier(self):
        self.write_entry(5, state="ready")
        d = self.bank / "dossier" / "5"
        d.mkdir(parents=True)
        (d / "pr.json").write_text("{}")
        self.run_bank("set", "5", "state=done", "disposition=skipped", f"disposition_at={ago(minutes=1)}")
        self.assertFalse(d.exists())

    def test_sync_skips_an_entry_reprepared_during_the_query(self):
        self.write_entry(5, state="preparing", head=A, pr_head=A, lease=ago(minutes=5))
        gate = self.tmp / "gate"
        self.rules([self.sync_rule(pr_node(5, A), wait_file=str(gate))])
        sync = subprocess.Popen([sys.executable, str(BANK_PY), "sync"], env=self.env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(200):
            if Path(str(gate) + ".reached").exists():
                break
            time.sleep(0.1)
        self.write_entry(5, state="preparing", head=B, pr_head=B, lease=ago(minutes=0))
        gate.write_text("")
        sync.communicate(timeout=60)
        self.assertEqual(self.entry(5)["pr_head"], B)

    def run_discussion(self, nodes, env=None):
        disc = {"data": {"repository": {"pullRequest": {
            "reviews": {"totalCount": 0, "nodes": []},
            "comments": {"totalCount": 0, "nodes": []},
            "reviewThreads": {"totalCount": 1, "nodes": [{
                "isResolved": False, "isOutdated": False, "path": "lib/net.js", "line": 1,
                "comments": {"nodes": nodes}}]}}}}}
        self.rules([{"match": ["graphql", "reviewThreads"], "stdout": disc}])
        p = subprocess.run(["zsh", str(RQ_REAL / "discussion.sh"), "--json", "5"], env=env or self.env,
                           text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def comment(self, login, assoc):
        return {"author": {"login": login}, "authorAssociation": assoc, "createdAt": ago(minutes=5),
                "isMinimized": False, "minimizedReason": None, "body": "hi"}

    def wait_for(self, cond, what, timeout=20):
        for _ in range(int(timeout * 10)):
            if cond():
                return
            time.sleep(0.1)
        self.fail(f"timed out waiting for {what}")

    def devc_state(self, image=None, slots=None, **extra):
        """fake_devc.py state. slots maps a slot name (from make_slots) to its fields."""
        img = {"image_id": "1" * 12, "image_digests": "docker.io/nodejs/devcontainer@sha256:old",
               "image_created": "2026-11-19 03:59:40.160578228 +0000 UTC"}
        img.update(image or {})
        st = {"image": img, "slots": {os.path.realpath(self.tmp / f"slot{n}"): f for n, f in (slots or {}).items()}}
        st.update(extra)
        (self.fake / "state.json").write_text(json.dumps(st))

    def hub_says(self, digest="sha256:new", arch="sha256:new-arm64", updated="2026-11-20T04:31:57.438312Z"):
        self.hub.write_text(json.dumps({"name": "nightly", "digest": digest, "last_updated": updated,
                                        "images": [{"architecture": "arm64", "digest": arch}]}))

    def devc_calls(self, cmd=None):
        p = self.fake / "calls.log"
        calls = [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
        return [(Path(c).name, k) for c, k in calls if cmd in (None, k)]

    def test_tick_pulls_a_newer_image_when_no_slot_is_held(self):
        self.make_slots("1", "2")
        self.devc_state(slots={"1": {"container_image": "1" * 12}, "2": {"container_image": "1" * 12}})
        self.hub_says()
        self.cache("queue.stamp", ago(minutes=1))
        out = self.run_bank("tick").stdout
        self.assertIn("pulling in the background", out)
        self.wait_for(lambda: "rc" in json.loads((self.bank / "cache" / "image-pull.json").read_text()), "the pull")
        self.assertEqual(self.devc_calls("pull"), [("slot1", "pull")])
        # The Docker Hub answer is cached, and a pull isn't retried within the hour.
        self.hub.unlink()
        out = self.run_bank("tick").stdout
        self.assertNotIn("check failed", out)
        self.assertIn("the pull at", out)
        self.assertEqual(len(self.devc_calls("pull")), 1)

    def test_the_pull_waits_while_a_slot_is_held(self):
        self.make_slots("1", "2")
        self.devc_state()
        self.hub_says()
        self.cache("queue.stamp", ago(minutes=1))
        self.run_bank("slot", "acquire", "1", "5")
        out = self.run_bank("tick").stdout
        self.assertIn("the pull and any moves wait until no slot is held (slot 1 for #5)", out)
        self.assertFalse((self.bank / "cache" / "image-pull.json").exists())
        self.assertEqual(self.devc_calls("pull"), [])

    def test_an_image_matching_a_platform_digest_is_current(self):
        self.make_slots("1")
        self.devc_state(image={"image_digests": "docker.io/nodejs/devcontainer@sha256:new-arm64 x@sha256:other"})
        self.hub_says()
        self.cache("queue.stamp", ago(minutes=1))
        out = self.run_bank("tick").stdout
        self.assertIn("; current", out)
        self.assertEqual(self.devc_calls("pull"), [])

    def test_tick_moves_a_free_outdated_slot_and_never_a_held_one(self):
        self.make_slots("1", "2")
        gate = self.tmp / "gate"
        old = {"container_image": "0" * 12}
        self.devc_state(image={"image_digests": "x@sha256:new"}, slots={"1": dict(old), "2": dict(old)},
                        wait={"build": str(gate)})
        self.hub_says()
        self.cache("queue.stamp", ago(minutes=1))
        self.run_bank("slot", "acquire", "1", "5")
        out = self.run_bank("tick").stdout
        self.assertIn("slot 2: moving from 000000000000 to 111111111111", out)
        self.wait_for(lambda: Path(str(gate) + ".reached").exists(), "the build")
        # The moving slot is held: no agent gets it, and status says why.
        self.assertEqual(self.run_bank("slot", "acquire", "any", "6", check=False).returncode, 3)
        self.assertIn("moving to image 111111111111", self.run_bank("slot", "status").stdout)
        self.assertIn("slot 2: moving to 111111111111", self.run_bank("tick").stdout)
        gate.write_text("")
        self.wait_for(lambda: not (self.bank / "locks" / "slot-2").exists(), "the slot release")
        self.assertEqual(self.devc_calls("down") + self.devc_calls("build"), [("slot2", "down"), ("slot2", "build")])
        self.assertEqual(json.loads((self.bank / "cache" / "image-moves.json").read_text())["2"]["rc"], 0)
        self.assertTrue((self.bank / "locks" / "slot-1" / "owner.json").exists())

    def test_a_busy_dirty_or_branched_slot_is_not_moved(self):
        self.make_slots("1", "2", "3")
        old = {"container_image": "0" * 12}
        self.devc_state(image={"image_digests": "x@sha256:new"},
                        slots={"1": dict(old, busy="yes"), "2": dict(old), "3": dict(old)})
        (self.tmp / "slot2" / "untracked").write_text("x")
        for args in (("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"),
                     ("checkout", "-q", "-b", "mine")):
            subprocess.run(["git", "-C", str(self.tmp / "slot3"), *args], check=True)
        self.hub_says()
        self.cache("queue.stamp", ago(minutes=1))
        out = self.run_bank("tick").stdout
        self.assertIn("slot 1: on older image 000000000000; the move waits (something runs", out)
        self.assertIn("slot 2: on older image 000000000000; the move waits (checkout has changes)", out)
        self.assertIn("slot 3: on older image 000000000000; the move waits (checkout is on mine", out)
        self.assertEqual(self.devc_calls("down"), [])

    def test_a_failed_move_releases_the_slot_and_is_not_retried_at_once(self):
        self.make_slots("1")
        self.devc_state(image={"image_digests": "x@sha256:new"}, slots={"1": {"container_image": "0" * 12}},
                        rc={"build": 1})
        self.hub_says()
        self.cache("queue.stamp", ago(minutes=1))
        self.run_bank("tick")
        self.wait_for(lambda: (self.bank / "cache" / "image-moves.json").exists(), "the move")
        self.wait_for(lambda: not (self.bank / "locks" / "slot-1").exists(), "the slot release")
        out = self.run_bank("tick").stdout
        self.assertIn("the move waits (the move at", out)
        self.assertEqual(len(self.devc_calls("build")), 1)

    def test_a_move_whose_worker_is_gone_is_reclaimed(self):
        self.make_slots("1")
        lock = self.bank / "locks" / "slot-1"
        lock.mkdir(parents=True)
        (lock / "owner.json").write_text(json.dumps({"pr": "image-move", "owner": "image-move", "at": ago(minutes=5)}))
        out = self.run_bank("slot", "acquire", "any", "5").stdout
        self.assertTrue(out.startswith("1\t"), out)

    def test_acquire_prefers_a_slot_on_the_local_image(self):
        self.make_slots("1", "2")
        self.devc_state(slots={"1": {"container_image": "0" * 12}, "2": {"container_image": "1" * 12}})
        self.assertTrue(self.run_bank("slot", "acquire", "any", "5").stdout.startswith("2\t"))
        p = self.run_bank("slot", "acquire", "any", "6")
        self.assertTrue(p.stdout.startswith("1\t"), p.stdout)
        self.assertIn("older than the local 111111111111", p.stderr)

    def test_slot_status_shows_the_image_commit_and_how_far_behind_main(self):
        self.make_clone()
        clone = self.tmp / "clone"
        first = subprocess.run(["git", "-C", str(clone), "rev-list", "--max-parents=0", "upstream/main"],
                               text=True, stdout=subprocess.PIPE, check=True).stdout.strip()
        work = self.tmp / "work"
        for msg in ("two", "three"):
            subprocess.run(["git", "-C", str(work), "commit", "-q", "--allow-empty", "-m", msg], check=True)
        subprocess.run(["git", "-C", str(work), "push", "-q", str(self.tmp / "upstream.git"), "HEAD:main"], check=True)
        subprocess.run(["git", "-C", str(clone), "fetch", "-q", "upstream"], check=True)
        self.make_slots("1")
        self.devc_state(slots={"1": {"container_image": "0" * 12, "image_commit": first}})
        out = self.run_bank("slot", "status").stdout
        # pr, two, three are on upstream/main after the image's commit.
        self.assertIn(f"image: 000000000000 built from {first[:12]} (3 commits behind upstream/main), "
                      "OUTDATED: local image is 111111111111", out)

    def test_image_prune_runs_only_in_free_slots(self):
        self.make_slots("1", "2")
        self.devc_state()
        self.run_bank("slot", "acquire", "1", "5")
        out = self.run_bank("image", "prune").stdout
        self.assertIn("slot 1: held for #5, skipped", out)
        self.assertEqual(self.devc_calls("prune"), [("slot2", "prune")])

    def run_devc(self, cmd, state, check=True):
        """The real devc.sh against fake_engine.py, in a scratch checkout."""
        co = self.tmp / "node"
        if not co.exists():
            subprocess.run(["git", "init", "-q", str(co)], check=True)
            (co / "node.gyp").write_text("")
        (self.fake / "state.json").write_text(json.dumps(state))
        p = subprocess.run(["bash", str(NC_REAL / "devc.sh"), cmd], cwd=co, text=True, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=60,
                           env=dict(self.env, DEVC_ENGINE=str(HERE / "fake_engine.py"), FAKE_ENGINE_DIR=str(self.fake)))
        if check:
            self.assertEqual(p.returncode, 0, p.stderr)
        return p, dict(l.split("=", 1) for l in p.stdout.splitlines() if "=" in l)

    def test_devc_image_and_prune_touch_only_this_checkouts_stale_volumes(self):
        key = self.run_devc("image", {})[1]["key"]
        cur, ctr, old = "1" * 12, "2" * 12, "3" * 12
        vols = [f"node-devc-out-{key}-{cur}", f"node-devc-out-{key}-{ctr}", f"node-devc-out-{key}-{old}",
                f"node-devc-out-{key}-x-123-{old}", f"node-devc-out-http-foo-1-{old}", "node-devc-ccache"]
        state = {"image": {"id": cur + "abcd", "digests": ["r@sha256:a", "r@sha256:b"],
                           "created": "2026-11-19 03:59:40.1 +0000 UTC"},
                 "containers": {f"node-devc-{key}": {"state": "running", "image": ctr + "ef", "commit": "c" * 40}},
                 "ps": "      1 Ss   sleep infinity\n     14 Z    [git] <defunct>\n    597 Rs   ps -eo pid=,stat=,args=",
                 "volumes": vols}
        info = self.run_devc("image", state)[1]
        self.assertEqual(info["image_id"], cur)
        self.assertEqual(info["image_digests"], "r@sha256:a r@sha256:b")
        self.assertEqual(info["container_image"], ctr)
        self.assertEqual(info["image_commit"], "c" * 40)
        self.assertEqual((info["outdated"], info["busy"]), ("yes", "no"))
        self.assertEqual(info["stale_volumes"], f"node-devc-out-{key}-{old}")
        state["ps"] += "\n    600 S    bash -lc ninja"
        self.assertEqual(self.run_devc("image", state)[1]["busy"], "yes")
        self.run_devc("prune", state)
        left = json.loads((self.fake / "state.json").read_text())["volumes"]
        self.assertEqual(left, [v for v in vols if v != f"node-devc-out-{key}-{old}"])

    def test_devc_prune_refuses_without_the_image(self):
        key = self.run_devc("image", {})[1]["key"]
        vols = [f"node-devc-out-{key}-{'3' * 12}"]
        p, _ = self.run_devc("prune", {"volumes": vols}, check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(json.loads((self.fake / "state.json").read_text())["volumes"], vols)

    def test_discussion_reports_a_failed_block_lookup_as_unknown(self):
        out = self.run_discussion([self.comment("drive-by", "NONE")])
        self.assertEqual(out["block_check"], "unknown")

    def test_discussion_does_not_probe_members_in_threads(self):
        self.run_discussion([self.comment("collaborator", "MEMBER")])
        self.assertFalse([c for c in self.calls() if any("blocks/" in a for a in c)])

    def test_discussion_reads_the_repo_from_REPO(self):
        self.run_discussion([], env=dict(self.env, REPO="someorg/somerepo"))
        q = [c for c in self.calls() if "graphql" in c][0]
        self.assertIn("o=someorg", q)
        self.assertIn("r=somerepo", q)

    def reviewed_node(self, n, head, others=(), created=None, labels=()):
        """A sync node with reviews by others (login, minutes ago) and an open time."""
        node = pr_node(n, head, labels=labels)
        node["createdAt"] = created or ago(days=10)
        node["allReviews"] = {"nodes": [{"author": {"login": who}, "submittedAt": ago(minutes=m)} for who, m in others]}
        return node

    def test_hold_keeps_a_candidate_with_no_entry_out_of_the_plan(self):
        self.cache("rereview.tsv", self.rereview_row(5))
        self.cache("ci.json", json.dumps({"5": {"head": A[:12], "ok": True, "line": "CI=SUCCESS HEAD-MATCH", "at": ago(minutes=1)}}))
        self.assertIn("PREPARE 5 lane=cq", self.run_bank("plan").stdout)
        self.run_bank("hold", "5", "--until-reviews", "2", "more", "http", "reviews")
        e = self.entry(5)
        self.assertEqual(e["state"], "waiting")
        self.assertEqual(e["lane"], "cq")
        self.assertEqual(e["note"], "held: more http reviews")
        self.assertEqual(e["wait_for"], f"reviews=2,push={A[:12]}")
        out = self.run_bank("plan", "--all").stdout
        self.assertNotIn("PREPARE 5", out)
        self.assertRegex(out, r"WAIT 5 lane=cq since .*2 review\(s\) by others")

    def test_hold_refuses_a_pr_the_bank_does_not_know(self):
        p = self.run_bank("hold", "5", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse((self.bank / "prs" / "5.md").exists())

    def test_reviews_by_others_wake_a_hold_and_the_pr_is_planned_again(self):
        # Skipped in the cq lane at this head, then held: the wake brings it back.
        self.write_entry(5, state="done", lane="cq", acted_head=A, disposition="skipped",
                         disposition_at=ago(hours=2))
        self.run_bank("hold", "5", "--until-reviews", "2")
        since = self.entry(5)["wait_since"]
        self.rules([self.sync_rule(self.reviewed_node(5, A, others=[("http-a", -1), ("me", -1), ("someone", -1)]))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["state"], "waiting", "me and the author don't count")
        self.rules([self.sync_rule(self.reviewed_node(5, A, others=[("http-a", -1), ("http-b", -1), ("old", 600)]))])
        self.run_bank("sync")
        e = self.entry(5)
        self.assertEqual(e["state"], "done")
        self.assertEqual(e["note"], "woke: reviewed by http-a, http-b")
        self.assertEqual(e["wait_since"], since)
        self.cache("rereview.tsv", self.rereview_row(5))
        self.cache("ci.json", json.dumps({"5": {"head": A[:12], "ok": True, "line": "CI=SUCCESS HEAD-MATCH", "at": ago(minutes=1)}}))
        out = self.run_bank("plan").stdout
        self.assertIn("PREPARE 5 lane=cq", out)
        self.assertIn("(woke: reviewed by http-a, http-b)", out)

    def test_a_push_or_the_until_time_wakes_a_hold(self):
        self.write_entry(5, state="ready")
        self.run_bank("hold", "5")
        self.rules([self.sync_rule(self.reviewed_node(5, B))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["note"], f"woke: new push {B[:12]}")
        self.write_entry(6, state="ready")
        self.run_bank("hold", "6", "--until-reviews", "0", "--until", "2026-01-02T03:04:05")
        self.assertEqual(self.entry(6)["wait_for"], f"push={A[:12]},until=2026-01-02T03:04:05Z")
        self.rules([self.sync_rule(self.reviewed_node(6, A, others=[("http-a", -1)]))])
        self.run_bank("sync")
        self.assertEqual(self.entry(6)["state"], "done")
        self.assertEqual(self.entry(6)["note"], "woke: hold until 2026-01-02T03:04:05Z passed")

    def test_hold_drops_the_dossier_and_unhold_wakes_it(self):
        self.write_entry(5, state="ready")
        d = self.bank / "dossier" / "5"
        d.mkdir(parents=True)
        self.run_bank("hold", "5", "--until", "2099-01-01T00:00:00Z")
        self.assertFalse(d.exists())
        self.assertIn("waiting", self.run_bank("list").stdout)
        self.assertEqual(self.run_bank("present", check=False).returncode, 3)
        self.run_bank("unhold", "5")
        self.assertEqual(self.entry(5)["state"], "done")
        self.assertEqual(self.entry(5)["note"], "woke: unheld by hand")
        self.assertNotEqual(self.run_bank("unhold", "5", check=False).returncode, 0)

    def test_hold_until_author_wakes_on_an_author_comment(self):
        self.write_entry(5, state="ready", author="writer")
        self.run_bank("hold", "5", "--until-author", "--until-reviews", "0")
        e = self.entry(5)
        self.assertEqual(e["wait_for"], f"push={A[:12]},author=writer")
        self.assertIn("a comment by @writer", self.run_bank("list").stdout)
        other = {"author": {"login": "bystander"}, "createdAt": ago(minutes=-1), "body": "+1"}
        old = {"author": {"login": "writer"}, "createdAt": ago(hours=1), "body": "earlier"}
        self.rules([self.sync_rule(pr_node(5, A, author="writer", comments=[old, other]))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["state"], "waiting", "only a new comment by the author wakes it")
        theirs = {"author": {"login": "writer"}, "createdAt": ago(minutes=-1), "body": "benchmarks below"}
        self.rules([self.sync_rule(pr_node(5, A, author="writer", comments=[old, other, theirs]))])
        self.run_bank("sync")
        e = self.entry(5)
        self.assertEqual(e["state"], "done")
        # Not "author responded": that marks a screen hold, whose wake skips the screen at prefetch.
        self.assertEqual(e["note"], "woke: comment by the author @writer")

    def test_hold_until_author_refuses_an_unknown_author(self):
        self.cache("rereview.tsv", self.rereview_row(5, bucket="RE-REVIEW"))
        p = self.run_bank("hold", "5", "--until-author", check=False)
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertFalse((self.bank / "prs" / "5.md").exists())

    def defer_until(self, e):
        w = dict(t.partition("=")[::2] for t in e["wait_for"].split(","))
        until = datetime.strptime(w["until"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        since = datetime.strptime(e["wait_since"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return w, until - since

    def test_defer_holds_on_the_author_a_push_a_review_or_seven_days(self):
        self.write_entry(5, state="preparing", author="writer", lease=ago(minutes=5))
        d = self.bank / "dossier" / "5"
        d.mkdir(parents=True)
        reason = "mcollina asked for a benchmark (https://github.com/nodejs/node/pull/5#issuecomment-1), no reply"
        out = self.run_bank("defer", "5", *reason.split()).stdout
        self.assertEqual(out.strip().splitlines()[-1], f"DEFER #5: {reason}")
        e = self.entry(5)
        self.assertEqual(e["state"], "waiting")
        self.assertEqual(e["note"], f"defer: {reason}")
        w, span = self.defer_until(e)
        self.assertEqual((w["reviews"], w["push"], w["author"]), ("1", A[:12], "writer"))
        self.assertEqual(span, timedelta(days=7))
        self.assertFalse(d.exists())
        self.assertIn(f"(defer: {reason})", self.run_bank("plan", "--all").stdout)
        # A review by someone else wakes it.
        self.rules([self.sync_rule(self.reviewed_node(5, A, others=[("lpinca", -1)]))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["note"], "woke: reviewed by lpinca")
        # A push wakes it.
        self.run_bank("defer", "5", "author", "said", "more", "commits", "are", "coming")
        self.rules([self.sync_rule(self.reviewed_node(5, B))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["note"], f"woke: new push {B[:12]}")
        # unhold reverses it.
        self.write_entry(5, state="ready", author="writer")
        self.run_bank("defer", "5", "waiting", "on", "a", "rebase")
        self.run_bank("unhold", "5")
        self.assertEqual(self.entry(5)["note"], "woke: unheld by hand")

    def test_defer_falls_back_to_DEFER_DAYS(self):
        self.write_entry(5, state="ready", author="writer")
        self.run_bank("defer", "5", "linked", "PR", "may", "supersede", "it", env=dict(self.env, DEFER_DAYS="2"))
        e = self.entry(5)
        w, span = self.defer_until(e)
        self.assertEqual(span, timedelta(days=2))
        self.rules([self.sync_rule(self.reviewed_node(5, A))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["state"], "waiting", "no author comment, push, or review yet")
        # Pretend the 2 days passed with nothing else: the time wakes it.
        e["wait_for"] = e["wait_for"].replace(w["until"], ago(minutes=1))
        self.write_entry(5, **{k: v for k, v in e.items() if k not in ("body", "pr")})
        self.run_bank("sync")
        e = self.entry(5)
        self.assertEqual(e["state"], "done")
        self.assertRegex(e["note"], r"^woke: hold until \S+Z passed$")

    def test_defer_needs_a_reason(self):
        self.write_entry(5, state="ready", author="writer")
        p = self.run_bank("defer", "5", check=False)
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertEqual(self.entry(5)["state"], "ready")

    def test_deferred_entries_do_not_use_the_banks_room(self):
        self.candidate_cache(9)
        self.write_entry(5, state="needs-run", author="writer", needs_run="1")
        out = self.run_bank("plan", "--target", "1").stdout
        self.assertNotIn("PREPARE 9", out)
        self.run_bank("defer", "5", "the", "author", "must", "rebase", "before", "the", "repro", "can", "run")
        self.assertEqual(self.entry(5)["state"], "waiting")
        self.assertIn("PREPARE 9", self.run_bank("plan", "--target", "1").stdout)

    def test_a_run_that_cannot_be_done_is_an_open_question_not_needs_run(self):
        self.write_entry(5, state="preparing", head=A, pr_head=A, lease=ago(minutes=1))
        summary = self.tmp / "s.md"
        summary.write_text("## Summary\n### Needs a run\n- None.\n"
                           "### Open questions\n- Is it faster on arm64? Needs hardware the slots lack.\n")
        self.run_bank("put", "5", str(summary), "--head", A)
        e = self.entry(5)
        self.assertEqual((e["state"], e["needs_run"]), ("ready", "0"))

    def test_an_approval_before_the_landing_wait_ends_waits(self):
        self.write_entry(5, state="presented", lane="rereview", created_at=ago(hours=2))
        node = self.reviewed_node(5, A, created=ago(hours=1))
        node["reviews"]["nodes"] = [{"state": "APPROVED", "submittedAt": ago(minutes=10), "commit": {"oid": A}}]
        self.cache("ci.json", json.dumps({"5": {"head": A[:12], "ok": True, "line": "CI=SUCCESS HEAD-MATCH", "at": ago(minutes=1)}}))
        self.rules([self.sync_rule(node)])
        self.run_bank("sync")
        e = self.entry(5)
        self.assertEqual(e["state"], "waiting")
        self.assertTrue(e["disposition"].startswith("approved"))
        self.assertRegex(e["wait_for"], rf"^reviews=1,push={A[:12]},landing=\S+Z$")
        self.cache("rereview.tsv", self.rereview_row(5))
        self.assertNotIn("PREPARE 5", self.run_bank("plan").stdout)
        # The landing wait ends (fast-track here): the hold wakes into the cq lane.
        node["labels"]["nodes"] = [{"name": "fast-track"}]
        self.rules([self.sync_rule(node)])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["note"], "woke: landing wait over")
        self.assertIn("PREPARE 5 lane=cq", self.run_bank("plan").stdout)

    def test_an_approval_with_red_ci_waits_for_green_ci(self):
        self.write_entry(5, state="presented", lane="rereview", created_at=ago(hours=2))
        node = self.reviewed_node(5, A)
        node["reviews"]["nodes"] = [{"state": "APPROVED", "submittedAt": ago(minutes=10), "commit": {"oid": A}}]
        self.rules([self.sync_rule(node)])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["wait_for"], f"reviews=1,push={A[:12]},ci")
        # A tick checks CI for the held cq candidate, and the next sync wakes it.
        self.rereview_out.write_text(self.rereview_row(5))
        self.cache("queue.stamp", ago(minutes=1))
        self.run_bank("tick")
        self.assertEqual(self.entry(5)["state"], "waiting")
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["note"], f"woke: CI green at {A[:12]}")

    def test_a_cq_candidate_waits_for_the_landing_wait(self):
        green = json.dumps({"5": {"head": A[:12], "ok": True, "line": "CI=SUCCESS HEAD-MATCH", "at": ago(minutes=1)}})
        self.cache("ci.json", green)
        self.cache("rereview.tsv", self.rereview_row(5).rstrip("\n") + f"\t{ago(hours=10)}\t-\n")
        self.assertRegex(self.run_bank("plan", "--all").stdout, r"SKIP 5 lane=cq landing wait until")
        self.cache("rereview.tsv", self.rereview_row(5).rstrip("\n") + f"\t{ago(hours=10)}\tfast-track,http\n")
        self.assertIn("PREPARE 5 lane=cq", self.run_bank("plan").stdout)

    def test_the_landing_wait_is_72_hours_over_a_weekend(self):
        code = ("import bank\n"
                "for t in ('2026-11-16T12:00:00Z', '2026-11-19T12:00:00Z', '2026-11-22T12:00:00Z'):\n"
                "    print(bank.iso(bank.landing_at(t, [])))\n"
                "print(bank.iso(bank.landing_at('2026-11-19T12:00:00Z', ['fast-track'])))\n")
        p = subprocess.run([sys.executable, "-c", code], cwd=SCRIPTS, env=dict(self.env, PYTHONDONTWRITEBYTECODE="1"), text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.split(), ["2026-11-18T12:00:00Z", "2026-11-22T12:00:00Z",
                                            "2026-11-25T12:00:00Z", "2026-11-19T12:00:00Z"])


    # The automation screen.

    WELCOME = ("Welcome to Node.js, and thank you for your first contribution!\n\n> [!CAUTION]\n"
               "> AgentScan found account activity patterns that may be consistent with automation.")

    README = ("# Node.js\n\n### TSC (Technical Steering Committee)\n\n#### TSC voting members\n\n"
              "* [TSC-Voting](https://example.com/tsc-voting) -\n  **T**\n\n#### TSC emeriti members\n\n"
              "* [tsc-emeritus](https://example.com/tsc-emeritus) -\n  **E**\n\n### Collaborators\n\n"
              "* [Collab-Active](https://example.com/collab-active) -\n  **C**\n\n### Collaborator emeriti\n\n"
              "* [collab-emeritus](https://example.com/collab-emeritus) -\n  **E**\n\n### Triagers\n\n"
              "* [someone](https://example.com/someone) -\n  **S**\n")

    def prefetch_screen(self, body="", labels=(), messages=(), comments=(), author="someone"):
        """Prefetch PR 5 with this body, labels, commit messages, PR comments, and author."""
        head = self.make_clone(readme=self.README)
        self.cache("release-lines.txt", "active release lines: v22 v24 v26\n")
        rules = self.prefetch_rules(head)
        pr = rules[1]["stdout"]
        pr["body"], pr["labels"] = body, [{"name": l} for l in labels]
        pr["author"] = {"login": author}
        pr["commits"] = [{"oid": head, "messageHeadline": "x", "messageBody": m} for m in messages]
        disc = rules[3]["stdout"]["data"]["repository"]["pullRequest"]["comments"]
        disc["nodes"] = [{"author": {"login": who}, "authorAssociation": assoc, "createdAt": ago(hours=2),
                          "isMinimized": False, "minimizedReason": None, "body": text}
                         for who, assoc, text in comments]
        disc["totalCount"] = len(comments)
        self.rules(rules)
        out = self.run_bank("prefetch", "5").stdout
        return head, out, json.loads((self.bank / "dossier" / "5" / "screen.json").read_text())

    FLAGGED = dict(labels=["stream", "agentscan:automated-account"])

    def test_screen_passes_a_pr_with_no_automation_signals(self):
        _, out, sc = self.prefetch_screen(body="Fixes a bug.")
        self.assertEqual(sc["result"], "pass")
        self.assertEqual(self.entry(5)["state"], "preparing")
        self.assertIn("gates:", out)

    def test_screen_skips_collaborators_even_when_flagged(self):
        for login in ("Collab-Active", "tsc-voting"):
            with self.subTest(login=login):
                shutil.rmtree(self.tmp / "clone", ignore_errors=True)
                shutil.rmtree(self.tmp / "work", ignore_errors=True)
                shutil.rmtree(self.tmp / "upstream.git", ignore_errors=True)
                shutil.rmtree(self.bank / "dossier", ignore_errors=True)
                (self.bank / "prs" / "5.md").unlink(missing_ok=True)
                _, _, sc = self.prefetch_screen(body="No disclosure.", author=login, **self.FLAGGED)
                self.assertEqual((sc["result"], sc["why"]), ("pass", "skipped: collaborator"))
                self.assertEqual(self.entry(5)["lane"], "fresh")
                self.assertEqual(self.entry(5)["screen"], "pass: skipped: collaborator")

    def test_screen_does_not_trust_emeriti_or_triagers(self):
        cached = json.loads((self.bank / "cache" / "collaborators.json").read_text()) \
            if (self.bank / "cache" / "collaborators.json").exists() else None
        self.assertIsNone(cached)
        _, _, sc = self.prefetch_screen(body="No disclosure.", author="someone", **self.FLAGGED)
        self.assertEqual(sc["result"], "fail")
        logins = json.loads((self.bank / "cache" / "collaborators.json").read_text())
        self.assertEqual(logins, ["collab-active", "tsc-voting"])

    def test_screen_passes_an_unflagged_pr_that_discloses_ai_use(self):
        _, out, sc = self.prefetch_screen(
            body="AI disclosure: Claude Code was used to write the change.",
            labels=["http"], messages=["fix\n\nAssisted-by: a closed-source coding agent\nSigned-off-by: x"])
        self.assertEqual(sc["result"], "pass", sc)
        self.assertEqual(sc["signals"]["ai_trailers"], ["Assisted-by: a closed-source coding agent"])
        e = self.entry(5)
        self.assertEqual((e["state"], e["lane"]), ("preparing", "fresh"))
        self.assertEqual(e["screen"], "pass: disclosed")

    def test_screen_fails_a_flagged_pr_with_no_disclosure_and_needs_no_agent(self):
        _, out, sc = self.prefetch_screen(
            body="This fixes duplicate bytes in Utf8Stream.", comments=[("github-actions", "CONTRIBUTOR", self.WELCOME)],
            **self.FLAGGED)
        self.assertEqual(sc["result"], "fail")
        self.assertTrue(sc["signals"]["agentscan_caution"])
        self.assertTrue(sc["signals"]["first_contribution"])
        e = self.entry(5)
        self.assertEqual((e["state"], e["lane"]), ("ready", "screen"))
        self.assertIn("No preparing agent", out)
        self.assertIn("### Outline for your comment", e["body"])
        # No CI or gates calls for a screened PR.
        self.assertFalse(any("statusCheckRollup" in " ".join(c) for c in self.calls()))
        self.assertFalse((self.bank / "dossier" / "5" / "ci.txt").exists())
        self.assertIn("(screen fail: agentscan:automated-account, AgentScan caution, first contribution, "
                      "no disclosure)", self.run_bank("list").stdout)
        self.assertIn("SCREEN 5 ready fail:", self.run_bank("plan", "--all").stdout)
        shown = self.run_bank("present").stdout
        self.assertIn("(automation screen)", shown)

    def test_screen_is_unclear_when_a_flagged_pr_discloses_ai_use(self):
        _, _, sc = self.prefetch_screen(body="This change was generated with Copilot.", **self.FLAGGED)
        self.assertEqual(sc["result"], "unclear")
        self.assertEqual(sc["why"], "flagged by AgentScan; AI use disclosed")
        self.assertEqual(self.entry(5)["lane"], "screen")

    def test_screen_entries_do_not_use_the_banks_room(self):
        self.write_entry(1, state="ready", lane="screen")
        self.cache("candidates.json", json.dumps({"9": {"title": "t", "draft": False, "state": "OPEN",
                                                        "updated": ago(minutes=1), "head": A, "author": "x",
                                                        "paths": ["lib/net.js"]}}))
        self.cache("queue.tsv", "9\tnet\t-\n")
        self.assertIn("PREPARE 9", self.run_bank("plan", "--target", "1").stdout)

    def screen_hold(self):
        """A screen entry for PR 5 by `bot-ish`, then my comment on it."""
        self.write_entry(5, state="ready", lane="screen", author="bot-ish", prepared_at=ago(hours=1),
                         created_at=ago(hours=1), screen="fail: agentscan:automated-account")
        mine = {"author": {"login": "me"}, "createdAt": ago(minutes=30), "body": "please see the AI policy"}
        node = pr_node(5, A, author="bot-ish", comments=[mine])
        self.rules([self.sync_rule(node)])
        self.run_bank("sync")
        return mine

    def test_a_comment_on_a_screen_entry_waits_48_hours_for_the_author(self):
        self.screen_hold()
        e = self.entry(5)
        self.assertEqual(e["state"], "waiting")
        w = dict(t.partition("=")[::2] for t in e["wait_for"].split(","))
        self.assertEqual(w["author"], "bot-ish")
        self.assertEqual(w["push"], A[:12])
        self.assertIn("screen", w)
        until = datetime.strptime(w["until"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        since = datetime.strptime(e["wait_since"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        self.assertEqual(until - since, timedelta(hours=48))

    def test_an_author_comment_wakes_a_screen_hold_for_a_real_review(self):
        mine = self.screen_hold()
        theirs = {"author": {"login": "bot-ish"}, "createdAt": ago(minutes=1), "body": "I wrote and tested it."}
        self.rules([self.sync_rule(pr_node(5, A, author="bot-ish", comments=[mine, theirs]))])
        self.run_bank("sync")
        e = self.entry(5)
        self.assertEqual(e["state"], "done")
        self.assertEqual(e["note"], "woke: author responded: comment by @bot-ish")
        # The next prefetch skips the screen: the user asked for this review.
        _, out, sc = self.prefetch_screen(body="No disclosure.", labels=["agentscan:automated-account"])
        self.assertEqual(sc["result"], "pass")
        self.assertEqual((self.entry(5)["state"], self.entry(5)["lane"]), ("preparing", "fresh"))

    def test_an_author_push_wakes_a_screen_hold(self):
        mine = self.screen_hold()
        self.rules([self.sync_rule(pr_node(5, B, author="bot-ish", comments=[mine]))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["note"], f"woke: author responded: new push {B[:12]}")

    def test_no_author_response_brings_back_a_close_recommendation(self):
        mine = self.screen_hold()
        e = self.entry(5)
        # Pretend the 48 hours passed.
        e["wait_for"] = e["wait_for"].replace(e["wait_for"].split("until=")[1].split(",")[0], ago(minutes=1))
        self.write_entry(5, **{k: v for k, v in e.items() if k not in ("body", "pr")})
        self.rules([self.sync_rule(pr_node(5, A, author="bot-ish", comments=[mine]))])
        self.run_bank("sync")
        e = self.entry(5)
        self.assertEqual((e["state"], e["lane"]), ("ready", "screen"))
        self.assertEqual(e["note"], "screen: no author response; recommend closing per the moderation policy")
        self.assertIn("Recommend closing it", e["body"])
        # My earlier comment doesn't start another hold.
        self.rules([self.sync_rule(pr_node(5, A, author="bot-ish", comments=[mine]))])
        self.run_bank("sync")
        self.assertEqual(self.entry(5)["state"], "ready")

    def test_hold_screen_sets_the_author_and_48_hours(self):
        self.write_entry(5, state="done", lane="fresh", author="bot-ish", disposition="commented")
        self.run_bank("hold", "5", "--screen", "asked", "for", "attestation")
        e = self.entry(5)
        self.assertEqual(e["note"], "screen: waiting for the author: asked for attestation")
        self.assertIn("author=bot-ish", e["wait_for"])
        self.assertIn("screen", e["wait_for"])
        self.assertIn("a comment by @bot-ish", self.run_bank("list").stdout)



    # Backoff: dormant queue refreshes, failed refreshes, and quiet ticks.

    def queue_rule(self, *nums, rc=0, stderr=""):
        data = {f"p{n}": {"number": n, "title": f"PR {n}", "isDraft": False, "state": "OPEN",
                          "updatedAt": ago(minutes=1), "headRefOid": A, "author": {"login": "someone"},
                          "files": {"nodes": [{"path": "lib/net.js"}]}} for n in nums}
        rule = {"match": ["graphql", "files(first:100)"], "rc": rc, "stderr": stderr,
                "stdout": {"data": {"repository": data}} if rc == 0 else ""}
        return rule

    def fill_bank(self, n=6):
        for i in range(n):
            self.write_entry(100 + i, state="ready")

    def test_a_full_bank_skips_a_stale_queue_refresh(self):
        env = dict(self.env, REFRESH_MINUTES="120")
        self.fill_bank()
        self.cache("queue.stamp", ago(hours=3))
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([self.queue_rule(5), self.sync_rule(*[pr_node(100 + i, A) for i in range(6)])])
        out = self.run_bank("tick", env=env).stdout
        self.assertIn("dormant (bank full)", out)
        self.assertNotIn("files(first:100)", json.dumps(self.calls()))
        self.assertNotIn("5\thttp", (self.bank / "cache" / "queue.tsv").read_text()
                         if (self.bank / "cache" / "queue.tsv").exists() else "")

    def test_no_recent_activity_skips_a_stale_queue_refresh(self):
        env = dict(self.env, REFRESH_MINUTES="120")
        self.cache("queue.stamp", ago(hours=3))
        self.cache("activity.json", json.dumps({"at": ago(hours=5)}))
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([self.queue_rule(5)])
        out = self.run_bank("tick", env=env).stdout
        self.assertIn("dormant (no activity since", out)
        self.assertNotIn("files(first:100)", json.dumps(self.calls()))

    def test_recent_activity_and_room_refresh_a_stale_queue(self):
        env = dict(self.env, REFRESH_MINUTES="120")
        self.cache("queue.stamp", ago(hours=3))
        self.cache("activity.json", json.dumps({"at": ago(minutes=30)}))
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([self.queue_rule(5)])
        out = self.run_bank("tick", env=env).stdout
        self.assertIn("team queue: 1 PRs", out)

    def test_a_dormant_bank_still_refreshes_every_six_hours(self):
        env = dict(self.env, REFRESH_MINUTES="120")
        self.fill_bank()
        self.cache("queue.stamp", ago(hours=7))
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([self.queue_rule(5), self.sync_rule(*[pr_node(100 + i, A) for i in range(6)])])
        out = self.run_bank("tick", env=env).stdout
        self.assertIn("team queue: 1 PRs", out)
        stamp = (self.bank / "cache" / "queue.stamp").read_text()
        self.assertGreater(stamp, ago(minutes=5))

    def test_a_failed_refresh_backs_off_two_four_then_eight_hours(self):
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([{"match": ["graphql", "files(first:100)"], "rc": 1, "stderr": "HTTP 502: Bad Gateway",
                     "stdout": ""}])
        out = self.run_bank("tick").stdout
        self.assertRegex(out, r"team queue: .*metadata FAILED.*HTTP 502.*failed 1 time\(s\) in a row, next try after")
        attempt = json.loads((self.bank / "cache" / "queue-attempt.json").read_text())
        self.assertEqual(attempt["failures"], 1)
        # The next tick doesn't retry, and says why.
        calls = len(self.calls())
        out = self.run_bank("tick").stdout
        self.assertRegex(out, r"team queue: last refresh failed 1 time\(s\) in a row \(.*HTTP 502.*\); next try after")
        self.assertEqual(sum("files(first:100)" in json.dumps(c) for c in self.calls()[calls:]), 0)
        # Each failure doubles the wait, capped at 8 hours.
        for failures, hours in ((1, 2), (2, 4), (3, 8), (5, 8)):
            at = datetime.now(timezone.utc) - timedelta(hours=hours) + timedelta(minutes=5)
            self.cache("queue-attempt.json", json.dumps({"at": iso(at), "failures": failures, "error": "x"}))
            self.assertIn("last refresh failed", self.run_bank("tick").stdout, (failures, hours))
            at -= timedelta(minutes=10)
            self.cache("queue-attempt.json", json.dumps({"at": iso(at), "failures": failures, "error": "x"}))
            self.assertNotIn("last refresh failed", self.run_bank("tick").stdout, (failures, hours))

    def test_a_successful_refresh_clears_the_failure_count(self):
        self.cache("queue-attempt.json", json.dumps({"at": ago(hours=9), "failures": 3, "error": "x"}))
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([self.queue_rule(5)])
        self.run_bank("tick")
        attempt = json.loads((self.bank / "cache" / "queue-attempt.json").read_text())
        self.assertEqual(attempt["failures"], 0)

    def test_refresh_forces_a_refresh_during_failure_backoff(self):
        self.cache("queue-attempt.json", json.dumps({"at": ago(minutes=5), "failures": 1, "error": "x"}))
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([self.queue_rule(5)])
        self.assertIn("team queue: 1 PRs", self.run_bank("tick", "--refresh").stdout)

    def test_graphql_keeps_the_message_of_a_failure_without_an_errors_list(self):
        self.queue_out.write_text("5\thttp\t-\n")
        self.rules([{"match": ["graphql", "files(first:100)"], "rc": 1, "stdout": {
            "message": "You have exceeded a secondary rate limit.", "documentation_url": "x"}}])
        out = self.run_bank("tick", "--refresh").stdout
        self.assertIn("secondary rate limit", out)

    def backoff_env(self):
        return dict(self.env, TICK_BACKOFF_MAX_MINUTES="240")

    def quiet_tick(self, env, *args):
        self.cache("queue.stamp", ago(minutes=1))
        return self.run_bank("tick", *args, env=env).stdout

    def tick_state(self):
        return json.loads((self.bank / "cache" / "tick.json").read_text())

    def test_quiet_ticks_back_off_doubling_up_to_four_hours(self):
        env = self.backoff_env()
        out = self.quiet_tick(env)
        self.assertIn("tick: quiet (1 in a row); next tick on the normal cadence", out)
        self.assertIsNone(self.tick_state()["next_due"])
        expect = {2: 40, 3: 80, 4: 160, 5: 240, 6: 240}
        for q in range(2, 7):
            st = self.tick_state()
            st["next_due"] = None  # pretend the wait passed
            self.cache("tick.json", json.dumps(st))
            out = self.quiet_tick(env)
            self.assertIn(f"tick: quiet ({q} in a row); backing off, next real tick at", out)
            due = datetime.fromisoformat(self.tick_state()["next_due"].replace("Z", "+00:00"))
            minutes = (due - datetime.now(timezone.utc)).total_seconds() / 60
            self.assertAlmostEqual(minutes, expect[q] - 2, delta=1.5, msg=q)

    def test_a_backed_off_tick_makes_no_gh_call_and_says_when(self):
        env = dict(self.backoff_env())
        env.pop("ME")  # me() would call gh api user
        self.cache("tick.json", json.dumps({"quiet": 3, "next_due": ago(minutes=-60)}))
        out = self.run_bank("tick", env=env).stdout
        self.assertRegex(out, r"^tick .*: backed off after 3 quiet ticks in a row; next real tick at ")
        self.assertEqual(len(out.strip().splitlines()), 1)
        self.assertEqual(self.calls(), [])

    def test_tick_now_bypasses_the_backoff(self):
        env = self.backoff_env()
        self.cache("tick.json", json.dumps({"quiet": 3, "next_due": ago(minutes=-60)}))
        out = self.quiet_tick(env, "--now")
        self.assertIn("plan:", out)
        self.assertEqual(self.tick_state()["quiet"], 4)

    def test_a_change_resets_the_tick_backoff(self):
        env = self.backoff_env()
        self.cache("tick.json", json.dumps({"quiet": 4, "next_due": None}))
        self.write_entry(5, state="ready")
        self.rules([self.sync_rule(pr_node(5, A, state="CLOSED", closed_at=ago(minutes=1)))])
        out = self.quiet_tick(env)
        self.assertIn("tick: changes this tick", out)
        self.assertEqual(self.tick_state(), {"quiet": 0, "next_due": None, "last": self.tick_state()["last"]})

    def test_a_prepare_line_counts_as_a_change(self):
        env = self.backoff_env()
        self.cache("tick.json", json.dumps({"quiet": 2, "next_due": None}))
        self.rereview_out.write_text(f"RE-REVIEW\t5\tAPPROVED\t{A}\t{A}\t{B}\t1\tMERGEABLE\t{ago(minutes=1)}\n")
        out = self.quiet_tick(env)
        self.assertIn("PREPARE 5", out)
        self.assertEqual(self.tick_state()["quiet"], 0)

    def test_user_commands_reset_the_tick_backoff_and_count_as_activity(self):
        env = self.backoff_env()
        for cmd in (("sync",), ("present",), ("put", "5", "x", "--head", A), ("prefetch", "5")):
            with self.subTest(cmd=cmd[0]):
                self.cache("tick.json", json.dumps({"quiet": 4, "next_due": ago(minutes=-60)}))
                (self.bank / "cache" / "activity.json").unlink(missing_ok=True)
                self.run_bank(*cmd, env=env, check=False)
                self.assertEqual(self.tick_state()["quiet"], 0, cmd)
                self.assertIsNone(self.tick_state()["next_due"], cmd)
                self.assertIn("at", json.loads((self.bank / "cache" / "activity.json").read_text()))


if __name__ == "__main__":
    unittest.main()
