/**
 * 活动二维码生成。
 *
 * 两条路径：
 *
 * ① 小程序码（wxacode.getUnlimited）—— 首选。
 *    宾客用微信扫一扫直接打开小程序并落到对应活动，一步到位。
 *
 * ② 本地生成的普通二维码 —— 兜底。
 *    内容是 H5 落地页地址。什么时候会走到这条路：
 *      · 还没配 AppID / AppSecret
 *      · 小程序尚未发布（此时生成的小程序码扫出来是白屏）
 *      · 微信接口额度用尽或调用失败
 *    普通二维码永远可用、不依赖微信接口。
 *
 * ⚠️ 需要对照文档核实的点（本项目开发环境访问不了微信文档）：
 *    · getUnlimited 的 env_version 取值与含义
 *    · check_path 的默认值与影响（未发布页面需要设 false）
 *    · scene 的字符集限制与长度上限（官方是 32 字符）
 *    · 日调用量上限
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';

import config from '../config.js';
import { toRel } from './storage.js';
import { getAccessToken } from './accessToken.js';

const GET_UNLIMITED_URL = 'https://api.weixin.qq.com/wxa/getwxacodeunlimit';
const TIMEOUT_MS = 15_000;

/**
 * 生成（或从缓存取）一个活动的二维码。
 *
 * @param {{id: string, slug: string}} event
 * @param {{envVersion?: string, force?: boolean}} [opts]
 * @returns {Promise<{relPath: string, mode: 'wxa'|'fallback', envVersion: string|null, bytes: number}>}
 */
export async function generateEventQr(event, opts = {}) {
  const envVersion = opts.envVersion || config.wechat.envVersion;

  // 缓存文件名带上 env_version：同一个活动在开发版和正式版下
  // 需要的是**不同**的码，混用会让主持人印出一批扫不开的二维码。
  const fileName = `${event.id}.${envVersion}.png`;
  const absPath = path.join(config.paths.qrCache, fileName);

  if (!opts.force) {
    const cached = await readIfExists(absPath);
    if (cached) {
      return {
        relPath: toRel(absPath),
        mode: 'wxa',
        envVersion,
        bytes: cached.length,
      };
    }
  }

  // --- 首选：小程序码 -------------------------------------------------------
  if (config.wechat.configured) {
    try {
      const png = await fetchUnlimitedCode(event.id, envVersion);
      await fsp.mkdir(config.paths.qrCache, { recursive: true });
      await fsp.writeFile(absPath, png);
      return { relPath: toRel(absPath), mode: 'wxa', envVersion, bytes: png.length };
    } catch (err) {
      console.warn(`[qrcode] 小程序码生成失败，退回本地二维码：${err.message}`);
    }
  }

  // --- 兜底：本地生成的普通二维码 -------------------------------------------
  const fallbackName = `${event.id}.fallback.png`;
  const fallbackAbs = path.join(config.paths.qrCache, fallbackName);

  if (!opts.force) {
    const cached = await readIfExists(fallbackAbs);
    if (cached) {
      return { relPath: toRel(fallbackAbs), mode: 'fallback', envVersion: null, bytes: cached.length };
    }
  }

  const png = await renderLocalQr(event.id);
  await fsp.mkdir(config.paths.qrCache, { recursive: true });
  await fsp.writeFile(fallbackAbs, png);

  return { relPath: toRel(fallbackAbs), mode: 'fallback', envVersion: null, bytes: png.length };
}

async function readIfExists(p) {
  try {
    const st = await fsp.stat(p);
    if (st.isFile() && st.size > 0) return await fsp.readFile(p);
  } catch {
    // 不存在
  }
  return null;
}

/**
 * 调微信接口拿小程序码。
 *
 * ★ 这个接口**成功时返回 PNG 字节流，失败时返回 JSON**，而两者的
 *   HTTP 状态码都是 200。所以必须看 content-type —— 直接写文件的话，
 *   你会得到一个后缀是 .png、内容却是 {"errcode":...} 的「二维码」，
 *   而且要等主持人打印出来扫不开才会发现。
 */
async function fetchUnlimitedCode(eventId, envVersion) {
  const token = await getAccessToken();

  const body = {
    // ⚠️ scene 的字符集受限，绝不能放中文或 URL。
    //    10 位活动 id 加前缀是 12 字符，远低于 32 的上限。
    scene: `e=${eventId}`,
    page: config.wechat.qrPage,
    // 未发布的页面路径需要把 check_path 设成 false，否则会报错
    check_path: false,
    env_version: envVersion,
    width: 430,
    auto_color: false,
    is_hyaline: false,
  };

  let res;
  try {
    res = await fetch(`${GET_UNLIMITED_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`请求微信失败：${err?.message ?? err}`);
  }

  if (!res.ok) throw new Error(`微信返回 HTTP ${res.status}`);

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // ★ 先看类型再决定怎么读
  if (contentType.includes('application/json') || contentType.includes('text/plain')) {
    const errBody = await res.json().catch(() => null);
    const code = errBody?.errcode ?? 'unknown';
    const msg = errBody?.errmsg ?? '未知错误';

    // 凭据失效：清缓存后由 accessToken 层重试一次的机会留给下一次调用
    throw new Error(`微信返回错误 ${code}：${msg}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());

  // 再兜一层：PNG 的魔数必须匹配。微信偶尔会用别的 content-type 返回错误体。
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    const head = buf.subarray(0, 200).toString('utf8');
    throw new Error(`微信返回的不是 PNG：${head}`);
  }

  return buf;
}

/**
 * 本地渲染普通二维码，内容指向 H5 落地页。
 *
 * 这条路不依赖微信任何接口，所以**永远可用**——
 * 现场断网、额度用尽、小程序还没过审，都还能靠它把宾客引到 H5 页面上。
 */
async function renderLocalQr(eventId) {
  const url = `${config.publicBaseUrl}/e/${eventId}`;

  return QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'M',
    width: 430,
    margin: 2,
    color: { dark: '#1a1a1aff', light: '#ffffffff' },
  });
}

/** 供管理端下载时用：取二维码文件的绝对路径 */
export function qrAbsPath(relPath) {
  return path.join(config.dataRoot, ...relPath.split('/'));
}

/** 兜底二维码指向的 H5 地址（管理端要显示给主持人看） */
export function fallbackUrl(eventId) {
  return `${config.publicBaseUrl}/e/${eventId}`;
}
