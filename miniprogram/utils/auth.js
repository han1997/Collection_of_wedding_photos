/**
 * 登录。
 *
 * 流程：wx.login() 拿 code → 后端用 code2Session 换 openid → 签发 7 天有效的令牌。
 *
 * 全程**不索取昵称、头像、手机号、位置**。
 * 这不只是隐私上的克制，也是过审的关键：小程序后台要声明收集了哪些信息，
 * 声明项越少，被拒的口子越少。
 */
const CONFIG = require('./config.js');
const { request } = require('./request.js');

/**
 * 静默登录（不带活动）。
 * @returns {Promise<{token: string, guestId: number}>}
 */
function login() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) {
          reject(new Error('微信登录失败，请重试'));
          return;
        }

        // 这里直接用 wx.request 而不是封装好的 request：
        // 封装里的 401 重试会再次调用 login，形成环。
        wx.request({
          url: CONFIG.BASE_URL + '/api/auth/login',
          method: 'POST',
          data: { code: res.code },
          timeout: 20000,
          success: (r) => {
            if (r.statusCode === 200 && r.data && r.data.ok) {
              const auth = {
                token: r.data.data.token,
                guestId: r.data.data.guest.id,
              };
              persist(auth);
              resolve(auth);
              return;
            }
            const info = r.data && r.data.error;
            reject(new Error((info && info.message) || '登录失败'));
          },
          fail: () => reject(new Error('网络不太好，请检查网络后重试')),
        });
      },
      fail: () => reject(new Error('微信登录失败，请重试')),
    });
  });
}

/**
 * 进入某场婚礼：登录 + 活动信息 + 第一页「我上传的」，一次请求拿全。
 *
 * 婚礼现场网络差、宾客没耐心，少一次往返是实打实的体感差别。
 *
 * @param {{eventId?: string, eventCode?: string, displayName?: string}} p
 * @returns {Promise<{token, guestId, event, me, media, nextCursor}>}
 */
function loginIntoEvent(p) {
  const payload = {};
  if (p.eventId) payload.eventId = p.eventId;
  if (p.eventCode) payload.eventCode = p.eventCode;
  if (p.displayName) payload.displayName = p.displayName;

  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) {
          reject(new Error('微信登录失败，请重试'));
          return;
        }

        wx.request({
          url: CONFIG.BASE_URL + '/api/auth/login',
          method: 'POST',
          data: Object.assign({ code: res.code }, payload),
          timeout: 20000,
          success: (r) => {
            if (r.statusCode === 200 && r.data && r.data.ok) {
              const d = r.data.data;
              const auth = { token: d.token, guestId: d.guest.id };
              persist(auth);
              resolve({
                token: d.token,
                guestId: d.guest.id,
                event: d.event,
                me: d.me,
                media: d.media || [],
                nextCursor: d.nextCursor || '',
              });
              return;
            }
            const info = r.data && r.data.error;
            const err = new Error((info && info.message) || '进入活动失败');
            err.code = info && info.code;
            reject(err);
          },
          fail: () => reject(new Error('网络不太好，请检查网络后重试')),
        });
      },
      fail: () => reject(new Error('微信登录失败，请重试')),
    });
  });
}

function persist(auth) {
  const app = getApp();
  if (app && app.setAuth) {
    app.setAuth(auth);
    return;
  }
  try {
    wx.setStorageSync('auth', auth);
  } catch (e) {
    // 存不下也不影响本次会话
  }
}

/** 本地有没有登录态（不代表服务端还认） */
function hasAuth() {
  try {
    const saved = wx.getStorageSync('auth');
    return Boolean(saved && saved.token);
  } catch (e) {
    return false;
  }
}

function clearAuth() {
  const app = getApp();
  if (app && app.clearAuth) {
    app.clearAuth();
    return;
  }
  try {
    wx.removeStorageSync('auth');
  } catch (e) {
    // 忽略
  }
}

module.exports = {
  login,
  loginIntoEvent,
  hasAuth,
  clearAuth,
};
