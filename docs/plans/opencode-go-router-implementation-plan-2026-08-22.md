# OpenCode Go 网关 MVP —— 真实实施细节计划（敲定版）

日期：2026-08-22
状态：实施计划敲定。**本轮明确了三件事**：① 实施要用的技能清单；② 内置浏览器测试方案；③ ZCode 模型配置真实接入测试步骤。实现任务开工时以本文档为执行规格，配合 UI/后端规格 `opencode-go-router-ui-architecture-2026-08-22.md` 与主方案 `opencode-go-key-router-2026-08-22.md`。

**一句话目标**：在 `D:\develop\Trae\OpencodeGo` 实现可运行的本地网关 MVP，用 ZCode 里的真实 OpenCode Go Key，把「ZCode → 网关(127.0.0.1:8788) → opencode.ai」整条链路真实跑通；前端本地网页页面用**内置浏览器**直接打开验证；**真实写入 ZCode 模型配置**测试「baseURL 指向网关」这条唯一路径是否真的可行。

---

## 一、技能使用清单（明确到 skill + 用在哪一步）

| 环节 | 调用的 skill | SKILL.md 路径 | 怎么用 |
|---|---|---|---|
| 前端视觉设计 | `frontend-design` | `C:\Users\duanz\.agents\skills\frontend-design\SKILL.md` | 六视图页面的设计方向（token 系统：配色 4-6 色/字体/布局/signature），先在思考里定方案再写码，避免模板感 |
| 内置浏览器控制 | `browser-use:control-browser` | `C:\Users\duanz\.zcode\cli\plugins\cache\zcode-plugins-official\browser-use\0.3.0\skills\control-browser\SKILL.md` | **主 agent 亲自**打开 `http://127.0.0.1:8788` 直接看页面、点击、输入、截图（main-agent-only，禁止委派 subagent） |
| 前端黑盒测试 | `browser-use:web-gui-tester` | `C:\Users\duanz\.zcode\cli\plugins\cache\zcode-plugins-official\browser-use\0.3.0\skills\web-gui-tester\SKILL.md` | 测试方法论：P0 主流程（放 key / 看 key）→ P1 交互反馈 → P2 输入边界 → P3 布局；每点必须有截图证据 |
| 运行时截图证据 | `runtime-screenshot-evidence` | `C:\Users\duanz\.agents\skills\runtime-screenshot-evidence\SKILL.md` | 抓真实页面/终端截图作为「确实跑通」的证据（用户要看结果时） |
| 备用前端测试 | `webapp-testing` | `C:\Users\duanz\.agents\skills\webapp-testing\SKILL.md` | 仅当内置浏览器不可用时，用 Python Playwright 脚本兜底测本地 webapp |
| 项目政策维护 | `project-system` | `C:\Users\duanz\.agents\skills\project-system\SKILL.md` | 实施收尾：更新 README 结构/索引、PROJECT_STATUS 日志、归档规范 |
| 目标提示词 | `prompt-writing` | `C:\Users\duanz\.agents\skills\prompt-writing\SKILL.md` | Goal-Mode 产出实施目标提示词（本计划的产物） |

> 内置浏览器是第一选择：control-browser 支持 localhost/127.0.0.1 目标、主 agent 直连可截图可点击，正满足「直接看到整个页面」。`webapp-testing`（Playwright）只在它不可用时启用，二者不重叠。

---

## 二、内置浏览器测试方案

1. 网关启动后（真实模式或 MOCK_MODE），用 `control-browser` 打开 `http://127.0.0.1:8788`，先整页截图获得总览，识别六视图与页面类型。
2. 按 `web-gui-tester` 优先级组织测试点：
   - **P0 主流程**：Key 管理「放 key」→ 粘贴 key + 备注 → 提交 → 卡片出现在总览「看 key」；隔离→复活流程；
   - **P1 交互反馈**：录入校验成功/失败提示、刷新按钮 loading、自动刷新、导航切换、错误横幅；
   - **P2 输入边界**：空 key、超长备注、重复提交、无效 key（401 拒绝）、同 workspace 告警；
   - **P3 布局与样式**：卡片不重叠、三档进度条正常、长 workspace id 截断、深色/浅色。
3. **每次断言必须配截图证据**（Read 截图文件或工具直接返回的图）；GUI 黑盒：不注入 JS 改页面状态，只模拟真实用户操作。
4. MOCK_MODE 下先走通全部视图与流程（合成数据覆盖 active/cooldown/quarantined/invalid 全状态），再切真实模式验证。

---

## 三、ZCode 模型配置真实接入测试（关键步骤，含备份/回退）

目标：验证主方案 §3.3 的唯一一次性改动「provider baseURL 指向网关」是否真实可行。

前置：网关已在 127.0.0.1:8788 就绪并处于**真实转发模式**（能承接转发或至少正确回 429，不能是连接错误）。

