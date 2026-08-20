#!/bin/sh
# T-06 的 QA。跑法：sh docs/crew/qa/T-06/run.sh
set -e
node "$(dirname "$0")/case-1-9.mjs"
