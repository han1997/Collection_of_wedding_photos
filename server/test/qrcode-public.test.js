import './_setup.js';

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import {
  bootstrapAdmin,
  createEvent,
  getApp,
  installFakeWechat,
  restoreFetch,
  stopApp,
} from './_app.js';

let app;
let admin;

before(async () => {
  installFakeWechat();
  app = await getApp();
  admin = (await bootstrapAdmin(app)).token;
});

after(async () => {
  restoreFetch();
  await stopApp();
});

// ===========================================================================
// 二维码
// ===========================================================================

test('★ 微信不可用时退回本地二维码，而不是报错', async () => {
  const event = await createEvent(app, admin, { title: '二维码兜底', eventDate: '2026-06-20' });

  // 测试环境没有真实微信凭据/接口，生成必然走兜底路径
  const res = await app.inject({
    method: 'POST',
    url: `/api/admin/events/${event.id}/qr/regenerate`,
    headers: { authorization: `Bearer ${admin}` },
    payload: { envVersion: 'trial' },
  });

  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.mode, 'fallback', '应当退回本地二维码');
  assert.ok(data.fallbackUrl, '兜底时应给出 H5 地址');
  assert.match(data.fallbackUrl, new RegExp(`/e/${event.id}$`));
  assert.equal(data.event.qrMode, 'fallback');
});

test('生成的二维码是一张合法的 PNG', async () => {
  const event = await createEvent(app, admin, { title: '二维码文件', eventDate: '2026-06-21' });

  const res = await app.inject({ method: 'GET', url: `/api/events/${event.id}/qr.png` });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');

  const png = res.rawPayload;
  assert.ok(png.length > 200, `二维码不该这么小：${png.length} 字节`);
  // PNG 魔数
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('envVersion 不合法时被拒', async () => {
  const event = await createEvent(app, admin, { title: '环境校验' });

  const res = await app.inject({
    method: 'POST',
    url: `/api/admin/events/${event.id}/qr/regenerate`,
    headers: { authorization: `Bearer ${admin}` },
    payload: { envVersion: 'nonsense' },
  });

  assert.equal(res.statusCode, 400);
});

test('不存在的活动取二维码返回 404', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/events/nope123/qr.png' });
  assert.equal(res.statusCode, 404);
});

test('qr-info 给出活动码，供印在二维码旁边做双保险', async () => {
  const event = await createEvent(app, admin, { title: '活动码', eventDate: '2026-06-22' });

  const res = await app.inject({ method: 'GET', url: `/api/events/${event.id}/qr-info` });

  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.code, event.id);
  assert.match(data.code, /^[A-Za-z0-9]{10}$/);
  assert.equal(data.title, '活动码');
});

test('二维码不需要登录也能取（它本来就要印在现场）', async () => {
  const event = await createEvent(app, admin, { title: '公开二维码' });
  const res = await app.inject({ method: 'GET', url: `/api/events/${event.id}/qr.png` });
  assert.equal(res.statusCode, 200);
});

// ===========================================================================
// H5 落地页
// ===========================================================================

test('★ H5 落地页能打开并显示活动信息', async () => {
  const event = await createEvent(app, admin, {
    title: '刘晓明 & 陈静 婚礼',
    coupleNames: '刘晓明 陈静',
    venue: '金鼎大酒店',
    eventDate: '2026-07-07',
  });

  const res = await app.inject({ method: 'GET', url: `/e/${event.id}` });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.ok(res.body.includes('刘晓明'), '应当显示活动标题');
  assert.ok(res.body.includes('金鼎大酒店'), '应当显示场地');
  assert.ok(res.body.includes(event.id), '应当显示活动码');
});

test('★ 不存在的活动，H5 页返回 404', async () => {
  const res = await app.inject({ method: 'GET', url: '/e/doesnotexist' });
  assert.equal(res.statusCode, 404);
  assert.ok(res.body.includes('活动不存在'));
});

test('★ 活动标题里的 HTML 被转义（防 XSS）', async () => {
  const event = await createEvent(app, admin, {
    title: '<script>alert(1)</script>',
  });

  const res = await app.inject({ method: 'GET', url: `/e/${event.id}` });

  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('<script>alert(1)</script>'), '原文不该出现在页面里');
  assert.ok(res.body.includes('&lt;script&gt;'), '应当被转义');
});

test('H5 页带 CSP 和 no-referrer', async () => {
  const event = await createEvent(app, admin, { title: 'CSP 检查' });
  const res = await app.inject({ method: 'GET', url: `/e/${event.id}` });

  assert.ok(res.headers['content-security-policy'], '应当有 CSP');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

// ===========================================================================
// 隐私政策
// ===========================================================================

test('隐私政策页可公开访问，且说明了收集与不收集的内容', async () => {
  const res = await app.inject({ method: 'GET', url: '/privacy' });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.ok(res.body.includes('隐私政策'));
  assert.ok(res.body.includes('不获取你的位置信息'));
  assert.ok(res.body.includes('不获取你的手机号'));
});

test('robots.txt 禁止收录相册页和文件出口', async () => {
  const res = await app.inject({ method: 'GET', url: '/robots.txt' });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('Disallow: /e/'));
  assert.ok(res.body.includes('Disallow: /f/'));
});
