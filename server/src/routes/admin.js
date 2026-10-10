import { currentEvent } from '../repositories/site.repo.js';
import * as guestsRepo from '../repositories/guests.repo.js';
/**
 * 管理端接口。主持人用：建活动、看全部素材、删除、导出。
 *
 * 鉴权分两层：
 *   requireAdmin      —— 已登录
 *   requireAdminReady —— 已登录且已改掉初始密码
 * 除了「登录/改密」自身，其余管理接口都用后者。
 *
 * 二维码生成（P4）不在这里，走 routes/qrcode.js。
 */
import config from '../config.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../lib/password.js';
import { signAdminToken } from '../lib/jwt.js';
import { adminViewOfEvent } from '../lib/views.js';
import { shanghaiDay, isoAfter } from '../lib/time.js';
import { softDelete as softDeleteMedia, toClient } from '../services/mediaService.js';
import * as adminsRepo from '../repositories/admins.repo.js';
import * as eventsRepo from '../repositories/events.repo.js';
import * as eventGuestsRepo from '../repositories/eventGuests.repo.js';
import * as mediaRepo from '../repositories/media.repo.js';
import * as reportsRepo from '../repositories/reports.repo.js';
import * as storage from '../services/storage.js';
import { stats as queueStats } from '../jobs/queue.js';

// ---------------------------------------------------------------------------
// 登录失败锁定
//
// 只限 IP 是没用的——家用宽带换 IP 很便宜。所以额外按**用户名**计数：
// 连续失败到阈值就锁一段时间，无论从哪个 IP 来。
//
// ⚠️ 这份状态在内存里，重启即清空。对本项目的部署形态（单容器、运维者即业主）
//    这个强度够用；要更强的持久性就把它挪到 kv 表。
// ---------------------------------------------------------------------------
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

/** @type {Map<string, {count: number, lockedUntil: number}>} */
const loginFailures = new Map();

function assertNotLocked(username) {
  const rec = loginFailures.get(username);
  if (!rec) return;
  if (rec.lockedUntil > Date.now()) {
    const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    throw unauthorized(`尝试次数过多，请 ${mins} 分钟后再试`);
  }
  if (rec.lockedUntil > 0) loginFailures.delete(username);
}

