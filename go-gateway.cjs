#!/usr/bin/env node
/**
 * go-gateway.cjs — OpenCode Go 多 Key 本地路由网关（Phase 1 MVP）
 *
 * 本地单进程网关（默认 127.0.0.1:8788，Node 24 原生 http/https，零依赖）：
 *   - 转发面  POST /v1/chat/completions     （OpenAI 协议，SSE 透传 + 透明 failover + 空回复重试优化）
 *             GET  /v1/models              （模型列表透传，ZCode 启动探测思考能力，不可 404）
 *   - 控制面  /api/*                         （keys/sessions/events/status/config）
 *   - 静态    GET /                          （前端六视图，纯 HTML/CSS/JS）
 *   - 探活    GET /health                    （go-guard 用）
 *
 * 设计依据：docs/plans/opencode-go-key-router-2026-08-22.md（主方案 L1-L8）
 * 与 docs/plans/opencode-go-router-ui-architecture-2026-08-22.md（UI/后端规格）。
 *
 * 环境变量：
 *   GO_PORT         端口（默认 8788）
 *   MOCK_MODE=1     不连真实端点，用合成数据剧本覆盖全部状态（前端开发/演示）
 *   GO_LOG          追加日志文件路径（默认仅 console）
 *   GO_STATE_DIR    状态目录（默认本项目根，keys.json 落在其下）
 *
 * 真实 Key 只存在 keys.json（0600，gitignore），不写入任何日志/文档。
 */
"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// 端口来源：GO_PORT 环境变量 > --port CLI 参数（go-guard 守护用它精确定位进程）> 默认 8788
function cliPort() {
  const i = process.argv.indexOf("--port");
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return 0;
}
const PORT = Number(process.env.GO_PORT) || cliPort() || 8788;
const MOCK = process.env.GO_MOCK_MODE === "1" || process.env.MOCK_MODE === "1";
const STATE_DIR = process.env.GO_STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, "keys.json");
const UI_DIR = path.join(__dirname, "ui");
const VERSION = "0.1.0-mvp";
const STARTED_AT = Date.now();

const UPSTREAM_HOST = "opencode.ai";
const UPSTREAM_BASE = "/zen/go/v1";
// node 原生 https 的 TLS 指纹已实测可过 Cloudflare（2026-08-22，urllib 会 1010）；仍带常规 UA 保险
const OUT_UA = `OpenCodeGoGateway/${VERSION} (local; 127.0.0.1:${PORT})`;

// 瞬时错误判定与重试策略：网络错/超时（网关 502）与上游 5xx 视为瞬时，同 key 重试后再 failover；
// 429（限额）/401（失效）不重试，直接切换。failover 有界防死循环（BUG-002/006）。
const SAME_KEY_RETRIES = 2;                     // 瞬时错误同 key 重试次数
const MAX_FAILOVER = 4;                         // failover 总尝试上限（每把 key 至多一次）
const TRANSIENT = (s) => s === 502 || (s >= 500 && s < 600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 日志 ----------------
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  if (process.env.GO_LOG) {
    try { fs.appendFileSync(process.env.GO_LOG, line + "\n"); } catch {}
  }
}

// ---------------- 状态 / 存储 ----------------
function defaultState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    config: {
      pollIntervalMs: 15 * 60 * 1000, // /usage 主动轮询默认 15min
      concurrencyPerKey: 5,           // 每 Key 并发上限
      localToken: null,               // 可选本地 token：设置后转发面与控制面要求 Bearer
      stickyEnabled: true,            // x-session-id 粘性开关
      retryEmptyResponse: false,      // 空回复重试优化：识别上游空流->掐断连接->触发 ZCode 网络级自动重试；默认关（缓冲整流让思考不实时滚动，2026-08-24 用户定稿）
      fallback: {                     // 备用通道（通用 OpenAI 协议上游，字段全部前端可配）
        enabled: false,
        label: "官方 DeepSeek",
        baseURL: "",                  // 留空回退 DeepSeek 官方默认（FALLBACK_DEFAULT_BASE）
        apiKey: null,                 // 前端填写保存；GET /api/config 掩码 "(set)"
        model: "deepseek-v4-flash-vision-exp", // 兜底时一律改写为该模型
        reasoningEffort: "max",       // 思考强度（OpenAI 字段 reasoning_effort），默认拉满；各厂取值不同，留空=不注入
        billingMode: "balance",       // balance=DeepSeek 官方 /user/balance 自动计费 | none=不计费
        balanceSampleMs: 15 * 60 * 1000,
      },
      relay: {                        // 中转站优先层运行参数（docs/plans/opencode-go-relay-priority-2026-08-25.md）
        enabled: true,                // 总开关（前端「启用优先通道」）
        headerTimeoutMs: 30 * 1000,   // 前置尝试响应头超时（快失败降级，防死站拖慢体验）
      },
    },
    keys: [],
    relays: [],                       // 中转站台账（每站常单模型、按额度计费）
    goModels: { list: [], fetchedAt: null }, // Go /v1/models 缓存（降级判定 + 半填半选候选源）
    sessions: [],
    events: [],
    seq: 0,
    // 备用通道运行态（持久化，支持关网关补结算）
    fallbackState: { sessionStart: null, samples: [], costs: [], settlements: [], lastFallbackAt: null, lastSampleAt: 0 },
  };
}
let state = defaultState();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const d = defaultState();
      state = {
        ...d, ...raw,
        config: { ...d.config, ...(raw.config || {}), fallback: { ...d.config.fallback, ...((raw.config || {}).fallback || {}) }, relay: { ...d.config.relay, ...((raw.config || {}).relay || {}) } },
        fallbackState: { ...d.fallbackState, ...(raw.fallbackState || {}) },
      };
      // 迁移清理：旧版持久化的预切换配置（90% 预切换已整体移除）不再回显
      delete state.config.preSwitchPct;
      delete state.config.preSwitchWeeklyPct;
      if (!Array.isArray(state.keys)) state.keys = [];
      if (!Array.isArray(state.sessions)) state.sessions = [];
      if (!Array.isArray(state.events)) state.events = [];
      if (!Array.isArray(state.fallbackState.samples)) state.fallbackState.samples = [];
      if (!Array.isArray(state.fallbackState.costs)) state.fallbackState.costs = [];
      if (!Array.isArray(state.fallbackState.settlements)) state.fallbackState.settlements = [];
      if (!Array.isArray(state.relays)) state.relays = [];
      if (!state.goModels || !Array.isArray(state.goModels.list)) state.goModels = { list: [], fetchedAt: null };
    }
  } catch (e) { log("state load failed: " + e.message); }
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  const tmp = STATE_FILE + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { log("state save failed: " + e.message); }
}

function addEvent(type, keyId, detail) {
  state.events.unshift({ ts: new Date().toISOString(), type, keyId, detail });
  if (state.events.length > 500) state.events.length = 500;
}

function redactKey(k) {
  const { key, ...rest } = k;
  return { ...rest, key: key ? key.slice(0, 7) + "****" + key.slice(-4) : null };
}

function toQuota(usage) {
  const w = (o) => ({ status: o.status, percent: o.percent, resetsAt: o.resetsAt, lastChecked: new Date().toISOString() });
  return { rolling: w(usage.rolling), weekly: w(usage.weekly), monthly: w(usage.monthly) };
}

// ---------------- 真实 /usage 探测 ----------------
function fetchUsage(key) {
  return new Promise((resolve) => {
    const opts = {
      hostname: UPSTREAM_HOST, port: 443, path: UPSTREAM_BASE + "/usage", method: "GET",
      headers: { Authorization: "Bearer " + key, Accept: "application/json", "User-Agent": OUT_UA },
      timeout: 20000,
    };
    const req = https.request(opts, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve({ ok: true, usage: JSON.parse(b).usage, code: 200 }); }
          catch (e) { resolve({ ok: false, code: "parse", msg: e.message }); }
        } else resolve({ ok: false, code: res.statusCode, msg: b.slice(0, 200) });
      });
    });
    req.on("error", (e) => resolve({ ok: false, code: "err", msg: e.message }));
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.end();
  });
}

// ---------------- 状态机（L5/L6） ----------------
function cooldown(key, status, windowName) {
  if (key.status !== status) {
    key.status = status;
    addEvent("cooldown", key.id, `entered ${status} (${windowName})`);
  }
}
function quarantine(key, reason) {
  if (key.status !== "quarantined") {
    key.status = "quarantined";
    key.quarantinedAt = new Date().toISOString();
    key.quarantineReason = reason;
    addEvent("quarantine", key.id, "reason=" + reason);
  }
}
function activate(key, reason) {
  if (key.status !== "active") {
    key.status = "active";
    key.quarantinedAt = null;
    key.quarantineReason = null;
    addEvent("recover", key.id, "back to active (" + (reason || "window ok") + ")");
  }
}

// 依据 /usage 快照驱动状态迁移
function runStateMachine(key) {
  const q = key.quota;
  if (!q) return;
  const m = q.monthly, w = q.weekly, r = q.rolling;
  const monthlyLimited = m && m.status === "rate-limited";
  const weeklyLimited = w && w.status === "rate-limited";
  const rollingLimited = r && r.status === "rate-limited";

  switch (key.status) {
    case "active":
      if (monthlyLimited) quarantine(key, "monthly");
      else if (weeklyLimited) cooldown(key, "cooldown_weekly", "weekly");
      else if (rollingLimited) cooldown(key, "cooldown_rolling", "rolling");
      break;
    case "cooldown_rolling":
      if (monthlyLimited) quarantine(key, "monthly");
      else if (weeklyLimited) cooldown(key, "cooldown_weekly", "weekly");
      else if (!rollingLimited) activate(key, "rolling ok");
      break;
    case "cooldown_weekly":
      if (monthlyLimited) quarantine(key, "monthly"); // 周一复查：weekly 恢复但 monthly 仍限 -> 隔离
      else if (!weeklyLimited) {
        if (rollingLimited) cooldown(key, "cooldown_rolling", "rolling");
        else activate(key, "weekly ok");
      }
      break;
    default: break; // quarantined / invalid 不自动迁移
  }
}

// ---------------- 隔离区复活（L6 增强：月限 Key 自动复查 + 一键查询，共用同一恢复门禁） ----------------
// 自动复查的「到点」判定：仅月限隔离（reason="monthly"）且已过续费日+ε 的 Key 才值得查 /usage。
// 无 resetsAt（一次性套餐）不自动复查；已判废弃（monthly_dead）/手动停用/认证失效 也不自动复查。
function quarantineDueForCheck(key, now = Date.now()) {
  if (key.status !== "quarantined" || key.quarantineReason !== "monthly") return false;
  const m = key.quota && key.quota.monthly;
  if (!m || !m.resetsAt) return false;
  return now >= new Date(m.resetsAt).getTime() + REVIVE_EPSILON_MS;
}

// 恢复门禁（手动 reactivate / reactivate-all「一键查询」/ 自动复查共用）：
// monthly.status==="ok" 才回池；回池后补跑状态机，让同时受限的 weekly/rolling 直接进入冷却，
// 避免「回池 → 第一个请求白吃一个 429」再被 failover 打下来。
function activateFromUsage(key, usage, via) {
  key.quota = toQuota(usage);
  if (key.quota.monthly && key.quota.monthly.status === "ok") {
    activate(key, via || "monthly ok");
    runStateMachine(key);
    return { ok: true, status: key.status };
  }
  return { ok: false, reason: "monthly still rate-limited" };
}

// ---------------- 调度器（L3） ----------------
const inflight = new Map();
const inflightInc = (id) => inflight.set(id, (inflight.get(id) || 0) + 1);
const inflightDec = (id) => inflight.set(id, Math.max(0, (inflight.get(id) || 0) - 1));

const quotaPercent = (k, w) => (k.quota && k.quota[w] ? k.quota[w].percent : 0);

// ---------------- 调度（L3）：双策略排序（2026-08-24 定稿） ----------------
// 缓存核心不变：网关唯一优化目标 = 提示词缓存命中率 -> 粘性层健康绑定绝不迁移。
// 会话流量（带 x-session-id，有粘性与缓存收益）= 到期优先（EDF）：
//   monthly.resetsAt = 订阅续费日 = 额度到期日，到期未用完的额度随重置作废 ->
//   永远先花马上作废的钱；无 resetsAt（一次性套餐）余额不作废，视作「存款」最后花。
// 无会话流量（不带 x-session-id，本地脚本/训练模型调用等）= 最轻松优先：
//   无缓存收益且常为突发批量 -> 路由到当前余量最大的 Key，避免集中打满一把 Key 触发 429 风暴。
// 两策略只在 新会话绑定 / 绑定失效重分配 / failover 目标选择 时生效，互不越过粘性层。
const REVIVE_EPSILON_MS = 5 * 60 * 1000; // 隔离复查过点缓冲：monthly.resetsAt 带快照截断毫秒，防时钟/服务端延迟误判

// 月到期时间戳；缺失/非法（一次性套餐等）= Infinity（最后消耗）
function expiryTime(k) {
  const m = k.quota && k.quota.monthly;
  if (!m || !m.resetsAt) return Infinity;
  const t = new Date(m.resetsAt).getTime();
  return Number.isFinite(t) ? t : Infinity;
}

