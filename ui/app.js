/* OpenCode Go 网关 — 前端（六视图，纯原生 JS，无构建链） */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STATUS_LABEL = {
  active: "active",
  cooldown_rolling: "5h 冷却",
  cooldown_weekly: "周限冷却",
  quarantined: "隔离",
  invalid: "失效",
};
const WINDOW_LABEL = { rolling: "5h", weekly: "周", monthly: "月" };

let state = {
  status: null, keys: [], sessions: [], events: [], config: null,
};
let currentView = "overview";
let pollTimer = null;

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
    const [st, k, se, ev, cfg] = await Promise.all([
      api("/api/status"), api("/api/keys"), api("/api/sessions"),
      api("/api/events?limit=60"), api("/api/config"),
    ]);
    state.status = st; state.keys = k.keys; state.sessions = se.sessions; state.events = ev.events; state.config = cfg.config;
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
  renderEvents();
  renderSettings();
}

function renderTopbar() {
  const st = state.status;
  $("#gwMode").textContent = st ? `v${st.version} · ${st.mode === "mock" ? "MOCK" : "real"}` : "未连接";
  const dot = $("#gwDot");
  dot.className = "dot " + (st ? "up" : "down");
  const q = state.keys.filter((k) => k.status === "quarantined" || k.status === "invalid").length;
  const badge = $("#qBadge");
  if (q > 0) { badge.textContent = q; badge.classList.remove("hidden"); } else badge.classList.add("hidden");
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
  return `<div class="qbar-row">
    <span class="qbar-label">${WINDOW_LABEL[win]}</span>
    <div class="qbar-track"><div class="qbar-fill ${win}" style="width:${Math.min(100, pct)}%"></div></div>
    <span class="qbar-reset">${pct}% · 重置 ${fmtCountdown(q && q.resetsAt)}</span>
  </div>`;
}

