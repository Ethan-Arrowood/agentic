#!/bin/zsh
# Runs one gh command through nodejs-review-queue's gh_retry (secondary rate
# limit backoff), for callers that aren't zsh, such as bank.py.
# Usage: gh-retry.sh <gh args...>
DIR="${0:A:h}"
source "${RQ_SCRIPTS:-$DIR/../../nodejs-review-queue/scripts}/lib.sh"
gh_retry gh "$@"
