#!/bin/zsh
# Reconfigure (ccache-enabled) + build node. Run from the node repo root.
# CC/CXX are set inline because gyp bakes the compiler into the ninja graph at
# ./configure time and Bash-tool shells may not source ~/.zshrc. Stream output
# directly (never pipe through tail). Backgrounding this is the normal pattern.
#
# Experimental subsystems are gated at CONFIGURE time, not just by a runtime
# flag. Without the configure flag the module is absent from the binary and
# `import 'node:<mod>'` throws ERR_UNKNOWN_BUILTIN_MODULE with nothing pointing
# at the build as the cause. QUIC is opt-in, only when QUIC work is in scope.
#   QUIC=1  -> add --experimental-quic
#   DTLS=1  -> add   --experimental-dtls  (needed for src/dtls + node:dtls work)
#
# Parallelism: ninja defaults to ncpu+2. A V8 translation unit peaks at roughly
# 0.5-2 GB, so on a 16-18 GB machine that default drives the box into swap and
# makes everything else unusable. Default to a RAM-aware job count instead.
#   JOBS=N  -> override the job count explicitly
#   NICE=1  -> also run under macOS background QoS (throttled CPU *and* I/O;
#              maximum interactivity, noticeably slower build)
export CC="ccache cc" CXX="ccache c++"

configure_args=(--ninja --node-builtin-modules-path "$(pwd)")
[[ "${QUIC:-0}" == "1" ]] && configure_args+=(--experimental-quic)
[[ "${DTLS:-0}" == "1" ]] && configure_args+=(--experimental-dtls)

# --- job count -------------------------------------------------------------
ncpu=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
mem_bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 8589934592)
ram_gb=$(( mem_bytes / 1073741824 ))
# ~3 GB of headroom per concurrent compile; never below 2, never above ncpu.
default_jobs=$(( ram_gb / 3 ))
(( default_jobs < 2 )) && default_jobs=2
(( default_jobs > ncpu )) && default_jobs=$ncpu
jobs=${JOBS:-$default_jobs}

ninja_cmd=(ninja -C out/Release -j "$jobs" node)
[[ "${NICE:-0}" == "1" ]] && ninja_cmd=(taskpolicy -b "${ninja_cmd[@]}")

echo "=== configure @ $(date +%H:%M:%S) ==="
echo "    args: ${configure_args[*]}"
./configure "${configure_args[@]}" || exit $?

echo "=== ninja @ $(date +%H:%M:%S) ==="
echo "    -j$jobs (ncpu=$ncpu, ram=${ram_gb}G, ninja default would be $((ncpu + 2)))${NICE:+, background QoS}"
"${ninja_cmd[@]}"
rc=$?
echo "=== BUILD EXIT $rc @ $(date +%H:%M:%S) ==="
if [[ $rc -eq 0 ]]; then
  # Confirm the gated subsystems actually made it into the binary.
  ./out/Release/node --experimental-quic \
    -p "'features: quic=' + process.features.quic +
        ' dtls=' + process.features.dtls +
        ' ngtcp2=' + (process.versions.ngtcp2 || 'n/a') +
        ' nghttp3=' + (process.versions.nghttp3 || 'n/a')" 2>/dev/null
fi
ccache -s 2>/dev/null | grep -iE 'hits|cache size' | head -3
exit $rc
