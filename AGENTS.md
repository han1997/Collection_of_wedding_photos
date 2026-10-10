# AGENTS.md：项目约定

## 项目

婚礼照片收集 Web 系统。根目录 `web/` 为原生 HTML/ESM/CSS，后端 Fastify + node:sqlite，单 Docker 容器。一容器一场婚礼，浏览器匿名会话，按宾客子目录保存原文件。不恢复小程序或微信 API。

设计见 README.md，部署见 docs/deploy-fnos.md。

## 不可破坏的规则

1. 宾客侧媒体与上传查询必须同时限制 event_id 和 guest_id。单场不等于可以省掉身份隔离。
2. 越权资源访问返回 404，不暴露 ID 是否存在。
3. 数据库路径必须使用 POSIX `/`，相对路径转绝对路径必须走 `services/storage.js` 的 `toAbs()`。
4. 原文件逐字节保存。缩略图/封面失败不能使上传失败，默认不转码视频。
5. `tmp/`、`guests/`、旧 `events/` 必须在同一文件系统。SQLite 数据不能在 SMB/NFS 上。
6. 已发布的迁移文件不可修改，只能新增下一个编号。清理代码不能删除照片或旧数据库。
7. 服务端密钥只存在于环境变量。匿名凭证不得进入日志、URL、二维码或版本库，数据库只存摘要。
8. 昵称不是身份凭据。同名不合并，改名不移动目录，不能凭昵称恢复记录。

## 技术约束

- Node.js 24，ESM。所有 SQL 经 `db/index.js`，便于未来替换数据库实现。
- 不装 `@fastify/static`、`@fastify/cors`。Web 固定资源使用明确白名单，API 同源。素材只经 `/f/:token` 出口。
- `bodyLimit` 保持 1MB；分片通过原始流接收，不调大 JSON 请求体上限。
- 浏览器 localStorage 失败要降级并提示，网络错误不能清空旧会话。
- 页面关闭后续传需要重新选择原文件并验证摘要，不能承诺后台一直上传。
- 默认 TRUST_PROXY=false。不能因使用反代就无条件信任所有代理头。

## 代码与测试

- 注释和用户文案使用中文，标识符使用英文。
- 注释解释原因，避免重复代码含义。
- 错误使用 `lib/errors.js` 工厂函数，API 响应保持 `{ok:true,data}` / `{ok:false,error:{code,message}}`。
- 分页使用 `created_at|id` 游标，不用 offset。
- 用户内容用 textContent/DOM API 渲染，不直接拼入 HTML。
- `npm test`：后端与迁移测试。
- `npm run test:web`：Playwright 浏览器测试，使用独立临时数据库，不连接 NAS。
- `npm run dev`：本地启动；`npm run migrate`：迁移；`npm run seed-admin`：创建/重置管理员。
