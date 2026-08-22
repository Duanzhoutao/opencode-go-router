# OpenCode Go 多 Key 本地路由 + ZCode 集成 -- 总方案

日期：2026-08-22（五轮设计迭代后复盘整理，本文件为唯一主方案，取代此前逐轮追加的版本）
状态：设计定稿；待用户确认 §3.6 的 4 个决策点后进入 MVP 实现
实测证据与调研细节（外挂）：[opencode-go-router-evidence-2026-08-22.md](opencode-go-router-evidence-2026-08-22.md)

**一句话**：本地 Node 网关（127.0.0.1:8788）持有 OpenCode Go 多 Key 池，以 `x-session-id` 做会话粘性 + 周限额优先级调度 + `resetsAt` 精确回收 + 月限隔离/复活，对 ZCode 完全透明（唯一一次性改动 = baseURL 指向网关），跟随 ZCode 启停，配浏览器仪表盘。

---

## 一、需要解决哪些问题

| # | 问题 | 关键约束/背景（均已实测，见外挂证据） |
|---|---|---|
| P1 | 多把 Go Key 自动轮换，ZCode 本体零改动 | ZCode 的 Key 在 provider 构造时固化（无 reloadConfig、无 `{env:}`/`{file:}` 模板、无用户 CA 钩子），改配置不生效 |
| P2 | 自动判定限额档位：5 小时 / 周 / 月 | Go 套餐三道滚动限额：5h $12 / 周 $30 / 月 $60，按美元用量计；DeepSeek 系月限额已降 $15 且分峰谷价 |
| P3 | 「平均使用」与「缓存命中」的矛盾 | 提示词缓存按 workspace（账号）记；平均轮换 5 Key = 每请求缓存全 miss，ZCode 每轮全量上下文（数万 token）重算 |
| P4 | Key 切换对 ZCode 完全无感、不抖动 | 同一会话内也可能要换 Key（5h 耗尽/月限/失效），不能断流、不能报错 |
| P5 | 按精确重置时刻回收，不用重试循环 | `/usage` 返回每窗口精确 `resetsAt`；周窗口实测周一 00:00 UTC 重置 |
| P6 | 月限 Key 不硬删：隔离存放、充值后一键复活、不充就废弃 | 「充值」= 续订 Go 订阅才重置月窗口；充 Zen 余额是独立钱包、不重置 $60 配额 |
| P7 | 网关生命周期跟随 ZCode 启动/关闭 | 复用 DT-MCP 已验证模式（SessionStart 钩子 + 单例 guard），不留孤儿进程 |
| P8 | 桌面前端：每 Key 三档剩余百分比、状态徽章、会话绑定、实时/定时/手动刷新 | 浏览器仪表盘即可满足 |
| P9 | 前提验证：多 Key 必须来自不同 workspace | 同 workspace 多 Key **共享同一额度池**，轮换无效（官方文档 + pi-opencode-go-rotation 双重警示） |

## 二、有哪些核心逻辑

### L1 密钥轮换的载体：本地网关（P1）

- 轮换不在 ZCode 内做（Key 固化，实测无重载机制），也不走 MITM/hosts（无 CA 钩子，侵入且脆弱，已判否）。
- **唯一一次性改动**：ZCode 里 OpencodeGo provider（`ce6a858a`）的 `baseURL` 从 `https://opencode.ai/zen/go/v1` 改为 `http://127.0.0.1:8788/v1`，`apiKey` 填占位符。此后 ZCode 运行时零接触，仍当自己在直连 Go 套餐。
- 真实 Key 只存网关 `keys.json`（0600 权限），不散落 ZCode 配置。

### L2 限额三通道判定（P2）

1. **主动轮询（主通道）**：每 N 分钟（默认 15，可配 5~60）对每把 Key 调 `GET /zen/go/v1/usage`（Bearer Key 即可、无需签名、查询不耗额度），得到三窗口 `{status, percent, resetsAt}`。
2. **被动 429（即时通道）**：推理请求返回 429 `GoUsageLimitError` + `metadata.limitName`（rolling/weekly/monthly），即时标记对应窗口，填轮询间隔的盲区。
3. **启发式兜底（降级通道）**：`/usage` 不可达时才启用「连续 3 次 429 视为周限 -> 冷却到周一 00:00 UTC」的原始逻辑。

### L3 缓存感知调度（P3）——粘性优先，换 Key 能省则省

