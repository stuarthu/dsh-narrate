#!/bin/sh
# T-09 的 QA。跑法：sh docs/crew/qa/T-09/run.sh
set -e
node "$(dirname "$0")/case-1-7.mjs"
