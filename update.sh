#!/usr/bin/env bash
# Emby 缺集检测工具 - 更新脚本
#
# 用法（在服务器上，项目目录内执行）：
#   chmod +x update.sh && ./update.sh
#
# 它会：
#   1. 记录当前版本（方便回滚）
#   2. 拉取最新镜像
#   3. 重建容器
#   4. 自动健康检查，失败则提示回滚
#
# 数据不会丢：扫描结果存在浏览器里，服务器只挂载 ./data（若有）。

set -u

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.ghcr.yml}"
SERVICE="${SERVICE:-emby-missing-episodes}"
APP_PORT="${APP_PORT:-8787}"
HEALTH_PATH="${HEALTH_PATH:-/__health}"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "✗ 找不到 docker compose，请先安装 Docker。"
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "✗ 找不到 $COMPOSE_FILE"
  echo "  若用源码构建方式，请执行: COMPOSE_FILE=docker-compose.yml ./update.sh"
  exit 1
fi

echo "=============================================="
echo " Emby 缺集检测工具 - 更新"
echo "=============================================="

# ---------- 1. 记录当前版本 ----------
echo
echo "[1/4] 记录当前版本"
OLD_IMAGE="$($DC -f "$COMPOSE_FILE" images "$SERVICE" 2>/dev/null | awk 'NR==2{print $3}' || true)"
OLD_ID="$(docker inspect --format='{{.Image}}' "$SERVICE" 2>/dev/null || true)"
if [ -n "$OLD_ID" ]; then
  echo "  当前容器镜像: ${OLD_IMAGE:-未知}  (${OLD_ID:0:19})"
  echo "  回滚命令: IMAGE_TAG=${OLD_IMAGE##*:} $DC -f $COMPOSE_FILE up -d"
else
  echo "  容器当前未运行，视为首次安装。"
fi

# ---------- 2. 拉取最新镜像 ----------
echo
echo "[2/4] 拉取最新镜像"
if ! $DC -f "$COMPOSE_FILE" pull; then
  echo "  ✗ 拉取失败。常见原因："
  echo "    - 服务器访问 ghcr.io 超时（国内偶发，重试一次试试）"
  echo "    - 网络代理问题"
  echo "  容器未被改动，服务仍是旧版本。"
  exit 1
fi
NEW_IMAGE="$($DC -f "$COMPOSE_FILE" images "$SERVICE" 2>/dev/null | awk 'NR==2{print $3}' || true)"
echo "  新镜像: ${NEW_IMAGE:-未知}"

# ---------- 3. 重建容器 ----------
echo
echo "[3/4] 重建容器"
$DC -f "$COMPOSE_FILE" up -d

# ---------- 4. 健康检查 ----------
echo
echo "[4/4] 健康检查"
DEADLINE=$(( $(date +%s) + 45 ))
CODE="000"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" 2>/dev/null || echo '000')"
  [ "$CODE" = "200" ] && break
  sleep 2
done

echo
echo "=============================================="
if [ "$CODE" = "200" ]; then
  echo " ✓ 更新成功，服务正常（HTTP 200）"
  echo "=============================================="
  echo
  echo " 清理旧镜像可释放磁盘（可选）："
  echo "     docker image prune -f"
else
  echo " ✗ 服务未就绪（HTTP $CODE）"
  echo "=============================================="
  echo
  echo " 查看日志定位："
  echo "     $DC -f $COMPOSE_FILE logs --tail=50"
  echo
  if [ -n "$OLD_ID" ]; then
    echo " 快速回滚到更新前版本："
    echo "     IMAGE_TAG=${OLD_IMAGE##*:} $DC -f $COMPOSE_FILE up -d"
  fi
  exit 1
fi
