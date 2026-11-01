# 开发日志：workspace 浏览器访问服务（Mac launchd + SSH 隧道 + 看门狗）

> 日期：2026-11-01
> 定位：**单个功能的完整开发记录** —— 需求、选型、实现、踩坑、验证、运维
> 涉及机器：Mac mini（M2，10.0.0.4，`YGS-Mac-mini-2.local`）、沙箱容器（Linux x86_64，10.0.0.10）
> 交付物：`serve-web.js`(283 行) + `serve-web-launch.sh`(8 行) + `com.yuangs.workspace-serve.plist`(69 行)

---

## 一、需求

> "有没有办法把 workspace 目录通过服务拉起来，我可以浏览器访问？"
> "在我搞个系统服务，用 watchdog 拉起来"

拆成三条硬要求：

1. **浏览器可访问**：能列出目录、点开文件、下载文件；
2. **系统服务**：开机/登录后自动起，不用手工 `nohup`；
3. **看门狗**：进程挂了、链路断了，能自动拉回来。

隐含约束：

- 文件在**沙箱容器**里（`/root/mdviewer`、`/workspace`），不在 Mac 上；
- 不能把整台机器暴露出去（容器里有 `~/.ssh`、`~/.pi` 等）；
- 沙箱是**临时容器**，随时可能重建。

---

## 二、选型

### 2.1 为什么不用 `python3 -m http.server`

最省事，但它会把**整个目录树原样吐出**，包括 `.ssh`、`.git`、`.pi`。在"给人浏览"的场景里这是不可接受的。

### 2.2 为什么服务不能只跑在 Mac 上

文件在沙箱里。Mac 上起服务只能服务 Mac 的目录，除非做 rsync —— 那又变成"看的是副本"，不是"工作目录"。

### 2.3 为什么沙箱里不做"系统服务"（systemd）

```
PID 1        = docker-init
systemctl    = offline（二进制存在，但没有 systemd 作为 PID 1）
supervisord  = 不存在
```

容器内没有可用的服务管理器；改 harness 的启动配置既会被覆盖，也不该动。

### 2.4 最终方案：**一条 SSH 会话 = 隧道 + 进程守护**

```
┌──────────── Mac (10.0.0.4) ────────────┐        ┌───────── 沙箱 (10.0.0.10) ─────────┐
│ launchd: com.yuangs.workspace-serve    │        │                                     │
│   KeepAlive = true                     │        │                                     │
│   ThrottleInterval = 10                │        │                                     │
│        │                               │        │                                     │
│        └── /usr/bin/ssh ─── WireGuard ────────▶ │  /bin/sh /root/serve-web-launch.sh  │
│              -L 127.0.0.1:8093:127.0.0.1:8080   │        └── exec node serve-web.js   │
│              ServerAliveInterval=15             │                 --port 8080         │
│              ExitOnForwardFailure=yes           │                                     │
│                                                │                                     │
│  浏览器 → http://localhost:8093/                │                                     │
└────────────────────────────────────────────────┘                                     │
                                      容器内仍是 0.0.0.0:8080 → 内网设备可直连 10.0.0.10:8080
```

核心洞察：**把"远程命令"设计成服务本体**。

- `ssh` 带远程命令时会一直挂着，直到远程命令退出；
- 远程命令是 `exec node serve-web.js`，所以 **node 死 = 会话结束 = ssh 退出码非 0**；
- launchd 的 `KeepAlive` 看到 ssh 退出就立刻重启 —— 重启的是一条完整链路（重连 + 重启远程服务）。

于是只需要**一个** launchd 任务，两端都自愈，不需要在沙箱里另造一层守护。

---

## 三、实现

### 3.1 `serve-web.js`（283 行，零依赖）

不用 `http-server`/`serve` 之类，因为：要的就是"完全控制白名单与隐藏规则"，引依赖反而更麻烦。

| 设计点 | 做法 | 为什么 |
|---|---|---|
| 白名单挂载 | `MOUNTS = [{'/mdviewer' → /root/mdviewer}, {'/workspace' → /workspace}]` | 根目录不开放，未挂载的路径一律 404 |
| 防路径穿越 | `path.resolve` 后 `fs.realpathSync`，再校验 `real === dir || real.startsWith(dir + sep)` | 光校验字符串会被符号链接绕过；realpath 之后再比才可靠 |
| 隐藏点文件 | 路径任一段以 `.` 开头即 404 | `.git/config`、`.env` 之类的默认保护 |
| 只读 | 只放行 `GET`/`HEAD`，其余 405 | 不提供任何写入面 |
| 目录列表 | 自绘 HTML（暗色、大小、修改时间、可点） | `python -m http.server` 的列表不带大小排序 |
| Range | 解析 `Range: bytes=a-b`，回 206 + `Content-Range` | 大文件/视频可拖进度 |
| 条件请求 | `ETag = W/"size-mtime"`，命中回 304 | 目录页 `no-cache`，二次访问不重复传输 |
| 可选鉴权 | `SERVE_PASS=xxx` 时要求 Basic Auth | 将来要上公网时一行环境变量就能加锁 |
| 日志 | 每请求一行：`时间 方法 路径 状态码 耗时` | 排查"为什么慢/为什么 401"的第一手材料 |

