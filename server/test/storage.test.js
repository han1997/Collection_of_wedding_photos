import './_setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import config from '../src/config.js';
import {
  buildEventSlug,
  buildFilename,
  eventDayDir,
  sanitizeName,
  toAbs,
  toRel,
  uniqueFilename,
  uploadTmpDir,
} from '../src/services/storage.js';
import { shanghaiDay, shanghaiHms } from '../src/lib/time.js';

// ---------------------------------------------------------------------------
// sanitizeName
// ---------------------------------------------------------------------------

test('sanitizeName 保留中文和字母数字', () => {
  assert.equal(sanitizeName('张伟李娜'), '张伟李娜');
  assert.equal(sanitizeName('Zhang Wei'), 'Zhang-Wei');
  assert.equal(sanitizeName('abc123'), 'abc123');
});

test('sanitizeName 去掉文件系统危险字符', () => {
  assert.equal(sanitizeName('a/b\\c:d*e?f'), 'a-b-c-d-e-f');
  assert.equal(sanitizeName('a\u0000b'), 'a-b');
  assert.equal(sanitizeName('  spaces  '), 'spaces');
});

test('sanitizeName 不允许开头连字符（会被当成命令行参数）', () => {
  assert.equal(sanitizeName('-rf'), 'rf');
  assert.equal(sanitizeName('--evil'), 'evil');
});

test('sanitizeName 把点号一律剔除（从根上杜绝 .. 构造）', () => {
  assert.equal(sanitizeName('name...'), 'name');
  assert.equal(sanitizeName('a..b'), 'a-b');
  assert.equal(sanitizeName('..'), '');
  assert.equal(sanitizeName('....'), '');
  assert.ok(!sanitizeName('a.b.c.d').includes('.'));
});

test('sanitizeName 按长度截断', () => {
  const out = sanitizeName('a'.repeat(100), { maxLen: 10 });
  assert.equal(out.length, 10);
});

test('sanitizeName 全空时用 fallback', () => {
  assert.equal(sanitizeName('///', { fallback: 'untitled' }), 'untitled');
});

// ---------------------------------------------------------------------------
// buildEventSlug
// ---------------------------------------------------------------------------

test('buildEventSlug 包含日期、新人和 eventId，且保留中文', () => {
  const slug = buildEventSlug({
    id: 'aB3dE5gH7j',
    title: '张伟 & 李娜 婚礼',
    couple_names: '张伟 李娜',
    event_date: '2026-05-20',
  });
  assert.match(slug, /^2026-05-20_张伟-李娜_aB3dE5gH7j$/);
});

test('buildEventSlug 没有日期也能用', () => {
  const slug = buildEventSlug({ id: 'abcdefghij', title: '某场婚礼' });
  assert.match(slug, /^某场婚礼_abcdefghij$/);
});

test('buildEventSlug 标题全非法字符时仍可生成', () => {
  const slug = buildEventSlug({ id: 'abcdefghij', title: '///' });
  assert.equal(slug, 'event_abcdefghij');
});

test('buildEventSlug 拒绝非法日期格式', () => {
  const slug = buildEventSlug({ id: 'abcdefghij', title: '婚礼', event_date: '2026/05/20' });
  assert.equal(slug, '婚礼_abcdefghij');
});

// ---------------------------------------------------------------------------
// toAbs / toRel —— 越界检查是安全关键
// ---------------------------------------------------------------------------

test('toAbs/toRel 往返一致', () => {
  const rel = 'events/demo/2026-05-20/originals/x.jpg';
  const abs = toAbs(rel);
  assert.equal(toRel(abs).replace(/\\/g, '/'), rel);
});

test('toAbs 拒绝路径穿越', () => {
  assert.throws(() => toAbs('../../etc/passwd'));
  assert.throws(() => toAbs('events/../../../etc/passwd'));
  // 这条会规整回 DATA_ROOT 本身——形状校验必须在包含性检查之前拦住它
  assert.throws(() => toAbs('../' + path.basename(config.dataRoot)));
});

test('toAbs 拒绝绝对路径', () => {
  // 光靠包含性检查拦不住：'/etc/passwd' 会被 resolve 成 DATA_ROOT/etc/passwd，
  // 看着安全，却和合法的 'etc/passwd' 撞成同一个文件
  assert.throws(() => toAbs('/etc/passwd'));
  assert.throws(() => toAbs('C:/Windows/System32'));
  assert.throws(() => toAbs('c:/windows'));
});

