# OpenCode Go 网关 —— 前端功能清单 + 后端架构（设计细化）

日期：2026-08-22（主方案定稿后的细节敲定轮）
状态：分析/设计细化，未实现代码。主方案 `opencode-go-key-router-2026-08-22.md` 仍为唯一决策源；本文档把前端页面功能与后端架构细化到「实现阶段可直接开工」的程度，并记录本轮真实探测结果。

**本轮结论一句话**：前端做成一个**本地单页网页**（浏览器打开 `http://127.0.0.1:8788`，纯 HTML/CSS/JS 无构建链，由网关直接托管），核心就两块——**「放 key 的地方」（Key 管理）+「看 key 的地方」（总览仪表盘）**，另配隔离区/会话绑定/事件日志/设置四个辅助视图；后端是**单 Node 进程网关**（转发面 + 控制面 API + 静态前端同一进程），控制面 API 为前端提供全部数据。

---

## 一、本轮真实探测（2026-08-22，ZCode config `ce6a858a` 的 Go Key）

用真实 Key 复测，确认前端要展示的数据形状（探测脚本 `%TEMP%\zcode\opencode-go-router-bootstrap\probe_usage.py`，可重跑）：

### 1.1 `/usage`（GET，Bearer，免签名）→「看 key」页面的数据源

```json
{"usage":{
  "rolling":  {"status":"ok",          "percent":0,   "resetsAt":"2026-08-22T10:22:37.103Z"},
  "weekly":   {"status":"rate-limited","percent":100, "resetsAt":"2026-08-24T00:00:00.103Z"},
  "monthly":  {"status":"ok",          "percent":50,  "resetsAt":"2026-09-19T11:08:00.103Z"}}}
```

- 每窗口：`status`（ok / rate-limited）+ `percent`（0-100）+ `resetsAt`（ISO，带统一毫秒后缀 = 近似值）。
- 前端卡片三档进度条的数据就是这三组 `percent` 与 `resetsAt`。当前真实状态：rolling 0%（ok）、weekly 100%（周一 08-24 00:00 UTC 重置）、monthly 50%。

### 1.2 推理 429（POST /chat/completions tiny）→ failover 与「冷却」徽章的触发依据

```json
{"type":"error","error":{"type":"GoUsageLimitError",
  "message":"Weekly usage limit reached. Resets in 1 day. ... https://opencode.ai/workspace/wrk_01KKZMHM676M3CWS8ZDFJ75EFG/go",
  "metadata":{"workspace":"wrk_01KKZMHM676M3CWS8ZDFJ75EFG","limitName":"weekly"}}}
```

- HTTP 429、`Content-Type: text/plain`、`Retry-After: 153435`（≈1.78 天）——**预流式完整 JSON 拒绝（非 SSE）**，与证据链一致，支持「缓冲到首字节前透明换 Key」。
- `metadata.workspace` 是本 Key 的 workspace id（`wrk_01KKZMHM...`）→ 前端「workspace id」字段与同池告警（P9）直接用。

### 1.3 ⚠️ 新发现：Cloudflare 1010 拦截（网关工程要点）

- 裸 `urllib` 请求（默认 UA/TLS 指纹）访问 `/usage`、`/models`、`/chat/completions` 全部返回 **HTTP 403 `error code: 1010`**（Cloudflare 浏览器签名拦截）。
- 带浏览器 UA 的 `curl` 全部通过（200/429 正常）。
- **对网关的工程含义**：出站请求的 User-Agent 不能是 Node 默认/无 UA——**实现 Phase 1 的第一件事**就是用真实 Key 验证网关转发（node http/fetch）带什么 UA 能通过；ZCode 本身能连通（其 HTTP 栈 UA 可过），网关照 ZCode 的 UA 形态配即可。

---

## 二、前端功能清单（本地单页网页）

### 2.1 总体形态与导航

- 单页应用，**顶部横向导航**六个视图：`总览`｜`Key 管理`｜`隔离区`｜`会话绑定`｜`事件日志`｜`设置`。
- 全局框架元素：
  - 右上角**网关状态点**（绿=healthy / 红=未运行，调 `/health`）+ 版本号。
  - **自动刷新控件**（全局）：开关 + 间隔选择（30s / 1min / 5min / 15min，默认 1min），存 localStorage。
  - **手动刷新按钮**（全部刷新）。
  - 数据加载失败时显示错误横幅（区分「网关未运行」与「API 异常」）。

### 2.2 视图一：总览（Dashboard）——「看 key 的地方」

顶部统计卡（4+2 个数字）：
- active / cooldown / quarantined / invalid 四类 Key 计数；
- 全局累计会话请求数、全局缓存命中率（V2 落地后）。

