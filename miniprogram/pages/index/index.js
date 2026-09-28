/**
 * 落地页。
 *
 * 职责：把「用户是怎么进来的」翻译成「进哪一场婚礼」。
 *
 * ★ 两个入口都要走同一套解析：
 *   · onLoad(options) —— 冷启动扫码
 *   · onShow + wx.getEnterOptionsSync() —— **热启动**扫码
 *     （小程序已在后台时，用户扫第二张码，onLoad 不会再触发）
 *   漏掉后者的话，主持人换了场次让宾客再扫，宾客会停在上一场的页面。
 */
const landing = require('../../utils/landing.js');
const auth = require('../../utils/auth.js');

Page({
  data: {
    phase: 'parsing', // parsing | needCode | error | done
    errorMessage: '',
    codeInput: '',
    eventTitle: '',
    busy: false,
  },

  /** 上一次处理过的目标，避免 onShow 重复处理同一个 scene */
  _lastHandled: '',

  onLoad(options) {
    this.handleEnter(options, 'load');
  },

  onShow() {
    // 热启动：小程序已在后台时扫码进来，onLoad 不会再触发
    const opts = landing.getEnterOptions();
    this.handleEnter(opts, 'show');
  },

  /**
   * @param {object} options
   * @param {'load'|'show'} from
   */
  handleEnter(options, from) {
    const parsed = landing.parseEnterOptions(options);

    if (!landing.hasTarget(parsed)) {
      // 没有任何目标：看看有没有上次进过的活动，没有就让用户手动输码
      const app = getApp();
      if (app && app.globalData && app.globalData.event) {
        this.goToEvent();
        return;
      }
      this.setData({ phase: 'needCode' });
      return;
    }

    // 同一个目标不重复处理（onShow 在返回本页时也会触发）
    const key = parsed.eventId || parsed.eventCode;
    if (key === this._lastHandled) return;
    this._lastHandled = key;

    this.enterEvent(parsed);
  },

  async enterEvent(parsed) {
    this.setData({ phase: 'parsing', errorMessage: '', busy: true });

    try {
      const result = await auth.loginIntoEvent({
        eventId: parsed.eventId,
        eventCode: parsed.eventCode,
      });

      const app = getApp();
      if (app) {
        app.globalData.event = result.event;
      }

      this.setData({
        phase: 'done',
        eventTitle: (result.event && result.event.title) || '',
        busy: false,
      });

      // 把落地时已经拿到的数据带过去，省掉活动页的一次请求
      app.globalData.bootData = {
        event: result.event,
        me: result.me,
        media: result.media,
        nextCursor: result.nextCursor,
      };

      this.goToEvent();
    } catch (err) {
      this.setData({
        phase: 'error',
        errorMessage: err.message || '进入活动失败',
        busy: false,
      });
    }
  },

  goToEvent() {
    wx.redirectTo({ url: '/pages/event/index' });
  },

  onCodeInput(e) {
    this.setData({ codeInput: e.detail.value });
  },

  /** 手动输入活动码进来 —— 现场网络、二维码印糊了时的兜底通道 */
  submitCode() {
    const code = (this.data.codeInput || '').trim().toUpperCase();
    if (!code) {
      wx.showToast({ title: '请输入活动码', icon: 'none' });
      return;
    }
    this._lastHandled = code;
    this.enterEvent({ eventId: '', eventCode: code });
  },

  retry() {
    this._lastHandled = '';
    const opts = landing.getEnterOptions();
    this.handleEnter(opts, 'show');
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/index' });
  },

  /** 主持人入口 */
  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/login/index' });
  },

  onShareAppMessage() {
    const app = getApp();
    const event = app && app.globalData && app.globalData.event;
    return {
      title: event ? `${event.title} · 上传你的照片` : '婚礼照片收集',
      path: event ? `/pages/index/index?id=${event.id}` : '/pages/index/index',
    };
  },
});
