# 部署到飞牛 fnOS

从零到能在婚礼现场用，大约 30 分钟。

---

## 0. 开始之前

需要准备好：

| 项 | 说明 |
| --- | --- |
| fnOS 上的 Docker | 你的 NAS 已经在跑 Navidrome / Emby 等容器，说明这项没问题 |
| 反向代理 + HTTPS | 你已经在跑 `music.aqzscn.cn`，复用它加一条规则即可 |
| 小程序 AppID | 微信公众平台 → 开发管理 → 开发设置 |
| 小程序 AppSecret | 同上。**只填进 NAS 的 `.env`，不要写进任何代码或小程序文件** |
| 一个子域名 | 例如 `photos.aqzscn.cn`，需已完成 ICP 备案 |

> **不想配微信也能先跑**：不填 `WX_APPID` / `WX_SECRET` 服务照常启动，
> 二维码会自动退化成普通二维码（扫出来打开一个引导网页）。
> 功能会打折扣，但整个流程能先验证一遍。

---

## 1. 把代码放到 NAS 上

在 **NAS 上**（SSH 登录，或用 fnOS 的终端）：

```bash
# 挑一个放代码的地方，不要放在数据目录里
mkdir -p /vol1/1000/docker/wedding-app
cd /vol1/1000/docker/wedding-app
```

把仓库内容传上去。两种方式二选一：

- **Git**（推荐）：`git clone <你的仓库地址> .`
- **手动上传**：用 fnOS 文件管理器把项目目录拖进来（注意要包含 `server/` 和 `docker-compose.yml`）

---

## 2. ⚠️ 建数据目录并改属主（最容易踩的坑）

**这一步不做，第一次上传就会报 `EACCES` 权限错误。**

容器里以 uid 1000（`node` 用户）运行，而 fnOS 建的目录属主往往不是它。

```bash
# 换成你自己的路径。放在 HDD 阵列上，不要放 SSD 系统盘 ——
# 素材一年能涨 1 TB 以上。
sudo mkdir -p /vol1/1000/docker/wedding-collect
sudo chown -R 1000:1000 /vol1/1000/docker/wedding-collect
```

确认一下：

```bash
ls -ld /vol1/1000/docker/wedding-collect
# 应当显示 1000 1000
```

> **不确定路径该用哪个？** 用 `df -h` 看挂载点，或在 fnOS 文件管理器里
> 进到目标文件夹看它显示的路径。`/vol1/1000/...` 是常见形态，
> 但**以你机器上实际显示的为准**。

### 为什么必须是普通目录（bind mount）而不是 Docker 卷

三个原因，都不是可选的：

1. 你要能在 fnOS 文件管理器 / SMB 里**直接翻看和取走原图**——这是本项目的核心诉求
2. `tmp/` 和 `events/` 必须**在同一个文件系统**上。合并大文件靠 `rename` 落盘（同盘才原子），
   拆到不同的挂载点会让每次合并都变成整文件拷贝
3. SQLite 的 WAL **不能**放在网络文件系统上——所以这个路径**务必指向 NAS 本地磁盘**，
   不要指向 NFS/SMB 挂载点

---

## 3. 配置 .env

```bash
cd /vol1/1000/docker/wedding-app
cp .env.example .env
```

生成两个随机密钥（**必须生成，不要用样例值**）：

```bash
openssl rand -base64 48   # 填给 JWT_SECRET
openssl rand -base64 48   # 填给 FILE_TOKEN_SECRET（两个必须不同）
```

编辑 `.env`：

```ini
NODE_ENV=production
TZ=Asia/Shanghai

# 对外访问地址。必须和你配的反代域名一致，且是 https
PUBLIC_BASE_URL=https://photos.aqzscn.cn

JWT_SECRET=<上面生成的第一个>
FILE_TOKEN_SECRET=<上面生成的第二个>

# 管理后台的初始账号。首次登录后会被强制要求改掉
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<想一个至少 8 位的>

# 微信小程序
WX_APPID=wx1234567890abcdef
WX_SECRET=<小程序后台的 AppSecret>
# 小程序还没发布时用 trial，否则扫出来是白屏
WX_ENV_VERSION=trial
```