1. **检查当前会话占用**：确认当前 ZCode 会话是否正用 `ce6a858a-5fad-4118-ba2b-b08bbde2c8d7`（OpencodeGo/deepseek-v4-flash）provider。若是，改配置只对**新建会话**或重启后生效（主方案实测：Key 在 provider 构造时固化），当前会话不受影响或需等网关就绪后再改，避免断流。
2. **备份**：复制 `C:\Users\duanz\.zcode\v2\config.json` → `%TEMP%\zcode\opencode-go-router-bootstrap\config.json.bak`（保留原 baseURL 记录）。
3. **改配置**：provider `ce6a858a` 的 `options.baseURL`：`https://opencode.ai/zen/go/v1` → `http://127.0.0.1:8788/v1`；`apiKey` → 占位符（如 `sk-local-gateway`）；模型名不动。
4. **建逃生门**：新增 provider `opencodego-direct`（真实 baseURL + 真实单 Key，`disabled: true` 常备）——网关彻底故障时手动切回，不至于断粮（主方案 §3.3）。
5. **发起真实请求**：在 ZCode 新建会话发起对话（deepseek-v4-flash）。
6. **验证**：
   - 网关日志出现该请求记录（x-session-id、模型名、路由到的 key）；
   - ZCode 侧收到正常响应（或至少是网关正确回传的 429 限额错误，而非连接拒绝）——两种情况都证明「baseURL 指向网关」链路通；
   - 记录请求头与响应。
7. **结论记录**：该模型配置**能否这样用**（能 / 不能 / 需要什么前提），写进 PROJECT_STATUS 与实施报告。
8. **回退**：失败/断流 → 恢复 `config.json.bak`，重启 ZCode 生效；确认逃生门 provider 可用。

> ⚠️ 此步真实修改 ZCode 运行配置，用户已明确授权；执行时仍遵守：先备份、网关就绪、可回退。真实 Key 只存在于网关 `keys.json`（0600），不写入任何文档/日志/提交。

---

## 四、网关实现顺序（对照 UI 架构文档 §五）

1. **骨架**：`go-gateway.cjs` —— HTTP Server（转发面 `/v1/chat/completions` + 控制面 `/api/*` + 静态前端 + `/health`），只绑 127.0.0.1:8788；内置 **MOCK_MODE=1**（合成数据剧本覆盖全状态）。
2. **Store**：`keys.json` 原子写（tmp+rename，0600），schema 照 UI 架构 §3.3。
3. **控制面 API**：按 UI 架构 §3.2 端点表全套（keys CRUD/refresh/reactivate/quarantine、sessions、events、status、config、export）。
4. **前端六视图**：总览 / Key 管理 / 隔离区 / 会话绑定 / 事件日志 / 设置；纯 HTML/CSS/JS 无构建链；**MOCK_MODE 下用内置浏览器走通**（含 frontend-design 的视觉方向）。
5. **真实转发面**：Router（x-session-id 粘性 + 周剩余分配 + 三触发换 Key）+ Forwarder（缓冲首字节 + failover + SSE 透传 + **UA 处理**）。**第一件事：验证网关出站 UA 能过 Cloudflare**（本轮实测：裸 urllib 被 1010 拦、浏览器 UA 通过；见 UI 架构 §1.3）。
6. **Limiter / StateMachine / Poller**：三通道判定、冷却/回收/隔离/复活、/usage 轮询与有界退避。
7. **ZCode 模型配置接入测试**（见 §三）。
8. **收尾**：验收 + `project-system` 更新 README/PROJECT_STATUS；写实施报告到 `%TEMP%\zcode\opencode-go-router-bootstrap\`。

**本阶段不做**（边界）：go-guard.cjs 生命周期（下阶段）、Anthropic `/messages` 与 count_tokens（Phase 2）、Electron 托盘、Key 加密存储（Phase 3）。

---

## 五、验收标准（可观测，逐条可查）

1. `node go-gateway.cjs` 启动后 `curl http://127.0.0.1:8788/health` 返回 200。
2. MOCK_MODE 下内置浏览器打开 `http://127.0.0.1:8788`：六视图可见，放 key→校验→总览看状态→隔离→复活全流程可操作，**每步有截图**。
3. 真实模式：从 ZCode 新会话发请求，网关日志出现转发记录；ZCode 收到正常响应或正确 429。
4. 模型配置测试：改 `config.json` baseURL 后 ZCode 能经网关对话（或有明确结论「能/不能/前提」），测试前后 config 可回退。
5. 真实 Key 未出现在任何文档/日志/提交；`keys.json` 权限 0600 且已 gitignore。
6. 前端测试点（P0-P3）记录通过/失败明细，失败项说明原因（不假装通过）。

---

## 六、风险与决策点

- **Cloudflare 1010（UA）**：第一个技术验证点，失败则先解决 UA 再继续（照 ZCode 的 HTTP 栈 UA 形态）。
- **当前会话占用 ce6a858a**：改配置选时机（网关就绪后）或开新会话，避免当前会话断流。
- **只有 1 把真实 Key 且周限 100%**：真实推理请求必然 429 → 正好验证「正确回 429」路径；failover 成功路径（主方案 V1）仍需用户提供 ≥2 健康 Key 才能端到端，MVP 用 MOCK_MODE + 429 路径覆盖。
- **主方案 §3.6 四个决策点**仍未确认：MVP 按默认推进（周剩余最多优先排序、并发=1、不设储备、workspace 独立性在真实录入时观察单 Key 不影响），不阻塞开工。
- **只读边界**：不改 `D:\develop\Trae\Me\`；不改主方案/UI 架构等决策源文档；ZCode config 改动按 §三 备份回退。
