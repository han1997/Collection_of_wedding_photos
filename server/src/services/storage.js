/**
 * 存储：DATA_ROOT 下的路径规划、文件名生成、越界检查。
 *
 * 这个文件的职责边界很重要——**所有从 DB 里的相对路径还原成绝对路径的动作
 * 都必须走这里**，因为它是唯一做了「越界检查」的地方。
 *
 * 两条不能破的规矩：
 *   1. DB 里的路径一律 POSIX（'/'）。开发机是 Windows、生产是 Linux，
 *      一旦有反斜杠进库，换台机器就全崩。
 *   2. resolve 之后必须确认仍在 DATA_ROOT 之内（见 toAbs）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { newFileSuffix, shortId } from '../lib/ids.js';
import { shanghaiDay, shanghaiHms } from '../lib/time.js';

const DATA_ROOT = config.dataRoot;

/** 建立 DATA_ROOT 下所有固定目录（启动时调一次） */
export function ensureDataDirs() {
  const dirs = [
    config.paths.db,
    config.paths.dbBackups,
    config.paths.events,
    config.paths.tmp,
    config.paths.tmpUploads,
    config.paths.tmpGc,
    config.paths.qrCache,
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
// 相对路径 <-> 绝对路径
// ---------------------------------------------------------------------------

/**
 * 绝对路径 → 相对 DATA_ROOT 的 POSIX 路径。
 * @param {string} abs
 */
export function toRel(abs) {
  const rel = path.relative(DATA_ROOT, abs);
  return rel.split(path.sep).join('/');
}

/**
 * 相对路径 → 绝对路径，**并做越界检查**。
 *
 * 这是整个服务里唯一允许把外部字符串拼成文件路径的地方。
 *
 * 两道防线：
 *   ① 形状校验——入库路径必须是**纯 POSIX 相对路径**。
 *      不收 '..' 段、不收开头的 '/'、不收反斜杠、不收盘符。
 *      光靠 ② 是不够的：'/etc/passwd' 会被 resolve 成 DATA_ROOT/etc/passwd
 *      （看着安全，但它和合法的 'etc/passwd' 撞成同一个文件，属于隐性混淆）；
 *      而 '../<DATA_ROOT 的目录名>' 会规整回 DATA_ROOT 本身，绕过 ② 的检查。
 *   ② 包含性检查——resolve 之后必须仍在 DATA_ROOT 之内，作为最后兜底。
 *
 * @param {string} rel
 */
export function toAbs(rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('toAbs 收到空的相对路径');
  }
  if (rel.includes('\0')) {
    throw new Error('相对路径含空字节');
  }
  if (rel.includes('\\')) {
    throw new Error(`相对路径不能含反斜杠（必须用 POSIX 风格）：${rel}`);
  }
  if (rel.startsWith('/')) {
    throw new Error(`相对路径不能以 / 开头：${rel}`);
  }
  if (/^[A-Za-z]:/.test(rel)) {
    throw new Error(`相对路径不能含盘符：${rel}`);
  }

  const segments = rel.split('/');
  if (segments.some((s) => s === '..')) {
    throw new Error(`相对路径不能含 '..' 段：${rel}`);
  }
  // 规整掉 '' 和 '.'，避免 'a//b' 这类怪异写法
  const normalized = segments.filter((s) => s !== '' && s !== '.').join('/');
  if (!normalized) return DATA_ROOT;

  const abs = path.resolve(DATA_ROOT, ...normalized.split('/'));
  const rootWithSep = DATA_ROOT.endsWith(path.sep) ? DATA_ROOT : DATA_ROOT + path.sep;

  if (abs !== DATA_ROOT && !abs.startsWith(rootWithSep)) {
    throw new Error(`路径越界，已拒绝：${rel}`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// 活动目录与 slug
// ---------------------------------------------------------------------------

/**
 * 生成活动目录名（slug）。
 *
 * **故意保留中文**——用户在 NAS 文件管理器里要一眼认出是哪场婚礼，
 * 「张伟-李娜」比拼音直观得多。Linux 和 Windows 的文件名都支持中文。
 * 只去掉文件系统里会惹麻烦的字符。
 *
 * 结尾拼 eventId 前 6 位保证唯一（两对同名新人也可能）。
 *
 * @param {{id: string, title?: string, couple_names?: string|null, event_date?: string|null}} event
 */
export function buildEventSlug(event) {
  const parts = [];

  const date = (event.event_date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) parts.push(date);

  const base = (event.couple_names || event.title || '').trim();
  const cleaned = sanitizeName(base, { maxLen: 30 });
  if (cleaned) parts.push(cleaned);

  const head = parts.join('_') || 'event';
  return `${head}_${sanitizeName(event.id, { maxLen: 10 })}`;
}

/**
 * 清洗一段名字，用于目录名或文件名。
 *
 * 保留：中文、字母、数字、下划线、连字符。其余（空格、标点、控制字符）都换成 '-'。
 * **点号一律剔除**——这样 '..' 从根上就不可能构造出来，比事后过滤更省心；
 * 文件名里的扩展名是在外面单独拼的，段内不需要点。
 *
 * 另外专门处理两个跨平台的坑：结尾的点和空格（Windows 不允许）、
 * 开头的连字符（会被误认成命令行参数）。
 *
 * ⚠️ 这是**有损**映射：'a/b' 和 'a-b' 都会变成 'a-b'。
 * 所以它只适用于给人看的显示名，**不能**用来派生会话 ID 这类需要唯一性的东西
 * （见 uploadTmpDir 为什么改用严格白名单）。
 *
 * @param {string} s
 * @param {{maxLen?: number, fallback?: string}} [opts]
 */
export function sanitizeName(s, opts = {}) {
  const maxLen = opts.maxLen ?? 40;

  // 控制字符 + 文件系统保留字符 + 空白 → '-'
  let out = String(s ?? '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*.\s]+/g, '-');
  // 只保留中文、字母、数字、下划线、连字符
  out = out.replace(/[^\p{Script=Han}A-Za-z0-9_-]/gu, '');
  // 折叠连字符、去掉首尾连字符
  out = out.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  if (out.length > maxLen) out = out.slice(0, maxLen).replace(/-+$/, '');

  return out || opts.fallback || '';
}

/**
 * 活动根目录（绝对路径）。
 * @param {string} slug
 */
export function eventDir(slug) {
  return path.join(config.paths.events, slug);
}

/**
 * 活动下某一天的分类子目录。
 * @param {string} slug
 * @param {string} day 'YYYY-MM-DD'（上海时区）
 * @param {'originals'|'previews'|'thumbs'|'posters'} bucket
 */
export function eventDayDir(slug, day, bucket) {
  return path.join(eventDir(slug), day, bucket);
}

/** 相对 DATA_ROOT 的版本（用于入库） */
export function eventDayRel(slug, day, bucket) {
  return toRel(eventDayDir(slug, day, bucket)).split(path.sep).join('/');
}

/** 建好活动某一天的四个分类目录 */
export async function ensureEventDayDirs(slug, day) {
  for (const bucket of ['originals', 'previews', 'thumbs', 'posters']) {
    await fsp.mkdir(eventDayDir(slug, day, bucket), { recursive: true });
  }
}

/**
 * 由原图的相对路径推出各衍生物的相对路径。
 *
 * 衍生物和原图放在同一天的同一个活动下，只是分了 originals/thumbs/... 几个桶：
 *   events/<slug>/<day>/originals/IMG_x.png
 *   events/<slug>/<day>/thumbs/IMG_x.jpg
 *
 * 这样主持人在文件管理器里翻当天的目录时，原图和缩略图是挨着的，
 * 「按天归档」的结构不会被衍生物打散。
 *
 * 纯字符串运算，不碰文件系统，所以可以放心当纯函数用。
 *
 * @param {string} originalRel 形如 events/<slug>/<day>/originals/<name>.<ext>
 */
export function derivativePaths(originalRel) {
  const slash = originalRel.lastIndexOf('/');
  if (slash < 0) throw new Error(`相对路径格式不对：${originalRel}`);

  const originalsDir = originalRel.slice(0, slash);
  const base = originalRel.slice(slash + 1);
  const stem = base.replace(/\.[^.]+$/, '');

  const daySlash = originalsDir.lastIndexOf('/');
  const dayDir = daySlash < 0 ? originalsDir : originalsDir.slice(0, daySlash);

  return {
    originals: originalsDir,
    thumbs: `${dayDir}/thumbs/${stem}.jpg`,
    previews: `${dayDir}/previews/${stem}.jpg`,
    posters: `${dayDir}/posters/${stem}.jpg`,
  };
}

/** 建好活动根目录及常见子目录 */
export async function ensureEventDirs(slug) {
  await fsp.mkdir(eventDir(slug), { recursive: true });
  await fsp.mkdir(path.join(eventDir(slug), 'blocked'), { recursive: true });
}

/**
 * 在活动根目录写一份 .event.json。
 * 让用户在文件管理器里点开就能知道这目录是哪场婚礼——
 * 数据库不在手边时这是唯一线索。
 * @param {any} event
 */
export async function writeEventManifest(event) {
  const p = path.join(eventDir(event.slug), '.event.json');
  const body = {
    活动ID: event.id,
    标题: event.title,
    新人: event.couple_names ?? null,
    日期: event.event_date ?? null,
    地点: event.venue ?? null,
    创建时间: event.created_at,
    说明: '这是本场婚礼的索引信息，供文件管理器查看。请勿手工修改或移动文件——服务端按数据库记录定位文件。',
  };
  await fsp.writeFile(p, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return toRel(p);
}

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

/**
 * 生成原文件名：`HHmmss_<guestShort>_<guestLabel>_<epochMs>_<rand4>.<ext>`
 *
 * 各段的用意：
 *   HHmmss     —— 上海时区的上传时刻，让文件管理器按名字排序就是时间顺序，
 *                 正好是主持人「翻当天的照片」的心智模型
 *   guestShort —— guest id 的 6 位 base36，不看数据库也知道是谁传的
 *   guestLabel —— 可选的「怎么称呼您」，纯为了可读性
 *   epochMs    —— 防同秒碰撞且保序
 *   rand4      —— 极端情况下的兜底随机
 *
 * @param {{guestId: number, label?: string|null, ext: string, at?: Date}} opts
 */
export function buildFilename({ guestId, label, ext, at = new Date() }) {
  const segs = [shanghaiHms(at), shortId(guestId)];

  const safeLabel = sanitizeName(label ?? '', { maxLen: 12 });
  if (safeLabel) segs.push(safeLabel);

  segs.push(String(at.getTime()));
  segs.push(newFileSuffix());

  return `${segs.join('_')}.${ext}`;
}

/**
 * 同一目录下若已存在同名文件，追加 _1 / _2 …
 * 正常情况不会发生（文件名里有毫秒+随机），但重复上传同一文件时可能撞上。
 * @param {string} dir
 * @param {string} filename
 */
export async function uniqueFilename(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);

  let candidate = filename;
  for (let i = 1; i < 50; i += 1) {
    try {
      await fsp.access(path.join(dir, candidate));
      // 存在 → 换一个
      candidate = `${stem}_${i}${ext}`;
    } catch {
      return candidate;
    }
  }
  // 实在撞不完就带上时间戳兜底
  return `${stem}_${Date.now()}${ext}`;
}

// ---------------------------------------------------------------------------
// 上传临时区
// ---------------------------------------------------------------------------

/**
 * 分片临时目录。
 *
 * ⚠️ 它在 DATA_ROOT 下，因此和 events/ **必然同盘**——
 * 合并完成后靠 fs.rename 落盘，同盘 rename 是原子的。
 * 若把 tmp 挪到别的挂载点（比如 Docker named volume），
 * 每次合并都会退化成整文件跨设备拷贝，3GB 的文件会很痛。
 *
 * 会话 ID 一律是服务端生成的 nanoid，所以这里用**严格白名单**而不是清洗：
 * 清洗是有损映射（'a/b' 和 'a-b' 会撞成同一个目录），
 * 两个会话共用一个临时目录会导致分片串台。
 * @param {string} sessionId
 */
export function uploadTmpDir(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(sessionId)) {
    throw new Error(`非法的上传会话 ID：${JSON.stringify(sessionId)}`);
  }
  return path.join(config.paths.tmpUploads, sessionId);
}

/** 某个分片的绝对路径 */
export function partPath(sessionId, partNo) {
  return path.join(uploadTmpDir(sessionId), `${partNo}.part`);
}

/** 合并过程中的半成品路径（写完再 rename，避免半截文件被当成成品） */
export function assemblingPath(sessionId, ext) {
  return path.join(uploadTmpDir(sessionId), `assembled.${ext}.partial`);
}

// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

/** 软删除文件的停放目录（24 小时内可恢复） */
export function gcDir() {
  return config.paths.tmpGc;
}

/**
 * 把文件移进回收站，返回新路径。
 * 跨盘时回退为拷贝+删除（tmp 和 events 同盘，正常走不到）。
 * @param {string} absPath
 */
export async function moveToGc(absPath) {
  const dir = gcDir();
  await fsp.mkdir(dir, { recursive: true });
  const name = `${Date.now()}_${path.basename(absPath)}`;
  const dest = path.join(dir, name);
  try {
    await fsp.rename(absPath, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(absPath, dest);
      await fsp.unlink(absPath);
    } else {
      throw err;
    }
  }
  return dest;
}

// ---------------------------------------------------------------------------
// 磁盘用量
// ---------------------------------------------------------------------------

/**
 * 目录占用字节数。用于 admin/stats，不追求精确，只求不阻塞事件循环。
 * @param {string} dir
 */
export async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSize(p);
    } else if (e.isFile()) {
      try {
        total += (await fsp.stat(p)).size;
      } catch {
        // 文件刚好被删了，忽略
      }
    }
  }
  return total;
}

/** DATA_ROOT 所在文件系统的剩余字节数 */
export async function freeBytes() {
  try {
    const st = await fsp.statfs(DATA_ROOT);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}
