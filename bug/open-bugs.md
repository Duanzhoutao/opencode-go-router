# Open Bugs — OpenCode Go 网关

登记约定：kill-bug 流程（`bug/` 根，无项目级自定义规则覆盖）。编号从 BUG-001 起，项目内唯一。
状态取值：`现象级复现中` / `假设验证中` / `已登记` / `修复中` / `待验证` / `回归测试通过` / `已解决`。
修复完成后整条移入 `resolved-bugs.md`（不删除内容）。
回归脚本统一入口：`node bug/regression/key-switch-sim.cjs`（提取网关真实调度/转发函数驱动场景断言；当前 PASS=20 RED=0 exit=0）。

---

## BUG-001

| 字段 | 内容 |
| --- | --- |
| 编号 | BUG-001 |
| 状态 | 回归测试通过 |
| 分类 | 社区代码 bug（缺陷在本项目网关代码本身，干净 checkout 可复现） |
| 推送决策 | 仅本地修复（本项目为本地工具，无社区上游可推） |
| 标题 | rolling 429 只改 status 不改 quota.percent，cooldown_rolling 特判用旧 percent 每轮把耗尽 key 挑回 |
| 复现步骤 | 会话绑定 A（rolling 35%）；A 请求命中 rolling 429 → `handleUpstreamError` 把 status 置 `cooldown_rolling`，但 quota.rolling.percent 保持旧值 85；随后连续 4 次请求同一会话（`bug/regression/key-switch-sim.cjs` 场景 S3），观察 `getOrBindKey` 返回值 |
| 根因 | 旧 `go-gateway.cjs:254-257` 特判「cooldown_rolling 且 percent < preSwitchPct(90) 仍可用」用的是可能过期的 percent；429 路径只改 status 不刷窗口 percent。rolling 耗尽后每个请求都被挑回 A → 429 → failover 悄悄换 B，直到 15min 轮询把 percent 刷到 100 才解脱 |
| 回归脚本路径 | `bug/regression/key-switch-sim.cjs`（S3） |
| 修复分支 | fix/bug-008-drain-priority（未合入） |
| 验证记录 | 2026-08-22 修复：删除 cooldown_rolling 特判（rolling 冷却 key 一律不可服务）+ 新增 `markWindowLimited`（429 命中窗口时同步把 quota[w].status 置 rate-limited，防止轮询状态机读到过期 status 误判提前复活）。修复后 S3.1-3.4 全转绿（不再挑回耗尽 A）。全量回归 PASS=20 RED=0 |

## BUG-002

| 字段 | 内容 |
| --- | --- |
| 编号 | BUG-002 |
| 状态 | 回归测试通过 |
| 分类 | 社区代码 bug（缺陷在本项目网关代码本身） |
| 推送决策 | 仅本地修复 |
| 标题 | failover 循环无已尝试集合/次数上限，失败不改状态的 key 被无限重试，请求永不返回 |
| 复现步骤 | 原 key A 失败，唯一活动 key B 每次尝试均 5xx 且不改状态（`bug/regression/key-switch-sim.cjs` 场景 S9 桩），跑 failover 链，观察是否有限终止 |
| 根因 | 旧 `while ((fallback = pickBestKey(key.id)))` 只排除原 key；5xx、网络错（直接回 502）、无 `metadata.limitName` 的 429 都不改变 fallback key 的 status → `pickBestKey` 无限返回同一把失败 key，客户端请求挂死 |
| 回归脚本路径 | `bug/regression/key-switch-sim.cjs`（S9） |
| 修复分支 | fix/bug-008-drain-priority（未合入） |
| 验证记录 | 2026-08-22 修复：failover 逻辑抽取为 `failoverChain`，`pickBestKey` 支持 skipIds 排除已试 key，总上限 `MAX_FAILOVER=4`（每把 key 至多试一次）。修复后 S9 有界终止（A=2、B=1 次）。全量回归 PASS=20 RED=0 |

## BUG-003

| 字段 | 内容 |
| --- | --- |
| 编号 | BUG-003 |
| 状态 | 回归测试通过 |
| 分类 | 社区代码 bug（缺陷在本项目网关代码本身） |
| 推送决策 | 仅本地修复 |
| 标题 | 预切换无「更鲜才切」保护，全部 key 同时近限时会话在 key 间 ping-pong，每轮换 workspace 毁缓存 |
| 复现步骤 | 3 把 key 全 active 且 weekly 均 ≥90%（A95/B92/C94），会话绑定 A，连续 6 次请求（`bug/regression/key-switch-sim.cjs` 场景 S6），观察每次返回的 key |
| 根因 | `shouldPreSwitch` 用绝对阈值；一旦 bound ≥ 阈值就迁移，无「目标明显更鲜」判定 → B→C→B→C… 无限来回跳，提示词缓存（workspace 级）每轮被毁 |
| 回归脚本路径 | `bug/regression/key-switch-sim.cjs`（S6） |
| 修复分支 | fix/bug-008-drain-priority（未合入） |
| 验证记录 | 2026-08-22 修复：新增 `meaningfullyFresher`（任一窗口低 ≥10 个百分点才算明显更鲜，`PRECHECK_MARGIN=10`），不满足则不预切换（留原 key，让 429 failover 兜底）。修复后 S6 六轮全 A（稳定）。全量回归 PASS=20 RED=0 |

