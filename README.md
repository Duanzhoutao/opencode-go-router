# OpenCode Go Router

**多 Key 本地路由网关**：一个本机 Node 进程持有多个 OpenCode Go Key，对 OpenAI 兼容的 Agent 客户端（ZCode / OpenCode / Claude Code 生态）呈现为一个普通 `127.0.0.1` provider——按会话粘性 + 限额调度自动选 Key，Key 用尽自动切换/隔离，零依赖、零改造接入。

> ⚠️ 非官方项目，与 opencode.ai 无任何关联。「OpenCode Go」是其付费订阅产品，本仓库只做本地 Key 配额管理。

## 为什么需要它

OpenCode Go 订阅的每个 Key 有 **5 小时滚动 / 每周 / 每月** 三重用量窗口，用满即被上游 429 限流。而 Agent 客户端（如 ZCode）只能配一个固定的 baseURL + 一个 Key：

- 单个 Key 用满 → 请求被 429 拒绝，AI 工具直接不可用；
- 多个 Key 想轮换 → 手工切配置麻烦，且会打断会话的模型缓存；
- 不知道哪个 Key 还有额度 → 全靠猜；
- 多 Key 可能**共享同一个额度池**（同 workspace），轮换无效。

网关把这一切封装掉：客户端只连网关，网关粘住会话、按限额挑选 Key、用尽自动 failover 与隔离，并提供浏览器仪表盘观察所有 Key 的真实用量。

## 特性

- **会话粘性（`x-session-id`）**：同一会话永远走同一 Key，模型上下文缓存不因轮换失效；跨会话自动分配到不同 Key。
- **限额感知调度**：每 15 分钟轮询 `/usage` 三窗口用量（5h 滚动 / 周 / 月，含 `resetsAt`），按「周剩余最多」优先出 Key；窗口将尽（可配置阈值）提前迁移到富余 Key；月限用尽的 Key 自动隔离，月窗重置后自动复活。
- **透明 failover**：上游 429/5xx 时缓冲首字节后自动换下一个可用 Key（failoverChain 兜底），对客户端无感知。
- **空回复重试优化（`retryEmptyResponse`，默认开）**：部分模型端（如 `deepseek-v4-flash-vision-exp`）在长思考后偶发「空回复」——`finish_reason=other` 或直接断流、零正文，客户端会收到空响应且通常不自动重试。网关在收到第一个正文/工具调用前缓冲整条流：若最终是空回复，**零字节**掐断连接，让客户端表现为「连接层失败」并按其网络重试机制自动重发；正常出正文则按序交还思考+正文后直通。已知取舍：缓冲期间思考内容不实时滚动（正文出现时一并显示）；「正文中途截断」不在覆盖范围（改回直通原样透传）。可在设置页关闭后完全透明直通。
- **同池检测**：从 429 响应 metadata 提取 workspace id，同 workspace 的 Key 标记「同池」并告警——提示轮换它们无效。
- **状态机管理**：`active / cooldown_rolling / cooldown_weekly / quarantined / invalid` 五态 + 冷却截止时间，支持手动停用、删除、复活、隔离。
- **浏览器仪表盘**：六视图单页（总览 / Key 管理 / 隔离区 / 会话绑定 / 事件日志 / 设置），暖棕奶油白主题、原生控件主题化、用量进度条三档分色（绿 <90% / 金 ≥90% / 红 ≥100%）。
- **可选本地鉴权**：`localToken` 设置后，转发面与控制面都要求 `Bearer` 头，防止本机其他进程借用网关。
- **每 Key 并发上限**（默认 5）与丢缓存保护。
- **零依赖**：Node 原生 `http/https`，无 `npm install`，无构建链。
- **MOCK 模式**：合成数据覆盖全部状态，前端开发/演示开箱即用。

## 快速开始

### 1. 启动网关

要求：Node.js ≥ 18（作者环境 24）。

```bash
# Linux / macOS
git clone <repo-url>
cd opencode-go-router
node go-gateway.cjs

# Windows（PowerShell 或 cmd 均可）
git clone <repo-url>
cd opencode-go-router
node go-gateway.cjs
```

启动后打开浏览器访问 <http://127.0.0.1:8788>（仪表盘）。

### 2. 录入 OpenCode Go Key

在仪表盘「Key 管理」页粘贴 Key（`sk-...`）与显示名即可；也可用 API：

```bash
curl -s -X POST http://127.0.0.1:8788/api/keys \
  -H "Content-Type: application/json" \
  -d '{"key": "sk-你的GoKey", "label": "主 Key"}'
```

录 Key 时网关会用该 Key 调一次 `https://opencode.ai/zen/go/v1/usage` 做真实校验（401 → 无效 Key；成功 → 录入并带出三窗口用量）。

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

#### ZCode 配置示例（Provider）

编辑 `~/.zcode/v2/config.json`，在 `provider` 对象中加/改一条：

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
- **`apiKey` 是占位符**。网关不关心这里填什么（填任何非空字符串即可），因为真实的 Go Key 由网关内部持有并按调度使用；填 `sk-local-gateway` 是惯例，用来一眼认出「这个 provider 走本地网关」。
- **不需要在客户端里配模型列表**：网关把上游的 `/v1/models` 原样透传，客户端启动探测自动发现模型与思考档位。
- **保留直连逃生门**：建议把原来的直连 provider（`https://opencode.ai/zen/go/v1`）保留一份并置为 disabled，出问题时改回 baseURL 即可秒切。

#### ZCode 的模型选择

