/**
 * 微信 access_token 管理。
 *
 * ★ 单飞（single-flight）是这里的关键。
 *   微信在签发新 token 时会让**旧的立即失效**。如果两个请求同时发现
 *   token 过期、各自去刷新，就可能出现「A 刷新拿到 T2、B 刷新拿到 T3、
 *   但 A 把 T2 写回缓存」的竞态——于是缓存里躺着一个已失效的 token，
 *   之后所有调用都报 40001。用一个进程内的 promise 守住刷新过程即可。
 *
 * token 落在 kv 表里，进程重启不用重新拉。
 */
import config from '../config.js';
import { get, run } from '../db/index.js';
import { nowIso } from '../lib/time.js';
import { wechatError } from '../lib/errors.js';

const KV_KEY = 'wx_access_token';
const REFRESH_AHEAD_MS = 5 * 60 * 1000; // 提前 5 分钟刷新
const TIMEOUT_MS = 10_000;

/** 正在进行中的刷新，用于单飞 */
let inflight = null;

function readCache() {
  const row = get('SELECT v, expires_at FROM kv WHERE k = ?', [KV_KEY]);
  if (!row) return null;
  let parsed;
  try {
    parsed = JSON.parse(row.v);
  } catch {
    return null;
  }
  if (!parsed?.token || !parsed?.expiresAt) return null;
  return parsed;
}

function writeCache(token, expiresAt) {
  const now = nowIso();
  run(
    `INSERT INTO kv (k, v, expires_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    [KV_KEY, JSON.stringify({ token, expiresAt }), expiresAt, now],
  );
}

export function clearCache() {
  run('DELETE FROM kv WHERE k = ?', [KV_KEY]);
}

/**
 * 拿一个可用的 access_token。
 * @param {{force?: boolean}} [opts] force 用于遇到 40001/42001 后强制刷新（只重试一次）
 * @returns {Promise<string>}
 */
export async function getAccessToken({ force = false } = {}) {
  if (!config.wechat.configured) {
    throw wechatError('服务端未配置 WX_APPID / WX_SECRET');
  }

  if (!force) {
    const cached = readCache();
    if (cached && Date.parse(cached.expiresAt) - REFRESH_AHEAD_MS > Date.now()) {
      return cached.token;
    }
  }

  // 单飞：并发的调用者共享同一次刷新
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const url =
        'https://api.weixin.qq.com/cgi-bin/token' +
        `?grant_type=client_credential&appid=${encodeURIComponent(config.wechat.appId)}` +
        `&secret=${encodeURIComponent(config.wechat.secret)}`;

      let res;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        throw wechatError('无法连接微信服务器获取 access_token', { cause: err?.message });
      }

      if (!res.ok) throw wechatError(`微信返回 HTTP ${res.status}`);

      const body = await res.json().catch(() => null);
      if (!body) throw wechatError('access_token 响应无法解析');

      // 同样地：出错时 HTTP 仍是 200，必须看 errcode
      if (body.errcode) {
        throw wechatError(`获取 access_token 失败（${body.errcode}）：${body.errmsg ?? ''}`);
      }
      if (typeof body.access_token !== 'string') {
        throw wechatError('微信没有返回 access_token');
      }

      const expiresAt = new Date(Date.now() + (Number(body.expires_in) || 7200) * 1000).toISOString();
      writeCache(body.access_token, expiresAt);
      return body.access_token;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * 带自动重试地调用一个需要 access_token 的微信接口。
 *
 * 只在遇到「token 失效」类错误时清缓存重试一次——**绝不循环重试**，
 * 否则一个配错的 AppSecret 会变成无限循环打微信接口。
 *
 * @param {(token: string) => Promise<any>} fn 接收 token，返回微信的响应体
 */
export async function withAccessToken(fn) {
  let token = await getAccessToken();

  let body = await fn(token);
  if (!body?.errcode) return body;

  // 40001 凭据失效 / 42001 token 过期 / 40014 非法 token
  if ([40001, 42001, 40014].includes(body.errcode)) {
    clearCache();
    token = await getAccessToken({ force: true });
    body = await fn(token);
  }

  return body;
}
