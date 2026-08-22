#!/usr/bin/env node
/**
 * go-gateway.cjs — OpenCode Go 多 Key 本地路由网关（Phase 1 MVP）
 *
 * 本地单进程网关（默认 127.0.0.1:8788，Node 24 原生 http/https，零依赖）：
 *   - 转发面  POST /v1/chat/completions     （OpenAI 协议，SSE 透传 + 透明 failover）
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
      preSwitchPct: 90,               // 预切换阈值：rolling 5h 窗口 ≥ 此值提前迁移
      preSwitchWeeklyPct: 95,         // 预切换阈值：weekly 周窗口 ≥ 此值提前迁移（与 rolling 分档，BUG-004）
      concurrencyPerKey: 5,           // 每 Key 并发上限
      localToken: null,               // 可选本地 token：设置后转发面与控制面要求 Bearer
      stickyEnabled: true,            // x-session-id 粘性开关
    },
    keys: [],
    sessions: [],
    events: [],
    seq: 0,
  };
}
let state = defaultState();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      state = { ...defaultState(), ...raw, config: { ...defaultState().config, ...(raw.config || {}) } };
      if (!Array.isArray(state.keys)) state.keys = [];
      if (!Array.isArray(state.sessions)) state.sessions = [];
      if (!Array.isArray(state.events)) state.events = [];
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

// ---------------- 调度器（L3） ----------------
const inflight = new Map();
const inflightInc = (id) => inflight.set(id, (inflight.get(id) || 0) + 1);
const inflightDec = (id) => inflight.set(id, Math.max(0, (inflight.get(id) || 0) - 1));

const quotaPercent = (k, w) => (k.quota && k.quota[w] ? k.quota[w].percent : 0);

// ---------------- 反浪费（drain）调度：缓存核心（BUG-008） ----------------
// 核心：网关唯一优化目标 = 提示词缓存命中率（切换对 ZCode 无感、代价为零）→ 会话粘性 = 缓存积累。
// 月额度将尽（剩余 < 5h 窗口 ≈ monthly ≥80%，或临近续费日仍有剩余）的 key 注定死亡：
// 其缓存无未来价值（会话迟早迁走、必刷新一次）→ 周额度无关紧要 → 最高优先用完丢弃。
// 只有月额度健康的 key 才谈周平衡/防封。
const DRAIN_MONTHLY_PCT = 80;    // monthly ≥80% ≈ 剩余 <5h 窗口（$12/$60）
const DRAIN_RENEWAL_HOURS = 72;  // 距 monthly.resetsAt（=订阅续费日）≤72h 且仍有剩余

function isDrainKey(k) {
  const m = k.quota && k.quota.monthly;
  if (!m) return false;
  if (m.percent >= DRAIN_MONTHLY_PCT) return true;
  if (m.percent > 0 && m.resetsAt) {
    const hours = (new Date(m.resetsAt).getTime() - Date.now()) / 3600e3;
    if (hours <= DRAIN_RENEWAL_HOURS) return true;
  }
  return false;
}

// 排序：drain 优先（到期近→剩余少），其余 balance（周剩余多→5h 剩余多→并发少）
function compareKeys(a, b) {
  const da = isDrainKey(a) ? 0 : 1;
  const db = isDrainKey(b) ? 0 : 1;
  if (da !== db) return da - db;
  if (da === 0) {
    const ra = (a.quota.monthly && a.quota.monthly.resetsAt) || "";
    const rb = (b.quota.monthly && b.quota.monthly.resetsAt) || "";
    if (ra !== rb) return ra < rb ? -1 : 1;
    return quotaPercent(b, "monthly") - quotaPercent(a, "monthly");
  }
  const dWeekly = quotaPercent(a, "weekly") - quotaPercent(b, "weekly");
  const dRolling = quotaPercent(a, "rolling") - quotaPercent(b, "rolling");
  const dInflight = (inflight.get(a.id) || 0) - (inflight.get(b.id) || 0);
  return dWeekly || dRolling || dInflight;
}

function shouldPreSwitch(key) {
  // 5h/周 分档阈值（BUG-004）；monthly 不触发（月额度走 drain：用完即弃，绝不因 high percent 弃用）
  const pct = state.config.preSwitchPct;
  const wpct = state.config.preSwitchWeeklyPct != null ? state.config.preSwitchWeeklyPct : 95;
  return quotaPercent(key, "rolling") >= pct || quotaPercent(key, "weekly") >= wpct;
}

// 新会话 / 迁移分配：drain（月额度将尽）优先用完丢弃，其余按「周剩余最多→5h 剩余→并发」平衡
function pickBestKey(excludeId, skipIds) {
  const cap = state.config.concurrencyPerKey;
  const actives = state.keys.filter((k) => k.status === "active" && k.id !== excludeId && !(skipIds && skipIds.has(k.id)));
  if (!actives.length) return null;
  const underCap = actives.filter((k) => (inflight.get(k.id) || 0) < cap);
  const pool = underCap.length ? underCap : actives;
  pool.sort(compareKeys);
  return pool[0];
}

// 预切换目标：健康（非 drain）key 中剩余最多者；无则 null（不动，让 429 failover 兜底）
function pickPreSwitchTarget(bound) {
  const pool = state.keys.filter((k) => k.status === "active" && k.id !== bound.id && !isDrainKey(k));
  if (!pool.length) return null;
  pool.sort(compareKeys);
  return pool[0];
}

// BUG-003：预切换目标须「明显更鲜」（任一窗口低 ≥10 个百分点），否则不切，防止多 key 近限时 ping-pong 毁缓存
const PRECHECK_MARGIN = 10;
function meaningfullyFresher(alt, bound) {
  return quotaPercent(alt, "rolling") <= quotaPercent(bound, "rolling") - PRECHECK_MARGIN ||
         quotaPercent(alt, "weekly") <= quotaPercent(bound, "weekly") - PRECHECK_MARGIN;
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
      if (bound && bound.status === "active") {
        // drain key（月额度将尽）：缓存注定丢失 → 绝不预切换走，留着用完即弃
        if (!isDrainKey(bound) && shouldPreSwitch(bound)) {
          const alt = pickPreSwitchTarget(bound);
          if (alt && meaningfullyFresher(alt, bound)) { bindSession(sessionId, alt); return alt; }
        }
        return bound;
      }
      // 绑定 Key 不可用（cooldown_*/quarantined/invalid）-> 重分配；rolling 冷却 key 一律不可服务（BUG-001）
      const alt = pickBestKey(null);
      if (alt) { bindSession(sessionId, alt); return alt; }
      return null;
    }
  }
  const k = pickBestKey(null);
  if (k && sessionId) bindSession(sessionId, k);
  return k;
}