在 ZCode 模型列表的 provider 一栏选 `OpenCodeGo`（或对应 id）。模型 id 沿用 Go 套餐模型（如 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` / `ox-alpha-free`），无需额外配置。

## 调度与状态机（半页版）

```
录入 -> active（可用）
  |-- /usage 轮询或 429 触发 --> cooldown_rolling（5h 窗口冷却）
  |---------------------------> cooldown_weekly（周窗口冷却）
  |---------------------------> quarantined（月限隔离，月窗重置自动复活）
  |-- 401/退订 --------------------> invalid（无效，需手动删除）
```

选 Key 优先级：会话已绑定的 Key（粘性）> 周剩余最多 > 同 Key 其他空闲并发 > failover 链兜底。每 Key 并发上限默认 5（可在设置页调 1–8）。详细设计与决策记录见 [docs/plans](docs/plans/)。

## 控制面 API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/status` | 汇总状态 + 同池告警 |
| `GET` | `/api/keys` | Key 列表 + 同池告警 |
| `POST` | `/api/keys` | 录入（`{key, label}`，实时校验） |
| `PATCH` | `/api/keys/{id}` | 改名 / 停用 / 启用 |
| `DELETE` | `/api/keys/{id}` | 删除 |
| `POST` | `/api/keys/{id}/refresh` | 强制刷新用量 |
| `POST` | `/api/keys/refresh-all` | 批量刷新全部可用 Key 用量（跳过隔离/失效） |
| `POST` | `/api/keys/{id}/reactivate` | 手动复活冷却 Key |
| `POST` | `/api/keys/{id}/quarantine` | 手动隔离 |
| `GET` | `/api/sessions` | 会话绑定表 |
| `GET` | `/api/events` | 事件日志 |
| `POST` | `/api/events/clear` | 清空事件日志 |
| `GET` / `PATCH` | `/api/config` | 读/改调度参数（见下） |

`PATCH /api/config` 支持的字段与范围：

| 字段 | 默认 | 范围 |
|---|---|---|
| `pollIntervalMs` | `900000`（15 分钟） | 5–60 分钟 |
| `preSwitchPct` | `90` | 0–100（5h 窗口预切换阈值 %） |
| `preSwitchWeeklyPct` | `95` | 0–100（周窗口预切换阈值 %） |
| `concurrencyPerKey` | `5` | 1–8 |
| `stickyEnabled` | `true` | bool（关掉后粘性按请求重新选 Key） |
| `retryEmptyResponse` | `true` | bool（空回复重试优化，默认开；关闭后完全透明直通） |
| `localToken` | `null` | 字符串 ≥4 字符；设空字符串清除 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GO_PORT` | `8788` | 监听端口（也可 `--port <N>` CLI 参数，优先级：`GO_PORT` > CLI > 默认） |
| `MOCK_MODE`（或 `GO_MOCK_MODE`） | 关 | `1` 开启合成数据模式（不连上游，前端演示/开发） |
| `GO_LOG` | 仅控制台 | 追加写入的日志文件路径 |
| `GO_STATE_DIR` | 脚本所在目录 | 状态目录（`keys.json` 落在此处；演示时指向临时目录可保护真实 Key） |

示例：

```bash
# MOCK 演示（不动真实 keys.json）
MOCK_MODE=1 GO_STATE_DIR=/tmp/mockstate node go-gateway.cjs

# 指定端口与日志
GO_PORT=9000 GO_LOG=~/go.log node go-gateway.cjs
```

## 生命周期守护（可选，go-guard.cjs）

`go-guard.cjs` 让网关跟随 ZCode 启停：ZCode 会话启动时（SessionStart 钩子）自动拉起网关，ZCode 退出满 60 秒自动停网关、释放 PID 锁（单例，PID 锁在 `~/.opencode-go-router/`）。在 `~/.zcode/cli/config.json` 的 `hooks` 块加一条 type=process 的 SessionStart 钩子指向 `go-guard.cjs` 即可（实现参照 `reference/dt-mcp-watch/` 的 v3 模式）。测试环境变量：`GO_GUARD_TEST_ZCODE=1|0`、`GO_GUARD_IDLE_S=5`。

## 安全说明

- **真实 Key 只存运行时**：`keys.json` 写入时 `chmod 0600` 且已 `.gitignore`，任何源码/文档不含真实密钥。
- 网关默认只监听 `127.0.0.1`（本地回环），不暴露局域网。
- 如需防同机其他进程借用，设置 `localToken`（见配置表）；注意设置后客户端 apiKey 也要改成同值。

## 目录结构

```text
.
├── go-gateway.cjs               # 网关本体（转发 + 调度 + 状态机 + 控制面 API + 静态托管，零依赖）
├── go-guard.cjs                 # 生命周期守护（可选，跟随 ZCode 启停）
├── ui/                          # 仪表盘单页（index.html / app.js / style.css，纯原生）
├── docs/
│   ├── plans/                   # 设计决策文档（主方案 / 实测证据 / UI 架构）
│   └── reports/                 # 历史调研
└── reference/dt-mcp-watch/      # 守护模式参考实现（v1/v2/v3 决策记录）
```

## 设计文档

- [主方案（架构/调度逻辑/分期）](docs/plans/opencode-go-key-router-2026-08-22.md)：问题定义、核心逻辑 L1–L8、架构与选型、开放项。
- [实测证据链](docs/plans/opencode-go-router-evidence-2026-08-22.md)：`/usage`/429/401 实测、上游协议、ZCode 请求头实证（粘性键选择依据）。
- [UI 架构（前端/后端规格）](docs/plans/opencode-go-router-ui-architecture-2026-08-22.md)：六视图数据流与 API 契约设计。

## 免责声明

本项目是个人工具，仅做**本地配额管理**：不作任何上游请求代答、不破解/绕过上游限制，正常请求仍受 OpenCode Go 服务条款约束。请合法使用自己的订阅 Key。

## License

[MIT](LICENSE)
