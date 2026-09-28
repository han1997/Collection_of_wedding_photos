import './_setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';

import sharp from 'sharp';

import config from '../src/config.js';
import { derivativePaths, toAbs } from '../src/services/storage.js';
import { drain } from '../src/jobs/queue.js';
import { checkTooling, probe } from '../src/services/videoProbe.js';
import {
  bootstrapAdmin,
  createEvent,
  getApp,
  guestLogin,
  installFakeWechat,
  restoreFetch,
  stopApp,
  uploadFile,
} from './_app.js';
import * as mediaRepo from '../src/repositories/media.repo.js';

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

/** 造一张真实尺寸的 PNG */
async function makePng(width, height, color = '#3366ff') {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

// ===========================================================================
// 纯函数：衍生物路径推导
// ===========================================================================

test('derivativePaths 从原图路径推出同日的各衍生物路径', () => {
  const rel = 'events/2026-05-20_张伟-李娜_abc/2026-05-20/originals/183045_000016_李阿姨_1779273045123_a1b2.png';
  const p = derivativePaths(rel);

  assert.equal(
    p.originals,
    'events/2026-05-20_张伟-李娜_abc/2026-05-20/originals',
  );
  assert.equal(
    p.thumbs,
    'events/2026-05-20_张伟-李娜_abc/2026-05-20/thumbs/183045_000016_李阿姨_1779273045123_a1b2.jpg',
  );
  assert.ok(p.previews.endsWith('.jpg'));
  assert.ok(p.posters.endsWith('.jpg'));
  // 衍生物必须和原图在同一天、同一个活动下
  assert.ok(p.thumbs.startsWith('events/2026-05-20_张伟-李娜_abc/2026-05-20/'));
});

test('derivativePaths 对畸形路径会抛错而不是给出错误结果', () => {
  assert.throws(() => derivativePaths('noslash.png'));
});

// ===========================================================================
// 图片处理
// ===========================================================================

test('★ 上传一张真实图片后，缩略图和预览图被生成且尺寸正确', async () => {
  const event = await createEvent(app, admin, { title: '图片处理', eventDate: '2026-07-10' });
  const { token } = await guestLogin(app, 'anne', event.id);

  const buffer = await makePng(1200, 800);
  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'photo.png',
    mime: 'image/png',
    buffer,
    chunkSize: 1024 * 1024,
  });

  // 等后台处理完成
  await drain();

  const media = mediaRepo.findById(mediaId);
  assert.equal(media.status, 'ready', `处理应当成功完成：${media.failReason ?? ''}`);

  // 原始尺寸被探测到
  assert.equal(media.width, 1200);
  assert.equal(media.height, 800);

  // 缩略图和预览图都在磁盘上
  const paths = derivativePaths(media.paths.original);
  const thumbAbs = toAbs(paths.thumbs);
  const previewAbs = toAbs(paths.previews);

  assert.ok(fs.existsSync(thumbAbs), '缩略图应当存在');
  assert.ok(fs.existsSync(previewAbs), '预览图应当存在');

  // 长边被限制到 480
  const thumbMeta = await sharp(thumbAbs).metadata();
  assert.equal(thumbMeta.format, 'jpeg');
  assert.equal(thumbMeta.width, 480);
  assert.equal(thumbMeta.height, 320);

  // 1200 宽小于预览上限 1600，所以预览保持原尺寸不变（withoutEnlargement）
  const previewMeta = await sharp(previewAbs).metadata();
  assert.equal(previewMeta.width, 1200);

  // 原图必须原样保留
  const originalAbs = toAbs(media.paths.original);
  assert.ok(fs.readFileSync(originalAbs).equals(buffer), '原图必须逐字节原样保存');
});

test('★ 原图带 EXIF 方向时，缩略图会被转正', async () => {
  const event = await createEvent(app, admin, { title: 'EXIF 方向', eventDate: '2026-07-11' });
  const { token } = await guestLogin(app, 'ben2', event.id);

  // orientation=6 表示「需要顺时针转 90 度才正」
  const buffer = await sharp({
    create: { width: 800, height: 400, channels: 3, background: '#ff9900' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'rotated.jpg',
    mime: 'image/jpeg',
    buffer,
    chunkSize: 1024 * 1024,
  });

  await drain();

  const media = mediaRepo.findById(mediaId);
  const paths = derivativePaths(media.paths.original);
  const thumbMeta = await sharp(toAbs(paths.thumbs)).metadata();

  // 800x400 转正后应当变成竖的 400 宽、480 高的长边受限图
  assert.ok(
    thumbMeta.height > thumbMeta.width,
    `转正后应当是竖图，实际 ${thumbMeta.width}x${thumbMeta.height}`,
  );

  // 衍生物里不该残留 EXIF（顺手剥掉了 GPS）
  assert.ok(!thumbMeta.exif || thumbMeta.exif.length === 0, '缩略图不应带 EXIF');
});

test('★ 处理失败不会让素材消失（fail-open）', async () => {
  const event = await createEvent(app, admin, { title: '处理降级', eventDate: '2026-07-12' });
  const { token } = await guestLogin(app, 'cara', event.id);

  // 伪造一个 magic bytes 合法、但 sharp 解不开的「PNG」：
  // 开头是 PNG 签名，后面是垃圾。上传能过（嗅探只看头 32 字节），
  // 但缩略图一定生成失败。
  const bogus = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(2000, 0x37),
  ]);

  const { mediaId } = await uploadFile(app, token, event.id, {
    fileName: 'broken.png',
    mime: 'image/png',
    buffer: bogus,
    chunkSize: 1024 * 1024,
  });

  await drain();

  const media = mediaRepo.findById(mediaId);

  // ★ 关键：素材仍然可用，原图仍在，宾客仍然能看到
  assert.equal(media.status, 'ready', '处理失败不应把素材标成不可用');
  assert.ok(media.failReason, '失败原因应当被记录下来');

  const originalAbs = toAbs(media.paths.original);
  assert.ok(fs.existsSync(originalAbs), '★ 原图必须完好无损');

  // 而且宾客的列表里仍然看得到它
  const list = await app.inject({
    method: 'GET',
    url: `/api/events/${event.id}/media`,
    headers: { authorization: `Bearer ${token}` },
  });
  const item = list.json().data.media.find((m) => m.id === mediaId);
  assert.ok(item, '宾客应当仍然看得到自己传的这张图');
  assert.ok(item.thumbUrl, '没有缩略图时应当退回原图地址，而不是给一个失效链接');
});

// ===========================================================================
// 工具可用性
// ===========================================================================

test('ffmpeg/ffprobe 探测不抛异常（本机可能没装）', async () => {
  const t = await checkTooling();
  assert.equal(typeof t.ffmpeg, 'boolean');
  assert.equal(typeof t.ffprobe, 'boolean');
});

test('probe 对非视频文件返回 null 而不是抛错', async () => {
  const t = await checkTooling();
  if (!t.ffprobe) {
    // 本机没有 ffprobe 时这条测不了，直接跳过
    return;
  }

  const tmp = path.join(config.paths.tmp, 'not-a-video.txt');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, 'this is definitely not a video');

  const meta = await probe(tmp);
  assert.equal(meta, null);
});

test('处理队列能排空，统计可读', async () => {
  await drain();
  const { stats } = await import('../src/jobs/queue.js');
  const s = stats();
  assert.equal(s.running, 0);
  assert.equal(s.queued, 0);
  assert.ok(s.completed > 0, '前面应当已经处理过若干条');
});