## BUG-004

| 字段 | 内容 |
| --- | --- |
| 编号 | BUG-004 |
| 状态 | 回归测试通过 |
| 分类 | 社区代码 bug（缺陷在本项目网关代码本身） |
| 推送决策 | 仅本地修复 |
| 标题 | 三档预切换阈值统一为 90 且 monthly 参与预切换，偏离设计（rolling 90 / weekly·monthly 95），healthy key 被误弃 |
| 复现步骤 | A active 且 monthly 90%、weekly 20%（健康）、B active（`bug/regression/key-switch-sim.cjs` 场景 S7），会话绑定 A，发一次请求，观察 key |
| 根因 | 旧 `shouldPreSwitch` 对 rolling/weekly/monthly 用同一 `preSwitchPct=90` 且 OR 合并。主方案 L3.3 设计是 rolling≥90%、weekly/monthly≥95%；monthly 是 $60/月长窗，几乎不作绑定约束，90% 就弃用 = 无谓换 workspace 毁缓存 |
| 回归脚本路径 | `bug/regression/key-switch-sim.cjs`（S7；阈值分档随 S6/S14 覆盖） |
| 修复分支 | fix/bug-008-drain-priority（未合入） |
| 验证记录 | 2026-08-22：`shouldPreSwitch` 移除 monthly（月额度走 drain，BUG-008 落地）+ 新增独立 `preSwitchWeeklyPct=95` 与 rolling `preSwitchPct=90` 分档。S7（绑定 drain 不弃用）、S6（近限不 ping-pong）、S14（预切换避开 drain）全绿。全量回归 PASS=20 RED=0 |

## BUG-005

| 字段 | 内容 |
| --- | --- |
| 编号 | BUG-005 |
| 状态 | 回归测试通过 |
| 分类 | 社区代码 bug（缺陷在本项目网关代码本身） |
| 推送决策 | 仅本地修复 |
| 标题 | 请求内 failover 成功不重绑会话，绑定晚一拍才切走，且 s.requests 归零 |
| 复现步骤 | 会话绑定 A（cooldown_weekly），下一请求（`bug/regression/key-switch-sim.cjs` 场景 S8）走 `getOrBindKey` → 重绑 B。期间失败请求（已由 B 服务）会话绑定仍是 A |
| 根因 | 旧 failover 成功分支 `streamThrough(res, nxt.res, fallback, …)` 未调 `bindSession(sessionId, fallback)`；迁移时把 `s.requests` 归零。仪表盘短暂显示会话挂在 cooldown key 上，计数被重置 |
| 回归脚本路径 | `bug/regression/key-switch-sim.cjs`（S8；failover 当场重绑随 failoverChain 覆盖） |
| 修复分支 | fix/bug-008-drain-priority（未合入） |
| 验证记录 | 2026-08-22 修复：`failoverChain` failover 成功分支 `if (sessionId) bindSession(sessionId, fallback)`，当场重绑，下个请求直连该 key。S8 保持绿（重绑 B）。全量回归 PASS=20 RED=0 |

## BUG-006

| 字段 | 内容 |
| --- | --- |
| 编号 | BUG-006 |
| 状态 | 回归测试通过 |
| 分类 | 社区代码 bug（缺陷在本项目网关代码本身） |
| 推送决策 | 仅本地修复 |
| 标题 | 网络抖动（非限额）不重试直接切 key，一次抖动 = 换 workspace 毁缓存 |
| 复现步骤 | 会话绑定 A（active 健康），A 上游网络错误一次（`bug/regression/key-switch-sim.cjs` 场景 S10 桩：A 永远 502、B 200），发一请求，统计各 key 尝试次数 |
| 根因 | 旧 `attemptForward` 网络错/超时直接回 `{stream:false,status:502}`；`forwardChat` 随即进入 failover 切 key，无同 key 重试。实际 S10：A 试 1 次即切 B。需求：仅网络类错误先在原 key 重试 2 次左右，再切其它 key；限额 429/401 才直接切换 |
| 回归脚本路径 | `bug/regression/key-switch-sim.cjs`（S10） |
| 修复分支 | fix/bug-008-drain-priority（未合入） |
| 验证记录 | 2026-08-22 修复：`failoverChain` 新增瞬时错误同 key 重试（`SAME_KEY_RETRIES=2`，`TRANSIENT` 判定 5xx/网络/超时；限额/401 不重试直接 failover）。修复后 S10：A 重试 2 次后才切 B（A=2、B=1）。全量回归 PASS=20 RED=0 |

