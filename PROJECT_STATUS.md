# OpenCode Go 多 Key 本地路由 状态日志

最近更新：2026-08-22

## 当前目标（进行中）

- Phase 1 MVP 已实现并真实跑通（go-gateway.cjs + ui/ 六视图）；待用户提供 ≥2 健康 Key 做 V1 端到端 failover 验证；下阶段可接 go-guard 生命周期。主方案 §3.6 的 4 个决策点仍按默认推进。

## 详细日志（近期，最近在上）

- 2026-08-22（Phase 1 MVP 实现轮）：**go-gateway.cjs + 前端六视图实现并真实跑通**。① 网关（Node 24 原生 http/https，零依赖）：转发面 `POST /v1/chat/completions`（x-session-id 粘性、周剩余优先、缓冲首字节 failover、SSE 透传、429 metadata 解析）+ `GET /v1/models`（透传 29 模型，ZCode 探测思考能力，侧边对话风险补充后补上）；控制面 `/api/*`（keys CRUD/refresh/reactivate/quarantine、sessions、events、status、config）；状态机 active/cooldown_rolling/cooldown_weekly/quarantined/invalid；/usage 主动轮询 + 429 被动；MOCK_MODE（GO_STATE_DIR 可隔离）。② 前端 `ui/`（纯 HTML/CSS/JS 无构建链）：六视图（总览/Key 管理/隔离区/会话绑定/事件日志/设置），浅色玻璃质感主题（奶油白偏棕 + backdrop-filter 磨砂 + 琥珀/翠绿高饱和点缀 + 底部双层波浪流动 + 衬线标题 + 进度条流光）。③ 第一技术验证点：Node https 出站 TLS 通过 Cloudflare（urllib 被 1010 拦，node 正常，无需特殊 UA）。④ 修真实 bug：429 的 metadata 在顶层而非 error.metadata（证据文档示例位置与实际不符），已兼容两种位置 + 修复 cooldown 迁移；无 active Key 时按 L4 如实回 429 + 恢复时间而非 503。⑤ 真实链路：用 ZCode config 的 Go Key 录入，/usage 三窗口正确（weekly 100% 周一 00:00 UTC 重置 / monthly 50%），经网关带 x-session-id 转发返回上游原始 429（workspace wrk_01KKZMHM… 回填），事件日志记录 bind/rate-limited/cooldown/exhausted。⑥ ZCode 模型配置真实测试：备份 config.json，ce6a858a 的 baseURL 改 `http://127.0.0.1:8788/v1`、apiKey 改占位符，新增 disabled 逃生门 opencodego-direct；用与 config 改动后完全一致的请求（Bearer sk-local-gateway + x-session-id）经网关验证通过，结论「能这样用」。⑦ 内置浏览器 IAB 逐视图截图验证（MOCK 全状态 + 真实看板），无乱码、对比度正常。真实 Key 仅存 keys.json（gitignore）。备份 `%TEMP%\zcode\opencode-go-router-bootstrap\config.json.bak-*`。待办：≥2 健康 Key 的 V1 failover 端到端、go-guard 生命周期（下阶段）。

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

- 2026-08-22：key 切换逻辑走查 + 仿真（提取网关真实调度函数驱动 9 场景），确认 4 个真实问题：① rolling 429 不改 quota.percent 致 cooldown_rolling 特判每轮挑回耗尽 key（:254-257）；② failover 循环无上限，5xx/网络错/无 metadata 的 429 不改状态 → 无限重试同一把 key（:397-404）；③ 预切换无「更鲜才切」保护 → 全 key 近限时 ping-pong 毁缓存；④ 三档预切换阈值统一 90 且 monthly 参与，偏离设计 rolling90/weekly·monthly95。另有 failover 不重绑会话的一致性问题。多 key 轮换尚未在真实模式跑过（当前仅 1 key 且周限耗尽）。

