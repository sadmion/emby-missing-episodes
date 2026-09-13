@echo off
chcp 65001 >nul
title Emby 缺集检测 - 本地代理
cd /d "%~dp0"

echo.
echo   ============================================
echo     Emby 缺集检测工具 - 本地代理启动器
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js
  echo.
  echo   请先安装 Node.js: https://nodejs.org/
  echo   安装后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo   正在启动代理服务...
echo.
echo   浏览器会自动打开：http://127.0.0.1:8787
echo   使用完关闭这个黑色窗口即可停止服务。
echo.

:: 先静默启动服务，稍等端口就绪后再打开浏览器，避免抢跑
start "" /b node emby-proxy.js
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8787

echo   服务运行中。按任意键停止服务并退出...
pause >nul

taskkill /f /im node.exe >nul 2>nul
echo.
echo   服务已停止。
timeout /t 2 >nul
