@echo off
chcp 65001 >nul
title Emby 缺集检测 - Docker 停止
cd /d "%~dp0"

echo.
echo   正在停止容器...
echo.
docker compose down
echo.
echo   已停止。
echo.
timeout /t 2 >nul
