@echo off
chcp 65001 >nul
title Emby 缺集检测 - Docker 启动
cd /d "%~dp0"

echo.
echo   ============================================
echo     Emby 缺集检测工具 - Docker 启动器
echo   ============================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Docker
  echo.
  echo   请先安装 Docker Desktop: https://www.docker.com/products/docker-desktop/
  echo   安装并启动 Docker 后，重新双击本文件。
  echo.
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo   [错误] Docker 没有运行
  echo.
  echo   请先启动 Docker Desktop（任务栏找那只小鲸鱼图标），
  echo   等它完全启动后，重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo   正在构建并启动容器（首次运行需要下载镜像，可能要几分钟）...
echo.

docker compose up -d --build
if errorlevel 1 (
  echo.
  echo   [错误] 启动失败，请看上面的提示。
  echo.
  pause
  exit /b 1
)

echo.
echo   启动成功！浏览器即将打开 http://localhost:8787
echo.
timeout /t 2 /nobreak >nul
start "" http://localhost:8787

echo   容器正在后台运行，可以关闭这个窗口。
echo.
echo   要停止服务，双击  停止docker.bat
echo.
pause
