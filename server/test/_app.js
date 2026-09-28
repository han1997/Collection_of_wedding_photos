/**
 * 集成测试用的公共装置：起应用、伪造微信、拿令牌、造测试文件。
 *
 * 之所以伪造 `globalThis.fetch` 而不是给 wechatAuth 打桩：
 * 这样连「微信出错也返回 HTTP 200，必须看 errcode」这条真实行为
 * 也一起被测到，而不用为了可测性去改动生产代码的形状。
 */
import './_setup.js';

import config from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seedInitialAdmin } from '../src/services/bootstrap.js';
import { ensureDataDirs } from '../src/services/storage.js';

let appPromise = null;

/** 起一次应用，之后复用（node:test 里多个用例共享同一个进程） */
export async function getApp() {
  if (appPromise) return appPromise;

  appPromise = (async () => {
    ensureDataDirs();
    openDb({ file: config.paths.dbFile });
    migrate({ log: () => {} });
    seedInitialAdmin({ log: () => {} });

    const app = await buildApp({ logger: false });
    await app.ready();
    return app;
  })();

  return appPromise;
}

export async function stopApp() {
  if (!appPromise) return;
  const app = await appPromise;
  await app.close();
  appPromise = null;
  closeDb();
}

// ---------------------------------------------------------------------------
// 伪造微信
// ---------------------------------------------------------------------------

let realFetch = null;

/**
 * 把 globalThis.fetch 换成一个假的微信。
 * code 就是 openid 的后缀：用 `wx-login('alice')` 之类的写法即可控制身份。
 * @param {{errcode?: number, errmsg?: string, mode?: 'ok'|'wechat-error'|'network'}} [opts]
 */
export function installFakeWechat(opts = {}) {
  if (!realFetch) realFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const u = String(url);

    if (!u.includes('jscode2session')) {
      throw new Error(`测试里不该请求这个地址：${u}`);
    }

    if (opts.mode === 'network') {
      throw new TypeError('fetch failed');
    }

    const code = new URL(u).searchParams.get('js_code') ?? '';

    if (opts.mode === 'wechat-error') {
      // 微信的真实行为：出错时 HTTP 仍是 200，错误在 body 的 errcode 里
      return jsonResponse({ errcode: opts.errcode ?? 40029, errmsg: opts.errmsg ?? 'invalid code' });
    }

    return jsonResponse({
      openid: `openid-${code}`,
      session_key: 'this-must-never-be-stored',
    });
  };
}

export function restoreFetch() {
  if (realFetch) {
    globalThis.fetch = realFetch;
    realFetch = null;
  }
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

export async function adminLogin(app, { username = 'admin', password = 'test-admin-password' } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username, password },
  });
  return { res, body: res.json() };
}

/**
 * 走完管理员的首次登录流程：初始密码 → 强制改密 → 拿到可用令牌。
 *
 * 之所以把这个流程固化成一个装置，是因为它就是真实上线时的路径：
 * 初始密码来自环境变量，属于临时密码，改掉之前所有管理接口都是 403。
 * 返回值把中间状态也带出来，好让用例去断言那些断言点。
 */
export async function bootstrapAdmin(app, {
  initialPassword = 'test-admin-password',
  newPassword = 'a-much-better-password',
} = {}) {
  const first = await adminLogin(app, { password: initialPassword });
  const initialToken = first.body.data.token;

  // 还没改密时，管理接口必须被拦住
  const blocked = await app.inject({
    method: 'GET',
    url: '/api/admin/events',
    headers: { authorization: `Bearer ${initialToken}` },
  });

  const changed = await app.inject({
    method: 'POST',
    url: '/api/admin/password',
    headers: { authorization: `Bearer ${initialToken}` },
    payload: { currentPassword: initialPassword, newPassword },
  });

  if (changed.statusCode !== 200) {
    throw new Error(`改密失败 ${changed.statusCode}: ${changed.body}`);
  }

  return {
    initialToken,
    initialMustChange: first.body.data.admin.mustChangePassword,
    blockedStatus: blocked.statusCode,
    token: changed.json().data.token,
    newPassword,
  };
}

/**
 * 宾客登录。传入的 `code` 决定身份（openid 就是 `openid-<code>`）。
 * @returns {Promise<{token: string, guestId: number, data: any}>}
 */
export async function guestLogin(app, code, eventId) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { code, ...(eventId ? { eventId } : {}) },
  });

  if (res.statusCode !== 200) {
    throw new Error(`宾客登录失败 ${res.statusCode}: ${res.body}`);
  }
  const data = res.json().data;
  return { token: data.token, guestId: data.guest?.id, data };
}

// ---------------------------------------------------------------------------
// 测试文件
// ---------------------------------------------------------------------------

/** 一个真实的 1x1 PNG，magic bytes 能通过嗅探 */
export function pngBuffer(padding = 0) {
  const head = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  return padding > 0 ? Buffer.concat([head, Buffer.alloc(padding, 0x41)]) : head;
}

/**
 * 构造一个「看起来像 MP4」的字节串。
 * 只有开头满足 ISO-BMFF 的 ftyp 结构——对上传链路来说足够，
 * 因为真正的解码要到 P3 的封面抽取才会发生。
 */
export function fakeMp4Buffer(size = 4096) {
  const head = Buffer.alloc(32);
  head.writeUInt32BE(24, 0);
  head.write('ftyp', 4, 'latin1');
  head.write('mp42', 8, 'latin1');
  head.write('mp42', 12, 'latin1');
  head.write('isom', 16, 'latin1');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - 32), 0x42)]);
}

// ---------------------------------------------------------------------------
// 上传助手
// ---------------------------------------------------------------------------

/**
 * 走完整的分片上传流程。
 * @returns {Promise<{mediaId: string, sessionId: string, parts: number}>}
 */
export async function uploadFile(app, token, eventId, {
  fileName,
  mime,
  buffer,
  chunkSize,
} = {}) {
  const init = await app.inject({
    method: 'POST',
    url: '/api/uploads/init',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      eventId,
      fileName,
      mime,
      bytes: buffer.length,
      ...(chunkSize ? { chunkSize } : {}),
    },
  });

  if (init.statusCode !== 200) {
    throw new Error(`init 失败 ${init.statusCode}: ${init.body}`);
  }

  const { sessionId, chunkSize: cs, totalParts } = init.json().data;

  for (let partNo = 1; partNo <= totalParts; partNo += 1) {
    const start = (partNo - 1) * cs;
    const chunk = buffer.subarray(start, Math.min(start + cs, buffer.length));

    const res = await app.inject({
      method: 'PUT',
      url: `/api/uploads/${sessionId}/parts/${partNo}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.length),
      },
      payload: chunk,
    });

    if (res.statusCode !== 200) {
      throw new Error(`分片 ${partNo} 失败 ${res.statusCode}: ${res.body}`);
    }
  }

  const done = await app.inject({
    method: 'POST',
    url: `/api/uploads/${sessionId}/complete`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });

  if (done.statusCode !== 200) {
    throw new Error(`complete 失败 ${done.statusCode}: ${done.body}`);
  }

  return { mediaId: done.json().data.mediaId, sessionId, parts: totalParts };
}

/** 建一个活动，返回活动对象 */
export async function createEvent(app, token, overrides = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/events',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: '张伟 & 李娜 婚礼',
      coupleNames: '张伟 李娜',
      eventDate: '2026-05-20',
      ...overrides,
    },
  });
  if (res.statusCode !== 200) throw new Error(`建活动失败 ${res.statusCode}: ${res.body}`);
  return res.json().data.event;
}
