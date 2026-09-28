/**
 * 启动入口。
 *
 * 顺序是有讲究的：
 *   1. 读配置（缺密钥在这里就炸，而不是等第一位宾客上传）
 *   2. 建目录
 *   3. 打开数据库
 *   4. 跑迁移
 *   5. 装配应用
 *   6. 监听
 *
 * 任何一步失败都应该让进程退出——Docker 的 restart: unless-stopped
 * 会把它拉起来重试，比半死不活地跑着强得多。
 */
import config from './config.js';
import { buildApp } from './app.js';
import { openDb, closeDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { ensureDataDirs } from './services/storage.js';
import { recoverJobs, seedInitialAdmin } from './services/bootstrap.js';
import { startGcSchedule } from './services/gc.js';
import { drain } from './jobs/queue.js';

async function main() {
  console.log(`[boot] 环境 = ${config.nodeEnv}`);
  console.log(`[boot] 数据目录 = ${config.dataRoot}`);

  ensureDataDirs();

  openDb({ file: config.paths.dbFile, verbose: !config.isProduction });
  migrate();

  seedInitialAdmin();
  recoverJobs();

  // 定时清理 + 每晚数据库备份。启动时先跑一次：
  // 重启往往意味着上次不正常退出，正是最该清理的时候。
  const stopGc = startGcSchedule({
    log: config.isTest ? () => {} : console.log,
  });

  const app = await buildApp();

  const close = async (signal) => {
    app.log.info(`收到 ${signal}，正在关闭…`);
    try {
      stopGc();
      await app.close();
      // 让在途的缩略图/封面生成收尾，别把半截文件留在磁盘上
      await Promise.race([drain(), new Promise((r) => setTimeout(r, 5000))]);
      closeDb();
      app.log.info('已关闭');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '关闭时出错');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  // 绑 0.0.0.0，这样容器里反代才连得上；
  // 真正的访问控制由 compose 的 `127.0.0.1:3000:3000` 端口映射负责。
  await app.listen({ port: config.port, host: '0.0.0.0' });

  app.log.info(`对外地址 ${config.publicBaseUrl}`);
  if (!config.wechat.configured) {
    app.log.warn('未配置 WX_APPID / WX_SECRET：小程序码将退化为本地生成的二维码');
  }
}

main().catch((err) => {
  console.error('[boot] 启动失败：');
  console.error(err instanceof Error ? err.message : err);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
