# desktop-touch MCP 生命周期方案（最终版：HTTP 引擎 + SessionStart 钩子守卫）

> 目录：`D:\develop\Trae\Me\tools\dt-mcp-watch\`
> 状态：2026-08-19 定稿。本文档供任何 AI/人复现、验证、回退整套机制。

## 1. 目标

desktop-touch 是桌面控制 MCP（代码在 `~/.desktop-touch-mcp/releases/v1.14.3/`，同一份代码支持 stdio 与 http 两种模式）。要求：

- **HTTP 层不变**：引擎以 `--http --port 23847` 单例运行，ZCode 通过 `type: http` 连接（所有会话共用一个引擎——桌面工具不能多开抢桌面）。
- **被 ZCode 启动（回调式），而不是后台常驻监测**：ZCode 一启动就触发拉起；后续任何触发被屏蔽（只启动一次）。
- **跟随 ZCode 退出**：ZCode 关闭后引擎自动停止，不留孤儿、不常驻。

## 2. 为什么不用前面两代方案（决策记录）

### v1：HTTP + Windows 计划任务 watcher —— 被否

`watch-zcode.js` 由计划任务 `DT-MCP-Shared-HTTP`（登录触发，`start-watch.vbs` 隐藏拉起）常驻：每 5s 轮询 `ZCode.exe`，在则保引擎、消失 60s 停引擎，watcher 永不退出。

- 缺点：watcher 是**永久后台常驻进程**（~55MB）；且它引用了当时借住在 `D:\OpenClaw\环境\node.exe` 的运行时（该目录 2026-08-19 已删除，node 统一迁到 `D:\APP\NodeJS\node.exe`）；计划任务登录即跑，与 ZCode 是否使用无关。
- 该计划任务已删除；`watch-zcode.js`/`start-watch.vbs` 保留作手动回退参考（已迁标准 node）。

### v2：stdio dt-owner 看守（每个会话一个进程）—— 被否，本文档记录原因

把 `dt-owner` 注册为 ZCode 的 stdio MCP：每个会话 spawn 一个；单例锁保证只有一个当 owner（守护引擎），其余要么退出、要么安静待命。

**放弃原因（实测数据，2026-08-19 本机测量）**：

| 进程 | RSS 实测 |
|---|---|
| desktop-touch 引擎（23847，两者都要付） | ~242 MB |
| owner / 空闲重复者 / 裸 node 基线 | ~55-58 MB |
| ZCode 会话进程数（常态） | ~5 |

总占用模型：v1 = 242 + 55 ≈ **297MB 恒定**；v2 = 242 + 55×N ≈ **520MB（N=5）**，随会话数线性上涨。用户常态 5 个会话 → v2 多花 ~220MB。

另外 v2 的重复者无论"退出"还是"待命"都有代价：退出 → ZCode 把 MCP 条目标红（用户明确不想要红色）；待命 → 每个会话一个 ~55MB 空闲进程，正是被否的内存来源。

**结论**：v2 把"每会话一个进程"的 MCP 模型套在"单例桌面工具"上，方向性错误。正确组合是：**引擎单例（HTTP 不变）+ 启动触发交给 ZCode 自身的钩子机制（hooks），而不是 MCP spawn**。

### v3（最终）：HTTP 引擎 + ZCode SessionStart 钩子 + dt-guard —— 采纳

ZCode 有官方 hooks 机制（七个事件，含 `SessionStart`；配置文件钩子需 `hooks.enabled: true`）。用 `SessionStart` 事件触发 `dt-guard.cjs`：

- **只启动一次**：dt-guard 用 PID 锁（`~/.desktop-touch-mcp/guard.lock`）；首个实例成为 owner，后续所有触发看到锁活着直接 exit 0（屏蔽）。
- **钩子不阻塞会话**：钩子进程 spawn 一份 detached 的自己做守护（否则钩子会把会话卡住），最多等 10s 引擎健康就返回 0——首个会话启动时引擎已就绪。
- **一直监测 + 跟随退出**：owner 每 5s 检查 `ZCode.exe`；在则保引擎健康（崩溃自动拉起）；消失满 60s（`DT_GUARD_IDLE_S` 可调）→ 停引擎、释放锁、退出。ZCode 下次启动 → 钩子再触发 → 新 owner 重新拉起。
- **陈旧锁接管**：owner 意外死亡，下一次触发直接接手。

## 3. 最终架构

```
ZCode 启动（开会话）
  │  hooks: SessionStart（config.json 的 hooks 块，type: process）
  ▼
node dt-guard.cjs（钩子进程，<10s 返回）
  ├── spawn 一份 detached 的自己做守护，然后等引擎健康、exit 0
  ▼
dt-guard（detached owner，单例）
  ├── guard.lock：后续触发全部屏蔽（exit 0）
  ├── 引擎 down → spawn 引擎：node dist/index.js --http --port 23847（detached，stdin 保持 pipe）
  │     ▲ 每 5s：引擎挂了自动拉起
  └── 每 5s：ZCode.exe 还在吗？
        └── 消失满 60s → 停引擎 → 释放锁 → 退出
