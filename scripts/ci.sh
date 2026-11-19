#!/usr/bin/env bash
# 本地等价于 CI 的一键校验（无依赖，不需要 npm install）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 单元测试 =="
node --test test/*.test.mjs

echo "== 热路径门禁 =="
node --expose-gc scripts/bench.mjs --gate

echo "== DSH 工具契约冒烟（无运行时则自动 SKIP）=="
node scripts/smoke-registry.mjs

echo "== DSH 消息契约冒烟（无运行时则自动 SKIP）=="
node scripts/smoke-dsh.mjs

echo "全部通过"
