@echo off
rem QuantHub 启动脚本 —— 由 explorer 代启动以脱离工具会话 Job Object，实现常驻
cd /d D:\QuantHub
set HUB_PORT=8791
set HUB_NEWS_INTERVAL=60000
set HUB_NEWS=1
"C:\Users\liaolc\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" D:\QuantHub\server.js >> D:\QuantHub\hub.log 2>> D:\QuantHub\hub.err