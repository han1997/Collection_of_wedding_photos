# 部署到飞牛 fnOS

每个容器只用于一场婚礼，Web 页面与 API 一起运行。

## 准备

1. 将仓库放在 NAS 的代码目录，与照片目录分开。
2. 建立本地磁盘上的数据目录，确保容器 uid 1000 可读写：

```bash
sudo mkdir -p /vol1/1000/photos/wedding-collect
sudo chown 1000:1000 /vol1/1000/photos/wedding-collect
```

已有数据不要盲目递归改权限，先检查目录所属用户。不能把 SQLite 数据目录放在 SMB/NFS 挂载上，tmp 与原文件必须同盘。

## 配置

复制 `.env.example` 为 `.env`，真实配置不要提交到 Git。

```ini
PUBLIC_BASE_URL=https://piccol.han1997.fun
HTTP_PORT=1240
BIND_ADDRESS=0.0.0.0
NAS_DATA_DIR=/vol1/1000/photos/wedding-collect
TRUST_PROXY=false
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<自己设置的强密码>
JWT_SECRET=<独立随机密钥>
FILE_TOKEN_SECRET=<另一个独立随机密钥>
```

分别运行两次 `openssl rand -base64 48` 生成密钥。没有任何微信凭据配置。
Compose 强制容器内 `DATA_ROOT=/data`，不要把 `tmp/` 另挂一块盘。

## 构建与启动

```bash
docker compose -p wedding-collect up -d --build
docker compose -p wedding-collect logs --tail 100
curl http://127.0.0.1:1240/api/health
```

访问 `/admin`，初次登录修改密码，然后填写婚礼信息并下载二维码。
健康检查使用独立 JS 文件，不再受容器管理界面丢引号影响。

## 反向代理与 HTTPS

复用现有反向代理，将域名指向 `http://NAS的局域网地址:1240`。若反代直接在宿主机，可使用 `http://127.0.0.1:1240`。
代理必须覆盖 `/`、`/assets/`、`/api/`、`/f/`，不能只转发 API。
设置足够的请求超时，允许分片请求（默认 4MB），不要缓存 API 或私有文件，不要公开日志中的签名链接。

全网卡绑定允许局域网直连，`TRUST_PROXY` 保持 false。若改成可信代理专用网络/回环绑定，且确实阻止了其他来源直连，再考虑开启。
匿名凭证在浏览器中保存，生产必须使用 HTTPS。更换域名相当于换了浏览器存储空间，旧会话不会自动迁移。

## 另一场婚礼

新建独立部署目录及 `.env`，分别设置：

```ini
PUBLIC_BASE_URL=https://另一场的域名
HTTP_PORT=1241
NAS_DATA_DIR=/vol1/1000/photos/another-wedding
```

生成不同的两个密钥和管理员密码，然后：

```bash
docker compose -p another-wedding up -d --build
```

Compose 没有固定 container_name，不同项目不会重名。绝对不要让两个实例共用同一个数据目录。

## 升级旧版与回滚

升级前停止写入并备份整个数据目录及当前镜像标签。新版通过新增 SQL 迁移保留所有旧路径和关联，旧 `events/` 下照片不搬运。

- 旧数据库无婚礼：自动创建默认婚礼。
- 一场婚礼：直接沿用。
- 多场婚礼：启动会提示配置 `EVENT_ID`，明确选择后才继续；不自动删除其他婚礼。
- 新 Web 会话无法自动证明属于旧微信账号；旧素材由管理员访问。
- 不要对迁移后的数据库直接启动旧镜像。需要回滚时恢复升级前的完整备份和旧镜像。

本地仓库 Compose 是构建部署用；如果 NAS 图形界面采用私有镜像仓库，需先构建/推送 Web 镜像，并在界面选择新标签，不能仍用旧小程序镜像。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 启动失败 | 查看日志中的配置/迁移/目录权限错误 |
| unhealthy | 查看 healthcheck 日志和 `/api/health`，不要直接推断服务没启动 |
| 上传 EACCES | 数据目录是否可被 uid 1000 写入 |
| 页面能开，分片失败 | 反代请求体上限、超时、上传开关、磁盘和配额 |
| 无法预览 HEIC/视频 | 解码/浏览器支持限制，先下载原文件确认；不自动转码 |
| 退出后找不到记录 | 是否换浏览器/域名/设备或清掉了 localStorage |

## 日常维护

备份完整 NAS_DATA_DIR，包括 db 与原图。要获得一致数据库备份，可使用 db/backups 的数据库快照或停服务后备份整个目录。
删除素材先进入临时回收，通常 24 小时后清理。上传会话分片也有 24 小时有效期。
公网匿名上传可能被滥用：保留限流、文件类型检查、单人/单场容量限制，不使用默认弱密码，并在收集结束后关闭上传。
