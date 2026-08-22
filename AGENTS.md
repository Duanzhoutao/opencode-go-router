# AGENTS.md — OpenCode Go 多 Key 本地路由项目规则

## 项目政策文件（名词契约）

本项目由下面的文件承担规则与记忆；用户说「规则文档」「相关文档」「项目约定」时，默认指这组文件，按需查阅。

| 文件 | 写什么 | 完成任务后：该更新吗 |
| --- | --- | --- |
| `AGENTS.md`（本文件） | 核心规则 | 规则 / 边界变化时才更新 |
| `README.md` | 全貌、结构、设计文档索引、「归档命名规范」 | 目录 / 入口 / 运行命令变化时更新 |
| `PROJECT_STATUS.md` | 当前目标 + 倒叙详细日志 + 底部摘要栈 | 产出可复用事实 / 验证结果时，倒叙加一条 |

**设计决策源（只读，勿删减改写）**：主方案 `docs/plans/opencode-go-key-router-2026-08-22.md`（含 §3.6 待确认决策点、§3.7 开放项 V1-V6）；证据 `docs/plans/opencode-go-router-evidence-2026-08-22.md`。本设计归属本项目；Me 工作区 `D:\develop\Trae\Me\docs\plans\opencode-go-key-router-2026-08-22.md` 等为移交副本，不作为归属入口。

**任务收尾自检（每次任务结束后核对）**：
1. 改了源码 / 文档 / 配置 / 结构？→ 检查是否应更新 README（结构或索引）或 AGENTS（规则）。
2. 产生可复用事实 / 验证结果 / 路径变化？→ `PROJECT_STATUS.md` 倒叙补一条，格式 `- YYYY-MM-DD：完成 X，验证 Y`（含日期、做了什么、结果）。
3. 设计文档（主方案/证据）是否被改动？→ 只允许复制与明显过时路径修正；新增决策/证据写新文档或 `PROJECT_STATUS.md`，不覆写决策源。
4. 都不需要？→ 不写，保持文件干净。

**归档**（用户说「沉淀项目经验 / 压缩 / 归档」时触发）：按 README §归档命名规范，把 `PROJECT_STATUS.md` 旧日志整段与其一句话摘要写入 `project-context/status-NNN-YYYYMMDD.md`（文件内前摘要 + 后原全文），并在 `PROJECT_STATUS.md` 底部「已压缩摘要」追加一行。

**兜底默认**：拿不准该不该更新时 → 写 `PROJECT_STATUS.md` 事实条目是安全的，但绝不自动写 TODO / 下一步；仍不确定 → 问用户。

**历史读取**：要追更早历史，按 README §归档命名规范读 `project-context/status-*.md`，每条先摘要后全文，按序号递增即可回溯整段日志；不需要一次读完整份旧日志。

## 项目硬事实与安全边界

- **真实 Key 安全**：真实 OpenCode Go Key 只存在于运行时 `keys.json`（0600），已入 `.gitignore`；任何源码、文档、提交、日志不得写入真实密钥。设计文档中只有 `sk-wfj0...` 脱敏占位符。
- **Me 工作区只读**：`D:\develop\Trae\Me\` 下任何文件不修改、不移动、不删除（该工作区仍承载其他项目与历史材料）。
- **网关实现前置**：MVP 开工前需用户确认主方案 §3.6 的 4 个决策点（独立 workspace / 排序方向 / 储备策略 / 并发上限）；§3.7 V1-V6 需 ≥2 健康 Key 或数据才能实证。实现范围按主方案 §3.5 分期，不做超范围扩展。
- 生命周期守护复用 `reference/dt-mcp-watch/` 的 v3 模式（SessionStart 钩子 + 单例 guard），不重造；本机在用的 dt-guard 不动。

Use Git for local progress by default. Connect GitHub, configure remotes, push, or create PRs only when the user explicitly asks. Before committing, inspect `git status -sb`, relevant diffs, and the staged file scope; write commit messages that describe the staged content. Runtime files (`keys.json`)、生成中间产物与本机状态默认不入库，匹配 `.gitignore` 模式。

Use `$project-system` for initialization / upgrade / memory read / 沉淀 / compact / restore；复杂长任务探索收敛用 `$research`；写目标提示词用 `$prompt-writing` Goal-Mode。
