/**
 * 媒体文件签名 URL。
 *
 * 为什么不用「不可猜的裸 URL」：媒体地址会通过微信转发、截图、复制粘贴泄露出去。
 * nanoid 确实难猜，但**它是永久的**——一旦泄露就是永久公开。
 * 签名 URL 带过期时间，把暴露面限制在一个时间窗内。
 *
 * 为什么必须走 query 参数而不是 Authorization 头：
 * 小程序的 `<image src>` 和 `<video src>` **不支持自定义请求头**。
 * 所以签名只能放在 URL 上。
 *
 * 格式：<base64url(载荷JSON)>.<base64url(HMAC-SHA256)>
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import config from '../config.js';

const secret = config.secrets.fileToken;

/** 变体 → 对应的 DB 字段。original 是原图，其余是衍生物。 */
export const VARIANTS = {
  original: 'rel_path',
  preview: 'preview_path',
  thumb: 'thumb_path',
  poster: 'poster_path',
  playable: 'playable_path',
};

/** 看图的时效。够长到不会在浏览过程中失效，够短到泄露后很快过期。 */
export const VIEW_TTL_MS = 2 * 60 * 60 * 1000;
/** 下载的时效。下载是一次性动作，不需要那么长。 */
export const DOWNLOAD_TTL_MS = 15 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * 签发文件令牌。
 *
 * @param {object} opts
 * @param {string} opts.mediaId
 * @param {string} opts.variant 见 VARIANTS
 * @param {boolean} [opts.download] 是否作为附件下载
 * @param {number|'a'} opts.guestId 持有者；管理员用 'a'
 * @param {number} [opts.ttlMs]
 * @returns {string}
 */
export function signFileToken({ mediaId, variant, download = false, guestId, ttlMs }) {
  if (!VARIANTS[variant]) throw new Error(`未知的变体：${variant}`);

  const ttl = ttlMs ?? (download ? DOWNLOAD_TTL_MS : VIEW_TTL_MS);
  const payload = {
    m: mediaId,
    v: variant,
    d: download ? 1 : 0,
    e: Math.floor((Date.now() + ttl) / 1000),
    g: guestId,
  };

  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * 校验文件令牌。
 *
 * 只用 timingSafeEqual 比较签名——普通的字符串比较会在第一个不同的字节处返回，
 * 理论上可以被用来逐字节爆破出正确签名。
 *
 * @param {string} token
 * @returns {{m: string, v: string, d: number, e: number, g: number|'a'}} 校验通过返回载荷
 * @throws {Error} 任何不合法的情况
 */
export function verifyFileToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    throw new Error('令牌格式不合法');
  }

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    throw new Error('令牌格式不合法');
  }

  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(payloadB64);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('签名不匹配');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('载荷无法解析');
  }

  if (typeof payload?.m !== 'string' || typeof payload?.v !== 'string') {
    throw new Error('载荷字段缺失');
  }
  if (!VARIANTS[payload.v]) {
    throw new Error('未知的变体');
  }
  if (typeof payload.e !== 'number' || payload.e * 1000 <= Date.now()) {
    throw new Error('令牌已过期');
  }
  if (payload.g !== 'a' && !Number.isInteger(payload.g)) {
    throw new Error('持有者字段不合法');
  }

  return payload;
}

/**
 * 拼出完整的对外 URL。
 * 用 mediaBaseUrl 而不是 publicBaseUrl —— 媒体可以单独走一个域名
 * （比如绕开 Cloudflare 对视频流量的限制）。
 * @param {string} token
 */
export function fileUrl(token) {
  return `${config.mediaBaseUrl}/f/${token}`;
}