安全自测（当时跑的）：

```
/etc/passwd                                  → 404
/mdviewer/.git/config                        → 404
/../root/.ssh/id_ed25519                     → 404
/mdviewer/%2e%2e%2f..%2froot%2f.ssh%2f...    → 404
```

### 3.2 `serve-web-launch.sh`（8 行，**这个文件是被坑出来的**）

```sh
#!/bin/sh
pkill -f "[s]erve-web\.js" >/dev/null 2>&1
sleep 0.3
exec node /root/serve-web.js --host 0.0.0.0 --port 8080
```

它存在的唯一原因见 §4.2。

### 3.3 `com.yuangs.workspace-serve.plist`（LaunchAgent）

关键字段与理由：

| 字段 | 值 | 理由 |
|---|---|---|
| `ProgramArguments` | `/usr/bin/ssh -L 127.0.0.1:8093:127.0.0.1:8080 root@10.0.0.10 exec /bin/sh /root/serve-web-launch.sh` | 一条会话承担隧道 + 守护 |
| `KeepAlive` | `true` | 无论怎么退出都重启 —— 这就是"看门狗" |
| `ThrottleInterval` | `10` | 失败时不疯狂重启、不刷爆日志 |
| `RunAtLoad` | `true` | 加载即启动（配合开机自动登录即"开机自启"） |
| `ExitOnForwardFailure` | `yes` | **端口撞车要立刻失败**，而不是静默起来却不转发（否则你会以为服务好了） |
| `ServerAliveInterval` / `CountMax` | `15` / `3` | 链路僵死 45 秒内主动断开 → 触发重启，避免"TCP 还在但实际不通" |
| `StrictHostKeyChecking` | `no` + `UserKnownHostsFile=/dev/null` | 沙箱是临时容器，重建必换主机密钥；严格校验会让看门狗**永久卡在握手失败** |
| `StandardOutPath/ErrorPath` | `~/Library/Logs/workspace-serve.log` | 日志统一落一处 |
| `Nice` | `5` | 后台服务让出优先级 |

---

## 四、踩坑（本文最有价值的部分）

### 4.1 坑一：端口撞车，且失败是"静默"的

第一次用 8090：

```
$ lsof -nP -iTCP:8090 -sTCP:LISTEN
knowly-da 34382 ygs ... TCP *:8090 (LISTEN)      ← 已被 knowly-daemon 占用
```

现象：`launchctl` 显示 `state = running`（其实是"即将重启"），但访问 8090 拿到的是 **knowly-daemon 的 401**，503/404 都没出现 —— 极容易被误判成"我的服务起了但鉴权没配对"。

排查时把 Mac 已占端口全扫了一遍：

```
8080 → podcastd
8090 → knowly-daemon
8093 → 空闲   ← 最终采用
```

教训：**转发失败必须显式失败**（`ExitOnForwardFailure=yes`），并且**先确认端口占用**再定端口。

### 4.2 坑二：`pkill -f` 把自己杀了，ssh 只回 255 且没有任何报错

最初的远程命令是"一行流"：

```
pkill -f "[s]erve-web\.js" >/dev/null 2>&1; sleep 0.3; exec node /root/serve-web.js --host 0.0.0.0 --port 8080
```

方括号技巧 `[s]erve-web` 只解决了"pkill 自己的模式串"这一半 —— 但**同一条命令行里还有后半段的 `exec node /root/serve-web.js`**，其中的 `serve-web.js` 完全匹配 `[s]erve-web\.js`。于是：

1. shell 启动 → cmdline 包含 `serve-web.js`；
2. `pkill -f` 扫描全表 → 命中自己的 shell → 把自己 kill 掉；
3. ssh 看到远程进程被信号杀死 → **返回 255，日志里只有一行 host key 警告**，没有任何错误说明。

排查代价：两轮（先怀疑 CORS、再怀疑密钥、再怀疑 `[vars]` 配置），最后用"手工跑一次同样的命令"才定位 —— 手工跑时因为引号层级不同，模式被 mangled，反而**没**自杀，所以两次现象不一致，更迷惑。

修法：**把逻辑挪进脚本**。脚本的 cmdline 是 `/bin/sh /root/serve-web-launch.sh`，不含 `.js`，pkill 扫不到自己；而 node 的 cmdline 是 `node /root/serve-web.js ...`，下一次能被正确清理。

教训：**任何"kill 模式串"和"目标串"共处一行**的地方，都要么用方括号 + 保证目标串不出现在同一行，要么拆成脚本。

### 4.3 坑三：容器重建会换主机密钥

沙箱是临时容器，重建后 `ssh-ed25519` 主机密钥必变。若用默认的 `StrictHostKeyChecking=ask/yes`，看门狗每次都在握手阶段失败，表现是"服务永远起不来，日志里全是 host key mismatch"。

在**私有 WireGuard 网络**内，这里选择 `StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null`（不写盘、不留残留），换取"容器重建后自动恢复"。