**粘性信号（已实测验证）**：ZCode 每个请求头带 `x-session-id`，会话内恒定、跨会话唯一（115 请求全同）。注意 **不能用 `x-query-id`**：它每个用户查询都变（单会话实测 5-6 个），绑它会每轮换 Key、缓存全毁。

1. **会话绑定**：`sessionId -> keyId` 绑定表（持久化）。Key 健康就绝不动绑定 -> 缓存在同一 workspace 持续累积。
2. **新会话分配**：健康 Key 中按「周限额剩余最多优先」排序（用户字面「周限额最少」= 用得最少 = 剩余最多；排序函数可翻转），tiebreak 看 5h 剩余；优先选无在途请求的 Key（并发保护）；全部忙时选「最少在途 + 最多周剩余」。
3. **换 Key 仅三种触发**：当前 Key ① 5h(rolling) 窗口耗尽（预判或 429）② 月限耗尽 -> 隔离 ③ 认证失效(401) -> 隔离。
4. **预切换**：会话下一轮到来前查绑定 Key 的 `/usage` 快照，rolling ≥90%（或 weekly/monthly ≥95%）就在请求发出前迁移，连失败尝试都没有。
5. **缓存收益可观测**：网关记录每响应的 `usage.prompt_tokens_details.cached_tokens`（DeepSeek 隐式缓存命中信号），仪表盘显示每 Key 缓存命中率--同时用于实证 Go 端点是否真有缓存（OpenCode 的 DeepSeek 集成曾有缓存失效 issue #32911）。
6. **无 `x-session-id` 的请求**（其他 agent 直连）：降级为无粘性、按调度逐请求分配（限制说明，写入 README）。

### L4 透明切换（P4）——ZCode 永远只看到「一轮正常回答」

- **硬规则**：Key 切换只发生在**请求边界**（一个请求完成后、下一个开始前），绝不发生在响应流中间。
- **请求内 failover**：Go 限额 429 是预流式完整 JSON 拒绝（非 SSE，实测），网关**缓冲到首字节**再向 ZCode 放行；首字节前遇 429/401/5xx/超时 -> 换下一把健康 Key 原样重放（请求体未消费、429 不耗额度、ZCode 无感知）。
- **无抖动**：5 Key 连同一 host（opencode.ai），连接池/TLS 复用天然共享，换 Key 无网络重建开销。
- **切换后首轮预期**：新 workspace 缓存空 -> 全量重算 -> 首字节慢几秒（「这轮稍慢」，不是断连）；同一模型跨 workspace 输出一致，无内容漂移。
- **全部 Key 耗尽**：如实回 429（附最近恢复时间），ZCode 停止--正确的最终状态，不是抖动。

### L5 resetsAt 精确回收 + Key 状态机（P5）

状态：`active` / `cooldown_rolling`（到 rolling.resetsAt）/ `cooldown_weekly`（到周一 00:00 UTC）/ `quarantined`（月限耗尽或认证失效）/ `invalid`（录入校验 401）。

- 回收是**定时复查**不是重试：调度器在限定窗口 `resetsAt`+ε 触发一次 `/usage` 复查；窗口 ok -> 回 active；仍 limited -> 有界退避再查（+2min、+5min，防时钟偏差/服务器延迟，不成死循环）。
- 周一复查：weekly 恢复但 monthly 仍 rate-limited -> 隔离（用户「下周一不行就抛弃」）。

### L6 隔离与复活（P6）

- 月限耗尽 -> `quarantined`：**不删除**，排除出调度与轮询；记录原因/时间/workspace id/monthly.resetsAt。
- 前端隔离区：「重新激活」按钮 -> 网关调 `/usage` 三态校验（monthly ok 回池 / 仍限提示检查续订 / 401 标失效）+「彻底删除」按钮。
- 可选：每日低频复查隔离 Key，检测到续订自动复活。
- **提示写死在 UI**：月限恢复靠**续订 Go 订阅**（新月周期），充 Zen 余额无效。

### L7 生命周期跟随 ZCode（P7）

复用 DT-MCP v3 模式（本机今日日志仍在正常工作的实证）：

```
ZCode 启动 -> 首会话 -> SessionStart 钩子 -> go-guard.cjs
    ├─ spawn detached 自己 -> 等网关 /health ≤10s -> 钩子返回 0（不阻塞会话）
    ├─ PID 锁单例（后续会话全部屏蔽；owner 死了下个调用接手）
    ├─ 每 5s：ZCode.exe 在 -> 保网关健康（crash 自动拉起）
    └─ ZCode.exe 消失满 60s -> 停网关 -> 释放锁 -> 退出
```

