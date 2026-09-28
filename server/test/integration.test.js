import './_setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';

import config from '../src/config.js';
import {
  adminLogin,
  bootstrapAdmin,
  createEvent,
  fakeMp4Buffer,
  getApp,
  guestLogin,
  installFakeWechat,
  pngBuffer,
  restoreFetch,
  stopApp,
  uploadFile,
} from './_app.js';

/**
 * 服务端会把分片大小夹到 [1MB, 16MB]。
 * 测试里用手输 64KB 是没用的——会被抬到 1MB。
 * 所以要用 ≥1MB 的分片，并且文件要够大才会真的切成多片。
 */
const CHUNK = 1024 * 1024;
const MULTI_PART_SIZE = 2_500_000;

let app;
let admin;
let adminBoot;

before(async () => {
  installFakeWechat();
  app = await getApp();
  adminBoot = await bootstrapAdmin(app);
  admin = adminBoot.token;
});

after(async () => {
  restoreFetch();
  await stopApp();
});

// ===========================================================================
// 登录
// ===========================================================================

test('管理端：初始密码登录后强制改密，改密作废旧令牌', async () => {
  // before 里已经走完了这套流程，这里断言那几步的中间状态
  assert.equal(adminBoot.initialMustChange, true, '初始密码应当被标记为必须修改');
  assert.equal(adminBoot.blockedStatus, 403, '未改密时管理接口应当被拦住');

  // ★ token_version 递增后，改密前签发的令牌必须立即失效
  const stale = await app.inject({
    method: 'GET',
    url: '/api/admin/events',
    headers: { authorization: `Bearer ${adminBoot.initialToken}` },
  });
  assert.equal(stale.statusCode, 401, '改密后旧令牌应当立即失效');

  // 新令牌可用
  const okRes = await app.inject({
    method: 'GET',
    url: '/api/admin/events',
    headers: { authorization: `Bearer ${admin}` },
  });
  assert.equal(okRes.statusCode, 200);

  // 新密码也真的能登录
  const relogin = await adminLogin(app, { password: adminBoot.newPassword });
  assert.equal(relogin.res.statusCode, 200);
  assert.equal(relogin.body.data.admin.mustChangePassword, false);
});

test('管理端：错误密码被拒', async () => {
  const { res } = await adminLogin(app, { password: 'definitely-wrong' });
  assert.equal(res.statusCode, 401);
});

test('宾客登录成功并拿到令牌', async () => {
  const { token, guestId } = await guestLogin(app, 'alice');
  assert.ok(token);
  assert.ok(Number.isInteger(guestId));
});

test('微信返回错误码时登录失败，且不会误当成成功', async () => {
  restoreFetch();
  installFakeWechat({ mode: 'wechat-error', errcode: 40029 });

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { code: 'bad-code' },
  });
  // 微信出错时 HTTP 仍是 200 —— 这条用例就是防止有人只看 HTTP 状态码
  assert.equal(res.statusCode, 401);

  restoreFetch();
  installFakeWechat();
});

// ===========================================================================
// 活动
// ===========================================================================

test('管理端能建活动，目录和 .event.json 都建好了', async () => {
  const event = await createEvent(app, admin);

  assert.match(event.id, /^[A-Za-z0-9]{10}$/);
  assert.match(event.slug, /^2026-05-20_张伟-李娜_/);

  const dir = path.join(config.paths.events, event.slug);
  assert.ok(fs.existsSync(dir), '活动目录应当存在');
  assert.ok(fs.existsSync(path.join(dir, '.event.json')), '.event.json 应当存在');

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.event.json'), 'utf8'));
  assert.equal(manifest.活动ID, event.id);
});

