#!/usr/bin/env bash
# Build and test nodejs/node inside the official nightly devcontainer image
# (nodejs/devcontainer:nightly). The image ships the toolchain (through Nix and
# direnv) and a prebuilt out/Release, so a checkout near `main` builds
# incrementally instead of compiling V8 from scratch.
#
# Run from a nodejs/node checkout or one of its worktrees. Each checkout gets
# its own container, named node-devc-<checkout dir name>.
#
#   devc.sh up            start or reuse this checkout's container
#   devc.sh build         configure, then `ninja node`; prints a features line
#   devc.sh run <cmd...>  run a command in the checkout inside the Nix env
#   devc.sh sh            interactive shell in the container
#   devc.sh status        image, container, volumes, and the built binary
#   devc.sh pull          pull the latest nightly image (about 10 GB)
#   devc.sh down          remove this checkout's container; keeps volumes
#
# Env:
#   QUIC=1       add --experimental-quic (off by default; only when QUIC is in scope)
#   DTLS=1       add --experimental-dtls
#   JOBS=N       ninja job count (default: min(CPUs, RAM GiB / 2) in the VM)
#   RECONFIGURE=1  rerun configure even if nothing it reads changed
#   DEVC_ENGINE  podman or docker (default: whichever is on PATH, podman first)
#   DEVC_IMAGE   image reference (default: docker.io/nodejs/devcontainer:nightly)
set -euo pipefail

IMAGE="${DEVC_IMAGE:-docker.io/nodejs/devcontainer:nightly}"
ENGINE="${DEVC_ENGINE:-$(command -v podman || command -v docker || true)}"
WS=/home/developer/nodejs/node
READY=/home/developer/.devc-ready   # in the container's own filesystem