教训：**看门狗的可恢复性目标，决定了它该容忍哪些错误**。容忍 MITM 的前提是链路本身已加密（WireGuard）。

---

## 五、验证

### 5.1 功能

| 项 | 结果 |
|---|---|
| 首页 `/` | 200，826 B（两个挂载点导航） |
| 目录 `/mdviewer/` | 200，可以列出全部文件（含 docs/ 5 篇 md） |
| 文件 `/mdviewer/VERSION` | 200，4 B |
| 编辑器 `/mdviewer/index.html` | 200，35793 B；`app.js` 273549 B；`lib/md-core.js` 30273 B |
| 中文路径 `/mdviewer/docs/2026-11-01-开发日志.md` | 200，12942 B（URL 编码正常） |
| 从 Mac 侧测 | 全部 200，首字节 1–2 秒（WireGuard RTT ≈ 380 ms） |

### 5.2 安全（必须全 404）

```
/etc/passwd、/mdviewer/.git/config、/../root/.ssh/id_ed25519、URL 编码变体
```

### 5.3 看门狗（双故障注入）

| 注入 | 观察 | 结果 |
|---|---|---|
| `pkill` 沙箱里的 node | 立即 `HTTP 000` | **5 秒**后恢复，node pid 变更（1447031 → 1449038） |
| `kill -9` Mac 上的 ssh | 立即 `HTTP 000` | **3 秒**后恢复，ssh pid 变更（19379 → 19525） |
| `launchctl print` | `state = running`、`runs = 3`、`last exit = never` | 与两次注入吻合 |

### 5.4 幂等性

重启后再次确认沙箱内**只有一个** node 实例（`pgrep -af "[s]erve-web\.js"` 只返回一条）—— 说明 `pkill` + `sleep 0.3` + `exec` 这套"先清后起"是有效的，没有端口冲突堆积。

---

## 六、运维手册

```bash
# 状态 / 重启 / 停止
launchctl print     gui/$(id -u)/com.yuangs.workspace-serve
launchctl kickstart -k gui/$(id -u)/com.yuangs.workspace-serve
launchctl bootout   gui/$(id -u)/com.yuangs.workspace-serve

# 日志（访问日志与 ssh 告警都在这里）
tail -f ~/Library/Logs/workspace-serve.log

# 改本地端口：改 plist 里的 -L 值 → kickstart
# 改挂载目录：改 serve-web.js 的 addMount() → kickstart（远程会重新拉脚本）

# 容器重建后恢复（脚本已备份在 Mac）
scp ~/Library/Application\ Support/workspace-serve/serve-web.js \
    ~/Library/Application\ Support/workspace-serve/serve-web-launch.sh root@10.0.0.10:/root/ && \
launchctl kickstart -k gui/$(id -u)/com.yuangs.workspace-serve
```

文件分布：

| 文件 | 位置 |
|---|---|
| plist | `~/Library/LaunchAgents/com.yuangs.workspace-serve.plist` |
| 日志 | `~/Library/Logs/workspace-serve.log` |
| 脚本备份 | `~/Library/Application Support/workspace-serve/` |
| 沙箱运行副本 | `/root/serve-web.js`、`/root/serve-web-launch.sh` |

---

## 七、已知限制与后续

| 限制 | 影响 | 计划 |
|---|---|---|
| `.md` 按纯文本显示 | 表格/代码块不渲染，当文档读很难受 | 加 `marked` + `DOMPurify` 渲染，保留 `?raw=1` / `?download=1` |
| 无鉴权 | 仅限 WireGuard 内网可接受；上公网必须加锁 | 已支持 `SERVE_PASS`，配合 `cloudflared` 前先设密码 |
| LaunchAgent 需登录会话 | 锁屏可以，注销/重启未登录则不起 | 需要时改 LaunchDaemon（`/Library/LaunchDaemons` + sudo） |
| 依赖沙箱存活 | 容器重建后脚本需重推（已备份，一条命令） | 可加重试提示；或在 plist 里前置一次自动 scp |
| 单实例、无连接池 | 个人使用足够（`node` 单进程，静态文件场景不是瓶颈） | 需要时加 `cluster` |

---

## 八、教训清单（可复用）

1. **端口撞车的失败是静默的** —— 一定开 `ExitOnForwardFailure`，先扫占用再定端口。
2. **`pkill -f` 会匹配自己** —— 模式串与目标串不要共处一行，拆脚本最稳。
3. **ssh 返回 255 且无输出**，先怀疑"远程进程被信号杀死"，而不是网络或密钥。
4. **看门狗要针对"最可能发生的故障"设计容错**：临时容器的最大故障是"主机密钥变了"，所以宁可放弃 host key 校验（链路已由 WireGuard 加密）。
5. **一条长连会话可以同时承担隧道与守护** —— 少一层守护进程，少一半的故障面。
6. **服务对象在别人的机器上（容器）时，守护放"稳定的一端"**：沙箱无 systemd，Mac 有 launchd，就把看门狗放在 Mac。
