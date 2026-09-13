#!/usr/bin/env bash
# Emby 缺集检测工具 - 访问问题一键诊断
#
# 用法（在服务器上，项目目录内执行）：
#   chmod +x diagnose.sh && ./diagnose.sh
#
# 它会依序检查：容器状态 → 端口绑定 → 服务健康 → 系统防火墙，
# 最后给出结论和建议。

set -u

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.ghcr.yml}"
SERVICE="${SERVICE:-emby-missing-episodes}"
APP_PORT="${APP_PORT:-8787}"

# 兼容 docker compose / docker-compose
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "✗ 找不到 docker compose，请先安装 Docker。"
  exit 1
fi

# compose 文件必须存在
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "✗ 当前目录找不到 $COMPOSE_FILE"
  echo "  可指定： COMPOSE_FILE=docker-compose.yml ./diagnose.sh"
  exit 1
fi

OK=0; BAD=0
ok()   { echo "  ✓ $1"; OK=$((OK+1)); }
bad()  { echo "  ✗ $1"; BAD=$((BAD+1)); }
info() { echo "    $1"; }

echo "=============================================="
echo " Emby 缺集检测工具 - 访问诊断"
echo " compose 文件: $COMPOSE_FILE"
echo " 服务名     : $SERVICE"
echo " 应用端口   : $APP_PORT"
echo "=============================================="
echo

# ---------- 1. 容器状态 ----------
echo "[1/5] 容器状态"
PS_OUT="$($DC -f "$COMPOSE_FILE" ps 2>&1)"
if echo "$PS_OUT" | grep -q "$SERVICE"; then
  STATE="$(echo "$PS_OUT" | grep "$SERVICE" | head -n1)"
  info "$STATE"
  if echo "$STATE" | grep -qiE 'up|running'; then
    ok "容器正在运行"
  else
    bad "容器未在运行 —— 先看日志: $DC -f $COMPOSE_FILE logs --tail=50"
  fi
else
  bad "找不到容器，可能没启动 —— 执行: $DC -f $COMPOSE_FILE up -d"
fi
echo

# ---------- 2. 端口绑定（最关键） ----------
echo "[2/5] 端口绑定地址  ← 最常见的死结"
PORT_OUT="$($DC -f "$COMPOSE_FILE" port "$SERVICE" "$APP_PORT" 2>&1 || true)"
if [ -z "$PORT_OUT" ] || echo "$PORT_OUT" | grep -qiE 'error|no public port'; then
  bad "查不到端口映射 —— 容器可能没起来，或没配 ports"
elif echo "$PORT_OUT" | grep -q "127.0.0.1"; then
  bad "只绑定了回环: $PORT_OUT"
  info "→ 公网绝对连不上。这就是「服务活着但浏览器打不开」的头号原因。"
  info "→ 修复：在 .env 里设 BIND_IP=0.0.0.0，然后:"
  info "     $DC -f $COMPOSE_FILE up -d"
  PORT_FIX=1
elif echo "$PORT_OUT" | grep -q "0.0.0.0"; then
  ok "绑定正常: $PORT_OUT （公网可达）"
else
  info "端口映射: $PORT_OUT"
  ok "未绑定到回环，映射看起来正常"
fi
echo

# ---------- 3. 服务健康 ----------
echo "[3/5] 服务本身是否正常（容器内）"
HEALTH="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  "http://127.0.0.1:${APP_PORT}/__health" 2>/dev/null || echo "000")"
if [ "$HEALTH" = "200" ]; then
  ok "服务响应 200 —— 容器内部一切正常"
  info "→ 那么问题一定在「对外暴露」层：绑定地址 / 安全组 / 系统防火墙"
elif [ "$HEALTH" = "000" ]; then
  bad "连不上本机 $APP_PORT 端口 —— 容器可能没真正监听"
  info "→ 看日志: $DC -f $COMPOSE_FILE logs --tail=50"
else
  bad "返回 HTTP $HEALTH（期望 200）"
  info "→ 看日志: $DC -f $COMPOSE_FILE logs --tail=50"
