# 配置参考

配置分四层：**环境变量**（启动时）→ **运行时配置**（仪表盘设置页 / `PATCH /api/config`，持久化进 keys.json）→ **备用通道配置**（备用通道视图 / `PATCH /api/fallback`）→ **keys.json 本体**（运行态，一般不手改）。

## 环境变量（启动网关时）

| 变量 | 默认 | 说明 |
|---|---|---|
| `GO_PORT` | `8788` | 监听端口（也可 `--port <N>` CLI 参数；优先级 `GO_PORT` > CLI > 默认） |
| `MOCK_MODE`（或 `GO_MOCK_MODE`） | 关 | `1` 开启合成数据模式：不连上游，全部状态可模拟，前端开发/演示用 |
| `GO_LOG` | 仅控制台 | 追加写入的日志文件路径 |
| `GO_STATE_DIR` | 脚本所在目录 | 状态目录（`keys.json` 落在此处；演示时指向临时目录可保护真实 Key） |

go-guard 专属（测试用）：`GO_GUARD_TEST_ZCODE=1|0` 伪造 ZCode 存在与否、`GO_GUARD_IDLE_S=<秒>` 缩短空闲退出时间，见 [guard.md](guard.md)。

```bash
# MOCK 演示（不动真实 keys.json）
MOCK_MODE=1 GO_STATE_DIR=/tmp/mockstate node go-gateway.cjs

# 指定端口与日志
GO_PORT=9000 GO_LOG=~/go.log node go-gateway.cjs
```

## 运行时配置（设置页 / `PATCH /api/config`）

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `pollIntervalMs` | `900000`（15 分钟） | 5–60 分钟 | `/usage` 三窗口用量轮询间隔 |
| `concurrencyPerKey` | `5` | 1–8 | 每 Key 并发上限；满载时调度放宽（不拒绝请求） |
| `stickyEnabled` | `true` | bool | 会话粘性开关；关闭后每个请求重新调度（缓存收益丢失） |
| `retryEmptyResponse` | `false` | bool | 空回复重试优化（见 architecture.md）；默认完全透明直通，需要时打开 |
| `localToken` | `null` | 字符串 ≥4 字符 | 本地鉴权：设置后转发面与控制面都要求 `Bearer` 头（`/health` 除外）；设空字符串清除。注意客户端 apiKey 需同步改 |

## 备用通道配置（备用通道视图 / `PATCH /api/fallback`）

备用通道 = 一个**通用 OpenAI 协议上游**。Go 的 Key 全部不可用时自动接管、任一 Key 恢复自动切回，机制见 [architecture.md](architecture.md)。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 启用开关（关 = 不兜底，无可用 Key 时如实回 429） |
| `label` | `官方 DeepSeek` | 显示名 |
| `baseURL` | 空 | **留空回退 DeepSeek 官方** `https://api.deepseek.com`；可填任何 OpenAI 兼容端点（火山方舟等） |
| `apiKey` | `null` | 备用上游的 API Key，前端填写保存；控制面回读一律掩码 `(set)`，代码不写死任何 Key |
| `model` | `deepseek-v4-flash-vision-exp` | 兜底时请求模型**一律改写**为该值 |
| `reasoningEffort` | `max` | 思考强度：注入备用请求体的 `reasoning_effort` 字段。各厂取值映射不同（DeepSeek 官方 `low`/`high`/`max`，拉满用 `max`；其他厂可能是 `xhigh`/`Ultra` 等，照其文档填）；留空 = 不注入（客户端若传了该字段则透传），交给上游默认 |
| `billingMode` | `balance` | `balance` = DeepSeek 官方余额差值自动计费；`none` = 不计费（其他端点用） |
| `balanceSampleMs` | `900000`（15 分钟） | 余额采样间隔（仅 balance 模式） |

- **测试连接**：备用通道视图的「测试连接」按钮（`POST /api/fallback/test`）用当前表单值（无需先保存）发起一次最小对话 + 余额探测，回报可达性与计费能力。
- **计费口径**（balance 模式）：人民币，唯一金额口径 = `/user/balance` 余额快照差值（切进/切回自动快照 + 定时采样 + 「立刻计算」按钮；网关关闭期间的未结算周期在下次启动自动补结算）。

## 中转站优先通道配置（中转站视图 / `PATCH /api/relays`）

中转站 = **按模型优先路由**的通用 OpenAI 上游（每站常单模型、按额度计费），机制见 [architecture.md](architecture.md)。与备用通道的区别：备用通道只在 Go 全不可用时兜底，中转站则在请求最前面**优先**服务匹配的模型。

| 字段 | 说明 |
|---|---|
| `label` | 显示名 |
| `baseURL` | OpenAI 兼容端点，`http(s)://` 开头（如中转站给的 `/v1`） |
| `apiKey` | 该中转站的 API Key，前端填写保存；控制面回读一律掩码 `(set)` |
| `model` | 中转站侧模型名（实际发给它的） |
| `goModel` | Go 侧模型名（客户端请求名，用于匹配；**留空 = 同 `model`**）——应对中转站命名漂移（大小写不一等） |
| `downgradeModel` | 降级模型（默认 `deepseek-v4-flash`）：仅当 `goModel` 不在 Go 模型列表时，降级请求改写为该模型 |
| `priority` | 优先级（全局唯一正整数，1 最优先）。冲突自动挤位；新增默认队尾；「自动重排」重编 1..N |
| `enabled` | 手动启停（关 = 不参与调度，区别于隔离） |

- **三个模型字段（model / goModel / downgradeModel）半填半选**：输入关键字实时过滤候选（Go 字段候选 = 网关缓存的 Go 模型列表；中转站字段候选 = 「测试连接」顺带探测的该站 `GET /models`），也允许纯手填。
- **测试连接**（`POST /api/relays/:id/test` 或未保存候选 `POST /api/relays/test`）：最小对话探活 + 探测该站模型列表，回报可达性与候选。
- **隔离与复活**：额度耗尽（402，或 429/403 + 额度关键词）立即隔离；识别不了则连续失败 5 次隔离（成功清零）；401 立即隔离。隔离后**仅手动**「重新激活」（先探活，通过才回池，连败清零）——中转站额度用完不会自己回来，不做自动复查。
- 运行参数：`config.relay.enabled`（总开关）+ `config.relay.headerTimeoutMs`（前置尝试响应头超时，默认 30s，设置页可调 5–120s）。

## keys.json（运行态文件）

- 位置：脚本目录 `keys.json`（`GO_STATE_DIR` 重定位）；`chmod 0600`，原子写，已 `.gitignore`。
- 内容：`config`（上述全部配置含 fallback/relay）、`keys`（Key 与三窗口状态、隔离记录）、`relays`（中转站台账）、`goModels`（Go 模型列表缓存）、`sessions`（会话绑定表）、`events`（事件日志）、`fallbackState`（备用通道快照/采样/结算）。
- 一般通过 UI 或 API 修改；手工编辑需先停网关（启动时会做旧字段迁移清理）。
- **真实 Key 只存在于此文件**，备份/迁移机器时注意权限。

## 安全清单

- 网关只监听 `127.0.0.1`，不暴露局域网。
- `keys.json` 0600 权限；真实 Key 不进任何源码/文档/提交。
- 防同机进程借用：设 `localToken`（转发面+控制面都要 Bearer）。
- 备用通道 Key、中转站 Key 与 `localToken` 在控制面一律掩码回显。
