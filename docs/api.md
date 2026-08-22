# HTTP API 参考

网关监听 `127.0.0.1:8788`（`GO_PORT` 可改）。两个面：**转发面**（给 Agent 客户端，OpenAI 协议）与**控制面**（给仪表盘/脚本，`/api/*`）。设置 `localToken` 后两个面都要求 `Authorization: Bearer <token>`（`/health` 除外）。

## 转发面

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI 对话协议，支持 SSE 流式；可选 `x-session-id` 头做会话粘性 |
| `GET` | `/v1/models` | 上游模型列表原样透传（客户端启动探测用） |
| `GET` | `/health` | 健康检查（go-guard 用；无需鉴权） |

对话请求的行为（选 Key、failover、备用通道、空回复处理）见 [architecture.md](architecture.md)。

## 控制面

### 状态与只读

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/status` | 汇总状态（Key 数/状态分布/总 token 等）+ 同池告警 |
| `GET` | `/api/keys` | Key 列表（三窗口用量、状态、统计）+ 同池告警 |
| `GET` | `/api/sessions` | 会话绑定表 |
| `GET` | `/api/events?limit=N` | 事件日志（倒序） |
| `GET` | `/api/config` | 当前配置（`localToken` 与 `fallback.apiKey` 掩码回显） |
| `GET` | `/api/fallback` | 备用通道视图（配置 + 余额 + 花费窗口聚合 + 结算记录） |
| `GET` | `/api/guide` | Agent 对接指引委派提示词（运行时生成，含本机安装目录/端口） |

### Key 管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/keys` | 录入：`{"key": "sk-...", "label": "..."}`；实时调上游校验（401 → 拒绝） |
| `PATCH` | `/api/keys/{id}` | 改名 / 替换 Key / 停用（`action=manualOff`）/ 启用 |
| `DELETE` | `/api/keys/{id}` | 删除 |
| `POST` | `/api/keys/{id}/refresh` | 强制刷新该 Key 用量 |
| `POST` | `/api/keys/{id}/reactivate` | 手动复活（实时查上游，月窗 ok 才放行） |
| `POST` | `/api/keys/{id}/quarantine` | 手动隔离 |
| `POST` | `/api/keys/refresh-all` | 批量刷新全部可用 Key 用量（跳过隔离/失效） |
| `POST` | `/api/keys/reactivate-all` | 「一键恢复」：全部隔离 Key 重查，月窗已恢复的自动放回池 |

### 配置与备用通道

| 方法 | 路径 | 说明 |
|---|---|---|
| `PATCH` | `/api/config` | 改运行时配置，字段见 [configuration.md](configuration.md) |
| `PATCH` | `/api/fallback` | 改备用通道配置（字段见 configuration.md；apiKey 掩码回显） |
| `POST` | `/api/fallback/refresh` | 「立刻计算」：即时采样余额并结算 |
| `POST` | `/api/fallback/test` | 「测试连接」：用 body 里的候选配置（不必先保存）测可达性 + 计费能力 |
| `POST` | `/api/events/clear` | 清空事件日志 |

## 示例

```bash
# 录入 Key（实时校验，成功即带出三窗口用量）
curl -s -X POST http://127.0.0.1:8788/api/keys \
  -H "Content-Type: application/json" \
  -d '{"key": "sk-你的GoKey", "label": "主 Key"}'

# 读状态
curl -s http://127.0.0.1:8788/api/status

# 改并发上限
curl -s -X PATCH http://127.0.0.1:8788/api/config \
  -H "Content-Type: application/json" \
  -d '{"concurrencyPerKey": 6}'

# 配置并测试备用通道（火山方舟示例，不计费模式）
curl -s -X POST http://127.0.0.1:8788/api/fallback/test \
  -H "Content-Type: application/json" \
  -d '{"baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3", "apiKey": "你的备用Key", "model": "deepseek-v4-flash", "billingMode": "none"}'
```

> 事件类型语义速查见 [admin-ui.md](admin-ui.md)。
