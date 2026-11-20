#!/usr/bin/env python3
"""A stand-in for nodejs-contribute's devc.sh, for the bank tests. Installed as
devc.sh in the stub NC_SCRIPTS directory.

State comes from $FAKE_DEVC_DIR/state.json:
  image   key=value fields every checkout shares (image_id, image_digests, ...)
  slots   {checkout realpath: fields for that checkout (container_image, ...)}
  rc      {command: exit status}
  wait    {command: file}: write <file>.reached, then wait for <file> (30 s)
Without state.json every call exits 1. `build` moves the checkout's container
to image_id. Every call is appended to $FAKE_DEVC_DIR/calls.log as
[checkout realpath, command].
"""
import json, os, sys, time
from pathlib import Path

d = Path(os.environ["FAKE_DEVC_DIR"])
cwd, cmd = os.path.realpath(os.getcwd()), (sys.argv[1:] or [""])[0]
with open(d / "calls.log", "a") as log:
    log.write(json.dumps([cwd, cmd]) + "\n")
state_path = d / "state.json"
if not state_path.exists():
    sys.exit(1)
state = json.loads(state_path.read_text())
wait = state.get("wait", {}).get(cmd)
if wait:
    Path(wait + ".reached").write_text("")
    for _ in range(300):
        if Path(wait).exists():
            break
        time.sleep(0.1)
slot = state.setdefault("slots", {}).setdefault(cwd, {})
info = {"image_id": "-", "image_digests": "", "image_created": "", "container_state": "running",
        "container_image": "-", "image_commit": "-", "busy": "no", "stale_volumes": ""}
info.update(state.get("image", {}))
info.update(slot)
if cmd == "image":
    if "outdated" not in slot:
        info["outdated"] = "yes" if info["container_image"] not in ("-", info["image_id"]) else "no"
    print("\n".join(f"{k}={v}" for k, v in info.items()))
elif cmd == "build" and not state.get("rc", {}).get(cmd):
    slot.update(container_image=info["image_id"], outdated="no", container_state="running")
    state_path.write_text(json.dumps(state))
elif cmd == "down":
    slot.update(container_state="none")
    state_path.write_text(json.dumps(state))
sys.exit(state.get("rc", {}).get(cmd, 0))
