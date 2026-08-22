#!/usr/bin/env node
/**
 * go-guard.cjs — OpenCode Go 本地网关(8788)的守护者（跟随 ZCode 启停）
 *
 * 由 ZCode 的 SessionStart 钩子调用（~/.zcode/cli/config.json 的 hooks 块，
 * type: process）。母本：reference/dt-mcp-watch/dt-guard.cjs（桌面 MCP 守护，v3 模式）。
 * 生命周期（与桌面 MCP 同构）：
 *   1. 只启动一次：第一个钩子实例抢到 PID 锁成为 owner；后续所有调用
 *      看到锁活着就直接退出（屏蔽），不重复启动。
 *   2. 一直监测：owner 常驻，每 5s 检查 ZCode.exe 是否还在、网关是否健康
 *      （崩溃自动拉起）。
 *   3. 退出模式：ZCode.exe 消失满 IDLE_EXIT_S 秒 -> 停网关 -> 释放锁 -> 退出。
 *
 * 自守护化：钩子进程（无 GO_GUARD_DETACHED）spawn 一份 detached 的自己做
 * 真正的守护（否则钩子会把会话卡住），然后最多等 10s 网关健康就返回 0，
 * 保证首个会话启动时网关已就绪。
 *
 * 参数化（对照 dt-guard）：
 *   - 端口 8788（GO_PORT 可改）；守护对象 go-gateway.cjs（--port 显式传，供 stopEngine 精确定位）
 *   - 锁/日志：~/.opencode-go-router/guard.lock + go-guard.log
 *   - 进程停止：pwsh 7 按 CommandLine 匹配 'go-gateway.cjs' + '--port <PORT>' 杀 node 进程
 *   - 测试用环境变量：GO_GUARD_TEST_ZCODE=0|1（伪造 ZCode 存在与否）、
 *                     GO_GUARD_IDLE_S=N（缩短空闲退出秒数）
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

const PORT = Number(process.env.GO_PORT) || 8788;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const NODE_EXE = process.execPath; // 谁跑我，我就用谁 spawn
const ENGINE_ENTRY = path.join(__dirname, "go-gateway.cjs");
const ENGINE_CWD = __dirname; // 网关用 __dirname 解析 ui/ 与 keys.json
const HOME = os.homedir();
const GUARD_DIR = path.join(HOME, ".opencode-go-router");
const LOCK_PATH = path.join(GUARD_DIR, "guard.lock");
const LOG_PATH = path.join(GUARD_DIR, "go-guard.log");
const IDLE_EXIT_S = Number(process.env.GO_GUARD_IDLE_S) || 60;
const POLL_MS = 5000;
const PS = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"; // PowerShell 7
const TEST_ZCODE = process.env.GO_GUARD_TEST_ZCODE;

function log(line) {
  try {
    fs.mkdirSync(GUARD_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function healthy() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function acquireLock() {
  try {
    fs.mkdirSync(GUARD_DIR, { recursive: true });
    if (fs.existsSync(LOCK_PATH)) {
      const rec = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      // 陈旧锁接管：owner 死了，下一个调用直接接手
      if (rec.pid && pidAlive(rec.pid)) return false;
    }
  } catch {}
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return true;
}

function releaseLock() {
  try {
    const rec = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    if (rec.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {}
}

function startEngine() {
  const child = spawn(NODE_EXE, [ENGINE_ENTRY, "--port", String(PORT)], {
    cwd: ENGINE_CWD,
    env: { ...process.env, GO_PORT: String(PORT) },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  child.unref();
  log(`gateway spawn pid=${child.pid}`);
}

function stopEngine() {
  const expr =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'go-gateway\\.cjs' -and $_.CommandLine -match '--port " +
    PORT +
    "' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  try {
    execSync(`"${PS}" -NoProfile -EncodedCommand ${Buffer.from(expr, "utf16le").toString("base64")}`, {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {}
}

function zcodeRunning() {
  if (TEST_ZCODE === "0") return false;
  if (TEST_ZCODE === "1") return true;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /FO CSV /NH', {
      encoding: "utf8",
      windowsHide: true,
    });
    return /ZCode\.exe/i.test(out);
  } catch {
    return false;
  }
}

// ---------- 自守护化：钩子调用 -> spawn detached 自己 -> 等健康 -> 返回 ----------
if (!process.env.GO_GUARD_DETACHED) {
  const child = spawn(NODE_EXE, [__filename], {
    env: { ...process.env, GO_GUARD_DETACHED: "1" },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  child.unref();
  log("hook: detached guard spawned");
  // 最多等 10s，保证网关就绪后钩子才返回（首个会话体验）
  (async () => {
    for (let i = 0; i < 20; i++) {
      if (await healthy()) {
        log(`hook: gateway healthy after ${(i * 500 / 1000).toFixed(1)}s`);
        break;
      }
      await sleep(500);
    }
    process.exit(0);
  })();
  return;
}

// ---------- detached：真正的守护逻辑 ----------
const amOwner = acquireLock();

if (!amOwner) {
  // 后续启动：直接屏蔽，什么都不做
  log(`shielded: owner already alive (pid in lock), exit`);
  process.exit(0);
}

log(`owner acquired pid=${process.pid} (idle-exit ${IDLE_EXIT_S}s)`);

let starting = false;
async function ensureEngine() {
  if (starting) return;
  if (await healthy()) return;
  starting = true;
  try {
    log("gateway down -> starting");
    startEngine();
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (await healthy()) {
        log("gateway healthy");
        return;
      }
    }
    log("gateway did not become healthy within 60s");
  } finally {
    starting = false;
  }
}

// 监测循环：ZCode 在 -> 保网关；消失满 IDLE_EXIT_S -> 收摊退出
let goneSince = null;
setInterval(() => {
  if (zcodeRunning()) {
    goneSince = null;
    ensureEngine();
  } else {
    if (goneSince === null) goneSince = Date.now();
    const idle = (Date.now() - goneSince) / 1000;
    if (idle >= IDLE_EXIT_S) {
      log(`zcode gone ${Math.round(idle)}s -> stop gateway, release lock, exit`);
      stopEngine();
      releaseLock();
      process.exit(0);
    }
  }
}, POLL_MS);

ensureEngine();