test('toAbs 拒绝反斜杠（入库路径必须是 POSIX 风格）', () => {
  assert.throws(() => toAbs('events\\2026-05-20\\x.jpg'));
});

test('toAbs 规整掉重复斜杠和 . 段', () => {
  assert.equal(toAbs('a//b'), toAbs('a/b'));
  assert.equal(toAbs('./a/b'), toAbs('a/b'));
});

test('toAbs 拒绝空路径和空字节', () => {
  assert.throws(() => toAbs(''));
  assert.throws(() => toAbs('a\u0000b'));
});

test('toAbs 允许 DATA_ROOT 本身', () => {
  assert.equal(toAbs('.'), config.dataRoot);
});

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

test('buildFilename 形如 HHmmss_guestShort_label_epochMs_rand4.ext', () => {
  const at = new Date('2026-05-20T10:30:45.123Z'); // 上海时间 18:30:45
  const name = buildFilename({ guestId: 42, label: '李阿姨', ext: 'jpg', at });
  assert.match(name, /^183045_000016_李阿姨_1779273045123_[a-z0-9]{4}\.jpg$/);
});

test('buildFilename 没有称呼时省略该段', () => {
  const at = new Date('2026-05-20T10:30:45.123Z');
  const name = buildFilename({ guestId: 1, label: null, ext: 'mp4', at });
  const parts = name.split('_');
  assert.equal(parts.length, 4, `期望 4 段，实际是 ${name}`);
  assert.equal(parts[0], '183045');
  assert.match(name, /\.mp4$/);
});

test('buildFilename 里非法的称呼字符被清洗掉', () => {
  const at = new Date('2026-05-20T10:30:45.123Z');
  const name = buildFilename({ guestId: 1, label: 'a/b..c', ext: 'jpg', at });
  assert.ok(!name.includes('/'));
  assert.ok(!name.includes('..'));
});

test('uniqueFilename 遇到同名时追加序号', async () => {
  const dir = path.join(config.dataRoot, 'tmp', 'nametest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jpg'), '');

  assert.equal(await uniqueFilename(dir, 'b.jpg'), 'b.jpg');
  assert.equal(await uniqueFilename(dir, 'a.jpg'), 'a_1.jpg');

  fs.writeFileSync(path.join(dir, 'a_1.jpg'), '');
  assert.equal(await uniqueFilename(dir, 'a.jpg'), 'a_2.jpg');
});

// ---------------------------------------------------------------------------
// 时区：按天分目录必须按上海时区算，不能依赖进程 TZ
// ---------------------------------------------------------------------------

test('shanghaiDay 按上海时区判定日期', () => {
  // UTC 16:30 == 上海次日 00:30
  assert.equal(shanghaiDay(new Date('2026-05-20T16:30:00Z')), '2026-05-21');
  // UTC 15:59 == 上海当日 23:59
  assert.equal(shanghaiDay(new Date('2026-05-20T15:59:00Z')), '2026-05-20');
  // UTC 16:00 整 == 上海次日 00:00
  assert.equal(shanghaiDay(new Date('2026-05-20T16:00:00Z')), '2026-05-21');
});

test('shanghaiHms 按上海时区取时刻', () => {
  assert.equal(shanghaiHms(new Date('2026-05-20T10:30:45Z')), '183045');
  assert.equal(shanghaiHms(new Date('2026-05-20T16:00:00Z')), '000000');
});

// ---------------------------------------------------------------------------
// 目录规划
// ---------------------------------------------------------------------------

test('eventDayDir 分出四个分类目录', () => {
  const slug = '2026-05-20_张伟-李娜_abc';
  assert.ok(eventDayDir(slug, '2026-05-20', 'originals').endsWith(path.join(slug, '2026-05-20', 'originals')));
  assert.ok(eventDayDir(slug, '2026-05-20', 'thumbs').endsWith(path.join('2026-05-20', 'thumbs')));
});

test('uploadTmpDir 与 events 同盘（同盘才能做原子 rename）', () => {
  const tmp = uploadTmpDir('session123');
  const events = config.paths.events;
  // 两者的公共祖先必须是 DATA_ROOT，说明没被拆到别的挂载点
  assert.ok(tmp.startsWith(config.dataRoot));
  assert.ok(events.startsWith(config.dataRoot));
  assert.equal(path.parse(tmp).root, path.parse(events).root);
});

test('uploadTmpDir 拒绝非法会话 ID', () => {
  assert.throws(() => uploadTmpDir('../../evil'));
});
