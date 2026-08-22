# OpenCode Go 网关 MVP —— 目标提示词（Goal-Mode，可直接设定为持续执行目标）

> 生成依据：prompt-writing Goal-Mode（2026-08-22）。设置方式：把下方「目标提示词」整体复制为你的 Goal/持续执行模式；设置后由该模式开始执行。细节规格均在项目文档中，提示词只带关键事实与决策边界。

## 目标提示词

你现在是 OpenCode Go 多 Key 本地路由网关的实现者。项目根 `D:\develop\Trae\OpencodeGo`，设计已定稿。你的任务是**实现 Phase 1 MVP 并在本机真实跑通整条链路**，不允许只做理论或半成品。

### 核心目标
在项目根实现可运行的本地网关 `go-gateway.cjs`（127.0.0.1:8788，Node 24 原生 http，零依赖），持有 ZCode 里的真实 OpenCode Go Key，把「ZCode → 网关 → opencode.ai」链路真实跑通：前端本地网页页面（六视图）能用内置浏览器打开并完整操作，并把 ZCode 模型配置真实改为指向网关，验证这条唯一路径可行。

### 当前上下文（已核实）
- 主方案（唯一决策源，只读）：`docs/plans/opencode-go-key-router-2026-08-22.md` —— L1-L8 核心逻辑、§3.6 决策点、§3.7 开放项 V1-V6。
- UI/后端规格：`docs/plans/opencode-go-router-ui-architecture-2026-08-22.md` —— 前端六视图功能清单、控制面 API 端点契约（§3.2 端点表）、keys.json schema（§3.3）、两条数据流（§3.4）、MOCK_MODE 设计（§3.5）。
- 实施计划：`docs/plans/opencode-go-router-implementation-plan-2026-08-22.md` —— 技能清单（§一）、内置浏览器方案（§二）、ZCode 模型配置测试步骤（§三）、实现顺序（§四）、验收标准（§五）。
- 生命周期参考：`reference/dt-mcp-watch/`（go-guard.cjs 母本；本阶段可只留 /health 对接，guard 下阶段做）。
- 真实 Key：`C:\Users\duanz\.zcode\v2\config.json` 的 provider `ce6a858a-5fad-4118-ba2b-b08bbde2c8d7`（baseURL `https://opencode.ai/zen/go/v1`，deepseek-v4-flash）。读取进内存使用，**绝不写入任何文档/日志/提交**；网关侧只存 `keys.json`（0600，已 gitignore）。
- 已实测事实（2026-08-22）：`/usage` 返回三窗口 `{status, percent, resetsAt}`（当前 weekly 100% 周一 00:00 UTC 重置、monthly 50%）；推理 429 是预流式完整 JSON（`GoUsageLimitError` + `metadata.limitName/workspace` + `Retry-After`）；**裸 urllib 请求被 Cloudflare 1010 拦截、带浏览器 UA 的 curl 通过 → 网关出站必须处理 UA（第一个技术验证点）**。
- 环境约束：真实 Key 只有 1 把且当前周限 100% → 真实推理请求必然 429（正好验证「网关正确回传 429」路径）；failover 成功路径（V1）无法端到端，用 MOCK_MODE 合成数据覆盖。

### 评价标准（可观测，全部满足才算完成）
1. `node go-gateway.cjs` 启动后 `curl http://127.0.0.1:8788/health` 返回 200。
2. 内置浏览器打开 `http://127.0.0.1:8788`：六视图可见；放 key→校验→总览看状态→隔离→复活全流程可操作，**每步有截图证据**。
3. 真实模式：从 ZCode 新会话发请求，网关日志出现转发记录（含 x-session-id/模型名/命中 key），ZCode 收到正常响应或正确 429（而非连接错误）。
4. 模型配置测试有明确结论（能/不能/需要什么前提），config 改动有备份且可回退，失败不留半改状态。
5. 真实 Key 未出现在任何文档/日志/提交；`keys.json` 权限 0600。

### 循环流程
按「实现候选 → 小测 → 分析 → 调整 → 再测」收敛：每个模块做完就做最小冒烟（控制面 API 用 curl、前端用内置浏览器），失败先定位（环境/依赖 → 数据/路径 → 运行行为），一次只改一个变量，保留失败证据；不要一次性写完再集中调试。

### 停止条件
实现顺序（骨架 → Store → 控制面 API → 前端六视图 → 真实转发 → 状态机 → 模型配置测试）全部完成且评价标准 1-5 通过；或遇到必须用户拍板的阻塞（如改 ZCode config 需要用户在场确认切换时机）时停下报告。

### 决策边界
可自行决定：函数拆分、CSS 结构、MOCK_MODE 剧本、测试用例组织。必须停下问用户：① 真实改动 ZCode config 前，确认网关已就绪、用户同意时机；② 需要用户提供 ≥2 把健康 Key 才能做的验证（V1 端到端）；③ 超出本阶段范围的改动（Anthropic `/messages`、count_tokens、Electron、go-guard 生命周期）。

### 沉淀方式
只保留：可运行的 `go-gateway.cjs`、`keys.json` schema、前端静态文件、验证结果（curl 输出/截图/请求日志摘要）。临时探测脚本放 `%TEMP%\zcode\opencode-go-router-bootstrap\`，不进项目。收尾用 `$project-system` 更新 README/PROJECT_STATUS，写实施报告到 `%TEMP%\zcode\opencode-go-router-bootstrap\handoff-report.md`，最终回复只给报告路径 + 简短摘要。真实 Key 一律不进任何文件。

### 跑偏防护
- 不做超出 MVP 的设计扩展（Electron、count_tokens、加密、多 agent 共享、go-guard 完整生命周期）。
- 不重写/删减主方案与规格文档（决策源只读；新增结论写 PROJECT_STATUS 或新文档）。
- 不把 MOCK_MODE 冒充真实转发结论——两条链路分开记录、分开验收。
- 出站请求 UA 必须处理（Cloudflare 1010）；真实 Key 绝不落任何产物。
- 改 ZCode config 前先备份，失败恢复备份并报告根因，不留半改状态。

## 设置方式
把上面的「目标提示词」整体复制为你的 Goal/持续执行模式；设置后由该模式开始执行。

## 为什么这样写
目标、评价标准、循环流程、停止条件、决策边界、跑偏防护六个要素全部压缩进去：目标一句话钉死「真实跑通」而非「做完就行」；评价标准全部是可 curl/可截图/可查日志的可观测项，杜绝「看起来能跑」；循环流程强制小步冒烟收敛，避免一次写完再调试的返工；决策边界明确哪些能自己定、哪些必须问用户（真实改动 ZCode 配置、缺健康 Key）；跑偏防护挡住「MVP 变万能」「mock 冒充真实」「key 泄漏」三类最常见的翻车。细节规格不重复搬进提示词，统一指向仓库文档，保持提示词可执行且不臃肿。
