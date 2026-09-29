/**
 * 小程序端配置。
 *
 * ⚠️ 上线前把 BASE_URL 换成你的正式域名。
 *    该域名必须是**已 ICP 备案的 HTTPS 域名**，并在小程序后台的
 *    「开发 → 开发管理 → 服务器域名」里加到 request / uploadFile / downloadFile 三处。
 */
const CONFIG = {
  // ---------------------------------------------------------------------
  // 开发时用本机局域网 IP（不是 127.0.0.1，手机连不到你的电脑）。
  // 开发者工具里勾上「不校验合法域名」即可，真机调试同样绕过校验。
  //
  // 查本机 IP：Windows 上 `ipconfig`，Mac/Linux 上 `ifconfig`。
  // ---------------------------------------------------------------------
  DEV_BASE_URL: 'http://192.168.227.2:3000',

  // 正式环境（备案域名）
  PROD_BASE_URL: 'https://piccol.han1997.fun',

  // 是否用正式环境。true = 走 PROD_BASE_URL。
  useProduction: true,

  /**
   * 分片大小（字节）。
   * 服务端会把最终值夹到 [1MB, 16MB]。
   * 4MB 在 30Mbps 上行约 1 秒一片，弱网下也远在 60 秒超时之内。
   */
  chunkSize: 4 * 1024 * 1024,

  /** 同时上传的分片数。打满 4G 上行又不触发微信的并发限制。 */
  uploadConcurrency: 3,

  /** 单个分片的重试次数（指数退避） */
  partRetries: 5,

  /** 媒体 URL 过期前多久主动换新（服务端签的是 2 小时） */
  urlRefreshAheadMs: 10 * 60 * 1000,
};

CONFIG.BASE_URL = CONFIG.useProduction ? CONFIG.PROD_BASE_URL : CONFIG.DEV_BASE_URL;

module.exports = CONFIG;
