#!/bin/zsh
# Reproduce a claimed failure mode on a PR head vs the main baseline.
# Builds main, runs the test N times; builds the PR head, runs it N times;
# reports pass/crash/fail for each so a crash (or its fix) is demonstrated,
# not just traced. Returns the tree to main and cleans up the pr-<n> ref.
# Usage: repro.sh <pr> <test-path> [runs]        (run from the node repo root)
#   e.g. repro.sh 64623 test/parallel/test-http2-respond-with-file-connection-abort.js 25
#
# Builds and runs inside the devcontainer through devc.sh (QUIC on by default).
# LOCAL=1 builds and runs on the host instead, with ccache and build-node.sh's
# configure flags.
#
# Native-addon tests are handled automatically: a test path under
# test/node-api/, test/js-native-api/, or test/addons/ needs its addon compiled
# against the freshly-built node (via the matching `make build-*` target) before
# it can run — `out/Release/node <test>` alone fails with "Cannot find module".
# repro.sh builds the right addons per rebuild so these tests actually run.
DIR="${0:A:h}"; source "$DIR/lib.sh"
n="$1"; T="$2"; N="${3:-20}"
{ [ -z "$n" ] || [ -z "$T" ]; } && { echo "usage: repro.sh <pr> <test-path> [runs]" >&2; exit 2; }

# Which `make` addon target (if any) this test needs built before it can run.
case "$T" in
  test/node-api/*)       ADDON_TARGET="build-node-api-tests" ;;
  test/js-native-api/*)  ADDON_TARGET="build-js-native-api-tests" ;;
  test/addons/*)         ADDON_TARGET="build-addons" ;;
  *)                     ADDON_TARGET="" ;;
esac

if [ "${LOCAL:-0}" = "1" ]; then
  export CC="ccache cc" CXX="ccache c++"
  build() {
    ./configure --ninja --experimental-quic --node-builtin-modules-path "$(pwd)" >/dev/null 2>&1 || return 1
    ninja -C out/Release node >/dev/null 2>&1 || return 1
    [ -n "$ADDON_TARGET" ] && { echo "    (building addons: make $ADDON_TARGET)" >&2; make "$ADDON_TARGET" >/dev/null 2>&1; }
    return 0
  }
  node_run() { out/Release/node "$@"; }
else
  build() {
    "$DIR/devc.sh" build >/dev/null 2>&1 || { echo "    devc.sh build failed; run it directly to see why" >&2; return 1; }
    [ -n "$ADDON_TARGET" ] && { echo "    (building addons: make $ADDON_TARGET)" >&2; "$DIR/devc.sh" run make "$ADDON_TARGET" >/dev/null 2>&1; }
    return 0
  }
  node_run() { "$DIR/devc.sh" run out/Release/node "$@"; }
fi
runN()  { local pass=0 crash=0 fail=0 rc; for i in $(seq 1 $N); do out=$(node_run "$T" 2>&1); rc=$?
            if [ $rc -eq 0 ]; then pass=$((pass+1)); elif [ $rc -gt 128 ]; then crash=$((crash+1)); echo "    run $i: CRASH signal $((rc-128))" >&2; else fail=$((fail+1)); fi
          done; echo "pass=$pass crash=$crash fail=$fail / $N"; }

echo "== baseline: main =="
git checkout main >/dev/null 2>&1; build || exit 1
echo "  main $(git rev-parse --short HEAD): $(runN)"

echo "== PR #$n =="
git fetch upstream "pull/$n/head:pr-$n" >/dev/null 2>&1
git checkout "pr-$n" >/dev/null 2>&1; build || { git checkout main >/dev/null 2>&1; exit 1; }
echo "  pr-$n $(git rev-parse --short HEAD): $(runN)"

git checkout main >/dev/null 2>&1; git branch -D "pr-$n" >/dev/null 2>&1
echo "(returned to main baseline)"