- 2026-08-22：kill-bug 登记建立 `bug/`（open-bugs.md / resolved-bugs.md / regression/key-switch-sim.cjs，断言式回归入口 `node bug/regression/key-switch-sim.cjs`，当前 PASS8/RED8/exit1）。登记 BUG-001~006（已仿真红灯）与 BUG-007（定时任务/无 title 会话请求标识未验证 + 缺统一兜底，假设验证中）。新确认缺陷：网络抖动不重试直接切 key（BUG-006，S10 实证 A=1/B=1）。

- 2026-08-22：调度设计转向（反浪费）。用户确认：monthly 90% 不再弃用，改为「优先用掉快用完/快到期的 key，用完即弃，便于买新套餐换 key」。研究实证：monthly.resetsAt 即订阅/套餐续费日（本地 k2=2026-09-19≈28天=订阅周期，Reddit/ZIDOOKA 确认按月订阅周期重置），官方无独立到期接口（issue #16017/#31084 仍在请求），周/5h 窗口到点重置未用不结转。登记 BUG-008（反浪费 drain 调度缺失），BUG-004 方向随之转向。待确认：用户「每周额度比较少优先使用」与「优先用 weekly 更多」的取舍。

- 2026-08-22：调度根因收敛为「缓存核心」。用户确认：网关唯一优化目标 = 提示词缓存命中率（切换对 ZCode 无感、代价为零），会话粘性 = 缓存积累。月额度将尽（剩余<5h窗口≈percent≥80%）的 key 注定死亡、缓存无未来价值、周额度无关 → 最高优先用完丢弃；仅月额度健康的 key 谈周平衡/防封。BUG-008 规格据此定稿，新增 S11 红灯（新会话应首选 drain key，当前实际选 B、红灯）。

- 2026-08-22：BUG-008（反浪费 drain 调度）实现并回归通过（分支 fix/bug-008-drain-priority，未合入）。改动 `go-gateway.cjs`：新增 isDrainKey（monthly≥80% 或距 resetsAt≤72h 且有剩余）、compareKeys（drain 优先→到期近→剩余少；balance 周剩余多→5h→并发）、pickPreSwitchTarget（预切换避开 drain key）；shouldPreSwitch 移除 monthly；pickBestKey 用 compareKeys；getOrBindKey 绑定 key 为 drain 时绝不预切换走。回归 `bug/regression/key-switch-sim.cjs` PASS=13 RED=7：S7/S11/S12/S13/S14 全绿，其余 bug 红灯（S3/S6/S9/S10）原样保留。`node --check` 通过。真实 E2E 待 ≥2 把健康 key。

- 2026-08-22：已知 bug 批量修复并回归通过（分支 fix/bug-008-drain-priority，未合入）。`go-gateway.cjs`：① BUG-001 删 cooldown_rolling 特判 + 429 同步标记 quota 窗口；② BUG-002/005/006 failover 逻辑抽取为 `failoverChain`（瞬时错误同 key 重试 2 次→有界 failover MAX_FAILOVER=4+skipIds→成功当场重绑会话→耗尽如实回错+恢复时间）；③ BUG-003 新增 `meaningfullyFresher`（任一窗口低≥10 才预切换，防 ping-pong）；④ BUG-004 新增 `preSwitchWeeklyPct=95` 与 rolling 90 分档、monthly 不再触发预切换。全量回归 `bug/regression/key-switch-sim.cjs` PASS=20 RED=0 exit=0（S1-S14 全绿）。`node --check` 通过，mock 模式启动/health/config/聊天链路正常。真实 E2E 待 ≥2 把健康 key。
- 2026-08-22：生命周期验证——`go-guard.cjs` 尚未实现（README 标「下阶段」），当前网关手动启停，不跟随 ZCode；参考母本 `reference/dt-mcp-watch/dt-guard.cjs`（v3：SessionStart 钩子→spawn detached 自守护→PID 锁单例→每 5s 查 ZCode.exe→消失满 60s 停引擎收摊）存在，待按端口 8788 参数化创建 go-guard.cjs 并挂 SessionStart 钩子。
