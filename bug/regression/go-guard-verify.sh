#!/usr/bin/env bash
# go-guard-verify.sh — go-guard 生命周期回归验证（A-E）
#
# 全部在测试端口 TEST_PORT 上跑 MOCK 网关 + 临时 GO_STATE_DIR，不碰真实 keys.json / 8788。
# 依赖：node、PowerShell 7（pwsh）、curl、python。
# 运行：bash bug/regression/go-guard-verify.sh
# 退出码：0=全部通过；1=存在失败。
set -u
cd "$(dirname "$0")/../.." || exit 2
ROOT=$(pwd)
TEST_PORT=8792
TMP=$(mktemp -d)
LOCK="$HOME/.opencode-go-router/guard.lock"
PASS=0; FAIL=0
PS="C:/Program Files/PowerShell/7/pwsh.exe"

say()  { echo "[$(date +%H:%M:%S)] $1"; }
check(){ if [ "$2" = "$3" ]; then say "  PASS $1"; PASS=$((PASS+1)); else say "  FAIL $1 (got=[$2] want=[$3])"; FAIL=$((FAIL+1)); fi; }

# 写临时 ps1 并运行，返回 stdout
ps1() {
  local f="$TMP/op.ps1"
  cat > "$f"
  "$PS" -NoProfile -File "$f" 2>/dev/null
}
gw_count() {  # 测试端口上的 go-gateway 进程数
  ps1 <<EOF
Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'node.exe' -and \$_.CommandLine -match 'go-gateway\\.cjs' -and \$_.CommandLine -match '--port $TEST_PORT' } | Measure-Object | Select-Object -ExpandProperty Count
EOF
}
kill_gw() {
  ps1 <<EOF
Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'node.exe' -and \$_.CommandLine -match 'go-gateway\\.cjs' -and \$_.CommandLine -match '--port $TEST_PORT' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }
EOF
}
lock_pid() { python -c "import json;print(json.load(open(r'$LOCK')).get('pid',''))" 2>/dev/null; }
health()   { curl -s -m 2 "http://127.0.0.1:$TEST_PORT/health" 2>/dev/null; }

cleanup() {
  # 无条件清掉所有 go-guard 与测试端口 go-gateway（不依赖锁，避免 owner kill 竞态）
  ps1 <<EOF
Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'node.exe' -and (\$_.CommandLine -match 'go-guard\\.cjs' -or (\$_.CommandLine -match 'go-gateway\\.cjs' -and \$_.CommandLine -match '--port $TEST_PORT')) } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }
EOF
  rm -f "$LOCK"
  sleep 1
}
trap cleanup EXIT

run_guard() {  # $1 = GO_GUARD_TEST_ZCODE
  MOCK_MODE=1 GO_STATE_DIR="$TMP" GO_PORT=$TEST_PORT GO_GUARD_TEST_ZCODE="$1" GO_GUARD_IDLE_S=5 \
    node "$ROOT/go-guard.cjs" >/dev/null 2>&1 &
}

say "=== A: ZCode 在 -> 网关拉起并保持 ==="
cleanup
run_guard 1
sleep 3
check "A1 /health=200" "$(health | grep -c '"ok":true')" "1"
check "A2 锁存在" "$(test -f "$LOCK" && echo 1 || echo 0)" "1"
check "A3 网关进程=1" "$(gw_count | tr -d ' ')" "1"
cleanup

say "=== B: ZCode 消失 -> idle 后停网关、放锁 ==="
cleanup
run_guard 0
sleep 2
check "B1 先起来 /health=200" "$(health | grep -c '"ok":true')" "1"
sleep 12
check "B2 网关已停=0" "$(gw_count | tr -d ' ')" "0"
check "B3 锁已释放" "$(test -f "$LOCK" && echo 1 || echo 0)" "0"
cleanup

say "=== C: 单例 -> 第二实例屏蔽，不重复启动 ==="
cleanup
run_guard 1
sleep 3
run_guard 1
sleep 2
check "C1 仍是 1 个网关" "$(gw_count | tr -d ' ')" "1"
check "C2 日志有 shielded" "$(grep -q shielded "$HOME/.opencode-go-router/go-guard.log" 2>/dev/null && echo 1 || echo 0)" "1"
cleanup

say "=== D: 陈旧锁 -> 自动接管 ==="
cleanup
echo '{"pid":999999,"startedAt":"stale"}' > "$LOCK"
run_guard 1
sleep 3
check "D1 /health=200" "$(health | grep -c '"ok":true')" "1"
check "D2 锁 pid 已换（非 999999）" "$(test "$(lock_pid)" != "999999" && echo 1 || echo 0)" "1"
cleanup

say "=== E: 网关崩溃 -> 自动重启 ==="
cleanup
run_guard 1
sleep 3
kill_gw >/dev/null
sleep 8
check "E1 /health=200" "$(health | grep -c '"ok":true')" "1"
check "E2 网关进程=1" "$(gw_count | tr -d ' ')" "1"
cleanup

say ""
say "结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
