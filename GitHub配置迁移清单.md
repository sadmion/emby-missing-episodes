# GitHub 配置迁移清单（给另一台 Work 机器用）

> 用途：在第二台机器上配好同样的 GitHub 推送能力。
> 生成时间：2026-09-14
> 适用仓库：https://github.com/sadmion/emby-missing-episodes

---

## ⚠️ 先看这个：什么能复制，什么不能

| 项目 | 能否复制 | 原因 |
|---|---|---|
| git 身份（姓名/邮箱） | ✅ 直接复制 | 就是两个字符串 |
| 仓库地址 | ✅ 直接复制 | 公开信息 |
| git 全局配置命令 | ✅ 直接复制 | 执行即可 |
| **SSH 私钥 `id_ed25519`** | ❌ **绝对不要复制** | 私钥泄漏 = 任何人可冒充你推送 |
| **Docker Hub Token** | ❌ 不要复制 | 已泄漏，且现在不用 Docker Hub 了 |
| **Emby / TMDB 密钥** | ❌ 不要复制 | 应各自配置，且建议轮换 |
| GHCR 登录 | ✅ 不需要 | 用内置 GITHUB_TOKEN，零配置 |

**结论**：身份信息复制，凭据重新生成。SSH 走「新机器生成新密钥 → 加到同一个 GitHub 账号」，
这是**一台机器一把钥匙**的标准做法，两边可以同时用，互不干扰。

---

## 第一步：检查这台机器有什么

在**新机器**上先跑这几条，看缺什么：

```bash
git --version
ssh -V
```

**Windows 常见情况**：系统没装 git，但 WorkBuddy 自带便携版：

```bash
# 找到便携版 git
ls "C:/Users/<用户名>/.workbuddy/binaries/PortableGit/versions/"
```

本机实测路径（版本号可能不同）：

```
C:\Users\zy\.workbuddy\binaries\PortableGit\versions\1.2.0\bin\git.exe
C:\Users\zy\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe
```

**重要**：用便携版时，每次开 shell 都要临时补 PATH，否则连 `cat`、`ls` 都用不了：

```bash
export PATH="/c/Users/<用户名>/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:/c/Users/<用户名>/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/c/Windows/System32:/c/Windows:$PATH"
```

（把 `<用户名>` 换成实际的。`bin` 目录不能少 —— `cat`/`find`/`bash` 都在那。）

---

## 第二步：配置 git 身份（直接复制执行）

```bash
git config --global user.name "sadmion"
git config --global user.email "102721363+sadmion@users.noreply.github.com"
git config --global init.defaultBranch main
```

**为什么用这个邮箱**：这是 GitHub 的 noreply 隐私邮箱，格式是
`<数字ID>+<用户名>@users.noreply.github.com`。
用它提交，真实邮箱不会出现在公开仓库的提交记录里。**建议保持和第一台机器一致**，
这样提交历史显示的是同一个人。

验证：

```bash
git config --global --list | grep user
```

预期输出：

```
user.name=sadmion
user.email=102721363+sadmion@users.noreply.github.com
```

**这个邮箱你是怎么查到的**：GitHub → Settings → Emails → 勾选
"Keep my email addresses private" 后，页面会显示这个 noreply 地址。
（数字 ID 是 `102721363`，两台机器共用同一个值。）

---

## 第三步：生成 SSH 密钥（在新机器上，必须新生成）

```bash
ssh-keygen -t ed25519 -C "102721363+sadmion@users.noreply.github.com" -f "$HOME/.ssh/id_ed25519" -N ""
```

参数说明：
- `-t ed25519` — 现代算法，比 RSA 更短更安全
- `-C` — 注释，写邮箱便于识别
- `-f` — 保存路径，默认就是 `~/.ssh/id_ed25519`
- `-N ""` — **空密码**，这样 git push 不用每次输密码

如果 `~/.ssh` 目录不存在，先创建：

```bash
mkdir -p "$HOME/.ssh"
```

生成后拿到**公钥**（这一步的公钥可以随便复制，私钥不行）：

```bash
cat "$HOME/.ssh/id_ed25519.pub"
```

输出长这样（`<算法> <一长串base64> <注释>` 三段，注释就是你的邮箱）：

**这个公钥要做什么**：复制全部内容 → 打开
https://github.com/settings/ssh/new → Title 随便填（比如 `work-machine-2`）→
Key type 选 `Authentication Key` → 粘贴 → Add SSH key。

**这一步只能你手动做**，我无法代劳（需要登录你的 GitHub）。

---

## 第四步：验证 SSH 连接

```bash
ssh -o StrictHostKeyChecking=accept-new -T git@github.com
```

**预期输出**（看到 Hi sadmion 就成功）：

```
Hi sadmion! You've successfully authenticated, but GitHub does not provide shell access.
```

如果是 `Permission denied (publickey)` → 公钥没加到 GitHub，或加错了账号。

**第一次连接会问 `Are you sure you want to continue connecting?`** → 输 `yes`。
（上面命令里的 `accept-new` 就是自动回答这个，省得卡住。）