// 会话流量排序：月到期近者优先 -> 同到期先用月额度将尽者 -> 周剩余 -> 5h 剩余 -> 并发少
function compareKeys(a, b) {
  const ta = expiryTime(a), tb = expiryTime(b);
  if (ta !== tb) return ta - tb;
  const dMonthly = quotaPercent(b, "monthly") - quotaPercent(a, "monthly");
  if (dMonthly) return dMonthly;
  return compareRelaxed(a, b);
}

// 无会话流量排序（「最轻松」= 余量最大）：5h 剩余 -> 周剩余 -> 月剩余 -> 并发少
function compareRelaxed(a, b) {
  const dRolling = quotaPercent(a, "rolling") - quotaPercent(b, "rolling");
  const dWeekly = quotaPercent(a, "weekly") - quotaPercent(b, "weekly");
  const dMonthly = quotaPercent(a, "monthly") - quotaPercent(b, "monthly");
  const dInflight = (inflight.get(a.id) || 0) - (inflight.get(b.id) || 0);
  return dRolling || dWeekly || dMonthly || dInflight;
}

// 新会话 / 迁移 / failover 目标分配：relaxed=true 走无会话策略，否则到期优先
function pickBestKey(excludeId, skipIds, relaxed) {
  const cap = state.config.concurrencyPerKey;
  const actives = state.keys.filter((k) => k.status === "active" && k.id !== excludeId && !(skipIds && skipIds.has(k.id)));
  if (!actives.length) return null;
  const underCap = actives.filter((k) => (inflight.get(k.id) || 0) < cap);
  const pool = underCap.length ? underCap : actives;
  pool.sort(relaxed ? compareRelaxed : compareKeys);
  return pool[0];
}

function bindSession(sessionId, key) {
  const s = state.sessions.find((x) => x.sessionId === sessionId);
  if (s) {
    if (s.keyId !== key.id) { s.keyId = key.id; s.requests = 0; s.lastActive = new Date().toISOString(); addEvent("migrate", key.id, `session ${shortSession(sessionId)} rebound`); }
    s.lastActive = new Date().toISOString();
  } else {
    state.sessions.push({ sessionId, keyId: key.id, requests: 0, lastActive: new Date().toISOString(), model: null });
    addEvent("bind", key.id, `session ${shortSession(sessionId)} -> key`);
  }
}

const shortSession = (s) => (s && s.length > 14 ? s.slice(0, 10) + "…" : String(s));

// 最早恢复时间：所有 cooldown Key 中最近的 resetsAt
function earliestRecovery() {
  let best = null;
  for (const k of state.keys) {
    if (!k.status.startsWith("cooldown")) continue;
    const q = k.status === "cooldown_weekly" ? (k.quota && k.quota.weekly) : (k.quota && k.quota.rolling);
    if (q && q.resetsAt && (!best || q.resetsAt < best)) best = q.resetsAt;
  }
  return best;
}

// 返回本请求应使用的 Key；无可用返回 null
function getOrBindKey(sessionId) {
  if (state.config.stickyEnabled && sessionId) {
    const sess = state.sessions.find((x) => x.sessionId === sessionId);
    if (sess) {
      const bound = state.keys.find((k) => k.id === sess.keyId);
      // 粘性：健康绑定绝不动（预切换已移除——90% 提前迁移毁缓存且收益已被 failover 覆盖，429 交由 failoverChain 兜底）
      if (bound && bound.status === "active") return bound;
      // 绑定 Key 不可用（cooldown_*/quarantined/invalid）-> 重分配；rolling 冷却 key 一律不可服务（BUG-001）
      const alt = pickBestKey(null);
      if (alt) { bindSession(sessionId, alt); return alt; }
      return null;
    }
  }
  // 无会话（或关粘性）：无会话流量走最轻松优先（不粘不绑）；带会话但关粘性仍按到期优先逐请求选
  const k = pickBestKey(null, null, !sessionId);
  if (k && sessionId) bindSession(sessionId, k);
  return k;
}

// ---------------- 转发面（L4） ----------------
// BUG-001：429 命中窗口时同步标记 quota 状态，避免下游（轮询状态机/调度）读到过期 status 而误判
function markWindowLimited(key, w) {
  if (key.quota && key.quota[w]) key.quota[w].status = "rate-limited";
}
// 429 limitName 归一化（BUG-011）：实测 5h 窗口上游返回 "5 hour" 而非 "rolling"
// （证据：2026-08-24 事件日志 `429 5 hour` 连打 11 次而 Key 未冷却--实时冷却此前从未生效过）。
// 按关键词归一；认不出/缺失也按 rolling 兜底--GoUsageLimitError 必属三窗口之一，
// 误判最坏 = 多冷却到下一次 /usage 轮询（≤15min）自愈，远好于不冷却引发 429 风暴。
function normalizeLimitName(ln) {
  const s = typeof ln === "string" ? ln.toLowerCase() : "";
  if (s.includes("month")) return "monthly";
  if (s.includes("week")) return "weekly";
  return "rolling"; // "5 hour" / "rolling" / 未知值 / 缺失
}
function handleUpstreamError(key, status, bodyText) {
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch {}
  // 实测 429 响应 metadata 在顶层（{"type":"error","error":{...},"metadata":{...}}），兼容历史"error.metadata"位置
  const meta = (parsed && (parsed.metadata || (parsed.error && parsed.error.metadata))) || {};
  if (status === 429 && parsed && parsed.error && parsed.error.type === "GoUsageLimitError") {
    if (meta.workspace && !key.workspaceId) key.workspaceId = meta.workspace;
    const raw = typeof meta.limitName === "string" ? meta.limitName : "";
    const ln = normalizeLimitName(raw);
    if (ln === "monthly") { quarantine(key, "monthly"); markWindowLimited(key, "monthly"); }
    else if (ln === "weekly") { cooldown(key, "cooldown_weekly", "weekly"); markWindowLimited(key, "weekly"); }
    else { cooldown(key, "cooldown_rolling", "rolling"); markWindowLimited(key, "rolling"); }
    addEvent("rate-limited", key.id, `429 ${ln}${raw && raw.toLowerCase() !== ln ? " (raw=" + raw + ")" : ""}${meta.workspace ? " ws=" + meta.workspace : ""}`);
    maybeWarnSamePool(key);
  } else if (status === 401) {
    quarantine(key, "auth_invalid");
    addEvent("quarantine", key.id, "401 during request");
  } else if (status >= 500) {
    addEvent("upstream-5xx", key.id, `HTTP ${status}`);
  }
}

// 同 workspace 共享额度告警（P9）：429 暴露的 workspace 若与别的 Key 相同则提示
function maybeWarnSamePool(key) {
  if (!key.workspaceId) return;
  const dup = state.keys.find((k) => k.id !== key.id && k.workspaceId === key.workspaceId);
  if (dup) addEvent("same-workspace-alert", key.id, `shares workspace ${key.workspaceId} with key ${dup.id} (same quota pool!)`);
}

// 向上游转发一次；成功（2xx 流式）返回 {stream,res}，否则读完错误体返回 {stream:false,status,body,retryAfter}
function attemptForward(key, rawBody, clientHeaders) {
  return new Promise((resolve) => {
    const headers = {
      Authorization: "Bearer " + key.key,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(rawBody),
      "User-Agent": OUT_UA,
      Accept: clientHeaders.accept || "text/event-stream",
    };
    if (clientHeaders["x-request-id"]) headers["x-request-id"] = clientHeaders["x-request-id"];
    const opts = { hostname: UPSTREAM_HOST, port: 443, path: UPSTREAM_BASE + "/chat/completions", method: "POST", headers, timeout: 300000 };
    const up = https.request(opts, (upRes) => {
      if (upRes.statusCode >= 200 && upRes.statusCode < 300) {
        resolve({ stream: true, res: upRes });
      } else {
        let b = "";
        upRes.on("data", (c) => (b += c));
        upRes.on("end", () => {
          handleUpstreamError(key, upRes.statusCode, b);
          resolve({ stream: false, status: upRes.statusCode, body: b, retryAfter: upRes.headers["retry-after"] });
        });
      }
    });
    up.on("error", (e) => resolve({ stream: false, status: 502, body: JSON.stringify({ error: { type: "GatewayError", message: e.message } }), retryAfter: null }));
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.end(rawBody);
  });
}

function finishRequest(key, sessionId, model, started, cacheTokens) {
  key.stats.requests += 1;
  key.stats.cachedTokens += cacheTokens;
  if (cacheTokens > 0) key.stats.cacheHits += 1;
  if (sessionId) {
    const s = state.sessions.find((x) => x.sessionId === sessionId);
    if (s) { s.requests += 1; s.lastActive = new Date().toISOString(); if (model) s.model = model; }
  }
  inflightDec(key.id);
  saveState();
  if (cacheTokens > 0) addEvent("cache-hit", key.id, `${model} cached=${cacheTokens}`);
}

// 流内异常完成检测（空回复重试优化）：上游 2xx 已开始流式，但收尾给出「空回复」——
// 无正文/无工具调用，且 finish_reason 非正常值（如 other / 其它未知值）或流不完整（无 finish 无 [DONE]）。
// 关键约束（实测 ZCode 行为）：一旦客户端已向用户输出过任何内容（思考也算），ZCode 就判定
// retryable=false、不自动重试；只有「连接层就失败、零输出」才 retryable=true 自动重发。
// 因此本实现在收到第一个正文/工具调用 chunk 之前**暂存整个流**（思考也暂存）：
//   - 若最终是空回复 → 掐断连接且一个字节都不透传（客户端表现为连接层失败 → ZCode 自动重试）；
//   - 若出现了正文/工具调用 → 把暂存的思考+正文一次性交还，之后转直通；
//   - 合法 thinking-only 完成（finish=stop/[DONE]，只有思考没有正文）→ 按正常完成交还；
//   仅当 retryEmptyResponse 打开时才缓存（关掉则完全透明直通）。
// 副作用：思考不再实时滚动（正文出现时一并出现）；这是「零输出失败→可重试」的必然代价。
function streamThrough(clientRes, upRes, key, sessionId, model, started, onUsage) {
  clientRes.writeHead(upRes.statusCode, upRes.headers);
  let buf = "";
  let cacheTokens = 0;
  let sawContent = false;      // 是否出现过正文（delta.content / delta.text）
  let sawToolCalls = false;    // 是否出现过工具调用
  let sawDone = false;         // 是否看到 data: [DONE]
  let finishReason = null;     // 最后一个 finish_reason
  let lastUsage = null;        // 末 chunk 的 usage（include_usage 时；备用通道计费明细用）
  let settled = false;         // finishRequest 只记一次账（abort 会 destroy 上游触发 error，需守卫防重复）
  let flushed = false;         // 已进入直通模式（缓冲已冲刷）
  const pending = [];          // 冲刷前暂存的原始 chunk
  let pendingBytes = 0;
  const MAX_PENDING = 512 * 1024; // 缓冲上限：超限降级直通（病态超长思考不撑爆内存）
  const finishOnce = () => {
    if (settled) return; settled = true;
    finishRequest(key, sessionId, model, started, cacheTokens);
    if (onUsage && lastUsage) { try { onUsage(lastUsage); } catch {} }
  };
  const endClient = () => { try { clientRes.end(); } catch {} finishOnce(); };
  const flushPending = () => {
    for (const c of pending) { try { clientRes.write(c); } catch {} }
    pending.length = 0; pendingBytes = 0; flushed = true;
  };
  const abortClient = (why) => {
    addEvent("empty-stream", key.id, `model=${model} abort=${why} content=${sawContent} tools=${sawToolCalls} finish=${finishReason || "none"}`);
    try { clientRes.destroy(); } catch {}
    finishOnce();
    try { upRes.destroy(); } catch {} // 提前释放上游；其 error 由 finishOnce 守卫，不重复记账
  };
  // 增量 SSE 解析：跨 chunk 拼接，按 \n\n 切事件，提取正文/工具调用/finish_reason/[DONE]
  let sse = "";
  const scan = (text) => {
    sse += text;
    let idx;
    while ((idx = sse.indexOf("\n\n")) >= 0) {
      const block = sse.slice(0, idx); sse = sse.slice(idx + 2);
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { sawDone = true; continue; }
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev.usage) lastUsage = ev.usage; // usage-only chunk（choices 为空）也要捕获
        const ch = ev.choices && ev.choices[0];
        if (!ch) continue;
        const d = ch.delta || {};
        if (d.content || d.text) sawContent = true;
        if (d.tool_calls && d.tool_calls.length) sawToolCalls = true;
        if (ch.finish_reason) finishReason = ch.finish_reason;
      }
    }
    if (sse.length > 65536) sse = sse.slice(-16384);
  };
  const abnormalFinish = () => finishReason && !["stop", "tool_calls", "length", "content_filter"].includes(finishReason);
  const enabled = () => state.config.retryEmptyResponse === true;
  const emptySoFar = () => !sawContent && !sawToolCalls;
  upRes.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    buf += text;
    scan(text);
    const m = buf.match(/"cached_tokens"\s*:\s*(\d+)/);
    if (m) cacheTokens = Math.max(cacheTokens, parseInt(m[1], 10));
    if (buf.length > 65536) buf = buf.slice(-16384);
    if (!flushed && enabled()) {
      // 缓冲阶段：空回复签名出现（无正文/工具 + 非正常 finish）→ 零字节掐断
      if (emptySoFar() && abnormalFinish()) { abortClient("empty-buffer"); return; }
      // 出现真实内容/工具调用 → 冲刷暂存（含思考），本次 chunk 一并交还，进入直通
      if (!emptySoFar()) { flushPending(); }
      // 缓冲超限 → 降级直通，避免病态超长思考撑爆内存
      else if (pendingBytes > MAX_PENDING) { flushPending(); }
      if (!flushed) { pending.push(chunk); pendingBytes += chunk.length; return; }
    }
    clientRes.write(chunk);
  });
  upRes.on("end", () => {
    if (settled) return; // 已因空回复掐断，不再补正常收尾
    if (!flushed && enabled()) {
      // 从未进入直通：整条流都在缓冲里。无正文/工具 且（非正常 finish 或 流不完整）→ 零字节掐断；否则（合法完成，如 thinking-only）交还
      if (emptySoFar() && (abnormalFinish() || (!finishReason && !sawDone))) { abortClient("empty-buffer"); return; }
      flushPending();
    }
    // 非流式响应（无 SSE）：直接从 JSON 体里补抓 usage
    if (onUsage && !lastUsage && buf.trim().startsWith("{")) { try { const j = JSON.parse(buf); if (j.usage) lastUsage = j.usage; } catch {} }
    endClient();
  });
  upRes.on("error", () => {
    // 上游中途断连：缓冲阶段（零输出）→ 掐断 = 连接层失败 = 客户端可重试；已直通 → 掐断（原有行为）
    try { clientRes.destroy(); } catch {}
    finishOnce();
  });
}

