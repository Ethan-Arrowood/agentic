#!/bin/zsh
# Reproduce a claimed failure mode on a PR vs the main baseline.
# Builds main, runs the test N times; builds the PR, runs it N times;
# reports pass/crash/fail for each so a crash (or its fix) is demonstrated,
# not just traced. Needs a clean tree. Returns the tree to main.
# Usage: repro.sh <pr> <test-path> [runs]        (run from the node repo root)
#   e.g. repro.sh 64623 test/parallel/test-http2-respond-with-file-connection-abort.js 25
#
# The PR's commits are rebased onto main in a temporary repro-<n> branch, as
# CI does, so the build is incremental. REBASE=0 builds the PR head as-is.
#
# Builds and runs inside the devcontainer through devc.sh. QUIC=1 adds
# --experimental-quic, for QUIC PRs only.
# LOCAL=1 builds and runs on the host instead, with ccache.
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
    local quic=""; [ "${QUIC:-0}" = "1" ] && quic="--experimental-quic"
    ./configure --ninja $quic --node-builtin-modules-path "$(pwd)" >/dev/null 2>&1 || return 1
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
# Run the test N times with the flags from its `// Flags:` line, as
# tools/test.py does. Without them, a test that imports a flag-gated builtin
# (node:quic, node:stream/iter) fails at load time on every build. The flags are
# read once for main and once for the PR, since the test file can differ. The
# first failure's output is printed, so a "fail" can't hide a setup error.
runN()  { local pass=0 crash=0 fail=0 rc shown=0 flags
          flags=(${(z)"$(sed -n 's|^// Flags: ||p' "$T" 2>/dev/null | head -1)"})
          for i in $(seq 1 $N); do out=$(node_run $flags "$T" 2>&1 </dev/null); rc=$?
            if [ $rc -eq 0 ]; then pass=$((pass+1)); elif [ $rc -gt 128 ]; then crash=$((crash+1)); echo "    run $i: CRASH signal $((rc-128))" >&2; else fail=$((fail+1)); fi
            if [ $rc -ne 0 ] && [ $shown = 0 ]; then
              shown=1; echo "    first failure (run $i, exit $rc):" >&2
              print -r -- "$out" | grep -v '^ *[0-9]*: 0x' | tail -8 | sed 's/^/      /' >&2
            fi
          done; echo "pass=$pass crash=$crash fail=$fail / $N"; }

[ "${REBASE:-1}" = "1" ] && git rev-parse -q --verify "refs/heads/repro-$n" >/dev/null &&
  { echo "repro.sh: branch repro-$n already exists; rename or delete it first" >&2; exit 1; }
git diff --quiet && git diff --cached --quiet ||
  { echo "repro.sh: the working tree has uncommitted changes; commit or stash them first" >&2; exit 1; }

echo "== baseline: main =="
git checkout main >/dev/null 2>&1 || { echo "repro.sh: could not check out main" >&2; exit 1; }
build || exit 1
echo "  main $(git rev-parse --short HEAD): $(runN)"

echo "== PR #$n =="
# The PR head goes to FETCH_HEAD, not a pr-<n> branch, so a pr-<n> you already
# have is never moved or deleted. The only branch this creates is repro-<n>,
# and it refuses to touch one that already exists.
made_branch=0
cleanup() { git checkout main >/dev/null 2>&1; [ $made_branch = 1 ] && git branch -D "repro-$n" >/dev/null 2>&1; }
git fetch upstream "pull/$n/head" >/dev/null 2>&1 || { echo "  fetch of pull/$n/head failed" >&2; exit 1; }
head=$(git rev-parse FETCH_HEAD)
if [ "${REBASE:-1}" = "1" ]; then
  # Test the PR's commits on top of main, as CI does (REBASE_ONTO). Checking out
  # an old PR head instead touches every file that changed since its base, and a
  # PR a few weeks behind main rebuilds all of V8.
  mb=$(git merge-base main "$head")
  echo "  rebasing $(git rev-list --count "$mb..$head") commit(s) onto main ($(git rev-list --count "$mb..main") behind)"
  git branch "repro-$n" "$head" >/dev/null 2>&1 && made_branch=1
  if ! git rebase -q --onto main "$mb" "repro-$n" >/dev/null 2>&1; then
    git rebase --abort >/dev/null 2>&1; cleanup
    echo "  PR #$n conflicts with main. REBASE=0 builds its head as-is (rebuilds everything that differs, possibly V8)." >&2
    exit 1
  fi
else
  git checkout --detach "$head" >/dev/null 2>&1
fi
build || { cleanup; exit 1; }
echo "  PR head $(git rev-parse --short "$head"), built at $(git rev-parse --short HEAD): $(runN)"

cleanup
echo "(returned to main baseline)"