function recordFailure(username) {
  const rec = loginFailures.get(username) ?? { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  loginFailures.set(username, rec);
}

function clearFailures(username) {
  loginFailures.delete(username);
}

export default async function adminRoutes(app) {
  // -------------------------------------------------------------------------
  // 登录
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/login',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes', keyGenerator: request => request.ip } } },
    async (request) => {
      const body = request.body ?? {};
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!username || !password) throw badRequest('请输入账号和密码');

      assertNotLocked(username);

      const admin = adminsRepo.findByUsernameWithHash(username);

      // 用户不存在时也走一次哈希校验，让响应时间不泄露「账号是否存在」。
      // 用一个固定的假哈希，代价是几十毫秒，值得。
      const storedHash = admin?.password_hash ?? DUMMY_HASH;
      const ok = verifyPassword(password, storedHash);

      if (!admin || !ok) {
        recordFailure(username);
        request.log.warn({ username, ip: request.ip }, '管理端登录失败');
        throw unauthorized('账号或密码不正确');
      }

      clearFailures(username);
      adminsRepo.updateLastLogin(admin.id);

      const token = await signAdminToken(admin.id, admin.token_version);

      return {
        ok: true,
        data: {
          token,
          admin: {
            id: admin.id,
            username: admin.username,
            displayName: admin.display_name,
            mustChangePassword: Boolean(admin.must_change_password),
          },
        },
      };
    },
  );

  /** 当前登录态 */
  app.get('/api/admin/me', { preHandler: app.requireAdmin }, async (request) => ({
    ok: true,
    data: { admin: request.admin },
  }));

  /**
   * 改密码。改完 token_version 加一，**所有旧会话立即失效**（包括当前这个），
   * 所以客户端要拿返回的新 token 替换掉本地的。
   */
  app.post('/api/admin/password', { preHandler: app.requireAdmin }, async (request) => {
    const body = request.body ?? {};
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';

    const admin = adminsRepo.findByUsernameWithHash(request.admin.username);
    if (!admin) throw unauthorized('账号不存在');

    if (!verifyPassword(current, admin.password_hash)) {
      throw unauthorized('当前密码不正确');
    }

    const problem = checkPasswordStrength(next);
    if (problem) throw badRequest(problem);
    if (next === current) throw badRequest('新密码不能和当前密码相同');

    adminsRepo.updatePasswordHash(admin.id, hashPassword(next));
    adminsRepo.bumpTokenVersion(admin.id);

    const fresh = adminsRepo.findByUsernameWithHash(admin.username);
    const token = await signAdminToken(fresh.id, fresh.token_version);

    return { ok: true, data: { token } };
  });

  // -------------------------------------------------------------------------
  // 活动
  // -------------------------------------------------------------------------
  app.get('/api/admin/wedding', { preHandler: app.requireAdminReady }, async (request) => {
    const event = currentEvent();
    if (!event) throw notFound('活动不存在');

    return {
      ok: true,
      data: {
        event: adminViewOfEvent(event),
        guests: eventGuestsRepo.listByEvent(event.id).map(g => ({ ...g, ...guestsRepo.findById(g.guestId) })),
        stats: {
          uploadCount: mediaRepo.countByEvent(event.id),
          totalBytes: eventsRepo.totalBytes(event.id),
          guestCount: eventGuestsRepo.countByEvent(event.id),
        },
      },
    };
  });

  app.patch('/api/admin/wedding', { preHandler: app.requireAdminReady }, async (request) => {
    const event = currentEvent();
    if (!event) throw notFound('活动不存在');

    const body = request.body ?? {};
    const patch = {};

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) throw badRequest('活动名称不能为空');
      patch.title = title.slice(0, 60);
    }
    if (body.coupleNames !== undefined) patch.coupleNames = str(body.coupleNames, 60);
    if (body.eventDate !== undefined) {
      if (body.eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.eventDate))) {
        throw badRequest('日期格式应为 YYYY-MM-DD');
      }
      patch.eventDate = str(body.eventDate, 10);
    }
    if (body.venue !== undefined) patch.venue = str(body.venue, 80);
    if (body.welcomeText !== undefined) patch.welcomeText = str(body.welcomeText, 200);
    if (body.uploadEnabled !== undefined) {
      if (typeof body.uploadEnabled !== 'boolean') throw badRequest('上传开关必须是布尔值');
      patch.uploadEnabled = body.uploadEnabled;
    }
    if (body.status !== undefined) {
      if (!['active', 'closed', 'archived'].includes(body.status)) {
        throw badRequest('状态不合法');
      }
      patch.status = body.status;
    }

    const updated = eventsRepo.update(event.id, patch);
    await storage.ensureEventDirs(updated.slug);
    await storage.writeEventManifest(updated);

    return { ok: true, data: { event: adminViewOfEvent(updated) } };
  });

  app.patch('/api/admin/guests/:id', { preHandler: app.requireAdminReady }, async (request) => {
    const id = Number(request.params.id);
    if (!eventGuestsRepo.find(currentEvent().id, id)) throw notFound('宾客不存在');
    if (typeof request.body?.banned !== 'boolean') throw badRequest('banned 必须是布尔值');
    guestsRepo.setBanned(id, request.body.banned);
    return { ok: true, data: {} };
  });

  // -------------------------------------------------------------------------
  // 素材（管理端看**全部**，不受 guest_id 限制）
  // -------------------------------------------------------------------------
  app.get('/api/admin/media', { preHandler: app.requireAdminReady }, async (request) => {
    const q = request.query ?? {};
    const limit = Number(q.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badRequest('分页数量不合法');
    if (q.guestId && (!Number.isSafeInteger(Number(q.guestId)) || Number(q.guestId) < 1)) throw badRequest('宾客筛选不合法');

    const rows = mediaRepo.listAllAdmin({
      eventId: currentEvent().id,
      guestId: q.guestId ? Number(q.guestId) : undefined,
      kind: q.kind ? String(q.kind) : undefined,
      status: q.status ? String(q.status) : undefined,
      cursor: q.cursor ? String(q.cursor) : undefined,
      limit,
    });

    return {
      ok: true,
      data: {
        // 管理员的签名令牌持有者标记是 'a'
        media: rows.map((m) => ({ ...toClient(m, 'a'), guestId: m.guestId, eventId: m.eventId })),
        nextCursor: rows.length === limit ? mediaRepo.encodeCursor(rows[rows.length - 1]) : '',
      },
    };
  });

  app.get('/api/admin/media/:id', { preHandler: app.requireAdminReady }, async (request) => {
    const media = mediaRepo.findById(request.params.id);
    if (!media || media.eventId !== currentEvent().id) throw notFound('素材不存在');
    return {
      ok: true,
      data: { media: { ...toClient(media, 'a'), guestId: media.guestId, eventId: media.eventId } },
    };
  });

  app.delete('/api/admin/media/:id', { preHandler: app.requireAdminReady }, async (request) => {
    const media = mediaRepo.findById(request.params.id);
    if (!media || media.eventId !== currentEvent().id) throw notFound('素材不存在');

    await softDeleteMedia(media);
    return { ok: true, data: { deleted: true } };
  });

}

/** 截断字符串字段，空值归一成 null */
function str(v, maxLen) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

/**
 * 「账号不存在」时用来消耗等量时间的假哈希。
 * 值本身不重要，重要的是 verifyPassword 会对它做一次真实的 scrypt 运算。
 */
const DUMMY_HASH = hashPassword('dummy-password-for-timing-equalization');
