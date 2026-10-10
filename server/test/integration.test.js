import "./_setup.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test, { before, after } from "node:test";
import {
  getApp,
  stopApp,
  bootstrapAdmin,
  guestLogin,
  pngBuffer,
  fakeMp4Buffer,
  uploadFile,
} from "./_app.js";
import { currentEvent, initializeSite } from "../src/repositories/site.repo.js";
import * as mediaRepo from "../src/repositories/media.repo.js";
import { all, get, run } from "../src/db/index.js";
import { toAbs } from "../src/services/storage.js";
import { drain } from "../src/jobs/queue.js";
import { migrate } from "../src/db/migrate.js";

let app, admin, boot;
const auth = (token) => ({ authorization: `Bearer ${token}` });
const hash = (data) => createHash("sha256").update(data).digest("hex");
before(async () => {
  app = await getApp();
  boot = await bootstrapAdmin(app);
  admin = boot.token;
});
after(stopApp);

async function init(token, buffer, sha256 = hash(buffer)) {
  const res = await app.inject({
    method: "POST",
    url: "/api/uploads/init",
    headers: auth(token),
    payload: {
      fileName: "原图.png",
      mime: "image/png",
      bytes: buffer.length,
      sha256,
      chunkSize: 1048576,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data;
}
async function part(token, id, n, buffer) {
  return app.inject({
    method: "PUT",
    url: `/api/uploads/${id}/parts/${n}`,
    headers: {
      ...auth(token),
      "content-type": "application/octet-stream",
      "content-length": String(buffer.length),
    },
    payload: buffer,
  });
}

test("管理员首登改密，旧 token 失效且新令牌可用", async () => {
  assert.equal(boot.initialMustChange, true);
  assert.equal(boot.blockedStatus, 403);
  assert.equal(
    (
      await app.inject({
        url: "/api/admin/wedding",
        headers: auth(boot.initialToken),
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: "/api/admin/wedding", headers: auth(admin) }))
      .statusCode,
    200,
  );
});
test("单场初始化和迁移可重复运行，不重建婚礼", () => {
  const id = currentEvent().id;
  initializeSite();
  assert.equal(currentEvent().id, id);
  assert.deepEqual(migrate({ log() {} }).applied, []);
  assert.equal(get("SELECT COUNT(*) AS n FROM site").n, 1);
});
test("不再开放多婚礼创建、列表和微信登录", async () => {
  for (const [method, url] of [
    ["POST", "/api/admin/events"],
    ["GET", "/api/admin/events"],
    ["POST", "/api/auth/login"],
  ])
    assert.equal(
      (
        await app.inject({
          method,
          url,
          headers: auth(admin),
          ...(method === "POST" ? { payload: {} } : {}),
        })
      ).statusCode,
      404,
    );
});
test("匿名会话可恢复，同名宾客不共享身份，数据库不保存明文凭证", async () => {
  const a = await guestLogin(app, "亲友"),
    b = await guestLogin(app, "亲友");
  assert.notEqual(a.guestId, b.guestId);
  assert.notEqual(
    get("SELECT folder_id FROM guests WHERE id = ?", [a.guestId]).folder_id,
    get("SELECT folder_id FROM guests WHERE id = ?", [b.guestId]).folder_id,
  );
  assert.equal(
    (await app.inject({ url: "/api/auth/me", headers: auth(a.token) })).json()
      .data.me.guestId,
    a.guestId,
  );
  assert.ok(
    !JSON.stringify(all("SELECT * FROM guest_sessions")).includes(a.token),
  );
  assert.equal(
    (await app.inject({ url: "/api/media", headers: auth(admin) })).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: "/api/admin/wedding", headers: auth(a.token) }))
      .statusCode,
    401,
  );
});
test("过期、撤销、伪造及封禁会话不可用", async () => {
  const a = await guestLogin(app, "过期");
  run("UPDATE guest_sessions SET expires_at = ? WHERE guest_id = ?", [
    "2000-01-01",
    a.guestId,
  ]);
  assert.equal(
    (await app.inject({ url: "/api/media", headers: auth(a.token) }))
      .statusCode,
    401,
  );
  const b = await guestLogin(app, "撤销");
  await app.inject({
    method: "DELETE",
    url: "/api/auth/session",
    headers: auth(b.token),
  });
  assert.equal(
    (await app.inject({ url: "/api/media", headers: auth(b.token) }))
      .statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: "/api/media", headers: auth("forged") }))
      .statusCode,
    401,
  );
  const c = await guestLogin(app, "封禁");
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/admin/guests/${c.guestId}`,
        headers: auth(admin),
        payload: { banned: true },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: "/api/media", headers: auth(c.token) }))
      .statusCode,
    401,
  );
});
test("分片续传与完成幂等，原图字节不变，宾客独立目录", async () => {
  const a = await guestLogin(app, "上传者"),
    buffer = pngBuffer(2500000);
  const session = await init(a.token, buffer);
  const first = buffer.subarray(0, session.chunkSize);
  assert.equal(
    (await part(a.token, session.sessionId, 1, first)).statusCode,
    200,
  );
  assert.equal(
    (await part(a.token, session.sessionId, 1, first)).json().data.duplicate,
    true,
  );
  const state = (
    await app.inject({
      url: `/api/uploads/${session.sessionId}`,
      headers: auth(a.token),
    })
  ).json().data;
  assert.deepEqual(state.receivedParts, [1]);
  for (let n = 2; n <= session.totalParts; n++)
    assert.equal(
      (
        await part(
          a.token,
          session.sessionId,
          n,
          buffer.subarray((n - 1) * session.chunkSize, n * session.chunkSize),
        )
      ).statusCode,
      200,
    );
  const complete = () =>
    app.inject({
      method: "POST",
      url: `/api/uploads/${session.sessionId}/complete`,
      headers: auth(a.token),
      payload: {},
    });
  const result = await complete();
  assert.equal(result.statusCode, 200, result.body);
  const id = result.json().data.mediaId;
  assert.equal((await complete()).json().data.mediaId, id);
  const media = mediaRepo.findById(id);
  assert.match(
    media.paths.original,
    /^guests\/[A-Za-z0-9_-]+\/\d{4}-\d{2}-\d{2}\/originals\//,
  );
  assert.deepEqual(fs.readFileSync(toAbs(media.paths.original)), buffer);
  const dir = get("SELECT folder_id FROM guests WHERE id = ?", [
    a.guestId,
  ]).folder_id;
  await app.inject({
    method: "PATCH",
    url: "/api/auth/me",
    headers: auth(a.token),
    payload: { displayName: "../../新名字" },
  });
  assert.equal(
    get("SELECT folder_id FROM guests WHERE id = ?", [a.guestId]).folder_id,
    dir,
  );
  await drain();
  assert.equal(mediaRepo.findById(id).status, "ready");
});
test("另一宾客不能查看详情、获取链接、删除或读写分片", async () => {
  const a = await guestLogin(app, "A"),
    b = await guestLogin(app, "B");
  const uploaded = await uploadFile(app, a.token, currentEvent().id, {
    fileName: "a.png",
    mime: "image/png",
    buffer: pngBuffer(),
  });
  for (const [method, url] of [
    ["GET", `/api/media/${uploaded.mediaId}`],
    ["GET", `/api/media/${uploaded.mediaId}/url`],
    ["DELETE", `/api/media/${uploaded.mediaId}`],
    ["GET", `/api/uploads/${uploaded.sessionId}`],
    ["DELETE", `/api/uploads/${uploaded.sessionId}`],
    ["POST", `/api/uploads/${uploaded.sessionId}/complete`],
  ]) {
    const res = await app.inject({
      method,
      url,
      headers: auth(b.token),
      ...(method === "POST" ? { payload: {} } : {}),
    });
    assert.equal(res.statusCode, 404, `${method} ${url}: ${res.body}`);
  }
  assert.equal(
    (await part(b.token, uploaded.sessionId, 1, pngBuffer())).statusCode,
    404,
  );
  assert.deepEqual(
    (await app.inject({ url: "/api/media", headers: auth(b.token) })).json()
      .data.media,
    [],
  );
});
test("SHA-256 不匹配拒绝落盘", async () => {
  const a = await guestLogin(app, "校验"),
    buffer = pngBuffer();
  const session = await init(a.token, buffer, "0".repeat(64));
  await part(a.token, session.sessionId, 1, buffer);
  const res = await app.inject({
    method: "POST",
    url: `/api/uploads/${session.sessionId}/complete`,
    headers: auth(a.token),
    payload: {},
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.deepEqual(
    (await app.inject({ url: "/api/media", headers: auth(a.token) })).json()
      .data.media,
    [],
  );
});
test("缺片、错误字节数、关闭上传和假图片均被拒绝", async () => {
  const a = await guestLogin(app, "异常");
  const buffer = pngBuffer();
  const s = await init(a.token, buffer);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/uploads/${s.sessionId}/complete`,
        headers: auth(a.token),
        payload: {},
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await part(a.token, s.sessionId, 1, buffer.subarray(1))).statusCode,
    400,
  );
  const fake = Buffer.from("<html>不是图片</html>");
  const f = await init(a.token, fake);
  await part(a.token, f.sessionId, 1, fake);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/uploads/${f.sessionId}/complete`,
        headers: auth(a.token),
        payload: {},
      })
    ).statusCode,
    415,
  );
  await app.inject({
    method: "PATCH",
    url: "/api/admin/wedding",
    headers: auth(admin),
    payload: { uploadEnabled: false },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/uploads/init",
    headers: auth(a.token),
    payload: { fileName: "a.png", mime: "image/png", bytes: buffer.length },
  });
  assert.equal(res.statusCode, 409);
  await app.inject({
    method: "PATCH",
    url: "/api/admin/wedding",
    headers: auth(admin),
    payload: { uploadEnabled: true },
  });
});
test("游标翻页不重复、不遗漏", async () => {
  const a = await guestLogin(app, "分页");
  for (let i = 0; i < 3; i++)
    await uploadFile(app, a.token, currentEvent().id, {
      fileName: "a.png",
      mime: "image/png",
      buffer: pngBuffer(),
    });
  const ids = [];
  let cursor = "";
  do {
    const res = await app.inject({
      url: `/api/media?limit=1&cursor=${encodeURIComponent(cursor)}`,
      headers: auth(a.token),
    });
    assert.equal(res.statusCode, 200);
    const data = res.json().data;
    ids.push(...data.media.map((m) => m.id));
    cursor = data.nextCursor;
    assert.ok(ids.length <= 3);
  } while (cursor);
  assert.equal(new Set(ids).size, 3);
});
test("原视频可 Range 下载，删除后旧链接失效", async () => {
  const a = await guestLogin(app, "视频");
  const buffer = fakeMp4Buffer();
  const { mediaId } = await uploadFile(app, a.token, currentEvent().id, {
    fileName: "a.mp4",
    mime: "video/mp4",
    buffer,
  });
  const media = (
    await app.inject({ url: `/api/media/${mediaId}`, headers: auth(a.token) })
  ).json().data.media;
  const url = new URL(media.downloadUrl).pathname;
  const range = await app.inject({ url, headers: { range: "bytes=0-9" } });
  assert.equal(range.statusCode, 206);
  assert.deepEqual(range.rawPayload, buffer.subarray(0, 10));
  await drain();
  await app.inject({
    method: "DELETE",
    url: `/api/media/${mediaId}`,
    headers: auth(a.token),
  });
  assert.equal((await app.inject({ url })).statusCode, 404);
});
