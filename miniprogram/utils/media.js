/**
 * 媒体查看与保存到相册。
 *
 * ⚠️ 保存到相册这块有几个容易踩的坑：
 *   · 2021 年起这些接口**不再自动弹授权框**，必须自己处理授权流程
 *   · 用户拒绝过之后，`wx.authorize` 会**静默失败**，
 *     必须用 `wx.openSetting` 引导他去设置页打开——而 openSetting
 *     **只能由用户点击触发**，不能自动调
 *   · app.json 里的 `permission.scope.writePhotosAlbum.desc` 漏了会直接报错
 */
const { request } = require('./request.js');

/** 预览图片（全屏、可左右滑、可长按保存） */
function previewImage(urls, current) {
  wx.previewImage({
    urls: urls,
    current: current || urls[0],
  });
}

/** 看视频（用系统播放器全屏） */
function previewVideo(url) {
  // 小程序里视频用 <video> 组件播。要全屏就用 wx.previewMedia。
  if (typeof wx.previewMedia === 'function') {
    wx.previewMedia({
      sources: [{ url: url, type: 'video' }],
      current: 0,
    });
    return;
  }
  // 低版本基础库没有 previewMedia，给出可读的提示而不是静默失败
  wx.showModal({
    title: '无法全屏播放',
    content: '请升级微信后再试，或点击「保存到相册」后用手机相册播放。',
    showCancel: false,
  });
}

/**
 * 换一个新鲜的签名 URL。
 * 签名 2 小时过期，页面停留久了就会失效。
 * @param {string} mediaId
 * @param {string} variant
 */
function refreshUrl(mediaId, variant) {
  return request({
    url: `/api/media/${mediaId}/url?variant=${variant}`,
    method: 'GET',
  }).then((d) => d.url);
}

/**
 * 检查保存到相册的授权状态。
 * @returns {Promise<boolean>} 是否已授权
 */
function ensureAlbumAuth() {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => {
        const setting = res.authSetting || {};

        if (setting['scope.writePhotosAlbum'] === true) {
          resolve(true);
          return;
        }

        if (setting['scope.writePhotosAlbum'] === false) {
          // 之前拒绝过：authorize 会静默失败，只能引导去设置页
          wx.showModal({
            title: '需要相册权限',
            content: '保存照片需要你允许「添加到相册」。点「去设置」打开开关即可。',
            confirmText: '去设置',
            success: (m) => {
              if (!m.confirm) {
                resolve(false);
                return;
              }
              wx.openSetting({
                success: (s) => resolve(Boolean(s.authSetting['scope.writePhotosAlbum'])),
                fail: () => resolve(false),
              });
            },
            fail: () => resolve(false),
          });
          return;
        }

        // 从没问过：正常发起授权
        wx.authorize({
          scope: 'scope.writePhotosAlbum',
          success: () => resolve(true),
          fail: () => resolve(false),
        });
      },
      fail: () => resolve(false),
    });
  });
}

/**
 * 把媒体保存到相册。
 *
 * 先拿一个新鲜的下载签名 URL，再 downloadFile 到临时文件，最后存进相册。
 *
 * @param {{id: string, kind: string}} media
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function saveToAlbum(media) {
  const allowed = await ensureAlbumAuth();
  if (!allowed) return { ok: false, reason: '没有相册权限' };

  wx.showLoading({ title: '正在保存…', mask: true });

  try {
    const url = await refreshUrl(media.id, 'original');

    const tempPath = await new Promise((resolve, reject) => {
      wx.downloadFile({
        url: url,
        timeout: 120000,
        success: (res) => {
          if (res.statusCode === 200) {
            resolve(res.tempFilePath);
          } else {
            reject(new Error('下载失败'));
          }
        },
        fail: () => reject(new Error('下载失败，请检查网络')),
      });
    });

    await new Promise((resolve, reject) => {
      const onOk = () => resolve();
      const onFail = (err) => {
        // 用户在系统弹窗里点了拒绝
        if (err && err.errMsg && err.errMsg.indexOf('auth deny') >= 0) {
          reject(new Error('你拒绝了相册权限'));
          return;
        }
        reject(new Error('保存失败'));
      };

      if (media.kind === 'video') {
        wx.saveVideoToPhotosAlbum({ filePath: tempPath, success: onOk, fail: onFail });
      } else {
        wx.saveImageToPhotosAlbum({ filePath: tempPath, success: onOk, fail: onFail });
      }
    });

    wx.hideLoading();
    wx.showToast({ title: '已保存到相册', icon: 'success' });
    return { ok: true };
  } catch (err) {
    wx.hideLoading();
    wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  previewImage,
  previewVideo,
  refreshUrl,
  ensureAlbumAuth,
  saveToAlbum,
};
