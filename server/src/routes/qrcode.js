/**
 * 活动二维码接口。
 *
 * 管理端能重新生成、下载；宾客端也能拿到（二维码本来就是要印出来的东西，
 * 不存在泄露问题）。真正需要保护的是**生成**这个动作——
 * 它要调微信接口，有额度成本。
 */
import fs from 'node:fs';
import { badRequest, notFound } from '../lib/errors.js';
import { adminViewOfEvent } from '../lib/views.js';
import { fallbackUrl, generateEventQr, qrAbsPath } from '../services/qrcode.js';
import * as eventsRepo from '../repositories/events.repo.js';

const ALLOWED_ENV = ['release', 'trial', 'develop'];

export default async function qrcodeRoutes(app) {
  /**
   * 生成或刷新二维码。
   *
   * ⚠️ env_version 必须和小程序的发布状态匹配：
   *    开发期用 release 会得到一个指向**不存在页面**的码，扫出来是白屏。
   *    所以这里要求显式传，并且返回里带上是哪个版本，让后台如实显示。
   */
  app.post('/api/admin/events/:id/qr/regenerate', { preHandler: app.requireAdminReady }, async (request) => {
    const event = eventsRepo.findById(request.params.id);
    if (!event) throw notFound('活动不存在');

    const envVersion = request.body?.envVersion;
    if (envVersion !== undefined && !ALLOWED_ENV.includes(envVersion)) {
      throw badRequest(`envVersion 只能是 ${ALLOWED_ENV.join(' / ')}`);
    }

    const result = await generateEventQr(event, {
      envVersion: envVersion || undefined,
      force: true,
    });

    eventsRepo.setQr(event.id, {
      path: result.relPath,
      envVersion: result.envVersion,
      mode: result.mode,
    });

    const updated = eventsRepo.findById(event.id);

    return {
      ok: true,
      data: {
        event: adminViewOfEvent(updated),
        mode: result.mode,
        envVersion: result.envVersion,
        // 兜底模式下把目标地址也带出来，方便主持人贴在群里
        fallbackUrl: result.mode === 'fallback' ? fallbackUrl(event.id) : null,
      },
    };
  });

  /** 管理端下载二维码图片 */
  app.get('/api/admin/events/:id/qr.png', { preHandler: app.requireAdminReady }, async (request, reply) => {
    const event = eventsRepo.findById(request.params.id);
    if (!event) throw notFound('活动不存在');

    return sendQr(reply, event, request.query?.envVersion);
  });

  /**
   * 公开读取二维码。
   * 二维码是用来印在现场的，本来就不保密；公开的好处是主持人能直接在
   * 手机浏览器里保存，不用先登录后台。
   */
  app.get('/api/events/:id/qr.png', async (request, reply) => {
    const event = eventsRepo.findById(request.params.id);
    if (!event) throw notFound('活动不存在');
    return sendQr(reply, event, request.query?.envVersion);
  });

  /**
   * 二维码的兜底目标地址（H5 落地页）。
   * 兜底模式下，主持人可以把这个链接直接发到宾客群里。
   */
  app.get('/api/events/:id/qr-info', async (request) => {
    const event = eventsRepo.findById(request.params.id);
    if (!event) throw notFound('活动不存在');

    return {
      ok: true,
      data: {
        id: event.id,
        // 8 位活动码：印在二维码旁边做双保险，扫不开时还能手输
        code: event.id,
        title: event.title,
        qrMode: event.qrMode,
        qrEnvVersion: event.qrEnvVersion,
        hasQr: Boolean(event.qrPath),
        fallbackUrl: fallbackUrl(event.id),
      },
    };
  });
}

/** 已经生成过就直接发缓存文件，没生成过就现生成一次 */
async function sendQr(reply, event, envVersion) {
  const allowed = ALLOWED_ENV.includes(envVersion) ? envVersion : undefined;

  const result = await generateEventQr(event, { envVersion: allowed });

  // 首次生成时把记录补上，省得主持人忘了点「生成」
  if (!event.qrPath || event.qrPath !== result.relPath) {
    eventsRepo.setQr(event.id, {
      path: result.relPath,
      envVersion: result.envVersion,
      mode: result.mode,
    });
  }

  const abs = qrAbsPath(result.relPath);

  reply.header('Content-Type', 'image/png');
  reply.header('Cache-Control', 'public, max-age=3600');
  reply.header(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(`婚礼二维码_${event.id}.png`)}`,
  );

  return reply.send(fs.createReadStream(abs));
}