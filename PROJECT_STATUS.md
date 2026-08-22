# OpenCode Go 多 Key 本地路由 状态日志

最近更新：2026-08-22

## 当前目标（进行中）

- 项目引导 + 核心文档迁移完成（本任务）。设计定稿，**网关代码未实现**；待用户确认主方案 `docs/plans/opencode-go-key-router-2026-08-22.md` §3.6 的 4 个决策点后进入 MVP 实现（实现由后续任务另行提供 skill）。

## 详细日志（近期，最近在上）

- 2026-08-22：**项目独立化引导 + 核心文档迁移（从 Me 工作区）**。在 `D:\develop\Trae\OpencodeGo` 建立项目骨架（README/AGENTS/PROJECT_STATUS/.gitignore/docs/reference/project-context），迁移设计文档：主方案 `docs/plans/opencode-go-key-router-2026-08-22.md`、证据链 `docs/plans/opencode-go-router-evidence-2026-08-22.md`、历史可行性报告 `docs/reports/opencodego-claude-code-feasibility-2026-08-04.md`、生命周期守护参考实现 `reference/dt-mcp-watch/`（dt-guard.cjs + README，go-guard.cjs 母本）。迁移时仅做明显过时路径修正（主方案 §3.2 布局前缀、dt-guard 引用路径），内容不改写。Me 侧原文件保持原样，本工作区成为设计唯一归属地。吸收 4 条核心事实进本项目管理记忆。迁移报告：`%TEMP%\zcode\opencode-go-router-bootstrap\handoff-report.md`。

## 重要约束

- 主方案 `docs/plans/opencode-go-key-router-2026-08-22.md` 为唯一决策源，只读；§3.6 的 4 个决策点待用户确认，§3.7 开放项 V1-V6 待实现后实证（部分需 ≥2 健康 Key）。
- 真实 Key 只存运行时 `keys.json`（0600，已入 .gitignore），任何源码/文档/提交/日志不得出现真实密钥。
- `D:\develop\Trae\Me\` 下任何文件只读，不修改/移动/删除；Me 侧主方案与证据为移交副本。
- 网关代码未实现；MVP 范围按主方案 §3.5 Phase 1，不做超范围扩展。
- 生命周期守护复用 `reference/dt-mcp-watch/` v3 模式，不重造；本机在用的 dt-guard（desktop-touch 23847）不动。
- 状态文件只记录已发生的事实、仍有效的边界、路径入口和验证结果；默认不写待办、下一步、建议计划或 agent 推测。

## 已压缩摘要（摘要栈：次远在上、最远在最底）

（暂无归档；旧日志整段在用户显式要求沉淀/压缩时，写入 `project-context/status-NNN-YYYYMMDD.md`：前摘要 + 后原全文；并在此栈追加一行。）

## 归档指针

- 归档命名规范与回溯方式：见 `README.md` §归档命名规范。
- 归档子文件夹：`project-context/status-*.md`（按序号递增回溯整段日志）。