⚠️ `.env` 里有 AppSecret，**已经在 `.gitignore` 里，不要提交**。

---

## 4. 改 docker-compose.yml 里的路径

只有一处必改：

```yaml
volumes:
  # 改成第 2 步建的那个路径
  - /vol1/1000/docker/wedding-collect:/data
```

---

## 5. 构建并启动

### 方式 A：SSH 命令行（推荐）

```bash
cd /vol1/1000/docker/wedding-app
docker compose up -d --build
docker compose logs -f
```

看到这样的输出就成功了：

```
[boot] 环境 = production
[boot] 数据目录 = /data
[db] journal_mode = wal
[migrate] 应用 001_init.sql …
Server listening at http://0.0.0.0:3000
```

第一次构建要装依赖 + 下载 ffmpeg，**大约 5–15 分钟**（国内已经配了清华 apt 源）。

### 方式 B：fnOS 容器应用

在 fnOS 的「容器」→「Compose」里新建项目，把 `docker-compose.yml` 的内容粘进去。
建议**先用方式 A 把 YAML 跑通**，再挪到图形界面里，省得在 UI 里猜报错。

### 验证容器起来了

```bash
curl http://127.0.0.1:3000/api/health
# {"ok":true,"data":{"db":"ok",...}}
```

---

## 6. 配反向代理

你的 NAS 上已经在跑反代（`music.aqzscn.cn`），**加一条规则即可**：

| 项 | 值 |
| --- | --- |
| 域名 | `photos.aqzscn.cn` |
| 目标 | `http://127.0.0.1:3000` |
| 证书 | 复用现有的 |
| WebSocket | 不需要 |

⚠️ 因为容器只绑了 `127.0.0.1`，**必须**经过反代才能从外面访问。
这是刻意的：这样 `.env` 里的 `TRUST_PROXY=true` 才是安全的
（直连不到容器，就伪造不了 `X-Forwarded-For`，限流和日志里的 IP 才可信）。

配完验证：

```bash
curl https://photos.aqzscn.cn/api/health
```

### 如果家里宽带没有公网 IP

国内家用宽带常在 CGNAT 后面，端口映射走不通。这时用 Cloudflare Tunnel
（`docker-compose.yml` 里有一段注释掉的示例，取消注释并填 `CF_TUNNEL_TOKEN` 即可）。

注意 Cloudflare 的两个限制：
- 免费版请求体上限 100MB —— 我们的分片是 4MB，远在下面
- 对视频类流量的 egress 有限制。若被限速，把 `.env` 里的 `MEDIA_BASE_URL`
  指向一个 DNS-only 的子域名（配置里本来就把它和 `PUBLIC_BASE_URL` 分开了，就是留这个口子）

---

## 7. 配置微信小程序后台

在小程序后台（mp.weixin.qq.com）：

1. **开发 → 开发管理 → 服务器域名**，三处都加上 `https://photos.aqzscn.cn`：
   - `request 合法域名` ← 分片上传走的是 `wx.request`，**这个最关键**
   - `uploadFile 合法域名`
   - `downloadFile 合法域名`

2. **设置 → 服务内容声明 → 用户隐私保护指引**，如实勾选：
   - 相册（选择照片/视频）
   - 摄像头（拍摄）
   - 相册（仅写入，用于保存到相册）

   ⚠️ **这一步要早做**。没配置的话 `chooseMedia` / `saveImageToPhotosAlbum`
   会在运行时被直接拦掉，而你会以为是代码 bug。

详细说明见 [微信配置与上线清单](wechat-setup.md)。

---

## 8. 跑通第一场婚礼

1. 用微信开发者工具打开 `miniprogram/`，把 `utils/config.js` 里的
   `PROD_BASE_URL` 改成你的域名、`useProduction` 改成 `true`