fi
echo

# ---------- 4. 系统防火墙 ----------
echo "[4/5] 系统防火墙"
FW_FOUND=0
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  FW_FOUND=1
  if firewall-cmd --list-ports 2>/dev/null | grep -q "${APP_PORT}/tcp"; then
    ok "firewalld 已放行 ${APP_PORT}/tcp"
  else
    bad "firewalld 未放行 ${APP_PORT}/tcp"
    info "→ 放行: firewall-cmd --permanent --add-port=${APP_PORT}/tcp && firewall-cmd --reload"
  fi
fi
if command -v ufw >/dev/null 2>&1; then
  UFW_ST="$(ufw status 2>/dev/null | head -n1 || true)"
  if echo "$UFW_ST" | grep -qi active; then
    FW_FOUND=1
    if ufw status 2>/dev/null | grep -q "$APP_PORT"; then
      ok "ufw 已放行 $APP_PORT"
    else
      bad "ufw 处于启用状态但未放行 $APP_PORT"
      info "→ 放行: ufw allow ${APP_PORT}/tcp"
    fi
  fi
fi
if command -v iptables >/dev/null 2>&1; then
  DOCKER_CHAIN="$(iptables -L DOCKER -n 2>/dev/null | grep -c "dpt:${APP_PORT}" || echo 0)"
  if [ "$DOCKER_CHAIN" != "0" ]; then
    ok "iptables 已有 ${APP_PORT} 的转发规则（Docker 自动加的）"
  fi
fi
[ "$FW_FOUND" = "0" ] && info "未检测到 firewalld/ufw，跳过（阿里云多为关闭状态，靠安全组）"
echo

# ---------- 5. 内外网 IP ----------
echo "[5/5] 网络信息（用于对照安全组）"
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '未知')"
info "内网 IP: $LAN_IP"
if [ -n "${LAN_IP:-}" ] && [ "$LAN_IP" != "未知" ]; then
  LAN_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 \
    "http://${LAN_IP}:${APP_PORT}/__health" 2>/dev/null || echo '000')"
  info "用内网 IP 访问: HTTP $LAN_CODE  $([ "$LAN_CODE" = "200" ] && echo '(通)' || echo '(不通)')"
fi
PUB_IP="$(curl -s --max-time 5 https://ipinfo.io/ip 2>/dev/null || \
          curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo '')"
if [ -n "$PUB_IP" ]; then
  info "公网 IP: $PUB_IP"
  PUB_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 \
    "http://${PUB_IP}:${APP_PORT}/__health" 2>/dev/null || echo '000')"
  if [ "$PUB_CODE" = "200" ]; then
    ok "公网可访问: http://${PUB_IP}:${APP_PORT}"
  else
    bad "公网访问不通 (HTTP $PUB_CODE)"
    info "→ 若第 2、3 步都是 ✓，那基本就是阿里云安全组没放行 ${APP_PORT}"
    info "→ 阿里云控制台 → 实例 → 安全组 → 入方向 → 添加规则"
    info "   协议 TCP / 端口 ${APP_PORT} / 授权对象填你自己的公网 IP（别用 0.0.0.0/0）"
  fi
else
  info "拿不到公网 IP（服务器可能无外网出口，可忽略）"
fi
echo

# ---------- 总结 ----------
echo "=============================================="
echo " 诊断结束： $OK 项正常， $BAD 项异常"
echo "=============================================="
if [ "${PORT_FIX:-0}" = "1" ]; then
  echo
  echo "★ 最可能的原因：端口只绑在 127.0.0.1，公网连不上。"
  echo
  echo "  最快的修法（不用改文件）："
  echo "      echo 'BIND_IP=0.0.0.0' >> .env"
  echo "      $DC -f $COMPOSE_FILE up -d"
  echo
  echo "  然后确认安全组放行 $APP_PORT 端口，再用浏览器打开："
  echo "      http://${PUB_IP:-你的服务器公网IP}:${APP_PORT}"
fi
echo
echo "把以上完整输出贴回来，我帮你继续定位。"
