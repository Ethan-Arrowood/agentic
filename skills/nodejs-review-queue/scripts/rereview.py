#!/usr/bin/env python3
"""Step 1b — the re-review lane.

Finds open PRs the user has reviewed (`reviewed-by:$ME`, which is finding your
own past reviews — NOT the prohibited reviewer-assignment search), compares the
user's latest-review commit to the current head, and classifies each into an
actionable bucket so nothing they reviewed silently stalls or silently becomes
land-ready.

Buckets:
  RE-REVIEW-ASAP  changes-requested + head advanced (author pushed a fix)
  RE-REVIEW       approved + head advanced (approval may not cover new commits)
  CQ-CANDIDATE    approved on current head, >=2 approvals, mergeable, no commit-queue label
  UNADDRESSED     changes-requested, head unchanged (waiting on author)
  CURRENT         approved & current (collapsed unless --all)

Usage: rereview.py [--all]        (run anywhere; uses gh)
Env: REPO (default nodejs/node), ME (default: gh api user).
"""
import json, os, subprocess, sys

REPO = os.environ.get("REPO", "nodejs/node")
ME = os.environ.get("ME") or subprocess.check_output(
    ["gh", "api", "user", "--jq", ".login"], text=True).strip()
SHOW_ALL = "--all" in sys.argv


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def main():
    nums = gh("api", "-X", "GET", "search/issues", "-f",
              f'q=repo:{REPO} is:pr is:open draft:false reviewed-by:{ME} -author:{ME}',
              "--jq", ".items[].number").split()
    if not nums:
        print("(no open PRs reviewed by you)")
        return

    rows = []
    for i in range(0, len(nums), 30):
        chunk = nums[i:i + 30]
        fields = " ".join(
            f'p{n}: pullRequest(number:{n}){{number title headRefOid mergeable '
            f'labels(first:20){{nodes{{name}}}} '
            f'reviews(first:50){{nodes{{author{{login}} state commit{{oid}} submittedAt}}}}}}'
            for n in chunk)
        q = f'query{{repository(owner:"{REPO.split("/")[0]}",name:"{REPO.split("/")[1]}"){{{fields}}}}}'
        data = json.loads(gh("api", "graphql", "-f", f"query={q}"))
        for d in data["data"]["repository"].values():
            rows.append(d)

    buckets = {"RE-REVIEW-ASAP": [], "RE-REVIEW": [], "CQ-CANDIDATE": [],
               "UNADDRESSED": [], "CURRENT": []}
    for d in rows:
        head = d["headRefOid"]
        labels = [l["name"] for l in d["labels"]["nodes"]]
        mine = sorted((r for r in d["reviews"]["nodes"] if r["author"]["login"] == ME),
                      key=lambda r: r["submittedAt"])
        if not mine:
            continue
        my = mine[-1]
        my_commit = (my.get("commit") or {}).get("oid", "")
        advanced = bool(my_commit) and my_commit != head
        latest = {}
        for r in d["reviews"]["nodes"]:
            latest[r["author"]["login"]] = r["state"]
        approvals = sum(1 for s in latest.values() if s == "APPROVED")
        st = my["state"]
        if st == "CHANGES_REQUESTED" and advanced:
            b = "RE-REVIEW-ASAP"
        elif st == "CHANGES_REQUESTED":
            b = "UNADDRESSED"
        elif st == "APPROVED" and advanced:
            b = "RE-REVIEW"
        elif st == "APPROVED" and approvals >= 2 and d["mergeable"] == "MERGEABLE" \
                and "commit-queue" not in labels:
            b = "CQ-CANDIDATE"
        else:
            b = "CURRENT"
        buckets[b].append((d["number"], approvals, d["mergeable"], d["title"][:60]))

    icons = {"RE-REVIEW-ASAP": "🔴", "RE-REVIEW": "🟠", "CQ-CANDIDATE": "✅",
             "UNADDRESSED": "⏸", "CURRENT": "·"}
    for b in ("RE-REVIEW-ASAP", "RE-REVIEW", "CQ-CANDIDATE", "UNADDRESSED", "CURRENT"):
        items = buckets[b]
        if not items or (b == "CURRENT" and not SHOW_ALL):
            if b == "CURRENT" and items and not SHOW_ALL:
                print(f"\n{icons[b]} CURRENT ({len(items)}) — collapsed; --all to list")
            continue
        print(f"\n{icons[b]} {b} ({len(items)})")
        for num, ap, mrg, title in sorted(items):
            note = f"apprs={ap} {mrg}" if b in ("CQ-CANDIDATE", "RE-REVIEW") else ""
            print(f"  #{num}  {note:16} {title}")


if __name__ == "__main__":
    main()
