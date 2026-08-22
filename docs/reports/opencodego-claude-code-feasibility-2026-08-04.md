# OpenCode Go 套餐接入 Claude Code 可行性调研(2026-08-04)

状态:可行性调研(未购买套餐),全部结论基于公开文档、端点无 key 探测与本机 Claude Code 2.1.219 实测。

## 一、OpenCode Go 是什么

- opencode.ai 的包月订阅:首月 $5,之后 $10/月;额度按美元等价用量计:5 小时 $12、每周 $30、每月 $60,超限后回退 Zen 余额。
- 无 key 探测 `/zen/go/v1/models`(HTTP 200,无需认证)确认当前模型清单:deepseek-v4-pro / flash、kimi-k3 / k2.7-code / k2.6 / k2.5、glm-5.2 / 5.1 / 5、qwen3.8-max / 3.7-max / 3.7-plus / 3.6-plus / 3.5-plus、minimax-m3 / m2.7 / m2.5、mimo-v2 系列、hy3、gpt-5.6-luna、grok-4.5 等(25+ 个)。
- 协议:同一 base URL `https://opencode.ai/zen/go` 下按模型路由——大部分模型走 OpenAI 格式 `/chat/completions`(Bearer 认证);部分模型(qwen3.7-max、minimax 系列)走 Anthropic 原生 `/v1/messages`(x-api-key 认证,用 chat/completions 调 qwen3.7-max 会被拒)。
- Zen(`/zen/v1`)是另一套按量付费服务,含 Anthropic 全家(claude-fable-5 等),与 Go 套餐不同,不在本次范围。

## 二、问题一:内置 WebSearch——禁用实测(结论:可禁用,且比"偷偷更换"简单可靠)

### 背景

