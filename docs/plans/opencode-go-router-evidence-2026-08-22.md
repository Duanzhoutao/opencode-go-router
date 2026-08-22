# OpenCode Go 路由方案 -- 实测证据链（外挂）

日期：2026-08-22（六轮探索汇总）。主方案：[opencode-go-key-router-2026-08-22.md](opencode-go-key-router-2026-08-22.md)
本文只放证据与调研细节；设计结论一律以主方案为准。所有「实测」均为本机 A 级证据，标注探测时间。

## 1. OpenCode Go API 实测（探测时间 2026-08-22 UTC 约 08:4x，Key：ZCode config `ce6a858a` 的 `sk-wfj0...`，当时已周限额）

### 1.1 `GET /zen/go/v1/usage`（公开、未文档化的用量查询接口）

- Bearer 即 Go 套餐 Key，**无需签名**。响应：

```json
{"usage":{
  "rolling":  {"status":"ok",          "percent":0,   "resetsAt":"2026-08-22T09:43:20.483Z"},
  "weekly":   {"status":"rate-limited","percent":100, "resetsAt":"2026-08-24T00:00:00.483Z"},
  "monthly":  {"status":"ok",          "percent":50,  "resetsAt":"2026-09-19T11:08:00.483Z"}}}
```

- `rolling`=5h 窗口、`weekly`=周窗口（resetsAt 实测=周一 00:00 UTC，2026-08-24 是周一）、`monthly`=月窗口（=订阅续费日 09-19）。
- 三个 resetsAt 都带统一 `.483` 毫秒后缀 -> 疑为快照生成时刻截断，视为近似值。
- 无效 Key -> `401 {"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}`；无 Key -> `401 "Missing API key."` -> 录入校验就用它。
- 官方未文档化（anomalyco/opencode issue #18648 请求过此能力，已关闭）；VSCode 扩展 opencode-zen-copilot 已在用（其 changelog 明确写 "fetches real account data from `/usage` endpoint"）。

### 1.2 推理 429 错误形态

`POST /zen/go/v1/chat/completions`（tiny 请求）：

```json
HTTP 429  Content-Type: text/plain;charset=UTF-8  Retry-After: 155754
{"type":"error","error":{"type":"GoUsageLimitError",
  "message":"Weekly usage limit reached. Resets in 1 day. ...",
  "metadata":{"workspace":"wrk_01KKZMHM676M3CWS8ZDFJ75EFG","limitName":"weekly"}}}
```

- **预流式完整 JSON 拒绝（非 SSE）** -> 网关可在首字节前透明换 Key 重放（L4 的依据）。
- `metadata.limitName` 精确标识窗口；`metadata.workspace` 给出工作区 ID（共享额度检测信号）。

### 1.3 端点矩阵

| 端点 | 无 Key | 无效 Key | 有效 Key |
|---|---|---|---|
| `GET /zen/go/v1/models` | 200（28 模型，公开无鉴权） | 200 | 200 |
| `GET /zen/go/v1/usage` | 401 Missing API key | 401 AuthError Unauthorized | 200 三窗口数据 |
| `POST /zen/go/v1/chat/completions` | 401 | 401 | 正常 / 429 |

- 其余 `usage` 同级路径（quota/balance/me/plan/credits/account/subscription/limits/status）全部 404。
- 模型 -> 端点映射（官方 docs/go Endpoints 表）：DeepSeek/GLM/Kimi/MiMo/Hy3/Ox -> `/chat/completions`（OpenAI，Bearer）；MiniMax/Qwen 系 -> `/messages`（Anthropic，**只认 x-api-key 不认 Bearer**，2026-08-04 报告实测）；Grok/GPT -> `/responses`。
- `/zen/go/v1/messages/count_tokens` 404（路由不存在）-> Anthropic 路径需 count_tokens 本地化（Phase 2）。

### 1.4 额度机制（官方 opencode.ai/docs/go + 多方交叉）

