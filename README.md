# OpenCode Go Router
111
**多 Key 本地路由网关**：一个本机 Node 进程持有多个 OpenCode Go Key，对 OpenAI 兼容的 Agent 客户端（ZCode / OpenCode / Claude Code 生态）呈现为一个普通 `127.0.0.1` provider——按会话粘性 + 限额调度自动选 Key，Key 用尽自动切换/隔离，全部不可用时自动走备用通道；也支持把第三方**中转站**（单模型、按额度计费）按模型优先接入，失败自动降级回 Go 池。零依赖、零改造接入。

> ⚠️ 非官方项目，与 opencode.ai 无任何关联。「OpenCode Go」是其付费订阅产品，本仓库只做本地 Key 配额管理。

## 为什么需要它

OpenCode Go 订阅的每个 Key 有 **5 小时滚动 / 每周 / 每月** 三重用量窗口，用满即被上游 429 限流。而 Agent 客户端（如 ZCode）只能配一个固定的 baseURL + 一个 Key：

- 单个 Key 用满 → 请求被 429 拒绝，AI 工具直接不可用；
- 多个 Key 想轮换 → 手工切配置麻烦，且会打断会话的模型缓存；
- 不知道哪个 Key 还有额度 → 全靠猜；
- 多个 Key 可能**共享同一个额度池**（同 workspace），轮换无效。

网关把这一切封装掉：客户端只连网关，网关粘住会话、按限额挑选 Key、用尽自动 failover 与隔离、全池不可用时切备用通道，并提供浏览器仪表盘观察所有 Key 的真实用量。

## 特性

- **会话粘性（`x-session-id`）**：开启粘性且绑定 Key 可用时，同一会话复用该 Key；绑定 Key 不可用时自动迁移。不同会话可能分配到同一 Key，缓存是否命中由上游决定。
- **限额感知调度**：每 15 分钟轮询 `/usage` 三窗口用量（5h 滚动 / 周 / 月，含 `resetsAt`）；会话流量按**月到期优先**（月窗到期未用完的额度随续费作废，先花马上到期的），无会话流量按**最轻松优先**（路由到余量最大的 Key）。
- **透明 failover**：上游 429 实时冷却对应窗口（`limitName` 按关键词归一，5h 窗口上游实际叫 "5 hour"）后缓冲首字节自动换下一个可用 Key（failoverChain 兜底），对客户端无感知。
- **备用通道（通用 OpenAI 协议兜底）**：全部 Go Key 不可用时自动切到任意 OpenAI 兼容上游（默认 DeepSeek 官方，火山方舟等均可），请求模型自动改写、思考强度默认拉满（`reasoning_effort=max`，各厂取值不同，可改或留空交上游默认）；任一 Go Key 恢复立刻切回。DeepSeek 官方可选**余额差值自动计费**（人民币快照差值 + 15 分钟采样 + 关网关补结算），其他端点不计费模式。
- **中转站优先通道（按模型优先路由）**：把第三方中转站（OpenAI 兼容端点，每站常只支持一个模型、按额度计费）按模型**优先**接入——请求模型命中某中转站就先走它（同一模型多站按优先级全序尝试），全部失败才降级回 Go 池，三层级联 = 中转站（优先）→ Go 池（默认）→ 备用通道（兜底）。额度耗尽（402，或 429/403 带 quota/余额关键词）**立即隔离**，识别不了则**连续失败 5 次**自动隔离（成功清零）、隔离后仅手动「重新激活」（先探活，通过才回池）；Go 缺该模型时降级改写为可配的「降级模型」（默认 `deepseek-v4-flash`）；模型名支持映射（应对中转站命名漂移）与**半填半选**（输关键字过滤候选）；仪表盘「使用中」卡片有转圈流光特效。
- **空回复重试优化（`retryEmptyResponse`，默认关）**：上游长思考后偶发零正文空流，客户端会判 `empty_model_response` 且不重试；打开后网关在首个正文字节前缓冲整条流，空回复则零字节掐断连接，触发客户端网络级自动重试（代价：思考不实时滚动）。默认关，需要时设置页打开。
- **同池检测**：从 429 响应 metadata 提取 workspace id，同 workspace 的 Key 标记「同池」并告警——提示轮换它们无效。
- **状态机管理**：`active / cooldown_rolling / cooldown_weekly / quarantined / invalid` 五态 + 冷却截止时间；月限 Key 按重置时钟自动复查回池；支持手动停用、删除、复活、隔离。
- **浏览器仪表盘**：八视图单页（总览 / Key 管理 / 隔离区 / 会话绑定 / 中转站 / 备用通道 / 事件日志 / 设置），总览分「优先通道 · 中转站 / 默认通道 · OpenCode Go」两区，用量条三档分色（绿 <90% / 金 ≥90% / 红 ≥100%），「使用中」卡片转圈流光，事件类型悬停有中文解释。
- **Agent 对接指引**：设置页一段可复制的委派提示词（运行时生成，自动带本机安装目录与端口），发给你的 AI 助手即可代为完成接入。
- **可选本地鉴权**：`localToken` 设置后，转发面与控制面都要求 `Bearer` 头，防止本机其他进程借用网关。
- **每 Key 并发调度阈值**（默认 5）：新会话分配优先挑并发未达阈值的 Key，全部达阈值时放宽到全体（是偏好而非硬上限），另有丢缓存保护。
- **零依赖**：Node 原生 `http/https`，无 `npm install`，无构建链。
- **MOCK 模式**：合成数据覆盖全部状态，前端开发/演示开箱即用。
111
## 交给你的 AI 助手（推荐）