function renderOverview() {
  const st = state.status;
  const counts = st ? st.counts : { active: 0, cooldown: 0, quarantined: 0, invalid: 0 };
  $("#statCards").innerHTML = [
    ["active", counts.active, "active"],
    ["cooldown", counts.cooldown, "cooldown"],
    ["quarantined", counts.quarantined, "quarantined"],
    ["invalid", counts.invalid, "invalid"],
    ["requests", st ? st.totalRequests : 0, "total 请求"],
    ["cached", st ? st.totalCachedTokens : 0, "缓存 token"],
  ].map(([cls, num, lbl]) => `<div class="stat ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join("");

  const grid = $("#keyGrid");
  const dup = new Set();
  const byWs = {};
  for (const k of state.keys) if (k.workspaceId) (byWs[k.workspaceId] = byWs[k.workspaceId] || []).push(k.id);
  for (const ids of Object.values(byWs)) if (ids.length > 1) ids.forEach((i) => dup.add(i));

  const activeKeys = state.keys.filter((k) => k.status !== "quarantined" && k.status !== "invalid");
  grid.innerHTML = activeKeys.map((k) => {
    const sess = state.sessions.find((s) => s.keyId === k.id);
    const same = dup.has(k.id);
    return `<div class="key-card${same ? " same-pool" : ""}" data-id="${esc(k.id)}">
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
      <div class="kc-ws mono${same ? " dup" : ""}">${k.workspaceId ? esc(k.workspaceId) : "workspace 待发现"}</div>
      <div class="quota-bars">${qbar(k, "rolling")}${qbar(k, "weekly")}${qbar(k, "monthly")}</div>
      <div class="kc-foot">
        <span>会话请求 <b>${k.stats ? k.stats.requests : 0}</b></span>
        <span>缓存命中 <b>${k.stats ? k.stats.cacheHits : 0}</b> (${k.stats ? k.stats.cachedTokens : 0})</span>
        <span title="当前粘在此 Key 上的会话">🔗 ${sess ? shortSession(sess.sessionId, 14) : "无"}</span>
      </div>
    </div>`;
  }).join("");

  $("#overviewEmpty").classList.toggle("hidden", activeKeys.length > 0);
  if (dup.size) showBanner("⚠️ 检测到同 workspace 共享额度池（多个 Key 同池 = 轮换无效），卡片已红框标出。", false);
  else hideBanner();
}

function renderKeys() {
  const tb = $("#keyTable tbody");
  tb.innerHTML = state.keys.map((k) => `<tr>
    <td><b>${esc(k.label)}</b></td>
    <td class="mono">${esc(k.key)}</td>
    <td>${statusBadge(k.status)}</td>
    <td class="mono">${k.workspaceId ? esc(k.workspaceId) : "—"}</td>
    <td>${k.stats ? k.stats.requests : 0}</td>
    <td>${k.stats ? `${k.stats.cacheHits} / ${k.stats.cachedTokens}` : "0 / 0"}</td>
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
    <td>${esc(k.quarantineReason || "—")}</td>
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

const EV_TYPES = ["bind", "migrate", "enroll", "cooldown", "rate-limited", "failover", "quarantine", "recover", "reactivate", "invalid", "exhausted", "cache-hit", "same-workspace-alert", "upstream-5xx", "delete", "edit", "config"];

function renderEvents() {
  const sel = $("#evType");
  if (sel.options.length <= 1) {
    sel.innerHTML = `<option value="">全部类型</option>` + EV_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
  }
  const filter = sel.value;
  const list = filter ? state.events.filter((e) => e.type === filter) : state.events;
  const ul = $("#evList");
  ul.innerHTML = list.length ? list.map((e) => `<li>
    <span class="t">${fmtTs(e.ts)}</span>
    <span class="tag ${esc(e.type)}">${esc(e.type)}</span>
    <span><b>${esc(e.keyId || "—")}</b> · ${esc(e.detail)}</span>
  </li>`).join("") : `<li style="grid-template-columns:1fr;color:var(--muted)">暂无事件</li>`;
}

function renderSettings() {
  const st = state.status;
  $("#gwInfo").innerHTML = `
    <dt>版本</dt><dd>${esc(st ? st.version : "—")}</dd>
    <dt>模式</dt><dd>${esc(st ? st.mode : "—")}</dd>
    <dt>运行时长</dt><dd>${st ? Math.floor(st.uptimeSec / 60) + " 分钟" : "—"}</dd>
    <dt>状态更新时间</dt><dd>${fmtTs(st && st.stateUpdatedAt)}</dd>`;

  const c = state.config || {};
  $("#cfgPoll").value = Math.round((c.pollIntervalMs || 900000) / 60000);
  $("#cfgPre").value = c.preSwitchPct ?? 90;
  $("#cfgConc").value = c.concurrencyPerKey ?? 1;
  $("#cfgSticky").checked = c.stickyEnabled !== false;
  $("#cfgToken").value = "";

  $("#zcodeGuide").textContent =
`# 一次性的 ZCode 模型配置改动（主方案 §3.3）
# 文件：C:\\Users\\duanz\\.zcode\\v2\\config.json
# provider ce6a858a-5fad-4118-ba2b-b08bbde2c8d7:
#   options.baseURL: https://opencode.ai/zen/go/v1  ->  http://127.0.0.1:8788/v1
#   options.apiKey:  <占位符，如 sk-local-gateway>
# 另保留一个 disabled 的逃生门 provider（真实 baseURL + 单 Key）。
# 改配置后需新建会话 / 重启 ZCode 生效（Key 在 provider 构造时固化）。`;
}

// ---------- 动作 ----------
async function actRefresh(id) {
  try {
    const r = await api(`/api/keys/${id}/refresh`, { method: "POST" });
    toast(`已刷新 ${r.key.label}：weekly ${r.key.quota.weekly.percent}%`);
  } catch (e) { toast("刷新失败：" + e.message, true); }
  refreshAll(true);
}

async function actQuarantine(id) {
  if (!confirm("手动停用该 Key（进隔离区）？")) return;
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

async function actDelete(id) {
  const k = state.keys.find((x) => x.id === id);
  if (!confirm(`彻底删除 Key「${k ? k.label : id}」？`)) return;
  try { await api(`/api/keys/${id}`, { method: "DELETE" }); toast("已删除"); } catch (e) { toast(e.message, true); }
  refreshAll(true);
}

function actEdit(id) {
  const k = state.keys.find((x) => x.id === id);
  if (!k) return;
  const label = prompt("显示名称：", k.label);
  if (label == null) return;
  const val = prompt("Key 值（留空保持不变）：", "");
  const body = { label };
  if (val && val.trim()) body.key = val.trim();
  (async () => {
    try { await api(`/api/keys/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); toast("已保存"); }
    catch (e) { toast(e.message, true); }
    refreshAll(true);
  })();
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
    preSwitchPct: Number($("#cfgPre").value) || 90,
    concurrencyPerKey: Number($("#cfgConc").value) || 1,
    stickyEnabled: $("#cfgSticky").checked,
  };
  const tok = $("#cfgToken").value.trim();
  if (tok) body.localToken = tok; else body.localToken = "";
  try { await api("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); toast("参数已保存"); }
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
  const iv = Number($("#refreshInterval").value);
  if ($("#autoRefresh").checked && iv > 0) pollTimer = setInterval(() => refreshAll(true), iv);
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
  }
});

$("#addKeyForm").addEventListener("submit", addKey);
$("#configForm").addEventListener("submit", saveConfig);
$("#btnRefresh").addEventListener("click", () => refreshAll(false));
$("#autoRefresh").addEventListener("change", setupPolling);
$("#refreshInterval").addEventListener("change", setupPolling);
$("#toggleNewKey").addEventListener("click", () => {
  const i = $("#newKey");
  i.type = i.type === "password" ? "text" : "password";
});
$("#btnClearEvents").addEventListener("click", async () => {
  if (!confirm("清空事件日志？")) return;
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
  try { await navigator.clipboard.writeText($("#zcodeGuide").textContent); toast("已复制"); }
  catch { toast("复制失败", true); }
});
$("#evType").addEventListener("change", () => renderEvents());

// ---------- 启动 ----------
refreshAll(true);
setupPolling();
