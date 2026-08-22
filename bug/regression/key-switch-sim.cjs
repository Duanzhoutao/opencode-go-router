#!/usr/bin/env node
/**
 * key-switch-sim.cjs — 网关 key 切换/调度逻辑回归脚本（kill-bug 登记用）
 *
 * 从 ../go-gateway.cjs 原样抽取调度/状态机函数（getOrBindKey/pickBestKey/shouldPreSwitch/
 * bindSession/cooldown/quarantine/activate/runStateMachine/quotaPercent/earliestRecovery），
 * 驱动 10 个场景做断言。当前目标：
 *   - 预期正确行为（S1/S2/S4/S5）必须绿灯；
 *   - 已登记缺陷（S3/S6/S7/S9/S10）当前应稳定红灯（对应 BUG-001/003/004/002/006）。
 *
 * 运行：node bug/regression/key-switch-sim.cjs
 * 退出码：0=全部符合预期；1=存在红灯；2=脚本自身错误
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "go-gateway.cjs");
const code = fs.readFileSync(SRC, "utf8");

// ---------- 从 go-gateway.cjs 原样切函数 ----------
const FUNCS = [
  ["SAME_KEY_RETRIES = ", "const"], ["MAX_FAILOVER = ", "const"], ["TRANSIENT = (", "const"], ["sleep = (", "const"],
  ["cooldown(", "function"], ["quarantine(", "function"], ["activate(", "function"], ["runStateMachine(", "function"],
  ["quotaPercent = (", "const"], ["DRAIN_MONTHLY_PCT = ", "const"], ["DRAIN_RENEWAL_HOURS = ", "const"], ["isDrainKey(", "function"], ["compareKeys(", "function"], ["shouldPreSwitch(", "function"],
  ["pickBestKey(", "function"], ["pickPreSwitchTarget(", "function"], ["PRECHECK_MARGIN = ", "const"], ["meaningfullyFresher(", "function"],
  ["bindSession(", "function"],
  ["shortSession = (", "const"], ["earliestRecovery(", "function"], ["getOrBindKey(", "function"],
  ["failoverChain(", "function"],
];
let extracted = "";
let idx = 0;
for (const [sig, kind] of FUNCS) {
  const probe = kind === "function" ? "function " + sig : "const " + sig;
  let start = code.indexOf(probe, idx);
  if (start < 0) { start = code.indexOf(sig, idx); if (start < 0) throw new Error("not found: " + sig); }
  if (kind === "const") {
    const semi = code.indexOf(";", start);
    extracted += code.slice(start, semi + 1) + "\n";
    idx = semi + 1;
  } else {
    // function 声明（可能带 async）：数大括号；保留 async 关键字
    if (code.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
    const bodyStart = code.indexOf("{", start);
    let depth = 0, i = bodyStart;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    extracted += code.slice(start, i) + "\n";
    idx = i;
  }
}

// ---------- 驱动环境 ----------
const events = [];
function addEvent(t, k, d) { events.push({ t, k, d }); }
function saveState() {}
let state = null;
let inflight = new Map();
const inflightInc = (id) => inflight.set(id, (inflight.get(id) || 0) + 1);
const inflightDec = (id) => inflight.set(id, Math.max(0, (inflight.get(id) || 0) - 1));
// failoverChain 依赖的转发/透传桩：每场景由测试代码注入
let attemptForward = async () => { throw new Error("attemptForward not stubbed"); };
function streamThrough(clientRes, upRes, key, sessionId, model, started) { /* 记录成功即可 */ }
eval(extracted + "\n;globalThis.__sim = { getOrBindKey, pickBestKey, shouldPreSwitch, bindSession, cooldown, quarantine, activate, runStateMachine, quotaPercent, earliestRecovery, failoverChain, meaningfullyFresher, isDrainKey, compareKeys, TRANSIENT, SAME_KEY_RETRIES, MAX_FAILOVER, sleep };");
const { getOrBindKey, pickBestKey, failoverChain } = globalThis.__sim;

function reset() {
  state = { config: { pollIntervalMs: 900000, preSwitchPct: 90, preSwitchWeeklyPct: 95, concurrencyPerKey: 1, stickyEnabled: true }, keys: [], sessions: [], events: [], seq: 0 };
  inflight = new Map();
  events.length = 0;
}
function mk(id, label, status, ws, roll, week, mon, rStatus, wStatus, mStatus, reason) {
  return {
    id, label, key: "sk-" + id, status, workspaceId: ws,
    quota: {
      rolling: { status: rStatus || "ok", percent: roll, resetsAt: "T+5h" },
      weekly: { status: wStatus || "ok", percent: week, resetsAt: "T+3d" },
      monthly: { status: mStatus || "ok", percent: mon, resetsAt: "T+28d" },
    },
    quarantinedAt: status === "quarantined" ? "now" : null,
    quarantineReason: reason || null,
    stats: { requests: 0, cachedTokens: 0, cacheHits: 0 },
  };
}
// 一次「请求 → key 分配」；key 分配后占用再释放，模拟一请求
function serve(sessionId) {
  const key = getOrBindKey(sessionId);
  if (key) inflight.set(key.id, (inflight.get(key.id) || 0) + 1);
  const bound = state.sessions.find((s) => s.sessionId === sessionId);
  if (key) inflight.set(key.id, Math.max(0, (inflight.get(key.id) || 0) - 1));
  return { key: key ? key.id : null, bound: bound ? bound.keyId : null };
}
const S = "sess_demo";