test('宾客能进入活动，并自动成为该活动成员', async () => {
  const event = await createEvent(app, admin, { title: '入场测试', eventDate: '2026-06-01' });
  const { token } = await guestLogin(app, 'bob', event.id);

  const res = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}`,
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.event.id, event.id);
  assert.deepEqual(data.media, []);
  assert.equal(data.me.uploadCount, 0);
});

test('不存在的活动返回 404', async () => {
  const { token } = await guestLogin(app, 'alice');
  const res = await app.inject({
    method: 'GET',
    url: '/api/events/doesnotexist',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 404);
});

// ===========================================================================
// 上传
// ===========================================================================

test('分片上传一张图片，文件按 NAS 布局落盘', async () => {
  const event = await createEvent(app, admin, { title: '上传测试', eventDate: '2026-07-01' });
  const { token, guestId } = await guestLogin(app, 'carol', event.id);

  const buffer = pngBuffer(MULTI_PART_SIZE); // 足够切成多片
  const { mediaId, parts } = await uploadFile(app, token, event.id, {
    fileName: 'IMG_1234.png',
    mime: 'image/png',
    buffer,
    chunkSize: CHUNK,
  });

  assert.ok(mediaId);
  assert.ok(parts > 1, `应当切成多片，实际 ${parts} 片`);

  // 「我上传的」应当看到它
  const mine = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}/media`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(mine.statusCode, 200);
  const list = mine.json().data.media;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, mediaId);
  assert.equal(list[0].kind, 'image');
  assert.equal(list[0].bytes, buffer.length);
  assert.ok(list[0].thumbUrl, '应当有可用的缩略图 URL');

  // 文件真的落到 events/<slug>/<日期>/originals/ 下了
  const dir = path.join(config.paths.events, event.slug);
  const dayDirs = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n));
  assert.ok(dayDirs.length >= 1, '应当按日期建了子目录');

  const originals = path.join(dir, dayDirs[0], 'originals');
  const files = fs.readdirSync(originals);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{6}_[0-9a-z]{6}_.+\.png$/);

  // 落盘的文件内容必须和上传的**逐字节**一致
  const written = fs.readFileSync(path.join(originals, files[0]));
  assert.equal(written.length, buffer.length);
  assert.ok(written.equals(buffer), '落盘内容必须与上传内容完全一致');

  // 临时目录清理干净了
  assert.ok(!fs.existsSync(path.join(config.paths.tmpUploads, mediaId)));

  // 计数同步更新
  const after = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(after.json().data.me.uploadCount, 1);
  assert.equal(after.json().data.me.bytesUploaded, buffer.length);

  void guestId;
});

// ===========================================================================
// ★ 核心不变式：宾客只能看到自己上传的
// ===========================================================================

test('★ 宾客 B 看不到宾客 A 上传的内容', async () => {
  const event = await createEvent(app, admin, { title: '隔离测试', eventDate: '2026-08-01' });

  const a = await guestLogin(app, 'dave', event.id);
  const b = await guestLogin(app, 'erin', event.id);

  await uploadFile(app, a.token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer: pngBuffer(1000),
    chunkSize: CHUNK,
  });

  const listA = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}/media`,
    headers: { authorization: `Bearer ${a.token}` },
  });
  assert.equal(listA.json().data.media.length, 1, 'A 应当看到自己的 1 张');

  const listB = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}/media`,
    headers: { authorization: `Bearer ${b.token}` },
  });
  assert.equal(listB.json().data.media.length, 0, '★ B 绝不能看到 A 的内容');

  // B 登录时拿到的落地数据里也不能有 A 的东西
  assert.deepEqual(b.data.media, []);
});

