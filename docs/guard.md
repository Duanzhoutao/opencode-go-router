# 生命周期守护：go-guard 与 ZCode 钩子机制

`go-guard.cjs` 解决一个问题：**网关不常驻**。你不想让一个 Node 进程开机自启、永远挂在后台——那就让它**跟随 ZCode 启停**：ZCode 一启动，网关自动拉起；ZCode 关掉 60 秒后，网关自动停止、释放锁。全程不需要你手动管。

> 不想要这个行为？直接手动 `node go-gateway.cjs` 运行网关即可，go-guard 完全可选。

## 总览：一次完整的启停周期

```
ZCode 启动（任意会话开启）
  │  触发 SessionStart 钩子 → node go-guard.cjs（钩子进程）
  │    ├── spawn 一份 detached 的自己作为常驻守护（避免钩子阻塞会话）
  │    └── 最多等 10 秒网关健康（http://127.0.0.1:8788/health 200）→ exit 0
  ▼
go-guard（detached 常驻，单例）
  ├── 抢到 ~/.opencode-go-router/guard.lock（PID 锁）；后续钩子触发看到锁活着 → 直接 exit（屏蔽重复启动）
  ├── 每 5 秒：网关健康吗？不健康 → 自动拉起（崩溃自愈）
  └── 每 5 秒：ZCode.exe 还在吗？
        └── 消失满 60 秒 → 停网关（按命令行精确匹配 node 进程）→ 释放锁 → 守护退出
ZCode 下次启动 → 钩子再触发 → 新守护重新拉起（循环）
```

## 第一步：配置 ZCode 钩子（一次性）

编辑 `~/.zcode/cli/config.json`（注意是 `cli` 这份，provider 配置在 `v2` 那份），在 `hooks` 块加 SessionStart 钩子：

```jsonc
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        {
          "hooks": [
            {
              "type": "process",
              "command": "node",                              // 或 node.exe 绝对路径
              "args": ["D:/path/to/opencode-go-router/go-guard.cjs"],  // 换成你的仓库绝对路径
              "timeoutMs": 20000
            }
          ]
        }
      ]
    }
  }
}
```

要点（配错是不生效的最常见原因）：

- **`hooks.enabled: true` 必须显式设置**——配置文件里的钩子默认禁用。
- `type: process` 用 `args[]` 传脚本路径，不走 shell（Windows 上最稳）；路径用正斜杠 `/`。
- `matcher` 省略 = 匹配所有启动场景（startup/resume/clear/compact），重复触发由 PID 锁屏蔽，无需担心。
- `timeoutMs` 是毫秒；钩子进程最多等 10 秒网关健康就返回，不会卡住会话启动。
- 钩子进程**不输出任何内容、总是 exit 0**（ZCode 把非零退出记为错误）——go-guard 已保证。

## 触发后发生了什么（时序）

1. **自守护化**：钩子调起的 go-guard 立刻 spawn 一份 detached 的自己（`GO_GUARD_DETACHED=1`）作为真正守护，避免钩子进程活着拖住 ZCode 会话。
2. **就绪等待**：钩子进程轮询 `/health`，网关 200 就 `exit 0`（最多 10 秒）——保证你第一个会话发出请求时网关已就绪。
3. **单例锁**：detached 守护抢 `~/.opencode-go-router/guard.lock`（记录 PID）。抢到的成为 owner；此后所有钩子触发看到锁里的 PID 活着就退出——**网关与守护全程只有一份**。
4. **陈旧锁接管**：owner 意外死亡（崩溃/被杀）锁会残留，但下次触发检查 PID 已死，直接接手，不会卡死。

## 常驻行为（owner 守护循环，每 5 秒）

- **ZCode 在**（进程列表能查到 `ZCode.exe`）→ 确保网关健康；`/health` 不通就重新拉起 `node go-gateway.cjs --port <PORT>`（崩溃自愈，最多等 60 秒确认）。
- **ZCode 消失** → 开始计时；**连续消失满 60 秒**（`GO_GUARD_IDLE_S` 可调）→ 用 PowerShell 7 按命令行精确匹配 `go-gateway.cjs --port <PORT>` 杀掉网关进程 → 删除锁文件 → 守护自身退出。

## 文件与日志

| 路径 | 内容 |
|---|---|
| `~/.opencode-go-router/guard.lock` | PID 锁（JSON：`{pid, startedAt}`）；守护退出时自动删除 |
| `~/.opencode-go-router/go-guard.log` | 守护日志（拉起/屏蔽/退出等关键事件，按行追加） |
| `~/.opencode-go-router/` 之外的网关状态 | `keys.json` 在网关脚本目录（见 configuration.md） |

排查启停问题**先看 `go-guard.log`**，每次拉起/屏蔽/收摊都有记录。

## 平台说明（重要）

当前实现针对 **Windows**：进程探测用 `tasklist` 查 `ZCode.exe`、停网关用 PowerShell 7 按 CommandLine 匹配。macOS / Linux 用户：

- 网关本体（`go-gateway.cjs`）跨平台无问题，直接手动 `node go-gateway.cjs` 或交给 systemd / launchd；
- 想用跟随启停，需按同样模式替换 `go-guard.cjs` 里的 `zcodeRunning()`（进程探测）与 `stopEngine()`（按命令行停进程）两处，其余逻辑（锁/自守护/空闲退出）平台无关；母本设计记录见 `reference/dt-mcp-watch/`。

## 端口改动

默认 8788。改端口时：钩子触发的 go-guard 读 `GO_PORT` 环境变量（可在钩子 `command`/系统环境里设置），网关由守护以 `--port <PORT>` 显式拉起，两边保持一致即可。

## 测试与手动操作

```bash
# 伪造 ZCode 存在/消失 + 缩短空闲退出秒数（5 秒收摊），快速验证整套机制
GO_GUARD_TEST_ZCODE=1 GO_GUARD_IDLE_S=5 node go-guard.cjs   # 假装 ZCode 在：拉起并保活网关
GO_GUARD_TEST_ZCODE=0 GO_GUARD_IDLE_S=5 node go-guard.cjs   # 假装 ZCode 不在：5 秒后停网关退出

# 手动启动网关（不经守护，最直接）
node go-gateway.cjs

# 手动停止：结束 node 进程即可；若守护还活着，它会在 ZCode 退出后统一收摊
```

## 排障速查

| 症状 | 排查顺序 |
|---|---|
| ZCode 启动了但网关没起来 | ① `~/.zcode/cli/config.json` 的 `hooks.enabled` 是否为 true、JSON 是否合法、脚本路径是否正确；② 看 `~/.opencode-go-router/go-guard.log` 有没有拉起记录；③ 手动 `node go-gateway.cjs` 验证网关本体正常（本体 OK 再查钩子） |
| 网关起了但总是莫名退出 | 大概率是正常收摊：ZCode 不在 60 秒后守护主动停网关（看 go-guard.log）；想常驻就手动启动网关、不装钩子 |
| 端口被占 | 换 `GO_PORT`；或找到占用 8788 的旧网关进程结束它（守护按 `--port` 精确匹配，不会误杀其他 node 进程） |
| 锁残留（守护异常死亡后） | 无需处理：下次触发检测 PID 已死会自动接管；手动清理可直接删 `~/.opencode-go-router/guard.lock` |
| 钩子一直不触发 | 用 ZCode 自带的 hooks 诊断（`zcode-guide:diagnosing-hooks`）；确认配置文件路径是 `~/.zcode/cli/config.json` 这一份 |