// ---------- 断言框架 ----------
let pass = 0, red = 0;
function check(name, cond, expectRed) {
  const ok = !!cond;
  const verdict = expectRed ? !ok : ok; // 红灯场景：断言「当前是错的」成立
  if (verdict) { pass++; console.log(`  PASS ${name}`); }
  else { red++; console.log(`  RED  ${name}${expectRed ? "（应红灯但当前竟然不红）" : ""}`); }
}
function header(t) { console.log(`\n${t}`); }

// ============================================================
header("S1 会话绑定健康 key → 绝不切换（预期正确行为）");
reset();
state.keys.push(mk("A", "主力", "active", "w1", 35, 40, 50), mk("B", "备用", "active", "w2", 12, 8, 22));
state.sessions.push({ sessionId: S, keyId: "A", requests: 86, lastActive: "now", model: "m" });
for (let i = 0; i < 3; i++) { const r = serve(S); check(`S1.${i + 1} 仍绑 A（实际=${r.key}）`, r.key === "A"); }

header("S2 rolling 达预切换阈值 → 主动换更鲜 key（预期正确行为）");
reset();
state.keys.push(mk("A", "主力", "active", "w1", 95, 40, 50), mk("B", "备用", "active", "w2", 12, 8, 22));
state.sessions.push({ sessionId: S, keyId: "A", requests: 86, lastActive: "now", model: "m" });
check("S2.1 首轮切到 B", serve(S).key === "B");
check("S2.2 次轮仍 B（不来回跳）", serve(S).key === "B");

header("S3 rolling 429 后 percent 未刷新 → 应换 B 而非挑回耗尽 A（BUG-001 红灯）");
reset();
state.keys.push(mk("A", "主力", "cooldown_rolling", "w1", 85, 40, 50, "ok", "ok", "ok"), mk("B", "备用", "active", "w2", 12, 8, 22));
state.sessions.push({ sessionId: S, keyId: "A", requests: 86, lastActive: "now", model: "m" });
for (let i = 0; i < 4; i++) { const r = serve(S); check(`S3.${i + 1} 不用耗尽 A（实际=${r.key}）`, r.key === "B"); }

header("S4 rolling percent 已被刷新为 100 → 应正确换 B（预期正确行为）");
reset();
state.keys.push(mk("A", "主力", "cooldown_rolling", "w1", 100, 40, 50, "rate-limited", "ok", "ok"), mk("B", "备用", "active", "w2", 12, 8, 22));
state.sessions.push({ sessionId: S, keyId: "A", requests: 86, lastActive: "now", model: "m" });
check("S4 换到 B", serve(S).key === "B");

header("S5 weekly 冷却 → 应正确换 B（预期正确行为）");
reset();
state.keys.push(mk("A", "主力", "cooldown_weekly", "w1", 0, 100, 50, "ok", "rate-limited", "ok"), mk("B", "备用", "active", "w2", 12, 8, 22));
state.sessions.push({ sessionId: S, keyId: "A", requests: 86, lastActive: "now", model: "m" });
check("S5 换到 B", serve(S).key === "B");

header("S6 全 key 同时近限 → 会话不得 ping-pong（BUG-003 红灯）");
reset();
state.keys.push(mk("A", "kA", "active", "w1", 50, 95, 50), mk("B", "kB", "active", "w2", 50, 92, 50), mk("C", "kC", "active", "w3", 50, 94, 50));
state.sessions.push({ sessionId: S, keyId: "A", requests: 86, lastActive: "now", model: "m" });
const seq6 = [];
for (let i = 0; i < 6; i++) seq6.push(serve(S).key);
const stable6 = seq6.every((k, i) => i === 0 || k === seq6[0]);
check(`S6 6 轮 key 序列稳定（实际=${seq6.join("→")}）`, stable6);

header("S7 monthly 90%（weekly 20% 健康）→ 不应弃用（BUG-004 红灯）");
reset();
state.keys.push(mk("A", "主力", "active", "w1", 30, 20, 90), mk("B", "备用", "active", "w2", 12, 8, 22));
state.sessions.push({ sessionId: S, keyId: "A", requests: 86, lastActive: "now", model: "m" });
check("S7 仍用 A（实际=" + serve(S).key + "）", serve(S).key === "A");

