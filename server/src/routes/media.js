/**
 * 单条媒体的操作：换签名 URL、删除自己的、举报。
 *
 * 这三个接口的 URL 里只有 mediaId，所以所有权判断落在
 * `mediaRepo.findOwnedAnyEvent({id, guestId})` —— **guest_id 是查询条件的一部分**，
 * 不是在 JS 里事后比对。取不到就 404（不 403，避免确认 ID 存在）。
 */
import { badRequest, notFound } from '../lib/errors.js';
import { fileUrl, signFileToken, VARIANTS } from '../lib/signedUrl.js';
import { toClient, softDelete as softDeleteMedia } from '../services/mediaService.js';
import * as mediaRepo from '../repositories/media.repo.js';

export default async function mediaRoutes(app) {
  app.get('/api/media/:id', { preHandler: app.requireGuest }, async (request) => {
    const media = mediaRepo.findOwned({ id: request.params.id, eventId: request.guest.eventId, guestId: request.guest.id });
    if (!media) throw notFound('素材不存在');
    return { ok: true, data: { media: toClient(media, request.guest.id) } };
  });
  /**
   * 换个新鲜的签名 URL。
   *
   * 为什么需要：签名 URL 有 2 小时有效期，宾客在页面上停留久了就会过期。
   * 客户端 403/过期时调这个接口换一个，而不是重新登录。
   */
  app.get('/api/media/:id/url', { preHandler: app.requireGuest }, async (request) => {
    const { id } = request.params;
    const variant = String(request.query?.variant ?? 'original');
    const download = request.query?.download === '1' || request.query?.download === 'true';

    if (!VARIANTS[variant]) {
      throw badRequest(`variant 只能是 ${Object.keys(VARIANTS).join(' / ')}`);
    }

    const media = mediaRepo.findOwned({ id, eventId: request.guest.eventId, guestId: request.guest.id });
    if (!media) throw notFound('素材不存在');

    const rel = media.paths?.[variant];
    if (!rel) throw notFound('该版本尚不可用（可能还在处理中）');

    const token = signFileToken({
      mediaId: media.id,
      variant,
      download,
      guestId: request.guest.id,
    });

    return { ok: true, data: { url: fileUrl(token), variant } };
  });

  /** 删除自己上传的 */
  app.delete('/api/media/:id', { preHandler: app.requireGuest }, async (request) => {
    const { id } = request.params;
    const media = mediaRepo.findOwned({ id, eventId: request.guest.eventId, guestId: request.guest.id });
    if (!media) throw notFound('素材不存在');

    await softDeleteMedia(media);
    return { ok: true, data: { id } };
  });

}