- 三道限额：5 小时 $12 / 每周 $30 / 每月 $60，按美元等价用量计（非次数）。
- DeepSeek V4 Pro/Flash 月限额已降 **$15**（2026-08-17 涨价后），且分峰谷价（Peak 01:00-04:00 & 06:00-10:00 UTC）。
- 每工作区仅一位成员可订阅 Go；**限额绑定订阅 workspace，同 workspace 多 Key 共享额度**（pi-opencode-go-rotation README 明确警示 + 官方文档「仅一成员可订阅」佐证）。
- 续订 vs 充值：续订 Go 订阅 = 新月周期重置月窗；充 Zen 余额是独立按量钱包，不重置 $60、不延期（2026-08-21 记忆 opencode-go-billing-credits，官方 docs/go "Usage beyond limits"）。

## 2. ZCode 密钥机制实测（asar 反编译 + config + 日志，2026-08-22）

- Key 存放：`~/.zcode/v2/config.json` 的 `provider.<id>.options.apiKey`（OpencodeGo provider `ce6a858a`，kind=openai-compatible，baseURL `https://opencode.ai/zen/go/v1`，模型 deepseek-v4-flash / deepseek-v4-flash-vision-exp / ox-alpha-free）。
- Key 解析：Vercel AI SDK `loadApiKey`（provider 构造时 apiKey -> 环境变量兜底），此后固化进 provider 实例。
- asar（ZCode 安装目录的 `resources/app.asar`，294MB）反编译结论：
  - `reloadConfig` / config watcher：**0 匹配**（无配置热重载）；
  - `{env:}` / `{file:}` 配置模板展开：**不存在**（匹配全是 JS 噪声：WASM env、PowerShell `${env:...}`、File 对象）；
  - `customCa`：memoize 库示例代码的误报；`allowInsecureHttp` 只用于火山 V4 请求签名；
  - `.zcode/v2/certs/` 有 `zcode-network-ca.pem/key`（ZCode 自有 CA，非用户可配钩子）。
  - -> **改 config 换 Key 不生效；MITM/hosts 零改配置路线不成立。**
- 认证头构造：OpenAI 路径 `Authorization: Bearer ${key}`；Anthropic 路径 `{Authorization: Bearer, x-api-key}`（`buildAnthropicConnectivityAuthHeaders`）。
- 凭据存储：`~/.zcode/v2/credentials.json`（enc:v1 加密的 oauth token 类，与本方案无关）。

## 3. ZCode 请求头实证（model-io 日志，2026-08-22）

日志：`~/.zcode/cli/rollout/model-io-sess_*.jsonl`（两个会话文件）。

| 信号 | 实测 | 路由含义 |
|---|---|---|
| `x-session-id` | 会话内恒定（115 请求全同；且=日志文件名）；跨会话唯一（两会话互异）；`role=lite`（标题请求）同带 | **粘性绑定键**（L3） |
| `x-query-id` | 每用户查询变化（单会话 5-6 个） | **不能**作绑定键（会每轮换 Key 毁缓存）；子智能体归属分组的候选信号（待 V4 验证） |
| `x-request-id` | 每请求唯一 | 转发上游便于审计 |
| 角色 | 两日志仅 `main`（183）与 `lite`（1），无子智能体样本 | V4 待验证 |

## 4. 生命周期模式实证（dt-guard，2026-08-22 当日日志）

`~/.desktop-touch-mcp/dt-guard.log` 尾部（当日完整循环）：

```
2026-08-22T04:32:01Z zcode gone 60s -> stop engine, release lock, exit
2026-08-22T04:42:17Z hook: detached guard spawned
2026-08-22T04:42:17Z owner acquired pid=8464 (idle-exit 60s)
2026-08-22T04:42:17Z engine down -> starting
2026-08-22T04:42:32Z engine healthy
```