test('★ 宾客 B 猜 ID 也拿不到 A 的素材（返回 404 而非 403）', async () => {
  const event = await createEvent(app, admin, { title: '越权测试', eventDate: '2026-09-01' });

  const a = await guestLogin(app, 'frank', event.id);
  const b = await guestLogin(app, 'grace', event.id);

  const { mediaId } = await uploadFile(app, a.token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer: pngBuffer(1000),
    chunkSize: CHUNK,
  });

  // 换签名 URL
  const urlRes = await app.inject({
    method: 'GET',
    url: `/api/media/${mediaId}/url?variant=original`,
    headers: { authorization: `Bearer ${b.token}` },
  });
  assert.equal(urlRes.statusCode, 404, '越权取 URL 应当是 404，不是 403');

  // 删除
  const delRes = await app.inject({
    method: 'DELETE',
    url: `/api/media/${mediaId}`,
    headers: { authorization: `Bearer ${b.token}` },
  });
  assert.equal(delRes.statusCode, 404, '越权删除应当是 404');

  // 素材仍然存在
  const stillThere = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}/media`,
    headers: { authorization: `Bearer ${a.token}` },
  });
  assert.equal(stillThere.json().data.media.length, 1, 'A 的素材不该被动到');
});

test('★ 宾客拿不到别的活动的素材', async () => {
  const eventA = await createEvent(app, admin, { title: '活动甲', eventDate: '2026-10-01' });
  const eventB = await createEvent(app, admin, { title: '活动乙', eventDate: '2026-10-02' });

  // 同一个人参加两场婚礼（openid 相同，这是真实情况）
  const inA = await guestLogin(app, 'henry', eventA.id);
  const inB = await guestLogin(app, 'henry', eventB.id);
  assert.equal(inA.guestId, inB.guestId, '同一个人在两场活动里应当是同一个 guest');

  await uploadFile(app, inA.token, eventA.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer: pngBuffer(1000),
    chunkSize: CHUNK,
  });

  // 在活动乙里，他不该看到活动甲的照片
  const listB = await app.inject({
    method: 'GET',
    url: `/api/events/${eventB.id}/media`,
    headers: { authorization: `Bearer ${inB.token}` },
  });
  assert.equal(listB.json().data.media.length, 0, '★ 活动之间必须隔离');

  // 活动甲的列表里仍然是 1 张
  const listA = await app.inject({
    method: 'GET',
    url: `/api/events/${eventA.id}/media`,
    headers: { authorization: `Bearer ${inA.token}` },
  });
  assert.equal(listA.json().data.media.length, 1);
});

test('★ 无令牌访问一律 401', async () => {
  const event = await createEvent(app, admin, { title: '未鉴权测试' });

  for (const url of [
    `/api/events/${event.id}`,
    `/api/events/${event.id}/media`,
    '/api/uploads',
  ]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, `${url} 应当要求登录`);
  }

  const noAdmin = await app.inject({ method: 'GET', url: '/api/admin/events' });
  assert.equal(noAdmin.statusCode, 401);
});

test('★ 宾客令牌不能访问管理端接口', async () => {
  const event = await createEvent(app, admin, { title: '令牌类型测试' });
  const { token } = await guestLogin(app, 'ivy', event.id);

  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/events',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
});

// ===========================================================================
// 上传校验
// ===========================================================================

test('不支持的文件类型被拒（415）', async () => {
  const event = await createEvent(app, admin, { title: '类型校验' });
  const { token } = await guestLogin(app, 'jack', event.id);

  const res = await app.inject({
    method: 'POST',
    url: '/api/uploads/init',
    headers: { authorization: `Bearer ${token}` },
    payload: { eventId: event.id, fileName: 'evil.exe', mime: 'application/octet-stream', bytes: 100 },
  });
  assert.equal(res.statusCode, 415);
});

test('★ 内容与扩展名不符时被拒（挡住多态文件）', async () => {
  const event = await createEvent(app, admin, { title: '多态文件防御' });
  const { token } = await guestLogin(app, 'kate', event.id);

  // 声称是 png，实际是 HTML —— 经典的「上传一个 .jpg 实际是脚本」
  const html = Buffer.from('<html><script>alert(1)</script></html>'.repeat(100));

  await assert.rejects(
    () =>
      uploadFile(app, token, event.id, {
        fileName: 'innocent.png',
        mime: 'image/png',
        buffer: html,
        chunkSize: CHUNK,
      }),
    /415|不支持的|不符/,
  );

  // 而且不该在 NAS 上留下任何文件
  const dir = path.join(config.paths.events, event.slug);
  const dayDirs = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    : [];
  for (const day of dayDirs) {
    const originals = path.join(dir, day, 'originals');
    if (fs.existsSync(originals)) {
      assert.equal(fs.readdirSync(originals).length, 0, '被拒的文件不该落盘');
    }
  }
});

test('分片大小不符时被拒', async () => {
  const event = await createEvent(app, admin, { title: '分片校验' });
  const { token } = await guestLogin(app, 'leo', event.id);

  const buffer = pngBuffer(MULTI_PART_SIZE);
  const init = await app.inject({
    method: 'POST',
    url: '/api/uploads/init',
    headers: { authorization: `Bearer ${token}` },
    payload: { eventId: event.id, fileName: 'x.png', mime: 'image/png', bytes: buffer.length, chunkSize: CHUNK },
  });
  const { sessionId, chunkSize } = init.json().data;

  // 故意传一个大小不对的分片
  const res = await app.inject({
    method: 'PUT',
    url: `/api/uploads/${sessionId}/parts/1`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': '10',
    },
    payload: Buffer.alloc(10),
  });
  assert.equal(res.statusCode, 400, `期望 400，实际 ${res.statusCode}: ${res.body}`);

  void chunkSize;
});

test('分片不齐时不允许 complete', async () => {
  const event = await createEvent(app, admin, { title: '完整性校验' });
  const { token } = await guestLogin(app, 'mia', event.id);

  const buffer = pngBuffer(MULTI_PART_SIZE);
  const init = await app.inject({
    method: 'POST',
    url: '/api/uploads/init',
    headers: { authorization: `Bearer ${token}` },
    payload: { eventId: event.id, fileName: 'x.png', mime: 'image/png', bytes: buffer.length, chunkSize: CHUNK },
  });
  const { sessionId, chunkSize, totalParts } = init.json().data;

  // 只传第 1 片
  await app.inject({
    method: 'PUT',
    url: `/api/uploads/${sessionId}/parts/1`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(chunkSize),
    },
    payload: buffer.subarray(0, chunkSize),
  });

  const res = await app.inject({
    method: 'POST',
    url: `/api/uploads/${sessionId}/complete`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });

  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error.code, 'CONFLICT');
  assert.equal(body.error.details.missingCount, totalParts - 1);
});

// ===========================================================================
// 断点续传
// ===========================================================================

test('★ 续传：查状态能准确说出已收和缺失的分片', async () => {
  const event = await createEvent(app, admin, { title: '续传测试' });
  const { token } = await guestLogin(app, 'nina', event.id);

  const buffer = pngBuffer(MULTI_PART_SIZE);
  const init = await app.inject({
    method: 'POST',
    url: '/api/uploads/init',
    headers: { authorization: `Bearer ${token}` },
    payload: { eventId: event.id, fileName: 'x.png', mime: 'image/png', bytes: buffer.length, chunkSize: CHUNK },
  });
  const { sessionId, chunkSize, totalParts } = init.json().data;

  // 乱序传第 1 片和第 3 片。
  // 注意最后一片比 chunkSize 短，content-length 必须按实际长度给——
  // 服务端会拿它和该片应有的大小做精确核对。
  for (const partNo of [1, 3]) {
    const start = (partNo - 1) * chunkSize;
    const chunk = buffer.subarray(start, Math.min(start + chunkSize, buffer.length));

    const res = await app.inject({
      method: 'PUT',
      url: `/api/uploads/${sessionId}/parts/${partNo}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.length),
      },
      payload: chunk,
    });
    assert.equal(res.statusCode, 200, `第 ${partNo} 片应当被接收：${res.body}`);
  }

  const status = await app.inject({
    method: 'GET',
    url: `/api/uploads/${sessionId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(status.statusCode, 200);
  const st = status.json().data;
  assert.deepEqual(st.receivedParts.sort(), [1, 3]);
  assert.equal(st.totalParts, totalParts);

  // 重发第 1 片应当幂等，不报错也不重复计数
  const again = await app.inject({
    method: 'PUT',
    url: `/api/uploads/${sessionId}/parts/1`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(chunkSize),
    },
    payload: buffer.subarray(0, chunkSize),
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().data.duplicate, true);

  // 补齐剩下的分片后应当能合并成功
  const have = new Set([1, 3]);
  for (let partNo = 1; partNo <= totalParts; partNo += 1) {
    if (have.has(partNo)) continue;
    const start = (partNo - 1) * chunkSize;
    const chunk = buffer.subarray(start, Math.min(start + chunkSize, buffer.length));
    const r = await app.inject({
      method: 'PUT',
      url: `/api/uploads/${sessionId}/parts/${partNo}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.length),
      },
      payload: chunk,
    });
    assert.equal(r.statusCode, 200, `补第 ${partNo} 片失败: ${r.body}`);
  }

  const done = await app.inject({
    method: 'POST',
    url: `/api/uploads/${sessionId}/complete`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
  assert.equal(done.statusCode, 200);
});