- 网关 boot 顺序：**先监听亮 /health，再后台加载数据**，把「首请求撞冷启动」窗口压到最小。
- 状态全落盘：ZCode 重启后重开同一会话，若 `x-session-id` 跨重启保持，持久化绑定让网关回到原 Key -> **缓存跨重启保留**。

### L8 仪表盘（P8）

- 浏览器打开 `http://127.0.0.1:8788`：顶部 active/cooldown/quarantined/invalid 计数 + 「立即刷新」+ 刷新间隔选择（实时/1h/关）。
- Key 卡片：三档进度条（剩余百分比 + resetsAt 倒计时）、状态徽章、workspace id（同池红标告警）、本会话请求数、**缓存命中率**。
- 会话绑定表（哪个会话粘在哪个 Key）、事件日志（绑定建立/迁移/冷却/回收/隔离/复活/429 failover）。
- 刷新三档全满足：前端 30s 轻量轮询本地状态；后端 15min 拉 `/usage`；按钮强制即时。

## 三、解决方案是什么

### 3.1 总体架构

```
┌─────────┐ OpenAI 协议  ┌────────────────────────────────────────────┐
│  ZCode  │ ───────────▶ │ 本地网关 127.0.0.1:8788（Node，零重依赖）      │
│(provider│              │  ├─ L3 调度：x-session-id 粘性 + 排序 + 并发   │
│ baseURL │              │  ├─ L2 判定：/usage 轮询 + 429 被动 + 兜底     │
│ ->本地)  │              │  ├─ L4 转发：缓冲首字节 + failover + SSE 透传  │
└─────────┘              │  ├─ L5/L6 状态机：冷却/回收/隔离/复活          │
     ▲                   │  ├─ 控制面 API + 静态仪表盘（L8）              │
     │ 浏览器仪表盘        │  └─ keys.json 状态落盘（0600）                │
     └───────────────────┴──────────────────┬─────────────────────────┘
                                  Bearer 各 Key │ 按模型选上游端点
                                   ┌───────────▼───────────┐
                                   │ opencode.ai/zen/go/v1 │
                                   │ /usage /chat/completions │
                                   └───────────────────────┘
生命周期：ZCode SessionStart 钩子 -> go-guard.cjs（单例守护，跟随 ZCode 启停）
```

### 3.2 模块与文件布局

| 文件（均位于本项目根；原 Me 布局 `tools/opencode-go-router/` 前缀已随项目独立化去除） | 职责 |
|---|---|
| `go-gateway.cjs` | 网关本体：转发/调度/状态机/控制面 API/静态前端；暴露 `/health` |
| `go-guard.cjs` | 生命周期守护（照抄 `reference/dt-mcp-watch/dt-guard.cjs` 参数化，端口 8788，锁/日志在 `~/.opencode-go-router/`） |
| `keys.json` | Key、状态、冷却截止、隔离记录、会话绑定表（0600） |
| `README.md` | 部署/复现/回退手册（照 dt-mcp-watch README 结构） |

### 3.3 ZCode 对接（一次性步骤 + 逃生门）

1. 改 `ce6a858a` provider：`baseURL -> http://127.0.0.1:8788/v1`，`apiKey -> 占位符`；模型名不动（MVP 跑 deepseek-v4-flash，走 OpenAI `/chat/completions`，与 provider kind `openai-compatible` 天然匹配）。
2. `~/.zcode/cli/config.json` 的 `hooks.events.SessionStart` 数组**追加**一组 go-guard 钩子（现有 dt-guard 不动）。
3. **逃生门**：ZCode 里另保留一个「OpencodeGo-direct」provider（真实 baseURL + 单把 Key，disabled 常备）--网关彻底故障时手动切换，不至于完全断粮。
4. 网关只绑 127.0.0.1（不出本机）；可选本地 token 校验防本机其他进程白嫖。

### 3.4 技术选型

