/**
 * 媒体对外的表现形式。
 *
 * ★ 一条硬规矩：**存储路径绝不发给客户端**。
 *   客户端只拿到已经签好名、带过期的 URL。
 *   路径是内部实现细节，泄露它等于告诉别人目录结构。
 *
 * 另一条：签名 URL 里绑定了持有者（宾客 id 或 'a' 代表管理员）。
 * 宾客之间互相转发 URL 也没用——签名里的 g 字段对不上就不给。
 */
import { fileUrl, signFileToken, VARIANTS } from '../lib/signedUrl.js';
import { moveToGc, toAbs } from './storage.js';
import * as mediaRepo from '../repositories/media.repo.js';
import * as eventGuestsRepo from '../repositories/eventGuests.repo.js';

/**
 * 某个变体是否存在文件。原图必然有；衍生物可能还没生成或生成失败。
 * @param {any} media media.repo 返回的对象
 * @param {string} variant
 */
function hasVariant(media, variant) {
  return Boolean(media.paths?.[variant]);
}

/**
 * 给某个变体签一个 URL。没有对应文件时返回 null。
 * @param {any} media
 * @param {string} variant
 * @param {number|'a'} holder
 * @param {{download?: boolean}} [opts]
 */
function urlFor(media, variant, holder, opts = {}) {
  if (!VARIANTS[variant]) throw new Error(`未知变体 ${variant}`);
  if (!hasVariant(media, variant)) return null;

  const token = signFileToken({
    mediaId: media.id,
    variant,
    download: opts.download === true,
    guestId: holder,
  });
  return fileUrl(token);
}

/**
 * 把一条 media 记录转成给客户端的样子。
 *
 * @param {any} media media.repo 的 toPublic 结果
 * @param {number|'a'} holder 宾客 id，或 'a' 表示管理员
 */
export function toClient(media, holder) {
  if (!media) return null;

  const isVideo = media.kind === 'video';

  // 缩略图优先级：专门的缩略图 → 视频封面 → 原图
  // 视频如果没有封面，退回原图会让手机去下整个视频，所以宁可给 null 让前端显示占位图标
  const thumbUrl =
    urlFor(media, 'thumb', holder) ?? (isVideo ? urlFor(media, 'poster', holder) : urlFor(media, 'original', holder));

  return {
    id: media.id,
    kind: media.kind,
    bytes: media.bytes,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    status: media.status,
    needsTranscode: media.needsTranscode,
    takenAt: media.takenAt,
    createdAt: media.createdAt,

    thumbUrl,
    // 预览用长边 1600 的衍生物；还没有就退回原图
    previewUrl: urlFor(media, 'preview', holder) ?? urlFor(media, 'original', holder),
    // 看视频时优先用转好的可播版本（如果开过转码），否则原片
    videoUrl: isVideo ? (urlFor(media, 'playable', holder) ?? urlFor(media, 'original', holder)) : null,
    // 「保存到相册 / 下载原片」用它，带 attachment 语义且时效更短
    downloadUrl: urlFor(media, 'original', holder, { download: true }),
  };
}

/**
 * 批量转换。
 * @param {any[]} list
 * @param {number|'a'} holder
 */
export function toClientList(list, holder) {
  return list.map((m) => toClient(m, holder));
}

/**
 * 删除一条媒体（软删）。
 *
 * 顺序刻意是「先写数据库、再动文件」：
 * 如果反过来，文件删掉了但数据库更新失败，就会留下一条指向不存在文件的记录，
 * 而前端还会尝试去显示它。反过来最坏情况只是留下几个孤儿文件，由回收站清理。
 *
 * 文件是**移进回收站**而不是立即 unlink——误触要能恢复，
 * 而且主持人可能在上传后马上后悔。24 小时后才真正清掉。
 *
 * @param {any} media media.repo 的 toPublic 结果（含 paths）
 */
export async function softDelete(media) {
  mediaRepo.softDelete(media.id);
  eventGuestsRepo.reduceCounters(media.eventId, media.guestId, media.bytes);

  for (const rel of Object.values(media.paths ?? {})) {
    if (!rel) continue;
    try {
      await moveToGc(toAbs(rel));
    } catch (err) {
      // 文件可能已经被删掉了，或者路径不合法——都不该让删除操作失败
      if (err?.code !== 'ENOENT') {
        // 交给上层日志，但不阻断
        console.warn(`[media] 移动文件到回收站失败：${rel}`, err?.message);
      }
    }
  }
}
