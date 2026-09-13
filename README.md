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
git clone https://github.com/<你的用户名>/emby-missing-episodes.git
cd emby-missing-episodes
docker compose up -d --build
```

打开 <http://localhost:8787>。

**拉现成镜像（不用 clone 源码）：**

```bash
docker run -d \
  --name emby-missing-episodes \
  -p 127.0.0.1:8787:8787 \
  --add-host=host.docker.internal:host-gateway \
  -e HOST=0.0.0.0 \
  -e PORT=8787 \
  emby-missing-episodes:latest
```

> 把镜像名换成 `<你的DockerHub用户名>/emby-missing-episodes:latest`

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
| `BIND_IP` | `127.0.0.1` | 暴露范围，**公网服务器请保持回环，用 SSH 隧道访问** |
| `HOST` | `127.0.0.1` | 容器内监听地址，Docker 里须为 `0.0.0.0` |
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
- 默认 `BIND_IP=127.0.0.1`，只监听回环，通过 SSH 隧道访问最安全：

  ```bash
  ssh -L 8787:127.0.0.1:8787 root@你的服务器IP
  ```

- 若确需公网访问，请在云厂商安全组**只放行你自己的 IP**，不要用 `0.0.0.0/0`。

---

## 自动构建镜像（GitHub Actions）

仓库配好了 [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)，
推 tag 即自动构建并推送到 Docker Hub。

**首次需配置两个 Secret**（仓库 Settings → Secrets and variables → Actions）：

| Secret | 值 |
|---|---|
| `DOCKERHUB_USERNAME` | 你的 Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token（不是登录密码） |

> Access Token 申请：Docker Hub → Account Settings → Security → New Access Token

**触发构建：**

```bash
git tag v1.0.0
git push origin v1.0.0
```

构建完成后镜像地址为 `<用户名>/emby-missing-episodes:1.0.0` 及 `:latest`。
也可在 Actions 页面手动 Run workflow。

---

## 文件说明

```
emby-missing-episodes.html   工具主体（单文件前端）
emby-proxy.js                代理服务器（绕开 CORS / 转发 TMDB / 代理海报）

Dockerfile                   Docker 镜像定义
docker-compose.yml           Docker Compose 配置
.dockerignore                构建时排除的文件
.env.example                 环境变量模板
deploy.sh                    服务器一键部署脚本
启动docker.bat / 停止docker.bat   Windows Docker 一键启停
启动代理.bat                  Windows 本机 Node 一键启动

.github/workflows/           自动构建镜像的流水线
README.md                    本文件
README.txt                   详细使用说明
部署文档.txt                 服务器部署完整指南
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