- 模式（`reference/dt-mcp-watch/dt-guard.cjs` + `README.md` v3 定稿；原 Me 位置 `tools/dt-mcp-watch/`）：SessionStart 钩子（`~/.zcode/cli/config.json` 的 `hooks.events.SessionStart`，type:process，node.exe + 脚本，timeoutMs 20000）-> 自守护化 spawn detached -> PID 锁单例（陈旧锁接管）-> 5s 轮询 ZCode.exe（tasklist）-> 消失 60s 停服务释放锁。
- 历史决策（README）：v1 计划任务常驻 watcher 被否（~55MB 永久后台）；v2 每会话 stdio owner 被否（5 会话 ~520MB）；v3 钩子+guard 采纳。
- 网关照抄 v3，参数化成 `go-guard.cjs`（端口 8788、锁/日志 `~/.opencode-go-router/`、`GO_GUARD_TEST_ZCODE`/`GO_GUARD_IDLE_S` 测试变量）。

## 5. 缓存机制调研（2026-08-22，Tavily）

- DeepSeek 为**隐式缓存**（自动前缀缓存，无需 cache_control；ZenMux/OpenRouter 文档口径），命中信号 = `usage.prompt_tokens_details.cached_tokens`。
- **反例警示**：anomalyco/opencode issue #32911「Deepseek API burning too many tokens」--OpenCode 的 DeepSeek 集成曾出现零缓存（无 cache read 字段、轮间无节省），疑为未正确传递缓存语义。-> **Go 端点对 DeepSeek 是否有缓存必须实测（V2），粘性设计在有无缓存两种情况下都不亏**。
- Anthropic 侧提示词缓存为显式（cache_control ephemeral）；ZCode 在 anthropic-protocol provider 上带 cacheControl（记忆 zcode-agent-loop-organization，实测 cache_read 可达 56320）。

## 6. 参考项目（均公开，逻辑可借鉴）

| 项目 | 形态 | 借鉴点 |
|---|---|---|
| `lnilluv/pi-opencode-go-rotation` | pi 扩展 | 429->查 /usage->封禁到 resetsAt->轮换的完整逻辑；workspace 共享额度警示；keys.json 0600 |
| `Ruinique/opencode-go-dashboard` | Cloudflare Workers 面板 | 多账号 Rolling/Weekly/Monthly 展示（用 Auth Cookie 抓控制台，非 /usage） |
| `SantiagoRomanChillon/opencode-zen-copilot` | VSCode 扩展 | 用 `/usage` 端点做用量面板（端点可用性的旁证） |
| `ChineseFirstKeng/opencode-api` | npm 转换代理 | Anthropic<->Go 格式转换、/messages 路由（Phase 2 参考） |
| `routatic/proxy` | 多上游代理 | Claude Code<->OpenCode 多上游转发 |
| zhihu「OpenCode Go Manager v1.3.0」 | 本地托盘多账号管理器 | 桌面形态参照（细节未深挖） |

## 7. 五轮迭代记录（摘要，全文见 git 前历史与 PROJECT_STATUS.md）

1. **第一轮**：/usage 端点发现 + 三窗口判定 + 网关架构初版（round-robin）。
2. **第二轮**：ZCode Key 固化实证 -> 网关成为唯一路径；`x-session-id` 发现 -> 粘性路由取代 round-robin（用户提出缓存命中率问题）。
3. **第三轮**：透明切换（请求边界 + 缓冲首字节 + 预切换；429 预流式实测支撑）。
4. **第四轮**：月限隔离区 + 复活流程（用户提出不硬删、充值后放回）。
5. **第五轮**：生命周期跟随 ZCode（复用 dt-guard v3）。
6. **第六轮（本轮）**：x-query-id 语义验证（绑定键必须是 session-id）、dt-guard 当日运行实证、DeepSeek 隐式缓存调研 + issue #32911 反例、全设计逻辑自查（主方案 §3.7 开放项清单）。

## 8. 复现命令（关键探测）

```bash
# 用量查询（Bearer = Go Key）
curl -s "https://opencode.ai/zen/go/v1/usage" -H "Authorization: Bearer sk-..."
# 触发限额错误（观察 limitName / 预流式 JSON）
curl -s -w "\n[HTTP %{http_code}]\n" "https://opencode.ai/zen/go/v1/chat/completions" \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
# 模型列表（公开无鉴权）
curl -s "https://opencode.ai/zen/go/v1/models"
```

探测脚本产物在 `%TEMP%\zcode\opencode-go-router\`（probe_*.json，可删）。
