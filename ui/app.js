/* OpenCode Go 网关 — 前端（六视图，纯原生 JS，无构建链） */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STATUS_LABEL = {
  active: "可用",
  cooldown_rolling: "5h 冷却",
  cooldown_weekly: "周限冷却",
  quarantined: "隔离",
  invalid: "失效",
};
const WINDOW_LABEL = { rolling: "5h", weekly: "周", monthly: "月" };
const REASON_CN = {
  monthly: "月限耗尽",
  monthly_dead: "月限耗尽·未续订",
  auth_invalid: "认证失效",
  manual: "手动停用",
};

let state = {
  status: null, keys: [], sessions: [], events: [], config: null, fallback: null, evFilter: "",
  relays: [], goModels: [],
};
let currentView = "overview";
let pollTimer = null;
let fbDirty = false;       // 备用通道表单编辑中：不被自动刷新覆盖
let cfgDirty = false;      // 设置表单编辑中：不被自动刷新覆盖
let fbWin = "h24";         // 费用时间窗选中项
let relayDirty = false;    // 中转站表单编辑中：不被自动刷新覆盖
let relayEditId = null;    // 正在编辑的中转站 id（null = 新增模式）
let relayModels = [];      // 最近测试连接探测到的中转站模型列表（中转站模型名候选源）

// ---------- 工具 ----------
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast hidden"), 3200);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtCountdown(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "已重置";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", { hour12: false });
}

// token 量格式化：≥1 亿显示「亿」，≥100 万显示「M」，其余原样
function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1e8) return parseFloat((n / 1e8).toFixed(n < 1e9 ? 2 : 1)) + " 亿";
  if (n >= 1e6) return parseFloat((n / 1e6).toFixed(n < 1e7 ? 2 : 1)) + " M";
  return String(n);
}

function shortSession(s, n = 18) {
  return s && s.length > n ? s.slice(0, n) + "…" : (s || "—");
}

// ---------- API ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) {
    const msg = (body && (body.error?.message || body.msg)) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body;
}

async function refreshAll(silent) {
  try {
    // relay/models 属新端点：后端（旧进程）暂缺时降级为空，不拖垮整个仪表盘（否则 render 永不执行、开关全部失灵）
    const [st, k, se, ev, cfg, fb, r, m] = await Promise.all([
      api("/api/status"), api("/api/keys"), api("/api/sessions"),
      api("/api/events?limit=60"), api("/api/config"), api("/api/fallback"),
      api("/api/relays").catch(() => ({ relays: [] })),
      api("/api/models").catch(() => ({ models: [] })),
    ]);
    state.status = st; state.keys = k.keys; state.sessions = se.sessions; state.events = ev.events; state.config = cfg.config; state.fallback = fb; state.relays = r.relays || []; state.goModels = m.models || [];
    render();
  } catch (e) {
    showBanner("无法连接网关：" + e.message, true);
    if (!silent) toast("刷新失败：" + e.message, true);
  }
}

// ---------- 渲染 ----------
function render() {
  renderTopbar();
  renderOverview();
  renderKeys();
  renderQuarantine();
  renderSessions();
  renderRelays();
  renderFallback();
  renderEvents();
  renderSettings();
}

function renderTopbar() {
  const st = state.status;
  $("#gwMode").textContent = st ? `v${st.version} · ${st.mode === "mock" ? "MOCK" : "real"}` : "未连接";
  const dot = $("#gwDot");
  dot.className = "dot " + (st ? "up" : "down");
}

function showBanner(msg, isErr) {
  const b = $("#banner");
  b.textContent = msg;
  b.className = "banner" + (isErr ? "" : " warn");
  b.classList.remove("hidden");
}
function hideBanner() { $("#banner").classList.add("hidden"); }

