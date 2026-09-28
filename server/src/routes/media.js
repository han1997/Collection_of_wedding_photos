/**
 * 单条媒体的操作：换签名 URL、删除自己的、举报。
 *
 * 这三个接口的 URL 里只有 mediaId，所以所有权判断落在
 * `mediaRepo.findOwnedAnyEvent({id, guestId})` —— **guest_id 是查询条件的一部分**，
 * 不是在 JS 里事后比对。取不到就 404（不 403，避免确认 ID 存在）。
 */
import { badRequest, notFound } from '../lib/errors.js';
import { fileUrl, signFileToken, VARIANTS } from '../lib/signedUrl.js';
import { softDelete as softDeleteMedia } from '../services/mediaService.js';
import { REASON_OPTIONS, isValidReason } from '../repositories/reports.repo.js';
import * as mediaRepo from '../repositories/media.repo.js';
import * as reportsRepo from '../repositories/reports.repo.js';

export default async function mediaRoutes(app) {
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

    const media = mediaRepo.findOwnedAnyEvent({ id, guestId: request.guest.id });
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
    const media = mediaRepo.findOwnedAnyEvent({ id, guestId: request.guest.id });
    if (!media) throw notFound('素材不存在');

    await softDeleteMedia(media);
    return { ok: true, data: { id } };
  });

  /**
   * 举报。审核要求有入口，所以必须有。
   * 重复举报同一条只记一次，避免刷量把管理员淹没。
   */
  app.post('/api/media/:id/report', { preHandler: app.requireGuest }, async (request) => {
    const { id } = request.params;
    const body = request.body ?? {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (!isValidReason(reason)) {
      throw badRequest('举报原因不合法', { allowed: REASON_OPTIONS });
    }

    // 举报对象必须是调用者能看到的素材
    const media = mediaRepo.findOwnedAnyEvent({ id, guestId: request.guest.id });
    if (!media) throw notFound('素材不存在');

    if (reportsRepo.existsFromReporter(media.id, request.guest.id)) {
      // 幂等返回，不报错——重复举报不是错误行为
      return { ok: true, data: { alreadyReported: true } };
    }

    reportsRepo.create({
      mediaId: media.id,
      reporterGuestId: request.guest.id,
      reason,
      detail: typeof body.detail === 'string' ? body.detail.slice(0, 500) : null,
    });

    return { ok: true, data: { reported: true } };
  });
}