```

ZCode 侧桌面工具：`mcp.servers["desktop-touch"] = { type: "http", url: "http://127.0.0.1:23847/mcp" }`——**保持不变**。

## 4. 文件清单

| 文件 | 作用 | 状态 |
|---|---|---|
| `dt-guard.cjs` | 本方案核心：钩子入口 + 单例锁 + 引擎守护 + 退出监测 | **在用** |
| `watch-zcode.js` / `start-watch.vbs` | v1 的 watcher（已迁标准 node） | 保留，手动回退参考 |
| `delete-openclaw.bat` / `.ps1` | 删除旧 OpenClaw 目录的提权脚本（任务已完成） | 保留，无副作用 |
| `~/.zcode/cli/config.json` | `mcp.servers["desktop-touch"]`(http) + `hooks`(SessionStart→dt-guard) | **在用** |
| `~/.desktop-touch-mcp/` | 引擎安装目录 + `guard.lock` + `dt-guard.log` | 运行时产物 |

## 5. AI 复现步骤

### 5.1 config.json（`~/.zcode/cli/config.json`）

```jsonc
{
  // ...其他键不动...
  "mcp": {
    "servers": {
      // desktop-touch 保持 http，任何方案都不改它：
      "desktop-touch": { "type": "http", "url": "http://127.0.0.1:23847/mcp", "timeoutMs": 60000 }
    }
  },
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        {
          "hooks": [
            {
              "type": "process",
              "command": "D:\\APP\\NodeJS\\node.exe",
              "args": ["D:/develop/Trae/Me/tools/dt-mcp-watch/dt-guard.cjs"],
              "timeoutMs": 20000
            }
          ]
        }
      ]
    }
  }
}
```

要点（来自 ZCode hooks 文档 `zcode-guide:diagnosing-hooks`）：
- 配置文件钩子**默认禁用**，必须 `hooks.enabled: true`。
- 事件名只能是七个之一，此处用 `SessionStart`；`matcher` 省略 = 匹配所有（startup/resume/clear/compact），重复触发交给锁屏蔽。
- `type: process` 用 `args[]`（不走 shell，Windows 最稳）；`timeoutMs` 是毫秒（process 用 ms，command 用秒——别混）。
- 钩子 stdout 必须是合法 JSON 或为空；dt-guard 不输出任何东西、总是 exit 0（非 0 会被记错误）。

### 5.2 dt-guard.cjs

本目录的 `dt-guard.cjs` 即可，无需构建。自守护化 + 单例锁 + 引擎守护 + 退出监测都在里面。

### 5.3 验证命令

```powershell
# 引擎健康
Invoke-WebRequest -Uri 'http://127.0.0.1:23847/health' -UseBasicParsing -TimeoutSec 3
# 锁内容（owner pid）
Get-Content 'C:\Users\duanz\.desktop-touch-mcp\guard.lock'
# 日志（owner acquired / shielded / engine healthy / zcode gone）
Get-Content 'C:\Users\duanz\.desktop-touch-mcp\dt-guard.log' -Tail 20
# 进程（应只有 1 个引擎 + 1 个 dt-guard，无论开几个会话）
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*dt-guard*' -or $_.CommandLine -like '*--http*') }
```

### 5.4 单机自测（不依赖 ZCode 重启，四条路径已全部实测通过）

```powershell
# 路径1 赢家：模拟 ZCode 在（TEST_ZCODE=1），应抢锁+起引擎+健康
$env:DT_GUARD_DETACHED='1'; $env:DT_GUARD_TEST_ZCODE='1'
Start-Process node -ArgumentList 'D:\develop\Trae\Me\tools\dt-mcp-watch\dt-guard.cjs' -WindowStyle Hidden

# 路径2 屏蔽：再跑一个，应 log "shielded" 立即退出
$env:DT_GUARD_DETACHED='1'; $env:DT_GUARD_TEST_ZCODE='1'
node D:\develop\Trae\Me\tools\dt-mcp-watch\dt-guard.cjs

# 路径3 钩子态：无 DETACHED，应 spawn detached 自己 + 等健康 + exit 0
$env:DT_GUARD_TEST_ZCODE='1'
node D:\develop\Trae\Me\tools\dt-mcp-watch\dt-guard.cjs

# 路径4 退出：模拟 ZCode 消失 + 5s 空闲阈值，约 10s 后引擎应停、锁应释放
# （先杀掉上面的 owner 和引擎、删 guard.lock）
$env:DT_GUARD_DETACHED='1'; $env:DT_GUARD_TEST_ZCODE='0'; $env:DT_GUARD_IDLE_S='5'
Start-Process node -ArgumentList 'D:\develop\Trae\Me\tools\dt-mcp-watch\dt-guard.cjs' -WindowStyle Hidden
```

## 6. 验收清单

1. 重启 ZCode，打开任务管理器：desktop-touch 只有 **1 个引擎进程 + 1 个 dt-guard**，多开几个会话数量不变。
2. MCP 面板：desktop-touch 条目正常（http 直连，无红色）；不再有 dt-owner 条目。
3. `dt-guard.log`：首次 `owner acquired` + `engine healthy`；之后可能出现的 `hook:` 行和 `shielded:` 行都正常。
4. 关掉所有 ZCode 窗口，等 60s：引擎和 dt-guard 一起消失，23847 变冷。
5. 再次打开 ZCode：钩子重新拉起，回到第 1 步状态。

## 7. 回退与故障排查

- **回退到 v1（计划任务 watcher）**：恢复 config 的 `hooks` 块删除、重建计划任务（动作 `wscript.exe "D:\develop\Trae\Me\tools\dt-mcp-watch\start-watch.vbs"`、登录触发）。
- **钩子没触发**（日志无新行）：先查 `hooks.enabled: true` 是否在；`SessionStart` 拼写；ZCode 日志里 hook 执行记录（fired/timed out/failed）。
- **钩子报错/阻塞**：dt-guard 只输出空 + exit 0，不应阻塞；若超时先看 `timeoutMs` 是否误写成秒。
- **引擎起不来**：手动跑 `node dt-guard.cjs` 看日志；确认 `D:\APP\NodeJS\node.exe` 存在、引擎 cwd 正确（引擎按相对路径解析 assets）。
- **锁卡死**：`guard.lock` 里 pid 已死仍残留 → 直接删文件即可（陈旧锁本来就会被接管，删了更干净）。