---

## 第五步：克隆或关联仓库

### 情况 A：新机器上还没有这个项目 → 克隆

```bash
# 换成你想要存放的目录
cd /c/Users/<用户名>/WorkBuddy
git clone git@github.com:sadmion/emby-missing-episodes.git
cd emby-missing-episodes
```

用 SSH 地址（`git@github.com:...`）而不是 HTTPS，才走刚才配的密钥。

### 情况 B：已经有一份本地代码 → 关联远程

```bash
cd 你的项目目录
git init -b main
git remote add origin git@github.com:sadmion/emby-missing-episodes.git
git remote -v          # 确认显示正确
```

如果 `git remote add` 报 `remote origin already exists`，说明已关联过，改用：

```bash
git remote set-url origin git@github.com:sadmion/emby-missing-episodes.git
```

---

## 第六步：推送

```bash
git add -A
git commit -m "初始化"
git push -u origin main
```

`-u` 的作用：把本地 main 和远程 main 绑定，**以后再推直接 `git push` 就行**，不用带参数。

---

## 第七步：GitHub Actions（零配置，无需操作）

这个仓库的镜像构建**不需要配任何 Secret**。

原理：workflow 用 GitHub 内置的 `GITHUB_TOKEN` 登录 GHCR，
配了 `permissions: packages: write` 就有推送权限。**开箱即用。**

需要知道的触发规则（`.github/workflows/docker-publish.yml`）：

| 操作 | 结果 |
|---|---|
| `git push` 到 main | 自动构建，更新 `latest` 标签 |
| 打 tag 并推送（如 `v1.0.1`） | 额外产出 `1.0.1` / `1.0` / `1` |
| Actions 页面手动 Run workflow | 用 short sha 做标签构建一次 |

查看构建状态：https://github.com/sadmion/emby-missing-episodes/actions

---

## 附：本机可用的完整命令模板

### 第一台机器的现状（供对照）

| 项目 | 值 |
|---|---|
| 用户名 | `sadmion` |
| 邮箱 | `102721363+sadmion@users.noreply.github.com` |
| 密钥路径 | `C:\Users\zy\.ssh\id_ed25519`（私钥，本机独有） |
| 公钥指纹 | 在**第一台机器**上执行 `ssh-keygen -lf ~/.ssh/id_ed25519.pub` 查看 |
| 仓库地址 | `git@github.com:sadmion/emby-missing-episodes.git` |
| 便携版 git | `C:\Users\zy\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe` |

> **新机器不要照抄第一台机器的公钥。** 公钥和私钥是一对，只把公钥拿到新机器上、
> 没有对应的私钥，照样连不上。必须在新机器上生成新的一对（第三步）。

> 第一台机器的公钥已经在 https://github.com/settings/keys 注册过，
> 新机器注册的是另一把 —— 两把可以共存，各管一台机器。

### 一次性执行模板

把 `<用户名>` 换成新机器上的实际用户名，逐段执行：

```bash
# 1. 补 PATH（便携版 git 环境必须）
export PATH="/c/Users/<用户名>/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:/c/Users/<用户名>/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/c/Windows/System32:/c/Windows:$PATH"

# 2. git 身份（与第一台机器保持一致）
git config --global user.name "sadmion"
git config --global user.email "102721363+sadmion@users.noreply.github.com"
git config --global init.defaultBranch main

# 3. 生成密钥（先建目录，避免目录不存在报错）
mkdir -p "$HOME/.ssh"
ssh-keygen -t ed25519 -C "102721363+sadmion@users.noreply.github.com" -f "$HOME/.ssh/id_ed25519" -N ""

# 4. 打印公钥 → 复制到 https://github.com/settings/ssh/new
cat "$HOME/.ssh/id_ed25519.pub"

# 5. 加完公钥后验证
ssh -o StrictHostKeyChecking=accept-new -T git@github.com

# 6. 克隆
cd /c/Users/<用户名>/WorkBuddy
git clone git@github.com:sadmion/emby-missing-episodes.git
```

---

## ⚠️ 安全提醒

**不要复制的东西**（再强调一次）：

1. **`C:\Users\zy\.ssh\id_ed25519`（私钥文件）**
   绝对不要拷到任何地方 —— U 盘、网盘、聊天窗口都不行。
   私钥泄漏后，拿到它的人可以像你一样推送代码。
   正确做法就是本文第三步：在新机器生成新密钥。

2. **Docker Hub Token**（`dckr_` 开头的那个）
   这个已经泄漏在之前的对话里了，而且现在也不用 Docker Hub。
   **去 https://hub.docker.com/settings/security 删掉它。**

3. **Emby Key / TMDB Key**
   在各自机器的 `.env` 里配置（`.env` 已被 `.gitignore` 排除，不会进仓库）。
   建议顺便轮换一次。

**一台机器一把密钥的好处**：
哪台机器丢了、卖了、重装了，单独删掉那一把公钥即可，不影响其他机器。
（在 https://github.com/settings/keys 页面能看到所有已授权的密钥，可以逐个删除。）