Key 卡片网格（每把 Key 一张卡，核心内容）：
| 卡片元素 | 数据来源 | 说明 |
|---|---|---|
| 显示名 + 脱敏 Key | keys.label / keys.key | 形如 `sk-wfj0****`，默认不展开明文 |
| 状态徽章 | keys.status | active=绿 / cooldown_rolling·cooldown_weekly=橙（附倒计时）/ quarantined=红 / invalid=灰 |
| 三档用量条 | quota.rolling/weekly/monthly | 每档：剩余 % 进度条 + `resetsAt`（相对倒计时「下周一 00:00 重置」+ hover 显示绝对时间） |
| workspace id | quota 或录入回填 | 多 Key workspace 相同 → 卡片红框 + 顶部同池告警横幅（P9） |
| 本会话请求数 | stats.requests | 粘在当前 Key 上的会话累计请求 |
| 缓存命中率 | stats（cached_tokens 统计） | V2 实证后显示 |
| 绑定会话 | sessions | 当前粘着的 x-session-id（截断显示，hover 完整） |
| 操作按钮 | — | 立即刷新 / 编辑 / 停用（→ 隔离区） |

### 2.3 视图二：Key 管理——「放 key 的地方」

- **添加 Key 表单**：
  - 真实 Key 输入框（`type=password` + 眼睛切换显示）；
  - 显示名称（备注，必填，默认 `Key-N`）；
  - 提交即校验：网关立即调 `/usage` → 200 回填三窗口 + workspace id 并置 active；401 拒绝并提示「无效 Key」；网络错误提示重试。
  - 同 workspace 检测：录入时若 workspace 与既有 Key 相同 → 红色警告「疑似同池共享额度，轮换无效」（P9），允许确认录入但卡片标记。
- **Key 列表**：每行 = 脱敏 Key + 状态徽章 + 显示名 + workspace + 操作（编辑 / 刷新 / 删除）。
- **编辑**：改显示名 / 替换 Key 值（替换时重新校验）。

### 2.4 视图三：隔离区（quarantined）

- 与总览分开展示，或独立 tab：每项 = 显示名 + 废弃原因（月限耗尽 / 认证失效）+ 废弃时间 + workspace id + monthly resetsAt。
- 操作按钮：
  - **重新激活** → 网关调 `/usage` 三态校验：monthly ok 回 active / 仍限 → 提示检查续订 / 401 → 标 invalid。
  - **彻底删除** → 二次确认后移除。
- **写死的提示文案**：月限恢复靠**续订 Go 订阅**（新月周期重置月窗口）；充 Zen 余额是独立钱包、不重置 $60 配额、不延期（主方案 P6 / 记忆 opencode-go-billing-credits）。

### 2.5 视图四：会话绑定表

- 列：x-session-id（截断 + hover 完整）、绑定 Key、会话请求数、最后活动时间、绑定时长。
- 用途：看哪个会话在烧哪把 Key 的额度；两个会话绑同一 Key（同池）时提示。

### 2.6 视图五：事件日志

- 倒序时间流：时间戳 + 类型标签 + Key + 详情。
- 事件类型：绑定建立 / 迁移 / 冷却（进入 cooldown）/ 回收（回 active）/ 隔离 / 复活 / 429 failover / 401 invalid / 录入 / 删除 / 启动 / 关闭 / 用量刷新。
- 过滤：按类型 + 按 Key；分页或最近 N 条。

### 2.7 视图六：设置

- 网关信息：端口（8788）、版本、模式（粘性开关）、启动时间、Guard 是否在位。
- 运行参数（可改，写 `/api/config`）：/usage 轮询间隔（5-60min 默认 15）、预切换阈值（默认 90%）、每 Key 并发上限（默认 1，决策点 4）。
- ZCode 对接指引：baseURL 改动步骤（一次性）+ 逃生门 provider 说明（主方案 §3.3），可一键复制文本。
- 安全：可选本地 token 设置（防本机其他进程白嫖，网关只绑 127.0.0.1 之外的第二道门）。
- 数据：导出当前状态（JSON）/ 清空事件日志。

### 2.8 前端实现要点

- 纯原生 HTML/CSS/JS 单文件（或 index.html + app.js + style.css），**无构建链、无 CDN 依赖**（本机离线可开），网关直接 serve 静态文件。
- 数据获取：`fetch('/api/...')` + 30s/1min 轻量轮询本地状态；按钮强制即时。
- 深色/浅色跟随系统（prefers-color-scheme）即可，不做主题配置。

---

## 三、后端架构

### 3.1 进程与模块划分（go-gateway.cjs，单进程，Node 24 原生 http，零依赖）

