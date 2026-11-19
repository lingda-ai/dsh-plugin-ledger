#!/usr/bin/env bash
# 本地等价于 CI 的一键校验（无依赖，不需要 npm install）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 单元测试 =="
node --test test/*.test.mjs

echo "== 热路径门禁 =="
node --expose-gc scripts/bench.mjs --gate

run_smoke() {
  local script="$1"
  node "$script"
  local rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "SKIP  $script（本机无 DSH 运行时；发布闸门会要求它必须真跑）"
    return 0
  fi
  return "$rc"
}

echo "== DSH 工具契约冒烟（无运行时则 SKIP，退出码 2）=="
run_smoke scripts/smoke-registry.mjs

echo "== DSH 消息契约冒烟（无运行时则 SKIP，退出码 2）=="
run_smoke scripts/smoke-dsh.mjs

echo "== 面板链路冒烟（落盘 → 读回，口径一致）=="
node scripts/smoke-panel.mjs

echo "全部通过"