不想手动配？把下面整段复制发给你的编程助手（ZCode / Claude Code / Cursor 等），它会克隆、部署、录 Key、改客户端配置、验证一条龙完成：

```text
你是我的配置助手。请把 OpenCode Go 多 Key 网关部署到我本机，并把我常用的编程助手客户端接入它：
1. 克隆仓库 https://github.com/Duanzhoutao/opencode-go-router 到本机合适的目录，读它的 README.md 与 docs/（入口 docs/README.md）理解运行方式：本地网关 http://127.0.0.1:8788，OpenAI 兼容端点 /v1，零依赖（Node ≥ 18 即可，无需 npm install）。
2. 启动网关（node go-gateway.cjs），向我要至少一把 OpenCode Go Key 并录入（管理页 http://127.0.0.1:8788 或 POST /api/keys），然后验证 /v1/models 与 /v1/chat/completions 真实连通。
3. 找到我编程助手的模型 provider 配置位置（按你的记忆或搜索该客户端文档确定；不确定就记进开场问题一并问我），把模型 baseURL 改为 http://127.0.0.1:8788/v1、apiKey 用占位符 sk-local-gateway；改前先备份配置文件，保留原 provider（设为 disabled）作逃生门。
4. 评估能否给我的客户端配「跟随启动」（如 ZCode 的 SessionStart 钩子，配置见 docs/guard.md）：能则一并配置并验证，不能则说明原因，不硬做。
5. 完成后汇报：改了哪些文件、如何回退、验证结果。
边界：只动模型接入相关配置；动手前把你的完整执行计划（改哪些文件与内容、配置位置的判断依据、是否启用跟随启动、备份与回退方式）一次列清给我确认——只问这一次，确认后连续执行到完成，中途不再逐步征求；事实先检测再下结论，不猜。
```

手动部署见下方快速开始。

## 快速开始

### 1. 启动网关

要求：Node.js ≥ 18（作者环境 24）。

```bash
git clone https://github.com/Duanzhoutao/opencode-go-router.git
cd opencode-go-router
node go-gateway.cjs
```

启动后打开浏览器访问 <http://127.0.0.1:8788>（仪表盘）。想让网关**跟随 ZCode 自动启停**（SessionStart 钩子，无需常驻），见 [docs/guard.md](docs/guard.md)。

### 2. 录入 OpenCode Go Key

在仪表盘「Key 管理」页粘贴 Key（`sk-...`）与显示名即可；也可用 API：

```bash
curl -s -X POST http://127.0.0.1:8788/api/keys \
  -H "Content-Type: application/json" \
  -d '{"key": "sk-你的GoKey", "label": "主 Key"}'
```

录 Key 时网关会用该 Key 调一次上游 `/usage` 做真实校验（401 → 无效 Key；成功 → 录入并带出三窗口用量）。

### 3. 验证网关

```bash
# 模型列表透传（Agent 启动探测用）
curl http://127.0.0.1:8788/v1/models

# 真实对话（OpenAI 协议，支持 SSE 流式）
curl -s http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-session-id: demo-session" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hello"}]}'
```

### 4. 接入 Agent 客户端

对客户端而言，网关就是一个 OpenAI 兼容 endpoint：

| 客户端 | 配置位置 | baseURL | apiKey |
|---|---|---|---|
| **ZCode** | `~/.zcode/v2/config.json` 的 `provider` 块 | `http://127.0.0.1:8788/v1` | 任意占位符（建议 `sk-local-gateway`） |
| **OpenCode**（原生） | `~/.config/opencode/opencode.json` 的 `provider` 块 | `http://127.0.0.1:8788/v1` | 任意占位符（建议 `sk-local-gateway`） |
| 任何 OpenAI 兼容客户端 | baseURL 指向网关 | `http://127.0.0.1:8788/v1` | 任意占位符 |