| 模块 | 职责（对应主方案） | 关键点 |
|---|---|---|
| HTTP Server | 路由分发：转发面 + 控制面 API + 静态前端 + /health | 只绑 127.0.0.1:8788 |
| Router（L3） | x-session-id→Key 绑定表（持久化）、新会话分配（周剩余最多优先 + 并发保护）、三触发换 Key、预切换 | 绑定表写入 keys.json |
| Limiter（L2） | 三通道判定：/usage 主动轮询（默认 15min）+ 429 被动标记 + 启发式兜底 | 填轮询盲区 |
| StateMachine（L5/L6） | 状态机 active/cooldown*/quarantined/invalid；resetsAt 定时复查回收 + 有界退避；隔离/复活三态校验 | 周一复查：weekly 恢复但 monthly 仍限 → 隔离 |
| Forwarder（L4） | 缓冲到首字节 + failover 重放 + SSE 透传 + UA 处理 + 连接池 | **首字节前完成换 Key**；UA 见 §1.3 |
| Store | keys.json 读写（原子写：临时文件 + rename；0600） | 含 config/keys/sessions/events/stats |
| Poller | /usage 轮询调度器（每 Key 定时 + 失败退避） | setInterval 管理，生命周期跟随网关 |
| UI | 静态前端托管 | 与 API 同源，无 CORS 问题 |
| guard 对接 | /health 探活 + 状态落盘 | go-guard.cjs 复用 reference 模式 |

### 3.2 控制面 API 端点清单（前端 ↔ 后端契约）

| 方法 + 路径 | 用途 | 前端视图 |
|---|---|---|
| `GET /health` | 探活（guard 用） | 全局状态点 |
| `GET /api/status` | 网关版本/运行时长/模式 + 汇总（四类计数、总请求、缓存命中） | 总览统计卡 |
| `GET /api/keys` | Key 列表（脱敏 + 状态 + 三窗口快照 + 绑定 + stats） | 总览/Key 管理 |
| `POST /api/keys` | 录入（立即 /usage 校验，回填 workspace 与三窗口） | Key 管理添加 |
| `PATCH /api/keys/:id` | 改备注 / 替换 Key 值（重新校验） | Key 管理编辑 |
| `DELETE /api/keys/:id` | 删除 | Key 管理/隔离区 |
| `POST /api/keys/:id/refresh` | 立即刷新该 Key 的 /usage | 总览卡片 |
| `POST /api/keys/:id/reactivate` | 隔离复活（三态校验） | 隔离区 |
| `POST /api/keys/:id/quarantine` | 手动停用（进隔离） | 总览卡片 |
| `GET /api/sessions` | 会话绑定表 | 会话绑定 |
| `GET /api/events?type=&key=&limit=` | 事件日志（过滤 + 最近 N 条） | 事件日志 |
| `GET /api/config` | 运行参数读取 | 设置 |
| `PATCH /api/config` | 更新运行参数（轮询间隔/预切换/并发/localToken） | 设置 |
| `POST /api/export` / `POST /api/events/clear` | 数据导出 / 清空日志 | 设置 |

转发面（ZCode 打，OpenAI 协议）：`POST /v1/chat/completions`（流式 SSE 透传；Phase 1 跑 deepseek-v4-flash）。Phase 2 增加 `POST /v1/messages`（Anthropic 转换 + count_tokens 本地化）。

### 3.3 存储 schema（keys.json，0600）

```json
{
  "version": 1,
  "updatedAt": "2026-08-22T...Z",
  "config": {
    "pollIntervalMs": 900000, "preSwitchPct": 90, "concurrencyPerKey": 1,
    "localToken": null, "stickyEnabled": true
  },
  "keys": [{
    "id": "k1", "label": "主力", "key": "sk-...", "status": "active",
    "workspaceId": "wrk_...",
    "quota": {
      "rolling":  {"status":"ok","percent":0,  "resetsAt":"...","lastChecked":"..."},
      "weekly":   {"status":"ok","percent":30,"resetsAt":"...","lastChecked":"..."},
      "monthly":  {"status":"ok","percent":50,"resetsAt":"...","lastChecked":"..."}
    },
    "quarantinedAt": null, "quarantineReason": null,
    "stats": { "requests": 12, "cachedTokens": 0, "cacheHits": 0 }
  }],
  "sessions": [ { "sessionId": "sess_...", "keyId": "k1", "requests": 8, "lastActive": "..." } ],
  "events": [ { "ts": "...", "type": "bind", "keyId": "k1", "detail": "..." } ]
}
```

- 真实 Key 明文存 `keys.json`（0600，已 gitignore）；前端 API 返回时**脱敏**（`sk-` + 前 4 位 + `****`），明文字段只在内部使用。
- 原子写：写 `keys.json.tmp` → rename，防崩溃损坏。

