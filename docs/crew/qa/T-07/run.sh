#!/bin/sh
# T-07 的 QA。跑法：sh docs/crew/qa/T-07/run.sh
set -e
node "$(dirname "$0")/case-1-12.mjs"