header("S8 429-failover 后会话绑定应跟上 fallback key（预期正确行为）");
reset();
state.keys.push(mk("A", "主力", "cooldown_weekly", "w1", 0, 100, 50, "ok", "rate-limited", "ok"), mk("B", "备用", "active", "w2", 12, 8, 22));
state.sessions.push({ sessionId: S, keyId: "A", requests: 86, lastActive: "now", model: "m" });
  const r8 = serve(S);
  check("S8 failover 后下一请求重绑 B（实际=" + r8.key + "）", r8.key === "B");

  header("S11 新会话应首选「月额度将耗尽」的 drain key（BUG-008 红灯）");
  reset();
  // A: monthly 90%（≈剩余<5h窗口，注定要死，缓存无价值）weekly 20%；B: 健康
  state.keys.push(mk("A", "主力", "active", "w1", 30, 20, 90), mk("B", "备用", "active", "w2", 12, 8, 22));
  const r11 = serve("sess_new_1");
  check(`S11 新会话首选 A（drain，实际=${r11.key}）`, r11.key === "A");

  header("S12 月额度未到 80% 但临近续费日且仍有剩余 → 也应 drain 优先（BUG-008）");
  reset();
  const a12 = mk("A", "主力", "active", "w1", 30, 20, 30);
  a12.quota.monthly.resetsAt = new Date(Date.now() + 24 * 3600e3).toISOString(); // 24h 后续费
  state.keys.push(a12, mk("B", "备用", "active", "w2", 12, 8, 22));
  const r12 = serve("sess_new_2");
  check(`S12 新会话首选临近续费的 A（实际=${r12.key}）`, r12.key === "A");

  header("S13 全健康 key 新会话按周平衡分摊（不破坏 balance）");
  reset();
  state.keys.push(mk("A", "kA", "active", "w1", 30, 30, 50), mk("B", "kB", "active", "w2", 30, 20, 50), mk("C", "kC", "active", "w3", 30, 10, 50));
  const r13 = serve("sess_new_3");
  check(`S13 新会话选周剩余最多的 C（实际=${r13.key}）`, r13.key === "C");

  header("S14 绑定健康 key 预切换目标应避开 drain key（缓存核心）");
  reset();
  state.keys.push(mk("A", "drain", "active", "w1", 30, 30, 90), mk("B", "绑定", "active", "w2", 30, 95, 50), mk("C", "健康", "active", "w3", 30, 10, 50));
  state.sessions.push({ sessionId: S, keyId: "B", requests: 10, lastActive: "now", model: "m" });
  const r14 = serve(S);
  check(`S14 B(周95)预切换目标是 C 而非 drain 的 A（实际=${r14.key}）`, r14.key === "C");

header("S9 failover 链必须有界终止（BUG-002）");
(async () => {
  reset();
  state.keys.push(mk("A", "原", "active", "w1", 30, 40, 50), mk("B", "备用", "active", "w2", 30, 40, 50));
  const attempts = { A: 0, B: 0 };
  // 所有 key 恒 5xx 且不改状态：旧实现会无限重试同一把 key，新实现必须有界终止
  attemptForward = async (key) => { attempts[key.id]++; return { stream: false, status: 502, body: "boom", retryAfter: null }; };
  const resStub = { writeHead() {}, end() {} };
  const key = state.keys[0];
  const out = { stream: false, status: 502, body: "boom", retryAfter: null };
  const done = failoverChain(resStub, key, out, "{}", {}, "sess", "m", 0);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const timedOut = await Promise.race([done.then(() => false), delay(5000).then(() => true)]);
  check(`S9 failover 链 5s 内有界终止（实际 A=${attempts.A} 次、B=${attempts.B} 次）`, timedOut === false && attempts.A + attempts.B <= 6);

  header("S10 网络抖动 → 应先同 key 重试 ≥2 次再切 key（BUG-006）");
  reset();
  state.keys.push(mk("A", "主力", "active", "w1", 35, 40, 50), mk("B", "备用", "active", "w2", 12, 8, 22));
  const attempts10 = { A: 0, B: 0 };
  // 桩：A 每次尝试都网络错误（502），B 永远 200 流式；A 应被重试 ≥2 次后才轮到 B
  attemptForward = async (key) => {
    attempts10[key.id]++;
    if (key.id === "B") return { stream: true, res: { statusCode: 200 } };
    return { stream: false, status: 502, body: "jitter", retryAfter: null };
  };
  const keyA = state.keys[0];
  const out10 = { stream: false, status: 502, body: "jitter", retryAfter: null };
  await failoverChain({ writeHead() {}, end() {} }, keyA, out10, "{}", {}, "sess", "m", 0);
  check(`S10 原 key A 至少重试 2 次再切（实际 A=${attempts10.A} 次、B=${attempts10.B} 次）`, attempts10.A >= 2);
  finish();
})();

function finish() {
  console.log(`\n结果：PASS=${pass} RED=${red}`);
  process.exit(red > 0 ? 1 : 0);
}
