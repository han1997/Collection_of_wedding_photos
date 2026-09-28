/**
 * 活动列表 + 新建活动。主持人日常最常用的页面。
 */
const adminUtil = require('../../../utils/admin.js');
const fmt = require('../../../utils/format.js');

Page({
  data: {
    events: [],
    loading: true,
    errorMessage: '',
    /** 新建表单是否展开 */
    showForm: false,
    busy: false,
    form: {
      title: '',
      coupleNames: '',
      eventDate: '',
      venue: '',
      welcomeText: '',
    },
    today: '',
  },

  onLoad() {
    if (!adminUtil.hasAuth()) {
      wx.redirectTo({ url: '/pages/admin/login/index' });
      return;
    }
    const d = new Date();
    this.setData({ today: d.toISOString().slice(0, 10) });
  },

  onShow() {
    if (adminUtil.hasAuth()) this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ errorMessage: '' });
    try {
      const d = await adminUtil.adminRequest({ url: '/api/admin/events' });
      this.setData({
        events: (d.events || []).map(decorate),
        loading: false,
      });
    } catch (err) {
      if (err.statusCode === 401) {
        wx.redirectTo({ url: '/pages/admin/login/index' });
        return;
      }
      this.setData({ loading: false, errorMessage: err.message || '加载失败' });
    }
  },

  toggleForm() {
    this.setData({ showForm: !this.data.showForm });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onDateChange(e) {
    this.setData({ 'form.eventDate': e.detail.value });
  },

  async createEvent() {
    const f = this.data.form;
    const title = (f.title || '').trim();

    if (!title) {
      wx.showToast({ title: '请填写活动名称', icon: 'none' });
      return;
    }

    this.setData({ busy: true });
    try {
      const d = await adminUtil.adminRequest({
        url: '/api/admin/events',
        method: 'POST',
        data: {
          title: title,
          coupleNames: (f.coupleNames || '').trim() || undefined,
          eventDate: f.eventDate || undefined,
          venue: (f.venue || '').trim() || undefined,
          welcomeText: (f.welcomeText || '').trim() || undefined,
        },
      });

      this.setData({
        busy: false,
        showForm: false,
        form: { title: '', coupleNames: '', eventDate: '', venue: '', welcomeText: '' },
      });

      await this.load();
      wx.showToast({ title: '已创建', icon: 'success' });

      // 建完直接进详情页去出码 —— 这是建活动的下一步，不用用户再点一次
      setTimeout(() => {
        wx.navigateTo({ url: '/pages/admin/event/index?id=' + d.event.id });
      }, 600);
    } catch (err) {
      this.setData({ busy: false });
      wx.showToast({ title: err.message || '创建失败', icon: 'none' });
    }
  },

  openEvent(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/admin/event/index?id=' + id });
  },

  logout() {
    wx.showModal({
      title: '退出登录？',
      success: (res) => {
        if (!res.confirm) return;
        adminUtil.clearAuth();
        wx.redirectTo({ url: '/pages/admin/login/index' });
      },
    });
  },
});

function decorate(e) {
  return Object.assign({}, e, {
    statText: `${e.uploadCount || 0} 项 · ${e.guestCount || 0} 人 · ${fmt.formatBytes(e.totalBytes || 0)}`,
    dateText: e.eventDate || fmt.formatDate(e.createdAt),
  });
}