// ---------------- 转发面（L4） ----------------
// BUG-001：429 命中窗口时同步标记 quota 状态，避免下游（轮询状态机/调度）读到过期 status 而误判
function markWindowLimited(key, w) {
  if (key.quota && key.quota[w]) key.quota[w].status = "rate-limited";
}
function handleUpstreamError(key, status, bodyText) {
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch {}
  // 实测 429 响应 metadata 在顶层（{"type":"error","error":{...},"metadata":{...}}），兼容历史"error.metadata"位置
  const meta = (parsed && (parsed.metadata || (parsed.error && parsed.error.metadata))) || {};
  if (status === 429 && parsed && parsed.error && parsed.error.type === "GoUsageLimitError") {
    if (meta.workspace && !key.workspaceId) key.workspaceId = meta.workspace;
    const ln = meta.limitName;
    if (ln === "monthly") { quarantine(key, "monthly"); markWindowLimited(key, "monthly"); }
    else if (ln === "weekly") { cooldown(key, "cooldown_weekly", "weekly"); markWindowLimited(key, "weekly"); }
    else if (ln === "rolling") { cooldown(key, "cooldown_rolling", "rolling"); markWindowLimited(key, "rolling"); }
    addEvent("rate-limited", key.id, `429 ${ln || "?"}${meta.workspace ? " ws=" + meta.workspace : ""}`);
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

function streamThrough(clientRes, upRes, key, sessionId, model, started) {
  clientRes.writeHead(upRes.statusCode, upRes.headers);
  let buf = "";
  let cacheTokens = 0;
  upRes.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const m = buf.match(/"cached_tokens"\s*:\s*(\d+)/);
    if (m) cacheTokens = Math.max(cacheTokens, parseInt(m[1], 10));
    if (buf.length > 65536) buf = buf.slice(-16384);
    clientRes.write(chunk);
  });
  upRes.on("end", () => { try { clientRes.end(); } catch {} finishRequest(key, sessionId, model, started, cacheTokens); });
  upRes.on("error", () => { try { clientRes.destroy(); } catch {} finishRequest(key, sessionId, model, started, cacheTokens); });
}

