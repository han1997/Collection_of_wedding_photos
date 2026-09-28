/**
 * 宾客登录。
 *
 * 落地页只调这一个接口：带 eventId 进来时，除了 token 还会顺带返回
 * 活动信息和第一页「我上传的」。婚礼现场网络差、宾客没耐心，
 * 少一次往返是实打实的体验差别。
 */
import { badRequest, notFound } from '../lib/errors.js';
import { signGuestToken } from '../lib/jwt.js';
import { guestViewOfEvent, guestViewOfMembership } from '../lib/views.js';
import { sanitizeName } from '../services/storage.js';
import { toClientList } from '../services/mediaService.js';
import { code2Session } from '../services/wechatAuth.js';
import * as eventsRepo from '../repositories/events.repo.js';
import * as eventGuestsRepo from '../repositories/eventGuests.repo.js';
import * as guestsRepo from '../repositories/guests.repo.js';
import * as mediaRepo from '../repositories/media.repo.js';

const PAGE_SIZE = 30;

export default async function authRoutes(app) {
  app.post('/api/auth/login', {
    config: {
      // 登录接口按 IP 限流，防止有人拿别人的 code 刷
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  }, async (request) => {
    const body = request.body ?? {};

    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) throw badRequest('缺少 code');

    // 可选：直接带活动 id（扫码进入），或带活动码（手动输入兜底）
    let event = null;
    if (typeof body.eventId === 'string' && body.eventId.trim()) {
      event = eventsRepo.findById(body.eventId.trim());
      if (!event) throw notFound('活动不存在或已结束');
    } else if (typeof body.eventCode === 'string' && body.eventCode.trim()) {
      event = eventsRepo.findById(body.eventCode.trim().toUpperCase());
      if (!event) throw notFound('活动码不正确');
    }

    const { openid, unionid } = await code2Session(code);
    const guest = guestsRepo.upsertByOpenid(openid, unionid);

    const token = await signGuestToken(guest.id, openid);

    const data = {
      token,
      guest: { id: guest.id },
      // 没带活动进来时只回 token，客户端再去拉活动
      ...(event ? { event: guestViewOfEvent(event) } : {}),
    };

    if (event) {
      // 昵称是可选的，只用于「怎么称呼您」的展示。清洗后再存——
      // 它会进文件名，不能带进斜杠、点号之类的字符。
      const displayName =
        typeof body.displayName === 'string'
          ? sanitizeName(body.displayName, { maxLen: 12 }) || null
          : null;

      const membership = eventGuestsRepo.ensure(event.id, guest.id, displayName);

      const page = mediaRepo.listMine({
        eventId: event.id,
        guestId: guest.id,
        limit: PAGE_SIZE,
      });

      data.me = guestViewOfMembership(membership);
      data.media = toClientList(page, guest.id);
      data.nextCursor = page.length === PAGE_SIZE ? mediaRepo.encodeCursor(page[page.length - 1]) : '';
    }

    return { ok: true, data };
  });
}
