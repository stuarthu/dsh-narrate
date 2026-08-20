#!/bin/sh
# T-11 的 QA。跑法：sh docs/crew/qa/T-11/run.sh
set -e
node "$(dirname "$0")/case-1-8.mjs"