// 首字节前失败后的统一兜底（BUG-002/005/006）：
//   1) 瞬时错误（5xx/网络/超时）先在原 key 上重试 SAME_KEY_RETRIES 次（限额/401 不重试）；
//   2) 有界 failover：每把 key 至多试一次、总上限 MAX_FAILOVER（防死循环）；目标与原请求同策略
//      （有会话=到期优先，无会话=最轻松优先）；
//   3) failover 成功当场把会话重绑到 fallback key（下个请求直连，避免晚一拍 + 计数归零）；
//   4) 全部耗尽如实回最后错误（附最近恢复时间）。
async function failoverChain(res, key, out, rawBody, clientHeaders, sessionId, model, started) {
  inflightDec(key.id);
  let last = out;
  if (TRANSIENT(last.status)) {
    for (let r = 0; r < SAME_KEY_RETRIES; r++) {
      await sleep(300 * (r + 1));
      inflightInc(key.id);
      const retry = await attemptForward(key, rawBody, clientHeaders);
      if (retry.stream) {
        if (state.fallbackState.sessionStart) markFallbackEnd("go-recovered");
        streamThrough(res, retry.res, key, sessionId, model, started, keyUsageRecorder(key));
        return;
      }
      inflightDec(key.id);
      last = retry;
      if (!TRANSIENT(last.status)) break; // 变为限额/401 -> 停止同 key 重试，走 failover
    }
  }
  const tried = new Set([key.id]);
  let fallback = null;
  let attempts = 0;
  while (attempts < MAX_FAILOVER && (fallback = pickBestKey(key.id, tried, !sessionId))) {
    attempts++;
    tried.add(fallback.id);
    inflightInc(fallback.id);
    addEvent("failover", key.id, `HTTP ${last.status} -> key ${fallback.id}`);
    const nxt = await attemptForward(fallback, rawBody, clientHeaders);
    if (nxt.stream) {
      if (sessionId) bindSession(sessionId, fallback);
      if (state.fallbackState.sessionStart) markFallbackEnd("go-recovered");
      streamThrough(res, nxt.res, fallback, sessionId, model, started, keyUsageRecorder(fallback));
      return;
    }
    inflightDec(fallback.id);
    last = nxt;
  }
  // 全部 Key 耗尽：先试备用通道（通用 OpenAI 上游），不行再如实回最后错误（附最近恢复时间）
  addEvent("exhausted", key.id, `all keys failed (last HTTP ${last.status})`);
  if (await tryFallback(res, rawBody, clientHeaders, sessionId, model, started)) { saveState(); return; }
  const head = { "Content-Type": "application/json" };
  if (last.retryAfter) head["Retry-After"] = last.retryAfter;
  res.writeHead(last.status, head);
  res.end(last.body || JSON.stringify({ error: { type: "GatewayError", message: "all keys exhausted" } }));
  saveState();
}

// ---------------- 备用通道（通用 OpenAI 协议上游，字段全部前端可配） ----------------
// 设计（docs/plans/opencode-go-router-fallback-2026-08-22.md）：
//   触发 = 三窗口语义下「无任何可用 key」；切回 = 任一 key 窗口刷新即回 Go（不粘备用）；
//   通道 = 任意 OpenAI 兼容端点（默认 DeepSeek 官方）；计费 = 可选能力（balance | none）。
const FALLBACK_DEFAULT_BASE = "https://api.deepseek.com";

