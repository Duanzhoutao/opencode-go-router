# OpenCode Go 多 Key 本地路由 + ZCode 集成

**一句话**：本地 Node 网关（127.0.0.1:8788）持有多个 OpenCode Go Key，以 `x-session-id` 做会话粘性 + 周限额优先级调度 + `/usage` 精确 `resetsAt` 回收 + 月限隔离/复活，对 ZCode 完全透明（唯一一次性改动 = baseURL 指向网关），跟随 ZCode 启停，配浏览器仪表盘。

本工作区是本设计的**唯一归属地**。此前在 Me 工作区经六轮迭代完成的设计、决策与实测证据已全部迁移至此（Me 侧原文件为移交副本，不再作为归属入口）。

## Project System

- Current stage: 项目引导 + 文档迁移完成；设计定稿，**网关代码未实现**（MVP 待用户确认决策点后由后续任务实现）
- Project type: 个人工具（本地 Node 网关 + ZCode 集成，零重依赖）
- Memory profile: `status-log`
- Dynamic status: `PROJECT_STATUS.md`
- Archival subfolder: `project-context/`（归档命名规范见下文）

## 文件职责（3 个核心文件）

| 文件 | 写什么 |
| --- | --- |
| `AGENTS.md` | 核心规则：项目政策文件清单、任务收尾自检、归档触发、兜底默认 |
| `README.md`（本文件） | 项目全貌：目标、结构、设计文档索引、归档命名规范 |
| `PROJECT_STATUS.md` | 当前目标 + 倒叙详细日志 + 重要约束 + 已压缩摘要（底部摘要栈） |

## 设计文档索引（决策源，勿删减改写）

| 文件 | 内容 |
|---|---|
| `docs/plans/opencode-go-key-router-2026-08-22.md` | **主方案（唯一决策源）**：问题 P1-P9 / 核心逻辑 L1-L8 / 解决方案（架构·文件布局·ZCode 对接·选型·分期）+ §3.6 待确认决策点 4 个 + §3.7 开放项 V1-V6 与已接受风险 |
| `docs/plans/opencode-go-router-evidence-2026-08-22.md` | 实测证据链（外挂）：API 实测（/usage、429、401、/models）、asar 反编译、model-io 日志验证、dt-guard 模式实证、缓存调研、参考项目、复现命令 |
| `docs/reports/opencodego-claude-code-feasibility-2026-08-04.md` | 历史可行性调研（2026-08-04）：Claude Code 接入 Go 套餐的端点/协议/参考代理 |
| `docs/plans/opencode-go-router-ui-architecture-2026-08-22.md` | 设计细化（UI/后端规格）：前端功能清单（六视图本地单页）+ 后端架构（模块/控制面 API 契约/存储 schema/数据流）+ 真实探测结果 + MOCK_MODE 模拟方案 |

> ⚠️ 开工前必读：主方案 `docs/plans/opencode-go-key-router-2026-08-22.md` 的 **§3.6 待用户确认的 4 个决策点**（多 Key 是否独立 workspace / 排序方向 / 储备策略 / 每 Key 并发上限）与 **§3.7 开放项 V1-V6**（failover 端到端 / 缓存实测 / 同池检测 / 子智能体 header / rolling resetsAt 语义 / /usage 稳定性）需用户确认或实现后实证。

## 目录结构

```text
.
├── README.md
├── AGENTS.md
├── PROJECT_STATUS.md
├── .gitignore
├── docs/
│   ├── plans/                       # 方案：主方案 + 外挂证据（决策源）
│   └── reports/                     # 一次性报告：历史可行性调研
├── reference/
│   └── dt-mcp-watch/                # 生命周期守护参考实现（go-guard.cjs 母本）
│       ├── dt-guard.cjs
│       └── README.md                # 部署/复现/回退手册（含 v1/v2/v3 决策记录）
├── project-context/                 # 归档：status-NNN-YYYYMMDD.md
└── [未来网关代码位于项目根]            # go-gateway.cjs / go-guard.cjs / keys.json / 部署 README
```

### 未来网关代码位置（按主方案 §3.2 修正后约定）

- `go-gateway.cjs`：网关本体（转发/调度/状态机/控制面 API/静态前端，暴露 `/health`）。
- `go-guard.cjs`：生命周期守护（照抄 `reference/dt-mcp-watch/dt-guard.cjs` 参数化，端口 8788，锁/日志在 `~/.opencode-go-router/`）。
- `keys.json`：Key、状态、冷却截止、隔离记录、会话绑定表（0600，**真实 Key 不入库**，已入 `.gitignore`）。
- 部署 `README.md`：照 `reference/dt-mcp-watch/README.md` 结构。

## 已知跨工作区引用（不随本项目迁移）

- 可行性报告内链接 `claude-desktop-cc-switch-session-replay-diagnosis-2026-07-14.md`（count_tokens 降级诊断）指向 Me 工作区 `D:\develop\Trae\Me\docs\reports\`，本项目未迁移该报告，链接在本地不可点（仅作历史溯源）。

## 归档命名规范（回溯入口）

- 归档文件放 `project-context/`，命名 `status-<三位序号>-<YYYYMMDD>.md`，序号递增 = 时间递增 = 回溯顺序。例：`status-001-YYYYMMDD.md`。
- 每个归档文件内部：**前面一段摘要 + 后面原 `PROJECT_STATUS` 内容原样保留**。
- 要追历史：按序号升序读 `project-context/status-*.md`（先摘要后全文），读完即回溯整段日志；`PROJECT_STATUS.md` 底部「已压缩摘要」栈给出各段一句话结论。
- 归档只有在用户显式要求（沉淀项目经验 / 压缩 / 归档）时创建。

## Naming

- 目录名使用稳定、可读的英文 slug。
- 设计文档沿用「决策源」语义，只做复制与明显过时路径修正，不删减改写。
- 真实 Key 只存在于运行时 `keys.json`，任何源码/文档/提交不得出现真实密钥（历史文档中仅有 `sk-wfj0...` 这类脱敏占位符）。

## Evolution Rules

- 设计方向 / 技术栈 / 结构变化时，更新本 README 结构摘要与 `PROJECT_STATUS.md`。
- 网关代码实现、决策点确认、V1-V6 验证进展都记录到 `PROJECT_STATUS.md`（只写已发生事实，不写 TODO）。
- 详细、快速变化的状态不进 README。

## Run

- 当前阶段无网关代码，无运行命令。网关实现后，运行方式见项目根部署 `README.md`（参照 `reference/dt-mcp-watch/README.md` 结构）与主方案 §3.3 ZCode 对接、§3.5 分阶段实施。