2. 在小程序里进入 **主持人入口 → 登录**（用 `.env` 里的账号密码，首登会要求改密）
3. **新建婚礼活动** → 自动跳到详情页
4. 在详情页选好「生成版本」，点**重新生成**，然后**保存到相册**
5. 把二维码打印出来，或直接发到宾客群
6. 用**另一台手机**（另一个微信号）扫这张码，传一张照片试试
7. 回到活动详情页，应当能看到统计数字和素材

### 关于「生成版本」这个选项

| 版本 | 什么时候用 |
| --- | --- |
| **体验版** trial | 小程序还没发布，只有体验成员能扫开。开发和内部测试用这个 |
| **正式版** release | 小程序已发布。**正式办婚礼必须用这个** |
| 开发版 develop | 只有开发者自己能扫开，一般不用 |

⚠️ 用错版本的后果：主持人印了 100 张码，宾客扫出来是白屏。
**婚礼当天之前一定用真手机扫一遍确认。**

---

## 9. 日常维护

### 看日志

```bash
docker compose logs -f --tail=200
```

### 备份

**备份整个 `/vol1/1000/docker/wedding-collect` 目录就是完整备份**——
原图、缩略图、数据库全在里面。用你现有的 NAS 备份任务覆盖它就够了。

服务本身每晚还会用 `VACUUM INTO` 做一份数据库快照，放在 `db/backups/`，保留最近 14 份。

### 升级

```bash
cd /vol1/1000/docker/wedding-app
git pull
docker compose up -d --build
```

数据库迁移在启动时自动执行，不用手动跑。

### 手动清理

服务每 30 分钟自动清一次（过期的上传分片、回收站里超过 24 小时的文件）。
想立刻清一下：

```bash
docker compose exec wedding-collect npm --workspace server run gc
```

### 磁盘占用

约 **50 GB / 场**，一年 30 场就是 1.5 TB。提前规划盘。

---

## 10. 出问题了？

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 第一次上传报 `EACCES` | 数据目录属主不是 uid 1000 | 回到第 2 步 `chown -R 1000:1000` |
| `libvips.so.42: cannot open shared object file` | sharp 的预编译二进制没加载上 | 在 `server/Dockerfile` 的 apt 安装行加上 `libvips42`，重新构建 |
| 容器起来又立刻退出 | `.env` 配置有误 | `docker compose logs` 会明确列出哪一项不对（配置校验是「一次列全部问题」的） |
| 小程序请求全部失败 | 服务器域名没配，或不是 HTTPS | 检查第 7 步的三处域名配置 |
| 小程序扫出来白屏 | 二维码的「生成版本」不对 | 回活动详情页换成 `正式版` 重新生成 |
| 二维码扫出来是网页不是小程序 | `WX_APPID`/`WX_SECRET` 没配，或小程序未发布 | 属于预期的兜底行为。配好凭据后点「重新生成」 |
| 传大视频总失败 | 上行带宽不够 / 中途切了后台 | 见下方「上行带宽」说明 |
| 缩略图不显示，但能下载原图 | HEIC 解码失败 | 原图完好无损，这是预期内的降级。网格会显示占位图标 |

### 关于上行带宽（这条最容易被忽略）

**真正的容量上限是家里宽带的上行，不是 NAS。**

100 位宾客 × 500MB = 50GB。在 30Mbps 上行下，光上传就需要约 **3.7 小时**，
而且主持人查看素材还挤同一条管子。

缓解办法：
- 建议宾客尽量用现场 WiFi
- 页面上已经写了「建议只上传精选照片」
- **主持人根本不需要下载**——文件就在 NAS 上，走 SMB 直接看

---

## 附：本地开发（不部署）

```bash
npm install
cp .env.example .env
# 填 JWT_SECRET / FILE_TOKEN_SECRET（openssl rand -base64 48）
npm run dev          # 起服务，自动建表
npm test             # 跑测试
```

小程序端用微信开发者工具打开 `miniprogram/`，在
「详情 → 本地设置」勾选 **不校验合法域名**，
并把 `utils/config.js` 的 `DEV_BASE_URL` 指向本机局域网 IP
（不是 `127.0.0.1`，手机连不到你的电脑）。

真机调试同样能绕过域名校验，所以**没有备案域名也能先把流程跑通**。
