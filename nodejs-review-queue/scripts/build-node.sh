#!/bin/zsh
# Reconfigure (ccache-enabled) + build node. Run from the node repo root.
# CC/CXX are set inline because gyp bakes the compiler into the ninja graph at
# ./configure time and Bash-tool shells may not source ~/.zshrc. Stream output
# directly (never pipe through tail). Backgrounding this is the normal pattern.
export CC="ccache cc" CXX="ccache c++"
echo "=== configure @ $(date +%H:%M:%S) ==="
./configure --ninja --node-builtin-modules-path "$(pwd)"
echo "=== ninja @ $(date +%H:%M:%S) ==="
ninja -C out/Release node
rc=$?
echo "=== BUILD EXIT $rc @ $(date +%H:%M:%S) ==="
ccache -s 2>/dev/null | grep -iE 'hits|cache size' | head -3
exit $rc
