# 客户端接入

对任何客户端而言，网关就是一个**普通的 OpenAI 兼容 endpoint**。接入只有三件事：

| 要素 | 值 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8788/v1` | **必须以 `/v1` 结尾**，网关在此暴露 `POST /v1/chat/completions` 与 `GET /v1/models` |
| `apiKey` | 任意非空占位符（惯例 `sk-local-gateway`） | 网关不校验此字段（除非设置了 `localToken`，见下）；真实 Key 由网关持有 |
| 模型 id | 沿用上游模型（如 `deepseek-v4-flash`） | `/v1/models` 原样透传上游列表，客户端启动探测自动发现 |

> 端口默认 8788，改端口用 `GO_PORT`（见 [configuration.md](configuration.md)），客户端 baseURL 同步改。

## ZCode

编辑 `~/.zcode/v2/config.json`，在 `provider` 对象中加一条（或把现有直连 provider 改成这样）：

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

- **保留直连逃生门**：把原来的直连 provider（`https://opencode.ai/zen/go/v1`）保留一份并置为 disabled；网关出问题时把 baseURL 改回去即可秒切。
- **模型选择**：在 ZCode 模型列表的 provider 一栏选 `OpenCodeGo`，模型 id 沿用 Go 套餐模型，无需额外配置。
- **会话粘性**：ZCode 每个会话带 `x-session-id` 头，网关据此粘 Key——这是缓存不丢的关键，不需要你做任何配置。
- **跟随启动（可选）**：想让网关随 ZCode 自动启动/关闭，配一个 SessionStart 钩子，见 [guard.md](guard.md)。
- **让 AI 助手代劳**：仪表盘「设置 → Agent 对接指引」有一段可复制的委派提示词（也可 `GET /api/guide` 获取），发给你的 AI 助手，它读完本项目文档即可替你完成上述接入。

## OpenCode（原生）

编辑 `~/.config/opencode/opencode.json`：

```jsonc
{
  "provider": {
    "opencodego": {
      "name": "OpenCodeGo",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:8788/v1",
        "apiKey": "sk-local-gateway"
      }
    }
  }
}
```

## 任意 OpenAI 兼容客户端 / 脚本

```bash
# 模型列表（客户端启动探测用）
curl http://127.0.0.1:8788/v1/models

# 对话（OpenAI 协议，支持 SSE 流式）
curl -s http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-session-id: my-session" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hello"}]}'
```

OpenAI 官方 SDK 把 `baseURL` 指到 `http://127.0.0.1:8788/v1`、`apiKey` 随便填即可。

## x-session-id 说明

- **带**（ZCode 等每会话一个 id 的客户端）：同会话永远同一把 Key，上下文缓存不丢——这是网关的核心收益。
- **不带**：功能完全正常，但每个请求重新调度，粘性与缓存收益丢失。想自己控制的脚本可以显式传一个固定值，等于手动粘住一把 Key。

## MCP 需要改吗？

**不需要，且无法改经网关。** 网关只代理 LLM 对话 API（`/v1/chat/completions`、`/v1/models`）；MCP server 是客户端与工具进程之间的连接（stdio / http），**完全不经过网关**，配置一行都不用动。

两点边界认知：

1. **MCP 工具调用本身是模型输出流的一部分**（模型决定调用工具 → 客户端执行 MCP → 把结果拼回下一轮对话），这段「模型输出」经网关透传，网关不解析、不修改、不影响工具语义。
2. **若 MCP 工具相关请求失败**，排查顺序：仪表盘「事件日志」看有无 `failover` / `empty-stream` / `exhausted` → 网关直连时上游是否同样失败（对照）→ 再查 MCP server 本身。网关侧的问题一定会体现在事件日志里。

## localToken（可选加固）

设置页配置 `localToken` 后，转发面与控制面都要求 `Authorization: Bearer <token>`——防同机其他进程借用网关。设置后客户端 `apiKey` 也要改成同值。默认不开启。