die() { echo "devc: $*" >&2; exit 1; }
[ -n "$ENGINE" ] || die "needs podman or docker on PATH"

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "run from a nodejs/node checkout"
[ -f "$root/node.gyp" ] || die "$root is not a nodejs/node checkout"
common=$(cd "$root" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
key=$(basename "$root" | tr -c 'A-Za-z0-9_.\n-' '-')
name="node-devc-$key"

image_id() {
  local id
  id=$("$ENGINE" image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null) ||
    die "image $IMAGE is missing. Run 'devc.sh pull' (about 10 GB)."
  id=${id#sha256:}
  echo "${id:0:12}"
}

# Run a shell snippet in the checkout, inside the Nix env that direnv loads.
in_ctr() {
  # shellcheck disable=SC2016 # expands inside the container
  "$ENGINE" exec -w "$WS" "$name" bash -lc \
    'eval "$(direnv export bash 2>/dev/null)"; '"$1"
}

up() {
  local img cur state commit
  img=$(image_id)
  if "$ENGINE" container inspect "$name" >/dev/null 2>&1; then
    cur=$("$ENGINE" container inspect "$name" --format '{{.Image}}')
    cur=${cur#sha256:}
    if [ "${cur:0:12}" = "$img" ]; then
      state=$("$ENGINE" container inspect "$name" --format '{{.State.Running}}')
      [ "$state" = "true" ] || "$ENGINE" start "$name" >/dev/null
      "$ENGINE" exec "$name" test -e "$READY" || setup
      return 0
    fi
    echo "devc: $name is on an older image; recreating it on $img" >&2
    "$ENGINE" rm -f "$name" >/dev/null
  fi

  # The commit the image's prebuilt out/ was compiled from.
  commit=$("$ENGINE" run --rm --entrypoint git "$IMAGE" -C "$WS" rev-parse HEAD)

  local mounts=(
    -v "$root:$WS"
    # One out/ volume per checkout and image. On first use the engine seeds
    # it from the image's prebuilt out/ (about 3 GB).
    -v "node-devc-out-$key-$img:$WS/out"
    -v "node-devc-ccache:/home/developer/.cache/ccache"
  )
  # A worktree's .git file points at the main clone's .git by absolute host
  # path. Mount it at that same path so git works inside the container.
  [ "$common" = "$root/.git" ] || mounts+=(-v "$common:$common")

  echo "devc: creating $name from $IMAGE ($img, built from ${commit:0:12})" >&2
  "$ENGINE" run -d --name "$name" --label "devc.image-commit=$commit" \
    "${mounts[@]}" -w "$WS" --entrypoint sleep "$IMAGE" infinity >/dev/null

  setup
}

# One-time setup for a new container. Writes a marker when it finishes, so a
# setup that failed partway reruns on the next `up` instead of leaving a
# container with the wrong mtimes.
setup() {
  local commit
  commit=$("$ENGINE" container inspect "$name" --format '{{index .Config.Labels "devc.image-commit"}}')

  # Same setup as .devcontainer/base/devcontainer.json.
  "$ENGINE" exec -w "$WS" "$name" bash -c \
    'cp ~/envrc/static-libs.envrc .envrc && direnv allow .'

  # Match the image's build cache: set each file's mtime to its last commit
  # time, as the image did. Then touch every file that differs from the image's
  # commit. A commit can land after the image's checkout but before its build
  # finished, and restore-mtime would make that file look older than its
  # object, so ninja would silently skip it.
  # Use the image's /usr/bin/git: git-restore-mtime is in its exec path
  # (/usr/lib/git-core), not in the Nix git that direnv puts first on PATH.
  git -C "$root" cat-file -e "$commit^{commit}" 2>/dev/null ||
    git -C "$root" fetch -q upstream main
  echo "devc: restoring mtimes (about 90 s)" >&2
  "$ENGINE" exec -w "$WS" "$name" bash -c "
    set -eo pipefail
    /usr/bin/git restore-mtime --quiet
    /usr/bin/git diff --no-renames --name-only -z $commit HEAD | xargs -0r touch -c
    touch $READY"
}

build() {
  up
  local extra=""
  [ "${QUIC:-0}" = "1" ] && extra="$extra --experimental-quic"
  [ "${DTLS:-0}" = "1" ] && extra="$extra --experimental-dtls"
  # Configure through `python3`, as `make build-ci` did for the image. The
  # ./configure shim picks python3.14 instead, which changes the command line
  # of V8's generator steps and rebuilds all of V8.
  #
  # Skip configure when nothing it reads changed. Each run re-extracts the ICU
  # data, which regenerates it and the V8 snapshot (about 25 s). The stamp holds
  # the command and the lib/**/*.js list, which configure bakes into the
  # build. Gyp and configure files newer than the stamp also force a rerun.
  # RECONFIGURE=1 forces one.
  in_ctr "
    set -eo pipefail
    jobs=${JOBS:-}
    if [ -z \"\$jobs\" ]; then
      mem=\$(awk '/MemTotal/ {print int(\$2 / 1048576)}' /proc/meminfo)
      jobs=\$(( mem / 2 )); [ \$jobs -gt \$(nproc) ] && jobs=\$(nproc); [ \$jobs -lt 2 ] && jobs=2
    fi
    cmd=\"python3 ./configure --verbose \$CONFIG_FLAGS$extra\"
    want=\$(printf '%s\n' \"\$cmd\"; find lib -name '*.js' | sort)
    stamp=out/.devc-configure
    newer=\$(find configure configure.py node.gyp node.gypi common.gypi tools/v8_gypfiles deps/*/*.gyp* \
      -newer \$stamp \\( -name '*.gyp*' -o -name 'configure*' \\) -print -quit 2>/dev/null || true)
    if [ '${RECONFIGURE:-0}' = 1 ] || [ ! -f \$stamp ] || [ \"\$want\" != \"\$(cat \$stamp)\" ] || [ -n \"\$newer\" ]; then
      echo \"=== configure @ \$(date +%H:%M:%S): \$CONFIG_FLAGS$extra\"
      \$cmd >out/configure.log 2>&1 || { tail -20 out/configure.log; exit 1; }
      printf '%s\n' \"\$want\" > \$stamp
    else
      echo '=== configure: unchanged, skipped (RECONFIGURE=1 forces it)'
    fi
    echo \"=== ninja -j\$jobs @ \$(date +%H:%M:%S)\"
    ninja -C out/Release -j\$jobs node
    echo \"=== done @ \$(date +%H:%M:%S)\"
    out/Release/node --experimental-quic -p \"'features: quic=' + process.features.quic +
      ' dtls=' + process.features.dtls + ' ngtcp2=' + (process.versions.ngtcp2 || 'n/a')\" 2>/dev/null
    ccache -s | grep -i -m1 hits
  "
}

run() {
  [ $# -gt 0 ] || die "usage: devc.sh run <cmd...>"
  up
  # shellcheck disable=SC2016 # expands inside the container
  "$ENGINE" exec -w "$WS" "$name" bash -lc \
    'eval "$(direnv export bash 2>/dev/null)"; exec "$@"' bash "$@"
}

status() {
  local img
  img=$(image_id)
  echo "image:     $IMAGE $img, created $("$ENGINE" image inspect "$IMAGE" --format '{{.Created}}' | cut -c1-16)"
  if "$ENGINE" container inspect "$name" >/dev/null 2>&1; then
    echo "container: $name $("$ENGINE" container inspect "$name" --format '{{.State.Status}}'), image commit $("$ENGINE" container inspect "$name" --format '{{index .Config.Labels "devc.image-commit"}}' | cut -c1-12)"
    [ "$("$ENGINE" container inspect "$name" --format "{{.State.Running}}")" = true ] &&
      in_ctr '[ -x out/Release/node ] && out/Release/node --experimental-quic -p "\"binary:    quic=\" + process.features.quic + \" dtls=\" + process.features.dtls + \" \" + process.version" 2>/dev/null || echo "binary:    not built"'
  else
    echo "container: $name not created"
  fi
  echo "volumes:"
  "$ENGINE" volume ls --format '{{.Name}}' | grep '^node-devc-' | while read -r v; do
    case "$v" in
      node-devc-out-*-"$img"|node-devc-ccache) echo "  $v" ;;
      *) echo "  $v (older image; remove with: $(basename "$ENGINE") volume rm $v)" ;;
    esac
  done
}

case "${1:-}" in
  up) up ;;
  build) build ;;
  run) shift; run "$@" ;;
  sh) up; "$ENGINE" exec -it -w "$WS" "$name" bash -l ;;
  status) status ;;
  pull) "$ENGINE" pull "$IMAGE" && echo "devc: pulled. The next 'up' recreates containers on the new image." ;;
  down) "$ENGINE" rm -f "$name" >/dev/null && echo "devc: removed $name (volumes kept)" ;;
  *) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
