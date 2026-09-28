/**
 * 关于页。
 *
 * ★ 审核会找这个页面。
 *   带用户上传功能的小程序需要说明数据用途、提供联系方式；
 *   这里把「我们收集什么、不收集什么」讲清楚，也是过审的加分项。
 */
Page({
  data: {
    version: '0.1.0',
  },

  copyContact() {
    wx.setClipboardData({
      data: 'contact@example.com',
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/login/index' });
  },

  onShareAppMessage() {
    return { title: '婚礼照片收集助手', path: '/pages/index/index' };
  },
});