## BUG-007

| 字段 | 内容 |
| --- | --- |
| 编号 | BUG-007 |
| 状态 | 假设验证中 |
| 分类 | 社区代码 bug（待验证；核心是设计缺口 + 未实测） |
| 推送决策 | 仅本地修复 |
| 标题 | 定时任务/无 title 会话的请求标识未验证；缺统一兜底（限额耗尽该停 vs 网络抖动该重试未分离） |
| 复现步骤 | ① 给网关转发面加可选请求头日志（x-session-id / role / 其它固定标记），本机跑一次 ZCode 定时任务（CronCreate 类），抓其每请求 header；② 观察定时任务会话是否带稳定 `x-session-id`、是否每次运行都新建会话（跨次运行无缓存复用）；③ 检查无 session title 的请求是否有固定标记（如 role=lite / cron 专用字段）可作为粘性回退键 |
| 根因 | 尚未验证（需 header 探针实测）。已知代码现状：`getOrBindKey` 只认 `x-session-id`，无任何回退标记；旧代码无统一兜底（无 active key 回 429+恢复时间、failover 耗尽回最后错误、网络错回 502，三类失败策略不统一，且没把「限额用尽（该停，带恢复时间）」与「网络抖动（该重试）」分开） |
| 回归脚本路径 | 暂无（待 header 探针 + 场景补进 `bug/regression/key-switch-sim.cjs`） |
| 修复分支 | 未创建 |
| 验证记录 | 2026-08-22 登记为验证项：未跑真实定时任务，header 行为仍未知。**统一兜底部分已由 2026-08-22 的 `failoverChain` 补上**（瞬时重试→有界 failover→耗尽如实回错+恢复时间），剩余待验证的是定时任务/无 title 会话的 header 与粘性回退标记 |

## BUG-008

| 字段 | 内容 |
| --- | --- |
| 编号 | BUG-008 |
| 状态 | 回归测试通过 |
| 分类 | 社区代码 bug（调度逻辑缺失，缺陷在本项目网关代码本身） |
| 推送决策 | 仅本地修复 |
| 标题 | 缺「反浪费」调度：monthly 近满 / 快到期的 key 应优先用完丢弃，而非因 high percent 被弃用 |
| 复现步骤 | A active 且 monthly 90%、weekly 20%（健康）、B active（`bug/regression/key-switch-sim.cjs` 场景 S7/S11）：会话绑定 A 发请求（S7）与全新会话选 key（S11），观察 —— 期望「drain 优先」让 A 被优先使用（用完即弃） |
| 根因 | 调度只有「躲开高用量 key」的预切换 + 周平衡，没有「优先用掉快用完的 key」的反浪费层。**核心推理（缓存核心，2026-08-22 用户确认）**：网关的唯一优化目标 = 提示词缓存命中率（缓存按 workspace/key 记，切换对 ZCode 无感、代价为零）→ 会话粘性最大化 = 缓存积累。月额度将尽（剩余 < 5h 窗口 ≈ monthly percent ≥80%，或临近续费日仍有剩余）的 key 注定死亡 → 其缓存无未来价值（会话迟早要迁走、必刷新一次）→ 周额度无关紧要 → 应**最高优先用完丢弃**。只有月额度健康的 key 才谈周平衡/防封（粘住 + 新会话按 weekly 剩余多分摊） |
| 回归脚本路径 | `bug/regression/key-switch-sim.cjs`（S7/S11/S12/S13/S14，均已转绿） |
| 修复分支 | fix/bug-008-drain-priority（未合入） |
| 验证记录 | 2026-08-22 实现并回归：`isDrainKey`（monthly≥80% 或距 resetsAt≤72h 且有剩余）、`compareKeys`（drain 优先→到期近→剩余少；balance 周剩余多→5h→并发）、`pickPreSwitchTarget`（预切换目标避开 drain key）；`shouldPreSwitch` 移除 monthly；`pickBestKey` 用 `compareKeys`；`getOrBindKey` 绑定 key 为 drain 时绝不预切换走。全量回归 PASS=20 RED=0（S7/S11/S12/S13/S14 全绿）。`node --check go-gateway.cjs` 通过、mock 模式启动 + /api/config + 聊天链路正常。真实环境 E2E 待 ≥2 把健康 key（当前仅 1 key 周限耗尽），未合入 main |
