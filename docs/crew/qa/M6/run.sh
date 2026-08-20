#!/bin/sh
# M6 里程碑验收（在 dsh 之外）。跑法：sh docs/crew/qa/M6/run.sh
# 素材文件夹默认 ~/assets，可以用 NARRATE_ASSETS 指到别处。
set -e
node "$(dirname "$0")/acceptance.mjs"