function statusBadge(status) {
  return `<span class="badge status-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

function qbar(key, win) {
  const q = key.quota && key.quota[win];
  const pct = q ? q.percent : 0;
  const limited = q && q.status === "rate-limited";
  const cls = limited || pct >= 100 ? "over" : pct >= 90 ? "warn" : "ok";
  return `<div class="qbar-row">
    <span class="qbar-label">${WINDOW_LABEL[win]}</span>
    <div class="qbar-track"><div class="qbar-fill ${cls}" style="width:${limited ? 100 : Math.min(100, pct)}%"></div></div>
    <span class="qbar-reset"><span class="qr-pct">${pct}%</span><span class="qr-verb">· 重置</span><span class="qr-time">${fmtCountdown(q && q.resetsAt)}</span></span>
  </div>`;
}

// 同池 = 多个 Key 共享同一 workspace 额度池（轮换无效）
function samePoolSet() {
  const byWs = {};
  for (const k of state.keys) if (k.workspaceId) (byWs[k.workspaceId] = byWs[k.workspaceId] || []).push(k.id);
  const dup = new Set();
  for (const ids of Object.values(byWs)) if (ids.length > 1) ids.forEach((i) => dup.add(i));
  return dup;
}

function renderOverview() {
  const st = state.status;
  const counts = st ? st.counts : { active: 0, cooldown: 0, quarantined: 0, invalid: 0 };
  const relayActive = st ? (st.relayActive || 0) : 0;
  $("#statCards").innerHTML = [
    ["active", counts.active, "可用"],
    ["cooldown", counts.cooldown, "冷却"],
    ["quarantined", counts.quarantined, "隔离"],
    ["invalid", counts.invalid, "失效"],
    ["relay", relayActive, "优先中"],
    ["requests", st ? st.totalRequests : 0, "总请求"],
    ["cached", fmtTokens(st ? st.totalTokens : 0), "总 token"],
  ].map(([cls, num, lbl]) => `<div class="stat ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join("");

  // 优先通道 · 中转站（翠绿识别色；隔离红卡带「重新激活」，充值后一步回池）
  const relays = state.relays || [];
  $("#relayGrid").innerHTML = relays.map((r) => {
    const q = r.status === "quarantined";
    const cls = "key-card relay-card" + (q ? " quarantined" : "") + (r.inUse ? " in-use" : "");
    const m = r.goModel || r.model;
    const shown = m === r.model ? esc(m) : `${esc(m)} → ${esc(r.model)}`;
    return `<div class="${cls}" data-id="${esc(r.id)}">
      <div class="kc-head">
        <span class="badge relay-prio">#${esc(r.priority)}</span>
        ${relayStatusBadge(r)}
        <span class="kc-label">${esc(r.label)}</span>
        <span class="kc-actions">
          ${q ? `<button class="btn small primary" data-act="relay-activate" data-id="${esc(r.id)}" title="重新激活（先探活，通过才回池）">重新激活</button>` : ""}
          <button class="btn small" data-act="relay-test" data-id="${esc(r.id)}" title="测试连接">⟳</button>
          <button class="btn small" data-act="relay-edit" data-id="${esc(r.id)}" title="编辑">✎</button>
          ${q ? "" : `<button class="btn small" data-act="relay-quarantine" data-id="${esc(r.id)}" title="手动停用">⏸</button>`}
          <button class="btn small" data-act="relay-delete" data-id="${esc(r.id)}" title="删除">🗑</button>
        </span>
      </div>
      <div class="kc-key mono">${shown}</div>
      <div class="relay-meta">
        <span>失败 <b>${r.failStreak || 0}/5</b></span>
        <span>请求 <b>${r.stats ? r.stats.requests : 0}</b></span>
        <span>最近 <b>${fmtRelative(r.lastReqAt)}</b></span>
      </div>
    </div>`;
  }).join("");
  $("#relayEmpty").classList.toggle("hidden", relays.length > 0);

  // 默认通道 · OpenCode Go（现状 + in-use 光效）
  const grid = $("#keyGrid");
  const dup = samePoolSet();
  const activeKeys = state.keys.filter((k) => k.status !== "quarantined" && k.status !== "invalid");
  grid.innerHTML = activeKeys.map((k) => {
    const same = dup.has(k.id);
    return `<div class="key-card${same ? " same-pool" : ""}${k.inUse ? " in-use" : ""}" data-id="${esc(k.id)}">
      <div class="kc-head">
        ${statusBadge(k.status)}
        <span class="kc-label">${esc(k.label)}</span>
        <span class="kc-actions">
          <button class="btn small" data-act="refresh" data-id="${esc(k.id)}" title="立即刷新 /usage">⟳</button>
          <button class="btn small" data-act="quarantine" data-id="${esc(k.id)}" title="手动停用">⏸</button>
          <button class="btn small" data-act="edit" data-id="${esc(k.id)}" title="编辑">✎</button>
          <button class="btn small" data-act="delete" data-id="${esc(k.id)}" title="删除">🗑</button>
        </span>
      </div>
      <div class="kc-key mono">${esc(k.key)}</div>
      <div class="quota-bars">${qbar(k, "rolling")}${qbar(k, "weekly")}${qbar(k, "monthly")}</div>
      <div class="kc-foot">
        <span>会话请求 <b>${k.stats ? k.stats.requests : 0}</b></span>
        <span title="有缓存收益的请求次数（粘住同一把 Key、未因切换丢缓存），非缓存 token 量">缓存命中 <b>${k.stats ? k.stats.cacheHits : 0} 次</b></span>
      </div>
    </div>`;
  }).join("");

  $("#overviewEmpty").classList.toggle("hidden", activeKeys.length > 0);
  if (dup.size) showBanner("⚠️ 检测到同池 Key（轮换无效），已红框标出。", false);
  else hideBanner();
}

function renderKeys() {
  const tb = $("#keyTable tbody");
  const dup = samePoolSet();
  tb.innerHTML = state.keys.map((k) => `<tr>
    <td><b>${esc(k.label)}</b></td>
    <td class="mono">${esc(k.key)}</td>
    <td>${statusBadge(k.status)}</td>
    <td>${dup.has(k.id) ? '<span class="tag same-workspace-alert">同池</span>' : "—"}</td>
    <td>${k.stats ? k.stats.requests : 0}</td>
    <td title="有缓存收益的请求次数（粘住同一把 Key、未因切换丢缓存），非缓存 token 量">${k.stats ? k.stats.cacheHits + " 次" : "—"}</td>
    <td>
      <button class="btn small" data-act="refresh" data-id="${esc(k.id)}">刷新</button>
      <button class="btn small" data-act="edit" data-id="${esc(k.id)}">编辑</button>
      <button class="btn small" data-act="delete" data-id="${esc(k.id)}">删除</button>
    </td>
  </tr>`).join("");
}

function renderQuarantine() {
  const tb = $("#qTable tbody");
  const q = state.keys.filter((k) => k.status === "quarantined" || k.status === "invalid");
  tb.innerHTML = q.length ? q.map((k) => `<tr>
    <td><b>${esc(k.label)}</b></td>
    <td class="mono">${esc(k.key)}</td>
    <td>${statusBadge(k.status)}</td>
    <td>${esc(k.status === "invalid" ? "认证失效" : (REASON_CN[k.quarantineReason] || k.quarantineReason || "—"))}</td>
    <td class="mono">${fmtTs(k.quarantinedAt)}</td>
    <td class="mono">${k.quota && k.quota.monthly ? fmtTs(k.quota.monthly.resetsAt) : "—"}</td>
    <td>
      <button class="btn small primary" data-act="reactivate" data-id="${esc(k.id)}">重新激活</button>
      <button class="btn small" data-act="delete" data-id="${esc(k.id)}">彻底删除</button>
    </td>
  </tr>`).join("")
    : `<tr><td colspan="7" style="color:var(--muted)">隔离区为空——月限耗尽或认证失效的 Key 会出现在这里。</td></tr>`;
}

function renderSessions() {
  const tb = $("#sessTable tbody");
  const keyName = (id) => { const k = state.keys.find((x) => x.id === id); return k ? k.label : id; };
  tb.innerHTML = state.sessions.length ? state.sessions.map((s) => `<tr>
    <td class="mono" title="${esc(s.sessionId)}">${esc(shortSession(s.sessionId))}</td>
    <td>${esc(keyName(s.keyId))}</td>
    <td class="mono">${esc(s.model || "—")}</td>
    <td>${s.requests}</td>
    <td class="mono">${fmtTs(s.lastActive)}</td>
  </tr>`).join("")
    : `<tr><td colspan="5" style="color:var(--muted)">暂无会话绑定——ZCode 发起请求后会自动绑定到 Key。</td></tr>`;
}

// ---------- 备用通道视图 ----------
const FB_WIN_LABEL = { h24: "近24小时", d7: "近一周", d14: "近两周", d30: "近一个月" };
const FB_SETTLE_VIA = { "go-recovered": "切回 Go", startup: "重启补结算" };

