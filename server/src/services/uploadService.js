/**
 * ★ 分片上传：初始化、收片、合并。
 *
 * 这是全项目风险最高的一段代码。设计要点：
 *
 * 1. **内存恒定**。收片是把请求体（裸流）直接管道到磁盘，合并是把分片流式
 *    追加到目标文件。全程峰值内存 ≈ 一个流的 highWaterMark，
 *    不管文件是 3MB 还是 3GB。弱 NAS 的内存很宝贵。
 *
 * 2. **服务端是续传的唯一真相**。客户端只记 sessionId，
 *    「哪些片收过了」一律以 upload_parts 表为准。
 *
 * 3. **合并用 rename 落盘**，所以 tmp/ 必须和 events/ 同盘（同盘才原子）。
 *    跨设备 rename 会退化成整文件拷贝，3GB 的文件会非常痛。
 *
 * 4. **收片阶段不校验文件内容**，只在合并后按实际字节嗅探一次。
 *    分片阶段无法判断整体类型，而且提前校验也没意义——
 *    真正的防线是最后的 magic bytes 检查 + 文件永不作为静态内容提供。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

import config from '../config.js';
import { badRequest, notFound, quotaExceeded, unsupportedMedia, conflict } from '../lib/errors.js';
import { newMediaId, newUploadId } from '../lib/ids.js';
import { looksNeedsTranscode, normalizeDeclared, verifyAgainstDeclared } from '../lib/mediaTypes.js';
import { isoAfter, shanghaiDay } from '../lib/time.js';
import { tx } from '../db/index.js';
import { enqueue } from '../jobs/queue.js';
import { processMedia } from '../jobs/processMedia.js';
import {
  assemblingPath,
  buildFilename,
  ensureEventDayDirs,
  eventDayDir,
  partPath,
  toRel,
  uniqueFilename,
  uploadTmpDir,
} from './storage.js';
import * as eventsRepo from '../repositories/events.repo.js';
import * as eventGuestsRepo from '../repositories/eventGuests.repo.js';
import * as mediaRepo from '../repositories/media.repo.js';
import * as uploadSessionsRepo from '../repositories/uploadSessions.repo.js';

const MIN_CHUNK = 1024 * 1024; // 1MB
const MAX_CHUNK = 16 * 1024 * 1024; // 16MB

/** 嗅探类型时读取的头字节数 */
const SNIFF_BYTES = 32;

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

/**
 * 建立上传会话。
 *
 * @param {object} p
 * @param {any} p.event
 * @param {any} p.guest
 * @param {any} p.body 客户端声明：{fileName, mime, bytes, sha256?, chunkSize?, takenAt?, deviceInfo?}
 * @param {string|undefined} p.sourceIp
 */
export async function initUpload({ event, guest, body, sourceIp }) {
  const fileName = typeof body?.fileName === 'string' ? body.fileName : '';
  const declaredBytes = Number(body?.bytes);

  const declared = normalizeDeclared(fileName, body?.mime);
  if (!declared) {
    throw unsupportedMedia('不支持的文件类型', {
      hint: '只接受常见的图片和视频格式',
    });
  }

  if (!Number.isFinite(declaredBytes) || declaredBytes <= 0) {
    throw badRequest('文件大小不合法');
  }
  if (declaredBytes > config.upload.maxUploadBytes) {
    throw quotaExceeded(
      `单个文件不能超过 ${Math.round(config.upload.maxUploadBytes / 1024 / 1024)}MB`,
      { maxBytes: config.upload.maxUploadBytes },
    );
  }

  if (!event.uploadEnabled) {
    throw conflict('本场活动的上传通道已关闭');
  }

  await assertQuota(event, guest, declaredBytes);

  // 分片大小取客户端偏好并夹到允许区间。
  // 客户端会按上次实测网速调整，但服务端要有最终决定权。
  const requested = Number(body?.chunkSize);
  const chunkSize = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), MIN_CHUNK), MAX_CHUNK)
    : config.upload.chunkSizeBytes;

  const totalParts = Math.ceil(declaredBytes / chunkSize);
  if (totalParts < 1 || totalParts > 100000) {
    throw badRequest('分片数不合法');
  }

  const sessionId = newUploadId();
  const tmpDir = uploadTmpDir(sessionId);
  await fsp.mkdir(tmpDir, { recursive: true });

  const session = uploadSessionsRepo.create({
    id: sessionId,
    eventId: event.id,
    guestId: guest.id,
    kind: declared.kind,
    mime: declared.mime,
    ext: declared.ext,
    declaredName: fileName.slice(0, 200),
    declaredBytes,
    declaredSha256: typeof body?.sha256 === 'string' ? body.sha256.toLowerCase() : null,
    chunkSize,
    totalParts,
    tmpDir,
    expiresAt: isoAfter(config.upload.sessionTtlMs),
  });

  return { session, declared, sourceIp };
}

