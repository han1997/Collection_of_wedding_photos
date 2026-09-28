/**
 * 上传页。
 *
 * ★ 两个必须显式处理的现实问题：
 *
 * 1. **切到后台就断传**。小程序 JS 在切后台时会被挂起，上传随之停住。
 *    这里用「屏幕常亮 + 明确的文案」来降低发生概率，但更重要的是**续传**：
 *    断了之后回到这个页面能接着传，而不是从 0 开始。
 *
 * 2. **多个文件不能各开并发**。每个文件内部已经有 3 路并发，
 *    再让 10 个文件同时跑就是 30 路并发，弱网下只会一起变慢。
 *    所以**一次只传一个文件**，文件内的分片才并发。
 */
const app = getApp();
const fmt = require('../../utils/format.js');
const { createTask } = require('../../utils/uploader.js');

/** 一次最多选几个 —— 太多次选择会让操作变复杂，也容易误选 */
const MAX_PICK = 9;

Page({
  data: {
    items: [],
    /** idle | uploading | paused | done */
    phase: 'idle',
    keepAwake: false,
    doneCount: 0,
    failCount: 0,
  },

  /** 当前正在传的任务控制器 */
  _task: null,
  /** 待传队列 */
  _queue: [],

  onLoad() {
    this.setData({ eventTitle: (app.globalData.event && app.globalData.event.title) || '' });
  },

  onUnload() {
    this.stopKeepAwake();
    // 离开页面时把在传的任务停掉，但**不取消**——
    // 服务端已经收到的分片都还在，回来还能接着传。
    if (this._task) this._task.pause();
  },

  // -------------------------------------------------------------------------
  // 选择媒体
  // -------------------------------------------------------------------------
  choose() {
    const remaining = MAX_PICK - this.data.items.length;
    if (remaining <= 0) {
      wx.showToast({ title: `一次最多 ${MAX_PICK} 个`, icon: 'none' });
      return;
    }

    wx.chooseMedia({
      count: remaining,
      mediaType: ['image', 'video'],
      sourceType: ['album', 'camera'],
      // 用 original 保住画质。缩略图由服务端生成，
      // 上传端压一次、服务端再压一次，只会白白损失质量。
      sizeType: ['original'],
      // ⚠️ maxDuration 只限制「在小程序内现场拍摄」的时长，
      //    从相册里选已有的视频**不受这个限制**。
      maxDuration: 60,
      camera: 'back',

      success: (res) => {
        const picked = (res.tempFiles || []).map((f) => ({
          // 本地唯一 id，仅用于列表渲染和更新
          id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          tempFilePath: f.tempFilePath,
          fileType: f.fileType || 'image',
          size: f.size || 0,
          sizeText: fmt.formatBytes(f.size || 0),
          durationText: f.duration ? fmt.formatDuration(f.duration * 1000) : '',
          percent: 0,
          percentText: '0%',
          state: 'waiting', // waiting | uploading | paused | done | failed
          stateText: '等待中',
          errorText: '',
        }));

        const items = this.data.items.concat(picked);
        this.setData({ items: items });

        // 选完立刻开始，少一次点击
        if (this.data.phase !== 'uploading') {
          this.startQueue();
        }
      },
      fail: (err) => {
        // 用户主动取消不算错误，不要弹提示
        if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) return;
        wx.showToast({ title: '选择失败', icon: 'none' });
      },
    });
  },

  // -------------------------------------------------------------------------
  // 队列调度：一次一个文件
  // -------------------------------------------------------------------------
  startQueue() {
    const pending = this.data.items.filter((it) => it.state === 'waiting' || it.state === 'failed');
    if (pending.length === 0) {
      this.setData({ phase: this._allDone() ? 'done' : 'idle' });
      return;
    }

    this._queue = pending.map((it) => it.id);
    this.setData({ phase: 'uploading' });
    this.startKeepAwake();
    this.nextInQueue();
  },

  nextInQueue() {
    if (this.data.phase === 'paused') return;

    const nextId = this._queue.shift();
    if (!nextId) {
      this.finishAll();
      return;
    }

    const index = this.data.items.findIndex((it) => it.id === nextId);
    if (index < 0) {
      this.nextInQueue();
      return;
    }

    const item = this.data.items[index];

    this.patch(index, { state: 'uploading', percent: 0, errorText: '' });

    const task = createTask({
      file: {
        tempFilePath: item.tempFilePath,
        size: item.size,
        fileType: item.fileType,
      },
      eventId: app.globalData.event.id,

      onProgress: (p) => {
        // 进度按片推进，被暂停时 state 会变成 'paused'
        this.patch(index, {
          percent: p.percent,
          state: p.state === 'paused' ? 'paused' : 'uploading',
        });
      },

      onResumed: (info) => {
        // 续传上了：告诉用户已经跳过了多少片
        wx.showToast({
          title: `继续上传，还剩 ${info.missing} 个分片`,
          icon: 'none',
          duration: 2000,
        });
      },

      onDone: () => {
        this.patch(index, { percent: 100, state: 'done' });
        this.setData({ doneCount: this.data.doneCount + 1 });
        this._task = null;
        this.nextInQueue();
      },

      onError: (err) => {
        this.patch(index, {
          state: 'failed',
          errorText: err.message || '上传失败',
        });
        this.setData({ failCount: this.data.failCount + 1 });
        this._task = null;
        this.nextInQueue();
      },
    });

    this._task = task;
    task.start();
  },

  finishAll() {
    this._task = null;
    this.stopKeepAwake();

    const failed = this.data.items.filter((it) => it.state === 'failed').length;
    this.setData({ phase: failed ? 'paused' : 'done' });

    if (!failed) {
      wx.showToast({ title: '全部上传完成', icon: 'success' });
      // 回到活动页时刷新，让新传的立刻出现在「我上传的」里
      setTimeout(() => wx.navigateBack(), 1200);
    }
  },

  _allDone() {
    return this.data.items.length > 0 && this.data.items.every((it) => it.state === 'done');
  },

  // -------------------------------------------------------------------------
  // 控制
  // -------------------------------------------------------------------------
  pause() {
    if (this._task) this._task.pause();
    this.setData({ phase: 'paused' });
    this.stopKeepAwake();
  },

  resume() {
    this.setData({ phase: 'uploading' });
    this.startKeepAwake();

    // 没在传就重新排一次队（把失败的也重排进去）
    if (this._task) {
      this._task.resume();
      return;
    }
    this.startQueue();
  },

  /** 重试单个失败项 */
  retryItem(e) {
    const index = e.currentTarget.dataset.index;
    this.patch(index, { state: 'waiting', errorText: '' });
    this._queue = [this.data.items[index].id];
    this.setData({ phase: 'uploading' });
    this.startKeepAwake();
    this.nextInQueue();
  },

  /** 从队列里移除（还没传完的） */
  removeItem(e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.items[index];

    if (item.state === 'uploading' && this._task) {
      wx.showToast({ title: '正在上传，请先暂停', icon: 'none' });
      return;
    }

    const items = this.data.items.slice();
    items.splice(index, 1);
    this.setData({ items: items });
  },

  // -------------------------------------------------------------------------
  // 屏幕常亮
  // -------------------------------------------------------------------------
  startKeepAwake() {
    if (this.data.keepAwake) return;
    wx.setKeepScreenOn({
      keepScreenOn: true,
      success: () => this.setData({ keepAwake: true }),
      fail: () => {},
    });
  },

  stopKeepAwake() {
    if (!this.data.keepAwake) return;
    wx.setKeepScreenOn({
      keepScreenOn: false,
      success: () => this.setData({ keepAwake: false }),
      fail: () => {},
    });
  },

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  /** 状态 → 给用户看的中文。WXML 里写不了这么长的三元表达式。 */
  patch(index, partial) {
    const data = {};
    Object.keys(partial).forEach((k) => {
      data[`items[${index}].${k}`] = partial[k];
    });

    if (partial.percent !== undefined) {
      data[`items[${index}].percentText`] = partial.percent + '%';
    }
    if (partial.state !== undefined) {
      data[`items[${index}].stateText`] = stateLabel(partial.state, partial.percent);
    }
    if (partial.percent !== undefined && partial.state === undefined) {
      data[`items[${index}].stateText`] = stateLabel('uploading', partial.percent);
    }

    this.setData(data);
  },

  /** 上传全部完成后返回相册 */
  goBack() {
    wx.navigateBack();
  },

  onShareAppMessage() {
    const event = app.globalData.event;
    return {
      title: event ? event.title + ' · 上传你的照片' : '婚礼照片收集',
      path: event ? '/pages/index/index?id=' + event.id : '/pages/index/index',
    };
  },
});

/** 状态标签。进度只在「上传中」时显示，其余状态显示文字。 */
function stateLabel(state, percent) {
  switch (state) {
    case 'waiting':
      return '等待中';
    case 'uploading':
      return (percent === undefined ? 0 : percent) + '%';
    case 'paused':
      return '已暂停';
    case 'done':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return '';
  }
}
