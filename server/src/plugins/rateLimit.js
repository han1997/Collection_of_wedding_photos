/**
 * 全局限流。
 *
 * 域名是公网 HTTPS，上线几小时内就会被扫。限流是成本最低的止血手段。
 *
 * 分级：
 *   · 全局默认    300/分钟/IP
 *   · 登录接口     由各路由用 `config.rateLimit` 覆盖（见 routes/auth.js、admin.js）
 *   · 分片 PUT     **刻意不限流**——一个 3GB 文件 750 片，任何合理阈值都会误伤。
 *                  它的保护是会话归属 + 过期 + 精确字节校验。
 *
 * ⚠️ 限流键默认是 req.ip。反代后面必须让 TRUST_PROXY=true 才能拿到真实 IP，
 *    而这也意味着直连者可以伪造 X-Forwarded-For——所以 compose 里只绑 127.0.0.1。
 */
import rateLimit from '@fastify/rate-limit';
import config from '../config.js';
import { ErrorCode } from '../lib/errors.js';

export default async function rateLimitPlugin(app) {
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',

    // 独立实例间不共享存储：单容器单进程，内存计数就够。
    // 若将来要跑多副本，这里要换成 Redis。
    allowList: () => false,

    // 用统一信封返回 429，别把插件的默认格式漏出去
    errorResponseBuilder: () => ({
      ok: false,
      error: {
        code: ErrorCode.RATE_LIMITED,
        message: '请求过于频繁，请稍后再试',
      },
    }),

    // 健康检查不能限流 —— 否则 Docker healthcheck 会把额度吃光
    keyGenerator: (request) => request.ip,
    skipOnError: true,
    hook: 'onRequest',
    // 测试环境关掉，否则并发用例会互相干扰
    enableDraftSpec: false,
    ...(config.isTest ? { max: 100000, allowList: () => true } : {}),
  });
}