| 环节 | 选型 | 理由 |
|---|---|---|
| 网关 | Node.js ≥18（本机既有 24）+ 原生 http | 本机既有；流式透传原生支持；零新依赖 |
| 桌面呈现 | 首期浏览器仪表盘 + 桌面快捷方式；后期可选 Electron 薄壳 | 核心价值在路由逻辑；Electron 是呈现层增强 |
| 前端 | 原生单页（HTML/CSS/JS 或 Vue3 CDN） | 无构建链 |
| 存储 | JSON 文件 0600 | 数据量小；SQLite 后期可换 |
| 常驻 | SessionStart 钩子 + go-guard（非计划任务常驻） | 跟随 ZCode，不留孤儿 |
| 端口 | 8788 | 避开 15890/23847/9223/39798 |

### 3.5 分阶段实施

- **Phase 1（MVP）**：网关转发 + 粘性调度 + 三通道判定 + 冷却/回收/隔离 + 简易仪表盘 + go-guard 生命周期；ZCode baseURL 切入，用现有周限 Key + 新增 Key 实测多 Key 轮换。
- **Phase 2**：Electron/托盘桌面化、缓存命中率统计、共享额度检测告警、Anthropic `/messages` 模型（MiniMax/Qwen，参考 opencode-api 转换）、count_tokens 本地化、绑定 TTL、每日隔离复查。
- **Phase 3（可选）**：Key 加密存储（DPAPI）、多 agent 共享（Claude Code/Codex 也指向网关）、least-loaded 调度升级。

### 3.6 待用户确认的决策点（开工前）

1. **5 个 Key 是否来自 5 个独立订阅/workspace？**（P9，最关键--决定轮换是否真翻倍额度；网关会做「三档 percent 完全一致 = 疑似同池」检测 + 429 metadata.workspace 比对告警）
2. **排序方向**：按「周限额剩余最多优先」（本方案默认）vs 用户字面「最少」。排序函数可翻转。
3. **储备策略**：迁移时保留最鲜 Key 作储备、用「第二鲜」（用户原话「倒数第二少」）--是否要。
4. **每 Key 并发上限**默认 1，是否放宽。

### 3.7 开放项与验证清单（第六轮逻辑自查结论）

**设计上已闭环、但需数据/多 Key 才能实证的（实现后第一批验证）：**

| # | 开放项 | 验证方法 |
|---|---|---|
| V1 | failover 成功路径端到端（429 -> 换 Key -> ZCode 无感） | 需 ≥2 把健康 Key；故意先打被限 Key，观察 ZCode 侧零报错 + 切换首轮延迟 |
| V2 | Go 端点对 DeepSeek 是否真有隐式缓存 | 记录 `usage.prompt_tokens_details.cached_tokens`；同会话连续两轮对比（第二轮应非零） |
| V3 | 同 workspace 共享额度检测 | 多 Key 的 /usage 快照三档一致 + 429 `metadata.workspace` 相同比对 |
| V4 | 子智能体（Agent 工具）请求的 header 行为 | 现有日志只有 main/lite 角色；跑一次带子智能体的会话，看子流是否共享父 `x-session-id`（共享=同 Key 同缓存；独立=各自绑 Key，可接受的并行燃烧，必要时用 `x-query-id` 分组归属父 Key） |
| V5 | rolling 窗口 rate-limited 时 resetsAt 的精确语义 | 观测一把被 5h 限的 Key 的 /usage（当前唯一 Key 只被周限挡住，未观测到 rolling 受限样本） |
| V6 | `/usage` 端点稳定性（官方未文档化，issue #18648 曾请求） | 兜底已内置（429 被动 + 启发式）；长期观察 |

**已知并接受的风险：**
- ZCode 版本升级可能改变 header（`x-session-id` 消失/改名）-> 网关降级为无粘性调度 + 日志告警，不致瘫。
- 网关崩溃中断在途流（任何本地代理同理）-> guard 5s 自动拉起 + 状态落盘。
- DeepSeek 峰谷价影响 $12/5h 的实际请求量 -> 日志记录时段供参考，MVP 不做调度。
- resetsAt 含统一毫秒后缀（疑为快照生成时刻截断）-> 视为近似值，+ε 与有界退避复查容忍。

---

## 附：外挂文件索引

| 文件 | 内容 |
|---|---|
| [opencode-go-router-evidence-2026-08-22.md](opencode-go-router-evidence-2026-08-22.md) | 全部实测证据链：API 实测（/usage、429、401、/models）、asar 反编译发现、model-io 日志验证（session-id/query-id/角色）、dt-guard 模式实证、官方文档要点、缓存调研、参考项目清单、五轮迭代记录 |
