/**
 * 媒体元数据探测（ffprobe）。
 *
 * 只读元数据，不解码画面——这一步很便宜，任何视频都可以无条件跑。
 * 真正贵的是转码，那个我们默认不做（见 jobs/processMedia.js 的说明）。
 */
import config from '../config.js';
import { isAvailable, run } from '../lib/exec.js';

/** 启动时探测一次，之后复用。缺 ffmpeg 的环境（比如没装的开发机）走降级路径。 */
let availability = null;

/**
 * 探测 ffmpeg / ffprobe 是否可用。结果会缓存。
 * @returns {Promise<{ffmpeg: boolean, ffprobe: boolean}>}
 */
export async function checkTooling() {
  if (availability) return availability;
  const [ffmpeg, ffprobe] = await Promise.all([
    isAvailable(config.media.ffmpegPath),
    isAvailable(config.media.ffprobePath),
  ]);
  availability = { ffmpeg, ffprobe };
  return availability;
}

/** 测试用：清掉缓存 */
export function resetToolingCache() {
  availability = null;
}

/**
 * 探测一个媒体文件。
 *
 * @param {string} absPath
 * @returns {Promise<null | {
 *   durationMs: number|null, width: number|null, height: number|null,
 *   rotation: number, videoCodec: string|null, audioCodec: string|null,
 *   formatName: string|null, needsTranscode: boolean
 * }>}
 */
export async function probe(absPath) {
  const { ffprobe } = await checkTooling();
  if (!ffprobe) return null;

  let stdout;
  try {
    const res = await run(
      config.media.ffprobePath,
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        absPath,
      ],
      { timeoutMs: 30_000 },
    );
    if (res.code !== 0) return null;
    stdout = res.stdout.toString('utf8');
  } catch {
    return null;
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video) return null;

  const width = num(video.width);
  const height = num(video.height);
  const rotation = readRotation(video);

  // 时长优先取 format 的（对某些容器更准），退回 stream 的
  const durationSec = num(data.format?.duration) ?? num(video.duration);
  const durationMs = durationSec === null ? null : Math.round(durationSec * 1000);

  const videoCodec = video.codec_name ?? null;

  return {
    durationMs,
    width,
    height,
    rotation,
    videoCodec,
    audioCodec: audio?.codec_name ?? null,
    formatName: data.format?.format_name ?? null,
    // HEVC/H.265 在部分安卓微信里会黑屏，标出来让前端给「下载原片」的降级入口
    needsTranscode: isProblematicCodec(videoCodec),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 读取旋转角度。
 * 手机竖着拍的视频会带一个旋转元数据，不处理的话封面会是横的。
 * ffprobe 在不同版本里把它放在两个地方，都要看。
 */
function readRotation(videoStream) {
  const fromTags = num(videoStream.tags?.rotate);
  if (fromTags !== null) return ((Math.round(fromTags) % 360) + 360) % 360;

  const sideData = videoStream.side_data_list;
  if (Array.isArray(sideData)) {
    for (const sd of sideData) {
      if (sd.rotation !== undefined) {
        const r = num(sd.rotation);
        if (r !== null) return ((Math.round(r) % 360) + 360) % 360;
      }
    }
  }
  return 0;
}

/**
 * 这些编码在安卓微信的 `<video>` 里经常黑屏有声。
 * 我们**不为此转码**（弱 NAS 上代价太大），只标记出来让 UI 降级展示。
 */
function isProblematicCodec(codec) {
  if (!codec) return false;
  return ['hevc', 'h265', 'av1'].includes(codec.toLowerCase());
}
