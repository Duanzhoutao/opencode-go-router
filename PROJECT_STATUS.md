# OpenCode Go 多 Key 本地路由 状态日志

最近更新：2026-08-22

## 当前目标（进行中）

- 项目引导 + 核心文档迁移完成（本任务）。设计定稿，**网关代码未实现**；待用户确认主方案 `docs/plans/opencode-go-key-router-2026-08-22.md` §3.6 的 4 个决策点后进入 MVP 实现（实现由后续任务另行提供 skill）。

## 详细日志（近期，最近在上）

- 2026-08-22（侧边对话·风险补充）：**网关透明性与思考透传风险点落盘**。结论：网关是纯透明转发层，思考在模型侧完成、决定质量的是上游模型 + ZCode 发出的 thinking/effort 档位，设计上不影响模型质量；三个真实风险点：① ZCode 可能调 `/models` 探测思考能力 → **网关必须一致转发 /models**（否则思考档位探测变→才真影响质量，转发面规格新增 `GET /v1/models`）；② 转发不得剥离 thinking/output_config/budget_tokens 字段；③ 出站 UA（Cloudflare 1010，已有）。已写入 UI 架构 §1.4、实施计划 §三.9（验收检查项）/§六（风险）、README「已知风险与待验证点」清单。

- 2026-08-22（实施计划敲定轮）：**MVP 实施细节计划 + 目标提示词落盘**。产出两份文档：① `docs/plans/opencode-go-router-implementation-plan-2026-08-22.md`（实施计划）：明确技能使用清单（frontend-design 前端设计 / browser-use:control-browser + web-gui-tester 内置浏览器黑盒测试 / runtime-screenshot-evidence 截图证据 / webapp-testing 兜底 / project-system 收尾）、内置浏览器测试方案（P0-P3 测试点 + 每断言配截图）、ZCode 模型配置真实接入测试步骤（备份 config.json → baseURL 改 127.0.0.1:8788/v1 → 建逃生门 provider → 新会话实测 → 结论记录 → 可回退）、网关实现顺序（骨架→Store→控制面 API→前端六视图→真实转发→状态机→配置测试）、验收标准 6 条；② `docs/plans/opencode-go-router-goal-prompt-2026-08-22.md`（Goal-Mode 目标提示词）：可直接设定为持续执行目标，含核心目标/上下文/评价标准/循环流程/停止条件/决策边界/沉淀方式/跑偏防护。真实 Key 读取位置与 Cloudflare 1010 UA 处理已写进上下文。实施阶段待用户把目标提示词设定为 Goal 后开始。

- 2026-08-22（细节敲定轮）：**前端功能清单 + 后端架构设计细化**。产出 `docs/plans/opencode-go-router-ui-architecture-2026-08-22.md`：前端定为本地单页网页（六视图：总览/Key 管理/隔离区/会话绑定/事件日志/设置，纯 HTML/CSS/JS 无构建链）；后端定为单 Node 进程网关（转发面+控制面 API+静态托管同进程），列出控制面 API 端点契约、keys.json schema、请求/定时两条数据流，并设计 MOCK_MODE 供开发期模拟 debug。本轮真实探测（ZCode config `ce6a858a` Go Key）：/usage 三窗口数据形状确认（当前 rolling 0% / weekly 100% 周一重置 / monthly 50%）、429 预流式 JSON 确认（limitName=weekly、Retry-After 153435、metadata.workspace=wrk_01KKZMHM676M3CWS8ZDFJ75EFG）；**新发现：裸 urllib 请求被 Cloudflare 1010 拦截、带浏览器 UA 的 curl 通过 → 网关转发必须处理 UA（实现第一件事验证）**。参考 opencode-go-dashboard（多账号 CRUD/一键刷新/上限高亮，但用 Auth Cookie 抓页面）与 pi-opencode-go-rotation（后端轮换逻辑无 UI）。主方案 §3.6 决策点与 §3.7 V1-V6 仍待确认/实证。

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
