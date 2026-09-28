/**
 * 微信登录：小程序 wx.login() 拿到的 code 换 openid。
 *
 * ⚠️ 实现前已核对过的点：
 *   · 微信这个接口**即使出错也返回 HTTP 200**，错误码在 body 的 errcode 里。
 *     只看 HTTP 状态码会把失败当成成功。
 *   · session_key 我们**拿到就丢**。本服务不解密任何东西（getUserProfile
 *     自 2022 年起也只返回匿名数据），留着它是纯负担。
 *     正因为不碰 session_key，我们也就不需要处理它过期换发的那套复杂逻辑。
 */
import config from '../config.js';
import { AppError, ErrorCode, wechatError } from '../lib/errors.js';

const JSCODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';
const TIMEOUT_MS = 8000;

/** 这些错误码是「用户/参数问题」，重试没有意义，直接告诉客户端重新登录 */
const FATAL_CODES = new Set([40029, 40163, 40013, 41008, 40125]);

/**
 * @param {string} code wx.login() 返回的 code
 * @returns {Promise<{openid: string, unionid?: string}>}
 */
export async function code2Session(code) {
  if (!config.wechat.configured) {
    throw new AppError(
      ErrorCode.WECHAT_ERROR,
      '服务端尚未配置微信 AppID / AppSecret',
      { status: 503 },
    );
  }

  if (typeof code !== 'string' || code.length === 0) {
    throw wechatError('登录 code 不合法');
  }

  const url =
    `${JSCODE2SESSION_URL}?appid=${encodeURIComponent(config.wechat.appId)}` +
    `&secret=${encodeURIComponent(config.wechat.secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    '&grant_type=authorization_code';

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw wechatError('无法连接微信服务器，请稍后重试', { cause: err?.message });
  }

  if (!res.ok) {
    throw wechatError(`微信服务器返回 HTTP ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw wechatError('微信返回的内容无法解析');
  }

  // 注意：出错时 HTTP 仍是 200，必须看 errcode
  if (body.errcode) {
    const msg = `微信登录失败（${body.errcode}）：${body.errmsg ?? '未知原因'}`;
    if (FATAL_CODES.has(body.errcode)) {
      throw new AppError(ErrorCode.UNAUTHORIZED, msg);
    }
    throw wechatError(msg);
  }

  if (typeof body.openid !== 'string' || body.openid.length === 0) {
    throw wechatError('微信没有返回 openid');
  }

  // session_key 故意不返回、不存储
  return {
    openid: body.openid,
    ...(body.unionid ? { unionid: String(body.unionid) } : {}),
  };
}
