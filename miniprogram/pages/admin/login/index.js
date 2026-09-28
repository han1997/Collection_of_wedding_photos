/**
 * 主持人登录。
 *
 * 首次用环境变量里的初始密码登录后，会被强制要求改密码——
 * 那个初始密码很可能被写在某处的明文配置里，不能长期有效。
 */
const adminUtil = require('../../../utils/admin.js');

Page({
  data: {
    username: 'admin',
    password: '',
    busy: false,
    /** 需要改密码时显示改密表单 */
    mustChange: false,
    newPassword: '',
    newPassword2: '',
  },

  onLoad() {
    // 已经登录就直接进去
    if (adminUtil.hasAuth()) {
      const a = adminUtil.getAdmin();
      if (a && a.mustChangePassword) {
        this.setData({ mustChange: true, username: a.username });
        return;
      }
      wx.redirectTo({ url: '/pages/admin/events/index' });
    }
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async submitLogin() {
    const { username, password } = this.data;
    if (!username || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' });
      return;
    }

    this.setData({ busy: true });
    try {
      const result = await adminUtil.login(username, password);

      if (result.admin.mustChangePassword) {
        this.setData({ busy: false, mustChange: true, password: '' });
        wx.showToast({ title: '请先修改初始密码', icon: 'none' });
        return;
      }

      wx.redirectTo({ url: '/pages/admin/events/index' });
    } catch (err) {
      this.setData({ busy: false });
      wx.showToast({ title: err.message || '登录失败', icon: 'none' });
    }
  },

  async submitPassword() {
    const { newPassword, newPassword2, password } = this.data;

    if (!password) {
      wx.showToast({ title: '请输入当前密码', icon: 'none' });
      return;
    }
    if (newPassword.length < 8) {
      wx.showToast({ title: '新密码至少 8 位', icon: 'none' });
      return;
    }
    if (newPassword !== newPassword2) {
      wx.showToast({ title: '两次输入不一致', icon: 'none' });
      return;
    }

    this.setData({ busy: true });
    try {
      await adminUtil.changePassword(password, newPassword);
      wx.showToast({ title: '密码已修改', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: '/pages/admin/events/index' }), 800);
    } catch (err) {
      this.setData({ busy: false });
      wx.showToast({ title: err.message || '修改失败', icon: 'none' });
    }
  },
});
