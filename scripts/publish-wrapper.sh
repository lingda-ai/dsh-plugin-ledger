#!/usr/bin/env bash
# 发布自包含单包 @lingda-ai/dsh-plugin-ledger。
#
# 为什么需要它：根包的 scripts/publish.sh 只发实现包；wrapper 之前是「手动 npm publish」，
# 于是存在两个缺口：① 没人保证发的是刚 build 出来的产物；② 没人跑测试。
# 这个脚本把「测试 → 重建 → 发布」串成一条，默认 dry-run。
#
# 用法：
#   scripts/publish-wrapper.sh 0.1.15            # dry-run（只打印将要发什么）
#   scripts/publish-wrapper.sh 0.1.15 --publish  # 真发
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
MODE="${2:---dry-run}"
if [ -z "$VERSION" ]; then
  echo "用法：scripts/publish-wrapper.sh <version> [--publish]" >&2
  exit 2
fi
case "$MODE" in
  --dry-run|--publish) ;;
  *) echo "未知模式：$MODE（只接受 --dry-run / --publish）" >&2; exit 2 ;;
esac

# 必须钉住官方源：本机 ~/.npmrc 可能指向华为云等镜像，
# 环境变量优先级高于 .npmrc，不钉住就会「以为发到 npmjs，实际发去镜像」。
# （根包 scripts/publish.sh 早就有这条防御，wrapper 之前漏了。）
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org
if [ "${NPM_REGISTRY_ORIG:-}" != "" ] && [ "$NPM_REGISTRY_ORIG" != "https://registry.npmjs.org" ]; then
  echo "! 原 registry 为 $NPM_REGISTRY_ORIG，本次强制使用官方源"
fi

LOG="$(mktemp -t ledger-test)"
echo "== 1/3 测试（全量）"
if ! node scripts/run-tests.mjs >"$LOG" 2>&1; then
  tail -25 "$LOG"
  echo "✗ 测试未通过，拒绝发布" >&2
  exit 1
fi
grep -E "^ℹ (tests|pass|fail) |^# 沙箱" "$LOG" | sed 's/^/  /'

echo "== 2/3 重建 wrapper $VERSION（lib 同步 + client 按 wrapper 包名重建）"
node scripts/build-bundle.mjs "$VERSION" | sed 's/^/  /'

echo "== 3/3 发布（$MODE）"
if [ "$MODE" = "--publish" ]; then
  who=$(npm whoami 2>/dev/null || true)
  [ -n "$who" ] || { echo "✗ 未登录 npm（先 npm login 或写入 _authToken）" >&2; exit 1; }
  echo "  账号：$who"
fi
cd packages/dsh-plugin-ledger
node -e "const p=require('./package.json');if(p.version!=='$VERSION')throw new Error('版本未生效: '+p.version);console.log('  待发：'+p.name+'@'+p.version)"
if [ "$MODE" = "--publish" ]; then
  npm publish --access public
else
  npm publish --dry-run --access public
fi