function fallbackConfig() { return state.config.fallback || {}; }
function fallbackReady() {
  const f = fallbackConfig();
  return !!(f && f.enabled && f.apiKey);
}
// 三窗口语义（用户定稿）：可用 key = 5h/weekly/monthly 均未打满（状态机表达为 active）；
// 任一窗口打满即不可用（weekly 满 5h 空也转不过去；monthly 满即废弃）。
// 手动停用 / 失效 key 不计入判定；候选集合为空（没配 key）不触发备用（不烧钱）。
function noUsableKey() {
  const candidates = state.keys.filter((k) => k.status !== "invalid" && k.quarantineReason !== "manual");
  if (!candidates.length) return false;
  return !candidates.some((k) => k.status === "active");
}
// 通用上游解析：baseURL + /chat/completions（DeepSeek 默认、/v1 基、自定义路径基都成立）
function fallbackUpstream(baseURL) {
  let u;
  try { u = new URL((baseURL != null ? baseURL : fallbackConfig().baseURL || "").trim() || FALLBACK_DEFAULT_BASE); }
  catch { u = new URL(FALLBACK_DEFAULT_BASE); }
  return {
    lib: u.protocol === "http:" ? http : https,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443,
    path: u.pathname.replace(/\/+$/, "") + "/chat/completions",
    base: u.pathname.replace(/\/+$/, ""),
  };
}
// OpenAI 标准字段白名单：模型一律改写为通道模型；Go 平台私有扩展字段剔除（防上游 400）
const FALLBACK_BODY_FIELDS = ["messages", "stream", "stream_options", "temperature", "top_p", "max_tokens", "stop", "tools", "tool_choice", "response_format", "reasoning_effort", "presence_penalty", "frequency_penalty", "seed", "user"];
function buildFallbackBody(payload, withUsage, modelOverride) {
  const f = fallbackConfig();
  const body = { model: modelOverride || f.model, messages: payload.messages };
  for (const k of FALLBACK_BODY_FIELDS) if (payload[k] !== undefined) body[k] = payload[k];
  if (f.reasoningEffort != null && f.reasoningEffort !== "") body.reasoning_effort = f.reasoningEffort; // 思考强度：配置优先（默认拉满），留空透传客户端
  if (withUsage && body.stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  return body;
}
// DeepSeek 官方 /user/balance（自动计费的唯一金额口径）；其他端点自然 404 → billingMode=none
function fetchFallbackBalance(overrides) {
  if (MOCK) return Promise.resolve({ ok: true, isAvailable: true, balance: Math.max(0, 9.53 - state.fallbackState.costs.length * 0.01), currency: "CNY" });
  const f = fallbackConfig();
  const apiKey = (overrides && overrides.apiKey) || f.apiKey;
  return new Promise((resolve) => {
    const up = fallbackUpstream((overrides && overrides.baseURL) != null ? overrides.baseURL : undefined);
    const req = up.lib.request({
      hostname: up.hostname, port: up.port, path: up.base + "/user/balance", method: "GET",
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json", "User-Agent": OUT_UA }, timeout: 20000,
    }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => {
        if (r.statusCode !== 200) return resolve({ ok: false, code: r.statusCode });
        try {
          const j = JSON.parse(b);
          const infos = j.balance_infos || [];
          const pick = infos.find((x) => x.currency === "CNY") || infos.find((x) => x.currency === "USD");
          resolve({ ok: true, isAvailable: !!j.is_available, balance: pick ? Number(pick.total_balance) : null, currency: pick ? pick.currency : null });
        } catch (e) { resolve({ ok: false, code: "parse", msg: e.message }); }
      });
    });
    req.on("error", (e) => resolve({ ok: false, code: "err", msg: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}
function recordBalanceSample(balance, currency) {
  const s = state.fallbackState;
  s.samples.push({ ts: new Date().toISOString(), balance, currency: currency || "CNY" });
  s.lastSampleAt = Date.now();
  if (s.samples.length > 3000) s.samples.splice(0, s.samples.length - 3000);
}
// 备用周期开始：首次兜底时快照余额（balance 模式）；sessionStart 存在即「备用中」
function markFallbackStart() {
  const s = state.fallbackState;
  if (s.sessionStart) return;
  const f = fallbackConfig();
  s.sessionStart = { ts: new Date().toISOString(), balance: null, currency: null };
  addEvent("fallback:start", null, `备用通道接管（${f.label || "fallback"} → ${f.model}）`);
  if (f.billingMode !== "none") {
    fetchFallbackBalance().then((v) => {
      if (v.ok && v.balance != null && state.fallbackState.sessionStart) {
        state.fallbackState.sessionStart.balance = v.balance;
        state.fallbackState.sessionStart.currency = v.currency;
        recordBalanceSample(v.balance, v.currency);
        saveState();
      }
    });
  }
}
// 备用周期结束（切回 Go / 网关重启补结算）：再快照一次余额，差值 = 官方实际扣费
function markFallbackEnd(via) {
  const s = state.fallbackState;
  if (!s.sessionStart) return;
  const start = s.sessionStart;
  s.sessionStart = null; // 先关，防并发重复结算
  const finish = (endBalance) => {
    const delta = start.balance != null && endBalance != null ? Math.round((start.balance - endBalance) * 10000) / 10000 : null;
    s.settlements.unshift({ startTs: start.ts, endTs: new Date().toISOString(), startBalance: start.balance, endBalance: endBalance == null ? null : endBalance, delta, currency: start.currency || "CNY", via: via || "go-recovered" });
    if (s.settlements.length > 100) s.settlements.length = 100;
    addEvent("fallback:end", null, via === "startup" ? `网关重启补结算${delta != null ? "：¥" + delta : "（金额未知）"}` : `切回 Go，本次备用消耗${delta != null ? " ¥" + delta : "（金额未知/不计费）"}`);
    saveState();
  };
  if (fallbackConfig().billingMode !== "none") {
    fetchFallbackBalance().then((v) => {
      if (v.ok && v.balance != null) recordBalanceSample(v.balance, v.currency);
      finish(v.ok ? v.balance : null);
    });
  } else finish(null);
}
// 窗内花费 = 相邻采样点的余额下降量之和（只计下降：充值/退款不冲抵费用）
function fallbackWindowCost(msWindow, now = Date.now()) {
  const since = now - msWindow;
  const pts = state.fallbackState.samples.filter((p) => new Date(p.ts).getTime() >= since && p.balance != null);
  let cost = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i - 1].balance - pts[i].balance;
    if (d > 0) cost += d;
  }
  return Math.round(cost * 10000) / 10000;
}
function fallbackWindowCount(msWindow, now = Date.now()) {
  const since = now - msWindow;
  return state.fallbackState.costs.filter((c) => new Date(c.ts).getTime() >= since).length;
}
function attemptFallback(rawBody, clientHeaders, withUsage) {
  return new Promise((resolve) => {
    const f = fallbackConfig();
    let payload; try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return resolve({ stream: false, status: 400, body: "invalid JSON" }); }
    const body = JSON.stringify(buildFallbackBody(payload, withUsage));
    const up = fallbackUpstream();
    const headers = {
      Authorization: "Bearer " + f.apiKey, "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body), "User-Agent": OUT_UA,
      Accept: clientHeaders.accept || "text/event-stream",
    };
    if (clientHeaders["x-request-id"]) headers["x-request-id"] = clientHeaders["x-request-id"];
    const req = up.lib.request({ hostname: up.hostname, port: up.port, path: up.path, method: "POST", headers, timeout: 300000 }, (r) => {
      if (r.statusCode >= 200 && r.statusCode < 300) return resolve({ stream: true, res: r });
      let b = ""; r.on("data", (c) => (b += c));
      r.on("end", () => resolve({ stream: false, status: r.statusCode, body: b }));
    });
    req.on("error", (e) => resolve({ stream: false, status: 502, body: JSON.stringify({ error: { message: e.message } }) }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}
// 兜底主入口：guard（启用+key+无可用 key）→ 转发（注入 include_usage；400 降级重试一次去掉注入）
async function tryFallback(res, rawBody, clientHeaders, sessionId, model, started) {
  const f = fallbackConfig();
  if (!(fallbackReady() && noUsableKey())) return false;
  let out = await attemptFallback(rawBody, clientHeaders, true);
  if (!out.stream && out.status === 400) out = await attemptFallback(rawBody, clientHeaders, false);
  if (!out.stream) {
    addEvent("fallback:fail", null, `HTTP ${out.status} via ${f.label || "fallback"}`);
    return false;
  }
  markFallbackStart();
  state.fallbackState.lastFallbackAt = new Date().toISOString();
  addEvent("fallback", null, `Go 无可用 key → ${f.label || "fallback"} ${f.model}`);
  const recUsage = (usage) => {
    const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) != null
      ? usage.prompt_tokens_details.cached_tokens
      : (usage.prompt_cache_hit_tokens || 0);
    state.fallbackState.costs.unshift({
      ts: new Date().toISOString(), model: f.model,
      promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0,
      cacheHit: cached,
      cacheMiss: usage.prompt_cache_miss_tokens != null ? usage.prompt_cache_miss_tokens : Math.max(0, (usage.prompt_tokens || 0) - cached),
      reasoningTokens: (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0,
    });
    if (state.fallbackState.costs.length > 2000) state.fallbackState.costs.length = 2000;
    saveState();
  };
  const pseudoKey = { id: "fallback", label: f.label, stats: { requests: 0, cachedTokens: 0, cacheHits: 0 } };
  streamThrough(res, out.res, pseudoKey, sessionId, model, started, recUsage);
  saveState();
  return true;
}

// ---------------- 中转站优先通道（docs/plans/opencode-go-relay-priority-2026-08-25.md） ----------------
// 定位：按模型优先路由的通用 OpenAI 上游（每站常单模型、按额度计费）。三层级联 = 中转站(优先) -> Go 池(默认) -> 备用通道(兜底)。
// Go 池与备用通道代码逐行不动；本层只在 forwardChat 最前面按模型匹配，失败分类隔离（仅手动探活复活）。
const DEFAULT_DOWNGRADE_MODEL = "deepseek-v4-flash"; // goModel 不在 Go 列表时的降级改写默认（实测在 30 模型列表中）
const RELAY_QUOTA_RE = /insufficient_quota|quota|余额不足|额度不足|insufficient balance|欠费/i;
const RELAY_FAIL_STREAK_LIMIT = 5;      // 连续失败兜底隔离阈值（任何一次成功清零）
const INUSE_WINDOW_MS = 10 * 60 * 1000; // 「使用中」判定窗口：近 10 分钟有流量
const relayConfig = () => state.config.relay || {};
const relayEnabled = () => relayConfig().enabled !== false;
const relayHeaderTimeout = () => Number(relayConfig().headerTimeoutMs) || 30000;

// Go 模型列表缓存：启动 + 每次 runPoll 刷新（公开无鉴权）；失败沿用上次；空缓存时 goModelsHas 视为「在列」保守不改写
function fetchGoModels() {
  return new Promise((resolve) => {
    const opts = {
      hostname: UPSTREAM_HOST, port: 443, path: UPSTREAM_BASE + "/models", method: "GET",
      headers: { Accept: "application/json", "User-Agent": OUT_UA }, timeout: 20000,
    };
    const req = https.request(opts, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => {
        if (res.statusCode === 200) { try { resolve({ ok: true, ids: JSON.parse(b).data.map((m) => m.id) }); } catch { resolve({ ok: false }); } }
        else resolve({ ok: false });
      });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}
async function refreshGoModels() {
  if (MOCK) return;
  if (state.goModels.fetchedAt && Date.now() - new Date(state.goModels.fetchedAt).getTime() < 60 * 1000) return; // 60s 节流
  const v = await fetchGoModels();
  if (v.ok) { state.goModels.list = v.ids; state.goModels.fetchedAt = new Date().toISOString(); saveState(); }
}
function goModelsHas(model) {
  if (!model) return true;
  return !state.goModels.list.length || state.goModels.list.includes(model);
}

function redactRelay(r) {
  const { apiKey, ...rest } = r;
  return { ...rest, apiKey: apiKey ? "(set)" : null };
}
function isolateRelay(relay, reason, detail) {
  if (relay.status !== "quarantined") {
    relay.status = "quarantined";
    relay.quarantinedAt = new Date().toISOString();
    relay.quarantineReason = reason;
    relay.lastError = detail;
    addEvent("relay-isolate", relay.id, "reason=" + reason + " (" + detail + ")");
  }
}
function activateRelay(relay) {
  if (relay.status !== "active") {
    relay.status = "active";
    relay.quarantinedAt = null;
    relay.quarantineReason = null;
    relay.lastError = null;
    addEvent("relay-recover", relay.id, "back to active (manual probe ok)");
  }
}
// 优先级挤位：把 relay 放到 target，原 target 及之后的其它站依次 +1（编号保持连续、全局唯一）
function setRelayPriority(relay, target) {
  const busy = state.relays.some((r) => r.id !== relay.id && r.priority === target);
  if (busy) for (const r of state.relays) if (r.id !== relay.id && r.priority >= target) r.priority += 1;
  relay.priority = target;
  addEvent("relay-edit", relay.id, "priority -> " + target);
}
// 匹配：enabled 且 active 且 (goModel||model)===请求模型，按 priority 升序（同模型完全按序试完再进 Go，用户定稿）
function matchRelays(model) {
  if (!relayEnabled()) return [];
  return state.relays
    .filter((r) => r.enabled !== false && r.status === "active" && (r.goModel || r.model) === model)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.id.localeCompare(b.id));
}
// 失败分类（方案 §3.2）：401 立即隔离 auth；402 或 429|403+关键词 立即隔离 quota；其余 failStreak+1，≥5 隔离 streak
function classifyRelayError(relay, out) {
  const status = out.status;
  const body = String(out.body || "");
  if (status === 401) return isolateRelay(relay, "auth_invalid", "401 (key invalid)");
  if (status === 402 || ((status === 429 || status === 403) && RELAY_QUOTA_RE.test(body))) return isolateRelay(relay, "quota", "HTTP " + status + " quota exhausted");
  relay.failStreak = (relay.failStreak || 0) + 1;
  if (relay.failStreak >= RELAY_FAIL_STREAK_LIMIT) isolateRelay(relay, "streak", "HTTP " + status + " x" + relay.failStreak);
}
function relayUpstream(baseURL) {
  let u; try { u = new URL(baseURL); } catch { return null; }
  return {
    lib: u.protocol === "http:" ? http : https,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443,
    path: u.pathname.replace(/\/+$/, "") + "/chat/completions",
    base: u.pathname.replace(/\/+$/, ""),
  };
}
// 请求体：model 改写为中转站侧名；OpenAI 标准字段白名单（同备用通道）；不注入 reasoning_effort（客户端值经白名单透传）
function buildRelayBody(payload, withUsage, relay) {
  const body = { model: relay.model, messages: payload.messages };
  for (const k of FALLBACK_BODY_FIELDS) if (payload[k] !== undefined) body[k] = payload[k];
  if (withUsage && body.stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  return body;
}
// 前置尝试：响应头超时 = config.relay.headerTimeoutMs（默认 30s）快失败，流式阶段沿用 300s
function attemptRelay(relay, rawBody, clientHeaders, withUsage) {
  return new Promise((resolve) => {
    let payload; try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return resolve({ stream: false, status: 400, body: "invalid JSON" }); }
    const body = JSON.stringify(buildRelayBody(payload, withUsage, relay));
    const up = relayUpstream(relay.baseURL);
    if (!up) return resolve({ stream: false, status: 502, body: JSON.stringify({ error: { message: "bad baseURL" } }) });
    const headers = {
      Authorization: "Bearer " + relay.apiKey, "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body), "User-Agent": OUT_UA,
      Accept: clientHeaders.accept || "text/event-stream",
    };
    if (clientHeaders["x-request-id"]) headers["x-request-id"] = clientHeaders["x-request-id"];
    const req = up.lib.request({ hostname: up.hostname, port: up.port, path: up.path, method: "POST", headers, timeout: 300000 }, (r) => {
      clearTimeout(headerTimer);
      try { req.setTimeout(300000); } catch {}
      if (r.statusCode >= 200 && r.statusCode < 300) return resolve({ stream: true, res: r });
      let b = ""; r.on("data", (c) => (b += c));
      r.on("end", () => resolve({ stream: false, status: r.statusCode, body: b }));
    });
    const headerTimer = setTimeout(() => req.destroy(new Error("header timeout")), relayHeaderTimeout());
    req.on("error", (e) => resolve({ stream: false, status: 502, body: JSON.stringify({ error: { message: e.message } }) }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}
const relayUsageRecorder = (relay) => (u) => {
  relay.stats.totalTokens = (relay.stats.totalTokens || 0) + (u.prompt_tokens || 0) + (u.completion_tokens || 0);
  saveState();
};
// 优先层主入口：返回 { handled:true } = 已由中转站处理；否则 { body } = 降级模型改写后的转发体（未改写则不设）
async function tryRelayPriority(res, upBody, clientHeaders, sessionId, model, started) {
  const candidates = matchRelays(model);
  if (!candidates.length) return {};
  for (const relay of candidates) {
    if (relay.status !== "active") continue; // 循环中刚被隔离的不再试
    inflightInc(relay.id);
    let out = await attemptRelay(relay, upBody, clientHeaders, true);
    if (!out.stream && out.status === 400) out = await attemptRelay(relay, upBody, clientHeaders, false); // include_usage 降级重试（沿备用通道先例）
    if (out.stream) {
      relay.failStreak = 0;
      relay.lastReqAt = new Date().toISOString();
      const pseudo = { id: relay.id, label: relay.label, stats: relay.stats };
      streamThrough(res, out.res, pseudo, sessionId, model, started, relayUsageRecorder(relay)); // finishRequest 负责 inflightDec
      saveState();
      return { handled: true };
    }
    inflightDec(relay.id);
    classifyRelayError(relay, out);
    addEvent("relay-fail", relay.id, "HTTP " + out.status + " streak=" + relay.failStreak + (relay.status !== "active" ? " isolated(" + relay.quarantineReason + ")" : ""));
  }
  saveState();
  // 全部失败 -> 降级模型改写：首个命中站的 goModel 不在 Go 列表时，改写为该站 downgradeModel（默认 deepseek-v4-flash）
  const c0 = candidates[0];
  const goModel = c0.goModel || c0.model;
  const down = c0.downgradeModel || DEFAULT_DOWNGRADE_MODEL;
  if (goModel && down && !goModelsHas(goModel)) {
    let payload; try { payload = JSON.parse(upBody.toString("utf8")); } catch { return {}; }
    payload.model = down;
    return { handled: false, body: Buffer.from(JSON.stringify(payload)) };
  }
  return {};
}

// GET /v1/models 透传：ZCode 启动时探测模型/思考能力，必须 200 而非 404（公开无鉴权端点）
function forwardModels(res) {
  const up = https.request({
    hostname: UPSTREAM_HOST, port: 443, path: UPSTREAM_BASE + "/models", method: "GET",
    headers: { Accept: "application/json", "User-Agent": OUT_UA },
  }, (upRes) => {
    res.writeHead(upRes.statusCode, { "Content-Type": upRes.headers["content-type"] || "application/json" });
    upRes.pipe(res);
  });
  up.on("error", (e) => jsonError(res, 502, "upstream models fetch failed: " + e.message));
  up.end();
}

// 总 token 统计：请求注入 include_usage 后，由 streamThrough 的 onUsage 捕获并累计到 key.stats.totalTokens
function keyUsageRecorder(key) {
  return (u) => {
    key.stats.totalTokens = (key.stats.totalTokens || 0) + (u.prompt_tokens || 0) + (u.completion_tokens || 0);
    saveState();
  };
}

function forwardChat(req, res) {
  const sessionId = req.headers["x-session-id"] || null;
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks);
    let payload = null;
    try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return jsonError(res, 400, "invalid JSON body"); }
    const model = payload.model || "unknown";
    const started = Date.now();
    // 流式请求注入 include_usage（与备用通道同机制）：上游在流末回 usage 块 → 总 token 可统计；上游不回则计 0 无副作用
    let upBody = rawBody;
    if (payload && payload.stream === true && !(payload.stream_options && payload.stream_options.include_usage)) {
      payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };
      try { upBody = Buffer.from(JSON.stringify(payload)); } catch { upBody = rawBody; }
    }
    // 中转站优先层（三层级联第 1 层）：按模型匹配的中转站完全按序试完，才进 Go 池（方案 relay-priority §3.2）
    const relayed = await tryRelayPriority(res, upBody, { accept: req.headers.accept, "x-request-id": req.headers["x-request-id"] }, sessionId, model, started);
    if (relayed.handled) return;
    if (relayed.body) upBody = relayed.body; // 降级模型改写后的转发体（goModel 不在 Go 列表 -> downgradeModel）
    const key = getOrBindKey(sessionId);
    if (!key) {
      // 无可用 Key：先试备用通道（通用 OpenAI 上游，三窗口语义触发），不行再按 L4 如实回 429 + 最近恢复时间
      addEvent("exhausted", null, "no active key available");
      if (await tryFallback(res, rawBody, { accept: req.headers.accept, "x-request-id": req.headers["x-request-id"] }, sessionId, model, started)) return;
      const rec = earliestRecovery();
      addEvent("exhausted", null, "fallback unavailable, honest 429" + (rec ? " recover at " + rec : ""));
      const msg = "All Go keys exhausted. " + (rec ? "Earliest recovery at " + rec : "Check gateway dashboard for key states.");
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: msg }, metadata: rec ? { resetsAt: rec } : {} }));
    }
    inflightInc(key.id);
    const out = await attemptForward(key, upBody, { accept: req.headers.accept, "x-request-id": req.headers["x-request-id"] });
    if (out.stream) {
      if (state.fallbackState.sessionStart) markFallbackEnd("go-recovered"); // 备用中恢复 → 立刻切回 Go（用户宪法）
      streamThrough(res, out.res, key, sessionId, model, started, keyUsageRecorder(key));
    } else {
      // 首字节前失败 -> 统一兜底：瞬时重试 → 有界 failover → 耗尽如实回错（BUG-002/005/006）
      await failoverChain(res, key, out, upBody, { accept: req.headers.accept, "x-request-id": req.headers["x-request-id"] }, sessionId, model, started);
    }
  });
}

// ---------------- 控制面 API ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function jsonError(res, code, msg) { json(res, code, { error: { type: "GatewayError", message: msg } }); }

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { resolve(null); }
    });
  });
}