官方文档称非 Anthropic 端点会自动隐藏 WebSearch,但本机实测不成立:DeepSeek 直连(api.deepseek.com/anthropic)下模型工具列表里 WebSearch 仍存在,调用被拒——与 [cc-switch issue #2570](https://github.com/farion1231/cc-switch/issues/2570) 描述的现象一致。这正是用户"每次 Claude 都尝试原生搜索"的原因。

### 本机实测(Claude Code 2.1.219,同一探针 prompt,三种机制逐一验证)

| 机制 | 配置位置 | 实测结果 |
|---|---|---|
| `disabledBuiltinTools` | `~/.claude/settings.json` 顶层数组 | ✅ WebSearch 从工具列表消失 |
| `permissions.deny` | settings.json 的 `permissions.deny: ["WebSearch"]` | ✅ 消失 |
| `--disallowedTools WebSearch` | CLI 标志 | ✅ 消失 |

三种机制下模型均自动转用 `mcp__web-search__tavily_*` MCP 工具 + WebFetch 兜底。2.1.219 二进制内 `disabledBuiltinTools`、`disallowedTools`、`web_search_20250305`、`isFirstPartyAnthropicBaseUrl` 字符串均存在(后两个证实 WebSearch 是发往 `ANTHROPIC_BASE_URL` 的服务端工具 `web_search_20250305`)。

### "偷偷更换"可行性

- **MCP 层面:不可行**。内置 WebSearch 不是 MCP server,无法在 MCP 注册表层面替换。
- **代理层面:可行**。WebSearch 是模型发出 `web_search_20250305` 工具调用、由 API 服务端执行(智谱兼容层就是这么做的)。本地代理可拦截该工具调用、用 Tavily 结果回填 tool_result——用户有 cc-switch 自定义构建经验,技术上完全可做,但需要维护一个常驻代理。
- **结论**:既然 settings 一行禁用实测生效、Tavily MCP 已经就位,推荐禁用方案;"偷偷更换"仅当希望模型保留原生搜索语义时才有价值,且必须落在代理层。
- 附带影响:禁用后 `research` skill 中"原生搜索 + Tavily 双源"的"原生搜索"一源消失,需把 skill 的 collect 步骤改为单源 Tavily(待用户确认后改)。

## 三、问题二:Anthropic 消息格式与 count_tokens(结论:会再次发生,但可低成本修复)

### 无 key 端点探测(HTTP 状态码即证据)

| 端点 | 探测结果 |
|---|---|
| `POST /zen/go/v1/messages/count_tokens?beta=true`(+ token-counting-2024-11-01 头) | **404,路由不存在** |
| `POST /zen/go/v1/messages/count_tokens`(无 beta 参数) | **404** |
| `POST /zen/go/v1/messages`(x-api-key: fake) | 401 `{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}`——路由存在、Anthropic 错误格式 |
| `POST /zen/go/v1/messages`(Authorization: Bearer fake) | 401 `"Missing API key."`——**不认 Bearer,只认 x-api-key** |
| `GET /zen/go/v1/models` | 200,无 key 即可列出全部模型 |

二进制证据(2.1.219):`POST /v1/messages/count_tokens?beta=true` + `anthropic-beta: token-counting-2024-11-01`、`count_tokens_unreachable` 错误态均存在;结合此前 2.1.205 抓包诊断([2026-07-14 报告](claude-desktop-cc-switch-session-replay-diagnosis-2026-07-14.md)),count_tokens 失败后 Claude Code 走 `messages.create({max_tokens:1})` 降级并只读 `usage.input_tokens`。

**结论:接入 OpenCode Go 后 count_tokens 降级会再次发生**。每次降级 = 一次全上下文输入计费调用(Claude Code 系统提示约 2-3 万 token),在 $60/月等价额度里占几个百分点(有缓存时小一个数量级),不是致命但会持续烧额度。

### 其余字段适配

- **usage 字段**:opencode-api 转换代理([ChineseFirstKeng/opencode-api](https://github.com/ChineseFirstKeng/opencode-api))的 stream.ts/translate.ts 已正确把 OpenAI 的 `prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens` 映射为 Anthropic 的 `input_tokens/output_tokens/cache_read_input_tokens`——**usage 字段问题不会发生**(前提:走这个代理)。
- **认证**:直连必须用 `ANTHROPIC_API_KEY`(→ x-api-key),不能用 `ANTHROPIC_AUTH_TOKEN`(→ Bearer,go 端点不认);走 opencode-api 代理则 AUTH_TOKEN 可用(代理转成 x-api-key,README 明确说明)。
- **流式/工具调用/缓存**:直连 /messages 路径未验证(需真实 key);opencode-api 代理有 stream.ts,社区反馈工具调用可用但各模型一致性参差,需按模型实测。

## 四、推荐接入架构(按优先级)

1. **WebSearch 禁用(现在就能做,与套餐无关)**:`~/.claude/settings.json` 加 `"disabledBuiltinTools": ["WebSearch"]`(保守可连 WebFetch 一起),或 `"permissions": {"deny": ["WebSearch"]}`。已实测。
2. **本地转换代理 + count_tokens 本地估算路由**:fork opencode-api(或自写小代理),补 `POST /v1/messages/count_tokens` 返回本地保守估算——完全复用 [cc-switch 3.17.0 local-count-tokens 修复](claude-desktop-cc-switch-session-replay-diagnosis-2026-07-14.md) 的成熟模式,零上游调用、零额度消耗。这样 deepseek-v4-flash 等全部模型可用(chat/completions 路由),Bearer 认证可用,usage 字段代理已处理好。
3. **直连 /zen/go/v1/messages**:模型仅限 qwen3.7-max / minimax 系列,需 ANTHROPIC_API_KEY,count_tokens 无解(只能接受降级)。不推荐作为主路径。

## 五、购买后验证清单(未完成项)

1. `/zen/go/v1/messages` 对 qwen3.7-max/minimax 的流式 SSE、工具调用、`cache_control`→`usage.cache_read_input_tokens` 是否生效;
2. 经代理 deepseek-v4-flash 的工具调用、thinking(`enable_thinking`)映射、effort 档位;
3. 模型映射:`claude-*` → 套餐模型名的对应关系(沿用 DeepSeek 直连的映射方式);
4. count_tokens 降级实际频次与额度消耗(用 go 控制台用量对比)。

## 参考来源

- [routatic/proxy(Claude Code ↔ OpenCode 多上游代理)](https://github.com/routatic/proxy)
- [opencode-api npm 包(Anthropic→OpenCode Go 格式转换代理)](https://npmx.dev/package/opencode-api)、[GitHub 源码](https://github.com/ChineseFirstKeng/opencode-api)
- [opencode-primer zen.md(Go/Zen 套餐文档镜像)](https://github.com/wesammustafa/opencode-primer/blob/main/docs/zen.md)
- [WebSearch 逆向:内置工具在第三方端点下的行为](https://www.cnblogs.com/kakarotto-chen/p/20467241)
- [mikhail.io:WebFetch vs WebSearch 服务端工具分析](https://mikhail.io/2025/10/claude-code-web-tools)
- [cc-switch #2570:第三方 API 下 WebSearch 残留状态失败](https://github.com/farion1231/cc-switch/issues/2570)
- [Anthropic:Web tools 文档(disabledBuiltinTools)](https://claude.com/docs/third-party/claude-desktop/web-tools)
- [GitHub issue #54716:CLI 侧 disabledBuiltinTools 需求](https://github.com/anthropics/claude-code/issues/54716)
- [zhihu:OpenCode Go 套餐介绍与用量实测](https://zhuanlan.zhihu.com/p/2046154007157256590)
- [cnblogs:Go 套餐值得试(额度规则)](https://www.cnblogs.com/funkygod/p/20612762)
- [locdd:Go 套餐 DeepSeek V4 Flash 用量参考(CPA 优化缓存版)](https://locdd.com/t/topic/76860)
