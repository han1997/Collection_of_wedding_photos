/**
 * 活动详情：出码、看统计、翻全部素材。
 *
 * 这是主持人在婚礼当天最常用的页面。核心是**出码**：
 * 生成二维码 → 保存到相册 → 打印或直接发群。
 *
 * 注意「环境版本」这个选择器不是可有可无的装饰：
 * 小程序还没发布时，正式版（release）的码扫出来是**白屏**。
 * 所以这里让主持人明确知道自己在出哪个版本的码。
 */
const CONFIG = require('../../../utils/config.js');
const adminUtil = require('../../../utils/admin.js');
const fmt = require('../../../utils/format.js');

const PAGE_SIZE = 60;

const ENV_LABELS = {
  release: '正式版',
  trial: '体验版',
  develop: '开发版',
};

Page({
  data: {
    eventId: '',
    event: null,
    guests: [],
    stats: {},
    media: [],
    nextCursor: '',
    hasMore: false,

    loading: true,
    errorMessage: '',
    busy: false,

    /** 生成二维码用的环境版本 */
    envVersion: 'trial',
    envOptions: [
      { value: 'trial', label: '体验版' },
      { value: 'release', label: '正式版' },
      { value: 'develop', label: '开发版' },
    ],
    envIndex: 0,

    /** 二维码地址（公开接口，可直接给 image 用） */
    qrUrl: '',
    qrMode: '',
    qrEnvLabel: '',

    /** 保存二维码到相册需要它 */
    canSaveQr: true,
  },

  onLoad(options) {
    if (!adminUtil.hasAuth()) {
      wx.redirectTo({ url: '/pages/admin/login/index' });
      return;
    }
    this.setData({ eventId: options.id || '' });
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const d = await adminUtil.adminRequest({ url: '/api/admin/events/' + this.data.eventId });

      const event = d.event;
      const env = event.qrEnvVersion || this.data.envVersion;
      const envIndex = this.data.envOptions.findIndex((o) => o.value === env);

      this.setData({
        loading: false,
        event: decorateEvent(event),
        guests: d.guests || [],
        stats: Object.assign({}, d.stats, {
          sizeText: fmt.formatBytes(d.stats.totalBytes || 0),
        }),
        envVersion: env,
        envIndex: envIndex >= 0 ? envIndex : 0,
        qrUrl: this.buildQrUrl(event.id, env),
        qrMode: event.qrMode || '',
        qrEnvLabel: ENV_LABELS[env] || '',
      });

      await this.loadMedia(true);
    } catch (err) {
      if (err.statusCode === 401) {
        wx.redirectTo({ url: '/pages/admin/login/index' });
        return;
      }
      this.setData({ loading: false, errorMessage: err.message || '加载失败' });
    }
  },

  buildQrUrl(eventId, envVersion) {
    // 加一个时间戳参数绕开缓存：重新生成之后要立刻看到新的
    return (
      CONFIG.BASE_URL +
      '/api/events/' + eventId + '/qr.png?envVersion=' + envVersion + '&t=' + Date.now()
    );
  },

  async loadMedia(reset) {
    const d = await adminUtil.adminRequest({
      url:
        '/api/admin/media?eventId=' + this.data.eventId +
        '&limit=' + PAGE_SIZE +
        (reset || !this.data.nextCursor ? '' : '&cursor=' + encodeURIComponent(this.data.nextCursor)),
    });

    const items = d.media || [];
    this.setData({
      media: reset ? items : this.data.media.concat(items),
      nextCursor: d.nextCursor || '',
      hasMore: Boolean(d.nextCursor),
    });
  },

  onReachBottom() {
    if (this.data.hasMore) {
      this.loadMedia(false).catch(() => {});
    }
  },

  onEnvChange(e) {
    const index = Number(e.detail.value);
    const env = this.data.envOptions[index].value;
    this.setData({
      envIndex: index,
      envVersion: env,
      qrUrl: this.buildQrUrl(this.data.eventId, env),
      qrEnvLabel: ENV_LABELS[env] || '',
    });
  },

  /** 生成 / 重新生成二维码 */
  async regenerate() {
    this.setData({ busy: true });
    try {
      const d = await adminUtil.adminRequest({
        url: '/api/admin/events/' + this.data.eventId + '/qr/regenerate',
        method: 'POST',
        data: { envVersion: this.data.envVersion },
      });

      this.setData({
        busy: false,
        qrUrl: this.buildQrUrl(this.data.eventId, this.data.envVersion),
        qrMode: d.mode,
        qrEnvLabel: ENV_LABELS[this.data.envVersion] || '',
        'event.qrMode': d.mode,
      });

      if (d.mode === 'fallback') {
        wx.showModal({
          title: '已生成兼容二维码',
          content:
            '微信小程序码暂时生成不了（可能是还没配 AppID，或小程序还没发布）。' +
            '已改用普通二维码，扫出来会打开一个网页，页面上有引导。' +
            '小程序发布后回到这里点「重新生成」即可。',
          showCancel: false,
        });
      } else {
        wx.showToast({ title: '已生成', icon: 'success' });
      }
    } catch (err) {
      this.setData({ busy: false });
      wx.showToast({ title: err.message || '生成失败', icon: 'none' });
    }
  },

  /** 预览二维码（大图，可长按保存） */
  previewQr() {
    wx.previewImage({
      urls: [this.data.qrUrl],
      current: this.data.qrUrl,
    });
  },

  /** 保存二维码到相册 */
  async saveQr() {
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const tempPath = await adminUtil.downloadQr(this.data.eventId);

      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath: tempPath,
          success: resolve,
          fail: (err) => {
            if (err && err.errMsg && err.errMsg.indexOf('auth deny') >= 0) {
              reject(new Error('请允许访问相册'));
              return;
            }
            reject(new Error('保存失败'));
          },
        });
      });

      wx.hideLoading();
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    }
  },

  /** 复制活动码：宾客扫不开码时可以手输 */
  copyCode() {
    wx.setClipboardData({
      data: this.data.eventId,
      success: () => wx.showToast({ title: '活动码已复制', icon: 'success' }),
    });
  },

  /** 暂停 / 恢复上传 */
  async toggleUpload() {
    const next = !this.data.event.uploadEnabled;

    try {
      await adminUtil.adminRequest({
        url: '/api/admin/events/' + this.data.eventId,
        method: 'PATCH',
        data: { uploadEnabled: next },
      });
      this.setData({ 'event.uploadEnabled': next });
      wx.showToast({ title: next ? '已开启上传' : '已暂停上传', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  /** 关闭整场活动 */
  closeEvent() {
    wx.showModal({
      title: '结束这场活动？',
      content: '结束后宾客将不能继续上传。已上传的照片不会被删除，随时可以再打开。',
      confirmText: '结束',
      confirmColor: '#c8553d',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await adminUtil.adminRequest({
            url: '/api/admin/events/' + this.data.eventId,
            method: 'PATCH',
            data: { status: 'closed', uploadEnabled: false },
          });
          await this.load();
          wx.showToast({ title: '已结束', icon: 'success' });
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  /** 看某条素材的原图 */
  previewMedia(e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.media[index];
    if (!item) return;

    if (item.kind === 'video') {
      if (item.videoUrl) {
        wx.previewMedia({ sources: [{ url: item.videoUrl, type: 'video' }], current: 0 });
      } else {
        wx.showToast({ title: '该视频暂不可播放', icon: 'none' });
      }
      return;
    }

    const urls = this.data.media.filter((m) => m.kind === 'image' && m.previewUrl).map((m) => m.previewUrl);
    if (urls.length) {
      wx.previewImage({ urls: urls, current: item.previewUrl });
    }
  },
});

function decorateEvent(e) {
  return Object.assign({}, e, {
    statusText: e.status === 'active' ? '进行中' : e.status === 'closed' ? '已结束' : '已归档',
  });
}
