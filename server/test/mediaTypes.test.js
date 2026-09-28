import './_setup.js';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_EXTENSIONS,
  looksNeedsTranscode,
  normalizeDeclared,
  sniff,
  verifyAgainstDeclared,
} from '../src/lib/mediaTypes.js';

// ---------------------------------------------------------------------------
// 构造文件头
// ---------------------------------------------------------------------------

function isoBmff(brand) {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(brand, 8, 'latin1');
  b.write('mp42', 12, 'latin1');
  return b;
}

const HEADERS = {
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28)]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]),
  gif: Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(26)]),
  webp: Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(20)]),
  bmp: Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(30)]),
  webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28)]),
  mp4_mp42: isoBmff('mp42'),
  mp4_isom: isoBmff('isom'),
  mov_qt: isoBmff('qt  '),
  mov_mp42: isoBmff('mp42'),
  heic: isoBmff('heic'),
  heif: isoBmff('mif1'),
  tgp3: isoBmff('3gp4'),
  html: Buffer.from('<html><body>not an image at all</body></html>'),
  exe: Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'),
};

// ---------------------------------------------------------------------------
// normalizeDeclared
// ---------------------------------------------------------------------------

test('normalizeDeclared 接受白名单内的扩展名', () => {
  assert.deepEqual(normalizeDeclared('a.jpg'), { ext: 'jpg', mime: 'image/jpeg', kind: 'image' });
  assert.deepEqual(normalizeDeclared('a.png'), { ext: 'png', mime: 'image/png', kind: 'image' });
  assert.deepEqual(normalizeDeclared('a.mp4'), { ext: 'mp4', mime: 'video/mp4', kind: 'video' });
  assert.deepEqual(normalizeDeclared('a.mov'), { ext: 'mov', mime: 'video/quicktime', kind: 'video' });
  assert.deepEqual(normalizeDeclared('a.heic'), { ext: 'heic', mime: 'image/heic', kind: 'image' });
});

test('normalizeDeclared 大小写不敏感', () => {
  assert.equal(normalizeDeclared('A.JPG').ext, 'jpg');
  assert.equal(normalizeDeclared('A.MP4').kind, 'video');
});

test('normalizeDeclared 拒绝白名单外的扩展名', () => {
  for (const name of ['evil.exe', 'a.php', 'a.js', 'a.html', 'a.svg', 'a.txt', 'noext']) {
    assert.equal(normalizeDeclared(name), null, `${name} 不该被接受`);
  }
});

test('normalizeDeclared 在 MIME 与扩展名不符时拒绝', () => {
  // 声称 png 却给了 mp4 的 mime
  assert.equal(normalizeDeclared('a.png', 'video/mp4'), null);
  // 声称 mp4 却给了图片的 mime
  assert.equal(normalizeDeclared('a.mp4', 'image/jpeg'), null);
});

test('normalizeDeclared 兼容 image/jpg 这类历史写法', () => {
  assert.ok(normalizeDeclared('a.jpg', 'image/jpg'));
  assert.ok(normalizeDeclared('a.jpeg', 'image/jpeg'));
});

test('normalizeDeclared 没给 MIME 时按扩展名判定', () => {
  assert.deepEqual(normalizeDeclared('a.png', ''), { ext: 'png', mime: 'image/png', kind: 'image' });
  assert.deepEqual(normalizeDeclared('a.png', undefined).kind, 'image');
});

// ---------------------------------------------------------------------------
// sniff
// ---------------------------------------------------------------------------

test('sniff 能认出各种图片格式', () => {
  assert.equal(sniff(HEADERS.jpg).ext, 'jpg');
  assert.equal(sniff(HEADERS.png).ext, 'png');
  assert.equal(sniff(HEADERS.gif).ext, 'gif');
  assert.equal(sniff(HEADERS.webp).ext, 'webp');
  assert.equal(sniff(HEADERS.bmp).ext, 'bmp');
  assert.equal(sniff(HEADERS.heic).kind, 'image');
  assert.equal(sniff(HEADERS.heif).kind, 'image');
});

test('sniff 能认出视频容器', () => {
  assert.equal(sniff(HEADERS.mp4_mp42).kind, 'video');
  assert.equal(sniff(HEADERS.mp4_isom).kind, 'video');
  assert.equal(sniff(HEADERS.mov_qt).kind, 'video');
  assert.equal(sniff(HEADERS.webm).ext, 'webm');
  assert.equal(sniff(HEADERS.tgp3).ext, '3gp');
});

