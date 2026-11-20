#!/usr/bin/env bash
# 一条命令完成发布：前置检查 → 门禁 → 发布 → 回读 registry 确认。
# 前提：本机已 `npm login`（或 ~/.npmrc 里有 _authToken），且 npm 上已存在 org「lingda-ai」。
set -euo pipefail
cd "$(dirname "$0")/.."

PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")
ENC_NAME=$(node -p "encodeURIComponent(require('./package.json').name)")

fail() { echo "✗ $1"; exit 1; }

# 环境里的 NPM_CONFIG_REGISTRY 优先级高于 ~/.npmrc，若指向镜像站会导致 token 对不上
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org
if [ "${NPM_REGISTRY_ORIG:-}" != "" ] && [ "$NPM_REGISTRY_ORIG" != "https://registry.npmjs.org" ]; then
  echo "! 原 registry 为 $NPM_REGISTRY_ORIG，本次强制使用官方源"
fi

echo "== 1/6 登录态 =="
who=$(npm whoami 2>/dev/null || true)
[ -n "$who" ] || fail "未登录。先执行 npm login，或把 token 写进 ~/.npmrc"
echo "  当前账号：$who"

echo "== 2/6 组织归属（scoped 包必须属于某个 org）=="
org=${PKG_NAME#@}
org=${org%%/*}
org_code=$(curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/-/org/$org/user")
if [ "$org_code" = "404" ]; then
  fail "npm 上还没有 org「$org」。去 npmjs.com 免费创建，或用你账号的用户名当 scope"
fi
echo "  org $org 存在（HTTP $org_code）"

echo "== 3/6 版本冲突 =="
ver_code=$(curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/$ENC_NAME/$PKG_VERSION")
if [ "$ver_code" = "200" ]; then
  fail "$PKG_NAME@$PKG_VERSION 已存在于 registry，先 bump 版本"
fi
echo "  $PKG_NAME@$PKG_VERSION 未发布过（可发）"

echo "== 4/6 工作区干净 =="
if [ -n "$(git status --porcelain)" ]; then
  fail "有未提交改动，先提交再发（发布物必须能对应到一个 commit）"
fi
echo "  clean @ $(git rev-parse --short HEAD)"

echo "== 5/6 门禁（单测 + 热路径 + 冒烟）=="
bash scripts/ci.sh > /tmp/publish-ci.log 2>&1 || { tail -20 /tmp/publish-ci.log; fail "门禁未通过"; }
echo "  全绿"

echo "== 6/6 发布 =="
pnpm publish --access public --no-git-checks --registry https://registry.npmjs.org 2>&1 | tail -6

echo "== 回读 registry 确认 =="
sleep 3
final=$(curl -s -o /tmp/pub.json -w "%{http_code}" "https://registry.npmjs.org/$ENC_NAME/$PKG_VERSION")
if [ "$final" = "200" ]; then
  node -e "
const d=require('/tmp/pub.json');
console.log('  已上架：'+d.name+'@'+d.version+'  ('+d.dist.tarball+')');
console.log('  体积：'+Math.round(d.dist.unpackedSize/1024)+' KB, 文件数：'+d.dist.fileCount);
"
else
  fail "回读失败（HTTP $final），去 npmjs.com 手动核对"
fi
echo "发布完成。"