function renderFallback() {
  const fb = state.fallback;
  if (!fb) return;
  const cfg = fb.config || {};
  // 表单：编辑中不覆盖
  if (!fbDirty) {
    $("#fbEnabled").checked = !!cfg.enabled;
    $("#fbLabel").value = cfg.label || "";
    $("#fbBaseURL").value = cfg.baseURL || "";
    $("#fbApiKey").value = "";
    $("#fbApiKey").placeholder = cfg.apiKey ? "已保存（留空保持不变）" : "sk-…";
    $("#fbModel").value = cfg.model || "";
    $("#fbReasoningEffort").value = cfg.reasoningEffort || "";
    if (typeof fbBillingDD !== "undefined") fbBillingDD.set(cfg.billingMode || "balance");
    // 虚影 = 当前生效配置（留空该字段时实际会用的值），让用户一眼看到现状与是否已配置
    $("#fbBaseURL").placeholder = `留空 = 当前生效 ${fb.effectiveBaseURL || ""}`;
    $("#fbModel").placeholder = `留空 = 当前生效 ${cfg.model || ""}`;
    $("#fbReasoningEffort").placeholder = cfg.reasoningEffort ? `留空 = 当前生效 ${cfg.reasoningEffort}` : "留空 = 不注入（交上游默认）";
  }
  // 状态徽标 + 概要
  $("#fbActiveBadge").classList.toggle("hidden", !fb.active);
  // 费用区（balance 模式显示金额；none 模式只显示次数）
  const billing = cfg.billingMode !== "none";
  const w = (fb.windows || {})[fbWin] || { cost: null, count: 0 };
  const money = (v) => (v == null ? "—" : `¥${v}`);
  $("#fbCostMain").innerHTML = billing ? [
    ["active", money(fb.lastSample ? fb.lastSample.balance : null), "当前余额"],
    ["quarantined", money(fb.currentSpent), "本次备用已花"],
    ["requests", money(w.cost), `${FB_WIN_LABEL[fbWin]}花费`],
    ["cached", w.count, `${FB_WIN_LABEL[fbWin]}兜底次数`],
  ].map(([cls, num, lbl]) => `<div class="stat ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join("")
    : [
      ["requests", w.count, `${FB_WIN_LABEL[fbWin]}兜底次数`],
      ["quarantined", "不计费", "该通道无自动计费"],
    ].map(([cls, num, lbl]) => `<div class="stat ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join("");
  $$("#fbWindows [data-win]").forEach((b) => b.classList.toggle("primary", b.dataset.win === fbWin));
  $("#fbWindowDetail").textContent = `生效端点：${fb.effectiveBaseURL} · 模型：${cfg.model || "—"}${cfg.reasoningEffort ? " · 思考强度：" + cfg.reasoningEffort : ""}${fb.lastFallbackAt ? " · 最近兜底 " + fmtTs(fb.lastFallbackAt) : ""}`;
  // 结算表
  const tb = $("#fbSettleTable tbody");
  tb.innerHTML = fb.settlements && fb.settlements.length ? fb.settlements.map((s) => `<tr>
    <td class="mono">${fmtTs(s.startTs)}</td>
    <td class="mono">${fmtTs(s.endTs)}</td>
    <td>${s.startBalance != null ? "¥" + s.startBalance : "—"}</td>
    <td>${s.endBalance != null ? "¥" + s.endBalance : "—"}</td>
    <td><b>${s.delta != null ? "¥" + s.delta : "—"}</b></td>
    <td>${FB_SETTLE_VIA[s.via] || s.via || "—"}</td>
  </tr>`).join("") : `<tr><td colspan="6" style="color:var(--muted)">暂无结算——每次备用周期（接管 → 切回）结算一次。</td></tr>`;
  // 兜底请求明细
  $("#fbCosts").innerHTML = fb.recentCosts && fb.recentCosts.length ? fb.recentCosts.map((c) => `<li>
    <span class="t">${fmtTs(c.ts)}</span>
    <span class="tag fallback">兜底</span>
    <span><b>${esc(c.model || "—")}</b> · in ${fmtTokens(c.promptTokens)}（命中 ${fmtTokens(c.cacheHit)}）· out ${fmtTokens(c.completionTokens)}（思考 ${fmtTokens(c.reasoningTokens)}）</span>
  </li>`).join("") : `<li style="grid-template-columns:1fr;color:var(--muted)">暂无兜底请求明细</li>`;
}

async function saveFallback(e) {
  e.preventDefault();
  const body = {
    enabled: $("#fbEnabled").checked,
    label: $("#fbLabel").value.trim(),
    baseURL: $("#fbBaseURL").value.trim(),
    model: $("#fbModel").value.trim(),
    reasoningEffort: $("#fbReasoningEffort").value.trim(),
    billingMode: (typeof fbBillingDD !== "undefined" && fbBillingDD.get()) || "balance",
  };
  const k = $("#fbApiKey").value.trim();
  if (k) body.apiKey = k; // 留空 = 保持不变
  try {
    await api("/api/fallback", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    toast("备用通道配置已保存");
    fbDirty = false;
  } catch (err) { toast(err.message, true); }
  refreshAll(true);
}

async function testFallback() {
  const btn = $("#btnFbTest");
  btn.disabled = true;
  $("#fbTestResult").textContent = "测试中…（发一个最小请求 + 探测计费端点）";
  try {
    const body = {
      baseURL: $("#fbBaseURL").value.trim(),
      model: $("#fbModel").value.trim(),
    };
    const k = $("#fbApiKey").value.trim();
    if (k) body.apiKey = k;
    const r = await api("/api/fallback/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { $("#fbTestResult").textContent = "❌ " + (r.msg || "测试失败"); return; }
    const chat = r.chat || {};
    const bal = r.billing || {};
    $("#fbTestResult").textContent = chat.ok
      ? `✅ 连接成功（HTTP ${chat.status}）· 自动计费：${bal.supported ? `支持（余额 ¥${bal.balance ?? "—"} ${bal.currency || ""}）` : "不支持（请选「不计费」）"}`
      : `❌ 连接失败（HTTP ${chat.status}${chat.msg ? " " + chat.msg : ""}）${r.body ? "" : ""}——检查 Base URL / Key / 模型名`;
  } catch (e) {
    $("#fbTestResult").textContent = "❌ 测试失败：" + e.message;
  } finally { btn.disabled = false; }
}

// 「立刻计算」：立即采样一次余额并重算差值
async function refreshFallbackCost() {
  const btn = $("#btnFbRefresh");
  btn.disabled = true;
  try {
    const r = await api("/api/fallback/refresh", { method: "POST" });
    toast(r.note ? r.note : `已更新：当前余额 ¥${r.balance}`);
  } catch (e) { toast("计算失败：" + e.message, true); }
  btn.disabled = false;
  refreshAll(true);
}

// ---------- 中转站优先通道视图 ----------
const RELAY_STREAK_LIMIT = 5;
const RELAY_REASON_CN = { quota: "额度耗尽", streak: "连续失败隔离", auth_invalid: "认证失效", manual: "手动停用", unverified: "未验证" };
const RELAY_STATUS_LABEL = { active: "优先中", quarantined: "隔离" };

function fmtRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "刚刚";
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  return Math.floor(h / 24) + " 天前";
}

function relayStatusBadge(r) {
  const s = r.status === "quarantined" ? "quarantined" : "active";
  return `<span class="badge status-${s}">${RELAY_STATUS_LABEL[r.status] || r.status}</span>`;
}
// 模型映射展示：两侧同名只显示一个；不同显「请求名 → 发出名」
function relayMapText(r) {
  const m = r.goModel || r.model;
  return m === r.model ? m : m + " → " + r.model;
}

function renderRelays() {
  const relays = state.relays || [];
  const cfg = state.config || {};
  if (!relayDirty) $("#relayEnabledGlobal").checked = !cfg.relay || cfg.relay.enabled !== false;
  const active = relays.filter((r) => r.status !== "quarantined");
  const quarantined = relays.filter((r) => r.status === "quarantined");
  const tb = $("#relayTable tbody");
  tb.innerHTML = active.length ? active.map((r) => `<tr>
    <td><b>${esc(r.priority)}</b></td>
    <td><b>${esc(r.label)}</b></td>
    <td class="mono">${esc(relayMapText(r))}</td>
    <td>${relayStatusBadge(r)}${r.enabled === false ? ' <span class="tag">停用</span>' : ""}</td>
    <td>${r.failStreak || 0}/5</td>
    <td>${r.stats ? r.stats.requests : 0}</td>
    <td class="mono">${r.lastReqAt ? fmtTs(r.lastReqAt) : "—"}</td>
    <td>
      <button class="btn small" data-act="relay-test" data-id="${esc(r.id)}">测试</button>
      <button class="btn small" data-act="relay-edit" data-id="${esc(r.id)}">编辑</button>
      <button class="btn small" data-act="relay-quarantine" data-id="${esc(r.id)}">停用</button>
      <button class="btn small" data-act="relay-delete" data-id="${esc(r.id)}">删除</button>
    </td>
  </tr>`).join("")
    : `<tr><td colspan="8" style="color:var(--muted)">暂无中转站——用上方表单添加。</td></tr>`;
  const qtb = $("#relayQTable tbody");
  qtb.innerHTML = quarantined.length ? quarantined.map((r) => `<tr>
    <td><b>${esc(r.priority)}</b></td>
    <td><b>${esc(r.label)}</b></td>
    <td>${esc(RELAY_REASON_CN[r.quarantineReason] || r.quarantineReason || "—")}</td>
    <td class="mono">${fmtTs(r.quarantinedAt)}</td>
    <td class="mono" title="${esc(r.lastError || "")}">${esc((r.lastError || "—").slice(0, 40))}</td>
    <td>
      <button class="btn small primary" data-act="relay-activate" data-id="${esc(r.id)}">重新激活</button>
      <button class="btn small" data-act="relay-delete" data-id="${esc(r.id)}">删除</button>
    </td>
  </tr>`).join("")
    : `<tr><td colspan="6" style="color:var(--muted)">无隔离中转站——额度耗尽或连续失败的中转站会出现在这里（仅可手动重新激活）。</td></tr>`;
  if (!relayDirty) fillRelayForm(relayEditId ? relays.find((x) => x.id === relayEditId) : null);
}

function fillRelayForm(r) {
  $("#relayLabel").value = r ? r.label : "";
  $("#relayBaseURL").value = r ? r.baseURL : "";
  $("#relayApiKey").value = "";
  $("#relayApiKey").placeholder = r && r.apiKey === "(set)" ? "已保存（留空保持不变）" : "sk-…（仅存本机，不回显）";
  $("#relayModel").value = r ? r.model : "";
  $("#relayGoModel").value = r ? (r.goModel === r.model ? "" : r.goModel) : "";
  $("#relayDowngrade").value = r ? (r.downgradeModel === "deepseek-v4-flash" ? "" : r.downgradeModel) : "";
  $("#relayPriority").value = r ? r.priority : "";
  $("#relaySubmit").textContent = r ? "保存修改" : "添加中转站";
  $("#btnRelayCancelEdit").classList.toggle("hidden", !r);
  $("#relayFormHint").textContent = "";
}

async function saveRelay(e) {
  e.preventDefault();
  const body = {
    label: $("#relayLabel").value.trim(),
    baseURL: $("#relayBaseURL").value.trim(),
    model: $("#relayModel").value.trim(),
    goModel: $("#relayGoModel").value.trim(),
    downgradeModel: $("#relayDowngrade").value.trim(),
    enabled: true,
  };
  const prio = Number($("#relayPriority").value);
  if (Number.isInteger(prio) && prio >= 1) body.priority = prio;
  const k = $("#relayApiKey").value.trim();
  if (k) body.apiKey = k;
  try {
    if (relayEditId) {
      await api(`/api/relays/${relayEditId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      toast("中转站已更新");
    } else {
      await api("/api/relays", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      toast("中转站已添加（配错会连续失败后自动隔离）");
    }
    relayEditId = null; relayDirty = false;
    fillRelayForm(null);
  } catch (err) { toast(err.message, true); }
  refreshAll(true);
}

// 未保存配置也能测：POST /api/relays/test 把表单当候选配置探活 + 探测模型列表
async function testRelayForm() {
  const btn = $("#btnRelayTest"); btn.disabled = true;
  const hint = $("#relayFormHint");
  hint.textContent = "测试中…（最小请求 + 探测模型列表）";
  try {
    const body = { baseURL: $("#relayBaseURL").value.trim(), model: $("#relayModel").value.trim() };
    const k = $("#relayApiKey").value.trim();
    if (k) body.apiKey = k;
    const r = await api("/api/relays/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { hint.textContent = "❌ " + (r.msg || "测试失败"); return; }
    const chat = r.chat || {};
    hint.textContent = chat.ok
      ? `✅ 连接成功（HTTP ${chat.status}）· ${r.models ? `探测到 ${r.models.length} 个模型（中转站模型名可选）` : "该站不支持模型列表（中转站模型名请手填）"}`
      : `❌ 连接失败（HTTP ${chat.status}${chat.msg ? " " + chat.msg : ""}）——检查 Base URL / Key / 模型名`;
    if (Array.isArray(r.models)) relayModels = r.models;
  } catch (e) { hint.textContent = "❌ 测试失败：" + e.message; }
  finally { btn.disabled = false; }
}

async function actRelayTest(id) {
  try {
    const r = await api(`/api/relays/${id}/test`, { method: "POST" });
    const chat = r.chat || {};
    toast(chat.ok ? `✅ 连接成功 · 模型 ${r.models ? r.models.length + " 个" : "不可探测"}` : `❌ HTTP ${chat.status || chat.msg}`);
    if (Array.isArray(r.models)) relayModels = r.models;
  } catch (e) { toast(e.message, true); }
  refreshAll(true);
}
function actRelayEdit(id) {
  const r = state.relays.find((x) => x.id === id);
  if (!r) return;
  relayEditId = id; relayDirty = true;
  fillRelayForm(r);
  if (currentView !== "relays") switchView("relays");
  $("#relayForm").scrollIntoView();
}
async function actRelayActivate(id) {
  try {
    const r = await api(`/api/relays/${id}/activate`, { method: "POST" });
    toast(r.ok ? "已重新激活（探活通过，回池）" : (r.msg || "保持隔离"));
  } catch (e) { toast(e.message, true); }
  refreshAll(true);
}
async function actRelayQuarantine(id) {
  const r = state.relays.find((x) => x.id === id);
  if (!(await uiDialog({ title: "手动停用中转站", message: `停用「${r ? r.label : id}」？停用后不参与调度，需手动重新激活。`, confirmText: "停用", danger: true }))) return;
  try { await api(`/api/relays/${id}/quarantine`, { method: "POST" }); toast("已停用"); } catch (e) { toast(e.message, true); }
  refreshAll(true);
}
async function actRelayDelete(id) {
  const r = state.relays.find((x) => x.id === id);
  if (!(await uiDialog({ title: "彻底删除中转站", message: `彻底删除「${r ? r.label : id}」？此操作不可恢复。`, confirmText: "删除", danger: true }))) return;
  try {
    await api(`/api/relays/${id}`, { method: "DELETE" });
    toast("已删除");
    if (relayEditId === id) cancelRelayEdit();
  } catch (e) { toast(e.message, true); }
  refreshAll(true);
}
async function actRelayRenumber() {
  try { await api("/api/relays/renumber", { method: "POST" }); toast("已自动重排 1..N"); } catch (e) { toast(e.message, true); }
  refreshAll(true);
}
async function toggleRelayGlobal(e) {
  try {
    await api("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ relay: { enabled: e.target.checked } }) });
    toast(e.target.checked ? "优先通道已启用" : "优先通道已关闭（全部请求直走 Go 池）");
  } catch (err) { toast(err.message, true); }
  refreshAll(true);
}
function cancelRelayEdit() { relayEditId = null; relayDirty = false; fillRelayForm(null); }

// 半填半选：输关键字实时过滤候选（大小写不敏感），点选填入；也允许纯手填自由文本
// 候选源：Go 字段 = 网关缓存模型列表；中转站字段 = 最近测试连接探测到的模型列表
function makeCombo(input, getOptions) {
  if (!input) return;
  const pop = document.createElement("div");
  pop.className = "dd-pop";
  document.body.appendChild(pop);
  let current = [];
  const close = () => pop.classList.remove("show");
  const open = () => {
    const kw = input.value.trim().toLowerCase();
    current = (getOptions() || []).filter((o) => String(o).toLowerCase().includes(kw)).slice(0, 20);
    if (!current.length) { close(); return; }
    pop.innerHTML = current.map((o, i) => `<div class="dd-opt" data-i="${i}"><span class="dd-label">${esc(o)}</span></div>`).join("");
    pop.classList.add("show");
    const r = input.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let top = r.bottom + 6;
    if (top + ph > vh - 8 && r.top - ph - 6 >= 8) top = r.top - ph - 6;
    pop.style.top = Math.max(8, top) + "px";
    pop.style.left = Math.min(Math.max(8, r.left), Math.max(8, vw - pw - 8)) + "px";
    pop.style.minWidth = Math.max(220, r.width) + "px";
    ddOpenClose = close;
  };
  const pick = (i) => { input.value = current[i]; input.dispatchEvent(new Event("input", { bubbles: true })); close(); };
  input.addEventListener("input", open);
  input.addEventListener("focus", open);
  pop.addEventListener("mousedown", (e) => e.preventDefault()); // 防失焦先于点击
  pop.addEventListener("click", (e) => { const opt = e.target.closest(".dd-opt"); if (opt) pick(Number(opt.dataset.i)); });
}

const EV_TYPES = ["bind", "migrate", "enroll", "cooldown", "rate-limited", "failover", "quarantine", "recover", "reactivate", "invalid", "exhausted", "cache-hit", "same-workspace-alert", "upstream-5xx", "empty-stream", "delete", "edit", "config", "refresh", "fallback", "fallback:start", "fallback:end", "fallback:fail", "fallback-test", "relay-fail", "relay-isolate", "relay-recover", "relay-test", "relay-edit"];

// 事件类型解释（悬停标签 / 下拉选项小注共用；标签本身保持英文 type）
const EV_EXPLAIN = {
  bind: "会话首次绑定到某把 Key",
  migrate: "会话迁移到另一把 Key（原 Key 不可用）",
  enroll: "录入新 Key 并校验通过",
  cooldown: "Key 进入冷却（对应窗口额度打满）",
  "rate-limited": "上游返回 429 限流",
  failover: "请求失败后自动切换到另一把 Key 重试",
  quarantine: "Key 进入隔离区（月限耗尽 / 手动停用）",
  recover: "Key 恢复可用（窗口额度重置）",
  reactivate: "手动重新激活 Key",
  invalid: "Key 认证失效（401），需删除重录",
  exhausted: "所有 Key 都失败，请求被如实拒绝",
  "cache-hit": "该请求命中上游缓存（有缓存收益）",
  "same-workspace-alert": "多把 Key 共享同一额度池（轮换无效）",
  "upstream-5xx": "上游服务端错误（5xx）",
  "empty-stream": "上游空回复被掐断，触发客户端自动重试",
  delete: "删除 Key",
  edit: "编辑 Key",
  config: "配置变更",
  refresh: "批量刷新额度（手动触发）",
  fallback: "Go 无可用 Key，请求转备用通道",
  "fallback:start": "备用周期开始（备用通道接管请求）",
  "fallback:end": "备用周期结束（切回 Go 并结算花费）",
  "fallback:fail": "备用通道请求失败",
  "fallback-test": "备用通道测试连接",
  "relay-fail": "中转站前置请求失败（记录连败计数）",
  "relay-isolate": "中转站被隔离（额度耗尽/连败/401/手动）",
  "relay-recover": "中转站手动复活成功（探活通过）",
  "relay-test": "中转站测试连接",
  "relay-edit": "中转站配置变更（新增/编辑/删除/重排）",
};

function renderEvents() {
  const filter = state.evFilter || "";
  const list = filter ? state.events.filter((e) => e.type === filter) : state.events;
  const ul = $("#evList");
  ul.innerHTML = list.length ? list.map((e) => `<li>
    <span class="t">${fmtTs(e.ts)}</span>
    <span class="tag ${esc(e.type)}" title="${esc(EV_EXPLAIN[e.type] || "")}">${esc(e.type)}</span>
    <span><b>${esc(e.keyId || "—")}</b> · ${esc(e.detail)}</span>
  </li>`).join("") : `<li style="grid-template-columns:1fr;color:var(--muted)">暂无事件</li>`;
}

// ---------- 自绘下拉（玻璃主题，替代原生 select 的系统弹层） ----------
// 弹层挂 document.body（fixed 定位）：彻底脱离卡片的 overflow:hidden 与 backdrop-filter
// 层叠上下文，不会被任何卡片裁剪/遮挡；位置由 JS 按按钮实时计算，下方空间不足时向上弹。
let ddOpenClose = null; // 当前打开的下拉的关闭函数（全局唯一）
function ddCloseAll() { if (ddOpenClose) { ddOpenClose(); ddOpenClose = null; } }

function makeDD(mount, opts, initial, onChange) {
  if (!mount) return { get: () => initial, set: () => {} };
  let value = initial;
  mount.classList.add("dd");
  mount.innerHTML = `<button type="button" class="dd-btn"></button><span class="dd-caret" aria-hidden="true"></span>`;
  const btn = mount.querySelector(".dd-btn");
  const caret = mount.querySelector(".dd-caret");
  if (caret) btn.appendChild(caret); // 箭头放按钮内，随按钮态旋转
  const pop = document.createElement("div");
  pop.className = "dd-pop";
  document.body.appendChild(pop);
  const labelOf = (v) => { const o = opts.find((x) => x.v === v); return o ? o.label : v; };
  const syncBtn = () => { const c = btn.querySelector(".dd-caret"); btn.textContent = labelOf(value) || "—"; if (c) btn.appendChild(c); };
  const place = () => {
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let top = r.bottom + 6;
    if (top + ph > vh - 8 && r.top - ph - 6 >= 8) top = r.top - ph - 6; // 下方放不下且上方更宽裕 → 向上弹
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - pw - 8));
    pop.style.top = Math.max(8, top) + "px";
    pop.style.left = left + "px";
    pop.style.minWidth = r.width + "px";
  };
  const close = () => { pop.classList.remove("show"); mount.classList.remove("open"); };
  const open = () => {
    ddCloseAll();
    pop.innerHTML = opts.map((o) => `<div class="dd-opt${o.v === value ? " sel" : ""}" data-v="${esc(o.v)}"><span class="dd-label">${esc(o.label)}</span>${o.note ? `<span class="dd-note">${esc(o.note)}</span>` : ""}</div>`).join("");
    pop.classList.add("show");
    mount.classList.add("open");
    place();
    ddOpenClose = close;
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pop.classList.contains("show")) ddCloseAll(); else open();
  });
  pop.addEventListener("click", (e) => {
    const opt = e.target.closest(".dd-opt");
    if (!opt) return;
    e.stopPropagation();
    value = opt.dataset.v;
    syncBtn();
    ddCloseAll();
    if (onChange) onChange(value);
  });
  window.addEventListener("scroll", () => { if (pop.classList.contains("show")) place(); }, true);
  window.addEventListener("resize", () => { if (pop.classList.contains("show")) place(); });
  syncBtn();
  return { get: () => value, set: (v) => { value = v; syncBtn(); } };
}

function renderSettings() {
  const st = state.status;
  $("#gwInfo").innerHTML = `
    <dt>版本</dt><dd>${esc(st ? st.version : "—")}</dd>
    <dt>模式</dt><dd>${esc(st ? st.mode : "—")}</dd>
    <dt>运行时长</dt><dd>${st ? Math.floor(st.uptimeSec / 60) + " 分钟" : "—"}</dd>
    <dt>状态更新时间</dt><dd>${fmtTs(st && st.stateUpdatedAt)}</dd>`;

  const c = state.config || {};
  // 表单显示当前生效配置（编辑中不覆盖）；本地 token 不回显，用占位符表明状态
  if (!cfgDirty) {
    $("#cfgPoll").value = Math.round((c.pollIntervalMs || 900000) / 60000);
    $("#cfgConc").value = c.concurrencyPerKey ?? 5;
    $("#cfgSticky").checked = c.stickyEnabled !== false;
    $("#cfgRetryEmpty").checked = c.retryEmptyResponse === true;
    $("#cfgToken").value = "";
  }
  $("#cfgToken").placeholder = c.localToken === "(set)" ? "已设置（输入新值替换，留空即清除）" : "未设置（≥4 字符）";
}

// Agent 对接指引：由网关运行时生成（注入本机安装目录与端口），前端只负责展示与复制
async function loadAgentGuide() {
  try {
    const r = await api("/api/guide");
    $("#agentGuide").textContent = r.prompt || "（指引为空）";
  } catch {
    $("#agentGuide").textContent = "（获取指引失败，请刷新页面重试）";
  }
}

// ---------- 主题化弹层（替换原生 confirm/prompt） ----------
function uiDialog({ title, message, kind = "confirm", defaultValue = "", confirmText = "确定", cancelText = "取消", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3 class="modal-title">${esc(title)}</h3>
        <p class="modal-msg">${esc(message)}</p>
        ${kind === "prompt" ? `<input class="modal-input" type="text" value="${esc(defaultValue)}" autocomplete="off">` : ""}
        <div class="modal-actions">
          <button class="btn modal-cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? "danger" : "primary"} modal-ok">${esc(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("show"));
    const finish = (val) => {
      overlay.classList.remove("show");
      setTimeout(() => overlay.remove(), 180);
      resolve(val);
    };
    const okBtn = overlay.querySelector(".modal-ok");
    const cancelBtn = overlay.querySelector(".modal-cancel");
    const input = overlay.querySelector(".modal-input");
    cancelBtn.addEventListener("click", () => finish(kind === "prompt" ? null : false));
    okBtn.addEventListener("click", () => finish(kind === "prompt" ? input.value : true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(kind === "prompt" ? null : false); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(kind === "prompt" ? null : false); });
    if (input) {
      input.focus(); input.select();
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") okBtn.click(); });
    } else {
      cancelBtn.focus();
    }
  });
}

// ---------- 动作 ----------
async function actRefresh(id) {
  try {
    const r = await api(`/api/keys/${id}/refresh`, { method: "POST" });
    toast(`已刷新 ${r.key.label}：weekly ${r.key.quota.weekly.percent}%`);
  } catch (e) { toast("刷新失败：" + e.message, true); }
  refreshAll(true);
}

// 右上角「立即刷新」：批量重查全部可用 Key 的 /usage（BUG-009 修复；旧实现只重拉缓存视图）
async function actRefreshAll() {
  try {
    const r = await api("/api/keys/refresh-all", { method: "POST" });
    const list = r.refreshed || [];
    const okN = list.filter((x) => x.ok).length;
    const badN = list.length - okN;
    toast(badN ? `已刷新 ${okN} 个 Key，${badN} 个失败` : `已刷新全部 ${okN} 个 Key`);
  } catch (e) { toast("刷新失败：" + e.message, true); }
  refreshAll(true);
}

async function actQuarantine(id) {
  if (!(await uiDialog({ title: "手动停用", message: "手动停用该 Key（进隔离区）？停用后移出调度与轮询。", confirmText: "停用", danger: true }))) return;
  try { await api(`/api/keys/${id}/quarantine`, { method: "POST" }); toast("已停用"); } catch (e) { toast(e.message, true); }
  refreshAll(true);
}

async function actReactivate(id) {
  try {
    const r = await api(`/api/keys/${id}/reactivate`, { method: "POST" });
    toast(r.ok ? "已重新激活" : (r.msg || "未激活"));
  } catch (e) { toast(e.message, true); }
  refreshAll(true);
}

// 隔离区「一键恢复」：手动点击 = 全部 Key 重查一次，隔离区额度已恢复的自动放回池
async function actReactivateAll() {
  const btn = $("#btnReactivateAll");
  btn.disabled = true; btn.textContent = "恢复中…";
  try {
    const r = await api("/api/keys/reactivate-all", { method: "POST" });
    const list = r.results || [];
    const okN = list.filter((x) => x.ok).length;
    const revived = list.filter((x) => x.revived).length;
    if (revived) toast(`已全部重查 ${list.length} 个 Key，恢复 ${revived} 个隔离 Key`);
    else if (okN === list.length) toast(`已全部重查 ${list.length} 个 Key`);
    else toast(`已重查 ${okN}/${list.length} 个 Key（${list.length - okN} 个失败：仍限/401）`);
  } catch (e) { toast("恢复失败：" + e.message, true); }
  btn.disabled = false; btn.textContent = "一键恢复";
  refreshAll(true);
}

async function actDelete(id) {
  const k = state.keys.find((x) => x.id === id);
  if (!(await uiDialog({ title: "彻底删除", message: `彻底删除 Key「${k ? k.label : id}」？此操作不可恢复。`, confirmText: "删除", danger: true }))) return;
  try { await api(`/api/keys/${id}`, { method: "DELETE" }); toast("已删除"); } catch (e) { toast(e.message, true); }
  refreshAll(true);
}

async function actEdit(id) {
  const k = state.keys.find((x) => x.id === id);
  if (!k) return;
  const label = await uiDialog({ kind: "prompt", title: "编辑显示名", message: "显示名称：", defaultValue: k.label, confirmText: "保存" });
  if (label == null) return;
  const val = await uiDialog({ kind: "prompt", title: "编辑 Key 值", message: "Key 值（留空保持不变）：", defaultValue: "", confirmText: "保存" });
  const body = { label };
  if (val && val.trim()) body.key = val.trim();
  try { await api(`/api/keys/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); toast("已保存"); }
  catch (e) { toast(e.message, true); }
  refreshAll(true);
}

// 添加 Key
async function addKey(e) {
  e.preventDefault();
  const key = $("#newKey").value.trim();
  const label = $("#newLabel").value.trim();
  if (!key) return toast("请粘贴 Key", true);
  try {
    const r = await api("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, label }) });
    $("#newKey").value = ""; $("#newLabel").value = "";
    toast(`已添加「${r.key.label}」并校验通过（active）`);
    $("#samePoolHint").classList.toggle("hidden", !(r.key.workspaceId && state.keys.some((k) => k.workspaceId === r.key.workspaceId)));
  } catch (e) {
    toast("添加失败：" + e.message, true);
  }
  refreshAll(true);
}

// ---------- 设置表单 ----------
async function saveConfig(e) {
  e.preventDefault();
  const body = {
    pollIntervalMs: Math.max(5, Math.min(60, Number($("#cfgPoll").value) || 15)) * 60000,
    concurrencyPerKey: Number($("#cfgConc").value) || 5,
    stickyEnabled: $("#cfgSticky").checked,
    retryEmptyResponse: $("#cfgRetryEmpty").checked,
  };
  const tok = $("#cfgToken").value.trim();
  if (tok) body.localToken = tok; else body.localToken = "";
  try { await api("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); toast("参数已保存"); cfgDirty = false; }
  catch (err) { toast(err.message, true); }
  refreshAll(true);
}

// ---------- 视图切换 ----------
function switchView(name) {
  currentView = name;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
}

// ---------- 轮询 ----------
function setupPolling() {
  clearInterval(pollTimer);
  const iv = Number(refreshDD.get());
  if ($("#autoRefresh").checked && iv > 0) pollTimer = setInterval(() => refreshAll(true), iv);
}

// ---------- 实时推送（SSE，2026-08-25 事件驱动改造） ----------
// 网关 /api/stream 推送两类消息：
//   activity -> 即时点亮对应卡「使用中」光效（零往返，不等拉取周期）；
//   event    -> 即时插入事件日志 + 750ms 防抖 refreshAll（事件伴随状态变化，统一防抖比维护类型矩阵简单）。
// 拉取轮询保留为兜底对账；EventSource 断线原生自动重连。
const GLOW_DECAY_MS = 10 * 60 * 1000; // 与服务端 INUSE_WINDOW_MS 对齐；refreshAll 时以服务端 inUse 重新对齐
let streamOk = false;
let refreshDebTimer = null;
const glowTimers = new Map(); // 卡 id（Key/中转站共用）-> 本地衰减 timer

function refreshDebounced() {
  clearTimeout(refreshDebTimer);
  refreshDebTimer = setTimeout(() => refreshAll(true), 750);
}

function markInUse(id) {
  const el = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (el) el.classList.add("in-use");
  clearTimeout(glowTimers.get(id));
  glowTimers.set(id, setTimeout(() => {
    const card = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (card) card.classList.remove("in-use");
  }, GLOW_DECAY_MS));
}

function setupStream() {
  const ind = $("#streamInd");
  let es = null;
  try {
    es = new EventSource("/api/stream");
  } catch (e) { if (ind) ind.title = "浏览器不支持实时推送，仅靠拉取刷新"; return; }
  es.onopen = () => { streamOk = true; if (ind) ind.classList.add("on"); };
  es.onerror = () => { if (ind) ind.classList.remove("on"); }; // 自动重连；断开瞬间标灰，重连成功恢复
  es.onmessage = (e) => {
    let msg = null;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!msg || !msg.kind) return;
    if (msg.kind === "activity") {
      if (msg.keyId) markInUse(msg.keyId);
      if (msg.relayId) markInUse(msg.relayId);
      return; // 流量信号：只点亮，不刷新
    }
    if (msg.kind === "event") {
      state.events.unshift(msg.ev);
      if (state.events.length > 500) state.events.length = 500;
      renderEvents();   // 事件日志即时出新条目（尊重过滤器）
      refreshDebounced();
    }
  };
}

// ---------- 事件绑定 ----------
document.addEventListener("click", async (e) => {
  const tab = e.target.closest(".tab");
  if (tab) return switchView(tab.dataset.view);
  const goto = e.target.closest("[data-goto]");
  if (goto) return switchView(goto.dataset.goto);
  const act = e.target.closest("[data-act]");
  if (act) {
    const a = act.dataset.act, id = act.dataset.id;
    if (a === "refresh") actRefresh(id);
    if (a === "quarantine") actQuarantine(id);
    if (a === "reactivate") actReactivate(id);
    if (a === "delete") actDelete(id);
    if (a === "edit") actEdit(id);
    if (a === "relay-test") actRelayTest(id);
    if (a === "relay-edit") actRelayEdit(id);
    if (a === "relay-activate") actRelayActivate(id);
    if (a === "relay-quarantine") actRelayQuarantine(id);
    if (a === "relay-delete") actRelayDelete(id);
  }
});

$("#addKeyForm").addEventListener("submit", addKey);
$("#configForm").addEventListener("submit", saveConfig);
$("#fallbackForm").addEventListener("submit", saveFallback);
$("#btnFbTest").addEventListener("click", testFallback);
$("#btnFbRefresh").addEventListener("click", refreshFallbackCost);
$("#fallbackForm").addEventListener("input", () => { fbDirty = true; });
$("#fallbackForm").addEventListener("change", () => { fbDirty = true; });
$("#relayForm").addEventListener("submit", saveRelay);
$("#btnRelayTest").addEventListener("click", testRelayForm);
$("#btnRelayCancelEdit").addEventListener("click", cancelRelayEdit);
$("#btnRelayRenumber").addEventListener("click", actRelayRenumber);
$("#relayEnabledGlobal").addEventListener("change", toggleRelayGlobal);
$("#relayForm").addEventListener("input", () => { relayDirty = true; });
$("#relayForm").addEventListener("change", () => { relayDirty = true; });
$("#fbWindows").addEventListener("click", (e) => {
  const b = e.target.closest("[data-win]");
  if (!b) return;
  fbWin = b.dataset.win;
  renderFallback();
});
$("#btnRefresh").addEventListener("click", actRefreshAll);
$("#btnReactivateAll").addEventListener("click", actReactivateAll);
$("#autoRefresh").addEventListener("change", setupPolling);
$("#configForm").addEventListener("input", () => { cfgDirty = true; });
$("#configForm").addEventListener("change", () => { cfgDirty = true; });
$("#toggleNewKey").addEventListener("click", () => {
  const i = $("#newKey");
  i.type = i.type === "password" ? "text" : "password";
});
$("#btnClearEvents").addEventListener("click", async () => {
  if (!(await uiDialog({ title: "清空事件日志", message: "清空事件日志？此操作不可恢复。", confirmText: "清空", danger: true }))) return;
  try { await api("/api/events/clear", { method: "POST" }); toast("已清空"); } catch (err) { toast(err.message, true); }
  refreshAll(true);
});
$("#btnExport").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/keys");
    const d = await r.json();
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "opencode-go-keys-export.json";
    a.click();
  } catch (err) { toast(err.message, true); }
});
$("#btnCopyGuide").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#agentGuide").textContent); toast("已复制"); }
  catch { toast("复制失败", true); }
});

