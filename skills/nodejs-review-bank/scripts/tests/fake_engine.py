#!/usr/bin/env python3
"""A stand-in for podman or docker, for testing devc.sh's image and prune
commands. Set DEVC_ENGINE to this file.

State comes from $FAKE_ENGINE_DIR/state.json:
  image       {id, digests: [...], created}, or absent when the image is missing
  containers  {name: {state, image, commit}}
  ps          output of `exec <name> ps ...`
  volumes     volume names; `volume rm` removes one
Every call is appended to $FAKE_ENGINE_DIR/calls.log.
"""
import json, os, sys
from pathlib import Path

d = Path(os.environ["FAKE_ENGINE_DIR"])
a = sys.argv[1:]
with open(d / "calls.log", "a") as log:
    log.write(json.dumps(a) + "\n")
p = d / "state.json"
st = json.loads(p.read_text())
if a[:2] == ["image", "inspect"]:
    im = st.get("image") or sys.exit(125)
    print(f"sha256:{im['id']}|{''.join(x + ' ' for x in im['digests'])}|{im['created']}")
elif a[:2] == ["container", "inspect"]:
    c = st.get("containers", {}).get(a[2]) or sys.exit(125)
    print(f"{c['state']}|sha256:{c['image']}|{c['commit']}")
elif a[:1] == ["exec"]:
    print(st.get("ps", ""))
elif a[:2] == ["volume", "ls"]:
    print("\n".join(st.get("volumes", [])))
elif a[:2] == ["volume", "rm"]:
    st["volumes"].remove(a[2])
    p.write_text(json.dumps(st))
else:
    sys.exit(1)