// 首字节前失败后的统一兜底（BUG-002/005/006）：
//   1) 瞬时错误（5xx/网络/超时）先在原 key 上重试 SAME_KEY_RETRIES 次（限额/401 不重试）；
//   2) 有界 failover：每把 key 至多试一次、总上限 MAX_FAILOVER（防死循环）；
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
      if (retry.stream) { streamThrough(res, retry.res, key, sessionId, model, started); return; }
      inflightDec(key.id);
      last = retry;
      if (!TRANSIENT(last.status)) break; // 变为限额/401 -> 停止同 key 重试，走 failover
    }
  }
  const tried = new Set([key.id]);
  let fallback = null;
  let attempts = 0;
  while (attempts < MAX_FAILOVER && (fallback = pickBestKey(key.id, tried))) {
    attempts++;
    tried.add(fallback.id);
    inflightInc(fallback.id);
    addEvent("failover", key.id, `HTTP ${last.status} -> key ${fallback.id}`);
    const nxt = await attemptForward(fallback, rawBody, clientHeaders);
    if (nxt.stream) {
      if (sessionId) bindSession(sessionId, fallback);
      streamThrough(res, nxt.res, fallback, sessionId, model, started);
      return;
    }
    inflightDec(fallback.id);
    last = nxt;
  }
  // 全部 Key 耗尽：如实回最后错误（附最近恢复时间）
  addEvent("exhausted", key.id, `all keys failed (last HTTP ${last.status})`);
  const head = { "Content-Type": "application/json" };
  if (last.retryAfter) head["Retry-After"] = last.retryAfter;
  res.writeHead(last.status, head);
  res.end(last.body || JSON.stringify({ error: { type: "GatewayError", message: "all keys exhausted" } }));
  saveState();
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
    const key = getOrBindKey(sessionId);
    if (!key) {
      // 无 active Key：按 L4 如实回 429 + 最近恢复时间（正确的最终状态，不是连接错误）
      const rec = earliestRecovery();
      addEvent("exhausted", null, "no active key available" + (rec ? " recover at " + rec : ""));
      const msg = "All Go keys exhausted. " + (rec ? "Earliest recovery at " + rec : "Check gateway dashboard for key states.");
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: msg }, metadata: rec ? { resetsAt: rec } : {} }));
    }
    inflightInc(key.id);
    const out = await attemptForward(key, rawBody, { accept: req.headers.accept, "x-request-id": req.headers["x-request-id"] });
    if (out.stream) {
      streamThrough(res, out.res, key, sessionId, model, started);
    } else {
      // 首字节前失败 -> 统一兜底：瞬时重试 → 有界 failover → 耗尽如实回错（BUG-002/005/006）
      await failoverChain(res, key, out, rawBody, { accept: req.headers.accept, "x-request-id": req.headers["x-request-id"] }, sessionId, model, started);
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
  const totalRequests = state.keys.reduce((a, k) => a + (k.stats ? k.stats.requests : 0), 0);
  const totalCached = state.keys.reduce((a, k) => a + (k.stats ? k.stats.cachedTokens : 0), 0);
  return { version: VERSION, mode: MOCK ? "mock" : "real", uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), counts, totalRequests, totalCachedTokens: totalCached, stateUpdatedAt: state.updatedAt };
}