### 3.4 关键数据流

**请求路径（ZCode → 网关 → opencode.ai）**：
```
ZCode POST /v1/chat/completions (+ x-session-id)
  → Router：查绑定表 → 有绑定且健康→用；无→按「周剩余最多优先 + 无在途」分配 → 记绑定
  → Forwarder：替换 Authorization: Bearer <该 Key>、处理 UA、复用连接池
  → 缓冲到首字节
      ├─ 429(GoUsageLimitError)/401/5xx → failover 下一健康 Key 原样重放（请求体未消费）
      └─ 首字节到达 → 开始流式透传给 ZCode
  → 记账：记录 usage.prompt_tokens_details.cached_tokens、会话请求数
  → 写事件（bind/429 failover/cooled）→ 异步落盘 keys.json
```

**定时路径（Poller）**：
```
每 15min（可配）对每 active/cooldown Key GET /usage
  → 更新 quota 快照 → StateMachine：
      status=rate-limited 且曾 active → 进 cooldown_<窗口>，记事件
      cooldown 到 resetsAt+ε → 复查：窗口 ok → active；仍限 → 有界退避（+2min/+5min）
      周一复查：weekly 恢复但 monthly 仍限 → 隔离
  → 前端 30s-1min 轮询 /api/keys 自然看到变化
```

### 3.5 开发期模拟（回应「模拟 debug 测试」）

- 网关内置 **`MOCK_MODE=1`**：不连真实端点，按内置剧本返回合成数据，覆盖全部状态（active / cooldown_rolling / cooldown_weekly / quarantined / invalid）与事件流，供前端开发与调试；可加 `MOCK_LATENCY` 模拟慢首字节。
- 前端六个视图在 MOCK_MODE 下可完整走通（放 key→校验→看状态→隔离→复活），再切真实模式用现有周限 Key 验证。
- 真实模式当前只有 1 把 Key 且周限额 100%，failover 成功路径（V1）仍需 ≥2 健康 Key 才能端到端验证——MOCK_MODE 可先覆盖 UI 层。

---

## 四、参考项目对比（前端设计借鉴）

| 项目 | 形态 | 借鉴点 | 我们的差异 |
|---|---|---|---|
| `Ruinique/opencode-go-dashboard` | CF Workers 面板（React+Kumo+D1） | 多账号增删改查、一键刷新单个/全部、用量接近上限高亮、密码保护管理后台 | 它用 **Auth Cookie 抓控制台页面**（结构变更就坏）；我们用 **/usage API Key**（稳定）；且我们没有会话绑定/事件日志/隔离复活/缓存命中率 |
| `lnilluv/pi-opencode-go-rotation` | pi 扩展（TypeScript，无 UI） | 429→查 /usage→封禁到 resetsAt→轮换的后端逻辑（与主方案 L2/L5 同源） | 它是脚本无 UI；我们做可视化 |
| `SantiagoRomanChillon/opencode-zen-copilot` | VSCode 扩展 | /usage 端点可用的旁证（V6 观察项） | 无 |
| `ChineseFirstKeng/opencode-api` | Anthropic↔Go 转换代理 | /messages 路由 + usage 字段映射（Phase 2 参考） | 无 UI |

结论：**前端功能定位 = 「本地自托管网关的管理台」**，在 opencode-go-dashboard 的「多账号额度面板」基础上增加本方案特有的会话粘性可视化、隔离复活流程、事件日志、缓存命中率、同池告警。

---

## 五、与主方案的关系与待办

- 主方案 §3.6 四个决策点仍待用户确认（5 Key 是否独立 workspace / 排序方向 / 储备策略 / 并发上限）——影响调度实现与前端部分展示（同池告警强度、排序方向）。
- §3.7 V1-V6 中与前端直接相关：V2（缓存命中率字段是否可用）、V3（同池检测告警）、V6（/usage 稳定性 → 前端错误兜底提示）。
- 本文档是主方案 §3.2/§3.4/§3.5 的细化，不取代主方案；实现任务开工时以本文档为 UI 与 API 规格。

**实现顺序建议（下一轮实现任务可照此排）**：
1. go-gateway.cjs 骨架：HTTP Server + /health + 静态托管 + MOCK_MODE；
2. 控制面 API 全套 + Store（keys.json 原子写）；
3. 前端六视图（MOCK_MODE 下走通）；
4. 真实转发面：Router + Forwarder（先验证 UA 过 Cloudflare，§1.3）；
5. Limiter + StateMachine + Poller；
6. go-guard.cjs 生命周期接入；
7. ZCode baseURL 切入 + 真实 Key 冒烟 + V1-V6 分批验证。
