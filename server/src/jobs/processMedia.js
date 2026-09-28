/**
 * 处理一条媒体：生成缩略图/预览/视频封面，探测元数据，跑内容安全。
 *
 * ★ 铁律：**处理失败绝不能让上传失败，也不能让素材消失。**
 *   原文件在入库前就已经逐字节校验并安全落盘了。缩略图只是显示层的事。
 *   所以这里的失败路径一律是「保持 status='ready'，缩略图为空，
 *   把原因记进 fail_reason」——宾客照样能看到自己传的东西（退化成占位图），
 *   主持人照样能下载原片。`status='failed'` 留给「媒体本身不可用」，
 *   而上传阶段的 magic bytes 校验已经基本排除了那种情况。
 */
import fsp from 'node:fs/promises';
import { dirname } from 'node:path';

import { toAbs, derivativePaths } from '../services/storage.js';
import { generateImageDerivatives } from '../services/thumbnails.js';
import { extractPoster } from '../services/videoPoster.js';
import { probe } from '../services/videoProbe.js';
import { checkImage } from '../services/contentSecurity.js';
import * as mediaRepo from '../repositories/media.repo.js';

/**
 * @param {string} mediaId
 */
export async function processMedia(mediaId) {
  const media = mediaRepo.findById(mediaId);

  // 上传后立刻被删掉的情况
  if (!media) return;
  if (media.status === 'deleted' || media.status === 'blocked') return;

  const rel = media.paths.original;
  if (!rel) {
    mediaRepo.updateStatus(mediaId, 'ready', '原图路径缺失，无法处理');
    return;
  }

  const paths = derivativePaths(rel);
  const abs = {
    original: toAbs(rel),
    thumb: toAbs(paths.thumbs),
    preview: toAbs(paths.previews),
    poster: toAbs(paths.posters),
  };

  // 衍生物目录可能还没建（活动是新的）
  await Promise.all([
    fsp.mkdir(dirname(abs.thumb), { recursive: true }),
    fsp.mkdir(dirname(abs.preview), { recursive: true }),
    fsp.mkdir(dirname(abs.poster), { recursive: true }),
  ]);

  const updates = {
    thumbPath: null,
    previewPath: null,
    posterPath: null,
    width: null,
    height: null,
    durationMs: null,
    needsTranscode: undefined,
  };

  /** @type {string[]} */
  const problems = [];

  if (media.kind === 'image') {
    const r = await generateImageDerivatives(abs.original, {
      thumbAbs: abs.thumb,
      previewAbs: abs.preview,
    });

    if (r.thumb) updates.thumbPath = paths.thumbs;
    if (r.preview) updates.previewPath = paths.previews;
    updates.width = r.width;
    updates.height = r.height;

    if (!r.ok) {
      problems.push(`缩略图生成失败（${r.via}）：${r.reason ?? '未知原因'}`);
    }
  } else if (media.kind === 'video') {
    // 元数据探测：很便宜，永远做
    const meta = await probe(abs.original);
    if (meta) {
      updates.width = meta.width;
      updates.height = meta.height;
      updates.durationMs = meta.durationMs;
      updates.needsTranscode = meta.needsTranscode;
    } else {
      problems.push('ffprobe 无法读取视频元数据');
    }

    // 封面帧：抽一帧，不转码
    const poster = await extractPoster(abs.original, abs.poster);
    if (poster.ok) {
      updates.posterPath = paths.posters;
    } else {
      problems.push(`封面抽取失败：${poster.reason ?? '未知原因'}`);
    }
  }

  // 写回衍生物信息。即使部分失败也要写——成功的那部分要生效。
  mediaRepo.updateDerivatives(mediaId, updates);

  // --- 内容安全（异步、不阻塞、失败放行）--------------------------------
  if (media.kind === 'image' && updates.thumbPath) {
    const verdict = await runImageSecurityCheck(abs.thumb);
    mediaRepo.updateSecurity(mediaId, { status: verdict.status, label: verdict.label });

    if (verdict.status === 'risky') {
      // 命中违规：隐藏但**不删文件**，留作证据
      await handleRisky(mediaId, rel, paths);
      return;
    }
  } else {
    // 视频检测依赖 media_check_async，其当前形态与类目开放范围都不确定，
    // 先标记 skipped 并依靠「私有可见 + 人工审核 + 举报入口」兜住。
    mediaRepo.updateSecurity(mediaId, {
      status: 'skipped',
      label: null,
    });
  }

  mediaRepo.updateStatus(mediaId, 'ready', problems.length ? problems.join('；') : null);
}

/**
 * 把缩略图读出来送检。
 * 缩略图恰好满足「≤750px、远小于 1MB」两个要求，所以直接用它，不用另压一份。
 */
async function runImageSecurityCheck(thumbAbs) {
  try {
    const buf = await fsp.readFile(thumbAbs);
    return await checkImage(buf);
  } catch (err) {
    return { status: 'error', label: null, detail: err?.message ?? '读取缩略图失败' };
  }
}

/**
 * 命中违规内容的处理：移进 blocked/ 目录、标记状态。
 *
 * 刻意**不删除**——万一是误判，人工复核时还需要原图；
 * 而且保留证据在应对监管问询时是必要的。
 */
async function handleRisky(mediaId, originalRel, paths) {
  const parts = paths.originals.split('/');
  const eventRoot = parts.slice(0, -2).join('/');
  const blockedDir = `${eventRoot}/blocked`;

  try {
    await fsp.mkdir(toAbs(blockedDir), { recursive: true });
    const base = originalRel.slice(originalRel.lastIndexOf('/') + 1);
    await fsp.rename(toAbs(originalRel), toAbs(`${blockedDir}/${base}`)).catch(() => {});
  } catch (err) {
    console.warn(`[media] 移动违规素材失败：${err?.message}`);
  }

  mediaRepo.updateStatus(mediaId, 'blocked', '内容安全检测未通过');
}

/** 队列使用的处理器签名 */
export default processMedia;
