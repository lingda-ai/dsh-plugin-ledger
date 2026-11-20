#!/usr/bin/env bash
# 本地等价于 CI 的一键校验（无依赖，不需要 npm install）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 客户端产物构建（产物形态错了会让宿主整页崩）=="
node scripts/build-client.mjs
git diff --quiet -- lib/client.js || {
  echo "FAIL  lib/client.js 与源不一致：改完客户端源码请提交重建后的产物" >&2
  exit 1
}

echo "== 转发包与主包一致（client.js 除外：它要按各自包名重新生成）=="
drift=0
for f in lib/*.js; do
  case "$(basename "$f")" in client.js) continue ;; esac
  if ! diff -q "$f" "packages/dsh-plugin-ledger/$f" >/dev/null 2>&1; then
    echo "FAIL  $f 与 packages/dsh-plugin-ledger/$f 不一致：跑 node scripts/build-bundle.mjs <版本>" >&2
    drift=1
  fi
done
[ "$drift" -eq 0 ] || exit 1

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

echo "== 真机端到端（默认 SKIP；加 --real-host 或 REAL_HOST=1 开启）=="
if [[ "${1:-}" == "--real-host" || "${REAL_HOST:-0}" == "1" ]]; then
  # 真机链路需要能被 DSH 真实加载的 profile，故必须指定 DSH 工程根
  node scripts/verify-real-host.mjs --cwd "${DSH_ROOT:?--real-host 需要 DSH_ROOT（含 node_modules/.bin/dsh 的目录）}" --profile "${DSH_PROFILE:-ledger-test}"
else
  echo "SKIP  scripts/verify-real-host.mjs（它证明的是链路与计价，不是覆盖率；提交前建议手动跑一次）"
fi

echo "全部通过"
