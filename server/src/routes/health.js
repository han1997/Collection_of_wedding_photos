/**
 * 健康检查。Docker healthcheck 和部署自检都用它。
 *
 * 会真的碰一下数据库——只回 200 不查库的 healthcheck 在部署时毫无价值。
 */
import { get } from '../db/index.js';
import { freeBytes } from '../services/storage.js';

export default async function healthRoutes(app) {
  app.get('/api/health', async (request, reply) => {
    const startedAt = process.uptime();
    let dbOk = false;
    let dbError = null;

    try {
      get('SELECT 1 AS ok');
      dbOk = true;
    } catch (err) {
      dbError = err.message;
    }

    const diskFree = await freeBytes();

    const body = {
      ok: dbOk,
      data: {
        version: process.env.npm_package_version ?? '0.1.0',
        uptimeSec: Math.round(startedAt),
        node: process.version,
        env: process.env.NODE_ENV ?? 'development',
        db: dbOk ? 'ok' : 'error',
        ...(dbError ? { dbError } : {}),
        ...(diskFree !== null ? { diskFreeBytes: diskFree } : {}),
      },
    };

    // 库挂了就回 503，这样编排工具能正确判定为不健康
    return reply.code(dbOk ? 200 : 503).send(body);
  });

  // 反代/负载均衡常用的极简探针，不查库
  app.get('/healthz', async (request, reply) => reply.code(200).send('ok'));
}