ZCode 配置示例：

```jsonc
{
  "provider": {
    "opencodego": {
      "name": "OpenCodeGo",
      "options": {
        "baseURL": "http://127.0.0.1:8788/v1",
        "apiKey": "sk-local-gateway"
      }
    }
  }
}
```

要点：

- **`baseURL` 必须以 `/v1` 结尾**——网关在这个后缀上暴露 OpenAI 协议面（`/v1/chat/completions`、`/v1/models`）。
- **`apiKey` 取决于本地鉴权配置**：未设置 localToken 时，可填任意非空占位符；设置后，客户端 `apiKey` 必须填写与 localToken 相同的值。真实 Go Key 由网关内部管理。
- **不需要在客户端里配模型列表**：网关把上游的 `/v1/models` 原样透传，客户端启动探测自动发现模型与思考档位。
- **保留直连逃生门**：建议把原来的直连 provider 保留一份并置为 disabled，出问题时改回 baseURL 即可秒切。
- **MCP 不用动**：网关只代理 LLM 对话 API，MCP server 连接不经网关，详见 [docs/client-integration.md](docs/client-integration.md)。
- 也可以把仪表盘「设置 → Agent 对接指引」的提示词发给你的 AI 助手，让它代为接入。

## 调度与状态机（半页版）

```
录入 -> active（可用）
  |-- /usage 轮询或 429 触发 --> cooldown_rolling（5h 窗口冷却）
  |---------------------------> cooldown_weekly（周窗口冷却）
  |---------------------------> quarantined（月限隔离，月窗重置自动复活）
  |-- 401/退订 --------------------> invalid（无效，需手动删除）

请求(model=M)
  └─ 中转站优先层：命中且 active 的中转站按优先级全序尝试
        └─ 全部失败 / 无匹配
             └─> OpenCode Go 池（粘性 + 到期优先 / 最轻松优先 + failover 链）
                   └─ 全部不可用 ──> 备用通道兜底（启用且配置就绪时）；任一 Key 恢复 ──> 自动切回
```

冷却到窗口 `resetsAt` 过点后由 30 秒看护定向重查即时回池（不等 15 分钟轮询；网关重启后自动补查断开期间过点的 Key）；月限隔离按月窗重置时钟复查回池。

选 Key 优先级：会话已绑定的 Key（粘性）> 会话流量按**月到期优先**（`resetsAt` 近者先，无到期日排最后）/ 无会话流量按**最轻松优先**（5h 余量最大）；429 实时冷却 + failover 链兜底。机制与决策见 [docs/architecture.md](docs/architecture.md)。

## 控制面 API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/status` | 汇总状态 + 同池告警 |
| `GET` | `/api/keys` | Key 列表 + 同池告警 |
| `POST` | `/api/keys` | 录入（`{key, label}`，实时校验） |
| `PATCH` | `/api/keys/{id}` | 改名 / 替换 / 停用 / 启用 |
| `DELETE` | `/api/keys/{id}` | 删除 |
| `POST` | `/api/keys/{id}/refresh` | 强制刷新用量 |
| `POST` | `/api/keys/refresh-all` | 批量刷新全部可用 Key 用量 |
| `POST` | `/api/keys/{id}/reactivate` | 手动复活冷却 Key |
| `POST` | `/api/keys/reactivate-all` | 一键恢复：全部隔离 Key 重查，月窗已恢复自动回池 |
| `POST` | `/api/keys/{id}/quarantine` | 手动隔离 |
| `GET` | `/api/sessions` | 会话绑定表 |
| `GET` | `/api/events` | 事件日志 |
| `POST` | `/api/events/clear` | 清空事件日志 |
| `GET` / `PATCH` | `/api/config` | 读/改调度参数（见下） |
| `GET` / `PATCH` | `/api/fallback` | 读/改备用通道配置（baseURL/模型/Key/计费模式/思考强度） |
| `POST` | `/api/fallback/refresh` | 备用费用「立刻计算」 |
| `POST` | `/api/fallback/test` | 备用通道「测试连接」（支持未保存的候选配置） |
| `GET` | `/api/relays` | 中转站列表（Key 掩码、含 inUse/连败/统计） |
| `POST` | `/api/relays` | 新增中转站（baseURL/Key/模型/优先级，冲突自动挤位） |
| `PATCH` / `DELETE` | `/api/relays/{id}` | 编辑 / 删除中转站 |
| `POST` | `/api/relays/{id}/test` | 中转站「测试连接」（顺带探测模型列表） |
| `POST` | `/api/relays/test` | 未保存候选配置测试 |
| `POST` | `/api/relays/{id}/activate` | 手动复活中转站（先探活，通过才回池） |
| `POST` | `/api/relays/{id}/quarantine` | 手动停用中转站 |
| `POST` | `/api/relays/renumber` | 自动重排优先级 1..N |
| `GET` | `/api/models` | Go 模型列表缓存（中转站模型字段半填半选候选源） |
| `GET` | `/api/guide` | Agent 对接指引提示词（运行时生成） |

