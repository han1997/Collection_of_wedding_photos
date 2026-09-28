/**
 * 宾客端的活动接口。
 *
 * 「我上传的」只在这一处暴露，且查询恒定带 (event_id, guest_id)。
 */
import { badRequest, notFound } from '../lib/errors.js';
import { guestViewOfEvent, guestViewOfMembership } from '../lib/views.js';
import { toClientList } from '../services/mediaService.js';
import * as eventsRepo from '../repositories/events.repo.js';
import * as eventGuestsRepo from '../repositories/eventGuests.repo.js';
import * as mediaRepo from '../repositories/media.repo.js';

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

export default async function eventRoutes(app) {
  /**
   * 载入活动并确保调用者已是该活动的成员。
   * 不是成员就自动加入——扫了码进来就算参加这场婚礼，不需要额外确认。
   */
  async function loadEventForGuest(request) {
    const { id } = request.params;
    const event = eventsRepo.findById(id);
    if (!event) throw notFound('活动不存在或已结束');

    const membership = eventGuestsRepo.ensure(event.id, request.guest.id, null);
    return { event, membership };
  }

  app.get('/api/events/:id', { preHandler: app.requireGuest }, async (request) => {
    const { event, membership } = await loadEventForGuest(request);

    const media = mediaRepo.listMine({
      eventId: event.id,
      guestId: request.guest.id,
      limit: DEFAULT_PAGE,
    });

    return {
      ok: true,
      data: {
        event: guestViewOfEvent(event),
        me: guestViewOfMembership(membership),
        media: toClientList(media, request.guest.id),
        nextCursor:
          media.length === DEFAULT_PAGE ? mediaRepo.encodeCursor(media[media.length - 1]) : '',
      },
    };
  });

  /**
   * ★「我上传的」。
   * 注意 listMine 的实现里 event_id 和 guest_id 是并列的两个条件——
   * 这就是「只能看到自己上传的内容」。
   */
  app.get('/api/events/:id/media', { preHandler: app.requireGuest }, async (request) => {
    const { id } = request.params;
    const event = eventsRepo.findById(id);
    if (!event) throw notFound('活动不存在或已结束');

    const { cursor } = request.query ?? {};
    const limit = Math.min(Number(request.query?.limit) || DEFAULT_PAGE, MAX_PAGE);
    if (Number.isNaN(limit) || limit < 1) throw badRequest('limit 不合法');

    const rows = mediaRepo.listMine({
      eventId: event.id,
      guestId: request.guest.id,
      cursor: typeof cursor === 'string' ? cursor : undefined,
      limit,
    });

    return {
      ok: true,
      data: {
        media: toClientList(rows, request.guest.id),
        nextCursor: rows.length === limit ? mediaRepo.encodeCursor(rows[rows.length - 1]) : '',
      },
    };
  });

  /**
   * 手动输入活动码的兜底入口。
   * 现场网络、微信版本、二维码印糊了……任何一种意外都会让「扫码」这条路断掉，
   * 所以必须留一条「手输」的路。
   */
  app.get('/api/events/by-code/:code', { preHandler: app.requireGuest }, async (request) => {
    const code = String(request.params.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(code)) throw badRequest('活动码格式不正确');

    const event = eventsRepo.findById(code);
    if (!event) throw notFound('活动码不正确');

    eventGuestsRepo.ensure(event.id, request.guest.id, null);

    return { ok: true, data: { event: guestViewOfEvent(event) } };
  });
}
