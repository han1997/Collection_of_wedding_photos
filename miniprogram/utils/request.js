/**
 * 网络层：wx.request 的 Promise 封装。
 *
 * 三件事在这里统一处理，页面层就不用各自操心了：
 *   1. 注入 Authorization
 *   2. 拆掉服务端的 {ok, data} 信封，失败时抛出带 code 的错误
 *   3. **401 时静默重新登录并重试一次**——宾客不该看到「登录已失效」这种话，
 *      他只是在婚礼现场想传张照片而已
 */
const CONFIG = require('./config.js');

/** 从 storage 里读 token，避免和 auth.js 形成循环依赖 */
function currentToken() {
  try {
    const saved = wx.getStorageSync('auth');
    return (saved && saved.token) || '';
  } catch (e) {
    return '';
  }
}

/**
 * 发起请求。
 *
 * @param {object} opts
 * @param {string} opts.url 以 / 开头的路径，如 '/api/events/xxx'
 * @param {string} [opts.method]
 * @param {any} [opts.data]
 * @param {object} [opts.header]
 * @param {boolean} [opts.auth] 是否需要带登录态（默认 true）
 * @param {boolean} [opts.retryOn401] 内部使用，防止无限重试
 * @returns {Promise<any>} 服务端 data 字段的内容
 */
function request(opts) {
  const {
    url,
    method = 'GET',
    data,
    header = {},
    auth = true,
    retryOn401 = true,
  } = opts;

  return new Promise((resolve, reject) => {
    const finalHeader = Object.assign({}, header);

    if (auth) {
      const token = currentToken();
      if (token) finalHeader.Authorization = `Bearer ${token}`;
    }

    wx.request({
      url: CONFIG.BASE_URL + url,
      method,
      data,
      header: finalHeader,
      timeout: 120000,

      success: (res) => {
        const body = res.data;

        if (res.statusCode === 200 && body && body.ok) {
          resolve(body.data);
          return;
        }

        // 登录态失效：静默重登一次再重试
        if (res.statusCode === 401 && retryOn401 && auth) {
          const authModule = require('./auth.js');
          authModule
            .login()
            .then(() => request(Object.assign({}, opts, { retryOn401: false })))
            .then(resolve)
            .catch(() => {
              const err = new Error('登录已失效，请重新扫码进入');
              err.code = 'UNAUTHORIZED';
              err.statusCode = 401;
              reject(err);
            });
          return;
        }

        reject(toError(res.statusCode, body));
      },

      fail: (res) => {
        // 网络层的失败（超时、DNS、断网）。给一句人话，方便现场排查。
        const err = new Error('网络不太好，请检查网络后重试');
        err.code = 'NETWORK';
        err.detail = res && res.errMsg;
        reject(err);
      },
    });
  });
}

function toError(statusCode, body) {
  const info = body && body.error ? body.error : null;
  const err = new Error((info && info.message) || `请求失败（${statusCode}）`);
  err.code = (info && info.code) || 'UNKNOWN';
  err.statusCode = statusCode;
  err.details = info && info.details;
  return err;
}

/**
 * 上传一个分片。
 *
 * ⚠️ 用 wx.request 而不是 wx.uploadFile：
 *    · uploadFile 是 multipart，服务端还要多解析一层
 *    · 最要紧的是 uploadFile 默认 60 秒超时且**无法续传**
 *    · wx.request 能直接发 ArrayBuffer，且超时可以在 app.json 里放宽
 *
 * @param {{sessionId: string, partNo: number, buffer: ArrayBuffer}} p
 * @returns {Promise<{partNo: number, receivedParts: number[]}>}
 */
function uploadChunk({ sessionId, partNo, buffer }) {
  return new Promise((resolve, reject) => {
    const token = currentToken();

    wx.request({
      url: `${CONFIG.BASE_URL}/api/uploads/${sessionId}/parts/${partNo}`,
      method: 'PUT',
      // 直接发二进制，走服务端的裸流解析器（不缓冲整个文件）
      data: buffer,
      header: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      timeout: 120000,

      success: (res) => {
        if (res.statusCode === 200 && res.data && res.data.ok) {
          resolve(res.data.data);
          return;
        }
        reject(toError(res.statusCode, res.data));
      },

      fail: (res) => {
        const err = new Error('分片上传失败');
        err.code = 'NETWORK';
        err.detail = res && res.errMsg;
        reject(err);
      },
    });
  });
}

/**
 * 上传成功后通知服务端合并。
 * @param {string} sessionId
 */
function completeUpload(sessionId) {
  return request({
    url: `/api/uploads/${sessionId}/complete`,
    method: 'POST',
    data: {},
  });
}

module.exports = {
  request,
  uploadChunk,
  completeUpload,
  toError,
};
