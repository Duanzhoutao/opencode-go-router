#!/usr/bin/env bash
# publish.sh — 一键同步本地开发状态到开源仓库（GitHub + GitCode）
#
# 唯一发布通道。流程：守卫扫描（=白名单）-> 白名单同步 -> commit -> 双推 -> 回读 SHA 比对。
# 用法：bash publish/publish.sh ["commit message"]
# 规则（AGENTS.md「开源发布」节）：
#   - publish/ 下由本脚本生成的副本按「同步产物」对待，勿手改；
#   - publish/README.md、publish/LICENSE 由本目录自身维护，脚本不覆盖；
#   - bug/、AGENTS.md、PROJECT_STATUS.md、实施计划、目标提示词、project-context/ 永不进入开源仓库。
set -euo pipefail

PUB="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$PUB")"
MSG="${1:-publish: 同步开源发布面}"

# ---- 白名单（唯一事实：守卫扫描与同步复制共用，不入库的文件不要列进来） ----
# docs/ 顶层 = 对外指南文档层（面向用户与其 Agent 的成品视角）；docs/plans、docs/reports = 内部过程文档，仅存根仓库。
SRC_FILES=(
  "$ROOT/go-gateway.cjs"
  "$ROOT/go-guard.cjs"
  "$ROOT/docs/README.md"
  "$ROOT/docs/architecture.md"
  "$ROOT/docs/client-integration.md"
  "$ROOT/docs/guard.md"
  "$ROOT/docs/configuration.md"
  "$ROOT/docs/api.md"
  "$ROOT/docs/admin-ui.md"
  "$ROOT/docs/faq.md"
)
SRC_DIRS=("$ROOT/ui" "$ROOT/reference")

# ---- 0) 守卫：敏感模式扫描（真实 Key 形状 / 本机绝对路径 / 作者邮箱） ----
for src in "${SRC_FILES[@]}" "${SRC_DIRS[@]}"; do
  [ -e "$src" ] || { echo "ABORT: 缺少发布面源文件 $src"; exit 1; }
done
BAD=$(rg -n -F -e "C:\\Users\\" -e "D:\\develop\\" -e "D:\\APP\\" -e "zhoutao@isrc" \
        "${SRC_FILES[@]}" "${SRC_DIRS[@]}" 2>/dev/null || true)
if [ -n "$BAD" ]; then
  echo "ABORT: 发布守卫命中本机路径/邮箱，请处理后再发布："
  echo "$BAD" | head -20
  exit 1
fi
KEYLIKE=$(rg -n "sk-[A-Za-z0-9]{20,}" "${SRC_FILES[@]}" "${SRC_DIRS[@]}" 2>/dev/null || true)
if [ -n "$KEYLIKE" ]; then
  echo "ABORT: 疑似真实 Key 形状字符串，请处理后再发布："
  echo "$KEYLIKE" | head -20
  exit 1
fi

# ---- 1) 白名单同步（拷贝即覆盖；不在白名单的目录被 git 记录为删除） ----
for src in "${SRC_FILES[@]}"; do
  rel="${src#"$ROOT"/}"
  mkdir -p "$PUB/$(dirname "$rel")"
  cp "$src" "$PUB/$rel"
done
for dir in "${SRC_DIRS[@]}"; do
  rel="${dir#"$ROOT"/}"
  rm -rf "$PUB/$rel" && cp -r "$dir" "$PUB/$rel"
done
# 显式移除曾经推上去、如今该消失的目录（幂等）
rm -rf "$PUB/bug" "$PUB/project-context" "$PUB/docs/plans" "$PUB/docs/reports"

# ---- 2) 提交（无变化则跳过） ----
git -C "$PUB" add -A
if git -C "$PUB" diff --cached --quiet; then
  echo "NO_CHANGE"
else
  git -C "$PUB" commit -m "$MSG" --quiet
  echo "COMMIT: $(git -C "$PUB" rev-parse --short HEAD)"
fi

# ---- 3) 双推 + 回读 ----
# GitHub 推 main 原样；GitCode 推「平台链接替换」变体（发布在哪个平台上就用哪个平台的链接与 star 命令）。
# 变体只存在于 gitcode-mirror 分支，main 始终是 GitHub 版唯一事实。
SEDF=$(mktemp)
cat > "$SEDF" <<'EOF'
s#https://github\.com/Duanzhoutao/opencode-go-router#https://gitcode.com/zhoutao-2026/opencode-go-router#g
s#gh api -X PUT user/starred/Duanzhoutao/opencode-go-router#curl -X PUT "https://api.gitcode.com/api/v5/user/starred/zhoutao-2026/opencode-go-router?access_token=$GITCODE_TOKEN"#g
s#Duanzhoutao/opencode-go-router#zhoutao-2026/opencode-go-router#g
EOF

git -C "$PUB" fetch origin main --quiet
git -C "$PUB" push --force-with-lease origin main

git -C "$PUB" checkout -q -B gitcode-mirror main
grep -rl -F -e "Duanzhoutao/opencode-go-router" --exclude-dir=.git --exclude=publish.sh "$PUB" 2>/dev/null | while read -r f; do
  sed -i -f "$SEDF" "$f"
done
rm -f "$SEDF"
git -C "$PUB" add -A
git -C "$PUB" diff --cached --quiet || git -C "$PUB" commit -q -m "mirror: 平台链接替换（GitHub → GitCode）"
git -C "$PUB" fetch gitcode main --quiet
git -C "$PUB" push --force-with-lease gitcode gitcode-mirror:main
GC_HEAD=$(git -C "$PUB" rev-parse gitcode-mirror)
git -C "$PUB" checkout -q main

ORIGN=$(git -C "$PUB" ls-remote origin main | cut -f1)
GC=$(git -C "$PUB" ls-remote gitcode main | cut -f1)
HEAD=$(git -C "$PUB" rev-parse HEAD)
if [ "$ORIGN" = "$HEAD" ] && [ "$GC" = "$GC_HEAD" ]; then
  echo "PUBLISH OK  github=$HEAD gitcode=$GC_HEAD"
else
  echo "MISMATCH  main=$HEAD github=$ORIGN gitcode-variant=$GC_HEAD gitcode=$GC"
  exit 1
fi
