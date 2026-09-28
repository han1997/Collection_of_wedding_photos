/**
 * 分片上传接口。
 *
 * 流程：
 *   POST   /api/uploads/init                     声明文件信息，拿 sessionId
 *   PUT    /api/uploads/:id/parts/:partNo        逐片上传（裸流）
 *   GET    /api/uploads/:id                      查「哪些片收过了」——续传依据
 *   POST   /api/uploads/:id/complete             合并落盘
 *   DELETE /api/uploads/:id                      放弃
 *
 * 注意：分片 PUT **刻意不做 IP 限流**。一个 3GB 文件有 750 片，
 * 任何合理的速率限制都会误伤。它的保护是会话归属 + 过期 + 精确字节校验。
 */
import { badRequest, notFound } from '../lib/errors.js';
import * as eventsRepo from '../repositories/events.repo.js';
import * as mediaRepo from '../repositories/media.repo.js';
import * as uploadSessionsRepo from '../repositories/uploadSessions.repo.js';
import {
  abortUpload,
  completeUpload,
  getOwnedSession,
  initUpload,
  missingParts,
  receivePart,
} from '../services/uploadService.js';

export default async function uploadRoutes(app) {
  /** 取活动；找不到就 404（不说「存在但你没权限」） */
  function loadEvent(eventId) {
    const event = eventsRepo.findById(eventId);
    if (!event) throw notFound('活动不存在或已结束');
    return event;
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------
  app.post(
    '/api/uploads/init',
    {
      preHandler: app.requireGuest,
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    },
    async (request) => {
      const body = request.body ?? {};
      const eventId = typeof body.eventId === 'string' ? body.eventId : '';
      const event = loadEvent(eventId);

      const { session } = await initUpload({
        event,
        guest: request.guest,
        body,
        sourceIp: request.ip,
      });

      return {
        ok: true,
        data: {
          sessionId: session.id,
          chunkSize: session.chunkSize,
          totalParts: session.totalParts,
          receivedParts: [],
          expiresAt: session.expiresAt,
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // 查状态（续传的唯一依据）
  // -------------------------------------------------------------------------
  app.get('/api/uploads/:sessionId', { preHandler: app.requireGuest }, async (request) => {
    const session = getOwnedSession(request.params.sessionId, request.guest.id);
    const parts = uploadSessionsRepo.listParts(session.id);

    return {
      ok: true,
      data: {
        sessionId: session.id,
        status: session.status,
        chunkSize: session.chunkSize,
        totalParts: session.totalParts,
        // 客户端拿这个跳过已传分片
        receivedParts: parts.map((p) => p.partNo),
        receivedBytes: parts.reduce((sum, p) => sum + p.bytes, 0),
        declaredBytes: session.declaredBytes,
        mediaId: session.mediaId,
        expiresAt: session.expiresAt,
      },
    };
  });

  // -------------------------------------------------------------------------
  // 收分片（裸流，按 partNo 幂等）
  // -------------------------------------------------------------------------
  app.put('/api/uploads/:sessionId/parts/:partNo', { preHandler: app.requireGuest }, async (request) => {
    const session = getOwnedSession(request.params.sessionId, request.guest.id);
    const partNo = Number(request.params.partNo);

    if (!Number.isInteger(partNo)) throw badRequest('分片号必须是整数');

    // 请求体必须是裸流（binaryParser 插件处理的）。
    // 如果客户端带错了 content-type，这里会退化成已解析对象——明确报错，
    // 免得写出一堆垃圾字节到磁盘上。
    if (!request.body || typeof request.body.pipe !== 'function') {
      throw badRequest('分片必须以 application/octet-stream 裸流方式上传');
    }

    const result = await receivePart({
      session,
      partNo,
      stream: request.body,
      contentLength: request.headers['content-length'],
    });

    return { ok: true, data: result };
  });

  // -------------------------------------------------------------------------
  // 合并
  // -------------------------------------------------------------------------
  app.post('/api/uploads/:sessionId/complete', { preHandler: app.requireGuest }, async (request) => {
    const session = getOwnedSession(request.params.sessionId, request.guest.id);
    const event = loadEvent(session.eventId);

    const { mediaId, alreadyCompleted } = await completeUpload({
      session,
      event,
      sourceIp: request.ip,
    });

    const media = mediaRepo.findById(mediaId);

    return {
      ok: true,
      data: {
        mediaId,
        alreadyCompleted,
        status: media?.status ?? 'processing',
      },
    };
  });

  // -------------------------------------------------------------------------
  // 放弃
  // -------------------------------------------------------------------------
  app.delete('/api/uploads/:sessionId', { preHandler: app.requireGuest }, async (request) => {
    const session = getOwnedSession(request.params.sessionId, request.guest.id);
    await abortUpload(session);
    return { ok: true, data: { aborted: true } };
  });

  // -------------------------------------------------------------------------
  // 未完成的上传（客户端用来提示「继续上次上传」）
  // -------------------------------------------------------------------------
  app.get('/api/uploads', { preHandler: app.requireGuest }, async (request) => {
    const eventId = String(request.query?.eventId ?? '');
    if (!eventId) throw badRequest('缺少 eventId');

    const open = uploadSessionsRepo.listOpenByGuest(eventId, request.guest.id);

    return {
      ok: true,
      data: {
        sessions: open.map((s) => ({
          sessionId: s.id,
          fileName: s.declaredName,
          declaredBytes: s.declaredBytes,
          kind: s.kind,
          expiresAt: s.expiresAt,
          receivedCount: uploadSessionsRepo.countParts(s.id),
          totalParts: s.totalParts,
          missingParts: missingParts(s),
        })),
      },
    };
  });
}
