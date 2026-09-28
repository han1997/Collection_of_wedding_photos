/**
 * 主持人（管理员）端的接口调用。
 *
 * 为什么管理后台放在小程序里而不是另做一个网页：
 * 婚礼当天主持人就在手机上——要现场建活动、出码、看有没有人传上来。
 * 再写一套 Web 前端是双倍工作量，还多一个认证面。
 * 服务端的鉴权是完全一样的，所以把管理页打进小程序包里不是安全问题。
 *
 * 管理员令牌和宾客令牌**分开存在不同的 key 下**：
 * 同一个人可能既是某场婚礼的宾客，又是另一场的主持人，两者不能互相覆盖。
 */
const CONFIG = require('./config.js');

const ADMIN_KEY = 'admin_auth';

function getToken() {
  try {
    const saved = wx.getStorageSync(ADMIN_KEY);
    return (saved && saved.token) || '';
  } catch (e) {
    return '';
  }
}

function setAuth(token, admin) {
  try {
    wx.setStorageSync(ADMIN_KEY, { token: token, admin: admin, at: Date.now() });
  } catch (e) {
    // 忽略
  }
}

function clearAuth() {
  try {
    wx.removeStorageSync(ADMIN_KEY);
  } catch (e) {
    // 忽略
  }
}

function getAdmin() {
  try {
    const saved = wx.getStorageSync(ADMIN_KEY);
    return (saved && saved.admin) || null;
  } catch (e) {
    return null;
  }
}

function hasAuth() {
  return Boolean(getToken());
}

/**
 * 管理端请求。
 *
 * 和宾客侧不同，这里**不做 401 自动重登**——
 * 管理员密码不能存下来，所以登不上就是登不上，必须让用户重新输。
 * 静默重试反而会掩盖问题。
 *
 * @param {{url, method?, data?, retryOn401?}} opts
 */
function adminRequest(opts) {
  const method = opts.method || 'GET';

  return new Promise((resolve, reject) => {
    const header = { 'content-type': 'application/json' };
    const token = getToken();
    if (token) header.Authorization = 'Bearer ' + token;

    wx.request({
      url: CONFIG.BASE_URL + opts.url,
      method: method,
      data: opts.data,
      header: header,
      timeout: 30000,
      success: (res) => {
        const body = res.data;

        if (res.statusCode === 200 && body && body.ok) {
          resolve(body.data);
          return;
        }

        // 令牌失效：清掉本地登录态，让页面把用户送回登录页
        if (res.statusCode === 401) {
          clearAuth();
        }

        const info = body && body.error;
        const err = new Error((info && info.message) || '请求失败（' + res.statusCode + '）');
        err.code = (info && info.code) || 'UNKNOWN';
        err.statusCode = res.statusCode;
        reject(err);
      },
      fail: () => {
        const err = new Error('网络不太好，请检查网络后重试');
        err.code = 'NETWORK';
        reject(err);
      },
    });
  });
}

/** 登录 */
function login(username, password) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: CONFIG.BASE_URL + '/api/admin/login',
      method: 'POST',
      data: { username: username, password: password },
      header: { 'content-type': 'application/json' },
      timeout: 30000,
      success: (res) => {
        const body = res.data;
        if (res.statusCode === 200 && body && body.ok) {
          setAuth(body.data.token, body.data.admin);
          resolve(body.data);
          return;
        }
        const info = body && body.error;
        reject(new Error((info && info.message) || '登录失败'));
      },
      fail: () => reject(new Error('网络不太好，请检查网络后重试')),
    });
  });
}

/** 改密码。改完旧令牌立即失效，所以要用返回的新令牌替换本地存的。 */
async function changePassword(currentPassword, newPassword) {
  const data = await adminRequest({
    url: '/api/admin/password',
    method: 'POST',
    data: { currentPassword: currentPassword, newPassword: newPassword },
  });
  setAuth(data.token, getAdmin());
  return data;
}

/** 下载二维码图片到本地临时文件，返回路径 */
function downloadQr(eventId) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      // 这个接口是公开的，不需要令牌
      url: CONFIG.BASE_URL + '/api/events/' + eventId + '/qr.png',
      timeout: 30000,
      success: (res) => {
        if (res.statusCode === 200) {
          resolve(res.tempFilePath);
          return;
        }
        reject(new Error('二维码下载失败'));
      },
      fail: () => reject(new Error('二维码下载失败')),
    });
  });
}

module.exports = {
  adminRequest: adminRequest,
  login: login,
  changePassword: changePassword,
  downloadQr: downloadQr,
  hasAuth: hasAuth,
  getAdmin: getAdmin,
  clearAuth: clearAuth,
};
