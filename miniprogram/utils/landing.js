/**
 * 落地参数解析。
 *
 * ★ 这里有一个很常见、也很致命的坑：
 *   小程序**已经在后台运行时**，用户扫第二张码进来，`App.onLaunch` **不会**再触发。
 *   只在 onLaunch 里处理扫码参数的话，主持人换一场婚礼让宾客再扫，
 *   宾客会停留在上一场的页面——而现场没人知道为什么。
 *
 *   所以这套逻辑必须由两个入口共同调用：
 *     · 落地页 onLoad(options)
 *     · 落地页 onShow → wx.getEnterOptionsSync()
 *   本文件把解析抽出来，两个入口都调它。
 */

/**
 * 从进入参数里解析出活动标识。
 *
 * 支持三种来源，优先级从高到低：
 *   1. `scene` —— 扫小程序码进来（形如 `e=<eventId>`）
 *   2. `eventId` / `id` —— 通过分享卡片或普通链接进来
 *   3. `code` —— 手动输入的活动码
 *
 * @param {object} options onLoad 的 options，或 wx.getEnterOptionsSync() 的结果
 * @returns {{eventId: string, eventCode: string}}
 */
function parseEnterOptions(options) {
  const result = { eventId: '', eventCode: '' };
  if (!options) return result;

  // --- scene（扫小程序码）--------------------------------------------------
  // 微信可能已经解码，也可能仍是 URL 编码。防御式地两种都试一遍。
  let scene = options.scene;
  if (scene) {
    if (typeof scene !== 'string') scene = String(scene);
    try {
      scene = decodeURIComponent(scene);
    } catch (e) {
      // 解不开就用原样，下面的正则同样能试
    }

    const m = /(?:^|&)e=([A-Za-z0-9]{4,32})/.exec(scene);
    if (m) result.eventId = m[1];
  }

  // --- query 参数（分享卡片 / 普通链接）-----------------------------------
  const q = options.query || {};
  if (!result.eventId) {
    const fromQuery = q.eventId || q.id || q.event;
    if (typeof fromQuery === 'string' && /^[A-Za-z0-9]{4,32}$/.test(fromQuery)) {
      result.eventId = fromQuery;
    }
  }

  // --- 手动输入的活动码 ----------------------------------------------------
  if (!result.eventId && typeof q.code === 'string') {
    result.eventCode = q.code.trim().toUpperCase();
  }

  return result;
}

/**
 * 取当前进入参数。
 * onShow 里用它来补 onLoad 拿不到的「热启动」场景。
 */
function getEnterOptions() {
  try {
    if (typeof wx.getEnterOptionsSync === 'function') {
      return wx.getEnterOptionsSync() || {};
    }
  } catch (e) {
    // 低版本基础库没有这个 API，退回到 onLaunch 的路径
  }
  return {};
}

/** 有没有解析出任何活动标识 */
function hasTarget(parsed) {
  return Boolean(parsed.eventId || parsed.eventCode);
}

module.exports = {
  parseEnterOptions,
  getEnterOptions,
  hasTarget,
};
