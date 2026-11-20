#!/usr/bin/env python3
"""A stand-in for gh, for the bank tests. Installed as `gh` on PATH.

Rules come from $FAKE_GH_DIR/rules.json, a list of objects:
  match      substrings that must all appear in the call (arguments, plus the
             text of any `-F query=@file` or `-f query=...`)
  stdout     text, or any JSON value (printed as JSON)
  stderr     text
  rc         exit status (default 0)
  times      how many calls the rule answers (default: unlimited)
  wait_file  block until this file exists (at most 30 s), after writing
             <wait_file>.reached so the test knows the call is in flight
The first rule that matches and has calls left answers. Every call is
appended to $FAKE_GH_DIR/calls.log. An unmatched call exits 1.
"""
import json, os, sys, time
from pathlib import Path

d = Path(os.environ["FAKE_GH_DIR"])
args = sys.argv[1:]
text = " ".join(args)
for i, a in enumerate(args):
    for prefix in ("query=@",):
        if a.startswith(prefix):
            text += " " + Path(a[len(prefix):]).read_text()
    if a.startswith("query=") and not a.startswith("query=@"):
        text += " " + a[len("query="):]
with open(d / "calls.log", "a") as log:
    log.write(json.dumps(args) + "\n")

rules_path = d / "rules.json"
rules = json.loads(rules_path.read_text()) if rules_path.exists() else []
for i, r in enumerate(rules):
    if r.get("times") == 0 or not all(m in text for m in r.get("match", [])):
        continue
    if "times" in r:
        r["times"] -= 1
        rules_path.write_text(json.dumps(rules))
    if r.get("wait_file"):
        Path(r["wait_file"] + ".reached").write_text("")
        for _ in range(300):
            if Path(r["wait_file"]).exists():
                break
            time.sleep(0.1)
    out = r.get("stdout", "")
    sys.stdout.write(out if isinstance(out, str) else json.dumps(out))
    sys.stderr.write(r.get("stderr", ""))
    sys.exit(r.get("rc", 0))
sys.stderr.write(f"fake gh: no rule for: {text[:300]}\n")
sys.exit(1)
