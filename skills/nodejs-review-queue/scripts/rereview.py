#!/usr/bin/env python3
"""Step 1b: the re-review lane.

Finds open PRs the user has reviewed (`reviewed-by:$ME`, which finds your own
past reviews; it is not the prohibited reviewer-assignment search), compares the
commit of the user's latest review to the current head, and sorts each PR into
an action bucket so nothing they reviewed stalls or becomes land-ready unseen.

A reviewer's state is their latest APPROVED, CHANGES_REQUESTED, or DISMISSED
review. COMMENTED reviews don't change it, matching how GitHub computes
review decisions.

Buckets:
  RE-REVIEW-ASAP  changes requested + head advanced (author pushed a fix)
  RE-REVIEW       approved + head advanced (approval may not cover new commits)
  CQ-CANDIDATE    approved on current head, enough approvals (2, or 1 if open
                  >7 days), mergeable, no commit-queue label
  UNADDRESSED     changes requested, head unchanged (waiting on author)
  CURRENT         everything else (collapsed unless --all)

GitHub computes `mergeable` lazily, so UNKNOWN is common. CQ-CANDIDATE rows
with UNKNOWN are flagged "re-check mergeable".

Usage: rereview.py [--all]        (run anywhere; uses gh)
Env: REPO (default nodejs/node), ME (default: gh api user).
"""
import json, os, subprocess, sys
from datetime import datetime, timedelta, timezone

REPO = os.environ.get("REPO", "nodejs/node")
OWNER, NAME = REPO.split("/")
ME = os.environ.get("ME") or subprocess.check_output(
    ["gh", "api", "user", "--jq", ".login"], text=True).strip()
SHOW_ALL = "--all" in sys.argv
DECISIVE = {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def latest_states(reviews):
    """Map reviewer login -> their latest decisive review node."""
    out = {}
    for r in sorted(reviews, key=lambda r: r["submittedAt"] or ""):
        login = (r.get("author") or {}).get("login")
        if login and r["state"] in DECISIVE:
            out[login] = r
    return out


def classify(d):
    head = d["headRefOid"]
    labels = {l["name"] for l in d["labels"]["nodes"]}
    states = latest_states(d["reviews"]["nodes"])
    my = states.get(ME)
    if not my:
        return None, 0  # only commented, or my review was the only one dismissed
    advanced = (my.get("commit") or {}).get("oid", head) != head
    approvals = sum(1 for r in states.values() if r["state"] == "APPROVED")
    created = datetime.fromisoformat(d["createdAt"].replace("Z", "+00:00"))
    needed = 1 if datetime.now(timezone.utc) - created > timedelta(days=7) else 2
    st = my["state"]
    if st == "CHANGES_REQUESTED":
        return ("RE-REVIEW-ASAP" if advanced else "UNADDRESSED"), approvals
    if st == "APPROVED" and advanced:
        return "RE-REVIEW", approvals
    if st == "APPROVED" and approvals >= needed and "commit-queue" not in labels \
            and d["mergeable"] in ("MERGEABLE", "UNKNOWN"):
        return "CQ-CANDIDATE", approvals
    return "CURRENT", approvals


def main():
    nums = gh("api", "-X", "GET", "search/issues", "--paginate",
              "-f", f"q=repo:{REPO} is:pr is:open draft:false reviewed-by:{ME} -author:{ME}",
              "-f", "per_page=100", "--jq", ".items[].number").split()
    if not nums:
        print("(no open PRs reviewed by you)")
        return

    rows = []
    for i in range(0, len(nums), 30):
        fields = " ".join(
            f"p{n}: pullRequest(number:{n}){{number title createdAt headRefOid mergeable "
            f"labels(first:50){{nodes{{name}}}} "
            f"reviews(last:100){{nodes{{author{{login}} state commit{{oid}} submittedAt}}}}}}"
            for n in nums[i:i + 30])
        q = f'query{{repository(owner:"{OWNER}",name:"{NAME}"){{{fields}}}}}'
        data = json.loads(gh("api", "graphql", "-f", f"query={q}"))
        rows.extend(data["data"]["repository"].values())

    order = ["RE-REVIEW-ASAP", "RE-REVIEW", "CQ-CANDIDATE", "UNADDRESSED", "CURRENT"]
    icons = dict(zip(order, ["🔴", "🟠", "✅", "⏸", "·"]))
    buckets = {b: [] for b in order}
    for d in rows:
        b, approvals = classify(d)
        if b:
            buckets[b].append((d["number"], approvals, d["mergeable"], d["title"][:60]))

    for b in order:
        items = buckets[b]
        if not items:
            continue
        if b == "CURRENT" and not SHOW_ALL:
            print(f"\n{icons[b]} CURRENT ({len(items)}): collapsed; --all to list")
            continue
        print(f"\n{icons[b]} {b} ({len(items)})")
        for num, ap, mrg, title in sorted(items):
            note = ""
            if b in ("CQ-CANDIDATE", "RE-REVIEW"):
                note = f"approvals={ap} {mrg}"
                if b == "CQ-CANDIDATE" and mrg == "UNKNOWN":
                    note += " (re-check mergeable)"
            print(f"  https://github.com/{REPO}/pull/{num}  {note}  {title}")


if __name__ == "__main__":
    main()
