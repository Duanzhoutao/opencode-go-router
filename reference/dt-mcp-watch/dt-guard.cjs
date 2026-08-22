#!/usr/bin/env node
/**
 * dt-guard.cjs — desktop-touch 共享 HTTP 引擎(23847)的守护者
 *
 * 由 ZCode 的 SessionStart 钩子调用（config.json 的 hooks 块，type: process）。
 * 生命周期（用户决策 2026-08-19）：
 *   1. 只启动一次：第一个钩子实例抢到 PID 锁成为 owner；后续所有调用
 *      看到锁活着就直接退出（屏蔽），不重复启动。
 *   2. 一直监测：owner 常驻，每 5s 检查 ZCode.exe 是否还在、引擎是否健康
 *      （崩溃自动拉起）。
 *   3. 退出模式：ZCode.exe 消失满 IDLE_EXIT_S 秒 -> 停引擎 -> 释放锁 -> 退出。
 *
 * 自守护化：钩子进程（无 DT_GUARD_DETACHED）spawn 一份 detached 的自己做
 * 真正的守护（否则钩子会把会话卡住），然后最多等 10s 引擎健康就返回 0，
 * 保证首个会话启动时引擎已就绪。
 *
 * 日志：~/.desktop-touch-mcp/dt-guard.log
 * 测试用环境变量：DT_GUARD_TEST_ZCODE=0|1（伪造 ZCode 存在与否）、
 *                 DT_GUARD_IDLE_S=N（缩短空闲退出秒数）
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

const PORT = 23847;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const NODE_EXE = process.execPath; // 谁跑我，我就用谁 spawn
const HOME = os.homedir();
const ENGINE_ENTRY = path.join(HOME, ".desktop-touch-mcp", "releases", "v1.14.3", "dist", "index.js");
// 引擎按相对路径解析 assets/，cwd 必须设到包目录
const ENGINE_CWD = path.join(HOME, "AppData", "Local", "npm-cache", "_npx", "7ef18fc3781728a1", "node_modules", "@harusame64", "desktop-touch-mcp");
const LOCK_PATH = path.join(HOME, ".desktop-touch-mcp", "guard.lock");
const LOG_PATH = path.join(HOME, ".desktop-touch-mcp", "dt-guard.log");
const IDLE_EXIT_S = Number(process.env.DT_GUARD_IDLE_S) || 60;
const POLL_MS = 5000;
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TEST_ZCODE = process.env.DT_GUARD_TEST_ZCODE;

function log(line) {
  try {
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
  const child = spawn(NODE_EXE, [ENGINE_ENTRY, "--http", "--port", String(PORT)], {
    cwd: ENGINE_CWD,
    detached: true,
    // stdin 必须保持 pipe：引擎有 stdio-watch 行为，stdin EOF 就退出
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  child.unref();
  log(`engine spawn pid=${child.pid}`);
}

function stopEngine() {
  const expr =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '--port " +
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
if (!process.env.DT_GUARD_DETACHED) {
  const child = spawn(NODE_EXE, [__filename], {
    env: { ...process.env, DT_GUARD_DETACHED: "1" },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  child.unref();
  log("hook: detached guard spawned");
  // 最多等 10s，保证引擎就绪后钩子才返回（首个会话体验）
  (async () => {
    for (let i = 0; i < 20; i++) {
      if (await healthy()) {
        log(`hook: engine healthy after ${(i * 500 / 1000).toFixed(1)}s`);
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
    log("engine down -> starting");
    startEngine();
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (await healthy()) {
        log("engine healthy");
        return;
      }
    }
    log("engine did not become healthy within 60s");
  } finally {
    starting = false;
  }
}

// 监测循环：ZCode 在 -> 保引擎；消失满 IDLE_EXIT_S -> 收摊退出
let goneSince = null;
setInterval(() => {
  if (zcodeRunning()) {
    goneSince = null;
    ensureEngine();
  } else {
    if (goneSince === null) goneSince = Date.now();
    const idle = (Date.now() - goneSince) / 1000;
    if (idle >= IDLE_EXIT_S) {
      log(`zcode gone ${Math.round(idle)}s -> stop engine, release lock, exit`);
      stopEngine();
      releaseLock();
      process.exit(0);
    }
  }
}, POLL_MS);

ensureEngine();