test('★ 别人的上传会话拿不到（隔断他人续传）', async () => {
  const event = await createEvent(app, admin, { title: '会话越权' });
  const a = await guestLogin(app, 'olive', event.id);
  const b = await guestLogin(app, 'pete', event.id);

  const init = await app.inject({
    method: 'POST',
    url: '/api/uploads/init',
    headers: { authorization: `Bearer ${a.token}` },
    payload: { eventId: event.id, fileName: 'x.png', mime: 'image/png', bytes: 1000 },
  });
  const { sessionId } = init.json().data;

  const res = await app.inject({
    method: 'GET',
    url: `/api/uploads/${sessionId}`,
    headers: { authorization: `Bearer ${b.token}` },
  });
  assert.equal(res.statusCode, 404);
});

// ===========================================================================
// 视频
// ===========================================================================

test('视频上传成功，并标记了 kind=video', async () => {
  const event = await createEvent(app, admin, { title: '视频测试' });
  const { token } = await guestLogin(app, 'quinn', event.id);

  const buffer = fakeMp4Buffer(300_000);
  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'VID_5678.mp4',
    mime: 'video/mp4',
    buffer,
    chunkSize: CHUNK,
  });

  const res = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}/media`,
    headers: { authorization: `Bearer ${token}` },
  });
  const item = res.json().data.media.find((m) => m.id === mediaId);
  assert.equal(item.kind, 'video');
  assert.ok(item.videoUrl, '视频应当有播放地址');
  assert.equal(item.bytes, buffer.length);
});

// ===========================================================================
// 管理端
// ===========================================================================

test('★ 管理员能看到所有人的素材（不受 guest_id 限制）', async () => {
  const event = await createEvent(app, admin, { title: '管理端全览', eventDate: '2026-11-01' });

  const a = await guestLogin(app, 'rita', event.id);
  const b = await guestLogin(app, 'sam', event.id);

  await uploadFile(app, a.token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer: pngBuffer(1000),
    chunkSize: CHUNK,
  });
  await uploadFile(app, b.token, event.id, {
    fileName: 'b.png',
    mime: 'image/png',
    buffer: pngBuffer(2000),
    chunkSize: CHUNK,
  });

  const res = await app.inject({
    method: 'GET',
    url: `/api/admin/media?eventId=${event.id}`,
    headers: { authorization: `Bearer ${admin}` },
  });
  assert.equal(res.statusCode, 200);
  const media = res.json().data.media;
  assert.equal(media.length, 2, '管理员应当看到 2 个人的素材');

  const guestIds = new Set(media.map((m) => m.guestId));
  assert.equal(guestIds.size, 2, '应当来自两个不同的宾客');
  assert.notEqual(a.guestId, b.guestId);
});

test('管理端活动的统计数据正确', async () => {
  const event = await createEvent(app, admin, { title: '统计测试', eventDate: '2026-12-01' });
  const { token } = await guestLogin(app, 'tina', event.id);

  await uploadFile(app, token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer: pngBuffer(5000),
    chunkSize: CHUNK,
  });

  const res = await app.inject({
    method: 'GET',
    url: `/api/admin/events/${event.id}`,
    headers: { authorization: `Bearer ${admin}` },
  });
  const data = res.json().data;
  assert.equal(data.stats.uploadCount, 1);
  assert.equal(data.stats.guestCount, 1);
  assert.ok(data.stats.totalBytes > 5000);
  assert.equal(data.guests.length, 1);
  assert.equal(data.guests[0].uploadCount, 1);
});

test('关闭上传通道后不能再上传', async () => {
  const event = await createEvent(app, admin, { title: '关闭上传' });
  const { token } = await guestLogin(app, 'uma', event.id);

  await app.inject({
    method: 'PATCH',
    url: `/api/admin/events/${event.id}`,
    headers: { authorization: `Bearer ${admin}` },
    payload: { uploadEnabled: false },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/uploads/init',
    headers: { authorization: `Bearer ${token}` },
    payload: { eventId: event.id, fileName: 'x.png', mime: 'image/png', bytes: 1000 },
  });
  assert.equal(res.statusCode, 409);
});

// ===========================================================================
// 删除
// ===========================================================================

test('宾客删除自己的素材后，列表里就没了', async () => {
  const event = await createEvent(app, admin, { title: '删除测试', eventDate: '2027-01-01' });
  const { token } = await guestLogin(app, 'vera', event.id);

  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer: pngBuffer(1000),
    chunkSize: CHUNK,
  });

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/media/${mediaId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 200);

  const list = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}/media`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(list.json().data.media.length, 0);

  // 计数也要回退，否则配额会越来越紧
  const ev = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(ev.json().data.me.uploadCount, 0);
});

