# Emby 缺集检测工具

以 **TMDB 官方集数**为准，找出 Emby 媒体库里缺少剧集的剧。

![Docker](https://img.shields.io/badge/docker-ready-blue)
![Node](https://img.shields.io/badge/node-22-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## 这是什么

一个自托管的网页小工具。你填上 Emby 服务器地址和 API Key，它会：

- 拉取 Emby 里所有剧集
- 逐季比对 TMDB 的官方集数
- 列出**哪些剧缺集、缺第几集**
- 显示海报、支持搜索 / 筛选 / 导出 CSV、结果自动保存

适合用来排查「某部剧明明下载了却少了几集」的问题。

## 三种运行方式

| 方式 | 需要 | 适合 |
|---|---|---|
| **Docker**（推荐） | Docker | 服务器 / NAS 长期运行 |
| **本机 Node** | Node 18+ | 本机临时用，最省事 |
| **直接开 HTML** | 无 | 应急，但要给 Emby 开 CORS，不保证成功 |

---

## 快速开始

### 方式一：Docker（推荐）

**本机 / NAS：**

```bash
git clone https://github.com/sadmion/emby-missing-episodes.git
cd emby-missing-episodes
docker compose up -d --build
```

打开 <http://localhost:8787>。

**拉现成镜像（不用 clone 源码）：**

```bash
docker run -d \
  --name emby-missing-episodes \
  -p 8787:8787 \
  --add-host=host.docker.internal:host-gateway \
  -e HOST=0.0.0.0 \
  -e PORT=8787 \
  ghcr.io/sadmion/emby-missing-episodes:latest
```

> 镜像来自 GitHub Container Registry，**公开可直接拉取，无需登录**。

> `-p 8787:8787` 等价于绑定 `0.0.0.0`，公网可访问；本机自用想更安全可写
> `-p 127.0.0.1:8787:8787`（此时只有本机能连，需走 SSH 隧道）。

### 用 Compose 拉现成镜像（不构建）

项目里额外提供 `docker-compose.ghcr.yml`，直接拉 GHCR 镜像，跳过构建：

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

适合服务器没装构建环境、或想启动更快的情况。

| 文件 | 行为 |
|---|---|
| `docker-compose.yml` | `build: .` — 现场构建镜像 |
| `docker-compose.ghcr.yml` | `image: ghcr.io/...` — 拉现成镜像 |

**服务器部署（阿里云 / VPS）：** 见 [`部署文档.txt`](部署文档.txt)，或一键脚本：

```bash
chmod +x deploy.sh && ./deploy.sh
```

### 方式二：本机 Node

```bash
node emby-proxy.js
# 浏览器打开 http://127.0.0.1:8787
```

Windows 用户可直接双击 `启动代理.bat`。

### 方式三：直接打开 HTML

双击 `emby-missing-episodes.html` 也能用，但浏览器会直连 Emby，
需要先在 **Emby 后台 → 网络 → CORS 主机** 填 `*` 并重启 Emby。

---

## ⚠️ 最容易踩的坑：Emby 地址不要写 localhost

**容器里的 `localhost` 指的是容器自己，不是你的电脑。**

| 场景 | 地址怎么填 |
|---|---|
| Docker 和 Emby 在同一台机器 | `http://host.docker.internal:8096` |
| Emby 在另一台机器 / 群晖 | `http://192.168.1.10:8096`（改成实际 IP） |
| Emby 也在 Docker 同一网络 | `http://容器名:8096` |

提示连不上 Emby，九成是这里写错了。

---

## 配置

复制 `.env.example` 为 `.env` 后按需修改：

```bash
cp .env.example .env
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `BIND_IP` | `0.0.0.0` | 宿主机暴露范围。`0.0.0.0` = 公网可访问（需配安全组）；`127.0.0.1` = 仅本机，走 SSH 隧道 |
| `HOST` | `0.0.0.0` | 容器内监听地址，Docker 里须为 `0.0.0.0` |
| `TMDB_HOST` | `api.tmdb.org` | TMDB 域名（`api.themoviedb.org` 国内常无法访问） |
| `TMDB_TIMEOUT` | `12000` | 请求超时（毫秒） |
| `EMBY_URL` | 空 | 可选，预填 Emby 地址 |
| `EMBY_KEY` | 空 | 可选，预填 Emby API Key |
| `TMDB_KEY` | 空 | 可选，预填 TMDB API Key |

> `.env` 已被 `.gitignore` 排除，**不会被提交**，Key 不会泄漏。

需要哪些 Key：

- **Emby API Key** — Emby 后台 → 高级 → API 密钥
- **TMDB API Key** — <https://www.themoviedb.org/settings/api>（免费注册）

---

## 安全说明

- 本工具**没有登录验证**。一旦对公网开放，任何人都能访问并消耗你的 Key。
- 默认 `BIND_IP=0.0.0.0`，可直接用浏览器访问 `http://服务器IP:8787`。
  请务必在云厂商安全组**只放行你自己的 IP**，不要用 `0.0.0.0/0`。
- 想要更安全（端口完全不对外开放），把 `.env` 里的 `BIND_IP` 改成 `127.0.0.1`，
  然后走 SSH 隧道：

  ```bash
  ssh -L 8787:127.0.0.1:8787 root@你的服务器IP
  # 浏览器打开 http://127.0.0.1:8787
  ```

### 部署后打不开？先跑诊断脚本

```bash
chmod +x diagnose.sh && ./diagnose.sh
```

自动依序检查：容器状态 → **端口绑定地址** → 服务健康 → 系统防火墙 → 内外网可达性，
并直接给出结论和修复命令。

手动排查（三步）：

```bash
# 1. 容器活着吗
docker compose -f docker-compose.ghcr.yml ps

# 2. 端口绑在哪（90% 的死结）
docker compose -f docker-compose.ghcr.yml port emby-missing-episodes 8787
#    127.0.0.1:8787 → 公网连不上，把 BIND_IP 改成 0.0.0.0 后 up -d
#    0.0.0.0:8787   → 绑定正常，去第 3 步

# 3. 阿里云安全组放行 8787（入方向，来源限自己的 IP）
```

服务自身是否正常：

```bash
curl -I http://127.0.0.1:8787/__health   # 返回 200 说明容器内部一切正常
```

返回 200 但外部打不开 → 问题必然在「对外暴露」层（绑定地址 / 安全组 / 系统防火墙），
不在容器本身。

---

## 更新到新版本

```bash
./update.sh
```

自动完成：记录当前版本 → 拉新镜像 → 重建容器 → 健康检查（失败会给出回滚命令）。

手动等价命令：

```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

**不会丢的东西**：扫描结果存在浏览器 localStorage，配置在 `.env`，更新都不影响。

**更新不生效？** 多半是 `.env` 里 `IMAGE_TAG` 被锁在具体版本号上了：

```bash
grep IMAGE_TAG .env     # 若是 1.0.0 这类值，改成 latest
```

**回滚**：在 `.env` 里指定旧版本号再 `up -d`：

```bash
IMAGE_TAG=1.0.0 docker compose -f docker-compose.ghcr.yml up -d
```

完整说明见 [`更新指南.txt`](更新指南.txt)（含维护者发布流程）。

---

## 自动构建镜像（GitHub Actions）

仓库配好了 [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)，
构建产物推送到 **GitHub Container Registry (GHCR)**。

**无需任何配置** —— 用 GitHub 内置的 `GITHUB_TOKEN` 认证，不用注册额外账号、
不用配 Secret。开箱即用。

**两种触发方式：**

```bash
# 1. 推 main → 自动构建，滚动更新 latest（日常改动用这个）
git push

# 2. 打 tag → 额外产出正式版本号 1.0.0 / 1.0 / 1（发稳定版时用）
git tag v1.0.0
git push origin v1.0.0
```

构建完成后镜像地址为：

```
ghcr.io/sadmion/emby-missing-episodes:latest    # 跟着 main 走
ghcr.io/sadmion/emby-missing-episodes:1.0.0     # 正式版本，可锁定
```

同时提供 `linux/amd64` 和 `linux/arm64` 两种架构（群晖、树莓派等 ARM 设备可用）。

也可在 Actions 页面手动 Run workflow。

### 拉取使用

镜像**公开可直接拉取，无需登录**：

```bash
docker pull ghcr.io/sadmion/emby-missing-episodes:latest
```

### 在 compose 里使用

```yaml
services:
  emby-missing-episodes:
    image: ghcr.io/sadmion/emby-missing-episodes:latest
    container_name: emby-missing-episodes
    restart: unless-stopped
    pull_policy: always          # 保证 up -d 时能拿到最新镜像
    ports:
      - "8787:8787"              # 公网访问；只给本机用则写 127.0.0.1:8787:8787
    environment:
      HOST: "0.0.0.0"
      PORT: "8787"
      TMDB_HOST: "api.tmdb.org"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

然后 `docker compose up -d`。

---

## 文件说明

```
emby-missing-episodes.html   工具主体（单文件前端）
emby-proxy.js                代理服务器（绕开 CORS / 转发 TMDB / 代理海报）

Dockerfile                   Docker 镜像定义
docker-compose.yml           Docker Compose 配置（源码现场构建）
docker-compose.ghcr.yml      Docker Compose 配置（拉取 GHCR 现成镜像）
.dockerignore                构建时排除的文件
.env.example                 环境变量模板
deploy.sh                    服务器一键部署脚本
update.sh                    一键更新到新版本（含健康检查与回滚提示）
diagnose.sh                  访问故障一键诊断
启动docker.bat / 停止docker.bat   Windows Docker 一键启停
启动代理.bat                  Windows 本机 Node 一键启动

.github/workflows/           自动构建镜像的流水线
README.md                    本文件
README.txt                   详细使用说明
部署文档.txt                 服务器部署完整指南
更新指南.txt                 更新与版本发布说明
```

---

## 常见问题

**Q：检测很慢 / 一直卡住？**
默认 TMDB 域名 `api.themoviedb.org` 在国内常被解析到 Meta 的 IP 段而无法访问。
现已改用 `api.tmdb.org`（走 AWS CloudFront，国内可直连），并支持并发检测。

**Q：位置数据存哪里？重启会丢吗？**
存在**浏览器的 localStorage**，不在容器、不在服务器。
所以重建容器、重启服务器都不影响；但换浏览器 / 无痕 / 清数据会丢。

**Q：海报显示灰色占位块？**
该剧在 TMDB 上没有海报，属正常。若全都加载不出，检查 TMDB Key 是否有效。

**Q：`HTTP 401 —— API Key 无效`？**
TMDB Key 填错了，去 <https://www.themoviedb.org/settings/api> 重新取。

更详细的问题排查见 [`README.txt`](README.txt) 与 [`部署文档.txt`](部署文档.txt)。

---

## License

[MIT](LICENSE)
