/**
 * 内容安全检测。
 *
 * ⚠️ 微信这套接口的名称与形态变过几轮，本项目的开发环境访问不了官方文档。
 *    **上线前必须对照 developers.weixin.qq.com 核对**：
 *      · `img_sec_check`（同步，图片 ≤1MB）是否仍可用、路径是否仍是 /wxa/img_sec_check
 *      · 命中违规的 errcode 是否为 87014
 *      · 视频的 `media_check_async` 当前形态与类目开放范围
 *    这里把接口收敛在**一个文件**里，核对后要改只改这一处。
 *
 * 设计取向：**失败放行（fail-open）**。
 * 理由是内容本来就只对上传者本人和主持人可见，没有公开广场；
 * 若改成失败拦截，微信接口一抖动，宾客的照片就传不上来了——
 * 在婚礼现场那是灾难性的，而它挡住的风险并不存在。
 */
import config from '../config.js';
import { getAccessToken } from './accessToken.js';

const IMG_SEC_CHECK_URL = 'https://api.weixin.qq.com/wxa/img_sec_check';
const MSG_SEC_CHECK_URL = 'https://api.weixin.qq.com/wxa/msg_sec_check';
const TIMEOUT_MS = 10_000;

/** 违规内容的 errcode */
const RISKY_CODES = new Set([87014]);

const results = {
  PASS: 'pass',
  RISKY: 'risky',
  ERROR: 'error',
  SKIPPED: 'skipped',
};

/**
 * 图片内容检测。
 *
 * 送检的永远是**压缩过的缩略图**，不是原图：
 *   ① 接口有 1MB 上限，原图必然超
 *   ② 也省流量和时间
 *
 * @param {Buffer} jpegBuffer 已经压到 1MB 以内的 JPEG
 * @returns {Promise<{status: string, label: number|null, detail: string|null}>}
 */
export async function checkImage(jpegBuffer) {
  if (!config.contentCheck.enabled) {
    return { status: results.SKIPPED, label: null, detail: '内容检测已关闭' };
  }
  if (!config.wechat.configured) {
    return { status: results.SKIPPED, label: null, detail: '未配置微信凭据' };
  }
  if (!Buffer.isBuffer(jpegBuffer) || jpegBuffer.length === 0) {
    return { status: results.SKIPPED, label: null, detail: '没有可送检的图片' };
  }
  if (jpegBuffer.length > 1024 * 1024) {
    return { status: results.SKIPPED, label: null, detail: '送检图片超过 1MB' };
  }

  try {
    const token = await getAccessToken();
    const form = buildMultipart({ name: 'media', filename: 'check.jpg', contentType: 'image/jpeg', data: jpegBuffer });

    const res = await fetch(`${IMG_SEC_CHECK_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
      body: form.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await res.json().catch(() => null);
    if (!body) return { status: results.ERROR, label: null, detail: '响应无法解析' };

    if (RISKY_CODES.has(body.errcode)) {
      return { status: results.RISKY, label: body.errcode, detail: '内容涉嫌违规' };
    }
    if (body.errcode === 0) {
      return { status: results.PASS, label: 0, detail: null };
    }

    return { status: results.ERROR, label: body.errcode ?? null, detail: body.errmsg ?? '未知错误' };
  } catch (err) {
    // 网络抖动、token 失效、微信改接口……一律放行
    return { status: results.ERROR, label: null, detail: err?.message ?? '调用失败' };
  }
}

/**
 * 文本内容检测（用于「怎么称呼您」这类自由输入）。
 * @param {string} text
 */
export async function checkText(text) {
  if (!config.contentCheck.enabled || !config.wechat.configured) {
    return { status: results.SKIPPED, label: null, detail: null };
  }
  const content = String(text ?? '').trim();
  if (!content) return { status: results.SKIPPED, label: null, detail: '空文本' };

  try {
    const token = await getAccessToken();
    const res = await fetch(`${MSG_SEC_CHECK_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, scene: 2, content }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await res.json().catch(() => null);
    if (!body) return { status: results.ERROR, label: null, detail: '响应无法解析' };

    if (RISKY_CODES.has(body.errcode)) {
      return { status: results.RISKY, label: body.errcode, detail: '文本涉嫌违规' };
    }
    if (body.errcode === 0) return { status: results.PASS, label: 0, detail: null };

    return { status: results.ERROR, label: body.errcode ?? null, detail: body.errmsg ?? '未知错误' };
  } catch (err) {
    return { status: results.ERROR, label: null, detail: err?.message ?? '调用失败' };
  }
}

/**
 * 手搓 multipart/form-data。
 *
 * 只为这一个接口引一个 multipart 库不划算（而且这个接口的形态还可能变）。
 * 内容是我们自己构造的固定结构，不涉及用户输入，所以拼接是安全的。
 */
function buildMultipart({ name, filename, contentType, data }) {
  const boundary = `----weddingcollect${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { boundary, body: Buffer.concat([head, data, tail]) };
}

export { results as ContentCheckResult };
