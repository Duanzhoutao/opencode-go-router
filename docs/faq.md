# 常见问题（FAQ）

按「用户实际会问的问题」组织；机制细节链接到对应文档。

## 网关怎么跟随 ZCode 自动启动和关闭？

装一个 SessionStart 钩子即可（一次性配置）：ZCode 启动时钩子拉起 `go-guard.cjs`，守护负责保活网关；ZCode 退出满 60 秒后守护自动停网关、释放锁并退出。完整配置与排障见 [guard.md](guard.md)。不想要跟随启停就手动 `node go-gateway.cjs`，二者互不冲突。

## 钩子机制怎么启动？为什么我的钩子不生效？

钩子在 `~/.zcode/cli/config.json` 的 `hooks` 块配置，三个最常见的失效原因：

1. **`hooks.enabled` 没有设为 `true`**——配置文件里的钩子默认禁用，必须显式开启；
2. JSON 语法错误或 `args` 里的脚本绝对路径不对（用正斜杠 `/`）；
3. 找错了配置文件——钩子在 `~/.zcode/cli/config.json`，客户端 provider 在 `~/.zcode/v2/config.json`，是两份文件。

排查先看 `~/.opencode-go-router/go-guard.log` 有没有触发记录。完整配置示例见 [guard.md](guard.md)。

## MCP 需要改配置吗？网关影响 MCP 吗？

**不需要，也不影响。** 网关只代理 LLM 对话 API（`/v1/chat/completions`、`/v1/models`）；MCP server 与客户端之间的连接（stdio / http）不经过网关，一行配置都不用动。MCP 工具调用中「模型决定调用工具」的那段输出流经网关透传，网关不解析不修改。工具相关请求失败时：先看仪表盘事件日志有无 `failover` / `empty-stream` / `exhausted`，再对照直连上游是否同样失败，最后才查 MCP server 本身。详见 [client-integration.md](client-integration.md)。

## 收到 429 / Key 进了冷却或隔离，是什么意思？

- **429**：上游限流，对应某个用量窗口打满。网关会自动 failover 到其他可用 Key。
- **冷却（cooldown_rolling / cooldown_weekly）**：5h 滚动或周窗口打满，到点自动恢复，无需干预。
- **隔离（quarantined）**：月窗口耗尽（月窗重置后网关按 `resetsAt` 时钟自动复查回池），或手动停用。
- 隔离区「一键恢复」会实时重查全部隔离 Key，月窗已恢复的自动放回；月窗没恢复不会放（放回去也是立刻 429）。
- **invalid**：Key 认证失效（401/退订），只能删除重录。

## 「空回复」是什么？网关做了什么？

上游模型偶发长思考后返回空正文（`finish_reason=other` 或断流），客户端（含 ZCode）会判 `empty_model_response` 且不重试。网关默认开启 `retryEmptyResponse`：首个正文字节前缓冲整条流，空回复则零字节掐断连接，让客户端按「连接失败」自动重试；正常出正文则按序交还后直通。代价是缓冲期间思考不实时滚动。可在设置页关闭（回到完全透明直通）。事件日志里对应 `empty-stream`。

## 仪表盘提示「同池」是什么意思？

多把 Key 解析出同一个 workspace id——它们共享同一个额度池，轮换等于没换。该提示只是告警，网关照常工作；解法是换不同 workspace（不同订阅）的 Key。

## 备用通道什么时候切过去？什么时候切回来？

- **切过去**：三窗口语义下没有任何可用 Go Key（全部冷却/隔离，且没有手动停用之外可恢复的候选），且备用通道已启用并配置就绪。
- **切回来**：任何一把 Go Key 恢复可用（窗口重置自动复查、轮询发现、手动恢复）——下一个请求立刻回 Go，不多花一分钱。
- 详见 [architecture.md](architecture.md)。

## 备用通道的花费怎么算？为什么我的端点显示不了余额？

- `billingMode=balance`（DeepSeek 官方）：金额唯一口径是 `/user/balance` 余额快照差值（人民币），切进/切回自动快照 + 15 分钟采样 + 「立刻计算」按钮；网关关闭时有未结算周期，下次启动自动补结算。
- 其他 OpenAI 兼容端点（火山方舟等）没有这个余额接口，选 `billingMode=none`：不计费、不显示费用区，功能不受影响——「不支持就不计费」是设计行为，不是故障。

## 「缓存命中 636 次」是什么意思？

该 Key 上「有缓存收益、且未因 Key 切换丢缓存」的请求次数。网关用 `x-session-id` 把同一会话粘在同一把 Key 上，上下文缓存不因轮换失效——这个计数就是粘性带来的缓存收益量化。它**不是**缓存 token 量。

## 我的 Key 安全吗？

- 真实 Key 只存在运行时 `keys.json`（0600 权限、原子写、已 gitignore），任何源码/文档/提交不含真实密钥；
- 网关只监听 `127.0.0.1`，不暴露局域网；
- 控制面对 `localToken` 与备用通道 Key 一律掩码回显；
- 想防同机其他进程借用，设置 `localToken`（见 [configuration.md](configuration.md)）。

## 支持什么平台和客户端？需要装依赖吗？

- **零依赖**：Node.js ≥ 18 即可（无需 `npm install`）。
- **网关本体**跨平台（Windows / macOS / Linux）。**go-guard 跟随启停**当前为 Windows 实现（tasklist + PowerShell 7），其他平台手动启动网关或按 [guard.md](guard.md) 的平台说明适配。
- 客户端：任何 OpenAI 兼容客户端（ZCode / OpenCode / Claude Code 生态 / SDK / curl），见 [client-integration.md](client-integration.md)。

## 想完全手动管理（不用守护）怎么启停？

```bash
node go-gateway.cjs        # 启动（前台；Ctrl+C 停）
# 或后台常驻：用系统服务管理器（systemd / launchd / 计划任务）包一层
```

装过钩子又想临时手动控制：手动启动的网关守护也会监测到并保活；彻底不用守护就移除钩子配置。
