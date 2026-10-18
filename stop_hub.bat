@echo off
rem QuantHub 停止脚本
taskkill /F /IM node.exe /FI "WINDOWTITLE eq *" >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8791"') do taskkill /F /PID %%p >nul 2>&1
echo QuantHub stopped
pause