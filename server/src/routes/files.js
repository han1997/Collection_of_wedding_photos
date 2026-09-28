/**
 * ★ 全服务唯一一个文件出口。
 *
 * 为什么只有这一个出口：**任何存储目录都不作为静态内容对外提供**
 * （所以刻意不装 @fastify/static，也不做目录列表）。
 * 文件只能凭签名令牌取，而令牌绑定了具体素材 + 变体 + 持有者 + 过期时间。
 *
 * 必须支持 Range：`<video>` 拖进度条、断点下载、以及 iPhone 上的
 * 视频预加载都依赖 206 Partial Content。没有 Range 的话大视频基本没法看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppError, ErrorCode, notFound } from '../lib/errors.js';
import { verifyFileToken } from '../lib/signedUrl.js';
import { toAbs } from '../services/storage.js';
import * as mediaRepo from '../repositories/media.repo.js';

/** 允许 Range 的变体——都是媒体本身 */
const RANGEABLE = new Set(['original', 'preview', 'playable']);

/**
 * 解析 `Range: bytes=start-end`。
 * 只支持单段 range（多段 range 需要 multipart/byteranges，浏览器极少用，
 * 而小程序和 Safari 都用单段）。解析失败返回 null，调用方回退成整个文件。
 *
 * @param {string|undefined} header
 * @param {number} size
 * @returns {{start: number, end: number}|null}
 */
function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;

  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;

  if (rawStart === '') {
    // bytes=-500 → 最后 500 字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;

  return { start, end: Math.min(end, size - 1) };
}

export default async function fileRoutes(app) {
  app.get('/f/:token', async (request, reply) => {
    const { token } = request.params;

    let payload;
    try {
      payload = verifyFileToken(token);
    } catch (err) {
      // 过期和签名错误都回 404：不告诉对方是「过期了」还是「签错了」。
      // 前者会鼓励他去刷新重试，后者会鼓励他去爆破。
      throw notFound('链接无效或已过期');
    }

    const media = mediaRepo.findById(payload.m);
    if (!media) throw notFound('素材不存在');

    // 纵深防御：令牌里记录了签发时的持有者，这里再核对一次素材归属。
    // 令牌本身就是凭据，所以这不防「URL 被转发」——那件事靠过期时间限制；
    // 它防的是签发逻辑出 bug 时签出了不该签的令牌。
    if (payload.g !== 'a' && media.guestId !== payload.g) {
      throw notFound('素材不存在');
    }

    const rel = media.paths?.[payload.v];
    if (!rel) throw notFound('该版本尚不可用');

    let abs;
    try {
      abs = toAbs(rel);
    } catch {
      // 存进库的路径不合法说明数据被改过或迁移出过问题，属于严重异常
      request.log.error({ mediaId: media.id, rel }, '数据库里的相对路径不合法');
      throw new AppError(ErrorCode.INTERNAL, '文件路径异常');
    }

    let stat;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw notFound('文件不存在或已被删除');
    }
    if (!stat.isFile()) throw notFound('文件不存在或已被删除');

    // Content-Type 一律取自**入库时经白名单校验的 mime**，绝不用请求头或扩展名推断。
    // 这挡住了「上传一个 .jpg 实际是 HTML」这类内容嗅探攻击。
    reply.header('Content-Type', media.mime);
    reply.header('Accept-Ranges', 'bytes');
    // 签名 URL 是每人专用的，可以放心让浏览器缓存一会儿
    reply.header('Cache-Control', 'private, max-age=1800');
    reply.header('Last-Modified', stat.mtime.toUTCString());

    const filename = sanitizeDownloadName(media, path.extname(rel));
    reply.header(
      'Content-Disposition',
      `${payload.d ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );

    const range = RANGEABLE.has(payload.v) ? parseRange(request.headers.range, stat.size) : null;

    if (range) {
      const { start, end } = range;
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      reply.header('Content-Length', String(end - start + 1));
      return reply.send(fs.createReadStream(abs, { start, end }));
    }

    // 请求了 Range 但范围不合法（比如超出文件末尾）→ 按规范回 416
    if (request.headers.range && RANGEABLE.has(payload.v)) {
      reply.code(416);
      reply.header('Content-Range', `bytes */${stat.size}`);
      return reply.send();
    }

    reply.header('Content-Length', String(stat.size));
    return reply.send(fs.createReadStream(abs));
  });
}

/**
 * 下载时的文件名。
 * 用「活动日期 + 类型 + id 前 8 位」而不是存储用的那串长文件名，
 * 因为宾客保存到相册后看到的应该是能认出来的名字。
 */
function sanitizeDownloadName(media, ext) {
  const at = (media.createdAt ?? '').slice(0, 10).replace(/-/g, '');
  const kindLabel = media.kind === 'video' ? '视频' : '照片';
  return `婚礼${kindLabel}_${at}_${media.id.slice(0, 8)}${ext || ''}`;
}
