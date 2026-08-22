# 文档索引

这组文档面向**正在部署、排查或二次开发本项目的人或 AI 助手**，全部以**当前版本的实际行为**为准（已修复的问题按修复后的机制描述，历史设计过程不上传）。

## 按问题找文档

| 你想做什么 / 疑问 | 读哪份 |
|---|---|
| 快速把网关跑起来、录入 Key | 仓库根 [README](../README.md) 的「快速开始」 |
| 把 ZCode / OpenCode / 其他客户端接到网关 | [client-integration.md](client-integration.md) |
| MCP 配置需要改吗？MCP 和网关什么关系 | [client-integration.md](client-integration.md) 的「MCP」一节 |
| 网关怎么选 Key、什么时候切换 / 隔离 / 走备用通道 | [architecture.md](architecture.md) |
| 网关怎么**跟随 ZCode 自动启动和关闭**（钩子机制） | [guard.md](guard.md) |
| 改端口、改调度参数、配备用通道 | [configuration.md](configuration.md) |
| 用脚本调控制面 API | [api.md](api.md) |
| 仪表盘各视图、事件类型含义 | [admin-ui.md](admin-ui.md) |
| 遇到报错或异常行为 | [faq.md](faq.md) |

## 推荐阅读顺序

- **新部署（人）**：根 README 快速开始 → [client-integration](client-integration.md) → （可选自动启停）[guard](guard.md) → [configuration](configuration.md)。
- **AI 助手代为接入**：根 README + [client-integration](client-integration.md) + [guard](guard.md) 三份即可完成接入；机制细节按需查 [architecture](architecture.md)，报错查 [faq](faq.md)。
- **二次开发**：[architecture](architecture.md) + [api](api.md) + 源码 `go-gateway.cjs`（约 1400 行，零依赖，注释即文档）。

## 文件清单

| 文件 | 内容 |
|---|---|
| `architecture.md` | 架构总览、请求生命周期、粘性会话与缓存、调度规则、状态机、备用通道与计费 |
| `client-integration.md` | ZCode / OpenCode / 任意 OpenAI 兼容客户端接入，x-session-id，MCP 说明 |
| `guard.md` | go-guard 生命周期守护：SessionStart 钩子配置、单例锁、跟随启停、测试与排障 |
| `configuration.md` | keys.json、运行时配置字段、备用通道配置、环境变量 |
| `api.md` | 转发面与控制面 HTTP API 参考 |
| `admin-ui.md` | 仪表盘七视图速览与事件类型表 |
| `faq.md` | 常见问题（含钩子启动、MCP、429/隔离、空回复、备用通道计费） |