// ===========================================================================
// 文件出口
// ===========================================================================

test('★ 签名 URL 能取到文件，且内容一致', async () => {
  const event = await createEvent(app, admin, { title: '文件出口', eventDate: '2027-02-01' });
  const { token } = await guestLogin(app, 'wendy', event.id);

  const buffer = pngBuffer(3000);
  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer,
    chunkSize: CHUNK,
  });

  const urlRes = await app.inject({
    method: 'GET',
    url: `/api/media/${mediaId}/url?variant=original`,
    headers: { authorization: `Bearer ${token}` },
  });
  const url = urlRes.json().data.url;
  const tokenPart = url.split('/f/')[1];

  const fileRes = await app.inject({ method: 'GET', url: `/f/${tokenPart}` });
  assert.equal(fileRes.statusCode, 200);
  assert.equal(fileRes.headers['content-type'], 'image/png');
  assert.equal(fileRes.headers['accept-ranges'], 'bytes');
  assert.ok(fileRes.rawPayload.equals(buffer), '取回的内容必须与上传的一致');
});

test('★ 篡改签名的文件令牌被拒', async () => {
  const event = await createEvent(app, admin, { title: '签名校验', eventDate: '2027-03-01' });
  const { token } = await guestLogin(app, 'xena', event.id);

  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer: pngBuffer(1000),
    chunkSize: CHUNK,
  });

  const urlRes = await app.inject({
    method: 'GET',
    url: `/api/media/${mediaId}/url?variant=original`,
    headers: { authorization: `Bearer ${token}` },
  });
  const tokenPart = urlRes.json().data.url.split('/f/')[1];

  // 改掉载荷里的一个字节
  const [payload] = tokenPart.split('.');
  const tampered = `${payload.slice(0, -1)}${payload.at(-1) === 'A' ? 'B' : 'A'}.${tokenPart.split('.')[1]}`;

  const res = await app.inject({ method: 'GET', url: `/f/${tampered}` });
  assert.equal(res.statusCode, 404);
});