/**
 * 配额检查。按**声明值**判断——谎报只能多传一片，
 * 真正的字节数在 complete 时会再核一次。
 */
async function assertQuota(event, guest, incomingBytes) {
  const membership = eventGuestsRepo.find(event.id, guest.id);
  const guestUsed = membership?.bytesUploaded ?? 0;
  if (guestUsed + incomingBytes > config.upload.maxGuestBytes) {
    throw quotaExceeded(
      `你在本场活动的上传总量已达上限（${Math.round(config.upload.maxGuestBytes / 1024 ** 3)}GB）`,
    );
  }

  const eventUsed = eventsRepo.totalBytes(event.id);
  if (eventUsed + incomingBytes > config.upload.maxEventBytes) {
    throw quotaExceeded(
      `本场活动的存储总量已达上限（${Math.round(config.upload.maxEventBytes / 1024 ** 3)}GB），请联系司仪`,
    );
  }

  const since = isoAfter(-60 * 60 * 1000);
  const recent = eventsRepo.recentUploadCount(event.id, since);
  if (recent >= config.upload.maxEventUploadsPerHour) {
    throw quotaExceeded('本场活动上传过于频繁，请稍后再试');
  }
}

// ---------------------------------------------------------------------------
// 收片
// ---------------------------------------------------------------------------

/**
 * 收一个分片。
 *
 * **刻意不做 IP 限流**：一个 3GB 的文件有 750 片，任何合理的 IP 速率限制都会误伤。
 * 这一端的保护是「会话归属 + 未过期 + 字节数精确校验」。
 *
 * @param {object} p
 * @param {any} p.session 已经过归属校验的会话
 * @param {number} p.partNo
 * @param {import('node:stream').Readable} p.stream 请求体裸流
 * @param {string|undefined} p.contentLength
 */
export async function receivePart({ session, partNo, stream, contentLength }) {
  if (session.status !== 'open') {
    throw conflict(`该上传会话状态为 ${session.status}，不能再接收分片`);
  }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    throw conflict('该上传会话已过期，请重新开始上传');
  }
  if (!Number.isInteger(partNo) || partNo < 1 || partNo > session.totalParts) {
    throw badRequest(`分片号必须在 1..${session.totalParts} 之间`);
  }

  const expected = expectedPartSize(session, partNo);

  // 客户端声明了长度就核对；没声明也无妨——写入后按实际字节数记录。
  if (contentLength !== undefined) {
    const declaredLen = Number(contentLength);
    if (Number.isFinite(declaredLen) && declaredLen !== expected) {
      throw badRequest(`分片 ${partNo} 大小不符：期望 ${expected} 字节，收到 ${declaredLen}`);
    }
  }

  const dir = session.tmpDir;
  const finalPath = partPath(session.id, partNo);
  const partialPath = `${finalPath}.partial`;

  // 先写 .partial 再 rename：中途断开时不会留下一个看起来完整、
  // 实际半截的分片文件被后续当成有效分片。
  let written = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      // 超过期望大小就中断——防止客户端无限灌数据把磁盘写满
      if (written > expected) {
        cb(new Error('分片超出预期大小'));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await fsp.mkdir(dir, { recursive: true });
    await pipeline(stream, counter, fs.createWriteStream(partialPath));
  } catch (err) {
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    if (err?.message === '分片超出预期大小') {
      throw badRequest(`分片 ${partNo} 超出预期大小`);
    }
    throw err;
  }

  if (written !== expected) {
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    throw badRequest(`分片 ${partNo} 不完整：期望 ${expected} 字节，实际 ${written}`);
  }

  await fsp.rename(partialPath, finalPath);
  const isNew = uploadSessionsRepo.addPart(session.id, partNo, written);

  return {
    partNo,
    bytes: written,
    duplicate: !isNew,
    receivedParts: uploadSessionsRepo.listParts(session.id).map((p) => p.partNo),
  };
}