function summarize() {
  const counts = { active: 0, cooldown: 0, quarantined: 0, invalid: 0 };
  for (const k of state.keys) {
    if (k.status === "active") counts.active++;
    else if (k.status.startsWith("cooldown")) counts.cooldown++;
    else if (k.status === "quarantined") counts.quarantined++;
    else if (k.status === "invalid") counts.invalid++;
  }
  const relayActive = state.relays.filter((r) => r.enabled !== false && r.status === "active").length;
  const totalRequests = state.keys.reduce((a, k) => a + (k.stats ? k.stats.requests : 0), 0);
  const totalCached = state.keys.reduce((a, k) => a + (k.stats ? k.stats.cachedTokens : 0), 0);
  // 总 token = Go 池各 key 累计 + 备用通道各请求（注入 include_usage 后由流末 usage 块统计）
  const totalTokens = state.keys.reduce((a, k) => a + (k.stats && k.stats.totalTokens ? k.stats.totalTokens : 0), 0)
    + state.fallbackState.costs.reduce((a, c) => a + ((c.promptTokens || 0) + (c.completionTokens || 0)), 0);
  return { version: VERSION, mode: MOCK ? "mock" : "real", uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), counts, relayActive, totalRequests, totalTokens, totalCachedTokens: totalCached, stateUpdatedAt: state.updatedAt };
}

function keyInUse(k) {
  if ((inflight.get(k.id) || 0) > 0) return true;
  const now = Date.now();
  return state.sessions.some((s) => s.keyId === k.id && s.lastActive && now - new Date(s.lastActive).getTime() < INUSE_WINDOW_MS);
}

function apiKeyList() {
  return state.keys.map((k) => ({ ...redactKey(k), inUse: keyInUse(k) }));
}

function samePoolWarnings() {
  const byWs = {};
  for (const k of state.keys) if (k.workspaceId) (byWs[k.workspaceId] = byWs[k.workspaceId] || []).push(k.id);
  return Object.entries(byWs).filter(([, ids]) => ids.length > 1).map(([ws, ids]) => ({ workspaceId: ws, keyIds: ids }));
}

// 控制面回显配置：localToken 与 fallback.apiKey 一律掩码（密钥永不回传前端）
function maskedConfig() {
  const f = state.config.fallback || {};
  return { ...state.config, localToken: state.config.localToken ? "(set)" : null, fallback: { ...f, apiKey: f.apiKey ? "(set)" : null } };
}

// Agent 对接指引：运行时生成（注入本机安装目录与端口），不含任何硬编码个人信息。
// 用户把这段委派提示词发给自己的 AI 助手，助手读源码与文档后完成客户端接入与跟随启动评估。
function agentGuidePrompt() {
  const url = `http://127.0.0.1:${PORT}`;
  const dir = __dirname;
  return [
    `你是我的配置助手。本机正在通过管理界面 ${url} 使用 OpenCode Go 多 Key 网关，OpenAI 兼容端点 ${url}/v1（chat/completions、models）。`,
    `请把我的编程助手（ZCode / Claude Code / 其他 OpenAI 兼容客户端）接入该网关：`,
    `1. 读以下材料理解本项目的运行方式：开源仓库 GitHub https://github.com/Duanzhoutao/opencode-go-router（备用镜像 GitCode https://gitcode.com/zhoutao-2026/opencode-go-router）的 README 与 docs/（入口 docs/README.md：client-integration.md 客户端接入、guard.md 跟随启动钩子、architecture.md 多 Key 路由与缓存粘性、configuration.md 配置、faq.md 排错）；本机源码 ${dir}（README.md、docs/、go-gateway.cjs、go-guard.cjs）。`,
    `2. 把我客户端的模型 baseURL 改为 ${url}/v1，apiKey 用占位符（如 sk-local-gateway）；改前先备份配置文件，保留原 provider（设为 disabled）作逃生门。`,
    `3. 评估我的客户端能否同时启用跟随启动（如 SessionStart 钩子机制）：能则一并配置并验证，不能则说明原因，不硬做。`,
    `边界：只动模型接入相关配置；动手前把你的完整执行计划（改哪些文件与内容、配置位置的判断依据、是否启用跟随启动、备份与回退方式）一次列清给我确认——只问这一次，确认后连续执行到完成，中途不再逐步征求；事实先检测再下结论，不猜。`,
    `完成后汇报：改了哪些文件、如何回退、验证结果（经网关发一条测试请求）。`,
  ].join("\n");
}

// ---------------- 备用通道：视图 / 立刻计算 / 配置 / 测试连接 ----------------
function fallbackView() {
  const f = fallbackConfig();
  const s = state.fallbackState;
  const lastSample = s.samples.length ? s.samples[s.samples.length - 1] : null;
  const H = 3600e3;
  const win = (h) => ({ cost: fallbackWindowCost(h * H), count: fallbackWindowCount(h * H) });
  const currentSpent = s.sessionStart && s.sessionStart.balance != null && lastSample && lastSample.balance != null
    ? Math.round((s.sessionStart.balance - lastSample.balance) * 10000) / 10000 : null;
  return {
    config: { ...f, apiKey: f.apiKey ? "(set)" : null },
    effectiveBaseURL: (f.baseURL || "").trim() || FALLBACK_DEFAULT_BASE,
    active: !!s.sessionStart,
    sessionStart: s.sessionStart,
    lastFallbackAt: s.lastFallbackAt,
    lastSample, currentSpent,
    windows: { h24: win(24), d7: win(24 * 7), d14: win(24 * 14), d30: win(24 * 30) },
    settlements: s.settlements.slice(0, 10),
    recentCosts: s.costs.slice(0, 20),
  };
}

function handleFallbackView(req, res) { return json(res, 200, fallbackView()); }

// 「立刻计算」：立即采样一次余额（用户手动刷新，不加定时器）
async function handleFallbackRefresh(req, res) {
  const f = fallbackConfig();
  if (!(f.enabled && f.apiKey)) return jsonError(res, 400, "备用通道未启用或未配置 Key");
  if (f.billingMode === "none") return json(res, 200, { ok: true, note: "该通道不计费（billingMode=none）" });
  const v = await fetchFallbackBalance();
  if (!v.ok) return json(res, 502, { ok: false, msg: `balance check failed: ${v.code} ${v.msg || ""}` });
  recordBalanceSample(v.balance, v.currency);
  saveState();
  return json(res, 200, { ok: true, balance: v.balance, currency: v.currency, isAvailable: v.isAvailable });
}