function apiKeyList() {
  return state.keys.map((k) => {
    const r = redactKey(k);
    return r;
  });
}

function samePoolWarnings() {
  const byWs = {};
  for (const k of state.keys) if (k.workspaceId) (byWs[k.workspaceId] = byWs[k.workspaceId] || []).push(k.id);
  return Object.entries(byWs).filter(([, ids]) => ids.length > 1).map(([ws, ids]) => ({ workspaceId: ws, keyIds: ids }));
}

// ---------------- MOCK_MODE 合成剧本 ----------------
function mockUsage(rollingPct, weeklyPct, monthlyPct, rollingStatus, weeklyStatus, monthlyStatus) {
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  return {
    rolling: { status: rollingStatus || "ok", percent: rollingPct, resetsAt: iso(5 * 3600e3) },
    weekly: { status: weeklyStatus || "ok", percent: weeklyPct, resetsAt: iso(3 * 24 * 3600e3) },
    monthly: { status: monthlyStatus || "ok", percent: monthlyPct, resetsAt: iso(28 * 24 * 3600e3) },
  };
}

function ensureMockData() {
  if (!MOCK || state.keys.length) return;
  const base = "sk-mock-";
  const mk = (label, status, ws, u, reason, stats) => ({
    id: "k" + (++state.seq), label, key: base + label.toLowerCase().replace(/\W+/g, ""), status, workspaceId: ws,
    quota: u, quarantinedAt: status === "quarantined" ? new Date().toISOString() : null,
    quarantineReason: reason || null, stats: stats || { requests: 0, cachedTokens: 0, cacheHits: 0 },
  });
  state.keys.push(
    mk("主力", "active", "wrk_AAA111", mockUsage(35, 40, 50), null, { requests: 86, cachedTokens: 4100, cacheHits: 9 }),
    mk("备用", "active", "wrk_BBB222", mockUsage(12, 8, 22), null, { requests: 34, cachedTokens: 900, cacheHits: 4 }),
    mk("周限冷却", "cooldown_weekly", "wrk_CCC333", mockUsage(0, 100, 55, "ok", "rate-limited"), null, { requests: 120, cachedTokens: 0, cacheHits: 0 }),
    mk("5h 冷却", "cooldown_rolling", "wrk_DDD444", mockUsage(100, 70, 60, "rate-limited"), null, { requests: 15, cachedTokens: 0, cacheHits: 0 }),
    mk("月限隔离", "quarantined", "wrk_EEE555", mockUsage(0, 0, 100, "ok", "ok", "rate-limited"), "monthly", { requests: 200, cachedTokens: 0, cacheHits: 0 }),
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
  if (req.method === "GET" && p === "/api/config") return json(res, 200, { config: { ...state.config, localToken: state.config.localToken ? "(set)" : null } });

  if (req.method === "POST" && p === "/api/keys") return handleEnroll(req, res);
  if (req.method === "POST" && p === "/api/keys/refresh-all") return handleRefreshAll(req, res);
  if (req.method === "PATCH" && p.startsWith("/api/keys/")) return handlePatchKey(req, res, url);
  if (req.method === "DELETE" && p.startsWith("/api/keys/")) return handleDeleteKey(req, res, url);
  if (req.method === "POST" && p.startsWith("/api/keys/") && p.endsWith("/refresh")) return handleRefresh(req, res, url);
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
    key.quota = toQuota(v.usage);
    if (key.quota.monthly.status === "ok") {
      key.status = "active"; key.quarantinedAt = null; key.quarantineReason = null;
      addEvent("reactivate", key.id, "monthly ok -> active"); saveState();
      return json(res, 200, { ok: true, status: "active" });
    }
    addEvent("reactivate", key.id, "monthly still rate-limited"); saveState();
    return json(res, 400, { ok: false, msg: "monthly 仍限额 — 需续订 Go 订阅（新月周期重置），充 Zen 余额不重置 $60 配额" });
  }
  if (v.code === 401) { key.status = "invalid"; key.quarantineReason = "auth_invalid"; addEvent("invalid", key.id, "reactivate check got 401"); saveState(); return json(res, 400, { ok: false, msg: "invalid key (401) — 已标失效" }); }
  return json(res, 502, { ok: false, msg: `usage check failed: ${v.code}` });
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
  if (typeof body.preSwitchPct === "number" && body.preSwitchPct >= 0 && body.preSwitchPct <= 100) c.preSwitchPct = body.preSwitchPct;
  if (typeof body.preSwitchWeeklyPct === "number" && body.preSwitchWeeklyPct >= 0 && body.preSwitchWeeklyPct <= 100) c.preSwitchWeeklyPct = body.preSwitchWeeklyPct;
  if (typeof body.concurrencyPerKey === "number" && body.concurrencyPerKey >= 1 && body.concurrencyPerKey <= 8) c.concurrencyPerKey = body.concurrencyPerKey;
  if (typeof body.stickyEnabled === "boolean") c.stickyEnabled = body.stickyEnabled;
  if (typeof body.localToken === "string" && body.localToken.length >= 4) c.localToken = body.localToken;
  if (body.localToken === "") c.localToken = null;
  addEvent("config", null, "runtime config updated");
  saveState();
  return json(res, 200, { ok: true, config: { ...c, localToken: c.localToken ? "(set)" : null } });
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
    const sessionId = req.headers["x-session-id"] || "mock-anon";
    let key = state.keys.find((k) => k.status === "active");
    const sess = state.sessions.find((s) => s.sessionId === sessionId);
    if (sess) { const b = state.keys.find((k) => k.id === sess.keyId && k.status === "active"); if (b) key = b; }
    if (!key) return jsonError(res, 429, { error: { type: "GoUsageLimitError", message: "mock: no active key", metadata: {} } });
    bindSession(sessionId, key);
    key.stats.requests += 1; saveState();
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
  pollTimer = setTimeout(runPoll, Math.max(5 * 1000, state.config.pollIntervalMs));
}
async function runPoll() {
  try {
    if (MOCK) return;
    for (const key of state.keys) {
      if (key.status === "invalid" || key.status === "quarantined") continue; // 隔离区不轮询
      const v = await fetchUsage(key.key);
      if (!v.ok) { if (v.code === 401) quarantine(key, "auth_invalid"); continue; }
      key.quota = toQuota(v.usage);
      runStateMachine(key);
    }
    saveState();
  } catch (e) { log("poll error: " + e.message); }
  schedulePoll();
}

// ---------------- 启动 ----------------
loadState();
ensureMockData();
if (!MOCK) {
  log(`gateway real mode, state=${STATE_FILE}, keys=${state.keys.length}`);
} else {
  log(`gateway MOCK_MODE, state=${STATE_FILE}, keys=${state.keys.length}`);
}

server.on("error", (e) => { if (e.code === "EADDRINUSE") log("FATAL: port " + PORT + " already in use"); else log("server error: " + e.message); process.exit(1); });
server.listen(PORT, "127.0.0.1", () => {
  log(`OpenCode Go gateway v${VERSION} listening on http://127.0.0.1:${PORT} (mode=${MOCK ? "mock" : "real"})`);
  if (!MOCK) schedulePoll();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { saveState(); log("shutdown"); process.exit(0); });
}