test('★ 伪造的文件令牌被拒', async () => {
  for (const bad of [
    'garbage',
    'a.b',
    'eyJtIjoieCJ9.bad-signature',
    '../../etc/passwd',
  ]) {
    const res = await app.inject({ method: 'GET', url: `/f/${encodeURIComponent(bad)}` });
    assert.equal(res.statusCode, 404, `伪造令牌 ${bad} 应当被拒`);
  }
});

test('Range 请求返回 206 和正确的片段', async () => {
  const event = await createEvent(app, admin, { title: 'Range 测试', eventDate: '2027-04-01' });
  const { token } = await guestLogin(app, 'yuri', event.id);

  const buffer = pngBuffer(5000);
  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer,
    chunkSize: CHUNK,
  });

  const urlRes = await app.inject({
    method: 'GET',
    url: `/api/media/${mediaId}/url?variant=original`,
    headers: { authorization: `Bearer ${token}` },
  });
  const tokenPart = urlRes.json().data.url.split('/f/')[1];

  const res = await app.inject({
    method: 'GET',
    url: `/f/${tokenPart}`,
    headers: { range: 'bytes=0-9' },
  });

  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], `bytes 0-9/${buffer.length}`);
  assert.equal(res.rawPayload.length, 10);
  assert.ok(res.rawPayload.equals(buffer.subarray(0, 10)));
});

