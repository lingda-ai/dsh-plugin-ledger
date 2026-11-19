#!/usr/bin/env bash
# 发布前闸门：一条命令回答"现在能不能发"。
#
# 只做检查，不改任何文件；任何一步失败即退出，避免带着坏状态发版。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. 工作区必须干净 =="
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL  工作区有未提交改动，先提交再发"
  git status --short
  exit 1
fi
echo "PASS  工作区干净（$(git rev-parse --short HEAD)）"

echo "== 2. 分支必须是 main =="
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || { echo "FAIL  当前分支 $branch，发版只允许 main"; exit 1; }
echo "PASS  main"

echo "== 3. 单测 + 性能门禁 + 运行时契约冒烟 =="
bash scripts/ci.sh >/tmp/ledger-ci.log 2>&1 || { echo "FAIL  ci.sh 未通过，见 /tmp/ledger-ci.log"; tail -20 /tmp/ledger-ci.log; exit 1; }
echo "PASS  ci.sh 全通过"

echo "== 4. 打包内容必须只有白名单 =="
allowed="package.json README.md LICENSE cordis.patch.yml lib/"
bad="$(npm pack --dry-run --json 2>/dev/null | node -e '
let raw=""
process.stdin.on("data", d => raw += d).on("end", () => {
  const [pack] = JSON.parse(raw)
  const files = pack.files.map(f => f.path)
  const allowedFile = (p) =>
    p === "package.json" || p === "README.md" || p === "LICENSE" || p === "cordis.patch.yml" || p.startsWith("lib/")
  const bad = files.filter(p => !allowedFile(p))
  if (bad.length > 0) process.stdout.write(bad.join("\n"))
})')"
if [ -n "$bad" ]; then
  echo "FAIL  包内出现白名单外文件："
  echo "$bad"
  exit 1
fi
echo "PASS  打包内容符合白名单（$allowed）"

echo "== 5. 版本与私有标记 =="
node -e '
const p = require("./package.json")
console.log("name     ", p.name)
console.log("version  ", p.version)
console.log("private  ", p.private === true ? "true（发布前需由 owner 改为 false 并确认目标 registry）" : "false")
console.log("license  ", p.license ?? "(未声明，由发布决策确定)")
'

echo "== 6. 契约冒烟必须真跑过（SKIP = 未验证，不许发）=="
for script in scripts/smoke-registry.mjs scripts/smoke-dsh.mjs; do
  rc=0
  node "$script" >/tmp/ledger-smoke.log 2>&1 && rc=0 || rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "FAIL  $script 在本机 SKIP（没有 DSH 运行时），契约等于没验证"
    tail -3 /tmp/ledger-smoke.log
    exit 1
  fi
  [ "$rc" -eq 0 ] || { echo "FAIL  $script 未通过"; tail -10 /tmp/ledger-smoke.log; exit 1; }
  echo "PASS  $script 真跑过"
done

echo
echo "结论：代码侧已可发布；远程与 registry 由 owner 决定（本仓库未配置 remote）。"