async function handleFallbackPatch(req, res) {
  const body = await readBody(req);
  if (body == null) return jsonError(res, 400, "invalid body");
  const f = state.config.fallback;
  if (typeof body.enabled === "boolean") f.enabled = body.enabled;
  if (typeof body.label === "string") f.label = body.label.trim().slice(0, 40) || "备用通道";
  if (typeof body.baseURL === "string") {
    const u = body.baseURL.trim();
    if (u === "" || /^https?:\/\//.test(u)) f.baseURL = u;
    else return jsonError(res, 400, "baseURL 须以 http(s):// 开头或留空");
  }
  if (body.apiKey === "" || body.apiKey === null) f.apiKey = null;
  else if (typeof body.apiKey === "string" && body.apiKey.trim().length >= 8) f.apiKey = body.apiKey.trim();
  if (typeof body.model === "string" && body.model.trim()) f.model = body.model.trim().slice(0, 120);
  if (typeof body.reasoningEffort === "string") f.reasoningEffort = body.reasoningEffort.trim().slice(0, 40);
  if (body.billingMode === "balance" || body.billingMode === "none") f.billingMode = body.billingMode;
  addEvent("config", null, "fallback config updated (enabled=" + f.enabled + ", model=" + f.model + ")");
  saveState();
  return json(res, 200, { ok: true, fallback: { ...f, apiKey: f.apiKey ? "(set)" : null } });
}

// 最小连通性探测（chat 一次小请求 + balance 一次 GET），支持用 body 里的候选配置试（未保存也能测）
function fallbackProbeChat(baseURL, apiKey, model) {
  return new Promise((resolve) => {
    let u; try { u = new URL(baseURL); } catch { return resolve({ ok: false, status: "badURL" }); }
    const lib = u.protocol === "http:" ? http : https;
    const base = u.pathname.replace(/\/+$/, "");
    const body = JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: false });
    const req = lib.request({
      hostname: u.hostname, port: u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443,
      path: base + "/chat/completions", method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": OUT_UA, Accept: "application/json" },
      timeout: 30000,
    }, (r) => {
      let b = ""; r.on("data", (c) => (b += c));
      r.on("end", () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, body: b.slice(0, 300) }));
    });
    req.on("error", (e) => resolve({ ok: false, status: "err", msg: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}
async function handleFallbackTest(req, res) {
  const body = (await readBody(req)) || {};
  const f = fallbackConfig();
  const baseURL = (typeof body.baseURL === "string" ? body.baseURL : f.baseURL || "").trim() || FALLBACK_DEFAULT_BASE;
  const apiKey = (typeof body.apiKey === "string" && body.apiKey.trim().length >= 8) ? body.apiKey.trim() : f.apiKey;
  const model = (typeof body.model === "string" && body.model.trim()) ? body.model.trim() : f.model;
  if (!apiKey) return json(res, 200, { ok: false, msg: "未配置 API Key" });
  const chat = MOCK ? { ok: true, status: 200, body: "(mock)" } : await fallbackProbeChat(baseURL, apiKey, model);
  const bal = MOCK ? { ok: true, balance: 9.53, currency: "CNY", isAvailable: true } : await fetchFallbackBalance({ baseURL, apiKey });
  addEvent("fallback-test", null, `chat=${chat.ok ? "OK(" + chat.status + ")" : "FAIL(" + (chat.status || chat.msg) + ")"} billing=${bal.ok ? "支持" : "不支持"}`);
  return json(res, 200, {
    ok: true,
    chat,
    billing: bal.ok ? { supported: true, balance: bal.balance, currency: bal.currency, isAvailable: bal.isAvailable } : { supported: false },
  });
}

// ---------------- 中转站：列表 / 录入 / 编辑 / 删除 / 测试 / 复活 / 停用 / 重排 + 模型列表 ----------------
function relayInUse(r) {
  if ((inflight.get(r.id) || 0) > 0) return true;
  if (!r.lastReqAt) return false;
  return Date.now() - new Date(r.lastReqAt).getTime() < INUSE_WINDOW_MS;
}
function handleRelayList(req, res) {
  const list = state.relays.slice().sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.id.localeCompare(b.id));
  return json(res, 200, { relays: list.map((r) => ({ ...redactRelay(r), inUse: relayInUse(r), inflight: inflight.get(r.id) || 0 })) });
}
async function handleRelayEnroll(req, res) {
  const body = await readBody(req);
  if (body == null) return jsonError(res, 400, "invalid body");
  const baseURL = (body.baseURL || "").trim();
  const apiKey = (body.apiKey || "").trim();
  const model = (body.model || "").trim();
  if (!/^https?:\/\//.test(baseURL)) return jsonError(res, 400, "baseURL 须以 http(s):// 开头");
  if (apiKey.length < 8) return jsonError(res, 400, "apiKey 至少 8 字符");
  if (!model) return jsonError(res, 400, "model 必填");
  const label = (body.label || "").trim() || "中转站-" + (state.relays.length + 1);
  const relay = {
    id: "r" + (++state.seq), label, baseURL, apiKey, model,
    goModel: (body.goModel || "").trim() || model,
    downgradeModel: (body.downgradeModel || "").trim() || DEFAULT_DOWNGRADE_MODEL,
    priority: 0, enabled: body.enabled !== false,
    status: "active", quarantineReason: null, quarantinedAt: null,
    failStreak: 0, lastError: null, lastReqAt: null,
    stats: { requests: 0, totalTokens: 0, cachedTokens: 0, cacheHits: 0 },
  };
  state.relays.push(relay);
  const p = Number.isInteger(body.priority) && body.priority >= 1 ? body.priority : state.relays.reduce((a, r) => Math.max(a, r.priority || 0), 0) + 1;
  setRelayPriority(relay, p); // 挤位；新站默认 max+1（队尾）
  addEvent("relay-edit", relay.id, "created (priority=" + relay.priority + ")");
  saveState();
  return json(res, 201, { ok: true, relay: redactRelay(relay) });
}
async function handleRelayPatch(req, res, url) {
  const id = url.pathname.split("/")[3];
  const relay = state.relays.find((r) => r.id === id);
  if (!relay) return jsonError(res, 404, "relay not found");
  const body = await readBody(req);
  if (body == null) return jsonError(res, 400, "invalid body");
  if (typeof body.label === "string" && body.label.trim()) relay.label = body.label.trim();
  if (typeof body.baseURL === "string" && body.baseURL.trim()) {
    if (!/^https?:\/\//.test(body.baseURL.trim())) return jsonError(res, 400, "baseURL 须以 http(s):// 开头");
    relay.baseURL = body.baseURL.trim();
  }
  if (typeof body.apiKey === "string" && body.apiKey.trim().length >= 8) relay.apiKey = body.apiKey.trim();
  if (typeof body.model === "string" && body.model.trim()) relay.model = body.model.trim();
  if (typeof body.goModel === "string") relay.goModel = body.goModel.trim() || relay.model;
  if (typeof body.downgradeModel === "string") relay.downgradeModel = body.downgradeModel.trim() || DEFAULT_DOWNGRADE_MODEL;
  if (typeof body.enabled === "boolean") relay.enabled = body.enabled;
  if (Number.isInteger(body.priority) && body.priority >= 1) setRelayPriority(relay, body.priority);
  addEvent("relay-edit", relay.id, "updated");
  saveState();
  return json(res, 200, { ok: true, relay: redactRelay(relay) });
}
function handleRelayDelete(req, res, url) {
  const id = url.pathname.split("/")[3];
  const i = state.relays.findIndex((r) => r.id === id);
  if (i < 0) return jsonError(res, 404, "relay not found");
  const [removed] = state.relays.splice(i, 1);
  addEvent("relay-edit", id, "deleted: " + removed.label);
  saveState();
  return json(res, 200, { ok: true });
}
function handleRelayRenumber(req, res) {
  const sorted = state.relays.slice().sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.id.localeCompare(b.id));
  sorted.forEach((r, i) => { r.priority = i + 1; });
  addEvent("relay-edit", null, "renumbered 1.." + sorted.length);
  saveState();
  return json(res, 200, { ok: true, relays: sorted.map(redactRelay) });
}
// 探测中转站模型列表（半填半选候选源）；非 200 / 解析失败回 null = 该站不支持
function relayProbeModels(baseURL, apiKey) {
  let u; try { u = new URL(baseURL); } catch { return Promise.resolve(null); }
  const lib = u.protocol === "http:" ? http : https;
  const base = u.pathname.replace(/\/+$/, "");
  return new Promise((resolve) => {
    const req = lib.request({
      hostname: u.hostname, port: u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443,
      path: base + "/models", method: "GET",
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json", "User-Agent": OUT_UA }, timeout: 20000,
    }, (r) => {
      let b = ""; r.on("data", (c) => (b += c));
      r.on("end", () => {
        if (r.statusCode !== 200) return resolve(null);
        try { return resolve(JSON.parse(b).data.map((m) => m.id)); } catch { return resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}
// 未保存候选配置也能测（沿 handleFallbackTest 模式，无需已存在的中转站 id）
async function handleRelayTestCandidate(req, res) {
  const body = (await readBody(req)) || {};
  const baseURL = (body.baseURL || "").trim();
  const apiKey = (body.apiKey || "").trim();
  const model = (body.model || "").trim();
  if (!/^https?:\/\//.test(baseURL) || apiKey.length < 8 || !model) return json(res, 200, { ok: false, msg: "需填写 Base URL / API Key / 模型名再测试" });
  const chat = MOCK ? { ok: true, status: 200, body: "(mock)" } : await fallbackProbeChat(baseURL, apiKey, model);
  const models = MOCK ? ["glm-5.3", "deepseek-v4-flash"] : await relayProbeModels(baseURL, apiKey);
  addEvent("relay-test", null, "candidate chat=" + (chat.ok ? "OK(" + chat.status + ")" : "FAIL(" + (chat.status || chat.msg) + ")"));
  return json(res, 200, { ok: true, chat, models });
}
async function handleRelayTest(req, res, url) {
  const id = url.pathname.split("/")[3];
  const relay = state.relays.find((r) => r.id === id);
  if (!relay) return jsonError(res, 404, "relay not found");
  const body = (await readBody(req)) || {};
  const baseURL = (typeof body.baseURL === "string" && body.baseURL.trim()) ? body.baseURL.trim() : relay.baseURL;
  const apiKey = (typeof body.apiKey === "string" && body.apiKey.trim().length >= 8) ? body.apiKey.trim() : relay.apiKey;
  const model = (typeof body.model === "string" && body.model.trim()) ? body.model.trim() : relay.model;
  if (!apiKey) return json(res, 200, { ok: false, msg: "未配置 API Key" });
  const chat = MOCK ? { ok: true, status: 200, body: "(mock)" } : await fallbackProbeChat(baseURL, apiKey, model);
  const models = MOCK ? ["glm-5.3", "deepseek-v4-flash"] : await relayProbeModels(baseURL, apiKey);
  addEvent("relay-test", relay.id, "chat=" + (chat.ok ? "OK(" + chat.status + ")" : "FAIL(" + (chat.status || chat.msg) + ")") + " models=" + (models ? models.length + "" : "unsupported"));
  return json(res, 200, { ok: true, chat, models });
}
async function handleRelayActivate(req, res, url) {
  const id = url.pathname.split("/")[3];
  const relay = state.relays.find((r) => r.id === id);
  if (!relay) return jsonError(res, 404, "relay not found");
  if (MOCK) { activateRelay(relay); relay.failStreak = 0; saveState(); return json(res, 200, { ok: true, status: "active" }); }
  const chat = await fallbackProbeChat(relay.baseURL, relay.apiKey, relay.model);
  if (chat.ok) { relay.failStreak = 0; activateRelay(relay); saveState(); return json(res, 200, { ok: true, status: "active" }); }
  relay.lastError = "probe failed HTTP " + (chat.status || chat.msg);
  saveState();
  return json(res, 200, { ok: false, status: "quarantined", msg: "探活失败（HTTP " + (chat.status || chat.msg) + "）— 保持隔离" });
}
function handleRelayQuarantine(req, res, url) {
  const id = url.pathname.split("/")[3];
  const relay = state.relays.find((r) => r.id === id);
  if (!relay) return jsonError(res, 404, "relay not found");
  isolateRelay(relay, "manual", "manual pause");
  saveState();
  return json(res, 200, { ok: true, status: relay.status });
}
function handleModels(req, res) {
  return json(res, 200, { models: state.goModels.list || [], fetchedAt: state.goModels.fetchedAt || null });
}

// ---------------- MOCK_MODE 合成剧本 ----------------
function mockUsage(rollingPct, weeklyPct, monthlyPct, rollingStatus, weeklyStatus, monthlyStatus, monthlyDays) {
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  return {
    rolling: { status: rollingStatus || "ok", percent: rollingPct, resetsAt: iso(5 * 3600e3) },
    weekly: { status: weeklyStatus || "ok", percent: weeklyPct, resetsAt: iso(3 * 24 * 3600e3) },
    monthly: { status: monthlyStatus || "ok", percent: monthlyPct, resetsAt: iso((monthlyDays || 28) * 24 * 3600e3) },
  };
}

function ensureMockData() {
  if (!MOCK) return;
  if (state.keys.length && state.relays.length) return;
  if (!state.keys.length) {
  const base = "sk-mock-";
  const mk = (label, status, ws, u, reason, stats) => ({
    id: "k" + (++state.seq), label, key: base + label.toLowerCase().replace(/\W+/g, ""), status, workspaceId: ws,
    quota: u, quarantinedAt: status === "quarantined" ? new Date().toISOString() : null,
    quarantineReason: reason || null, stats: stats || { requests: 0, cachedTokens: 0, cacheHits: 0 },
  });
  // 月窗到期错开演示双策略：主力 9 天后到期（最近）-> 会话流量到期优先选它；
  // 备用 5h 余量最大 -> 无会话流量最轻松优先选它
  state.keys.push(
    mk("主力", "active", "wrk_AAA111", mockUsage(35, 40, 50, null, null, null, 9), null, { requests: 86, cachedTokens: 4100, cacheHits: 9 }),
    mk("备用", "active", "wrk_BBB222", mockUsage(12, 8, 22, null, null, null, 26), null, { requests: 34, cachedTokens: 900, cacheHits: 4 }),
    mk("周限冷却", "cooldown_weekly", "wrk_CCC333", mockUsage(0, 100, 55, "ok", "rate-limited", null, 15), null, { requests: 120, cachedTokens: 0, cacheHits: 0 }),
    mk("5h 冷却", "cooldown_rolling", "wrk_DDD444", mockUsage(100, 70, 60, "rate-limited", null, null, 21), null, { requests: 15, cachedTokens: 0, cacheHits: 0 }),
    mk("月限隔离", "quarantined", "wrk_EEE555", mockUsage(0, 0, 100, "ok", "ok", "rate-limited", 28), "monthly", { requests: 200, cachedTokens: 0, cacheHits: 0 }),
    mk("失效", "invalid", null, mockUsage(0, 0, 0), "auth_invalid", { requests: 0, cachedTokens: 0, cacheHits: 0 })
  );
  state.sessions.push(
    { sessionId: "sess_mock-ab12cd34", keyId: state.keys[0].id, requests: 86, lastActive: new Date().toISOString(), model: "deepseek-v4-flash" },
    { sessionId: "sess_mock-ef56gh78", keyId: state.keys[1].id, requests: 34, lastActive: new Date().toISOString(), model: "deepseek-v4-flash" }
  );
  const ev = (type, keyId, detail, minAgo) => ({ ts: new Date(Date.now() - minAgo * 60e3).toISOString(), type, keyId, detail });
  state.events.push(
    ev("bind", "k1", "session sess_mock-ab12… -> key", 120), ev("rate-limited", "k3", "429 weekly ws=wrk_CCC333", 300),
    ev("cooldown", "k3", "entered cooldown_weekly (weekly)", 300), ev("quarantine", "k5", "reason=monthly", 60 * 26),
    ev("recover", "k2", "back to active (window ok)", 60 * 30), ev("failover", "k1", "HTTP 429 -> key k2", 240)
  );
  }
  if (!state.relays.length) {
    const rmk = (id, label, model, goModel, priority, status, reason, streak, requests) => ({
      id, label, baseURL: "https://example.com/v1", apiKey: "sk-mock-" + id, model, goModel,
      downgradeModel: "deepseek-v4-flash", priority, enabled: true, status,
      quarantineReason: reason, quarantinedAt: status === "quarantined" ? new Date(Date.now() - 3600e3).toISOString() : null,
      failStreak: streak, lastError: reason === "quota" ? "HTTP 429 quota exhausted" : null,
      lastReqAt: status === "active" ? new Date(Date.now() - 60e3).toISOString() : null,
      stats: { requests, totalTokens: requests * 1500, cachedTokens: 0, cacheHits: 0 },
    });
    state.relays.push(
      rmk("r1", "中转站-A", "glm-5.3", "glm-5.3", 1, "active", null, 0, 42),
      rmk("r2", "中转站-B（额度耗尽）", "deepseek-v4-flash", "deepseek-v4-flash", 2, "quarantined", "quota", 0, 200),
      rmk("r3", "中转站-C（连败 2/5）", "deepseek-v4-pro", "deepseek-v4-pro", 3, "active", null, 2, 9)
    );
  }
  if (!state.goModels.list.length) state.goModels.list = ["glm-5.3", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro", "kimi-k3", "qwen3.8-max"]; // MOCK 半填半选演示候选
  saveState();
}

// ---------------- 路由分发 ----------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);
  const p = url.pathname;

  // 转发面
  if (req.method === "POST" && p === "/v1/chat/completions") {
    if (MOCK) return mockChat(req, res);
    if (state.config.localToken && req.headers.authorization !== "Bearer " + state.config.localToken) {
      return jsonError(res, 401, "invalid local token");
    }
    return forwardChat(req, res);
  }
  if (req.method === "GET" && p === "/v1/models") {
    if (MOCK) return mockModels(res);
    if (state.config.localToken && req.headers.authorization !== "Bearer " + state.config.localToken) {
      return jsonError(res, 401, "invalid local token");
    }
    return forwardModels(res);
  }

  // 控制面鉴权（/health 除外）
  const isApi = p.startsWith("/api/");
  if (isApi && state.config.localToken && req.headers.authorization !== "Bearer " + state.config.localToken) {
    return jsonError(res, 401, "invalid local token");
  }

  // 探活
  if (p === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, version: VERSION, mode: MOCK ? "mock" : "real", ts: new Date().toISOString() }));
  }

  // 静态前端
  if (req.method === "GET" && (p === "/" || p === "/index.html" || p === "/app.js" || p === "/style.css" || p === "/favicon.svg")) {
    return serveStatic(req, res, p);
  }

  // 控制面 API
  if (req.method === "GET" && p === "/api/status") return json(res, 200, { ...summarize(), warnings: samePoolWarnings() });
  if (req.method === "GET" && p === "/api/guide") return json(res, 200, { prompt: agentGuidePrompt() });
  if (req.method === "GET" && p === "/api/keys") return json(res, 200, { keys: apiKeyList(), warnings: samePoolWarnings() });
  if (req.method === "GET" && p === "/api/sessions") return json(res, 200, { sessions: state.sessions });
  if (req.method === "GET" && p === "/api/events") {
    const type = url.searchParams.get("type");
    const keyId = url.searchParams.get("key");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
    let list = state.events;
    if (type) list = list.filter((e) => e.type === type);
    if (keyId) list = list.filter((e) => e.keyId === keyId);
    return json(res, 200, { events: list.slice(0, limit) });
  }
  if (req.method === "GET" && p === "/api/config") return json(res, 200, { config: maskedConfig() });
  if (req.method === "GET" && p === "/api/fallback") return handleFallbackView(req, res);
  if (req.method === "POST" && p === "/api/fallback/refresh") return handleFallbackRefresh(req, res);
  if (req.method === "POST" && p === "/api/fallback/test") return handleFallbackTest(req, res);
  if (req.method === "PATCH" && p === "/api/fallback") return handleFallbackPatch(req, res);

  if (req.method === "GET" && p === "/api/relays") return handleRelayList(req, res);
  if (req.method === "POST" && p === "/api/relays") return handleRelayEnroll(req, res);
  if (req.method === "POST" && p === "/api/relays/renumber") return handleRelayRenumber(req, res);
  if (req.method === "POST" && p === "/api/relays/test") return handleRelayTestCandidate(req, res);
  if (req.method === "POST" && p.startsWith("/api/relays/") && p.endsWith("/test")) return handleRelayTest(req, res, url);
  if (req.method === "POST" && p.startsWith("/api/relays/") && p.endsWith("/activate")) return handleRelayActivate(req, res, url);
  if (req.method === "POST" && p.startsWith("/api/relays/") && p.endsWith("/quarantine")) return handleRelayQuarantine(req, res, url);
  if (req.method === "PATCH" && p.startsWith("/api/relays/")) return handleRelayPatch(req, res, url);
  if (req.method === "DELETE" && p.startsWith("/api/relays/")) return handleRelayDelete(req, res, url);
  if (req.method === "GET" && p === "/api/models") return handleModels(req, res);

  if (req.method === "POST" && p === "/api/keys") return handleEnroll(req, res);
  if (req.method === "POST" && p === "/api/keys/refresh-all") return handleRefreshAll(req, res);
  if (req.method === "PATCH" && p.startsWith("/api/keys/")) return handlePatchKey(req, res, url);
  if (req.method === "DELETE" && p.startsWith("/api/keys/")) return handleDeleteKey(req, res, url);
  if (req.method === "POST" && p.startsWith("/api/keys/") && p.endsWith("/refresh")) return handleRefresh(req, res, url);
  if (req.method === "POST" && p.startsWith("/api/keys/") && p.endsWith("/reactivate-all")) return handleReactivateAll(req, res);
  if (req.method === "POST" && p.startsWith("/api/keys/") && p.endsWith("/reactivate")) return handleReactivate(req, res, url);
  if (req.method === "POST" && p.startsWith("/api/keys/") && p.endsWith("/quarantine")) return handleQuarantine(req, res, url);

  if (req.method === "PATCH" && p === "/api/config") return handlePatchConfig(req, res);
  if (req.method === "POST" && p === "/api/events/clear") { state.events = []; saveState(); return json(res, 200, { ok: true }); }

  jsonError(res, 404, "not found: " + p);
});

function serveStatic(req, res, p) {
  const file = p === "/" || p === "/index.html" ? "index.html" : p.slice(1);
  const full = path.join(UI_DIR, file);
  if (!full.startsWith(UI_DIR) || !fs.existsSync(full)) return jsonError(res, 404, "static not found");
  const ext = path.extname(file);
  const ct = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store" });
  res.end(fs.readFileSync(full));
}

// 录入：真实模式先 /usage 校验（401 拒绝 / 200 回填三窗口）
async function handleEnroll(req, res) {
  const body = await readBody(req);
  if (!body || typeof body.key !== "string" || !body.key.trim()) return jsonError(res, 400, "key required");
  const label = (body.label || "").trim() || "Key-" + (state.keys.length + 1);
  if (MOCK) {
    const key = { id: "k" + (++state.seq), label, key: body.key.trim(), status: "active", workspaceId: "wrk_MOCK" + state.seq, quota: mockUsage(10, 15, 30), quarantinedAt: null, quarantineReason: null, stats: { requests: 0, cachedTokens: 0, cacheHits: 0 } };
    state.keys.push(key);
    addEvent("enroll", key.id, "mock usage ok -> active");
    saveState();
    return json(res, 201, { ok: true, key: redactKey(key) });
  }
  const v = await fetchUsage(body.key.trim());
  if (v.ok) {
    const key = { id: "k" + (++state.seq), label, key: body.key.trim(), status: "active", workspaceId: null, quota: toQuota(v.usage), quarantinedAt: null, quarantineReason: null, stats: { requests: 0, cachedTokens: 0, cacheHits: 0 } };
    state.keys.push(key);
    addEvent("enroll", key.id, "usage ok -> active");
    saveState();
    return json(res, 201, { ok: true, key: redactKey(key) });
  }
  if (v.code === 401) { addEvent("invalid", null, "enroll rejected (401)"); return json(res, 400, { ok: false, code: "invalid", msg: "invalid key (401 Unauthorized)" }); }
  return json(res, 502, { ok: false, code: "usage_failed", msg: `usage check failed: ${v.code} ${v.msg}` });
}

async function handlePatchKey(req, res, url) {
  const id = url.pathname.split("/")[3];
  const key = state.keys.find((k) => k.id === id);
  if (!key) return jsonError(res, 404, "key not found");
  const body = await readBody(req);
  if (body == null) return jsonError(res, 400, "invalid body");
  if (typeof body.label === "string" && body.label.trim()) { key.label = body.label.trim(); addEvent("edit", key.id, "label updated"); }
  if (typeof body.key === "string" && body.key.trim() && body.key.trim() !== key.key) {
    if (MOCK) { key.key = body.key.trim(); key.status = "active"; addEvent("edit", key.id, "key replaced (mock)"); }
    else {
      const v = await fetchUsage(body.key.trim());
      if (!v.ok) return json(v.code === 401 ? 400 : 502, { ok: false, code: v.code === 401 ? "invalid" : "usage_failed", msg: v.code === 401 ? "invalid key (401)" : `usage check failed: ${v.code}` });
      key.key = body.key.trim(); key.quota = toQuota(v.usage); key.status = "active"; key.quarantinedAt = null; key.quarantineReason = null;
      addEvent("edit", key.id, "key replaced + revalidated");
    }
  }
  saveState();
  return json(res, 200, { ok: true, key: redactKey(key) });
}

function handleDeleteKey(req, res, url) {
  const id = url.pathname.split("/")[3];
  const i = state.keys.findIndex((k) => k.id === id);
  if (i < 0) return jsonError(res, 404, "key not found");
  const [removed] = state.keys.splice(i, 1);
  state.sessions = state.sessions.filter((s) => s.keyId !== id);
  addEvent("delete", id, "key deleted: " + removed.label);
  saveState();
  return json(res, 200, { ok: true });
}

async function handleRefresh(req, res, url) {
  const id = url.pathname.split("/")[3];
  const key = state.keys.find((k) => k.id === id);
  if (!key) return jsonError(res, 404, "key not found");
  if (MOCK) { key.quota = mockUsage(Math.min(100, quotaPercent(key, "rolling") + 7), quotaPercent(key, "weekly"), quotaPercent(key, "monthly")); saveState(); return json(res, 200, { ok: true, key: redactKey(key) }); }
  const v = await fetchUsage(key.key);
  if (!v.ok) {
    if (v.code === 401) quarantine(key, "auth_invalid");
    return json(v.code === 401 ? 401 : 502, { ok: false, msg: `usage check failed: ${v.code}` });
  }
  key.quota = toQuota(v.usage);
  runStateMachine(key);
  saveState();
  return json(res, 200, { ok: true, key: redactKey(key) });
}

// 批量刷新：与后台轮询 runPoll 同语义（跳过隔离/失效），对每个可用 Key 重查 /usage 并跑状态机。
// 前端右上角「立即刷新」调它（BUG-009：旧实现只重拉缓存视图，从不触发上游重查）。
async function handleRefreshAll(req, res) {
  const refreshed = [];
  for (const key of state.keys) {
    if (key.status === "invalid" || key.status === "quarantined") continue;
    if (MOCK) {
      key.quota = mockUsage(Math.min(100, quotaPercent(key, "rolling") + 7), quotaPercent(key, "weekly"), quotaPercent(key, "monthly"));
      refreshed.push({ id: key.id, ok: true });
      continue;
    }
    const v = await fetchUsage(key.key);
    if (!v.ok) {
      if (v.code === 401) quarantine(key, "auth_invalid");
      refreshed.push({ id: key.id, ok: false, code: v.code === 401 ? 401 : "usage", msg: v.msg || String(v.code) });
      continue;
    }
    key.quota = toQuota(v.usage);
    runStateMachine(key);
    refreshed.push({ id: key.id, ok: true });
  }
  saveState();
  const okN = refreshed.filter((x) => x.ok).length;
  addEvent("refresh", null, `refresh-all: ok=${okN} failed=${refreshed.length - okN}`);
  return json(res, 200, { ok: true, refreshed });
}

async function handleReactivate(req, res, url) {
  const id = url.pathname.split("/")[3];
  const key = state.keys.find((k) => k.id === id);
  if (!key) return jsonError(res, 404, "key not found");
  if (MOCK) {
    if (key.quarantineReason === "auth_invalid") return json(res, 400, { ok: false, msg: "invalid key (401) — 已标失效，需删除重录" });
    key.status = "active"; key.quarantinedAt = null; key.quarantineReason = null; addEvent("reactivate", key.id, "mock reactivated");
    saveState(); return json(res, 200, { ok: true, status: "active" });
  }
  const v = await fetchUsage(key.key);
  if (v.ok) {
    const r = activateFromUsage(key, v.usage, "manual");
    if (r.ok) { saveState(); return json(res, 200, { ok: true, status: r.status }); }
    addEvent("reactivate", key.id, "monthly still rate-limited"); saveState();
    return json(res, 400, { ok: false, msg: "monthly 仍限额 — 需续订 Go 订阅（新月周期重置），充 Zen 余额不重置 $60 配额" });
  }
  if (v.code === 401) { key.status = "invalid"; key.quarantineReason = "auth_invalid"; addEvent("invalid", key.id, "reactivate check got 401"); saveState(); return json(res, 400, { ok: false, msg: "invalid key (401) — 已标失效" }); }
  return json(res, 502, { ok: false, msg: `usage check failed: ${v.code}` });
}

// 隔离区「一键查询」：手动点击 = 全部 Key 重查一次（用户要求「既然手动点了，就都查询一次」）。
// 作用域 = 除 invalid 外的所有 Key：active/cooldown 走常规刷新（quota + 状态机），
// quarantined 走恢复门禁（monthly ok 才回池），401 分别按各自语义处理。
async function handleReactivateAll(req, res) {
  const results = [];
  for (const key of state.keys) {
    if (key.status === "invalid") continue; // 失效 Key 不重查（401 死 Key，查了无意义）
    if (MOCK) {
      if (key.status === "quarantined") {
        const m = key.quota && key.quota.monthly;
        if (m && m.status === "ok") {
          key.status = "active"; key.quarantinedAt = null; key.quarantineReason = null;
          addEvent("recover", key.id, "back to active (manual, mock)");
          results.push({ id: key.id, ok: true, revived: true });
        } else {
          results.push({ id: key.id, ok: false, reason: m && m.status === "rate-limited" ? "monthly still rate-limited" : "cannot revive" });
        }
      } else {
        key.quota = mockUsage(Math.min(100, quotaPercent(key, "rolling") + 7), quotaPercent(key, "weekly"), quotaPercent(key, "monthly"));
        results.push({ id: key.id, ok: true });
      }
      continue;
    }
    const v = await fetchUsage(key.key);
    if (!v.ok) {
      if (v.code === 401) {
        if (key.status === "quarantined") {
          key.status = "invalid"; key.quarantineReason = "auth_invalid";
          addEvent("invalid", key.id, "reactivate-all check got 401");
          results.push({ id: key.id, ok: false, reason: "401 invalid" });
        } else {
          quarantine(key, "auth_invalid");
          results.push({ id: key.id, ok: false, reason: "401 invalid" });
        }
      } else {
        results.push({ id: key.id, ok: false, reason: `usage check failed: ${v.code}` });
      }
      continue;
    }
    if (key.status === "quarantined") {
      const r = activateFromUsage(key, v.usage, "manual (batch)");
      results.push({ id: key.id, ok: r.ok, status: r.ok ? r.status : undefined, revived: r.ok ? true : undefined, reason: r.ok ? undefined : r.reason });
    } else {
      key.quota = toQuota(v.usage);
      runStateMachine(key);
      results.push({ id: key.id, ok: true });
    }
  }
  saveState();
  const okN = results.filter((x) => x.ok).length;
  addEvent("refresh", null, `reactivate-all: ok=${okN} failed=${results.length - okN}`);
  return json(res, 200, { ok: true, results });
}

function handleQuarantine(req, res, url) {
  const id = url.pathname.split("/")[3];
  const key = state.keys.find((k) => k.id === id);
  if (!key) return jsonError(res, 404, "key not found");
  quarantine(key, "manual");
  saveState();
  return json(res, 200, { ok: true, status: key.status });
}

async function handlePatchConfig(req, res) {
  const body = await readBody(req);
  if (body == null) return jsonError(res, 400, "invalid body");
  const c = state.config;
  if (typeof body.pollIntervalMs === "number" && body.pollIntervalMs >= 5 * 60 * 1000 && body.pollIntervalMs <= 60 * 60 * 1000) c.pollIntervalMs = body.pollIntervalMs;
  if (typeof body.concurrencyPerKey === "number" && body.concurrencyPerKey >= 1 && body.concurrencyPerKey <= 8) c.concurrencyPerKey = body.concurrencyPerKey;
  if (typeof body.stickyEnabled === "boolean") c.stickyEnabled = body.stickyEnabled;
  if (typeof body.retryEmptyResponse === "boolean") c.retryEmptyResponse = body.retryEmptyResponse;
  if (typeof body.localToken === "string" && body.localToken.length >= 4) c.localToken = body.localToken;
  if (body.localToken === "") c.localToken = null;
  if (body.relay && typeof body.relay === "object") {
    if (typeof body.relay.enabled === "boolean") c.relay.enabled = body.relay.enabled;
    if (Number.isInteger(body.relay.headerTimeoutMs) && body.relay.headerTimeoutMs >= 5000 && body.relay.headerTimeoutMs <= 120000) c.relay.headerTimeoutMs = body.relay.headerTimeoutMs;
  }
  addEvent("config", null, "runtime config updated");
  saveState();
  return json(res, 200, { ok: true, config: maskedConfig() });
}

// MOCK：/v1/models 返回固定模型列表（ZCode 探测思考能力用，不可 404）
function mockModels(res) {
  const ids = ["deepseek-v4-flash", "deepseek-v4-pro", "kimi-k3", "glm-5.2", "ox-alpha-free"];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: ids.map((id, i) => ({ id, object: "model", created: 1787376158, owned_by: "opencode" })) }));
}

// MOCK 转发：按 session 粘性返回合成 SSE 流，可触发模拟 failover
function mockChat(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let payload = {};
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    const model = payload.model || "mock-model";
    const sessionId = req.headers["x-session-id"] || null;
    // MOCK 中转站优先层（演示）：命中 relay 返回合成 SSE 并更新 stats
    const mrelays = matchRelays(model);
    if (mrelays.length) {
      const r = mrelays[0];
      r.failStreak = 0; r.lastReqAt = new Date().toISOString();
      r.stats.requests += 1; r.stats.totalTokens = (r.stats.totalTokens || 0) + 15;
      saveState();
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
      const rid = "mock-relay-" + Date.now();
      res.write(`data: ${JSON.stringify({ id: rid, object: "chat.completion.chunk", model: r.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ id: rid, object: "chat.completion.chunk", model: r.model, choices: [{ index: 0, delta: { content: "[mock] 中转站优先 #" + r.priority + " " + r.label + " → " + r.model }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: rid, object: "chat.completion.chunk", model: r.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: rid, object: "chat.completion", model: r.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }, 150);
      return;
    }
    const key = getOrBindKey(sessionId); // 与真实路径同调度：粘性 + 会话到期优先 / 无会话轻松优先
    if (!key) {
      // 兜底（MOCK 演示）：无可用 key 且备用通道就绪 → 合成备用 SSE 流（真实路径见 tryFallback）
      if (fallbackReady() && noUsableKey()) {
        markFallbackStart();
        state.fallbackState.lastFallbackAt = new Date().toISOString();
        const f = fallbackConfig();
        addEvent("fallback", null, `Go 无可用 key → ${f.label || "fallback"} ${f.model}（mock）`);
        state.fallbackState.costs.unshift({ ts: new Date().toISOString(), model: f.model, promptTokens: 120, completionTokens: 8, cacheHit: 0, cacheMiss: 120, reasoningTokens: 8 });
        saveState();
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
        const fid = "mock-fb-" + Date.now();
        res.write(`data: ${JSON.stringify({ id: fid, object: "chat.completion.chunk", model: f.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ id: fid, object: "chat.completion.chunk", model: f.model, choices: [{ index: 0, delta: { content: "[mock-fallback] Go 无可用 key，已走备用通道 " + (f.label || "fallback") + " → " + f.model }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: fid, object: "chat.completion.chunk", model: f.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: fid, object: "chat.completion", model: f.model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 8 } } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 150);
        return;
      }
      return jsonError(res, 429, { error: { type: "GoUsageLimitError", message: "mock: no active key", metadata: {} } });
    }
    if (state.fallbackState.sessionStart) markFallbackEnd("go-recovered"); // 备用中恢复 -> 切回 Go
    key.stats.requests += 1;
    key.stats.totalTokens = (key.stats.totalTokens || 0) + 15; // mock 流末 usage 块等值
    saveState();
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
    const id = "mock-" + Date.now();
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
    const msg = `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "[mock] 网关正常，粘性 Key=" + key.label }, finish_reason: null }] })}\n\n`;
    setTimeout(() => {
      res.write(msg);
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion", model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, 150);
  });
}

// ---------------- 轮询器（L2 主通道 / L5 回收） ----------------
let pollTimer = null;
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  if (!MOCK) refreshGoModels(); // 模型列表低频刷新（每轮询周期一次；内部 60s 节流）
  pollTimer = setTimeout(runPoll, Math.max(5 * 1000, state.config.pollIntervalMs));
}
async function runPoll() {
  try {
    if (MOCK) return;
    for (const key of state.keys) {
      if (key.status === "invalid") continue;
      if (key.status === "quarantined") {
        // 隔离区自动复查（L6 增强）：仅月限隔离且已过续费日+ε 的 Key 才查 /usage；
        // monthly 恢复 → 自动回池；过点仍限 → 标 monthly_dead 停止复查（一次性耗尽，等手动一键查询/激活）
        if (!quarantineDueForCheck(key)) continue;
        const v = await fetchUsage(key.key);
        if (!v.ok) {
          // 隔离 Key 遇 401：quarantine() 对已是 quarantined 的状态是空操作，直接标 invalid（与单 Key 激活路径一致）
          if (v.code === 401 && key.quarantineReason !== "auth_invalid") {
            key.status = "invalid"; key.quarantineReason = "auth_invalid";
            addEvent("invalid", key.id, "poll check got 401");
          }
          continue;
        }
        const r = activateFromUsage(key, v.usage, "auto (renewal)");
        if (!r.ok && key.quarantineReason !== "monthly_dead") {
          key.quarantineReason = "monthly_dead";
          addEvent("quarantine", key.id, "reason=monthly_dead (past resetsAt, no renewal)");
        }
        continue;
      }
      const v = await fetchUsage(key.key);
      if (!v.ok) { if (v.code === 401) quarantine(key, "auth_invalid"); continue; }
      key.quota = toQuota(v.usage);
      runStateMachine(key);
    }
    // 备用通道余额采样（balance 模式）：并入现有轮询循环、按 balanceSampleMs 节流，不新增定时器
    const fb = state.config.fallback;
    if (fb && fb.enabled && fb.apiKey && fb.billingMode !== "none") {
      const now = Date.now();
      if (now - (state.fallbackState.lastSampleAt || 0) >= (fb.balanceSampleMs || 15 * 60 * 1000)) {
        const v = await fetchFallbackBalance();
        if (v.ok && v.balance != null) recordBalanceSample(v.balance, v.currency);
      }
    }
    saveState();
  } catch (e) { log("poll error: " + e.message); }
  schedulePoll();
}

// ---------------- 冷却到期看护（L5 增强）：窗口 resetsAt 过点即时定向复查回池 ----------------
// 冷却 Key 的恢复不等 15min 轮询：quota 已标明窗口重置点（resetsAt），过点即定向重查 /usage，
// 以服务器真相驱动激活（不做本地免查放行--防本地时钟偏差/边界未真过时误放行引发 429 循环；
// 查了仍限则采纳新的 resetsAt 继续按新边界等，自愈）。不存任何计时器字段：每 tick 从当前
// keys 状态推导到点集合 -> 网关断开/重启期间过点的 Key 在启动后首个看护周期即被补查；
// fetchUsage 失败保持冷却、下个 tick 自然重试（保守不错放）。月限隔离不在此列（沿用 resetsAt+ε 复活门禁）。
const COOLDOWN_WATCH_MS = 30 * 1000;         // 看护节拍
const COOLDOWN_WATCH_EPSILON_MS = 30 * 1000; // 过点缓冲：防本地时钟略快提前查（查了也只是仍限，自愈）
const cooldownWatchBusy = new Set();         // 同 Key 防并发复查
let cooldownWatchTimer = null;

function cooldownWatchWindow(key) {
  return key.status === "cooldown_weekly" ? (key.quota && key.quota.weekly) : (key.quota && key.quota.rolling);
}

async function runCooldownWatch() {
  const now = Date.now();
  for (const key of state.keys) {
    if (key.status !== "cooldown_rolling" && key.status !== "cooldown_weekly") continue;
    if (cooldownWatchBusy.has(key.id)) continue;
    const w = cooldownWatchWindow(key);
    if (!w || !w.resetsAt) continue; // 无 resetsAt（旧快照/一次性）：交给 15min 轮询兜底
    const t = new Date(w.resetsAt).getTime();
    if (!Number.isFinite(t) || now < t + COOLDOWN_WATCH_EPSILON_MS) continue;
    cooldownWatchBusy.add(key.id);
    try {
      const v = await fetchUsage(key.key);
      if (v.ok) {
        key.quota = toQuota(v.usage);
        runStateMachine(key); // 已重置 -> activate（recover 事件）；仍限 -> 新 resetsAt 继续等
        saveState();
      } // 查询失败：保持冷却，下个 tick 重试
    } finally {
      cooldownWatchBusy.delete(key.id);
    }
  }
}

function scheduleCooldownWatch(delayMs) {
  if (cooldownWatchTimer) clearTimeout(cooldownWatchTimer);
  cooldownWatchTimer = setTimeout(async () => {
    try { await runCooldownWatch(); } catch (e) { log("cooldown watch error: " + e.message); }
    scheduleCooldownWatch();
  }, delayMs != null ? delayMs : COOLDOWN_WATCH_MS);
}

// ---------------- 启动 ----------------
loadState();
ensureMockData();
// 关网关边界（用户定稿）：上次关闭时仍处备用态未结算 → 启动即自动补一次结算，不丢账
//（无论此刻是否还启用：未结算周期都要闭合；查不到余额/不计费时金额记 null）
if (!MOCK && state.fallbackState.sessionStart) {
  markFallbackEnd("startup");
}
if (!MOCK) {
  log(`gateway real mode, state=${STATE_FILE}, keys=${state.keys.length}`);
} else {
  log(`gateway MOCK_MODE, state=${STATE_FILE}, keys=${state.keys.length}`);
}

// 自测钩子：GO_NO_LISTEN=1 时跳过启动，仅导出供单测驱动（不影响正常启动路径）
if (process.env.GO_NO_LISTEN === "1") {
  module.exports = {
    streamThrough, quarantineDueForCheck, activateFromUsage,
    noUsableKey, buildFallbackBody, fallbackUpstream, fallbackWindowCost, fallbackWindowCount,
    markFallbackStart, markFallbackEnd, recordBalanceSample, fallbackConfig, fallbackReady,
    matchRelays, classifyRelayError, buildRelayBody, setRelayPriority, isolateRelay, activateRelay,
    goModelsHas, redactRelay, relayConfig, relayEnabled, relayUpstream, relayProbeModels,
    DEFAULT_DOWNGRADE_MODEL, RELAY_FAIL_STREAK_LIMIT, RELAY_QUOTA_RE, INUSE_WINDOW_MS,
    config: state.config, state,
  };
} else {
  server.on("error", (e) => { if (e.code === "EADDRINUSE") log("FATAL: port " + PORT + " already in use"); else log("server error: " + e.message); process.exit(1); });
  server.listen(PORT, "127.0.0.1", () => {
    log(`OpenCode Go gateway v${VERSION} listening on http://127.0.0.1:${PORT} (mode=${MOCK ? "mock" : "real"})`);
    if (!MOCK) { refreshGoModels(); schedulePoll(); scheduleCooldownWatch(5 * 1000); } // 看护首轮 5s：重启后尽快补查断开期间过点的冷却 Key
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { saveState(); log("shutdown"); process.exit(0); });
  }
}