// ===========================================================================
// 举报
// ===========================================================================

test('举报自己的素材成功，重复举报幂等', async () => {
  const event = await createEvent(app, admin, { title: '举报测试', eventDate: '2027-05-01' });
  const { token } = await guestLogin(app, 'zoe', event.id);

  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer: pngBuffer(1000),
    chunkSize: CHUNK,
  });

  const first = await app.inject({
    method: 'POST',
    url: `/api/media/${mediaId}/report`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reason: '广告骚扰' },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().data.reported, true);

  const second = await app.inject({
    method: 'POST',
    url: `/api/media/${mediaId}/report`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reason: '广告骚扰' },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().data.alreadyReported, true);

  // 管理端能看到
  const list = await app.inject({
    method: 'GET',
    url: '/api/admin/reports',
    headers: { authorization: `Bearer ${admin}` },
  });
  assert.ok(list.json().data.openCount >= 1);
});

test('举报原因不合法会被拒', async () => {
  const event = await createEvent(app, admin, { title: '举报校验' });
  const { token } = await guestLogin(app, 'amy', event.id);

  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'a.png',
    mime: 'image/png',
    buffer: pngBuffer(1000),
    chunkSize: CHUNK,
  });

  const res = await app.inject({
    method: 'POST',
    url: `/api/media/${mediaId}/report`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reason: '随便写的理由' },
  });
  assert.equal(res.statusCode, 400);
});

// ===========================================================================
// 其他
// ===========================================================================

test('健康检查报告数据库状态', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.db, 'ok');
});

test('未知接口返回统一信封', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
});

test('单独上传一张图（非分片路径）也能成功', async () => {
  const event = await createEvent(app, admin, { title: '单片上传', eventDate: '2027-06-01' });
  const { token } = await guestLogin(app, 'ben', event.id);

  const buffer = pngBuffer(500); // 小于最小分片
  const { mediaId, parts } = await uploadFile(app, token, event.id, {
    fileName: 'small.png',
    mime: 'image/png',
    buffer,
    chunkSize: 1024 * 1024,
  });

  assert.equal(parts, 1);
  assert.ok(mediaId);
});
