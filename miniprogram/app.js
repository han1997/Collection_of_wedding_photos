const CONFIG = require('./utils/config.js');

App({
  globalData: {
    /** 后端基址，各页面统一从这里取 */
    baseUrl: CONFIG.BASE_URL,
    /** 当前所在的活动（扫码/输入活动码后填充） */
    event: null,
    /** 本机保存的登录态 */
    token: '',
    guestId: 0,
  },

  onLaunch() {
    // 恢复上次的登录态。token 有效期 7 天，所以婚礼当天基本不会被要求重新登录。
    try {
      const saved = wx.getStorageSync('auth');
      if (saved && saved.token) {
        this.globalData.token = saved.token;
        this.globalData.guestId = saved.guestId || 0;
      }
    } catch (e) {
      // 存储读不出来就当没登录，不影响启动
    }
  },

  /**
   * 保存登录态。
   * @param {{token: string, guestId: number}} auth
   */
  setAuth(auth) {
    this.globalData.token = auth.token;
    this.globalData.guestId = auth.guestId;
    try {
      wx.setStorageSync('auth', auth);
    } catch (e) {
      // 存不下也不影响本次使用，只是下次要重新登录
    }
  },

  clearAuth() {
    this.globalData.token = '';
    this.globalData.guestId = 0;
    try {
      wx.removeStorageSync('auth');
    } catch (e) {
      // 忽略
    }
  },
});
