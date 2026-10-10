import "./_setup.js";
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { getApp, stopApp, bootstrapAdmin } from "./_app.js";
import { currentEvent } from "../src/repositories/site.repo.js";
let app, admin;
before(async () => {
  app = await getApp();
  admin = (await bootstrapAdmin(app)).token;
});
after(stopApp);
test("Web 页面与模块只允许白名单资源", async () => {
  for (const url of [
    "/",
    "/admin",
    "/privacy",
    "/assets/guest.js",
    "/assets/styles.css",
    "/assets/hash/sha2.js",
    "/assets/hash/_md.js",
    "/assets/hash/utils.js",
  ]) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 200, url);
    if (!url.startsWith("/assets/"))
      assert.match(res.headers["content-security-policy"], /script-src 'self'/);
  }
  for (const url of [
    "/.env",
    "/assets/../.env",
    "/data/db/app.db",
    "/assets/hash/package.json",
  ])
    assert.equal((await app.inject({ url })).statusCode, 404, url);
});
test("婚礼二维码是本地生成的 PNG，指向网站根路径", async () => {
  assert.equal((await app.inject({ url: "/api/admin/qr" })).statusCode, 401);
  const res = await app.inject({
    url: "/api/admin/qr",
    headers: { authorization: `Bearer ${admin}` },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.url, "http://127.0.0.1:3000/");
  const image = Buffer.from(data.image.split(",")[1], "base64");
  assert.deepEqual([...image.subarray(0, 4)], [137, 80, 78, 71]);
});
test("旧链接仅对当前婚礼重定向", async () => {
  assert.equal(
    (await app.inject({ url: `/e/${currentEvent().id}` })).headers.location,
    "/",
  );
  assert.equal((await app.inject({ url: "/e/not-here" })).statusCode, 404);
});
test("公开婚礼信息不含私有凭证及目录", async () => {
  const res = await app.inject({ url: "/api/site" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.ok(res.json().data.instanceId);
  assert.doesNotMatch(res.body, /folder|password|secret|token|openid/i);
});