// ---------- 自绘下拉初始化 + 全局关闭（ddCloseAll 定义于 makeDD 上方） ----------
document.addEventListener("click", ddCloseAll);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") ddCloseAll(); });

const refreshDD = makeDD($("#refreshDD"), [
  { v: "30000", label: "30s" }, { v: "60000", label: "1min" }, { v: "300000", label: "5min" }, { v: "0", label: "关" },
], "60000", () => setupPolling());
const evDD = makeDD($("#evTypeDD"),
  [{ v: "", label: "全部类型" }].concat(EV_TYPES.map((t) => ({ v: t, label: t, note: EV_EXPLAIN[t] }))),
  "", (v) => { state.evFilter = v; renderEvents(); });
const fbBillingDD = makeDD($("#fbBillingDD"), [
  { v: "balance", label: "自动计费", note: "DeepSeek 官方余额差值" },
  { v: "none", label: "不计费", note: "其他 OpenAI 端点" },
], "balance");

// 半填半选接线：中转站模型名用最近探测列表，Go 字段用网关缓存的 Go 模型列表
makeCombo($("#relayModel"), () => relayModels);
makeCombo($("#relayGoModel"), () => state.goModels);
makeCombo($("#relayDowngrade"), () => state.goModels);

// ---------- 启动 ----------
refreshAll(true);
loadAgentGuide();
setupPolling();
setupStream();
