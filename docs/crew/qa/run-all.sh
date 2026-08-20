#!/bin/sh
# 跑所有任务的 QA。跑法：sh docs/crew/qa/run-all.sh
# 每个任务一个子目录，里面一个 run.sh。这里只负责找到它们并依次跑。
set -e
here="$(dirname "$0")"
found=0
for script in "$here"/*/run.sh; do
  [ -f "$script" ] || continue
  found=$((found + 1))
  echo "===== $(basename "$(dirname "$script")") ====="
  sh "$script"
  echo ""
done
if [ "$found" -eq 0 ]; then
  echo "没有找到任何 run.sh"
  exit 1
fi
echo "$found 个任务的 QA 全部跑完"