`PATCH /api/config` 支持的字段与范围：

| 字段 | 默认 | 范围 |
|---|---|---|
| `pollIntervalMs` | `900000`（15 分钟） | 5–60 分钟 |
| `concurrencyPerKey` | `5` | 1–8 |
| `stickyEnabled` | `true` | bool（关掉后粘性按请求重新选 Key） |
| `retryEmptyResponse` | `false` | bool（空回复重试优化，默认关=完全透明直通；需要时打开） |
| `localToken` | `null` | 字符串 ≥4 字符；设空字符串清除 |

完整 API 说明与示例见 [docs/api.md](docs/api.md)，全部配置（含备用通道八字段、中转站字段）见 [docs/configuration.md](docs/configuration.md)。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GO_PORT` | `8788` | 监听端口（也可 `--port <N>` CLI 参数，优先级：`GO_PORT` > CLI > 默认） |
| `MOCK_MODE`（或 `GO_MOCK_MODE`） | 关 | `1` 开启合成数据模式（不连上游，前端演示/开发） |
| `GO_LOG` | 仅控制台 | 追加写入的日志文件路径 |
| `GO_STATE_DIR` | 脚本所在目录 | 状态目录（`keys.json` 落在此处；演示时指向临时目录可保护真实 Key） |

## 生命周期守护（可选，go-guard.cjs）

`go-guard.cjs` 让网关跟随 ZCode 启停：ZCode 会话启动时（SessionStart 钩子）自动拉起网关，ZCode 退出满 60 秒自动停网关、释放 PID 锁（单例，锁/日志在 `~/.opencode-go-router/`）；网关崩溃自动拉起。钩子配置与排障详见 **[docs/guard.md](docs/guard.md)**（当前实现针对 Windows，其他平台手动启动即可）。

## 安全说明

- **Key 明文落盘**：真实 Key 存放在 `keys.json`（明文 JSON，写入时 `chmod 0600` 且已 `.gitignore`）；文件权限只挡住同机其他用户读取，**不等于加密**。任何源码/文档/日志不含真实密钥，控制面对密钥一律掩码回显。
- 网关默认只监听 `127.0.0.1`（本地回环），不暴露局域网。
- 如需防同机其他进程借用，设置 `localToken`（见配置表）；注意设置后客户端 apiKey 也要改成同值。

## 文档

完整文档在 [`docs/`](docs/README.md)，面向人和 AI 助手、按当前版本实际行为编写：

- [docs/README.md](docs/README.md) — 文档索引与按问题导航
- [architecture.md](docs/architecture.md) — 工作原理：请求生命周期、粘性与缓存、调度、状态机、中转站优先通道、备用通道与计费
- [client-integration.md](docs/client-integration.md) — ZCode / OpenCode / 任意客户端接入 + MCP 说明
- [guard.md](docs/guard.md) — go-guard 钩子机制与跟随启停（配置、单例、排障）
- [configuration.md](docs/configuration.md) — keys.json、运行时配置、备用通道、中转站配置、环境变量
- [api.md](docs/api.md) — 转发面与控制面 HTTP API 参考
- [admin-ui.md](docs/admin-ui.md) — 仪表盘八视图与事件类型表
- [faq.md](docs/faq.md) — 常见问题（钩子、MCP、429/隔离、空回复、中转站、计费）

## 目录结构

```text
.
├── go-gateway.cjs               # 网关本体（转发 + 调度 + 状态机 + 控制面 API + 静态托管，零依赖）
├── go-guard.cjs                 # 生命周期守护（可选，跟随 ZCode 启停）
├── ui/                          # 仪表盘单页（index.html / app.js / style.css，纯原生）
├── docs/                        # 指南文档（架构 / 接入 / 守护 / 配置 / API / 仪表盘 / FAQ）
└── reference/dt-mcp-watch/      # go-guard 的守护模式母本（v1/v2/v3 决策记录）
```

## 免责声明

本项目是个人工具，仅做**本地配额管理**：不作任何上游请求代答、不破解/绕过上游限制，正常请求仍受 OpenCode Go 服务条款约束。请合法使用自己的订阅 Key。

## License

[MIT](LICENSE)