test('sniff 对非媒体内容返回 null', () => {
  assert.equal(sniff(HEADERS.html), null);
  assert.equal(sniff(HEADERS.exe), null);
  assert.equal(sniff(Buffer.alloc(32)), null);
});

test('sniff 对过短的输入返回 null 而不是崩掉', () => {
  assert.equal(sniff(Buffer.from([0xff, 0xd8])), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
  assert.equal(sniff(null), null);
  assert.equal(sniff('not a buffer'), null);
});

// ---------------------------------------------------------------------------
// ★ verifyAgainstDeclared —— 上传安全的关键判据
// ---------------------------------------------------------------------------

test('★ 声明与内容一致时通过', () => {
  const cases = [
    ['jpg', HEADERS.jpg],
    ['jpeg', HEADERS.jpg],
    ['png', HEADERS.png],
    ['gif', HEADERS.gif],
    ['webp', HEADERS.webp],
    ['bmp', HEADERS.bmp],
    ['heic', HEADERS.heic],
    ['mp4', HEADERS.mp4_mp42],
    ['webm', HEADERS.webm],
    ['3gp', HEADERS.tgp3],
  ];

  for (const [ext, head] of cases) {
    const kind = ['mp4', 'webm', '3gp'].includes(ext) ? 'video' : 'image';
    const v = verifyAgainstDeclared(head, { ext, kind });
    assert.equal(v.ok, true, `.${ext} 应当通过，实际：${v.reason}`);
  }
});

test('★ iPhone 的 .mov 必须能通过（brand 常是 mp42 而不是 qt）', () => {
  // 这条曾经是 bug：sniff 对 ISO-BMFF 一律返回 mp4，
  // 而 mov 不在等价集合里，导致 iPhone 拍的 .mov 全被拒。
  for (const head of [HEADERS.mov_qt, HEADERS.mov_mp42]) {
    const v = verifyAgainstDeclared(head, { ext: 'mov', kind: 'video' });
    assert.equal(v.ok, true, `mov 应当通过，实际：${v.reason}`);
  }
});

test('★ 内容是 HTML 却声称是图片 → 拒绝（多态文件防御）', () => {
  const v = verifyAgainstDeclared(HEADERS.html, { ext: 'jpg', kind: 'image' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /无法识别/);
});

test('★ 可执行文件声称是图片 → 拒绝', () => {
  const v = verifyAgainstDeclared(HEADERS.exe, { ext: 'png', kind: 'image' });
  assert.equal(v.ok, false);
});

test('★ 跨类别错配 → 拒绝（声称图片实际视频，反之亦然）', () => {
  const asImage = verifyAgainstDeclared(HEADERS.mp4_mp42, { ext: 'mp4', kind: 'image' });
  assert.equal(asImage.ok, false);
  assert.match(asImage.reason, /不符/);

  const asVideo = verifyAgainstDeclared(HEADERS.jpg, { ext: 'jpg', kind: 'video' });
  assert.equal(asVideo.ok, false);
});

test('★ 容器同名但确实不同格式 → 拒绝', () => {
  // 声称是 webp（RIFF 容器），实际是 PNG —— 同为图片，但格式不对
  const v = verifyAgainstDeclared(HEADERS.png, { ext: 'webp', kind: 'image' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /扩展名/);
});

// ---------------------------------------------------------------------------
// 其他
// ---------------------------------------------------------------------------

test('ALLOWED_EXTENSIONS 覆盖常见格式且不含危险类型', () => {
  for (const ext of ['jpg', 'png', 'heic', 'mp4', 'mov']) {
    assert.ok(ALLOWED_EXTENSIONS.includes(ext), `${ext} 应当被允许`);
  }
  for (const ext of ['exe', 'php', 'js', 'html', 'svg', 'sh']) {
    assert.ok(!ALLOWED_EXTENSIONS.includes(ext), `${ext} 绝不能出现在白名单里`);
  }
});

test('looksNeedsTranscode 只对 .mov 返回 true', () => {
  assert.equal(looksNeedsTranscode('mov'), true);
  assert.equal(looksNeedsTranscode('mp4'), false);
  assert.equal(looksNeedsTranscode('jpg'), false);
});
