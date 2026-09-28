/**
 * 图片衍生物：缩略图（网格用）和预览图（看大图用）。
 *
 * 为什么要 preview 而不用原图看：一张 12MB 的 iPhone 原图，
 * 在 4G 上为了「看一眼」而下完是不可接受的。长边 1600 的预览图
 * 通常 200–400KB，体验差别巨大。
 *
 * HEIC 的处理策略（这是 iPhone 用户的必经之路）：
 *   sharp 的预编译 libvips **不保证**能解 HEIC（取决于打包时有没有带 libheif）。
 *   解不了就回退 ffmpeg —— Debian 的 ffmpeg 包带 libheif。
 *   两边都失败就**不生成缩略图**，前端显示占位图标。
 *
 *   ★ 无论哪条路径失败，**原图都是逐字节原样保存的**。
 *     缩略图只是显示层的事，不影响数据完整性。这是本项目的核心保证之一。
 */
import fsp from 'node:fs/promises';
import sharp from 'sharp';
import { convertImageToJpeg } from './videoPoster.js';

export const THUMB_EDGE = 480;
export const PREVIEW_EDGE = 1600;

/** sharp 是否可用。libvips 缺失时整个模块都不可用，探测一次即可。 */
let sharpUsable = null;

async function checkSharp() {
  if (sharpUsable !== null) return sharpUsable;
  try {
    // 用一个 1x1 的最小 PNG 试一下，能跑通说明 libvips 加载正常
    const probe = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await sharp(probe).resize(1, 1).toBuffer();
    sharpUsable = true;
  } catch {
    sharpUsable = false;
  }
  return sharpUsable;
}

/** 测试用 */
export function resetSharpCache() {
  sharpUsable = null;
}

/**
 * 生成图片的缩略图和预览图。
 *
 * @param {string} srcAbs 原图绝对路径
 * @param {{thumbAbs: string, previewAbs: string}} dest
 * @returns {Promise<{
 *   ok: boolean, width: number|null, height: number|null,
 *   thumb: boolean, preview: boolean, reason?: string, via?: string
 * }>}
 */
export async function generateImageDerivatives(srcAbs, { thumbAbs, previewAbs }) {
  if (await checkSharp()) {
    const viaSharp = await trySharp(srcAbs, { thumbAbs, previewAbs });
    if (viaSharp.ok) return viaSharp;
    // 走到这里通常是 HEIC —— 换 ffmpeg 再试
    const viaFfmpeg = await tryFfmpeg(srcAbs, { thumbAbs, previewAbs });
    return { ...viaFfmpeg, reason: viaSharp.reason };
  }

  // 连 sharp 都加载不了（libvips 缺失），直接走 ffmpeg
  return tryFfmpeg(srcAbs, { thumbAbs, previewAbs });
}

async function trySharp(srcAbs, { thumbAbs, previewAbs }) {
  try {
    const meta = await sharp(srcAbs).metadata();
    const width = meta.width ?? null;
    const height = meta.height ?? null;

    // .rotate() 不带参数 = 按 EXIF 方向自动转正。
    // 手机拍的竖图不加这一步会显示成横的。
    // 不调 withMetadata()，衍生物里就不带 EXIF —— 顺手剥掉了 GPS 坐标。
    await sharp(srcAbs)
      .rotate()
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78, progressive: true })
      .toFile(thumbAbs);

    await sharp(srcAbs)
      .rotate()
      .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true })
      .toFile(previewAbs);

    return { ok: true, width, height, thumb: true, preview: true, via: 'sharp' };
  } catch (err) {
    return {
      ok: false,
      width: null,
      height: null,
      thumb: false,
      preview: false,
      reason: err?.message ?? 'sharp 处理失败',
      via: 'sharp',
    };
  }
}

async function tryFfmpeg(srcAbs, { thumbAbs, previewAbs }) {
  const thumb = await convertImageToJpeg(srcAbs, thumbAbs, { maxEdge: THUMB_EDGE });

  // 预览图失败不算致命——有缩略图就够网格显示了
  let preview = { ok: false };
  if (thumb.ok) {
    preview = await convertImageToJpeg(srcAbs, previewAbs, { maxEdge: PREVIEW_EDGE });
  }

  return {
    ok: thumb.ok,
    // ffmpeg 这条路拿不到原始尺寸（要另跑 ffprobe，不值得为一张图多起一个进程）
    width: null,
    height: null,
    thumb: thumb.ok,
    preview: preview.ok,
    via: 'ffmpeg',
    ...(thumb.ok ? {} : { reason: thumb.reason ?? 'ffmpeg 转换失败' }),
  };
}

/**
 * 清理没生成成功的衍生物文件。
 * 失败时留个 0 字节文件在磁盘上很讨厌——它会被当成「有缩略图」。
 */
export async function cleanupFailedDerivatives(paths) {
  await Promise.all(
    paths.filter(Boolean).map((p) => fsp.rm(p, { force: true }).catch(() => {})),
  );
}
