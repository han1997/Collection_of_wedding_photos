/**
 * 处理队列：进程内，并发受控，状态落数据库。
 *
 * 为什么不开第二个 worker 容器：瓶颈就是那个弱 CPU，并发 1 已经把它用满；
 * 多一个容器只是多一处会坏的地方。
 *
 * 为什么不需要 Redis/BullMQ：**持久性靠 media.status 字段，不靠队列本身**。
 * 进程重启时把 status='processing' 的全部重新入队即可（见 recoverOnBoot）。
 * 队列只是「谁来干、同时干几个」的调度器，丢了可以重建。
 */
import pLimit from 'p-limit';
import config from '../config.js';

/** @type {import('p-limit').LimitFunction} */
const limit = pLimit(config.media.thumbConcurrency);

let running = 0;
let queued = 0;
let completed = 0;
let failed = 0;

/** 已经排进队列的 id，避免重复入队 */
const scheduled = new Set();

/**
 * 把一个媒体处理任务排进队列。
 *
 * 重复入队同一 id 会被忽略——这很重要，因为启动恢复和上传完成
 * 可能同时想处理同一条记录。
 *
 * @param {string} mediaId
 * @param {(id: string) => Promise<void>} handler
 */
export function enqueue(mediaId, handler) {
  if (scheduled.has(mediaId)) return;
  scheduled.add(mediaId);
  queued += 1;

  limit(async () => {
    running += 1;
    queued -= 1;
    try {
      await handler(mediaId);
      completed += 1;
    } catch (err) {
      failed += 1;
      // 处理失败**绝不能**让上传失败：媒体本身已经安全落盘了，
      // 缩略图只是锦上添花。这里只记日志，由 handler 自己决定要不要标 failed。
      console.error(`[queue] 处理 ${mediaId} 失败：`, err?.message);
    } finally {
      running -= 1;
      scheduled.delete(mediaId);
    }
  });
}

export function stats() {
  return { running, queued, completed, failed, concurrency: config.media.thumbConcurrency };
}

/**
 * 等队列排空。测试和优雅关闭时用。
 */
export async function drain() {
  while (running > 0 || queued > 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
}