/**
 * 某一分片应有的字节数。
 * 除最后一片外都是完整的 chunkSize；最后一片是余数。
 */
function expectedPartSize(session, partNo) {
  const { chunkSize, totalParts, declaredBytes } = session;
  if (partNo < totalParts) return chunkSize;
  const remainder = declaredBytes - (totalParts - 1) * chunkSize;
  // 声明大小恰好是 chunkSize 的整数倍时，最后一片也是整片
  return remainder > 0 ? remainder : chunkSize;
}

/** 还缺哪些分片。用于给客户端一个明确的「缺哪几片」。 */
export function missingParts(session) {
  const have = new Set(uploadSessionsRepo.listParts(session.id).map((p) => p.partNo));
  const missing = [];
  for (let i = 1; i <= session.totalParts; i += 1) {
    if (!have.has(i)) missing.push(i);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

/**
 * 合并所有分片，落盘，入库，进处理队列。
 *
 * @param {object} p
 * @param {any} p.session
 * @param {any} p.event
 * @param {string|undefined} p.sourceIp
 */
export async function completeUpload({ session, event, sourceIp }) {
  if (session.status === 'completed') {
    // 幂等：客户端没收到响应会重试 complete，这里直接回已有的结果
    return { mediaId: session.mediaId, alreadyCompleted: true };
  }
  if (session.status !== 'open' && session.status !== 'assembling') {
    throw conflict(`该上传会话状态为 ${session.status}，无法完成`);
  }

  const missing = missingParts(session);
  if (missing.length) {
    throw conflict(`还有 ${missing.length} 个分片未收到`, {
      missingParts: missing.slice(0, 50),
      missingCount: missing.length,
    });
  }

  const receivedBytes = uploadSessionsRepo.sumPartBytes(session.id);
  if (receivedBytes !== session.declaredBytes) {
    throw conflict(
      `收到的字节数与声明不符：声明 ${session.declaredBytes}，实际 ${receivedBytes}`,
    );
  }

  uploadSessionsRepo.setStatus(session.id, 'assembling');

  const assembled = assemblingPath(session.id, session.ext);

  try {
    await assembleParts(session, assembled);
  } catch (err) {
    uploadSessionsRepo.setStatus(session.id, 'failed');
    throw err;
  }

  // --- 内容校验（此时才拿到完整文件）------------------------------------
  let head;
  try {
    const fh = await fsp.open(assembled, 'r');
    try {
      head = Buffer.alloc(SNIFF_BYTES);
      await fh.read(head, 0, SNIFF_BYTES, 0);
    } finally {
      await fh.close();
    }
  } catch (err) {
    uploadSessionsRepo.setStatus(session.id, 'failed');
    throw err;
  }

  const declared = { ext: session.ext, kind: session.kind };
  const verdict = verifyAgainstDeclared(head, declared);
  if (!verdict.ok) {
    // 校验不过就把临时文件清掉。**不落盘**——
    // 这类文件要么是客户端搞错了，要么是有人在试着投递多态文件。
    await fsp.rm(assembled, { force: true }).catch(() => {});
    await cleanupTmp(session.id);
    uploadSessionsRepo.setStatus(session.id, 'failed');
    throw unsupportedMedia(verdict.reason);
  }

  // --- 落盘 --------------------------------------------------------------
  const at = new Date();
  const day = shanghaiDay(at);
  await ensureEventDayDirs(event.slug, day);

  const membership = eventGuestsRepo.find(event.id, session.guestId);
  const dir = eventDayDir(event.slug, day, 'originals');
  const filename = await uniqueFilename(
    dir,
    buildFilename({
      guestId: session.guestId,
      label: membership?.displayName,
      ext: session.ext,
      at,
    }),
  );

  const finalAbs = path.join(dir, filename);

  // ⚠️ 同盘 rename 是原子的，且不会复制数据。
  // 这也是为什么 tmp/ 必须和 events/ 在同一个文件系统上。
  try {
    await fsp.rename(assembled, finalAbs);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // 跨设备说明部署出了问题（tmp 被挪到别的挂载点了）。
      // 回退成拷贝，同时明确报出来——这是个应当被修掉的部署错误。
      console.warn(
        '[upload] tmp 与 events 不在同一文件系统，回退为跨设备拷贝。' +
          '这会让大文件合并变慢，请检查 DATA_ROOT 的挂载配置。',
      );
      await fsp.copyFile(assembled, finalAbs);
      await fsp.rm(assembled, { force: true });
    } else {
      throw err;
    }
  }

  const relPath = toRel(finalAbs);
  const mediaId = newMediaId();

  // --- 入库 --------------------------------------------------------------
  // 媒体记录和计数必须同一个事务：分开写会出现「列表里多了 1 张，
  // 但配额没涨」的漂移，而这种漂移只会越积越大。
  tx(() => {
    mediaRepo.create({
      id: mediaId,
      eventId: event.id,
      guestId: session.guestId,
      kind: session.kind,
      ext: session.ext,
      mime: session.mime,
      bytes: receivedBytes,
      sha256: session.declaredSha256,
      relPath,
      status: 'processing',
      needsTranscode: looksNeedsTranscode(session.ext),
      secStatus: 'pending',
      clientTakenAt: null,
      deviceInfo: null,
      sourceIp: sourceIp ?? null,
    });

    eventGuestsRepo.bumpCounters(event.id, session.guestId, receivedBytes);
    uploadSessionsRepo.setStatus(session.id, 'completed', mediaId);
  });

  await cleanupTmp(session.id);

  // 交给后台处理缩略图/封面。失败不影响这次上传的成功。
  enqueue(mediaId, processMedia);

  return { mediaId, alreadyCompleted: false };
}

/**
 * 按序把分片流式追加成一个文件。
 *
 * 用 `pipeline(src, out, {end:false})` 逐片追加，最后再手动 end()——
 * 这样内存占用是一片的流缓冲，不会把整个文件读进内存。
 */
async function assembleParts(session, destPath) {
  const out = fs.createWriteStream(destPath);

  try {
    for (let partNo = 1; partNo <= session.totalParts; partNo += 1) {
      const src = partPath(session.id, partNo);
      await pipeline(fs.createReadStream(src), out, { end: false });
    }
  } catch (err) {
    out.destroy();
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw err;
  }

  // 关闭写入流，并等它真正 flush 到磁盘
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });
}

/** 删掉这个会话的临时目录 */
export async function cleanupTmp(sessionId) {
  await fsp.rm(uploadTmpDir(sessionId), { recursive: true, force: true }).catch(() => {});
}

/**
 * 放弃上传：清掉临时文件，删掉会话。
 * 已经 completed 的会话不能这样放弃。
 */
export async function abortUpload(session) {
  await cleanupTmp(session.id);
  if (session.status === 'completed') {
    throw conflict('该上传已完成，无法放弃');
  }
  uploadSessionsRepo.remove(session.id);
}

/** 供路由层复用的查询：按 (id, guestId) 取会话，取不到就是 404 */
export function getOwnedSession(id, guestId) {
  const session = uploadSessionsRepo.findOwned({ id, guestId });
  if (!session) throw notFound('上传会话不存在');
  return session;
}
