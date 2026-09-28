/**
 * 活动主页：欢迎语 + 上传入口 + 「我上传的」。
 *
 * ★ 这里显示的内容**只有当前宾客自己传的**。
 *   这是产品规则，也是合规论证的核心：没有公开广场，不存在用户间互动。
 *   服务端在 SQL 层就按 (event_id, guest_id) 过滤，前端拿不到别人的东西。
 */
const app = getApp();
const { request } = require('../../utils/request.js');
const mediaUtil = require('../../utils/media.js');
const fmt = require('../../utils/format.js');

const PAGE_SIZE = 30;

Page({
  data: {
    event: null,
    me: { uploadCount: 0, bytesUploaded: 0 },
    media: [],
    nextCursor: '',
    loading: true,
    loadingMore: false,
    hasMore: false,
    errorMessage: '',
    /** 统计信息的可读形式 */
    statText: '',
  },

  /** 上次拉取的游标，避免重复请求 */
  _loadingLock: false,

  onLoad() {
    // 落地页可能已经把首屏数据带过来了，直接用，省一次往返
    const boot = app.globalData.bootData;
    if (boot && boot.event) {
      app.globalData.bootData = null;
      this.applyData(boot);
      this.setData({ loading: false });
      return;
    }
    this.loadEvent();
  },

  onShow() {
    // 从上传页回来时刷新一下，让新传的立刻出现
    if (this.data.event && this._needRefresh) {
      this._needRefresh = false;
      this.loadEvent({ silent: true });
    }
  },

  onPullDownRefresh() {
    this.loadEvent({ silent: true }).finally(() => wx.stopPullDownRefresh());
  },

  applyData(d) {
    const media = decorate(d.media || []);
    const nextCursor = d.nextCursor || '';
    this.setData({
      event: d.event,
      me: d.me || { uploadCount: 0, bytesUploaded: 0 },
      media: media,
      nextCursor: nextCursor,
      hasMore: Boolean(nextCursor),
      statText: buildStatText(d.me),
    });
  },

  async loadEvent(opts) {
    const silent = opts && opts.silent;
    if (!silent) this.setData({ loading: true, errorMessage: '' });

    try {
      const d = await request({ url: '/api/events/' + this.data.event.id });
      this.applyData(d);
      this.setData({ loading: false });
    } catch (err) {
      this.setData({
        loading: false,
        errorMessage: err.message || '加载失败',
      });
    }
  },

  /** 上拉加载更多 */
  async loadMore() {
    if (this._loadingLock || !this.data.hasMore) return;
    this._loadingLock = true;
    this.setData({ loadingMore: true });

    try {
      const d = await request({
        url:
          '/api/events/' +
          this.data.event.id +
          '/media?limit=' +
          PAGE_SIZE +
          '&cursor=' +
          encodeURIComponent(this.data.nextCursor),
      });

      const merged = this.data.media.concat(decorate(d.media || []));
      this.setData({
        media: merged,
        nextCursor: d.nextCursor || '',
        hasMore: Boolean(d.nextCursor),
        loadingMore: false,
      });
    } catch (err) {
      this.setData({ loadingMore: false });
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this._loadingLock = false;
    }
  },

  onReachBottom() {
    this.loadMore();
  },

  goUpload() {
    if (!this.data.event.uploadEnabled) {
      wx.showToast({ title: '本场活动已关闭上传', icon: 'none' });
      return;
    }
    this._needRefresh = true;
    wx.navigateTo({ url: '/pages/upload/index' });
  },

  /** 点开大图/播视频 */
  openMedia(e) {
    const index = e.currentTarget.dataset.index;
    // 列表可能很长，不适合塞进 URL。放到 globalData 里传过去，
    // 预览页就能左右滑动翻看全部，而不用重新请求。
    app.globalData.previewList = this.data.media;
    app.globalData.previewEvent = this.data.event;
    wx.navigateTo({ url: '/pages/preview/index?index=' + index });
  },

  /**
   * ★ 图片加载失败时换一个新的签名 URL。
   *
   * 签名 URL 2 小时过期。宾客在页面上停留久了（婚礼现场很正常），
   * 回来时图片就全裂了。这里检测到加载失败就换一个 URL 重试一次。
   */
  async onImageError(e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.media[index];
    if (!item || item._retried) return;

    try {
      const url = await mediaUtil.refreshUrl(item.id, item.kind === 'video' ? 'poster' : 'thumb');
      const key = 'media[' + index + '].thumbUrl';
      const retryKey = 'media[' + index + ']._retried';
      this.setData({ [key]: url, [retryKey]: true });
    } catch (err) {
      // 换不到就算了，占位图继续显示
    }
  },

  /** 删除自己上传的一条 */
  deleteMedia(e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.media[index];
    if (!item) return;

    wx.showModal({
      title: '删除这张？',
      content: '删除后就找不回来了，确定吗？',
      confirmText: '删除',
      confirmColor: '#c8553d',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中…', mask: true });
        try {
          await request({ url: '/api/media/' + item.id, method: 'DELETE' });

          const list = this.data.media.slice();
          list.splice(index, 1);
          const me = Object.assign({}, this.data.me, {
            uploadCount: Math.max(0, (this.data.me.uploadCount || 0) - 1),
          });

          this.setData({ media: list, me: me, statText: buildStatText(me) });
          wx.hideLoading();
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: err.message || '删除失败', icon: 'none' });
        }
      },
    });
  },

  onShareAppMessage() {
    const event = this.data.event;
    return {
      title: event ? event.title + ' · 上传你的照片' : '婚礼照片收集',
      path: event ? '/pages/index/index?id=' + event.id : '/pages/index/index',
    };
  },
});

function buildStatText(me) {
  if (!me) return '';
  const count = me.uploadCount || 0;
  if (count === 0) return '还没有上传';
  return '已上传 ' + count + ' 项 · ' + fmt.formatBytes(me.bytesUploaded || 0);
}

/**
 * 给列表项补上展示用的派生字段。
 *
 * WXML 里不能调用函数，所有格式化都必须在 JS 里做完——
 * 放到模板里做只会得到一串原始数字。
 */
function decorate(list) {
  return (list || []).map(function (item) {
    return Object.assign({}, item, {
      durationText: item.durationMs ? fmt.formatDuration(item.durationMs) : '',
      sizeText: fmt.formatBytes(item.bytes),
      timeText: fmt.formatRelative(item.createdAt),
    });
  });
}
