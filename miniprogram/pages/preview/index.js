/**
 * 预览页：全屏看图 / 播视频，可左右滑动翻页，可保存到相册、可删除、可举报。
 *
 * 列表从 globalData 里取（活动页塞进来的），所以翻页不用重新请求。
 */
const app = getApp();
const { request } = require('../../utils/request.js');
const mediaUtil = require('../../utils/media.js');
const fmt = require('../../utils/format.js');

/** 举报原因，必须和服务端 reports.repo.js 里的白名单一致 */
const REPORT_REASONS = ['色情低俗', '违法违规', '侵权', '广告骚扰', '其他'];

Page({
  data: {
    list: [],
    current: 0,
    currentItem: null,
    reportReasons: REPORT_REASONS,
    showReport: false,
  },

  onLoad(options) {
    const list = (app.globalData.previewList || []).map(decorate);
    const index = Number(options.index) || 0;

    if (list.length === 0) {
      wx.showToast({ title: '内容已失效', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    this.setData({ list: list, current: index });
    this.syncCurrent(index);
  },

  syncCurrent(index) {
    this.setData({ currentItem: this.data.list[index] || null });
  },

  onSwiperChange(e) {
    const index = e.detail.current;
    this.setData({ current: index });
    this.syncCurrent(index);
  },

  /** 图片加载失败 → 换新的签名 URL（签名 2 小时过期） */
  async onImageError() {
    const index = this.data.current;
    const item = this.data.list[index];
    if (!item || item._retried) return;

    try {
      const variant = item.kind === 'video' ? 'poster' : 'preview';
      const url = await mediaUtil.refreshUrl(item.id, variant);
      this.setData({
        [`list[${index}].previewUrl`]: url,
        [`list[${index}]._retried`]: true,
      });
      this.syncCurrent(index);
    } catch (err) {
      // 换不到就继续显示占位
    }
  },

  /** 保存到相册 */
  save() {
    const item = this.data.currentItem;
    if (!item) return;
    mediaUtil.saveToAlbum(item);
  },

  /** 删除自己上传的 */
  remove() {
    const index = this.data.current;
    const item = this.data.list[index];
    if (!item) return;

    wx.showModal({
      title: '删除这一项？',
      content: '删除后就找不回来了。',
      confirmText: '删除',
      confirmColor: '#c8553d',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中…', mask: true });
        try {
          await request({ url: '/api/media/' + item.id, method: 'DELETE' });
          wx.hideLoading();

          const list = this.data.list.slice();
          list.splice(index, 1);

          if (list.length === 0) {
            wx.navigateBack();
            return;
          }

          const next = Math.min(index, list.length - 1);
          this.setData({ list: list, current: next });
          this.syncCurrent(next);
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: err.message || '删除失败', icon: 'none' });
        }
      },
    });
  },

  // -------------------------------------------------------------------------
  // 举报
  // -------------------------------------------------------------------------
  openReport() {
    this.setData({ showReport: true });
  },

  closeReport() {
    this.setData({ showReport: false });
  },

  async submitReport(e) {
    const reason = e.currentTarget.dataset.reason;
    const item = this.data.currentItem;
    if (!item) return;

    this.setData({ showReport: false });

    try {
      await request({
        url: '/api/media/' + item.id + '/report',
        method: 'POST',
        data: { reason: reason },
      });
      wx.showToast({ title: '已收到举报', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' });
    }
  },

  /** 阻止弹层滚动穿透 */
  noop() {},
});

function decorate(item) {
  return Object.assign({}, item, {
    sizeText: fmt.formatBytes(item.bytes),
    durationText: item.durationMs ? fmt.formatDuration(item.durationMs) : '',
    timeText: fmt.formatRelative(item.createdAt),
  });
}
