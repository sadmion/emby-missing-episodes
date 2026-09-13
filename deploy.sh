#!/usr/bin/env bash
# Emby 缺集检测工具 - 服务器一键部署脚本（Linux / macOS）
#
# 用法：
#   chmod +x deploy.sh
#   ./deploy.sh
#
# 脚本会：检查 Docker → 准备 .env → 构建并启动 → 显示访问方式

set -euo pipefail

cd "$(dirname "$0")"

echo ""
echo "  ============================================"
echo "    Emby 缺集检测工具 - 服务器部署"
echo "  ============================================"
echo ""

# ---------- 1. 检查 Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  echo "  [错误] 没有找到 docker，请先安装。"
  echo ""
  echo "  Ubuntu / Debian:"
  echo "    curl -fsSL https://get.docker.com | sh"
  echo ""
  echo "  CentOS / 阿里云 Linux:"
  echo "    curl -fsSL https://get.docker.com | sh"
  echo "    sudo systemctl enable --now docker"
  echo ""
  echo "  国内服务器如果下载慢，可用阿里云镜像脚本，参考："
  echo "    https://help.aliyun.com/zh/ecs/use-cases/install-and-use-docker-on-a-linux-ecs-instance"
  echo ""
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "  [错误] Docker 已安装但没有运行。"
  echo "  请执行： sudo systemctl start docker"
  echo ""
  exit 1
fi

echo "  [1/3] Docker 检查通过： $(docker --version)"

# ---------- 2. 准备 .env ----------
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "  [2/3] 已从 .env.example 创建 .env（默认只监听 127.0.0.1，安全）"
    echo "        如需修改配置，编辑 .env 后重新运行本脚本。"
  else
    echo "  [2/3] 未找到 .env.example，跳过（将使用默认值）"
  fi
else
  echo "  [2/3] 已有 .env，保持不变"
fi

# ---------- 3. 构建并启动 ----------
echo "  [3/3] 构建并启动容器（首次需要下载镜像，请稍候）..."
echo ""
docker compose up -d --build

echo ""
echo "  ============================================"
echo "    部署完成"
echo "  ============================================"
echo ""

BIND_IP="$(grep -E '^BIND_IP=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || true)"
BIND_IP="${BIND_IP:-127.0.0.1}"
PORT_VAL="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || true)"
PORT_VAL="${PORT_VAL:-8787}"

if [ "$BIND_IP" = "127.0.0.1" ]; then
  echo "  当前只监听本机回环（安全模式）。访问方式——在你自己的电脑上执行："
  echo ""
  echo "    ssh -L ${PORT_VAL}:127.0.0.1:${PORT_VAL} root@<服务器公网IP>"
  echo ""
  echo "  然后本地浏览器打开： http://127.0.0.1:${PORT_VAL}"
  echo ""
  echo "  （想直接用公网 IP 访问，把 .env 里的 BIND_IP 改成 0.0.0.0，"
  echo "    并在阿里云安全组只放行你自己的 IP，然后重新运行本脚本）"
else
  echo "  访问地址： http://<服务器公网IP>:${PORT_VAL}"
  echo ""
  echo "  注意：请到阿里云安全组放行 ${PORT_VAL} 端口，且建议只放行自己的 IP。"
fi

echo ""
echo "  常用命令："
echo "    docker compose logs -f     查看日志"
echo "    docker compose down        停止"
echo "    docker compose up -d       再次启动"
echo ""
