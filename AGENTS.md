# AGENTS.md —— 给 AI 助手的项目约定

## 这个项目是什么

婚礼照片收集系统。微信小程序 + 自建 NAS 后端（Fastify + SQLite，单 Docker 容器）。
主持人每场婚礼建一个活动、生成一个二维码；宾客扫码上传，原文件直接落到 NAS。

完整设计与取舍见 `README.md`。部署见 `docs/deploy-fnos.md`。

## 绝对不要破坏的约定

1. **宾客侧的任何查询都必须同时带 `event_id` 和 `guest_id`。**
   这是「宾客只能看到自己上传的内容」的全部实现。漏掉任何一个条件就是数据泄露。

2. **越权访问返回 404，不返回 403。**
   403 等于确认「这个 ID 存在，只是你没权限」，本身就是信息泄露。

3. **DB 里的路径一律 POSIX（`/`）。**
   开发机是 Windows、生产是 Linux。任何反斜杠进库都会在换机器时全崩。

4. **所有「相对路径 → 绝对路径」的转换必须走 `services/storage.js` 的 `toAbs()`。**
   它是唯一做了越界检查的地方。别在别处拼 `path.join(DATA_ROOT, ...)`。

5. **原图逐字节原样保存。**
   缩略图/封面生成失败**绝不能**导致上传失败——降级成占位图即可，
   数据完整性不受影响。

6. **默认不转码视频。** 弱 NAS 上转码会钉死 CPU，而那时其他宾客还在上传。

7. **`AppSecret` 只存在于服务端环境变量。**
   绝不写进 `miniprogram/` 下任何文件，包括 `project.config.json`。

8. **已发布的迁移文件不可修改。** 只能新增 `002_xxx.sql`。

## 技术选型里几个反直觉的点

- **用 `node:sqlite`（Node 内置），不用 better-sqlite3。**
  理由是去掉原生编译依赖。代价是它仍标记为 experimental，所以
  **所有 SQL 必须经过 `db/index.js`**——将来要换回 better-sqlite3 只改这一个文件。
- **`tmp/` 必须和 `events/` 在同一个文件系统上。**
  合并大文件靠 `fs.rename`，同盘才原子；拆到别的挂载点会退化成整文件拷贝。
- **不装 `@fastify/static`，也不装 `@fastify/cors`。**
  素材只经 `GET /f/:token` 的签名 URL 出去；小程序不发预检，装了 CORS 反而更危险。
- **`bodyLimit` 保持默认的 1MB 不要动。**
  分片上传是绕过它的（原始流直接交给 handler），不是靠调大它。

## 命令

```bash
npm install            # 装依赖
npm run dev            # 起服务（自动迁移）
npm test               # 跑测试
npm run migrate        # 只跑迁移
npm run seed-admin     # 建/重置管理员
```

## 代码风格

- 服务端是 ESM（`"type": "module"`）
- **注释和用户可见文案用中文**，标识符用英文
- 注释解释**为什么**，不解释**是什么**——代码本身能说清的事不要写
- 错误统一用 `lib/errors.js` 的 `AppError` 和那几个工厂函数，
  别在路由里直接 `reply.code(500)`
- 响应统一走 `{ok:true,data}` / `{ok:false,error:{code,message}}` 信封
- 分页用游标（`created_at|id`），**不要用 offset**——
  婚礼当天素材持续涌入，offset 分页会重复和漏行

## 需要人工核对的外部信息

微信接口的细节会变，而本项目的开发环境**访问不了微信官方文档**。
以下内容实现/修改前必须对照 `developers.weixin.qq.com` 核实，代码里已用 ⚠️ 标注：

- `wxacode.getUnlimited` 的 `env_version` / `check_path` 参数
- 隐私接口：`wx.getPrivacySetting` / `wx.onNeedPrivacyAuthorization` /
  `<button open-type="agreePrivacyAuthorization">`，以及 `app.json` 是否还需要 `__usePrivacyCheck__`
- 内容安全接口名与版本：`img_sec_check`(v1) vs `media_check_async`(v2)
- `wx.downloadFile` 的大小上限
- `FileSystemManager.saveFile` 的大文件持久化上限
- 服务类目树，以及**个人主体**能选哪些（本项目的用户是个人主体）
