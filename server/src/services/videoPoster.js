/**
 * 视频封面帧抽取。
 *
 * ★ 只抽一帧，**不转码**。
 *   弱 NAS 上转码 1080p 大约只有 0.2–0.5 倍速，一个 3 分钟的 4K 片段
 *   会把 CPU 钉住半小时以上——而那时别的宾客还在上传。
 *   抽帧是毫秒级的事，转码不是。
 */
import fsp from 'node:fs/promises';
import config from '../config.js';
import { run } from '../lib/exec.js';
import { checkTooling } from './videoProbe.js';

/**
 * 从视频里抽一帧当封面。
 *
 * @param {string} srcAbs 视频绝对路径
 * @param {string} destAbs 输出 JPEG 绝对路径
 * @param {{maxEdge?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function extractPoster(srcAbs, destAbs, opts = {}) {
  const { ffmpeg } = await checkTooling();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg 不可用' };

  const maxEdge = opts.maxEdge ?? 480;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // 先试第 1 秒的位置：正片开头常是黑场或纯色，抽第 0 帧往往得到一张黑图。
  // 前向 seek（-ss 在 -i 之前）是快速的，不需要解码到那个位置。
  if (await tryFrame(srcAbs, destAbs, 1, maxEdge, timeoutMs)) {
    return { ok: true };
  }

  // 兜底：不足 1 秒的短片，或者 seek 失败
  if (await tryFrame(srcAbs, destAbs, 0, maxEdge, timeoutMs)) {
    return { ok: true };
  }

  return { ok: false, reason: '无法抽取封面帧（视频可能损坏或格式不受支持）' };
}

async function tryFrame(srcAbs, destAbs, seekSec, maxEdge, timeoutMs) {
  // ⚠️ -nostdin 是必须的：否则 ffmpeg 在某些情况下会等标准输入而挂住
  const args = [
    '-nostdin',
    '-y',
    '-loglevel', 'error',
    ...(seekSec > 0 ? ['-ss', String(seekSec)] : []),
    '-i', srcAbs,
    '-frames:v', '1',
    // 长边缩到 maxEdge，另一边按比例；-2 保证是偶数（编码器要求）
    '-vf', `scale='min(${maxEdge},iw)':-2`,
    // 抽帧的输出质量。取 4 比默认好一些，体积仍然很小。
    '-q:v', '4',
    destAbs,
  ];

  try {
    const res = await run(config.media.ffmpegPath, args, { timeoutMs });
    if (res.code !== 0) return false;
  } catch {
    return false;
  }

  // ffmpeg 返回 0 但没产出文件的情况是存在的（比如源文件没有视频轨）
  try {
    const st = await fsp.stat(destAbs);
    if (st.size === 0) {
      await fsp.rm(destAbs, { force: true });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 用 ffmpeg 把一个静态图片转成 JPEG 缩略图。
 *
 * 专门用于 **sharp 搞不定的格式**，最主要就是 iPhone 的 HEIC。
 * Debian 的 ffmpeg 包带 libheif，所以这条回退是真的能用的。
 *
 * @param {string} srcAbs
 * @param {string} destAbs
 * @param {{maxEdge?: number, timeoutMs?: number}} [opts]
 */
export async function convertImageToJpeg(srcAbs, destAbs, opts = {}) {
  const { ffmpeg } = await checkTooling();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg 不可用' };

  const maxEdge = opts.maxEdge ?? 480;

  const args = [
    '-nostdin',
    '-y',
    '-loglevel', 'error',
    '-i', srcAbs,
    '-frames:v', '1',
    '-vf', `scale='min(${maxEdge},iw)':-2`,
    '-q:v', '4',
    destAbs,
  ];

  try {
    const res = await run(config.media.ffmpegPath, args, { timeoutMs: opts.timeoutMs ?? 60_000 });
    if (res.code !== 0) return { ok: false, reason: `ffmpeg 退出码 ${res.code}` };
  } catch (err) {
    return { ok: false, reason: err?.message ?? 'ffmpeg 执行失败' };
  }

  try {
    const st = await fsp.stat(destAbs);
    if (st.size === 0) {
      await fsp.rm(destAbs, { force: true });
      return { ok: false, reason: '输出为空' };
    }
  } catch {
    return { ok: false, reason: '没有产出文件' };
  }

  return { ok: true };
}
