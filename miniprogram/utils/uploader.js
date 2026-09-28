/**
 * ★ 分片上传状态机。客户端最核心的一段代码。
 *
 * 为什么不用 wx.uploadFile 一把梭：
 *   · 它默认 60 秒超时，而相册里的长视频可能有几个 GB —— 必然超时
 *   · 超时后**没有任何续传手段**，宾客只能从 0 字节重来
 *   · 它是 multipart，服务端还得额外解析一层
 *
 * 本模块的三条设计主线：
 *
 * 1. **内存恒定**：一次只把一个分片读进内存（默认 4MB），
 *    读完立刻释放。手机上同时握着几个 GB 的 ArrayBuffer 会直接被系统杀掉。
 *
 * 2. **服务端才是续传的真相**：本地只记 sessionId 方便提示「继续上次上传」，
 *    「哪些片收过了」一律以服务端返回的 receivedParts 为准。
 *    本地记录在杀进程、清缓存之后都可能失真。
 *
 * 3. **进度按片报**：wx.request 没有 onProgressUpdate（只有 onHeadersReceived），
 *    所以拿不到片内字节进度。进度以片为粒度推进，片内的平滑感交给页面自己做动画。
 */
const CONFIG = require('./config.js');
const { request, uploadChunk, completeUpload } = require('./request.js');

const fs = wx.getFileSystemManager();

/** 本地记录的未完成任务，用于「继续上次上传」提示 */
const PENDING_KEY = 'pending_uploads';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function openFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.open({
      filePath,
      flag: 'r',
      success: (res) => resolve(res.fd),
      fail: (err) => reject(new Error(`打不开文件：${err.errMsg || ''}`)),
    });
  });
}

function readChunk(fd, position, length) {
  return new Promise((resolve, reject) => {
    const buffer = new ArrayBuffer(length);
    fs.read({
      fd,
      arrayBuffer: buffer,
      position,
      length,
      success: (res) => resolve({
        buffer,
        bytesRead: res.bytesRead,
      }),
      fail: (err) => reject(new Error(`读取文件失败：${err.errMsg || ''}`)),
    });
  });
}

function closeFile(fd) {
  return new Promise((resolve) => {
    fs.close({ fd, success: () => resolve(), fail: () => resolve() });
  });
}

function statFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.stat({
      path: filePath,
      success: (res) => resolve(res.stats),
      fail: () => reject(new Error('读不到文件信息')),
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPending() {
  try {
    return wx.getStorageSync(PENDING_KEY) || {};
  } catch (e) {
    return {};
  }
}

function writePending(map) {
  try {
    wx.setStorageSync(PENDING_KEY, map);
  } catch (e) {
    // 存不下就算了，只是少了「继续上次上传」的提示
  }
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

/**
 * 一个上传任务。
 *
 * @param {object} opts
 * @param {{tempFilePath: string, size: number, fileType?: string, thumbTempFilePath?: string}} opts.file
 *        来自 wx.chooseMedia
 * @param {string} opts.eventId
 * @param {(p: {uploadedParts: number, totalParts: number, percent: number, state: string}) => void} [opts.onProgress]
 * @param {(mediaId: string) => void} [opts.onDone]
 * @param {(err: Error) => void} [opts.onError]
 * @param {(info: {sessionId: string, missing: number}) => void} [opts.onResumed]
 */
function createTask(opts) {
  const { file, eventId, onProgress, onDone, onError, onResumed } = opts;

  const state = {
    sessionId: '',
    chunkSize: CONFIG.chunkSize,
    totalParts: 0,
    completedParts: 0,
    /** 已确认收到的分片号 */
    received: new Set(),
    paused: false,
    aborted: false,
    finished: false,
    bytes: file.size || 0,
    /** 片内平滑动画用：当前正在传的片号 */
    activeParts: 0,
  };

  let netListener = null;
  let resumeWaiters = [];

  // -------------------------------------------------------------------------
  // 进度上报
  // -------------------------------------------------------------------------
  function report(extraState) {
    if (!onProgress) return;
    const percent = state.totalParts
      ? Math.floor((state.completedParts / state.totalParts) * 100)
      : 0;
    onProgress({
      uploadedParts: state.completedParts,
      totalParts: state.totalParts,
      percent,
      state: extraState || (state.paused ? 'paused' : 'uploading'),
    });
  }

  // -------------------------------------------------------------------------
  // 网络变化：断网自动暂停，恢复后自动继续
  // -------------------------------------------------------------------------
  function watchNetwork() {
    netListener = (res) => {
      if (!res.isConnected) {
        if (!state.paused && !state.finished) {
          state.paused = true;
          report('offline');
        }
      } else if (state.paused && !state.aborted && !state.finished) {
        // 只在「因为断网而暂停」时自动恢复；用户主动暂停的不动
        state.paused = false;
        releaseWaiters();
        report('uploading');
      }
    };
    wx.onNetworkStatusChange(netListener);
  }

  function unwatchNetwork() {
    if (netListener && typeof wx.offNetworkStatusChange === 'function') {
      wx.offNetworkStatusChange(netListener);
    }
    netListener = null;
  }

  function waitWhilePaused() {
    if (!state.paused) return Promise.resolve();
    return new Promise((resolve) => {
      resumeWaiters.push(resolve);
    });
  }

  function releaseWaiters() {
    const waiters = resumeWaiters;
    resumeWaiters = [];
    waiters.forEach((r) => r());
  }

  // -------------------------------------------------------------------------
  // 初始化会话（含续传判定）
  // -------------------------------------------------------------------------
  async function initSession() {
    const kind = file.fileType === 'video' ? 'video' : 'image';

    // 从临时路径里取扩展名。极少数情况下路径没有扩展名，
    // 这时按类型兜一个——否则服务端的白名单会直接拒掉（415）。
    let ext = (file.tempFilePath.split('.').pop() || '').toLowerCase();
    if (!ext || ext.length > 5 || file.tempFilePath.indexOf('.') < 0) {
      ext = kind === 'video' ? 'mp4' : 'jpg';
    }

    const mime = guessMime(kind, ext);

    const data = await request({
      url: '/api/uploads/init',
      method: 'POST',
      data: {
        eventId: eventId,
        // 服务端只从文件名里取扩展名（并按 magic bytes 复核），
        // 原始文件名在这里没有意义，所以给一个干净的名字。
        fileName: 'upload.' + ext,
        mime: mime,
        bytes: state.bytes,
        chunkSize: CONFIG.chunkSize,
        kind: kind,
      },
    });

    state.sessionId = data.sessionId;
    state.chunkSize = data.chunkSize;
    state.totalParts = data.totalParts;
    state.received = new Set(data.receivedParts || []);
    state.completedParts = state.received.size;

    // 记到本地，方便「继续上次上传」提示
    const pending = readPending();
    pending[file.tempFilePath] = {
      sessionId: state.sessionId,
      eventId: eventId,
      bytes: state.bytes,
      at: Date.now(),
    };
    writePending(pending);

    if (state.received.size > 0 && onResumed) {
      onResumed({ sessionId: state.sessionId, missing: state.totalParts - state.received.size });
    }
  }

  // -------------------------------------------------------------------------
  // 传一个分片，带重试
  // -------------------------------------------------------------------------
  async function uploadOnePart(fd, partNo) {
    const start = (partNo - 1) * state.chunkSize;

    // 一次只读一片到内存
    const remaining = state.bytes - start;
    const length = Math.min(state.chunkSize, remaining);
    const { buffer, bytesRead } = await readChunk(fd, start, length);

    // 最后一片可能比请求的短，按实际长度截取
    const payload = bytesRead === buffer.byteLength
      ? buffer
      : buffer.slice(0, bytesRead);

    let attempt = 0;
    let lastErr = null;

    while (attempt < CONFIG.partRetries) {
      if (state.aborted) throw new Error('已取消');
      await waitWhilePaused();

      try {
        await uploadChunk({ sessionId: state.sessionId, partNo: partNo, buffer: payload });
        return;
      } catch (err) {
        lastErr = err;
        attempt += 1;

        // 这些错误重试没有意义，直接抛
        if (['BAD_REQUEST', 'UNSUPPORTED_MEDIA_TYPE', 'NOT_FOUND', 'UNAUTHORIZED'].indexOf(err.code) >= 0) {
          throw err;
        }

        if (attempt < CONFIG.partRetries) {
          // 指数退避 + 抖动，避免所有分片同时重试把弱网打死
          const backoff = Math.min(8000, 500 * Math.pow(2, attempt - 1));
          const jitter = Math.random() * 300;
          await sleep(backoff + jitter);
        }
      }
    }

    throw lastErr || new Error(`分片 ${partNo} 上传失败`);
  }

  // -------------------------------------------------------------------------
  // 主流程
  // -------------------------------------------------------------------------
  async function run() {
    let fd = null;

    try {
      watchNetwork();

      if (!state.bytes) {
        const st = await statFile(file.tempFilePath);
        state.bytes = st.size;
      }
      if (!state.bytes) throw new Error('文件是空的');

      await initSession();
      report('uploading');

      // 待传的分片号。服务端说已经收过的直接跳过 —— 这就是续传。
      const todo = [];
      for (let i = 1; i <= state.totalParts; i += 1) {
        if (!state.received.has(i)) todo.push(i);
      }

      if (todo.length === 0) {
        // 分片都齐了，只差合并
        await finish();
        return;
      }

      fd = await openFile(file.tempFilePath);

      // 并发池：最多 uploadConcurrency 个分片在飞
      let cursor = 0;

      async function worker() {
        while (cursor < todo.length) {
          if (state.aborted) return;

          const partNo = todo[cursor];
          cursor += 1;
          state.activeParts += 1;

          try {
            await uploadOnePart(fd, partNo);
            state.completedParts += 1;
            state.received.add(partNo);
            report();
          } finally {
            state.activeParts -= 1;
          }
        }
      }

      const workers = [];
      for (let i = 0; i < Math.min(CONFIG.uploadConcurrency, todo.length); i += 1) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (state.aborted) return;

      await finish();
    } catch (err) {
      if (state.aborted) return;
      report('failed');
      if (onError) onError(err);
    } finally {
      if (fd !== null) await closeFile(fd);
      unwatchNetwork();
      state.finished = true;
    }
  }

  async function finish() {
    report('merging');
    const data = await completeUpload(state.sessionId);

    // 传完了就把本地记录清掉
    const pending = readPending();
    delete pending[file.tempFilePath];
    writePending(pending);

    state.finished = true;
    report('done');
    if (onDone) onDone(data.mediaId);
  }

  // -------------------------------------------------------------------------
  // 对外控制
  // -------------------------------------------------------------------------
  return {
    start() {
      report('preparing');
      run();
      return this;
    },
    pause() {
      if (state.finished || state.aborted) return;
      state.paused = true;
      report('paused');
    },
    resume() {
      if (state.finished || state.aborted) return;
      state.paused = false;
      releaseWaiters();
      report('uploading');
    },
    abort() {
      state.aborted = true;
      releaseWaiters();
      // 尽力通知服务端清理临时分片；失败也无所谓，gc 会兜底
      if (state.sessionId) {
        request({
          url: `/api/uploads/${state.sessionId}`,
          method: 'DELETE',
        }).catch(() => {});
      }
    },
    getState() {
      return {
        sessionId: state.sessionId,
        totalParts: state.totalParts,
        completedParts: state.completedParts,
        percent: state.totalParts
          ? Math.floor((state.completedParts / state.totalParts) * 100)
          : 0,
        paused: state.paused,
        finished: state.finished,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// MIME 推断
//
// 只做粗略推断；**服务端会按 magic bytes 复核**，声明错了会被拒。
// 所以这里宁可保守，不要瞎猜成别的类型。
// ---------------------------------------------------------------------------

function guessMime(fileType, ext) {
  if (fileType === 'video') {
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'webm') return 'video/webm';
    if (ext === '3gp') return 'video/3gpp';
    if (ext === 'm4v') return 'video/x-m4v';
    return 'video/mp4';
  }

  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'bmp':
      return 'image/bmp';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    default:
      // 服务端有白名单，猜错会被拒绝；返回空让服务端按扩展名判定
      return '';
  }
}

module.exports = {
  createTask,
  guessMime,
  readPending,
  writePending,
};
