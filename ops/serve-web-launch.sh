#!/bin/sh
# serve-web 的启动器（由 Mac 上的 launchd 通过 SSH 拉起）
# 为什么要单独成脚本：远程命令若把 "serve-web.js" 写在自己的命令行里，
# 用 pkill -f 清理旧进程时会匹配到自身而自杀（ssh 只返回 255，无任何报错）。
# 把逻辑放进脚本后，该 shell 的 cmdline 是 .../serve-web-launch.sh，不含 .js，不会自伤。
pkill -f "[s]erve-web\.js" >/dev/null 2>&1
sleep 0.3
exec node /root/serve-web.js --host 0.0.0.0 --port 8080
